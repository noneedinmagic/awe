import test from 'node:test';
import assert from 'node:assert/strict';
import {
  globToRegExp, matchesAny, classifyRisk, unmatchedGlobs, hasUngatedCi,
} from '../scripts/lib/risk.js';
import { parsePolicy } from '../scripts/lib/policy.js';

const policy = parsePolicy(`
version: 1
authors: [a]
humans: [h]
risk:
  human_required_paths: ["migrations/**", "src/auth/**", "docker-compose*.yml", "**/*.sql"]
  max_files_changed: 3
  max_lines_added: 100
  max_lines_deleted: 50
  overrides: [{ paths: ["docs/**"], risk: low }]
`);

const f = (filename, additions = 1, deletions = 0) => ({ filename, additions, deletions });

test('glob semantics', () => {
  assert.ok(globToRegExp('.github/**').test('.github/workflows/ci.yml'));
  assert.ok(!globToRegExp('.github/**').test('src/.githubby/x'));
  assert.ok(globToRegExp('**/*.sql').test('a.sql'));
  assert.ok(globToRegExp('**/*.sql').test('deep/nested/a.sql'));
  assert.ok(!globToRegExp('**/*.sql').test('a.sqlx'));
  assert.ok(globToRegExp('docker-compose*.yml').test('docker-compose.prod.yml'));
  assert.ok(globToRegExp('docker-compose*.yml').test('ops/docker-compose.yml'), 'slashless matches any depth');
  assert.ok(globToRegExp('src/auth/**').test('src/auth/login.ts'));
  assert.ok(!globToRegExp('src/auth/**').test('src/authx/login.ts'));
  assert.ok(matchesAny('go.mod', ['go.mod', 'go.sum']));
});

test('glob semantics: leading `/` root-anchors instead of matching a literal slash (codex review round 2 finding on #1)', () => {
  // GitHub's PR-files API returns filenames repo-relative, never with a leading slash.
  assert.ok(globToRegExp('/src/auth/**').test('src/auth/login.ts'));
  assert.ok(globToRegExp('/README.md').test('README.md'));
  assert.ok(!globToRegExp('/README.md').test('docs/README.md'), 'root anchor, not any-depth');
});

test('plain small change is low risk', () => {
  const r = classifyRisk([f('src/app.ts', 10, 2)], policy);
  assert.deepEqual([r.level, r.humanRequired], ['low', false]);
});

test('.github changes are always human-required, regardless of policy', () => {
  const r = classifyRisk([f('.github/ai-policy.yml')], policy);
  assert.equal(r.level, 'high');
  assert.ok(r.humanRequired);
});

test('human_required_paths force high + human', () => {
  const r = classifyRisk([f('migrations/001.sql')], policy);
  assert.ok(r.humanRequired);
  assert.equal(r.level, 'high');
});

test('classifyRisk caps the filename list in a reason instead of joining every match (#224)', () => {
  const files = Array.from({ length: 3000 }, (_, i) => f(`migrations/${i}.sql`));
  const r = classifyRisk(files, policy);
  const humanReason = r.reasons.find((x) => x.startsWith('human-required paths changed'));
  assert.match(humanReason, /and 2975 more/);
  assert.ok(humanReason.length < 2000, 'the reason string stays small regardless of PR size');
});

test('classifyRisk caps a reason by total length too, not just file count (codex review round 1 finding on #234)', () => {
  const files = Array.from({ length: 25 }, (_, i) => f(`migrations/${'deep/'.repeat(200)}${i}.sql`));
  const r = classifyRisk(files, policy);
  const humanReason = r.reasons.find((x) => x.startsWith('human-required paths changed'));
  assert.ok(humanReason.length < 2000, 'even 25 very long filenames must not blow the comment budget');
});

test('dependency manifests honor dependency_changes=human', () => {
  const r = classifyRisk([f('package-lock.json', 500, 500)], policy);
  assert.ok(r.humanRequired);
});

test('size limits bump to medium', () => {
  assert.equal(classifyRisk([f('a'), f('b'), f('c'), f('d')], policy).level, 'medium');
  assert.equal(classifyRisk([f('a', 101, 0)], policy).level, 'medium');
  assert.equal(classifyRisk([f('a', 0, 51)], policy).level, 'medium');
});

test('override can lower level but never clears human requirement', () => {
  assert.equal(classifyRisk([f('docs/big.md', 5000, 0)], policy).level, 'low');
  const withAuth = classifyRisk([f('docs/x.md'), f('src/auth/a.ts')], policy);
  assert.equal(withAuth.level, 'high');
  assert.ok(withAuth.humanRequired);
});

test('lowering override does not apply to a mixed PR with unrelated risk', () => {
  // one docs file (override-eligible) plus enough other files to bump to medium.
  const mixed = classifyRisk([f('docs/x.md'), f('a'), f('b'), f('c')], policy);
  assert.equal(mixed.level, 'medium', 'override must not underreport risk from the other files');
});

test('classifyRisk: many override reasons stay bounded so the un-droppable state marker cannot blow the comment cap (codex review round 2 finding on #1)', () => {
  // 50 raise-overrides, all matching the same file (via a catch-all `**/*` alongside a
  // long decorative path that pads out the reason text) — every one still applies its
  // level, but only a bounded prefix of the reason text is kept.
  const longPad = 'x'.repeat(200);
  const manyOverrides = parsePolicy(`
version: 1
authors: [a]
humans: [h]
risk:
  overrides:
${Array.from({ length: 50 }, (_, i) => `    - { paths: ["**/*", "${longPad}${i}"], risk: high }`).join('\n')}
`);
  const result = classifyRisk([f('a.ts')], manyOverrides);
  assert.equal(result.level, 'high', 'every matching override still sets the level');
  const totalReasonChars = result.reasons.reduce((n, r) => n + r.length, 0);
  assert.ok(totalReasonChars < 3000, `override reasons must stay well under the comment budget, got ${totalReasonChars} chars`);
  assert.ok(result.reasons.some((r) => /more matching override reason\(s\) omitted/.test(r)), 'omitted overrides are summarized, not silently dropped');
});

