#!/usr/bin/env node
// Step 2 (SPEC §5): stage-1 domain relevance. Reads candidates.json, writes stage1.json.
//
//   node pipeline/scripts/prefilter.mjs --run <run_id> [--now ISO] [--sources F] [--work-dir D] [--verbose]
//
// Drops seen candidates, event listings, roundups, principally-marketing items and off-domain /
// low-scoring items (lexicon in pipeline/lib/lexicon.mjs). Survivors carry matched domains, score
// and matched terms. Extra sources added with add-manual.mjs --extra are not scored.

import { parseCli, runMain, log, out, UsageError } from '../lib/cli.mjs';
import { exists, readJson, writeJsonAtomic } from '../lib/io.mjs';
import { runWorkPaths } from '../lib/paths.mjs';
import { runPrefilter } from '../lib/prefilter.mjs';
import { loadSources, sourceMap } from '../lib/sources.mjs';
import { parseRunId, slotFor, toEtIso } from '../lib/time.mjs';

const USAGE = 'node pipeline/scripts/prefilter.mjs --run <run_id> [--now ISO] [--sources F] [--work-dir D] [--verbose]';

runMain(async () => {
  const { values, paths, now } = parseCli(process.argv.slice(2), {
    run: { type: 'string' },
    verbose: { type: 'boolean', short: 'v' },
  }, USAGE);
  const runId = values.run ?? slotFor(now).run_id;
  if (!parseRunId(runId)) throw new UsageError(`--run: "${runId}" is not a slot run id`);
  const wp = runWorkPaths(paths.workDir, runId);
  const cand = readJson(wp.candidates);
  if (cand.run_id !== runId) throw new Error(`${wp.candidates}: run_id ${cand.run_id} does not match --run ${runId}`);

  let sources = new Map();
  if (exists(paths.sources)) {
    const loaded = loadSources(paths.sources, { allowHttp: true });
    if (loaded.errors.length) log(`warn  ${paths.sources} has ${loaded.errors.length} error(s); using class defaults where needed`);
    sources = sourceMap(loaded.sources);
  } else {
    log(`warn  ${paths.sources} not found; profiles fall back to source class`);
  }

  const result = runPrefilter(cand.candidates ?? [], { sources });
  const doc = {
    schema_version: 1,
    run_id: runId,
    generated_at: toEtIso(values.now ? now : new Date()),
    ...result,
  };
  writeJsonAtomic(wp.stage1, doc);

  const { counts } = result;
  const unseen = counts.input - counts.seen;
  const rate = unseen ? Math.round((counts.passed / unseen) * 1000) / 10 : 0;
  for (const [id, s] of Object.entries(result.by_source)) {
    const r = s.unseen ? Math.round((s.passed / s.unseen) * 100) : 0;
    log(`  ${id.padEnd(28)} ${s.profile.padEnd(8)} unseen ${String(s.unseen).padStart(4)}  passed ${String(s.passed).padStart(3)}  (${r}%)`);
  }
  if (values.verbose) {
    for (const s of result.survivors) log(`  + ${s.score.toFixed(1).padStart(5)} [${s.domains.join(',')}] ${s.headline}`);
  }
  log(`stage 1 ${runId}: ${counts.input} in, ${counts.seen} seen, ${counts.event} event listings, ${counts.roundup} roundup, ${counts.redundant} redundant, ${counts.marketing} marketing, ${counts.off_domain} off-domain, ${counts.below_threshold} below threshold -> ${counts.passed} passed (${rate}% of unseen)${counts.extra ? `; ${counts.extra} extra source(s) not scored` : ''}`);
  log(`wrote ${wp.stage1}`);
  out({ run_id: runId, lexicon_version: result.lexicon_version, counts, pass_rate_of_unseen: rate, survivors: result.survivors.length });
  return 0;
});
