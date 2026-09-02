# A.W.E. — Agentic Workflows Engine

Glossary for the PR orchestration + review loop this engine runs. ADR numbers refer to design
records kept in the maintainer's private companion repository.

## Review memory

**Adjudicated thread**:
An own review thread that already stands at a location — either unresolved (live, still
blocking a clean verdict) or resolved (addressed or answered). A fresh finding that
matches one is a duplicate, not news.

**Human-blessed thread**:
A resolved thread GitHub's own `resolvedBy` names as a `humans` login. Its resolution is
authoritative and never auto-reopened — contrast an agent-only-resolved thread, whose
resolution is an unverified `"Done"` claim that a re-detected finding calls into
question. A human merely *commenting* somewhere in the thread does not bless it — an
agent can post a broken fix and resolve the thread itself afterward, so only who
actually clicked resolve counts (ADR 0001).
A human comment still matters — see Thread lifecycle below — just not as blessing.

**Re-raise**:
Reopening an existing resolved thread (with an explaining reply), done only when an
*agent-only*-resolved thread's finding is re-detected — signalling the fix didn't hold.
Never posting a second thread for the same finding.
_Avoid_: re-comment, re-file, re-post.

**Location match**:
A fresh finding matches a thread when they share a path and — when both carry a line —
sit within the proximity window (±N lines). Line-less findings match on path alone.

**Durable memory**:
Review state that survives a push because agent re-reviews are nondeterministic. Open
threads force a clean scan to blocking; adjudicated threads suppress a re-raise.

**Summoned review**:
A hosted-agent review triggered by an explicit human mention (`@codex review`,
`@claude review`) rather than dispatched by the orchestrator's own configured
`backends.reviewer`. Its findings block a clean verdict exactly like a dispatched
reviewer's — durable memory does not care who asked — but its *silence* never promotes:
a summoned reviewer only ever runs when asked, so the absence of a review carries no
information, unlike a dispatched reviewer's clean result. See
ADR 0007.

**Reviewer-opened thread**:
A thread whose ROOT comment was posted by an agent capable of the reviewer role
(`reviewers.actors` or `reviewers.vendors`), as opposed to a **reviewer voice** — any
comment, anywhere in the thread, from a human or a reviewer actor. The distinction exists
because `claude[bot]` is both a reviewer identity (a summoned `@claude review`) and the
fixer identity for every round it's dispatched to: the fixer replies to threads it
addresses, so its mere *participation* carries no signal and must never count as reviewer
conversation on its own — only *origination* (who opened the thread) can, since the fixer
never opens one (see ADR 0007).

**Wrapper review**:
A review object GitHub creates solely to carry a standalone reply comment — empty body,
`COMMENTED` state, no root comments, only a reply. A delivery envelope, not a verdict, and
never evidence for the state machine: it carries a fresh (higher) review id, so reading it
as a real review shadows the actual review submitted moments earlier and silently zeroes
every marker on it (`blocking`, `contested`, `escalate`, ...) along with `blocking` itself.
Confirmed live on PR #119 (shadowed a standing `CHANGES_REQUESTED`) and PR #122 (shadowed a
`CONTESTED_MARKER` dispute escalation) — both landed on `ai:ready` over open findings.

**Open-thread block**:
A clean scan turned blocking solely because adjudicated-voice threads stand open — the
mechanism durable memory uses to enforce itself. Its findings are procedural, not new
code findings, and never a second thread for the same spot — contrast a re-raise, which
reopens one. What the procedural instruction asks for depends on thread authority: at
`fixer`, "address it and resolve the thread"; at `reviewer`, "address it — the reviewer
resolves it after re-verifying." Distinguishing this from an ordinary blocking review
matters downstream: a fix round dispatched by an open-thread block that ends with every
such thread resolved (or, at `adjudicate`/`reviewer`, unanswered) is not a dispute, even
if nothing was pushed.

**Stateless sweep**:
Each reviewer run derives findings only from the PR diff. Its "memory" comes from reading
existing threads at run time, not from persisted sweep state.

## Thread lifecycle

Who may resolve a review thread, and how a disputed one gets closed without either side
certifying its own work. See ADR 0005.

