import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTelegramMessage, sendTelegram, selectDigestResults, capToTelegramLimit } from '../scripts/lib/telegram.js';
import { REASONS } from '../scripts/lib/handoff.js';

const repo = 'noneedinmagic/awe';
const prNumber = 42;

test('needs-human: clickable repo/PR links, HTML parse mode, and the pinned-comment reason prose', () => {
  const msg = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'round-limit' });
  assert.equal(msg.parse_mode, 'HTML');
  assert.match(msg.text, /<a href="https:\/\/github\.com\/noneedinmagic\/awe">noneedinmagic\/awe<\/a>/);
  assert.match(msg.text, /<a href="https:\/\/github\.com\/noneedinmagic\/awe\/pull\/42">#42<\/a>/);
  assert.ok(msg.text.startsWith('🔴 '), 'needs-human is red-cued');
  assert.ok(msg.text.includes(REASONS['round-limit'].why), 'copies the same reasoning the pinned comment shows');
  assert.ok(msg.text.includes(REASONS['round-limit'].scope));
});

test('needs-human: risk-requires-human appends a risk-level emoji cue', () => {
  const msg = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'risk-requires-human', risk: { level: 'high' } });
  assert.ok(msg.text.includes(REASONS['risk-requires-human'].why));
  assert.match(msg.text, /Risk:.*🔴.*high/s);
});

test('needs-human: risk-requires-human lists the actual risk reasons, not just "listed above"', () => {
  const msg = buildTelegramMessage({
    kind: 'needs-human',
    repo,
    prNumber,
    reason: 'risk-requires-human',
    risk: { level: 'high', reasons: ['lines added 933 > max 600', 'touches human-required paths'] },
  });
  assert.ok(msg.text.includes('- lines added 933 &gt; max 600'));
  assert.ok(msg.text.includes('- touches human-required paths'));
});

// #144: the risk block used to be gated on `reason === 'risk-requires-human'` — hidden
// from every other handoff reason even when that PR was independently elevated risk. Now
// it renders whenever risk.level !== 'low', regardless of why automation actually stopped.
test('needs-human: a non-risk reason still shows the risk block when risk is independently elevated', () => {
  const msg = buildTelegramMessage({
    kind: 'needs-human',
    repo,
    prNumber,
    reason: 'round-limit',
    risk: { level: 'medium', reasons: ['lines added 754 > max 600'] },
  });
  assert.ok(msg.text.includes(REASONS['round-limit'].why));
  assert.match(msg.text, /Risk:.*🟡.*medium/s);
  assert.ok(msg.text.includes('- lines added 754 &gt; max 600'));
});

test('needs-human: risk block is omitted entirely when risk is low (or absent)', () => {
  const low = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'round-limit', risk: { level: 'low' } });
  assert.ok(!low.text.includes('Risk:'));
  const absent = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'round-limit' });
  assert.ok(!absent.text.includes('Risk:'));
});

test('needs-human: hard-truncates when an unbounded risk reason (e.g. a huge filename list) exceeds Telegram\'s 4096-char limit', () => {
  const msg = buildTelegramMessage({
    kind: 'needs-human',
    repo,
    prNumber,
    reason: 'risk-requires-human',
    risk: { level: 'high', reasons: [`protected orchestration paths changed: ${'file.js, '.repeat(1000)}`] },
  });
  assert.ok(msg.text.length <= 4096, `text must never exceed Telegram's limit, got ${msg.text.length}`);
});

test('capToTelegramLimit: backs up instead of slicing through an HTML entity (e.g. "&amp;" from an escaped "&")', () => {
  // Cut point (TELEGRAM_MAX_CHARS - 1 = 4095) lands mid-entity: 4093 filler chars, then
  // "&amp;" starting at index 4093 — slice(0, 4095) ends "...&a", a dangling entity.
  const text = `${'x'.repeat(4093)}&amp;rest of the message after the entity`;
  const capped = capToTelegramLimit(text);
  assert.ok(capped.length <= 4096, `capped text must never exceed Telegram's limit, got ${capped.length}`);
  assert.equal(capped, `${'x'.repeat(4093)}…`, 'must back up before the "&" rather than keep a partial entity');
});

test('capToTelegramLimit: closes a tag left open by the cut (e.g. a card\'s <blockquote>)', () => {
  const text = `${'x'.repeat(4000)}<blockquote>${'y'.repeat(200)}</blockquote>`;
  const capped = capToTelegramLimit(text);
  assert.ok(capped.length <= 4096, `capped text must never exceed Telegram's limit, got ${capped.length}`);
  const opens = (capped.match(/<blockquote>/g) ?? []).length;
  const closes = (capped.match(/<\/blockquote>/g) ?? []).length;
  assert.equal(opens, closes, 'every opened <blockquote> must be closed, or Telegram rejects the whole message');
});

