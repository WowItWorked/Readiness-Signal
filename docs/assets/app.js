// Readiness Signal: entry point. Loads the two data files, keeps UI state in memory and the
// URL hash (no storage APIs), and re-renders by morphing the DOM in place so focus, caret and
// scroll position survive every update.

import * as M from './model.js';
import { renderApp, PAGE_TITLES } from './view.js';

const root = document.getElementById('app');
const live = document.getElementById('live');

let data = null;
let loadError = null;
let loading = true;
let ui = M.defaultUi(new Date());
let pendingScroll = null; // { id, land }: item to bring into view after the next render
let pendingFocus = null; // selector to focus after the next render
let copyTimer = 0;
let lastRoute = null;

// ---------------------------------------------------------------------------------------
// Rendering

const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-k') || n.id || null : null);
const sameType = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName;

function morphNode(a, b) {
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  for (const { name } of Array.from(a.attributes)) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of Array.from(b.attributes)) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  if (a.nodeName === 'INPUT') {
    // Typing updates state first, so a field the user is typing in already matches and is
    // left alone (focus and caret survive). A focused date field may hold a partial entry
    // whose value reads as '' until complete, so it is never overwritten while focused.
    const v = b.getAttribute('value') ?? '';
    const typingDate = a.type === 'date' && a === document.activeElement;
    if (!typingDate && a.value !== v) a.value = v;
    return;
  }
  morphChildren(a, b);
}

function morphChildren(from, to) {
  const next = Array.from(to.childNodes);
  const keyed = new Map();
  for (const c of from.childNodes) { const k = keyOf(c); if (k) keyed.set(k, c); }
  next.forEach((nk, j) => {
    const cur = from.childNodes[j] || null;
    const k = keyOf(nk);
    let m = null;
    if (k) {
      const c = keyed.get(k);
      if (c && sameType(c, nk)) { m = c; keyed.delete(k); }
    } else {
      for (let c = cur; c; c = c.nextSibling) {
        if (!keyOf(c) && sameType(c, nk)) { m = c; break; }
      }
    }
    if (m) {
      if (m !== cur) from.insertBefore(m, cur);
      morphNode(m, nk);
    } else {
      from.insertBefore(nk, cur);
    }
  });
  while (from.childNodes.length > next.length) from.removeChild(from.lastChild);
}

/** Render clock: the viewer's, or the pipeline's latest write if the viewer's runs behind. */
const clock = () => M.effectiveNow(data, new Date());

function render() {
  const html = renderApp({
    ui, data, now: clock(), error: loadError, loading,
  }).replace(/>\s+</g, '><');
  const t = document.createElement('template');
  t.innerHTML = html;
  morphChildren(root, t.content);
  root.classList.toggle('printing', !!ui.printMode);
  document.title = PAGE_TITLES[ui.page] || PAGE_TITLES.dashboard;
  // Items carry scroll-margin-top = sticky filter bar height, so both the browser's own
  // fragment scroll and scrollToItem() land the item just below the bar.
  const bar = root.querySelector('.fbar');
  root.style.setProperty('--fbar-h', `${bar ? Math.ceil(bar.getBoundingClientRect().height) : 0}px`);

  if (ui.pop) fitPopover();

  if (pendingFocus) {
    const sels = [].concat(pendingFocus);
    pendingFocus = null;
    const el = sels.map((s) => root.querySelector(s)).find(Boolean);
    if (el) el.focus();
  }
  if (pendingScroll && !loading) {
    const { id, land } = pendingScroll;
    pendingScroll = null;
    setTimeout(() => (land ? landOn(id) : scrollToItem(id)), 0);
  }
}

/**
 * Keep an open filter popover on screen. Sideways: a 300px popover under a filter near the
 * right edge (medium widths, wrapped bar) shifts left. Downwards: the popover's height is
 * capped in CSS to the room below the sticky bar; if the bar has not stuck yet, the page
 * scrolls just enough (at most until the bar sticks) to bring the popover's foot into view.
 */
function fitPopover() {
  const pop = root.querySelector('.fbar .pop');
  if (!pop) return;
  const vw = document.documentElement.clientWidth;
  if (!pop.classList.contains('export-pop') && getComputedStyle(pop.parentElement).position === 'relative') {
    const r = pop.getBoundingClientRect();
    const over = r.right - (vw - 8);
    if (over > 0) pop.style.left = `${-Math.min(over, Math.max(0, r.left - 8))}px`;
  }
  const bar = root.querySelector('.fbar');
  const below = pop.getBoundingClientRect().bottom + 8 - window.innerHeight;
  const room = bar ? bar.getBoundingClientRect().top : 0;
  if (below > 0 && room > 0) window.scrollBy(0, Math.min(below, room));
}