**Thread authority**:
The `reviewers.thread_authority` policy setting: `fixer` (default — the fixer resolves
what it addressed or answered, today's behavior), `adjudicate` (the fixer still resolves,
but the reviewer adjudicates any thread it pushed back on instead of blindly re-raising
the same finding), or `reviewer` (the fixer never resolves; only the reviewer does,
always after re-verifying).

**Push-back**:
A fix round where the fixer replied to a finding but pushed no code — a dispute, not
silence, until the reviewer says otherwise.

**Self-certification**:
An actor resolving a thread it is a party to — the fixer closing a thread over its own
fix, or a reviewer trusting its own prior finding is gone just because a stateless rescan
didn't re-derive it. What thread authority above exists to prevent: closing a thread is
reserved for whichever actor did *not* make the claim being closed.

**Answered thread** / **unanswered thread**:
Whether the fixer has replied since a reviewer or human last spoke in an open thread. The
fix-outcome classifier (state-machine `disputed` no-push rounds) counts only unanswered
threads at `adjudicate`/`reviewer` — an answered push-back re-queues for adjudication
instead of an immediate human handoff, where a `fixer`-tier round still requires the
round to have been an open-thread block.

**Adjudication**:
The reviewer re-verifying, against the CURRENT code, its own group's open threads that
someone else has replied to since a reviewer last spoke — the mechanism that lets a
push-back close without the fixer certifying itself. Per thread, one of three verdicts:

- **Withdraw**: the reviewer no longer has a finding here; it replies and resolves.
- **Sustain**: the reviewer still disagrees after re-verifying; it replies and the review
  is marked **contested** — a genuine dispute, handed to a human without burning another
  fix round.
- **Ask**: the thread's human intent can't be determined; the reviewer replies without
  resolving and the review is marked **awaiting human** — left for a human to close, not
  guessed at by either agent.

A `withdraw` on a thread a human has commented in additionally requires the human's
instruction to have been clear AND independently confirmed satisfied against the code —
otherwise it downgrades to `ask`, enforced in code rather than trusted from the model, so
a human's presence in a thread can withhold the reviewer's authority to close it without
ever granting trust to close it either.

**Group adoption**:
A reviewer sweep may adjudicate/resolve a thread opened by any reviewer identity sharing
its vendor group (`reviewers.vendors`), not only its own login — so cloud Codex can open
a thread that a same-vendor local sweep later re-verifies and closes. Membership is by
**origination**, not participation: a fixer identity that happens to share a vendor list
with a reviewer (`claude[bot]` sits in `vendors.claude` alongside the local reviewer's own login)
is excluded from the group by its REPLIES — the fixer's own group must never bless the
fixer's own reply — but is legitimately admitted as a member when it ORIGINATED a thread
itself, i.e. a **reviewer-opened thread** from a summoned `@claude review`. See
ADR 0007.

## Round budget

**Fix round**:
One fixer dispatch — the unit `max_rounds` counts. Reviews are only what triggers one;
the domain never calls these "review rounds".

**Episode budget**:
`round`'s live value against the effective cap: how many fix rounds the *current*
episode has left before a `round-limit` handoff. Resets to 0 on `/ai retry` and on a
listed human's push (a fresh look-again grants a fresh budget); bypassed entirely by an
`/ai fix` (counted, never capped) and by a human's own `REQUEST_CHANGES` review (never
capped — the human is the oversight the cap escalates to). Because it resets, a PR can
burn many multiples of the cap across its life without ever exceeding it in any one
episode — see **Total rounds** below.

**Round cap**:
A human's per-PR override of `max_rounds` (`/ai round-cap <n>`, issue #112). Resolved
with per-PR **>** `AI_ORCH_MAX_ROUNDS` **>** `ai-policy.yml`'s `max_rounds`, most
specific wins. Unlike the episode budget it overrides, the cap itself is a fact about
the PR ("this one's important"), not the episode — it survives every reset (`/ai retry`,
a human push, a new head) for the PR's life, until changed again by another
`/ai round-cap`. Raising it while latched on `round-limit` also resumes automation
immediately; any other handoff reason is untouched, since the cap has nothing to do with
those.

