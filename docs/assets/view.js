// Readiness Signal: rendering. Pure string templates (no DOM access) so the escaping rules
// can be tested in Node. Every data-derived string goes through esc(); every href through
// model.safeHref (https:, our own mailto:, or an in-page #id; anything else renders as text).

import * as M from './model.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** An attribute-safe href, or '' when the value is not an allowed link. */
export const href = (h) => esc(M.safeHref(h));

/** data-mech lets the stylesheet set the mechanism hue (--m-*) on this element and its contents. */
const mechAttr = (mechKey) => ` data-mech="${esc(mechKey)}"`;

const mechTag = (mechKey, cls = 'mech') => `<span class="${cls}"${mechAttr(mechKey)}><span class="mech-label">${esc(M.mechOf(mechKey).label)}</span></span>`;

// The logo, from the owner's brand set (2026-10-06): a baseline that rises through the bar, the
// part above it in the brand green, drawn in a 284 x 94 box. favicon.svg is the same mark on navy.
const BRAND_MARK = '<svg class="brand-mark" viewBox="0 0 284 94" aria-hidden="true" focusable="false"><path class="bm-base" d="M0 68H96V44H122V94H0zM162 44H188V68H284V94H162z"></path><path class="bm-cap" d="M96 0H188V44H162V26H122V44H96z"></path></svg>';

// The masthead's chatter as level bars (owner, 2026-10-06: the line read as a heart monitor).
// Traffic rises from the masthead's foot, mostly well under a dashed bar laid on the nav row's top
// rule (y 22 of 66), and only the bursts that cross it light up above it, as in the logo. One
// period is 80 bars at a 6px pitch (480px), their heights a fixed seeded draw on a slow swell with
// three bursts (one stops short of the bar); <use> tiles the period to cover any width and the
// stylesheet scrolls one period at a time.
const BARS = (() => {
  let seed = 20261006;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const burst = { 13: 24, 14: 38, 15: 55, 16: 42, 17: 26, 42: 21, 43: 30, 44: 37, 45: 27, 46: 17, 60: 22, 61: 34, 62: 52, 63: 40, 64: 23 };
  let d = '';
  for (let i = 0; i < 80; i++) {
    const h = burst[i] ?? Math.round(7 + 5 * Math.sin((i / 80) * Math.PI * 6) + rnd() * 9);
    d += `M${i * 6 + 2} 66V${66 - h}`;
  }
  return d;
})();
const barTiles = [0, 480, 960, 1440, 1920].map((x) => `<use href="#mw-bars"${x ? ` x="${x}"` : ''}></use>`).join('');
const MAST_WAVE = `<div class="mast-wave" aria-hidden="true"><svg focusable="false"><defs><path id="mw-bars" d="${BARS}"></path><clipPath id="mw-above"><rect x="-10000" y="0" width="20000" height="22"></rect></clipPath></defs><line class="mw-bar" x1="0" y1="22" x2="100%" y2="22"></line><g class="mw-chatter"><g class="mw-dim">${barTiles}</g><g class="mw-hot" clip-path="url(#mw-above)">${barTiles}</g></g></svg></div>`;

/** Decorative "quiet signal" for empty states: a flat line with one soft blip. */
const QUIET = '<svg class="quiet-sig" viewBox="0 0 104 22" aria-hidden="true" focusable="false"><path class="q-line" d="M2 16H38M66 16H102"/><path class="q-blip" d="M38 16C44 16 46 6 52 6S60 16 66 16"/><circle class="q-dot" cx="52" cy="6" r="2.25"/></svg>';

const navAttrs = (page, preset = '', v = '') => ` data-act="nav" data-page="${page}"${preset ? ` data-preset="${preset}"` : ''}${v ? ` data-v="${esc(v)}"` : ''}`;

// ---------------------------------------------------------------------------------------
// Masthead and footer

const NAV = [['dashboard', 'Dashboard'], ['report', 'Report'], ['archive', 'Archive'], ['about', 'About']];

function masthead(st) {
  const { ui } = st;
  const nav = ui.printMode ? '' : `
    <nav class="nav" aria-label="Primary">${NAV.map(([k, l]) => {
    const on = ui.page === k;
    return `<a href="#${k}"${navAttrs(k)}${on ? ' class="on" aria-current="page"' : ''}>${l}</a>`;
  }).join('')}</nav>`;
  return `<header class="mast" data-k="mast">
  ${ui.printMode ? '' : '<a class="skip" href="#main" data-act="skip" data-k="skip">Skip to content</a>'}
  ${ui.printMode ? '' : MAST_WAVE}
  <div class="mast-in">
    <div class="mast-top">
      <a class="brand" href="#dashboard"${navAttrs('dashboard')}>${BRAND_MARK}<span class="brand-name">Readiness Signal</span><span class="brand-tag">Amplify the signal. Reduce the risk.</span></a>
      ${mastStatus(st)}
    </div>${nav}
  </div>
</header>`;
}

/**
 * One quiet line (owner change 2026-10-06, replacing "Last edition" and "Last checked"): when the
 * data last changed and when the next scheduled update is due. Nothing is guessed while loading;
 * on paper it is the full time of the data alone.
 */
function mastStatus(st) {
  const { ui, data, now, error, loading } = st;
  if (loading) return '<p class="mast-status" data-k="mast-status">&nbsp;</p>';
  const s = M.mastheadStatus(error ? null : data, now);
  const v = (x) => `<span class="ms-v">${esc(x)}</span>`;
  if (ui.printMode) return s.updatedFull ? `<p class="mast-status" data-k="mast-status">Updated ${v(s.updatedFull)}</p>` : '';
  const next = v(`${s.next} ET`);
  return `<p class="mast-status" data-k="mast-status">${s.updated ? `Updated ${v(s.updated)}<span class="ms-sep" aria-hidden="true"> · </span>Next ${next}` : `Next update ${next}`}</p>`;
}

