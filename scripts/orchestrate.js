import { readFileSync, appendFileSync } from 'node:fs';
import { makeClient } from './lib/github.js';
import {
  parsePolicy, PolicyError, POLICY_PATH, recognizedReviewActors, localReviewActors,
  reviewerRoleAgents, applyMaxRoundsOverride, echoEnabled, isEligible,
} from './lib/policy.js';
import {
  classifyRisk, RISK_CAUSES, unmatchedGlobs, hasUngatedCi,
} from './lib/risk.js';
import { latestCodexResult, inspectReview } from './lib/inspect-review.js';
import { fetchReviewThreads, qualifyUnresolvedThreads, unansweredThreads } from './lib/review-threads.js';
import { extractAdjudicationCards } from './lib/adjudication-cards.js';
import {
  parseStateComment, parseEchoMarker, renderComment, renderEcho, renderRefreshReply, reduce, STATES,
  DISPUTE_REASON_LABELS,
} from './lib/state.js';
import { evaluateGate, GATE_NAME } from './lib/gate.js';
import { buildTelegramMessage, sendTelegram as defaultSendTelegram } from './lib/telegram.js';

// Checks produced by the orchestrator itself — never counted as consumer CI.
// Reusable-workflow job checks are named "<caller job> / <called job>" — match that
// exact shape (a `name === marker` gate check, or a ` / <marker>` suffix for the two
// reusable-workflow jobs), not an arbitrary substring: a consumer's own legitimately
// `required_checks`-listed check whose name merely contains one of these words (e.g.
// "AI Orchestrator Integration Tests") must not be silently excluded and left stuck
// pending forever (codex review round 2 finding on #1).
const OWN_CHECK_MARKERS = ['AI Orchestrator', 'AI Claude Fix'];
const isOwnCheck = (name) => name === GATE_NAME || OWN_CHECK_MARKERS.some((m) => name === m || name.endsWith(` / ${m}`));

// The sticky state comment is only ever posted by the orchestrator itself, authenticated
// with GITHUB_TOKEN — never trust a same-marker comment from any other commenter, or a
// forged JSON blob (e.g. a fake `ai:ready` for the current SHA) could drive the gate.
const ORCHESTRATOR_COMMENTER = 'github-actions[bot]';

/** Resolve the PR number and the event's head SHA (for staleness checks). */
export function resolveEvent(eventName, payload) {
  if (eventName === 'pull_request') {
    return { prNumber: payload.pull_request?.number, eventHeadSha: payload.pull_request?.head?.sha };
  }
  if (eventName === 'pull_request_review') {
    return { prNumber: payload.pull_request?.number, eventHeadSha: null };
  }
  if (eventName === 'check_suite') {
    // Only fires for suites from external CI apps — Actions-created suites never
    // trigger this event (recursion guard); Actions CI arrives via workflow_run.
    const pr = (payload.check_suite?.pull_requests ?? [])[0];
    return { prNumber: pr?.number, eventHeadSha: payload.check_suite?.head_sha ?? null };
  }
  if (eventName === 'workflow_run') {
    const pr = (payload.workflow_run?.pull_requests ?? [])[0];
    return { prNumber: pr?.number, eventHeadSha: payload.workflow_run?.head_sha ?? null };
  }
  if (eventName === 'issue_comment') {
    // Only comments on PRs (the issue payload carries a pull_request stub there).
    return { prNumber: payload.issue?.pull_request ? payload.issue.number : null, eventHeadSha: null };
  }
  return { prNumber: null, eventHeadSha: null };
}

/**
 * Parse a human /ai command from a comment body. Returns null for anything else.
 * `status` is a valid no-op command (any orchestrator run refreshes the sticky comment).
 * `refresh` triggers a reconciliation — re-deriving durable state from the PR's current
 * facts, never a labels-only operation (see reduce()'s `refresh` branch in state.js).
 * `help` is a pure doc lookup — never reaches reduce() (see main()).
 * `round-cap <n>` sets this PR's episode round budget (issue #112); a malformed or
 * missing argument makes the whole comment not match — same as any other bad command,
 * never replied to with an error (see `looksLikeAiCommand` below for the 😕 reaction
 * that stands in for one).
 */
export function parseAiCommand(body) {
  const m = /^\/ai\s+(retry|fix|status|refresh|help|round-cap)\b\s*([\s\S]*)$/.exec((body ?? '').trim());
  if (!m) return null;
  const arg = m[2].trim();
  if (m[1] === 'round-cap') {
    // Digit-only isn't sufficient on its own: a sufficiently long digit string still
    // converts to a non-finite/unsafe Number (e.g. Infinity) — mirrors
    // applyMaxRoundsOverride's AI_ORCH_MAX_ROUNDS parsing (policy.js).
    const cap = /^\d+$/.test(arg) ? Number(arg) : NaN;
    return Number.isSafeInteger(cap) ? { type: 'round-cap', cap } : null;
  }
  return { type: m[1], ...(m[1] === 'fix' && arg ? { instruction: arg } : {}) };
}

/**
 * Whether a comment opens with `/ai` at all, valid subcommand or not — distinguishes
 * a mistyped command (`/ai destroy`, `/ai round-cap abc`) from an unrelated comment
 * that merely mentions `/ai` mid-sentence (`parseAiCommand` rejects both alike, but
 * only the former deserves the 😕 reaction in main()). Same start-of-comment anchor
 * as `parseAiCommand`.
 */
export function looksLikeAiCommand(body) {
  return /^\/ai\b/.test((body ?? '').trim());
}

/** Best-effort comment reaction — a failure here must never fail the command itself. */
async function react(gh, repo, commentId, content) {
  return gh.request('POST', `/repos/${repo}/issues/comments/${commentId}/reactions`, { content })
    .catch((err) => console.warn(`reaction: ${err.message}`));
}

/**
 * A blocking review submitted by a listed human counts as first-class blocking
 * evidence — the phone-native way to command a fix round is to just review the PR.
 * Only REQUEST_CHANGES counts (approvals stay GitHub-native); newest human review
 * for the current head wins, dismissal un-counts it.
 */
export function humanBlockingResult(reviews, inlineComments, { humans, headSha }) {
  // A COMMENTED review does not clear a standing REQUEST_CHANGES on GitHub itself — only
  // an APPROVED review or an explicit dismissal does — so it must not overwrite that
  // user's latest entry below either; exclude it from the pool entirely.
  const relevant = (reviews ?? []).filter((r) =>
    humans.includes(r.user?.login) && r.commit_id === headSha && r.state !== 'DISMISSED' && r.state !== 'COMMENTED');
  // One listed human's later approval must not clear another listed human's
  // still-active REQUEST_CHANGES — evaluate each reviewer's own latest review (reviews
  // arrive chronological, so a Map keeps last-write-per-user), not the single latest
  // review across everyone.
  const latestPerUser = new Map();
  for (const r of relevant) {
    // delete-then-set moves this user's entry to the end of Map iteration order, so that
    // order tracks last-submitted-overall order, not each user's first appearance —
    // otherwise an earlier reviewer's later review sorts before a later reviewer's
    // earlier one and `.at(-1)` below picks the wrong "latest" review (#220).
    latestPerUser.delete(r.user.login);
    latestPerUser.set(r.user.login, r);
  }
  const blocking = [...latestPerUser.values()].filter((r) => r.state === 'CHANGES_REQUESTED');
  if (!blocking.length) return null;
  const latest = blocking.at(-1); // most recently submitted still-blocking review
  const blockingIds = new Set(blocking.map((r) => r.id));
  const findings = (inlineComments ?? [])
    .filter((c) => blockingIds.has(c.pull_request_review_id))
    .map((c) => ({ id: c.id, path: c.path, line: c.line ?? c.original_line ?? null, excerpt: (c.body ?? '').slice(0, 200) }));
  // A human can request changes via the review summary alone, with no inline comments —
  // that text is the only scope the fixer would otherwise see, so surface it (`body`)
  // even though it isn't a `findings` entry; the caller forwards it to the fixer prompt.
  // When multiple listed humans each have a standing REQUEST_CHANGES, concatenate every
  // one's summary — picking only the latest silently dropped the others' scope.
  // `reviewId` lets reduce() dedupe: a still-standing review must dispatch a fix round
  // once, not on every later orchestrator run that happens to re-fetch the same review.
  const body = blocking.map((r) => (r.body ?? '').trim()).filter(Boolean).join('\n\n---\n\n');
  return { relevant: true, blocking: true, findings, sha: latest.commit_id, reviewId: latest.id, source: 'human', body };
}

