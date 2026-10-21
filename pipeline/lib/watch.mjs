// The Global watch page's data (owner decision 2026-10-21, FILTER.md §4.4.6): regulatory signals
// from the other G20 jurisdictions, Singapore and Hong Kong that held every RT element and were
// recorded as RT_GLOBAL_WATCH, compiled from the live run logs and the backfill audit logs into
// docs/data/watch.json. They are never archive items. Derived and rebuilt whole every time, like
// the Dropped page (pipeline/lib/dropped.mjs), whose log reading and folding rules it shares:
//   - cluster members fold into their lead, which counts them;
//   - one row per story URL: a later judgment replaces an earlier one, and a later judgment that
//     is not RT_GLOBAL_WATCH removes it;
//   - a headline that names a financial institution is withheld; the outlet and link remain.

import { findInstitutions } from './institutions.mjs';
import { normaliseUrl } from './url.mjs';
import { WATCH_JURISDICTIONS } from './enums.mjs';
import { watchJurisdictionOf } from './validate.mjs';
import { dateOfRun, isCluster } from './dropped.mjs';

export const WATCH_SCHEMA_VERSION = 1;
export const WATCH_CODE = 'RT_GLOBAL_WATCH';

/** Build the watch.json document from logs in chronological order ([{ rows, judged, key }]). */
export function buildWatch({ logs }) {
  const byUrl = new Map();
  for (const { rows, judged, key } of logs) {
    const members = new Map();
    for (const r of rows) {
      if (r.judged !== false && r.verdict && isCluster(r) && r.match_id) members.set(r.match_id, (members.get(r.match_id) ?? 0) + 1);
    }
    for (const r of rows) {
      if (r.judged === false || !r.verdict || !r.url) continue;
      const url = normaliseUrl(r.url);
      const jurisdiction = r.reason_code === WATCH_CODE ? watchJurisdictionOf(r.reason) : null;
      if (isCluster(r) || !jurisdiction) {
        byUrl.delete(url);
        continue;
      }
      const withheld = findInstitutions(r.headline).length > 0;
      const more = members.get(r.candidate_id) ?? 0;
      byUrl.set(url, {
        id: r.candidate_id,
        date: judged === 'backfill' ? String(r.published ?? '').slice(0, 10) || null : dateOfRun(r.run_id),
        jurisdiction,
        signal: String(r.reason).slice(jurisdiction.length + 2),
        publication: r.publication ?? null,
        headline: withheld ? null : (r.headline ?? null),
        ...(withheld ? { headline_withheld: true } : {}),
        url: r.url,
        ...(more ? { more_sources: more } : {}),
        judged,
        run: judged === 'backfill' ? key : r.run_id,
      });
    }
  }
  const items = [...byUrl.values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)));
  const present = new Set(items.map((i) => i.jurisdiction));
  return {
    schema_version: WATCH_SCHEMA_VERSION,
    note: 'Derived from pipeline/logs by pipeline/scripts/watch.mjs; rebuilt whole after every publish. The logs are the record. Global watch signals are never archive items.',
    jurisdictions: WATCH_JURISDICTIONS.filter((j) => present.has(j)),
    items,
  };
}