const FOOTER = 'Public sources only: headlines and leads are referenced, never republished. Nothing here describes any institution’s control position; validation questions and issue language are generic starting points.';

const footer = () => `<footer class="foot" data-k="foot">${FOOTER}</footer>`;

// ---------------------------------------------------------------------------------------
// Messages (loading, load failure)

function message(page, title, body) {
  return `<main id="main" tabindex="-1" class="main" data-k="main-${page}-msg">
  <div class="card notice" role="status">
    <p class="notice-t">${title}</p>
    ${body ? `<p class="notice-b">${body}</p>` : ''}
  </div>
</main>`;
}

const loadingMain = (page) => `<main id="main" tabindex="-1" class="main" data-k="main-${page}-loading"><p class="loading">Loading the archive…</p></main>`;

const errorMain = (page) => message(page, 'The archive could not be loaded.',
  'The page itself is fine, but the published data did not arrive or could not be read. Reload to try again.');

// ---------------------------------------------------------------------------------------
// Dashboard (owner change 2026-10-06): the brief, then the panels behind it. Charts use the one
// navy ink; what an item asks is carried by labels and the mechanism tag, never by hue alone.

const cardHead = (id, title, sub) => `<header class="card-head">
      <h2 class="h-19" id="${id}">${esc(title)}</h2>${sub ? `<span class="sub-13">${esc(sub)}</span>` : ''}
    </header>`;

/** Tooltip text for an item mark: date, what it asks, and the claim. */
const itemTip = (it) => `${M.fmtDate(it.date)} · ${M.mechOf(it.mechanism).label}${it.backfilled ? ' · Backfilled' : ''}\n${it.claim}`;

/** On phones the domain grid keeps its last six months. */
const OLD_MONTHS = 6;
const oldCls = (k, n) => (k < n - OLD_MONTHS ? ' old' : '');

/** Month labels under a month-aligned chart: a short name, and the year where it starts or turns. */
function monthAxis(months, cls) {
  return `<div class="mx ${cls}" aria-hidden="true">${months.map((m) => `<span class="mx-m">${esc(m.label)}${m.year ? `<span class="mx-y">${esc(m.year)}</span>` : ''}</span>`).join('')}</div>`;
}

/** A reading's figure, its "of" set small: "13 of 14". */
const briefFig = (f) => `<span class="brief-fig">${esc(f).replace(' of ', '<span class="brief-of"> of </span>')}</span> `;

/**
 * The brief: readings side by side (the dashboard's, and the report's for its window). A reading
 * with a figure shows it large, its text reading on from it; one without is a plain sentence.
 */
function briefCard(brief, title = 'At a glance', id = 'brief-h') {
  const cells = brief.map((b) => `<div class="brief-cell" data-k="brief-${esc(b.key)}">
        <span class="kicker">${esc(b.kicker)}</span>
        <p class="brief-t${b.figure ? ' has-fig' : ''}">${b.figure ? briefFig(b.figure) : ''}${esc(b.text)}</p>
        ${b.sub ? `<p class="brief-s">${esc(b.sub)}</p>` : ''}
      </div>`).join('');
  return `<section class="card brief" aria-labelledby="${id}">
    <h2 class="sr-only" id="${id}">${esc(title)}</h2>
    <div class="brief-grid n${brief.length}">${cells}</div>
  </section>`;
}

/** One square of a unit chart, linking to its item: filled asks for action, open is awareness only. */
const unitSquare = (it, cls = '') => `<a class="u${M.asksForAction(it) ? '' : ' aw'}${cls}" href="${href(`#${it.id}`)}" tabindex="-1" data-tip="${esc(itemTip(it))}"></a>`;

const unitLegend = (extra = '') => `<div class="lg-row" aria-hidden="true"><span class="lg"><span class="u"></span>Asks for action</span><span class="lg"><span class="u aw"></span>Awareness only</span>${extra}</div>`;

function latestCard(d) {
  const rows = d.latest.map((it, i) => `<button type="button" class="lt${i ? ' ruled' : ''}" data-act="reveal" data-id="${esc(it.id)}">
        <span class="lt-meta">${mechTag(it.mechanism)}<span class="lt-when">${esc(M.fmtDate(it.date))}</span>${it.backfilled ? '<span class="meta-bf">Backfilled</span>' : ''}</span>
        <span class="lt-claim">${esc(it.claim)}</span>
      </button>`).join('');
  return `<section class="card dcard d-latest" aria-labelledby="lt-h">
    ${cardHead('lt-h', 'Latest additions', 'The newest items, from live editions or the historical backfill.')}
    ${rows || `<div class="dash-none">${QUIET}<p>Nothing published yet. Runs at 06:00, 10:00, 14:00 and 18:00 ET publish only what clears the bar; a silent run is a result.</p></div>`}
  </section>`;
}

