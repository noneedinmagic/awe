import { load } from 'js-yaml';

export class PolicyError extends Error {}

export const POLICY_PATH = '.github/ai-policy.yml';

// Invariants enforced in code, not configurable: an agent must never be able to
// change orchestration/workflow/policy files and benefit from it in the same PR.
export const BUILTIN_HUMAN_PATHS = ['.github/**'];

export const DEPENDENCY_MANIFESTS = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'pyproject.toml', 'poetry.lock', 'uv.lock', 'requirements*.txt',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
  'Gemfile', 'Gemfile.lock', 'composer.json', 'composer.lock',
];

const MODES = ['dry-run', 'active', 'disabled'];
const RISK_LEVELS = ['low', 'medium', 'high'];
const REVIEWER_BACKENDS = ['codex', 'local-agent'];
const FIXER_BACKENDS = ['claude-code-action', 'local-worker'];
// Who may resolve a review thread — see docs/adr/0005-reviewer-owns-thread-lifecycle.md.
// 'fixer': today's behavior, the fixer resolves what it addressed/answered. 'adjudicate':
// the fixer still resolves, but the reviewer sweep re-adjudicates any thread it pushed
// back on (withdraw/sustain/ask) instead of leaving it to a blind next-tick re-raise.
// 'reviewer': the fixer never resolves; only the reviewer sweep resolves, always after
// re-verifying. A fourth combination (reviewer resolves, nobody adjudicates disputes) is
// deliberately unrepresentable — it would leave every dispute burning fix rounds to the
// cap with the reviewer having nothing new to say.
const THREAD_AUTHORITIES = ['fixer', 'adjudicate', 'reviewer'];

// #290: no fleet identity is hardcoded here — a consumer with its own reviewer bots
// gets this cloud-only map unless it configures `reviewers.vendors` itself, which
// `local-agent` policies are required to do below.
const CLOUD_ONLY_VENDORS = {
  claude: ['claude[bot]'],
  codex: ['chatgpt-codex-connector[bot]'],
};

const DEFAULTS = {
  mode: 'dry-run',
  max_rounds: 2,
  ci_failure_threshold: 2,
  echo_frequency: 100,
  manual_optin: { label: 'ai:managed' },
  reviewers: {
    codex_actor: 'chatgpt-codex-connector[bot]',
    // The local sweep is stateless (diff-only per run) and used to re-file the same
    // finding as a new thread on every head, even after a human resolved it (observed
    // live: the same finding four times on one file). Both default on: the gate is the guarantee, the prompt
    // hint is a cheap reduction in wasted CLI cycles — see the companion review sweep's
    // classifyFindings/formatReviewHistory.
    dedup_resolved_threads: true,
    inject_review_history: true,
    dedup_proximity_lines: 5,
    // Defaults to the pre-existing behavior everywhere: merging this feature changes
    // nothing until a repo opts in. See THREAD_AUTHORITIES above.
    thread_authority: 'fixer',
  },
  backends: { reviewer: ['codex'], fixer: ['claude-code-action'] },
  risk: {
    human_required_paths: [],
    max_files_changed: 25,
    max_lines_added: 600,
    max_lines_deleted: 400,
    dependency_changes: 'human',
    overrides: [],
  },
  required_checks: [],
  label_names: {},
  merge: { auto_merge: false, method: 'merge' },
  notifications: { telegram: { enabled: false } },
  // LAW2 `refine` (the private companion's pre-PR loop) — optional, this repo-level section
  // is untouched by the PR-time orchestrator above. Empty `gates` means auto-detect from
  // package.json scripts (lint/test/build) rather than a fixed list. `notify` gates a
  // Telegram ping on a terminal round reaching cap-reached or converged-with-a-dispute —
  // deliberately separate from `notifications.telegram.enabled` above, which is the
  // GitHub-side PR-time gate; refine never touches GitHub, so it gets its own opt-in here.
  prepr: {
    max_rounds: 3, reviewers: ['claude', 'codex'], gates: [], notify: false,
  },
};

const PREPR_REVIEWER_VENDORS = ['claude', 'codex'];

function fail(msg) {
  throw new PolicyError(`ai-policy: ${msg}`);
}

function requireStringArray(value, name, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) {
    fail(`\`${name}\` must be an array of non-empty strings`);
  }
  if (nonEmpty && value.length === 0) fail(`\`${name}\` must not be empty`);
  return value;
}

