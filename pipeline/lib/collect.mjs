// Collection: HTTP fetch with timeout/concurrency/403 retry, feed + CISA KEV -> candidates,
// window and seen marking. Used by scripts/fetch.mjs and scripts/add-manual.mjs.

import { parseFeed, leadWordsFor, makeLead, collapseWhitespace } from './feed.mjs';
import { candidateId, hostOf, normaliseUrl } from './url.mjs';
import { etDateString, etWallToDate, toEtIso } from './time.mjs';

export const USER_AGENT = 'ReadinessSignal/1.0 (+https://emergingtechrisk.com/Readiness-Signal/)';
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_CONCURRENCY = 8;
export const MAX_DATELESS_PER_SOURCE = 20;
export const WINDOW_OVERLAP_HOURS = 6;
export const WINDOW_FLOOR_HOURS = 72;
/**
 * Live runs: entries dated further ahead than this are event listings, not publications. A replay
 * (fetch.mjs --now, RUNBOOK §C) allows none: an entry dated after --now did not exist at the
 * replayed slot, and keeping it would leak it into two consecutive replays.
 */
export const FUTURE_TOLERANCE_HOURS = 24;
const MAX_BODY_BYTES = 15 * 1024 * 1024;

const ACCEPT = {
  feed: 'application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
  json: 'application/json, */*;q=0.5',
};

/**
 * Default collection window start: previous successful run's started_at − 6 h, but never earlier
 * than now − 72 h. Failed runs judged nothing, so they do not move the window.
 */
export function defaultSince(runsDoc, now) {
  const floor = new Date(now.getTime() - WINDOW_FLOOR_HOURS * 3600e3);
  const runs = Array.isArray(runsDoc?.runs) ? runsDoc.runs : [];
  const prev = [...runs].reverse().find((r) => r && (r.status === 'published' || r.status === 'silent') && r.started_at);
  if (!prev) return { since: floor, basis: 'floor (no previous successful run)' };
  const t = new Date(prev.started_at);
  if (Number.isNaN(t.getTime())) return { since: floor, basis: 'floor (previous run has invalid started_at)' };
  const start = new Date(t.getTime() - WINDOW_OVERLAP_HOURS * 3600e3);
  if (start < floor) return { since: floor, basis: `floor (previous run ${prev.run_id} older than 72 h)` };
  return { since: start, basis: `previous successful run ${prev.run_id} started_at − 6 h` };
}

async function httpGet(url, { userAgent, timeoutMs, accept, fetchImpl = fetch }) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': userAgent, accept, 'accept-language': 'en-GB,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { status: res.status, ok: false, text: '', tooLarge: true, finalUrl: res.url };
  }
  const text = await res.text();
  return { status: res.status, ok: res.ok, text: text.length > MAX_BODY_BYTES ? '' : text, tooLarge: text.length > MAX_BODY_BYTES, finalUrl: res.url };
}

/** GET with the project UA; on 403 retry once with a standard browser UA. */
export async function fetchWithRetry(url, { timeoutMs = DEFAULT_TIMEOUT_MS, accept = ACCEPT.feed, fetchImpl } = {}) {
  const started = Date.now();
  let retried = false;
  let res = await httpGet(url, { userAgent: USER_AGENT, timeoutMs, accept, fetchImpl });
  if (res.status === 403) {
    retried = true;
    res = await httpGet(url, { userAgent: BROWSER_USER_AGENT, timeoutMs, accept, fetchImpl });
  }
  return { ...res, retried, elapsed_ms: Date.now() - started };
}

export async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function baseCandidate(source, { url, headline, lead, published, publishedDate }) {
  const url_normalised = normaliseUrl(url);
  return {
    candidate_id: candidateId(url),
    url,
    url_normalised,
    source_id: source.id,
    publication: source.publication,
    source_class: source.source_class,
    region: source.region,
    paywalled: Boolean(source.paywalled),
    headline,
    lead,
    published: published ?? null,
    published_date: publishedDate ?? (published ? etDateString(published) : null),
    date_missing: !published,
    ...(source.tier ? { tier: source.tier } : {}),
  };
}

