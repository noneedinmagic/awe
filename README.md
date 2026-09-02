# A.W.E. — Agentic Workflows Engine

Reusable GitHub Actions PR orchestrator for agent-authored pull requests. Consumer
repositories install a ~15-line caller workflow; everything else runs from here, pinned
to the moving `live` tag. The funnel it automates: *an agent opens a PR → a reviewer
reviews → Claude validates and fixes or disputes → re-review → deterministic policy gate →
a human only when a real decision is needed*.

This is the public half of a two-repo system. The private companion holds the
maintainer's host-side reviewer sweep, its prompts, and the design records (ADRs) that
this documentation cites by number; it pins this repo at a submodule SHA.

## How it works (one paragraph)

On every PR event the caller invokes [`orchestrator.yml`](.github/workflows/orchestrator.yml),
which runs a pure, tested state machine on the consumer's runner: risk is classified
deterministically from the diff against the repo's `.github/ai-policy.yml` (read from the
base branch), a review is requested exactly once per head SHA, blocking findings dispatch a
Claude fix round (max 2 by default), and anything ambiguous hands off to a human once — with
a review request and a precise explanation in the sticky status comment every managed PR
carries. The **AI Policy Gate** check reflects the machine's verdict; agents produce
evidence, never the verdict itself.

## Adding a repository

Follow [docs/rollout.md](docs/rollout.md). Short version: copy
[`templates/consumer-workflow.yml`](templates/consumer-workflow.yml) to
`.github/workflows/ai-orchestrator.yml`, copy [`templates/ai-policy.yml`](templates/ai-policy.yml)
to `.github/ai-policy.yml`, create the labels in [`templates/labels.json`](templates/labels.json),
add the `CLAUDE_CODE_OAUTH_TOKEN` secret, start in `mode: dry-run`. The one line that ties
you to this repo:

```yaml
uses: noneedinmagic/awe/.github/workflows/orchestrator.yml@live
```

Pin `live` — never a SHA or a point version; [docs/rollout.md](docs/rollout.md#why-live)
explains why that is the only safe pin here.

Using this engine only affects your own repository: every API call targets the calling
repo, every secret is yours, and minutes bill to you. Nothing here contacts the
maintainer's infrastructure ([docs/security.md](docs/security.md)).

## Repository map

```
.github/workflows/orchestrator.yml   reusable workflow (orchestrate + claude-fix jobs)
actions/orchestrate/action.yml       composite action the workflow runs its logic through
scripts/orchestrate.js               event entry point
scripts/lib/                         policy / risk / state reducer / review parser / gate
scripts/claude-fix-prompt.md         review-response prompt for the hosted Claude fixer
scripts/retag-live.sh                moves `live` to every green main (ci.yml's retag job)
schemas/ai-policy.schema.json        policy schema (v1)
templates/                           consumer caller, policy template, label set
docs/                                architecture, state machine, policy, human controls,
                                     rollout, security, troubleshooting, /ai command reference
tests/                               node:test unit + transition tests, event fixtures
```

## Development

```bash
npm test          # node --test, no framework
actionlint        # workflow lint (see ci.yml for the pinned invocation)
```

`node_modules/` is committed on purpose (single vendored dependency, `js-yaml`) so the
reusable workflow runs with zero install steps; after bumping the dependency run `npm ci`
and commit the result — CI fails on drift.

This repository never registers a self-hosted runner. Fork pull requests are never
enrolled by the orchestrator.

## Design docs

Start with [docs/architecture.md](docs/architecture.md) and
[docs/state-machine.md](docs/state-machine.md). Vocabulary: [CONTEXT.md](CONTEXT.md).
Security posture: [docs/security.md](docs/security.md). Human control from anywhere:
[docs/human-controls.md](docs/human-controls.md).

## License

Copyright (c) 2026, all rights reserved — see [LICENSE](LICENSE). Published for
transparency and for use by the author's own organizations through GitHub Actions; ask
before any other use.
