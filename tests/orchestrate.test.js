import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveEvent, computeCiStatus, managedLabelNames, desiredLabels, findSticky,
  parseAiCommand, looksLikeAiCommand, safeHandoffThreads, classifierThreads, shouldEcho,
  threadResolutionRule, DISPUTE_REASON_LABELS, CI_LABELS, notifyCrash, main, run,
} from '../scripts/orchestrate.js';
import { parsePolicy, isEligible } from '../scripts/lib/policy.js';
import { newState, parseStateComment, renderComment, renderEcho } from '../scripts/lib/state.js';
import { RISK_CAUSES } from '../scripts/lib/risk.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const policy = parsePolicy(readFileSync(new URL('../templates/ai-policy.yml', import.meta.url), 'utf8'));
const mainPolicy = `version: 1
mode: active
authors: ["author[bot]"]
humans: [human]
backends: { reviewer: [local-agent], fixer: [claude-code-action] }
reviewers: { actors: ["reviewer[bot]"], vendors: { codex: ["reviewer[bot]"] } }
notifications: { telegram: { enabled: true } }
`;

function mainFixture({ failSticky = false, policyYaml = mainPolicy } = {}) {
  const calls = [];
  const sha = 'aaaa000011112222333344445555666677778888';
  const pr = {
    title: 'Ready PR', head: { sha, ref: 'feat/ready', repo: { full_name: 'o/r' } },
    base: { ref: 'main' }, user: { login: 'author[bot]' }, draft: false, labels: [], state: 'open',
  };
  const gh = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/repos/o/r/pulls/12') return pr;
      if (method === 'GET' && path.startsWith('/repos/o/r/contents/.github/ai-policy.yml')) {
        return { content: Buffer.from(policyYaml).toString('base64') };
      }
      if (failSticky && method === 'POST' && path === '/repos/o/r/issues/12/comments') throw new Error('sticky write failed');
      if (method === 'POST' && path === '/repos/o/r/issues/12/comments') return { id: 91 };
      return null;
    },
    paginate: async (path) => {
      if (path === '/repos/o/r/pulls/12/files') return [{ filename: '.github/workflows/ci.yml', additions: 1, deletions: 0 }];
      if (path === '/repos/o/r/pulls/12/reviews') return [{ id: 8, user: { login: 'reviewer[bot]' }, commit_id: sha, state: 'APPROVED' }];
      if (path === '/repos/o/r/commits/' + sha + '/check-runs?filter=latest') return [{ name: 'test', status: 'completed', conclusion: 'success' }];
      return [];
    },
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
    countAll: async () => 0,
  };
  const env = {
    GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'token', GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: new URL('./fixtures/pull_request.opened.json', import.meta.url).pathname,
    GITHUB_SERVER_URL: 'https://github.example', AI_ORCH_TELEGRAM_BOT_TOKEN: 'token', AI_ORCH_TELEGRAM_CHAT_ID: 'chat',
  };
  return { calls, gh, env };
}

test('main: requests human review before persisting the state that latches it as done (codex review round 1 finding on #1)', async () => {
  const { calls, env, gh } = mainFixture();
  await main({ env, gh, sendTelegram: async () => true });

  const persist = calls.findIndex((c) => c.method === 'POST' && c.path === '/repos/o/r/issues/12/comments');
  const reviewRequest = calls.findIndex((c) => c.method === 'POST' && c.path === '/repos/o/r/pulls/12/requested_reviewers');
  assert.ok(persist >= 0, 'sticky state is posted');
  // reduce() sets handoff.done/readyReviewRequested true in-memory before this call, and
  // the sticky write below persists that latch — so the review request must happen first:
  // a crash between the two would otherwise leave the PR permanently believing the review
  // was already requested when it never was, with no later event able to retry it.
  assert.ok(reviewRequest >= 0 && reviewRequest < persist, 'review request effect runs before its latch is persisted');
});

test('main: failed human review request rolls back its own latch for retry (codex review round 2 finding on #1)', async () => {
  const { calls, env, gh } = mainFixture();
  const baseRequest = gh.request;
  gh.request = async (method, path, body) => {
    if (method === 'POST' && path === '/repos/o/r/pulls/12/requested_reviewers') throw new Error('422 Unprocessable');
    return baseRequest(method, path, body);
  };

  await main({ env, gh, sendTelegram: async () => true });

  const sticky = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/issues/12/comments');
  const state = parseStateComment(sticky.body.body);
  // Unlike a delivered request, a failed one must not be recorded as done — otherwise
  // reduce() never re-emits 'request-human-review' on a later event and the review is
  // lost for the rest of the episode.
  assert.equal(state.readyReviewRequested, false);
});

test('main: no non-author reviewer left rolls back the request-human-review latch, same as a failed request (round 3 finding on #1)', async () => {
  // `policy.humans` has exactly one entry and it's the PR's own author — the author
  // filter in orchestrate.js leaves `reviewers` empty, so nothing is POSTed at all.
  const authorOnlyPolicy = mainPolicy.replace('humans: [human]', 'humans: ["author[bot]"]');
  const { calls, env, gh } = mainFixture({ policyYaml: authorOnlyPolicy });

  await main({ env, gh, sendTelegram: async () => true });

  assert.equal(calls.filter((c) => c.path === '/repos/o/r/pulls/12/requested_reviewers').length, 0);
  const sticky = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/issues/12/comments');
  const state = parseStateComment(sticky.body.body);
  // Left latched as done, this never re-opens — not even once a second human is added
  // to the base policy later, since reduce() only re-emits the effect while the latch
  // reads false.
  assert.equal(state.readyReviewRequested, false);
});