// Mirrors orchestrate.js's matchPattern slash-delimited detection exactly (start/end
// slash, length > 2) — an uncompilable `/regex/` entry there currently throws deep
// inside computeCiStatus on every future orchestration event, turning one config typo
// into a repository-wide failing gate. Reject it here instead, at parse time, with a
// clear message (codex review round 4 finding on #1).
function validateRequiredChecks(patterns) {
  for (const p of patterns) {
    if (p.startsWith('/') && p.endsWith('/') && p.length > 2) {
      try {
        RegExp(p.slice(1, -1));
      } catch (err) {
        fail(`\`required_checks\` entry ${JSON.stringify(p)} is not a valid regex: ${err.message}`);
      }
    }
  }
  return patterns;
}

function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) fail(`\`${name}\` must be a non-negative integer`);
  return value;
}

// Like positiveInt, but an explicit `null` is a valid third state ("disabled"), distinct
// from `undefined` ("use the default"). `0` means the same thing as `null` (see
// echoEnabled) and is normalized to it here, so callers only ever see one "disabled" value.
function positiveIntOrNull(value, name, fallback) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) fail(`\`${name}\` must be a non-negative integer or null`);
  return value === 0 ? null : value;
}

function bool(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`\`${name}\` must be a boolean`);
  return value;
}

// Mirrors schemas/ai-policy.schema.json's `additionalProperties: false` at runtime —
// a typo like `required_check` must fail loudly, not silently fall back to a default
// that leaves a safety gate unconfigured.
function rejectUnknownKeys(obj, allowed, name) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`unknown key \`${key}\` in \`${name}\` (known: ${allowed.join(', ')})`);
  }
}

