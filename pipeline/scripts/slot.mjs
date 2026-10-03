#!/usr/bin/env node
// Step 0 (SPEC §4/§5): which edition slot is this run, and has it already run?
//
//   node pipeline/scripts/slot.mjs [--now ISO] [--runs F]
//   node pipeline/scripts/slot.mjs --run <run_id> [--runs F]
//
// stdout: { slot, run_id, id_stem, already_run, superseded, previous_run, latest_run,
// fetch_since, ... }. Exit 0 either way; when already_run is true the routine stops without doing
// anything (idempotent).
//
// --run checks a given run id against runs.json without reading the clock (RUNBOOK step 14, after
// a reset to origin/main): already_run = a record for that slot exists; superseded = a record for
// a later slot exists, so publish.mjs would refuse the run (runs are appended in slot order).

import { parseCli, runMain, log, out, UsageError } from '../lib/cli.mjs';
import { readJson } from '../lib/io.mjs';
import { defaultSince } from '../lib/collect.mjs';
import { formatEtHuman, parseRunId, slotFor, toEtIso } from '../lib/time.mjs';

const USAGE = `node pipeline/scripts/slot.mjs [--now ISO] [--runs F]
node pipeline/scripts/slot.mjs --run <run_id> [--runs F]

  (no --run)  the slot for the current clock (or --now): stop when already_run is true
  --run ID    check that run id against runs.json without reading the clock: already_run is true
              when a record for the slot exists; superseded is true when a later slot is recorded`;

runMain(async () => {
  const { values, paths, now } = parseCli(process.argv.slice(2), { run: { type: 'string' } }, USAGE);
  if (values.run !== undefined && values.now !== undefined) throw new UsageError('--run and --now are exclusive (--run never reads the clock)');
  const fixed = values.run !== undefined ? parseRunId(values.run) : null;
  if (values.run !== undefined && !fixed) throw new UsageError(`--run: "${values.run}" is not a slot run id (YYYY-MM-DD-HHMM at 0600/1000/1400/1800 ET)`);
  const slot = fixed ?? slotFor(now);
  const runsDoc = readJson(paths.runs, { schema_version: 1, runs: [] });
  const runs = Array.isArray(runsDoc.runs) ? runsDoc.runs : [];
  const already = runs.find((r) => r?.run_id === slot.run_id || r?.slot === slot.iso) ?? null;
  const later = runs.filter((r) => parseRunId(r?.run_id) && parseRunId(r.run_id).instant > slot.instant);
  const earlier = runs.filter((r) => parseRunId(r?.run_id) && parseRunId(r.run_id).instant < slot.instant);
  const prev = earlier.at(-1) ?? null;
  const latest = runs.at(-1) ?? null;
  const brief = (r) => (r ? { run_id: r.run_id, status: r.status, started_at: r.started_at, finished_at: r.finished_at } : null);
  const result = {
    ...(fixed ? {} : { now: toEtIso(now) }),
    slot: slot.iso,
    run_id: slot.run_id,
    id_stem: slot.id_stem,
    already_run: Boolean(already),
    superseded: later.length > 0,
    previous_run: brief(prev),
    latest_run: brief(latest),
  };
  if (!fixed) {
    const { since, basis } = defaultSince({ runs: runs.filter((r) => r?.run_id !== slot.run_id) }, now);
    result.fetch_since = toEtIso(since);
    result.fetch_since_basis = basis;
  }
  const state = already
    ? ` ALREADY RUN (status ${already.status}) - stop`
    : later.length ? ` SUPERSEDED by ${later.at(-1).run_id} - stop (publish.mjs would refuse)` : '';
  log(`slot ${formatEtHuman(slot.instant)} (${slot.run_id})${state}`);
  out(result);
  return 0;
});
