import { REASONS } from './handoff.js';

// Mirrors templates/labels.json's color palette (ai:ready 0e8a16 green, ai:needs-human
// d93f0b red) — Telegram's Bot API has no colored text, so a status-color emoji is the
// closest faithful equivalent.
const RISK_EMOJI = { low: '🟢', medium: '🟡', high: '🔴' };

// #144: the `ready`/`needs-human` headline used to carry one glyph doing three jobs — a
// PR blocked purely by a size threshold looked identical to a genuine agent dispute. Three
// fixed-position, shape-prefixed pairs instead: 🤖 (did the reviewer find anything?), 🛠️
// (is the build green?), 👤 (does policy want your eyes?) — shape carries the axis, color
// the state, so reading "which axis is red" is a shape lookup, not a memorized position.
// Never reordered/sorted — sorting would destroy that positional mapping.
//
// 🛠️ MUST keep its U+FE0F variation selector. Bare U+1F6E0 is Unicode-listed
// "unqualified" (defaults to monochrome text presentation on some clients) — exactly the
// property this row depends on to be readable at a glance. 🏗/⚒ share the same defect;
// 🧪 was rejected on meaning (reads "experiment", not "build").
const NEUTRAL_GLYPH = '⚪';
const AGENT_GLYPH = { clean: '🟢', blocking: '🔴' };
const BUILD_GLYPH = { success: '🟢', pending: '🟡', failure: '🔴' };

/**
 * The three-axis glyph row, or null when neither new fact was passed at all — the
 * degrade-gracefully path for a caller (or an older test) that only ever knew about
 * `risk`. A caller passing just one of the two still gets the full row, with ⚪ standing
 * in for the other axis and for an absent/unrecognized risk level.
 * @param {{codexResult?: string|null, ciConclusion?: string|null, riskLevel?: string|null}} facts
 * @returns {string|null}
 */
function factGlyphRow({ codexResult, ciConclusion, riskLevel }) {
  if (codexResult === undefined && ciConclusion === undefined) return null;
  const agent = AGENT_GLYPH[codexResult] ?? NEUTRAL_GLYPH;
  const build = BUILD_GLYPH[ciConclusion] ?? NEUTRAL_GLYPH;
  const risk = RISK_EMOJI[riskLevel] ?? NEUTRAL_GLYPH;
  return `🤖${agent} 🛠️${build} 👤${risk}`;
}

// review-digest verdicts (the companion's notify sweep) — 🟠 for blocked-run mirrors
// neither an ai:* nor risk:* label; it's new (a human/GH-side gate, not a policy outcome).
const VERDICT_EMOJI = { findings: '🟡', clean: '🟢', error: '🔴', done: '🔎' };

// Worst-first so a digest's lead emoji reflects the worst verdict present, never the
// newest — an `error` line must not be visually buried under later `findings` lines.
const VERDICT_SEVERITY = { error: 0, findings: 1, done: 2, clean: 3 };

const DEFAULT_DIGEST_MAX_LINES = 20;

// law2-refine residual/dispute list cap — generous relative to typical session sizes
// (P0/P1-only findings, deduped, capped at 2-3 reviewer rounds by design) so this is a
// true last-resort, not an expected trim.
const LAW2_LIST_CAP = 15;

// needs-human adjudication-card list cap (#165) — a PR realistically deadlocks on a
// handful of threads at once, not dozens; generous relative to that for the same
// last-resort reason as LAW2_LIST_CAP above.
const CARD_LIST_CAP = 8;

// Telegram's own `sendMessage` hard limit (https://core.telegram.org/bots/api#sendmessage,
// `text` field) — exceeding it gets the whole message rejected outright, not truncated.
const TELEGRAM_MAX_CHARS = 4096;

// Per-item cap for agent-authored free text (adjudication cards, law2-refine rationale) —
// mirrors the companion review sweep's annotateDisputedFinding precedent. A count cap (CARD_LIST_CAP,
// LAW2_LIST_CAP) bounds how many items render, not how long each one is; without this, a
// handful of long items can still blow the char budget and cost the identifying field that
// capToTelegramLimit's own trim would otherwise eat first (#200).
const FREE_TEXT_CAP = 300;

