#!/usr/bin/env node
// Step 1 (SPEC §5): fetch every registered source, keep in-window entries as candidates.
//
//   node pipeline/scripts/fetch.mjs --run <run_id> [--since ISO] [--now ISO]
//        [--timeout-ms 15000] [--concurrency 8] [--only id,id] [--allow-http]
//        [--sources F] [--runs F] [--seen F] [--work-dir D]
//
// Writes <work-dir>/<run_id>/candidates.json and fetch-report.json. Marks each candidate with
// `seen` from seen.json (it does not write seen.json; publish.mjs does). `page` sources are
// listed as manual. Date problems are counted per source and listed in fetch-report.json
// `date_warnings` (and printed as "warn" lines): entries with an implausible date (e.g. 1899) are
// skipped; entries whose date text cannot be parsed are kept as undated, so the window does not
// apply to them until the parser learns the format. Feeds that re-date old documents (EIOPA; see
// collect.mjs URL_DATE_RULES) are dated from the entry URL instead ("re-dated from the URL"); feeds
// that repost older documents under a new date (BIS speeches; LEAD_DATE_RULES) keep their feed date
// and are listed in date_warnings with the date the lead states.
// Replay (--now given; RUNBOOK §C): no entry dated after --now is kept (live runs allow
// FUTURE_TOLERANCE_HOURS), and the window carries "replay": true, so selfcheck.mjs and publish.mjs
// warn when an item cites a page published after the replayed slot.
// CISA KEV entries point at the CISA catalogue entry for the CVE and carry headline_composed:
// true (an item source citing one omits headline). Exit 0 when healthy, 3 when fewer than half the
// fetchable sources responded (fetch-report.json is still written: record a failed run), 1 on
// error, 2 on usage error.

import { parseCli, runMain, log, out, UsageError } from '../lib/cli.mjs';
import { readJson, writeJsonAtomic } from '../lib/io.mjs';
import { runWorkPaths } from '../lib/paths.mjs';
import { loadSources } from '../lib/sources.mjs';
import { parseRunId, slotFor, toEtIso } from '../lib/time.mjs';
import {
  collectSource, dateWarnings, defaultSince, finaliseCandidates, mapPool,
  DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_MS, USER_AGENT,
} from '../lib/collect.mjs';

const USAGE = `node pipeline/scripts/fetch.mjs --run <run_id> [--since ISO] [--now ISO]
  [--timeout-ms N] [--concurrency N] [--only id,id] [--allow-http]
  [--sources F] [--runs F] [--seen F] [--work-dir D]

  --since ISO  window start (default: previous successful run's start minus 6 h, at most 72 h back)
  --now ISO    replay a past slot (owner calibration only, RUNBOOK section C): the window ends at
               --now, nothing dated after it is kept, and candidates.json window.replay is true.
               Never passed in a live run.`;

