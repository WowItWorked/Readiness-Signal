// Readiness Signal: rendering. Pure string templates (no DOM access) so the escaping rules
// can be tested in Node. Every data-derived string goes through esc(); every href through
// model.safeHref (https:, our own mailto:, or an in-page #id; anything else renders as text).

import * as M from './model.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** An attribute-safe href, or '' when the value is not an allowed link. */
export const href = (h) => esc(M.safeHref(h));

const ICONS = [0, 1, 2, 3];

/** The four-square mechanism rail (decorative; the label carries the meaning). */
export function rail(mechKey) {
  const on = M.mechOf(mechKey).i;
  return `<span class="rail" aria-hidden="true">${ICONS.map((i) => `<span${i === on ? ' class="on"' : ''}></span>`).join('')}</span>`;
}

/** data-mech lets the stylesheet set the mechanism hue (--m-*) on this element and its contents. */
const mechAttr = (mechKey) => ` data-mech="${esc(mechKey)}"`;

const mechTag = (mechKey, cls = 'mech') => `<span class="${cls}"${mechAttr(mechKey)}>${rail(mechKey)}<span class="mech-label">${esc(M.mechOf(mechKey).label)}</span></span>`;

/** Decorative "quiet signal" for empty states: a flat line with one soft blip. */
const QUIET = '<svg class="quiet-sig" viewBox="0 0 104 22" aria-hidden="true" focusable="false"><path class="q-line" d="M2 16H38M66 16H102"/><path class="q-blip" d="M38 16C44 16 46 6 52 6S60 16 66 16"/><circle class="q-dot" cx="52" cy="6" r="2.25"/></svg>';

const navAttrs = (page, preset = '', v = '') => ` data-act="nav" data-page="${page}"${preset ? ` data-preset="${preset}"` : ''}${v ? ` data-v="${esc(v)}"` : ''}`;

// ---------------------------------------------------------------------------------------
// Masthead and footer

const NAV = [['dashboard', 'Dashboard'], ['report', 'Report'], ['archive', 'Archive'], ['about', 'About']];

