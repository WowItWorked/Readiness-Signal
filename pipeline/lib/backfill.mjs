// Backfill pass (pipeline/BACKFILL.md, binding): pass windows (a month, or a day of the current
// month, possibly ended early at an `until`), slots and timestamps (§4), archive
// collection from the CISA KEV catalogue and the Federal Register API (§3.1), candidate
// registration, live source-URL verification (§5) and the publish planner (§4, §6).
// Used by pipeline/scripts/backfill.mjs. No dependencies.
//
// Honest access (BACKFILL.md §5, SPEC §5): every request carries collect.mjs USER_AGENT and no
// other. A 403, 429 or 503 is retried once with the same user agent after any Retry-After (at
// most 10 s). An access wall, bot interstitial or redirect to an unblock or challenge page is not
// verified (reason "access wall ..."), never bypassed. Where a publisher offers an official
// machine-readable record, that record is the check: Federal Register documents through the
// Federal Register API, CISA KEV catalogue entries through the KEV JSON.

import { randomBytes } from 'node:crypto';
import { CANDIDATE_ID_RE, ITEM_ID_RE, SECTIONS, SOURCE_CLASSES } from './enums.mjs';
import {
  MAX_RETRY_AFTER_MS, RETRY_STATUSES, USER_AGENT, fetchWithRetry, kevCandidates, mapPool, retryAfterMs, retryNote, sleep,
} from './collect.mjs';
import { collapseWhitespace, decodeEntities, leadWordsFor, makeLead, stripHtml } from './feed.mjs';
import { assignIds, finaliseItem, isPublishedJudgment } from './publish.mjs';
import { KEV_URL, isKnownPaywalled, paywalledOnSite, sourceForUrl } from './sources.mjs';
import { SLOT_HOURS, etDateString, etParts, etWallToDate, isEtIso, isIsoDate, slotAt, toEtIso } from './time.mjs';
import { candidateId, disallowedSourceReason, hostOf, isHttpsUrl, isTrackingParam, normaliseUrl, registrableDomain } from './url.mjs';
import {
  Issues, buildNgramSet, checkAppendOnly, decisionStyleIssues, findVerbatim, parseReasonCodeElements, parseReasonCodes, styleWarnings,
  validateArchive, validateDecisions, validateItem, validateRuns,
} from './validate.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad2 = (n) => String(n).padStart(2, '0');
const quote = (s) => JSON.stringify(s);

// ---------------------------------------------------------------- passes (BACKFILL.md §1)

const PASS_SECTIONS = Object.freeze(['capability_shift', 'regulatory_trajectory']);
// 2026-10-04 15:57 ET; the build owner set the sections to the 2026-01 pass's for every pass
const YEAR_TO_DATE_INSTRUCTION = '2026-10-04 15:57 ET: "Now run all months sequentially until October and then run each day up until today so that nothing is missed from this year on it\'s first load"; sections as the 2026-01 pass (build owner decision).';
const yearToDate = (extra = {}) => Object.freeze({ sections: PASS_SECTIONS, instruction: YEAR_TO_DATE_INSTRUCTION, ...extra });

/**
 * The passes the owner has instructed, mirroring the BACKFILL.md §1 table (binding). A pass key is
 * a calendar month (YYYY-MM, --month) or, for the current month, a calendar day (YYYY-MM-DD,
 * --day), in America/New_York time. An `until` (ET ISO, an edition slot instant) ends that pass's
 * window early: the last slot the backfill covers, after which the live routine takes over.
 * Every subcommand refuses a key that is not listed; adding a pass or a section to a pass is an
 * owner instruction recorded in BACKFILL.md §1 and here together.
 */
export const PASSES = Object.freeze({
  '2026-01': Object.freeze({
    sections: PASS_SECTIONS,
    instruction: '2026-10-04: January 2026 only; capability shift and regulatory trajectory only; verify every source URL is live; do not commit.',
  }),
  '2026-02': yearToDate(),
  '2026-03': yearToDate(),
  '2026-04': yearToDate(),
  '2026-05': yearToDate(),
  '2026-06': yearToDate(),
  '2026-07': yearToDate(),
  '2026-08': yearToDate(),
  '2026-09': yearToDate(),
  '2026-10-01': yearToDate(),
  '2026-10-02': yearToDate(),
  '2026-10-03': yearToDate(),
  // the live routine takes over at 06:05 ET on 2026-10-05 with its own 72-hour window
  '2026-10-04': yearToDate({ until: '2026-10-04T18:00:00-04:00' }),
});

/** Backfill-only drop codes (BACKFILL.md §6); every other code is FILTER.md §8.2's closed list. */
export const BF_REASON_CODES = Object.freeze(['BF_SECTION_EXCLUDED', 'BF_OUT_OF_WINDOW', 'BF_URL_UNVERIFIED']);
/** How a candidate was found (BACKFILL.md §3): machine-readable archive, publisher listing page, search. */
export const DISCOVERY_MODES = Object.freeze(['archive', 'search', 'feed']);
/** BACKFILL.md §3: paywalled leads are at most 30 words (live: 40). */
export const PAYWALLED_LEAD_WORDS = 30;
export const DEFAULT_LEAD_WORDS = 60;
/** BACKFILL.md §6: every item source passed verification in a check no older than this. */
export const URL_CHECK_MAX_AGE_HOURS = 24;
/** A check stamped this far after the real time is a clock problem, not a fresh check. */
const URL_CHECK_FUTURE_TOLERANCE_MS = 5 * 60e3;
/** BACKFILL.md §4: a source with a date but no time counts as published at 18:00 ET that day. */
export const DATE_ONLY_HOUR = 18;

/** 'month' for a YYYY-MM key, 'day' for a YYYY-MM-DD key, else null. */
export function passKind(key) {
  if (/^\d{4}-\d{2}$/.test(String(key ?? ''))) return 'month';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(key ?? ''))) return 'day';
  return null;
}

/** The PASSES entry for a pass key (month or day). Throws when the owner has not instructed a pass for it. */
export function requirePass(key) {
  const pass = Object.hasOwn(PASSES, key) ? PASSES[key] : null;
  if (!pass) {
    throw new Error(`no backfill pass is defined for ${key} (BACKFILL.md §1 lists ${Object.keys(PASSES).join(', ')}); run a pass only when the owner asks for that ${passKind(key) ?? 'month or day'}, and record the instruction in BACKFILL.md §1 and PASSES together`);
  }
  return pass;
}

/**
 * The pass's sections: the PASSES entry, or --sections (comma list) narrowing it to some of its
 * sections. --sections never widens a pass. Throws for a key without a pass.
 */
export function passSections(month, sectionsFlag) {
  const pass = requirePass(month);
  if (sectionsFlag === undefined || sectionsFlag === null) return [...pass.sections];
  const list = String(sectionsFlag).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error(`--sections: give one or more of ${pass.sections.join(', ')}`);
  for (const s of list) {
    if (!SECTIONS.includes(s)) throw new Error(`--sections: "${s}" is not one of ${SECTIONS.join(', ')}`);
    if (!pass.sections.includes(s)) throw new Error(`--sections: ${s} is not in the ${month} pass (${pass.sections.join(', ')}); --sections only narrows a pass, and widening it is an owner instruction recorded in BACKFILL.md §1 and PASSES together`);
  }
  return [...new Set(list)];
}

// ---------------------------------------------------------------- window, slots, timestamps (§4)

/**
 * One calendar month in ET: [start, end) as instants, first and last calendar dates, the first and
 * last edition slots inside it, and the pass id used as decisions.json run_id. `key` is the pass
 * key (the month), `kind` 'month'.
 */
export function monthWindow(month) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month ?? ''));
  if (!m) throw new Error(`--month: ${quote(month ?? '')} is not YYYY-MM`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const start = etWallToDate(year, mon, 1, 0, 0, 0);
  const end = mon === 12 ? etWallToDate(year + 1, 1, 1, 0, 0, 0) : etWallToDate(year, mon + 1, 1, 0, 0, 0);
  return {
    kind: 'month',
    key: `${m[1]}-${m[2]}`,
    month: `${m[1]}-${m[2]}`,
    id: `backfill-${m[1]}-${m[2]}`,
    year,
    mon,
    start,
    end,
    firstDate: `${m[1]}-${m[2]}-01`,
    lastDate: `${m[1]}-${m[2]}-${pad2(lastDay)}`,
    firstSlot: slotAt(year, mon, 1, SLOT_HOURS[0]),
    lastSlot: slotAt(year, mon, lastDay, SLOT_HOURS[SLOT_HOURS.length - 1]),
    since: toEtIso(start),
    until: toEtIso(new Date(end.getTime() - 1000)),
  };
}

/**
 * One calendar day in ET, in the shape of monthWindow: `key` and `day` are the date, `kind` 'day',
 * the first and last slots 06:00 and 18:00 that day, the pass id "backfill-YYYY-MM-DD".
 */
export function dayWindow(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  if (!m || !isIsoDate(String(day))) throw new Error(`--day: ${quote(day ?? '')} is not YYYY-MM-DD`);
  const [year, mon, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = etWallToDate(year, mon, d, 0, 0, 0);
  const end = etWallToDate(year, mon, d + 1, 0, 0, 0);
  return {
    kind: 'day',
    key: String(day),
    day: String(day),
    id: `backfill-${day}`,
    year,
    mon,
    start,
    end,
    firstDate: String(day),
    lastDate: String(day),
    firstSlot: slotAt(year, mon, d, SLOT_HOURS[0]),
    lastSlot: slotAt(year, mon, d, SLOT_HOURS[SLOT_HOURS.length - 1]),
    since: toEtIso(start),
    until: toEtIso(new Date(end.getTime() - 1000)),
  };
}

/**
 * The window ended early at `until` (ET ISO with offset, an edition slot instant inside the
 * window): the window includes that instant and nothing after it (end = until + 1 ms, exclusive);
 * its last slot is that slot and its last date that slot's date. `ends_early` records it.
 */
export function windowUntil(w, until) {
  if (!isEtIso(until)) throw new Error(`until: ${quote(until)} is not an ET ISO timestamp with offset`);
  const t = new Date(until);
  if (!(t.getTime() > w.start.getTime() && t.getTime() < w.end.getTime())) throw new Error(`until: ${until} is not inside the ${w.key} window (${w.since} to ${w.until})`);
  const p = etParts(t);
  if (!SLOT_HOURS.includes(p.hour) || p.minute !== 0 || p.second !== 0 || t.getUTCMilliseconds() !== 0) {
    throw new Error(`until: ${until} is not an edition slot (${SLOT_HOURS.map((h) => `${pad2(h)}:00`).join(', ')} ET); a pass ends at the last slot it covers`);
  }
  const lastSlot = slotAt(p.year, p.month, p.day, p.hour);
  return { ...w, end: new Date(t.getTime() + 1), lastDate: lastSlot.date, lastSlot, until: lastSlot.iso, endsEarly: true };
}

/**
 * The window of a pass key the owner has instructed (BACKFILL.md §1): a month (YYYY-MM) or a day
 * (YYYY-MM-DD), ended early at the pass's `until` when it has one. `kind` ('month' | 'day'), when
 * given, is the flag the key came from: --month takes only a month, --day only a day. Throws for
 * a malformed key and for a key without a pass.
 */
export function passWindow(key, kind = passKind(key) ?? 'month') {
  const base = kind === 'day' ? dayWindow(key) : monthWindow(key);
  const pass = requirePass(base.key);
  return pass.until ? windowUntil(base, pass.until) : base;
}

/** The pass key as a document field: { month: 'YYYY-MM' } or { day: 'YYYY-MM-DD' }. */
export const passFields = (w) => ({ [w.kind ?? 'month']: w.key ?? w.month });

/** The pass key a work file or log row names (its day or month field), or null. */
export function docPassKey(doc) {
  if (!isObj(doc)) return null;
  if (typeof doc.day === 'string') return doc.day;
  return typeof doc.month === 'string' ? doc.month : null;
}

/**
 * Why the pass's window has not ended at `now`, or null: a backfill covers history only. The end
 * is the pass's effective end (its `until` when it has one).
 */
export function windowOpenIssue(w, now, { clock = null } = {}) {
  if (w.end.getTime() <= now.getTime()) return null;
  const closes = w.endsEarly ? `it ends at ${w.until} ET, the last edition slot this pass covers; the live routine covers what follows` : `it closes ${w.until} ET`;
  return `the ${w.key} window has not ended (${closes})${clock ? ` at the ${clock} ${toEtIso(now)}` : ''}; a backfill covers history only`;
}

/** JSON description of a window, as written to candidates.json and the reports. */
export function windowDoc(w) {
  return { ...passFields(w), since: w.since, until: w.until, first_slot: w.firstSlot.iso, last_slot: w.lastSlot.iso, ...(w.endsEarly ? { ends_early: true } : {}) };
}

export const dateInWindow = (date, w) => isIsoDate(date) && date >= w.firstDate && date <= w.lastDate;
export const instantInWindow = (t, w) => {
  const ms = t instanceof Date ? t.getTime() : Date.parse(t);
  return Number.isFinite(ms) && ms >= w.start.getTime() && ms < w.end.getTime();
};

/** The first edition slot at or after an instant (06:00, 10:00, 14:00, 18:00 ET). */
export function firstSlotAtOrAfter(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${value}`);
  const p = etParts(d);
  for (const h of SLOT_HOURS) {
    const s = slotAt(p.year, p.month, p.day, h);
    if (s.instant.getTime() >= d.getTime()) return s;
  }
  return slotAt(p.year, p.month, p.day + 1, SLOT_HOURS[0]);
}

/**
 * When a candidate counts as published for §4: { instant, precision, date } or null.
 * precision 'date' (KEV dateAdded, Federal Register publication_date, a "YYYY-MM-DD" registered with
 * add) counts as 18:00 ET that day; 'time' is the stated instant. A candidate without
 * published_precision (hand-made) is date-only when it has no time or sits at ET midnight.
 */
export function publicationInstant(c) {
  let precision = c?.published_precision;
  if (precision !== 'date' && precision !== 'time') {
    const t = c?.published ? new Date(c.published) : null;
    if (!t || Number.isNaN(t.getTime())) precision = 'date';
    else {
      const p = etParts(t);
      precision = p.hour === 0 && p.minute === 0 && p.second === 0 ? 'date' : 'time';
    }
  }
  if (precision === 'date') {
    let date = c?.published_date;
    if (!isIsoDate(date) && c?.published && !Number.isNaN(Date.parse(c.published))) date = etDateString(c.published);
    if (!isIsoDate(date)) return null;
    const [y, m, d] = date.split('-').map(Number);
    return { instant: etWallToDate(y, m, d, DATE_ONLY_HOUR, 0, 0), precision, date };
  }
  const t = new Date(c?.published);
  if (Number.isNaN(t.getTime())) return null;
  return { instant: t, precision, date: etDateString(t) };
}

/**
 * §4: the edition slot of a development first published at `instant`: the first slot at or after
 * it, except that a development published inside the window after its last slot (after 18:00 ET on
 * the last day) takes that last slot. `clamped` says so.
 */
export function slotForPublication(instant, w) {
  const slot = firstSlotAtOrAfter(instant);
  if (slot.instant.getTime() >= w.end.getTime() && instantInWindow(instant, w)) return { slot: w.lastSlot, clamped: true };
  return { slot, clamped: false };
}

/** The §4 slot of a single candidate's own publication ({ slot, clamped }), or null without a usable date. */
export function candidateSlot(c, w) {
  const pub = publicationInstant(c);
  return pub ? slotForPublication(pub.instant, w) : null;
}

const describePub = (pub) => (pub.precision === 'date' ? `${pub.date} (date only: 18:00 ET)` : toEtIso(pub.instant));

/**
 * §4 timestamp of a draft item: the first slot at or after the earliest publication among its
 * sources that are inside the window (sources outside it only confirm facts stated at the time).
 * Returns { slot, basis, issues }: issues name what stops the item being placed in the window.
 */
export function itemTiming(item, candByNorm, w) {
  const issues = [];
  const considered = [];
  (Array.isArray(item?.sources) ? item.sources : []).forEach((s, k) => {
    const c = isObj(s) ? candByNorm.get(normaliseUrl(s.url)) : null;
    if (!c) return; // validateDecisions reports a source that is not a candidate
    const pub = publicationInstant(c);
    if (!pub) {
      issues.push(`sources[${k}]: candidate ${c.candidate_id} has no usable publication date`);
      return;
    }
    const inside = c.outside_window !== true && c.background !== true && instantInWindow(pub.instant, w);
    considered.push({ k, c, pub, inside });
  });
  const primary = considered.find((x) => x.k === 0);
  if (primary && !primary.inside) {
    issues.push(`sources[0] (${primary.c.candidate_id}, published ${describePub(primary.pub)}) is outside the ${w.key} window; the primary source is the development's own publication inside the window (a development first made public outside it is dropped BF_OUT_OF_WINDOW)`);
  }
  const inside = considered.filter((x) => x.inside);
  if (!inside.length) {
    if (considered.length) issues.push(`no source is published inside the ${w.key} window (${w.since} to ${w.until}); drop it BF_OUT_OF_WINDOW`);
    return { slot: null, basis: null, issues };
  }
  const earliest = inside.reduce((a, b) => (b.pub.instant < a.pub.instant ? b : a));
  // §4: inside the window, a development published after the last slot takes that last slot
  const { slot, clamped } = slotForPublication(earliest.pub.instant, w);
  const basis = { candidate_id: earliest.c.candidate_id, published: describePub(earliest.pub) };
  if (clamped) basis.note = `published after the window's last slot ${w.lastSlot.iso} but inside the window: takes that last slot (BACKFILL.md §4)`;
  return { slot, basis, issues };
}

