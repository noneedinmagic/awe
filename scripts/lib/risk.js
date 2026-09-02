import { load } from 'js-yaml';
import { BUILTIN_HUMAN_PATHS, DEPENDENCY_MANIFESTS } from './policy.js';

const ORDER = { low: 0, medium: 1, high: 2 };

// #144/#204: machine-readable cause codes alongside the free-text `reasons` prose —
// `desiredLabels` (orchestrate.js) turns each into a `human:<code>` label so a human can
// filter/glance "why is this flagged" without opening the PR, instead of pattern-matching
// the prose (fragile) or re-deriving the same paths a second time (duplicates the
// classifier below). Order here is display order in RISK_CAUSES, not severity — a PR can
// earn several at once.
export const RISK_CAUSES = ['protected-path', 'configured-path', 'deps', 'size'];

// GitHub caps issue/PR comment bodies at 65,536 chars and renderComment (state.js) embeds
// these reasons directly — including inside the hidden state marker, which is never
// dropped by that function's own degrade cascade — so cap how many names each reason
// lists. A file-count cap alone isn't enough: MAX_REASON_FILES deeply nested filenames
// near a filesystem's path-length limit can still blow the comment budget on their own
// (codex review round 1 finding on #234), so also cap the joined string's total length.
const MAX_REASON_FILES = 25;
const MAX_REASON_CHARS = 1500;

function listFilenames(files) {
  const names = files.map((f) => f.filename);
  const capped = names.length > MAX_REASON_FILES ? names.slice(0, MAX_REASON_FILES) : names;
  let joined = capped.join(', ');
  if (joined.length > MAX_REASON_CHARS) joined = `${joined.slice(0, MAX_REASON_CHARS)}…`;
  if (names.length <= MAX_REASON_FILES) return joined;
  return `${joined}, and ${names.length - MAX_REASON_FILES} more`;
}

/**
 * Convert a gitignore-style glob to a RegExp.
 * Supports `**` (any depth), `*` (within a segment), `?`. A pattern without `/`
 * matches at any depth (like gitignore), e.g. `docker-compose*.yml`. A leading `/`
 * anchors to the repo root (gitignore semantics) rather than matching a literal slash —
 * the PR-files API returns filenames repo-relative, with no leading slash, so matching
 * it literally could never match anything (codex review round 2 finding on #1).
 */
export function globToRegExp(glob) {
  const rooted = glob.startsWith('/');
  const pattern = rooted ? glob.slice(1) : glob;
  let src = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) { src += '(?:.*/)?'; i += 3; }
    else if (pattern.startsWith('**', i)) { src += '.*'; i += 2; }
    else if (pattern[i] === '*') { src += '[^/]*'; i += 1; }
    else if (pattern[i] === '?') { src += '[^/]'; i += 1; }
    else { src += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&'); i += 1; }
  }
  return new RegExp(rooted || pattern.includes('/') ? `^${src}$` : `^(?:.*/)?${src}$`);
}

export function matchesAny(path, patterns) {
  return patterns.some((p) => globToRegExp(p).test(path));
}

/** A renamed file reports the new name in `filename`, the old one in `previous_filename` —
 * check both so a rename can't slip a match past a protected/sensitive path pattern. */
function matchesFile(file, patterns) {
  return matchesAny(file.filename, patterns) || (file.previous_filename && matchesAny(file.previous_filename, patterns));
}

/**
 * Deterministic risk classification.
 * @param {{filename: string, additions: number, deletions: number}[]} files PR changed files
 * @param {object} policy normalized policy from parsePolicy()
 * @returns {{level: 'low'|'medium'|'high', humanRequired: boolean, reasons: string[], causes: string[]}}
 *   `causes` is a subset of RISK_CAUSES, dedup'd, in RISK_CAUSES order — a PR can earn
 *   several at once (e.g. a large PR that also bumps package.json).
 */
