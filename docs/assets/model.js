// Readiness Signal: pure view-model logic (SPEC §7). No DOM, no storage, no clock reads:
// every function takes `now` explicitly so Node tests can pin time. Imported by view.js,
// app.js and tests/model.test.mjs.

export const TZ = 'America/New_York';
export const DAY = 864e5;

// ---------------------------------------------------------------------------------------
// Vocabulary (SPEC §7.1, §7.2)

export const SECTIONS = Object.freeze([
  {
    key: 'executive_visibility', n: 1, title: 'Executive Visibility', mark: 'solid',
    test: 'Could a director or executive credibly ask ‘what are we doing about this?’ unprompted?',
    empty: 'Nothing in range met the test of a question an executive might raise unprompted.',
  },
  {
    key: 'capability_shift', n: 2, title: 'Capability & Control Shift', mark: 'double',
    test: 'Has adversary capability changed, or has a control failed somewhere in a way that invalidates an assumption others rely on?',
    empty: 'No change in adversary capability or external control failure met the bar.',
  },
  {
    key: 'regulatory_trajectory', n: 3, title: 'Regulatory & Executive Trajectory', mark: 'dashed',
    test: 'Is this an early, soft signal — a speech, testimony, consultation or supervisory direction in the US, UK or EU, or a public statement by a leading bank executive — of where things are heading? Formal rules and exam notices are out of scope.',
    empty: 'Trajectory signals are early and soft, and most do not survive the entry test. An empty section is a result, not a gap.',
  },
]);

export const MECHANISMS = Object.freeze([
  {
    key: 'candidate_issue', i: 0, label: 'Candidate issue', short: 'Validate; raise if no',
    asks: 'Send the validation question to the owner. If the answer is no or unknown, raise the candidate issue.',
    about: 'Send the validation question. If the answer is no or unknown, raise the issue.',
  },
  {
    key: 'kri_kpi', i: 1, label: 'KRI / KPI', short: 'Check the indicator',
    asks: 'Confirm an indicator exists, is measured, and reaches someone who acts on it. If not, the issue language applies.',
    about: 'Confirm an indicator exists, is measured, and reaches someone who acts on it.',
  },
  {
    key: 'praf_coverage', i: 2, label: 'PRAF coverage', short: 'Confirm coverage',
    asks: 'Confirm the risk assessment framework represents this risk at all. If it does not, the issue language applies.',
    about: 'Confirm the risk assessment framework represents this risk at all.',
  },
  {
    key: 'awareness_only', i: 3, label: 'Awareness only', short: 'Resolved; know it',
    asks: 'Nothing to action. This is a complete resolution: know it, in case you are asked.',
    about: 'A complete resolution. Nothing to action; know it in case you’re asked.',
  },
]);

export const DOMAINS = Object.freeze([
  { key: 'cyber', label: 'Cyber' },
  { key: 'fraud', label: 'Fraud' },
  { key: 'ai', label: 'AI' },
  { key: 'data', label: 'Data' },
  { key: 'resilience', label: 'Resilience' },
  { key: 'third_party', label: 'Third party' },
  { key: 'risk_quantification', label: 'Risk quantification' },
]);

export const SOURCE_CLASSES = Object.freeze([
  { key: 'news', label: 'News' },
  { key: 'regulator', label: 'Regulator' },
  { key: 'standards_body', label: 'Standards body' },
  { key: 'industry_trade', label: 'Industry/trade' },
  { key: 'vendor_threat_research', label: 'Vendor/threat research' },
  { key: 'research_analysis', label: 'Research & analysis' },
]);

export const PAGES = Object.freeze(['dashboard', 'report', 'archive', 'about']);
export const REPORT_SPANS = Object.freeze({ day: 1, week: 7, month: 30 });

const byKey = (list) => new Map(list.map((x) => [x.key, x]));
export const SECTION_BY_KEY = byKey(SECTIONS);
export const MECH_BY_KEY = byKey(MECHANISMS);
export const DOMAIN_BY_KEY = byKey(DOMAINS);
export const SOURCE_BY_KEY = byKey(SOURCE_CLASSES);

export const sectionOf = (k) => SECTION_BY_KEY.get(k);
export const mechOf = (k) => MECH_BY_KEY.get(k);
export const domainLabel = (k) => (DOMAIN_BY_KEY.get(k) || { label: String(k) }).label;
export const sourceLabel = (k) => (SOURCE_BY_KEY.get(k) || { label: String(k) }).label;

/**
 * Item ids double as element ids, morph keys and URL fragments, so only the SPEC §3.2 format
 * passes (same pattern as pipeline/lib/enums.mjs ITEM_ID_RE). It can never collide with a page
 * name, a section/month anchor or an object-prototype member.
 */
export const SAFE_ID = /^RS-\d{6}-\d{4}-\d{2}$/;

