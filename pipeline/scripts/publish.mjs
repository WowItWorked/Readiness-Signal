#!/usr/bin/env node
// Step 5 (SPEC §5): validate decisions.json, assign ids, append items and the run record.
//
//   node pipeline/scripts/publish.mjs --run <run_id> [--dry-run [--seen-out F]] [--now ISO]
//        [--status failed --reason "..."] [--threshold-level high] [--started-at ISO]
//        [--archive F] [--runs F] [--seen F] [--logs-dir D] [--work-dir D] [--filter F] [--thresholds F]
//
// The only writer of docs/data/archive.json and docs/data/runs.json. Never modifies an existing
// item or run record. Refuses (exit 1, readable error list) on any schema/lint violation, when a
// run record for the slot already exists, when the slot is not after the latest recorded run, when
// the slot has not started yet, when the run's started_at falls in another slot, when a non-failed
// run has no fetch-report.json, or when fewer than half of the sources responded (record
// --status failed instead). Existing archive items are checked for schema only: the text lint
// applies to the items this run adds (published items are frozen). Reads thresholds.json
// writing.claims_may_name_institutions: at false (launch) a financial institution named in a
// claim is an error, at true a warning.
// Writes logs/YYYY/MM/<run_id>.jsonl, seen.json, archive.json and runs.json, each atomically (temp
// + rename) and as one unit: if any write fails, the files already written are restored.
// --dry-run prints everything and writes nothing, except with --seen-out F (owner replays only,
// RUNBOOK section C): the seen.json this run would leave is written to F, outside docs/data,
// pipeline/state and pipeline/logs, so the next replayed run can be fetched with --seen F.

import fs from 'node:fs';
import path from 'node:path';
import { parseCli, runMain, log, out, printIssues, UsageError } from '../lib/cli.mjs';
import { exists, readJson, toJsonlText, toJsonText, writeFilesAtomically, writeJsonAtomic } from '../lib/io.mjs';
import { DEFAULT_PATHS, runLogPath, runWorkPaths } from '../lib/paths.mjs';
import {
  assignIds, buildLogRows, computeFunnel, emptyStage2BySection, fetchUnhealthy, finaliseItem,
  mechanismDistribution, seenConflicts, stage2BySection, updateSeen,
} from '../lib/publish.mjs';
import { loadThresholds } from '../lib/thresholds.mjs';
import { formatEtHuman, isEtIso, parseRunId, slotFor, toEtIso } from '../lib/time.mjs';
import {
  Issues, LIMITS, checkAppendOnly, findFirstPerson, parseReasonCodeElements, parseReasonCodes, validateArchive, validateDecisions, validateItem, validateRun, validateRuns, validateSeen,
} from '../lib/validate.mjs';

const USAGE = `node pipeline/scripts/publish.mjs --run <run_id> [--dry-run [--seen-out F]] [--now ISO]
  [--status failed --reason "..."] [--threshold-level high] [--started-at ISO]
  [--archive F] [--runs F] [--seen F] [--logs-dir D] [--work-dir D] [--filter F] [--thresholds F]

  --dry-run      validate and print the result; write nothing
  --seen-out F   with --dry-run only (owner replays, RUNBOOK section C): write the seen.json this
                 run would leave to F (never docs/data, pipeline/state or pipeline/logs); fetch the
                 next replayed run with --seen F`;

