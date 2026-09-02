// Shared GraphQL review-thread helpers. Lives here (not in scripts/local/review-sweep.js)
// so scripts/orchestrate.js can reuse it without importing review-sweep.js, which pulls in
// isEligible from orchestrate.js itself — a circular import.

import { reviewerRoleAgents } from './policy.js';

/**
 * Threads that block a "clean" verdict: unresolved AND either a listed human or a
 * reviewer actor PARTICIPATED anywhere in the thread, OR a reviewer-role agent
 * ORIGINATED it (opened its root comment) — anchored to ANY commit, because findings do
 * not expire when a push happens (the dropped-P1 lesson from pilot #39: agent
 * re-reviews are nondeterministic, so open threads are the durable memory).
 *
 * The origination clause is what makes this catch a human-summoned `@codex review` /
 * `@claude review` (#58/#103): `reviewerRoleAgents(policy)` includes both, backend-gated
 * or not. It must be origination, not participation, for `claude[bot]` specifically —
 * that login is a reviewer identity (a summoned `@claude review`) AND the fixer identity
 * for every round it's dispatched to. A fixer reply to a thread it did not open is never
 * enough on its own to qualify the thread; only the thread's ROOT author decides which
 * role posted it, since the fixer never opens a thread (claude-fix-prompt.md only ever
 * has it reply or post one top-level comment).
 */
export function qualifyUnresolvedThreads(threads, policy) {
  const voices = new Set([...policy.humans, ...policy.reviewerActors, policy.codexActor]);
  const roleAgents = new Set(reviewerRoleAgents(policy));
  return (threads ?? []).filter((t) => !t.isResolved
    && ((t.comments ?? []).some((c) => voices.has(c.author))
        || roleAgents.has(t.comments?.[0]?.author)));
}

/**
 * Narrower than qualifyUnresolvedThreads: still-open threads the fixer has NOT yet
 * replied to since a human/reviewer voice last spoke — used by the fix-outcome
 * classifier (state.js, `reviewers.thread_authority: adjudicate|reviewer` only) so a
 * no-push round the fixer genuinely answered (reply, no push — a push-back) can re-queue
 * for the reviewer's own adjudication instead of an immediate human handoff. A thread
 * where the newest voice is a human or reviewer still counts as "unanswered" — the
 * fixer hasn't had the last word — and keeps forcing the classifier's handoff branch.
 * See docs/adr/0005-reviewer-owns-thread-lifecycle.md.
 *
 * A reviewer-role-agent-ORIGINATED thread (see qualifyUnresolvedThreads) with no reply
 * yet is also "unanswered" — its own root author is the only comment in it, and that
 * root author is by construction a reviewer role, never the fixer. "No reply yet" must
 * be `comments.length === 1`, never `last.author === root`: `claude[bot]` can be BOTH
 * the root author (a summoned `@claude review`) AND the fixer replying to it, so once
 * the fixer replies, `last.author` is still `claude[bot]`, identical to `root` — a
 * login-equality check would read that as "still unanswered" forever.
 */
export function unansweredThreads(threads, policy) {
  const voices = new Set([...policy.humans, ...policy.reviewerActors, policy.codexActor]);
  const roleAgents = new Set(reviewerRoleAgents(policy));
  return qualifyUnresolvedThreads(threads, policy).filter((t) => {
    const last = (t.comments ?? []).at(-1);
    const root = t.comments?.[0]?.author;
    const freshOrigination = t.comments.length === 1 && roleAgents.has(root);
    return !!last && (voices.has(last.author) || freshOrigination);
  });
}

// GitHub's GraphQL Actor union drops the "[bot]" suffix that bot logins carry
// everywhere else in this codebase — REST's `user.login`, policy.yml's `authors`/
// `reviewers.actors`/`humans`, inspect-review.js's comparisons. Confirmed live:
// chatgpt-codex-connector/normandy-tali/normandy-garrus all come back as
// `{ login: "normandy-garrus", __typename: "Bot" }` — no suffix. Every comparison
// against a GraphQL-sourced login in this file and review-sweep.js (ownThreadsOf,
// classifyFindings's isHumanAdjudicated, qualifyUnresolvedThreads' reviewerActors voice)
// checks against a REST-style "name[bot]" policy-configured login, so without this an
// actor's own threads never match its own login — silently turning the dedup gate (and
// the pre-existing unresolved-thread-forces-blocking check for bot voices) into a no-op.
// Normalized once, here, at the single point every consumer reads through, rather than
// patched at each comparison site.
function normalizeActorLogin(actor) {
  if (!actor?.login) return undefined;
  return actor.__typename === 'Bot' ? `${actor.login}[bot]` : actor.login;
}