/** Earliest date the custom range accepts; keyboard entry passes through years like 0202. */
export const MIN_DATE = '1990-01-01';

// ---------------------------------------------------------------------------------------
// Eastern-time formatting. Always America/New_York, never the viewer's zone (SPEC §4).

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONF = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');

let dtf = null;
function formatter() {
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }
  return dtf;
}

const toDate = (v) => (v instanceof Date ? v : new Date(v));

/** Wall-clock parts of an instant in ET. */
export function etParts(value) {
  const parts = {};
  for (const p of formatter().formatToParts(toDate(value))) parts[p.type] = p.value;
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour, minute: Number(parts.minute), second: Number(parts.second), weekday: parts.weekday,
  };
}

/** ET offset from UTC at an instant, in minutes (-240 EDT, -300 EST). */
export function etOffsetMinutes(value) {
  const d = toDate(value);
  const p = etParts(d);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** The instant of an ET wall-clock time. Calendar overflow (day 0, day 32) is normalised. */
export function etWallToDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = etOffsetMinutes(new Date(wall));
  let t = wall - off1 * 60000;
  const off2 = etOffsetMinutes(new Date(t));
  if (off2 !== off1) t = wall - off2 * 60000;
  return new Date(t);
}

/** 'HH:MM' in ET. */
export const hm = (v) => { const p = etParts(v); return `${pad(p.hour)}:${pad(p.minute)}`; };
/** 'Fri 2 Oct' in ET. */
export const dShort = (v) => { const p = etParts(v); return `${p.weekday} ${p.day} ${MON[p.month - 1]}`; };
/** 'Fri 2 Oct 2026, 14:00 ET' */
export const fmtFull = (v) => {
  const p = etParts(v);
  return `${p.weekday} ${p.day} ${MON[p.month - 1]} ${p.year}, ${pad(p.hour)}:${pad(p.minute)} ET`;
};
/** '2 Oct 2026' in ET. */
export const fmtDate = (v) => { const p = etParts(v); return `${p.day} ${MON[p.month - 1]} ${p.year}`; };
/** ET calendar date 'YYYY-MM-DD'. */
export const etDateKey = (v) => { const p = etParts(v); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
/** ET calendar month 'YYYY-MM'. */
export const monthKey = (v) => { const p = etParts(v); return `${p.year}-${pad(p.month)}`; };
/** 'October 2026' from 'YYYY-MM'. */
export const monthName = (k) => { const [y, m] = String(k).split('-').map(Number); return `${MONF[m - 1]} ${y}`; };
/** '2 Oct' from 'YYYY-MM-DD' (a calendar date, no zone involved). */
export const fmtDayMonth = (iso) => { const [, m, d] = String(iso).split('-').map(Number); return `${d} ${MON[m - 1]}`; };

/** Design's compact time: weekday and time inside six days, else day, month and time. */
export function whenShort(v, now) {
  const p = etParts(v);
  const t = `${pad(p.hour)}:${pad(p.minute)}`;
  return (+now - +toDate(v) < 6 * DAY) ? `${p.weekday} ${t}` : `${p.day} ${MON[p.month - 1]}, ${t}`;
}

export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * A custom-range date as typed or picked: null (ignore it) unless it is a real date on or after
 * MIN_DATE, so the partial years a keyboard entry passes through (0002, 0020, 0202) never reach
 * the state; dates after `maxDate` (today in ET) clamp to it. From and To are independent:
 * archiveRange and rangeLabel order them.
 */
export function acceptDate(value, maxDate) {
  if (!isIsoDate(value) || value < MIN_DATE) return null;
  return isIsoDate(maxDate) && value > maxDate ? maxDate : value;
}

/** ET midnight starting the given calendar date, plus `addDays`. */
export function etDayStart(iso, addDays = 0) {
  const [y, m, d] = iso.split('-').map(Number);
  return etWallToDate(y, m, d + addDays);
}

// ---------------------------------------------------------------------------------------
// URLs. Data is untrusted: only https: links, our own mailto: and in-page #ids survive.

export function safeHttps(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    return u.href;
  } catch {
    return '';
  }
}

export function safeHref(href) {
  if (typeof href !== 'string') return '';
  if (href.startsWith('#')) return SAFE_ID.test(href.slice(1)) ? href : '';
  if (href.startsWith('mailto:')) return /^mailto:[^\s<>"']*$/.test(href) ? href : '';
  return safeHttps(href);
}

// ---------------------------------------------------------------------------------------
// Data preparation. Anything malformed is dropped rather than rendered.

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : '');
const uniq = (list) => [...new Set(list)];

