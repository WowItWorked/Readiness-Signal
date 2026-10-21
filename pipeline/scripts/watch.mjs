#!/usr/bin/env node
// Rebuild docs/data/watch.json (the Global watch page) from pipeline/logs (pipeline/lib/watch.mjs).
// Run after every live publish (RUNBOOK step 13) and every backfill publish (BACKFILL.md §6).
//
//   node pipeline/scripts/watch.mjs [--logs-dir D] [--out F] [--check]
//
// --check writes nothing and exits 1 when the file on disk differs from a fresh build.

import path from 'node:path';
import { parseCli, runMain, log, out } from '../lib/cli.mjs';
import { exists, readJson, toJsonText, writeJsonAtomic } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { readAllLogs } from '../lib/dropped.mjs';
import { buildWatch } from '../lib/watch.mjs';

const USAGE = `node pipeline/scripts/watch.mjs [--logs-dir D] [--out F] [--check]

Rebuilds docs/data/watch.json from the live run logs and the backfill audit logs: regulatory
signals from Global watch jurisdictions recorded as RT_GLOBAL_WATCH (FILTER.md §4.4.6).
--check compares instead of writing.`;

runMain(async () => {
  const { values, paths } = parseCli(process.argv.slice(2), {
    out: { type: 'string' },
    check: { type: 'boolean' },
  }, USAGE);
  const outFile = values.out ? path.resolve(values.out) : path.join(REPO_ROOT, 'docs', 'data', 'watch.json');
  const doc = buildWatch({ logs: readAllLogs(paths.logsDir) });
  const summary = { file: outFile, items: doc.items.length, jurisdictions: doc.jurisdictions.length };
  if (values.check) {
    const same = exists(outFile) && toJsonText(readJson(outFile)) === toJsonText(doc);
    log(same ? `watch.json is current (${doc.items.length} items)` : 'watch.json is out of date: run node pipeline/scripts/watch.mjs');
    out({ ...summary, current: same });
    return same ? 0 : 1;
  }
  writeJsonAtomic(outFile, doc);
  log(`wrote ${outFile}: ${doc.items.length} Global watch signals from ${doc.jurisdictions.length} jurisdictions`);
  out(summary);
  return 0;
});
