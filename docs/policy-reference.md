# Policy reference — `.github/ai-policy.yml`

Schema: [`schemas/ai-policy.schema.json`](../schemas/ai-policy.schema.json); template:
[`templates/ai-policy.yml`](../templates/ai-policy.yml). Runtime validation is in
`scripts/lib/policy.js` — an invalid policy fails the orchestrator run visibly rather
than guessing.

The policy is always read from the **base branch** of the PR being processed. A PR can
never alter the policy it is judged by; policy changes take effect only after they merge.

| Key | Default | Meaning |
|---|---|---|
| `version` | — (required) | schema version; must be `1` |
| `mode` | `dry-run` | `dry-run` = classify + narrate only; `active` = full orchestration; `disabled` = repo unmanaged |
| `max_rounds` | `2` | automatic fix/re-review rounds before human handoff. Three-layer precedence, most specific wins: a per-PR `/ai round-cap <n>` override (see [ai-command.md](ai-command.md); stored in the sticky comment, survives retries/pushes/new heads until changed again) beats the repo-wide `AI_ORCH_MAX_ROUNDS` Variable (Settings → Secrets and variables → Actions → Variables — a plain, non-secret value, not forwarded through the caller like secrets are, since GitHub resolves `vars.*` against the calling repo automatically inside the reusable workflow) beats this field. A set-but-malformed `AI_ORCH_MAX_ROUNDS` fails the run loudly rather than being silently ignored. |
| `ci_failure_threshold` | `2` | consecutive red-CI cycles (counted once per SHA) before handoff |
| `echo_frequency` | `100` | timeline items between automatic status echoes — a disposable copy of the sticky comment posted at the bottom of the thread, since the sticky comment itself updates in place and gets buried on a busy PR. `0` or `null` disables the automatic trigger; `/ai status` always echoes regardless. See [ai-command.md](ai-command.md) |
| `authors` | — (required) | exact GitHub logins whose PRs are auto-managed (typically the GitHub Apps your agents author PRs as; all entries are equal peers) |
| `humans` | — (required) | humans who receive review requests and may opt PRs in; extensible list |
| `manual_optin.label` | `ai:managed` | label a human adds to enroll a non-allowlisted PR (cloud Claude/Codex, Cursor, yourself) |
| `reviewers.codex_actor` | `chatgpt-codex-connector[bot]` | exact reviewer bot login — never a broad `type == Bot` test |
| `reviewers.actors` | `[codex_actor]` | ordered reviewer identities; cross-vendor selection picks the first whose vendor (see `reviewers.vendors`) differs from the PR author's. **Required** when `backends.reviewer` includes `local-agent` — the `codex_actor` fallback is always a cloud-Codex identity, which a local-agent sweep never runs as |
| `reviewers.vendors` | cloud-only: `{claude: [claude[bot]], codex: [chatgpt-codex-connector[bot]]}` | vendor-family membership for `reviewers.actors`/`reviewers.codex_actor` — no fleet-specific identity is hardcoded here (#290). **Required** when `backends.reviewer` includes `local-agent`, so every configured actor resolves to a vendor. Also feeds `claude-fix`'s `allowed_bots` input automatically (every actor and vendor login, `[bot]` suffix stripped, plus `github-actions`) — a consumer never configures `allowed_bots` directly |
| `reviewers.dedup_resolved_threads` | `true` | local-agent sweep only: deterministic gate — suppress a fresh finding matching this actor's own prior thread; reopen (with a reply) an agent-only-resolved one whose finding re-detects |
| `reviewers.inject_review_history` | `true` | local-agent sweep only: soft prompt hint listing this actor's own prior threads, alongside the gate above |
| `reviewers.dedup_proximity_lines` | `5` | line-number tolerance when matching a fresh finding to a prior thread on the same file |
| `reviewers.thread_authority` | `fixer` | local-agent sweep only: who resolves a review thread — `fixer` (today's behavior), `adjudicate` (fixer still resolves; the sweep re-adjudicates threads it pushed back on instead of blindly re-raising), `reviewer` (fixer never resolves; only the sweep does, always after re-verifying). Requires `backends.reviewer` to include `local-agent` when not `fixer`. Policy-file only — unlike `max_rounds`, there is no `AI_ORCH_*` repository-Variable override (ADR 0005) |
| `backends.reviewer` | `[codex]` | ordered adapter chain (future fallback slots) |
| `backends.fixer` | `[claude-code-action]` | ordered adapter chain; `local-worker` reserved for a future host-side backend |
| `risk.human_required_paths` | template list | gitignore-style globs that force high risk + human review |
| `risk.max_files_changed` / `max_lines_added` / `max_lines_deleted` | 25 / 600 / 400 | size limits; exceeding bumps risk to medium |
| `risk.dependency_changes` | `human` | how manifest/lockfile edits are classified (`human` also forces human review) |
| `risk.overrides` | `[]` | `{paths, risk}` pairs; may raise or lower level but can never clear a human requirement |
| `required_checks` | `[]` | exact names or `/regex/`; empty = every non-orchestrator check on the head SHA. **If the repo has CI, list it explicitly** — that also guards the window before CI starts |
| `label_names` | `{}` | state → display-label mapping; add emoji/colors freely, execution is unaffected |
| `merge.auto_merge` | `false` | keep `false` until the Phase 4 milestone |
| `merge.method` | `merge` | merge method if auto-merge is ever enabled — project preference is fast-forward or an ordinary merge commit, never squash/rebase |
| `notifications.telegram.enabled` | `false` | message on `ai:needs-human` and `ai:ready` (see [human-controls.md](human-controls.md)), requires `AI_ORCH_TELEGRAM_BOT_TOKEN`/`AI_ORCH_TELEGRAM_CHAT_ID` secrets |

Every gate run also checks the policy itself for two common mistakes and adds an
advisory (non-blocking) warning to the gate output when found: a `risk.human_required_paths`
glob matching zero tracked files on the base ref, or `required_checks: []` sitting beside
a real CI workflow that could be gating PRs (see [`scripts/lib/risk.js`](../scripts/lib/risk.js)'s
`unmatchedGlobs`/`hasUngatedCi`).

Each `risk.*` cause above also earns a `human:<cause>` label (`human:configured-path`,
`human:size`, `human:deps`, `human:protected-path`) whenever the final level isn't
`low` — a PR can carry several at once. See `classifyRisk`'s `causes` in
[`scripts/lib/risk.js`](../scripts/lib/risk.js). CI's own conclusion gets the same
treatment as its own `ci:green`/`ci:red`/`ci:pending` label, independent of `ai:ready`
(ADR 0012).

## Hard invariants (not configurable)

- Any PR touching `.github/**` (which includes this policy file and all workflows) is
  human-required regardless of policy content: a formal GitHub review is requested from
  `humans`, `risk:high` is labeled, and the Telegram ping's 👤 glyph reads red — but
  (ADR 0012) this does not keep the AI
  Policy Gate itself red. A clean review + green CI on such a PR reaches `ai:ready`
  (gate `success`) same as any other; "human-required" is a review-and-signal guarantee,
  not a gate-blocking one. Nothing merges automatically either way — `merge.auto_merge`
  stays `false`.
- `dry-run` restricts the orchestrator to the sticky comment plus a `neutral` gate check.
- Agents never set the gate; `scripts/lib/gate.js` maps recorded state deterministically.
- A human-summoned `@codex review` / `@claude review` with open findings on the current
  head always blocks a clean verdict and invalidates a stale `ai:ready`, regardless of
  `backends.reviewer` — not a policy toggle, since the incidents motivating this
  happened under the shipped default and a default-off flag would leave every consumer
  repo exposed until it opted in (ADR 0007).