test('main: a fix-result invocation still clears the ai:fixing latch while policy is disabled (round 3 finding on #1)', async () => {
  const disabledPolicy = mainPolicy.replace('mode: active', 'mode: disabled');
  const { calls, env, gh } = mainFixture({ policyYaml: disabledPolicy });
  const sha = 'aaaa000011112222333344445555666677778888';
  const stuck = newState(12, sha, 'active');
  stuck.state = 'ai:fixing';
  const basePaginate = gh.paginate;
  gh.paginate = async (path) => {
    if (path === '/repos/o/r/issues/12/comments') {
      return [{ id: 50, user: { login: 'github-actions[bot]' }, body: renderComment(stuck) }];
    }
    return basePaginate(path);
  };
  env.PR_NUMBER = '12';
  env.FIX_OUTCOME = 'failed';

  await main({
    env, gh, sendTelegram: async () => true, argv: ['node', 'orchestrate.js', 'fix-result'],
  });

  const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/repos/o/r/issues/comments/50');
  assert.ok(patch, 'the stuck sticky comment is patched, not left untouched');
  const state = parseStateComment(patch.body.body);
  // A claude-fix job already in flight when policy flipped to `disabled` must still be
  // allowed to consume FIX_OUTCOME here — otherwise `ai:fixing` is stranded forever,
  // surviving even a later re-enable.
  assert.notEqual(state.state, 'ai:fixing');

  // `active` (false, mode !== 'active') suppresses request-codex/notify/request-human-review/
  // labels — none of those must fire just because a fix-result was consumed while disabled.
  assert.equal(calls.filter((c) => c.path === '/repos/o/r/pulls/12/requested_reviewers').length, 0);
  assert.equal(calls.filter((c) => c.path === '/repos/o/r/issues/12/labels').length, 0);
  // Disabled mode must still never leave a non-neutral gate blocking the PR.
  const gate = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/check-runs');
  assert.equal(gate.body.conclusion, 'neutral');
});

test('main: failed ready Telegram send retries only the notification latch', async () => {
  const { calls, env, gh } = mainFixture();
  await main({ env, gh, sendTelegram: async () => false });

  const sticky = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/issues/12/comments');
  const state = parseStateComment(sticky.body.body);
  assert.equal(state.readyNotified, false);
  assert.equal(state.readyReviewRequested, true);
  assert.equal(calls.filter((c) => c.path === '/repos/o/r/pulls/12/requested_reviewers').length, 1);
});

test('main: gate output warns on an empty required_checks beside a real CI workflow (#267)', async (t) => {
  const { calls, env, gh } = mainFixture();
  const baseRequest = gh.request;
  gh.request = async (method, path, body) => {
    if (method === 'GET' && path === '/repos/o/r/git/trees/main?recursive=1') {
      return { tree: [{ path: '.github/workflows/ci.yml', type: 'blob', sha: 'blobsha1' }] };
    }
    if (method === 'GET' && path === '/repos/o/r/git/blobs/blobsha1') {
      return { content: Buffer.from('on:\n  push: {}\njobs: {}\n').toString('base64'), encoding: 'base64' };
    }
    return baseRequest(method, path, body);
  };
  const log = t.mock.method(console, 'log');

  await main({ env, gh, sendTelegram: async () => true });

  const gate = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/check-runs');
  assert.match(gate.body.output.summary, /required_checks.*is empty/);
  // #277: the same warning reaches the operator surfaces — sticky comment + annotation.
  const sticky = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/issues/12/comments');
  assert.match(sticky.body.body, /Policy sanity/);
  assert.match(sticky.body.body, /required_checks.*is empty/);
  assert.equal(log.mock.calls.filter((c) => String(c.arguments[0]).startsWith('::warning::')).length, 1);
});

test('main: no policy sanity warning when required_checks is empty but there is no CI workflow', async () => {
  const { calls, env, gh } = mainFixture();
  const baseRequest = gh.request;
  gh.request = async (method, path, body) => {
    if (method === 'GET' && path === '/repos/o/r/git/trees/main?recursive=1') {
      return { tree: [{ path: 'src/index.js', type: 'blob', sha: 'blobsha2' }] };
    }
    return baseRequest(method, path, body);
  };

  await main({ env, gh, sendTelegram: async () => true });

  const gate = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/check-runs');
  assert.doesNotMatch(gate.body.output.summary, /Policy sanity warnings/);
  const sticky = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/issues/12/comments');
  assert.doesNotMatch(sticky.body.body, /Policy sanity/);
});

const migrationsPolicy = `${mainPolicy}risk: { human_required_paths: ["migrations/**"] }\n`;

test('main: gate output warns on a human_required_paths glob matching zero tracked files (#267)', async () => {
  const { calls, env, gh } = mainFixture({ policyYaml: migrationsPolicy });
  const baseRequest = gh.request;
  gh.request = async (method, path, body) => {
    if (method === 'GET' && path === '/repos/o/r/git/trees/main?recursive=1') {
      return { tree: [{ path: 'src/index.js', type: 'blob', sha: 'blobsha3' }] };
    }
    return baseRequest(method, path, body);
  };

  await main({ env, gh, sendTelegram: async () => true });

  const gate = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/check-runs');
  assert.match(gate.body.output.summary, /migrations\/\*\*/);
});

test('main: no policy sanity warning when the human_required_paths glob actually matches', async () => {
  const { calls, env, gh } = mainFixture({ policyYaml: migrationsPolicy });
  const baseRequest = gh.request;
  gh.request = async (method, path, body) => {
    if (method === 'GET' && path === '/repos/o/r/git/trees/main?recursive=1') {
      return { tree: [{ path: 'migrations/001.sql', type: 'blob', sha: 'blobsha4' }] };
    }
    return baseRequest(method, path, body);
  };

  await main({ env, gh, sendTelegram: async () => true });

  const gate = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/check-runs');
  assert.doesNotMatch(gate.body.output.summary, /Policy sanity warnings/);
});