/** Lower-case, straight quotes, collapsed whitespace: makes search forgiving of typography. */
export function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function normSource(s, itemClass) {
  if (!s || typeof s !== 'object') return null;
  const url = str(s.url).trim();
  let publication = str(s.publication).trim();
  if (!publication) {
    try { publication = new URL(url).hostname; } catch { publication = 'Source'; }
  }
  return {
    publication,
    url,
    headline: str(s.headline).trim(),
    published: isIsoDate(s.published) ? s.published : '',
    source_class: SOURCE_BY_KEY.has(s.source_class) ? s.source_class : itemClass,
  };
}

function normItem(r) {
  if (!r || typeof r !== 'object') return null;
  const id = str(r.id).trim();
  if (!SAFE_ID.test(id)) return null;
  const ts = Date.parse(str(r.timestamp));
  if (!Number.isFinite(ts)) return null;
  if (!SECTION_BY_KEY.has(r.section) || !MECH_BY_KEY.has(r.mechanism)) return null;
  const claim = str(r.claim).trim();
  if (!claim) return null;
  const sourceClass = SOURCE_BY_KEY.has(r.source_class) ? r.source_class : '';
  const sources = arr(r.sources).map((s) => normSource(s, sourceClass)).filter(Boolean);
  const domains = uniq(arr(r.domains).filter((d) => DOMAIN_BY_KEY.has(d)));
  const interpretation = [];
  const seen = new Set();
  for (const x of arr(r.interpretation)) {
    if (!x || !DOMAIN_BY_KEY.has(x.domain) || seen.has(x.domain)) continue;
    const text = str(x.text).trim();
    if (!text) continue;
    seen.add(x.domain);
    interpretation.push({ domain: x.domain, text });
  }
  const classes = uniq([sourceClass, ...sources.map((s) => s.source_class)].filter(Boolean));
  const date = new Date(ts);
  const p = etParts(date);
  const it = {
    id,
    ts,
    date,
    year: p.year,
    month: `${p.year}-${pad(p.month)}`,
    section: r.section,
    mechanism: r.mechanism,
    claim,
    domains,
    source_class: sourceClass,
    classes,
    interpretation,
    validation_question: str(r.validation_question).trim(),
    candidate_issue_statement: str(r.candidate_issue_statement).trim(),
    awareness_rationale: str(r.awareness_rationale).trim(),
    sources,
    backfilled: r.backfilled === true,
    update_of: SAFE_ID.test(str(r.update_of)) ? r.update_of : null,
  };
  it.search = normText([
    claim,
    domains.map(domainLabel).join(' '),
    sources.map((s) => `${s.publication} ${s.headline}`).join(' '),
  ].join(' '));
  return it;
}

function normRun(r) {
  if (!r || typeof r !== 'object') return null;
  const slotTs = Date.parse(str(r.slot));
  if (!Number.isFinite(slotTs)) return null;
  const started = Date.parse(str(r.started_at));
  const finished = Date.parse(str(r.finished_at));
  const status = ['published', 'silent', 'failed'].includes(r.status) ? r.status : 'failed';
  return {
    run_id: str(r.run_id),
    slotTs,
    slot: new Date(slotTs),
    status,
    items: arr(r.items).filter((x) => typeof x === 'string'),
    startedTs: Number.isFinite(started) ? started : null,
    finishedTs: Number.isFinite(finished) ? finished : null,
  };
}

const mechIndex = (it) => MECH_BY_KEY.get(it.mechanism).i;
const secIndex = (it) => SECTION_BY_KEY.get(it.section).n;

/** Newest first; within an edition by mechanism, then section, then id. */
export const newestFirst = (x, y) => y.ts - x.ts || mechIndex(x) - mechIndex(y) || secIndex(x) - secIndex(y)
  || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * Normalise archive.json and runs.json. Throws when either file is not the expected shape
 * (the caller shows the plain load-failure message); drops individual malformed records.
 */
export function prepare(archive, runs) {
  if (!archive || typeof archive !== 'object' || !Array.isArray(archive.items)) {
    throw new Error('archive.json is not in the expected format');
  }
  if (!runs || typeof runs !== 'object' || !Array.isArray(runs.runs)) {
    throw new Error('runs.json is not in the expected format');
  }
  const byId = new Map();
  for (const raw of archive.items) {
    const it = normItem(raw);
    if (it && !byId.has(it.id)) byId.set(it.id, it);
  }
  const items = [...byId.values()].sort(newestFirst);
  const runList = runs.runs.map(normRun).filter(Boolean)
    .sort((a, b) => a.slotTs - b.slotTs || (a.finishedTs || 0) - (b.finishedTs || 0));
  const months = uniq(items.map((i) => i.month)).sort().reverse();
  const earliest = items.length ? new Date(Math.min(...items.map((i) => i.ts))) : null;
  return { items, byId, runs: runList, months, earliest };
}

export const emptyData = () => prepare({ items: [] }, { runs: [] });

// ---------------------------------------------------------------------------------------
// Editions and runs (SPEC §7.1: runs.json is the source of truth for edition counts)

