# Architecture

Central, versioned control plane that automates the PR review funnel for agent-authored
pull requests across a fleet of repositories: Codex reviews, Claude responds/fixes, deterministic
policy decides, a human is pulled in only when a real decision is needed.

## Boundary contract

| Repository | Owns |
|---|---|
| **awe** (this repo) | workflow state, events, risk policy evaluation, checks, labels, review requests, handoff, merge eligibility |
| the maintainer's private companion | the host-side reviewer sweep and its prompts, plus the design records (ADRs) this documentation cites by number; it pins this repo at a submodule SHA |
| consumer repos | thin caller workflow, `.github/ai-policy.yml`, their own CI, per-repo secrets |

Consumers integrate through a reusable-workflow reference plus a versioned policy schema — no submodules on their side.

## Components

- **`.github/workflows/orchestrator.yml`** — reusable workflow with two jobs:
  - `orchestrate` (AI Orchestrator): runs `scripts/orchestrate.js` on every subscribed event;
  - `claude-fix` (AI Claude Fix): runs `anthropics/claude-code-action` when the
    orchestrator dispatched a fix round.
- **`scripts/orchestrate.js`** — entry point: resolves the event to a PR, gathers live
  data (PR, files, reviews, check runs), calls the pure reducer, executes effects.
- **`scripts/lib/state.js#reduce`** — the transition brain: a pure, idempotent function
  from `(previous state + gathered inputs)` to `(next state + effects)`. All decision
  logic is testable without GitHub.
- **`scripts/lib/policy.js` / `risk.js` / `inspect-review.js` / `gate.js`** — policy
  parsing, deterministic risk classification, Codex review interpretation, gate mapping.

## The consumer-checkout trap, solved

A reusable workflow's `actions/checkout` checks out the **consumer** repo — and an
explicit checkout of *this* repo would need a token, because a called job's
`GITHUB_TOKEN` is scoped to the calling repo only. Central logic therefore ships as the
`actions/orchestrate` **composite action**: cross-repo `uses:` references to a public
repo are resolved by GitHub itself, tarball included, no checkout and no token. The workflow's internal `…/actions/orchestrate@live` refs are
literals (`uses:` cannot take expressions); `live` moves automatically to every green
`main` (`scripts/retag-live.sh`, run by `ci.yml`'s retag job — see
[rollout.md](rollout.md#why-live)) and carries workflow and action refs
together, so consumers pinning `live` can never see them diverge.

The same tag-pinning that makes this safe has one sharp edge: a PR that changes the
*schema* `live` itself declares — a `workflow_call.secrets`/`inputs` key renamed or removed
in `orchestrator.yml` — can't validate on its own branch. The caller (on the PR's branch)
starts passing the new key names, but the currently-tagged `live` reusable workflow still
declares the old ones; GitHub's own workflow-schema validation rejects the mismatch
**before any job starts**, so this repo's error handling never runs and nothing posts a
gate — the PR just looks silently stuck. Expected and recognizable, not a bug: see
[troubleshooting.md](troubleshooting.md#the-workflow_call-schema-trap) for the fix.

## Durable state

One sticky PR comment carries a hidden marker:

```
<!-- ai-orch:state
{ "v": 1, "pr": …, "state": "ai:reviewing", "head_sha": "…", "round": 1, … }
-->
```

followed by the human-readable status table. Machine state and presentation live in the
same object but only the JSON is ever read back. Labels mirror state for humans and are
**never** read as truth (they can race; the comment is mutated only inside the per-PR
concurrency group). The **AI Policy Gate** is an API-created check run per head SHA —
checks being SHA-keyed gives stale-review safety for free.

## Identities

- The `orchestrate` job acts as `github-actions[bot]` through `GITHUB_TOKEN` — comments,
  labels, checks, review requests. `GITHUB_TOKEN` events never retrigger workflows, so
  there is no self-recursion.
- Reviews arrive from whichever reviewer identities the consumer's policy names
  (`reviewers.actors`): the maintainer's host-side local-agent sweep, or cloud Codex
  (`chatgpt-codex-connector[bot]`) where a human posts the mention.
- The `claude-fix` job acts as `claude[bot]` through `claude-code-action`'s OIDC
  exchange; its push retriggers `pull_request:synchronize`, which **is** the loop edge —
  no dispatch plumbing. Humans from policy make the merge decisions.

Reviewer App private keys never enter GitHub Actions; the fix job uses the Claude app
plus the consumer's own OAuth token only.

## Why plain JavaScript

Node ≥ 20 (CI tests 24), ESM, no build/packaging step, one vendored dependency (`js-yaml`,
committed via `node_modules/` so the workflow does no `npm ci` at run time). JSDoc plus
`node --test` cover the safety needs of glue logic; TypeScript would add a compile
pipeline for no behavioral gain here.

To refresh the vendored tree after bumping `package.json`/`package-lock.json` (including a
Dependabot PR): run `npm ci` and commit the resulting `node_modules/` changes in the same
PR — `ci.yml`'s `npm ci` + `git status --porcelain` step fails the build if the committed
tree and lockfile disagree.