function scrollToItem(id, instant = false, focus = true) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'start', behavior: instant || reduce || document.hidden ? 'auto' : 'smooth' });
  if (!focus) return;
  const row = el.querySelector('.row');
  if (row) row.focus({ preventScroll: true });
}

const READER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'];

/**
 * A permalink opened from outside the page: jump straight to the item (no smooth scroll across
 * the whole archive), then hold it in view while the page settles. Web fonts that arrive late,
 * or anything else that shifts the layout, can move the item after the jump, and not every
 * browser keeps the scroll anchored. The hold repeats the jump when the fonts are ready, when
 * the page has loaded and when a background tab is first shown; it ends as soon as the reader
 * scrolls (wheel, touch, keys or the scrollbar), clicks or taps, and three seconds after the
 * page is visible.
 */
function landOn(id) {
  let holding = true;
  let at = null; // where the last jump left the page, to tell the reader's own scrolling apart
  const jump = (focus) => { scrollToItem(id, true, focus); at = window.scrollY; };
  const hold = () => { if (holding) jump(false); };
  const moved = () => { if (at !== null && Math.abs(window.scrollY - at) > 2) end(); };
  const settle = () => setTimeout(() => { hold(); end(); }, 3000);
  const shown = () => {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', shown);
    hold();
    settle();
  };
  function end() {
    holding = false;
    for (const t of READER_INPUT) window.removeEventListener(t, end, true);
    window.removeEventListener('scroll', moved);
    document.removeEventListener('visibilitychange', shown);
  }
  for (const t of READER_INPUT) window.addEventListener(t, end, { capture: true, passive: true });
  window.addEventListener('scroll', moved, { passive: true });
  jump(true);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(hold, () => {});
  if (document.readyState !== 'complete') window.addEventListener('load', hold, { once: true });
  if (document.hidden) document.addEventListener('visibilitychange', shown);
  else settle();
}

function set(patch) {
  ui = { ...ui, ...patch };
  render();
}

// ---------------------------------------------------------------------------------------
// Navigation

function setHash(h, replace = false) {
  const target = `#${h}`;
  lastRoute = target;
  if (location.hash === target) return;
  try {
    if (replace) history.replaceState(null, '', target);
    else history.pushState(null, '', target);
  } catch { location.hash = target; }
}

function go(page, preset, value) {
  if (!M.PAGES.includes(page)) page = 'dashboard';
  const patch = { page, pop: null, printMode: null };
  const clear = { secs: [], doms: [], srcs: [] };
  if (preset === 'day') patch.repTime = 'day';
  else if (preset === 'week') Object.assign(patch, { repTime: 'week' }, clear);
  else if (preset === 'exec') Object.assign(patch, { repTime: 'week' }, clear, { secs: ['executive_visibility'] });
  else if (preset === 'section' && M.SECTION_BY_KEY.has(value)) Object.assign(patch, { repTime: 'week' }, clear, { secs: [value] });
  else if (preset === 'domain' && M.DOMAIN_BY_KEY.has(value)) Object.assign(patch, { repTime: 'week' }, clear, { doms: [value] });
  else if (preset === 'latest' && data) {
    const le = M.latestEdition(data);
    if (le) {
      const win = M.revealWindow(+clock() - le.ts + M.REVEAL_SLACK);
      Object.assign(patch, win, clear);
      if (win.page === 'archive') Object.assign(patch, { archTime: `m-${M.monthKey(le.date)}`, q: '' });
    }
  }
  const changed = patch.page !== ui.page;
  setHash(patch.page);
  set(patch);
  window.scrollTo(0, 0);
  if (changed) announcePage();
}

/** Screen readers hear the new page after an in-page navigation (no reload happens). */
function announcePage() {
  announce(PAGE_TITLES[ui.page] || PAGE_TITLES.dashboard);
}

/** Item `id` is on the page and expanded. */
function isShown(id) {
  const el = document.getElementById(id);
  return !!el && el.classList.contains('open');
}

/**
 * Show item `id` expanded and bring it into view: in the smallest window that holds it, with
 * only the filters that would hide it cleared (M.revealPatch). If that view still does not show
 * it, the all-time archive with every filter and the search cleared, for this page load only.
 * `land`: a permalink opened from outside the page (see landOn).
 */