/**
 * Whether a dismissed `pull_request_review` invalidates the recorded codex evidence for
 * the head it targeted. A reviewer bot's dismissed review always counts — the recorded
 * result rests directly on it, clean or blocking. A listed human's dismissal only counts
 * when the recorded result is itself `blocking`: an ordinary approval/comment review
 * plays no part in a clean bot result, so dismissing it must not wipe one and force an
 * unrelated re-review of an already-ready PR.
 */
export function isCodexDismissal(review, { policy, headSha, prAuthor, recordedResult }) {
  const author = review?.user?.login;
  if (!author || author === prAuthor || review?.commit_id !== headSha) return false;
  if (recognizedReviewActors(policy).includes(author)) return true;
  return policy.humans.includes(author) && recordedResult === 'blocking';
}

/**
 * The id of a human-summoned `@codex review` / `@claude review` with open findings on
 * the current head (#58/#103), or null. An identity that CAN act as a reviewer
 * (`reviewerRoleAgents`) but whose submitted review isn't currently recognized as fresh
 * evidence (`recognizedReviewActors` is backend-gated — e.g. the connector under
 * `backends.reviewer: [local-agent]`, the shipped default). Deliberately never fed into
 * `codexResult`/`latestCodexResult`'s primary call: its silence must never promote
 * `ai:ready` the way a recognized reviewer's clean verdict does — only its *findings*
 * matter, as an invalidation trigger reduce() consumes via `summonedReviewId`. See
 * docs/adr/0007-summoned-reviews-block-never-promote.md.
 *
 * `localReviewActors: []` — this review body is never trusted with
 * ESCALATE_MARKER/OPEN_THREAD_BLOCK_MARKER/etc; those are only ever written by this
 * repo's own deterministic sweep wrapper. `inspectReview`'s root-only finding filter
 * matters here too: `reviewerRoleAgents` includes `claude[bot]`, which also acts as the
 * fixer, and a fixer round's thread replies are review comments GitHub attaches to an
 * auto-created review under that same login — without root-only filtering every fix round
 * would look like a fresh blocking review by its own fixer and loop (claude-fix-prompt.md
 * never has the fixer post a root review comment, only replies or one top-level issue
 * comment, so this filter costs nothing real). Blocking-only, and OLDEST wins rather than
 * newest — deliberately not
 * `latestCodexResult`, whose plain "newest relevant"/"newest blocking" would either let
 * the fixer's later (higher-id, non-blocking) auto-review SHADOW an earlier, still-open
 * blocking summoned review from the same actor, or — when two independent summoned
 * reviews stand at once (e.g. a body-only one, then a later threaded one) — let
 * resolving the NEWER one's thread alone advance `state.js`'s single `summoned_floor`
 * past both ids, silently releasing the older, still-unaddressed body-only finding too
 * (#105 finding). Tracking the oldest keeps the state machine pinned to it until that
 * one is actually released, at which point it drops out of consideration and the
 * next-oldest takes over. A push or dismissal is self-releasing: `inspectReview`'s own
 * `commit_id !== headSha`/`DISMISSED` check drops the review from `relevant` on its own,
 * no extra bookkeeping needed. Resolving a THREADED review's GraphQL thread is not
 * self-releasing the same way — it never touches `review.state` or the REST inline
 * comments (see `latestSummonedReviewHasThread`), so without `summonedFloor` this
 * candidate list would keep returning that same oldest review forever even after
 * `state.js` has recorded it as released (`summoned_floor` caught up to its id),
 * starving out a later, still-unaddressed summoned review that never gets a chance to
 * become `candidates[0]` (#105 round-2 finding). `summonedFloor` (the caller's current
 * `state.codex.summoned_floor`) excludes any candidate at or below that ceiling so the
 * next-oldest surfaces once the oldest is marked released.
 */
function summonedReviewCandidates(reviews, inlineComments, policy, { prAuthor, headSha, summonedFloor = 0 }) {
  const summonedActors = reviewerRoleAgents(policy).filter((a) => !recognizedReviewActors(policy).includes(a));
  if (!summonedActors.length) return [];
  return (reviews ?? [])
    .map((r) => inspectReview(r, inlineComments, {
      actors: summonedActors, localReviewActors: [], prAuthor, headSha,
    }))
    .filter((r) => r.relevant && r.blocking && r.id > summonedFloor);
}

function latestSummonedReview(reviews, inlineComments, policy, opts) {
  return summonedReviewCandidates(reviews, inlineComments, policy, opts)[0] ?? null;
}

export function latestSummonedReviewId(reviews, inlineComments, policy, opts) {
  return latestSummonedReview(reviews, inlineComments, policy, opts)?.id ?? null;
}

/**
 * Whether the standing summoned review (same one `latestSummonedReviewId` derives)
 * actually originated an inline finding, as opposed to being body-only
 * (`CHANGES_REQUESTED` with no inline comments — `inspectReview`'s `findings` stays
 * empty). `state.js`'s no-push `summoned_floor` release path is only sound for a
 * threaded review: `openThreads.length === 0` proves ITS thread resolved, but a
 * body-only review never opened one, so that same signal is vacuously true for it
 * regardless of whether the finding was ever addressed (#105 round-2 finding).
 */
export function latestSummonedReviewHasThread(reviews, inlineComments, policy, opts) {
  return (latestSummonedReview(reviews, inlineComments, policy, opts)?.findings.length ?? 0) > 0;
}

/**
 * Whether ANY standing summoned review — not just the oldest one `latestSummonedReviewId`
 * reports — is body-only. `latestSummonedReview` always tracks the single oldest
 * candidate so a newer review can never shadow-release an older one (see that function's
 * docstring), but that also means a newer body-only review arriving while an OLDER
 * threaded one is still outstanding is entirely invisible to
 * `latestSummonedReviewId`/`latestSummonedReviewHasThread`: both keep reporting the older
 * threaded review, so `state.js` never latches `summonedDuringFix` for the newer one. If
 * the in-flight round then pushes — even just to address the OLDER review's own thread —
 * the push goes stale-by-commit_id for every standing review, including the newer
 * body-only one, which had no thread to survive it and, without this, no latch to trigger
 * a handoff either (#105 finding). `state.js` widens its latch condition with this so that
 * case still hands off instead of silently dropping the newer finding.
 */
export function hasPendingBodyOnlySummonedReview(reviews, inlineComments, policy, opts) {
  return summonedReviewCandidates(reviews, inlineComments, policy, opts).some((r) => r.findings.length === 0);
}

/**
 * Every standing summoned review id as of `opts.headSha` — the full set
 * `summonedReviewCandidates` reports, not just the oldest one `latestSummonedReviewId`
 * surfaces. Lets state.js latch the COMPLETE set of reviews a `summonedDuringFix` episode
 * needs to verify individually later (`allSummonedReviewsDismissed`) — a newer body-only
 * review standing alongside an older one is otherwise invisible to any single-id latch
 * (P1 finding on #119).
 */
export function standingSummonedReviewIds(reviews, inlineComments, policy, opts) {
  return summonedReviewCandidates(reviews, inlineComments, policy, opts).map((r) => r.id);
}