// ---------------------------------------------------------------- collect (§3.1)

export const FR_API_URL = 'https://www.federalregister.gov/api/v1/documents.json';
export const FR_FIELDS = Object.freeze(['title', 'abstract', 'html_url', 'publication_date', 'agencies', 'document_number', 'type']);
export const FR_PER_PAGE = 100;
export const FR_MAX_PAGES = 20;
const JSON_ACCEPT = 'application/json, */*;q=0.5';

/** The registry's KEV source (or the catalogue defaults when sources.json has none). */
export function kevSource(sources) {
  return sources.find((s) => s?.type === 'cisa-kev' && s.enabled !== false)
    ?? { id: 'cisa-kev', publication: 'CISA', source_class: 'vendor_threat_research', type: 'cisa-kev', url: KEV_URL, paywalled: false, region: 'US', notes: '' };
}

/**
 * KEV catalogue entries whose dateAdded falls in the month (ET calendar dates), in the live
 * candidate shape (collect.mjs kevCandidates: CISA catalogue URL, headline_composed: true).
 */
export function kevMonthCandidates(json, w, source) {
  const total = Array.isArray(json?.vulnerabilities) ? json.vulnerabilities.length : 0;
  const { candidates } = kevCandidates(source, json, { since: w.start, now: new Date(w.end.getTime() - 1) });
  return {
    total,
    candidates: candidates.map((c) => ({ ...c, published_precision: 'date', discovery_mode: 'archive', outside_window: false })),
  };
}

/** Federal Register agency slugs of the registry's federalregister.gov feeds: [{ slug, source }]. */
export function federalRegisterAgencies(sources) {
  const out = [];
  for (const s of sources) {
    if (!s || s.enabled === false || typeof s.url !== 'string') continue;
    let u;
    try {
      u = new URL(s.url);
    } catch {
      continue;
    }
    if (!/(?:^|\.)federalregister\.gov$/i.test(u.hostname)) continue;
    for (const slug of u.searchParams.getAll('conditions[agencies][]')) {
      if (slug && !out.some((x) => x.slug === slug)) out.push({ slug, source: s });
    }
  }
  return out;
}

/** Federal Register API query: final rules (type RULE) of one agency published in the month. */
export function federalRegisterQueryUrl(slug, w, { base = FR_API_URL, perPage = FR_PER_PAGE } = {}) {
  const u = new URL(base);
  u.searchParams.set('per_page', String(perPage));
  u.searchParams.set('order', 'oldest');
  u.searchParams.append('conditions[agencies][]', slug);
  u.searchParams.append('conditions[type][]', 'RULE');
  u.searchParams.set('conditions[publication_date][gte]', w.firstDate);
  u.searchParams.set('conditions[publication_date][lte]', w.lastDate);
  for (const f of FR_FIELDS) u.searchParams.append('fields[]', f);
  return u.href;
}

/**
 * One Federal Register API response page -> candidates. headline = title; lead = the first
 * lead_words of the abstract; publication = the issuing agency's registry name (the first listed
 * agency that has a registry feed, else the agency queried); class regulator; date-only.
 */
export function federalRegisterCandidates(page, { source, agencies = [], window: w }) {
  if (!isObj(page)) throw new Error('Federal Register API: response is not a JSON object');
  const results = page.results === undefined || page.results === null ? [] : page.results;
  if (!Array.isArray(results)) throw new Error('Federal Register API: "results" is not an array');
  const bySlug = new Map(agencies.map((a) => [a.slug, a.source]));
  const skipped = { invalid: 0, not_rule: 0, out_of_window: 0 };
  const candidates = [];
  for (const r of results) {
    const url = typeof r?.html_url === 'string' ? r.html_url.trim() : '';
    const title = collapseWhitespace(r?.title);
    const date = String(r?.publication_date ?? '').trim();
    let u = null;
    try { u = new URL(url); } catch { u = null; }
    // a rule's page is on federalregister.gov; any other html_url is not the Register's document
    if (!u || u.protocol !== 'https:' || !/(?:^|\.)federalregister\.gov$/i.test(u.hostname) || !title || !isIsoDate(date)) {
      skipped.invalid++;
      continue;
    }
    if (r.type !== undefined && r.type !== null && String(r.type).toLowerCase() !== 'rule') {
      skipped.not_rule++;
      continue;
    }
    if (!dateInWindow(date, w)) {
      skipped.out_of_window++;
      continue;
    }
    const listed = Array.isArray(r.agencies) ? r.agencies.filter(isObj) : [];
    const issuer = listed.map((a) => bySlug.get(a.slug)).find(Boolean) ?? source;
    const [y, m, d] = date.split('-').map(Number);
    candidates.push({
      candidate_id: candidateId(url),
      url,
      url_normalised: normaliseUrl(url),
      source_id: issuer.id,
      found_in: source.id,
      publication: issuer.publication,
      source_class: 'regulator',
      region: issuer.region ?? 'US',
      paywalled: false,
      headline: title,
      lead: makeLead(typeof r.abstract === 'string' ? r.abstract : '', leadWordsFor(issuer)),
      published: etWallToDate(y, m, d, 0, 0, 0).toISOString(),
      published_date: date,
      published_precision: 'date',
      date_missing: false,
      discovery_mode: 'archive',
      outside_window: false,
      fr: {
        document_number: typeof r.document_number === 'string' ? r.document_number : null,
        type: typeof r.type === 'string' ? r.type : null,
        agencies: listed.map((a) => collapseWhitespace(a.name ?? a.raw_name)).filter(Boolean),
      },
    });
  }
  return {
    candidates,
    count: Number.isInteger(page.count) ? page.count : null,
    total_pages: Number.isInteger(page.total_pages) ? page.total_pages : null,
    next_page_url: typeof page.next_page_url === 'string' && page.next_page_url ? page.next_page_url : null,
    skipped,
  };
}

const errorText = (err, timeoutMs) => (err?.name === 'TimeoutError' || err?.name === 'AbortError'
  ? `timeout after ${timeoutMs} ms`
  : err?.cause?.code ? `${err.message} (${err.cause.code})` : String(err?.message ?? err)).slice(0, 300);

/** GET JSON with the project user agent (one same-agent retry on 403/429/503; collect.mjs fetchWithRetry). */
async function getJson(url, { timeoutMs, fetchImpl }) {
  const res = await fetchWithRetry(url, { timeoutMs, accept: JSON_ACCEPT, fetchImpl });
  if (res.tooLarge) throw new Error('response larger than 15 MB');
  if (!res.ok) throw new Error(`HTTP ${res.status}${retryNote(res)}`);
  try {
    return { json: JSON.parse(res.text), retried: res.retried, status: res.status };
  } catch (e) {
    throw new Error(`invalid JSON: ${e.message}`);
  }
}

/**
 * Collect the month's archive candidates: the KEV catalogue and every registry Federal Register
 * agency (paginated). Never throws for a failing source: it is reported with its error.
 * @returns {Promise<{ candidates: object[], kev: object|null, federal_register: object[] }>}
 */
export async function collectArchives({ sources, window: w, only = null, timeoutMs = 30000, concurrency = 4, kevUrl = null, frApiUrl = FR_API_URL, fetchImpl }) {
  const want = (key) => !only || only.has(key);
  const jobs = [];
  if (want('kev')) {
    const source = kevSource(sources);
    jobs.push(async () => {
      const url = kevUrl ?? source.url;
      const report = { id: source.id, url, status: 'failed', catalogue_entries: 0, in_window: 0, error: null };
      try {
        const { json } = await getJson(url, { timeoutMs, fetchImpl });
        if (!Array.isArray(json?.vulnerabilities)) throw new Error('KEV JSON has no "vulnerabilities" array');
        const r = kevMonthCandidates(json, w, source);
        report.status = 'ok';
        report.catalogue_entries = r.total;
        report.catalog_version = typeof json.catalogVersion === 'string' ? json.catalogVersion : null;
        report.in_window = r.candidates.length;
        return { kind: 'kev', report, candidates: r.candidates };
      } catch (err) {
        report.error = errorText(err, timeoutMs);
        return { kind: 'kev', report, candidates: [] };
      }
    });
  }
  const agencies = federalRegisterAgencies(sources);
  if (want('federal-register')) {
    for (const a of agencies) {
      jobs.push(async () => {
        const first = federalRegisterQueryUrl(a.slug, w, { base: frApiUrl });
        const report = { source_id: a.source.id, slug: a.slug, publication: a.source.publication, status: 'failed', api_count: null, pages: 0, in_window: 0, skipped: { invalid: 0, not_rule: 0, out_of_window: 0 }, query: first, error: null };
        const out = [];
        try {
          let url = first;
          const origin = new URL(first).origin;
          while (url) {
            if (report.pages >= FR_MAX_PAGES) throw new Error(`more than ${FR_MAX_PAGES} pages; narrow the query`);
            const { json } = await getJson(url, { timeoutMs, fetchImpl });
            const page = federalRegisterCandidates(json, { source: a.source, agencies, window: w });
            report.pages++;
            if (report.api_count === null) report.api_count = page.count;
            for (const k of Object.keys(report.skipped)) report.skipped[k] += page.skipped[k];
            out.push(...page.candidates);
            url = null;
            if (page.next_page_url) {
              const next = new URL(page.next_page_url, first);
              if (next.origin !== origin) throw new Error(`next_page_url ${next.href} leaves ${origin}`);
              url = next.href;
            }
          }
          report.status = 'ok';
          report.in_window = out.length;
          return { kind: 'fr', report, candidates: out };
        } catch (err) {
          report.error = errorText(err, timeoutMs);
          report.in_window = out.length;
          return { kind: 'fr', report, candidates: out };
        }
      });
    }
  }
  const results = await mapPool(jobs, concurrency, (job) => job());
  return {
    candidates: results.flatMap((r) => r.candidates),
    kev: results.find((r) => r.kind === 'kev')?.report ?? null,
    federal_register: results.filter((r) => r.kind === 'fr').map((r) => r.report),
  };
}

/** Mark a candidate with the live runs' seen.json verdict (read-only; the backfill never writes it). */
export function markSeen(c, seenDoc) {
  const e = isObj(seenDoc?.urls) ? seenDoc.urls[c.url_normalised ?? normaliseUrl(c.url)] : null;
  return { ...c, seen: Boolean(e), seen_verdict: e?.verdict ?? null };
}

/**
 * Merge incoming candidates into the pass's list, deduplicated by normalised URL (candidate_id).
 * Existing entries keep their data; a duplicate from another source (for a Federal Register joint
 * rule, another agency's feed: found_in) is recorded in also_in.
 */
export function mergeCandidates(existing, incoming) {
  const byId = new Map();
  for (const c of existing) byId.set(c.candidate_id, { ...c, also_in: Array.isArray(c.also_in) ? [...c.also_in] : [] });
  const added = [];
  const already = [];
  const marked = [];
  for (const c of incoming) {
    const prev = byId.get(c.candidate_id);
    if (prev) {
      if (c.background === true && prev.background !== true) {
        prev.background = true;
        marked.push(c.candidate_id);
      }
      const tag = c.found_in ?? c.source_id ?? c.publication;
      if (tag && tag !== (prev.found_in ?? prev.source_id ?? prev.publication) && !prev.also_in.includes(tag)) prev.also_in.push(tag);
      already.push({ candidate_id: c.candidate_id, url: c.url, publication: prev.publication });
      continue;
    }
    const rec = { ...c, also_in: Array.isArray(c.also_in) ? [...c.also_in] : [] };
    byId.set(c.candidate_id, rec);
    added.push(rec);
  }
  return { candidates: [...byId.values()], added, already, marked };
}

/** A fresh candidates.json for the pass. */
export function emptyCandidatesDoc(w, now) {
  return { schema_version: 1, ...passFields(w), window: windowDoc(w), generated_at: toEtIso(now), candidates: [] };
}

// ---------------------------------------------------------------- add (agents' candidates)

const ADD_KEYS = new Set(['url', 'publication', 'source_class', 'headline', 'lead', 'published', 'paywalled', 'discovery_mode', 'notes']);
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MIDNIGHT_STAMP = /^(\d{4}-\d{2}-\d{2})T00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const wordTotal = (s) => (collapseWhitespace(s) ? collapseWhitespace(s).split(' ').length : 0);