/**
 * The clock the site renders against: the viewer's clock, or the newest thing the pipeline has
 * written if that is later (a viewer whose clock runs behind still sees the latest edition as
 * the latest 24 hours, and can pick its date in a custom range).
 */
export function effectiveNow(data, clock) {
  let t = +clock;
  if (!Number.isFinite(t)) t = 0;
  if (data) {
    for (const r of data.runs) t = Math.max(t, r.finishedTs ?? r.startedTs ?? r.slotTs);
    for (const i of data.items) if (!i.backfilled) t = Math.max(t, i.ts);
  }
  return new Date(t);
}

/** Latest run of any status (by slot), or null. */
export function latestRun(data) {
  return data.runs.length ? data.runs[data.runs.length - 1] : null;
}

/** Dashboard "As of": the latest run's finished_at (any status); null hides the line. */
export function asOf(data) {
  const r = latestRun(data);
  if (!r) return null;
  return new Date(r.finishedTs ?? r.startedTs ?? r.slotTs);
}

const byEditionOrder = (x, y) => secIndex(x) - secIndex(y) || mechIndex(x) - mechIndex(y)
  || (x.id < y.id ? -1 : 1);

/**
 * Latest edition = latest `published` run (its slot, its items). Fallback when no run has
 * published: the latest non-backfilled item timestamp. Null on day one.
 */
export function latestEdition(data) {
  for (let k = data.runs.length - 1; k >= 0; k--) {
    const r = data.runs[k];
    if (r.status !== 'published') continue;
    let items = r.items.map((id) => data.byId.get(id)).filter(Boolean);
    if (!items.length) items = data.items.filter((i) => !i.backfilled && i.ts === r.slotTs);
    return { ts: r.slotTs, date: r.slot, items: items.sort(byEditionOrder), run: r };
  }
  const live = data.items.filter((i) => !i.backfilled);
  if (!live.length) return null;
  const ts = Math.max(...live.map((i) => i.ts));
  return { ts, date: new Date(ts), items: live.filter((i) => i.ts === ts).sort(byEditionOrder), run: null };
}

/** Runs whose slot falls in [a, b) (null = open). A silent run is logged but is not an edition. */
export function runStats(data, range) {
  const [a, b] = range;
  const out = { total: 0, published: 0, silent: 0, failed: 0, applied: 0 };
  for (const r of data.runs) {
    if ((a != null && r.slotTs < a) || (b != null && r.slotTs >= b)) continue;
    out.total++;
    out[r.status]++;
  }
  out.applied = out.published + out.silent;
  return out;
}

// ---------------------------------------------------------------------------------------
// Ranges. A range is [startMs|null, endMs|null) with an exclusive end.
// Report windows have no upper bound so a viewer whose clock runs slightly behind the
// pipeline's still sees the latest edition.

export function reportRange(span, now) {
  const days = REPORT_SPANS[span] || 1;
  return [+now - days * DAY, null];
}

export function todayEt(now) { return etDateKey(now); }

export function archiveRange(ui, now) {
  const t = ui.archTime || 'all';
  if (t === 'all') return [null, null];
  if (t === 'custom') {
    let from = isIsoDate(ui.from) ? ui.from : todayEt(now);
    let to = isIsoDate(ui.to) ? ui.to : todayEt(now);
    if (from > to) [from, to] = [to, from];
    return [+etDayStart(from), +etDayStart(to, 1)];
  }
  const m = /^m-(\d{4})-(\d{2})$/.exec(t);
  if (!m) return [null, null];
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return [+etWallToDate(y, mo, 1), +etWallToDate(y, mo + 1, 1)];
}

export const inRange = (it, [a, b]) => (a == null || it.ts >= a) && (b == null || it.ts < b);

export function matchesQuery(it, q) {
  const n = normText(q);
  return !n || it.search.includes(n);
}

/** Section / domain / source predicates for a UI state (empty selection = all). */
export function predicates(ui) {
  const secs = ui.secs || [];
  const doms = ui.doms || [];
  const srcs = ui.srcs || [];
  const secOK = (i) => !secs.length || secs.includes(i.section);
  const domOK = (i) => !doms.length || i.domains.some((d) => doms.includes(d));
  const srcOK = (i) => !srcs.length || i.classes.some((c) => srcs.includes(c));
  return { secOK, domOK, srcOK, allOK: (i) => secOK(i) && domOK(i) && srcOK(i) };
}

// ---------------------------------------------------------------------------------------
// UI state

export function defaultUi(now) {
  const p = etParts(now);
  const from = etDateKey(etWallToDate(p.year, p.month - 2, 1, 12));
  return {
    page: 'dashboard', repTime: 'day', archTime: 'all', from, to: todayEt(now), q: '',
    secs: [], doms: [], srcs: [], open: {}, copied: null, pop: null, printMode: null,
  };
}

