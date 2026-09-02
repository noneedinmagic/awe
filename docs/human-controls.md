# Human controls — steering the machine from anywhere

Everything here works from GitHub mobile: the design goal is full decision control
while away from a laptop. All controls are gated on the `humans:` list in the repo's
`ai-policy.yml`; commands and reviews from anyone else are ignored (logged, no reply).

## `/ai` comment commands

Post as a normal PR comment (top-level, not inline). Full reference, man-page style:
[ai-command.md](ai-command.md) — or just post `/ai help` on the PR to get it back as a
reply.

| Command | Effect |
|---|---|
| `/ai retry` | Full episode reset at the current head: clears `ai:needs-human`, round counter, and recorded results, then re-runs the cycle. If a blocking review already exists for this head, the fix round dispatches immediately — no push needed — *except* when the handoff being cleared is a `contested`/`ask` review (the reviewer's adjudication verdicts) or an `agents-disagree`/`agents-may-disagree` dispute (the fixer's own no-push report): those are all treated as stale, not durable evidence, so retry requests a fresh review instead (ADR 0009). This is the recovery for `fixer-failed`/`fixer-skipped`-style infra handoffs. |
| `/ai fix <instruction…>` | Dispatch a Claude fix round **now**, no blocking review required. The instruction text (optional, multiline OK) is appended verbatim to the fixer's prompt as authoritative scope on top of the open threads. This is the "delegate the change to the agents" primitive. |
| `/ai round-cap <n>` | Set this PR's automatic fix-round budget to `n`, overriding `max_rounds` for this PR only. Sticky for the PR's life — no unset form; set it back to the policy number to restore the default. If the PR is latched at `ai:needs-human` because the *previous* budget was reached, this also resumes automation immediately (any other handoff reason is untouched). See [ai-command.md](ai-command.md). |
| `/ai status` | No-op refresh: re-evaluates and updates the sticky status comment. |
| `/ai refresh` | Reconciliation: re-derives durable state from the PR's current facts (reviews, thread resolution, CI, risk) — for when a lost or never-run event left the stored state stuck behind reality. Never dispatches a fix round and never resets the round counter (that's `/ai retry`'s job); never promotes straight to `ai:ready` either — if nothing is blocking, it re-queues for a fresh review instead of trusting stale evidence. Declines (state unchanged) if qualifying review threads are still unresolved, or their state can't be confirmed — either way it replies saying so. |
| `/ai help` | Replies on the comment with [ai-command.md](ai-command.md). Doesn't touch state, labels, or the round counter — works in `dry-run` mode too. |

Notes:
- Human-initiated fix rounds are **counted but never capped** — the `max_rounds` budget
  exists to stop agent↔agent loops, and you are the oversight it escalates to.
- Hit `round-limit` on a PR that's worth more automatic iteration? `/ai round-cap <n>`
  raises the budget and, from that exact handoff, resumes automatically — no separate
  `/ai retry` needed (and `retry` would also discard the standing review verdict, which
  this doesn't).
- Commands work in any state, including `ai:needs-human` — they are the designed
  alternative to the "push something to reset" dance.
- Every accepted command, `help` included, gets an immediate 👀 reaction on the
  comment, the same ack Codex itself gives `@codex review` — confirmation the command
  was seen, before the run finishes (or, for `help`, before its reply lands).
  Suppressed in `dry-run` mode, since nothing is actually dispatched there.
- A comment that starts with `/ai` but doesn't match a recognized command (a typo, a
  malformed `round-cap` argument, …) gets a 😕 reaction instead — same gating as the
  👀 above (listed human, `active` mode only).

## Reviews as commands