runMain(async () => {
  const { values, paths, now } = parseCli(process.argv.slice(2), {
    run: { type: 'string' },
    'dry-run': { type: 'boolean' },
    status: { type: 'string' },
    reason: { type: 'string' },
    'threshold-level': { type: 'string' },
    'started-at': { type: 'string' },
    'seen-out': { type: 'string' },
  }, USAGE);

  if (!values.run) throw new UsageError(`--run <run_id> is required\n\n${USAGE}`);
  const runId = values.run;
  const slot = parseRunId(runId);
  if (!slot) throw new UsageError(`--run: "${runId}" is not a slot run id (YYYY-MM-DD-HHMM at 0600/1000/1400/1800 ET)`);
  const failed = values.status !== undefined;
  if (failed && values.status !== 'failed') throw new UsageError('--status: only "failed" can be set explicitly (published/silent are derived)');
  if (failed && !values.reason?.trim()) throw new UsageError('--status failed requires --reason "..."');
  if (!failed && values.reason) throw new UsageError('--reason is only used with --status failed');
  if (values.reason && values.reason.length > LIMITS.notesChars) throw new UsageError(`--reason: max ${LIMITS.notesChars} chars`);
  if (values.reason && /[\r\n]/.test(values.reason)) throw new UsageError('--reason: one line');
  if (values.reason && findFirstPerson(values.reason)) throw new UsageError(`--reason: first-person voice "${findFirstPerson(values.reason)}" (run notes are public)`);
  const dryRun = Boolean(values['dry-run']);
  let seenOut = null;
  if (values['seen-out'] !== undefined) {
    if (!dryRun) throw new UsageError('--seen-out is only for --dry-run replays (RUNBOOK section C)');
    seenOut = path.resolve(values['seen-out']);
    const inside = (dir) => { const rel = path.relative(dir, seenOut); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
    const guarded = [path.dirname(DEFAULT_PATHS.archive), path.dirname(DEFAULT_PATHS.seen), DEFAULT_PATHS.logsDir, paths.logsDir];
    if ([paths.seen, paths.archive, paths.runs].some((p) => seenOut === path.resolve(p)) || guarded.some(inside)) {
      throw new UsageError(`--seen-out ${seenOut}: write the replay's seen file to a scratch path, never over seen.json or inside docs/data, pipeline/state or pipeline/logs`);
    }
  }
  const thresholds = loadThresholds(paths.thresholds);
  // FILTER V4: at the launch value (false) a financial institution named in a claim is an error.
  const claimsMayNameInstitutions = thresholds.bool('claims_may_name_institutions');

  // ---- load and check the current state
  const archive = readJson(paths.archive, { schema_version: 1, items: [] });
  const runs = readJson(paths.runs, { schema_version: 1, runs: [] });
  const seen = readJson(paths.seen, { schema_version: 1, urls: {} });
  // Existing items: schema only. Re-linting them would let a tightened lint rule invalidate an
  // item that can never be changed, and block every later run.
  const pre = new Issues()
    .merge(validateArchive(archive, { lint: 'off' }))
    .merge(validateRuns(runs, archive))
    .merge(validateSeen(seen));
  if (!pre.ok) {
    printIssues('existing data', pre.result());
    throw new Error('existing archive/runs/seen are invalid; fix them before publishing (run validate.mjs)');
  }
  const existing = runs.runs.find((r) => r.run_id === runId || r.slot === slot.iso);
  if (existing) throw new Error(`a run record for slot ${runId} already exists (status ${existing.status}); refusing to publish twice`);
  const last = runs.runs[runs.runs.length - 1];
  if (last && parseRunId(last.run_id) && parseRunId(last.run_id).instant >= slot.instant) {
    throw new Error(`run ${runId} is not after the latest recorded run ${last.run_id}; runs are appended in slot order`);
  }
  // A future slot would block every real slot before it (slot order): never record one.
  if (now < slot.instant) throw new Error(`slot ${runId} has not started yet (now ${toEtIso(now)}, slot ${slot.iso}); check $RUN against slot.mjs`);

  // ---- work files
  const wp = runWorkPaths(paths.workDir, runId);
  const fetchReport = exists(wp.fetchReport) ? readJson(wp.fetchReport) : null;
  const candidatesDoc = exists(wp.candidates) ? readJson(wp.candidates) : null;
  const stage1 = exists(wp.stage1) ? readJson(wp.stage1) : null;
  for (const [name, doc] of [['fetch-report.json', fetchReport], ['candidates.json', candidatesDoc], ['stage1.json', stage1]]) {
    if (doc && doc.run_id !== runId) throw new Error(`${name}: run_id ${doc.run_id} does not match --run ${runId}`);
  }

  let startedAt = fetchReport?.started_at;
  if (values['started-at']) {
    const d = new Date(values['started-at']);
    if (Number.isNaN(d.getTime())) throw new UsageError('--started-at: not a valid date');
    startedAt = toEtIso(d);
  }
  if (!failed && !fetchReport) {
    throw new Error(`${wp.fetchReport} not found: run fetch.mjs for this run first, or record --status failed --reason "..."`);
  }
  if (!isEtIso(startedAt)) startedAt = toEtIso(now);
  const finishedAt = toEtIso(now);
  const warnings = [];
  const startSlot = slotFor(new Date(startedAt));
  if (startSlot.run_id !== runId) {
    // Started before the slot: a mistyped run id. Started in a later slot: the work belongs to that
    // slot; only a failed run may still be recorded late.
    const msg = `started_at ${startedAt} falls in slot ${startSlot.run_id}, not ${runId}`;
    if (!failed || startSlot.instant < slot.instant) throw new Error(`${msg}; the run id must be the slot the run started in (slot.mjs)`);
    warnings.push(msg);
  }

  const survivors = Array.isArray(stage1?.survivors) ? stage1.survivors : [];
  let record;
  let newItems = [];
  let logRows = [];
  let seenUpdate = null;
  const decisionIssues = new Issues();

  if (failed) {
    // ---- failed run: no items, no seen changes
    const decisions = exists(wp.decisions) ? readJson(wp.decisions) : null;
    record = {
      run_id: runId,
      slot: slot.iso,
      started_at: startedAt,
      finished_at: finishedAt,
      status: 'failed',
      items: [],
      threshold_level: values['threshold-level'] ?? decisions?.threshold_level ?? thresholds.level,
      funnel: { ...computeFunnel({ fetchReport, stage1, judgments: [], published: 0 }) },
      stage2_by_section: emptyStage2BySection(),
      mechanism_distribution: mechanismDistribution([]),
      notes: values.reason.trim(),
    };
    logRows = buildLogRows({ runId, survivors, failedReason: values.reason.trim() });
  } else {
    if (!candidatesDoc) throw new Error(`${wp.candidates} not found (run fetch.mjs first, or record --status failed)`);
    if (!stage1) throw new Error(`${wp.stage1} not found (run prefilter.mjs first, or record --status failed)`);
    const unhealthy = fetchUnhealthy(fetchReport);
    if (unhealthy) {
      throw new Error(`fewer than half of sources responded (${unhealthy.ok}/${unhealthy.total}); publish nothing and record a failed run: --status failed --reason "..."`);
    }
    let decisions;
    if (exists(wp.decisions)) decisions = readJson(wp.decisions);
    else if (survivors.length === 0) decisions = { run_id: runId, threshold_level: values['threshold-level'] ?? thresholds.level, judgments: [], items: [], ...(thresholds.found ? {} : { notes: 'thresholds: defaults used' }) };
    else throw new Error(`${wp.decisions} not found: ${survivors.length} stage-1 survivor(s) need judgments`);

    const candidates = Array.isArray(candidatesDoc.candidates) ? candidatesDoc.candidates : [];
    for (const c of seenConflicts(survivors, seen)) {
      warnings.push(`survivor ${c.candidate_id} ("${String(c.headline ?? '').slice(0, 80)}") is now in seen.json as ${c.verdict}${c.item_id ? ` (${c.item_id})` : ''} from run ${c.run_id}; re-check its judgment against FILTER.md §5 (another run recorded it after this run's fetch)`);
    }
    const filterText = exists(paths.filter) ? fs.readFileSync(paths.filter, 'utf8') : null;
    decisionIssues.merge(validateDecisions(decisions, {
      runId,
      candidates,
      survivorIds: survivors.map((s) => s.candidate_id),
      archiveItems: archive.items,
      reasonCodes: parseReasonCodes(filterText),
      reasonElements: parseReasonCodeElements(filterText),
      knobs: thresholds.knobs(),
      claimsMayNameInstitutions,
      window: candidatesDoc.window ?? null,
      filterText,
    }));
    if (!decisionIssues.ok) {
      printIssues('decisions.json', decisionIssues.result());
      throw new Error(`decisions.json has ${decisionIssues.errors.length} error(s); nothing was written`);
    }

    const order = assignIds(decisions.items, slot.id_stem);
    const itemIdByDraftIndex = new Map(order.map((o) => [o.draftIndex, o.id]));
    newItems = order.map(({ draftIndex, id }) => finaliseItem(decisions.items[draftIndex], { id, timestamp: slot.iso }));
    const taken = new Set(archive.items.map((i) => i.id));
    for (const it of newItems) {
      if (taken.has(it.id)) throw new Error(`item id ${it.id} already exists in the archive`);
      const r = validateItem(it, { at: it.id, mode: 'archive', claimsMayNameInstitutions });
      if (r.errors.length) {
        printIssues(it.id, r);
        throw new Error(`assembled item ${it.id} is invalid (bug); nothing was written`);
      }
    }
    record = {
      run_id: runId,
      slot: slot.iso,
      started_at: startedAt,
      finished_at: finishedAt,
      status: newItems.length ? 'published' : 'silent',
      items: newItems.map((i) => i.id),
      threshold_level: decisions.threshold_level,
      funnel: computeFunnel({ fetchReport, stage1, judgments: decisions.judgments, published: newItems.length }),
      stage2_by_section: stage2BySection(decisions.judgments),
      mechanism_distribution: mechanismDistribution(newItems),
    };
    if (typeof decisions.notes === 'string' && decisions.notes.trim()) record.notes = decisions.notes.trim();
    logRows = buildLogRows({ runId, survivors, judgments: decisions.judgments, itemIdByDraftIndex });
    seenUpdate = updateSeen(seen, {
      runId,
      firstSeen: startedAt,
      now,
      survivors,
      judgments: decisions.judgments,
      draftItems: decisions.items,
      candidatesById: new Map(candidates.map((c) => [c.candidate_id, c])),
      itemIdByDraftIndex,
    });
  }

  // ---- assemble and re-validate the result in memory
  const nextArchive = { ...archive, items: [...archive.items, ...newItems] };
  const nextRuns = { ...runs, runs: [...runs.runs, record] };
  // New items were linted above (validateDecisions, validateItem); here: schema and cross-checks.
  const post = new Issues()
    .merge(validateRun(record, { at: `run ${runId}` }))
    .merge(validateArchive(nextArchive, { lint: 'off' }))
    .merge(validateRuns(nextRuns, nextArchive))
    .merge(checkAppendOnly(archive, nextArchive, 'archive'))
    .merge(checkAppendOnly(runs, nextRuns, 'runs'));
  if (seenUpdate) post.merge(validateSeen(seenUpdate.doc));
  if (!post.ok) {
    printIssues('assembled result', post.result());
    throw new Error('assembled archive/runs failed validation; nothing was written');
  }
  // Item warnings were already reported against decisions.json; keep only this run's record warnings.
  const allWarnings = [...warnings, ...decisionIssues.warnings, ...post.warnings.filter((w) => w.includes(runId))];
  for (const w of allWarnings) log(`  warn  ${w}`);

  const logPath = runLogPath(paths.logsDir, runId);
  // funnel.dedup_dropped (SPEC §3.3) counts both; the split tells a resurfacing story from a cluster.
  const dedupSplit = {
    same_story: logRows.filter((r) => r.dedup === 'same_story_dropped').length,
    cluster_members: logRows.filter((r) => r.dedup === 'cluster_merged').length,
  };
  const summary = {
    run_id: runId,
    slot: slot.iso,
    status: record.status,
    dry_run: dryRun,
    items: record.items,
    funnel: record.funnel,
    dedup_dropped_split: dedupSplit,
    stage2_by_section: record.stage2_by_section,
    mechanism_distribution: record.mechanism_distribution,
    warnings: allWarnings,
  };

  log(`${record.status.toUpperCase()} ${formatEtHuman(slot.instant)} (${runId}): ${record.items.length} item(s)`);
  for (const it of newItems) log(`  ${it.id}  ${it.section} / ${it.mechanism}  ${it.claim}`);
  const md = record.mechanism_distribution;
  log(`  mechanisms: candidate_issue ${md.candidate_issue}, kri_kpi ${md.kri_kpi}, praf_coverage ${md.praf_coverage}, awareness_only ${md.awareness_only}`);
  const f = record.funnel;
  log(`  funnel: sources ${f.sources_ok} ok / ${f.sources_failed} failed; fetched ${f.fetched} -> in window ${f.in_window} -> unseen ${f.unseen} -> stage1 ${f.stage1_pass} -> stage2 ${f.stage2_pass} -> dedup dropped ${f.dedup_dropped} (same story ${dedupSplit.same_story}, cluster members ${dedupSplit.cluster_members}) -> published ${f.published}`);

  if (dryRun) {
    if (seenOut) {
      if (!seenUpdate) throw new Error('--seen-out: a failed run records nothing in seen.json');
      writeJsonAtomic(seenOut, seenUpdate.doc);
      log(`dry run: nothing written to the data; replay seen file written to ${seenOut} (${Object.keys(seenUpdate.doc.urls).length} URL(s); fetch the next replayed run with --seen ${seenOut})`);
      out({ ...summary, run_record: record, new_items: newItems, log_rows: logRows.length, seen_added: seenUpdate.added, seen_pruned: seenUpdate.pruned, seen_out: seenOut, would_write: [logRows.length ? logPath : null, paths.seen, newItems.length ? paths.archive : null, paths.runs].filter(Boolean) });
      return 0;
    }
    log('dry run: nothing written');
    out({ ...summary, run_record: record, new_items: newItems, log_rows: logRows.length, seen_added: seenUpdate?.added ?? 0, seen_pruned: seenUpdate?.pruned ?? 0, would_write: [logRows.length ? logPath : null, seenUpdate ? paths.seen : null, newItems.length ? paths.archive : null, paths.runs].filter(Boolean) });
    return 0;
  }

  // One unit: if any write fails, the files already written are restored, so the data never holds
  // items without their run record (which would block this and every later run).
  const writes = [];
  if (logRows.length) writes.push([logPath, toJsonlText(logRows)]);
  if (seenUpdate) writes.push([paths.seen, toJsonText(seenUpdate.doc)]);
  if (newItems.length) writes.push([paths.archive, toJsonText(nextArchive)]);
  writes.push([paths.runs, toJsonText(nextRuns)]); // last: the run record marks the slot as done
  const written = writeFilesAtomically(writes);
  for (const p of written) log(`  wrote ${p}`);
  const n = record.items.length;
  const hhmm = `${runId.slice(11, 13)}:${runId.slice(13, 15)}`;
  const commit = record.status === 'published'
    ? `edition: ${runId.slice(0, 10)} ${hhmm} ET (+${n} items)`
    : `run: ${runId.slice(0, 10)} ${hhmm} ET (${record.status})`;
  log(`  commit message: ${commit}`);
  out({ ...summary, written, commit_message: commit });
  return 0;
});