/** Parse a location hash: a page name, an item id, or nothing. */
export function parseHash(hash) {
  let h = String(hash || '');
  if (h.startsWith('#')) h = h.slice(1);
  try { h = decodeURIComponent(h); } catch { /* keep raw */ }
  if (!h || h === 'dashboard') return { page: 'dashboard' };
  if (PAGES.includes(h)) return { page: h };
  if (SAFE_ID.test(h)) return { id: h };
  return { page: 'dashboard' };
}

/** Which window should hold an item of this age (SPEC §7.2 reveal). */
export function revealWindow(age) {
  if (age <= DAY) return { page: 'report', repTime: 'day' };
  if (age <= 7 * DAY) return { page: 'report', repTime: 'week' };
  if (age <= 30 * DAY) return { page: 'report', repTime: 'month' };
  return { page: 'archive', archTime: 'all' };
}

/**
 * Permalink reveal: pick the report window (or the all-time archive) that holds the item,
 * clear only the filters that would hide it, and expand it. Null for an unknown id.
 */
export function revealPatch(data, id, ui, now) {
  const it = data.byId.get(id);
  if (!it) return null;
  const win = revealWindow(+now - it.ts);
  const patch = { ...win, open: { ...ui.open, [id]: true }, pop: null, printMode: null };
  if (win.page === 'archive' && ui.q && !matchesQuery(it, ui.q)) patch.q = '';
  if (ui.secs.length && !ui.secs.includes(it.section)) patch.secs = [];
  if (ui.doms.length && !it.domains.some((d) => ui.doms.includes(d))) patch.doms = [];
  if (ui.srcs.length && !it.classes.some((c) => ui.srcs.includes(c))) patch.srcs = [];
  return patch;
}

// ---------------------------------------------------------------------------------------
// Item detail (expanded view, email)

export function itemDetail(it, data) {
  const mech = MECH_BY_KEY.get(it.mechanism);
  const sec = SECTION_BY_KEY.get(it.section);
  const n = it.sources.length;
  const k = it.classes.length;
  const covered = new Set(it.interpretation.map((r) => r.domain));
  const earlier = it.update_of ? data.byId.get(it.update_of) : null;
  return {
    mechLabel: mech.label,
    asks: mech.asks,
    isAware: it.mechanism === 'awareness_only',
    secLabel: `0${sec.n} ${sec.title}`,
    domainLabels: it.domains.map(domainLabel),
    srcClassLabel: it.classes.map(sourceLabel).join(' + '),
    srcCount: plural(n, 'source'),
    srcN: n,
    corrob: n > 1 ? `Corroborated: ${n} sources across ${k === 1 ? '1 class' : `${k} classes`}` : 'Single source',
    read: it.interpretation.map((r) => ({ label: domainLabel(r.domain), text: r.text })),
    noRead: DOMAINS.filter((d) => !covered.has(d.key)).map((d) => d.label).join(' · '),
    sources: it.sources.map((s) => {
      let date = '';
      if (s.published) {
        date = fmtDayMonth(s.published);
        if (Number(s.published.slice(0, 4)) !== it.year) date += ` ${s.published.slice(0, 4)}`;
      }
      return {
        pub: s.publication,
        cls: sourceLabel(s.source_class || it.source_class),
        date,
        title: s.headline || s.publication,
        href: safeHttps(s.url),
      };
    }),
    updateOf: it.update_of ? { id: it.update_of, claim: earlier ? earlier.claim : '', found: !!earlier } : null,
  };
}

/**
 * Plain-text email body (design format; awareness items carry the rationale). CRLF lines.
 * `detail` trims only the source list, for the mailto length budget: 0 full, 1 without
 * headlines, 2 the primary source only, 3 sources left to the permalink. The claim, the
 * question and issue language (or the rationale) and the permalink are always kept.
 */
export function mailBody(it, link, detail = 0) {
  const mech = MECH_BY_KEY.get(it.mechanism);
  const sec = SECTION_BY_KEY.get(it.section);
  const lines = [
    it.claim, '',
    `Mechanism: ${mech.label}`,
    `Section: ${sec.title}`,
    `Domains: ${it.domains.map(domainLabel).join(', ')}`,
    '',
  ];
  if (it.mechanism === 'awareness_only') {
    lines.push('Why awareness only:', it.awareness_rationale, '');
  } else {
    lines.push('Validation question:', it.validation_question, '',
      'If the answer is no or unknown, consider this language:', `“${it.candidate_issue_statement}”`, '');
  }
  const n = it.sources.length;
  const srcLine = (s) => {
    const url = safeHttps(s.url);
    const head = s.headline && detail === 0 ? `${s.publication}: ${s.headline}` : s.publication;
    return `- ${head}${url ? ` ${url}` : ''}`;
  };
  if (detail >= 3) {
    lines.push(`Sources: ${n}, listed at the permalink.`);
  } else if (detail === 2) {
    lines.push('Sources:', srcLine(it.sources[0] || { publication: '' }));
    if (n > 1) lines.push(`- ${plural(n - 1, 'more source')} at the permalink`);
  } else {
    lines.push('Sources:', ...it.sources.map(srcLine));
  }
  lines.push('', `Permalink: ${link}`);
  return lines.join('\r\n');
}

