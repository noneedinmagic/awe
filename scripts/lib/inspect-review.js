const PRIORITY_RE = /\bP0\b|\bP1\b/;

// Set by the local-agent sweep (the maintainer's companion repo) on a deterministic
// CLI-failure-escalation review — a REQUEST_CHANGES with no inline comments and no
// actionable findings for the Claude fixer to read. Without this marker such a review
// looks like an ordinary blocking result (review.state === CHANGES_REQUESTED) and
// `reduce()` would burn a fix round dispatching the fixer at nothing; this marker lets
// it route straight to `ai:needs-human` instead.
export const ESCALATE_MARKER = '<!-- ai-orch:escalate -->';

// Set by the local-agent sweep when a clean scan is converted to blocking solely because
// adjudicated-voice threads still stand open (see qualifyUnresolvedThreads in
// review-threads.js and its call site in the companion's review sweep) — an "open-thread block", not a
// finding about the code. Distinguishing this from an ordinary blocking review with real
// findings is what lets reduce() tell "the fixer resolved every thread it was asked to"
// apart from "the fixer disputed the findings and pushed nothing" on a no-push round —
// see the fixResult.outcome === 'disputed' handling in state.js.
export const OPEN_THREAD_BLOCK_MARKER = '<!-- ai-orch:open-thread-block -->';

// Set by the local-agent sweep (reviewers.thread_authority: adjudicate|reviewer) when
// its per-thread adjudication of a push-back sustains at least one finding — the
// reviewer re-verified against the current code and still disagrees with the fixer's
// rebuttal. Distinct from an ordinary blocking review: it means a genuine dispute, not
// new code findings, so reduce() routes it straight to `agents-disagree` without
// burning another fix round. See docs/adr/0005-reviewer-owns-thread-lifecycle.md.
export const CONTESTED_MARKER = '<!-- ai-orch:contested -->';

// Set by the same adjudication pass when a thread's human intent can't be determined
// (an `ask` verdict, or a `withdraw` on a thread a human commented in without a
// demonstrably-satisfied instruction — see the companion review sweep's applyAdjudications). Never
// merged with CONTESTED_MARKER's ping: "I withdrew, please close this" or "what did you
// mean?" is not the same signal as "the agents disagree," and reusing that ping would
// misdescribe what actually happened (the #85 lesson).
export const AWAITING_HUMAN_MARKER = '<!-- ai-orch:awaiting-human -->';

/**
 * Interpret a submitted PR review as evidence for the state machine.
 * Conservative by design: any ROOT inline comment attached to the reviewer's review
 * counts as a finding (Codex only flags P0/P1, but if its badge format ever
 * changes we must fail toward "blocking", never guess "clean").
 *
 * @param {object} review pull request review (REST shape)
 * @param {object[]} inlineComments review comments on the PR (REST shape)
 * @param {{codexActor?: string, actors?: string[], localReviewActors?: string[], prAuthor?: string, headSha: string}} opts
 *   `actors` is the reviewer allowlist; `codexActor` is accepted as a single-entry
 *   equivalent for backward compatibility. A review by the PR author never counts
 *   (self-review guard for the symmetric Tali/Garrus setup). `localReviewActors` is the
 *   (usually narrower) subset of `actors` that actually runs the local-agent sweep and
 *   is therefore trusted to emit ESCALATE_MARKER/OPEN_THREAD_BLOCK_MARKER — see below.
 */