test('main: a truncated base-ref tree suppresses the glob warning instead of false-flagging it', async () => {
  const { calls, env, gh } = mainFixture({ policyYaml: migrationsPolicy });
  const baseRequest = gh.request;
  gh.request = async (method, path, body) => {
    if (method === 'GET' && path === '/repos/o/r/git/trees/main?recursive=1') {
      return { tree: [{ path: 'src/index.js', type: 'blob', sha: 'blobsha5' }], truncated: true };
    }
    return baseRequest(method, path, body);
  };

  await main({ env, gh, sendTelegram: async () => true });

  const gate = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/check-runs');
  assert.doesNotMatch(gate.body.output.summary, /Policy sanity warnings/);
});

test('main: a failed base-ref tree fetch degrades to no warning, never a failing gate', async () => {
  const { calls, env, gh } = mainFixture({ policyYaml: migrationsPolicy });
  const baseRequest = gh.request;
  gh.request = async (method, path, body) => {
    if (method === 'GET' && path === '/repos/o/r/git/trees/main?recursive=1') throw new Error('502: bad gateway');
    return baseRequest(method, path, body);
  };

  await main({ env, gh, sendTelegram: async () => true });

  const gate = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/check-runs');
  assert.equal(gate.body.conclusion, 'success');
  assert.doesNotMatch(gate.body.output.summary, /Policy sanity warnings/);
});

const manyGlobsPolicy = `${mainPolicy}risk: { human_required_paths: [${
  Array.from({ length: 30 }, (_, i) => `"nope-${i}/**"`).join(', ')
}] }\n`;

test('main: policy sanity warnings are capped so a large unmatched-glob list cannot blow the comment body (#278)', async () => {
  const { calls, env, gh } = mainFixture({ policyYaml: manyGlobsPolicy });
  const baseRequest = gh.request;
  gh.request = async (method, path, body) => {
    if (method === 'GET' && path === '/repos/o/r/git/trees/main?recursive=1') {
      return { tree: [{ path: 'src/index.js', type: 'blob', sha: 'blobsha6' }] };
    }
    return baseRequest(method, path, body);
  };

  await main({ env, gh, sendTelegram: async () => true });

  const gate = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/check-runs');
  assert.match(gate.body.output.summary, /truncated/);
  const warningLines = gate.body.output.summary.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(warningLines.length <= 21, `expected at most 20 warnings plus a truncation note, got ${warningLines.length}`);

  const sticky = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/issues/12/comments');
  assert.match(sticky.body.body, /truncated/);
  assert.ok(sticky.body.body.length <= 65536);
});

const longGlobsPolicy = `${mainPolicy}risk: { human_required_paths: [${
  Array.from({ length: 20 }, (_, i) => `"nope-${i}-${'x'.repeat(3300)}/**"`).join(', ')
}] }\n`;

test('main: policy sanity warnings are capped by total length, not just count, when globs are long (#278)', async () => {
  const { calls, env, gh } = mainFixture({ policyYaml: longGlobsPolicy });
  const baseRequest = gh.request;
  gh.request = async (method, path, body) => {
    if (method === 'GET' && path === '/repos/o/r/git/trees/main?recursive=1') {
      return { tree: [{ path: 'src/index.js', type: 'blob', sha: 'blobsha7' }] };
    }
    return baseRequest(method, path, body);
  };

  await main({ env, gh, sendTelegram: async () => true });

  const gate = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/check-runs');
  assert.match(gate.body.output.summary, /truncated/);

  const sticky = calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/issues/12/comments');
  assert.match(sticky.body.body, /truncated/);
  assert.ok(sticky.body.body.length <= 65536, `expected sticky comment under 65536 chars, got ${sticky.body.body.length}`);
});

test('run: post-fetch crash reports a failing gate and Telegram alert without exiting', async () => {
  const { env, gh } = mainFixture({ failSticky: true });
  const gates = [];
  const alerts = [];
  const ok = await run({
    env, gh, sendTelegram: async () => true,
    postGateFn: async (...args) => { gates.push(args); },
    notifyCrashFn: async (...args) => { alerts.push(args); },
  });
  assert.equal(ok, false);
  assert.equal(gates.length, 1);
  assert.equal(gates[0][3].conclusion, 'failure');
  assert.match(gates[0][3].summary, /sticky write failed/);
  assert.equal(alerts.length, 1);
  assert.match(String(alerts[0][1]), /sticky write failed/);
});

test('resolveEvent extracts PR number and head SHA per event type', () => {
  const opened = resolveEvent('pull_request', fixture('pull_request.opened.json'));
  assert.deepEqual(opened, { prNumber: 12, eventHeadSha: 'aaaa000011112222333344445555666677778888' });

  const review = resolveEvent('pull_request_review', fixture('pull_request_review.submitted.json'));
  assert.deepEqual(review, { prNumber: 12, eventHeadSha: null });

  const suite = resolveEvent('check_suite', fixture('check_suite.completed.json'));
  assert.deepEqual(suite, { prNumber: 12, eventHeadSha: 'aaaa000011112222333344445555666677778888' });

  assert.equal(resolveEvent('check_suite', { check_suite: { pull_requests: [] } }).prNumber, undefined);

  const run = resolveEvent('workflow_run', fixture('workflow_run.completed.json'));
  assert.deepEqual(run, { prNumber: 12, eventHeadSha: 'aaaa000011112222333344445555666677778888' });
});