test('needs-human: #165/#200 follow-up — an oversized card list never leaves a dangling <blockquote>', () => {
  // Escaped "&" characters (&amp;) inflate each card past its raw 300-char cap enough that
  // three cards' worth of <blockquote>-wrapped text blows past the 4096 limit mid-card.
  const cards = Array.from({ length: 3 }, (_, i) => ({
    path: `f${i}.js`, line: i, author: null, card: '&'.repeat(300),
  }));
  const msg = buildTelegramMessage({
    kind: 'needs-human', repo, prNumber, reason: 'agents-disagree', cards,
  });
  assert.ok(msg.text.length <= 4096, `text must never exceed Telegram's limit, got ${msg.text.length}`);
  const opens = (msg.text.match(/<blockquote>/g) ?? []).length;
  const closes = (msg.text.match(/<\/blockquote>/g) ?? []).length;
  assert.equal(opens, closes, 'a truncated card list must never leave an unclosed <blockquote>');
});

test('needs-human: fixer-failed includes the failed-run link, mirroring the sticky comment', () => {
  const msg = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'fixer-failed', runUrl: 'https://github.com/o/r/actions/runs/123' });
  assert.match(msg.text, /<a href="https:\/\/github\.com\/o\/r\/actions\/runs\/123">https:\/\/github\.com\/o\/r\/actions\/runs\/123<\/a>/);
});

test('needs-human: an unrecognized reason falls back gracefully instead of throwing', () => {
  const msg = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'made-up-reason' });
  assert.ok(msg.text.includes('made-up-reason'));
});

test('needs-human: agents-may-disagree renders the hedged reason and the standing-review link', () => {
  const msg = buildTelegramMessage({
    kind: 'needs-human', repo, prNumber, reason: 'agents-may-disagree',
    runUrl: 'https://github.com/o/r/pull/42#pullrequestreview-99',
  });
  assert.ok(msg.text.includes(REASONS['agents-may-disagree'].why));
  assert.match(msg.text, /<b>Standing review:<\/b>.*pullrequestreview-99/s, 'not "Failed run" — that label is fixer-failed only');
});

test('needs-human: agents-disagree still labels the link "Failed run" only for fixer-failed, "Standing review" otherwise', () => {
  const disagree = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'agents-disagree', runUrl: 'https://x/review' });
  assert.match(disagree.text, /<b>Standing review:<\/b>/);
  const failed = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'fixer-failed', runUrl: 'https://x/run' });
  assert.match(failed.text, /<b>Failed run:<\/b>/);
});

test('needs-human: fixer-skipped labels its run link "Skipped run", distinct from a real failure', () => {
  const msg = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'fixer-skipped', runUrl: 'https://x/run' });
  assert.ok(msg.text.includes(REASONS['fixer-skipped'].why));
  assert.match(msg.text, /<b>Skipped run:<\/b>/);
  assert.doesNotMatch(msg.text, /Failed run/);
});

test('needs-human: agents-disagree with cards lifts each blocking thread\'s card text into the message', () => {
  const card = '🧑‍⚖️ For the human, in plain words:\nDisagreement: is the counter reset a bug\nIf reviewer is right: data loss\n'
    + 'If responder is right: needless migration\nRecommended default: reviewer';
  const msg = buildTelegramMessage({
    kind: 'needs-human',
    repo,
    prNumber,
    reason: 'agents-disagree',
    runUrl: 'https://x/review',
    cards: [{
      path: 'scripts/orchestrate.js', line: 412, author: 'normandy-garrus[bot]', card,
    }],
  });
  assert.match(msg.text, /<b>Open disagreement \(1\):<\/b>/);
  assert.match(msg.text, /<code>scripts\/orchestrate\.js:412<\/code>/);
  assert.ok(msg.text.includes(card), 'the card text, including its own header line and newlines, is included verbatim (HTML-escaped)');
  assert.ok(msg.text.indexOf('<b>Standing review:</b>') < msg.text.indexOf('<b>Open disagreement'),
    '#200: the run link renders before the unbounded cards block, so a tail-trim can only ever eat card text');
});

test('needs-human: no cards (absent or empty) omits the disagreement section entirely — same message as before #165', () => {
  const withoutField = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'agents-disagree' });
  const withEmpty = buildTelegramMessage({
    kind: 'needs-human', repo, prNumber, reason: 'agents-disagree', cards: [],
  });
  assert.ok(!withoutField.text.includes('Open disagreement'));
  assert.ok(!withEmpty.text.includes('Open disagreement'));
});

test('needs-human: a null line renders path-only, no trailing colon; an unknown path degrades instead of crashing', () => {
  const msg = buildTelegramMessage({
    kind: 'needs-human',
    repo,
    prNumber,
    reason: 'reviewer-sustained',
    cards: [
      { path: 'a.js', line: null, author: null, card: '🧑‍⚖️ card one' },
      { path: null, line: null, author: null, card: '🧑‍⚖️ card two' },
    ],
  });
  assert.match(msg.text, /<code>a\.js<\/code>/);
  assert.match(msg.text, /<code>\(unknown path\)<\/code>/);
});