/**
 * Whether EVERY summoned review that was standing as of `opts.headSha` has since been
 * explicitly dismissed. `state.js`'s `summonedDuringFix` latch can represent more than one
 * review — the oldest standing one plus, when `summonedReviewHasBodyOnlyPending` was also
 * true, a newer body-only one hiding behind it — so `opts.latchedIds` (from
 * `sticky.state.summonedDuringFixIds`, `standingSummonedReviewIds`'s full snapshot at latch
 * time) is checked entry-by-entry, each looked up directly in the raw `reviews` list and
 * required to show an explicit `DISMISSED` state, independent of any actor classification.
 * That sidesteps two separate P1 findings on #119: (1) dismissing only the oldest of several
 * latched reviews must not read as releasing the whole latch, and (2)
 * `summonedReviewCandidates` classifies through `reviewerRoleAgents`/`recognizedReviewActors`,
 * both derived from the CURRENT `policy` (reloaded fresh from the base branch every run) — if
 * that policy changes between the round that set the latch and this one, a latched review's
 * author can silently stop being a summoned actor and drop out of `candidates` for a reason
 * that has nothing to do with dismissal. Checking each latched id against the raw list avoids
 * that reclassification entirely. Fails closed (returns false) if an id is missing from
 * `reviews` — an unexplained disappearance is never treated as dismissal.
 *
 * Callers should pass the PRIOR head (`sticky.state.head_sha`), not the current one —
 * `inspectReview`'s `commit_id !== headSha` staleness check would otherwise make every
 * standing review look released the instant the head moves, which is exactly the "ignored
 * vs. dismissed" ambiguity this function exists to resolve.
 *
 * Falls back to the current-policy candidate count only when `latchedIds` is absent
 * (state persisted before this field existed) — a strictly weaker check than the per-id
 * one above, kept only for that migration window.
 */
export function allSummonedReviewsDismissed(reviews, inlineComments, policy, opts) {
  const { latchedIds } = opts;
  if (latchedIds && latchedIds.length) {
    return latchedIds.every((id) => (reviews ?? []).find((r) => r.id === id)?.state === 'DISMISSED');
  }
  return summonedReviewCandidates(reviews, inlineComments, policy, opts).length === 0;
}

function matchPattern(pattern, name) {
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    return new RegExp(pattern.slice(1, -1)).test(name);
  }
  return pattern === name;
}

/** Deterministic CI verdict from check runs (`filter=latest` expected upstream). */
export function computeCiStatus(checkRuns, requiredChecks, excludeCheck = isOwnCheck) {
  const relevant = checkRuns.filter((r) => !excludeCheck(r.name));
  let considered = relevant;
  if (requiredChecks.length) {
    considered = relevant.filter((r) => requiredChecks.some((p) => matchPattern(p, r.name)));
    // Every required pattern must be present; a check that has not even started is "pending".
    if (requiredChecks.some((p) => !relevant.some((r) => matchPattern(p, r.name)))) return 'pending';
  }
  if (considered.some((r) => r.status !== 'completed')) return 'pending';
  if (considered.some((r) => ['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required', 'stale'].includes(r.conclusion))) {
    return 'failure';
  }
  return 'success';
}

export { DISPUTE_REASON_LABELS };

// #144/#204: the build axis, as its own label group — `ai:ready`/`ai:needs-human` no
// longer imply CI status (ADR 0012), so this is the only place CI's own conclusion
// survives to the label surface as its own signal. `computeCiStatus` only ever returns
// one of these three once it has evaluated at all; `null` (pre-first-evaluation, see
// `newState`) maps to no label, matching how `risk:*` also waits for a real
// classification before labeling.
export const CI_LABELS = { success: 'ci:green', failure: 'ci:red', pending: 'ci:pending' };

// Round labels are a FIXED vocabulary, not one label per round: exact `ai:round-0`
// through `ai:round-4`, then everything from 5 up collapses into one `ai:round-5+`
// bucket. Uncapped `/ai fix` and (since issue #112) a per-PR `/ai round-cap` override
// can both push a round well past a small default — an unbounded `ai:round-${n}` would
// sprawl the repo label list, and (like the dispute-reason labels below) round labels
// are posted best-effort, not as a required add: a consumer repo bootstrapped from a
// `templates/labels.json` older than this bucketing (which only ever shipped
// `ai:round-0..2`) won't have `ai:round-3/4/5+` yet, and GitHub rejects the *entire*
// POST when a named label doesn't exist — batching these with the required state/risk
// labels would let a missing round label throw after state/gate are already persisted
// but before the fixer job is dispatched, stranding the PR (codex review round 1
// finding on #117).
const ROUND_LABEL_MAX = 5;
const roundLabelKey = (n) => `ai:round-${n >= ROUND_LABEL_MAX ? `${ROUND_LABEL_MAX}+` : n}`;

/**
 * All label names the orchestrator owns (so it can remove stale ones). `currentLabels`
 * (the PR's actual labels) is folded in to sweep off a legacy per-round label
 * (`ai:round-7`, `ai:round-13`) from before round labels were bucketed.
 */
export function managedLabelNames(policy, currentLabels = []) {
  const name = (key) => policy.labelNames[key] ?? key;
  const names = new Set([
    ...STATES.map(name), ...['risk:low', 'risk:medium', 'risk:high'].map(name),
    ...[...DISPUTE_REASON_LABELS].map((r) => name(`ai:${r}`)),
    ...RISK_CAUSES.map((c) => name(`human:${c}`)), ...Object.values(CI_LABELS).map(name),
  ]);
  for (let i = 0; i <= ROUND_LABEL_MAX; i++) names.add(name(roundLabelKey(i)));
  // ponytail: matches only the default `ai:round-N`/`ai:round-N+` naming, not a custom
  // label_names remap of a specific round number — fine for the reported scenario
  // (nobody remaps round labels individually); revisit if that ever becomes a real policy.
  for (const l of currentLabels) if (/^ai:round-\d+\+?$/.test(l)) names.add(l);
  return [...names];
}

export function desiredLabels(state, policy) {
  const name = (key) => policy.labelNames[key] ?? key;
  const labels = [name(state.state), name(roundLabelKey(state.round))];
  if (state.risk?.level) labels.push(name(`risk:${state.risk.level}`));
  // #144/#204: per-cause labels, gated on the FINAL level rather than emitted whenever
  // `causes` is non-empty — `causes` records raw facts (see classifyRisk), so a PR whose
  // size overrun got overridden back down to `risk:low` must not still read `human:size`;
  // the override said "don't worry about this," and the label must agree.
  if (state.risk?.level && state.risk.level !== 'low') {
    for (const cause of state.risk.causes ?? []) labels.push(name(`human:${cause}`));
  }
  const ciLabel = CI_LABELS[state.ci?.conclusion];
  if (ciLabel) labels.push(name(ciLabel));
  // Reason visible in the PR list, not just the sticky comment/ping — several
  // ai:needs-human PRs are otherwise indistinguishable at a glance (see #73).
  if (state.state === 'ai:needs-human' && DISPUTE_REASON_LABELS.has(state.handoff.reason)) {
    labels.push(name(`ai:${state.handoff.reason}`));
  }
  return labels;
}

async function loadPolicy(gh, repo, baseRef) {
  let file;
  try {
    file = await gh.request('GET', `/repos/${repo}/contents/${POLICY_PATH}?ref=${encodeURIComponent(baseRef)}`);
  } catch (err) {
    if (err.status === 404) return null; // no policy → unmanaged repo
    throw err;
  }
  return parsePolicy(Buffer.from(file.content, 'base64').toString('utf8'));
}

// A policy with a large `risk.human_required_paths` list can produce one warning per
// unmatched glob — uncapped, that list (folded into the sticky comment's un-droppable
// `core`, see state.js's renderComment) can push the comment body past GitHub's
// 65,536-char limit, which would make the PATCH/POST throw before postGate ever runs.
// An item-count cap alone doesn't bound this: each warning wraps an arbitrary-length
// glob string, so a handful of very long globs can blow the limit even under the count
// cap. Dual-cap on both count and total characters, whichever is hit first.
const MAX_POLICY_WARNINGS = 20;
const MAX_POLICY_WARNINGS_CHARS = 60_000;

