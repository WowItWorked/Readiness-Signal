#!/usr/bin/env node
// Historical backfill pass (pipeline/BACKFILL.md, binding). One calendar month in ET, the sections
// the owner names for it, the live selection standard judged as of the date.
//
//   node pipeline/scripts/backfill.mjs <collect|add|verify-urls|publish> --month YYYY-MM [flags]
//
// The only writer of backfilled items (publish). Never writes docs/data/runs.json or
// pipeline/state/seen.json. See USAGE for every flag.

import fs from 'node:fs';
import path from 'node:path';
import { parseCli, runMain, log, out, printIssues, UsageError } from '../lib/cli.mjs';
import { exists, readJson, readJsonl, toJsonlText, toJsonText, writeFilesAtomically, writeJsonAtomic } from '../lib/io.mjs';
import { DEFAULT_PATHS } from '../lib/paths.mjs';
import { USER_AGENT } from '../lib/collect.mjs';
import { normaliseUrl } from '../lib/url.mjs';
import { loadSources } from '../lib/sources.mjs';
import { loadThresholds } from '../lib/thresholds.mjs';
import { formatEtHuman, toEtIso } from '../lib/time.mjs';
import { Issues, validateArchive, validateRuns } from '../lib/validate.mjs';
import {
  FR_API_URL, PASSES, checkUrls, collectArchives, emptyCandidatesDoc, emptyUrlCheckDoc, expectedChecks, kevSource, markSeen,
  mergeCandidates, mergeUrlChecks, monthWindow, passSections, planPublish, prepareAddEntries, requirePass, urlsToVerify, windowDoc,
} from '../lib/backfill.mjs';