export function inspectReview(review, inlineComments, {
  codexActor, actors, localReviewActors, prAuthor, headSha,
}) {
  const allowed = actors ?? (codexActor ? [codexActor] : []);
  const login = review?.user?.login;
  if (!review || !allowed.includes(login)) return { relevant: false, stale: false };
  if (prAuthor && login === prAuthor) return { relevant: false, stale: false };
  if (review.commit_id !== headSha) return { relevant: false, stale: true };
  if (review.state === 'DISMISSED') return { relevant: false, stale: false };

  // Root comments only (#107): a reply (`in_reply_to_id` set) is thread conversation the
  // reviewer participated in, not a fresh finding it raised. Unconditional — no caller has
  // ever needed a reply to count, and any that omitted this filter (every site but the
  // summoned-review one, pre-#107) got a real bug: GitHub auto-wraps every standalone
  // reply comment (e.g. a sweep's own adjudication reply, or the fixer's thread replies
  // under a login that also acts as reviewer) into its own review object — an empty-body
  // `COMMENTED` review that would otherwise get misread as a fresh blocking verdict purely
  // for carrying a reply, shadowing the reviewer's real, unrelated verdict on the same head.
  const attached = (inlineComments ?? []).filter((c) => c.pull_request_review_id === review.id);
  const findings = attached
    .filter((c) => c.in_reply_to_id == null)
    .map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      priority: PRIORITY_RE.exec(c.body ?? '')?.[0] ?? null,
      excerpt: (c.body ?? '').slice(0, 200),
    }));

  // #107 stopped a wrapper's lone reply counting as a finding — but left the wrapper
  // itself still `relevant`, so `latestCodexResult`'s `.at(-1)` still picks it over the
  // real review submitted moments earlier (it always has the higher id): an empty body,
  // `COMMENTED` state, zero findings reads as a fresh CLEAN verdict, silently zeroing
  // every marker below along with `blocking` (#123, live on PR #119 — shadowed a standing
  // CHANGES_REQUESTED — and PR #122 — shadowed a CONTESTED_MARKER dispute escalation).
  // Narrow on purpose: `attached.length > 0` means this only fires on a review that
  // actually carries a reply, so a genuine clean review with an empty body and no
  // comments at all (a real, if terse, verdict) is never suppressed.
  if (review.state === 'COMMENTED' && !(review.body ?? '').trim()
      && findings.length === 0 && attached.length > 0) {
    return { relevant: false, stale: false };
  }

  // The root-only filter above applies to `findings` only — it does NOT also gate this
  // state-based clause. That's safe only because a reply-posting API never results in a
  // `CHANGES_REQUESTED`-state auto-review (claude-fix-prompt.md's reply endpoint has no
  // state to set); if that assumption is ever wrong for a given login, filtering findings
  // alone would not suppress the loop this filter exists to prevent. See
  // tests/human-controls.test.js's coverage of this exact assumption.
  const blocking = review.state === 'CHANGES_REQUESTED' || findings.length > 0;
  // These markers are only ever written by the local-agent sweep's own deterministic
  // wrapper (the companion's review sweep), never by a human or by the cloud `codex` actor — whose
  // review body is model-generated from the (untrusted, PR-controlled) diff and could
  // otherwise be made to quote either marker verbatim. Trust them only from a login the
  // caller has identified as actually running that sweep.
  const trustedForMarkers = (localReviewActors ?? []).includes(login);
  const escalate = trustedForMarkers && (review.body ?? '').includes(ESCALATE_MARKER);
  const openThreadBlock = trustedForMarkers && (review.body ?? '').includes(OPEN_THREAD_BLOCK_MARKER);
  const contested = trustedForMarkers && (review.body ?? '').includes(CONTESTED_MARKER);
  const awaitingHuman = trustedForMarkers && (review.body ?? '').includes(AWAITING_HUMAN_MARKER);
  // `id` is GitHub's own monotonically-increasing review id — the "generation" floor
  // reduce()/needsReview() use to tell a review posted for the *current* request apart
  // from one that predates a retry (see state.js's `codex.review_floor`).
  return {
    relevant: true, stale: false, blocking, escalate, openThreadBlock, contested, awaitingHuman, findings,
    reviewState: review.state, sha: review.commit_id, id: review.id,
  };
}

/**
 * Pick the newest relevant review by the Codex actor for the current head SHA. Plain
 * `.at(-1)` on `relevant` reviews — a wrapper review (see `inspectReview`'s empty-body
 * guard above) is already filtered out of `relevant` before it gets here, so it can never
 * shadow a real, still-open blocking review by carrying a later id.
 */
export function latestCodexResult(reviews, inlineComments, opts) {
  const candidates = (reviews ?? [])
    .map((r) => inspectReview(r, inlineComments, opts))
    .filter((r) => r.relevant);
  return candidates.at(-1) ?? null;
}