function additionsCard(d) {
  const cols = d.additions.map((a) => `<div class="uc-col">${a.items.map((it) => unitSquare(it)).join('')}</div>`).join('');
  const rows = d.additions.map((a) => `<tr><th scope="row">${esc(a.name)}</th><td>${a.items.length}</td><td>${a.action}</td></tr>`).join('');
  const secs = d.sections.map((s) => `<span class="secs-i"><span class="badge badge-22 badge-${s.mark}" aria-hidden="true">${s.n}</span><span class="secs-t">${esc(s.title)}</span><span class="secs-n">${s.count}</span></span>`).join('');
  return `<section class="card dcard d-adds" aria-labelledby="add-h">
    ${cardHead('add-h', 'Additions by month', 'One square per item: filled where it asks for action, open where it resolves as awareness only.')}
    <div class="dcard-body">
      <div class="uc" aria-hidden="true">
        <div class="uc-cols">${cols}</div>
        ${monthAxis(d.months, 'uc-axis')}
      </div>
      ${unitLegend()}
      <table class="sr-only"><caption>Items added by month</caption><thead><tr><th scope="col">Month</th><th scope="col">Items</th><th scope="col">Ask for action</th></tr></thead><tbody>${rows}</tbody></table>
      ${d.beforeChart ? `<p class="dcard-note">${M.plural(d.beforeChart, 'earlier item')} not charted.</p>` : ''}
    </div>
    <div class="secs"><span class="kicker">By section, all time</span><div class="secs-list">${secs}</div></div>
  </section>`;
}

/**
 * A thread's timeline: its developments (`dots`, each { item, x, current? }) on a month axis of
 * `n` equal months, joined from first to latest. The current development, if any, is haloed.
 */
function threadLine(dots, n) {
  // Stretched to the card's width (preserveAspectRatio none), so every stroke is non-scaling and
  // each dot is a zero-length line with round caps: it stays round at any width.
  const NS = 'vector-effect="non-scaling-stroke"';
  const X = (x) => (x * 1000).toFixed(1);
  const seg = (cls, x, y1 = 11.99, y2 = 12.01) => `<line class="${cls}" x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" ${NS}/>`;
  const grid = Array.from({ length: n - 1 }, (_, k) => seg('th-grid', X((k + 1) / n), 2, 22)).join('');
  const xs = dots.map((p) => p.x);
  const span = xs.length > 1 ? `<line class="th-span" x1="${X(Math.min(...xs))}" y1="12" x2="${X(Math.max(...xs))}" y2="12" ${NS}/>` : '';
  const marks = dots.map((p) => {
    const x = X(p.x);
    const hole = M.asksForAction(p.item) ? '' : seg('th-hole', x);
    return `<a href="${href(`#${p.item.id}`)}" tabindex="-1" data-tip="${esc(itemTip(p.item))}">${p.current ? seg('th-halo', x) : ''}${seg('th-hit', x)}${seg('th-ring', x)}${seg('th-dot', x)}${hole}</a>`;
  }).join('');
  return `<svg class="th-svg" viewBox="0 0 1000 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">${grid}${span}${marks}</svg>`;
}

function threadsCard(d) {
  const n = d.months.length;
  const list = d.threads.map((t) => `<div class="th">
        <div class="th-top">
          <span class="th-n"><span class="th-num">${t.n}</span> developments</span>
          <span class="th-meta">${esc(`${M.fmtDate(t.first.date)} to ${M.fmtDate(t.latest.date)}${t.recent ? ` · ${t.recent} in the last 30 days` : ''}${t.domains.length ? ` · ${t.domains.join(', ')}` : ''}`)}</span>
        </div>
        ${threadLine(t.dots, n)}
        <button type="button" class="th-latest" data-act="reveal" data-id="${esc(t.latest.id)}">
          <span class="th-latest-k">Latest${mechTag(t.latest.mechanism)}</span>
          <span class="th-claim">${esc(t.latest.claim)}</span>
        </button>
      </div>`).join('');
  const more = d.threadCount > d.threads.length ? `<p class="dcard-note">${M.plural(d.threadCount - d.threads.length, 'more thread')} in the archive.</p>` : '';
  return `<section class="card dcard d-threads" aria-labelledby="th-h">
    ${cardHead('th-h', 'Developing threads', 'Stories that later items have materially updated, most recently active first. Filled dots ask for action.')}
    ${list ? `<div class="th-list">${list}</div>${monthAxis(d.months, 'th-axis')}${more}` : `<div class="dash-none">${QUIET}<p>No developing thread yet. A thread forms when an item materially updates an earlier one.</p></div>`}
  </section>`;
}

function asksCard(d) {
  const rows = d.asks.map((it, i) => `<button type="button" class="ask${i ? ' ruled' : ''}" data-act="reveal" data-id="${esc(it.id)}">
        <span class="ask-meta">${mechTag(it.mechanism)}<span class="ask-when">${esc(M.fmtDate(it.date))}</span></span>
        <span class="ask-q">${esc(it.validation_question)}</span>
        <span class="ask-c">${esc(it.claim)}</span>
      </button>`).join('');
  return `<section class="card dcard d-asks" aria-labelledby="ask-h">
    ${cardHead('ask-h', 'Questions to put to owners', 'The newest items that ask for action. Each question is paste-ready.')}
    ${rows || `<div class="dash-none">${QUIET}<p>No item asks for action yet. Every item so far resolves as awareness only.</p></div>`}
    ${d.asksTotal > d.asks.length ? `<footer class="dcard-foot">${M.plural(d.asksTotal, 'item')} in the archive ask for action. <a class="small-link" href="#archive"${navAttrs('archive')}>Browse the archive</a></footer>` : ''}
  </section>`;
}