/** Parse and validate .github/ai-policy.yml text into a normalized policy object. */
export function parsePolicy(yamlText) {
  let raw;
  try {
    raw = load(yamlText);
  } catch (err) {
    fail(`invalid YAML — ${err.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('document must be a mapping');

  rejectUnknownKeys(raw, [
    'version', 'mode', 'max_rounds', 'ci_failure_threshold', 'echo_frequency', 'authors', 'humans',
    'manual_optin', 'reviewers', 'backends', 'risk', 'required_checks', 'label_names',
    'merge', 'notifications', 'prepr',
  ], 'root');
  rejectUnknownKeys(raw.manual_optin, ['label'], 'manual_optin');
  rejectUnknownKeys(raw.reviewers, [
    'codex_actor', 'actors', 'vendors',
    'dedup_resolved_threads', 'inject_review_history', 'dedup_proximity_lines',
    'thread_authority',
  ], 'reviewers');
  rejectUnknownKeys(raw.reviewers?.vendors, ['claude', 'codex'], 'reviewers.vendors');
  rejectUnknownKeys(raw.backends, ['reviewer', 'fixer'], 'backends');
  rejectUnknownKeys(raw.risk, [
    'human_required_paths', 'max_files_changed', 'max_lines_added', 'max_lines_deleted',
    'dependency_changes', 'overrides',
  ], 'risk');
  if (Array.isArray(raw.risk?.overrides)) {
    for (const o of raw.risk.overrides) rejectUnknownKeys(o, ['paths', 'risk'], 'risk.overrides[]');
  }
  rejectUnknownKeys(raw.merge, ['auto_merge', 'method'], 'merge');
  rejectUnknownKeys(raw.notifications, ['telegram'], 'notifications');
  rejectUnknownKeys(raw.notifications?.telegram, ['enabled'], 'notifications.telegram');
  // label_names is an intentionally open-ended state → display-label mapping.
  rejectUnknownKeys(raw.prepr, ['max_rounds', 'reviewers', 'gates', 'notify'], 'prepr');
  if (Array.isArray(raw.prepr?.gates)) {
    for (const g of raw.prepr.gates) rejectUnknownKeys(g, ['name', 'cmd', 'timeout_s'], 'prepr.gates[]');
  }

  if (raw.version !== 1) fail(`unsupported \`version\` ${JSON.stringify(raw.version)} (expected 1)`);

  const mode = raw.mode ?? DEFAULTS.mode;
  if (!MODES.includes(mode)) fail(`\`mode\` must be one of ${MODES.join(', ')}`);

  const authors = requireStringArray(raw.authors, 'authors', { nonEmpty: true });
  const humans = requireStringArray(raw.humans, 'humans', { nonEmpty: true });

  const codexActor = raw.reviewers?.codex_actor ?? DEFAULTS.reviewers.codex_actor;
  if (typeof codexActor !== 'string' || !codexActor) fail('`reviewers.codex_actor` must be a non-empty string');

  // Ordered reviewer identities; `codex_actor` remains the single-entry fallback so
  // pre-existing policies keep parsing unchanged.
  const reviewerActors = raw.reviewers?.actors
    ? requireStringArray(raw.reviewers.actors, 'reviewers.actors', { nonEmpty: true })
    : [codexActor];
  // #290: `reviewers.vendors` has no fleet-specific default — a `local-agent` backend
  // must configure its own reviewer identities explicitly (every consumer's policy
  // already does; verified across the fleet 2026-09-02) rather than silently
  // inheriting some other repo's bots. Checked against the raw, not-yet-validated
  // `backends.reviewer` since the full `backends` object isn't built until below.
  const rawBackendsReviewer = raw.backends?.reviewer ?? DEFAULTS.backends.reviewer;
  const usesLocalAgentReviewer = Array.isArray(rawBackendsReviewer) && rawBackendsReviewer.includes('local-agent');
  if (usesLocalAgentReviewer && !raw.reviewers?.vendors) {
    fail('`reviewers.vendors` is required when `backends.reviewer` includes `local-agent`');
  }
  const vendors = {
    claude: raw.reviewers?.vendors?.claude
      ? requireStringArray(raw.reviewers.vendors.claude, 'reviewers.vendors.claude')
      : CLOUD_ONLY_VENDORS.claude,
    codex: raw.reviewers?.vendors?.codex
      ? requireStringArray(raw.reviewers.vendors.codex, 'reviewers.vendors.codex')
      : CLOUD_ONLY_VENDORS.codex,
  };

  const dedupResolvedThreads = bool(raw.reviewers?.dedup_resolved_threads, 'reviewers.dedup_resolved_threads', DEFAULTS.reviewers.dedup_resolved_threads);
  const injectReviewHistory = bool(raw.reviewers?.inject_review_history, 'reviewers.inject_review_history', DEFAULTS.reviewers.inject_review_history);
  const dedupProximityLines = positiveInt(raw.reviewers?.dedup_proximity_lines, 'reviewers.dedup_proximity_lines', DEFAULTS.reviewers.dedup_proximity_lines);
  const threadAuthority = raw.reviewers?.thread_authority ?? DEFAULTS.reviewers.thread_authority;
  if (!THREAD_AUTHORITIES.includes(threadAuthority)) {
    fail(`\`reviewers.thread_authority\` must be one of ${THREAD_AUTHORITIES.join(', ')}`);
  }

  const backends = {
    reviewer: raw.backends?.reviewer ?? DEFAULTS.backends.reviewer,
    fixer: raw.backends?.fixer ?? DEFAULTS.backends.fixer,
  };
  requireStringArray(backends.reviewer, 'backends.reviewer', { nonEmpty: true });
  requireStringArray(backends.fixer, 'backends.fixer', { nonEmpty: true });
  for (const b of backends.reviewer) if (!REVIEWER_BACKENDS.includes(b)) fail(`unknown reviewer backend \`${b}\``);
  for (const b of backends.fixer) if (!FIXER_BACKENDS.includes(b)) fail(`unknown fixer backend \`${b}\``);
  // The `codex_actor` fallback for `reviewers.actors` is always a cloud-Codex identity
  // (chatgpt-codex-connector[bot] by default), which a local-agent sweep never runs as —
  // a local-agent policy that relies on the fallback leaves `needsReview` rejecting every
  // PR as "wrong reviewer" forever. Fail loudly instead of leaving that gate silently stuck.
  if (backends.reviewer.includes('local-agent') && !raw.reviewers?.actors) {
    fail('`reviewers.actors` is required when `backends.reviewer` includes `local-agent`');
  }
  // Both non-default tiers depend on the sweep re-verifying/adjudicating — cloud codex
  // can't be summoned by a bot to do that (see the companion review sweep's header) and a pure-codex
  // policy has no sweep tick at all. Fail at parse time rather than silently leaving every
  // pushed-back thread with no resolver.
  if (threadAuthority !== 'fixer' && !backends.reviewer.includes('local-agent')) {
    fail('`reviewers.thread_authority` other than `fixer` requires `backends.reviewer` to include `local-agent`');
  }
  // desiredReviewer() treats an actor with no vendor entry as "unknown", which falls
  // back to reviewerActors[0]. If that first actor is itself the unmapped one and also
  // the PR's author, desiredReviewer(author) returns the author, and needsReview()'s
  // self-review guard then rejects every sweep forever — the PR sits in `ai:reviewing`
  // with no error, no reviewer, and no human signal. Fail at parse time instead.
  if (backends.reviewer.includes('local-agent')) {
    for (const actor of reviewerActors) {
      if (!vendors.claude.includes(actor) && !vendors.codex.includes(actor)) {
        fail(`\`reviewers.actors\` entry \`${actor}\` has no vendor in \`reviewers.vendors\` (claude/codex) — add it or desiredReviewer() cannot cross-vendor-select it`);
      }
    }
  }

  const riskRaw = raw.risk ?? {};
  const overrides = riskRaw.overrides ?? DEFAULTS.risk.overrides;
  if (!Array.isArray(overrides)) fail('`risk.overrides` must be an array');
  for (const o of overrides) {
    requireStringArray(o?.paths, 'risk.overrides[].paths', { nonEmpty: true });
    if (!RISK_LEVELS.includes(o?.risk)) fail(`\`risk.overrides[].risk\` must be one of ${RISK_LEVELS.join(', ')}`);
  }
  const dependencyChanges = riskRaw.dependency_changes ?? DEFAULTS.risk.dependency_changes;
  if (!['human', ...RISK_LEVELS].includes(dependencyChanges)) {
    fail('`risk.dependency_changes` must be human, low, medium, or high');
  }

  const labelNames = raw.label_names ?? DEFAULTS.label_names;
  if (labelNames === null || typeof labelNames !== 'object' || Array.isArray(labelNames)) {
    fail('`label_names` must be a mapping of state → display label');
  }
  // An unusable remap (empty string, non-string) reaches desiredLabels()'s `name(key) ??
  // key` fallback unchanged (it only substitutes on null/undefined, not on ''), so a
  // required state label like `ai:fixing` would POST as an invalid GitHub label name —
  // AFTER the sticky comment already recorded that state, stranding the PR with no
  // fixer ever dispatched (round 3 finding on #1). Reject at parse time instead.
  for (const [key, value] of Object.entries(labelNames)) {
    if (typeof value !== 'string' || !value.trim()) fail(`\`label_names.${key}\` must be a non-empty string`);
  }

  const prepr = {
    maxRounds: positiveInt(raw.prepr?.max_rounds, 'prepr.max_rounds', DEFAULTS.prepr.max_rounds),
    reviewers: raw.prepr?.reviewers
      ? requireStringArray(raw.prepr.reviewers, 'prepr.reviewers', { nonEmpty: true })
      : DEFAULTS.prepr.reviewers,
    // Empty means "auto-detect from package.json scripts" (see the companion's refine docs) —
    // not validated here, that's refine.js's job (it needs the repo checkout to detect).
    gates: (raw.prepr?.gates ?? DEFAULTS.prepr.gates).map((g, i) => {
      if (typeof g?.name !== 'string' || !g.name) fail(`\`prepr.gates[${i}].name\` must be a non-empty string`);
      if (typeof g?.cmd !== 'string' || !g.cmd) fail(`\`prepr.gates[${i}].cmd\` must be a non-empty string`);
      return { name: g.name, cmd: g.cmd, timeoutS: positiveInt(g.timeout_s, `prepr.gates[${i}].timeout_s`, 300) };
    }),
    notify: bool(raw.prepr?.notify, 'prepr.notify', DEFAULTS.prepr.notify),
  };
  for (const v of prepr.reviewers) {
    if (!PREPR_REVIEWER_VENDORS.includes(v)) fail(`\`prepr.reviewers\` entries must be one of ${PREPR_REVIEWER_VENDORS.join(', ')}`);
  }

  return {
    version: 1,
    mode,
    maxRounds: positiveInt(raw.max_rounds, 'max_rounds', DEFAULTS.max_rounds),
    ciFailureThreshold: positiveInt(raw.ci_failure_threshold, 'ci_failure_threshold', DEFAULTS.ci_failure_threshold),
    // Timeline items between automatic status echoes (see docs/ai-command.md); `null` or
    // `0` disables the automatic trigger — `/ai status` still always echoes.
    echoFrequency: positiveIntOrNull(raw.echo_frequency, 'echo_frequency', DEFAULTS.echo_frequency),
    authors,
    humans,
    manualOptinLabel: raw.manual_optin?.label ?? DEFAULTS.manual_optin.label,
    codexActor,
    reviewerActors,
    reviewerVendors: vendors,
    dedupResolvedThreads,
    injectReviewHistory,
    dedupProximityLines,
    threadAuthority,
    backends,
    risk: {
      humanRequiredPaths: riskRaw.human_required_paths
        ? requireStringArray(riskRaw.human_required_paths, 'risk.human_required_paths')
        : DEFAULTS.risk.human_required_paths,
      maxFilesChanged: positiveInt(riskRaw.max_files_changed, 'risk.max_files_changed', DEFAULTS.risk.max_files_changed),
      maxLinesAdded: positiveInt(riskRaw.max_lines_added, 'risk.max_lines_added', DEFAULTS.risk.max_lines_added),
      maxLinesDeleted: positiveInt(riskRaw.max_lines_deleted, 'risk.max_lines_deleted', DEFAULTS.risk.max_lines_deleted),
      dependencyChanges,
      overrides,
    },
    requiredChecks: raw.required_checks
      ? validateRequiredChecks(requireStringArray(raw.required_checks, 'required_checks'))
      : DEFAULTS.required_checks,
    labelNames,
    merge: {
      autoMerge: raw.merge?.auto_merge ?? DEFAULTS.merge.auto_merge,
      method: raw.merge?.method ?? DEFAULTS.merge.method,
    },
    notifications: {
      telegram: {
        enabled: bool(raw.notifications?.telegram?.enabled, 'notifications.telegram.enabled', DEFAULTS.notifications.telegram.enabled),
      },
    },
    prepr,
  };
}

// `echoFrequency` is "disabled" when `null` (positiveIntOrNull already normalizes the
// `0` spelling to `null`). Centralized so the orchestrator's threshold check never has
// to re-reason about which value means off.
export function echoEnabled(policy) {
  return policy.echoFrequency !== null;
}

// Exported for the companion review sweep's groupThreadsOf: which vendor group a reviewer identity
// belongs to, so a thread opened by any reviewer in that group (not just this exact
// login) can be adopted for re-verification/resolution — see docs/adr/0005.
export function vendorOf(login, vendors) {
  if (vendors.claude.includes(login)) return 'claude';
  if (vendors.codex.includes(login)) return 'codex';
  return null;
}

/**
 * A PR is managed if its author is allowlisted, or a human in `policy.humans` opted it
 * in by label — presence of the label alone is not enough: anyone with triage
 * permission can apply it, so `pr.optinApplier` (the resolved applier login, or `null`
 * when unresolved/unattributed) must also be a listed human. Callers only need to
 * resolve `optinApplier` when the label is actually present and the author isn't
 * already allowlisted — see `resolveOptinApplier`.
 */
export function isEligible(pr, policy) {
  if (pr.draft) return false;
  if (pr.isFork) return false;
  if (policy.authors.includes(pr.author)) return true;
  return pr.labels.includes(policy.manualOptinLabel)
    && !!pr.optinApplier && policy.humans.includes(pr.optinApplier);
}

/**
 * Who applied the manual opt-in label, per the issue-events history — the label's mere
 * presence proves nothing about who put it there. Latest matching `labeled` event wins
 * (handles unlabel-then-relabel by a different actor); a label with no matching `labeled`
 * event at all (events pruned, or some other anomaly) resolves to `null` — unattributed,
 * which `isEligible` treats as not eligible (fail-closed). Returns `{login, eventId}`
 * rather than a bare login: the caller's ignored-applier comment dedupes on `eventId` so
 * a replayed/re-run event doesn't repeat it.
 */
export async function resolveOptinApplier(gh, repo, prNumber, label) {
  const events = await gh.paginate(`/repos/${repo}/issues/${prNumber}/events`);
  const labeled = events.filter((e) => e.event === 'labeled' && e.label?.name === label);
  if (!labeled.length) return null;
  const latest = labeled[labeled.length - 1];
  return { login: latest.actor?.login ?? null, eventId: latest.id };
}

/**
 * Deterministic cross-vendor reviewer selection: the first configured actor whose
 * vendor differs from the PR author's. Authors with no known vendor (humans,
 * unrecognized bots) get the first configured actor.
 */
export function desiredReviewer(prAuthor, policy) {
  const authorVendor = vendorOf(prAuthor, policy.reviewerVendors);
  if (authorVendor === null) return policy.reviewerActors[0];
  return policy.reviewerActors.find((a) => vendorOf(a, policy.reviewerVendors) !== authorVendor)
    ?? policy.reviewerActors[0];
}

/**
 * Actor logins whose submitted review counts as evidence right now. Usually just
 * `reviewerActors`, but if `codex` is still a configured backend, `codexActor` is
 * always included even when `reviewers.actors` was overridden for local-agent —
 * otherwise flipping `backends.reviewer` back to `[codex]` without also restoring
 * `reviewers.actors` leaves a submitted cloud-Codex review unrecognized forever.
 */
export function recognizedReviewActors(policy) {
  if (!policy.backends.reviewer.includes('codex') || policy.reviewerActors.includes(policy.codexActor)) {
    return policy.reviewerActors;
  }
  return [...policy.reviewerActors, policy.codexActor];
}

/**
 * Subset of `recognizedReviewActors()` that actually runs the local-agent sweep
 * (the companion's review sweep) and is therefore trusted to emit ESCALATE_MARKER/OPEN_THREAD_BLOCK_MARKER
 * (see inspectReview's `localReviewActors` opt). Empty when `local-agent` isn't a
 * configured reviewer backend — a pure cloud-`codex` review body is model-generated from
 * the untrusted diff and must never be trusted with these markers. `codexActor` is always
 * excluded even then: a mixed-backend policy (`reviewer: [local-agent, codex]`) can legally
 * list it in `reviewers.actors` for cross-vendor selection, but it never runs the local
 * sweep, so its review body is still model-generated from the untrusted diff.
 */
export function localReviewActors(policy) {
  if (!policy.backends.reviewer.includes('local-agent')) return [];
  return policy.reviewerActors.filter((actor) => actor !== policy.codexActor);
}

/**
 * Every identity that can act as a reviewer, independent of which backend is currently
 * configured — unlike `recognizedReviewActors()`, which answers "whose *submitted
 * review* counts as fresh evidence right now" and is deliberately backend-gated. This
 * answers a different question: "whose open thread is reviewer conversation, and whose
 * findings must never be silently dropped" (see #58/#103). `reviewers.vendors` is
 * unioned in directly (not filtered through `recognizedReviewActors`) so a human-summoned
 * `@codex review` / `@claude review` counts even on a `backends.reviewer: [local-agent]`
 * policy that never dispatches either automatically — the template explicitly documents
 * that manual-mention use case, and #103 traced the connector's vendor-list entry being
 * silently inert to exactly this backend-gated derivation.
 *
 * `claude[bot]` is deliberately included here: it sits in `reviewers.vendors.claude`
 * alongside a genuine reviewer actor because `@claude review` is a documented manual
 * flow, not because the fixer identity is a reviewer. Every consumer of this set relies
 * on ORIGINATION (who opened the thread — the fixer never does, see
 * claude-fix-prompt.md's reply-only contract), never PARTICIPATION, to keep the fixer's
 * own replies from being mistaken for reviewer conversation. See
 * docs/adr/0007-summoned-reviews-block-never-promote.md.
 */
export function reviewerRoleAgents(policy) {
  return [...new Set([
    ...policy.reviewerActors, policy.codexActor,
    ...policy.reviewerVendors.claude, ...policy.reviewerVendors.codex,
  ])];
}

/**
 * Optional runtime override of policy.yml's max_rounds via the AI_ORCH_MAX_ROUNDS
 * repository Variable — plain, UI-editable, no PR/human-required-path review needed,
 * unlike editing ai-policy.yml itself. Absent/empty → policy unchanged (falls back to
 * the committed policy.yml value, which itself already falls back to the code
 * default). Present but not a non-negative integer → throws rather than being
 * silently ignored, so a typo'd variable is visible instead of quietly doing nothing.
 */
export function applyMaxRoundsOverride(policy, envValue) {
  if (envValue === undefined || envValue === null || envValue === '') return policy;
  // Digit-only isn't sufficient on its own: a sufficiently long digit string still
  // converts to a non-finite/unsafe Number (e.g. Infinity), so require the parsed
  // result to be a safe integer too, not just the input's surface shape.
  const parsed = /^\d+$/.test(envValue) ? Number(envValue) : NaN;
  if (!Number.isSafeInteger(parsed)) {
    fail(`AI_ORCH_MAX_ROUNDS must be a non-negative integer, got ${JSON.stringify(envValue)}`);
  }
  return { ...policy, maxRounds: parsed };
}
