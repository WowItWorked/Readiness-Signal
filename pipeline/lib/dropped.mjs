// The Dropped page's data (owner request 2026-10-21): in-domain stories the filter judged and
// dropped, each with its reason, compiled from the live run logs (pipeline/logs/YYYY/MM/*.jsonl)
// and the backfill audit logs (pipeline/logs/backfill/*.jsonl) into docs/data/dropped.json.
// Derived and rebuilt whole every time: the logs stay the record, this file is a view of them.
//
// Rules:
//   - drops only; noise codes (off-domain, marketing, stale reposts, round-ups, advocacy, out of a
//     backfill window or its sections, never judged) and same-story drops are left out;
//   - cluster members fold into their lead, which counts them;
//   - a story whose URL is a source of a published item is left out (it was published later);
//   - one row per story URL: a backfill judgment (a re-judge under a later FILTER.md) replaces a
//     live one, and within a log a later row replaces an earlier one (--rejudge appends);
//   - a headline that names a financial institution is withheld (CLAUDE.md: nothing on the site
//     may state or imply an institution's position); the outlet and link remain.

import path from 'node:path';
import fs from 'node:fs';
import { findInstitutions } from './institutions.mjs';
import { listFiles, readJsonl } from './io.mjs';
import { normaliseUrl } from './url.mjs';

export const DROPPED_SCHEMA_VERSION = 1;

/** Drops that say nothing about the bar for an in-domain story (owner choice: in-domain only). */
export const NOISE_CODES = Object.freeze([
  'GL_OFF_DOMAIN', 'GL_MARKETING', 'GL_STALE', 'GL_NO_DEVELOPMENT', 'GL_ADVOCACY', 'GL_NOT_JUDGED',
  'BF_OUT_OF_WINDOW', 'BF_SECTION_EXCLUDED', 'DD_SAME_STORY',
]);

const BF_LABELS = Object.freeze({
  BF_URL_UNVERIFIED: 'the source could not be verified live',
});

/** Plain-language reason per code, from the last column of FILTER.md §8.2. */
export function codeLabels(filterText) {
  const out = { ...BF_LABELS };
  for (const line of String(filterText ?? '').split('\n')) {
    const m = /^\|\s*`([A-Z][A-Z0-9_]{1,47})`\s*\|\s*drop\s*\|/.exec(line);
    if (!m) continue;
    const cells = line.split('|').map((c) => c.trim());
    const label = cells[cells.length - 2];
    if (label) out[m[1]] = label.replace(/\s*\(§[^)]*\)/g, '').replace(/`/g, '');
  }
  return out;
}

const isCluster = (r) => r.dedup === 'cluster_merged' || /^cluster member of /.test(String(r.reason ?? ''));
const dateOfRun = (runId) => (/^(\d{4}-\d{2}-\d{2})/.exec(String(runId ?? '')) || [])[1] ?? null;

/** Rows of one log file with their origin: { rows, judged: 'live'|'backfill', key } */
function readLog(file, logsDir) {
  const rel = path.relative(logsDir, file).split(path.sep);
  const judged = rel[0] === 'backfill' ? 'backfill' : 'live';
  return { rows: readJsonl(file), judged, key: path.basename(file, '.jsonl') };
}

/**
 * Build the dropped.json document. `logs` is [{ rows, judged, key }] in chronological order
 * (live logs, then backfill logs: the re-judge passes postdate the live runs they replace).
 */
export function buildDropped({ logs, archive, filterText }) {
  const labels = codeLabels(filterText);
  const published = new Set();
  for (const it of Array.isArray(archive?.items) ? archive.items : []) {
    for (const s of Array.isArray(it.sources) ? it.sources : []) if (s?.url) published.add(normaliseUrl(s.url));
  }
  const byUrl = new Map();
  for (const { rows, judged, key } of logs) {
    const members = new Map();
    for (const r of rows) {
      if (r.judged === false || !r.verdict) continue;
      if (isCluster(r) && r.match_id) members.set(r.match_id, (members.get(r.match_id) ?? 0) + 1);
    }
    for (const r of rows) {
      if (r.judged === false || !r.verdict || !r.url) continue;
      const url = normaliseUrl(r.url);
      if (isCluster(r)) {
        // a cluster member never stands alone; a later judgment of it still replaces an earlier one
        byUrl.delete(url);
        continue;
      }
      if (r.verdict !== 'drop' || NOISE_CODES.includes(r.reason_code)) {
        byUrl.delete(url);
        continue;
      }
      const withheld = findInstitutions(r.headline).length > 0;
      const more = members.get(r.candidate_id) ?? 0;
      // optional fields appear only when they say something (keeps the file small)
      byUrl.set(url, {
        id: r.candidate_id,
        date: judged === 'backfill' ? String(r.published ?? '').slice(0, 10) || null : dateOfRun(r.run_id),
        section: r.section_tested ?? null,
        code: r.reason_code,
        reason: r.reason,
        publication: r.publication ?? null,
        headline: withheld ? null : (r.headline ?? null),
        ...(withheld ? { headline_withheld: true } : {}),
        url: r.url,
        ...(more ? { more_sources: more } : {}),
        judged,
        run: judged === 'backfill' ? key : r.run_id,
        ...(r.rejudged === true ? { rejudged: true } : {}),
      });
    }
  }
  const items = [...byUrl.entries()]
    .filter(([url]) => !published.has(url))
    .map(([, v]) => v)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)));
  const usedCodes = [...new Set(items.map((i) => i.code))].sort();
  return {
    schema_version: DROPPED_SCHEMA_VERSION,
    note: 'Derived from pipeline/logs by pipeline/scripts/dropped.mjs; rebuilt whole after every publish. The logs are the record.',
    codes: Object.fromEntries(usedCodes.map((c) => [c, labels[c] ?? c])),
    items,
  };
}

/** Read every log under logsDir in chronological order (live first, then backfill). */
export function readAllLogs(logsDir) {
  const files = listFiles(logsDir, (p) => p.endsWith('.jsonl'));
  const live = files.filter((f) => !path.relative(logsDir, f).startsWith(`backfill${path.sep}`));
  const backfill = files.filter((f) => path.relative(logsDir, f).startsWith(`backfill${path.sep}`));
  return [...live, ...backfill].map((f) => readLog(f, logsDir));
}

export const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
