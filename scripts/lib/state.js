import { describeHandoff } from './handoff.js';

export const STATE_VERSION = 1;
const MARKER_START = '<!-- ai-orch:state';
const MARKER_END = '-->';
const HISTORY_CAP = 40;

// Echo comments are a disposable, human-only copy of the sticky comment posted at the
// bottom of a busy thread — never the state store, so this marker is deliberately a
// different prefix than MARKER_START and carries only the timeline count `n` it was
// posted at (see findSticky/echoEnabled in orchestrate.js).
const ECHO_MARKER_START = '<!-- ai-orch:echo n=';
const ECHO_MARKER_END = '-->';

export const STATES = ['ai:queued', 'ai:reviewing', 'ai:fixing', 'ai:needs-human', 'ai:ready', 'ai:failed'];

// Scoped to just these reasons, not one label per REASONS entry (handoff.js): these
// are the only ones anyone asked to filter the PR list by — round-limit/ci-failing/etc.
// stay comment-only. `reviewer-sustained` joins them for the same reason #73 added the
// first two: several ai:needs-human PRs are otherwise indistinguishable at a glance.
// Widening later is a one-line change to this set. Lives here (not orchestrate.js,
// which imports it) so `reduce` below can use it without a circular import — `reduce`
// also reads this set to decide whether `/ai retry` treats a standing review as stale
// (see `skipStaleCleanOnRetry`, #188), so widening it for labels also widens which
// handoffs retry re-scans on rather than immediately re-dispatching.
export const DISPUTE_REASON_LABELS = new Set(['agents-disagree', 'agents-may-disagree', 'reviewer-sustained']);

export function newState(prNumber, headSha, mode) {
  return {
    v: STATE_VERSION,
    pr: prNumber,
    mode,
    state: 'ai:queued',
    head_sha: headSha,
    risk: null,
    round: 0,
    // Never resets — unlike `round` (the current episode's budget, zeroed by /ai retry
    // and a human push), this is every fixer dispatch this PR has ever burned, the
    // number issue #110 asked for. Incremented at the same two sites `round` is.
    rounds_total: 0,
    // A human's per-PR override of policy.maxRounds (`/ai round-cap <n>`, issue #112).
    // `null` = no override, fall through to policy. Survives every reset in this
    // function — retry, a human push, a new head — deliberately: it's a fact about the
    // PR ("this one's important"), not about the episode. `effective_cap` below is the
    // resolved value renderers actually read.
    cap: null,
    // Despite the field/JSON-key name, this records the verdict of THIS repo's own
    // configured reviewer sweep (local-agent CLI or a dispatched cloud-`codex` backend
    // review) — never the hosted GitHub "Codex Review" App
    // (`chatgpt-codex-connector[bot]`) specifically, which is a distinct, only
    // sometimes-overlapping identity (see policy.js's `codexActor` vs `recognizedReviewActors`).
    // Left unrenamed here to avoid a JSON-key migration across every in-flight sticky
    // comment (parseStateComment hard-requires `v === STATE_VERSION` and would rebuild
    // fresh state, dropping round/review_floor/handoff/command_ids fleet-wide) — only the
    // human-facing `renderComment` label below was fixed, per #58.
    // `summoned_floor` is the id ceiling of #58/#103 summoned-review evidence that's been
    // confirmed released (a push, an explicit dismissal, or a no-push thread resolution
    // — see the summoned-review block below) — separate from `review_floor`, which only
    // gates the invalidation reset from re-firing, not whether the resulting skip lifts.
    codex: {
      requested_sha: null, reviewed_sha: null, result: null, human_review_id: null, review_floor: 0, summoned_floor: 0,
    },
    fixer: { sha: null, outcome: null },
    ci: { sha: null, conclusion: null, consecutive_failures: 0, failureConfirmedSha: null },
    // `done` latches the state transition + the (idempotent-on-GitHub but noisy)
    // review-request effect; `notified` latches the Telegram ping separately so a
    // failed/disabled send can retry without re-issuing the review request (see
    // the failed-delivery rollback in orchestrate.js and the replay block below).
    handoff: { done: false, notified: false, reason: null },
    // Mirrors handoff.done: only latched for real once active, so a dry-run
    // preview reaching ai:ready still gets the real ping on activation (see reduce()).
    readyNotified: false,
    // Split from readyNotified the same way handoff.done is split from handoff.notified
    // (codex review round 1 finding on #206): the review-request effect must not be
    // reissued just because a later event's Telegram send failed and rolled readyNotified
    // back for a retry.
    readyReviewRequested: false,
    // Set whenever a round is dispatched, to 'human' only for an explicit `/ai fix`
    // (never for the automatic codexResult.blocking dispatch) — see the fixResult
    // `disputed` handling below, which must not treat a human-dispatched round as the
    // benign "review's open-thread-block resolved itself" no-op just because a stale
    // standing review happens to still carry that marker.
    roundOrigin: null,
    // Latches the Telegram ping for a no-op re-queue (see fixResult handling below):
    // unlike ready/needs-human, that transition lands back on the generic `ai:queued`/
    // `ai:reviewing` states with nothing else to recheck, so a failed/disabled send
    // needs its own durable record to retry against (see the replay block below and
    // the failed-delivery rollback in orchestrate.js).
    noOp: null,
    // A BODY-ONLY summoned review's id, latched only while `ai:fixing` deliberately
    // ignores it (a round is already in flight — see the summoned-review block below). If
    // that round goes on to push, the review becomes stale for `latestSummonedReviewId`
    // the moment the head moves (`inspectReview`'s `commit_id !== headSha` check) and is
    // gone for good — a body-only review has no thread for the durable-thread gate to
    // recover either. The head-change block below checks this and hands off instead of
    // quietly resuming automation on a finding the fixer never saw (#105 round-2 finding).
    // A THREADED summoned review is never latched here: its thread survives any push and
    // keeps blocking a future clean scan on its own (#105 round-5 finding).
    summonedDuringFix: null,
    // The FULL set of standing summoned review ids `standingSummonedReviewIds`
    // (orchestrate.js) snapshots at the same moment `summonedDuringFix` above latches —
    // not just that single oldest id. `summonedDuringFix` can represent two distinct
    // reviews at once (the oldest, plus a newer body-only one hiding behind it — see
    // `summonedReviewHasBodyOnlyPending`), and dismissing only the oldest must not read as
    // releasing a still-outstanding newer one (P1 finding on #119). Always reset in lockstep
    // with `summonedDuringFix` below — never meaningful on its own.
    summonedDuringFixIds: null,
    history: [],
    // Bounded list, not a single last id: a manual Actions re-run can replay an older
    // comment id after a newer command already advanced past it (see reduce()).
    command_ids: [],
  };
}

const COMMAND_ID_CAP = 20;

function markCommandProcessed(s, id) {
  if (id == null) return;
  s.command_ids.push(id);
  if (s.command_ids.length > COMMAND_ID_CAP) s.command_ids.splice(0, s.command_ids.length - COMMAND_ID_CAP);
}