export function classifyRisk(files, policy) {
  const reasons = [];
  const causeSet = new Set();
  let level = 'low';
  let humanRequired = false;
  const bump = (to, reason, cause) => {
    if (ORDER[to] > ORDER[level]) level = to;
    reasons.push(reason);
    if (cause) causeSet.add(cause);
  };

  const builtinHits = files.filter((f) => matchesFile(f, BUILTIN_HUMAN_PATHS));
  if (builtinHits.length) {
    humanRequired = true;
    bump('high', `protected orchestration paths changed: ${listFilenames(builtinHits)}`, 'protected-path');
  }

  const humanHits = files.filter((f) => matchesFile(f, policy.risk.humanRequiredPaths));
  if (humanHits.length) {
    humanRequired = true;
    bump('high', `human-required paths changed: ${listFilenames(humanHits)}`, 'configured-path');
  }

  const depHits = files.filter((f) => matchesFile(f, DEPENDENCY_MANIFESTS));
  if (depHits.length) {
    const setting = policy.risk.dependencyChanges;
    const names = listFilenames(depHits);
    if (setting === 'human') {
      humanRequired = true;
      bump('high', `dependency manifests changed (policy: human): ${names}`, 'deps');
    } else {
      bump(setting, `dependency manifests changed (policy: ${setting}): ${names}`, 'deps');
    }
  }

  const additions = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  if (files.length > policy.risk.maxFilesChanged) {
    bump('medium', `files changed ${files.length} > max ${policy.risk.maxFilesChanged}`, 'size');
  }
  if (additions > policy.risk.maxLinesAdded) {
    bump('medium', `lines added ${additions} > max ${policy.risk.maxLinesAdded}`, 'size');
  }
  if (deletions > policy.risk.maxLinesDeleted) {
    bump('medium', `lines deleted ${deletions} > max ${policy.risk.maxLinesDeleted}`, 'size');
  }

  // Overrides may raise or lower the level, but never clear a human requirement.
  // Lowering only applies when EVERY changed file is in scope — otherwise a single
  // matching file (e.g. a docs override) would underreport risk for the rest of a
  // mixed PR that independently earned a higher level.
  let overrideReasonChars = 0;
  let overrideReasonsOmitted = 0;
  for (const override of policy.risk.overrides) {
    const matched = files.filter((f) => matchesFile(f, override.paths));
    if (!matched.length) continue;
    const lowersRisk = ORDER[override.risk] < ORDER[level];
    if (lowersRisk && matched.length !== files.length) continue;
    // Level always applies, regardless of whether the reason text below fits the
    // budget — the comment-size cap must never change the actual risk classification.
    level = override.risk;
    // A policy with many overrides (or long path lists) used to append every one of
    // these lines unbounded — unlike the human-readable "Risk reasons" section,
    // reasons feeds the JSON state marker, which renderComment's degrade cascade never
    // drops, so this alone could blow GitHub's comment cap and fail the orchestrator
    // outright (codex review round 2 finding on #1). Cap the combined text the same
    // way listFilenames already caps a single reason's file list.
    const line = `override → ${override.risk} (${override.paths.join(', ')})`;
    if (overrideReasonChars + line.length > MAX_REASON_CHARS) { overrideReasonsOmitted += 1; continue; }
    reasons.push(line);
    overrideReasonChars += line.length;
    // Deliberately no cause code: an override is a manual policy adjustment to the
    // level, not a reason a human should look — the causes above already cover why.
  }
  if (overrideReasonsOmitted) {
    reasons.push(`override → ${overrideReasonsOmitted} more matching override reason(s) omitted (state marker budget)`);
  }
  if (humanRequired && ORDER[level] < ORDER.high) level = 'high';

  return {
    level, humanRequired, reasons, causes: RISK_CAUSES.filter((c) => causeSet.has(c)),
  };
}

/**
 * #267: `risk.human_required_paths` globs that match zero tracked files on the base
 * ref — a stale/typo'd path reads as protection while guarding nothing (one such glob
 * once went unnoticed for weeks). Advisory only; called from orchestrate.js with the base ref's
 * file list from the Git Trees API.
 */
export function unmatchedGlobs(patterns, trackedPaths) {
  return patterns.filter((p) => !trackedPaths.some((f) => globToRegExp(p).test(f)));
}

// A workflow whose `uses:` calls this orchestrator is the caller itself, not a second
// CI workflow guarding the PR — excluded so onboarding a repo never flags its own caller.
// ponytail: substring match over the whole file body, not a parse of `jobs.*.uses` — a
// workflow that merely *mentions* this path (a comment, a disabled block) is also
// exempted from the ungated-CI warning. Errs toward silence, the right direction for an
// advisory; parse `jobs.*.uses` if a real CI workflow ever hides behind a stray mention.
// Matches the engine's current home (awe) and its previous one (agentic-workflows): callers
// still on the old ref reach this code through a forwarding shim during the migration.
const ORCHESTRATOR_CALLER_RE = /(?:agentic-workflows|awe)\/\.github\/workflows\/orchestrator\.yml/;
const GATING_TRIGGERS = ['push', 'pull_request'];

function workflowTriggers(content) {
  let doc;
  try { doc = load(content); } catch { return []; }
  const on = doc?.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  if (on && typeof on === 'object') return Object.keys(on);
  return [];
}

/**
 * #267: `required_checks: []` beside a real CI workflow reads as "gate is on" while
 * gating nothing (9/10 audited repos left it empty next to the template's own comment
 * asking for it to be filled in). `workflowFiles` is `{content}[]` for every YAML file
 * under `.github/workflows/` on the base ref.
 */
export function hasUngatedCi(requiredChecks, workflowFiles) {
  if (requiredChecks.length > 0) return false;
  return workflowFiles.some(({ content }) => !ORCHESTRATOR_CALLER_RE.test(content)
    && workflowTriggers(content).some((t) => GATING_TRIGGERS.includes(t)));
}