/**
 * Validate entries an agent found (publisher archive pages, search, feeds) and turn them into
 * candidates. Every field is checked; a disallowed host (aggregator, cache, wrapper, social) is
 * refused; a date outside the window is refused unless allowOutside and later than the window (a
 * corroborating later source, flagged outside_window: true), or allowBackground and earlier (an
 * outlet on the story's earlier record, FILTER §5.8/§5.9, flagged outside_window and background); paywalled leads are cut to 30 words,
 * others to the registry's lead_words (default 60).
 * @returns {{ candidates: object[], errors: string[], notices: string[] }}
 */
export function prepareAddEntries(entries, { sources = [], window: w, allowOutside = false, allowBackground = false, seenDoc = null }) {
  const errors = [];
  const notices = [];
  const candidates = [];
  if (!Array.isArray(entries)) return { candidates, errors: ['expected a JSON array of entries, or { "candidates": [...] }'], notices };
  entries.forEach((e, i) => {
    const at = `entries[${i}]`;
    const err = (msg) => errors.push(`${at}${msg}`);
    if (!isObj(e)) return err(': must be an object');
    const before = errors.length;
    for (const k of Object.keys(e)) if (!ADD_KEYS.has(k)) err(`.${k}: unknown field (allowed: ${[...ADD_KEYS].join(', ')})`);
    let url = null;
    if (typeof e.url !== 'string' || e.url.trim() !== e.url || !e.url) err('.url: required string without surrounding spaces');
    else {
      try { url = new URL(e.url); } catch { url = null; }
      if (!url) err('.url: not a URL');
      else if (url.protocol !== 'https:') err('.url: must be https');
      else {
        const banned = disallowedSourceReason(e.url);
        if (banned) err(`.url: ${banned}`);
      }
    }
    const publication = collapseWhitespace(e.publication);
    if (!publication) err('.publication: required (the publication\'s common name, FILTER 7.8)');
    else if (publication.length > 200) err('.publication: longer than 200 characters');
    if (!SOURCE_CLASSES.includes(e.source_class)) err(`.source_class: must be one of ${SOURCE_CLASSES.join(', ')}`);
    const headline = collapseWhitespace(e.headline);
    if (!headline) err('.headline: required (the headline exactly as published)');
    else if (headline.length > 300) err(`.headline: too long for a headline (${headline.length} characters)`);
    if (e.lead !== undefined && e.lead !== null && typeof e.lead !== 'string') err('.lead: must be a string when present');
    if (typeof e.paywalled !== 'boolean') err('.paywalled: required true or false');
    if (!DISCOVERY_MODES.includes(e.discovery_mode)) err(`.discovery_mode: must be one of ${DISCOVERY_MODES.join(', ')}`);
    if (e.notes !== undefined && e.notes !== null && (typeof e.notes !== 'string' || e.notes.length > 500)) err('.notes: optional string of at most 500 characters');
    let precision = null;
    let instant = null;
    let date = null;
    const midnight = typeof e.published === 'string' ? MIDNIGHT_STAMP.exec(e.published) : null;
    if (typeof e.published !== 'string') err('.published: required, "YYYY-MM-DD" (date only) or ISO 8601 with an offset ("2026-01-15T09:30:00-05:00")');
    else if (isIsoDate(e.published) || (midnight && isIsoDate(midnight[1]))) {
      // an exact midnight stamp ("2026-01-15T00:00:00Z") is how many sites date a page that has no
      // time: it is the date written, not 19:00 ET the evening before
      precision = 'date';
      date = midnight ? midnight[1] : e.published;
      if (midnight) notices.push(`${at}: published ${e.published} is a midnight stamp; recorded as the date ${date} (date only: 18:00 ET)`);
      const [y, m, d] = date.split('-').map(Number);
      instant = etWallToDate(y, m, d, 0, 0, 0);
    } else if (ISO_WITH_OFFSET.test(e.published) && !Number.isNaN(Date.parse(e.published))) {
      precision = 'time';
      instant = new Date(e.published);
      date = etDateString(instant);
    } else err(`.published: ${quote(e.published)} is neither "YYYY-MM-DD" nor ISO 8601 with an offset`);
    let outside = false;
    let background = false;
    if (precision) {
      // a date-only source counts as 18:00 ET that day (§4), also against a window ended early
      const [py, pm, pd] = date.split('-').map(Number);
      const counted = precision === 'date' ? etWallToDate(py, pm, pd, DATE_ONLY_HOUR, 0, 0) : instant;
      if (!instantInWindow(counted, w)) {
        const later = counted.getTime() >= w.end.getTime();
        const what = `published ${e.published} is outside the ${w.key} window (${w.since} to ${w.until} ET)`;
        if (!later && allowBackground) {
          // FILTER §5.8(1)(v), §5.9(1)(iv): an earlier outlet on the story's record, listed for
          // prominence only (outside_window and background: never primary, never judged, no timestamp)
          outside = true;
          background = true;
        } else if (!later) err(`.published: ${what}; a development first made public before the window is dropped BF_OUT_OF_WINDOW and is not registered (an earlier outlet on the story's record may be registered with --allow-background, FILTER §5.8 and §5.9)`);
        else if (!allowOutside) err(`.published: ${what}; a development first made public after the window is dropped BF_OUT_OF_WINDOW; a later source that only confirms facts stated at the time may be registered with --allow-outside`);
        else outside = true;
      }
    }
    if (errors.length > before) return undefined;
    // FILTER §5.8(1)(v), §5.9(1)(iv): with --allow-background every entry is an outlet on the story's
    // record counted for prominence only, inside the window as well as before it
    if (allowBackground) background = true;

    const reg = sourceForUrl(sources, e.url);
    const forced = Boolean(reg?.paywalled) || Boolean(paywalledOnSite(sources, e.url)) || isKnownPaywalled(e.url);
    if (forced && e.paywalled === false) notices.push(`${at}: ${hostOf(e.url)} is a paywalled publication; recorded as paywalled (headline and lead only)`);
    const paywalled = forced || e.paywalled === true;
    const regWords = Number.isInteger(reg?.lead_words) ? reg.lead_words : null;
    const limit = paywalled ? Math.min(PAYWALLED_LEAD_WORDS, regWords ?? PAYWALLED_LEAD_WORDS) : regWords ?? DEFAULT_LEAD_WORDS;
    const rawLead = typeof e.lead === 'string' ? e.lead : '';
    const lead = makeLead(rawLead, limit);
    if (wordTotal(rawLead) > limit) notices.push(`${at}: lead cut to ${limit} words${paywalled ? ' (paywalled: headline and lead only, BACKFILL.md §3)' : ''}`);
    const c = {
      candidate_id: candidateId(e.url),
      url: e.url,
      url_normalised: normaliseUrl(e.url),
      source_id: reg?.id ?? null,
      publication,
      source_class: e.source_class,
      region: reg?.region ?? null,
      paywalled,
      headline,
      lead,
      published: instant.toISOString(),
      published_date: date,
      published_precision: precision,
      date_missing: false,
      discovery_mode: e.discovery_mode,
      outside_window: outside,
      ...(background ? { background: true } : {}),
      ...(typeof e.notes === 'string' && e.notes.trim() ? { notes: collapseWhitespace(e.notes) } : {}),
      ...(reg?.tier && e.source_class === 'news' ? { tier: reg.tier } : {}),
      also_in: [],
    };
    candidates.push(seenDoc ? markSeen(c, seenDoc) : { ...c, seen: false, seen_verdict: null });
    return undefined;
  });
  return { candidates, errors, notices };
}

// ---------------------------------------------------------------- source URL verification (§5)

/**
 * Hosts that serve one publisher across two registrable domains, so a redirect between them is
 * not off-site. www. and any other subdomain of the same registrable domain are already equal
 * (federalreserve.gov and www.federalreserve.gov), so they need no entry here.
 */
export const CANONICAL_HOSTS = Object.freeze([
  // The OCC's legacy host occ.treas.gov redirects to occ.gov.
  Object.freeze(['occ.treas.gov', 'occ.gov']),
  // ECB Banking Supervision documents move between the ECB's site and the supervision site.
  Object.freeze(['ecb.europa.eu', 'bankingsupervision.europa.eu']),
]);

/**
 * Shared suffixes whose subdomains belong to different owners (a ministry under gouv.fr, a
 * tenant under github.io): the site is one label more than url.mjs registrableDomain gives.
 */
export const SHARED_SUFFIXES = Object.freeze([
  'gouv.fr', 'admin.ch', 'gv.at', 'gob.es', 'gov.it', 'bund.de',
  'github.io', 'gitlab.io', 'blogspot.com', 'wordpress.com', 'substack.com', 'medium.com', 'tumblr.com',
  'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com',
  'herokuapp.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'sharepoint.com', 'readthedocs.io',
]);

const onHost = (host, base) => host === base || host.endsWith(`.${base}`);

/** The site a host belongs to: its registrable domain, one label deeper under a SHARED_SUFFIXES entry. */
export function siteOf(host) {
  if (!host) return null;
  const h = String(host).toLowerCase().replace(/\.$/, '');
  const shared = SHARED_SUFFIXES.find((s) => h.endsWith(`.${s}`));
  if (shared) {
    const labels = h.slice(0, -(shared.length + 1)).split('.').filter(Boolean);
    return `${labels[labels.length - 1]}.${shared}`;
  }
  return registrableDomain(h);
}

/** Same publisher site: equal siteOf, or a CANONICAL_HOSTS pair. */
export function sameSite(originalUrl, finalUrl) {
  const a = hostOf(originalUrl);
  const b = hostOf(finalUrl);
  if (!a || !b) return false;
  if (siteOf(a) === siteOf(b)) return true;
  return CANONICAL_HOSTS.some(([x, y]) => (onHost(a, x) && onHost(b, y)) || (onHost(a, y) && onHost(b, x)));
}

/** 'html' | 'pdf' | 'xml' | 'json' | null from a Content-Type header. */
export function contentKind(contentType) {
  const t = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!t) return null;
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'html';
  if (t === 'application/pdf' || t === 'application/x-pdf') return 'pdf';
  if (t === 'application/xml' || t === 'text/xml' || t.endsWith('+xml')) return 'xml';
  if (t === 'application/json' || t === 'text/json' || t.endsWith('+json')) return 'json';
  return null;
}

/** The document's <title>, entities decoded, whitespace collapsed ('' when none). */
export function pageTitle(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html ?? ''));
  return m ? collapseWhitespace(decodeEntities(m[1].replace(/<[^>]*>/g, ' '))) : '';
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * Remove every element whose opening tag `openRe` (global; group 1 = the tag name) matches, with
 * its content, counting nested elements of the same name. An element that is never closed loses
 * only its opening tag.
 */
function removeElements(html, openRe) {
  const s = String(html ?? '');
  let out = '';
  let i = 0;
  for (;;) {
    openRe.lastIndex = i;
    const m = openRe.exec(s);
    if (!m) break;
    out += `${s.slice(i, m.index)} `;
    const tag = m[1].toLowerCase();
    const after = m.index + m[0].length;
    if (VOID_TAGS.has(tag) || m[0].endsWith('/>')) {
      i = after;
      continue;
    }
    const scan = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    scan.lastIndex = after;
    let depth = 1;
    let t;
    while (depth > 0 && (t = scan.exec(s))) depth += t[1] ? -1 : t[0].endsWith('/>') ? 0 : 1;
    i = depth === 0 ? scan.lastIndex : after;
  }
  return out + s.slice(i);
}

/** The inner HTML of the `tag` element whose opening tag ends at `start` (nested ones counted). */
function innerFrom(s, start, tag) {
  const scan = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  scan.lastIndex = start;
  let depth = 1;
  let t;
  while (depth > 0 && (t = scan.exec(s))) {
    depth += t[1] ? -1 : t[0].endsWith('/>') ? 0 : 1;
    if (depth === 0) return s.slice(start, t.index);
  }
  return s.slice(start);
}

