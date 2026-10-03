#!/usr/bin/env node
// Validate the published data (SPEC §6): archive.json + runs.json (+ seen.json), and optionally
// the append-only rule against a git ref.
//
//   node pipeline/scripts/validate.mjs [--archive F] [--runs F] [--seen F] [--thresholds F]
//        [--against-git-ref <ref>] [--repo DIR] [--strict-lint] [--quiet]
//
// --against-git-ref reads `git show <ref>:<path>` for archive.json and runs.json (a file missing at
// <ref> counts as empty) and fails if any item or run record present there is missing, changed or
// reordered now. Exit 1 on any error, 2 on usage error (including an unknown ref).
//
// Text lint (SPEC §6: first person, institution names, word limits, shapes): published items are
// frozen, so a lint rule tightened after publication must not make the archive permanently
// invalid. With --against-git-ref, items new since <ref> are linted as errors and items already
// at <ref> as warnings. Without a ref every item is linted as a warning, unless --strict-lint.
// Schema, ids, run records and cross-checks are always errors. The lint reads
// writing.claims_may_name_institutions from thresholds.json (--thresholds F).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseCli, runMain, log, out, UsageError } from '../lib/cli.mjs';
import { exists, readJson } from '../lib/io.mjs';
import { loadThresholds } from '../lib/thresholds.mjs';
import { checkAppendOnly, Issues, validateArchive, validateRuns, validateSeen } from '../lib/validate.mjs';

const USAGE = `node pipeline/scripts/validate.mjs [--archive F] [--runs F] [--seen F] [--thresholds F]
  [--against-git-ref <ref>] [--repo DIR] [--strict-lint] [--quiet]

  --against-git-ref <ref>  also fail if any item or run record present at <ref> was removed,
                           changed or moved; text-lint items new since <ref> as errors
  --strict-lint            text-lint every item as an error (default without a ref: warnings)`;

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true });
}

/** Parsed JSON of `file` at `ref`, or null when the file does not exist there. */
function readAtRef(file, ref, repoOverride) {
  const cwd = repoOverride ? path.resolve(repoOverride) : path.dirname(file);
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (top.status !== 0) throw new UsageError(`not inside a git repository: ${cwd}`);
  const root = top.stdout.trim();
  const verify = git(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], root);
  if (verify.status !== 0) throw new UsageError(`git ref not found: ${ref}`);
  const rel = path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join('/');
  if (rel.startsWith('..')) throw new UsageError(`${file} is outside the repository ${root}`);
  const shown = git(['show', `${ref}:${rel}`], root);
  if (shown.status !== 0) {
    if (/does not exist|exists on disk, but not in|not in '/i.test(shown.stderr)) return null;
    throw new Error(`git show ${ref}:${rel} failed: ${shown.stderr.trim()}`);
  }
  try {
    return JSON.parse(shown.stdout.replace(/^\s+/, ''));
  } catch (err) {
    throw new Error(`${rel} at ${ref} is not valid JSON: ${err.message}`);
  }
}

runMain(async () => {
  const { values, paths } = parseCli(process.argv.slice(2), {
    'against-git-ref': { type: 'string' },
    repo: { type: 'string' },
    'strict-lint': { type: 'boolean' },
    quiet: { type: 'boolean', short: 'q' },
  }, USAGE);

  const archive = readJson(paths.archive);
  const runs = readJson(paths.runs);
  const ref = values['against-git-ref'];
  const beforeArchive = ref ? readAtRef(paths.archive, ref, values.repo) : null;
  const beforeRuns = ref ? readAtRef(paths.runs, ref, values.repo) : null;
  const publishedAtRef = new Set((Array.isArray(beforeArchive?.items) ? beforeArchive.items : []).map((i) => i?.id).filter(Boolean));
  const lint = values['strict-lint'] ? 'error' : ref ? (item) => (publishedAtRef.has(item?.id) ? 'warn' : 'error') : 'warn';
  // FILTER V4: thresholds.json writing.claims_may_name_institutions decides whether a financial
  // institution named in a claim is an error (false, launch) or a warning (true).
  const claimsMayNameInstitutions = loadThresholds(paths.thresholds).bool('claims_may_name_institutions');
  const a = validateArchive(archive, { lint, claimsMayNameInstitutions });
  const r = validateRuns(runs, archive);
  const s = exists(paths.seen) ? validateSeen(readJson(paths.seen)) : { errors: [], warnings: [] };
  const report = {
    archive: { file: paths.archive, items: Array.isArray(archive?.items) ? archive.items.length : 0, ...a },
    runs: { file: paths.runs, runs: Array.isArray(runs?.runs) ? runs.runs.length : 0, ...r },
    seen: { file: paths.seen, ...s },
  };

  let appendOnly = null;
  if (ref) {
    const v = new Issues()
      .merge(checkAppendOnly(beforeArchive, archive, 'archive'))
      .merge(checkAppendOnly(beforeRuns, runs, 'runs'));
    appendOnly = {
      ref,
      before: {
        items: Array.isArray(beforeArchive?.items) ? beforeArchive.items.length : 0,
        runs: Array.isArray(beforeRuns?.runs) ? beforeRuns.runs.length : 0,
      },
      ...v.result(),
    };
    report.append_only = appendOnly;
  }

  const sections = [['archive', report.archive], ['runs', report.runs], ['seen', report.seen]];
  if (appendOnly) sections.push([`append-only vs ${appendOnly.ref}`, appendOnly]);
  let errors = 0;
  for (const [name, x] of sections) {
    if (!values.quiet) for (const w of x.warnings) log(`  warn  ${w}`);
    for (const e of x.errors) log(`  ERROR ${e}`);
    errors += x.errors.length;
    log(`${name}: ${x.errors.length} error(s), ${x.warnings.length} warning(s)`);
  }
  log(errors ? `INVALID: ${errors} error(s)` : `OK: ${report.archive.items} item(s), ${report.runs.runs} run(s)${appendOnly ? `, append-only vs ${appendOnly.ref} (+${report.archive.items - appendOnly.before.items} items, +${report.runs.runs - appendOnly.before.runs} runs)` : ''}`);
  out({ ok: errors === 0, ...report });
  return errors ? 1 : 0;
});