test('parseAiCommand recognizes retry/fix/round-cap/status/help and rejects everything else', () => {
  assert.deepEqual(parseAiCommand('/ai retry'), { type: 'retry' });
  assert.deepEqual(parseAiCommand('/ai status'), { type: 'status' });
  assert.deepEqual(parseAiCommand('/ai help'), { type: 'help' });
  assert.deepEqual(parseAiCommand('/ai fix do the thing'), { type: 'fix', instruction: 'do the thing' });
  assert.deepEqual(parseAiCommand('/ai fix'), { type: 'fix' });
  assert.deepEqual(parseAiCommand('/ai round-cap 10'), { type: 'round-cap', cap: 10 });
  assert.equal(parseAiCommand('/ai bogus'), null);
  assert.equal(parseAiCommand('not a command'), null);
  assert.equal(parseAiCommand(null), null);
});

test('looksLikeAiCommand: true for any comment opening with /ai, valid subcommand or not', () => {
  assert.equal(looksLikeAiCommand('/ai retry'), true);
  assert.equal(looksLikeAiCommand('/ai bogus'), true, 'wrong subcommand still looks like an attempt');
  assert.equal(looksLikeAiCommand('/ai round-cap abc'), true, 'valid subcommand, bad argument');
  assert.equal(looksLikeAiCommand('  /ai retry  '), true, 'leading/trailing whitespace trimmed');
  assert.equal(looksLikeAiCommand('/ai'), true, 'bare, no subcommand at all');
  assert.equal(looksLikeAiCommand('please /ai retry'), false, 'must start the comment');
  assert.equal(looksLikeAiCommand('/aircraft carrier'), false, 'word-boundary: /ai must stand alone');
  assert.equal(looksLikeAiCommand('not a command'), false);
  assert.equal(looksLikeAiCommand(null), false);
});

test('the ai-command.md doc the /ai help reply reads exists and covers every subcommand', () => {
  const doc = readFileSync(new URL('../docs/ai-command.md', import.meta.url), 'utf8');
  for (const cmd of ['retry', 'fix', 'round-cap', 'status', 'help']) assert.match(doc, new RegExp(`\\*\\*${cmd}\\*\\*`));
});

test('eligibility: allowlisted authors in, drafts/forks/others out, label opts in', () => {
  const pr = { author: 'your-claude-agent[bot]', draft: false, isFork: false, labels: [] };
  assert.ok(isEligible(pr, policy));
  assert.ok(isEligible({ ...pr, author: 'your-codex-agent[bot]' }, policy), 'Garrus is an equal peer');
  assert.ok(!isEligible({ ...pr, draft: true }, policy));
  assert.ok(!isEligible({ ...pr, isFork: true }, policy));
  assert.ok(!isEligible({ ...pr, author: 'random-person' }, policy));
  assert.ok(isEligible({ ...pr, author: 'random-person', labels: ['ai:managed'] }, policy), 'manual opt-in');
});

test('computeCiStatus: own checks excluded (including reusable-workflow composite names)', () => {
  const runs = [
    { name: 'AI Policy Gate', status: 'completed', conclusion: 'failure' },
    { name: 'orchestrate / AI Orchestrator', status: 'in_progress', conclusion: null },
    { name: 'orchestrate / AI Claude Fix', status: 'completed', conclusion: 'failure' },
    // Nested form the companion's forwarding shim produces (round 3 P1 fix's new job).
    { name: 'orchestrate / forward / Report Fix Result', status: 'completed', conclusion: 'success' },
    { name: 'build', status: 'completed', conclusion: 'success' },
  ];
  assert.equal(computeCiStatus(runs, []), 'success');
  assert.equal(computeCiStatus([...runs, { name: 'test', status: 'in_progress', conclusion: null }], []), 'pending');
  assert.equal(computeCiStatus([...runs, { name: 'test', status: 'completed', conclusion: 'failure' }], []), 'failure');
});

test('computeCiStatus: a consumer check merely containing an own-check word is not excluded (codex review round 2 finding on #1)', () => {
  const runs = [
    { name: 'orchestrate / AI Orchestrator', status: 'completed', conclusion: 'success' },
    // A real consumer CI job whose name happens to contain "AI Orchestrator" as a
    // substring — must still count as relevant CI, not be silently dropped.
    { name: 'AI Orchestrator Integration Tests', status: 'completed', conclusion: 'success' },
  ];
  assert.equal(
    computeCiStatus(runs, ['AI Orchestrator Integration Tests']),
    'success',
    'a required check must not be reported pending forever just because its name contains an own-check word',
  );
});

test('computeCiStatus: required patterns must all be present and green', () => {
  const build = { name: 'build', status: 'completed', conclusion: 'success' };
  assert.equal(computeCiStatus([build], ['build', 'test']), 'pending', 'missing required check is pending, not success');
  const test_ = { name: 'test (unit)', status: 'completed', conclusion: 'success' };
  assert.equal(computeCiStatus([build, test_], ['build', '/^test/']), 'success');
  const flaky = { name: 'lint', status: 'completed', conclusion: 'failure' };
  assert.equal(computeCiStatus([build, test_, flaky], ['build', '/^test/']), 'success', 'non-required failures ignored');
});

test('computeCiStatus: action_required and stale conclusions count as failures', () => {
  const build = { name: 'build', status: 'completed', conclusion: 'success' };
  const actionRequired = { name: 'deploy-approval', status: 'completed', conclusion: 'action_required' };
  const stale = { name: 'old-check', status: 'completed', conclusion: 'stale' };
  assert.equal(computeCiStatus([build, actionRequired], []), 'failure');
  assert.equal(computeCiStatus([build, stale], []), 'failure');
});