function reveal(id, push, land = false) {
  if (!data) return;
  const patch = M.revealPatch(data, id, ui, clock());
  if (!patch) return;
  if (push) setHash(id);
  pendingScroll = { id, land };
  set(patch);
  if (!isShown(id)) set(M.revealAllPatch(id, ui));
}

function readHash() {
  if (location.hash === lastRoute) return;
  lastRoute = location.hash;
  const r = M.parseHash(location.hash);
  if (r.id) {
    if (loading) return; // applied once the data arrives
    if (data && data.byId.has(r.id)) reveal(r.id, false);
    else set({ page: 'dashboard', pop: null });
    return;
  }
  const changed = r.page !== ui.page;
  set({ page: r.page, pop: null, printMode: null });
  if (changed) announcePage();
}

// ---------------------------------------------------------------------------------------
// Actions

function toggleItem(id) {
  set({ open: { ...ui.open, [id]: !M.isOpenId(ui.open, id) } });
}

function toggleIn(key, v) {
  const list = ui[key];
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function pick(f, v) {
  if (f === 'time') {
    if (ui.page === 'report') { if (M.REPORT_SPANS[v]) set({ repTime: v }); return; }
    if (v === 'all' || v === 'custom' || (data && data.months.includes(v.slice(2)))) set({ archTime: v });
    return;
  }
  const map = { section: ['secs', M.SECTION_BY_KEY], domain: ['doms', M.DOMAIN_BY_KEY], source: ['srcs', M.SOURCE_BY_KEY] };
  const [key, vocab] = map[f] || [];
  if (!key) return;
  if (!v) set({ [key]: [] });
  else if (vocab.has(v)) set({ [key]: toggleIn(key, v) });
}

function clearFilter(f) {
  if (f === 'time') set(ui.page === 'report' ? { repTime: 'day' } : { archTime: 'all' });
  else if (f === 'section') set({ secs: [] });
  else if (f === 'domain') set({ doms: [] });
  else if (f === 'source') set({ srcs: [] });
}

function closePop(refocus) {
  if (!ui.pop) return;
  const key = ui.pop;
  if (refocus) pendingFocus = `[data-act="pop"][data-key="${key}"]`;
  set({ pop: null });
}

function announce(text) {
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 30);
}

function copyText(key, text) {
  const active = document.activeElement;
  const fallback = () => {
    const t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.top = '0';
    t.style.left = '0';
    t.style.opacity = '0';
    t.style.fontSize = '16px';
    document.body.appendChild(t);
    t.select();
    try { t.setSelectionRange(0, text.length); } catch { /* older engines */ }
    try { document.execCommand('copy'); } catch { /* nothing more to try */ }
    t.remove();
    if (active && active.focus) active.focus({ preventScroll: true });
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else {
      fallback();
    }
  } catch {
    fallback();
  }
  clearTimeout(copyTimer);
  set({ copied: key });
  announce('Copied');
  copyTimer = setTimeout(() => set({ copied: null }), 1600);
}

function copyFor(id, kind) {
  const it = data && data.byId.get(id);
  if (!it) return;
  if (kind === 'q') copyText(`${id}:q`, it.validation_question);
  else if (kind === 'i') copyText(`${id}:i`, it.candidate_issue_statement);
  else if (kind === 'l') copyText(`${id}:l`, M.permalinkUrl(id));
}

function printAs(mode) {
  set({ printMode: mode === 'expanded' ? 'expanded' : 'collapsed', pop: null });
  setTimeout(() => window.print(), 150);
}

function endPrint() {
  if (!ui.printMode) return;
  pendingFocus = '.export-btn'; // the Export option that started the print no longer exists
  set({ printMode: null });
}

function toggleAll() {
  if (!data) return;
  const lm = M.listModel(data, ui, clock());
  set({ open: lm.allOpen ? {} : Object.fromEntries(lm.shown.map((i) => [i.id, true])) });
}

/**
 * Custom-range dates. From and To are independent (the range orders them); a value outside
 * MIN_DATE..today is ignored or clamped (M.acceptDate), so typing a year digit by digit never
 * rewrites the other field or the range.
 */
function setDate(which, value) {
  const v = M.acceptDate(value, M.todayEt(clock()));
  if (v && v !== ui[which]) set({ [which]: v });
}