runMain(async () => {
  const { values, paths, now } = parseCli(process.argv.slice(2), {
    run: { type: 'string' },
    since: { type: 'string' },
    'timeout-ms': { type: 'string' },
    concurrency: { type: 'string' },
    only: { type: 'string' },
    'allow-http': { type: 'boolean' },
  }, USAGE);

  const runId = values.run ?? slotFor(now).run_id;
  if (!parseRunId(runId)) throw new UsageError(`--run: "${runId}" is not a slot run id (YYYY-MM-DD-HHMM at 0600/1000/1400/1800)`);
  const timeoutMs = values['timeout-ms'] ? Number(values['timeout-ms']) : DEFAULT_TIMEOUT_MS;
  const concurrency = values.concurrency ? Number(values.concurrency) : DEFAULT_CONCURRENCY;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100) throw new UsageError('--timeout-ms: integer >= 100');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new UsageError('--concurrency: integer >= 1');

  const { sources, errors, warnings } = loadSources(paths.sources, { allowHttp: Boolean(values['allow-http']) });
  for (const w of warnings) log(`warn  ${w}`);
  if (errors.length) {
    for (const e of errors) log(`ERROR ${e}`);
    throw new Error(`${paths.sources}: ${errors.length} error(s)`);
  }
  const runsDoc = readJson(paths.runs, { schema_version: 1, runs: [] });
  const seenDoc = readJson(paths.seen, { schema_version: 1, urls: {} });
  if (runsDoc.runs?.some((r) => r.run_id === runId)) log(`warn  a run record for ${runId} already exists; publish.mjs will refuse this run`);

  let since;
  let basis;
  if (values.since) {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime())) throw new UsageError(`--since: not a valid date: ${values.since}`);
    basis = '--since';
  } else {
    ({ since, basis } = defaultSince(runsDoc, now));
  }

  const only = values.only ? new Set(values.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const active = sources.filter((s) => s.enabled !== false && (!only || only.has(s.id)));
  const startedAt = toEtIso(now);
  const replay = values.now !== undefined;
  log(`fetch ${runId}: ${active.length} source(s), window ${toEtIso(since)} → ${startedAt} (${basis})${replay ? '; replay: nothing dated after --now is kept' : ''}`);

  const results = await mapPool(active, concurrency, (s) => collectSource(s, { since, now, timeoutMs, replay }));
  const { candidates, duplicates } = finaliseCandidates(results.map((r) => r.candidates), seenDoc);

  // per-source unseen counts (after seen marking)
  const unseenBySource = new Map();
  for (const c of candidates) if (!c.seen) unseenBySource.set(c.source_id, (unseenBySource.get(c.source_id) ?? 0) + 1);
  const reports = results.map((r) => ({ ...r.report, unseen: unseenBySource.get(r.report.id) ?? 0 }));

  const ok = reports.filter((r) => r.status === 'ok');
  const failed = reports.filter((r) => r.status === 'failed');
  const manual = reports.filter((r) => r.status === 'manual');
  const fetchable = ok.length + failed.length;
  const healthy = fetchable > 0 && ok.length * 2 >= fetchable;
  const totals = {
    sources_ok: ok.length,
    sources_failed: failed.length,
    sources_manual: manual.length,
    fetched: ok.reduce((n, r) => n + r.entries, 0),
    in_window: candidates.length,
    unseen: candidates.filter((c) => !c.seen).length,
    duplicates_in_run: duplicates,
    undated: candidates.filter((c) => c.date_missing).length,
    bad_date: ok.reduce((n, r) => n + (r.bad_date ?? 0), 0),
    date_unparsed: ok.reduce((n, r) => n + (r.date_unparsed ?? 0), 0),
    excluded_by_url: ok.reduce((n, r) => n + (r.excluded ?? 0), 0),
    reposted: ok.reduce((n, r) => n + (r.reposted ?? 0), 0),
  };
  const dateIssues = ok.flatMap((r) => dateWarnings(r));
  const finishedAt = values.now ? startedAt : toEtIso(new Date());
  const wp = runWorkPaths(paths.workDir, runId);
  const window = { since: toEtIso(since), until: startedAt, basis, ...(replay ? { replay: true } : {}) };

  writeJsonAtomic(wp.candidates, {
    schema_version: 1,
    run_id: runId,
    generated_at: finishedAt,
    window,
    candidates,
  });
  writeJsonAtomic(wp.fetchReport, {
    schema_version: 1,
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    window,
    user_agent: USER_AGENT,
    healthy,
    totals,
    date_warnings: dateIssues,
    sources: reports,
    manual: manual.map((r) => {
      const s = active.find((x) => x.id === r.id);
      return { id: r.id, publication: r.publication, url: r.url, notes: s?.notes ?? '' };
    }),
  });

  for (const r of reports) {
    const extra = r.status === 'ok'
      ? `${r.format}, ${r.entries} entries, ${r.in_window} in window, ${r.unseen} unseen${r.dateless ? `, ${r.dateless} undated` : ''}${r.future_dated ? `, ${r.future_dated} future-dated skipped` : ''}${r.bad_date ? `, ${r.bad_date} bad dates skipped` : ''}${r.excluded ? `, ${r.excluded} excluded by URL pattern` : ''}${r.redated ? `, ${r.redated} re-dated from the URL` : ''}${r.reposted ? `, ${r.reposted} repost(s) of older documents` : ''}`
      : r.status === 'manual' ? 'read manually (page)' : r.error;
    log(`  ${r.status.padEnd(6)} ${r.id}${r.retried_with_browser_ua ? ' [403 → retried with browser UA]' : ''}: ${extra}`);
  }
  for (const w of dateIssues) log(`warn  ${w}`);
  log(`sources ok ${totals.sources_ok}, failed ${totals.sources_failed}, manual ${totals.sources_manual}; fetched ${totals.fetched}, in window ${totals.in_window} (${totals.undated} undated), unseen ${totals.unseen}`);
  log(`wrote ${wp.candidates}`);
  if (!healthy) log(`UNHEALTHY: fewer than half of fetchable sources responded (${ok.length}/${fetchable}). Record a failed run: publish.mjs --run ${runId} --status failed --reason "..."`);
  out({ run_id: runId, window, healthy, totals, date_warnings: dateIssues, work_dir: wp.dir });
  return healthy ? 0 : 3;
});