test('findSticky ignores a forged state marker from anyone but the orchestrator', async () => {
  const realState = newState(1, 'sha1', 'active');
  realState.state = 'ai:ready';
  const forged = { id: 1, user: { login: 'random-person' }, body: renderComment(realState) };
  const real = { id: 2, user: { login: 'github-actions[bot]' }, body: renderComment(newState(1, 'sha1', 'active')) };
  const gh = { paginate: async () => [forged, real] };
  const sticky = await findSticky(gh, 'o/r', 1);
  assert.equal(sticky.commentId, 2);
  assert.equal(sticky.state.state, 'ai:queued', 'the forged ai:ready comment must never be trusted');
});

test('findSticky finds nothing when only forged comments exist', async () => {
  const realState = newState(1, 'sha1', 'active');
  const forged = { id: 1, user: { login: 'random-person' }, body: renderComment(realState) };
  const gh = { paginate: async () => [forged] };
  const sticky = await findSticky(gh, 'o/r', 1);
  assert.equal(sticky.commentId, null);
  assert.equal(sticky.state, null);
  assert.deepEqual(sticky.echoes, []);
});

test('findSticky collects echo comments alongside the state comment, and never confuses one for the other', async () => {
  const real = { id: 2, user: { login: 'github-actions[bot]' }, body: renderComment(newState(1, 'sha1', 'active')) };
  const echo1 = { id: 3, user: { login: 'github-actions[bot]' }, body: renderEcho(newState(1, 'sha1', 'active'), { canonicalUrl: 'u', timelineCount: 40 }) };
  const echo2 = { id: 4, user: { login: 'github-actions[bot]' }, body: renderEcho(newState(1, 'sha1', 'active'), { canonicalUrl: 'u', timelineCount: 90 }) };
  const gh = { paginate: async () => [real, echo1, echo2] };
  const sticky = await findSticky(gh, 'o/r', 1);
  assert.equal(sticky.commentId, 2);
  assert.equal(sticky.state.state, 'ai:queued');
  assert.deepEqual(sticky.echoes, [{ id: 3, n: 40 }, { id: 4, n: 90 }]);
});

test('shouldEcho: /ai status always echoes, regardless of policy or threshold', () => {
  const disabled = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\necho_frequency: 0\n');
  assert.ok(shouldEcho({ isStatusCommand: true, policy: disabled, timelineCount: 1, lastEchoN: null }));
  const enabled = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\necho_frequency: 100\n');
  assert.ok(shouldEcho({ isStatusCommand: true, policy: enabled, timelineCount: 1, lastEchoN: 99 }));
});

test('shouldEcho: auto trigger fires at/above echo_frequency, not below, and never when disabled', () => {
  const policy = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\necho_frequency: 100\n');
  assert.ok(!shouldEcho({ isStatusCommand: false, policy, timelineCount: 99, lastEchoN: null }), 'below threshold, no prior echo');
  assert.ok(shouldEcho({ isStatusCommand: false, policy, timelineCount: 100, lastEchoN: null }), 'at threshold, no prior echo');
  assert.ok(!shouldEcho({ isStatusCommand: false, policy, timelineCount: 150, lastEchoN: 60 }), 'only 90 items since the last echo');
  assert.ok(shouldEcho({ isStatusCommand: false, policy, timelineCount: 160, lastEchoN: 60 }), '100 items since the last echo');

  const disabled = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\necho_frequency: 0\n');
  assert.ok(!shouldEcho({ isStatusCommand: false, policy: disabled, timelineCount: 999, lastEchoN: null }));
  const nulled = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\necho_frequency: null\n');
  assert.ok(!shouldEcho({ isStatusCommand: false, policy: nulled, timelineCount: 999, lastEchoN: null }));
});

test('shouldEcho: a fresh echo\'s n resets the floor — no immediate re-fire right after a manual echo', () => {
  const policy = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\necho_frequency: 100\n');
  // A manual /ai status just echoed at timelineCount 160; the next auto-check must not
  // re-fire until another 100 items accrue past that new floor, not the old one.
  assert.ok(!shouldEcho({ isStatusCommand: false, policy, timelineCount: 170, lastEchoN: 160 }));
  assert.ok(shouldEcho({ isStatusCommand: false, policy, timelineCount: 260, lastEchoN: 160 }));
});

test('shouldEcho: a timeline count below the recorded floor (deleted comments) resets the floor instead of going negative', () => {
  const policy = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\necho_frequency: 100\n');
  // lastEchoN=160, but comments were deleted and the count is now only 80 — treat as no
  // prior echo (floor 0) rather than requiring timelineCount to climb back to 260.
  assert.ok(!shouldEcho({ isStatusCommand: false, policy, timelineCount: 80, lastEchoN: 160 }), 'below threshold from reset floor');
  assert.ok(shouldEcho({ isStatusCommand: false, policy, timelineCount: 100, lastEchoN: 160 }), 'at threshold from reset floor');
});

test('managedLabelNames respects label_names display mapping', () => {
  const p = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\nlabel_names: {"ai:fixing": "🔧 ai:fixing"}\n');
  const names = managedLabelNames(p);
  assert.ok(names.includes('🔧 ai:fixing'));
  assert.ok(!names.includes('ai:fixing'), 'mapped state uses only its display name');
  assert.ok(names.includes('risk:high'));
});

