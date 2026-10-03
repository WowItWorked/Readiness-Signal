#!/usr/bin/env node
// Calibration review (SPEC §8): funnel, stage-2 pass rates by section, mechanism distribution
// (warning when candidate_issue exceeds candidate_issue_share_warn, default 40 %, of items), reason-code and dedup tallies, per-source
// stage-2 yield, per-run table. Near-misses: stories near each knob (FILTER.md §9.6(a)) and, as
// prominently, stories near each fixed element (NEAR without a knob: the §9.6 fixed-element
// route), each flagged once it reaches 3 stories.
//
//   node pipeline/scripts/calibration.mjs [--days N | --since ISO] [--until ISO] [--json]
//        [--runs F] [--logs-dir D] [--archive F] [--thresholds F] [--now ISO]
//
// Human report on stdout (or on stderr with --json, which prints machine JSON on stdout).

import { parseCli, runMain, log, UsageError } from '../lib/cli.mjs';
import { exists, readJson, readJsonl } from '../lib/io.mjs';
import { MECHANISMS, SECTIONS, FUNNEL_KEYS } from '../lib/enums.mjs';
import { runLogPath } from '../lib/paths.mjs';
import { loadThresholds } from '../lib/thresholds.mjs';
import { formatEtHuman, parseRunId, toEtIso } from '../lib/time.mjs';


const USAGE = `node pipeline/scripts/calibration.mjs [--days N | --since ISO] [--until ISO] [--json]
  [--runs F] [--logs-dir D] [--archive F] [--thresholds F] [--now ISO]`;

// FILTER.md §8.4: reason := [ "[M" 1-6 "] " ] [ "NEAR " element [ "/" knob ] ": " ] text ...
// A material update's near-miss ("[M3] NEAR E3/ev_min_general_outlets: ...") counts too, and so
// does the other section's knob near-miss in an alternative-route marker
// (" [alt EV:E3/ev_min_general_outlets]"); FILTER.md §9.6(a) counts both, per knob.
const NEAR_REASON = /^(?:\[M[1-6]\] )?NEAR ([^:]+):/;
const ALT_KNOB_REASON = / \[alt (?:EV|CS):([A-Z][A-Za-z0-9]*)\/([a-z][a-z0-9_]*)\]$/;

const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : 'n/a');
const ratio = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
const tally = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const sortedObj = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));