function regulatoryCard(d) {
  const rows = d.regulatory.map((r) => `<li><button type="button" class="reg" data-act="reveal" data-id="${esc(r.item.id)}">
        <span class="reg-when">${esc(M.fmtDate(r.item.date))}</span>
        <span class="reg-t">${r.issuer ? `<span class="reg-who">${esc(r.issuer)}</span>` : ''}<span class="reg-c">${esc(r.item.claim)}</span></span>
      </button></li>`).join('');
  return `<section class="card dcard d-reg" aria-labelledby="reg-h">
    ${cardHead('reg-h', 'Regulatory direction', 'Where regulators and executives are signalling they are heading, newest first.')}
    ${rows ? `<ol class="reg-list">${rows}</ol>` : `<div class="dash-none">${QUIET}<p>No regulatory or executive signal has cleared the bar yet.</p></div>`}
    ${d.regulatoryTotal > d.regulatory.length ? `<footer class="dcard-foot"><a class="small-link" href="#archive"${navAttrs('archive', 'section', 'regulatory_trajectory')}>All ${d.regulatoryTotal} in the archive</a></footer>` : ''}
  </section>`;
}

const SLOT_STATE = {
  published: 'Published an edition', silent: 'Ran, silent', failed: 'Failed', missed: 'Did not run',
  due: 'Due now', later: 'Not yet due', off: 'Before runs began',
};

function barCard(d) {
  const b = d.bar;
  const step = (v, l) => `<div class="fn"><span class="fn-v">${esc(Number(v).toLocaleString('en-US'))}</span><span class="fn-l">${l}</span></div>`;
  const grid = b.grid.map((g) => `<tr><th scope="row"><span aria-hidden="true">${esc(g.label)}</span><span class="sr-only">${esc(g.name)}</span></th>${g.slots.map((s) => `<td><span class="slot slot-${s.state}" aria-hidden="true"></span><span class="sr-only">${SLOT_STATE[s.state]}</span></td>`).join('')}</tr>`).join('');
  const reading = d.brief.find((x) => x.key === 'bar');
  return `<section class="card dcard d-bar" aria-labelledby="bar-h">
    ${cardHead('bar-h', `The bar, last ${b.days} days`, 'From the run log: what the scheduled runs read, what got through, and whether each slot ran.')}
    <div class="dcard-body bar-body">
      <div class="funnel">${step(b.unseen, 'new headlines read')}${step(b.stage1, 'passed the first screen')}${step(b.tested, 'put to an entry test')}${step(b.cleared, 'cleared the bar')}</div>
      <div class="runs-wrap">
        <table class="runs">
          <caption class="sr-only">Scheduled runs by day and slot (ET)</caption>
          <thead><tr><th scope="col"><span class="sr-only">Day</span></th>${M.SLOT_HOURS.map((h) => `<th scope="col">${String(h).padStart(2, '0')}:00</th>`).join('')}</tr></thead>
          <tbody>${grid}</tbody>
        </table>
        <ul class="runs-key" aria-hidden="true">
          <li><span class="slot slot-published"></span>Published</li><li><span class="slot slot-silent"></span>Silent</li>
          <li><span class="slot slot-failed"></span>Failed</li><li><span class="slot slot-missed"></span>Did not run</li>
        </ul>
      </div>
      ${reading && reading.status ? `<p class="bar-note">${esc(reading.status)}</p>` : ''}
    </div>
  </section>`;
}

function dashboardMain(st) {
  const d = M.dashboard(st.data, st.now);
  return `<main id="main" tabindex="-1" class="main dash" data-k="main-dashboard">
  <div class="title-row start">
    <h1 class="h1">Dashboard</h1>
    ${d.scope ? `<span class="list-sub">${esc(d.scope)}</span>` : ''}
  </div>
  ${briefCard(d.brief)}
  <div class="dash-grid">
    ${latestCard(d)}
    ${additionsCard(d)}
    ${threadsCard(d)}
    ${asksCard(d)}
    ${regulatoryCard(d)}
    ${domainsCard(d)}
    ${barCard(d)}
  </div>
  <a class="arch-link" href="#archive"${navAttrs('archive')}>
    <span class="arch-link-t"><span class="arch-link-h">Archive</span><span class="arch-link-s">${esc(d.archLine)}</span></span>
    <span class="arch-link-go">Browse the archive</span>
  </a>
</main>`;
}