test('managedLabelNames: round labels are a fixed six-entry bucket, independent of policy.maxRounds', () => {
  // Unbounded round labels used to throw the whole label-add request past the static
  // enumeration (GitHub rejects the entire POST if any named label doesn't exist) — a
  // per-PR /ai round-cap override (#112) can now push rounds arbitrarily high, so the
  // vocabulary must be fixed rather than growing with the cap.
  const low = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\nmax_rounds: 2\n');
  const high = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\nmax_rounds: 40\n');
  const expected = ['ai:round-0', 'ai:round-1', 'ai:round-2', 'ai:round-3', 'ai:round-4', 'ai:round-5+'];
  for (const name of expected) {
    assert.ok(managedLabelNames(low).includes(name));
    assert.ok(managedLabelNames(high).includes(name));
  }
  assert.ok(!managedLabelNames(high).includes('ai:round-40'), 'no per-round label past the bucket, even under a high cap');
});

test('managedLabelNames folds in a legacy per-round label (pre-bucketing) so it gets swept off', () => {
  const p = parsePolicy('version: 1\nauthors: [a]\nhumans: [h]\n');
  const names = managedLabelNames(p, ['ai:round-12', 'some-unrelated-label']);
  assert.ok(names.includes('ai:round-12'), 'a legacy unbucketed round label is still managed, so it can be cleaned up');
  assert.ok(!names.includes('some-unrelated-label'), 'non-round labels are not swept in');
});

test('desiredLabels: round label buckets at 5, exact below it', () => {
  for (const round of [0, 1, 4]) {
    const s = { ...newState(1, 'sha1', 'active'), round };
    assert.ok(desiredLabels(s, policy).includes(`ai:round-${round}`));
  }
  for (const round of [5, 9, 40]) {
    const s = { ...newState(1, 'sha1', 'active'), round };
    const labels = desiredLabels(s, policy);
    assert.ok(labels.includes('ai:round-5+'), `round ${round} collapses into the bucket`);
    assert.ok(!labels.includes(`ai:round-${round}`), `round ${round} does not get its own label`);
  }
});

// Pins the exact set the #165 Telegram-notify wiring branches on
// (`effect.kind === 'needs-human' && DISPUTE_REASON_LABELS.has(effect.reason)` in
// main()'s notify loop) — main() itself isn't exported/exercisable end to end, so this
// is the cheapest honest coverage that a future edit to the set doesn't silently drop
// card-lifting for a reason it should still cover, or add it to one it shouldn't.
test('DISPUTE_REASON_LABELS: exactly the three reasons a sustain reply can carry an adjudication card for', () => {
  assert.deepEqual([...DISPUTE_REASON_LABELS].sort(), ['agents-disagree', 'agents-may-disagree', 'reviewer-sustained']);
  for (const nonDispute of ['round-limit', 'fixer-failed', 'ci-failing', 'risk-requires-human']) {
    assert.ok(!DISPUTE_REASON_LABELS.has(nonDispute), `${nonDispute} must not be treated as a dispute reason`);
  }
});

test('desiredLabels: dispute reasons get a label, other needs-human reasons do not', () => {
  const disagree = { ...newState(1, 'sha1', 'active'), state: 'ai:needs-human', handoff: { done: true, notified: true, reason: 'agents-disagree' } };
  assert.ok(desiredLabels(disagree, policy).includes('ai:agents-disagree'));

  const may = { ...newState(1, 'sha1', 'active'), state: 'ai:needs-human', handoff: { done: true, notified: true, reason: 'agents-may-disagree' } };
  assert.ok(desiredLabels(may, policy).includes('ai:agents-may-disagree'));

  const sustained = { ...newState(1, 'sha1', 'active'), state: 'ai:needs-human', handoff: { done: true, notified: true, reason: 'reviewer-sustained' } };
  assert.ok(desiredLabels(sustained, policy).includes('ai:reviewer-sustained'), 'ADR-0009: reviewer-sustained gets its own label, same as the other dispute reasons');

  const roundLimit = { ...newState(1, 'sha1', 'active'), state: 'ai:needs-human', handoff: { done: true, notified: true, reason: 'round-limit' } };
  assert.ok(!desiredLabels(roundLimit, policy).some((l) => l.startsWith('ai:agents-') || l.startsWith('ai:reviewer-')), 'round-limit stays comment-only, not one label per reason');
});

test('desiredLabels: a dispute reason label never appears outside ai:needs-human', () => {
  const ready = { ...newState(1, 'sha1', 'active'), state: 'ai:ready', handoff: { done: false, notified: false, reason: 'agents-disagree' } };
  assert.ok(!desiredLabels(ready, policy).some((l) => l.startsWith('ai:agents-')), 'stale handoff.reason from a prior episode must not leak a label once recovered');
});

test('managedLabelNames includes all dispute-reason labels so a stale one is stripped on recovery', () => {
  const names = managedLabelNames(policy);
  assert.ok(names.includes('ai:agents-disagree'));
  assert.ok(names.includes('ai:agents-may-disagree'));
  assert.ok(names.includes('ai:reviewer-sustained'));
});

// #144/#204: per-cause human:* labels, gated on the final risk level (not raw causes —
// see risk.test.js's override coverage for why that distinction matters).
test('desiredLabels: a PR earning several risk causes at once gets every matching human:* label', () => {
  const s = {
    ...newState(1, 'sha1', 'active'),
    risk: {
      level: 'high', humanRequired: true, reasons: [], causes: ['protected-path', 'deps', 'size'],
    },
  };
  const labels = desiredLabels(s, policy);
  assert.ok(labels.includes('human:protected-path'));
  assert.ok(labels.includes('human:deps'));
  assert.ok(labels.includes('human:size'));
  assert.ok(!labels.includes('human:configured-path'), 'only the causes actually present get a label');
});