runMain(async () => {
  const { values, paths, now } = parseCli(process.argv.slice(2), {
    days: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    json: { type: 'boolean' },
  }, USAGE);
  if (values.days && values.since) throw new UsageError('use --days or --since, not both');
  let since = null;
  if (values.days) {
    const d = Number(values.days);
    if (!Number.isFinite(d) || d <= 0) throw new UsageError('--days: positive number');
    since = new Date(now.getTime() - d * 86400e3);
  } else if (values.since) {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime())) throw new UsageError('--since: not a valid date');
  }
  const until = values.until ? new Date(values.until) : null;
  if (until && Number.isNaN(until.getTime())) throw new UsageError('--until: not a valid date');

  const CANDIDATE_ISSUE_WARN_SHARE = loadThresholds(paths.thresholds).number('candidate_issue_share_warn');
  const runsDoc = readJson(paths.runs, { schema_version: 1, runs: [] });
  const runs = (runsDoc.runs ?? []).filter((r) => {
    const s = parseRunId(r?.run_id);
    if (!s) return false;
    if (since && s.instant < since) return false;
    if (until && s.instant > until) return false;
    return true;
  });

  const status = new Map();
  const funnel = Object.fromEntries(FUNNEL_KEYS.map((k) => [k, 0]));
  const sections = Object.fromEntries(SECTIONS.map((s) => [s, { tested: 0, passed: 0 }]));
  const mech = Object.fromEntries(MECHANISMS.map((m) => [m, 0]));
  for (const r of runs) {
    tally(status, r.status);
    if (r.status === 'failed') continue;
    for (const k of FUNNEL_KEYS) funnel[k] += Number(r.funnel?.[k] ?? 0);
    for (const s of SECTIONS) {
      sections[s].tested += Number(r.stage2_by_section?.[s]?.tested ?? 0);
      sections[s].passed += Number(r.stage2_by_section?.[s]?.passed ?? 0);
    }
    for (const m of MECHANISMS) mech[m] += Number(r.mechanism_distribution?.[m] ?? 0);
  }
  const items = MECHANISMS.reduce((n, m) => n + mech[m], 0);
  const ciShare = items ? mech.candidate_issue / items : 0;
  const warnings = [];
  if (items && ciShare > CANDIDATE_ISSUE_WARN_SHARE) {
    warnings.push(`candidate_issue is ${pct(mech.candidate_issue, items)} of items (> ${CANDIDATE_ISSUE_WARN_SHARE * 100}%): likely over-applied; reserve it for items where a specific control weakness can be articulated`);
  }
  if (funnel.unseen && funnel.stage1_pass / funnel.unseen > 0.25) warnings.push(`stage 1 passes ${pct(funnel.stage1_pass, funnel.unseen)} of unseen candidates (> 25%): lexicon may be too loose`);

  // logs: reason codes, verdicts, dedup, per-source yield
  const reasonCodes = new Map();
  const verdictBySection = new Map();
  const dedup = new Map();
  const nearMisses = new Map();
  const altNearMisses = new Map();
  const nearByKnob = new Map();
  const nearFixed = new Map();
  const perSource = new Map();
  let logRows = 0;
  const missingLogs = [];
  for (const r of runs) {
    const p = runLogPath(paths.logsDir, r.run_id);
    if (!exists(p)) {
      if (r.funnel?.stage1_pass) missingLogs.push(r.run_id);
      continue;
    }
    for (const row of readJsonl(p)) {
      logRows++;
      // stories, not members (FILTER.md §8.1): cluster members are left out of code tallies
      if (row.dedup !== 'cluster_merged') {
        tally(reasonCodes, row.reason_code ?? '(none)');
        tally(verdictBySection, `${row.section_tested ?? 'none'}:${row.verdict ?? 'none'}`);
        const near = typeof row.reason === 'string' ? NEAR_REASON.exec(row.reason) : null;
        if (near) tally(nearMisses, near[1]);
        if (near && !near[1].includes('/')) tally(nearFixed, near[1].trim());
        const alt = typeof row.reason === 'string' ? ALT_KNOB_REASON.exec(row.reason) : null;
        if (alt) tally(altNearMisses, `${alt[1]}/${alt[2]}`);
        // stories near each knob: a reason counts once per knob it names
        for (const k of new Set([near?.[1].split('/')[1], alt?.[2]].filter(Boolean))) tally(nearByKnob, k);
      }
      if (row.dedup) tally(dedup, row.dedup);
      const key = row.publication ?? row.source_id ?? '(unknown)';
      const ps = perSource.get(key) ?? { survivors: 0, passed: 0, published: 0 };
      ps.survivors++;
      if (row.verdict === 'pass') ps.passed++;
      if (row.item_id) ps.published++;
      perSource.set(key, ps);
    }
  }
  if (missingLogs.length) warnings.push(`no log file for ${missingLogs.length} run(s) with stage-1 survivors: ${missingLogs.slice(0, 5).join(', ')}${missingLogs.length > 5 ? ', ...' : ''}`);

  // archive cross-check: live items in range by mechanism
  const archive = readJson(paths.archive, { schema_version: 1, items: [] });
  const runSlots = new Set(runs.map((r) => r.slot));
  const archiveMech = Object.fromEntries(MECHANISMS.map((m) => [m, 0]));
  for (const it of archive.items ?? []) if (it?.backfilled === false && runSlots.has(it.timestamp) && archiveMech[it.mechanism] !== undefined) archiveMech[it.mechanism]++;

  const report = {
    generated_at: toEtIso(now),
    range: { since: since ? toEtIso(since) : null, until: until ? toEtIso(until) : null },
    runs: { total: runs.length, ...Object.fromEntries(['published', 'silent', 'failed'].map((s) => [s, status.get(s) ?? 0])) },
    funnel,
    conversion: {
      in_window_of_fetched: ratio(funnel.in_window, funnel.fetched),
      stage1_of_unseen: ratio(funnel.stage1_pass, funnel.unseen),
      stage2_of_stage1: ratio(funnel.stage2_pass, funnel.stage1_pass),
      published_of_stage2: ratio(funnel.published, funnel.stage2_pass),
    },
    stage2_by_section: Object.fromEntries(SECTIONS.map((s) => [s, { ...sections[s], pass_rate: ratio(sections[s].passed, sections[s].tested) }])),
    mechanism_distribution: { counts: mech, shares: Object.fromEntries(MECHANISMS.map((m) => [m, ratio(mech[m], items)])), items, archive_counts: archiveMech },
    reason_codes: sortedObj(reasonCodes),
    verdict_by_section: sortedObj(verdictBySection),
    dedup: sortedObj(dedup),
    near_misses: sortedObj(nearMisses),
    alt_near_misses: sortedObj(altNearMisses),
    near_misses_by_knob: sortedObj(nearByKnob),
    near_misses_fixed_elements: sortedObj(nearFixed),
    per_source: Object.fromEntries([...perSource.entries()].sort((a, b) => b[1].survivors - a[1].survivors)),
    log_rows: logRows,
    per_run: runs.map((r) => ({
      run_id: r.run_id,
      status: r.status,
      unseen: r.funnel?.unseen ?? 0,
      stage1_pass: r.funnel?.stage1_pass ?? 0,
      stage2_pass: r.funnel?.stage2_pass ?? 0,
      published: r.funnel?.published ?? 0,
      mechanisms: r.mechanism_distribution,
    })),
    warnings,
  };

  const lines = [];
  const L = (s = '') => lines.push(s);
  L(`Readiness Signal calibration — ${formatEtHuman(now)}`);
  L(`Range: ${report.range.since ?? 'all'} to ${report.range.until ?? 'latest'}`);
  L(`Runs: ${runs.length} (published ${report.runs.published}, silent ${report.runs.silent}, failed ${report.runs.failed})`);
  L();
  L('Funnel (successful runs)');
  L(`  sources ok/failed   ${funnel.sources_ok} / ${funnel.sources_failed}`);
  L(`  fetched             ${funnel.fetched}`);
  L(`  in window           ${funnel.in_window}  (${pct(funnel.in_window, funnel.fetched)} of fetched)`);
  L(`  unseen              ${funnel.unseen}`);
  L(`  stage 1 pass        ${funnel.stage1_pass}  (${pct(funnel.stage1_pass, funnel.unseen)} of unseen)`);
  L(`  stage 2 pass        ${funnel.stage2_pass}  (${pct(funnel.stage2_pass, funnel.stage1_pass)} of stage 1)`);
  L(`  dedup dropped       ${funnel.dedup_dropped}  (same story ${dedup.get('same_story_dropped') ?? 0}, cluster members ${dedup.get('cluster_merged') ?? 0}, from the logs)`);
  L(`  published           ${funnel.published}`);
  L();
  L('Stage 2 by section (tested -> passed)');
  for (const s of SECTIONS) L(`  ${s.padEnd(24)} ${String(sections[s].tested).padStart(4)} -> ${String(sections[s].passed).padStart(4)}  (${pct(sections[s].passed, sections[s].tested)})`);
  L();
  L(`Mechanism distribution (${items} item(s))`);
  for (const m of MECHANISMS) L(`  ${m.padEnd(18)} ${String(mech[m]).padStart(4)}  ${pct(mech[m], items)}`);
  L();
  L(`Reason codes (${logRows} logged judgment(s); cluster members excluded)`);
  for (const [k, n] of Object.entries(report.reason_codes)) L(`  ${k.padEnd(32)} ${n}`);
  if (Object.keys(report.near_misses).length) {
    L();
    L('NEAR drops by element/knob');
    for (const [k, n] of Object.entries(report.near_misses)) L(`  ${k.padEnd(32)} ${n}`);
  }
  if (Object.keys(report.alt_near_misses).length) {
    L();
    L('Other-section knob near-misses ([alt EV|CS:element/knob])');
    for (const [k, n] of Object.entries(report.alt_near_misses)) L(`  ${k.padEnd(32)} ${n}`);
  }
  if (Object.keys(report.near_misses_by_knob).length) {
    L();
    L('Stories near each knob (NEAR and [alt] markers; FILTER 9.6(a))');
    for (const [k, n] of Object.entries(report.near_misses_by_knob)) L(`  ${k.padEnd(32)} ${n}${n >= 3 ? '  <- 3+: rate them under 9.6(b)' : ''}`);
  }
  L();
  L('Stories near each fixed element (NEAR without a knob; FILTER 9.6 fixed-element route)');
  if (Object.keys(report.near_misses_fixed_elements).length) {
    for (const [k, n] of Object.entries(report.near_misses_fixed_elements)) L(`  ${k.padEnd(32)} ${n}${n >= 3 ? '  <- 3+: rate them; 2/3 "should have passed" records a proposed amendment' : ''}`);
  } else L('  none');
  if (Object.keys(report.dedup).length) {
    L();
    L('Dedup outcomes');
    for (const [k, n] of Object.entries(report.dedup)) L(`  ${k.padEnd(22)} ${n}`);
  }
  if (perSource.size) {
    L();
    L('Stage-2 yield by publication (survivors / passed / published)');
    for (const [k, v] of Object.entries(report.per_source).slice(0, 25)) L(`  ${k.slice(0, 32).padEnd(32)} ${String(v.survivors).padStart(4)} / ${String(v.passed).padStart(3)} / ${String(v.published).padStart(3)}`);
  }
  if (runs.length) {
    L();
    L('Per run (unseen -> stage1 -> stage2 -> published)');
    for (const r of report.per_run.slice(-40)) L(`  ${r.run_id}  ${r.status.padEnd(9)} ${r.unseen} -> ${r.stage1_pass} -> ${r.stage2_pass} -> ${r.published}`);
  }
  L();
  if (warnings.length) for (const w of warnings) L(`WARNING: ${w}`);
  else L('No calibration warnings.');

  const text = `${lines.join('\n')}\n`;
  if (values.json) {
    process.stderr.write(text);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(text);
  }
  if (!runs.length) log('(no runs in range)');
  return 0;
});