// #144/#204: cause codes drive `human:*` labels — a PR can earn several at once, and
// `causes` must be dedup'd (two separate humanRequiredPaths matches don't double-report
// 'configured-path') and ordered by RISK_CAUSES, not by which check happened to fire first.
test('classifyRisk: causes report which check(s) fired, deduped, in RISK_CAUSES order', () => {
  const plain = classifyRisk([f('src/app.ts', 10, 2)], policy);
  assert.deepEqual(plain.causes, [], 'a plain low-risk change earns no causes');

  const protectedPath = classifyRisk([f('.github/ai-policy.yml')], policy);
  assert.deepEqual(protectedPath.causes, ['protected-path']);

  const configuredPath = classifyRisk([f('migrations/001.sql')], policy);
  assert.deepEqual(configuredPath.causes, ['configured-path']);

  const deps = classifyRisk([f('package-lock.json', 10, 10)], policy);
  assert.deepEqual(deps.causes, ['deps'], 'small enough to not also trip the size cause');

  const size = classifyRisk([f('a'), f('b'), f('c'), f('d')], policy);
  assert.deepEqual(size.causes, ['size']);

  // Two files each matching human_required_paths must not double-report 'configured-path'.
  const twoConfigured = classifyRisk([f('migrations/001.sql'), f('src/auth/a.ts')], policy);
  assert.deepEqual(twoConfigured.causes, ['configured-path']);

  // A PR earning multiple causes at once — order matches RISK_CAUSES, not fire order.
  const many = classifyRisk([f('.github/x.yml'), f('package.json', 500, 0), f('a'), f('b'), f('c'), f('d')], policy);
  assert.deepEqual(many.causes, ['protected-path', 'deps', 'size']);
});

test('classifyRisk: causes are raw facts, not overridden away — like reasons, they record what fired even when an override lowers the final level', () => {
  // Same fixture as 'override can lower level but never clears human requirement':
  // 5000 added lines trips the size check (recording the 'size' cause) BEFORE the
  // single-file docs/** override brings the level back down to 'low'. Consumers that
  // only want to label a human-facing PR must gate on `level !== 'low'` themselves
  // (as desiredLabels does), not assume an empty `causes` for a low-level result.
  const lowered = classifyRisk([f('docs/big.md', 5000, 0)], policy);
  assert.equal(lowered.level, 'low');
  assert.deepEqual(lowered.causes, ['size']);
});

test('unmatchedGlobs: flags a glob matching zero tracked files, ignores ones that match', () => {
  const tracked = ['src/auth/login.ts', 'docs/readme.md'];
  assert.deepEqual(unmatchedGlobs(['src/auth/**', 'migrations/**'], tracked), ['migrations/**']);
  assert.deepEqual(unmatchedGlobs(['src/auth/**'], tracked), []);
  assert.deepEqual(unmatchedGlobs([], tracked), []);
});

test('hasUngatedCi: empty required_checks beside a real CI workflow warns', () => {
  const ci = { content: 'on:\n  push: {}\n  pull_request: {}\njobs: {}\n' };
  assert.ok(hasUngatedCi([], [ci]));
});

test('hasUngatedCi: named required_checks never warns, even with real CI', () => {
  const ci = { content: 'on: [push]\njobs: {}\n' };
  assert.ok(!hasUngatedCi(['test'], [ci]));
});

test('hasUngatedCi: no workflows at all does not warn', () => {
  assert.ok(!hasUngatedCi([], []));
});

test('hasUngatedCi: the orchestrator caller workflow itself is excluded', () => {
  const caller = { content: 'on:\n  pull_request: {}\njobs:\n  o:\n    uses: noneedinmagic/awe/.github/workflows/orchestrator.yml@live\n' };
  assert.ok(!hasUngatedCi([], [caller]));
  // Callers still on the pre-split ref reach this code through the forwarding shim; they
  // must not be flagged as ungated CI either.
  const legacy = { content: 'on:\n  pull_request: {}\njobs:\n  o:\n    uses: noneedinmagic/agentic-workflows/.github/workflows/orchestrator.yml@live\n' };
  assert.ok(!hasUngatedCi([], [legacy]));
});

test('hasUngatedCi: a workflow_dispatch-only workflow does not count as gating CI', () => {
  const manual = { content: 'on: workflow_dispatch\njobs: {}\n' };
  assert.ok(!hasUngatedCi([], [manual]));
});

test('rename: protected/sensitive path checks also match previous_filename', () => {
  const renamedIntoProtected = classifyRisk([{ filename: '.github/workflows/ci.yml', previous_filename: 'ci.yml', additions: 1, deletions: 0 }], policy);
  const renamedOutOfProtected = classifyRisk([{ filename: 'ci.yml', previous_filename: '.github/workflows/ci.yml', additions: 1, deletions: 0 }], policy);
  for (const r of [renamedIntoProtected, renamedOutOfProtected]) {
    assert.equal(r.level, 'high');
    assert.ok(r.humanRequired);
  }
});