const NON_TEXT_ELEMENTS = /<(script|style|noscript|template|select|button|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi;
const CHROME_TAGS = /<(nav|header|footer|aside)\b[^>]*>/gi;
const CHROME_ROLES = /<([a-z][a-z0-9]*)\b[^>]*\brole\s*=\s*["']?(?:navigation|banner|contentinfo|search)\b[^>]*>/gi;
const MAIN_OPEN = /<(main)\b[^>]*>|<([a-z][a-z0-9]*)\b[^>]*\brole\s*=\s*["']?main\b[^>]*>/gi;

/** The page body without head, scripts, styles and form controls. */
function bodyMarkup(html) {
  return String(html ?? '').replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ').replace(NON_TEXT_ELEMENTS, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
}
const markupText = (s) => collapseWhitespace(decodeEntities(stripHtml(s)));
/** Body markup without site chrome: nav, header, footer, aside and navigation/banner/footer/search roles. */
const withoutChrome = (markup) => removeElements(removeElements(markup, CHROME_TAGS), CHROME_ROLES);

/**
 * The first `n` characters of the page's visible text: head, scripts, styles, form controls and
 * site chrome (nav, header, footer, aside, role=navigation/banner/contentinfo/search) removed.
 */
export function visibleTextStart(html, n = 2048) {
  return markupText(withoutChrome(bodyMarkup(html))).slice(0, n);
}

/** The text of the page's <main> (or role=main) element, chrome removed; '' when there is none. */
export function mainText(html, n = 2048) {
  const markup = bodyMarkup(html);
  MAIN_OPEN.lastIndex = 0;
  const m = MAIN_OPEN.exec(markup);
  if (!m) return '';
  const inner = innerFrom(markup, m.index + m[0].length, (m[1] ?? m[2]).toLowerCase());
  return markupText(withoutChrome(inner)).slice(0, n);
}

/** The text of the page's first three <h1> headings (chrome included: a heading is never chrome). */
export function headings(html) {
  return [...bodyMarkup(html).matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)].slice(0, 3).map((m) => markupText(m[1])).filter(Boolean);
}

// Soft 404 (BACKFILL.md §5: "a page whose title or opening text says the page was not found").
// The phrases are stated about the page itself: a source's own subject matter ("the patch does not
// exist yet", "the malicious file was removed", "Rule 404", a document number ending in 404) never
// makes it an error page. A short title or heading (6 words or fewer, e.g. "404 | Federal
// Register", "Document not found", "Error | Example Agency", "Oops!") may state them bare.
// The bare forms count only said of the page ("Page not found", "Document not available", "404
// Not Found") or as the text or a segment of it ("Not Found | Example Agency"), never inside a
// short headline ("Backdoor not found, vendor says", "Patch not available | SecurityWeek").
const NOT_THERE = String.raw`(?:not\s+found|not\s+available|no\s+longer\s+available|does\s+not\s+exist|doesn['’]t\s+exist|cannot\s+be\s+found|could\s+not\s+be\s+found)`;
const SHORT_SOFT_404 = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:page|web\s*page|document|content|file|resource|url|article|item|404)\s+(?:${NOT_THERE}|unavailable|missing|gone|removed)(?![\p{L}\p{N}])|(?:^|[|:–—-])\s*${NOT_THERE}\s*(?:[|:–—-]|$)|(?<![\p{L}\p{N}])(?:missing|unavailable)\s+page(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:error\s*404|404\s*error)(?![\p{L}\p{N}])`, 'iu');
const BARE_404 = /(?:^|[|:–—-]\s*)404(?=\s*(?:[|:–—-]|$))/u;
// "Error", "Oops!", "Error | Example Agency"; not "Error: the cost of misconfigured clouds"
const ERROR_LEAD = /^\s*(?:error|oops|whoops|sorry|uh[\s-]oh)\b!?\s*(?:[|–—-].*)?$/iu;
const LOOKING_FOR = String.raw`(?:(?:you|that\s+you)(?:['’]re|\s+are|\s+were)\s+looking\s+for\s+|you\s+(?:have\s+)?requested\s+|requested\s+)?`;
const PAGE_SOFT_404 = Object.freeze([
  /(?<![\p{L}\p{N}])page\s+not\s+found(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?:error\s*:?\s*404|404\s*(?:[-:–|]\s*)?(?:error|not\s+found|page))(?![\p{L}\p{N}])/iu,
  new RegExp(String.raw`(?<![\p{L}\p{N}])(?:page|document|article|content|resource|link|url|web\s*page)\s+${LOOKING_FOR}(?:is\s+|was\s+|could\s+)?(?:not\s+(?:be\s+)?found|cannot\s+be\s+found|can['’]t\s+be\s+found|could\s+not\s+be\s+found|does\s+not\s+exist|doesn['’]t\s+exist|no\s+longer\s+(?:exists|available)|(?:is\s+)?unavailable)(?![\p{L}\p{N}])`, 'iu'),
  /(?<![\p{L}\p{N}])(?:this|the)\s+(?:page|content|document|article)\s+(?:has\s+been|was)\s+(?:removed|deleted|archived|taken\s+down)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?:sorry|oops)(?![\p{L}\p{N}])[^.!?]{0,80}?(?:can(?:no|['’])t\s+find|could\s*(?:no|n['’])t\s+find|not\s+(?:be\s+)?found|does\s*(?:no|n['’])t\s+exist|no\s+longer\s+available)/iu,
  // "We can't find the page you're looking for", "We couldn't find that page"
  /(?<![\p{L}\p{N}])(?:can(?:no|['’])t|could\s*(?:no|n['’])t|(?:are|were)\s+unable\s+to)\s+(?:find|locate)\s+(?:the|that|this|your)\s+(?:web\s*)?(?:page|url|link)(?![\p{L}\p{N}])/iu,
  // "We couldn't find what you were looking for"
  /(?<![\p{L}\p{N}])(?:can(?:no|['’])t|could\s*(?:no|n['’])t|(?:are|were)\s+unable\s+to)\s+find\s+what\s+you(?:['’]re|\s+are|\s+were)\s+looking\s+for(?![\p{L}\p{N}])/iu,
  // "The page you were looking for has moved or no longer exists"
  new RegExp(String.raw`(?<![\p{L}\p{N}])(?:page|web\s*page|url|link)\s+${LOOKING_FOR}(?:has\s+(?:been\s+)?|may\s+have\s+been\s+|might\s+have\s+been\s+)(?:moved|removed|deleted|renamed)(?![\p{L}\p{N}])`, 'iu'),
  // "Looks like this page is missing"
  /(?<![\p{L}\p{N}])(?:this|the|that)\s+(?:web\s*)?page\s+(?:is|seems\s+to\s+be|appears\s+to\s+be)\s+(?:missing|gone|unavailable|not\s+available)(?![\p{L}\p{N}])/iu,
  // WordPress: "It looks like nothing was found at this location"
  /(?<![\p{L}\p{N}])nothing\s+(?:was\s+)?found\s+(?:at|on)\s+this\s+(?:location|address|url|page)(?![\p{L}\p{N}])/iu,
]);

const wordCount = (s) => (collapseWhitespace(s) ? collapseWhitespace(s).split(' ').length : 0);

/** The error-page phrase in a title, heading or text, or null. `short` admits the bare forms. */
function softPhrase(text, { short = false } = {}) {
  if (!text) return null;
  if (short) {
    const m = SHORT_SOFT_404.exec(text) ?? BARE_404.exec(text) ?? ERROR_LEAD.exec(text);
    // the phrase alone, without the separators and site name around it
    if (m) return collapseWhitespace(m[0].replace(/^\s*[|:–—-]\s*/, '').replace(/\s*[|:–—].*$/, '').replace(/\s+-(?:\s.*)?$/, ''));
  }
  for (const re of PAGE_SOFT_404) {
    const m = re.exec(text);
    if (m) return m[0].slice(0, 80);
  }
  return null;
}

/**
 * Why an HTML page is a soft 404, or null. In order: the <title>; the first <h1> headings; the
 * opening text of <main>; the opening 2 KB of visible text without site chrome (navigation,
 * header, footer and aside menus can push an error message far down a page).
 */
export function soft404Reason(html) {
  const title = pageTitle(html);
  const t = softPhrase(title, { short: wordCount(title) <= 6 });
  if (t) return `title ${quote(title.slice(0, 120))} says ${quote(t)}`;
  for (const h of headings(html)) {
    const p = softPhrase(h, { short: wordCount(h) <= 6 });
    if (p) return `heading ${quote(h.slice(0, 120))} says ${quote(p)}`;
  }
  const main = softPhrase(mainText(html));
  if (main) return `main text says ${quote(main)}`;
  const text = softPhrase(visibleTextStart(html));
  if (text) return `opening text says ${quote(text)}`;
  return null;
}

// Access walls: a bot or access interstitial instead of the page (federalregister.gov sends a
// non-browser user agent to unblock.federalregister.gov, "Federal Register :: Request Access", for
// every document, including ones that do not exist; a CDN answers "Just a moment..." with 403 or
// 503). A walled page is simply not verified, never worked around: no other user agent, no
// cookies, no challenge solving. A wall title is short: a page about requesting access to records
// is not a wall. (Federal Register documents are verified through the Federal Register API, its
// official machine-readable record, and never reach the wall.)
const WALL_HOST = /^(?:unblock|captcha|challenge|verify|botcheck)\./i;
const WALL_TITLE = /(?<![\p{L}\p{N}])(?:request\s+access|access\s+denied|access\s+to\s+this\s+page\s+has\s+been\s+denied|just\s+a\s+moment|attention\s+required|are\s+you\s+a\s+(?:robot|human)|verify(?:ing)?\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human|human\s+verification|captcha|bot\s+(?:check|protection|detection)|security\s+check|unusual\s+traffic|enable\s+(?:javascript\s+and\s+)?cookies)(?![\p{L}\p{N}])/iu;
// Where a dead link is commonly redirected: the home page (also /en/, /index.html, /home,
// /default.aspx), an error page (/404.html, /page-not-found, /error/...), a search page, or a
// parent listing of the original path.
// a language prefix (/en/, /fr-fr/): an ISO 639-1 code a publisher's site is likely to use
const LOCALE = '(?:en|fr|de|es|it|nl|pt|sv|da|fi|no|nb|nn|pl|cs|el|hu|ro|bg|hr|sk|sl|et|lv|lt|ga|mt|is|ja|zh|ko|ru|ar|tr|he|uk|id|ms|th|vi|hi)(?:[-_][a-z]{2,4})?';
const HOME_PATH = new RegExp(`^/(?:${LOCALE}/?)?(?:(?:index|default|home)(?:\\.(?:html?|aspx?|php|jsp|cfm))?)?/?$`, 'i');
const ERROR_PATH = /(?:^|\/)(?:404|not[-_]?found|page[-_]?not[-_]?found|errors?|error[-_]?404|404[-_]?error|error[-_]?page|missing)(?:\.[a-z0-9]+)?(?:\/|$)/i;
const SEARCH_PATH = new RegExp(`^/(?:${LOCALE}/)?(?:search|find|site-?search|search-results)(?:\\.[a-z0-9]+)?/?$`, 'i');
const INDEX_FILE = /\/(?:index|default)\.(?:html?|aspx?|php|jsp|cfm)$/i;
const trimPath = (p) => decodeURIComponentSafe(p).replace(INDEX_FILE, '').replace(/\/+$/, '').toLowerCase();
function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}
const meaningfulParams = (u) => [...u.searchParams].filter(([k, v]) => !isTrackingParam(k, v, u.hostname));

/**
 * Why a response is a bot or access interstitial, or null: a final host such as unblock. or
 * captcha. (any site), or a short title such as "Request Access" or "Just a moment...". Applies to
 * a 200, and to a 403, 429 or 503 whose page is such an interstitial.
 */
export function accessWall({ status, final_url: finalUrl, title = '' }) {
  if (!finalUrl || !(status === 200 || RETRY_STATUSES.includes(status))) return null;
  let f;
  try {
    f = new URL(finalUrl);
  } catch {
    return null;
  }
  const http = status === 200 ? '' : ` (HTTP ${status})`;
  if (WALL_HOST.test(f.hostname)) return `access wall at ${f.hostname}${http}${title ? ` (${quote(title.slice(0, 80))})` : ''}`;
  if (title && title.split(/\s+/).length <= 8 && WALL_TITLE.test(title)) return `access wall${http}: title ${quote(title.slice(0, 80))}`;
  return null;
}

/** Why a 200 response is an access wall (accessWall) or a redirect to where dead links go, or null. */
export function accessWallReason(originalUrl, { status, final_url: finalUrl, redirects = 0, title = '' }) {
  if (status !== 200 || !finalUrl) return null;
  let o;
  let f;
  try {
    o = new URL(originalUrl);
    f = new URL(finalUrl);
  } catch {
    return null;
  }
  const wall = accessWall({ status, final_url: finalUrl, title });
  if (wall) return wall;
  if (redirects <= 0) return null;
  const oParams = meaningfulParams(o);
  const fParams = meaningfulParams(f);
  const originalIsHome = HOME_PATH.test(o.pathname) && oParams.length === 0;
  // the final URL kept the original's identifying query (index.php?id=5 -> index.php?id=5&lang=en)
  const queryKept = oParams.length > 0 && oParams.every(([k, v]) => fParams.some(([k2, v2]) => k2 === k && v2 === v));
  if (!originalIsHome && HOME_PATH.test(f.pathname) && !queryKept) {
    return `redirected to the site's home page ${f.origin}${f.pathname}${f.search} (a removed page or an access wall)`;
  }
  if (ERROR_PATH.test(f.pathname) && !ERROR_PATH.test(o.pathname)) return `redirected to an error page ${f.pathname} (a removed page)`;
  if (SEARCH_PATH.test(f.pathname) && !SEARCH_PATH.test(o.pathname)) return `redirected to a search page ${f.pathname}${f.search} (a removed page)`;
  const op = trimPath(o.pathname);
  const fp = trimPath(f.pathname);
  if (f.hostname === o.hostname || siteOf(f.hostname) === siteOf(o.hostname)) {
    if (fp && op.startsWith(`${fp}/`) && !queryKept) return `redirected to ${f.pathname}, a parent of the original path (a removed page)`;
  }
  return null;
}

/**
 * The target of a <meta http-equiv="refresh"> redirect with a delay of at most `maxDelay` seconds,
 * or null (none, a plain reload, or a slower refresh). Ignored inside <noscript>.
 */
export function metaRefreshTarget(html, { maxDelay = 5 } = {}) {
  const s = String(html ?? '').slice(0, 64 * 1024).replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  for (const m of s.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bhttp-equiv\s*=\s*["']?refresh\b/i.test(tag)) continue;
    const cm = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const content = decodeEntities(cm?.[1] ?? cm?.[2] ?? cm?.[3] ?? '');
    const mm = /^\s*(\d+(?:\.\d+)?)\s*(?:[;,]\s*(?:url\s*=\s*)?(.*))?$/i.exec(content);
    if (!mm) continue;
    const target = String(mm[2] ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
    if (!target || Number(mm[1]) > maxDelay) return null;
    return target;
  }
  return null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// A 403, 429 or 503 is retried once with the same user agent after any Retry-After, up to
// MAX_RETRY_AFTER_MS (both from collect.mjs, shared with the live fetcher).
export { MAX_RETRY_AFTER_MS, retryAfterMs };
const BODY_READ_LIMIT = 1024 * 1024;
const PAGE_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,application/json;q=0.8,*/*;q=0.5';

async function discardBody(res) {
  try { await res.body?.cancel(); } catch { /* ignore */ }
}

async function readTextLimited(res, limit) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      size += value.byteLength;
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}

/**
 * One GET attempt with the project user agent (the only one sent), following up to maxRedirects
 * redirects by hand: HTTP redirects and <meta http-equiv="refresh"> redirects of 5 s or less (each
 * counts as a hop). An https URL redirected to http is refused unless allowHttp. The body is read
 * (at most 1 MB) for an HTML or JSON 200, and for an HTML 403/429/503 so that a bot interstitial
 * is recognised by its title.
 */
async function attemptGet(url, { timeoutMs, maxRedirects, fetchImpl, allowHttp, accept = PAGE_ACCEPT }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  const fail = (hops, extra) => ({ status: null, final_url: current, content_type: null, body: '', redirects: hops, retry_after: null, meta_refreshes: 0, ...extra });
  let metaRefreshes = 0;
  for (let hops = 0; ; hops++) {
    let res;
    try {
      res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en-GB,en;q=0.9' },
      });
    } catch (err) {
      return fail(hops, { error: errorText(err, timeoutMs), meta_refreshes: metaRefreshes });
    }
    const location = res.headers.get('location');
    let next = null;
    if (REDIRECT_STATUSES.has(res.status) && location) {
      await discardBody(res);
      next = location;
    }
    const contentType = res.headers.get('content-type');
    let body = '';
    if (next === null) {
      const kind = contentKind(contentType);
      try {
        if ((res.status === 200 && (kind === 'html' || kind === 'json')) || (RETRY_STATUSES.includes(res.status) && kind === 'html')) body = await readTextLimited(res, BODY_READ_LIMIT);
        else await discardBody(res);
      } catch (err) {
        return { ...fail(hops, { error: errorText(err, timeoutMs) }), status: res.status, content_type: contentType, meta_refreshes: metaRefreshes };
      }
      const refresh = res.status === 200 && kind === 'html' ? metaRefreshTarget(body) : null;
      if (refresh) {
        let target = null;
        try { target = new URL(refresh, current).href; } catch { target = null; }
        if (target && normaliseUrl(target) !== normaliseUrl(current)) {
          next = refresh;
          metaRefreshes++;
        }
      }
      if (next === null) {
        return { status: res.status, final_url: current, content_type: contentType, body, redirects: hops, retry_after: res.headers.get('retry-after'), meta_refreshes: metaRefreshes, error: null };
      }
    }
    if (hops >= maxRedirects) return { ...fail(hops, { error: `more than ${maxRedirects} redirects` }), status: res.status, meta_refreshes: metaRefreshes };
    let target;
    try {
      target = new URL(next, current);
    } catch {
      return { ...fail(hops, { error: `invalid redirect location ${quote(next)}` }), status: res.status, meta_refreshes: metaRefreshes };
    }
    if (target.protocol === 'http:' && !allowHttp) {
      return { ...fail(hops, { error: `redirected to insecure ${target.href}` }), status: res.status, meta_refreshes: metaRefreshes };
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return { ...fail(hops, { error: `redirected to a non-web URL ${quote(target.href)}` }), status: res.status, meta_refreshes: metaRefreshes };
    }
    current = target.href;
  }
}

// ---- KEV catalogue sources (BACKFILL.md §5 with the CISA catalogue page)
// The catalogue page (known-exploited-vulnerabilities-catalog?search_api_fulltext=<CVE>) answers
// 200 with the same first rows whatever is searched for, so the page proves nothing about the CVE.
// A catalogue URL is verified against CISA's own catalogue JSON instead: the CVE must be listed,
// with the candidate's dateAdded when one is expected.

/** The CVE of a CISA KEV catalogue search URL, or null. */
export function kevCveOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(?:^|\.)cisa\.gov$/i.test(u.hostname)) return null;
  if (u.pathname.replace(/\/+$/, '').toLowerCase() !== '/known-exploited-vulnerabilities-catalog') return null;
  const q = String(u.searchParams.get('search_api_fulltext') ?? '').trim().toUpperCase();
  return /^CVE-\d{4}-\d{4,}$/.test(q) ? q : null;
}

/** KEV catalogue JSON -> { entries: Map(CVE -> dateAdded), version }. */
export function kevIndex(json) {
  if (!Array.isArray(json?.vulnerabilities)) throw new Error('KEV JSON has no "vulnerabilities" array');
  const entries = new Map();
  for (const v of json.vulnerabilities) {
    const cve = String(v?.cveID ?? '').trim().toUpperCase();
    const added = String(v?.dateAdded ?? '').trim();
    if (/^CVE-\d{4}-\d{4,}$/.test(cve) && isIsoDate(added)) entries.set(cve, added);
  }
  return { entries, version: typeof json.catalogVersion === 'string' ? json.catalogVersion : null };
}

async function loadKev(kevUrl, { timeoutMs, fetchImpl }) {
  try {
    const { json } = await getJson(kevUrl, { timeoutMs, fetchImpl });
    return { ...kevIndex(json), url: kevUrl, error: null };
  } catch (err) {
    return { entries: null, version: null, url: kevUrl, error: errorText(err, timeoutMs) };
  }
}

// ---- Federal Register documents (BACKFILL.md §5 with the official API)
// federalregister.gov answers a non-browser user agent with an access wall for every document
// page, and the pipeline never works around one. A document URL
// (https://www.federalregister.gov/documents/YYYY/MM/DD/<document_number>/<slug>) is verified
// through the Federal Register API, the publisher's own machine-readable record, instead: GET
// /api/v1/documents/<document_number>.json with the project user agent; verified iff 200, JSON,
// its html_url names the same document path as the source URL (/documents/YYYY/MM/DD/<number>;
// the slug may differ) and its publication_date is the candidate's date (without a candidate, the
// date in the URL). The HTML page itself is never fetched.

export const FR_DOCUMENT_API_BASE = 'https://www.federalregister.gov/api/v1/documents/';
const FR_DOC_PATH = /^\/documents\/(\d{4})\/(\d{2})\/(\d{2})\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?:\/[^/]*)?\/?$/;

/**
 * A Federal Register document URL -> { document_number, date, path } (path = /documents/YYYY/MM/DD/
 * <number>, without the slug), or null for any other URL.
 */
export function federalRegisterDocOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !/^(?:www\.)?federalregister\.gov$/i.test(u.hostname)) return null;
  const m = FR_DOC_PATH.exec(u.pathname);
  if (!m || !/\d/.test(m[4])) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isIsoDate(date)) return null;
  return { document_number: m[4], date, path: `/documents/${m[1]}/${m[2]}/${m[3]}/${m[4]}` };
}