// The state marker must open the comment body, not merely appear somewhere inside it:
// renderComment() always emits it as the very first line, and anchoring here is what
// keeps a marker-shaped string smuggled into PR-controlled text (a filename, a review
// snippet quoted into a handoff block or echo) from being mistaken for the real state
// store if the genuine sticky comment is ever missing (findSticky in orchestrate.js).
export function parseStateComment(body) {
  if (!body?.startsWith(MARKER_START)) return null;
  const end = body.indexOf(MARKER_END, MARKER_START.length);
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(body.slice(MARKER_START.length, end).trim());
    if (parsed?.v !== STATE_VERSION) return null;
    // Backward compat: a sticky comment persisted before `failureConfirmedSha` was
    // introduced has no such key, and STATE_VERSION wasn't bumped for it (see the
    // `codex` field's comment above on why in-flight state isn't migrated that way).
    // Without this, the first orchestration pass after deploy reads `undefined`,
    // which never equals `pr.headSha`, so an already-once-counted failure on an
    // unchanged head gets recounted — recreate the marker from the legacy
    // `sha`/`conclusion` pair exactly as the old dedupe check read them.
    if (parsed.ci && parsed.ci.failureConfirmedSha === undefined) {
      parsed.ci.failureConfirmedSha = parsed.ci.conclusion === 'failure' ? parsed.ci.sha : null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Parse an echo comment's `n=<timeline count at post time>` marker, or null if absent/malformed. */
export function parseEchoMarker(body) {
  const start = body?.indexOf(ECHO_MARKER_START);
  if (start === undefined || start === -1) return null;
  const end = body.indexOf(ECHO_MARKER_END, start);
  if (end === -1) return null;
  const n = Number(body.slice(start + ECHO_MARKER_START.length, end).trim());
  return Number.isInteger(n) ? { n } : null;
}

function log(state, event, from) {
  state.history.push({ t: new Date().toISOString(), event, from, to: state.state });
  if (state.history.length > HISTORY_CAP) state.history.splice(0, state.history.length - HISTORY_CAP);
}

function toHandoff(state, reason, effects, event, active, runUrl = null) {
  if (state.handoff.done) return; // fires once per episode
  const from = state.state;
  state.state = 'ai:needs-human';
  // Only latch `done`/`notified` for real: a dry-run preview must not silently mark
  // the request/notification as sent, or activating later would dedupe away the real one.
  state.handoff = { done: active, notified: active, reason, ...(runUrl ? { runUrl } : {}) };
  log(state, event, from);
  effects.push({ type: 'request-human-review' }, { type: 'notify', kind: 'needs-human', reason, ...(runUrl ? { runUrl } : {}) });
}

/**
 * The transition brain: pure function from (previous state + gathered inputs)
 * to (next state + side-effects for the executor). Idempotent: replaying the
 * same input over the resulting state yields no new effects.
 *
 * @param {object} input
 * @param {object|null} input.prev previous durable state (or null)
 * @param {{number: number, headSha: string}} input.pr live PR
 * @param {object} input.policy normalized policy
 * @param {object} input.risk classifyRisk() result for the current head
 * @param {string} input.event short event descriptor for the audit log
 * @param {object|null} input.codexResult latestCodexResult() for the current head
 * @param {'success'|'failure'|'pending'} input.ci CI status for the current head
 * @param {{outcome: 'pushed'|'disputed'|'failed'|'skipped', runUrl?: string, reviewUrl?: string}|null} input.fixResult
 *   fixer job report; `runUrl` (meaningful on `failed`/`skipped`) and `reviewUrl` (the
 *   standing review a `disputed` outcome may need to link, when the record can't say what
 *   happened) are pure inputs built by the caller from its own ambient run context — never
 *   read from env here, to keep this function pure. `skipped` means claude-code-action's
 *   own workflow-validation guard refused to run at all (the PR edits the workflow file
 *   the run came from) — distinct from `failed` (it ran and errored) and from `disputed`
 *   (it ran, reported success, pushed nothing) — see docs/troubleshooting.md.
 * @param {boolean} input.pushedByHuman head moved by a listed human (resets the episode)
 * @param {boolean} input.codexDismissed the codex review this state relied on was dismissed
 * @param {{type: 'retry'|'fix'|'refresh'|'round-cap', instruction?: string, cap?: number, id?: number|string}|null} input.humanCommand
 *   a listed human's /ai command — the explicit control surface; overrides latches by
 *   design. `id` (the triggering comment id) dedupes a replayed/rerun delivery of the
 *   same command. `round-cap`'s `cap` is a non-negative integer, this PR's new episode
 *   budget (issue #112) — survives every reset in this function.
 * @param {object[]|null} [input.openThreads] qualifying unresolved review threads, fetched
 *   fresh by the caller — meaningful alongside a `disputed` fixResult (to classify a
 *   no-push round, see the fixResult handling below) and alongside an `/ai refresh`
 *   command (see below). `null` means "couldn't be confirmed" (GraphQL fetch failed),
 *   never conflated with "confirmed empty" — an unknown thread state must never read as
 *   agreement.
 * @param {number|null} [input.summonedReviewId] id of a human-summoned `@codex review` /
 *   `@claude review` with open findings on the current head (#58/#103) — never evidence
 *   (it never flows through `codexResult`; its silence must never promote `ai:ready`),
 *   only an invalidation trigger for a stale clean/ai:ready verdict. See
 *   docs/adr/0007-summoned-reviews-block-never-promote.md and orchestrate.js's derivation.
 * @param {boolean} [input.summonedReviewHasThread] whether that same standing summoned
 *   review actually originated an inline finding (a thread), as opposed to being
 *   body-only (`CHANGES_REQUESTED` with no inline comments). Gates the `summoned_floor`
 *   no-push release path below — see its comment for why a body-only review must never
 *   release through thread resolution. Defaults `false` (fail toward blocking): a caller
 *   that omits this must not accidentally unlock a release path it didn't confirm.
 * @param {string|null} [input.summonedReviewUrl] link to the standing summoned review, for
 *   the `summoned-review-no-thread` handoff below (a body-only review's thread list is
 *   empty by construction, so this is the only thing for a human to click).
 * @param {boolean} [input.summonedReviewHasBodyOnlyPending] whether ANY standing summoned
 *   review is body-only — not just the oldest one `summonedReviewId` reports. Widens the
 *   `summonedDuringFix` latch below to also cover a newer body-only review hidden behind
 *   an older still-outstanding threaded one, which `summonedReviewId`/
 *   `summonedReviewHasThread` alone can never see (#105 finding). Defaults `false`: a
 *   caller that omits this falls back to the existing `!summonedReviewHasThread` check
 *   alone, rather than silently widening a latch condition it never confirmed.
 * @param {boolean} [input.summonedDuringFixDismissed] whether EVERY summoned review
 *   standing as of the prior head has since been explicitly dismissed, checked by the
 *   caller independent of the current head or current policy (a plain `summonedReviewId ==
 *   null` this event can't distinguish "dismissed" from "just went stale by commit_id
 *   because a push landed" — see the head-change block below — or from "reclassified out of
 *   the summoned-actor set by a base-policy edit," which the no-push release branch further
 *   down hits the same way — P1 finding on #119). Deliberately not scoped to just the single
 *   review id `prev.summonedDuringFix` remembers: that latch can represent a newer
 *   body-only review hiding behind an older threaded one, so dismissing only the older one
 *   must not read as fully releasing it. Gates BOTH the head-change block's stale-latch
 *   read below and the no-push release branch further down — `summonedReviewId == null`
 *   alone is never sufficient proof of release in either place. Defaults `false` (fail
 *   toward blocking): a caller that omits this must not accidentally suppress a real
 *   handoff or accidentally release a still-standing latch.
 * @param {number[]} [input.summonedReviewIds] every standing summoned review id as of the
 *   CURRENT head — the full set `standingSummonedReviewIds` (orchestrate.js) reports, not
 *   just the oldest one `summonedReviewId` is. Snapshotted into `summonedDuringFix`'s
 *   sibling `summonedDuringFixIds` field at latch time so a later
 *   `allSummonedReviewsDismissed` check can verify each represented review individually
 *   (P1 finding on #119). Defaults `[]`: a caller that omits this latches an empty set
 *   rather than guessing.
 * @returns {{next: object, effects: {type: string}[]}}
 */
export function reduce({
  prev, pr, policy, risk, event, codexResult, ci, fixResult, pushedByHuman = false,
  codexDismissed = false, humanCommand = null, openThreads = null, summonedReviewId = null,
  summonedReviewHasThread = false, summonedReviewUrl = null, summonedReviewHasBodyOnlyPending = false,
  summonedDuringFixDismissed = false, summonedReviewIds = [],
}) {
  const effects = [];
  let s = prev ? structuredClone(prev) : newState(pr.number, pr.headSha, policy.mode);
  // A bot-sourced codexResult carries `.id`; a human-sourced one carries `.reviewId`
  // instead (see humanBlockingResult in orchestrate.js) — both key the same GitHub
  // PR-review id space, so either is valid review-floor evidence. Reading only `.id`
  // (as every review_floor site below used to) silently never raises the floor past a
  // standing human review, leaving an older pre-reconciliation bot review free to be
  // re-consumed by a later event once the human review is dismissed/superseded.
  const codexResultId = codexResult?.id ?? codexResult?.reviewId ?? null;
  s.mode = policy.mode;
  s.command_ids ??= []; // back-compat: older stored state used a single `last_command_id`
  // ponytail: back-compat for state persisted before this field existed — defaulting to
  // false (not true) means an already-active-and-notified ai:ready PR from before this
  // deploy can fire one harmless duplicate ping, but a dry-run-reached one gets the real
  // notify it was missing. Favor delivering over dropping, same call toHandoff makes below.
  s.readyNotified ??= false;
  // back-compat: state persisted before the readyNotified/readyReviewRequested split had
  // only `readyNotified`. Default to it: a previously-completed promotion is presumed to
  // have requested review together with the ping, same assumption the old single-latch
  // code made (mirrors handoff.notified's default below).
  s.readyReviewRequested ??= s.readyNotified;
  // back-compat: state persisted before the done/notified split had only `done`. Default
  // `notified` to `done` — a previously-completed handoff is presumed to have gone out
  // together with the request, same assumption the old single-latch code made.
  s.handoff.notified ??= s.handoff.done;
  // back-compat: state persisted before rounds_total/cap existed.
  // ponytail: back-fill from history, not from `s.round` — `??= s.round` would give a
  // PR that has already retried/re-episoded a total equal to just its current episode
  // (issue #110's own motivating example, #105, would read `1` instead of ~11). Only
  // two sites in this function set `to: 'ai:fixing'`, each immediately followed by
  // log(), so each such entry is exactly one dispatch. Ceiling: HISTORY_CAP is 40, so
  // this is a floor once history has started truncating, not an exact count — a floor
  // that's right about the thrashing beats a number that erases it. Clamped to at least
  // `s.round`: the current episode's round is itself a lower bound on lifetime dispatches,
  // and a truncated history must never backfill a total below the round it's reporting
  // alongside. Exact from here on, since rounds_total increments live once the field exists.
  s.rounds_total ??= Math.max(s.history.filter((h) => h.to === 'ai:fixing').length, s.round);
  s.cap ??= null;
  const active = policy.mode === 'active';
  // Derived, not stored as the source of truth: recomputed every call so a policy change
  // propagates on the next event. Denormalized into state (rather than threaded as a
  // parameter) because renderComment/renderEcho/describeHandoff only ever see `state`,
  // never `policy`.
  s.effective_cap = s.cap ?? policy.maxRounds;

  // New head SHA → new cycle. Round survives a fixer push; a human push resets the episode.
  // A non-human push while latched at `ai:needs-human` must NOT resume automation —
  // only a listed human's push (`pushedByHuman`) may leave that state.
  if (s.head_sha !== pr.headSha) {
    const from = s.state;
    const latched = from === 'ai:needs-human' && !pushedByHuman;
    // Read before this event's reset below clears it. Not restricted to `from ===
    // 'ai:fixing'` (#115): the round that ignored this latch may have already routed
    // through an intermediate, unrelated `ai:needs-human` handoff (a same-event dispute/
    // failure classified below) before the human's push lands here — by then `from` is
    // that handoff's state, not `ai:fixing`, and a `from`-gated read would silently
    // discard a still-real, unaddressed latch. Most legitimate release paths (`/ai
    // retry`/`/ai fix` confirmed-addressed, `/ai refresh`, a no-push dismissal observed on
    // the unchanged head) already null the field itself before this point. An explicit
    // dismissal that lands in the SAME event as the push is the one exception — by the
    // time `summonedReviewId` is derived here it is already null via `commit_id !==
    // headSha` staleness regardless of dismissal (see inspect-review.js), so that signal
    // alone can't tell "ignored and pushed" apart from "dismissed and pushed" here.
    // `summonedDuringFixDismissed` is orchestrate.js's answer to that specific question —
    // it checks the latched review id's OWN state, independent of head — so only a
    // genuinely-ignored latch still forces the handoff below (P1 finding on #119).
    const summonedDuringFix = summonedDuringFixDismissed ? null : s.summonedDuringFix;
    s.head_sha = pr.headSha;
    // `summoned_floor` resets too — moot for the OLD review (it goes stale via
    // `commit_id !== headSha` regardless), but a genuinely new summoned review posted
    // against the NEW head must start unreleased, not inherit a stale floor.
    // `human_review_id` deliberately does NOT reset here, unlike every other codex.*
    // field: `humanBlockingResult` (orchestrate.js) is no longer SHA-gated (round 4
    // finding on #1 — a human's REQUEST_CHANGES stands until dismissed, regardless of
    // how many pushes happen under it), so the same still-standing review keeps
    // re-deriving as blocking evidence after every push. If this reset to null here,
    // `alreadyHandledHumanReview` below would see a fresh miss and re-dispatch an
    // uncapped fix round for the exact same, already-addressed-once review on every
    // subsequent push, forever.
    s.codex = {
      requested_sha: null, reviewed_sha: null, result: null, human_review_id: s.codex.human_review_id, review_floor: 0, summoned_floor: 0,
    };
    s.fixer = { sha: null, outcome: null };
    s.summonedDuringFix = null;
    s.summonedDuringFixIds = null;
    if (!latched) s.state = 'ai:queued';
    if (pushedByHuman) {
      s.round = 0;
      s.handoff = { done: false, notified: false, reason: null };
      s.ci.consecutive_failures = 0;
      // A human push starts a new episode — the once-per-episode ready ping must be
      // free to fire again, or a prior episode's latch silently swallows this one's.
      s.readyNotified = false;
      s.readyReviewRequested = false;
    }
    log(s, `${event} (new head${latched ? ', latched' : ''})`, from);
    if (summonedDuringFix != null) {
      // The round ignored this summoned review to avoid interrupting itself, then
      // pushed — the review is unrecoverable from here (stale by commit_id, no
      // thread). Resuming automation on the queued/reviewing path above would let a
      // fresh clean result silently promote without ever addressing it; hand off
      // instead, same fail-toward-blocking call as every other standing-review case.
      toHandoff(s, 'summoned-review-during-fix', effects, event, active);
    }
  }
  s.risk = risk;

  // The Codex review this head's `clean`/`blocking` result relied on was dismissed —
  // it no longer counts as an active review, so a stored `ai:ready` (or any recorded
  // result) for this head must not keep reporting a clean review that no longer exists.
  if (codexDismissed && s.codex.reviewed_sha === pr.headSha && s.state !== 'ai:fixing' && s.state !== 'ai:needs-human') {
    const from = s.state;
    // `summoned_floor` carries forward unchanged — this dismissal is about the recognized
    // reviewer's OWN evidence, orthogonal to whether a standing summoned review's block
    // has been released.
    s.codex = {
      requested_sha: null, reviewed_sha: null, result: null, human_review_id: null,
      review_floor: 0, summoned_floor: s.codex.summoned_floor ?? 0,
    };
    s.state = 'ai:queued';
    log(s, `${event} (codex review dismissed)`, from);
  }

  // A human-summoned `@codex review` / `@claude review` with open findings on the current
  // head (#58/#103) — see docs/adr/0007-summoned-reviews-block-never-promote.md. It never
  // supplies a verdict (it never becomes `codexResult` — see its derivation in
  // orchestrate.js, which keeps its silence from ever promoting anything); it only
  // invalidates a stale clean verdict, including one already latched into `ai:ready`.
  // Modeled on the codexDismissed branch just above: neither resumes automation out of
  // `ai:fixing` (a round is already in flight — though it's latched into
  // `summonedDuringFix` rather than dropped; see the head-change block above and the
  // branch below) nor an `ai:needs-human` latch (a human is already on the hook — and
  // change 2's widened qualifyUnresolvedThreads now surfaces these same open threads in
  // the handoff block regardless of `handoff.reason`, so the finding isn't silently lost
  // there either).
  //
  // Re-fire guard is two mechanisms, not one. Within a head: `review_floor` latches to
  // this review's id, so a later event re-deriving the SAME still-standing review (e.g.
  // the fixer resolved every thread without pushing — head unchanged) reads
  // `summonedReviewId <= review_floor` and does not re-fire. Across a head change:
  // `review_floor` itself resets to 0 (see the head-change block above), so mechanism one
  // alone would re-fire forever once the head moves. What actually stops that is
  // `summonedReviewId`'s derivation in orchestrate.js going through `inspectReview`, whose
  // `review.commit_id !== headSha` check marks the old review stale — it never reaches
  // this branch again once the head advances.
  //
  // `skipStaleCleanAfterSummonedInvalidation` below (keyed on `summonedReviewId >
  // summoned_floor`, not on whether the reset just below fires this call) gates the
  // codexResult-consuming block for as long as this same summoned review stands
  // UNRELEASED, the same way `skipStaleCleanOnRetry` already does for /ai retry. Without
  // it: a body-only summoned CHANGES_REQUESTED review (blocking via `review.state`, no
  // inline comments — so `qualifyUnresolvedThreads` never sees it either) can stand
  // alongside a genuinely fresh, higher-id CLEAN `codexResult` from a recognized reviewer
  // that hasn't seen this finding (it's not a thread, so nothing in the durable-memory
  // gate flagged it for that reviewer to notice). `staleByFloor` alone would NOT catch
  // that clean result — its id is above the newly-bumped floor — so once
  // `summonedReviewId` settles at the (now-equal) `review_floor` (the very next event,
  // since the reset below no longer re-fires) it would be consumed and promote straight
  // back to `ai:ready`, undoing the reset below and firing a duplicate `notify: ready`
  // one event later than the naive fix would suggest.
  //
  // `summoned_floor` is the THIRD release path, separate from `review_floor`: a summoned
  // review's inline finding can be legitimately resolved (the reviewer-sweep re-verifies
  // and resolves its GraphQL thread — `THREAD_RESOLUTION_RULES.reviewer` forbids the
  // fixer itself from doing this at `thread_authority: reviewer`, so resolution IS
  // reviewer confirmation there, and the no-op-round machinery already accepts the same
  // trade-off at the default `fixer` tier) entirely WITHOUT a push. `resolveReviewThread`
  // touches neither `review.state` nor the REST inline comments, so `summonedReviewId`
  // keeps re-deriving the same non-null id from GitHub forever — `review_floor` alone
  // never falls back to 0 for it (no push, no dismissal), so the block would never lift.
  // The `no-op round — threads resolved` branch below (state.js's `fixResult` handling)
  // is exactly the confirmation that every reviewer-role-originated thread — including
  // one a summoned review originated — is resolved; it bumps `summoned_floor` to record
  // that release for this review id.
  if (summonedReviewId != null && summonedReviewId > (s.codex.review_floor ?? 0) && s.state !== 'ai:needs-human') {
    // Latch unconditionally (before we know whether this call ends in `ai:fixing`) only
    // for a BODY-ONLY review: an unrelated recognized-reviewer `codexResult` gathered in
    // this SAME event can still drive the codexResult-consuming block below into
    // `ai:fixing` even though we're re-queuing (not fixing) right here (#105 round-4
    // finding) — without the latch, that block's own transition never sees `s.state ===
    // 'ai:fixing'` at latch time, so the head-change block above finds nothing to hand off
    // when that round later pushes, and a body-only finding has no thread for the
    // durable-memory gate to recover once the head moves. Harmless to re-latch the same id
    // on every event while a round is still running (idempotent write, no state
    // transition) — see the head-change block's consumption.
    //
    // A THREADED summoned review needs no latch of its own: its thread stays open (durable,
    // anchored to any commit — review-threads.js) regardless of which round eventually
    // pushes, so the next local sweep re-derives it via `qualifyUnresolvedThreads` and
    // reconverts clean to blocking on its own. Latching here would force a false-positive
    // `summoned-review-during-fix` handoff even when the very round that pushed was
    // dispatched specifically to address this exact thread (#105 round-5 finding).
    //
    // But `summonedReviewId`/`summonedReviewHasThread` only ever see the OLDEST standing
    // summoned review — a newer BODY-ONLY one arriving while an older threaded one is still
    // outstanding stays invisible to both (orchestrate.js's `latestSummonedReview` docstring)
    // until the older one releases. If the round in flight pushes before that release — even
    // to address the older review's own thread — every standing review goes stale by
    // commit_id in the same instant, so the newer body-only one, having no thread of its
    // own, would vanish with no latch to catch it. `summonedReviewHasBodyOnlyPending` scans
    // ALL standing candidates (not just the oldest) so that case still latches too (#105
    // finding).
    if (!summonedReviewHasThread || summonedReviewHasBodyOnlyPending) {
      s.summonedDuringFix = summonedReviewId;
      // Union with whatever is already latched, not overwrite: this block re-fires on
      // every event while a round stays `ai:fixing` (the "idempotent re-latch" comment
      // above), and `summonedReviewIds` is reclassified through the CURRENT policy each
      // time (orchestrate.js). A base-policy edit that reclassifies one already-latched
      // review's author out of the summoned-actor set — while another latched review
      // stays classified — must not let a later re-fire silently drop the reclassified
      // one from the snapshot; only an explicit per-id dismissal (checked independently
      // of policy by `allSummonedReviewsDismissed`) may release it (P1 finding on #119).
      s.summonedDuringFixIds = [...new Set([...(s.summonedDuringFixIds ?? []), ...summonedReviewIds])];
    }
    if (s.state !== 'ai:fixing') {
      const from = s.state;
      // The floor must also cover a fresh recognized-reviewer `codexResult` that this SAME
      // event suppresses as clean (skipStaleCleanAfterSummonedInvalidation below), not just
      // `summonedReviewId` — otherwise `needsReview()` (the companion's review sweep) sees that same
      // still-standing result as `existingResult.id > review_floor` and refuses to post
      // again ("already posted, awaiting orchestrator"), while `reduce()` here refuses to
      // ever consume it (the summoned review still stands). Neither side moves: the sweep
      // never gets to re-scan and let `qualifyUnresolvedThreads` convert its own verdict to
      // blocking, so a threaded summoned review's documented self-resolving path never
      // actually fires. Restricted to a result that would actually BE suppressed (mirrors
      // skipStaleCleanAfterSummonedInvalidation's own exclusions) — folding in a genuinely
      // blocking/contested/awaitingHuman result's id here would make `staleByFloor` (below)
      // wrongly swallow this SAME event's normal, unsuppressed consumption of it.
      const suppressedCleanId = codexResult && !codexResult.blocking && !codexResult.contested
        && !codexResult.awaitingHuman ? (codexResult.id ?? 0) : 0;
      s.codex = {
        requested_sha: null, reviewed_sha: null, result: null, human_review_id: null,
        review_floor: Math.max(s.codex.review_floor ?? 0, summonedReviewId, suppressedCleanId),
        summoned_floor: s.codex.summoned_floor ?? 0,
      };
      s.state = 'ai:queued';
      s.readyNotified = false;
      s.readyReviewRequested = false;
      log(s, `${event} (summoned review — re-queued)`, from);
    }
  } else if (s.summonedDuringFix != null && summonedReviewId == null && summonedDuringFixDismissed) {
    // The body-only review this latch was guarding against is no longer standing on the
    // UNCHANGED head — with commit_id staleness ruled out (that's the head-change block's
    // case, which already reads and clears this latch before we get here). But
    // `summonedReviewId` going null here is NOT on its own proof of dismissal:
    // `summonedReviewCandidates` (orchestrate.js) classifies through
    // `reviewerRoleAgents`/`recognizedReviewActors`, both reloaded fresh from the current
    // policy every run, so a base-branch policy edit that reclassifies the latched review's
    // author out of those sets makes it vanish from candidates for a reason that has nothing
    // to do with dismissal (P1 finding on #119). `summonedDuringFixDismissed` is the same
    // raw-review-state check the head-change block already relies on for this — since the
    // head is unchanged here, the prior head it's computed against equals the current one, so
    // it's equally valid as this branch's gate. Only clear the latch once it confirms every
    // review the latch represents is actually `DISMISSED`, so a later push doesn't force a
    // false `summoned-review-during-fix` handoff for a finding that was already released
    // (#105 finding) — but a reclassification alone leaves the latch standing, fail toward
    // blocking.
    s.summonedDuringFix = null;
    s.summonedDuringFixIds = null;
    // If that release is what the standing `summoned-review-no-thread` handoff itself was
    // waiting on, resume automation now — handoff.js's own scope text promises the human
    // "dismiss the review... releases the block", but `ai:needs-human` isn't among
    // `codexConsumingStates` for a non-human-sourced result, so without this the PR would
    // otherwise sit stuck there forever even after the human did exactly what was asked.
    // Scoped to this exact reason so a human stuck at `ai:needs-human` for an unrelated
    // cause (e.g. `ci-failing`) is never silently resumed out from under them — only an
    // explicit `/ai retry`/`/ai fix` may do that.
    if (s.state === 'ai:needs-human' && s.handoff.reason === 'summoned-review-no-thread') {
      const from = s.state;
      s.state = 'ai:queued';
      s.handoff = { done: false, notified: false, reason: null };
      s.readyNotified = false;
      s.readyReviewRequested = false;
      log(s, `${event} (summoned review no-thread — dismissed)`, from);
    }
  }

  // A listed human's explicit /ai command — the one input allowed to clear any latch
  // (needs-human, round budget): the human IS the oversight those latches exist for.
  // A duplicate webhook delivery or a manual Actions re-run replays the same comment id;
  // skip it once already processed so it can't double-dispatch a fix round. Tracked as a
  // bounded list, not just the last id: a manual re-run of an *older* workflow run can
  // replay a comment id after a newer command already moved `command_ids` past it.
  let retriedThisEvent = false;
  // Set below, inside the retry branch, when the handoff this retry just cleared was
  // itself a dispute (agents-disagree/agents-may-disagree/reviewer-sustained) — see
  // `skipStaleCleanOnRetry` further down, and ADR-0009's gap this closes (#188).
  let retriedOffDisputeThisEvent = false;
  // The human review id (if any) already recorded as consumed for that same disputed
  // round, captured before the retry branch's reset nulls it — lets the check further
  // down tell "the exact review that produced this dispute, still standing" apart from
  // "an unrelated, never-yet-consumed human review that happens to arrive in this same
  // event" (e.g. a lost webhook finally caught by a later `/ai retry`). Only the former
  // is stale; the latter is fresh, human-actionable evidence and must still dispatch.
  let priorHumanReviewIdAtRetry = null;
  // Set as soon as a /ai refresh command is processed, regardless of which outcome branch
  // it takes below — gates the codexResult-consuming block further down so a
  // reconciliation's own call never dispatches a fixer round (see ADR-0006's Consequences:
  // "never dispatches a fixer round, in its own effects or by consuming a still-standing
  // review within the same call"). Without this covering every branch, a standing human
  // review not yet recorded in `s.codex.human_review_id` — e.g. the webhook that would
  // have recorded it was lost while state sat at `ai:ready` or latched at
  // `ai:needs-human` — gets silently consumed by that block in this same call, starting a
  // fix round the reconciliation reply never mentioned.
  let refreshedThisEvent = false;
  // Set when refresh declines because it can't confirm nothing's blocking (an open
  // qualifying thread, or a failed thread-status fetch) — gates the CI-driven
  // `ai:ready` promotion below (state.js:~530) so a decline can't fall straight through
  // to a promotion in the very same call it just reported as blocked on.
  let refreshDeclinedThisEvent = false;
  if (humanCommand && humanCommand.id != null && s.command_ids.includes(humanCommand.id)) {
    // no-op: already processed this exact command. A replayed `/ai refresh` (a duplicate
    // webhook, or a manual Actions re-run of the same job) must stay a true no-op — the
    // original call already reset state (e.g. to `ai:queued`) without necessarily having
    // consumed a still-standing human review, so without this the codexResult-consuming
    // block below would see that same review again on the replay and dispatch a fixer,
    // breaking refresh's no-dispatch contract.
    // `refreshDeclinedThisEvent` must replay too: a threads-open decline marks the command
    // processed, so its replay (duplicate webhook, or a manual Actions re-run of the same
    // job) lands here — without this, CI flipping to success between the original call and
    // the replay would promote straight to `ai:ready` below off a stale recorded 'clean'
    // result despite the same still-open threads the original call declined over. Safe to
    // set unconditionally on any replayed refresh: it only gates a `result === 'clean'`
    // promotion, which a re-queued or nothing-to-reconcile outcome never leaves standing.
    if (humanCommand.type === 'refresh') { refreshedThisEvent = true; refreshDeclinedThisEvent = true; }
  } else if (humanCommand?.type === 'retry') {
    const from = s.state;
    // Captured before the reset just below clears it — a retry that's clearing a dispute
    // handoff (see `retriedOffDisputeThisEvent` below) means the standing review already
    // produced this exact dispute once; it must not be treated as fresh, unconsumed
    // evidence for a second fixer round.
    const priorHandoffReason = s.handoff.reason;
    retriedOffDisputeThisEvent = DISPUTE_REASON_LABELS.has(priorHandoffReason);
    priorHumanReviewIdAtRetry = s.codex.human_review_id;
    // Drift review on #1 round 4: a retry that is ABOUT to skip re-consuming the exact
    // review that produced this dispute (the `skipStaleCleanOnRetry` dispute clause
    // further down) must not null `human_review_id` here either — round 4's fix made
    // `human_review_id` survive a head change specifically so `alreadyHandledHumanReview`
    // keeps recognizing this same still-standing review after a later, unrelated push;
    // nulling it here (even though this event skips consumption) throws that away with
    // nothing to restore it, reopening the exact loop round 4 closed. Every OTHER retry
    // still nulls it unconditionally — that's the intentional escape hatch letting a
    // human force reconsideration of an already-handled standing review.
    const freshHumanReviewAtRetry = codexResult?.source === 'human' && codexResult?.reviewId != null
      && codexResult.reviewId !== priorHumanReviewIdAtRetry;
    const preserveHumanReviewIdAtRetry = retriedOffDisputeThisEvent && codexResult?.source === 'human'
      && !freshHumanReviewAtRetry ? priorHumanReviewIdAtRetry : null;
    s.round = 0;
    s.handoff = { done: false, notified: false, reason: null };
    // Reset the CI snapshot too, not just the counter: without this, `s.ci.sha` still
    // equals the (unchanged) head, so the failure-counting check below never re-counts
    // still-red CI and a `ci-failing` handoff can't refire until an unrelated push.
    s.ci = { sha: null, conclusion: null, consecutive_failures: 0, failureConfirmedSha: null };
    // `review_floor` latches the id of whatever review currently stands (if any) as the
    // ceiling of "stale, pre-retry" evidence — any later event that re-derives the same
    // standing review from GitHub (a CI/status event, another cron tick) must not treat
    // it as a fresh answer to *this* request and re-populate `reviewed_sha`, or the retry
    // is silently defeated before a new review is ever posted (see the codexResult
    // consumption guard below).
    // `summoned_floor` carries forward unchanged — a retry distrusts the recognized
    // reviewer's own last verdict, not a standing summoned review's release state.
    s.codex = {
      requested_sha: null, reviewed_sha: null, result: null, human_review_id: preserveHumanReviewIdAtRetry,
      review_floor: Math.max(s.codex.review_floor ?? 0, codexResultId ?? 0),
      summoned_floor: s.codex.summoned_floor ?? 0,
    };
    s.fixer = { sha: null, outcome: null };
    s.state = 'ai:queued';
    // A retry is a full look-again request — if a prior episode already sent the ready
    // ping, this latch must not silently swallow the fresh episode's, same as the
    // pushedByHuman reset above.
    s.readyNotified = false;
    s.readyReviewRequested = false;
    // Same stale-latch risk `/ai fix` guards against below — but unlike `/ai fix`, a bare
    // `/ai retry` carries no general guarantee the human is responding to this exact
    // review, or that whatever round it dispatches (in this same event, off an unrelated
    // standing `codexResult`) will even touch it: only clear the latch once the review is
    // no longer standing (`summonedReviewId == null` — dismissed, or already stale by
    // commit_id), the same release condition the top-of-function block uses. An earlier
    // version also cleared unconditionally when `from` was the exact
    // `summoned-review-no-thread` handoff this retry answers, trusting the human to be
    // responding to it specifically — but by the time that handoff exists, the
    // top-of-function block has already bumped `review_floor` to cover `summonedReviewId`
    // (its own re-queue, the same event the handoff was reached), so that block's
    // `summonedReviewId > review_floor` re-latch condition can never fire again for this
    // id either. `summonedDuringFix` is thus this review's ONLY remaining safety net once
    // at that handoff, and a same-event unrelated blocking `codexResult` can consume this
    // very retry to dispatch a round for ITS OWN findings only — never seeing the summoned
    // review's — so clearing the net out from under it here permanently drops the finding
    // with no push or dismissal ever having released it (#105 finding; unlike `/ai fix`
    // below, a bare retry never hands the summoned review's own findings to the fixer, so
    // it earns none of that branch's trust).
    // `summonedReviewId == null` alone is not proof of release (same reasoning as the
    // top-of-function no-push branch above and the head-change block's read further up):
    // a base-policy edit can reclassify the latched review's author out of the
    // summoned-actor set without it ever being dismissed. Require `summonedDuringFixDismissed`
    // too, so a bare `/ai retry` can't silently drop a still-standing, unaddressed summoned
    // review just because this event's current-policy classification stopped seeing it
    // (P1 finding on #119).
    if (summonedReviewId == null && summonedDuringFixDismissed) {
      s.summonedDuringFix = null;
      s.summonedDuringFixIds = null;
    }
    markCommandProcessed(s, humanCommand.id);
    retriedThisEvent = true;
    log(s, `${event} (/ai retry)`, from);
    // fall through: the request-codex block below re-latches a fresh review request
  } else if (humanCommand?.type === 'fix') {
    const from = s.state;
    // Captured before the reset just below clears it — needed to tell "this /ai fix is
    // the human directly responding to the standing summoned review" apart from "this
    // /ai fix is about something else entirely" (#115; see the summonedDuringFix clear
    // further down).
    const priorHandoffReason = s.handoff.reason;
    s.handoff = { done: false, notified: false, reason: null };
    const nextRound = s.round + 1; // counted for the audit trail, but human-initiated fixes are never capped
    // In dry-run, `main()`'s `shouldFix` also requires `active`, so no fixer job actually
    // runs and no `fixResult` will ever arrive to move the PR out of `ai:fixing` again —
    // latching real state and consuming the command here would strand the PR and
    // silently swallow the command the moment the policy switches to active. Only
    // narrate the effect (for the dry-run note); keep state and dedup untouched so
    // activation still dispatches the real fix.
    if (active) {
      s.round = nextRound;
      s.rounds_total = (s.rounds_total ?? 0) + 1;
      s.state = 'ai:fixing';
      // A human explicitly requesting another look must be free to get the ready ping
      // again once this round concludes, same as the pushedByHuman/retry resets above.
      s.readyNotified = false;
      s.readyReviewRequested = false;
      // This round exists because a human asked for it, not because a standing review's
      // open-thread-block was consumed — see the fixResult `disputed` handling below,
      // which must not read a no-push answer to *this* instruction as the unrelated
      // review having been satisfied.
      s.roundOrigin = 'human';
      // A body-only summoned review may have latched `summonedDuringFix` before this
      // command landed. A human issuing `/ai fix` directly from the handoff that latch
      // caused (`summoned-review-no-thread`, or `summoned-review-during-fix` — the same
      // hazard, discovered via a different path; see the head-change and `/ai refresh`
      // blocks) IS the round seeing the review — left set, the head-change block above
      // would misread this round's own push as one that ignored it and immediately
      // bounce right back to a handoff. Only clear for THOSE two reasons, or once the
      // review is confirmed no longer standing (`summonedReviewId == null` AND
      // `summonedDuringFixDismissed`, the same release condition `/ai retry`/`/ai refresh`
      // use above — plain `summonedReviewId == null` alone can also be a base-policy
      // reclassification, not a dismissal, same P1 finding on #119 those two close) — an
      // `/ai fix` for an unrelated handoff (e.g. `agents-disagree`) must not silently drop
      // a still-standing, unaddressed summoned review just because a fix round happened to
      // run (#115). A summoned review that arrives DURING this new round re-latches on its
      // own (the summoned-review block above runs every event `/ai fix` doesn't skip).
      if ((summonedReviewId == null && summonedDuringFixDismissed)
        || priorHandoffReason === 'summoned-review-no-thread'
        || priorHandoffReason === 'summoned-review-during-fix') {
        s.summonedDuringFix = null;
        s.summonedDuringFixIds = null;
      }
      markCommandProcessed(s, humanCommand.id);
      log(s, `${event} (/ai fix)`, from);
    }
    effects.push({
      type: 'dispatch-fixer', round: nextRound,
      instruction: humanCommand.instruction || null, humanInitiated: true,
    });
  } else if (humanCommand?.type === 'round-cap') {
    const from = s.state;
    s.cap = humanCommand.cap;
    s.effective_cap = s.cap;
    // Raising the cap un-does only the interrupt the cap itself caused. A PR latched on
    // agents-disagree/ci-failing/risk-requires-human etc. has nothing to do with the
    // round budget, and silently resuming it would hand a genuine dispute back to the
    // agents behind the human's back — only a round-limit handoff is this command's to
    // clear. Deliberately does not touch s.round/s.ci — this is not a retry; dropping
    // back to ai:queued just lets the codexResult-consuming block below re-derive the
    // still-standing blocking review (if any) and dispatch against the new cap in this
    // same call. Gated on `s.cap > s.round`: a cap that doesn't actually raise the
    // ceiling past the round already reached changes nothing about the standing
    // round-limit handoff, and clearing+re-latching it anyway would re-run
    // `toHandoff` (its `done` guard was just reset to false) for a duplicate
    // request-human-review/notify the human never asked for (codex review round 1
    // finding on #117).
    if (s.state === 'ai:needs-human' && s.handoff.reason === 'round-limit' && s.cap > s.round) {
      s.state = 'ai:queued';
      s.handoff = { done: false, notified: false, reason: null };
      // Mirrors every other re-entry point (pushedByHuman/retry/`/ai fix` above).
      s.readyNotified = false;
      s.readyReviewRequested = false;
      // Reset the recorded verdict too (review_floor/summoned_floor carried forward
      // unchanged, same reasoning as the codexDismissed/refresh resets above): without
      // this, a review that's no longer live (dismissed or superseded since the
      // round-limit handoff latched) leaves `s.codex.result` stuck at its stale
      // 'blocking' value, which blocks the request-codex gate below (`result === null`)
      // from ever firing — stranding the PR in `ai:queued` with no fresh review
      // requested. A still-live blocking review is unaffected: the codexResult-consuming
      // block below dispatches from THIS call's freshly fetched codexResult regardless
      // of what's stored here.
      s.codex = {
        requested_sha: null, reviewed_sha: null, result: null, human_review_id: null,
        review_floor: s.codex.review_floor ?? 0, summoned_floor: s.codex.summoned_floor ?? 0,
      };
    }
    markCommandProcessed(s, humanCommand.id);
    log(s, `${event} (/ai round-cap ${s.cap})`, from);
  } else if (humanCommand?.type === 'refresh') {
    // Reconciliation (issue #97): re-derive state from the PR's observable facts when a
    // lost or never-run event left the stored state behind reality — never a labels-only
    // operation (labels already reconcile on every run), and never a promotion straight
    // to `ai:ready` (see docs/adr/0006-reconciliation-never-promotes-to-ready.md): a
    // reconciliation that finds nothing blocking re-queues instead, so the confirming
    // verdict always comes from a real review, not stale evidence.
    const from = s.state;
    // Covers every branch below, not just the re-queue one: none of them may let the
    // codexResult-consuming block further down dispatch a fixer round in this same call
    // (see the declaration above and ADR-0006).
    refreshedThisEvent = true;
    if (s.state === 'ai:needs-human' && s.handoff.reason === 'ci-failing' && ci !== 'success') {
      // CI isn't confirmed green on this head yet — still 'failure', or 'pending'
      // because a failed check is rerunning — so clearing the handoff here (because no
      // review threads are open) would re-queue into ai:reviewing, and the
      // failure-counting block below only recounts a failure when `s.ci.sha` changes
      // (see /ai retry's explicit s.ci reset above, which this branch deliberately
      // doesn't do). Left alone with a narrower `ci === 'failure'` check, a rerun
      // landing on 'pending' would slip past this guard, get its SHA recorded as the
      // ci snapshot below, and then silently drop the human escalation when that rerun
      // fails again on the same SHA — the recount never fires because `s.ci.sha` already
      // matches. Only 'success' may clear it.
      markCommandProcessed(s, humanCommand.id);
      effects.push({ type: 'refresh-report', outcome: 'ci-failing' });
    } else if (!Array.isArray(openThreads)) {
      // Thread state couldn't be confirmed (GraphQL fetch failed) — decline loudly
      // rather than guess either way (same "hedge, never suppress" rule classifierThreads
      // documents above), and leave the command unmarked so a manual Actions re-run can
      // retry it. Reaches `ai:ready` too (#123): a recorded 'clean' verdict cannot be
      // trusted safe without confirming thread state, so an unconfirmed fetch on a ready
      // PR must decline exactly like every other state, not fall through to the
      // (formerly first) 'nothing-to-reconcile' branch below.
      refreshDeclinedThisEvent = true;
      effects.push({ type: 'refresh-report', outcome: 'unconfirmed' });
    } else if (openThreads.length > 0) {
      if (s.state === 'ai:ready') {
        // The stored 'clean' verdict contradicts the threads GitHub actually shows open
        // — unlike every other state reaching this branch, that's not "state already
        // agrees, nothing to reconcile," it's exactly the stale-evidence case
        // reconciliation exists to correct (#123: a wrapper review's empty body shadowed
        // a real CHANGES_REQUESTED/CONTESTED verdict, latching `ai:ready` over live
        // findings). Mirrors the no-push re-queue reset below minus the round reset —
        // reconciliation still never *asserts* a verdict in either direction: it clears
        // the stale one and lets a fresh review reconfirm, via the shared
        // ai:queued -> ai:reviewing fall-through further down (same mechanism the
        // re-queue reset relies on, since `refreshDeclinedThisEvent` stays false here).
        s.codex = {
          requested_sha: null, reviewed_sha: null, result: null, human_review_id: null,
          review_floor: Math.max(s.codex.review_floor ?? 0, codexResultId ?? 0),
          summoned_floor: s.codex.summoned_floor ?? 0,
        };
        s.fixer = { sha: null, outcome: null };
        s.summonedDuringFix = null;
        s.summonedDuringFixIds = null;
        s.handoff = { done: false, notified: false, reason: null };
        s.readyNotified = false;
        s.readyReviewRequested = false;
        s.state = 'ai:queued';
        markCommandProcessed(s, humanCommand.id);
        log(s, `${event} (/ai refresh)`, from);
        effects.push({ type: 'refresh-report', outcome: 'threads-open-demoted', threads: openThreads });
      } else {
        // Blocking conversation isn't over — report it and change nothing. A human who
        // wants a fix round despite open threads already has /ai fix and /ai retry.
        refreshDeclinedThisEvent = true;
        markCommandProcessed(s, humanCommand.id);
        effects.push({ type: 'refresh-report', outcome: 'threads-open', threads: openThreads });
      }
    } else if (s.state === 'ai:ready') {
      // Already green and no qualifying thread stands open — nothing to reconcile.
      markCommandProcessed(s, humanCommand.id);
      effects.push({ type: 'refresh-report', outcome: 'nothing-to-reconcile' });
    } else {
      // Nothing blocking left. Mirrors /ai retry's reset (state.js above) minus the round
      // reset — that stays retry's job, so reconciliation can never be a cheap way around
      // max_rounds — and dispatches nothing itself (refreshedThisEvent is already set above).
      const standingHumanReview = codexResult?.source === 'human';
      // A reconciliation out of `ai:fixing` can't tell "the fixer died without reporting"
      // (the case this command exists for) from "a fixer round is still running right
      // now" — same blind spot /ai retry already accepts leaving this state. If a round
      // really is in flight, its later fix-result report only mutates state while
      // `s.state === 'ai:fixing'` (see the fixResult block below); once refresh has
      // already moved off it, a `disputed`/`failed` outcome is silently dropped (a
      // `pushed` outcome is harmless — the resulting `synchronize` drives a new head
      // regardless). Flagged in the reply so a human doesn't reach for `/ai refresh`
      // expecting it to be strictly safe on a PR that's genuinely mid-round.
      const wasFixing = from === 'ai:fixing';
      // Same capture the head-change block above makes before resetting — and, like that
      // block (#115), not restricted to `wasFixing`: a still-set latch here is real
      // regardless of what state refresh found the PR in (every genuine release path
      // already nulls the field itself before this point), so hand it off rather than
      // silently dropping it on an unrelated reconciliation.
      const summonedDuringFix = s.summonedDuringFix;
      s.codex = {
        requested_sha: null, reviewed_sha: null, result: null, human_review_id: null,
        review_floor: Math.max(s.codex.review_floor ?? 0, codexResultId ?? 0),
        // Carries forward unchanged, like every other reset above — this re-queue is about
        // the recognized reviewer's own evidence, orthogonal to whether a standing summoned
        // review's block has been released. Dropping it here (reading back as 0 via the `??`
        // fallback) would let a still-standing, already-released summoned review look
        // unreleased again to `skipStaleCleanAfterSummonedInvalidation` below, suppressing a
        // fresh clean result forever.
        summoned_floor: s.codex.summoned_floor ?? 0,
      };
      s.fixer = { sha: null, outcome: null };
      // Only clear on confirmed release (#115; mirrors /ai retry above), not
      // unconditionally: a still-set latch here is about to be converted into a
      // `summoned-review-during-fix` handoff below — clearing it regardless would let a
      // SECOND `/ai refresh` on the same still-standing review read a stale `null`,
      // report `re-queued`, and resume automation right past a summoned finding that was
      // never actually addressed. `summonedReviewId == null` alone is not confirmation of
      // that release either (same reclassification gap /ai retry closes above) — require
      // `summonedDuringFixDismissed` too, or a base-policy edit can make refresh silently
      // resume automation past an undismissed summoned review (P1 finding on #119).
      if (summonedReviewId == null && summonedDuringFixDismissed) {
        s.summonedDuringFix = null;
        s.summonedDuringFixIds = null;
      }
      s.handoff = { done: false, notified: false, reason: null };
      s.readyNotified = false;
      s.readyReviewRequested = false;
      s.state = 'ai:queued';
      markCommandProcessed(s, humanCommand.id);
      log(s, `${event} (/ai refresh)`, from);
      if (summonedDuringFix != null) {
        toHandoff(s, 'summoned-review-during-fix', effects, event, active);
      } else {
        effects.push({ type: 'refresh-report', outcome: 're-queued', standingHumanReview, wasFixing });
      }
    }
  }

  if (fixResult) {
    if (s.state === 'ai:fixing') {
      s.fixer = { sha: pr.headSha, outcome: fixResult.outcome };
      // Only reached for a no-push conclusion (disputed/failed) — a 'pushed' outcome
      // already left `ai:fixing` via the head-change block above, which reads and
      // clears this itself. Deliberately NOT cleared here (#115): the self-heal claim
      // this comment used to make ("a still-latched summoned review keeps re-deriving as
      // non-stale, the top-level block self-heals next event") only holds while
      // `s.state !== 'ai:needs-human'` — but `agents-disagree`/`agents-may-disagree`/
      // `fixer-failed` below can set exactly that state in this same call, for a reason
      // unrelated to the summoned review. Left set, the head-change block's read (above)
      // recovers it whenever the eventual push lands, however many unrelated handoffs
      // came between.
      if (fixResult.outcome === 'disputed') {
        // A no-push round is not on its own evidence of a dispute: "I pushed back on the
        // findings" and "there was nothing to push" both look identical to the SHA compare
        // that produced this outcome (see orchestrator.yml's "Determine fix outcome" step).
        // Classify from facts the fixer can't spin: was this round dispatched by real
        // findings or by the review sweep's open-thread block (qualifyUnresolvedThreads
        // converting a clean scan to blocking solely because adjudicated-voice threads
        // still stood open — see OPEN_THREAD_BLOCK_MARKER in inspect-review.js), and are
        // any such threads still open right now. `codexResult` here is the caller's fresh
        // re-fetch of the still-latest review — nothing else reviews while a round is in
        // flight (needsReview() only fires in ai:reviewing), so it's the same review that
        // dispatched this round.
        const threadsKnown = Array.isArray(openThreads);
        // Require the explicit 'auto' origin (never `!== 'human'`): a state persisted
        // before `roundOrigin` existed has no such field, and an in-flight `/ai fix` round
        // dispatched under that older code is indistinguishable from `undefined` here. That
        // legacy round must fall through to the handoff below, not be silently swallowed as
        // if the review's own threads had resolved. An explicit `/ai fix` never silently
        // re-queues either, at any tier — the human who asked gets an answer, not silence.
        //
        // At `thread_authority: fixer` (the default), only an open-thread-block round may
        // re-queue this way — see the #73 incident this guards against. At
        // `adjudicate`/`reviewer`, the caller (orchestrate.js's classifierThreads) redefines
        // `openThreads` to count only UNANSWERED threads (review-threads.js's
        // unansweredThreads) — ones the fixer hasn't replied to. A genuine push-back the
        // fixer DID reply to no longer counts, so a round dispatched by a real finding (not
        // just an open-thread-block) can also re-queue, for the reviewer's own adjudication
        // on the next tick instead of an immediate handoff — see
        // docs/adr/0005-reviewer-owns-thread-lifecycle.md.
        const openThreadBlockRequired = policy.threadAuthority === 'fixer';
        if (threadsKnown && openThreads.length === 0 && s.roundOrigin === 'auto'
          && (!openThreadBlockRequired || codexResult?.openThreadBlock)) {
          // The round existed solely to get open threads addressed, and none are left open
          // — the fixer did exactly what was asked (the #73 incident: it replied, pushed,
          // then resolved the thread on a later round with no code left to change). Not a
          // dispute. Re-queue for a fresh review of the same head — mirrors /ai retry's
          // reset (state.js:191), including the `review_floor` latch: without it
          // needsReview() (the companion's review sweep) skips with "already posted, awaiting
          // orchestrator" and the PR stalls silently in `ai:reviewing` with no ping at all,
          // which is worse than the false-positive handoff this replaces.
          //
          // `summoned_floor` also bumps here, but ONLY when the standing summoned review
          // (#58/#103) actually originated one of the threads `openThreads` is confirming
          // resolved — `summonedReviewHasThread`. `openThreads.length === 0` on its own
          // proves nothing about a BODY-ONLY summoned review: it never opened a thread in
          // the first place, so its "resolution" can never be observed this way, and an
          // unrelated open-thread-block round finishing (its own, different threads
          // resolved) would otherwise look identical to this review having been addressed
          // and silently release a finding no one touched (#105 round-2 finding). For a
          // threaded summoned review, `qualifyUnresolvedThreads` origination-catches its
          // own thread, so `openThreads.length === 0` already implies that thread is
          // resolved too — bumping to `summonedReviewId` (not just `codexResult?.id`) is
          // what actually lifts `skipStaleCleanAfterSummonedInvalidation` below once this
          // same id is re-derived on a later event.
          s.codex = {
            requested_sha: null, reviewed_sha: null, result: null, human_review_id: null,
            review_floor: Math.max(s.codex.review_floor ?? 0, codexResultId ?? 0),
            summoned_floor: summonedReviewHasThread
              ? Math.max(s.codex.summoned_floor ?? 0, summonedReviewId ?? 0)
              : (s.codex.summoned_floor ?? 0),
          };
          s.fixer = { sha: pr.headSha, outcome: 'no-change' };
          const from = s.state;
          s.state = 'ai:queued';
          // A prior episode's ready ping must not silently swallow this one's — same
          // reasoning as every other re-entry point (pushedByHuman/retry/`/ai fix` above).
          s.readyNotified = false;
          s.readyReviewRequested = false;
          log(s, `${event} (no-op round — threads resolved)`, from);
          // Latched (see s.noOp above), not pushed directly: the replay block near the end
          // of this function is what actually emits the effect, so a failed/disabled send
          // can retry on a later event instead of losing the ping for good.
          s.noOp = { round: s.round, notified: false };
        } else if (threadsKnown && openThreads.length > 0) {
          // Threads remain open regardless of how the round was dispatched — a definite
          // dispute. A compliant fixer never leaves a thread open without having pushed
          // back on it (claude-fix-prompt.md: "never resolve a thread you pushed back on"),
          // so an open thread here is either an unaddressed finding or an unresolved
          // pushback; either way a human arbitrates.
          toHandoff(s, 'agents-disagree', effects, event, active);
        } else {
          // Thread state unknown (fetch failed — fail toward the loud reading, never
          // silence) or the round carried real/body-only findings with nothing left open:
          // buildReviewPayload folds line-less findings into the review body, and the fix
          // prompt answers those in a top-level comment, not a thread — so a genuine
          // dispute over body-only findings also leaves zero open threads. The record
          // can't tell "addressed in replies" from "disputed" here; say so honestly rather
          // than guessing either way.
          toHandoff(s, 'agents-may-disagree', effects, event, active, fixResult.reviewUrl);
        }
      } else if (fixResult.outcome === 'failed') toHandoff(s, 'fixer-failed', effects, event, active, fixResult.runUrl);
      // claude-code-action's own workflow-validation guard refused to run (the PR edits
      // the workflow file the run came from — see orchestrator.yml's "Determine fix
      // outcome"); no fix was attempted, so this must not be read as a dispute (#133).
      // orchestrate.js passes FIX_OUTCOME straight through unvalidated (fixResultMode),
      // and the sole producer — that same YAML step — only ever emits one of the four
      // outcomes handled here, so there is no unhandled-string case that would otherwise
      // fall through this whole `if (fixResult)` block, leaving the PR silently stuck at
      // `ai:fixing` with no transition and no ping.
      else if (fixResult.outcome === 'skipped') toHandoff(s, 'fixer-skipped', effects, event, active, fixResult.runUrl);
      // 'pushed' → the synchronize event for the new SHA drives the next cycle.
    }
  }

  // An agent's review only ever arrives while queued/reviewing (that's when it was
  // requested), so gating on those states is enough. A listed human can review at any
  // time, though — including after the PR already reached `ai:ready` or while latched at
  // `ai:needs-human` — and that REQUEST_CHANGES is still meant to dispatch a fix round
  // (see docs/human-controls.md "Reviews as commands"), so widen the states it's
  // consumed in for that source. `ai:fixing` is excluded either way: a round already in
  // flight isn't restarted by evidence that predates it.
  const isHumanSource = codexResult?.source === 'human';
  const codexConsumingStates = isHumanSource
    ? ['ai:queued', 'ai:reviewing', 'ai:ready', 'ai:needs-human']
    : ['ai:queued', 'ai:reviewing'];
  // NOT restricted to `ai:ready`/`ai:needs-human` (unlike the original round of this
  // guard): a standing human review dispatches a fix round once, full stop, regardless
  // of which of `codexConsumingStates` it's re-derived in. Without this guard, any later
  // orchestrator run that re-gathers the same still-present (not dismissed, not
  // superseded) review — a CI event, `/ai status`, a cron sweep, or (since
  // `humanBlockingResult` in orchestrate.js is no longer SHA-gated — round 4 finding on
  // #1) the very push this round itself produced, landing the PR back at `ai:queued` —
  // would "consume" it again and dispatch another uncapped fixer round with no new
  // human action, forever. A genuinely new review (new id) still goes through.
  const alreadyHandledHumanReview = isHumanSource
    && codexResult.reviewId != null && codexResult.reviewId === s.codex.human_review_id;
  // /ai retry means "distrust the last verdict, look again" — a stale *clean* result
  // re-consumed in this same call would instantly restore `ai:ready` and skip the fresh
  // request-codex effect below. Existing *blocking* evidence is still trusted immediately
  // (docs/human-controls.md: retry dispatches on a standing blocking review with no push) —
  // except a stale `escalate`/`contested`/`awaitingHuman` result, none of which are a
  // fresh human-actionable finding on THIS retry: `escalate` is the local reviewer CLI
  // itself failing; `contested`/`awaitingHuman` are adjudication LATCHES (ADR-0005) —
  // the reviewer's opinion on a rebuttal it already read, not new evidence, and retry's
  // whole point in reaching for them is to get a fresh look after acting on that opinion
  // (resolving the thread, replying). Consuming any of the three here would immediately
  // re-handoff to `ai:needs-human` instead of latching the fresh review request retry is
  // supposed to force — see ADR-0009 (#133/#137) for the full decision, including the
  // accepted cost: if genuinely nothing changed, the re-scan still dispatches one more
  // (human-initiated, round-capped) fix round rather than silently declining the retry.
  //
  // ADR-0009 covers `contested`/`awaitingHuman` (adjudication latches, reachable only at
  // `thread_authority: adjudicate|reviewer`) but not `agents-disagree`/`agents-may-disagree`
  // (a no-push dispute the FIXER itself reported — reachable at the default `fixer`
  // authority too, see the disputed-outcome branch above). That handoff's underlying
  // review sits forever as plain `codexResult.blocking === true` with none of
  // escalate/contested/awaitingHuman set, so without `retriedOffDisputeThisEvent` a retry
  // off it re-consumed the exact same review and dispatched a fixer round against the
  // exact same findings that already produced the dispute — `/ai retry` did nothing (#188).
  //
  // Gated on NOT `freshHumanReviewSinceDispute`: `retriedOffDisputeThisEvent` alone would
  // also swallow a genuinely different, never-yet-consumed human REQUEST_CHANGES that
  // happens to surface in this same event (e.g. its own webhook was lost while the PR sat
  // latched, and this retry's fresh GitHub fetch is the first time it's seen) — that's
  // fresh human-actionable evidence, not the stale review this exemption exists for, and
  // dropping it would be exactly the silent-loss failure mode this repo's conventions
  // forbid. `priorHumanReviewIdAtRetry` is captured above, before the reset nulls it.
  const freshHumanReviewSinceDispute = isHumanSource && codexResult?.reviewId != null
    && codexResult.reviewId !== priorHumanReviewIdAtRetry;
  const skipStaleCleanOnRetry = retriedThisEvent && codexResult
    && (!codexResult.blocking || codexResult.escalate || codexResult.contested || codexResult.awaitingHuman
      || (retriedOffDisputeThisEvent && !freshHumanReviewSinceDispute));
  // The retry event above only skips a stale clean/escalate result *in that same call*
  // (see `skipStaleCleanOnRetry`) — a later event (a CI/status update, another cron tick,
  // `/ai status`) re-deriving the exact same still-standing review from GitHub before the
  // local reviewer ever posts a fresh one must keep excluding it too, or it silently
  // re-populates `reviewed_sha` and defeats the retry before the fresh review request is
  // ever answered. `review_floor` (latched at the retry) is the id ceiling of evidence
  // that predates this generation; a review at or below it never counts again.
  const staleByFloor = !retriedThisEvent && codexResultId != null && codexResultId <= (s.codex.review_floor ?? 0);
  // A reconciliation that just re-queued must not turn around and consume the very
  // review it discarded within the same call — `refreshedThisEvent` blocks that outright
  // regardless of floor. The floor bump above (keyed on `codexResultId`, which reads a
  // human review's `reviewId` too — see its declaration) is what stops a *later* event
  // from re-consuming that same discarded review, or an older pre-refresh bot review on
  // the same head, once the human review is dismissed and GitHub's "latest" review
  // reverts to it.
  //
  // Same shape as `skipStaleCleanOnRetry`, for the summoned-review branch above:
  // `staleByFloor` alone doesn't catch a genuinely fresh (higher-id) CLEAN codexResult
  // from a recognized reviewer that never saw the summoned finding (it was a body-only
  // review, no thread, so qualifyUnresolvedThreads never flagged it) — without this, that
  // clean result gets consumed and instantly undoes the reset above. Gated on
  // `summonedReviewId > summoned_floor` (a still-standing, UNRELEASED summoned review),
  // not on `summonedInvalidatedThisEvent`: the reset above only *fires* once per review id
  // (guarded by `review_floor`), but the same still-open review keeps being re-derived as
  // the same id on every later event (a CI/status update, another cron tick) until it's
  // actually released — a push, an explicit dismissal, or `summoned_floor` catching up via
  // the no-op-round-threads-resolved branch above. Scoping this skip to the firing event
  // alone would let that very next event — where `summonedReviewId <= review_floor` so the
  // reset no longer fires — consume the stale clean result and silently promote to
  // `ai:ready`, defeating the invalidation one event later. A genuinely BLOCKING
  // codexResult is still consumed normally — only a genuinely clean result is what would
  // silently erase the invalidation. Not gated on `codexResult.escalate` alone (escalate
  // always posts CHANGES_REQUESTED, so `blocking` already catches it): `contested` and
  // `awaitingHuman` also need excluding, since a clean COMMENT review can still carry
  // either marker (buildReviewPayload stamps them regardless of which branch runs) —
  // without excluding them too, this skip swallowed the whole consuming block below,
  // including the escalate/contested/awaitingHuman-routed `toHandoff` calls, silently
  // stranding the PR in `ai:reviewing` instead of routing to a human (#105 finding).
  const skipStaleCleanAfterSummonedInvalidation = summonedReviewId != null
    && summonedReviewId > (s.codex.summoned_floor ?? 0)
    && codexResult && !codexResult.blocking && !codexResult.contested && !codexResult.awaitingHuman;
  // A THREADED summoned review already has a working escape from this skip: its thread is
  // durable (qualifyUnresolvedThreads, origination-anchored — review-threads.js), so the
  // recognized reviewer's own next scan converts its own would-be-clean verdict to
  // blocking on its own, which flows through the ordinary round/dispatch/round-limit path
  // below. A BODY-ONLY summoned review has no thread for that mechanism to grab onto —
  // nothing in the automated loop will ever dispatch a fixer round or otherwise resolve
  // it, only a push or an explicit dismissal (see the summoned-review block above), and
  // nothing forces either to happen. Left alone, the PR would sit silently cycling
  // ai:reviewing -> clean (skipped) -> ai:reviewing forever, with no visible signal in the
  // sticky comment (`Reviewer` only ever shows the recognized reviewer's own verdict) —
  // exactly the silent-stall failure mode this repo's own conventions exist to prevent.
  // Escalate loudly instead, the first moment this is confirmed: a genuinely fresh clean
  // codexResult exists and is being suppressed by this exact review. See
  // docs/adr/0007-summoned-reviews-block-never-promote.md.
  // Gated on `codexConsumingStates` like the primary branch below: `summonedReviewNeedsHuman`
  // only means a clean result WOULD have been consumed here if not for the summon, so the
  // escalation itself must not fire in a state where nothing would have been consumed anyway.
  // Without this, an unrelated fresh clean result re-derived mid-round (`ai:fixing` is never
  // a consuming state) would trip this branch and yank an in-flight fixer round straight to
  // `ai:needs-human` (#105 finding) — or overwrite an unrelated standing `ai:needs-human`
  // handoff's reason. `s.state` here already reflects the summoned-review re-queue block
  // above (ai:ready -> ai:queued in the same event when it fires), so this still escalates
  // for the case that block's own tests pin.
  const summonedReviewNeedsHuman = skipStaleCleanAfterSummonedInvalidation && !summonedReviewHasThread
    && codexConsumingStates.includes(s.state);
  if (codexResult && !refreshedThisEvent && codexConsumingStates.includes(s.state) && !alreadyHandledHumanReview
    && !skipStaleCleanOnRetry && !staleByFloor && !skipStaleCleanAfterSummonedInvalidation) {
    if (s.state === 'ai:needs-human') s.handoff = { done: false, notified: false, reason: null };
    s.codex.reviewed_sha = codexResult.sha;
    s.codex.result = codexResult.blocking ? 'blocking' : 'clean';
    if (isHumanSource) s.codex.human_review_id = codexResult.reviewId ?? null;
    if (codexResult.escalate) {
      // The local-agent sweep's own reviewer CLI is failing repeatedly (see
      // ESCALATE_MARKER in lib/inspect-review.js) — there are no real findings for the
      // fixer to act on, so go straight to a human instead of burning a fix round.
      toHandoff(s, 'local-reviewer-escalation', effects, event, active);
    } else if (codexResult.contested) {
      // The reviewer re-adjudicated a push-back and still disagrees with it (a
      // `sustain` verdict, thread_authority: adjudicate|reviewer) — a genuine dispute,
      // discovered by re-verification rather than ADR-0003's no-push classifier, but the
      // same outcome: a human arbitrates instead of burning another fix round. Checked
      // ahead of `blocking` (and wins over `awaitingHuman` — see CONTESTED_MARKER in
      // inspect-review.js) since it's independent of this tick's fresh scan verdict.
      // A distinct reason from `agents-disagree` (ADR-0009, #133/#137): that prose
      // describes a no-push round with an unaddressed/unanswered thread, neither of
      // which need be true here — the reviewer already re-read the rebuttal against
      // current code and didn't budge.
      toHandoff(s, 'reviewer-sustained', effects, event, active);
    } else if (codexResult.awaitingHuman) {
      // The reviewer withdrew a finding on a thread a human commented in without a
      // demonstrably-satisfied instruction, or couldn't tell what the human meant (an
      // `ask` verdict) — thread_authority forbids the reviewer from resolving or
      // re-raising it unilaterally, so only a human can close the loop here.
      toHandoff(s, 'awaiting-human-resolution', effects, event, active);
    } else if (codexResult.blocking) {
      // The round cap protects against agent↔agent loops; findings a listed human
      // raised themselves (source 'human': their REQUEST_CHANGES review) are never
      // capped — the human is the oversight the cap escalates to. `effective_cap` is
      // `cap` (a per-PR /ai round-cap override) when set, else policy.maxRounds.
      if (s.round >= s.effective_cap && codexResult.source !== 'human') {
        toHandoff(s, 'round-limit', effects, event, active);
      } else {
        const from = s.state;
        s.round += 1;
        s.rounds_total = (s.rounds_total ?? 0) + 1;
        s.state = 'ai:fixing';
        // Only a human-sourced review can land this while already `ai:ready` (see
        // codexConsumingStates above); resetting here is a no-op otherwise, since the
        // ping hasn't fired yet. Mirrors the pushedByHuman/retry/`/ai fix` resets.
        s.readyNotified = false;
        s.readyReviewRequested = false;
        // Dispatched by consuming a review (whether the local-agent sweep's or a human's
        // standing REQUEST_CHANGES), never by `/ai fix` — see s.roundOrigin's other setter.
        s.roundOrigin = 'auto';
        log(s, event, from);
        effects.push({ type: 'dispatch-fixer', round: s.round, findings: codexResult.findings });
      }
    }
  } else if (summonedReviewNeedsHuman) {
    toHandoff(s, 'summoned-review-no-thread', effects, event, active, summonedReviewUrl);
  }

  if (['ai:queued', 'ai:reviewing'].includes(s.state)) {
    // A refresh that just declined (threads-open/unconfirmed) reported "changed nothing"
    // for this exact call — without this, a stale `ai:queued`/`ai:reviewing` state with no
    // recorded result (`s.codex.result === null`) would still fall through to request a
    // fresh review and move `s.state` to `ai:reviewing` right here, contradicting the
    // decline it just reported in the very same call.
    if (s.codex.result === null && s.codex.requested_sha !== pr.headSha && !refreshDeclinedThisEvent) {
      // Only mark as requested for real once active; a dry-run preview must keep
      // re-narrating "would request" so activation still fires the real request.
      if (active) s.codex.requested_sha = pr.headSha;
      if (s.state !== 'ai:reviewing') {
        const from = s.state;
        s.state = 'ai:reviewing';
        log(s, event, from);
      }
      effects.push({ type: 'request-codex', sha: pr.headSha });
    }

    if (ci === 'failure' && s.ci.failureConfirmedSha !== pr.headSha) {
      s.ci.consecutive_failures += 1;
      s.ci.failureConfirmedSha = pr.headSha;
      if (s.ci.consecutive_failures >= policy.ciFailureThreshold) toHandoff(s, 'ci-failing', effects, event, active);
    } else if (ci === 'success') {
      s.ci.consecutive_failures = 0;
      // A success clears the marker too: a later failure on this same head (CI went
      // green, then regressed) is a fresh failure, not the one already counted above —
      // mirrors the pre-existing `conclusion !== 'failure'` half of the old dedupe check.
      s.ci.failureConfirmedSha = null;
    }
    // The failure dedupe marker (`failureConfirmedSha`) is tracked separately from
    // `sha`/`conclusion` below: a `pending` observation (e.g. a rerun on an already-failed
    // head) must not clear the marker, or the same head's next `failure` observation looks
    // "new" and double-counts. But `sha`/`conclusion` themselves must always mirror the
    // latest observation — including `pending` — since `desiredLabels` reads
    // `state.ci.conclusion` directly for the `ci:*` label; skipping the update on `pending`
    // left a stale `failure` (or `success`) conclusion driving the label/status comment
    // after CI had actually gone back to pending.
    s.ci = { ...s.ci, sha: pr.headSha, conclusion: ci };

    // A refresh that just declined (threads-open/unconfirmed) reported "changed nothing"
    // for this exact call — it must not fall through to a CI-driven ai:ready promotion
    // below on the strength of a stale recorded 'clean' result, or the decline it just
    // reported becomes a lie the very same call it was reported in.
    if (s.codex.result === 'clean' && s.state !== 'ai:needs-human' && !refreshDeclinedThisEvent) {
      // #124: a clean AI verdict is never sufficient on its own — an open adjudicated-
      // voice thread must still block promotion, independent of which `backends.reviewer`
      // produced the verdict. The local-agent sweep already encodes this itself (a clean
      // scan gets converted to a blocking review via OPEN_THREAD_BLOCK_MARKER before
      // reduce() ever sees it), but a clean codex-only review has no such conversion, so
      // this checks the invariant directly instead of trusting every backend to encode it.
      // `openThreads` is `null` both when the caller never fetched it and when it tried
      // and the GraphQL call failed (classifierThreads' catch) — the two collapse to the
      // same value. But `approachingReady` (orchestrate.js) mirrors this exact condition
      // (`ci === 'success'` plus a clean verdict) to decide whether to fetch, and every
      // reset that can change `s.state`/`s.codex.result` earlier in this same reduce()
      // call also nulls `s.codex.result`, so a real `null` reaching here is always the
      // failed-fetch case, never the never-fetched one. Hedge like every other consumer
      // of `openThreads` (`!Array.isArray` above) rather than promote on an unconfirmed
      // thread state — P1 finding on #14 round 2.
      const threadsBlockReady = !Array.isArray(openThreads) || openThreads.length > 0;
      if (ci === 'success' && !threadsBlockReady) {
        // #144/#203: `ai:ready` is the AI axis only — clean review AND green CI, full
        // stop. Risk (size, protected/configured paths, dependency manifests) used to
        // gate this too (`risk.level === 'low' && !risk.humanRequired`), collapsing "the
        // agents are satisfied" and "policy wants your eyes anyway" into one signal. Risk
        // is now purely a human-axis fact, reported alongside `ai:ready` in labels and the
        // Telegram glyph row (scripts/lib/telegram.js) rather than gating it — see the ADR
        // for why this is safe (and the one path, .github/**, that still isn't).
        const from = s.state;
        s.state = 'ai:ready';
        log(s, event, from);
        // #144/#203: an elevated-risk PR used to reach this human via a GitHub review
        // request (toHandoff's `request-human-review`, dropped when risk stopped gating
        // this promotion) as well as a ping — losing the request would be a silent
        // regression in discoverability for anyone not on Telegram. Latched separately
        // from the ping (codex review round 1 finding on #206): a failed/disabled
        // Telegram send rolls `readyNotified` back for retry (orchestrate.js), and
        // sharing one latch would replay this GitHub API call on every such retry.
        // Only latch for real once active — a dry-run preview that reaches ai:ready
        // still gets the real request via the replay block below once the repo activates.
        if (!s.readyReviewRequested && (risk.level !== 'low' || risk.humanRequired)) {
          s.readyReviewRequested = active;
          effects.push({ type: 'request-human-review' });
        }
        // Only notify (and latch) if this episode hasn't already sent the ping —
        // a CI rerun can bounce ai:ready → ai:reviewing → ai:ready without a new
        // head_sha, and that must not re-fire it. Mirrors handoff.done in toHandoff.
        // Only latch for real once active — a dry-run preview that reaches ai:ready
        // still gets the real ping via the replay block below once the repo activates.
        if (!s.readyNotified) {
          s.readyNotified = active;
          effects.push({ type: 'notify', kind: 'ready' });
        }
      }
      // ci pending → stay ai:reviewing; a check_suite event re-evaluates.
    }
  } else if (s.state === 'ai:ready' && ci === 'failure') {
    // CI regressed after the PR was already marked ready (e.g. a later required check
    // completes red) — the gate must not keep reporting success for a red head.
    toHandoff(s, 'ci-failing', effects, event, active);
    s.ci = { ...s.ci, sha: pr.headSha, conclusion: ci };
  } else if (s.state === 'ai:ready' && ci === 'pending') {
    // A required check restarted (rerun, or a new required check appeared) — CI is no
    // longer definitively green for this head, so the gate must stop reporting success
    // until it resolves. Falls back to `ai:reviewing`, which re-promotes to `ai:ready`
    // the moment `ci` is `success` again (codex.result is still recorded as clean).
    const from = s.state;
    s.state = 'ai:reviewing';
    log(s, event, from);
    s.ci = { ...s.ci, sha: pr.headSha, conclusion: ci };
  } else {
    s.ci = { ...s.ci, sha: pr.headSha, conclusion: ci };
  }

  // A dry-run preview can reach `ai:needs-human` without ever requesting/notifying (the
  // effects above were only narrated, never sent). Once activated, replay each once —
  // independently, same split as the ai:ready block below, not else-if chained: a failed
  // `request-human-review` (orchestrate.js rolls back only `done` on that failure, codex
  // review round 2 finding on #1) must retry just the request without re-sending an
  // already-delivered ping, the same way a failed/disabled Telegram send below already
  // retries just the notify without re-requesting an already-sent review.
  if (active && s.state === 'ai:needs-human') {
    if (!s.handoff.done) {
      s.handoff.done = true;
      effects.push({ type: 'request-human-review' });
    }
    if (!s.handoff.notified) {
      s.handoff.notified = true;
      effects.push({ type: 'notify', kind: 'needs-human', reason: s.handoff.reason, ...(s.handoff.runUrl ? { runUrl: s.handoff.runUrl } : {}) });
    }
  }

  // Same replay for ai:ready: a dry-run preview that promoted to ai:ready never sent
  // the real request/ping (readyReviewRequested/readyNotified stayed false). Once
  // activated, send each once — independently, same split as the promotion block above,
  // so a later failed/disabled Telegram send can retry just the ping.
  if (active && s.state === 'ai:ready') {
    if (!s.readyReviewRequested && (risk.level !== 'low' || risk.humanRequired)) {
      s.readyReviewRequested = true;
      effects.push({ type: 'request-human-review' });
    }
    if (!s.readyNotified) {
      s.readyNotified = true;
      effects.push({ type: 'notify', kind: 'ready' });
    }
  }

  // Same replay for the no-op-round ping (see s.noOp above): unlike ready/needs-human
  // this transition doesn't land on a stable, re-checkable state value (it's just
  // `ai:queued`/`ai:reviewing`, reused for plenty of other reasons), so the round-scoped
  // latch itself — not `s.state` — is what a failed/disabled send retries against on
  // every subsequent event until it's confirmed sent.
  if (active && s.noOp && !s.noOp.notified) {
    s.noOp.notified = true;
    effects.push({ type: 'notify', kind: 'no-op-round', round: s.noOp.round });
  }

  // ponytail: no push site for { type: 'notify', kind: 'merged' } yet — auto-merge itself
  // isn't implemented (policy.merge.auto_merge is inert, see scripts/lib/gate.js). Add the
  // push here, right after whatever marks a PR merged, once that lands.

  return { next: s, effects };
}

const STATE_EMOJI = {
  'ai:queued': '⏳', 'ai:reviewing': '🔍', 'ai:fixing': '🔧',
  'ai:needs-human': '🙋', 'ai:ready': '✅', 'ai:failed': '💥',
};

// GitHub's hard cap on an issue/PR comment body.
const GITHUB_COMMENT_MAX = 65536;

/**
 * Render the sticky comment: hidden machine state + human-readable status.
 * `marker: false` omits the hidden state blob — used by renderEcho() below, so the
 * disposable copy it posts can never be mistaken for (or parsed as) the state store.
 */
export function renderComment(state, { dryRunNote = null, handoffThreads = [], marker = true, policyWarnings = [] } = {}) {
  // PR-controlled text (e.g. risk.reasons quoting a changed filename) can legally contain
  // "-->" — a valid Git filename like `.github/evil-->name.js` — which would otherwise
  // terminate this HTML comment early and make parseStateComment read a truncated,
  // unparseable JSON blob (silently falls back to "no state", re-driving every effect).
  // `-->` can only ever occur inside a JSON *string* value in this output (JSON's own
  // grammar never emits a bare `>`), so rewriting it to the equivalent `>` escape is
  // always safe and round-trips through JSON.parse unchanged — no change needed on the
  // read side.
  const json = JSON.stringify(state).replaceAll('-->', '--\\u003e');
  const markerLines = marker ? [`${MARKER_START}\n${json}\n${MARKER_END}`] : [];
  // #277: advisory policy sanity warnings are recomputed every run (never part of the
  // JSON state, so they appear while the policy is wrong and vanish when fixed) and are
  // otherwise part of the un-droppable `core` block — built by a closure, not inline,
  // so the #278 degrade cascade below can re-render with `warnings: []` as a last resort
  // without duplicating the rest of the table.
  const buildCore = (warnings) => {
    const core = [
      '## 🤖 AI orchestration status',
      '',
      '| | |',
      '|---|---|',
      `| State | ${STATE_EMOJI[state.state] ?? ''} \`${state.state}\` |`,
      // #144/#203: `humanRequired` no longer gates `ai:ready` (see the promotion logic
      // above) — reworded from "(human required)" so this doesn't read as a bug next to a
      // gate that can now report `success` for the same PR.
      `| Risk | \`${state.risk?.level ?? '—'}\`${state.risk?.humanRequired ? ' (policy flags this for human review)' : ''} |`,
      `| Head | \`${state.head_sha.slice(0, 12)}\` |`,
      `| Round | ${state.effective_cap != null ? `${state.round} of ${state.effective_cap}` : state.round}${state.cap != null ? ' (override)' : ''} |`,
      `| Rounds total | ${state.rounds_total ?? state.round} |`,
      // Labeled "Reviewer", not "Codex" (#58): this is this repo's own configured reviewer
      // sweep's verdict, not the hosted GitHub Codex App's — reading "Codex: clean" next to
      // a live cloud-Codex P1 was actively misleading while debugging #102.
      `| Reviewer | ${state.codex.result ?? (state.codex.requested_sha ? 'requested' : '—')} |`,
      `| Fixer | ${state.fixer.outcome ?? '—'} |`,
      `| CI | ${state.ci.conclusion ?? '—'} |`,
    ];
    if (state.state === 'ai:needs-human') {
      core.push('', describeHandoff(state, handoffThreads));
    }
    if (dryRunNote) core.push('', `> **Dry run** — no actions taken. ${dryRunNote}`);
    if (warnings.length) core.push('', '⚠️ **Policy sanity**', ...warnings.map((w) => `- ${w}`));
    return core;
  };

  // risk.reasons quotes raw PR filenames (risk.js's listFilenames), which — unlike the
  // hidden JSON marker above — lands in the human-visible portion of this trusted
  // github-actions[bot] comment as plain Markdown/HTML. A legal Git filename can carry
  // backticks or a literal newline (e.g. `.github/x\n</details>\n## Approved`), which
  // would otherwise close the <details> block early and forge trailing content as if the
  // bot had posted it (codex review round 3 finding on #1). Neutralize `<`/`>` (HTML/tag
  // injection) and backtick (the reviewer's other named vector — no open code span to
  // break out of here, but a stray one still garbles the rendered bullet), then collapse
  // embedded newlines so one reason can never become new Markdown lines.
  const escapeReason = (s) => s
    .replace(/[<>`]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '`': '&#96;' }[c]))
    .replace(/\r\n|\r|\n/g, ' ');
  const riskDetails = state.risk?.reasons?.length
    ? ['', '<details><summary>Risk reasons</summary>', '', ...state.risk.reasons.map((r) => `- ${escapeReason(r)}`), '', '</details>']
    : [];
  const historyDetails = state.history.length
    ? ['', '<details><summary>History</summary>', '',
      ...state.history.slice(-8).map((h) => `- \`${h.t}\` ${h.event}: \`${h.from}\` → \`${h.to}\``), '', '</details>']
    : [];

  const render = (core, details) => [...markerLines, ...core, ...details].join('\n');
  // A body can blow past GitHub's 65,536-char comment limit (e.g. risk reasons listing
  // hundreds of filenames, #224) — the PATCH/POST would then throw and the PR stalls
  // silently. Degrade by dropping optional sections instead; the hidden state marker in
  // `core`/`markerLines` is never dropped, so the orchestrator can keep parsing state
  // even from a degraded comment.
  let body = render(buildCore(policyWarnings), [...riskDetails, ...historyDetails]);
  if (body.length > GITHUB_COMMENT_MAX) body = render(buildCore(policyWarnings), riskDetails);
  if (body.length > GITHUB_COMMENT_MAX) body = render(buildCore(policyWarnings), []);
  // #278: the policyWarnings dual cap (orchestrate.js) bounds that field alone, but a
  // maxed-out policyWarnings block plus a maxed-out risk/history state marker can still
  // clear this limit together even though each is capped on its own. Warnings are
  // advisory only and still ship via the `::warning::` annotations and the gate summary
  // (orchestrate.js), so dropping them here as the very last resort loses nothing a
  // human can't see elsewhere.
  if (body.length > GITHUB_COMMENT_MAX) body = render(buildCore([]), []);
  return body;
}

/**
 * Render a disposable echo of the sticky comment for the bottom of a busy thread (see
 * docs/ai-command.md `/ai status`): the `n=` marker (not the state blob — `marker:
 * false`) is the self-describing floor the automatic trigger compares against next time,
 * a copy banner up top makes it unmistakable for the live comment, and a backlink at the
 * bottom points back to it.
 */
export function renderEcho(state, { canonicalUrl, timelineCount, dryRunNote = null, handoffThreads = [] } = {}) {
  // ponytail: timelineCount is read once, at render time — by the time a human reads
  // this echo a few more thread events may have landed, so `n` (and the auto-trigger
  // floor it sets) can drift a little low. Fine for a "roughly every echo_frequency items"
  // heuristic; tighten only if the drift ever becomes something people notice.
  const lines = [
    `${ECHO_MARKER_START}${timelineCount} ${ECHO_MARKER_END}`,
    '> 📋 **Copy of the AI status comment** — this is a snapshot, not the live status.',
    '',
    renderComment(state, { dryRunNote, handoffThreads, marker: false }),
    '',
    `> ↑ Live status: ${canonicalUrl}`,
  ];
  return lines.join('\n');
}

/**
 * Render the `/ai refresh` reply comment (see docs/ai-command.md). Takes the
 * `refresh-report` effect itself, not durable state, unlike renderComment/renderEcho —
 * the decline reasons (unconfirmed thread state, which threads are still open) exist only
 * in the effect for this one call, never persisted.
 */
export function renderRefreshReply(effect) {
  switch (effect.outcome) {
    case 'nothing-to-reconcile':
      return '🤖 `/ai refresh` — already `ai:ready`; nothing to reconcile.';
    case 'unconfirmed':
      return '🤖 `/ai refresh` — could not confirm review thread state (a GraphQL fetch '
        + 'failed). Nothing changed; try again.';
    case 'ci-failing':
      return '🤖 `/ai refresh` — CI is still failing on this head; nothing to reconcile. '
        + 'State unchanged until CI passes (or `/ai fix` / `/ai retry`).';
    case 'threads-open': {
      const lines = effect.threads.map((t) => `- \`${t.path ?? '(review thread)'}${t.line ? `:${t.line}` : ''}\``);
      return [
        `🤖 \`/ai refresh\` — ${effect.threads.length} unresolved thread(s), nothing to reconcile:`,
        '', ...lines, '',
        'State unchanged. Resolve them (or `/ai fix`) and refresh again.',
      ].join('\n');
    }
    case 'threads-open-demoted': {
      const lines = effect.threads.map((t) => `- \`${t.path ?? '(review thread)'}${t.line ? `:${t.line}` : ''}\``);
      return [
        `🤖 \`/ai refresh\` — was \`ai:ready\`, but ${effect.threads.length} review thread(s) `
          + 'are still open (the recorded verdict was stale). Moved back to `ai:reviewing` '
          + 'and re-queued for a fresh review:',
        '', ...lines,
      ].join('\n');
    }
    case 're-queued': {
      const lines = ['🤖 `/ai refresh` — nothing blocking left; re-queued for a fresh review.'];
      if (effect.standingHumanReview) {
        lines.push('', '⚠️ Your `REQUEST_CHANGES` review is still standing on GitHub — '
          + 'dismiss it, or a later event may dispatch a fix round on it.');
      }
      if (effect.wasFixing) {
        lines.push('', '⚠️ This PR was `ai:fixing` — if a fix round is still running, its '
          + 'outcome will be discarded when it reports back.');
      }
      return lines.join('\n');
    }
    default:
      return '🤖 `/ai refresh` — done.';
  }
}
