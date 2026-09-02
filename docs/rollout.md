# Rollout

Roll one repository out first. One phase at a time; each phase has explicit
acceptance criteria and is reversible (`mode: dry-run` or `disabled` at any point).

## One-time central setup

1. Nothing to configure for access: this repo is public, so any repository may `uses:`
   its workflow and composite action. If the calling repo or organization restricts
   Actions to *selected* sources, allow `noneedinmagic/awe@*`. No token is needed:
   GitHub resolves cross-repo `uses:` references itself, which is exactly why the logic
   ships as an action instead of an `actions/checkout` of this repo (a called job's
   `GITHUB_TOKEN` is scoped to the calling repo).
2. Nothing to do for versions — `live` is a moving tag maintained automatically by
   `ci.yml`'s `retag` job on every merge to `main` (see [Why `live`](#why-live) below).
   Consumers pin `live`; it always resolves to the latest green `main`, and the reusable
   workflow's internal `actions/orchestrate@live` literal moves with it, so workflow and
   action refs never diverge. **Never create a GitHub Release on `live`** — GitHub's
   immutable-releases behavior would freeze the tag and permanently break the retag
   job's force-push.

## Why `live`

`live` is the only supported consumer pin. It is moved automatically — `scripts/retag-live.sh`,
called by the `retag` job in `ci.yml` — to every commit on `main` that passes CI. It never
means "a released, extra-vetted version": there is no soak between merge and tag move,
because nothing exercises `main` on its own (this repo dogfoods the external tag too), so
a lag would buy staleness, not evidence.

**Never pin a SHA or a point version.** `orchestrator.yml` references
`actions/orchestrate@live` as literals (`uses:` cannot take expressions), and those resolve
from wherever `live` currently points, *not* from the ref your caller pinned. A SHA-pinned
caller therefore runs an old workflow paired with a newer action the next time `live`
moves. Pin `live` and the two always travel together.

Breaking changes to the consumer contract (the caller's `uses:`/`secrets:`/`permissions:`/
`on:` shape in `templates/consumer-workflow.yml`, `schemas/ai-policy.schema.json`,
`templates/labels.json`, the `AI_ORCH_MAX_ROUNDS` variable name) land on every consumer
the moment `main` goes green, so they are made expand/contract: `live` tolerates the old
contract and the new one, consumers migrate, then the cleanup drops the old path. CI
emits a `::warning::` on any PR touching those files.

**Recovery from a bad `live`.** `scripts/retag-live.sh` also records every SHA `live` has
pointed at as an immutable `live-history/<n>` tag (`n` = commit count on `main`). Tier 1,
immediate: `git fetch --force --tags origin` (a plain fetch does not update a moved tag),
pick a good SHA from `git tag -l 'live-history/*' --sort=-creatordate`, then
`git push -f origin live-history/<n>:refs/tags/live` — valid only until the next merge to
`main`, which moves `live` forward again. Tier 2, durable: a revert PR on `main`; `live`
follows automatically. The script itself refuses to move `live` to anything but the
current tip of `main`, so a re-run of an old CI run can never move the fleet backward
silently; rollback is deliberately a manual act.

## Per-consumer bootstrap checklist

1. Copy `templates/consumer-workflow.yml` → `.github/workflows/ai-orchestrator.yml`.
2. Copy `templates/ai-policy.yml` → `.github/ai-policy.yml`; set `required_checks` to the
   repo's real check names; keep `mode: dry-run`.
3. Create labels from `templates/labels.json`
   (`gh label create -R <repo> "$name" --color ... --description ...`, or a one-off loop).
   Round labels are a fixed set (`ai:round-0` through `-4`, then `ai:round-5+`) — re-run
   this step on an already-bootstrapped repo after pulling a `templates/labels.json`
   update, or a PR reaching a round past what's already created throws (GitHub rejects
   the whole label-add request when any named label doesn't exist).
4. Add the `CLAUDE_CODE_OAUTH_TOKEN` secret; confirm the Claude GitHub App is installed.
5. With the `local-agent` reviewer backend (the template default), reviews come from the
   maintainer's host-side sweep: the repo must be on that sweep's explicit, fail-closed
   allow-list and have the reviewer Apps installed — a policy file alone is never enough,
   by design. Ask the maintainer to onboard it. Cloud Codex automatic reviews
   (chatgpt.com/codex/settings/code-review) are optional extra signal at PR-open only.
6. (Optional, needs GitHub Pro for private repos) branch protection: require the
   `AI Policy Gate` check. Without it the gate is advisory — fine while merges are manual.
   The gate's `success` conclusion means "clean review, green CI" only — it does not
   imply low risk (see [state-machine.md](state-machine.md)). Check the PR's `risk:*`
   label and 👤 Telegram glyph before merging on a green gate alone.

## Phases

### Phase 0 — dry run
No mutations beyond the sticky comment + neutral gate. **Done when:** 3 real PRs show
correct risk classification and correct "would do" narration; duplicate and stale events
visibly no-op; zero labels/comments/mentions posted.

### Phase 1 — review request + handoff (`mode: active`, fixer disabled)
Set `backends.fixer` unchanged but do not add the `CLAUDE_CODE_OAUTH_TOKEN` secret yet —
the fix job without its token fails fast into `fixer-failed` handoff, or simpler: keep
`max_rounds: 0` so every blocking review goes straight to handoff. Reviews arrive via
the local-agent sweep; the historical verification of the cloud-Codex mention path is
recorded in [troubleshooting](troubleshooting.md) (outcome: bots can never trigger it).
**Done when:** manual review requests are no longer needed; exactly one review per
(PR, SHA); handoff fires once.

### Phase 2 — Claude fix loop
`max_rounds: 2`, secret in place. **Done when:** a real finding is fixed and re-reviewed
with no human touch; a disputed-only round escalates to `agents-disagree`; all PRs still
human-merged.

### Phase 3 — readiness accuracy
Observe `ai:ready` accuracy on the AI axis (clean review, green CI — risk no longer
gates it). Measure: false
positives/negatives, loop counts, human interventions (the sticky comment history is
the raw data).

### Phase 4 — selective auto-merge (separate milestone)
Requires: explicit policy change (`merge.auto_merge: true`), branch protection with the
gate as a required check, **and auto-merge keyed on the human axis being clear (no
elevated risk, or an explicit override) — never on `ai:ready` alone**: a green gate does
not mean low risk, so gating auto-merge on it alone would let a PR that edited its own
leash under `.github/**` merge itself unreviewed. Sensitive paths stay human-required
forever.

### Fleet rollout
After Phase 2 is stable on the pilot: apply the bootstrap checklist to the remaining
repos, each starting at `dry-run`. No manual tagging step — `live` is already moving.