function truncateWarnings(warnings) {
  const kept = [];
  let totalChars = 0;
  for (const w of warnings) {
    if (kept.length >= MAX_POLICY_WARNINGS || totalChars + w.length > MAX_POLICY_WARNINGS_CHARS) {
      return [...kept, `...and ${warnings.length - kept.length} more policy sanity warnings (truncated).`];
    }
    kept.push(w);
    totalChars += w.length;
  }
  return kept;
}

// #267: advisory-only gate-time sanity checks on the policy itself, read from the same
// base ref as the policy (git-trees API, one call — no repo checkout exists here, see
// actions/orchestrate/action.yml). Only fetches workflow file contents when there's
// actually something to check, to keep the common case (checks named, or no CI) cheap.
async function policySanityWarnings(gh, repo, baseRef, policy) {
  const warnings = [];
  if (policy.risk.humanRequiredPaths.length === 0 && policy.requiredChecks.length > 0) return warnings;

  const tree = await gh.request('GET', `/repos/${repo}/git/trees/${encodeURIComponent(baseRef)}?recursive=1`);
  // A truncated listing (huge repo) is a partial view — a glob that actually matches
  // could look zero-match just because its match lives past the truncation point, which
  // would misdirect someone to "fix" an already-correct line. Silence beats that.
  if (tree?.truncated) return warnings;
  const blobs = (tree?.tree ?? []).filter((e) => e.type === 'blob');

  for (const glob of unmatchedGlobs(policy.risk.humanRequiredPaths, blobs.map((b) => b.path))) {
    warnings.push(`\`risk.human_required_paths\` glob \`${glob}\` matches no tracked files — check for a stale or typo'd path.`);
  }

  if (policy.requiredChecks.length === 0) {
    const workflowBlobs = blobs.filter((b) => /^\.github\/workflows\/.*\.ya?ml$/.test(b.path));
    const workflowFiles = await Promise.all(workflowBlobs.map(async (b) => {
      const blob = await gh.request('GET', `/repos/${repo}/git/blobs/${b.sha}`);
      return { content: Buffer.from(blob.content, blob.encoding).toString('utf8') };
    }));
    if (hasUngatedCi(policy.requiredChecks, workflowFiles)) {
      warnings.push('`required_checks` is empty but `.github/workflows/` has CI that could gate PRs — name the checks explicitly.');
    }
  }
  return truncateWarnings(warnings);
}

/**
 * Whether this sweep should post a status echo (see docs/ai-command.md `/ai status`):
 * an explicit `/ai status` always does; otherwise only when auto-echo is enabled and
 * enough timeline items have accrued since the last echo (or since the start, if none
 * exists yet — `lastEchoN` is the self-describing floor read off existing echo markers,
 * not state stored in the sticky comment's JSON). The timeline count isn't monotonic
 * (issue comments can be deleted), so a count that has fallen below the recorded floor
 * means the floor itself is stale — treat it like no prior echo rather than going negative
 * and stalling the auto-trigger until the count climbs back past the old floor.
 */
export function shouldEcho({ isStatusCommand, policy, timelineCount, lastEchoN }) {
  if (isStatusCommand) return true;
  if (!echoEnabled(policy)) return false;
  const floor = lastEchoN !== null && timelineCount >= lastEchoN ? lastEchoN : 0;
  return timelineCount - floor >= policy.echoFrequency;
}

export async function findSticky(gh, repo, prNumber) {
  const comments = await gh.paginate(`/repos/${repo}/issues/${prNumber}/comments`);
  let commentId = null;
  let state = null;
  const echoes = [];
  for (const c of comments) {
    if (c.user?.login !== ORCHESTRATOR_COMMENTER) continue;
    if (commentId === null) {
      const s = parseStateComment(c.body);
      if (s) { commentId = c.id; state = s; continue; }
    }
    const echo = parseEchoMarker(c.body);
    if (echo) echoes.push({ id: c.id, n: echo.n });
  }
  return { commentId, state, echoes };
}

function setOutput(env, name, value) {
  if (!env.GITHUB_OUTPUT) return;
  // Heredoc form: safe for multiline values (e.g. a human /ai fix instruction).
  const delim = `AI_ORCH_${Math.random().toString(36).slice(2)}`;
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delim}\n${value}\n${delim}\n`);
}

async function postGate(gh, repo, headSha, gate) {
  return gh.request('POST', `/repos/${repo}/check-runs`, {
    name: GATE_NAME,
    head_sha: headSha,
    status: gate.status,
    ...(gate.conclusion ? { conclusion: gate.conclusion } : {}),
    output: { title: gate.title, summary: gate.summary },
  });
}

// Best-effort: a transient GraphQL failure here must not stop the sticky comment below
// from persisting `next` — that's what durably latches the notify effect already resolved
// above, and losing the threads list for one render is far cheaper than resending Telegram
// on the next run because the latch never made it to disk.
export async function safeHandoffThreads(gh, repo, prNumber, policy) {
  try {
    return qualifyUnresolvedThreads(await fetchReviewThreads(gh, repo, prNumber), policy);
  } catch (err) {
    console.warn(`handoff threads: ${err.message}`);
    return [];
  }
}

// Same fetch as safeHandoffThreads, deliberately NOT reusing it: that helper's `[] `-on-
// failure fallback is correct for display (nothing to show beats a crash) but wrong for
// reduce()'s fix-round classifier, where `[]` reads as "confirmed no threads open" and a
// GraphQL hiccup would misclassify a real dispute as resolved. `null` here means "couldn't
// confirm" and reduce() treats that as it treats a genuine unknown — hedge, never suppress.
// claude-fix-prompt.md's {{THREAD_RESOLUTION_RULE}} placeholder — the fixer-side half of
// docs/adr/0005-reviewer-owns-thread-lifecycle.md. At `fixer`/`adjudicate` this is the
// original instruction (unchanged, byte-for-byte, at those tiers). At `reviewer` the
// fixer never resolves anything — the reviewer sweep is the sole resolver, always after
// re-verifying — so telling the fixer to resolve would be a live instruction it's told
// to ignore.
const THREAD_RESOLUTION_RULES = {
  reviewer: 'Never resolve any review thread, regardless of outcome — not even one you '
    + 'just fixed. This repo\'s `reviewers.thread_authority: reviewer` setting reserves '
    + 'resolving threads for the reviewer, always after independently re-verifying '
    + 'against the pushed code; you resolving your own thread is exactly the '
    + 'self-certification that setting exists to prevent. Reply to every thread you '
    + 'addressed, pushed back on, or answered, then stop — do not attempt to resolve it.',
  default: 'When you have addressed such a thread (fixed, or answered with a reply the '
    + 'participants\' comments already support), resolve it: '
    + '`gh api graphql -f query=\'mutation{resolveReviewThread(input:{threadId:"THREAD_ID"}){thread{id}}}\'`. '
    + 'Never resolve a thread you pushed back on or left with an open question — leave '
    + 'those for the human.',
};

export function threadResolutionRule(policy) {
  return THREAD_RESOLUTION_RULES[policy.threadAuthority] ?? THREAD_RESOLUTION_RULES.default;
}

export async function classifierThreads(gh, repo, prNumber, policy, { forRefresh = false } = {}) {
  try {
    const threads = await fetchReviewThreads(gh, repo, prNumber);
    // At `thread_authority: fixer` (the default) this is unchanged — every qualifying
    // open thread counts, exactly as ADR-0003 shipped it. At `adjudicate`/`reviewer`,
    // state.js's disputed-round classifier needs a narrower count: threads the fixer
    // hasn't replied to yet, so a push-back it DID reply to can re-queue for the
    // reviewer's own adjudication instead of an immediate handoff — see
    // docs/adr/0005-reviewer-owns-thread-lifecycle.md. `/ai refresh` (forRefresh) has no
    // such narrowing at any tier: its contract is "state unchanged while qualifying
    // threads remain unresolved," so a fixer's own reply to a still-open thread must
    // still count as blocking — unlike the disputed-round classifier, refresh isn't
    // trying to tell a push-back apart from an unaddressed finding.
    return forRefresh || policy.threadAuthority === 'fixer'
      ? qualifyUnresolvedThreads(threads, policy)
      : unansweredThreads(threads, policy);
  } catch (err) {
    console.warn(`classifier threads: ${err.message}`);
    return null;
  }
}