/** RFC 3986 strict: also encodes ! ' ( ) * so the result is safe inside any attribute. */
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Longest mailto: URL the site emits. Chromium on Windows silently drops external-protocol
 * URLs over 2,048 characters and some mail clients truncate long ones, so the source list is
 * trimmed first (see mailBody `detail`) to stay inside the budget.
 */
export const MAILTO_BUDGET = 2000;

export function mailtoHref(it, link) {
  let href = '';
  // Last resort (4): the subject carries the item id; the claim still opens the body.
  for (let detail = 0; detail <= 4; detail++) {
    const subject = enc(`Readiness Signal: ${detail < 4 ? it.claim : it.id}`);
    href = `mailto:?subject=${subject}&body=${enc(mailBody(it, link, Math.min(detail, 3)))}`;
    if (href.length <= MAILTO_BUDGET) break;
  }
  return href;
}

// ---------------------------------------------------------------------------------------
// Dashboard (design renderVals, page === 'dashboard')

export function dashboard(data, now) {
  const le = latestEdition(data);
  const weekStart = +now - 7 * DAY;
  const wk = data.items.filter((i) => i.ts >= weekStart);
  const isLatest = (i) => !!le && i.ts === le.ts && !i.backfilled;
  const exec = wk.filter((i) => i.section === 'executive_visibility').map((i) => ({
    item: i,
    isNew: isLatest(i),
    when: isLatest(i) ? `Latest edition · ${hm(i.date)}` : whenShort(i.date, now),
  }));
  const board = MECHANISMS.map((m) => {
    const list = wk.filter((i) => i.mechanism === m.key)
      .sort((x, y) => (x.section === 'executive_visibility' ? 0 : 1) - (y.section === 'executive_visibility' ? 0 : 1)
        || y.ts - x.ts);
    return {
      mech: m.key, label: m.label, desc: m.short, n: list.length,
      items: list.map((i) => ({ item: i, meta: `${whenShort(i.date, now)} · Section ${secIndex(i)}` })),
    };
  });
  const secRows = SECTIONS.map((S) => {
    const n = wk.filter((i) => i.section === S.key).length;
    const last = data.items.find((i) => i.section === S.key);
    return {
      key: S.key, n: S.n, title: S.title, mark: S.mark, count: n,
      last: `${n ? '' : 'Quiet this week · '}Last published ${last ? dShort(last.date) : 'never'}`,
    };
  });
  const domRows = DOMAINS.map((d) => {
    const l = wk.filter((i) => i.domains.includes(d.key));
    const act = l.filter((i) => i.mechanism !== 'awareness_only').length;
    return {
      key: d.key, label: d.label, n: l.length || '—', act: act || '—',
      name: `${d.label}: ${plural(l.length, 'item')}, ${act} ask action`,
    };
  });
  const asof = asOf(data);
  // "Nothing cleared the test" only when a run actually applied it this week (as the report does).
  const weekRuns = runStats(data, [weekStart, null]);
  return {
    asOf: asof ? `As of ${fmtFull(asof)}` : '',
    execNone: weekRuns.applied
      ? 'Nothing cleared the Executive Visibility test this week.'
      : 'Nothing published this week. No run in the last 7 days has applied the entry test yet.',
    latest: le ? {
      title: `${dShort(le.date)}, ${hm(le.date)} ET · ${plural(le.items.length, 'item')}`,
      items: le.items.map((i) => ({ item: i, secLabel: `0${secIndex(i)} ${SECTION_BY_KEY.get(i.section).title}` })),
      window: revealWindow(+now - le.ts),
    } : null,
    exec,
    weekCount: wk.length,
    weekLink: wk.length ? `All ${plural(wk.length, 'item')} in the report` : 'Open the report',
    board,
    secRows,
    domRows,
    archLine: data.items.length
      ? `${plural(data.items.length, 'item')} published since ${fmtDate(data.earliest)}. Nothing is replaced; everything stays searchable.`
      : 'Nothing published yet. Every item that clears the bar stays here, searchable; nothing is replaced.',
  };
}

/** Masthead "Latest edition" value. */
export function mastheadLatest(data) {
  const le = data ? latestEdition(data) : null;
  return le ? fmtFull(le.date) : 'None yet';
}

// ---------------------------------------------------------------------------------------
// Report and archive (design renderVals, isRep || isArch)