const USAGE = `node pipeline/scripts/backfill.mjs <subcommand> --month YYYY-MM [flags]

Historical backfill pass (pipeline/BACKFILL.md, binding). Run a pass only when the owner asks for
that month: every subcommand refuses a month that BACKFILL.md §1 (PASSES) does not list. Human
summary on stderr, JSON on stdout. Exit 0 ok, 1 error, 2 usage error, 3 finished with failures
(collect: a source failed; verify-urls: a URL is not verified).

Flags every subcommand accepts:
  --month YYYY-MM   the pass's calendar month in America/New_York time (required)
  --work-dir D      the pass's work directory (default pipeline/work/backfill-<month>/), holding
                    candidates.json, collect-report.json, decisions.json and url-check.json
  --archive F  --runs F  --seen F  --logs-dir D  --sources F  --filter F  --thresholds F
                    path overrides (tests); runs.json and seen.json are only ever read
  --now ISO         the clock for the window checks (tests only): refused when the subcommand would
                    write the real archive, logs or work directory, and by verify-urls. URL checks
                    are always stamped with the real time.
  --help

collect [--only kev,federal-register] [--timeout-ms 30000] [--concurrency 4]
        [--kev-url URL] [--fr-api-url URL] [--allow-http]
  Candidates from machine-readable archives for the month (BACKFILL.md §3.1, discovery_mode
  "archive"): CISA KEV entries whose dateAdded is in the month (the CISA catalogue URL; the
  headline is composed, headline_composed: true) and Federal Register final rules (type RULE)
  published in the month for every federalregister.gov agency feed in sources.json, through the
  Federal Register API (paginated; publication = the issuing agency's registry name; class
  regulator). Merges into <work>/candidates.json (deduplicated by normalised URL; a joint rule's
  other agencies go to also_in) and writes <work>/collect-report.json. Re-running is safe.
  --kev-url and --fr-api-url replace the catalogue and API addresses (tests and mirrors).

add --file F [--allow-outside]
  Registers candidates found by agents on publishers' archive pages, by search or in feeds.
  F is a JSON array (or { "candidates": [...] }) of
    { "url": "https://<the original publication's own page>",
      "publication": "<common name>",
      "source_class": "news|regulator|standards_body|industry_trade|vendor_threat_research|research_analysis",
      "headline": "<the headline exactly as published>",
      "lead": "<verbatim opening words>",              (optional)
      "published": "YYYY-MM-DD" | "2026-01-15T09:30:00-05:00",   (date only counts as 18:00 ET)
      "paywalled": true|false,
      "discovery_mode": "archive|search|feed",
      "notes": "<optional, 500 characters>" }
  Every field is validated; nothing is written if any entry is invalid. Refused: http, an
  aggregator, cache, archive, AMP page, shortener, redirect or mailing-list wrapper or social
  post (use the original publication's URL), and a date outside the month. --allow-outside
  admits dates after the month only, for later sources that confirm facts stated at the time
  (flagged outside_window: true; never the primary source, never judged pass). Leads are cut
  to 30 words when paywalled (forced for paywalled publications), else to the registry's
  lead_words (default 60). An entry whose URL normalises to a registered candidate is not
  added again (its candidate_id is printed). stdout lists every candidate_id.

verify-urls [--file F | --candidates | --url U ...] [--concurrency 4] [--timeout-ms 20000] [--allow-http]
  Checks source URLs live (BACKFILL.md §5), a preflight for publish: GET with the honest project
  user agent (ReadinessSignal/1.0) and no other, following up to 10 redirects (HTTP and meta
  refresh of 5 s or less; never https to http); a 403, 429 or 503 is retried once with the same
  user agent after any Retry-After (at most 10 s). The pipeline never impersonates a browser or
  works around a bot check: an access wall (a bot, challenge or "Request Access" interstitial,
  or a redirect to an unblock or challenge host) is simply not verified ("access wall ...").
  Verified iff the final status is 200; the final URL is on the original's site (www. and other
  subdomains are equal; tenants of shared suffixes such as gouv.fr or github.io are not; a short
  documented list of canonical publisher hosts is accepted); the content type is HTML, PDF, XML
  or JSON; the page is not an access wall and not a redirect to the home page, an error page, a
  search page or a parent listing; an HTML page is not a soft 404 (its title, first headings,
  main text or opening text says the page was not found); and a made-up sibling URL does not
  answer 200 with the same page (the canary; a site that does cannot show a page exists).
  Official machine-readable records replace the page: a Federal Register document URL
  (federalregister.gov/documents/YYYY/MM/DD/<number>/<slug>) is verified through the Federal
  Register API (/api/v1/documents/<number>.json: 200, JSON, html_url naming the same document,
  publication_date equal to the candidate's date; verified_by federalregister-api), and a CISA
  KEV catalogue URL against the KEV catalogue JSON (the catalogue page answers 200 for any
  query): the CVE must be listed, with the candidate's dateAdded. Records every check in
  <work>/url-check.json: per URL the newest check plus its full history.
  Default: every source URL of every item in <work>/decisions.json and the URL of every
  candidate dropped BF_URL_UNVERIFIED. --file F reads a decisions-shaped file or a JSON list of
  URLs; --candidates checks every registered candidate.

publish [--dry-run] [--append-missing] [--sections a,b] [--concurrency 4] [--timeout-ms 20000]
  Validates <work>/decisions.json exactly as live publish and the self-check do (schema, every
  FILTER §7 lint rule, verbatim guard against the pass's headlines and leads, institution and
  first-person rules, the FILTER §8.2 codes plus BF_SECTION_EXCLUDED, BF_OUT_OF_WINDOW and
  BF_URL_UNVERIFIED), restricts items to the pass's sections (BACKFILL.md §1; --sections can
  only narrow them), requires every registered in-window candidate to be judged (one cited only
  as an item source excepted), never a paywalled primary source, and an earlier story for a
  DD_SAME_STORY drop or a material update. Then checks every item source URL, and the URL of
  every candidate dropped BF_URL_UNVERIFIED, live, as verify-urls does (the project user agent
  only; a walled page is unverified), and publishes only
  sources verified by those checks (url-check.json is history, never trusted). Timestamp = the
  first slot (06:00, 10:00, 14:00, 18:00 ET) at or after the earliest in-window publication
  among the item's sources (date only = 18:00 ET); a development published after the month's
  last slot but inside the month takes that last slot. Ids RS-YYMMDD-HHMM-NN, NN by section,
  mechanism, primary source date. Appends backfilled: true items atomically to the archive
  (existing items unchanged; refused if the archive changed while publish ran) and writes
  <logs-dir>/backfill/<month>.jsonl (one line per judged candidate, then each registered
  candidate left unjudged, with every URL check of each). decisions.json has the live shape
  with run_id "backfill-<month>". update_of and a material_update or same_story_dropped match_id
  may name an earlier backfilled item by its id or by any candidate_id of an item in this batch
  (or of an earlier publish of the month).
  Refuses a second publish for a month (backfilled items in the window, or an audit log)
  unless --append-missing: then judgments already logged are skipped, items already published
  are recognised by their primary source, and new items take NN after the slot's existing ids.
  --dry-run checks and prints everything and writes nothing.`;