// ---------------------------------------------------------------------------------------
// Events (delegated; no inline handlers)

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !root.contains(el)) return;
  const d = el.dataset;
  switch (d.act) {
    case 'nav':
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      go(d.page, d.preset, d.v);
      break;
    case 'reveal': reveal(d.id, true); break;
    case 'toggle': toggleItem(d.id); break;
    case 'pop': set({ pop: ui.pop === d.key ? null : d.key }); break;
    case 'closepop': closePop(el.classList.contains('done-btn')); break;
    case 'pick': pick(d.f, d.v || ''); break;
    case 'fclear': clearFilter(d.f); break;
    case 'clearall':
      // The button disappears with the filters; keep focus in the bar, on the control before it.
      pendingFocus = ui.page === 'archive' ? ['.search'] : ['[data-act="pop"][data-key="source"]'];
      set({ secs: [], doms: [], srcs: [], q: '' });
      break;
    case 'showall': {
      // The empty state goes; focus the section's first item that the cleared filters revealed.
      const sec = el.closest('section[id]');
      pendingFocus = [sec ? `#${sec.id} .row` : '', '[data-act="pop"][data-key="domain"]'].filter(Boolean);
      set({ doms: [], srcs: [] });
      break;
    }
    case 'skip': {
      e.preventDefault();
      const main = document.getElementById('main');
      if (main) main.focus();
      break;
    }
    case 'toggleall': toggleAll(); break;
    case 'print': printAs(d.mode); break;
    case 'copy': copyFor(d.id, d.kind); break;
    default: break;
  }
});

// Item rows (role=button) behave like native buttons: Enter acts on keydown, Space on keyup,
// and a held key does not auto-repeat the toggle.
const isRowKey = (e) => e.target.dataset && e.target.dataset.act === 'toggle';
const isSpace = (e) => e.key === ' ' || e.key === 'Spacebar';
root.addEventListener('keydown', (e) => {
  if (!isRowKey(e)) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!e.repeat) toggleItem(e.target.dataset.id);
  } else if (isSpace(e)) {
    e.preventDefault(); // no page scroll
  }
});
root.addEventListener('keyup', (e) => {
  if (isRowKey(e) && isSpace(e)) {
    e.preventDefault();
    toggleItem(e.target.dataset.id);
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Escape' || e.key === 'Esc') && ui.pop) {
    e.preventDefault();
    closePop(true);
  }
});

const onField = (e) => {
  const el = e.target;
  const act = el.dataset && el.dataset.act;
  if (act === 'q') { if (el.value !== ui.q) set({ q: el.value }); } else if (act === 'from' || act === 'to') setDate(act, el.value);
};
root.addEventListener('input', onField);
root.addEventListener('change', onField);
// A focused date field is never overwritten mid-entry (see morphNode); once it loses focus,
// re-render so it shows the value actually in use (an ignored partial entry, or a clamped date).
root.addEventListener('focusout', (e) => {
  if (e.target && e.target.type === 'date') setTimeout(render, 0);
});

window.addEventListener('hashchange', readHash);
window.addEventListener('popstate', readHash);
window.addEventListener('afterprint', endPrint);
if (window.matchMedia) {
  const mq = window.matchMedia('print');
  const onChange = (ev) => { if (!ev.matches) setTimeout(endPrint, 0); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

// ---------------------------------------------------------------------------------------
// Boot

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function boot() {
  const first = M.parseHash(location.hash);
  if (first.page) ui.page = first.page;
  else ui.page = 'report';
  lastRoute = location.hash;
  render();
  try {
    const [archive, runs] = await Promise.all([fetchJson('data/archive.json'), fetchJson('data/runs.json')]);
    data = M.prepare(archive, runs);
  } catch (err) {
    loadError = err;
    data = null;
    console.error('Readiness Signal: data load failed.', err);
  }
  loading = false;
  if (data) {
    // Custom-range defaults follow the render clock (it can be ahead of a slow viewer clock).
    const d = M.defaultUi(clock());
    ui = { ...ui, from: d.from, to: d.to };
  }
  // A permalink lands on its item whatever the default view would show (reveal falls back to
  // the unfiltered all-time archive if it has to); an unknown id opens the dashboard.
  const landing = first.id && data && data.byId.has(first.id) ? first.id : null;
  if (first.id && !landing) ui.page = 'dashboard';
  try {
    if (landing) reveal(landing, false, true);
    else render();
  } catch (err) {
    // Never leave the loading line (or a blank main) behind: fall back to the plain message.
    console.error('Readiness Signal: render failed.', err);
    loadError = err;
    data = null;
    pendingScroll = null;
    try { render(); } catch { /* the static masthead and boot line remain */ }
  }
}

boot();
