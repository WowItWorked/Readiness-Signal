#!/usr/bin/env node
// Register candidates that fetch.mjs did not collect, in this run's candidates.json.
//
//   node pipeline/scripts/add-manual.mjs --run <run_id> --file <manual.json> [--extra]
//        [--sources F] [--seen F] [--work-dir D] [--allow-http]
//
// Page mode (default, RUNBOOK step 5): entries the agent read by hand from `page` sources. They go
// through stage 1 like fetched candidates. Each URL must be on the registered source's own site.
//
// Extra mode (--extra, RUNBOOK step 9): public sources the agent found by search while judging a
// survivor (FILTER.md NP5, §2.7.1, §2.7.5): the primary source (advisory, transcript, CVE record,
// post-incident report) or independent coverage counted for E3. They are recorded with
// `extra: true`, are never scored at stage 1 or judged, and exist so an item may list them as
// sources: publish.mjs only accepts source URLs that are candidates in the item's candidate_ids.
//
// Headline and a lead cut to the source's lead_words (paywalled max 40) are the only text kept.

import { parseCli, runMain, log, out, UsageError } from '../lib/cli.mjs';
import { SOURCE_CLASSES } from '../lib/enums.mjs';
import { exists, readJson, writeJsonAtomic } from '../lib/io.mjs';
import { runWorkPaths } from '../lib/paths.mjs';
import { isKnownPaywalled, loadSources, paywalledOnSite, sourceForUrl, sourceMap } from '../lib/sources.mjs';
import { collapseWhitespace, leadWordsFor, makeLead, parseFeedDate } from '../lib/feed.mjs';
import { candidateId, disallowedSourceReason, hostOf, normaliseUrl, registrableDomain } from '../lib/url.mjs';
import { etDateString, etWallToDate, isIsoDate, parseRunId } from '../lib/time.mjs';

const USAGE = `node pipeline/scripts/add-manual.mjs --run <run_id> --file <manual.json> [--extra]
  [--sources F] [--seen F] [--work-dir D] [--allow-http]

Registers candidates that fetch.mjs did not collect in pipeline/work/<run_id>/candidates.json.
Write <manual.json> anywhere under pipeline/work/<run_id>/ (for example
pipeline/work/<run_id>/manual.json or pipeline/work/<run_id>/extra.json).

PAGE MODE (default; RUNBOOK step 5): entries read by hand from \`page\` sources
(fetch-report.json -> manual[]). They go through stage 1 like fetched candidates. Run it after
fetch.mjs and before prefilter.mjs (if stage1.json already exists, re-run prefilter.mjs and
dedup-hints.mjs afterwards).
  { "candidates": [
      { "source_id": "<id of the page source in pipeline/sources.json>",
        "url": "https://<the entry's own page, on the same site as the source>",
        "headline": "<the entry's title exactly as the page shows it>",
        "published": "YYYY-MM-DD",            (optional; omit if the page shows no date)
        "lead": "<summary line shown on the page>" }   (optional; cut to the source's lead_words)
  ] }
  Rules: source_id must be registered; the URL must be https and on the source's own site (same
  registrable domain); entries dated before the run window are skipped.

EXTRA MODE (--extra; RUNBOOK step 9): public sources found by search while judging a survivor
(FILTER.md NP5, 2.7.1, 2.7.5): the primary source, or independent coverage relied on for E3.
They are never scored or judged (no prefilter re-run needed). To list one on an item, add its
candidate_id (printed on stdout) to the item's candidate_ids and its URL to the item's sources.
  { "candidates": [
      { "url": "https://<the document's own canonical page>",
        "headline": "<its title exactly as shown>",
        "publication": "<issuer or outlet name>",      (optional when the site is in sources.json)
        "source_class": "<news|regulator|standards_body|industry_trade|vendor_threat_research|research_analysis>",
                                                       (optional when the site is in sources.json; set it
                                                        whenever the document's own class differs, FILTER 2.9)
        "published": "YYYY-MM-DD",                     (optional; omit if no date is shown)
        "paywalled": true,                             (optional; forced true for paywalled sites)
        "lead": "<summary line shown on the page>" }   (optional; paywalled: headline only is safest)
  ] }
  Rules: https; never an aggregator, cache, archive, AMP page, link shortener, redirect wrapper or
  social platform (use the original publication's URL); a source registered in sources.json on the
  same host (or the same site: www/feeds/rss prefixes aside) lends its publication, class and
  source id, never a source on another subdomain (nvd.nist.gov is not csrc.nist.gov); any
  subdomain of a paywalled registered publication, or of a known paywalled publication, is
  paywalled (lead max 40 words); no window check (an older primary document may establish a
  background fact, but the development itself must pass G7).
  Already a candidate: a URL that normalises to a collected candidate (the same page without
  tracking parameters, a trailing slash or a "//" in the path) is not added again. That is
  success: cite the candidate_id it prints (stdout "registered" lists every entry's id), and the
  URL in its clean form.

Both modes: entries already in candidates.json are skipped (re-running is safe; an extra that is
already a fetched candidate is reported with its candidate_id); nothing is written if any entry is
invalid. stdout: { run_id, mode, added: [{ candidate_id, url, source_id, publication,
source_class, paywalled, headline, seen }], skipped: [...], registered: [{ candidate_id, url,
status: "added" | "already a candidate" }] }.`;