const REP_LABEL = { day: 'last 24 hours', week: 'last 7 days', month: 'last 30 days' };
const REP_VALUE = { day: '24 hours', week: '7 days', month: '30 days' };

export function rangeLabel(ui) {
  if (ui.page === 'archive') {
    if (ui.archTime === 'custom') {
      let [a, b] = [ui.from, ui.to];
      if (a > b) [a, b] = [b, a];
      if (a.slice(0, 4) !== b.slice(0, 4)) return `${fmtDayMonth(a)} ${a.slice(0, 4)} – ${fmtDayMonth(b)} ${b.slice(0, 4)}`;
      return `${fmtDayMonth(a)} – ${fmtDayMonth(b)}`;
    }
    if (ui.archTime && ui.archTime.startsWith('m-')) return monthName(ui.archTime.slice(2));
    return 'all time';
  }
  return REP_LABEL[ui.repTime] || REP_LABEL.day;
}

function runsPhrase(rs) {
  if (!rs.total) return 'no runs in this period';
  let s = `from ${rs.published} of ${plural(rs.total, 'run')}`;
  if (rs.silent) s += `, ${rs.silent} silent`;
  if (rs.failed) s += `, ${rs.failed} failed`;
  return s;
}

/** Empty-section copy. "Nothing cleared the bar" only when a run actually applied the test. */
function emptySection(S, rs, label) {
  if (rs.applied) {
    return {
      title: `Nothing cleared the bar in the ${label}.`,
      body: `${S.empty} The entry test was applied in ${plural(rs.applied, 'run')}.`,
    };
  }
  return {
    title: `Nothing published in the ${label}.`,
    body: rs.failed
      ? `No run in this period completed the entry test (${plural(rs.failed, 'failed run')}).`
      : 'No run in this period has applied the entry test yet.',
  };
}