function capFreeText(s) {
  const str = String(s ?? '');
  return str.length > FREE_TEXT_CAP ? `${str.slice(0, FREE_TEXT_CAP)}…` : str;
}

/**
 * Pure: picks which of a PR's new results fit in a digest capped at `maxLines`.
 * `error` results are reserved a slot first — never truncated away — then the remaining
 * slots go to the newest of the rest. Returned `shown` is newest-first regardless of
 * which pass placed it.
 * @param {{verdict: string, at: string|number|Date}[]} results
 * @param {number} maxLines
 * @returns {{shown: object[], hiddenCount: number}}
 */
export function selectDigestResults(results, maxLines = DEFAULT_DIGEST_MAX_LINES) {
  if (results.length <= maxLines) {
    return { shown: [...results].sort((a, b) => new Date(b.at) - new Date(a.at)), hiddenCount: 0 };
  }
  // Even `error` results are capped at maxLines — an unbounded error backlog (e.g. a
  // long-lived PR with 100+ failed sentinels) would otherwise blow past Telegram's 4096
  // char sendMessage limit, get the whole digest rejected, and retry forever undelivered.
  const errors = results.filter((r) => r.verdict === 'error')
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, maxLines);
  const rest = results.filter((r) => r.verdict !== 'error')
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  const shown = [...errors, ...rest.slice(0, Math.max(0, maxLines - errors.length))]
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  return { shown, hiddenCount: results.length - shown.length };
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Shared by `ready` and `needs-human` so the Title line's look changes in one place.
function titleLine(prTitle) {
  return `<b>Title:</b> <code>${esc(prTitle)}</code>`;
}