const OPTIONS = {
  month: { type: 'string' },
  only: { type: 'string' },
  'timeout-ms': { type: 'string' },
  concurrency: { type: 'string' },
  'kev-url': { type: 'string' },
  'fr-api-url': { type: 'string' },
  'allow-http': { type: 'boolean' },
  file: { type: 'string' },
  'allow-outside': { type: 'boolean' },
  candidates: { type: 'boolean' },
  url: { type: 'string', multiple: true },
  'dry-run': { type: 'boolean' },
  'append-missing': { type: 'boolean' },
  sections: { type: 'string' },
};
const SUBCOMMAND_OPTIONS = {
  collect: ['only', 'timeout-ms', 'concurrency', 'kev-url', 'fr-api-url', 'allow-http'],
  add: ['file', 'allow-outside'],
  'verify-urls': ['file', 'candidates', 'url', 'concurrency', 'timeout-ms', 'allow-http'],
  publish: ['dry-run', 'append-missing', 'sections', 'concurrency', 'timeout-ms'],
};

const IS_WINDOWS = process.platform === 'win32';
const pathKey = (p) => (IS_WINDOWS ? path.resolve(p).toLowerCase() : path.resolve(p));
/** Is `p` the directory `dir` or inside it? */
const within = (p, dir) => {
  const rel = path.relative(pathKey(dir), pathKey(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * --now is for tests: refused when the subcommand would write the real archive, the real logs or
 * the real work directory (a backdated clock must never decide what a real pass writes).
 */
function refuseNowOnRealPaths(sub, paths, workDir) {
  const real = [];
  if (within(workDir, DEFAULT_PATHS.workDir)) real.push(`the work directory ${workDir}`);
  if (sub === 'publish') {
    if (pathKey(paths.archive) === pathKey(DEFAULT_PATHS.archive)) real.push(`the archive ${paths.archive}`);
    if (within(paths.logsDir, DEFAULT_PATHS.logsDir)) real.push(`the logs ${paths.logsDir}`);
  }
  if (real.length) throw new UsageError(`--now is for tests only and is refused with ${real.join(', ')}; a real pass runs on the real clock`);
}

/** Read a JSON file once: { value, text } (text null when the file does not exist and a fallback is used). */
function readJsonWithText(file, fallback) {
  if (!exists(file)) return { value: structuredClone(fallback), text: null };
  const text = fs.readFileSync(file, 'utf8');
  try {
    return { value: JSON.parse(text.replace(/^\s+/, '')), text };
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${err.message}`);
  }
}
const textOrNull = (file) => (exists(file) ? fs.readFileSync(file, 'utf8') : null);

function intFlag(values, name, fallback, min) {
  if (values[name] === undefined) return fallback;
  const n = Number(values[name]);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name}: integer >= ${min}`);
  return n;
}

function workFiles(dir) {
  return {
    dir,
    candidates: path.join(dir, 'candidates.json'),
    collectReport: path.join(dir, 'collect-report.json'),
    decisions: path.join(dir, 'decisions.json'),
    urlCheck: path.join(dir, 'url-check.json'),
  };
}

function loadCandidatesDoc(file, w, now) {
  const doc = exists(file) ? readJson(file) : emptyCandidatesDoc(w, now);
  if (doc.month !== w.month) throw new Error(`${file}: month ${JSON.stringify(doc.month)} is not the ${w.month} pass; use the pass's own --work-dir`);
  if (!Array.isArray(doc.candidates)) throw new Error(`${file}: "candidates" must be an array`);
  return doc;
}

function requireEnded(w, now) {
  if (w.end.getTime() > now.getTime()) throw new Error(`the ${w.month} window has not ended (it closes ${w.until} ET); a backfill covers history only`);
}

function loadRegistry(file, allowHttp) {
  const { sources, errors, warnings } = loadSources(file, { allowHttp });
  for (const x of warnings) log(`warn  ${x}`);
  if (errors.length) {
    for (const e of errors) log(`ERROR ${e}`);
    throw new Error(`${file}: ${errors.length} error(s)`);
  }
  return sources;
}

// ---------------------------------------------------------------- collect

async function cmdCollect({ values, paths, now, w, wf }) {
  requireEnded(w, now);
  const allowHttp = Boolean(values['allow-http']);
  const timeoutMs = intFlag(values, 'timeout-ms', 30000, 100);
  const concurrency = intFlag(values, 'concurrency', 4, 1);
  let only = null;
  if (values.only !== undefined) {
    only = new Set(values.only.split(',').map((s) => s.trim()).filter(Boolean));
    for (const k of only) if (k !== 'kev' && k !== 'federal-register') throw new UsageError(`--only: "${k}" is not kev or federal-register`);
  }
  for (const flag of ['kev-url', 'fr-api-url']) {
    if (values[flag] === undefined) continue;
    let u = null;
    try { u = new URL(values[flag]); } catch { u = null; }
    if (!u || !(u.protocol === 'https:' || (allowHttp && u.protocol === 'http:'))) throw new UsageError(`--${flag}: must be an https URL`);
  }
  const sources = loadRegistry(paths.sources, allowHttp);
  const seen = readJson(paths.seen, { schema_version: 1, urls: {} });
  log(`collect ${w.month}: window ${w.since} to ${w.until} ET`);
  const res = await collectArchives({
    sources, window: w, only, timeoutMs, concurrency, kevUrl: values['kev-url'] ?? null, frApiUrl: values['fr-api-url'] ?? FR_API_URL,
  });
  const doc = loadCandidatesDoc(wf.candidates, w, now);
  const inRun = mergeCandidates([], res.candidates.map((c) => markSeen(c, seen)));
  const merged = mergeCandidates(doc.candidates, inRun.candidates);
  const nextDoc = { ...doc, schema_version: 1, month: w.month, window: windowDoc(w), updated_at: toEtIso(now), candidates: merged.candidates };
  const failed = [res.kev, ...res.federal_register].filter((r) => r && r.status !== 'ok');
  const report = {
    schema_version: 1,
    month: w.month,
    window: windowDoc(w),
    collected_at: toEtIso(new Date()),
    user_agent: USER_AGENT,
    kev: res.kev,
    federal_register: res.federal_register,
    totals: {
      collected: res.candidates.length,
      duplicates_in_run: inRun.already.length,
      added: merged.added.length,
      already_registered: merged.already.length,
      candidates: merged.candidates.length,
      sources_failed: failed.length,
    },
  };
  writeJsonAtomic(wf.candidates, nextDoc);
  writeJsonAtomic(wf.collectReport, report);

  if (res.kev) {
    const k = res.kev;
    log(`  ${k.status.padEnd(6)} cisa-kev: ${k.status === 'ok' ? `${k.catalogue_entries} catalogue entries, ${k.in_window} added in ${w.month}` : k.error}`);
  }
  for (const f of res.federal_register) {
    const extra = f.status === 'ok' ? `${f.in_window} rule(s) in ${w.month} (API count ${f.api_count ?? '?'}, ${f.pages} page(s))` : f.error;
    log(`  ${f.status.padEnd(6)} ${f.source_id} [${f.slug}]: ${extra}`);
  }
  log(`collected ${report.totals.collected} (${report.totals.duplicates_in_run} joint/duplicate), added ${report.totals.added}, already registered ${report.totals.already_registered}; ${report.totals.candidates} candidate(s) in ${wf.candidates}`);
  if (failed.length) log(`WARNING: ${failed.length} source(s) failed; re-run collect (it merges) once they respond`);
  out({ ...report, files: { candidates: wf.candidates, report: wf.collectReport } });
  return failed.length ? 3 : 0;
}

// ---------------------------------------------------------------- add

async function cmdAdd({ values, paths, now, w, wf }) {
  requireEnded(w, now);
  if (!values.file) throw new UsageError('add: --file F is required');
  const input = readJson(path.resolve(values.file));
  const entries = Array.isArray(input) ? input : input?.candidates;
  const sources = loadRegistry(paths.sources, false);
  const seen = readJson(paths.seen, { schema_version: 1, urls: {} });
  const { candidates, errors, notices } = prepareAddEntries(entries, { sources, window: w, allowOutside: Boolean(values['allow-outside']), seenDoc: seen });
  for (const n of notices) log(`note  ${n}`);
  if (errors.length) {
    for (const e of errors) log(`ERROR ${e}`);
    throw new Error(`${values.file}: ${errors.length} error(s); nothing was added`);
  }
  const doc = loadCandidatesDoc(wf.candidates, w, now);
  const merged = mergeCandidates(doc.candidates, candidates);
  writeJsonAtomic(wf.candidates, { ...doc, schema_version: 1, month: w.month, window: windowDoc(w), updated_at: toEtIso(now), candidates: merged.candidates });
  const addedIds = new Set(merged.added.map((c) => c.candidate_id));
  const registered = candidates.map((c) => ({ candidate_id: c.candidate_id, url: c.url, status: addedIds.has(c.candidate_id) ? 'added' : 'already a candidate', outside_window: c.outside_window }));
  // a URL listed twice in one file is added once; report each entry
  const firstSeen = new Set();
  for (const r of registered) {
    if (r.status === 'added' && firstSeen.has(r.candidate_id)) r.status = 'already a candidate';
    firstSeen.add(r.candidate_id);
  }
  for (const r of registered) log(`  ${r.candidate_id}  ${r.status.padEnd(19)}${r.outside_window ? ' (outside window)' : ''} ${r.url}`);
  log(`added ${merged.added.length}, already registered ${registered.length - merged.added.length}; ${merged.candidates.length} candidate(s) in ${wf.candidates}`);
  out({
    month: w.month,
    added: merged.added.map((c) => ({ candidate_id: c.candidate_id, url: c.url, publication: c.publication, source_class: c.source_class, paywalled: c.paywalled, published: c.published_date, outside_window: c.outside_window, discovery_mode: c.discovery_mode })),
    registered,
    file: wf.candidates,
  });
  return 0;
}

// ---------------------------------------------------------------- verify-urls

/** url-check.json for the pass (validated month), or an empty one. */
function loadUrlCheckDoc(file, w) {
  const doc = exists(file) ? readJson(file) : emptyUrlCheckDoc(w);
  if (doc.month !== undefined && doc.month !== null && doc.month !== w.month) throw new Error(`${file}: month ${JSON.stringify(doc.month)} is not the ${w.month} pass`);
  return { ...doc, month: w.month };
}

/** Merge checks into url-check.json's history (real clock), logging records it refuses. */
function mergeChecks(prev, records) {
  return mergeUrlChecks(prev, records, new Date(), {
    onIgnored: (key, _rec, why) => log(`warn  url-check.json: ignored a check of ${key}: ${why}`),
  });
}

const checkLine = (r) => `  ${r.verified ? 'ok  ' : 'FAIL'}  ${String(r.status ?? '-').padEnd(3)}  ${r.verified ? '' : `${r.reason}  `}${r.url}${r.final_url && r.final_url !== r.url ? ` -> ${r.final_url}` : ''}`;

async function cmdVerify({ values, paths, w, wf }) {
  const picked = ['file', 'candidates', 'url'].filter((k) => values[k] !== undefined && values[k] !== false);
  if (picked.length > 1) throw new UsageError(`verify-urls: use one of --file, --candidates or --url (got ${picked.map((k) => `--${k}`).join(', ')})`);
  const concurrency = intFlag(values, 'concurrency', 4, 1);
  const timeoutMs = intFlag(values, 'timeout-ms', 20000, 100);
  const allowHttp = Boolean(values['allow-http']);
  const candidates = exists(wf.candidates) ? loadCandidatesDoc(wf.candidates, w, new Date()).candidates : [];
  let urls;
  let from;
  if (values.url) {
    urls = values.url;
    from = '--url';
  } else if (values.candidates) {
    if (!exists(wf.candidates)) throw new Error(`${wf.candidates} not found (run collect and add first)`);
    urls = candidates.map((c) => c.url);
    from = wf.candidates;
  } else {
    const file = values.file ? path.resolve(values.file) : wf.decisions;
    if (!exists(file)) throw new Error(`${file} not found: write decisions.json first, or pass --file, --candidates or --url`);
    urls = urlsToVerify(readJson(file), candidates);
    from = file;
  }
  if (!urls.length) throw new Error(`no URLs to check in ${from}`);
  const sources = exists(paths.sources) ? loadRegistry(paths.sources, allowHttp) : [];
  log(`verify-urls ${w.month}: checking ${urls.length} URL(s) from ${from} (concurrency ${concurrency}, timeout ${timeoutMs} ms)`);
  const records = await checkUrls(urls, { concurrency, timeoutMs, allowHttp, kevUrl: kevSource(sources).url, expected: expectedChecks(candidates) });
  const doc = mergeChecks(loadUrlCheckDoc(wf.urlCheck, w), records);
  writeJsonAtomic(wf.urlCheck, doc);
  for (const r of records) log(checkLine(r));
  const failed = records.filter((r) => !r.verified);
  log(`${records.length - failed.length} of ${records.length} verified; wrote ${wf.urlCheck}`);
  out({ month: w.month, checked: records.length, verified: records.length - failed.length, failed: failed.map((r) => ({ url: r.url, status: r.status, final_url: r.final_url, reason: r.reason })), checks: records, file: wf.urlCheck });
  return failed.length ? 3 : 0;
}

// ---------------------------------------------------------------- publish

async function cmdPublish({ values, paths, now, w, wf }) {
  let sections;
  try {
    sections = passSections(w.month, values.sections);
  } catch (err) {
    throw new UsageError(err.message);
  }
  requireEnded(w, now);
  const dryRun = Boolean(values['dry-run']);
  const appendMissing = Boolean(values['append-missing']);
  const concurrency = intFlag(values, 'concurrency', 4, 1);
  const timeoutMs = intFlag(values, 'timeout-ms', 20000, 100);
  if (!exists(wf.decisions)) throw new Error(`${wf.decisions} not found`);
  if (!exists(wf.candidates)) throw new Error(`${wf.candidates} not found (run collect and add first)`);
  const decisions = readJson(wf.decisions);
  const candidatesDoc = loadCandidatesDoc(wf.candidates, w, now);
  const urlCheckDoc = loadUrlCheckDoc(wf.urlCheck, w);
  const thresholds = loadThresholds(paths.thresholds);
  const filterText = exists(paths.filter) ? fs.readFileSync(paths.filter, 'utf8') : null;
  const sources = loadRegistry(paths.sources, false);
  // read once; the archive and the audit log must be unchanged when publish writes them
  const { value: archive, text: archiveText } = readJsonWithText(paths.archive, { schema_version: 1, items: [] });
  const runs = readJson(paths.runs, { schema_version: 1, runs: [] });
  const pre = new Issues().merge(validateArchive(archive, { lint: 'off' })).merge(validateRuns(runs, archive));
  if (!pre.ok) {
    printIssues('existing data', pre.result());
    throw new Error('existing archive/runs are invalid; fix them before a backfill publish (run validate.mjs)');
  }
  const logPath = path.join(paths.logsDir, 'backfill', `${w.month}.jsonl`);
  const logText = textOrNull(logPath);
  const auditRows = logText === null ? null : readJsonl(logPath);

  // BACKFILL.md §5: every source URL is checked live before its item is written. publish makes
  // the checks itself, on the real clock, and trusts no recorded verdict.
  const urls = urlsToVerify(decisions, candidatesDoc.candidates);
  let records = [];
  if (urls.length) {
    log(`checking ${urls.length} URL(s) live (concurrency ${concurrency}, timeout ${timeoutMs} ms)`);
    records = await checkUrls(urls, { concurrency, timeoutMs, kevUrl: kevSource(sources).url, expected: expectedChecks(candidatesDoc.candidates) });
    for (const r of records) if (!r.verified) log(checkLine(r));
  }
  const liveChecks = Object.fromEntries(records.map((r) => [normaliseUrl(r.url) ?? r.url, r]));
  const checkDoc = mergeChecks(urlCheckDoc, records);
  const urlHistory = Object.fromEntries(Object.entries(checkDoc.checks).map(([k, v]) => [k, v.history ?? []]));

  const plan = planPublish({
    decisions, candidates: candidatesDoc.candidates, archive, runs, urlChecks: liveChecks, urlHistory, auditRows,
    thresholds, filterText, window: w, sections, now: new Date(), appendMissing,
  });
  // the checks are a record of the pass whatever the outcome (not on a dry run)
  if (!dryRun && records.length) writeJsonAtomic(wf.urlCheck, checkDoc);
  for (const n of plan.notices) log(`note  ${n}`);
  if (plan.errors.length) {
    printIssues('backfill decisions.json', { errors: plan.errors, warnings: plan.warnings });
    throw new Error(`${plan.errors.length} error(s); nothing was written to the archive or the audit log${!dryRun && records.length ? ` (the URL checks were recorded in ${wf.urlCheck})` : ''}`);
  }
  for (const x of plan.warnings) log(`  warn  ${x}`);
  const pass = PASSES[w.month];
  const judged = plan.logRows.filter((r) => r.judged);
  const byCode = {};
  for (const r of judged) byCode[r.reason_code] = (byCode[r.reason_code] ?? 0) + 1;
  const summary = {
    month: w.month,
    sections,
    dry_run: dryRun,
    append_missing: appendMissing,
    items: plan.newItems.map((i) => i.id),
    judged: judged.length,
    passed: judged.filter((r) => r.verdict === 'pass').length,
    dropped: judged.filter((r) => r.verdict === 'drop').length,
    reason_codes: byCode,
    not_judged: plan.notJudged,
    urls_checked: records.length,
    skipped: plan.skipped,
    warnings: plan.warnings,
    notes: typeof decisions?.notes === 'string' ? decisions.notes : null,
  };

  log(`${dryRun ? 'DRY RUN ' : ''}BACKFILL ${w.month} (${sections.join(', ')}): ${plan.newItems.length} item(s); ${summary.judged} judged (${summary.passed} pass, ${summary.dropped} drop); ${records.length} URL(s) verified live; ${plan.notJudged.length} registered candidate(s) not judged`);
  for (const it of plan.newItems) log(`  ${it.id}  ${formatEtHuman(it.timestamp)}  ${it.section} / ${it.mechanism}  ${it.claim}`);
  if (plan.notJudged.length) log(`  not judged (cited as sources, outside the window or logged earlier): ${plan.notJudged.slice(0, 12).join(', ')}${plan.notJudged.length > 12 ? `, ... (${plan.notJudged.length} in all)` : ''}`);
  if (plan.nothingNew) {
    out({ ...summary, written: [] });
    return 0;
  }
  const writes = [];
  if (plan.logRows.length) {
    const prevText = logText ?? '';
    writes.push([logPath, `${prevText}${prevText && !prevText.endsWith('\n') ? '\n' : ''}${toJsonlText(plan.logRows)}`]);
  }
  if (plan.newItems.length) writes.push([paths.archive, toJsonText(plan.nextArchive)]); // last: the archive is the record
  if (dryRun) {
    log('dry run: nothing written');
    out({ ...summary, new_items: plan.newItems, log_rows: plan.logRows, would_write: writes.map(([f]) => f) });
    return 0;
  }
  // the live checks take time: refuse if a live run (or anything else) changed the files meanwhile
  if (textOrNull(paths.archive) !== archiveText) throw new Error(`${paths.archive} changed while this publish ran; nothing was written to the archive or the audit log; re-run publish`);
  if (textOrNull(logPath) !== logText) throw new Error(`${logPath} changed while this publish ran; nothing was written to the archive or the audit log; re-run publish`);
  const written = writeFilesAtomically(writes);
  for (const f of written) log(`  wrote ${f}`);
  if (pass?.instruction) log(`  owner instruction: ${pass.instruction}`);
  out({ ...summary, written });
  return 0;
}

// ---------------------------------------------------------------- main

const COMMANDS = { collect: cmdCollect, add: cmdAdd, 'verify-urls': cmdVerify, publish: cmdPublish };

runMain(async () => {
  const argv = process.argv.slice(2);
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
  if (!sub) {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stderr.write(`${USAGE}\n`);
      return 0;
    }
    throw new UsageError(`a subcommand is required: ${Object.keys(COMMANDS).join(', ')}\n\n${USAGE}`);
  }
  const cmd = COMMANDS[sub];
  if (!cmd) throw new UsageError(`unknown subcommand "${sub}" (one of ${Object.keys(COMMANDS).join(', ')})`);
  const { values, paths, now } = parseCli(argv.slice(1), OPTIONS, USAGE);
  const allowed = new Set(SUBCOMMAND_OPTIONS[sub]);
  for (const k of Object.keys(OPTIONS)) {
    if (k !== 'month' && values[k] !== undefined && !allowed.has(k)) throw new UsageError(`--${k} does not apply to ${sub}`);
  }
  if (!values.month) throw new UsageError(`--month YYYY-MM is required\n\n${USAGE}`);
  let w;
  try {
    w = monthWindow(values.month);
    requirePass(w.month); // BACKFILL.md §1: only a month the owner has instructed
  } catch (err) {
    throw new UsageError(err.message);
  }
  const dir = values['work-dir'] ? path.resolve(values['work-dir']) : path.join(DEFAULT_PATHS.workDir, `backfill-${w.month}`);
  if (values.now !== undefined) {
    if (sub === 'verify-urls') throw new UsageError('--now does not apply to verify-urls: URL checks are always stamped with the real time');
    refuseNowOnRealPaths(sub, paths, dir);
  }
  return cmd({ values, paths, now, w, wf: workFiles(dir) });
});