test('desiredLabels: no human:* label when risk is low, even if causes is non-empty (defensive)', () => {
  const s = {
    ...newState(1, 'sha1', 'active'),
    risk: {
      level: 'low', humanRequired: false, reasons: [], causes: ['size'],
    },
  };
  assert.ok(!desiredLabels(s, policy).some((l) => l.startsWith('human:')), 'level low must suppress every human:* label regardless of raw causes');
});

test('desiredLabels: ci:* mirrors state.ci.conclusion independently of the ai:* state', () => {
  const green = { ...newState(1, 'sha1', 'active'), state: 'ai:ready', ci: { sha: 'sha1', conclusion: 'success', consecutive_failures: 0 } };
  assert.ok(desiredLabels(green, policy).includes('ci:green'));

  const red = { ...newState(1, 'sha1', 'active'), state: 'ai:needs-human', handoff: { done: true, notified: true, reason: 'ci-failing' }, ci: { sha: 'sha1', conclusion: 'failure', consecutive_failures: 2 } };
  assert.ok(desiredLabels(red, policy).includes('ci:red'));

  const pending = { ...newState(1, 'sha1', 'active'), ci: { sha: 'sha1', conclusion: 'pending', consecutive_failures: 0 } };
  assert.ok(desiredLabels(pending, policy).includes('ci:pending'));

  const none = newState(1, 'sha1', 'active'); // ci.conclusion still null, pre-first-evaluation
  assert.ok(!desiredLabels(none, policy).some((l) => l.startsWith('ci:')), 'no ci:* label before CI has ever reported');
});

test('managedLabelNames includes every human:*/ci:* label so a stale one is stripped when risk/CI changes', () => {
  const names = managedLabelNames(policy);
  for (const cause of RISK_CAUSES) assert.ok(names.includes(`human:${cause}`));
  for (const ci of Object.values(CI_LABELS)) assert.ok(names.includes(ci));
});

// Pins the exact set main()'s label-apply split branches on
// (`bestEffortLabelNames` in the notify loop) — main() itself isn't
// exported/exercisable end to end, same reasoning as the DISPUTE_REASON_LABELS pin
// above. human:*/ci:* MUST be best-effort: a consumer repo that hasn't re-run bootstrap
// after #144/#204 is missing these labels entirely, and ci:pending in particular is
// near-universal (most PRs sit pending for most of their life) — landing it in the
// required batch would throw on that repo's very next PR event (GitHub rejects the
// whole POST when any named label doesn't exist, same class of bug as #117).
test('RISK_CAUSES and CI_LABELS: the exact human:*/ci:* label names main() treats as best-effort, not required', () => {
  assert.deepEqual(RISK_CAUSES, ['protected-path', 'configured-path', 'deps', 'size']);
  assert.deepEqual(CI_LABELS, { success: 'ci:green', failure: 'ci:red', pending: 'ci:pending' });
});

test('classifierThreads returns null (not []) on a GraphQL failure — unconfirmed must never read as confirmed-empty', async () => {
  const gh = { graphql: async () => { throw new Error('GitHub GraphQL → 502: bad gateway'); } };
  assert.equal(await classifierThreads(gh, 'o/r', 1, policy), null);
});