// Last-resort safety net for text that still exceeds Telegram's sendMessage limit after
// any kind-specific trimming (or for kinds with no trimming of their own, e.g. an
// unbounded list of risk reasons) — better to truncate than let Telegram reject the send.
export function capToTelegramLimit(text) {
  if (text.length <= TELEGRAM_MAX_CHARS) return text;
  let sliced = text.slice(0, TELEGRAM_MAX_CHARS - 1);
  // esc() only ever emits &amp;/&lt;/&gt;, so a trailing "&" not yet followed by ";" is
  // always a hard cut through one of those — back up to before it, or Telegram's HTML
  // parser rejects the whole message over one dangling entity.
  const danglingEntity = sliced.match(/&[a-zA-Z0-9#]*$/);
  if (danglingEntity) sliced = sliced.slice(0, danglingEntity.index);
  return `${sliced}…`;
}

/**
 * Build the Telegram `sendMessage` payload for a notify effect — either the orchestrator's
 * own state-machine transitions, or the server-side notify sweep's out-of-band events.
 * Pure and side-effect-free so the message text is unit-testable without a live bot.
 *
 * @param {object} input
 * @param {'needs-human'|'ready'|'merged'|'blocked-run'|'blocked-run-expired'|'review-digest'|'no-op-round'|'law2-refine'} input.kind
 * @param {string} input.repo `owner/repo`
 * @param {number} [input.prNumber] omitted for a `blocked-run`/`blocked-run-expired` with no resolvable PR
 * @param {string} [input.reason] handoff reason slug — required for `needs-human`, looked
 *   up in the same `REASONS` prose the pinned sticky comment renders (handoff.js)
 * @param {{level: string, reasons?: string[]}} [input.risk] `ready`/`needs-human` only —
 *   rendered as a `<b>Risk:</b>` line (plus bullet reasons) whenever `level !== 'low'`,
 *   regardless of handoff reason (#144) — not just for `risk-requires-human` as before
 * @param {string|null} [input.codexResult] `ready`/`needs-human` only — `state.codex.result`
 *   (`'clean'`/`'blocking'`/`null`), the 🤖 glyph's source; omitted (not just null/undefined
 *   on purpose vs. never passed) together with `ciConclusion` falls back to the pre-#144
 *   single lead glyph — see `factGlyphRow`
 * @param {string|null} [input.ciConclusion] `ready`/`needs-human` only — `state.ci.conclusion`
 *   (`'success'`/`'pending'`/`'failure'`/`null`), the 🛠️ glyph's source
 * @param {{path: string|null, line: number|null, author: string|null, card: string}[]} [input.cards]
 *   `needs-human` only — adjudication cards (scripts/lib/adjudication-cards.js) for the
 *   handoff's blocking threads, when `reason` is a dispute reason (agents-disagree,
 *   agents-may-disagree, reviewer-sustained); omitted/empty for every other reason, and
 *   for a dispute PR where no thread has a card yet (predates this feature, or never
 *   deadlocked into one) — the message degrades to the same plain handoff text either way
 * @param {string} [input.runUrl] failed workflow run link — used by `fixer-failed`
 *   (mirrors describeHandoff's own `state.handoff.runUrl` line), by `agents-may-disagree`
 *   (the standing review link — same field, different meaning), and by `blocked-run`
 *   (the run page). Not `blocked-run-expired` — GitHub deletes the run itself by then.
 * @param {number} [input.round] `no-op-round` only — the fix round that changed no code.
 * @param {string} [input.workflowName] `blocked-run`/`blocked-run-expired` only — the gated workflow's name
 * @param {string} [input.prTitle] `blocked-run`/`blocked-run-expired`/`review-digest`/`ready`/`needs-human` — omitted if unresolvable
 * @param {boolean} [input.reminder] `blocked-run` only — true once it's a re-ping, not the first notice
 * @param {{agent: string, verdict: 'findings'|'clean'|'error'|'done', url: string, at: string|number|Date}[]}
 *   [input.results] `review-digest` only — this tick's newly-detected sentinels for the PR, one
 *   Telegram message line each (subject to `maxLines`/severity-protected capping)
 * @param {number} [input.earlierCount] `review-digest` only — sentinels already notified for this
 *   PR in an earlier tick; rendered as a footer count, never repeated in `results`
 * @param {number} [input.maxLines] `review-digest` only — cap on rendered `results` lines (default 20)
 * @param {string} [input.branch] `law2-refine` only — the branch the refine session ran on
 * @param {string} [input.sessionId] `law2-refine` only — the LAW2 session id (companion docs)
 * @param {boolean} [input.capReached] `law2-refine` only — true for a non-convergent terminal round
 *   (residuals left, reviewer-round cap spent), false for a converged one (may still carry disputes)
 * @param {{reviewer: number, max: number}} [input.rounds] `law2-refine` only — reviewer rounds used/cap
 * @param {{id: string, path: string, line: number|null, severity: string, title: string}[]} [input.residuals]
 *   `law2-refine` only — open findings ranked severity-first, empty unless `capReached`
 * @param {{id: string, path: string, line: number|null, severity: string, title: string, rationale: string}[]} [input.disputes]
 *   `law2-refine` only — findings the caller rejected with a rationale (the companion's refine docs'
 *   dispositions schema) at any point in the session; `rationale` is the caller-authored plain-language
 *   card, already capped to 5 lines by that schema — passed through with its `\n` line breaks intact
 *   (not `oneLine()`-collapsed) since Telegram's HTML parse mode renders literal newlines fine
 * @returns {{text: string, parse_mode: 'HTML', shownKeys?: string[]}} `shownKeys` (`review-digest`
 *   only) is the `.key` of every `results` entry that actually made it into `text`, after both the
 *   line cap and the char-budget trim — the caller's source of truth for what to mark notified.
 */
export function buildTelegramMessage({
  kind, repo, prNumber, reason, risk, codexResult, ciConclusion, runUrl, workflowName, prTitle, reminder,
  results, earlierCount, maxLines, round,
  branch, sessionId, capReached, rounds, residuals, disputes,
  cards, applier, accepted, label,
  issueNumber, prUrl: loopPrUrl,
}) {
  const repoUrl = `https://github.com/${repo}`;
  const prUrl = prNumber != null ? `${repoUrl}/pull/${prNumber}` : null;
  const repoLink = `<a href="${esc(repoUrl)}">${esc(repo)}</a>`;
  const prLink = prUrl ? `<a href="${esc(prUrl)}">#${prNumber}</a>` : null;
  const issueLink = issueNumber != null ? `<a href="${esc(`${repoUrl}/issues/${issueNumber}`)}">#${issueNumber}</a>` : null;

  // Shared by `ready`/`needs-human` only — see the `<b>Risk:</b>` block below and
  // factGlyphRow's own doc comment for the fallback rule.
  // #144: whenever risk is elevated, its reasons are worth showing regardless of which
  // handoff reason fired (or whether one fired at all) — a size-threshold PR and a
  // protected-path PR both read `risk: medium/high` here, and only the reasons list tells
  // them apart. Previously gated on `reason === 'risk-requires-human'`, which hid this from
  // every `ready` PR and every other `needs-human` reason.
  const renderRiskBlock = () => {
    if (!risk?.level || risk.level === 'low') return [];
    const out = [`<b>Risk:</b> ${RISK_EMOJI[risk.level] ?? ''} ${esc(risk.level)}`];
    if (risk.reasons?.length) out.push(...risk.reasons.map((r) => `- ${esc(r)}`));
    return out;
  };

  // loop-* (the companion's dispatcher/babysitter): issueNumber links the *issue*, not a
  // PR — a loop-dispatched session is joined against an issue, and only `loop-done`
  // resolves to an actual PR (via `prUrl: loopPrUrl`, pulled straight from state.json's
  // `children`). Companion-only callers; the engine's own orchestrator never emits these.
  if (kind === 'loop-blocked') {
    return {
      text: capToTelegramLimit(`🟡 ${repoLink} ${issueLink} is blocked — needs a human: ${esc(reason ?? 'no detail recorded')}`),
      parse_mode: 'HTML',
    };
  }
  if (kind === 'loop-failed') {
    return {
      text: capToTelegramLimit(`🔴 ${repoLink} ${issueLink} — loop dispatch ended without a PR: ${esc(reason ?? 'no detail recorded')}. `
        + `Tagged <code>loop:failed</code>; needs a human to investigate before re-triage.`),
      parse_mode: 'HTML',
    };
  }
  if (kind === 'loop-done') {
    const where = loopPrUrl ? `<a href="${esc(loopPrUrl)}">a PR</a>` : 'a PR';
    return {
      text: capToTelegramLimit(`🟢 ${repoLink} ${issueLink} — loop dispatch opened ${where}.`),
      parse_mode: 'HTML',
    };
  }
  if (kind === 'loop-unknown') {
    return {
      text: capToTelegramLimit(`⚠️ ${repoLink} ${issueLink} — babysitter could not classify this dispatch's session: `
        + `${esc(reason ?? 'no detail recorded')}. Needs human investigation; claim left in place.`),
      parse_mode: 'HTML',
    };
  }

  // awe#7: the ai:managed opt-in ping — paired with orchestrate.js's `resolveOptinApplier`
  // fix, so an ignored (non-listed-human) applier gets the same visibility as an accepted
  // one, not just the PR comment.
  if (kind === 'opt-in') {
    const where = prLink ? `${prLink}${prTitle ? ` (${esc(prTitle)})` : ''}` : 'a PR';
    const text = accepted
      ? `🏷️ @${esc(applier)} enrolled ${repoLink} ${where} into automation.`
      : `🚫 @${esc(applier)} applied <code>${esc(label)}</code> on ${repoLink} ${where} but is not in `
        + `<code>policy.humans</code> — ignored.`;
    return { text: capToTelegramLimit(text), parse_mode: 'HTML' };
  }
  if (kind === 'dependabot-pr') {
    return {
      text: `🤖 ${repoLink} — new dependabot PR ${prLink}${prTitle ? ` (${esc(prTitle)})` : ''} — `
        + `excluded from orchestration, needs a human look.`,
      parse_mode: 'HTML',
    };
  }

  if (kind === 'blocked-run') {
    const where = prLink ? `PR ${prLink}${prTitle ? ` (${esc(prTitle)})` : ''}` : 'a run';
    const lead = reminder ? '⏰ Still blocked:' : '🟠';
    return {
      text: `${lead} ${repoLink} — <b>${esc(workflowName)}</b> on ${where} needs manual approval.\n`
        + `<a href="${esc(runUrl)}">Review and approve</a>`,
      parse_mode: 'HTML',
    };
  }
  if (kind === 'blocked-run-expired') {
    // No run link here (unlike blocked-run): GitHub deletes the run itself once it
    // expires unapproved, so its own page 404s — link the PR instead, when resolvable.
    const where = prLink ? `PR ${prLink}${prTitle ? ` (${esc(prTitle)})` : ''}` : 'a run';
    return {
      text: `⚫ ${repoLink} — <b>${esc(workflowName)}</b> on ${where} was never approved; `
        + `GitHub auto-deleted the run after 30 days unapproved.`,
      parse_mode: 'HTML',
    };
  }
  if (kind === 'review-digest') {
    const verdictWord = (v) => ({ findings: 'flagged findings', clean: 'clean, no findings', error: 'errored', done: 'finished' }[v] ?? v);
    const { shown, hiddenCount } = selectDigestResults(results, maxLines ?? DEFAULT_DIGEST_MAX_LINES);
    // Derived from the full `results`, not the capped `shown` — otherwise a hidden older
    // `findings`/`error` behind an all-`clean` displayed subset would make the digest's
    // lead emoji lie green.
    const worst = results.reduce((w, r) => (VERDICT_SEVERITY[r.verdict] < VERDICT_SEVERITY[w] ? r.verdict : w), results[0]?.verdict ?? 'clean');
    const where = prLink ? `PR ${prLink}${prTitle ? ` (${esc(prTitle)})` : ''}` : 'a PR';
    const thisYear = new Date().getUTCFullYear();
    const fmtDate = (at) => {
      const d = new Date(at);
      const opts = { day: '2-digit', month: 'short', timeZone: 'UTC' };
      if (d.getUTCFullYear() !== thisYear) opts.year = 'numeric';
      return d.toLocaleDateString('en-GB', opts);
    };
    const renderResultLine = (r) => `${VERDICT_EMOJI[r.verdict] ?? '🔎'} ${esc(r.agent)} ${esc(verdictWord(r.verdict))} · `
      + `${fmtDate(r.at)} — <a href="${esc(r.url)}">View</a>`;
    const header = [
      `${VERDICT_EMOJI[worst] ?? '🔎'} ${repoLink} ${where}`,
      `${results.length} new review result${results.length === 1 ? '' : 's'}`,
      '',
    ];
    const footer = (hidden) => {
      const out = [];
      if (hidden > 0) {
        out.push('', `…and ${hidden} older result${hidden === 1 ? '' : 's'} not shown — `
          + `<a href="${esc(prUrl)}">View all on the PR</a>`);
      }
      if (earlierCount > 0) {
        out.push('', `… ${earlierCount} earlier result${earlierCount === 1 ? '' : 's'} already reported — `
          + `<a href="${esc(prUrl)}">View all on the PR</a>`);
      }
      return out;
    };
    // Line count alone doesn't bound Telegram's 4096-char sendMessage limit — long
    // owner/repo names, PR titles, and comment/review URLs can blow the budget well
    // under `maxLines`. Trim the oldest non-error line first (mirrors selectDigestResults'
    // own error-protection), falling back to the oldest error only once nothing else is
    // left, until the fully-rendered message (header + lines + footer) fits.
    const trimmedShown = [...shown];
    const lineTexts = trimmedShown.map(renderResultLine);
    let extraHidden = 0;
    while (lineTexts.length > 0
      && [...header, ...lineTexts, ...footer(hiddenCount + extraHidden)].join('\n').length > TELEGRAM_MAX_CHARS) {
      let idx = trimmedShown.findLastIndex((r) => r.verdict !== 'error');
      if (idx === -1) idx = trimmedShown.length - 1;
      trimmedShown.splice(idx, 1);
      lineTexts.splice(idx, 1);
      extraHidden += 1;
    }
    const lines = [...header, ...lineTexts, ...footer(hiddenCount + extraHidden)];
    const text = capToTelegramLimit(lines.join('\n'));
    return { text, parse_mode: 'HTML', shownKeys: trimmedShown.map((r) => r.key) };
  }

  if (kind === 'law2-refine') {
    const where = repo ? `${repoLink} <b>${esc(branch)}</b>` : `<b>${esc(branch)}</b>`;
    const lead = capReached ? '🟠' : '🟡';
    const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    const status = capReached
      ? `hit its round cap (${rounds?.reviewer ?? '?'}/${rounds?.max ?? '?'}) with ${count(residuals.length, 'finding')} still open`
      : `converged, but ${count(disputes.length, 'finding')} rejected by the author`;
    const lines = [`${lead} LAW2 refine — ${where} ${status}`];
    // `id` (F<round>-<n>) lets a human cross-reference this ping against `refine
    // summary`/summary.md without matching on title text alone.
    const renderFinding = (f) => {
      const loc = f.line != null ? `${esc(f.path)}:${f.line}` : esc(f.path);
      return `- <b>${esc(f.severity)}</b> <code>${esc(f.id)}</code> ${loc} — ${esc(f.title)}`;
    };
    // Each list caps item count (LAW2_LIST_CAP) and each rationale caps its own length
    // (capFreeText) — but `path`/`title` stay unbounded, so a stuck session with many (or
    // just long) residuals/disputes can still blow the char budget before capToTelegramLimit's
    // last-resort trim gets a say. The Session id above is what actually survives that: it's
    // emitted first, so the trim can only ever eat this list, never that line (#200).
    const appendList = (heading, items) => {
      if (!items.length) return;
      lines.push('', `<b>${heading}:</b>`);
      for (const f of items.slice(0, LAW2_LIST_CAP)) {
        lines.push(renderFinding(f));
        if (f.rationale) lines.push(esc(capFreeText(f.rationale)));
      }
      if (items.length > LAW2_LIST_CAP) lines.push(`…and ${items.length - LAW2_LIST_CAP} more — see \`refine summary\``);
    };
    // Session id first (#200): it's the key a human needs to find the session dir,
    // and capToTelegramLimit trims the *tail* — an unbounded residual/
    // dispute list must only ever be able to eat itself, never this line.
    lines.push('', `Session: <code>${esc(sessionId)}</code>`);
    appendList('Residual', residuals);
    appendList('Disputed (rejected by author)', disputes);
    return { text: capToTelegramLimit(lines.join('\n')), parse_mode: 'HTML' };
  }

  if (kind === 'no-op-round') {
    return {
      text: `🔵 PR ${prLink} in ${repoLink} — fix round ${round} changed no code; the threads it `
        + `was dispatched for are resolved. Re-queued for review.`,
      parse_mode: 'HTML',
    };
  }
  if (kind === 'ready') {
    const lead = factGlyphRow({ codexResult, ciConclusion, riskLevel: risk?.level }) ?? '🟢';
    // Hardcoding "low risk" predates #144: `ai:ready` used to require risk.level === 'low'
    // by construction, so it was never anything else. Once the state machine stops
    // requiring that (issue #203), this line is what makes the sentence honest for a
    // clean/green/medium-or-high PR without any further message-building work there.
    const riskWord = esc(risk?.level ?? 'low');
    const lines = [`${lead} PR ${prLink} in ${repoLink} is ready to merge — clean review, green CI, ${riskWord} risk.`];
    // #210: a busy multi-repo chat otherwise shows nothing but "PR #N is ready to merge"
    // over and over — the title is what actually tells two notifications apart.
    if (prTitle) lines.push('', titleLine(prTitle));
    const riskBlock = renderRiskBlock();
    if (riskBlock.length) lines.push('', ...riskBlock);
    // #144: unlike the old fixed one-liner, this can now carry risk.reasons — an
    // unbounded list of matched filenames (see risk.js's `protected orchestration paths
    // changed: ${...join(', ')}`) — so it needs the same last-resort cap the needs-human
    // branch already has. An over-limit send is rejected outright, not truncated, by
    // Telegram, and orchestrate.js retries it forever undelivered.
    return { text: capToTelegramLimit(lines.join('\n')), parse_mode: 'HTML' };
  }
  if (kind === 'merged') {
    // ponytail: hook only — nothing pushes a 'merged' notify effect yet, since
    // auto-merge itself isn't implemented (policy.merge.auto_merge is inert, see
    // scripts/lib/gate.js). Wire the push site in scripts/lib/state.js once it is.
    return {
      text: `🟢 PR ${prLink} in ${repoLink} was auto-merged.`,
      parse_mode: 'HTML',
    };
  }

  // needs-human
  const needsHumanLead = factGlyphRow({ codexResult, ciConclusion, riskLevel: risk?.level }) ?? '🔴';
  const info = REASONS[reason] ?? { why: reason, scope: 'See the pinned comment for details.' };
  const lines = [
    `${needsHumanLead} PR ${prLink} in ${repoLink} needs a human`,
    // #210: same crowded-chat problem as `ready` above — the title is what tells two
    // "needs a human" pings apart at a glance.
    ...(prTitle ? ['', titleLine(prTitle)] : []),
    '',
    `<b>Why automation stopped:</b> ${esc(info.why)}`,
    `<b>Recommended scope:</b> ${esc(info.scope)}`,
  ];
  lines.push(...renderRiskBlock());
  // #200: runUrl is emitted before the unbounded cards block below, so capToTelegramLimit's
  // tail trim can only ever eat card text, never this link.
  if (runUrl) {
    // Same field, three meanings — see describeHandoff's identical branch in handoff.js.
    const label = reason === 'fixer-failed' ? 'Failed run'
      : reason === 'fixer-skipped' ? 'Skipped run' : 'Standing review';
    lines.push(`<b>${label}:</b> <a href="${esc(runUrl)}">${esc(runUrl)}</a>`);
  }
  // #165: lifts each deadlocked thread's plain-language adjudication card (the last one
  // written, per extractAdjudicationCard) straight into the message, so triage starts in
  // Telegram without opening GitHub first. `card` already contains its own "🧑‍⚖️ For the
  // human..." header line — esc() preserves its `\n` line breaks (HTML parse mode renders
  // literal newlines fine) without collapsing them the way a oneLine()-style helper would.
  if (cards?.length) {
    lines.push('', `<b>Open disagreement${cards.length === 1 ? '' : 's'} (${cards.length}):</b>`);
    for (const c of cards.slice(0, CARD_LIST_CAP)) {
      const loc = c.line != null ? `${esc(c.path)}:${c.line}` : esc(c.path ?? '(unknown path)');
      lines.push('', `<code>${loc}</code>`, esc(capFreeText(c.card)));
    }
    if (cards.length > CARD_LIST_CAP) lines.push('', `…and ${cards.length - CARD_LIST_CAP} more — see the PR's threads`);
  }
  return { text: capToTelegramLimit(lines.join('\n')), parse_mode: 'HTML' };
}

const TELEGRAM_TIMEOUT_MS = 10_000;

/**
 * Sends a pre-built Telegram message (see buildTelegramMessage). Resolves false on any
 * non-2xx, network failure, or stalled response — never throws, so a dead bot/unset
 * secrets can't take down whichever caller is trying to notify.
 * @param {{text: string, parse_mode: string}} message
 * @returns {Promise<boolean>}
 */
export async function sendTelegram(message) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.AI_ORCH_TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.AI_ORCH_TELEGRAM_CHAT_ID,
      text: message.text,
      parse_mode: message.parse_mode,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  }).catch((err) => {
    console.warn(`telegram: ${err.message}`);
    return null;
  });
  return res?.ok ?? false;
}