// #248: the crash path below already posts a failure gate, but that's a check run — nobody
// watches those the way they watch Telegram. Without this, a sticky-comment write failure
// (or any other post-fetch crash) stalls the PR with no ping at all. Best-effort, env-gated,
// same as every other notify call site in this file — a dead bot/unset secret must not turn
// a reported crash into an unreported one.
export async function notifyCrash({ repo, prNumber, prTitle }, err, { env = process.env, sendTelegram = defaultSendTelegram } = {}) {
  if (!env.AI_ORCH_TELEGRAM_BOT_TOKEN || !env.AI_ORCH_TELEGRAM_CHAT_ID) return;
  const where = prNumber != null ? ` PR #${prNumber}${prTitle ? ` (${prTitle})` : ''}` : '';
  await sendTelegram({ text: `🔴 Orchestrator crashed on ${repo}${where}: ${String(err?.message ?? err).slice(0, 300)}` });
}

/**
 * Execute one orchestration event. Dependencies default to the GitHub Actions runtime,
 * but are injectable so this effectful boundary can be tested without network access.
 */
export async function main({ env = process.env, gh: injectedGh, sendTelegram = defaultSendTelegram, argv = process.argv, onCrashContext } = {}) {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const gh = injectedGh ?? makeClient({ token, apiUrl: env.GITHUB_API_URL || 'https://api.github.com' });

  const fixResultMode = argv[2] === 'fix-result';
  const eventName = env.GITHUB_EVENT_NAME;
  const payload = fixResultMode ? {} : JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));

  let prNumber, eventHeadSha, eventLabel;
  if (fixResultMode) {
    prNumber = Number(env.PR_NUMBER);
    eventHeadSha = null;
  } else {
    ({ prNumber, eventHeadSha } = resolveEvent(eventName, payload));
    eventLabel = `${eventName}${payload.action ? `:${payload.action}` : ''}`;
  }
  if (!prNumber) {
    console.log('No pull request associated with this event — nothing to do.');
    return;
  }

  const prData = await gh.request('GET', `/repos/${repo}/pulls/${prNumber}`);
  const pr = {
    number: prNumber,
    title: prData.title,
    headSha: prData.head.sha,
    headRef: prData.head.ref,
    author: prData.user.login,
    draft: prData.draft,
    isFork: prData.head.repo?.full_name !== repo,
    labels: (prData.labels ?? []).map((l) => l.name),
    baseRef: prData.base.ref,
    state: prData.state,
  };
  if (pr.state !== 'open') {
    console.log(`PR #${prNumber} is ${pr.state} — nothing to do.`);
    return;
  }
  // From here on, a thrown error must not leave a stale success/failure gate from a
  // prior good run in place — the top-level catch reports a failure gate instead.
  onCrashContext?.({
    gh, repo, headSha: pr.headSha, prNumber, prTitle: pr.title,
  });

  // Policy comes from the BASE branch, never the PR head — a PR cannot change
  // the policy it is judged by.
  let policy = await loadPolicy(gh, repo, pr.baseRef);
  if (!policy) {
    console.log('No ai-policy on the base branch — unmanaged.');
    return;
  }
  policy = applyMaxRoundsOverride(policy, env.AI_ORCH_MAX_ROUNDS);
  // fixResultMode falls through instead of returning here even while disabled: a
  // claude-fix job already in flight when the policy flipped to `disabled` still runs
  // its "Report fix result" step, and that invocation must be allowed to consume
  // FIX_OUTCOME and clear the `ai:fixing` latch via reduce() below — otherwise the
  // sticky state is stranded at `ai:fixing` forever, surviving even past a later
  // re-enable (round 3 finding on #1). Safe to let it reach the normal pipeline:
  // `active` (false, mode !== 'active') already suppresses every other side effect
  // (request-codex/notify/request-human-review/label sync/status echo are all gated on
  // it below), and evaluateGate forces a neutral gate for `disabled` regardless of
  // `next.state`, so a required check still can never block while disabled.
  if (policy.mode === 'disabled' && !fixResultMode) {
    // Still emit a neutral gate: if a consumer has made the check required during
    // rollout, disabling orchestration must not leave PRs blocked by a missing check.
    console.log('ai-policy is disabled on the base branch — emitting neutral gate only.');
    const gate = evaluateGate({ state: 'disabled', risk: null, head_sha: pr.headSha, round: 0 }, policy);
    await postGate(gh, repo, pr.headSha, gate);
    return;
  }
  if (policy.mode === 'disabled') {
    console.log('ai-policy is disabled on the base branch — reporting fix result to clear in-flight state only.');
  }
  if (!isEligible(pr, policy)) {
    console.log(`PR #${prNumber} by ${pr.author} is not managed (allowlist/opt-in/draft/fork).`);
    // If this PR was previously managed (a sticky state exists), a stale success/failure
    // gate from before the opt-in was withdrawn must not keep enforcing — replace it with
    // neutral so removing the label is an effective manual override.
    const sticky = await findSticky(gh, repo, prNumber);
    if (sticky.state) {
      await postGate(gh, repo, pr.headSha, {
        status: 'completed', conclusion: 'neutral',
        title: 'No longer managed', summary: `PR #${prNumber} is no longer eligible (opt-in removed, draft, or fork) — the orchestrator stopped enforcing it.`,
      });
    }
    return;
  }
  if (eventHeadSha && eventHeadSha !== pr.headSha) {
    console.log(`Stale event for ${eventHeadSha}; live head is ${pr.headSha} — no-op.`);
    return;
  }

  // Human /ai commands: only on PR comments, only from listed humans; every other
  // comment exits before any further API spend. Guarded on `!fixResultMode` because
  // GITHUB_EVENT_NAME reflects the *run's* trigger, not this step's — a fixer round
  // dispatched by an /ai command runs inside an issue_comment-triggered run, so the
  // later "Report fix result" invocation (fixResultMode, payload forced to `{}`) would
  // otherwise hit `payload.action !== 'created'` and return before ever reaching
  // reduce(), silently dropping the fixer's outcome and leaving the PR stuck in
  // `ai:fixing` forever (a 'pushed' outcome only recovers by accident, via the
  // separate `pull_request:synchronize` event the push itself fires).
  let humanCommand = null;
  let isStatusCommand = false;
  if (!fixResultMode && eventName === 'issue_comment') {
    if (payload.action !== 'created') return;
    const cmd = parseAiCommand(payload.comment?.body);
    if (!cmd) {
      // A comment that opens with `/ai` but doesn't parse (typo, bad round-cap
      // argument, ...) is a wrong command attempt, not an unrelated comment — ack it
      // with 😕 so a listed human sees the miss immediately, same phone-native
      // feedback loop as the 👀 below. Gated on the humans list and active mode for
      // the same reasons that reaction is: no signal to anyone else, nothing to react
      // to when nothing would actually be dispatched.
      if (looksLikeAiCommand(payload.comment?.body) && policy.humans.includes(payload.comment?.user?.login) && policy.mode === 'active') {
        await react(gh, repo, payload.comment.id, 'confused');
      }
      console.log('Comment is not an /ai command — nothing to do.');
      return;
    }
    if (!policy.humans.includes(payload.comment?.user?.login)) {
      console.log(`/ai command from ${payload.comment?.user?.login} ignored — not a listed human.`);
      return;
    }
    // `help` is a doc lookup, not an orchestration command — reply and stop before
    // touching state, labels, or the gate. Posted even in dry-run: it's informational,
    // not one of the effects dry-run exists to suppress. It still gets the same 👀 ack
    // as every other recognized command (issue #185 wants every `/ai` command
    // acknowledged, not just the ones that dispatch something) — suppressed in
    // dry-run like the other reactions, since the full reply below already tells a
    // human in dry-run mode the command landed.
    if (cmd.type === 'help') {
      if (policy.mode === 'active') await react(gh, repo, payload.comment.id, 'eyes');
      const doc = readFileSync(new URL('../docs/ai-command.md', import.meta.url), 'utf8');
      await gh.request('POST', `/repos/${repo}/issues/${prNumber}/comments`, { body: doc });
      console.log('/ai help — replied with command reference.');
      return;
    }
    // `id` dedupes a replayed/rerun delivery of the same comment (see reduce()).
    if (cmd.type !== 'status') humanCommand = { ...cmd, id: payload.comment.id };
    else isStatusCommand = true; // triggers the mandatory status echo below, unconditionally

    console.log(`/ai ${cmd.type} accepted from ${payload.comment.user.login}.`);
    // Ack receipt right away — mirrors Codex's own eyes reaction on `@codex review` — so
    // a human on their phone knows the command was seen before the run finishes and the
    // sticky comment updates. Best-effort: a reaction failure must not fail the command.
    // Dry-run stays inert like every other side effect (see below).
    if (policy.mode === 'active') {
      await react(gh, repo, payload.comment.id, 'eyes');
    }
  }

  const [files, reviews, inlineComments, checkRunsRaw] = await Promise.all([
    gh.paginate(`/repos/${repo}/pulls/${prNumber}/files`),
    gh.paginate(`/repos/${repo}/pulls/${prNumber}/reviews`),
    gh.paginate(`/repos/${repo}/pulls/${prNumber}/comments`),
    gh.paginate(`/repos/${repo}/commits/${pr.headSha}/check-runs?filter=latest`),
  ]);

  const risk = classifyRisk(files, policy);
  const ci = computeCiStatus(checkRunsRaw, policy.requiredChecks);
  // A listed human's blocking review outranks (and substitutes for) the agent result.
  const codexResult = humanBlockingResult(reviews, inlineComments, { humans: policy.humans, headSha: pr.headSha })
    ?? latestCodexResult(reviews, inlineComments,
      { actors: recognizedReviewActors(policy), localReviewActors: localReviewActors(policy), prAuthor: pr.author, headSha: pr.headSha });
  // Fetched here (rather than where it's otherwise first needed, below) so its
  // `codex.summoned_floor` is available to gate `latestSummonedReview`'s candidate list —
  // see that function's docstring for why an already-released oldest summoned review must
  // not keep shadowing the next-oldest one.
  const sticky = await findSticky(gh, repo, prNumber);
  const summonedFloor = sticky.state?.codex?.summoned_floor ?? 0;
  const summonedReviewId = latestSummonedReviewId(reviews, inlineComments, policy, { prAuthor: pr.author, headSha: pr.headSha, summonedFloor });
  const summonedReviewHasThread = latestSummonedReviewHasThread(reviews, inlineComments, policy, { prAuthor: pr.author, headSha: pr.headSha, summonedFloor });
  const summonedReviewHasBodyOnlyPending = hasPendingBodyOnlySummonedReview(reviews, inlineComments, policy, { prAuthor: pr.author, headSha: pr.headSha, summonedFloor });
  // Every candidate standing right now, not just the oldest — snapshotted into
  // `summonedDuringFix`'s latch below (state.js) so a later `allSummonedReviewsDismissed`
  // check can verify each one individually instead of only the single id
  // `latestSummonedReviewId` would otherwise remember (P1 finding on #119).
  const summonedReviewIds = standingSummonedReviewIds(reviews, inlineComments, policy, { prAuthor: pr.author, headSha: pr.headSha, summonedFloor });
  // GitHub's own anchor format for a specific review on a PR — mirrors `fixResult.reviewUrl`
  // below. Only meaningful for reduce()'s `summoned-review-no-thread` handoff, whose thread
  // list is empty by construction (a body-only review never opened one) and would otherwise
  // leave nothing to click.
  const summonedReviewUrl = summonedReviewId != null
    ? `${env.GITHUB_SERVER_URL}/${repo}/pull/${prNumber}#pullrequestreview-${summonedReviewId}` : null;
  // Whether every summoned review standing before this push has been explicitly
  // dismissed — evaluated against `sticky.state.head_sha` (the PRIOR head), NOT the
  // current one, because `latestSummonedReviewId`'s `commit_id !== headSha` staleness
  // check (inspect-review.js) makes an ordinary "ignored, then pushed" round look
  // identical to "dismissed, then pushed" the moment the head moves: both report
  // `summonedReviewId == null`. Checking ALL candidates at the old head — not just the
  // single id `sticky.state.summonedDuringFix` remembers — matters because that latch
  // can represent a newer body-only review hiding behind an older threaded one
  // (`summonedReviewHasBodyOnlyPending`'s case); dismissing only the older one must not
  // read as releasing the latch while the newer, un-dismissed one is still outstanding.
  // Only meaningful when a dismissal and the push that follows it land in the same
  // reduce() call (no intervening sync) — see state.js's head-change block for why that
  // collapsed case needs its own signal (P1 findings on #119). `sticky.state.summonedDuringFixIds`
  // is the full snapshot `summonedReviewIds` above takes at latch time — falls back to the
  // single `summonedDuringFix` id for state persisted before that field existed.
  const summonedDuringFixDismissed = sticky.state?.summonedDuringFix != null
    && allSummonedReviewsDismissed(reviews, inlineComments, policy,
      {
        prAuthor: pr.author, headSha: sticky.state.head_sha, summonedFloor,
        latchedIds: sticky.state.summonedDuringFixIds ?? [sticky.state.summonedDuringFix],
      });
  const pushedByHuman = eventName === 'pull_request' && payload.action === 'synchronize'
    && policy.humans.includes(payload.sender?.login);
  // GITHUB_SERVER_URL/GITHUB_RUN_ID are ambient on every Actions runner (no extra wiring
  // needed) — links straight to the failed run so a human doesn't have to hunt for it.
  // `reviewUrl` (only meaningful on a `disputed` outcome) links the standing review that
  // dispatched this round — GitHub's own anchor format for a specific review on a PR —
  // for reduce()'s `agents-may-disagree` handoff, whose thread list is empty by
  // construction (see REASONS in handoff.js) and would otherwise leave nothing to click.
  const fixResult = fixResultMode
    ? {
        outcome: env.FIX_OUTCOME,
        runUrl: `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`,
        reviewUrl: (codexResult?.id ?? codexResult?.reviewId) != null
          ? `${env.GITHUB_SERVER_URL}/${repo}/pull/${prNumber}#pullrequestreview-${codexResult.id ?? codexResult.reviewId}` : null,
      }
    : null;
  // Only fetched on the paths that need it: classifying whether a no-push fix round was
  // a real dispute (see reduce()'s fixResult handling), or answering an `/ai refresh`
  // reconciliation (see reduce()'s `refresh` branch — it declines outright, never
  // guessing, when this comes back null). `null` (not `[]`) on failure — classifierThreads
  // deliberately doesn't reuse safeHandoffThreads' display-oriented fallback, since `[]`
  // here would misclassify an unconfirmed thread state as agreement.
  const openThreads = (fixResultMode && fixResult.outcome === 'disputed') || humanCommand?.type === 'refresh'
    ? await classifierThreads(gh, repo, prNumber, policy, { forRefresh: humanCommand?.type === 'refresh' })
    : null;

  // A dismissed Codex review is no longer "relevant" evidence (see inspectReview), so it
  // never surfaces via codexResult — flag it separately so reduce() can revoke a result
  // (e.g. ai:ready) that relied on the now-dismissed review, instead of leaving it stale.
  const codexDismissed = !fixResultMode && eventName === 'pull_request_review' && payload.action === 'dismissed'
    && isCodexDismissal(payload.review, { policy, headSha: pr.headSha, prAuthor: pr.author, recordedResult: sticky.state?.codex?.result });
  const { next, effects } = reduce({
    prev: sticky.state, pr, policy, risk,
    event: fixResultMode ? `fix-result:${fixResult.outcome}` : eventLabel,
    codexResult, ci, fixResult, pushedByHuman, codexDismissed, humanCommand, openThreads, summonedReviewId,
    summonedReviewHasThread, summonedReviewUrl, summonedReviewHasBodyOnlyPending, summonedDuringFixDismissed,
    summonedReviewIds,
  });

  const active = policy.mode === 'active';
  const effectTypes = effects.map((e) => e.type);
  console.log(`PR #${prNumber} ${sticky.state?.state ?? '(new)'} → ${next.state}; effects: ${effectTypes.join(', ') || 'none'}`);

  // --- side effects; dry-run is restricted to the sticky comment + a neutral gate ---

  // Fetch live, not from durable state: shows the current thread contents (including any
  // reply added since the handoff, e.g. a human's own agreeing reply — see docs/human-controls.md
  // "Threads are durable memory") without growing the sticky-comment JSON. On the disputed-
  // fixResult path `openThreads` was already fetched for the classifier above — reuse it
  // instead of fetching twice, but ONLY when it holds the full qualified set: at
  // `thread_authority: fixer` (or forRefresh — never true on this path) classifierThreads
  // returns `qualifyUnresolvedThreads`, same as safeHandoffThreads below. At
  // `adjudicate`/`reviewer` it deliberately narrows to `unansweredThreads` for the
  // classifier's own purposes (see classifierThreads) — reusing that narrowed set here
  // would silently drop an already-answered thread (e.g. one carrying an adjudication
  // card) from the sticky comment and the Telegram notification, so fetch fresh instead.
  // (`?? []`: a null classifier fetch failure still renders an empty list here rather than
  // a second doomed request). Every other needs-human reason (round-limit, ci-failing,
  // risk-requires-human, fixer-failed, local-reviewer-escalation) never populated
  // `openThreads`, so those still get their own live fetch.
  //
  // Fetched here, before the notify block below (not just for the sticky-comment render
  // it originally existed for) — #165 reuses this same fetch to lift adjudication cards
  // into the Telegram message, rather than fetching the same threads twice.
  const handoffThreads = next.state === 'ai:needs-human'
    ? (fixResultMode && fixResult?.outcome === 'disputed' && policy.threadAuthority === 'fixer'
      ? (openThreads ?? [])
      : await safeHandoffThreads(gh, repo, prNumber, policy))
    : [];

  // Telegram delivery, the Codex review request, and the human review request must all be
  // resolved (and any latch a failed one earned rolled back) *before* the sticky comment
  // below persists `next` — otherwise a dropped call here (bot down, rate-limited, a
  // transient GitHub error) is recorded as sent/requested and never retried: reduce() only
  // re-emits 'request-codex' while `codex.requested_sha !== pr.headSha`, and only re-emits
  // 'request-human-review' while `handoff.done`/`readyReviewRequested` is still false —
  // both already flipped true in `next` by this point, so a crash between here and the
  // sticky write would otherwise strand the PR on that latch with no later event able to
  // tell "this really was requested" from "we only meant to" (codex review round 1 finding
  // on #1). Gate/label effects further below don't need this: they're recomputed fresh
  // from `next` every run, so a failure there just gets retried on the next event.
  if (active) {
    for (const effect of effects) {
      if (effect.type === 'notify') {
        // #165: lift each blocking thread's adjudication card into the Telegram message —
        // only for the dispute reasons a card is ever written for (formatAdjudicationSection
        // / claude-fix-prompt.md's pushback path); `cards` is `[]` for every other reason, and
        // for a dispute PR whose threads carry no card yet (predates this feature, or never
        // deadlocked into one) — buildTelegramMessage renders the same plain handoff either way.
        const cards = effect.kind === 'needs-human' && DISPUTE_REASON_LABELS.has(effect.reason)
          ? extractAdjudicationCards(handoffThreads)
          : [];
        const delivered = policy.notifications.telegram.enabled
          && env.AI_ORCH_TELEGRAM_BOT_TOKEN && env.AI_ORCH_TELEGRAM_CHAT_ID
          && await sendTelegram(buildTelegramMessage({
            kind: effect.kind, repo, prNumber, prTitle: pr.title, reason: effect.reason, risk, runUrl: effect.runUrl, round: effect.round, cards,
            // #144: the three-axis glyph row's other two facts — `risk` above is the third.
            codexResult: next.codex.result, ciConclusion: next.ci.conclusion,
          }));
        if (!delivered) {
          // Roll back only the notify latch, not `readyReviewRequested` — that one also
          // guards `request-human-review`, which already succeeded and must not be reissued.
          if (effect.kind === 'ready') next.readyNotified = false;
          // Roll back only the notify latch, not `done` — `done` also guards
          // `request-human-review`, which already succeeded and must not be reissued.
          else if (effect.kind === 'needs-human') next.handoff = { ...next.handoff, notified: false };
          // See state.js's `s.noOp` replay block: a failed/disabled send here would
          // otherwise be lost for good once the round-scoped latch persists as "sent".
          else if (effect.kind === 'no-op-round') next.noOp = { ...next.noOp, notified: false };
        }
      } else if (effect.type === 'request-codex') {
        if (policy.backends.reviewer[0] === 'codex') {
          await gh.request('POST', `/repos/${repo}/issues/${prNumber}/comments`,
            { body: `@codex review\n\n<!-- ai-orch:codex-request ${effect.sha} -->` });
        } else {
          // local-agent backend: the latched codex.requested_sha in the sticky marker
          // is the work queue the server-side review sweep polls — nothing to post.
          console.log(`Review of ${effect.sha} queued for the local-agent sweep.`);
        }
      } else if (effect.type === 'request-human-review') {
        // GitHub rejects the whole request if it includes the PR's own author.
        const reviewers = policy.humans.filter((h) => h !== pr.author);
        // No non-author reviewer exists (e.g. policy.humans has exactly one entry and
        // it's the PR's own author) — nothing was actually requested, so this must be
        // treated the same as a failed request below, not silently left latched as
        // done (round 3 finding on #1): otherwise the latch never re-opens, not even
        // once a second human is added to the base policy later.
        const requested = reviewers.length
          ? await gh.request('POST', `/repos/${repo}/pulls/${prNumber}/requested_reviewers`,
            { reviewers }).then(() => true, (err) => { console.warn(`review request: ${err.message}`); return false; })
          : false;
        if (!requested) {
          // Roll back whichever latch this effect earned, so the next event retries it
          // (codex review round 2 finding on #1) — mirrors the notify rollback above.
          // handoff.done/readyReviewRequested are set by mutually exclusive states
          // (ai:needs-human vs ai:ready), so only one is ever true here.
          if (next.state === 'ai:needs-human') next.handoff = { ...next.handoff, done: false };
          else next.readyReviewRequested = false;
        }
      }
    }
  }

  const dryRunNote = active ? null
    : `Would apply labels \`${desiredLabels(next, policy).join('`, `')}\`` +
      (effectTypes.length ? ` and run: ${effectTypes.join(', ')}.` : '.');
  // Advisory only — a fetch failure here must never turn a healthy PR into a failing
  // gate (see the top-level catch at this function's top, which would otherwise do
  // exactly that for anything thrown between here and postGate). Computed before the
  // sticky render so the warnings land where the operator reads (#277), not only in
  // the Checks-tab gate summary.
  const policyWarnings = await policySanityWarnings(gh, repo, pr.baseRef, policy)
    .catch((err) => { console.warn(`policy sanity check: ${err.message}`); return []; });
  for (const w of policyWarnings) console.log(`::warning::${w}`);
  const body = renderComment(next, { dryRunNote, handoffThreads, policyWarnings });
  let canonicalId = sticky.commentId;
  if (sticky.commentId) {
    await gh.request('PATCH', `/repos/${repo}/issues/comments/${sticky.commentId}`, { body });
  } else {
    const posted = await gh.request('POST', `/repos/${repo}/issues/${prNumber}/comments`, { body });
    canonicalId = posted.id;
  }

  const gate = evaluateGate(next, policy);
  if (policyWarnings.length) {
    gate.summary += `\n\n⚠️ Policy sanity warnings:\n${policyWarnings.map((w) => `- ${w}`).join('\n')}`;
  }
  await postGate(gh, repo, pr.headSha, gate);

  // /ai refresh always replies, dry-run included — informational, like /ai help, not one
  // of the effects dry-run exists to suppress. Best-effort: a failed reply must not throw
  // past the setOutput calls below.
  const refreshEffect = effects.find((e) => e.type === 'refresh-report');
  if (refreshEffect) {
    await gh.request('POST', `/repos/${repo}/issues/${prNumber}/comments`, { body: renderRefreshReply(refreshEffect) })
      .catch((err) => console.warn(`refresh reply: ${err.message}`));
  }

  if (active) {
    const desired = desiredLabels(next, policy);
    const managed = managedLabelNames(policy, pr.labels);
    const toRemove = pr.labels.filter((l) => managed.includes(l) && !desired.includes(l));
    const toAdd = desired.filter((l) => !pr.labels.includes(l));
    for (const label of toRemove) {
      await gh.request('DELETE', `/repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`)
        .catch((err) => console.warn(`label remove ${label}: ${err.message}`));
    }
    // The optional dispute-reason, round, human:*, and ci:* labels are split from the
    // required state/risk labels: a consumer repo bootstrapped from an older
    // `templates/labels.json` (before ai:agents-disagree/ai:agents-may-disagree existed
    // there, before round labels were bucketed up to `ai:round-5+` — see ROUND_LABEL_MAX
    // above — or before #144/#204 added human:*/ci:*) can be missing any of them, and
    // GitHub rejects the *whole* POST if any named label doesn't exist. Batching them
    // with the required labels would let that swallow the required add too — and since
    // the local-agent sweep discovers work exclusively through the state label (e.g.
    // `ai:reviewing`), a swallowed failure there stalls the PR with no later event to
    // retry it. Only the labels GitHub might legitimately reject are best-effort; a
    // required-label failure still throws, same as before dispute/round labels existed.
    // human:*/ci:* specifically MUST be best-effort, not just "consistent with the
    // others": ci:pending is near-universal (most PRs sit pending for most of their
    // life), so an unbootstrapped consumer would throw on its very next PR event.
    const labelName = (key) => policy.labelNames[key] ?? key;
    const disputeLabelNames = new Set([...DISPUTE_REASON_LABELS].map((r) => labelName(`ai:${r}`)));
    const roundLabelNames = new Set(
      Array.from({ length: ROUND_LABEL_MAX + 1 }, (_, i) => labelName(roundLabelKey(i))),
    );
    const causeLabelNames = new Set(RISK_CAUSES.map((c) => labelName(`human:${c}`)));
    const ciLabelNames = new Set(Object.values(CI_LABELS).map(labelName));
    const bestEffortLabelNames = new Set([...disputeLabelNames, ...roundLabelNames, ...causeLabelNames, ...ciLabelNames]);
    const requiredToAdd = toAdd.filter((l) => !bestEffortLabelNames.has(l));
    const optionalToAdd = toAdd.filter((l) => bestEffortLabelNames.has(l));
    if (requiredToAdd.length) {
      await gh.request('POST', `/repos/${repo}/issues/${prNumber}/labels`, { labels: requiredToAdd });
    }
    if (optionalToAdd.length) {
      await gh.request('POST', `/repos/${repo}/issues/${prNumber}/labels`, { labels: optionalToAdd })
        .catch((err) => console.warn(`label add ${optionalToAdd.join(', ')}: ${err.message}`));
    }

    // 'notify'/'request-codex'/'request-human-review' effects are all sent earlier,
    // before the sticky comment persists (see above).

    // Status echo: a disposable, human-only copy of the sticky comment at the bottom of
    // the thread (see docs/ai-command.md `/ai status`) — the canonical comment above never
    // moves, so on a busy PR it gets buried. Posted last, after the labels/effects above,
    // so those (which themselves add timeline items) don't leave the echo no longer at the
    // bottom. `/ai status` always echoes; the automatic trigger is best-effort and only
    // runs the (still O(1), but non-zero) timeline count check when it's actually enabled.
    // Whole block is best-effort, like every other effect above: a transient failure here
    // (timeline fetch, post, delete) must not throw past this point and skip the
    // `setOutput` calls below — that would starve `claude-fix` of `should_fix` and drop an
    // already-decided fixer dispatch over a disposable status copy.
    try {
      if (isStatusCommand || echoEnabled(policy)) {
        const timelineCount = await gh.countAll(`/repos/${repo}/issues/${prNumber}/timeline`);
        // Self-describing floor (see renderEcho): the highest `n=` among existing echoes,
        // or null if none exist yet — no counter in the state JSON.
        const lastEchoN = sticky.echoes.length ? Math.max(...sticky.echoes.map((e) => e.n)) : null;
        if (shouldEcho({ isStatusCommand, policy, timelineCount, lastEchoN })) {
          const canonicalUrl = `${env.GITHUB_SERVER_URL}/${repo}/pull/${prNumber}#issuecomment-${canonicalId}`;
          const echoBody = renderEcho(next, { canonicalUrl, timelineCount, dryRunNote, handoffThreads });
          // repost-then-delete: post the fresh echo before removing any prior one(s), so a
          // crash mid-way leaves a redundant echo, never zero. Deletes every previously-found
          // echo, not just the latest, self-healing leftovers from an earlier crash too.
          await gh.request('POST', `/repos/${repo}/issues/${prNumber}/comments`, { body: echoBody });
          for (const e of sticky.echoes) {
            await gh.request('DELETE', `/repos/${repo}/issues/comments/${e.id}`)
              .catch((err) => console.warn(`echo cleanup ${e.id}: ${err.message}`));
          }
        }
      }
    } catch (err) {
      console.warn(`status echo: ${err.message}`);
    }
  }

  const shouldFix = active && effectTypes.includes('dispatch-fixer') && policy.backends.fixer.includes('claude-code-action');
  setOutput(env, 'should_fix', String(shouldFix));
  setOutput(env, 'pr_number', String(prNumber));
  setOutput(env, 'round', String(next.round));
  setOutput(env, 'head_ref', pr.headRef);
  setOutput(env, 'head_sha', pr.headSha);
  // /ai fix carries an explicit instruction already. A human review dispatch has none —
  // forward the standing review summary/summaries (humanBlockingResult() already
  // aggregates every listed human's blocking review body) unconditionally, not just
  // when findings is empty: a second reviewer's summary-only request must still reach
  // the fixer even when a different reviewer's review happened to carry inline findings.
  const dispatchEffect = effects.find((e) => e.type === 'dispatch-fixer');
  const reviewBodyFallback = codexResult?.source === 'human' ? codexResult.body : '';
  setOutput(env, 'fix_instruction', dispatchEffect?.instruction || reviewBodyFallback || '');
  setOutput(env, 'thread_resolution_rule', threadResolutionRule(policy));
}

/** Run main and report a post-fetch failure without making tests exit the process. */
export async function run({ mainFn = main, postGateFn = postGate, notifyCrashFn = notifyCrash, ...opts } = {}) {
  let crashGateContext = null;
  try {
    await mainFn({ ...opts, onCrashContext: (context) => { crashGateContext = context; } });
    return true;
  } catch (err) {
    console.error(err instanceof PolicyError ? err.message : err);
    if (crashGateContext) {
      const {
        gh, repo, headSha, prNumber, prTitle,
      } = crashGateContext;
      await postGateFn(gh, repo, headSha, {
        status: 'completed', conclusion: 'failure',
        title: 'Orchestrator error', summary: String(err?.message ?? err).slice(0, 1000),
      }).catch(() => {});
      await notifyCrashFn({ repo, prNumber, prTitle }, err, opts);
    }
    return false;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run().then((ok) => { if (!ok) process.exit(1); });
}