// Unlike the REST fetches elsewhere (all via gh.paginate), this GraphQL connection has no
// shared pagination helper — walk its cursor by hand so a PR with more than one page of
// review threads doesn't silently hide an unresolved one from the durable-thread guard below.
export async function fetchReviewThreads(gh, repo, prNumber) {
  const [owner, name] = repo.split('/');
  const nodes = [];
  let after = null;
  for (;;) {
    const data = await gh.graphql(`
      query($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id isResolved path line
                resolvedBy { login __typename }
                comments(first: 100) { nodes { databaseId author { login __typename } body } }
              }
            }
          }
        }
      }`, { owner, name, number: prNumber, after });
    const page = data.repository.pullRequest.reviewThreads;
    nodes.push(...(page.nodes ?? []));
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  // ponytail: comments per thread still capped at 100 (not cursor-paginated) — a single
  // thread with more replies than that is not a realistic PR review thread; upgrade to a
  // nested cursor loop here too if that ceiling is ever hit in practice.
  return nodes.map((t) => ({
    id: t.id,
    isResolved: t.isResolved,
    // Maintainer resolutions made via GitHub's "Resolve conversation" button with no
    // comment still need to count as human-adjudicated (see isHumanAdjudicated in
    // review-sweep.js) — the comments list alone can't tell that apart from an
    // agent-only "Done" resolve.
    resolvedBy: normalizeActorLogin(t.resolvedBy) ?? null,
    path: t.path,
    line: t.line,
    // The REST reply endpoint only accepts a top-level (root) comment's database id —
    // posting to a reply's id is rejected. GraphQL returns comments oldest-first, so the
    // root is always index 0.
    rootCommentId: t.comments.nodes[0]?.databaseId ?? null,
    comments: (t.comments.nodes ?? []).map((c) => ({ author: normalizeActorLogin(c.author), body: c.body })),
  }));
}

/**
 * Does a fresh finding match an existing thread at (roughly) the same spot? Same path,
 * and within `proximity` lines of each other (tolerates minor line drift from unrelated
 * edits elsewhere in the file). A line-less FINDING (file-wide) falls back to a path-only
 * match. A line-less THREAD does NOT — GitHub nulls a thread's `line` once its anchor
 * goes outdated (a later commit moved/removed the anchored lines; confirmed live: PR #9's
 * own `run.py` thread sits at `line: null, isOutdated: true`). Path-only matching there
 * would let one stale outdated thread swallow every future lined finding in that file —
 * hiding real, unrelated bugs and reopening the wrong thread. Without a live line to
 * compare, we can't confirm co-location, so a lined finding simply doesn't match it.
 *
 * Multiple own threads can sit in the same file within `proximity` of each other (e.g.
 * one resolved at line 100, another still open at line 104) — picking whichever GitHub
 * listed first instead of the nearest one can associate a fresh finding with the wrong
 * thread's fate, so among candidates within range a lined finding picks the closest one.
 */
export function matchOwnThread(finding, ownThreads, proximity) {
  const sameFile = (ownThreads ?? []).filter((t) => t.path === finding.path);
  if (finding.line == null) return sameFile[0] ?? null;
  let best = null;
  let bestDist = Infinity;
  for (const t of sameFile) {
    if (t.line == null) continue;
    const dist = Math.abs(finding.line - t.line);
    if (dist <= proximity && dist < bestDist) { best = t; bestDist = dist; }
  }
  return best;
}

/**
 * Reopen a resolved thread. GitHub's REST API has no endpoint for this — only GraphQL's
 * `unresolveReviewThread` mutation does. Used when an agent-only-resolved thread's
 * finding is re-detected: `isResolved` was an unverified "Done" claim, and re-detection
 * is the signal that the fix didn't hold (see classifyFindings in review-sweep.js).
 */
export async function unresolveReviewThread(gh, threadId) {
  await gh.graphql(
    'mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }',
    { id: threadId },
  );
}

/**
 * Resolve a thread. Mirror of `unresolveReviewThread` above, for the reverse direction:
 * the reviewer sweep closing its own thread after re-verifying (a `withdraw` verdict —
 * see `applyAdjudications` in review-sweep.js and docs/adr/0005-reviewer-owns-thread-lifecycle.md).
 * Never called for a thread a human has commented in unless the verdict carries
 * `human_intent: "clear-and-satisfied"` — that gate lives in the caller, not here.
 */
export async function resolveReviewThread(gh, threadId) {
  await gh.graphql(
    'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }',
    { id: threadId },
  );
}
