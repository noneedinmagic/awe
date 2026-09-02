# Security

## Threat model & mitigations

| Threat | Mitigation |
|---|---|
| Untrusted fork code reaching secrets | plain `pull_request` events only (never `pull_request_target`); fork PRs are `unmanaged` by guard; fork contexts get no secrets anyway |
| An agent changing policy/workflows and benefiting in the same PR | policy is read from the **base ref**; `.github/**` changes are human-required by hard-coded invariant; the fix prompt forbids Claude from touching `.github/**`, workflows, or CI config |
| Agents declaring themselves mergeable | agents only produce evidence (reviews, pushes); `gate.js` maps recorded state to the check deterministically; nothing an agent writes is executed as policy |
| Spoofed reviewer | the Codex actor is matched by **exact login** from policy (`chatgpt-codex-connector[bot]`), never `user.type == Bot` |
| Stale approvals/reviews | every result is keyed to the head SHA it was produced for; the gate check run is itself SHA-keyed |
| Event races / duplicate deliveries | per-PR concurrency group (queued, not cancelled) + pure idempotent reducer; replays are no-ops |
| Infinite loops | `max_rounds` (default 2), `ci_failure_threshold`, single-shot handoff flag, job `timeout-minutes` on both jobs |
| Notification spam | handoff fires once per episode; Telegram (if enabled) sends one message per handoff, not per event |
| Maintainer-host exposure | this repo is public and never registers a self-hosted runner; consumers route jobs to their own runners only through the `runs-on`/`fix-runs-on` inputs; reviewer App keys never enter Actions; the hosted fix job uses the Claude app + per-repo OAuth token only |
| Outsiders trying to reach the maintainer's local reviewers by using this engine or installing the public reviewer Apps on their own repos | the engine never contacts the maintainer's infrastructure — every API call targets the calling repo and every secret is the caller's; the maintainer's local reviewers act only on an explicit, fail-closed repo allow-list kept outside any consumer repo, so a stranger's repo is never cloned or reviewed |
| Third-party action tampering | all third-party actions pinned to full commit SHAs; Dependabot proposes updates as reviewable PRs |

## Deliberate non-capabilities

- The orchestrator cannot merge (no auto-merge in the pilot, and the gate summary says a
  human merge is required even on success).
- The orchestrator never force-pushes, closes PRs, or edits code itself; only the fix
  job's Claude session writes code, on the PR branch, as `claude[bot]`.
- `GITHUB_TOKEN` in the orchestrate job has `contents: read` — it cannot push.

## Label-based opt-in trust

`ai:managed` can only be added by users with triage permission on the repo — for a
personal repo that is the owner. If collaborators are added, remember that granting
triage also grants the ability to enroll PRs into automation; fork PRs are never
enrolled, label or not.

## Manual override

Everything the orchestrator does is reversible by a human at any time: remove the label,
dismiss the review request, push to the branch (resets the episode), or set
`mode: disabled` on the base branch to stop the machine repo-wide.
