import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePolicy, PolicyError, applyMaxRoundsOverride, echoEnabled } from '../scripts/lib/policy.js';

const template = readFileSync(new URL('../templates/ai-policy.yml', import.meta.url), 'utf8');

test('template policy parses with expected defaults', () => {
  const p = parsePolicy(template);
  assert.equal(p.mode, 'dry-run');
  assert.equal(p.maxRounds, 2);
  assert.equal(p.echoFrequency, 100);
  assert.deepEqual(p.authors, ['your-claude-agent[bot]', 'your-codex-agent[bot]']);
  assert.deepEqual(p.humans, ['your-github-login']);
  assert.equal(p.codexActor, 'chatgpt-codex-connector[bot]');
  assert.equal(p.manualOptinLabel, 'ai:managed');
  assert.deepEqual(p.backends, { reviewer: ['local-agent'], fixer: ['claude-code-action'] });
  assert.equal(p.merge.autoMerge, false);
  assert.equal(p.notifications.telegram.enabled, false);
});

test('minimal policy gets defaults', () => {
  const p = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\n');
  assert.equal(p.mode, 'dry-run');
  assert.equal(p.ciFailureThreshold, 2);
  assert.equal(p.risk.dependencyChanges, 'human');
  assert.deepEqual(p.requiredChecks, []);
  // Project preference: fast-forward or an ordinary merge commit, never squash/rebase.
  assert.equal(p.merge.method, 'merge');
});

for (const [name, yaml] of [
  ['missing version', 'authors: [a]\nhumans: [h]'],
  ['wrong version', 'version: 2\nauthors: [a]\nhumans: [h]'],
  ['bad mode', 'version: 1\nmode: yolo\nauthors: [a]\nhumans: [h]'],
  ['empty authors', 'version: 1\nauthors: []\nhumans: [h]'],
  ['missing humans', 'version: 1\nauthors: [a]'],
  ['unknown fixer backend', 'version: 1\nauthors: [a]\nhumans: [h]\nbackends: {fixer: [gpt-magic]}'],
  ['bad override risk', 'version: 1\nauthors: [a]\nhumans: [h]\nrisk: {overrides: [{paths: [x], risk: extreme}]}'],
  ['negative rounds', 'version: 1\nauthors: [a]\nhumans: [h]\nmax_rounds: -1'],
  ['negative echo_frequency', 'version: 1\nauthors: [a]\nhumans: [h]\necho_frequency: -1'],
  ['not yaml mapping', '- just\n- a list'],
  ['unknown top-level key (typo)', 'version: 1\nauthors: [a]\nhumans: [h]\nrequired_check: [build]'],
  ['unknown nested risk key (typo)', 'version: 1\nauthors: [a]\nhumans: [h]\nrisk: {max_file_changed: 5}'],
  ['unknown override key', 'version: 1\nauthors: [a]\nhumans: [h]\nrisk: {overrides: [{paths: [x], risk: low, extra: 1}]}'],
  ['non-boolean telegram enabled', 'version: 1\nauthors: [a]\nhumans: [h]\nnotifications: {telegram: {enabled: "false"}}'],
  ['empty label_names value', 'version: 1\nauthors: [a]\nhumans: [h]\nlabel_names: {"ai:fixing": ""}'],
  ['whitespace-only label_names value', 'version: 1\nauthors: [a]\nhumans: [h]\nlabel_names: {"ai:fixing": " "}'],
  ['non-string label_names value', 'version: 1\nauthors: [a]\nhumans: [h]\nlabel_names: {"ai:fixing": 5}'],
  // codex review round 4 finding on #1: an uncompilable /regex/ required_checks entry
  // otherwise parses through and only throws later, deep inside computeCiStatus, on
  // every future orchestration event.
  ['malformed regex required_checks entry', 'version: 1\nauthors: [a]\nhumans: [h]\nrequired_checks: ["/[/"]'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parsePolicy(yaml), PolicyError);
  });
}

test('reviewers.vendors: required for local-agent, no fleet-specific default leaks (#290)', () => {
  assert.throws(
    () => parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\nbackends: {reviewer: [local-agent]}\nreviewers: {actors: [x]}\n'),
    PolicyError,
    'local-agent without reviewers.vendors must fail loudly',
  );
  const withVendors = parsePolicy(
    'version: 1\nauthors: [a]\nhumans: [h]\nbackends: {reviewer: [local-agent]}\n'
    + 'reviewers: {actors: [x], vendors: {claude: [x], codex: [y]}}\n',
  );
  assert.deepEqual(withVendors.reviewerVendors, { claude: ['x'], codex: ['y'] });
});

