# `/ai` — PR comment command reference

## NAME

`/ai` — steer the orchestrator from a pull request comment

## SYNOPSIS

```
/ai retry
/ai fix [instruction...]
/ai round-cap <n>
/ai status
/ai refresh
/ai help
```

## DESCRIPTION

Post as a normal top-level PR comment (not an inline review comment) on a PR the
orchestrator manages. Every subcommand is gated on the `humans:` list in the repo's
`.github/ai-policy.yml` — commands from anyone else are ignored (logged server-side,
no reply). Commands work in any orchestrator state, including `ai:needs-human`.

## COMMANDS

**retry**
    Full episode reset at the current head: clears `ai:needs-human`, the round
    counter, and recorded results, then re-runs the cycle. If a blocking review
    already exists for this head, the fix round dispatches immediately — no push
    needed — except a `contested`/`ask` review (the reviewer already re-adjudicated
    a push-back): that's treated as stale, and retry requests a fresh review instead.
    Recovery for `fixer-failed`/`fixer-skipped`-style infra handoffs.

**fix** [*instruction...*]
    Dispatch a Claude fix round now, no blocking review required. *instruction* is
    optional and may span multiple lines; when given, it is appended verbatim to the
    fixer's prompt as authoritative scope on top of any open threads. Human-initiated
    fix rounds are counted but never capped.

**round-cap** *n*
    Set this PR's automatic fix-round budget to *n* (a non-negative integer),
    overriding `max_rounds`/`AI_ORCH_MAX_ROUNDS` for this PR only. Sticky for the PR's
    life — survives `/ai retry`, a push, a new head — until changed again by another
    `/ai round-cap`; there is no unset form, restore the default by setting it back to
    the policy's own number. `0` sends every blocking review straight to a human, no
    automatic rounds at all. If the PR is currently latched at `ai:needs-human` because
    the *previous* budget was reached (`round-limit`), raising the cap also resumes
    automation immediately — any other handoff reason (a genuine dispute, failing CI,
    …) is left untouched, since the cap has nothing to do with those. Malformed or
    missing *n* is silently ignored, like any other unrecognized command. Human-
    initiated `/ai fix` rounds stay uncapped regardless of this setting.

**status**
    No-op refresh: re-evaluates and updates the sticky status comment. Does not
    consume a round. In `active` mode, also posts a fresh **status echo** — a disposable,
    human-only copy of the status comment at the bottom of the thread, flagged as a copy
    with a link back to the live one. Unlike the sticky comment itself, the echo never
    stays in place: each run posts a new one and removes the old (see NOTES). No echo is
    posted in `dry-run` mode; only the sticky comment is refreshed there.

**refresh**
    Triggers a **reconciliation**: re-derives durable state from the PR's current facts
    (reviews for the head, review-thread resolution, CI, risk) instead of trusting
    whatever the sticky comment last recorded. For when a lost or never-run event left
    the state behind reality — e.g. a fixer job died without reporting, or a webhook that
    should have advanced the state machine never arrived — and a human has since resolved
    the blocking threads by hand but the PR is still shown stuck. Unlike `/ai retry`, this
    never dispatches a fix round and never resets the round counter.

    Never a labels-only operation — every orchestrator run already reconciles labels from
    state, `/ai status` included; refresh targets the state itself. And a reconciliation
    can never promote straight to `ai:ready`: if it finds nothing blocking, it re-queues
    the PR for a fresh review instead, so the confirming verdict always comes from a real
    review, never stale evidence. If qualifying review threads are still unresolved or
    their state can't be confirmed, nothing changes — the reply says why. Same for a
    standing `ai:needs-human` handoff that was for CI still failing on this head. Consumed
    once per comment id, same dedupe as `retry`/`fix`.

    The one exception to "nothing changes": on a PR already `ai:ready`, refresh checks
    qualifying threads too — and if any are still open, that's not agreement to leave
    alone, it's a stale recorded verdict to correct. It clears the badge and re-queues for
    a fresh review, the same way it would from any other state; it still never dispatches a
    fix round itself — a reconciliation never promotes, by design; it only re-queues.
    A ready PR whose thread state can't be confirmed declines the same as any other state.

    Same blind spot as `/ai retry` on a PR that's genuinely `ai:fixing` right now (not
    dead, just still running): reconciliation can't tell "the fixer died without
    reporting" from "a round is in flight," so re-queuing off `ai:fixing` risks discarding
    that round's outcome if it reports back after the fact — the reply flags this case.

**help**
    Reply on this comment with this reference. Does not touch orchestrator state,
    labels, or the round counter, and works in `dry-run` mode too.

## NOTES

- Every accepted command, `help` included, gets an immediate 👀 reaction, the same ack
  Codex gives `@codex review` — confirmation the command was seen before the run
  finishes (or, for `help`, before its reply lands). Suppressed in `dry-run` mode,
  since nothing is actually dispatched there.
- A comment starting with `/ai` that doesn't match a recognized subcommand (a typo, a
  malformed `round-cap` argument, ...) gets a 😕 reaction instead, from a listed human
  — GitHub's reaction set has no "disappointed", so `confused` stands in. Same gating
  as the 👀 above: nothing from an unlisted commenter, nothing in `dry-run`. An
  ordinary comment that merely mentions `/ai` mid-sentence gets neither reaction.
- A `REQUEST_CHANGES` review from a listed human works as a command too: it dispatches
  a fix round on your findings, exactly like `/ai fix`. See
  [human-controls.md](human-controls.md).
- `refresh` always replies on the comment — in both `active` and `dry-run` mode,
  informational like `help` — stating what it did (re-queued, or demoted off `ai:ready`)
  or why it declined (threads still open, listed by location; or thread state couldn't be
  confirmed). Re-queuing leaves a standing human `REQUEST_CHANGES` review as-is on GitHub
  (only the human can dismiss it) — the reply flags it when this applies, as a reminder the
  badge is still there even though `/ai refresh` itself won't act on it again.
- On a busy PR, the sticky comment gets buried and updates in place — it never moves
  down the thread. `/ai status` is the fastest way to pull a fresh copy to where you're
  reading, especially on mobile. The same echo also fires automatically, checked on every
  orchestrator run (a push, a review, a CI completion — not on ordinary discussion
  comments, which don't trigger a run by themselves) once `echo_frequency` timeline items
  have accrued since the last echo (default `100`; set `echo_frequency: 0` or `null` in
  `ai-policy.yml` to disable the automatic trigger — in `active` mode, `/ai status`
  still always echoes regardless of `echo_frequency`. Neither trigger fires in
  `dry-run`).

## SEE ALSO

[human-controls.md](human-controls.md), [state-machine.md](state-machine.md),
[policy-reference.md](policy-reference.md)
