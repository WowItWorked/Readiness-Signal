#!/usr/bin/env node
// Rebuild docs/data/dropped.json (the Dropped page) from pipeline/logs (pipeline/lib/dropped.mjs).
// Run after every live publish (RUNBOOK step 12) and every backfill publish (BACKFILL.md §6).
//
//   node pipeline/scripts/dropped.mjs [--archive F] [--logs-dir D] [--filter F] [--out F] [--check]
//
// --check writes nothing and exits 1 when the file on disk differs from a fresh build.

import path from 'node:path';
import { parseCli, runMain, log, out } from '../lib/cli.mjs';
import { exists, readJson, toJsonText, writeJsonAtomic } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { buildDropped, readAllLogs, readText } from '../lib/dropped.mjs';

const USAGE = `node pipeline/scripts/dropped.mjs [--archive F] [--logs-dir D] [--filter F] [--out F] [--check]

Rebuilds docs/data/dropped.json from the live run logs and the backfill audit logs: in-domain
stories the filter dropped, with their reasons. --check compares instead of writing.`;

runMain(async () => {
  const { values, paths } = parseCli(process.argv.slice(2), {
    out: { type: 'string' },
    check: { type: 'boolean' },
  }, USAGE);
  const outFile = values.out ? path.resolve(values.out) : path.join(REPO_ROOT, 'docs', 'data', 'dropped.json');
  const doc = buildDropped({ logs: readAllLogs(paths.logsDir), archive: readJson(paths.archive), filterText: readText(paths.filter) });
  const summary = { file: outFile, items: doc.items.length, withheld_headlines: doc.items.filter((i) => i.headline_withheld).length };
  if (values.check) {
    const same = exists(outFile) && toJsonText(readJson(outFile)) === toJsonText(doc);
    log(same ? `dropped.json is current (${doc.items.length} items)` : 'dropped.json is out of date: run node pipeline/scripts/dropped.mjs');
    out({ ...summary, current: same });
    return same ? 0 : 1;
  }
  writeJsonAtomic(outFile, doc);
  log(`wrote ${outFile}: ${doc.items.length} dropped stories (${summary.withheld_headlines} headlines withheld)`);
  out(summary);
  return 0;
});