/** The Federal Register API record of one document. */
export function federalRegisterApiUrl(documentNumber, base = FR_DOCUMENT_API_BASE) {
  return new URL(`${encodeURIComponent(documentNumber)}.json`, base).href;
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Why a Federal Register API document record does not bear out the source URL's document, or
 * null: html_url must name the same document path (the slug may differ), document_number (when
 * given) the same number, and publication_date must be `expectedDate`.
 */
export function federalRegisterRecordProblem(doc, json, expectedDate) {
  if (!isObj(json)) return 'the response is not a JSON object';
  const html = typeof json.html_url === 'string' ? json.html_url.trim() : '';
  const h = federalRegisterDocOf(html);
  if (!h) return `html_url ${quote(html)} is not a Federal Register document URL`;
  if (!samePath(h.path, doc.path)) return `html_url ${html} is not the source URL's document ${doc.path}`;
  if (typeof json.document_number === 'string' && !samePath(json.document_number, doc.document_number)) return `document_number ${quote(json.document_number)} is not ${doc.document_number}`;
  const date = typeof json.publication_date === 'string' ? json.publication_date.trim() : '';
  if (!isIsoDate(date)) return `publication_date ${quote(json.publication_date ?? null)} is not a date`;
  if (date !== expectedDate) return `publication_date ${date} is not the candidate's date ${expectedDate}`;
  return null;
}

// ---- canary probe: does this site answer 200 for pages that do not exist?

/** Prefix of the made-up path segment or query value of a canary URL. */
export const CANARY_PREFIX = 'rs-canary-';
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)+(?:\.[a-z0-9]+)?$/i;

/**
 * A sibling of `url` that cannot exist: the identifying query value (one with a digit, or the last
 * one of a script or home path) or the last path segment replaced by `token`. When the last
 * segment is a slug after an id segment (/documents/2026/01/07/2026-00085/a-rule), the id is
 * replaced: such sites ignore the slug.
 */
export function canaryUrl(url, token) {
  const u = new URL(url);
  u.hash = '';
  const params = [...u.searchParams];
  const ident = params.filter(([k, v]) => !isTrackingParam(k, v, u.hostname) && /\d/.test(v));
  const scriptPath = /\.(?:php|aspx?|jsp|cfm|cgi)$/i.test(u.pathname) || HOME_PATH.test(u.pathname);
  if (ident.length || (scriptPath && params.length)) {
    const replace = new Set(ident.length ? ident.map(([k]) => k) : [params[params.length - 1][0]]);
    const sp = new URLSearchParams();
    for (const [k, v] of params) sp.append(k, replace.has(k) ? token : v);
    u.search = sp.toString();
    return u.href;
  }
  const segs = u.pathname.split('/');
  const idx = segs.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) {
    u.pathname = `/${token}`;
    return u.href;
  }
  let pick = idx[idx.length - 1];
  if (idx.length >= 2) {
    const last = segs[idx[idx.length - 1]];
    const prev = segs[idx[idx.length - 2]];
    // an id has a digit and is not a date part (/2026/01/05/slug: the slug identifies the post)
    if (!/\d/.test(last) && /\d/.test(prev) && !/^\d{1,4}$/.test(prev) && SLUG.test(last)) pick = idx[idx.length - 2];
  }
  const ext = /(\.[a-z0-9]{1,5})$/i.exec(segs[pick])?.[1] ?? '';
  segs[pick] = `${token}${ext}`;
  u.pathname = segs.join('/');
  return u.href;
}

const wordSet = (text) => new Set(String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
/** At or above this word overlap, two pages' opening text counts as the same page. */
export const CANARY_SAME_TEXT = 0.9;

/** Is the canary response the same page as the checked one (the site's 200 proves nothing)? */
export function samePage(real, canary) {
  if (canary.status !== 200 || canary.error) return false;
  const kind = contentKind(real.content_type);
  if (kind !== contentKind(canary.content_type)) return false;
  if (normaliseUrl(canary.final_url) === normaliseUrl(real.final_url)) return true;
  if (kind === 'json') return canary.body === real.body;
  if (kind !== 'html') return false;
  const t1 = pageTitle(real.body).toLowerCase();
  const t2 = pageTitle(canary.body).toLowerCase();
  if (t1 !== t2) return false;
  return jaccard(wordSet(visibleTextStart(real.body, 6000)), wordSet(visibleTextStart(canary.body, 6000))) >= CANARY_SAME_TEXT;
}

/**
 * One GET (attemptGet), retried once with the same user agent when the answer is 403, 429 or 503,
 * after any Retry-After (at most maxRetryAfterMs). Returns { r, retry } (retry: { status, wait_ms }
 * of the first answer, or null).
 */
async function getWithRetry(target, { maxRetryAfterMs = MAX_RETRY_AFTER_MS, ...opts }) {
  const first = await attemptGet(target, opts);
  if (!RETRY_STATUSES.includes(first.status)) return { r: first, retry: null };
  const wait = Math.min(retryAfterMs(first.retry_after), maxRetryAfterMs);
  if (wait > 0) await sleep(wait);
  return { r: await attemptGet(target, opts), retry: { status: first.status, wait_ms: wait } };
}

const retryVia = (retry) => (retry ? ` (retried once after HTTP ${retry.status})` : '');
const titleOf = (r) => (contentKind(r.content_type) === 'html' && r.body ? pageTitle(r.body) : '');

/** A Federal Register document URL checked through the Federal Register API (see federalRegisterDocOf). */
async function checkFederalRegisterDoc(doc, out, { get, expectedDate, stamp }) {
  const apiUrl = federalRegisterApiUrl(doc.document_number);
  const want = isIsoDate(expectedDate) ? expectedDate : doc.date;
  const { r, retry } = await get(apiUrl, JSON_ACCEPT);
  Object.assign(out, {
    status: r.status,
    final_url: r.final_url,
    content_type: r.content_type,
    retried: Boolean(retry),
    retry_status: retry?.status ?? null,
    redirects: r.redirects,
    checked_at: stamp(),
  });
  out.fr = { document_number: doc.document_number, api_url: apiUrl, html_url: null, publication_date: null, expected_date: want, title: null };
  const via = retryVia(retry);
  const wall = accessWall({ status: r.status, final_url: r.final_url, title: titleOf(r) });
  const api = `Federal Register API ${apiUrl}`;
  if (r.error) out.reason = `${api}: ${r.error}${via}`;
  else if (wall) out.reason = `${wall} (${api})${via}`;
  else if (r.status !== 200) out.reason = `${api}: HTTP ${r.status}${via}`;
  else if (!sameSite(apiUrl, r.final_url)) out.reason = `${api}: redirected off-site to ${hostOf(r.final_url)}`;
  else if (contentKind(r.content_type) !== 'json') out.reason = `${api}: content type ${quote(r.content_type ?? '')} is not JSON`;
  else {
    let json = null;
    try { json = JSON.parse(r.body); } catch { json = null; }
    if (json === null) out.reason = `${api}: the response is not valid JSON`;
    else {
      if (isObj(json)) {
        out.fr.html_url = typeof json.html_url === 'string' ? json.html_url : null;
        out.fr.publication_date = typeof json.publication_date === 'string' ? json.publication_date : null;
        out.fr.title = typeof json.title === 'string' ? collapseWhitespace(json.title).slice(0, 200) : null;
      }
      const problem = federalRegisterRecordProblem(doc, json, want);
      if (problem) out.reason = `${api}: ${problem}`;
      else {
        out.verified = true;
        out.verified_by = 'federalregister-api';
        out.reason = `ok: document ${doc.document_number} in the Federal Register API (publication_date ${out.fr.publication_date})${via}`;
      }
    }
  }
  return out;
}

/**
 * Check one source URL live (BACKFILL.md §5). Every request carries the project user agent and no
 * other; the pipeline never impersonates a browser or works around a bot check or access wall.
 * GET following up to 10 redirects (HTTP and quick meta refresh; never https to http unless
 * allowHttp); a 403, 429 or 503 is retried once with the same user agent after any Retry-After (up
 * to 10 s). Verified iff the final status is 200, the response is no access wall (accessWall: an
 * unblock or challenge host, or a bot-check title; reason "access wall ..."), the final URL is on
 * the same site (sameSite), the content type is HTML, PDF, XML or JSON, the response is no
 * redirect to where dead links go (accessWallReason), an HTML page is no soft 404, and a made-up
 * sibling URL (canaryUrl) does not answer with the same page.
 * Official machine-readable records replace the page where a publisher offers one:
 * - a Federal Register document URL is checked through the Federal Register API only (verified_by
 *   "federalregister-api"; publication_date must be `expectedPublicationDate`, else the URL's date);
 * - a CISA KEV catalogue URL is verified against the catalogue JSON (`kev`, from checkUrls) instead
 *   of the soft-404 and canary tests (verified_by "kev-json").
 * `retried` / `retry_status` record a same-agent retry. The time is always the real clock.
 * @param {string} url
 * @param {{timeoutMs?, maxRedirects?, fetchImpl?, allowHttp?, kev?, expectedDateAdded?, expectedPublicationDate?, canary?, maxRetryAfterMs?}} opts
 */
export async function checkUrl(url, { timeoutMs = 20000, maxRedirects = 10, fetchImpl = fetch, allowHttp = false, kev = null, expectedDateAdded = null, expectedPublicationDate = null, canary = true, maxRetryAfterMs = MAX_RETRY_AFTER_MS } = {}) {
  // check_id tells two checks of one URL in the same second apart in the history
  const base = { url, check_id: randomBytes(6).toString('hex'), status: null, final_url: null, content_type: null, verified: false, verified_by: null, reason: null, checked_at: null, user_agent: USER_AGENT, retried: false, retry_status: null, redirects: 0, title: null };
  const stamp = () => toEtIso(new Date());
  let parsed = null;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || !(parsed.protocol === 'https:' || (allowHttp && parsed.protocol === 'http:'))) {
    return { ...base, reason: 'not an https URL', checked_at: stamp() };
  }
  const opts = { timeoutMs, maxRedirects, fetchImpl, allowHttp };
  const get = (target, accept = PAGE_ACCEPT) => getWithRetry(target, { ...opts, accept, maxRetryAfterMs });
  const fr = federalRegisterDocOf(url);
  if (fr) return checkFederalRegisterDoc(fr, { ...base }, { get, expectedDate: expectedPublicationDate, stamp });

  const { r, retry } = await get(url);
  const title = titleOf(r);
  const wall = accessWall({ status: r.status, final_url: r.final_url, title });
  const deadLink = accessWallReason(url, { ...r, title });
  const out = {
    ...base,
    status: r.status,
    final_url: r.final_url,
    content_type: r.content_type,
    retried: Boolean(retry),
    retry_status: retry?.status ?? null,
    redirects: r.redirects,
    checked_at: stamp(),
  };
  if (r.meta_refreshes) out.meta_refreshes = r.meta_refreshes;
  const kind = contentKind(r.content_type);
  if (kind === 'html' && r.body) out.title = title.slice(0, 200) || null;
  const via = retryVia(retry);
  const cve = kevCveOf(url);
  if (r.error) out.reason = `${r.error}${via}`;
  // a walled page is simply not verified (never bypassed), wherever the wall is served from
  else if (wall) out.reason = `${wall}${via}`;
  else if (r.status !== 200) out.reason = `HTTP ${r.status}${via}`;
  else if (!sameSite(url, r.final_url)) out.reason = `redirected off-site to ${hostOf(r.final_url)} (${siteOf(hostOf(r.final_url))} is not ${siteOf(hostOf(url))})`;
  else if (!kind) out.reason = `content type ${quote(r.content_type ?? '')} is not HTML, PDF, XML or JSON`;
  else if (deadLink) out.reason = `${deadLink}${via}`;
  else if (cve) {
    const entry = kev?.entries?.get(cve);
    out.kev = { cve, date_added: entry ?? null, catalog_version: kev?.version ?? null };
    if (!kev || !kev.entries) out.reason = `the KEV catalogue page answers 200 for any query, so ${cve} is verified against the catalogue JSON, which was unavailable (${kev?.error ?? 'not loaded'})`;
    else if (!entry) out.reason = `${cve} is not in the KEV catalogue JSON (version ${kev.version ?? 'unknown'}); the catalogue page answers 200 for any query`;
    else if (expectedDateAdded && entry !== expectedDateAdded) out.reason = `the KEV catalogue JSON lists ${cve} with dateAdded ${entry}, not ${expectedDateAdded}`;
    else {
      out.verified = true;
      out.verified_by = 'kev-json';
      out.reason = `ok: ${cve} in the KEV catalogue JSON (version ${kev.version ?? 'unknown'}, dateAdded ${entry})${via}`;
    }
  } else {
    const soft = kind === 'html' ? soft404Reason(r.body) : null;
    if (soft) out.reason = `soft 404: ${soft}`;
    else if (canary && (kind === 'html' || kind === 'json')) {
      let probe;
      try {
        const curl = canaryUrl(url, `${CANARY_PREFIX}${randomBytes(5).toString('hex')}`);
        // one attempt, no retry: a canary only has to show what the site answers for a made-up URL
        const c = await attemptGet(curl, { ...opts, accept: PAGE_ACCEPT });
        probe = { url: curl, status: c.status, final_url: c.final_url, error: c.error ?? null, same_page: samePage(r, c) };
      } catch (err) {
        probe = { url: null, status: null, final_url: null, error: String(err?.message ?? err).slice(0, 200), same_page: false };
      }
      out.canary = probe;
      if (probe.same_page) {
        out.reason = `soft 404: a made-up sibling URL (${probe.url}) answers 200 with the same page${probe.final_url && normaliseUrl(probe.final_url) === normaliseUrl(r.final_url) ? ` (redirected to ${r.final_url})` : ''}; this site's 200 does not show that the page exists`;
      }
    }
    if (!out.reason) {
      out.verified = true;
      out.verified_by = 'page';
      out.reason = `ok${via}`;
    }
  }
  return out;
}