test('classifierThreads: at thread_authority fixer (default), every qualifying open thread counts — unchanged from before ADR-0005', async () => {
  const gh = { graphql: async () => ({
    repository: { pullRequest: { reviewThreads: {
      nodes: [{
        isResolved: false, path: 'a.js',
        // Last comment is the fixer's own reply — under the OLD (still-current at this
        // tier) behavior this still counts; only unansweredThreads narrows it away.
        comments: { nodes: [{ author: { login: 'your-codex-agent[bot]' } }, { author: { login: 'claude[bot]' } }] },
      }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } },
  }) };
  const threads = await classifierThreads(gh, 'o/r', 1, policy);
  assert.equal(threads.length, 1, 'fixer tier counts every qualifying open thread, answered or not');
});

test('classifierThreads: at thread_authority adjudicate/reviewer, only UNANSWERED threads count', async () => {
  const adjudicatePolicy = parsePolicy(
    'version: 1\nmode: active\nauthors: [a]\nhumans: [oleh]\n'
    + 'backends: { reviewer: [local-agent], fixer: [claude-code-action] }\n'
    + 'reviewers:\n  actors: ["your-codex-agent[bot]"]\n  vendors: { codex: ["your-codex-agent[bot]"] }\n  thread_authority: adjudicate\n',
  );
  const gh = { graphql: async () => ({
    repository: { pullRequest: { reviewThreads: {
      nodes: [
        {
          isResolved: false, path: 'a.js',
          // fixer spoke last — answered, no longer counts at this tier
          comments: { nodes: [{ author: { login: 'your-codex-agent[bot]' } }, { author: { login: 'claude[bot]' } }] },
        },
        {
          isResolved: false, path: 'b.js',
          // reviewer spoke last — still unanswered, still counts
          comments: { nodes: [{ author: { login: 'claude[bot]' } }, { author: { login: 'your-codex-agent[bot]' } }] },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } },
  }) };
  const threads = await classifierThreads(gh, 'o/r', 1, adjudicatePolicy);
  assert.deepEqual(threads.map((t) => t.path), ['b.js']);
});

test('classifierThreads: forRefresh ignores thread_authority narrowing — a fixer push-back still counts as unresolved', async () => {
  const adjudicatePolicy = parsePolicy(
    'version: 1\nmode: active\nauthors: [a]\nhumans: [oleh]\n'
    + 'backends: { reviewer: [local-agent], fixer: [claude-code-action] }\n'
    + 'reviewers:\n  actors: ["your-codex-agent[bot]"]\n  vendors: { codex: ["your-codex-agent[bot]"] }\n  thread_authority: reviewer\n',
  );
  const gh = { graphql: async () => ({
    repository: { pullRequest: { reviewThreads: {
      nodes: [{
        isResolved: false, path: 'a.js',
        // fixer spoke last (a push-back) — unansweredThreads would drop this, but
        // refresh's contract is "unresolved" not "unanswered": it must still block.
        comments: { nodes: [{ author: { login: 'your-codex-agent[bot]' } }, { author: { login: 'claude[bot]' } }] },
      }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } },
  }) };
  const threads = await classifierThreads(gh, 'o/r', 1, adjudicatePolicy, { forRefresh: true });
  assert.equal(threads.length, 1, 'refresh must count a fixer push-back as still-unresolved, unlike the disputed-round classifier');
});

test('safeHandoffThreads falls back to [] on a GraphQL failure instead of throwing', async () => {
  const gh = { graphql: async () => { throw new Error('GitHub GraphQL → 502: bad gateway'); } };
  const threads = await safeHandoffThreads(gh, 'o/r', 1, policy);
  assert.deepEqual(threads, [],
    'a transient threads fetch failure must not block the sticky-comment persist that durably latches the notify effect');
});

// --- Thread authority: fixer-side prompt rule (docs/adr/0005-reviewer-owns-thread-lifecycle.md) ---

test('threadResolutionRule: fixer/adjudicate get the original resolve instruction; reviewer forbids it', () => {
  const fixerRule = threadResolutionRule(policy); // template policy defaults to thread_authority: fixer
  assert.match(fixerRule, /resolve it/);
  assert.match(fixerRule, /resolveReviewThread/);

  const adjudicatePolicy = { ...policy, threadAuthority: 'adjudicate' };
  assert.equal(threadResolutionRule(adjudicatePolicy), fixerRule, 'adjudicate leaves the fixer-resolve instruction unchanged');

  const reviewerPolicy = { ...policy, threadAuthority: 'reviewer' };
  const reviewerRule = threadResolutionRule(reviewerPolicy);
  assert.match(reviewerRule, /Never resolve any review thread/);
  assert.doesNotMatch(reviewerRule, /resolveReviewThread/, 'no resolve mutation instruction at this tier');
});

test('threadResolutionRule: an unrecognized/missing tier falls back to the original instruction, never silently forbids resolving', () => {
  assert.equal(threadResolutionRule({ threadAuthority: undefined }), threadResolutionRule(policy));
  assert.equal(threadResolutionRule({ threadAuthority: 'bogus' }), threadResolutionRule(policy));
});

test('claude-fix-prompt.md carries the {{THREAD_RESOLUTION_RULE}} placeholder exactly once, and step 3 (reply to every thread) is untouched', () => {
  const doc = readFileSync(new URL('../scripts/claude-fix-prompt.md', import.meta.url), 'utf8');
  const occurrences = doc.match(/\{\{THREAD_RESOLUTION_RULE\}\}/g) ?? [];
  assert.equal(occurrences.length, 1);
  assert.match(doc, /Reply to every unanswered thread/, 'the reply obligation is unconditional at every tier');
});

test('safeHandoffThreads returns the qualified threads on success', async () => {
  const gh = { graphql: async () => ({
    repository: { pullRequest: { reviewThreads: {
      nodes: [{ isResolved: false, path: 'a.js', comments: { nodes: [{ author: { login: 'your-codex-agent[bot]' }, body: 'P1 x' }] } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } },
  }) };
  const threads = await safeHandoffThreads(gh, 'o/r', 1, policy);
  assert.deepEqual(threads.map((t) => t.path), ['a.js']);
});

// --- notifyCrash: the top-level catch's best-effort Telegram ping (#248) ---

test('notifyCrash: sends a Telegram message naming the repo/PR/error when env is configured', async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.AI_ORCH_TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.AI_ORCH_TELEGRAM_CHAT_ID;
  t.after(() => {
    global.fetch = originalFetch;
    process.env.AI_ORCH_TELEGRAM_BOT_TOKEN = originalToken;
    process.env.AI_ORCH_TELEGRAM_CHAT_ID = originalChat;
  });
  process.env.AI_ORCH_TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.AI_ORCH_TELEGRAM_CHAT_ID = 'test-chat';

  let sentBody;
  global.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true };
  };

  await notifyCrash({ repo: 'o/r', prNumber: 42, prTitle: 'Fix things' }, new Error('sticky comment PATCH failed'));
  assert.match(sentBody.text, /o\/r/);
  assert.match(sentBody.text, /#42/);
  assert.match(sentBody.text, /Fix things/);
  assert.match(sentBody.text, /sticky comment PATCH failed/);
});

test('notifyCrash: a missing Telegram secret is a silent no-op, no network attempt', async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.AI_ORCH_TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.AI_ORCH_TELEGRAM_CHAT_ID;
  t.after(() => {
    global.fetch = originalFetch;
    process.env.AI_ORCH_TELEGRAM_BOT_TOKEN = originalToken;
    process.env.AI_ORCH_TELEGRAM_CHAT_ID = originalChat;
  });
  delete process.env.AI_ORCH_TELEGRAM_BOT_TOKEN;
  delete process.env.AI_ORCH_TELEGRAM_CHAT_ID;

  let fetched = false;
  global.fetch = async () => { fetched = true; return { ok: true }; };

  await notifyCrash({ repo: 'o/r', prNumber: 42, prTitle: 'Fix things' }, new Error('boom'));
  assert.equal(fetched, false);
});