**Total rounds**:
Every fix round a PR has ever burned, across every episode — the number issue #110
asked for, since the episode budget alone answers "how much is left", never "how much
has this PR absorbed". Never resets.

**Re-verification** (issue #168):
Not a fix round and does not consume the round budget — verifying whether an open own
group thread's finding still holds at the current HEAD (verify-priors only, never new
findings) is acknowledging a fix, not new litigation. Runs from the same local sweep
tick as an ordinary review, but on PRs latched at
`ai:needs-human` rather than `ai:reviewing`, and posts no review — only thread
resolutions/replies via the existing adjudication machinery
(ADR 0005). Head-driven, not
reply-driven: a thread the reviewer already sustained is re-offered on the next push
regardless of who spoke last, closing the gap where the round budget exhausted while a
fix was already in flight (PR #166). Never loosens the `ai:needs-human` latch itself —
see ADR 0011; a human's
`/ai refresh` after re-verification clears the threads is still what re-queues the PR.

## Reconciliation

**Reconciliation**:
Re-deriving durable state from the PR's observable facts (reviews for the head, thread
resolution, CI, risk) when a lost or never-run event left the stored state behind
reality — the human control surface's answer to issue #97. Never a labels-only
operation — labels already reconcile on every run (`desiredLabels`, driven purely by
state) — and never a promotion: a reconciliation that finds nothing blocking re-queues,
so the confirming verdict always comes from a real review, never stale evidence.
Performed by the `/ai refresh` command. Contrast **retry**, which resets the whole
episode (including the round counter) and may dispatch a fix round immediately; a
reconciliation dispatches nothing.

## Readiness axes

Three independent facts about a PR, previously collapsed into one `ai:ready`/
`ai:needs-human` signal — see ADR 0012 for
why they were split and what stayed fused.

**AI axis**:
Whether the reviewer found anything — `state.codex.result` (`clean`/`blocking`). One half
of what `ai:ready` requires.

**Build axis**:
Whether CI is green — `state.ci.conclusion`. The other half of what `ai:ready` requires;
unlike the human axis below, this one still gates it.

**Human axis**:
Whether policy wants a human's eyes regardless of the AI and build axes — `risk.level`
and `risk.humanRequired` (`scripts/lib/risk.js`). Reported in labels and notifications,
but never gates `ai:ready` or the merge gate — signal, not a block. `ai:ready` on an
elevated-risk PR is not a contradiction: it means "the agents are satisfied; a human
still needs to look at *why* policy flagged it."

## Commit identity

**Author** vs **pusher**:
A commit's author is a name/email written *inside* the commit — cosmetic, and whatever
the committing tool chooses to set. The pusher is whichever credential actually ran `git
push` — GitHub's own record, separate from the commit content, and the one it uses to
decide whether a push may trigger further workflow runs (`GITHUB_TOKEN`-authored pushes
never do, by design; GitHub App-authored pushes do). The two can disagree: `git push`
reuses whatever push credential is already configured in `.git/config` (e.g. one
`actions/checkout` wrote there) regardless of which identity authored the commit or which
identity the pushing tool itself authenticates as elsewhere. Reading only the author on a
commit list can look correct while the pusher — the field workflow-triggering actually
keys on — silently disagrees.

## Consumer ref policy

**`live`**:
The tag every consumer repo pins (`orchestrator.yml@live`). Moved automatically to every
commit on `main` that passes CI — no manual retagging, no vetting beyond CI. Never means
"a released, extra-vetted version"; see ADR 0004.

**`live-history/<n>`**:
An append-only, immutable record of every SHA `live` has ever pointed at (`n` = commit
count on `main`). Never a consumer pin — a rollback source only, read by a human picking a
target for the tier-1 recovery in ADR 0004's runbook.

**Contract surface**:
The subset of files a consumer repo's own copies must change in lockstep with:
`templates/consumer-workflow.yml`, `templates/labels.json`,
`schemas/ai-policy.schema.json`. A PR touching these gets a deterministic
`::warning::` (`ci.yml`'s "Warn when a PR forces consumer migration" step, in the `test`
job) rather than relying on a PR description an agent wrote about its own change.
Contrast the host↔cloud contract below — same mechanism, different boundary.
