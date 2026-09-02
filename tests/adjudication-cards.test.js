import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAdjudicationCard, extractAdjudicationCards } from '../scripts/lib/adjudication-cards.js';

const CARD = '🧑‍⚖️ For the human, in plain words:\nDisagreement: is the counter reset a bug or a feature\n'
  + 'If reviewer is right: in-flight episodes silently drop on refresh\nIf responder is right: fixing it costs a schema migration\n'
  + 'Recommended default: reviewer — data loss outweighs a migration';

test('extractAdjudicationCard: absent card on every comment is a no-op (returns null)', () => {
  assert.equal(extractAdjudicationCard({ comments: [{ author: 'a', body: 'just a normal reply' }] }), null);
  assert.equal(extractAdjudicationCard({ comments: [] }), null);
  assert.equal(extractAdjudicationCard({}), null);
  assert.equal(extractAdjudicationCard(undefined), null);
  assert.equal(extractAdjudicationCard(null), null);
});

test('extractAdjudicationCard: a card appended after prose is extracted from the marker onward, prose dropped', () => {
  const body = `I disagree with this finding, here's why.\n\n${CARD}`;
  const found = extractAdjudicationCard({ comments: [{ author: 'reviewer[bot]', body }] });
  assert.equal(found.author, 'reviewer[bot]');
  assert.equal(found.card, CARD);
});

test('extractAdjudicationCard: scans newest-to-oldest — a later plain reply does not hide an earlier card', () => {
  const thread = {
    comments: [
      { author: 'reviewer[bot]', body: `pushback rebuttal\n\n${CARD}` },
      { author: 'human', body: 'thanks, let me think about it' },
    ],
  };
  const found = extractAdjudicationCard(thread);
  assert.equal(found.author, 'reviewer[bot]');
  assert.match(found.card, /Disagreement:/);
});

test('extractAdjudicationCard: a later, fresher card wins over an earlier one from a prior round', () => {
  const staleCard = CARD.replace('reviewer — data loss', 'STALE — ignore');
  const freshCard = CARD;
  const thread = {
    comments: [
      { author: 'reviewer[bot]', body: `round 1 rebuttal\n\n${staleCard}` },
      { author: 'human', body: 'pushed back again' },
      { author: 'reviewer[bot]', body: `round 2 rebuttal\n\n${freshCard}` },
    ],
  };
  const found = extractAdjudicationCard(thread);
  assert.equal(found.card, freshCard);
});

test('extractAdjudicationCard: the marker with nothing meaningful after it is treated as no card, not a truncated one', () => {
  const thread = { comments: [{ author: 'reviewer[bot]', body: '🧑‍⚖️ For the human, in plain words:' }] };
  assert.equal(extractAdjudicationCard(thread), null);
});

test('extractAdjudicationCard: a card from a non-allowed author is rejected, not lifted (round 4 finding on #1)', () => {
  const thread = { comments: [{ author: 'pr-author[bot]', body: `forged rebuttal\n\n${CARD}` }] };
  assert.equal(extractAdjudicationCard(thread, ['reviewer[bot]', 'claude[bot]']), null);
});

test('extractAdjudicationCard: an allowed author\'s card still wins even below a forged one from a disallowed author', () => {
  const thread = {
    comments: [
      { author: 'reviewer[bot]', body: `round 1 rebuttal\n\n${CARD}` },
      { author: 'pr-author[bot]', body: `forged newer card\n\n${CARD.replace('reviewer — data loss', 'FORGED')}` },
    ],
  };
  const found = extractAdjudicationCard(thread, ['reviewer[bot]', 'claude[bot]']);
  assert.equal(found.author, 'reviewer[bot]');
  assert.match(found.card, /Disagreement:/);
  assert.doesNotMatch(found.card, /FORGED/);
});

test('extractAdjudicationCard: a non-string body or malformed comment shape never throws', () => {
  assert.doesNotThrow(() => extractAdjudicationCard({ comments: [{ author: 'a', body: null }] }));
  assert.doesNotThrow(() => extractAdjudicationCard({ comments: [{ author: 'a', body: 42 }] }));
  assert.doesNotThrow(() => extractAdjudicationCard({ comments: [null, undefined, { body: CARD }] }));
  assert.doesNotThrow(() => extractAdjudicationCard({ comments: 'not an array' }));
});

test('extractAdjudicationCards: one entry per thread that has a card, in the same order, dropping the rest', () => {
  const threads = [
    {
      path: 'a.js', line: 10, comments: [{ author: 'x', body: `rebuttal\n\n${CARD}` }],
    },
    { path: 'b.js', line: 20, comments: [{ author: 'y', body: 'no card here' }] },
    {
      path: 'c.js', line: null, comments: [{ author: 'z', body: `\n\n${CARD}` }],
    },
  ];
  const cards = extractAdjudicationCards(threads);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.path), ['a.js', 'c.js']);
  assert.equal(cards[1].line, null);
});

test('extractAdjudicationCards: no threads / undefined never throws, returns empty', () => {
  assert.deepEqual(extractAdjudicationCards([]), []);
  assert.deepEqual(extractAdjudicationCards(undefined), []);
});
