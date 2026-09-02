/** Minimal GitHub REST client: fetch + token, pagination-safe. */

// Documented once here rather than per call site (#216).
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Seconds (`Retry-After: 30`) or an HTTP-date — both are valid per RFC 9110 §10.2.3. */
function retryAfterMs(res) {
  const header = res?.headers?.get?.('retry-after');
  if (!header) return null;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * Retries fetchImpl on network errors (including our own timeout) and on
 * RETRYABLE_STATUSES, honoring `Retry-After` when present, otherwise exponential backoff.
 * Non-retryable statuses and exhausted retries just return/throw to the caller as normal —
 * every caller below still does its own res.ok / JSON handling, this only owns the "was
 * that worth trying again" decision. `retryable: false` (see `request()`'s POST case below)
 * skips retries entirely — a resource-creating call with no idempotency key would duplicate
 * its side effect on GitHub if retried after a lost response (#245 review).
 */
async function fetchWithRetry(fetchImpl, url, opts, { timeoutMs, maxRetries, retryBaseDelayMs, retryable = true }) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (!retryable || attempt >= maxRetries) throw err;
      await sleep(retryBaseDelayMs * 2 ** attempt);
      continue;
    }
    if (res.ok || !retryable || !RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) return res;
    await sleep(retryAfterMs(res) ?? retryBaseDelayMs * 2 ** attempt);
  }
}

// timeoutMs/maxRetries/retryBaseDelayMs are overridable so tests don't have to wait out
// real backoff delays — production code should never need to pass them.
export function makeClient({
  token, apiUrl = 'https://api.github.com', fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS, maxRetries = MAX_RETRIES, retryBaseDelayMs = RETRY_BASE_DELAY_MS,
}) {
  const retryOpts = { timeoutMs, maxRetries, retryBaseDelayMs };
  const authHeaders = {
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };

  async function request(method, path, body) {
    // POST creates a resource (comment/review/check-run/reply) with no idempotency key —
    // retrying it after a lost response risks duplicating that side effect on GitHub. Every
    // other method here is safe to retry: GET reads, PUT/DELETE/PATCH converge on the same
    // end state when repeated.
    const res = await fetchWithRetry(fetchImpl, `${apiUrl}${path}`, {
      method,
      headers: {
        ...authHeaders,
        accept: 'application/vnd.github+json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }, { ...retryOpts, retryable: method.toUpperCase() !== 'POST' });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path} → ${res.status}: ${data?.message ?? 'unknown error'}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** GET with a non-JSON Accept header (e.g. application/vnd.github.diff) → text body. */
  async function requestRaw(path, accept) {
    const res = await fetchWithRetry(fetchImpl, `${apiUrl}${path}`, { headers: { ...authHeaders, accept } }, retryOpts);
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`GitHub GET ${path} (${accept}) → ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return text;
  }

  /** GraphQL query/mutation (needed where REST has no equivalent, e.g. review-thread resolution). */
  async function graphql(query, variables = {}) {
    const res = await fetchWithRetry(fetchImpl, `${apiUrl}/graphql`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    }, retryOpts);
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.errors?.length) {
      const err = new Error(`GitHub GraphQL → ${res.status}: ${data?.errors?.[0]?.message ?? data?.message ?? 'unknown error'}`);
      err.status = res.status;
      throw err;
    }
    return data.data;
  }

  /** Follow Link: rel="next" headers until exhausted. `path` may already have a query string. */
  async function paginate(path) {
    const sep = path.includes('?') ? '&' : '?';
    let url = `${apiUrl}${path}${sep}per_page=100`;
    const all = [];
    while (url) {
      const res = await fetchWithRetry(fetchImpl, url, { headers: { ...authHeaders, accept: 'application/vnd.github+json' } }, retryOpts);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(`GitHub GET ${url} → ${res.status}: ${data?.message ?? 'unknown error'}`);
        err.status = res.status;
        throw err;
      }
      // Some list endpoints wrap the array: check-runs, installation repositories, workflow runs.
      // A 2xx with an unparseable/null body has no list to unwrap — treat it as empty
      // rather than throwing a TypeError out of `data.check_runs`.
      all.push(...(Array.isArray(data) ? data : data?.check_runs ?? data?.repositories ?? data?.workflow_runs ?? []));
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
    }
    return all;
  }

  /**
   * Count items on a paginated list endpoint in O(1): request `per_page=1` and read the
   * `Link: rel="last"` page number instead of walking every page. Falls back to counting
   * the one returned page directly when there's no `rel="last"` link (0 or 1 items total —
   * GitHub omits the header when there's nothing to paginate to).
   */
  async function countAll(path) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetchWithRetry(fetchImpl, `${apiUrl}${path}${sep}per_page=1`, { headers: { ...authHeaders, accept: 'application/vnd.github+json' } }, retryOpts);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`GitHub GET ${path} → ${res.status}: ${data?.message ?? 'unknown error'}`);
      err.status = res.status;
      throw err;
    }
    const lastPage = /[?&]page=(\d+)>;\s*rel="last"/.exec(res.headers.get('link') ?? '')?.[1];
    if (lastPage) return Number(lastPage);
    return (Array.isArray(data) ? data : data?.check_runs ?? data?.repositories ?? []).length;
  }

  return { request, requestRaw, graphql, paginate, countAll };
}