/** Case-insensitive substring tests from a source's optional `exclude_url_patterns`. */
export function urlExcluder(source) {
  const pats = Array.isArray(source?.exclude_url_patterns)
    ? source.exclude_url_patterns.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim().toLowerCase())
    : [];
  return pats.length ? (url) => pats.some((p) => String(url).toLowerCase().includes(p)) : null;
}

const MAX_DATE_SAMPLES = 2;

/**
 * Sources whose entry URL carries the publication date more reliably than the feed, so the date
 * is read from the URL (as a calendar date) when the URL carries one:
 * - EIOPA news pages end "-YYYY-MM-DD_en" and its feed re-issues old pages under the current date
 *   (a risk dashboard from July surfacing as today's news).
 * - Federal Register documents (the fedreg-* sources) live at /documents/YYYY/MM/DD/<number>/...,
 *   the issue date, while the feed's pubDate is midnight ET of that date (sent as 04:00 GMT), hours
 *   before the issue goes online. Compared as a timestamp, an entry fell before the window of every
 *   run after 06:05 (a 10:05 window opens at 00:05), so only the 06:05 run could collect it; as a
 *   calendar date it is in the window for every run that day.
 */
export const URL_DATE_RULES = Object.freeze([
  {
    id: 'eiopa-news',
    applies: (source) => source?.id === 'eiopa-news' || /(?:^|\.)eiopa\.europa\.eu$/i.test(hostOf(source?.url) ?? ''),
    re: /-(\d{4})-(\d{2})-(\d{2})_[a-z]{2}(?=$|[/?#])/,
  },
  {
    id: 'federal-register',
    applies: (source) => /(?:^|\.)federalregister\.gov$/i.test(hostOf(source?.url) ?? ''),
    re: /^\/documents\/(\d{4})\/(\d{2})\/(\d{2})\//,
  },
]);

/** 'YYYY-MM-DD' read from an entry URL under URL_DATE_RULES, or null. */
export function urlDateFor(source, link) {
  for (const rule of URL_DATE_RULES) {
    if (!rule.applies(source)) continue;
    let path;
    try {
      path = new URL(link).pathname;
    } catch {
      return null;
    }
    const m = rule.re.exec(path);
    if (!m) continue;
    const [y, mo, d] = m.slice(1, 4).map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (y < 1990 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) continue;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
}

/**
 * Feeds that repost documents later under a new date, where the lead states the original date:
 * BIS central bankers' speeches carry the repost date (a speech of 9 September listed on 28
 * September) and a lead ending "..., Paris, 9 September 2026." The entry keeps its feed date (the
 * window is unchanged; the speaker's own central bank feed may carry it on the day), and fetch.mjs
 * reports it in date_warnings so the agent judges G7 by the stated date (FILTER.md G7, §9.1
 * `source:`).
 */
export const LEAD_DATE_RULES = Object.freeze([
  {
    id: 'bis-cb-speeches',
    applies: (source) => source?.id === 'bis-cb-speeches' || (/(?:^|\.)bis\.org$/i.test(hostOf(source?.url) ?? '') && /cbspeeches/i.test(String(source?.url ?? ''))),
    re: /,\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\.?\s*$/,
  },
]);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM-DD' stated at the end of an entry lead under LEAD_DATE_RULES, or null. */
export function leadDateFor(source, lead) {
  for (const rule of LEAD_DATE_RULES) {
    if (!rule.applies(source)) continue;
    const m = rule.re.exec(String(lead ?? '').trim());
    if (!m) continue;
    const d = Number(m[1]);
    const mo = MONTHS.indexOf(m[2]) + 1;
    const y = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (y < 1990 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) continue;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}
/** A lead-stated date this many days or more before the feed date is reported as a repost. */
export const REPOST_MIN_DAYS = 2;

/**
 * Feed entries -> candidate records (window applied).
 *
 * Dates: a parsed date is compared with the window (date-only entries by calendar date). An entry
 * whose date parses to an implausible year (the 'Sat, 30 Dec 1899' null date) is skipped and
 * counted in `bad_date`; one whose date text cannot be parsed is kept as undated and counted in
 * `date_unparsed` so a feed format change is visible instead of silently disabling the window.
 * Undated entries (no date, or unparsed) are kept up to MAX_DATELESS_PER_SOURCE per source.
 * For sources in URL_DATE_RULES a date in the entry URL replaces the feed date (counted in
 * `url_dated`, and in `redated` when it differs from the feed's). For sources in LEAD_DATE_RULES
 * an entry whose lead states a date REPOST_MIN_DAYS or more before the feed date is kept and
 * counted in `reposted` (samples in `repost_samples`). With `replay` (fetch.mjs --now) no entry
 * dated after `now` is kept (FUTURE_TOLERANCE_HOURS applies to live runs only).
 */
export function feedCandidates(source, parsed, { since, now, replay = false }) {
  const leadWords = leadWordsFor(source);
  const excluded = urlExcluder(source);
  const out = [];
  let dateless = 0;
  let inWindow = 0;
  let future = 0;
  let badDate = 0;
  let dateUnparsed = 0;
  let excludedCount = 0;
  let urlDated = 0;
  let redated = 0;
  let reposted = 0;
  const repostSamples = [];
  const dateSamples = [];
  const sample = (e) => {
    if (e.date_text && dateSamples.length < MAX_DATE_SAMPLES && !dateSamples.includes(e.date_text)) dateSamples.push(e.date_text);
  };
  const sinceDate = etDateString(since);
  const futureLimit = new Date(now.getTime() + (replay ? 0 : FUTURE_TOLERANCE_HOURS) * 3600e3);
  const futureDate = etDateString(futureLimit);
  for (const entry of parsed.entries) {
    if (!entry.link || !normaliseUrl(entry.link)) continue;
    const headline = collapseWhitespace(entry.title);
    if (!headline) continue;
    if (excluded && excluded(entry.link)) {
      excludedCount++;
      continue;
    }
    let e = entry;
    const urlDate = urlDateFor(source, entry.link);
    if (urlDate) {
      urlDated++;
      if (entry.date_only !== urlDate && (!entry.published || etDateString(entry.published) !== urlDate)) redated++;
      const [y, m, d] = urlDate.split('-').map(Number);
      e = { ...entry, published: etWallToDate(y, m, d, 0, 0, 0).toISOString(), date_only: urlDate, date_status: 'ok' };
    }
    let keep;
    let publishedDate = null;
    if (e.published && e.date_only) {
      // Date-only publication: compare calendar dates so a same-day item is never lost to the window.
      publishedDate = e.date_only;
      if (e.date_only > futureDate) { future++; continue; }
      keep = e.date_only >= sinceDate;
    } else if (e.published) {
      const t = new Date(e.published);
      if (t > futureLimit) { future++; continue; } // event listings dated in the future
      keep = t >= since;
    } else if (e.date_status === 'implausible') {
      badDate++;
      sample(e);
      continue;
    } else {
      if (e.date_status === 'unparsed') {
        dateUnparsed++;
        sample(e);
      }
      dateless++;
      keep = dateless <= MAX_DATELESS_PER_SOURCE;
    }
    if (!keep) continue;
    inWindow++;
    const stated = publishedDate || e.published ? leadDateFor(source, e.lead) : null;
    const feedDate = publishedDate ?? (e.published ? etDateString(e.published) : null);
    if (stated && feedDate && Date.parse(feedDate) - Date.parse(stated) >= REPOST_MIN_DAYS * 86400e3) {
      reposted++;
      if (repostSamples.length < MAX_DATE_SAMPLES) repostSamples.push(`${headline.slice(0, 60)}: stated ${stated}, feed ${feedDate}`);
    }
    // feed.mjs already cut the lead to the source's limit; re-cut defensively.
    out.push(baseCandidate(source, { url: e.link, headline, lead: makeLead(e.lead, leadWords), published: e.published, publishedDate }));
  }
  return {
    candidates: out,
    entries: parsed.entries.length,
    in_window: inWindow,
    dateless,
    future_dated: future,
    bad_date: badDate,
    date_unparsed: dateUnparsed,
    excluded: excludedCount,
    url_dated: urlDated,
    redated,
    reposted,
    repost_samples: repostSamples,
    date_samples: dateSamples,
  };
}

/** Warning lines for a source report's date problems (fetch.mjs prints them and writes them to fetch-report.json). */
export function dateWarnings(report) {
  const out = [];
  const eg = report.date_samples?.length ? ` (e.g. ${report.date_samples.map((d) => JSON.stringify(d)).join(', ')})` : '';
  if (report.date_unparsed) out.push(`${report.id}: ${report.date_unparsed} entr${report.date_unparsed === 1 ? 'y has a date' : 'ies have dates'} in an unreadable format${eg}; kept as undated, so the window does not apply to them`);
  if (report.bad_date) out.push(`${report.id}: ${report.bad_date} entr${report.bad_date === 1 ? 'y has' : 'ies have'} an implausible date${eg}; skipped`);
  if (report.reposted) out.push(`${report.id}: ${report.reposted} entr${report.reposted === 1 ? 'y is a repost' : 'ies are reposts'} whose lead states an earlier date${report.repost_samples?.length ? ` (${report.repost_samples.map((x) => JSON.stringify(x)).join(', ')})` : ''}; judge G7 by the stated date and note "source: ${report.id} reposts older speeches" if it bears on judgment`);
  return out;
}

/** The CISA catalogue page for one CVE: the public primary source of a KEV listing (FILTER.md §7.8). */
export function kevCatalogueUrl(cve) {
  return `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(cve)}`;
}

/**
 * CISA KEV catalogue -> one candidate per CVE whose dateAdded falls in the window (ET dates).
 * The URL is the CISA catalogue entry (publication "CISA", class vendor_threat_research). The
 * headline is composed by the collector ("CISA KEV adds ..."), not published by CISA, so the
 * candidate carries `headline_composed: true` and an item source citing it omits `headline`
 * (FILTER.md §7.8; validateDecisions rejects it).
 */
export function kevCandidates(source, json, { since, now }) {
  const vulns = Array.isArray(json?.vulnerabilities) ? json.vulnerabilities : null;
  if (!vulns) throw new Error('KEV JSON has no "vulnerabilities" array');
  const from = etDateString(since);
  const to = etDateString(now);
  const leadWords = leadWordsFor(source);
  const out = [];
  for (const v of vulns) {
    const cve = String(v?.cveID ?? '').trim().toUpperCase();
    const added = String(v?.dateAdded ?? '').trim();
    if (!/^CVE-\d{4}-\d{4,}$/.test(cve) || !/^\d{4}-\d{2}-\d{2}$/.test(added)) continue;
    if (added < from || added > to) continue;
    const vendor = collapseWhitespace(v.vendorProject);
    const product = collapseWhitespace(v.product);
    const name = collapseWhitespace(v.vulnerabilityName);
    const [y, m, d] = added.split('-').map(Number);
    const c = baseCandidate(
      { ...source, publication: 'CISA', source_class: 'vendor_threat_research' },
      {
        url: kevCatalogueUrl(cve),
        headline: `CISA KEV adds ${cve}: ${vendor} ${product} — ${name}`,
        lead: makeLead(v.shortDescription ?? '', leadWords),
        published: etWallToDate(y, m, d, 0, 0, 0).toISOString(),
        publishedDate: added,
      },
    );
    c.headline_composed = true;
    c.kev = {
      cve,
      vendor,
      product,
      date_added: added,
      due_date: v.dueDate ?? null,
      known_ransomware_use: v.knownRansomwareCampaignUse ?? null,
    };
    out.push(c);
  }
  return { candidates: out, entries: out.length, in_window: out.length, dateless: 0, future_dated: 0, bad_date: 0, date_unparsed: 0, excluded: 0, url_dated: 0, redated: 0, reposted: 0, repost_samples: [], date_samples: [] };
}

/** Fetch one source. Never throws: failures are reported in the result. */
export async function collectSource(source, { since, now, timeoutMs, fetchImpl, replay = false }) {
  const report = {
    id: source.id,
    publication: source.publication,
    type: source.type,
    url: source.url,
    status: 'failed',
    http_status: null,
    retried_with_browser_ua: false,
    format: null,
    entries: 0,
    in_window: 0,
    unseen: 0,
    dateless: 0,
    future_dated: 0,
    bad_date: 0,
    date_unparsed: 0,
    excluded: 0,
    url_dated: 0,
    redated: 0,
    reposted: 0,
    repost_samples: [],
    date_samples: [],
    elapsed_ms: 0,
    error: null,
  };
  if (source.type === 'page') {
    report.status = 'manual';
    return { report, candidates: [] };
  }
  try {
    const res = await fetchWithRetry(source.url, {
      timeoutMs,
      accept: source.type === 'cisa-kev' ? ACCEPT.json : ACCEPT.feed,
      fetchImpl,
    });
    report.http_status = res.status;
    report.retried_with_browser_ua = res.retried;
    report.elapsed_ms = res.elapsed_ms;
    if (res.tooLarge) throw new Error('response larger than 15 MB');
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.retried ? ' (after browser-UA retry)' : ''}`);
    let result;
    if (source.type === 'cisa-kev') {
      let json;
      try { json = JSON.parse(res.text); } catch (e) { throw new Error(`invalid KEV JSON: ${e.message}`); }
      report.format = 'kev-json';
      result = kevCandidates(source, json, { since, now });
    } else {
      const parsed = parseFeed(res.text, { baseUrl: res.finalUrl || source.url, leadWords: leadWordsFor(source) });
      report.format = parsed.format;
      result = feedCandidates(source, parsed, { since, now, replay });
    }
    report.status = 'ok';
    report.entries = result.entries;
    report.in_window = result.in_window;
    report.dateless = result.dateless;
    report.future_dated = result.future_dated;
    report.bad_date = result.bad_date;
    report.date_unparsed = result.date_unparsed;
    report.excluded = result.excluded;
    report.url_dated = result.url_dated ?? 0;
    report.redated = result.redated ?? 0;
    report.reposted = result.reposted ?? 0;
    report.repost_samples = result.repost_samples ?? [];
    report.date_samples = result.date_samples;
    return { report, candidates: result.candidates };
  } catch (err) {
    const msg = err?.name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : (err?.cause?.code ? `${err.message} (${err.cause.code})` : err?.message ?? String(err));
    report.error = String(msg).slice(0, 300);
    return { report, candidates: [] };
  }
}

/** Mark seen + merge in-run duplicates (same candidate_id from several sources). */
export function finaliseCandidates(lists, seenDoc) {
  const seenUrls = seenDoc?.urls && typeof seenDoc.urls === 'object' ? seenDoc.urls : {};
  const byId = new Map();
  let duplicates = 0;
  for (const c of lists.flat()) {
    const prev = byId.get(c.candidate_id);
    if (prev) {
      duplicates++;
      if (!prev.also_in.includes(c.source_id) && prev.source_id !== c.source_id) prev.also_in.push(c.source_id);
      continue;
    }
    const s = seenUrls[c.url_normalised];
    byId.set(c.candidate_id, { ...c, seen: Boolean(s), seen_verdict: s?.verdict ?? null, also_in: [] });
  }
  return { candidates: [...byId.values()], duplicates };
}

export function nowIso(now) {
  return toEtIso(now);
}
