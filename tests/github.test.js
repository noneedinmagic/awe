import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClient } from '../scripts/lib/github.js';

function fakeRes({
  ok = true, status = 200, json = [], link = '', retryAfter = null,
} = {}) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
    headers: { get: (h) => ({ link, 'retry-after': retryAfter }[h] ?? null) },
  };
}

// Fast by construction: maxRetries/retryBaseDelayMs are small so a real-time
// setTimeout-based backoff doesn't slow the suite down.
const FAST_RETRY = { maxRetries: 2, retryBaseDelayMs: 1 };

test('countAll reads the rel="last" page number instead of walking every page', async () => {
  let requestedUrl;
  const gh = makeClient({
    token: 't',
    fetchImpl: async (url) => {
      requestedUrl = url;
      return fakeRes({ json: [{ event: 'labeled' }], link: '<https://api.github.com/repos/o/r/issues/1/timeline?per_page=1&page=156>; rel="last"' });
    },
  });
  const count = await gh.countAll('/repos/o/r/issues/1/timeline');
  assert.equal(count, 156);
  assert.match(requestedUrl, /per_page=1$/, 'requests a single item, not the full list');
});

test('countAll falls back to counting the returned page when there is no rel="last" link', async () => {
  const gh = makeClient({ token: 't', fetchImpl: async () => fakeRes({ json: [{ event: 'labeled' }], link: '' }) });
  assert.equal(await gh.countAll('/repos/o/r/issues/1/timeline'), 1);
  const ghEmpty = makeClient({ token: 't', fetchImpl: async () => fakeRes({ json: [], link: '' }) });
  assert.equal(await ghEmpty.countAll('/repos/o/r/issues/1/timeline'), 0);
});

test('paginate unwraps the workflow_runs envelope, same as check_runs/repositories', async () => {
  const gh = makeClient({
    token: 't',
    fetchImpl: async () => fakeRes({ json: { total_count: 2, workflow_runs: [{ id: 1 }, { id: 2 }] } }),
  });
  const runs = await gh.paginate('/repos/o/r/actions/runs');
  assert.deepEqual(runs.map((r) => r.id), [1, 2]);
});

test('countAll throws on a non-ok response', async () => {
  const gh = makeClient({ token: 't', fetchImpl: async () => fakeRes({ ok: false, status: 404, json: { message: 'Not Found' } }) });
  await assert.rejects(() => gh.countAll('/repos/o/r/issues/1/timeline'), /404/);
});

test('request() attaches the HTTP status to a thrown error, so callers can distinguish a confirmed 404 from other failures', async () => {
  const gh = makeClient({ token: 't', fetchImpl: async () => fakeRes({ ok: false, status: 500, json: { message: 'boom' } }) });
  await assert.rejects(() => gh.request('GET', '/repos/o/r/contents/x'), (err) => err.status === 500);
});

test('a hung request times out and is retried, not left to hang forever', async () => {
  let calls = 0;
  const gh = makeClient({
    token: 't',
    timeoutMs: 5,
    ...FAST_RETRY,
    fetchImpl: (url, opts) => {
      calls++;
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
      });
    },
  });
  await assert.rejects(() => gh.request('GET', '/repos/o/r/pulls/1'), /aborted/);
  assert.equal(calls, FAST_RETRY.maxRetries + 1);
});

test('retries a 503 and returns the eventual success', async () => {
  let calls = 0;
  const gh = makeClient({
    token: 't',
    ...FAST_RETRY,
    fetchImpl: async () => {
      calls++;
      return calls < 3 ? fakeRes({ ok: false, status: 503 }) : fakeRes({ json: { ok: true } });
    },
  });
  assert.deepEqual(await gh.request('GET', '/repos/o/r/pulls/1'), { ok: true });
  assert.equal(calls, 3);
});

test('gives up after exhausting retries on a persistent 503', async () => {
  let calls = 0;
  const gh = makeClient({
    token: 't',
    ...FAST_RETRY,
    fetchImpl: async () => { calls++; return fakeRes({ ok: false, status: 503, json: { message: 'still down' } }); },
  });
  await assert.rejects(() => gh.request('GET', '/repos/o/r/pulls/1'), (err) => err.status === 503);
  assert.equal(calls, FAST_RETRY.maxRetries + 1);
});

test('a non-retryable status (400) is not retried', async () => {
  let calls = 0;
  const gh = makeClient({
    token: 't',
    ...FAST_RETRY,
    fetchImpl: async () => { calls++; return fakeRes({ ok: false, status: 400, json: { message: 'bad request' } }); },
  });
  await assert.rejects(() => gh.request('GET', '/repos/o/r/pulls/1'), (err) => err.status === 400);
  assert.equal(calls, 1);
});

test('err.status reflects the real response status, not a substring of the path — a PR numbered 422 hitting a 500 must not read as 422', async () => {
  const gh = makeClient({ token: 't', ...FAST_RETRY, fetchImpl: async () => fakeRes({ ok: false, status: 500, json: { message: 'boom' } }) });
  await assert.rejects(() => gh.request('POST', '/repos/o/r/pulls/422/reviews', { event: 'COMMENT' }), (err) => err.status === 500 && err.status !== 422);
});

test('err.status is a real 422 when the response actually is one, path digits notwithstanding', async () => {
  const gh = makeClient({ token: 't', ...FAST_RETRY, fetchImpl: async () => fakeRes({ ok: false, status: 422, json: { message: 'unprocessable' } }) });
  await assert.rejects(() => gh.request('POST', '/repos/o/r/pulls/1/reviews', { event: 'COMMENT' }), (err) => err.status === 422);
});

test('paginate treats a null (unparseable) 2xx body as an empty page instead of throwing', async () => {
  const gh = makeClient({ token: 't', fetchImpl: async () => ({ ...fakeRes({ json: null }), json: async () => null }) });
  assert.deepEqual(await gh.paginate('/repos/o/r/actions/runs'), []);
});

test('a POST is not retried on a retryable status (503) — retrying a create risks duplicating it', async () => {
  let calls = 0;
  const gh = makeClient({
    token: 't',
    ...FAST_RETRY,
    fetchImpl: async () => { calls++; return fakeRes({ ok: false, status: 503, json: { message: 'still down' } }); },
  });
  await assert.rejects(() => gh.request('POST', '/repos/o/r/issues/1/comments', { body: 'hi' }), (err) => err.status === 503);
  assert.equal(calls, 1);
});

test('a POST is not retried on a network error/timeout — the create may have already landed server-side', async () => {
  let calls = 0;
  const gh = makeClient({
    token: 't',
    timeoutMs: 5,
    ...FAST_RETRY,
    fetchImpl: (url, opts) => {
      calls++;
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
      });
    },
  });
  await assert.rejects(() => gh.request('POST', '/repos/o/r/issues/1/comments', { body: 'hi' }), /aborted/);
  assert.equal(calls, 1);
});

test('a PATCH is still retried on a retryable status — it converges on the same end state when repeated', async () => {
  let calls = 0;
  const gh = makeClient({
    token: 't',
    ...FAST_RETRY,
    fetchImpl: async () => {
      calls++;
      return calls < 2 ? fakeRes({ ok: false, status: 503 }) : fakeRes({ json: { ok: true } });
    },
  });
  assert.deepEqual(await gh.request('PATCH', '/repos/o/r/issues/comments/1', { body: 'hi' }), { ok: true });
  assert.equal(calls, 2);
});