runMain(async () => {
  const { values, paths } = parseCli(process.argv.slice(2), {
    run: { type: 'string' },
    file: { type: 'string' },
    extra: { type: 'boolean' },
    'allow-http': { type: 'boolean' },
  }, USAGE);
  if (!values.run || !parseRunId(values.run)) throw new UsageError(`--run <run_id> is required\n\n${USAGE}`);
  if (!values.file) throw new UsageError(`--file <manual.json> is required\n\n${USAGE}`);
  const runId = values.run;
  const extraMode = Boolean(values.extra);
  const wp = runWorkPaths(paths.workDir, runId);
  const candDoc = readJson(wp.candidates);
  if (candDoc.run_id !== runId) throw new Error(`${wp.candidates}: run_id ${candDoc.run_id} does not match --run ${runId}`);
  const report = exists(wp.fetchReport) ? readJson(wp.fetchReport) : null;
  const { sources, errors: srcErrors } = loadSources(paths.sources, { allowHttp: Boolean(values['allow-http']) });
  if (srcErrors.length) throw new Error(`${paths.sources}: ${srcErrors.length} error(s); run fetch.mjs to see them`);
  const byId = sourceMap(sources);
  const seen = readJson(paths.seen, { schema_version: 1, urls: {} });

  const manual = readJson(values.file);
  const entries = Array.isArray(manual) ? manual : manual?.candidates;
  if (!Array.isArray(entries)) throw new Error(`${values.file}: expected { "candidates": [...] }`);

  const sinceDate = candDoc.window?.since ? etDateString(candDoc.window.since) : null;
  const existing = new Map((candDoc.candidates ?? []).map((c) => [c.candidate_id, c]));
  const errors = [];
  const added = [];
  const skipped = [];
  const citable = [];

  const parseUrl = (e, at) => {
    let url;
    try { url = new URL(e?.url); } catch { errors.push(`${at}.url: not a URL`); return null; }
    if (url.protocol !== 'https:' && !(values['allow-http'] && url.protocol === 'http:')) { errors.push(`${at}.url: must be https`); return null; }
    return url;
  };
  const parsePublished = (e, at) => {
    if (e.published === undefined || e.published === null || e.published === '') return { published: null, publishedDate: null };
    if (isIsoDate(e.published)) {
      const [y, m, d] = e.published.split('-').map(Number);
      return { published: etWallToDate(y, m, d).toISOString(), publishedDate: e.published };
    }
    const published = parseFeedDate(e.published);
    if (!published) { errors.push(`${at}.published: not a date`); return null; }
    return { published, publishedDate: etDateString(published) };
  };
  const headlineOf = (e, at) => {
    const headline = collapseWhitespace(e?.headline);
    if (!headline) { errors.push(`${at}.headline: required`); return null; }
    if (headline.length > 300) { errors.push(`${at}.headline: too long for a headline (${headline.length} chars)`); return null; }
    return headline;
  };
  const record = (e, fields) => {
    const norm = normaliseUrl(e.url);
    const s = seen.urls?.[norm];
    return {
      candidate_id: candidateId(e.url),
      url: e.url,
      url_normalised: norm,
      ...fields,
      date_missing: !fields.published,
      seen: Boolean(s),
      seen_verdict: s?.verdict ?? null,
      also_in: [],
    };
  };

  entries.forEach((e, i) => {
    const at = `candidates[${i}]`;
    if (!e || typeof e !== 'object') return errors.push(`${at}: must be an object`);

    if (!extraMode) {
      // ---- page mode
      const source = byId.get(e.source_id);
      if (!source) return errors.push(`${at}.source_id: ${JSON.stringify(e.source_id)} is not in ${paths.sources}`);
      if (source.type !== 'page') log(`warn  ${at}: source ${source.id} is type ${source.type}, not page`);
      if (!parseUrl(e, at)) return undefined;
      if (registrableDomain(hostOf(e.url)) !== registrableDomain(hostOf(source.url))) {
        return errors.push(`${at}.url: ${hostOf(e.url)} is not on ${source.publication}'s site (${hostOf(source.url)})`);
      }
      const headline = headlineOf(e, at);
      if (!headline) return undefined;
      const dates = parsePublished(e, at);
      if (!dates) return undefined;
      if (dates.publishedDate && sinceDate && dates.publishedDate < sinceDate) {
        skipped.push(`${at}: published ${dates.publishedDate} is before the run window (${sinceDate})`);
        return undefined;
      }
      const cid = candidateId(e.url);
      if (existing.has(cid)) {
        skipped.push(`${at}: already a candidate (${cid})`);
        return undefined;
      }
      const c = record(e, {
        source_id: source.id,
        publication: source.publication,
        source_class: source.source_class,
        region: source.region,
        paywalled: Boolean(source.paywalled),
        headline,
        lead: makeLead(e.lead ?? '', leadWordsFor(source)),
        published: dates.published,
        published_date: dates.publishedDate,
        ...(source.tier ? { tier: source.tier } : {}),
      });
      c.manual = true;
      existing.set(cid, c);
      added.push(c);
      return undefined;
    }

    // ---- extra mode
    if (!parseUrl(e, at)) return undefined;
    const banned = disallowedSourceReason(e.url);
    if (banned) return errors.push(`${at}.url: ${banned}`);
    let registered = null;
    if (e.source_id !== undefined) {
      registered = byId.get(e.source_id);
      if (!registered) return errors.push(`${at}.source_id: ${JSON.stringify(e.source_id)} is not in ${paths.sources}`);
      if (registrableDomain(hostOf(e.url)) !== registrableDomain(hostOf(registered.url))) {
        return errors.push(`${at}.url: ${hostOf(e.url)} is not on ${registered.publication}'s site (${hostOf(registered.url)})`);
      }
    } else {
      registered = sourceForUrl(sources, e.url);
    }
    const publication = collapseWhitespace(e.publication) || registered?.publication || '';
    if (!publication) return errors.push(`${at}.publication: required (no source in ${paths.sources} on ${hostOf(e.url)})`);
    const sourceClass = e.source_class ?? registered?.source_class;
    if (!SOURCE_CLASSES.includes(sourceClass)) {
      return errors.push(`${at}.source_class: ${sourceClass === undefined ? `required (no source in sources.json on ${hostOf(e.url)})` : `${JSON.stringify(sourceClass)} is not`} one of ${SOURCE_CLASSES.join(', ')}`);
    }
    if (e.paywalled !== undefined && typeof e.paywalled !== 'boolean') return errors.push(`${at}.paywalled: must be true or false`);
    const forcedPaywall = Boolean(registered?.paywalled) || Boolean(paywalledOnSite(sources, e.url)) || isKnownPaywalled(e.url);
    if (e.paywalled === false && forcedPaywall) log(`warn  ${at}: ${hostOf(e.url)} is a paywalled publication; recorded as paywalled (headline and lead only)`);
    const paywalled = forcedPaywall || e.paywalled === true;
    const headline = headlineOf(e, at);
    if (!headline) return undefined;
    const dates = parsePublished(e, at);
    if (!dates) return undefined;
    const cid = candidateId(e.url);
    const prior = existing.get(cid);
    if (prior) {
      skipped.push(`${at}: already a candidate (${cid}${prior.extra ? ', extra' : `, fetched from ${prior.source_id}`}); use that candidate_id`);
      citable.push({ candidate_id: cid, url: e.url, status: 'already a candidate' });
      return undefined;
    }
    const leadSource = { paywalled, lead_words: registered?.lead_words };
    const c = record(e, {
      source_id: registered?.id ?? null,
      publication,
      source_class: sourceClass,
      region: registered?.region ?? null,
      paywalled,
      headline,
      lead: makeLead(e.lead ?? '', leadWordsFor(leadSource)),
      published: dates.published,
      published_date: dates.publishedDate,
      ...(registered?.tier && sourceClass === 'news' ? { tier: registered.tier } : {}),
    });
    c.extra = true;
    existing.set(cid, c);
    added.push(c);
    citable.push({ candidate_id: cid, url: e.url, status: 'added' });
    return undefined;
  });
  for (const s of skipped) log(`skip  ${s}`);
  if (errors.length) {
    for (const e of errors) log(`ERROR ${e}`);
    throw new Error(`${values.file}: ${errors.length} error(s); nothing was added`);
  }

  candDoc.candidates = [...(candDoc.candidates ?? []), ...added];
  writeJsonAtomic(wp.candidates, candDoc);
  if (report && !extraMode) {
    // Page entries are part of the collected pool (funnel counts); extras are not.
    const unseen = added.filter((c) => !c.seen).length;
    report.totals.in_window = (report.totals.in_window ?? 0) + added.length;
    report.totals.unseen = (report.totals.unseen ?? 0) + unseen;
    report.totals.manual_added = (report.totals.manual_added ?? 0) + added.length;
    for (const r of report.sources ?? []) {
      const mine = added.filter((c) => c.source_id === r.id);
      if (!mine.length) continue;
      r.entries += mine.length;
      r.in_window += mine.length;
      r.unseen += mine.filter((c) => !c.seen).length;
    }
    writeJsonAtomic(wp.fetchReport, report);
  }
  if (!extraMode && added.length && exists(wp.stage1)) log('warn  stage1.json already exists for this run: re-run prefilter.mjs so the manual candidates are scored');
  for (const c of added.filter((x) => x.seen)) log(`warn  ${c.candidate_id} ${c.url} is already in seen.json (${c.seen_verdict}); if it is a source of a published item, list it only on a material update of that item`);
  if (extraMode) {
    const already = citable.filter((r) => r.status !== 'added').length;
    log(`added ${added.length} extra source(s); ${already} already a candidate (registered: cite the candidate_id shown)`);
    for (const r of citable) log(`  ${r.candidate_id}  ${r.status.padEnd(19)} ${r.url}`);
  } else {
    log(`added ${added.length} manual candidate(s), skipped ${skipped.length}`);
  }
  out({
    run_id: runId,
    mode: extraMode ? 'extra' : 'page',
    added: added.map((c) => ({
      candidate_id: c.candidate_id, url: c.url, source_id: c.source_id, publication: c.publication,
      source_class: c.source_class, paywalled: c.paywalled, headline: c.headline, seen: c.seen,
    })),
    skipped,
    ...(extraMode ? { registered: citable } : {}),
  });
  return 0;
});
