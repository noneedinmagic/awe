# State machine

States: `ai:queued`, `ai:reviewing`, `ai:fixing`, `ai:needs-human`, `ai:ready`,
`ai:failed` (plus implicit `unmanaged` = no state comment). Orthogonal display labels:
`risk:low|medium|high`, `ai:round-N`.

There is no `ai:waiting-rereview`: a fix push creates a new head SHA whose cycle is
simply `ai:queued → ai:reviewing` again; the round counter persists across SHAs.

## Transitions

| # | From | Trigger | Guard | Actions | To |
|---|---|---|---|---|---|
| 1 | — | `pull_request` opened/reopened/ready_for_review/synchronize, or `labeled` with the opt-in label | author allowlisted or opted in; not draft; not fork; policy enabled | init/refresh state for head SHA; classify risk (policy read from **base ref**) | `ai:queued` |
| 2 | `ai:queued` | same run | no Codex result recorded for this head SHA | request Codex review once (`codex.requested_sha` dedupe) | `ai:reviewing` |
| 3 | `ai:reviewing` | review submitted by `codex_actor` | `review.commit_id == head SHA` (else stale, ignored) | interpret findings | 4 or 5 |
| 4 | `ai:reviewing` | blocking findings | `round < max_rounds` | `round++`; dispatch Claude fix job | `ai:fixing` |
| 4b | `ai:reviewing` | review carries `escalate` (local reviewer CLI failing repeatedly), `contested` (reviewer re-adjudicated a push-back and sustained it — ADR 0005), or `awaitingHuman` (an `ask` adjudication verdict) | checked ahead of transition 4 | handoff `local-reviewer-escalation` / `reviewer-sustained` / `awaiting-human-resolution` — no round spent. `/ai retry` treats all three as stale rather than re-deriving the same handoff — see ADR 0009 | `ai:needs-human` |
| 5 | `ai:reviewing` | clean review | CI green | promote — risk no longer gates this transition; see ADR 0012 | `ai:ready` |
| 6 | `ai:fixing` | fixer pushed → `synchronize` (new SHA) | — | transition 1 for new SHA, round preserved | `ai:queued` |
| 7 | `ai:fixing` | fixer succeeded, no push | classified by whether the round was dispatched purely by an open-thread block (durable-memory findings, not code findings) and whether any such threads are still open now — see ADR 0003. At `reviewers.thread_authority: adjudicate`/`reviewer` the "still open" count is narrowed to *unanswered* threads (the fixer hasn't replied since a reviewer/human last spoke), so a real push-back the fixer DID reply to can also re-queue — see ADR 0005 | open-thread block (or, at `adjudicate`/`reviewer`, any auto-dispatched round) + no threads left unanswered → not a dispute, re-queue (`ai:queued`) + informational ping; a thread still open/unanswered → handoff `agents-disagree`; real/body-only findings or unconfirmed thread state, nothing left open → handoff `agents-may-disagree` (possible dispute — the record can't tell addressed-in-replies from disputed) | `ai:queued` / `ai:needs-human` |
| 8 | `ai:fixing` | fixer job failed/timed out | — | handoff `fixer-failed` | `ai:needs-human` |
| 8b | `ai:fixing` | fixer job was skipped without running | `claude-code-action`'s own workflow-validation guard refuses to run when the PR changes the workflow file the run itself came from (`steps.claude.outputs.execution_file` empty — see "Determine fix outcome" in `orchestrator.yml`) — distinct from 8 (it ran and errored) and 7 (it ran, reported success, pushed nothing) | handoff `fixer-skipped` | `ai:needs-human` |
| 9 | any managed | round limit / repeated CI failures / unparseable review | fires **once** per episode (`handoff.done`) | label + review request to `humans` + handoff block in sticky comment + optional Telegram | `ai:needs-human` |
| 10 | any | orchestrator internal error | — | workflow run fails visibly | (unchanged) |
| 11 | any | event SHA ≠ live head SHA | — | logged no-op | unchanged |
| 12 | `ai:needs-human` | human pushes new commits | `sender ∈ humans` on synchronize | round and handoff reset | `ai:queued` |
| 13 | `ai:queued` / `ai:reviewing` / `ai:ready` | a human-summoned `@codex review` / `@claude review` with open findings lands on the current head | reviewer not already latched at `ai:fixing`/`ai:needs-human`; review id above `codex.review_floor` | reset `codex`, latch `review_floor` to the summoned review's id — never treated as evidence itself, see ADR 0007 | `ai:queued` (re-requests a fresh review) |
| 14 | `ai:queued` / `ai:reviewing` | a BODY-ONLY summoned review (no inline comment, so no thread) stands unreleased and a fresh clean recognized-reviewer result would otherwise be silently suppressed forever | `summonedReviewId > codex.summoned_floor`; `!summonedReviewHasThread` | handoff `summoned-review-no-thread`, linking the standing review — a threaded summoned review never reaches this: its thread already converts the recognized reviewer's own next scan to blocking via transition 5's durable-memory gate, so it resolves through the ordinary round/dispatch path instead | `ai:needs-human` |

## Human inputs (see [human-controls.md](human-controls.md))

Four additional inputs, all gated on the policy's `humans:` list:

| Input | Effect |
|---|---|
| `/ai retry` comment | full episode reset at the current head — the only latch-clearing input besides a human push; if a blocking review already exists, the fix round dispatches immediately |
| `/ai fix <instruction>` comment | dispatch a fix round now, no blocking review needed; instruction appended verbatim to the fixer prompt; counted but never capped |
| `/ai refresh` comment | reconciliation — re-derives state from the PR's current facts (reviews, thread resolution, CI, risk) for a state left stuck by a lost/never-run event; never dispatches a fix round, never resets the round counter, never promotes straight to `ai:ready` (re-queues instead); declines with a reply if qualifying threads are still open or unconfirmed, or if a standing `ci-failing` handoff's CI is still red |
| `REQUEST_CHANGES` review by a human | first-class blocking evidence (their inline comments = findings), also uncapped; dismissal un-counts it |

Additionally, the sweep refuses a clean verdict while unresolved review threads with
human/reviewer PARTICIPATION exist, or that a reviewer-role agent ORIGINATED (any commit
anchor) — open threads are durable findings, converted into a blocking review that loops
the fixer to address-and-resolve. The origination clause is what makes a human-summoned
`@codex review` / `@claude review`'s findings durable too, even when the backend that
posted them isn't currently `backends.reviewer`-dispatched — see ADR 0007.

## Head-SHA discipline

Every recorded result (`codex.reviewed_sha`, `ci.sha`, gate check run) is keyed to the
SHA it was produced for; only evidence matching the live head counts. A review or green
CI for an older SHA can never satisfy the current head.

## Idempotency

`reduce()` is pure; replaying the same event over the state it produced yields zero new
effects (verified by tests). Duplicate webhook deliveries, re-run jobs, and out-of-order
`check_suite` events degrade to no-ops. Consecutive CI failures count once per SHA.

## Over the round limit

The loop stops for that episode: one transition to `ai:needs-human` — label, review
request to every login in `humans`, a handoff block (reason, rounds, CI state,
recommended scope) inside the sticky comment, at most one Telegram ping. Nothing further
happens automatically until a human pushes (resets the episode) or intervenes manually.
The PR is never auto-closed or auto-merged.