test('reviewers.vendors: cloud-only default when unset, no fleet identity (#290)', () => {
  const p = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\n');
  assert.deepEqual(p.reviewerVendors, { claude: ['claude[bot]'], codex: ['chatgpt-codex-connector[bot]'] });
});

test('required_checks: a valid slash-delimited regex entry parses through unchanged', () => {
  const p = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\nrequired_checks: ["/^build/", "lint"]\n');
  assert.deepEqual(p.requiredChecks, ['/^build/', 'lint']);
});

test('label_names: valid remap parses through', () => {
  const p = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\nlabel_names: {"ai:fixing": "status: fixing"}\n');
  assert.equal(p.labelNames['ai:fixing'], 'status: fixing');
});

test('echo_frequency: custom value, and both 0 and null disable auto-echo', () => {
  const custom = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\necho_frequency: 50\n');
  assert.equal(custom.echoFrequency, 50);
  assert.ok(echoEnabled(custom));

  const zero = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\necho_frequency: 0\n');
  assert.equal(zero.echoFrequency, null);
  assert.ok(!echoEnabled(zero));

  const nulled = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\necho_frequency: null\n');
  assert.equal(nulled.echoFrequency, null);
  assert.ok(!echoEnabled(nulled));

  const defaulted = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\n');
  assert.equal(defaulted.echoFrequency, 100);
  assert.ok(echoEnabled(defaulted));
});

test('prepr: defaults when section absent', () => {
  const p = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\n');
  assert.deepEqual(p.prepr, {
    maxRounds: 3, reviewers: ['claude', 'codex'], gates: [], notify: false,
  });
});

test('prepr: custom section parses', () => {
  const p = parsePolicy(`version: 1
authors: [a]
humans: [h]
prepr:
  max_rounds: 5
  reviewers: [codex]
  gates:
    - { name: test, cmd: "npm test", timeout_s: 600 }
    - { name: lint, cmd: "npm run lint" }
  notify: true
`);
  assert.equal(p.prepr.maxRounds, 5);
  assert.deepEqual(p.prepr.reviewers, ['codex']);
  assert.deepEqual(p.prepr.gates, [
    { name: 'test', cmd: 'npm test', timeoutS: 600 },
    { name: 'lint', cmd: 'npm run lint', timeoutS: 300 },
  ]);
  assert.equal(p.prepr.notify, true);
});

for (const [name, yaml] of [
  ['unknown prepr key (typo)', 'version: 1\nauthors: [a]\nhumans: [h]\nprepr: {max_round: 3}'],
  ['bad prepr.reviewers entry', 'version: 1\nauthors: [a]\nhumans: [h]\nprepr: {reviewers: [claude, gemini]}'],
  ['gate missing cmd', 'version: 1\nauthors: [a]\nhumans: [h]\nprepr: {gates: [{name: test}]}'],
  ['unknown gate key', 'version: 1\nauthors: [a]\nhumans: [h]\nprepr: {gates: [{name: t, cmd: x, extra: 1}]}'],
  ['bad prepr.notify type', 'version: 1\nauthors: [a]\nhumans: [h]\nprepr: {notify: 1}'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parsePolicy(yaml), PolicyError);
  });
}

test('applyMaxRoundsOverride: absent/empty env leaves policy unchanged', () => {
  const p = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\nmax_rounds: 2\n');
  assert.equal(applyMaxRoundsOverride(p, undefined).maxRounds, 2);
  assert.equal(applyMaxRoundsOverride(p, null).maxRounds, 2);
  assert.equal(applyMaxRoundsOverride(p, '').maxRounds, 2);
  assert.equal(applyMaxRoundsOverride(p, undefined), p, 'unchanged input is returned as-is, not a copy');
});

test('applyMaxRoundsOverride: a valid override replaces policy.yml\'s value', () => {
  const p = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\nmax_rounds: 2\n');
  assert.equal(applyMaxRoundsOverride(p, '4').maxRounds, 4);
  assert.equal(applyMaxRoundsOverride(p, '0').maxRounds, 0, 'zero is a valid non-negative integer');
  assert.equal(p.maxRounds, 2, 'original policy object is not mutated');
});

test('applyMaxRoundsOverride: a malformed non-empty override throws rather than being silently ignored', () => {
  const p = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\n');
  for (const bad of ['abc', '-1', '2.5', ' 2', '2 ', 'NaN', '99999999999999999999999999']) {
    assert.throws(() => applyMaxRoundsOverride(p, bad), PolicyError, `expected throw for ${JSON.stringify(bad)}`);
  }
});