A **`REQUEST_CHANGES` review from a listed human** counts as first-class blocking
evidence, exactly like an agent review: it dispatches a fix round on your findings
(inline comments become the fixer's scope; also uncapped). Dismissing that review
un-counts it — **only you can clear it**, agents never dismiss a human's review. Your
own agent reviews work the other way: once a reviewer clears its own earlier blocking
finding with a clean re-review, it dismisses its own stale badge automatically — so a "Changes requested" banner on a managed
PR always means either a currently-blocking agent finding or a human's own standing
review, never a stale leftover. Approvals are deliberately left GitHub-native — they
don't drive the machine; merging stays your explicit act.

So the two natural gestures both work: *comment* `/ai fix do X`, or *review* the code
the way you'd review a human's PR.

## Threads are durable memory

Replying to a finding thread does not by itself trigger anything — but it is never
lost either: the sweep refuses to accept a "clean" re-review while unresolved threads
with human or reviewer participation exist (any commit anchor — findings don't expire
on push), converting them into a blocking review that loops the fixer. The fixer
addresses such threads and **resolves** them when done (never the ones it pushed back
on). Practical upshot: if you agree with a finding, say so in the thread and either
wait for the next cycle or `/ai fix` to force one now; the thread stays load-bearing
until explicitly resolved.

**A comment does not resolve a thread — only GitHub's own "Resolve conversation"
button/API does.** Writing "Looks resolved" or "agreed, fixing" in a thread is not the
same as clicking Resolve: the orchestrator and sweep only ever read `resolvedBy`
(GitHub's own record of who actually resolved it), never comment text, by design
(ADR 0001, ADR 0005). A thread you've replied to
approvingly but not resolved still reads as open and still blocks. If you intend to
close it yourself, use the button.

## Re-verification while stuck at `ai:needs-human`

A `round-limit` handoff means the fixer's automated loop stopped, not that agent
threads stop getting checked: every sweep tick also re-verifies each open thread your
listed reviewer group raised against the PR's *current* HEAD, independently of the
round budget, and resolves/replies to whichever ones the current code actually fixes.
This is verify-priors only — it never raises a new finding and never posts a review, so
it cannot itself move the PR out of `ai:needs-human`. Once the threads you care about
are clear, `/ai refresh` re-queues the PR for a fresh review (see the command table
above); auto-promoting straight to `ai:ready` once re-verification clears the last
thread is deliberately out of scope for now (tracked separately).

## Knowing when to look — Telegram notifications

Set `notifications.telegram.enabled: true` in a repo's `ai-policy.yml` and add
`AI_ORCH_TELEGRAM_BOT_TOKEN` / `AI_ORCH_TELEGRAM_CHAT_ID` as that repo's Actions
secrets to get a Telegram message on:

- **`ai:needs-human`** — a handoff (fires once per episode, same as the
  sticky-comment/review-request effects — never spammed per event). Includes the
  same "why automation stopped" / "recommended scope" reasoning the pinned sticky
  comment shows, plus a `<b>Risk:</b>` block (level and reasons) whenever the PR's
  risk is elevated, regardless of which reason actually triggered the handoff. For
  the three dispute reasons (`agents-disagree`, `agents-may-disagree`,
  `reviewer-sustained`), the message also lifts each blocking thread's
  plain-language adjudication card straight in — the "🧑‍⚖️ For the human, in plain
  words:" card a `sustain` reply appends when a disagreement completes a full
  push-back/rebuttal cycle (see `scripts/lib/adjudication-cards.js`) — so triage
  can start in Telegram without opening GitHub first. A thread with no card yet
  (predates this feature, or the disagreement never reached a full cycle) is
  silently omitted, not shown as missing; the message still degrades to the same
  plain handoff text either way.
- **`ai:ready`** — the PR is clean and green, waiting on a manual merge. This is
  the one case a human doing the merge by hand has no other signal that it's time
  to look. `ai:ready` does not imply low risk (ADR 0012):
  a size- or path-flagged PR can reach it too, with its risk level stated in the
  sentence and the reasons listed underneath — read the 👤 glyph before merging by
  hand. Fires once per episode too, including a retroactive ping if the PR reached
  `ai:ready` while the policy was still `dry-run` and you later flip it to
  `active` — same replay behavior as `ai:needs-human`.

Both messages link the repo name and `#<PR number>` straight to GitHub, and both lead
with a fixed-position, three-glyph row instead of one glyph doing three jobs:
🤖 (did the reviewer find anything?), 🛠️ (is the build green?), 👤 (does policy want
your eyes?) — shape carries the axis, color the state
(🟢 good/⚪ no verdict yet/🟡 pending/🔴 bad). Never reordered, so position always maps
to the same axis. Telegram's Bot API has no colored text, so each axis is cued with
an emoji instead — the same palette as this repo's `ai:*`/`risk:*` label colors
(`templates/labels.json`).

A **🟢 "auto-merged"** message is wired but currently unreachable: `policy.merge.auto_merge`
doesn't actually merge anything yet (see [policy-reference.md](policy-reference.md)) — the
notify effect just has nowhere to fire from until that's built.

Deliberately prefixed `AI_ORCH_` rather than a generic `TELEGRAM_BOT_TOKEN`:
GitHub Actions secrets are already repo-scoped so a bare name can't literally
collide, but the prefix keeps intent obvious if this account ever centralizes
secrets (e.g. via an Organization's shared secrets) where a generic name really
could collide with an unrelated bot. Safe to enable before the secrets exist — the
send is skipped silently until both are set.