/**
 * Check many URLs (deduplicated by normalised URL) with bounded concurrency. The KEV catalogue
 * JSON is fetched once when a URL is a KEV catalogue page. `expected` maps a normalised URL to
 * { kev_date_added } or { publication_date } (from the pass's candidates; expectedChecks).
 */
export async function checkUrls(urls, { concurrency = 4, kevUrl = KEV_URL, expected = new Map(), ...opts } = {}) {
  const seen = new Set();
  const list = [];
  for (const u of urls) {
    const key = normaliseUrl(u) ?? u;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(u);
  }
  const kev = list.some((u) => kevCveOf(u)) ? await loadKev(kevUrl, { timeoutMs: Math.max(opts.timeoutMs ?? 20000, 30000), fetchImpl: opts.fetchImpl }) : null;
  return mapPool(list, concurrency, (u) => {
    const e = expected.get(normaliseUrl(u) ?? u);
    return checkUrl(u, { ...opts, kev, expectedDateAdded: e?.kev_date_added ?? null, expectedPublicationDate: e?.publication_date ?? null });
  });
}

/**
 * The dates the official records must confirm for the pass's candidates: KEV dateAdded for a KEV
 * catalogue candidate ({ kev_date_added }), the publication date for a Federal Register document
 * ({ publication_date }). Map(normalised URL -> expectation).
 */
export function expectedChecks(candidates) {
  const out = new Map();
  for (const c of candidates ?? []) {
    if (!isObj(c) || typeof c.url !== 'string' || !isIsoDate(c.published_date)) continue;
    if (kevCveOf(c.url)) out.set(normaliseUrl(c.url), { kev_date_added: c.published_date });
    else if (federalRegisterDocOf(c.url)) out.set(normaliseUrl(c.url), { publication_date: c.published_date });
  }
  return out;
}

export function emptyUrlCheckDoc(w) {
  return { schema_version: 1, ...passFields(w), updated_at: null, checks: {} };
}

/** The fields of a check that go into the audit log and url-check.json history. */
export function checkSummary(check) {
  if (!isObj(check)) return null;
  const s = {
    status: check.status ?? null,
    final_url: check.final_url ?? null,
    content_type: check.content_type ?? null,
    verified: check.verified === true,
    verified_by: check.verified_by ?? null,
    reason: check.reason ?? null,
    checked_at: check.checked_at ?? null,
    check_id: check.check_id ?? null,
  };
  if (check.retried === true) {
    s.retried = true;
    s.retry_status = check.retry_status ?? null;
  }
  if (isObj(check.kev)) s.kev = { cve: check.kev.cve ?? null, date_added: check.kev.date_added ?? null, catalog_version: check.kev.catalog_version ?? null };
  if (isObj(check.fr)) s.fr = { document_number: check.fr.document_number ?? null, api_url: check.fr.api_url ?? null, html_url: check.fr.html_url ?? null, publication_date: check.fr.publication_date ?? null };
  if (isObj(check.canary)) s.canary = { url: check.canary.url ?? null, status: check.canary.status ?? null, same_page: check.canary.same_page === true };
  return s;
}

const checkTime = (c) => (isObj(c) && isEtIso(c.checked_at) ? Date.parse(c.checked_at) : NaN);
const isFutureCheck = (c, now) => checkTime(c) > now.getTime() + URL_CHECK_FUTURE_TOLERANCE_MS;
const historyKey = (h) => (typeof h.check_id === 'string' && h.check_id ? h.check_id : `${h.checked_at}|${h.status}|${h.final_url}|${h.verified}|${h.reason}`);

/**
 * Merge check records into url-check.json, keyed by normalised URL. Every check is kept in the
 * entry's `history` (oldest first; BACKFILL.md §5: every check is recorded); the entry's own
 * fields are the newest check. A check without a valid ET checked_at, or stamped more than 5
 * minutes after the real time `now` (a forged or skewed clock), is ignored, including one already
 * in the file: `onIgnored(key, record, why)` is told.
 */
export function mergeUrlChecks(doc, records, now = new Date(), { onIgnored = () => {} } = {}) {
  const checks = {};
  const valid = (key, rec) => {
    if (!isObj(rec)) return false;
    if (!Number.isFinite(checkTime(rec))) {
      onIgnored(key, rec, 'no valid checked_at');
      return false;
    }
    if (isFutureCheck(rec, now)) {
      onIgnored(key, rec, `checked_at ${rec.checked_at} is after the real time ${toEtIso(now)}`);
      return false;
    }
    return true;
  };
  const add = (key, rec, histories) => {
    const entry = checks[key];
    const hist = new Map((entry?.history ?? []).map((h) => [historyKey(h), h]));
    for (const h of histories) if (isObj(h) && Number.isFinite(checkTime(h)) && !isFutureCheck(h, now)) hist.set(historyKey(h), h);
    const history = [...hist.values()].sort((a, b) => checkTime(a) - checkTime(b));
    const newest = !entry || checkTime(rec) >= checkTime(entry) ? rec : entry;
    const { history: _drop, ...fields } = newest;
    checks[key] = { ...fields, history };
  };
  for (const [key, rec] of Object.entries(isObj(doc?.checks) ? doc.checks : {})) {
    if (!isObj(rec)) continue;
    const hist = (Array.isArray(rec.history) ? rec.history : []).filter((h) => isObj(h) && Number.isFinite(checkTime(h)) && !isFutureCheck(h, now));
    if (valid(key, rec)) add(key, rec, [...hist, checkSummary(rec)]);
    else if (hist.length) {
      // the entry's own fields are unusable; its newest believable history entry stands in
      const newest = hist.reduce((a, b) => (checkTime(b) >= checkTime(a) ? b : a));
      add(key, { ...newest, url: typeof rec.url === 'string' ? rec.url : key }, hist);
    }
  }
  for (const r of records) {
    const key = normaliseUrl(r?.url) ?? r?.url;
    if (!valid(key, r)) continue;
    add(key, r, [checkSummary(r)]);
  }
  const key = typeof doc?.day === 'string' ? { day: doc.day } : { month: doc?.month ?? null };
  return { schema_version: 1, ...key, updated_at: toEtIso(now), checks };
}

/** Why a verified record does not hold up when its fields are read again, or null. */
function recordProblem(sourceUrl, check) {
  if (normaliseUrl(check.url) !== normaliseUrl(sourceUrl)) return `the check is of ${check.url ?? 'no URL'}, not this URL`;
  if (!isHttpsUrl(check.url)) return 'the checked URL is not https';
  if (check.status !== 200) return `status ${check.status ?? 'none'}, not 200`;
  if (!isHttpsUrl(check.final_url)) return `final URL ${check.final_url ?? 'none'} is not https`;
  if (!sameSite(check.url, check.final_url)) return `final URL ${check.final_url} is off-site`;
  if (!contentKind(check.content_type)) return `content type ${quote(check.content_type ?? '')} is not HTML, PDF, XML or JSON`;
  const wall = accessWallReason(check.url, { status: check.status, final_url: check.final_url, redirects: check.redirects ?? 0, title: check.title ?? '' });
  if (wall) return wall;
  const cve = kevCveOf(check.url);
  if (cve && !(check.verified_by === 'kev-json' && check.kev?.cve === cve && isIsoDate(check.kev?.date_added))) return `a KEV catalogue page is verified only against the catalogue JSON (verified_by kev-json for ${cve})`;
  const fr = federalRegisterDocOf(check.url);
  if (fr) {
    if (check.verified_by !== 'federalregister-api' || !isObj(check.fr) || !samePath(check.fr.document_number, fr.document_number)) {
      return `a Federal Register document is verified only through the Federal Register API (verified_by federalregister-api for ${fr.document_number})`;
    }
    if (!new URL(check.final_url).pathname.startsWith('/api/v1/documents/')) return `final URL ${check.final_url} is not a Federal Register API document record`;
    const problem = federalRegisterRecordProblem(fr, { html_url: check.fr.html_url, publication_date: check.fr.publication_date }, check.fr.publication_date);
    if (problem) return `the Federal Register API record ${problem}`;
    return null;
  }
  if (!cve && check.verified_by !== 'page') return 'verified_by is not "page"';
  return null;
}

/**
 * Why a source URL may not be published on this check, or null (BACKFILL.md §5, §6: verified,
 * by a check of this URL, no older than 24 h, and its recorded fields bear the verdict out).
 * `now` is the real time; `url` the source URL the check must be of.
 */
export function urlCheckIssue(check, now, { url = null, maxAgeHours = URL_CHECK_MAX_AGE_HOURS } = {}) {
  if (!check) return 'not checked';
  if (check.verified !== true) return `failed verification (${check.reason ?? 'no reason recorded'}; checked ${check.checked_at ?? 'at an unknown time'}): remove the source, or drop the item BF_URL_UNVERIFIED when no verified source carries its facts`;
  const problem = recordProblem(url ?? check.url, check);
  if (problem) return `the check record says verified but ${problem}`;
  const t = Date.parse(check.checked_at);
  if (!isEtIso(check.checked_at) || !Number.isFinite(t)) return 'the check has no valid checked_at';
  const age = now.getTime() - t;
  if (age > maxAgeHours * 3600e3) return `verified ${check.checked_at}, more than ${maxAgeHours} h before ${toEtIso(now)}`;
  if (age < -URL_CHECK_FUTURE_TOLERANCE_MS) return `checked_at ${check.checked_at} is after now (${toEtIso(now)})`;
  return null;
}

/**
 * The URLs to check for a decisions-shaped document (or a plain list of URLs): every source URL
 * of every item, and with `candidates`, the URL of every candidate dropped BF_URL_UNVERIFIED.
 */
export function urlsToVerify(doc, candidates = null) {
  if (Array.isArray(doc)) return doc.filter((u) => typeof u === 'string');
  if (Array.isArray(doc?.urls)) return doc.urls.filter((u) => typeof u === 'string');
  const out = [];
  for (const it of Array.isArray(doc?.items) ? doc.items : []) {
    for (const s of Array.isArray(it?.sources) ? it.sources : []) if (typeof s?.url === 'string') out.push(s.url);
  }
  if (Array.isArray(candidates)) {
    const byId = new Map(candidates.filter(isObj).map((c) => [c.candidate_id, c]));
    for (const j of Array.isArray(doc?.judgments) ? doc.judgments : []) {
      const c = isObj(j) && j.reason_code === 'BF_URL_UNVERIFIED' ? byId.get(j.candidate_id) : null;
      if (typeof c?.url === 'string') out.push(c.url);
    }
  }
  return out;
}

// ---------------------------------------------------------------- publish planner (§4, §6)

/** FILTER.md §8.2 codes plus the backfill-only drop codes. */
export function backfillReasonCodes(filterText) {
  const codes = parseReasonCodes(filterText);
  if (!codes) return null;
  const out = new Map(codes);
  for (const c of BF_REASON_CODES) out.set(c, 'drop');
  return out;
}

const timestampInWindow = (it, w) => typeof it?.timestamp === 'string' && instantInWindow(it.timestamp, w);

/**
 * Existing backfilled items whose timestamps fall in the pass's window: that pass key's items
 * (pass windows never overlap, so another month's or day's items are never counted).
 */
export function backfilledInWindow(archiveItems, w) {
  return (archiveItems ?? []).filter((it) => it?.backfilled === true && timestampInWindow(it, w));
}

/** The key of the pass whose window holds an instant (Date, ms or ISO; PASSES, `until` applied), or null. */
export function passKeyAt(t) {
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  for (const key of Object.keys(PASSES)) {
    const w = passWindow(key);
    if (ms >= w.start.getTime() && ms < w.end.getTime()) return key;
  }
  return null;
}