function masthead(st) {
  const { ui, data, error, loading } = st;
  const latest = loading ? '&nbsp;' : error ? 'Unavailable' : esc(M.mastheadLatest(data));
  // The dot pulses (briefly) only when there is an edition to point at.
  const isLive = !loading && !error && !!data && !!M.latestEdition(data);
  const nav = ui.printMode ? '' : `
    <nav class="nav" aria-label="Primary">${NAV.map(([k, l]) => {
    const on = ui.page === k;
    return `<a href="#${k}"${navAttrs(k)}${on ? ' class="on" aria-current="page"' : ''}>${l}</a>`;
  }).join('')}</nav>`;
  return `<header class="mast" data-k="mast">
  ${ui.printMode ? '' : '<a class="skip" href="#main" data-act="skip" data-k="skip">Skip to content</a>'}
  <div class="mast-in">
    <div class="mast-top">
      <a class="brand" href="#dashboard"${navAttrs('dashboard')}>
        <span class="brand-bar" aria-hidden="true"></span>
        <span class="brand-text"><span class="brand-name">Readiness Signal</span><span class="brand-tag">Only what clears the bar. Silence when nothing does.</span></span>
      </a>
      <div class="mast-latest">
        <div class="mast-latest-k"><span class="dot${isLive ? ' live' : ''}" aria-hidden="true"></span>Last update</div>
        <div class="mast-latest-v">${latest}</div>
      </div>
    </div>${nav}
  </div>
</header>`;
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
// Dashboard

function dashRow(it, rule, area, extraCls = '') {
  return `<button type="button" class="dash-row${rule ? ' ruled' : ''}${extraCls}" data-act="reveal" data-id="${esc(it.item.id)}">
      ${mechTag(it.item.mechanism)}
      <span class="dash-claim">${esc(it.item.claim)}</span>
      ${area}
    </button>`;
}

/** Dashboard domain counts render as pills; an em dash (none) is a quiet, unfilled pill. */
const domCount = (n) => `<span class="dom-n${n === '—' ? ' zero' : ''}">${esc(n)}</span>`;

function dashboardMain(st) {
  const d = M.dashboard(st.data, st.now);
  const latest = d.latest
    ? `<header class="latest-head">
        <div class="latest-head-t"><span class="kicker">Last update</span><h2 class="h-21">${esc(d.latest.title)}</h2></div>
        <a class="small-link" href="#report"${navAttrs('report', 'latest')}>Open in the report</a>
      </header>
      ${d.latest.items.map((e, i) => dashRow(e, i > 0, `<span class="dash-sec">${esc(e.secLabel)}</span>`, ' latest-row')).join('')}`
    : `<header class="latest-head">
        <div class="latest-head-t"><span class="kicker">Last update</span><h2 class="h-21">None yet</h2></div>
      </header>
      <div class="dash-none">${QUIET}<p>No edition has been published yet. Runs at 06:00, 10:00, 14:00 and 18:00 ET publish only what clears the bar; a silent run is a result.</p></div>`;

  const board = d.board.map((col) => `<div class="board-col"${mechAttr(col.mech)}>
        <div class="board-head">
          ${mechTag(col.mech)}
          <div class="num-row"><span class="num-30">${col.n}</span><span class="num-desc">${esc(col.desc)}</span></div>
        </div>
        ${col.items.map((x) => `<button type="button" class="board-item" data-act="reveal" data-id="${esc(x.item.id)}">
          <span class="board-meta">${esc(x.meta)}</span>
          <span class="board-claim">${esc(x.item.claim)}</span>
        </button>`).join('')}
        ${col.n ? '' : '<span class="board-none">Nothing this week.</span>'}
      </div>`).join('');

  const secRows = d.secRows.map((r, i) => `<button type="button" class="sec-row${i ? ' ruled' : ''}"${navAttrs('report', 'section', r.key)}>
        <span class="badge badge-36 badge-${r.mark}" aria-hidden="true">${r.n}</span>
        <span class="sec-row-t"><span class="sec-row-title">${esc(r.title)}</span><span class="sec-row-last">${esc(r.last)}</span></span>
        <span class="sec-row-n">${r.count}</span>
      </button>`).join('');

  const domRows = d.domRows.map((r) => `<button type="button" class="dom-row" aria-label="${esc(r.name)}"${navAttrs('report', 'domain', r.key)}>
        <span class="dom-name">${esc(r.label)}</span>${domCount(r.n)}${domCount(r.act)}
      </button>`).join('');

  return `<main id="main" tabindex="-1" class="main dash" data-k="main-dashboard">
  <div class="title-row">
    <h1 class="h1">Dashboard</h1>
    ${d.asOf ? `<span class="as-of">${esc(d.asOf)}</span>` : ''}
  </div>

  <section class="card latest-card" aria-label="Last update">
    ${latest}
  </section>

  <section class="board-wrap" aria-labelledby="board-h">
    <div class="title-row">
      <h2 class="h-21" id="board-h">Last 7 days, by what each item asks</h2>
      <a class="small-link" href="#report"${navAttrs('report', 'week')}>${esc(d.weekLink)}</a>
    </div>
    <div class="board">${board}</div>
  </section>

  <div class="dash-two">
    <section class="card" aria-labelledby="secs-h">
      <header class="card-head"><h2 class="h-19" id="secs-h">Sections, last 7 days</h2><span class="sub-13">Open a section in the report.</span></header>
      ${secRows}
    </section>
    <section class="card" aria-labelledby="doms-h">
      <header class="card-head"><h2 class="h-19" id="doms-h">Domains, last 7 days</h2><span class="sub-13">Items carry several domains, so these overlap.</span></header>
      <div class="dom-cols" aria-hidden="true"><span>Domain</span><span>Items</span><span>Ask action</span></div>
      ${domRows}
    </section>
  </div>

  <a class="arch-link" href="#archive"${navAttrs('archive')}>
    <span class="arch-link-t"><span class="arch-link-h">Archive</span><span class="arch-link-s">${esc(d.archLine)}</span></span>
    <span class="arch-link-go">Browse the archive</span>
  </a>
</main>`;
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
  const { ui, data, now, base, showSec } = st;
  const screen = !ui.printMode;
  const open = M.isOpen(it, ui);
  const d = M.itemDetail(it, data);
  const permalink = `${base}#${it.id}`;
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

  const sources = d.sources.map((s) => `<div class="src-row">
          <div class="src-k"><span class="src-pub">${esc(s.pub)}</span><span class="src-cls">${esc(s.cls)}${s.date ? ` · ${esc(s.date)}` : ''}</span></div>
          ${s.href ? `<a class="src-link" href="${esc(s.href)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>` : `<span class="src-link nolink">${esc(s.title)}</span>`}
        </div>`).join('');

  const body = `<div class="body">
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

function listMain(st) {
  const { ui, data, now } = st;
  const lm = M.listModel(data, ui, now);
  const ctx = { ...st, showSec: lm.isArch };
  const mix = lm.mix.map((m) => `<div class="mix-cell"${mechAttr(m.mech)}>${mechTag(m.mech)}<div class="num-row"><span class="num-24">${m.n}</span><span class="num-desc">${esc(m.desc)}</span></div></div>`).join('');
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
    <div class="mix">${mix}</div>
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
      <h2 class="h-19">Why it exists</h2>
      <div class="prose">
        <p>An earlier version failed because every item looked the same. Nothing said what it wanted from the reader, and the bar for inclusion didn’t discriminate, so it turned into news.</p>
        <p>This version is judged by what it leaves out. It runs four times a day, at 06:00, 10:00, 14:00 and 18:00 ET. When nothing clears the bar, the run is silent, and silence is a result.</p>
      </div>
    </div>

    <div class="about-sec">
      <h2 class="h-19">Three entry tests</h2>
      <div class="tests">${tests}</div>
    </div>

    <div class="about-sec">
      <h2 class="h-19">Every item says what it wants</h2>
      <div class="about-col">
        <p class="prose-p">Each item carries one mechanism tag. The four squares mark which one, so the mix of an edition can be read without reading the claims.</p>
        <div class="mech-grid">${mechs}</div>
      </div>
    </div>

    <div class="about-sec">
      <h2 class="h-19">How an item is built</h2>
      <div class="prose">
        <p>Collapsed, an item is one line: the claim, stated as an assertion in about a dozen words; its domains; the class of its sources; and its mechanism.</p>
        <p>Expanded, it adds what the claim implies across the seven domains, a validation question you can paste to a program owner, issue language to use if the answer is no or unknown, and every backing source. Several sources on one item is a signal in itself.</p>
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
        <a class="live-row" href="#dashboard"${navAttrs('dashboard')}><span class="live-k">Dashboard</span><span class="live-v">The last update and the past week at a glance, by mechanism, section and domain.</span></a>
        <a class="live-row" href="#report"${navAttrs('report', 'day')}><span class="live-k">Report</span><span class="live-v">The last 24 hours, week or month, organised by the three sections. Filter, expand and export.</span></a>
        <a class="live-row" href="#archive"${navAttrs('archive')}><span class="live-k">Archive</span><span class="live-v">Everything ever published, by month, with search and a custom date range. Nothing is replaced.</span></a>
      </div>
    </div>
  </article>
</main>`;
}

// ---------------------------------------------------------------------------------------

/**
 * Whole app body. st = { ui, data, now, base, error, loading }.
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