test('needs-human: HTML-escapes card text (untrusted reviewer/fixer-authored)', () => {
  const msg = buildTelegramMessage({
    kind: 'needs-human',
    repo,
    prNumber,
    reason: 'agents-disagree',
    cards: [{
      path: 'a.js', line: 1, author: null, card: '🧑‍⚖️ <script>bad</script>',
    }],
  });
  assert.ok(!msg.text.includes('<script>bad</script>'));
  assert.ok(msg.text.includes('&lt;script&gt;bad&lt;/script&gt;'));
});

test('needs-human: card list beyond the cap is truncated with a hidden-count footer', () => {
  const cards = Array.from({ length: 12 }, (_, i) => ({
    path: `f${i}.js`, line: i, author: null, card: `🧑‍⚖️ card ${i}`,
  }));
  const msg = buildTelegramMessage({
    kind: 'needs-human', repo, prNumber, reason: 'agents-disagree', cards,
  });
  assert.match(msg.text, /card 0/);
  assert.match(msg.text, /card 7/);
  assert.ok(!msg.text.includes('card 8'), 'cards beyond the cap are not rendered');
  assert.match(msg.text, /…and 4 more — see the PR's threads/);
});

test('needs-human: a card longer than 300 chars is capped with a visible ellipsis', () => {
  const msg = buildTelegramMessage({
    kind: 'needs-human',
    repo,
    prNumber,
    reason: 'agents-disagree',
    cards: [{ path: 'a.js', line: 1, author: null, card: `🧑‍⚖️ ${'z'.repeat(400)}` }],
  });
  assert.ok(!msg.text.includes('z'.repeat(400)), 'card text beyond the 300-char cap must not appear in full');
  assert.match(msg.text, /z…/, 'a capped card ends with a visible ellipsis, not a hard cutoff');
});

test('needs-human: #200 — an oversized card list truncates card text, never the standing-review link', () => {
  const cards = Array.from({ length: 20 }, (_, i) => ({
    path: `f${i}.js`.repeat(60), line: i, author: null, card: 'y'.repeat(1000),
  }));
  const msg = buildTelegramMessage({
    kind: 'needs-human',
    repo,
    prNumber,
    reason: 'agents-may-disagree',
    runUrl: 'https://github.com/o/r/pull/42#pullrequestreview-99',
    cards,
  });
  assert.ok(msg.text.length <= 4096, `text must never exceed Telegram's limit, got ${msg.text.length}`);
  assert.match(msg.text, /<b>Standing review:<\/b> <a href="https:\/\/github\.com\/o\/r\/pull\/42#pullrequestreview-99">/,
    'the run link survives the tail-trim regardless of how much card text overflows');
});

test('no-op-round: blue-cued, names the round, no reason lookup needed', () => {
  const msg = buildTelegramMessage({ kind: 'no-op-round', repo, prNumber, round: 2 });
  assert.ok(msg.text.startsWith('🔵 '));
  assert.match(msg.text, /fix round 2 changed no code/);
  assert.match(msg.text, /<a href="https:\/\/github\.com\/noneedinmagic\/awe\/pull\/42">#42<\/a>/);
});

test('ready: green-cued, links to the PR, no reason prose needed', () => {
  const msg = buildTelegramMessage({ kind: 'ready', repo, prNumber });
  assert.ok(msg.text.startsWith('🟢 '));
  assert.match(msg.text, /ready to merge — clean review, green CI, low risk\./);
  assert.match(msg.text, /<a href="https:\/\/github\.com\/noneedinmagic\/awe\/pull\/42">#42<\/a>/);
  assert.ok(!msg.text.includes('Title:'), 'no Title line when prTitle is unresolvable');
});

// #210: a busy chat notifying across many repos otherwise reads as identical "PR #N is
// ready to merge" lines — the title is what actually distinguishes them.
test('ready: includes an HTML-escaped Title line when prTitle is given', () => {
  const msg = buildTelegramMessage({ kind: 'ready', repo, prNumber, prTitle: 'Fix <the> thing' });
  assert.match(msg.text, /ready to merge — clean review, green CI, low risk\.\n\n<b>Title:<\/b> <code>Fix &lt;the&gt; thing<\/code>/);
});

test('needs-human: includes a Title line when prTitle is given, ahead of the reason prose', () => {
  const msg = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'round-limit', prTitle: 'Add loop mode' });
  assert.match(msg.text, /needs a human\n\n<b>Title:<\/b> <code>Add loop mode<\/code>\n\n<b>Why automation stopped/);
});

// #144: `ai:ready` no longer implies low risk (see #203) — the sentence must say whatever
// risk level the PR actually carries, and show the reasons, instead of a hardcoded "low".
test('ready: elevated risk is spoken in the sentence and lists its reasons', () => {
  const msg = buildTelegramMessage({
    kind: 'ready', repo, prNumber, risk: { level: 'medium', reasons: ['lines added 754 > max 600'] },
  });
  assert.match(msg.text, /is ready to merge — clean review, green CI, medium risk\./);
  assert.match(msg.text, /Risk:.*🟡.*medium/s);
  assert.ok(msg.text.includes('- lines added 754 &gt; max 600'));
});

test('ready: hard-truncates when an unbounded risk reason exceeds Telegram\'s 4096-char limit', () => {
  // Unreachable at risk.level === 'low' today (the only level `ready` carries pre-#203),
  // but #203 lifts that restriction and this block already renders unbounded reasons —
  // same hazard, same fix, as the equivalent needs-human test above.
  const msg = buildTelegramMessage({
    kind: 'ready',
    repo,
    prNumber,
    risk: { level: 'high', reasons: [`protected orchestration paths changed: ${'file.js, '.repeat(1000)}`] },
  });
  assert.ok(msg.text.length <= 4096, `text must never exceed Telegram's limit, got ${msg.text.length}`);
});

// #144: three fixed-position, shape-prefixed glyph pairs — 🤖 agents, 🛠️ build, 👤 you.
// Never sorted: position always maps to the same axis regardless of severity.
test('three-axis glyph row: ready and needs-human both lead with 🤖/🛠️/👤 when the facts are passed', () => {
  const ready = buildTelegramMessage({
    kind: 'ready', repo, prNumber, codexResult: 'clean', ciConclusion: 'success', risk: { level: 'medium' },
  });
  assert.ok(ready.text.startsWith('🤖🟢 🛠️🟢 👤🟡 '), ready.text);

  const needsHuman = buildTelegramMessage({
    kind: 'needs-human', repo, prNumber, reason: 'ci-failing', codexResult: 'clean', ciConclusion: 'failure', risk: { level: 'low' },
  });
  assert.ok(needsHuman.text.startsWith('🤖🟢 🛠️🔴 👤🟢 '), needsHuman.text);
});

test('three-axis glyph row: an absent fact within the row renders ⚪, not a crash or a blank', () => {
  const msg = buildTelegramMessage({
    kind: 'needs-human', repo, prNumber, reason: 'local-reviewer-escalation', codexResult: null, ciConclusion: undefined,
  });
  // codexResult passed explicitly (even as null) is enough to opt into the row — only
  // BOTH being undefined triggers the pre-#144 fallback.
  assert.ok(msg.text.startsWith('🤖⚪ 🛠️⚪ 👤⚪ '), msg.text);
});

test('three-axis glyph row: neither new fact passed falls back to the single pre-#144 glyph', () => {
  const ready = buildTelegramMessage({ kind: 'ready', repo, prNumber });
  assert.ok(ready.text.startsWith('🟢 '));
  assert.ok(!ready.text.includes('🤖'));

  const needsHuman = buildTelegramMessage({ kind: 'needs-human', repo, prNumber, reason: 'round-limit' });
  assert.ok(needsHuman.text.startsWith('🔴 '));
  assert.ok(!needsHuman.text.includes('🤖'));
});

test('three-axis glyph row: 🛠️ always carries its U+FE0F variation selector, never the bare unqualified codepoint', () => {
  const msg = buildTelegramMessage({ kind: 'ready', repo, prNumber, codexResult: 'clean', ciConclusion: 'success' });
  assert.ok(msg.text.includes('\u{1F6E0}\u{FE0F}'), 'must be the fully-qualified sequence, not bare U+1F6E0');
});

test('merged: hook message for when auto-merge lands', () => {
  const msg = buildTelegramMessage({ kind: 'merged', repo, prNumber });
  assert.ok(msg.text.startsWith('🟢 '));
  assert.match(msg.text, /auto-merged/);
});

test('HTML-escapes interpolated repo name', () => {
  const msg = buildTelegramMessage({ kind: 'ready', repo: 'o/<script>', prNumber });
  assert.ok(!msg.text.includes('<script>'));
  assert.ok(msg.text.includes('&lt;script&gt;'));
});

test('law2-refine: cap-reached renders orange, lists residuals, no dispute section', () => {
  const msg = buildTelegramMessage({
    kind: 'law2-refine',
    repo,
    branch: 'fix/foo',
    sessionId: 'aw-fix-foo-20260808T1201Z',
    capReached: true,
    rounds: { reviewer: 3, max: 3 },
    residuals: [
      {
        id: 'F3-1', path: 'scripts/orchestrate.js', line: 412, severity: 'P0', title: 'round counter resets',
      },
    ],
    disputes: [],
  });
  assert.ok(msg.text.startsWith('🟠 '));
  assert.match(msg.text, /hit its round cap \(3\/3\)/);
  assert.match(msg.text, /<a href="https:\/\/github\.com\/noneedinmagic\/awe">noneedinmagic\/awe<\/a> <b>fix\/foo<\/b>/);
  assert.match(msg.text, /<b>Residual:<\/b>/);
  assert.match(msg.text, /<code>F3-1<\/code> scripts\/orchestrate\.js:412 — round counter resets/);
  assert.ok(!msg.text.includes('Disputed'), 'no disputes were passed, so no Disputed section');
  assert.match(msg.text, /Session: <code>aw-fix-foo-20260808T1201Z<\/code>/);
  assert.ok(msg.text.indexOf('Session:') < msg.text.indexOf('<b>Residual:</b>'),
    '#200: the session id renders before the unbounded residual list, so a tail-trim can only ever eat that list');
});

test('law2-refine: converged-with-a-dispute renders yellow, no residual section, rationale newlines preserved', () => {
  const msg = buildTelegramMessage({
    kind: 'law2-refine',
    repo,
    branch: 'fix/foo',
    sessionId: 's1',
    capReached: false,
    rounds: { reviewer: 2, max: 3 },
    residuals: [],
    disputes: [
      {
        id: 'F1-1', path: 'scripts/notify.js', line: 88, severity: 'P1', title: 'counter reset', rationale: 'line one\nline two',
      },
    ],
  });
  assert.ok(msg.text.startsWith('🟡 '));
  assert.match(msg.text, /converged, but 1 finding rejected by the author/);
  assert.ok(!msg.text.includes('<b>Residual:</b>'), 'converged with no residuals — no Residual section');
  assert.match(msg.text, /<b>Disputed \(rejected by author\):<\/b>/);
  assert.match(msg.text, /<code>F1-1<\/code> scripts\/notify\.js:88 — counter reset/);
  assert.ok(msg.text.includes('line one\nline two'), 'rationale newlines must survive, not be collapsed to one line');
});

test('law2-refine: no repo (no origin remote) falls back to a bare branch name, no dead link', () => {
  const msg = buildTelegramMessage({
    kind: 'law2-refine',
    repo: null,
    branch: 'fix/foo',
    sessionId: 's1',
    capReached: true,
    rounds: { reviewer: 1, max: 1 },
    residuals: [{
      id: 'F1-1', path: 'a.js', line: null, severity: 'P0', title: 'file-wide finding',
    }],
    disputes: [],
  });
  assert.ok(!msg.text.includes('github.com'));
  assert.match(msg.text, /<b>fix\/foo<\/b> hit its round cap/);
  assert.match(msg.text, /- <b>P0<\/b> <code>F1-1<\/code> a\.js — file-wide finding/, 'a null line renders path-only, no trailing colon');
});

test('law2-refine: HTML-escapes finding titles and rationale', () => {
  const msg = buildTelegramMessage({
    kind: 'law2-refine',
    repo,
    branch: 'fix/foo',
    sessionId: 's1',
    capReached: false,
    rounds: { reviewer: 1, max: 3 },
    residuals: [],
    disputes: [{
      id: 'F1-1', path: 'a.js', line: 1, severity: 'P1', title: '<script>bad</script>', rationale: 'also <b>bad</b>',
    }],
  });
  assert.ok(!msg.text.includes('<script>bad</script>'));
  assert.ok(msg.text.includes('&lt;script&gt;bad&lt;/script&gt;'));
  assert.ok(!msg.text.includes('also <b>bad</b>'));
  assert.ok(msg.text.includes('also &lt;b&gt;bad&lt;/b&gt;'));
});

test('law2-refine: residual list beyond the cap is truncated with a hidden-count footer', () => {
  const residuals = Array.from({ length: 20 }, (_, i) => ({
    id: `F1-${i}`, path: `f${i}.js`, line: i, severity: 'P1', title: `finding ${i}`,
  }));
  const msg = buildTelegramMessage({
    kind: 'law2-refine',
    repo,
    branch: 'fix/foo',
    sessionId: 's1',
    capReached: true,
    rounds: { reviewer: 3, max: 3 },
    residuals,
    disputes: [],
  });
  assert.match(msg.text, /finding 0/);
  assert.match(msg.text, /finding 14/);
  assert.ok(!msg.text.includes('finding 15'), 'residuals beyond the cap are not rendered');
  assert.match(msg.text, /…and 5 more — see `refine summary`/);
});

test('law2-refine: a rationale longer than 300 chars is capped with a visible ellipsis', () => {
  const msg = buildTelegramMessage({
    kind: 'law2-refine',
    repo,
    branch: 'fix/foo',
    sessionId: 's1',
    capReached: false,
    rounds: { reviewer: 1, max: 3 },
    residuals: [],
    disputes: [{
      id: 'F1-1', path: 'a.js', line: 1, severity: 'P1', title: 'counter reset', rationale: 'z'.repeat(400),
    }],
  });
  assert.ok(!msg.text.includes('z'.repeat(400)), 'rationale beyond the 300-char cap must not appear in full');
  assert.match(msg.text, /z…/, 'a capped rationale ends with a visible ellipsis, not a hard cutoff');
});

test('law2-refine: #200 — an oversized residual/dispute list truncates finding text, never the session id', () => {
  const residuals = Array.from({ length: 20 }, (_, i) => ({
    id: `F1-${i}`, path: `f${i}.js`.repeat(60), line: i, severity: 'P1', title: 'x'.repeat(1000),
  }));
  const msg = buildTelegramMessage({
    kind: 'law2-refine',
    repo,
    branch: 'fix/foo',
    sessionId: 'aw-fix-foo-20260808T1201Z',
    capReached: true,
    rounds: { reviewer: 3, max: 3 },
    residuals,
    disputes: [],
  });
  assert.ok(msg.text.length <= 4096, `text must never exceed Telegram's limit, got ${msg.text.length}`);
  assert.match(msg.text, /Session: <code>aw-fix-foo-20260808T1201Z<\/code>/,
    'the session id survives the tail-trim regardless of how much residual text overflows');
});

test('blocked-run: orange-cued, links the run, includes PR + title when resolvable', () => {
  const msg = buildTelegramMessage({
    kind: 'blocked-run', repo, prNumber, workflowName: 'AI PR Orchestration',
    prTitle: 'Consolidate MVP', runUrl: 'https://github.com/o/r/actions/runs/1',
  });
  assert.ok(msg.text.startsWith('🟠 '));
  assert.match(msg.text, /AI PR Orchestration/);
  assert.match(msg.text, /Consolidate MVP/);
  assert.match(msg.text, /<a href="https:\/\/github\.com\/o\/r\/actions\/runs\/1">Review and approve<\/a>/);
});

test('blocked-run: falls back to "a run" when no PR is resolvable', () => {
  const msg = buildTelegramMessage({
    kind: 'blocked-run', repo, workflowName: 'AI PR Orchestration',
    runUrl: 'https://github.com/o/r/actions/runs/1',
  });
  assert.match(msg.text, /on a run needs manual approval/);
});

test('blocked-run: reminder:true swaps the lead cue instead of repeating the first-notice one', () => {
  const msg = buildTelegramMessage({
    kind: 'blocked-run', repo, workflowName: 'AI PR Orchestration', reminder: true,
    runUrl: 'https://github.com/o/r/actions/runs/1',
  });
  assert.ok(msg.text.startsWith('⏰ Still blocked:'));
  assert.ok(!msg.text.startsWith('🟠'));
});

test('blocked-run-expired: black-cued, notes the 30-day auto-delete, no dead run link', () => {
  const msg = buildTelegramMessage({
    kind: 'blocked-run-expired', repo, prNumber, workflowName: 'AI PR Orchestration',
    prTitle: 'Consolidate MVP', runUrl: 'https://github.com/o/r/actions/runs/1',
  });
  assert.ok(msg.text.startsWith('⚫ '));
  assert.match(msg.text, /auto-deleted the run after 30 days/);
  assert.match(msg.text, /Consolidate MVP/);
  assert.ok(!msg.text.includes('actions/runs/1'), 'no run link — the run itself 404s once deleted');
  assert.match(msg.text, /<a href="https:\/\/github\.com\/noneedinmagic\/awe\/pull\/42">#42<\/a>/);
});

test('opt-in: accepted names the applier and links the PR; ignored names the label and policy.humans', () => {
  const accepted = buildTelegramMessage({
    kind: 'opt-in', repo, prNumber, accepted: true, applier: 'human', label: 'ai:managed',
  });
  assert.match(accepted.text, /🏷️/);
  assert.match(accepted.text, /@human/);
  assert.match(accepted.text, /enrolled/);

  const ignored = buildTelegramMessage({
    kind: 'opt-in', repo, prNumber, accepted: false, applier: '<intruder>', label: 'ai:managed',
  });
  assert.match(ignored.text, /🚫/);
  assert.match(ignored.text, /&lt;intruder&gt;/, 'applier login is HTML-escaped');
  assert.match(ignored.text, /policy\.humans/);
});

test('opt-in: falls back to "a PR" when no prNumber is resolvable', () => {
  const msg = buildTelegramMessage({ kind: 'opt-in', repo, accepted: true, applier: 'human', label: 'ai:managed' });
  assert.match(msg.text, /a PR/);
});

test('dependabot-pr: robot-cued, links the PR + title', () => {
  const msg = buildTelegramMessage({ kind: 'dependabot-pr', repo, prNumber, prTitle: 'Bump lodash from 4.17.20 to 4.17.21' });
  assert.match(msg.text, /🤖/);
  assert.match(msg.text, /Bump lodash/);
  assert.match(msg.text, /excluded from orchestration/);
});

test('loop-blocked/failed/done/unknown: render issue links and reasons (companion dispatcher/babysitter kinds)', () => {
  const blocked = buildTelegramMessage({ kind: 'loop-blocked', repo: 'o/r', issueNumber: 5, reason: 'needs an org' });
  assert.match(blocked.text, /blocked/);
  assert.match(blocked.text, /#5/);

  const failed = buildTelegramMessage({ kind: 'loop-failed', repo: 'o/r', issueNumber: 6, reason: 'stalled' });
  assert.match(failed.text, /loop:failed/);
  assert.match(failed.text, /#6/);

  const done = buildTelegramMessage({ kind: 'loop-done', repo: 'o/r', issueNumber: 7, prUrl: 'https://github.com/o/r/pull/1' });
  assert.match(done.text, /pull\/1/);
  assert.match(done.text, /#7/);

  const unknown = buildTelegramMessage({ kind: 'loop-unknown', repo: 'o/r', issueNumber: 8, reason: 'cwd join miss' });
  assert.match(unknown.text, /could not classify/);
  assert.match(unknown.text, /#8/);

  const footerFailed = buildTelegramMessage({
    kind: 'loop-footer-failed', repo: 'o/r', issueNumber: 9, prUrl: 'https://github.com/o/r/pull/2', reason: 'identity.sh exited 1',
  });
  assert.match(footerFailed.text, /identity footer/);
  assert.match(footerFailed.text, /pull\/2/);
  assert.match(footerFailed.text, /#9/);
  assert.match(footerFailed.text, /identity\.sh exited 1/);
});

const NOW_YEAR = new Date().getUTCFullYear();
const result = (over = {}) => ({
  agent: 'codex', verdict: 'findings', url: 'https://github.com/o/r/pull/42#pullrequestreview-1',
  at: `${NOW_YEAR}-07-28T00:00:00Z`, ...over,
});

test('review-digest: single result renders digest shape with singular wording, no footers', () => {
  const msg = buildTelegramMessage({
    kind: 'review-digest', repo, prNumber, prTitle: 'Add loop mode',
    results: [result({ verdict: 'clean' })], earlierCount: 0,
  });
  assert.ok(msg.text.startsWith('🟢 '), 'clean-only digest is cued by its one verdict');
  assert.match(msg.text, /1 new review result\n/, 'singular wording, not "1 new review results"');
  assert.match(msg.text, /codex clean, no findings · 28 Jul — <a href="[^"]+">View<\/a>/);
  assert.ok(!msg.text.includes('not shown'), 'no cap footer when nothing was hidden');
  assert.ok(!msg.text.includes('already reported'), 'no earlier footer when earlierCount is 0');
});

test('review-digest: leads with the worst verdict present, not the newest result', () => {
  const msg = buildTelegramMessage({
    kind: 'review-digest', repo, prNumber, prTitle: 'Add loop mode',
    results: [
      result({ verdict: 'findings', at: `${NOW_YEAR}-07-28T00:00:00Z` }), // newest
      result({ verdict: 'error', at: `${NOW_YEAR}-07-20T00:00:00Z` }), // worst, but older
    ],
    earlierCount: 0,
  });
  assert.ok(msg.text.startsWith('🔴 '), 'error present anywhere in the group cues the whole digest red');
  assert.match(msg.text, /2 new review results/);
  const findingsLine = msg.text.split('\n').findIndex((l) => l.includes('flagged findings'));
  const errorLine = msg.text.split('\n').findIndex((l) => l.includes('errored'));
  assert.ok(findingsLine < errorLine, 'lines stay newest-first even though lead emoji is worst-first');
});

test('review-digest: over cap keeps every errored line and reports the correct hidden count', () => {
  const results = [
    result({ verdict: 'error', at: `${NOW_YEAR}-06-01T00:00:00Z`, url: 'https://x/error1' }),
    result({ verdict: 'error', at: `${NOW_YEAR}-06-02T00:00:00Z`, url: 'https://x/error2' }),
    ...Array.from({ length: 4 }, (_, i) => result({ at: `${NOW_YEAR}-07-0${i + 1}T00:00:00Z`, url: `https://x/f${i}` })),
  ];
  const msg = buildTelegramMessage({
    kind: 'review-digest', repo, prNumber, prTitle: 'Add loop mode', results, earlierCount: 0, maxLines: 3,
  });
  assert.match(msg.text, /https:\/\/x\/error1/, 'first error kept despite cap');
  assert.match(msg.text, /https:\/\/x\/error2/, 'second error kept despite cap');
  assert.match(msg.text, /…and 3 older results not shown/);
  assert.match(msg.text, /6 new review results/, 'header counts the true total, not just what is shown');
});

test('review-digest: trims further than maxLines to stay under Telegram\'s 4096-char sendMessage limit', () => {
  const longUrl = `https://x/${'a'.repeat(300)}`;
  const results = Array.from({ length: 25 }, (_, i) => result({
    url: `${longUrl}-${i}`, at: `${NOW_YEAR}-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const msg = buildTelegramMessage({
    kind: 'review-digest', repo, prNumber, prTitle: 'Add loop mode', results, earlierCount: 0,
  });
  assert.ok(msg.text.length <= 4096, `text must fit Telegram's limit, got ${msg.text.length}`);
  assert.match(msg.text, /older results? not shown/);
  assert.match(msg.text, /25 new review results/, 'header still counts the true total');
});

test('review-digest: char-budget trim drops non-error lines before ever dropping an error line', () => {
  const longUrl = `https://x/${'a'.repeat(300)}`;
  const results = [
    result({ verdict: 'error', url: `${longUrl}-err`, at: `${NOW_YEAR}-01-01T00:00:00Z` }), // oldest, but an error
    ...Array.from({ length: 15 }, (_, i) => result({
      url: `${longUrl}-${i}`, at: `${NOW_YEAR}-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    })),
  ];
  const msg = buildTelegramMessage({
    kind: 'review-digest', repo, prNumber, prTitle: 'Add loop mode', results, earlierCount: 0, maxLines: 20,
  });
  assert.ok(msg.text.length <= 4096);
  assert.match(msg.text, /-err/, 'the oldest line is the sole error and must survive the char trim');
});

test('review-digest: hard-truncates as a last resort when the header alone exceeds the char limit', () => {
  const msg = buildTelegramMessage({
    kind: 'review-digest', repo, prNumber, prTitle: 'x'.repeat(5000), results: [result()], earlierCount: 0,
  });
  assert.ok(msg.text.length <= 4096, `text must never exceed Telegram's limit, got ${msg.text.length}`);
});

test('review-digest: shownKeys lists exactly the rendered results\' keys, in the same order as the text', () => {
  const results = [
    result({ key: 'k1', url: 'a', at: `${NOW_YEAR}-07-01T00:00:00Z` }),
    result({ key: 'k2', url: 'b', at: `${NOW_YEAR}-07-02T00:00:00Z` }),
  ];
  const msg = buildTelegramMessage({ kind: 'review-digest', repo, prNumber, prTitle: 'x', results, earlierCount: 0 });
  assert.deepEqual(msg.shownKeys, ['k2', 'k1']);
});

test('selectDigestResults: under cap returns everything, sorted newest-first, nothing hidden', () => {
  const a = result({ url: 'a', at: `${NOW_YEAR}-07-01T00:00:00Z` });
  const b = result({ url: 'b', at: `${NOW_YEAR}-07-15T00:00:00Z` });
  const { shown, hiddenCount } = selectDigestResults([a, b], 20);
  assert.deepEqual(shown.map((r) => r.url), ['b', 'a']);
  assert.equal(hiddenCount, 0);
});

test('selectDigestResults: over cap protects every error, newest-first ordering preserved', () => {
  const err = result({ verdict: 'error', url: 'err', at: `${NOW_YEAR}-01-01T00:00:00Z` });
  const rest = Array.from({ length: 5 }, (_, i) => result({ url: `r${i}`, at: `${NOW_YEAR}-07-0${i + 1}T00:00:00Z` }));
  const { shown, hiddenCount } = selectDigestResults([err, ...rest], 3);
  assert.ok(shown.some((r) => r.url === 'err'), 'the error survives the cap');
  assert.equal(hiddenCount, 3);
  assert.deepEqual([...shown].sort((x, y) => new Date(y.at) - new Date(x.at)).map((r) => r.url), shown.map((r) => r.url));
});

test('review-digest: earlierCount renders a footer; 0 omits it', () => {
  const withEarlier = buildTelegramMessage({
    kind: 'review-digest', repo, prNumber, prTitle: 'Add loop mode', results: [result()], earlierCount: 3,
  });
  assert.match(withEarlier.text, /… 3 earlier results already reported — <a href="[^"]+">View all on the PR<\/a>/);

  const noEarlier = buildTelegramMessage({
    kind: 'review-digest', repo, prNumber, prTitle: 'Add loop mode', results: [result()], earlierCount: 0,
  });
  assert.ok(!noEarlier.text.includes('already reported'));
});

test('review-digest: HTML-escapes the PR title', () => {
  const msg = buildTelegramMessage({
    kind: 'review-digest', repo, prNumber, prTitle: '<script>alert(1)</script>', results: [result()], earlierCount: 0,
  });
  assert.ok(!msg.text.includes('<script>alert'));
  assert.match(msg.text, /&lt;script&gt;/);
});

test('review-digest: a result dated in a previous year renders its year, current-year lines do not', () => {
  const msg = buildTelegramMessage({
    kind: 'review-digest', repo, prNumber, prTitle: 'Add loop mode',
    results: [result({ url: 'old', at: `${NOW_YEAR - 1}-03-05T00:00:00Z` }), result({ url: 'new' })],
    earlierCount: 0,
  });
  assert.match(msg.text, new RegExp(`05 Mar ${NOW_YEAR - 1}`), 'previous-year result shows its year');
  assert.doesNotMatch(msg.text, new RegExp(`28 Jul ${NOW_YEAR}\\b`), 'current-year result omits the year');
});

test('sendTelegram resolves false on a non-ok response, true on ok', async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.AI_ORCH_TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.AI_ORCH_TELEGRAM_CHAT_ID;
  t.after(() => {
    global.fetch = originalFetch;
    process.env.AI_ORCH_TELEGRAM_BOT_TOKEN = originalToken;
    process.env.AI_ORCH_TELEGRAM_CHAT_ID = originalChat;
  });
  process.env.AI_ORCH_TELEGRAM_BOT_TOKEN = 'tok';
  process.env.AI_ORCH_TELEGRAM_CHAT_ID = 'chat';
  const msg = { text: 'hi', parse_mode: 'HTML' };

  global.fetch = async () => ({ ok: false });
  assert.equal(await sendTelegram(msg), false);

  global.fetch = async () => ({ ok: true });
  assert.equal(await sendTelegram(msg), true);

  global.fetch = async () => { throw new Error('network down'); };
  assert.equal(await sendTelegram(msg), false, 'a thrown/rejected send must not be mistaken for delivery');

  global.fetch = async (url, opts) => {
    assert.ok(opts.signal instanceof AbortSignal, 'request must carry an abort signal so a stalled endpoint cannot hang the job');
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  assert.equal(await sendTelegram(msg), false, 'an aborted (timed-out) send resolves false rather than hanging');
});