function domainsCard(d) {
  const { rows } = d.domains;
  const n = d.months.length;
  const head = d.months.map((m, k) => `<th scope="col" class="dm-m${oldCls(k, n)}"><span aria-hidden="true">${esc(m.label)}</span><span class="sr-only">${esc(m.name)}</span></th>`).join('');
  const body = rows.map((r) => `<tr class="${r.recent ? '' : 'dm-quiet'}">
        <th scope="row" class="dm-d">${esc(r.label)}</th>
        ${r.cells.map((c, k) => `<td class="dm-c${oldCls(k, n)}" data-tip="${esc(`${r.label}, ${d.months[k].name}: ${M.plural(c, 'item')}`)}"><span class="dmd s${Math.min(c, 4)}" aria-hidden="true"></span><span class="sr-only">${c}</span></td>`).join('')}
        <td class="dm-r"><span class="dm-n">${r.recent}</span><span class="dm-was">${r.prior} before</span></td>
      </tr>`).join('');
  return `<section class="card dcard d-doms" aria-labelledby="dom-h">
    ${cardHead('dom-h', 'Where the signal concentrates', `Items by domain and month; the last column compares the last ${M.RECENT_DAYS} days with the ${M.RECENT_DAYS} before. Items carry several domains, so rows overlap.`)}
    <div class="dcard-body">
      <table class="dm">
        <caption class="sr-only">Items by domain and month, and in the last ${M.RECENT_DAYS} days against the ${M.RECENT_DAYS} days before</caption>
        <thead><tr><th scope="col" class="dm-d"><span class="sr-only">Domain</span></th>${head}<th scope="col" class="dm-r">${M.RECENT_DAYS} days</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------------------
// Filter bar (report, archive)

function filterBar(lm, ui) {
  const btns = lm.filters.map((f) => {
    const open = ui.pop === f.key;
    const pop = !open ? '' : `<div class="pop" role="dialog" aria-label="${esc(f.label)}">
        <div class="pop-opts">${f.opts.map((o) => `<button type="button" class="opt${o.rule ? ' ruled' : ''}${o.sel ? ' sel' : ''}" data-act="pick" data-f="${f.key}" data-v="${esc(o.value)}" aria-pressed="${o.sel}">
            <span class="mark${f.round ? ' round' : ''}" aria-hidden="true"><span></span></span>
            <span class="opt-l">${esc(o.label)}</span>
            <span class="opt-n">${o.n === '' ? '' : o.n}</span>
          </button>`).join('')}</div>
        ${f.custom ? `<div class="pop-range">
          <input type="date" class="date-in" aria-label="From date" data-act="from" data-k="from" value="${esc(ui.from)}" min="${esc(lm.minDate)}" max="${esc(ui.to < lm.maxDate ? ui.to : lm.maxDate)}">
          <span class="pop-range-to">to</span>
          <input type="date" class="date-in" aria-label="To date" data-act="to" data-k="to" value="${esc(ui.to)}" min="${esc(ui.from > lm.minDate ? ui.from : lm.minDate)}" max="${esc(lm.maxDate)}">
        </div>` : ''}
        <div class="pop-foot">
          <button type="button" class="text-btn" data-act="fclear" data-f="${f.key}">${esc(f.clearLabel)}</button>
          <button type="button" class="done-btn" data-act="closepop">Done</button>
        </div>
      </div>`;
    return `<div class="fwrap" data-k="f-${f.key}">
      <button type="button" class="fbtn${f.active ? ' active' : ''}${open ? ' open' : ''}" data-act="pop" data-key="${f.key}" aria-expanded="${open}" aria-haspopup="dialog">
        <span class="fbtn-l">${esc(f.label)}</span><span class="fbtn-v">${esc(f.value)}</span><span class="chev-s" aria-hidden="true"></span>
      </button>${pop}
    </div>`;
  }).join('');

  const exportOpen = ui.pop === 'export';
  return `<section class="fbar" data-k="fbar" aria-label="Filters">
  ${ui.pop ? '<div class="scrim" data-act="closepop" data-k="scrim"></div>' : ''}
  <div class="fbar-in">
    ${btns}
    ${lm.isArch ? `<input type="search" class="search" data-act="q" data-k="search" aria-label="Search the archive" placeholder="Search claims and sources" value="${esc(ui.q)}" autocomplete="off" spellcheck="false">` : ''}
    ${lm.hasActive ? '<button type="button" class="clear-all" data-act="clearall" data-k="clearall">Clear filters</button>' : ''}
    <div class="fbar-right" data-k="fbar-right">
      ${lm.showToggleAll ? `<button type="button" class="toggle-all" data-act="toggleall" data-k="toggleall">${lm.toggleAllLabel}</button>` : ''}
      ${lm.showExport ? `<button type="button" class="export-btn" data-act="pop" data-key="export" data-k="export-btn" aria-expanded="${exportOpen}" aria-haspopup="dialog">Export<span class="chev-s" aria-hidden="true"></span></button>` : ''}
      ${exportOpen && lm.showExport ? `<div class="pop export-pop" role="dialog" aria-label="Export">
        <div class="export-sum"><span class="kicker">Export current selection</span><span class="export-sel">${esc(lm.selSummary)}</span></div>
        <button type="button" class="export-opt" data-act="print" data-mode="collapsed"><span class="export-opt-t">Collapsed summary</span><span class="export-opt-d">One line per item: mechanism, claim, domains, sources.</span></button>
        <button type="button" class="export-opt" data-act="print" data-mode="expanded"><span class="export-opt-t">Fully expanded</span><span class="export-opt-d">Every item with read-across, validation question, issue language and sources.</span></button>
      </div>` : ''}
    </div>
  </div>
</section>`;
}

// ---------------------------------------------------------------------------------------
// Items

/** `what` completes the accessible name ("Copy validation question") without changing the visible label. */
function copyBtn(ui, key, id, kind, label, what) {
  const on = ui.copied === key;
  return `<button type="button" class="copy-btn${on ? ' on' : ''}" data-act="copy" data-id="${esc(id)}" data-kind="${kind}">${on ? '<span class="copy-mark" aria-hidden="true"></span>Copied' : label}<span class="sr-only"> ${what}</span></button>`;
}

export function itemArticle(it, idx, st) {
  const { ui, data, now, showSec } = st;
  const screen = !ui.printMode;
  const open = M.isOpen(it, ui);
  const d = M.itemDetail(it, data);
  const permalink = M.permalinkUrl(it.id);
  const ticks = it.sources.map(() => '<span></span>').join('');

  const headRow = `<div class="row" role="button" tabindex="0" aria-expanded="${open}" data-act="toggle" data-id="${esc(it.id)}">
      ${mechTag(it.mechanism, 'mech row-mech')}
      <div class="row-claim">${esc(it.claim)}</div>
      <div class="row-meta">
        <div class="chips">${d.domainLabels.map((l) => `<span class="chip">${esc(l)}</span>`).join('')}</div>
        <div class="meta-line">
          ${showSec ? `<span class="meta-sec">${esc(d.secLabel)}</span>` : ''}
          ${d.srcClassLabel ? `<span>${esc(d.srcClassLabel)}</span>` : ''}
          <span class="ticks"><span class="tick-set" aria-hidden="true">${ticks}</span><span class="tick-n">${esc(d.srcCount)}</span></span>
          <span>${esc(M.whenShort(it.date, now))}</span>
          ${d.thread ? `<span class="meta-thr">Thread · ${d.thread.n}</span>` : ''}
          ${it.backfilled ? '<span class="meta-bf">Backfilled</span>' : ''}
        </div>
      </div>
      <div class="row-tog" aria-hidden="true"><span class="chev${open ? ' up' : ''}"></span></div>
    </div>`;

  if (!open) {
    return `<article id="${esc(it.id)}" class="item${idx ? ' ruled' : ''}"${mechAttr(it.mechanism)}>${headRow}</article>`;
  }

  const mail = M.safeHref(M.mailtoHref(it, permalink));
  // SPEC §7.2: "Update to: <earlier claim>" linking to the earlier item.
  const upd = d.updateOf
    ? `<p class="upd">Update to: ${d.updateOf.found
      ? `<a class="upd-link" href="${href(`#${d.updateOf.id}`)}">${esc(d.updateOf.claim)}</a>`
      : `<span class="upd-id">${esc(d.updateOf.id)}</span>`}</p>`
    : '';

  // Design's awareness resolution panel: full weight (same border and background as the
  // validation question panel), its own 8px rhythm and 15.5px rationale.
  const act = d.isAware
    ? `<div class="panel aware">
          <span class="panel-k">Why this resolves as awareness only</span>
          <p class="panel-why">${esc(it.awareness_rationale)}</p>
        </div>`
    : `<div class="panel">
          <div class="panel-h"><span class="panel-k">Validation question</span>${screen ? copyBtn(ui, `${it.id}:q`, it.id, 'q', 'Copy', 'validation question') : ''}</div>
          <p class="panel-q">${esc(it.validation_question)}</p>
          <span class="panel-f">Paste-ready</span>
        </div>
        <div class="panel dashed">
          <div class="panel-h"><span class="panel-k">Conditional candidate issue</span>${screen ? copyBtn(ui, `${it.id}:i`, it.id, 'i', 'Copy', 'issue language') : ''}</div>
          <p class="panel-lead">If the answer is no or unknown, consider this language:</p>
          <p class="panel-issue">“${esc(it.candidate_issue_statement)}”</p>
        </div>`;

  // Owner change 2026-10-06: an item in a thread shows the whole story (the dashboard's timeline,
  // this development haloed) and steps to the developments either side.
  const t = d.thread;
  const step = (x, k) => `<button type="button" class="thr-step" data-act="reveal" data-id="${esc(x.id)}">
          <span class="thr-step-k">${k} · ${esc(M.fmtDate(x.date))}${mechTag(x.mechanism)}</span>
          <span class="thr-step-c">${esc(x.claim)}</span>
        </button>`;
  const thread = t ? `<div class="b-thr">
        <div class="thr-head"><span class="kicker">Thread</span><span class="thr-meta">${esc(`Development ${t.at} of ${t.n} · ${M.fmtDate(t.first.date)} to ${M.fmtDate(t.latest.date)}`)}</span></div>
        <div class="thr-chart">${threadLine(t.dots, t.months.length)}${monthAxis(t.months, 'thr-axis')}</div>
        ${t.prev || t.next ? `<div class="thr-nav">${t.prev ? step(t.prev, 'Earlier') : ''}${t.next ? step(t.next, 'Later') : ''}</div>` : ''}
      </div>` : '';

  const sources = d.sources.map((s) => `<div class="src-row">
          <div class="src-k"><span class="src-pub">${esc(s.pub)}</span><span class="src-cls">${esc(s.cls)}${s.date ? ` · ${esc(s.date)}` : ''}</span></div>
          ${s.href ? `<a class="src-link" href="${esc(s.href)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>` : `<span class="src-link nolink">${esc(s.title)}</span>`}
        </div>`).join('');

  const body = `<div class="body${t ? ' has-thr' : ''}">
      <div class="b-disp">
        <span class="kicker">What it asks of you</span>
        <p class="asks">${esc(d.asks)}</p>
        ${upd}
      </div>
      <div class="b-read">
        <span class="kicker">Cross-domain read-across</span>
        <div class="read-list">${d.read.map((r) => `<div class="read-row"><span class="read-d">${esc(r.label)}</span><span class="read-t">${esc(r.text)}</span></div>`).join('')}</div>
        ${d.noRead ? `<span class="no-read">No material read-across: ${esc(d.noRead)}</span>` : ''}
      </div>
      <div class="b-act">${act}</div>
      ${thread}
      <div class="b-src">
        <div class="src-head"><span class="kicker">Sources · ${d.srcN}</span><span class="corrob">${esc(d.corrob)}</span></div>
        <div class="src-list">${sources}</div>
      </div>
      <div class="b-foot">
        <div class="perma">
          <span class="kicker">Permalink</span>
          <a class="perma-link" href="${href(`#${it.id}`)}">${esc(screen ? it.id : permalink)}</a>
          ${screen ? copyBtn(ui, `${it.id}:l`, it.id, 'l', 'Copy link', 'to this item') : ''}
        </div>
        ${screen && mail ? `<a class="email-btn" href="${esc(mail)}">Email this item</a>` : ''}
        ${it.backfilled ? '<p class="bf-note">Added by the historical backfill pass, not by a live edition.</p>' : ''}
      </div>
    </div>`;

  return `<article id="${esc(it.id)}" class="item open${idx ? ' ruled' : ''}"${mechAttr(it.mechanism)}>${headRow}${body}</article>`;
}

// ---------------------------------------------------------------------------------------
// Report / archive

function group(g, st) {
  const items = g.items.map((it, i) => itemArticle(it, i, st)).join('');
  const head = g.kind === 'section'
    ? `<header class="sec-head sec-head-${g.mark}">
        <div class="badge badge-40 badge-${g.mark}" aria-hidden="true">${g.n}</div>
        <div class="sec-head-in">
          <div class="sec-head-t"><h2 class="h-23">${esc(g.title)}</h2><span class="count">${esc(g.countLabel)}</span></div>
          <p class="entry"><span class="entry-k">Entry test</span>${esc(g.test)}</p>
        </div>
      </header>`
    : `<header class="month-head"><h2 class="h-23">${esc(g.title)}</h2><span class="count">${esc(g.countLabel)}</span></header>`;
  let empty = '';
  if (g.empty) {
    const e = g.empty;
    empty = `<div class="empty">
        <div class="empty-l">
          ${QUIET}
          <p class="empty-t">${esc(e.title)}</p>
          <p class="empty-b">${esc(e.body)}</p>
          ${e.hasHidden ? '<button type="button" class="text-btn" data-act="showall">Clear domain and source filters</button>' : ''}
        </div>
        ${e.last ? `<div class="empty-r">
          <span class="kicker">Last published in this section</span>
          <button type="button" class="last-btn" data-act="reveal" data-id="${esc(e.last.item.id)}"${mechAttr(e.last.item.mechanism)}>
            <span class="last-when">${esc(e.last.when)} · <span class="last-mech">${esc(e.last.mech)}</span></span>
            <span class="last-claim">${esc(e.last.item.claim)}</span>
          </button>
        </div>` : ''}
      </div>`;
  }
  const label = g.kind === 'section' ? `${g.title}` : g.title;
  return `<section id="${esc(g.anchor)}" class="card group" aria-label="${esc(label)}">${head}${items ? `<div>${items}</div>` : ''}${empty}</section>`;
}

/**
 * The archive navigator: every item by month, faded where the current selection leaves it out.
 * A month's label picks that month (and picks all time again once it is the selection).
 */
function archiveChartCard(c, ui) {
  const fadedAny = c.columns.some((col) => col.shown < col.items.length);
  const cols = c.columns.map((col) => `<div class="uc-col">${col.items.map((it) => unitSquare(it, c.on.has(it.id) ? '' : ' out')).join('')}</div>`).join('');
  const axis = c.columns.map((col) => {
    const v = `m-${col.key}`;
    const on = ui.archTime === v;
    const note = col.shown < col.items.length ? `, ${col.shown} in your selection` : '';
    return `<button type="button" class="mx-m mx-btn" data-act="pick" data-f="time" data-v="${on ? 'all' : v}" aria-pressed="${on}"${col.items.length ? '' : ' disabled'}>
        <span aria-hidden="true">${esc(col.label)}${col.year ? `<span class="mx-y">${esc(col.year)}</span>` : ''}</span>
        <span class="sr-only">${esc(`${col.name}: ${M.plural(col.items.length, 'item')}${note}`)}</span>
      </button>`;
  }).join('');
  return `<section class="card arch-chart" aria-labelledby="ac-h">
    ${cardHead('ac-h', 'The archive by month', 'One square per item: filled where it asks for action, open where it resolves as awareness only. Choose a month to see only that month.')}
    <div class="dcard-body">
      <div class="uc" aria-hidden="true"><div class="uc-cols">${cols}</div></div>
      <div class="mx uc-axis">${axis}</div>
      ${unitLegend(fadedAny ? '<span class="lg"><span class="u out"></span>Outside your selection</span>' : '')}
      ${c.before ? `<p class="dcard-note">${M.plural(c.before, 'earlier item')} not charted.</p>` : ''}
    </div>
  </section>`;
}

function listMain(st) {
  const { ui, data, now } = st;
  const lm = M.listModel(data, ui, now);
  const ctx = { ...st, showSec: lm.isArch };
  let lead = '';
  if (lm.brief) lead = briefCard(lm.brief, `At a glance: ${M.rangeLabel(ui)}`, 'rb-h');
  else if (lm.chart) lead = archiveChartCard(lm.chart, ui);
  let empty = '';
  if (lm.archiveEmpty) {
    empty = `<div class="card notice quiet">${QUIET}<p class="notice-t">Nothing published yet.</p><p class="notice-b">Every item that clears the bar is added here and stays searchable. Nothing is replaced.</p></div>`;
  } else if (lm.listEmpty) {
    empty = `<div class="card notice quiet">${QUIET}<p class="notice-t">Nothing in the archive matches.</p><p class="notice-b">Widen the time range, change the search, or clear the filters.</p></div>`;
  }
  const bar = ui.printMode ? '' : filterBar(lm, ui);
  return `${bar}<main id="main" tabindex="-1" class="main list" data-k="main-${ui.page}">
  ${lm.printMeta ? `<div class="print-meta">${esc(lm.printMeta)}</div>` : ''}
  <div class="summary">
    <div class="title-row start">
      <h1 class="h1">${lm.title}</h1>
      <span class="list-sub">${esc(lm.sub)}</span>
    </div>
    ${lead}
  </div>
  ${empty}
  ${lm.groups.map((g) => group(g, ctx)).join('')}
</main>`;
}

// ---------------------------------------------------------------------------------------
// About (SPEC §7.3)

function aboutMain() {
  const tests = M.SECTIONS.map((S) => `<div class="test-row">
          <span class="badge badge-36 badge-${S.mark}" aria-hidden="true">${S.n}</span>
          <div class="test-t"><span class="test-h">${esc(S.title)}</span><span class="test-b">${esc(S.test)}${S.n === 3 ? ' Most candidates fail this test, so the section is often empty.' : ''}</span></div>
        </div>`).join('');
  const mechs = M.MECHANISMS.map((m) => `<div class="mech-cell"${mechAttr(m.key)}>${mechTag(m.key)}<span class="mech-about">${esc(m.about)}</span></div>`).join('');
  return `<main id="main" tabindex="-1" class="main" data-k="main-about">
  <article class="card about">
    <div class="about-lead">
      <span class="kicker">About</span>
      <h1 class="about-h">A filter, not a feed.</h1>
      <p class="about-p">Readiness Signal is a triage digest for technology risk professionals. It reads widely so you don’t have to, and publishes only what changes what you should check, measure, cover, or be ready to answer.</p>
    </div>

    <div class="about-sec">
      <h2 class="h-19">Three entry tests</h2>
      <div class="tests">${tests}</div>
    </div>

    <div class="about-sec">
      <h2 class="h-19">Every item says what it wants</h2>
      <div class="about-col">
        <p class="prose-p">Each item carries one mechanism tag, named and coloured for what it asks, so the mix of an edition can be read without reading the claims.</p>
        <div class="mech-grid">${mechs}</div>
      </div>
    </div>

    <div class="about-sec">
      <h2 class="h-19">How an item is built</h2>
      <div class="prose">
        <p>Collapsed, an item is one line: the claim, stated as an assertion in about a dozen words; its domains; the class of its sources; and its mechanism.</p>
        <p>Expanded, it adds what the claim implies across the seven domains, a validation question you can paste to a program owner, issue language to use if the answer is no or unknown, and every backing source. Several sources on one item is a signal in itself.</p>
        <p>When a later item materially updates an earlier one, both belong to a thread, and the expanded item shows the whole story with the developments either side.</p>
      </div>
    </div>

    <div class="about-sec">
      <h2 class="h-19">How the charts read</h2>
      <div class="lgd-list">
        <div class="lgd"><span class="lgd-k" aria-hidden="true"><span class="u"></span><span class="u aw"></span></span><span class="lgd-t">One square per item: filled where it asks for action, open where it resolves as awareness only. The two carry the same weight.</span></div>
        <div class="lgd"><span class="lgd-k" aria-hidden="true"><svg class="lgd-thr" viewBox="0 0 64 16" focusable="false"><line class="lgd-line" x1="8" y1="8" x2="56" y2="8"/><circle class="lgd-dot" cx="8" cy="8" r="4.5"/><circle class="lgd-dot aw" cx="32" cy="8" r="4.5"/><circle class="lgd-dot" cx="56" cy="8" r="4.5"/></svg></span><span class="lgd-t">A thread: a story that later items have materially updated, each development a dot on its timeline.</span></div>
        <div class="lgd"><span class="lgd-k" aria-hidden="true"><span class="slot slot-published"></span><span class="slot slot-silent"></span><span class="slot slot-failed"></span><span class="slot slot-missed"></span></span><span class="lgd-t">Each scheduled run: published an edition, ran silent, failed, or did not run.</span></div>
        <div class="lgd"><span class="lgd-k" aria-hidden="true"><span class="dmd s1"></span><span class="dmd s2"></span><span class="dmd s4"></span></span><span class="lgd-t">Dot size counts items. Counts and sizes mean volume, never severity.</span></div>
      </div>
    </div>

    <div class="about-sec">
      <h2 class="h-19">What it is not</h2>
      <div class="prose">
        <p>It is not a risk rating. Nothing here is red, amber or green; the green mark is emphasis only and never means safe. Colours mark what an item asks of you, never how serious it is.</p>
        <p>It is not a threat feed or a news service, and it says nothing about any institution’s control position. The validation question is where that record starts, inside your own organisation.</p>
      </div>
    </div>

    <div class="about-sec">
      <h2 class="h-19">Where things live</h2>
      <div class="lives">
        <a class="live-row" href="#dashboard"${navAttrs('dashboard')}><span class="live-k">Dashboard</span><span class="live-v">A brief of what is building, where the signal concentrates and what the archive asks, with the threads, trends and run log behind it.</span></a>
        <a class="live-row" href="#report"${navAttrs('report', 'day')}><span class="live-k">Report</span><span class="live-v">The last 24 hours, week or month: a brief of the window, then its items by the three sections. Filter, expand and export.</span></a>
        <a class="live-row" href="#archive"${navAttrs('archive')}><span class="live-k">Archive</span><span class="live-v">Everything ever published, charted and listed by month, with search and a custom date range. Nothing is replaced.</span></a>
      </div>
    </div>
  </article>
</main>`;
}

// ---------------------------------------------------------------------------------------

/**
 * Whole app body. st = { ui, data, now, error, loading }.
 * `data` may be null while loading or after a failure; About never needs it.
 */
export function renderApp(st) {
  const { ui } = st;
  let main;
  if (ui.page === 'about') main = aboutMain();
  else if (st.loading) main = loadingMain(ui.page);
  else if (st.error || !st.data) main = errorMain(ui.page);
  else if (ui.page === 'report' || ui.page === 'archive') main = listMain(st);
  else main = dashboardMain(st);
  return `${masthead(st)}${main}${footer()}`;
}

export const PAGE_TITLES = { dashboard: 'Readiness Signal', report: 'Report · Readiness Signal', archive: 'Archive · Readiness Signal', about: 'About · Readiness Signal' };
