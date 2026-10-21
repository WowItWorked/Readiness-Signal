// The Dropped page's data (pipeline/lib/dropped.mjs): which drops are listed, how clusters and
// re-judges fold, and that headlines naming a financial institution are withheld.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildDropped, codeLabels, NOISE_CODES } from '../../pipeline/lib/dropped.mjs';
import { ROOT } from './_helpers.mjs';

const FILTER = fs.readFileSync(path.join(ROOT, 'pipeline', 'FILTER.md'), 'utf8');

const row = (over) => ({
  run_id: '2026-10-13-1400', candidate_id: 'c-aaaaaaaaaa', url: 'https://example.com/a', publication: 'Example',
  headline: 'A vendor patches an exploited flaw', section_tested: 'capability_shift', verdict: 'drop',
  reason_code: 'CS_ROUTINE_VULN', reason: 'C6: patched flaw; no exception', dedup: 'new', match_id: null, ...over,
});

test('codeLabels reads FILTER.md §8.2 drop codes', () => {
  const l = codeLabels(FILTER);
  assert.equal(l.CS_ROUTINE_VULN, 'vulnerability without an exception');
  assert.ok(l.EV_BELOW_FLOOR && l.RT_NO_DIRECTION && l.BF_URL_UNVERIFIED);
  assert.ok(!('CS_PASS_CONTROL_FAILURE' in l), 'pass codes are not drop labels');
});

test('in-domain drops only; noise and same-story drops left out; clusters fold into their lead', () => {
  const live = [
    row({}),
    row({ candidate_id: 'c-bbbbbbbbbb', url: 'https://example.com/b', reason: 'cluster member of c-aaaaaaaaaa', dedup: 'cluster_merged', match_id: 'c-aaaaaaaaaa' }),
    row({ candidate_id: 'c-cccccccccc', url: 'https://example.com/c', section_tested: null, reason_code: 'GL_OFF_DOMAIN', reason: 'G1 off-domain' }),
    row({ candidate_id: 'c-dddddddddd', url: 'https://example.com/d', reason_code: 'DD_SAME_STORY', dedup: 'same_story_dropped', match_id: 'RS-261001-0600-01' }),
    row({ candidate_id: 'c-eeeeeeeeee', url: 'https://example.com/e', verdict: 'pass', reason_code: 'CS_PASS_CONTROL_FAILURE' }),
  ];
  const doc = buildDropped({ logs: [{ rows: live, judged: 'live', key: '2026-10-13-1400' }], archive: { items: [] }, filterText: FILTER });
  assert.deepEqual(doc.items.map((i) => i.id), ['c-aaaaaaaaaa']);
  const [a] = doc.items;
  assert.equal(a.more_sources, 1);
  assert.equal(a.date, '2026-10-13');
  assert.equal(a.judged, 'live');
  assert.equal(doc.codes.CS_ROUTINE_VULN, 'vulnerability without an exception');
  for (const c of ['GL_OFF_DOMAIN', 'GL_MARKETING', 'GL_STALE', 'GL_NO_DEVELOPMENT', 'DD_SAME_STORY']) assert.ok(NOISE_CODES.includes(c), c);
});

test('a later judgment of the same URL replaces an earlier one; a later publication removes it', () => {
  const live = [row({})];
  const rejudgedDrop = [{ ...row({ reason_code: 'EV_BELOW_FLOOR', section_tested: 'executive_visibility', reason: 'E2 no limb' }), published: '2026-10-13', rejudged: true }];
  const twice = buildDropped({ logs: [{ rows: live, judged: 'live', key: 'x' }, { rows: rejudgedDrop, judged: 'backfill', key: '2026-10-13' }], archive: { items: [] }, filterText: FILTER });
  assert.equal(twice.items.length, 1);
  assert.equal(twice.items[0].code, 'EV_BELOW_FLOOR');
  assert.equal(twice.items[0].judged, 'backfill');
  assert.equal(twice.items[0].rejudged, true);
  const rejudgedPass = [{ ...row({ verdict: 'pass', reason_code: 'CS_PASS_CONTROL_FAILURE' }), published: '2026-10-13' }];
  const passed = buildDropped({ logs: [{ rows: live, judged: 'live', key: 'x' }, { rows: rejudgedPass, judged: 'backfill', key: '2026-10-13' }], archive: { items: [] }, filterText: FILTER });
  assert.equal(passed.items.length, 0, 'a re-judge that passed removes the drop');
  const published = buildDropped({ logs: [{ rows: live, judged: 'live', key: 'x' }], archive: { items: [{ sources: [{ url: 'https://example.com/a/?utm_source=feed' }] }] }, filterText: FILTER });
  assert.equal(published.items.length, 0, 'a story whose URL is an item source is left out');
});

test('a headline naming a financial institution is withheld; the outlet and link stay', () => {
  const doc = buildDropped({
    logs: [{ rows: [row({ headline: 'JPMorgan Chase blocks outside AI agents', section_tested: 'regulatory_trajectory', reason_code: 'RT_NO_DIRECTION', reason: 'R3: general warning' })], judged: 'live', key: 'x' }],
    archive: { items: [] },
    filterText: FILTER,
  });
  const [i] = doc.items;
  assert.equal(i.headline, null);
  assert.equal(i.headline_withheld, true);
  assert.equal(i.publication, 'Example');
  assert.equal(i.url, 'https://example.com/a');
});

test('the published dropped.json is current with the logs', () => {
  const file = path.join(ROOT, 'docs', 'data', 'dropped.json');
  if (!fs.existsSync(file)) return;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.schema_version, 1);
  assert.ok(Array.isArray(doc.items) && doc.items.every((i) => i.code && i.reason && i.url));
  assert.ok(doc.items.every((i) => !NOISE_CODES.includes(i.code)));
});
