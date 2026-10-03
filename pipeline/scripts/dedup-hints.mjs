#!/usr/bin/env node
// Step 3 (SPEC §5): dedup hints for stage-1 survivors.
//
//   node pipeline/scripts/dedup-hints.mjs --run <run_id> [--now ISO] [--window-days 21]
//        [--archive F] [--work-dir D] [--thresholds F]
//
// For each survivor: likely/possible matches among archive items from the last dedup_window_days
// (pipeline/thresholds.json, default 21; --window-days overrides) days (relative
// to --now, default the run's slot) and among other survivors, plus candidate clusters. Hints
// only: the agent confirms same-story / material-update / cluster-merge in decisions.json.

import { parseCli, runMain, log, out, UsageError } from '../lib/cli.mjs';
import { readJson, writeJsonAtomic } from '../lib/io.mjs';
import { runWorkPaths } from '../lib/paths.mjs';
import { ARCHIVE_WINDOW_DAYS, THRESHOLDS, buildHints } from '../lib/similarity.mjs';
import { loadThresholds } from '../lib/thresholds.mjs';
import { parseRunId, slotFor, toEtIso } from '../lib/time.mjs';

const USAGE = 'node pipeline/scripts/dedup-hints.mjs --run <run_id> [--now ISO] [--window-days N] [--archive F] [--work-dir D] [--thresholds F]';

runMain(async () => {
  const { values, paths, now } = parseCli(process.argv.slice(2), {
    run: { type: 'string' },
    'window-days': { type: 'string' },
  }, USAGE);
  const runId = values.run ?? slotFor(now).run_id;
  const slot = parseRunId(runId);
  if (!slot) throw new UsageError(`--run: "${runId}" is not a slot run id`);
  const days = values['window-days'] ? Number(values['window-days']) : loadThresholds(paths.thresholds).number('dedup_window_days') || ARCHIVE_WINDOW_DAYS;
  if (!Number.isFinite(days) || days <= 0) throw new UsageError('--window-days: positive number');
  const ref = values.now ? now : slot.instant;

  const wp = runWorkPaths(paths.workDir, runId);
  const stage1 = readJson(wp.stage1);
  if (stage1.run_id !== runId) throw new Error(`${wp.stage1}: run_id ${stage1.run_id} does not match --run ${runId}`);
  const archive = readJson(paths.archive, { schema_version: 1, items: [] });
  const from = ref.getTime() - days * 86400e3;
  const recent = (archive.items ?? []).filter((i) => {
    const t = Date.parse(i?.timestamp);
    return Number.isFinite(t) && t >= from && t <= ref.getTime() + 86400e3;
  });

  const survivors = stage1.survivors ?? [];
  const { hints, clusters } = buildHints(survivors, recent);
  writeJsonAtomic(wp.dedupHints, {
    schema_version: 1,
    run_id: runId,
    generated_at: toEtIso(values.now ? now : new Date()),
    archive_window: { days, from: toEtIso(new Date(from)), items_compared: recent.length },
    thresholds: THRESHOLDS,
    clusters,
    hints,
  });

  const withArchive = hints.filter((h) => h.archive_matches.length).length;
  const likelyArchive = hints.filter((h) => h.archive_matches.some((m) => m.level !== 'possible')).length;
  for (const c of clusters) log(`  cluster ${c.cluster_id}: ${c.headlines.map((h) => h.slice(0, 70)).join(' | ')}`);
  for (const h of hints) {
    const m = h.archive_matches[0];
    if (m) log(`  archive ${m.level.padEnd(8)} ${m.score.toFixed(2)} ${h.headline.slice(0, 60)} ~ ${m.item_id}`);
  }
  log(`dedup hints ${runId}: ${survivors.length} survivor(s) vs ${recent.length} archive item(s) from ${days} d; ${clusters.length} cluster(s); ${withArchive} with archive matches (${likelyArchive} likely/exact)`);
  log(`wrote ${wp.dedupHints}`);
  out({ run_id: runId, survivors: survivors.length, archive_items_compared: recent.length, clusters: clusters.length, with_archive_matches: withArchive, likely_archive_matches: likelyArchive });
  return 0;
});
