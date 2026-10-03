// Shared CLI plumbing: flag parsing (node:util parseArgs), stderr logging, stdout JSON, exits.

import { parseArgs } from 'node:util';
import { resolvePaths } from './paths.mjs';
import { parseNow } from './time.mjs';

/** Flags every script accepts (path overrides + --now + --help). */
export const COMMON_OPTIONS = {
  now: { type: 'string' },
  archive: { type: 'string' },
  runs: { type: 'string' },
  seen: { type: 'string' },
  'logs-dir': { type: 'string' },
  'work-dir': { type: 'string' },
  sources: { type: 'string' },
  filter: { type: 'string' },
  thresholds: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

export class UsageError extends Error {}

/**
 * Parse argv with the common options plus `options`.
 * Returns { values, paths, now }.
 */
export function parseCli(argv, options = {}, usage = '') {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { ...COMMON_OPTIONS, ...options }, strict: true, allowPositionals: false });
  } catch (err) {
    throw new UsageError(`${err.message}${usage ? `\n\n${usage}` : ''}`);
  }
  const { values } = parsed;
  if (values.help) {
    process.stderr.write(`${usage}\n`);
    process.exit(0);
  }
  let now;
  try {
    now = parseNow(values.now);
  } catch (err) {
    throw new UsageError(err.message);
  }
  return { values, paths: resolvePaths(values), now };
}

export const log = (...parts) => process.stderr.write(`${parts.join(' ')}\n`);

export function out(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Run an async main(), mapping errors to exit codes (2 usage, 1 everything else). */
export function runMain(main) {
  Promise.resolve()
    .then(main)
    .then((code) => {
      process.exitCode = typeof code === 'number' ? code : 0;
    })
    .catch((err) => {
      if (err instanceof UsageError) {
        log(`usage error: ${err.message}`);
        process.exitCode = 2;
        return;
      }
      log(`error: ${err?.stack && process.env.RS_DEBUG ? err.stack : err?.message ?? err}`);
      process.exitCode = 1;
    });
}

export function printIssues(label, { errors = [], warnings = [] }) {
  for (const w of warnings) log(`  warn  ${w}`);
  for (const e of errors) log(`  ERROR ${e}`);
  log(`${label}: ${errors.length} error(s), ${warnings.length} warning(s)`);
}
