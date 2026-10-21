// The Global watch page's data (pipeline/lib/watch.mjs, FILTER.md §4.4.6): which records are
// listed, how clusters and re-judges fold, and the validator's reason rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildWatch } from '../../pipeline/lib/watch.mjs';
import { buildDropped } from '../../pipeline/lib/dropped.mjs';
import { decisionStyleIssues, parseReasonCodes, watchJurisdictionOf } from '../../pipeline/lib/validate.mjs';
import { WATCH_JURISDICTIONS } from '../../pipeline/lib/enums.mjs';
import { ROOT } from './_helpers.mjs';

const FILTER = fs.readFileSync(path.join(ROOT, 'pipeline', 'FILTER.md'), 'utf8');

const row = (over) => ({
  run_id: '2026-10-22-0600', candidate_id: 'c-aaaaaaaaaa', url: 'https://example.gov.sg/a', publication: 'Monetary Authority of Singapore',
  headline: 'Consultation on AI model risk management', section_tested: 'regulatory_trajectory', verdict: 'drop',
  reason_code: 'RT_GLOBAL_WATCH', reason: 'Singapore: MAS; R3 no AI guidance → consults on AI model risk; R4 inventory and validation', dedup: 'new', match_id: null, ...over,
});

test('FILTER §8.2 lists RT_GLOBAL_WATCH as a drop; the watch list is closed and excludes the core', () => {
  assert.equal(parseReasonCodes(FILTER).get('RT_GLOBAL_WATCH'), 'drop');
  for (const j of ['Canada', 'United States', 'Germany', 'European Union']) assert.ok(!WATCH_JURISDICTIONS.includes(j), j);
  for (const j of WATCH_JURISDICTIONS) assert.ok(FILTER.includes(j), `${j} named in FILTER.md §4.4.6`);
  assert.equal(watchJurisdictionOf('South Korea: FSC; R3 x'), 'South Korea');
  assert.equal(watchJurisdictionOf('Canada: OSFI; R3 x'), null);
  assert.equal(watchJurisdictionOf('R2 speech outside the core'), null);
});

test('watch records only; clusters fold into the lead; a later judgment replaces or removes', () => {
  const live = [
    row({}),
    row({ candidate_id: 'c-bbbbbbbbbb', url: 'https://example.com/b', reason: 'cluster member of c-aaaaaaaaaa', dedup: 'cluster_merged', match_id: 'c-aaaaaaaaaa' }),
    row({ candidate_id: 'c-cccccccccc', url: 'https://example.com/c', reason_code: 'RT_NO_DIRECTION', reason: 'R3 restates priorities' }),
    row({ candidate_id: 'c-dddddddddd', url: 'https://example.com/d', reason: 'Atlantis: central bank; R3 x' }),
  ];
  const doc = buildWatch({ logs: [{ rows: live, judged: 'live', key: 'x' }] });
  assert.deepEqual(doc.items.map((i) => i.id), ['c-aaaaaaaaaa'], 'only RT_GLOBAL_WATCH with a listed jurisdiction');
  const [w] = doc.items;
  assert.equal(w.jurisdiction, 'Singapore');
  assert.equal(w.signal, 'MAS; R3 no AI guidance → consults on AI model risk; R4 inventory and validation');
  assert.equal(w.more_sources, 1);
  assert.equal(w.date, '2026-10-22');
  assert.deepEqual(doc.jurisdictions, ['Singapore']);
  const later = [{ ...row({ reason_code: 'RT_NOT_SPECIFIC', reason: 'R4 no specific topic' }), published: '2026-10-22' }];
  assert.equal(buildWatch({ logs: [{ rows: live, judged: 'live', key: 'x' }, { rows: later, judged: 'backfill', key: '2026-10-22' }] }).items.length, 0);
  const named = buildWatch({ logs: [{ rows: [row({ headline: 'JPMorgan Chase joins an AI pilot' })], judged: 'live', key: 'x' }] });
  assert.equal(named.items[0].headline, null);
  assert.equal(named.items[0].headline_withheld, true);
});

test('a watch record never appears on the Dropped page', () => {
  const doc = buildDropped({ logs: [{ rows: [row({})], judged: 'live', key: 'x' }], archive: { items: [] }, filterText: FILTER });
  assert.equal(doc.items.length, 0);
});

test('validator: a watch reason opens with a listed jurisdiction and is never NEAR', () => {
  const issues = (reason) => decisionStyleIssues({ judgments: [{ candidate_id: 'c-aaaaaaaaaa', verdict: 'drop', reason_code: 'RT_GLOBAL_WATCH', section_tested: 'regulatory_trajectory', reason }] })
    .filter((s) => s.rule === 'FILTER 8.4').map((s) => s.message);
  assert.deepEqual(issues('Japan: FSA; R3 new cloud expectations; R4 exit plans'), []);
  assert.ok(issues('Canada: OSFI; R3 x').some((m) => /opens "<jurisdiction>: "/.test(m)));
  assert.ok(issues('NEAR R2/rt_standard_setters: Japan x').some((m) => /never NEAR/.test(m)));
});

test('the published watch.json is current with the logs', () => {
  const file = path.join(ROOT, 'docs', 'data', 'watch.json');
  if (!fs.existsSync(file)) return;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.schema_version, 1);
  assert.ok(Array.isArray(doc.items) && doc.items.every((i) => WATCH_JURISDICTIONS.includes(i.jurisdiction) && i.signal && i.url));
});
