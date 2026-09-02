# Troubleshooting & verification items

## Verification items — all resolved (2026-07-17, first pilot repository)

| # | Question | Result |
|---|---|---|
| 1 | Does the cross-repo `actions/orchestrate` reference resolve from a private consumer with no token? | **Yes** — the first pilot run resolved and executed the action with no token. |
| 2 | Does Codex **auto-review** fire on every push? | **No** — on #39 the only auto-review was at PR open (July 12); a later push got none. |
| 3 | Does Codex act on `@codex review` posted by `github-actions[bot]`? | **No, definitively** — Codex replied in 7s: *"To use Codex here, create a Codex account and connect to github"*. It resolves the comment author's linked human ChatGPT account, so **no bot identity can ever trigger it** (a dedicated mention app is ruled out too, not just GITHUB_TOKEN). |

Consequence of 2+3: the cloud-Codex mention mechanism is dead for automation. The
reviewer role moved to the maintainer's host-side **local-agent sweep**. The `codex` backend remains valid only for
repos where auto-review-at-open plus human-posted mentions are acceptable.

## Common issues

**The caller can't find the reusable workflow** — check that your repo's (or org's)
Actions policy allows `noneedinmagic/awe`, and that the `uses:` line reads exactly
`noneedinmagic/awe/.github/workflows/orchestrator.yml@live`. GitHub never redirects
`uses:` references, so an old owner or repo name fails with `repository not found`.

**PR sits in `ai:reviewing` forever** — Codex never reviewed the current head SHA (see
items 2–3), or its review is for an older SHA (stale by design). Nudge with a manual
`@codex review`, or push a trivial commit. There is deliberately no polling/cron here.

**Codex is clean but the PR never reaches `ai:ready`** — the CI-completion edge is
missing: `check_suite` does **not** fire for Actions-created suites, so the caller's
`workflow_run.workflows` list must name the repo's real CI workflow(s). Any other PR
event (e.g. the next orchestrator run) also re-evaluates, so the state self-heals on the
next event either way.

**Gate check missing on the head SHA** — the orchestrator only runs on subscribed
events; re-run the last workflow run or push. Check runs are per-SHA, so a force-push
naturally clears them.

**A PR by another identity (cloud Claude/Codex, Cursor) isn't managed** — expected: only
`authors` from policy are automatic. Add the `ai:managed` label to opt it in.

**Fix job ran but nothing happened** — the "Determine fix outcome" step log shows
`Claude outcome=… execution_file=… remote=… pre=… → <outcome>`. Four outcomes:
`failed` (the run errored — `fixer-failed` handoff); `skipped` (`execution_file` empty —
`claude-code-action`'s own workflow-validation guard refused to run at all, because the
PR changes the workflow file the run itself came from; `fixer-skipped` handoff, only
recoverable via a comment-triggered `/ai retry`); `pushed`; or
`disputed` (it ran, reported success, pushed nothing). A `disputed` round is not
automatically a dispute: it's
classified by whether the round was dispatched purely by an open-thread block and
whether any such threads are still open now. Resolved-and-nothing-left-open re-queues
quietly (a blue informational ping, not a handoff); a thread still open is a definite
`agents-disagree`; anything the record can't confirm — real findings with nothing left
open, or the thread fetch itself failing — is the hedged `agents-may-disagree`.

**`/ai retry` on a `reviewer-sustained` handoff and nothing moves** — this is a
*review* result (a fresh review landed with `<!-- ai-orch:contested -->`), not a
`fixResult`, so it's a different classifier than the paragraph above: the reviewer
re-adjudicated a push-back against current code and didn't change its mind.
`/ai retry` treats that verdict as stale and requests a fresh review rather than
re-deriving the same handoff — if the thread genuinely wasn't touched, expect
one more fix round before the next review, not an immediate change.

**Everything must stop right now** — set `mode: disabled` in `.github/ai-policy.yml` on
the default branch (takes effect on the next event), or disable the caller workflow in
the consumer repo's Actions tab (immediate).

**Invalid policy** — the orchestrate job fails with the `ai-policy: …` validation error
in its log; no state is mutated.

<a name="the-workflow_call-schema-trap"></a>**A PR touching `orchestrator.yml` looks stuck
"fixing" with zero updates, every single run fails, and there's no error anywhere a human
would see it** — check the run logs for `startup_failure`, and check whether the PR
renames or removes a key under `workflow_call.secrets:` or `workflow_call.inputs:` in
`.github/workflows/orchestrator.yml` itself. If so, this is the **`workflow_call` schema
trap**, a structural consequence of the self-hosting design (see
[architecture.md](architecture.md#the-consumer-checkout-trap-solved)):

- The caller workflow (`templates/consumer-workflow.yml`, checked out on the PR's own
  branch) starts passing the *new* secret/input names the PR introduces.
- The reusable workflow it calls is pinned `uses: …/orchestrator.yml@live` — a literal
  that still points at the schema from the last time `live` moved, i.e. the *old* names.
- GitHub validates the caller's `secrets:`/`with:` block against that pinned `live`
  schema **before scheduling any job** — the mismatch is rejected at the platform level,
  so none of this repo's own code (orchestrate.js, the gate, the sticky comment) ever
  runs. Nothing posts a status, nothing logs an error inside the run; the sticky comment
  simply stops updating and the run shows `startup_failure` with no further detail.

**This cannot be fixed by pushing more commits to the same PR** — every commit hits the
identical mismatch against the still-unmoved `live`. The only resolution is: merge the PR
to `main` — `live` then moves automatically once CI on `main` goes green (a few minutes,
see the `retag` job in `ci.yml`; no manual retag step needed). Before merging,
double-check the *old* key names are still declared too if any consumer's caller template
might still reference them during that window (keep a deprecated key declared, marked as
such, until no caller passes it).

**`live` didn't move after a merge to `main`** — check the `retag` job on that commit's
CI run first: `needs: [test, actionlint]` means it never runs if either of those failed,
and its own guard silently no-ops (exit 0, no ref touched) if `main` moved again before
the job started — the log line says `stale re-run … not moving live` when that happens,
which is correct behavior, not a bug. If the job ran, is green, and `live` still didn't
move, check whether **Settings → Actions → General → Workflow permissions** regressed to
read-only (`gh api repos/noneedinmagic/awe/actions/permissions/workflow`
should show `"default_workflow_permissions":"write"`) — job-level `permissions:` can only
narrow that setting, never widen it, so a read-only default 403s the push. Once fixed,
run `scripts/retag-live.sh` by hand to move `live` immediately rather than waiting for
the next merge (see [rollout.md](rollout.md#why-live) for the rollback runbook if the
fleet needs recovery to an older state instead).