export function listModel(data, ui, now) {
  const isRep = ui.page === 'report';
  const isArch = ui.page === 'archive';
  const q = isArch ? normText(ui.q) : '';
  const qOK = (i) => !q || i.search.includes(q);
  const range = isArch ? archiveRange(ui, now) : reportRange(ui.repTime, now);
  const inTime = data.items.filter((i) => inRange(i, range) && qOK(i));
  const { secOK, domOK, srcOK, allOK } = predicates(ui);
  const shown = inTime.filter(allOK);
  const rs = runStats(data, range);
  const label = rangeLabel(ui);
  const printing = !!ui.printMode;

  let groups;
  if (isRep) {
    groups = SECTIONS.filter((S) => !ui.secs.length || ui.secs.includes(S.key)).map((S) => {
      const list = shown.filter((i) => i.section === S.key);
      const hidden = inTime.filter((i) => i.section === S.key).length - list.length;
      const last = range[0] == null ? null : data.items.find((i) => i.section === S.key && i.ts < range[0]);
      const none = emptySection(S, rs, label);
      return {
        kind: 'section', key: S.key, anchor: `section-${S.n}`, n: S.n, title: S.title, test: S.test, mark: S.mark,
        countLabel: list.length ? plural(list.length, 'item') : 'None published',
        items: list,
        empty: list.length ? null : {
          title: hidden ? 'Nothing here matches your filters.' : none.title,
          body: hidden
            ? `${plural(hidden, 'item')} in this section ${hidden === 1 ? 'sits' : 'sit'} outside your domain or source selection.`
            : none.body,
          hasHidden: hidden > 0,
          last: last && !hidden ? {
            item: last, when: `${dShort(last.date)}, ${hm(last.date)}`, mech: MECH_BY_KEY.get(last.mechanism).label,
          } : null,
        },
      };
    });
  } else {
    const keys = uniq(shown.map((i) => i.month));
    groups = keys.map((k) => {
      const list = shown.filter((i) => i.month === k);
      return {
        kind: 'month', key: k, anchor: `month-${k}`, title: monthName(k),
        countLabel: plural(list.length, 'item'), items: list, empty: null,
      };
    });
  }

  const row = (value, label2, n, sel, rule) => ({ value, label: label2, n, sel, rule });
  const cnt = (pred) => inTime.filter(pred).length;
  const timeOpts = isRep
    ? Object.keys(REPORT_SPANS).map((k, idx) => {
      const r = reportRange(k, now);
      return row(k, cap(REP_LABEL[k]), data.items.filter((it) => inRange(it, r) && allOK(it)).length, ui.repTime === k, idx > 0);
    })
    : [['all', 'All time'], ...data.months.map((m) => [`m-${m}`, monthName(m)]), ['custom', 'Custom range']]
      .map(([k, l], idx) => {
        if (k === 'custom') return row(k, l, '', ui.archTime === k, idx > 0);
        const r = archiveRange({ ...ui, archTime: k }, now);
        return row(k, l, data.items.filter((it) => inRange(it, r) && allOK(it) && qOK(it)).length, ui.archTime === k, idx > 0);
      });
  const timeVal = isRep ? REP_VALUE[ui.repTime] || REP_VALUE.day
    : ui.archTime === 'all' ? 'All' : label;
  const multiVal = (sel, labels) => (!sel.length ? 'All' : sel.length === 1 ? labels[0] : `${sel.length} selected`);
  const secNames = SECTIONS.filter((S) => ui.secs.includes(S.key)).map((S) => S.title);
  const domNames = DOMAINS.filter((d) => ui.doms.includes(d.key)).map((d) => d.label);
  const srcNames = SOURCE_CLASSES.filter((c) => ui.srcs.includes(c.key)).map((c) => c.label);

  const filters = [
    {
      key: 'time', label: 'Time', value: timeVal, round: true,
      active: isRep ? ui.repTime !== 'day' : ui.archTime !== 'all',
      opts: timeOpts, custom: isArch && ui.archTime === 'custom',
      clearLabel: isRep ? 'Reset to 24 hours' : 'Reset to all time',
    },
    {
      key: 'section', label: 'Section', value: multiVal(ui.secs, secNames), active: ui.secs.length > 0,
      opts: [row('', 'All sections', '', !ui.secs.length, false),
        ...SECTIONS.map((S) => row(S.key, `${S.n} ${S.title}`, cnt((i) => i.section === S.key && domOK(i) && srcOK(i)), ui.secs.includes(S.key), true))],
      clearLabel: 'Clear',
    },
    {
      key: 'domain', label: 'Domain', value: multiVal(ui.doms, domNames), active: ui.doms.length > 0,
      opts: [row('', 'All domains', '', !ui.doms.length, false),
        ...DOMAINS.map((d) => row(d.key, d.label, cnt((i) => i.domains.includes(d.key) && secOK(i) && srcOK(i)), ui.doms.includes(d.key), true))],
      clearLabel: 'Clear',
    },
    {
      key: 'source', label: 'Source', value: multiVal(ui.srcs, srcNames), active: ui.srcs.length > 0,
      opts: [row('', 'All sources', '', !ui.srcs.length, false),
        ...SOURCE_CLASSES.map((c) => row(c.key, c.label, cnt((i) => i.classes.includes(c.key) && secOK(i) && domOK(i)), ui.srcs.includes(c.key), true))],
      clearLabel: 'Clear',
    },
  ];

  const hasActive = ui.secs.length + ui.doms.length + ui.srcs.length > 0 || (isArch && !!q);
  const allOpen = shown.length > 0 && shown.every((i) => isOpenId(ui.open, i.id));
  const sel = `${cap(label)}${isArch && q ? ` · “${String(ui.q).trim()}”` : ''} · ${secNames.length ? secNames.join(', ') : 'All sections'} · ${domNames.length ? domNames.join(', ') : 'All domains'} · ${srcNames.length ? srcNames.join(', ') : 'All sources'}`;

  return {
    isRep,
    isArch,
    title: isRep ? 'Report' : 'Archive',
    sub: isRep
      ? `${plural(shown.length, 'item')} · ${label} · ${runsPhrase(rs)}`
      : `${plural(shown.length, 'item')} · ${label}${ui.archTime === 'all' && data.earliest ? ` · since ${fmtDate(data.earliest)}` : ''}`,
    shown,
    groups,
    mix: MECHANISMS.map((m) => ({ mech: m.key, label: m.label, desc: m.short, n: shown.filter((i) => i.mechanism === m.key).length })),
    filters,
    hasActive,
    allOpen,
    toggleAllLabel: allOpen ? 'Collapse all' : 'Expand all',
    selSummary: `${sel} — ${plural(shown.length, 'item')}`,
    printMeta: printing
      ? `Readiness Signal ${isRep ? 'report' : 'archive'} export · ${ui.printMode === 'expanded' ? 'Fully expanded' : 'Collapsed summary'} · ${sel} · ${plural(shown.length, 'item')} · Exported ${fmtFull(now)}`
      : '',
    archiveEmpty: isArch && data.items.length === 0,
    listEmpty: isArch && shown.length === 0,
    // Nothing to expand, and an empty archive selection has nothing to export (an empty
    // report still exports: its empty sections record that nothing cleared the bar).
    showToggleAll: shown.length > 0,
    showExport: isRep || shown.length > 0,
    runs: rs,
    minDate: MIN_DATE,
    maxDate: todayEt(now),
  };
}

/** Is item `it` open in this render (print mode overrides the per-item state)? */
export function isOpen(it, ui) {
  if (ui.printMode) return ui.printMode === 'expanded';
  return isOpenId(ui.open, it.id);
}

/** Own-property test, so no id can ever read an Object.prototype member as "open". */
export const isOpenId = (open, id) => !!open && Object.prototype.hasOwnProperty.call(open, id) && open[id] === true;