const cleanValidatorText = (s) => s
  .replace(/is not a stage-1 survivor of this run/g, 'is not a registered candidate of this pass')
  .replace(/this run's candidates\.json/g, "the pass's candidates.json");

/**
 * Plan a backfill publish: everything BACKFILL.md §6 requires, computed in memory. Never writes.
 * @param {object} ctx
 *   decisions      parsed <work>/decisions.json (run_id "backfill-<key>": the month or the day)
 *   candidates     the pass's candidates (candidates.json)
 *   archive        parsed archive.json; runs: parsed runs.json (read only)
 *   urlChecks      the live checks publish just made (normalised URL -> checkUrl record): every
 *                  item source URL and every BF_URL_UNVERIFIED candidate URL
 *   urlHistory     every recorded check per normalised URL (url-check.json history plus the live
 *                  checks), written to the audit log; informational, never gating
 *   auditRows      rows of logs/backfill/<key>.jsonl from earlier publishes of this pass, or null
 *   thresholds     loadThresholds() result; filterText: FILTER.md text
 *   window         passWindow() (monthWindow or dayWindow, `until` applied); sections: the pass's sections
 *   now            the real time, for the age of the URL checks (never --now)
 *   appendMissing  --append-missing
 *   rejudge        --rejudge: candidate ids whose logged drop is judged again (needs appendMissing)
 * @returns {{ errors, warnings, notices, newItems, nextArchive, logRows, notJudged, skipped, nothingNew }}
 */
export function planPublish(ctx) {
  const { candidates = [], archive, runs = null, urlChecks = {}, urlHistory = {}, auditRows = null, thresholds, filterText, window: w, sections, now = new Date(), appendMissing = false, rejudge = [] } = ctx;
  const v = new Issues();
  const notices = [];
  const result = (extra = {}) => ({ errors: v.errors, warnings: v.warnings, notices, newItems: [], nextArchive: null, logRows: [], notJudged: [], skipped: { judgments: [], items: [] }, nothingNew: false, ...extra });
  const raw = ctx.decisions;
  if (!isObj(raw)) {
    v.error('decisions', 'must be a JSON object');
    return result();
  }
  if (!Array.isArray(raw.judgments) || !Array.isArray(raw.items)) {
    if (!Array.isArray(raw.judgments)) v.error('decisions', 'judgments: must be an array');
    if (!Array.isArray(raw.items)) v.error('decisions', 'items: must be an array');
    return result();
  }
  if (raw.run_id !== w.id) v.error('decisions', `run_id: ${quote(raw.run_id)} must be ${quote(w.id)} for the ${w.key} pass`);
  if (raw.judgments.length === 0) {
    v.error('decisions', 'judgments: empty; a publish records the pass\'s judgments (nothing to publish)');
    return result();
  }
  const reasonCodes = backfillReasonCodes(filterText);
  if (!reasonCodes) {
    v.error('decisions', 'FILTER.md §8.2 reason-code list unavailable (--filter); a backfill is judged against the closed list');
    return result();
  }

  if (Array.isArray(rejudge) && rejudge.length && !appendMissing) {
    v.error('rejudge', '--rejudge needs --append-missing (it re-judges candidates an earlier publish logged)');
    return result();
  }

  // ---- 1. one publish per month (BACKFILL.md §6), unless --append-missing
  const archiveItems = Array.isArray(archive?.items) ? archive.items : [];
  const prior = backfilledInWindow(archiveItems, w);
  if ((prior.length || auditRows) && !appendMissing) {
    v.error('archive', `the ${w.key} backfill was already published (${prior.length} backfilled item(s) in the window${prior.length ? `: ${prior.slice(0, 5).map((i) => i.id).join(', ')}${prior.length > 5 ? ', ...' : ''}` : ''}${auditRows ? '; audit log present' : ''}); refusing to publish twice. Use --append-missing to add only new items`);
    return result();
  }

  // ---- 2. --append-missing: judgments logged by an earlier publish are not judged again
  let decisions = structuredClone(raw);
  const skipped = { judgments: [], items: [] };
  const priorRows = new Map();
  for (const r of auditRows ?? []) if (isObj(r) && typeof r.candidate_id === 'string') priorRows.set(r.candidate_id, r);
  // ---- 2a. --rejudge (BACKFILL.md §6): after an owner revision of FILTER.md, named candidates whose
  // logged judgment was a drop are judged again. Their earlier rows stay in the audit log; the new
  // rows are appended with rejudged: true. A candidate of a published item is never re-judged.
  const rejudged = new Map();
  const errorsBeforeRejudge = v.errors.length;
  for (const id of Array.isArray(rejudge) ? rejudge : []) {
    const r = priorRows.get(id);
    if (!appendMissing) v.error('rejudge', '--rejudge needs --append-missing (it re-judges candidates an earlier publish logged)');
    else if (!r || !['pass', 'drop'].includes(r.verdict)) v.error('rejudge', `${id} has no logged judgment in the ${w.key} pass`);
    else if (r.verdict !== 'drop' || r.item_id) v.error('rejudge', `${id} belongs to a published item${r.item_id ? ` (${r.item_id})` : ''}; published items are never re-judged (a later fact is a material update)`);
    else rejudged.set(id, r);
  }
  if (v.errors.length > errorsBeforeRejudge) return result();
  for (const id of rejudged.keys()) priorRows.delete(id);
  if (rejudged.size) notices.push(`--rejudge: ${rejudged.size} candidate(s) judged again after a FILTER.md revision: ${[...rejudged.keys()].join(', ')}`);
  if (appendMissing && auditRows) {
    const prevJudged = new Set([...priorRows.values()].filter((r) => r.verdict === 'pass' || r.verdict === 'drop').map((r) => r.candidate_id));
    const isPrev = (j) => isObj(j) && prevJudged.has(j.candidate_id);
    const keepItems = [];
    const remap = new Map();
    const skippedIdx = new Set();
    decisions.items.forEach((item, i) => {
      const refs = decisions.judgments.filter((j) => isObj(j) && j.draft_index === i);
      const old = refs.filter(isPrev);
      if (refs.length && old.length === refs.length) {
        const primary = normaliseUrl(item?.sources?.[0]?.url);
        const done = prior.find((it) => normaliseUrl(it.sources?.[0]?.url) === primary);
        if (done) {
          skipped.items.push({ draft_index: i, id: done.id });
          skippedIdx.add(i);
        } else {
          v.error(`decisions.items[${i}]`, `its judgments (${old.map((j) => j.candidate_id).join(', ')}) were logged by an earlier publish of ${w.key}, but no backfilled item has its primary source; a candidate is judged once per pass`);
        }
        return;
      }
      if (old.length) {
        v.error(`decisions.items[${i}]`, `mixes candidates judged by an earlier publish of ${w.key} (${old.map((j) => j.candidate_id).join(', ')}) with new ones`);
        return;
      }
      remap.set(i, keepItems.length);
      keepItems.push(item);
    });
    const keepJudgments = [];
    for (const j of decisions.judgments) {
      if (isPrev(j)) {
        skipped.judgments.push(j.candidate_id);
        continue;
      }
      if (isObj(j) && Number.isInteger(j.draft_index)) {
        if (skippedIdx.has(j.draft_index)) v.error(`decisions.judgments (${j.candidate_id})`, `draft_index ${j.draft_index} points at an item an earlier publish already added (${skipped.items.find((x) => x.draft_index === j.draft_index)?.id}); a new candidate on a published story is a material update or DD_SAME_STORY`);
        j.draft_index = remap.has(j.draft_index) ? remap.get(j.draft_index) : -1;
      }
      keepJudgments.push(j);
    }
    decisions = { ...decisions, judgments: keepJudgments, items: keepItems };
    if (skipped.judgments.length) notices.push(`--append-missing: ${skipped.judgments.length} judgment(s) already logged by an earlier publish skipped; ${skipped.items.length} item(s) already published (${skipped.items.map((x) => x.id).join(', ') || 'none'})`);
    if (!keepJudgments.length && !v.errors.length) {
      notices.push(`--append-missing: nothing new to publish for ${w.key}`);
      return result({ skipped, nothingNew: true });
    }
  }
  const judgments = decisions.judgments;
  const items = decisions.items;

  // ---- 3. judged candidates are registered candidates of the pass
  const candById = new Map(candidates.map((c) => [c.candidate_id, c]));
  const candByNorm = new Map(candidates.map((c) => [normaliseUrl(c.url), c]));
  const judgedIds = [];
  judgments.forEach((j, i) => {
    if (!isObj(j) || typeof j.candidate_id !== 'string' || !CANDIDATE_ID_RE.test(j.candidate_id)) return;
    if (!candById.has(j.candidate_id)) v.error(`decisions.judgments[${i}] (${j.candidate_id})`, 'candidate_id: not a registered candidate of this pass (register it with backfill.mjs collect or add)');
    else judgedIds.push(j.candidate_id);
  });
  const judgedSet = new Set(judgedIds);

  // ---- 4. the pass's sections and window (BACKFILL.md §1)
  const inPass = (s) => sections.includes(s);
  judgments.forEach((j, i) => {
    if (!isObj(j)) return;
    const a = `decisions.judgments[${i}]${typeof j.candidate_id === 'string' ? ` (${j.candidate_id})` : ''}`;
    const st = j.section_tested;
    const code = j.reason_code;
    if (SECTIONS.includes(st) && !inPass(st) && code !== 'BF_SECTION_EXCLUDED') {
      v.error(a, `section_tested: ${st} is outside the ${w.key} pass (${sections.join(', ')}); a candidate that would qualify only there is dropped BF_SECTION_EXCLUDED, never re-routed`);
    }
    if (code === 'BF_SECTION_EXCLUDED' && st !== null && inPass(st)) v.error(a, `section_tested: BF_SECTION_EXCLUDED names a section outside the pass (or null), not ${st}`);
    if (code === 'BF_OUT_OF_WINDOW' && st !== null) v.error(a, 'section_tested: BF_OUT_OF_WINDOW requires null');
    const c = candById.get(j.candidate_id);
    if (c?.background === true && j.verdict === 'pass') v.error(a, `verdict: ${j.candidate_id} was registered as background (--allow-background); it only counts towards prominence and is never judged pass`);
    if (c?.outside_window === true && j.verdict === 'pass') v.error(a, `verdict: ${j.candidate_id} was registered outside the window (outside_window); it can only corroborate an in-window source, or be dropped BF_OUT_OF_WINDOW`);
  });
  items.forEach((item, i) => {
    if (isObj(item) && SECTIONS.includes(item.section) && !inPass(item.section)) {
      v.error(`decisions.items[${i}]`, `section: ${item.section} is outside the ${w.key} pass (${sections.join(', ')}); drop the story BF_SECTION_EXCLUDED`);
    }
  });

  // ---- 5. timestamps (§4) and ids
  const timing = items.map((item) => (isObj(item) ? itemTiming(item, candByNorm, w) : { slot: null, issues: [] }));
  timing.forEach((t, i) => { for (const msg of t.issues) v.error(`decisions.items[${i}]`, msg); });
  const groups = new Map();
  timing.forEach((t, i) => {
    if (!t.slot || t.issues.length) return;
    if (!groups.has(t.slot.iso)) groups.set(t.slot.iso, { slot: t.slot, members: [] });
    groups.get(t.slot.iso).members.push(i);
  });
  const taken = new Set(archiveItems.map((it) => it?.id).filter(Boolean));
  const idOf = new Map();
  const slotOf = new Map();
  for (const { slot, members } of groups.values()) {
    let offset = 0;
    if (appendMissing) {
      for (const id of taken) if (id.startsWith(`${slot.id_stem}-`)) offset = Math.max(offset, Number(id.slice(-2)) || 0);
    }
    let order;
    try {
      order = assignIds(members.map((i) => items[i]), slot.id_stem);
    } catch (err) {
      v.error(`slot ${slot.iso}`, err.message);
      continue;
    }
    for (const o of order) {
      const di = members[o.draftIndex];
      const nn = Number(o.id.slice(-2)) + offset;
      if (nn > 99) {
        v.error(`decisions.items[${di}]`, `slot ${slot.iso} would need NN ${nn}; ids allow at most 99`);
        continue;
      }
      const id = `${slot.id_stem}-${pad2(nn)}`;
      if (taken.has(id)) {
        v.error(`decisions.items[${di}]`, `id ${id} already exists in the archive; ids never collide with existing items (BACKFILL.md §4)`);
        continue;
      }
      idOf.set(di, id);
      slotOf.set(di, slot);
    }
  }

  // ---- 6. references to earlier items: an RS id (an item of this batch, of an earlier publish of
  // this pass, or a backfilled item of an earlier pass, any key), or a candidate id of an item of
  // this batch or of an earlier publish of this pass. Never an item of a later pass.
  const archiveById = new Map(archiveItems.filter((it) => typeof it?.id === 'string').map((it) => [it.id, it]));
  const batchById = new Map([...idOf].map(([di, id]) => [id, { di, slot: slotOf.get(di) }]));
  const itemOfCand = new Map();
  items.forEach((item, i) => {
    for (const cid of Array.isArray(item?.candidate_ids) ? item.candidate_ids : []) if (typeof cid === 'string' && !itemOfCand.has(cid)) itemOfCand.set(cid, i);
  });
  const resolve = (ref, at, what) => {
    if (typeof ref !== 'string' || !CANDIDATE_ID_RE.test(ref)) return ref;
    if (itemOfCand.has(ref)) {
      const di = itemOfCand.get(ref);
      if (idOf.has(di)) return idOf.get(di);
      v.error(at, `${what}: ${ref} belongs to items[${di}], which has no id (see its errors)`);
      return ref;
    }
    const row = priorRows.get(ref);
    if (row && typeof row.item_id === 'string') return row.item_id;
    v.error(at, `${what}: ${ref} is not a candidate of any item of this batch or of an earlier publish of ${w.key}; name an item of an earlier pass by its id (RS-YYMMDD-HHMM-NN)`);
    return ref;
  };
  const instantOfRef = (id) => {
    if (batchById.has(id)) return batchById.get(id).slot.instant.getTime();
    const t = Date.parse(archiveById.get(id)?.timestamp);
    return Number.isFinite(t) ? t : null;
  };
  const isBackfilledRef = (id) => batchById.has(id) || archiveById.get(id)?.backfilled === true;
  const slotIsoOfRef = (id) => (batchById.has(id) ? batchById.get(id).slot.iso : archiveById.get(id)?.timestamp ?? '?');
  // a backfilled archive item after this pass's window belongs to a later pass (any key)
  const laterPassOf = (id) => {
    if (batchById.has(id)) return null;
    const it = archiveById.get(id);
    const t = Date.parse(it?.timestamp);
    if (it?.backfilled !== true || !Number.isFinite(t) || t < w.end.getTime()) return null;
    return { key: passKeyAt(t) };
  };
  const laterPassText = (what, id, later) => `${what}: ${id} (${slotIsoOfRef(id)}) is ${later.key ? `an item of the later ${later.key} pass` : `a backfilled item after the ${w.key} window`}; a pass references only backfilled items of earlier passes or of its own, never a later pass's (BACKFILL.md §2: as of the date, no hindsight)`;
  judgments.forEach((j, i) => {
    if (!isObj(j) || (j.dedup !== 'material_update' && j.dedup !== 'same_story_dropped')) return;
    const a = `decisions.judgments[${i}]${typeof j.candidate_id === 'string' ? ` (${j.candidate_id})` : ''}`;
    j.match_id = resolve(j.match_id, a, 'match_id');
    if (typeof j.match_id !== 'string' || !ITEM_ID_RE.test(j.match_id)) return;
    const t = instantOfRef(j.match_id);
    if (t === null) return; // validateDecisions: not a published item
    if (j.dedup === 'material_update' && !isBackfilledRef(j.match_id)) {
      v.error(a, `match_id: ${j.match_id} is a live item; a backfilled item never references a live item (BACKFILL.md §2)`);
    }
    // §2, as of the date: the story this candidate repeats or updates was out before it
    const c = candById.get(j.candidate_id);
    const own = c ? candidateSlot(c, w) : null;
    const later = laterPassOf(j.match_id);
    if (later) v.error(a, laterPassText('match_id', j.match_id, later));
    else if (own && t >= own.slot.instant.getTime()) {
      v.error(a, `match_id: ${j.match_id} (${slotIsoOfRef(j.match_id)}) is not earlier than this candidate's own slot ${own.slot.iso}; the earlier story must precede this candidate (BACKFILL.md §2: as of the date, no hindsight). The first publication of a story is its item; outlets in the same slot are cluster members of it`);
    }
  });
  items.forEach((item, i) => {
    if (!isObj(item) || item.update_of === null || item.update_of === undefined) return;
    const a = `decisions.items[${i}]`;
    item.update_of = resolve(item.update_of, a, 'update_of');
    const ref = item.update_of;
    if (typeof ref !== 'string' || !ITEM_ID_RE.test(ref)) return;
    const t = instantOfRef(ref);
    if (t === null) return; // validateDecisions: not a published item
    if (!isBackfilledRef(ref)) v.error(a, `update_of: ${ref} is a live item; a backfilled item never references a live item (BACKFILL.md §2)`);
    const mine = slotOf.get(i);
    const later = laterPassOf(ref);
    if (later) v.error(a, laterPassText('update_of', ref, later));
    else if (mine && t >= mine.instant.getTime()) v.error(a, `update_of: ${ref} is not earlier than this item (${mine.iso}); a material update points at an earlier backfilled item`);
  });

  // ---- 7. the live gate: publish.mjs (validateDecisions) plus selfcheck.mjs's strict layer
  const stubs = [...idOf].map(([di, id]) => ({ id, timestamp: slotOf.get(di).iso, backfilled: true, update_of: typeof items[di]?.update_of === 'string' ? items[di].update_of : null, sources: [] }));
  const view = candidates.map((c) => (judgedSet.has(c.candidate_id) || c.extra ? c : { ...c, extra: true }));
  const claimsMayNameInstitutions = thresholds.bool('claims_may_name_institutions');
  const reasonElements = parseReasonCodeElements(filterText);
  const knobs = thresholds.knobs();
  const live = validateDecisions(decisions, {
    runId: w.id,
    candidates: view,
    survivorIds: judgedIds,
    archiveItems: [...archiveItems, ...stubs],
    reasonCodes,
    reasonElements,
    knobs,
    style: false,
    claimsMayNameInstitutions,
    window: null,
    filterText,
  });
  for (const e of live.errors) if (!/is not a stage-1 survivor of this run/.test(e)) v.errors.push(cleanValidatorText(e));
  for (const x of live.warnings) v.warnings.push(cleanValidatorText(x));
  if (decisions.threshold_level !== thresholds.level) {
    v.error('decisions.threshold_level', `${quote(decisions.threshold_level)} must equal thresholds.json level ${quote(thresholds.level)} (FILTER Appendix A)`);
  }
  judgments.forEach((j, i) => {
    if (isObj(j) && j.dedup === 'cluster_merged' && !(typeof j.reason === 'string' && j.reason.startsWith('cluster member of '))) {
      v.error(`decisions.judgments[${i}] (${j.candidate_id})`, 'reason: a cluster member\'s reason begins "cluster member of <lead candidate_id>" (FILTER 5.2, 8.3.6)');
    }
  });
  items.forEach((item, i) => { if (isObj(item)) v.merge(styleWarnings(item, `decisions.items[${i}]`, { strict: true })); });
  for (const s of decisionStyleIssues(decisions, { candidates: view, archiveItems, reasonElements, knobs, filterText })) {
    if (s.banned) v.error(s.at, `${s.message} (${s.rule})`);
    else v.warn(s.at, `${s.message} (${s.rule})`);
  }
  // FILTER 7.7.6 (AO3) inside the pass: a month published as one batch stands for many live runs,
  // so each rationale is also checked against the rationales of the pass's earlier items
  const inOrder = [...idOf].sort(([da, a], [db, b]) => slotOf.get(da).instant - slotOf.get(db).instant || a.localeCompare(b));
  const earlier = [];
  for (const [di, id] of inOrder) {
    const r = items[di]?.awareness_rationale;
    if (typeof r !== 'string' || !r.trim()) continue;
    for (const prev of earlier) {
      const hit = findVerbatim(r, prev.ngrams, 12);
      if (hit) {
        v.error(`decisions.items[${di}]`, `awareness_rationale: repeats 12+ consecutive words of the rationale of ${prev.id}, earlier in this pass (${quote(hit)}); it fails AO3 specificity (FILTER 7.7)`);
        break;
      }
    }
    earlier.push({ id, ngrams: buildNgramSet([r], 12) });
  }
  // BACKFILL.md §3: a paywalled publication is headline and lead only, never the primary source
  items.forEach((item, i) => {
    const s = Array.isArray(item?.sources) ? item.sources[0] : null;
    const c = isObj(s) && typeof s.url === 'string' ? candByNorm.get(normaliseUrl(s.url)) : null;
    if (c?.paywalled === true) {
      v.error(`decisions.items[${i}].sources[0]`, `${s.url}: ${c.publication} is paywalled (headline and lead only) and never the primary source of a backfilled item (BACKFILL.md §3); cite a public source first, or drop the story`);
    }
  });

  // ---- 8. every source URL verified live, by the checks publish just made (BACKFILL.md §5, §6)
  const checks = isObj(urlChecks) ? urlChecks : {};
  const checkOf = (url) => checks[normaliseUrl(url) ?? url] ?? null;
  items.forEach((item, i) => {
    (Array.isArray(item?.sources) ? item.sources : []).forEach((s, k) => {
      if (!isObj(s) || typeof s.url !== 'string') return;
      const chk = checkOf(s.url);
      const issue = urlCheckIssue(chk, now, { url: s.url });
      if (issue) {
        v.error(`decisions.items[${i}].sources[${k}]`, `${s.url}: ${issue}`);
        return;
      }
      // a KEV catalogue source: the catalogue JSON lists the CVE on the candidate's date
      const c = candByNorm.get(normaliseUrl(s.url));
      if (chk.verified_by === 'kev-json' && c && isIsoDate(c.published_date) && chk.kev?.date_added !== c.published_date) {
        v.error(`decisions.items[${i}].sources[${k}]`, `${s.url}: the KEV catalogue JSON lists ${chk.kev?.cve} with dateAdded ${chk.kev?.date_added}, but the candidate says ${c.published_date}`);
      }
      // a Federal Register document: the API record's publication_date is the candidate's date
      if (chk.verified_by === 'federalregister-api' && c && isIsoDate(c.published_date) && chk.fr?.publication_date !== c.published_date) {
        v.error(`decisions.items[${i}].sources[${k}]`, `${s.url}: the Federal Register API gives publication_date ${chk.fr?.publication_date} for ${chk.fr?.document_number}, but the candidate says ${c.published_date}`);
      }
    });
  });
  // BF_URL_UNVERIFIED rests on a recorded check of the candidate's URL (§5: every check is logged)
  judgments.forEach((j, i) => {
    if (!isObj(j) || j.reason_code !== 'BF_URL_UNVERIFIED') return;
    const c = candById.get(j.candidate_id);
    if (!c) return;
    const a = `decisions.judgments[${i}] (${j.candidate_id})`;
    const chk = checkOf(c.url);
    if (!chk) v.error(a, `reason_code: BF_URL_UNVERIFIED needs a check of ${c.url} in this publish; none was made`);
    else if (chk.verified === true) {
      v.warn(a, `reason_code: BF_URL_UNVERIFIED, but ${c.url} verified at ${chk.checked_at} (${chk.reason}); the code then stands only if the page was read and does not carry the claim's facts (BACKFILL.md §5)`);
    }
  });
  // a pre-window source cannot be cited (add refuses it); one hand-written into candidates.json is reported
  items.forEach((item, i) => {
    (Array.isArray(item?.sources) ? item.sources : []).forEach((s, k) => {
      const c = isObj(s) ? candByNorm.get(normaliseUrl(s.url)) : null;
      const pub = c ? publicationInstant(c) : null;
      if (pub && pub.instant.getTime() < w.start.getTime() && c.background !== true) v.error(`decisions.items[${i}].sources[${k}]`, `published ${describePub(pub)}, before the ${w.key} window: a development first made public before the window is dropped BF_OUT_OF_WINDOW`);
    });
  });

  const judgedBefore = (id) => skipped.judgments.includes(id) || ['pass', 'drop'].includes(priorRows.get(id)?.verdict);
  const notJudged = candidates.filter((c) => !judgedSet.has(c.candidate_id) && !judgedBefore(c.candidate_id)).map((c) => c.candidate_id);
  // §2: every candidate is judged (default verdict DROP). Exempt: a candidate cited only as a
  // source of an item (an outlet on the item's story), one registered outside the window (it can
  // only corroborate), and one an earlier publish of the month already logged.
  const cited = new Set();
  for (const item of items) {
    for (const s of Array.isArray(item?.sources) ? item.sources : []) {
      const c = isObj(s) ? candByNorm.get(normaliseUrl(s.url)) : null;
      if (c) cited.add(c.candidate_id);
    }
  }
  const notJudgedSet = new Set(notJudged);
  const unjudged = candidates.filter((c) => notJudgedSet.has(c.candidate_id) && !cited.has(c.candidate_id) && c.outside_window !== true && c.background !== true && !priorRows.has(c.candidate_id));
  if (unjudged.length) {
    v.error('decisions.judgments', `${unjudged.length} registered in-window candidate(s) not judged: ${unjudged.slice(0, 10).map((c) => c.candidate_id).join(', ')}${unjudged.length > 10 ? ', ...' : ''}; every candidate is judged, and the default verdict is DROP with its reason code (BACKFILL.md §2)`);
  }
  if (v.errors.length) return result({ skipped, notJudged });

  // ---- 9. assemble (append-only) and re-validate in memory
  const newItems = [...idOf].map(([di, id]) => ({ ...finaliseItem(items[di], { id, timestamp: slotOf.get(di).iso }), backfilled: true }))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
  for (const it of newItems) {
    const r = validateItem(it, { at: it.id, mode: 'archive', claimsMayNameInstitutions });
    for (const e of r.errors) v.error(null, `assembled ${e} (bug)`);
  }
  const nextArchive = { ...archive, items: [...archiveItems, ...newItems] };
  const runsDoc = isObj(runs) ? runs : { schema_version: 1, runs: [] };
  const post = new Issues()
    .merge(validateArchive(nextArchive, { lint: 'off' }))
    .merge(checkAppendOnly(archive, nextArchive, 'archive'))
    .merge(validateRuns(runsDoc, nextArchive));
  for (const e of post.errors) v.error(null, `assembled archive: ${e}`);
  if (v.errors.length) return result({ skipped, notJudged });

  // ---- 10. audit log rows: one per judged candidate, then the pass's unjudged candidates
  const itemIdByDraft = idOf;
  const sourceItemOf = new Map();
  items.forEach((item, i) => {
    for (const s of Array.isArray(item?.sources) ? item.sources : []) {
      const c = isObj(s) ? candByNorm.get(normaliseUrl(s.url)) : null;
      if (c && !sourceItemOf.has(c.candidate_id)) sourceItemOf.set(c.candidate_id, itemIdByDraft.get(i) ?? null);
    }
  });
  const check = (url) => checkSummary(checkOf(url));
  const history = (url) => {
    const h = isObj(urlHistory) ? urlHistory[normaliseUrl(url) ?? url] : null;
    return Array.isArray(h) ? h : [];
  };
  const published = (c) => {
    if (c.published_precision === 'time') {
      const pub = publicationInstant(c);
      return pub ? toEtIso(pub.instant) : null;
    }
    return c.published_date ?? null;
  };
  const base = (c) => ({
    ...passFields(w),
    candidate_id: c.candidate_id,
    url: c.url,
    publication: c.publication,
    source_class: c.source_class,
    discovery_mode: c.discovery_mode ?? null,
    published: published(c),
    headline: c.headline,
    outside_window: c.outside_window === true,
  });
  const logRows = [];
  for (const j of judgments) {
    const c = candById.get(j.candidate_id);
    const itemId = isPublishedJudgment(j) ? itemIdByDraft.get(j.draft_index) ?? null : null;
    const row = {
      ...base(c),
      judged: true,
      section_tested: j.section_tested ?? null,
      verdict: j.verdict,
      reason_code: j.reason_code,
      reason: j.reason,
      dedup: j.dedup,
      match_id: j.match_id ?? null,
      item_id: itemId,
      url_check: check(c.url),
      url_check_history: history(c.url),
    };
    if (rejudged.has(j.candidate_id)) {
      const prev = rejudged.get(j.candidate_id);
      Object.assign(row, { rejudged: true, previous_reason_code: prev.reason_code ?? null, previous_reason: prev.reason ?? null });
    }
    if (itemId && (j.dedup === 'new' || j.dedup === 'material_update')) {
      row.item_sources = items[j.draft_index].sources.map((s) => ({ url: s.url, url_check: check(s.url), url_check_history: history(s.url) }));
    }
    logRows.push(row);
  }
  for (const c of candidates) {
    if (judgedSet.has(c.candidate_id) || judgedBefore(c.candidate_id)) continue;
    const attachedTo = sourceItemOf.get(c.candidate_id) ?? null;
    if (priorRows.has(c.candidate_id) && !attachedTo) continue;
    logRows.push({
      ...base(c),
      judged: false,
      section_tested: null,
      verdict: null,
      reason_code: null,
      reason: attachedTo ? 'not judged; cited as a source' : 'not judged',
      dedup: null,
      match_id: null,
      item_id: attachedTo,
      url_check: check(c.url),
      url_check_history: history(c.url),
    });
  }
  return { errors: v.errors, warnings: v.warnings, notices, newItems, nextArchive, logRows, notJudged, skipped, nothingNew: false };
}
