// Parses the "🧑‍⚖️ For the human, in plain words:" adjudication card that a `sustain`
// reply appends to a review-thread comment (docs/adr — see #163's
// formatAdjudicationSection in review-sweep.js for the writer side; both
// scripts/claude-fix-prompt.md's pushback path and the ad-hoc /respond-review path write
// the identical card shape). This is the reader side, added for #165: lifting card text
// into the Telegram `needs-human` notify.
//
// Tolerant by contract, mirroring scripts/lib/law2-summary.js: most threads never
// deadlocked into a card at all — that's routine, not a warning — and a thread whose
// comments predate this feature, or whose card text is malformed, must degrade to "no
// card" rather than crash the notify path (issue #165's open question 3).

const CARD_MARKER = '🧑‍⚖️ For the human, in plain words:';

/**
 * The last-written card in `thread.comments` (oldest-first, per fetchReviewThreads) —
 * scanned newest to oldest so a later round's fresh card (formatAdjudicationSection:
 * "write a fresh one reflecting the current state ... rather than editing the old one")
 * wins over a stale one from an earlier round of the same disagreement, even if a
 * non-card reply (a plain fix attempt, a question) was posted after it.
 *
 * Returns `null` when no comment carries the marker at all — absent is the common case,
 * not malformed. Never throws: a non-array `comments`, a non-string `body`, or a
 * marker with nothing meaningful after it all fall through to a normal miss/short result
 * rather than an exception.
 *
 * @param {{comments?: {author?: string, body?: string}[]}} thread
 * @returns {{author: string|null, card: string}|null}
 */
export function extractAdjudicationCard(thread) {
  const comments = Array.isArray(thread?.comments) ? thread.comments : [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i]?.body;
    if (typeof body !== 'string') continue;
    const idx = body.lastIndexOf(CARD_MARKER);
    if (idx === -1) continue;
    const card = body.slice(idx).trim();
    if (card.length <= CARD_MARKER.length) continue; // the marker with nothing after it — keep scanning older comments
    return { author: comments[i].author ?? null, card };
  }
  return null;
}

/**
 * Cards for every thread in `threads` that has one, in the same order as `threads`
 * (already GitHub's/qualifyUnresolvedThreads' order — this never re-sorts). Threads
 * with no card are silently dropped, not represented as a null placeholder — the caller
 * (buildTelegramMessage's `needs-human` kind) renders however many it gets, including
 * zero, without needing to know which threads were skipped and why.
 *
 * @param {object[]} threads
 * @returns {{path: string|null, line: number|null, author: string|null, card: string}[]}
 */
export function extractAdjudicationCards(threads) {
  const out = [];
  for (const t of threads ?? []) {
    const found = extractAdjudicationCard(t);
    if (found) out.push({ path: t.path ?? null, line: t.line ?? null, ...found });
  }
  return out;
}
