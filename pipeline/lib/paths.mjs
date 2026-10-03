// Default locations, all overridable by CLI flags (tests always override them).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_PATHS = Object.freeze({
  archive: path.join(REPO_ROOT, 'docs', 'data', 'archive.json'),
  runs: path.join(REPO_ROOT, 'docs', 'data', 'runs.json'),
  seen: path.join(REPO_ROOT, 'pipeline', 'state', 'seen.json'),
  logsDir: path.join(REPO_ROOT, 'pipeline', 'logs'),
  workDir: path.join(REPO_ROOT, 'pipeline', 'work'),
  sources: path.join(REPO_ROOT, 'pipeline', 'sources.json'),
  filter: path.join(REPO_ROOT, 'pipeline', 'FILTER.md'),
  thresholds: path.join(REPO_ROOT, 'pipeline', 'thresholds.json'),
});

/** Resolve path flags (relative to cwd) over the defaults. */
export function resolvePaths(values = {}) {
  const pick = (flag, key) => (values[flag] ? path.resolve(values[flag]) : DEFAULT_PATHS[key]);
  return {
    archive: pick('archive', 'archive'),
    runs: pick('runs', 'runs'),
    seen: pick('seen', 'seen'),
    logsDir: pick('logs-dir', 'logsDir'),
    workDir: pick('work-dir', 'workDir'),
    sources: pick('sources', 'sources'),
    filter: pick('filter', 'filter'),
    thresholds: pick('thresholds', 'thresholds'),
  };
}

/** Per-run work directory and its files. */
export function runWorkPaths(workDir, runId) {
  const dir = path.join(workDir, runId);
  return {
    dir,
    candidates: path.join(dir, 'candidates.json'),
    fetchReport: path.join(dir, 'fetch-report.json'),
    stage1: path.join(dir, 'stage1.json'),
    dedupHints: path.join(dir, 'dedup-hints.json'),
    decisions: path.join(dir, 'decisions.json'),
  };
}

/** pipeline/logs/YYYY/MM/<run_id>.jsonl */
export function runLogPath(logsDir, runId) {
  return path.join(logsDir, runId.slice(0, 4), runId.slice(5, 7), `${runId}.jsonl`);
}
