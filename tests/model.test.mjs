// Site model tests (docs/assets/model.js). Clock pinned to the fixture reference time
// (tests/fixtures/README.md): Fri 2 Oct 2026, 15:00 ET.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../docs/assets/model.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const RAW_ARCHIVE = fixture('archive.json');
const RAW_RUNS = fixture('runs.json');
const NOW = new Date('2026-10-02T15:00:00-04:00');
const DAY = 864e5;
const data = M.prepare(RAW_ARCHIVE, RAW_RUNS);
const empty = M.prepare({ schema_version: 1, items: [] }, { schema_version: 1, runs: [] });
const ui = (patch = {}) => ({ ...M.defaultUi(NOW), ...patch });

// A minimal valid item for synthetic cases.
function item(over = {}) {
  return {
    id: 'RS-261001-1800-09',
    timestamp: '2026-10-01T18:00:00-04:00',
    section: 'capability_shift',
    claim: 'A synthetic claim used only by the site model tests here.',
    domains: ['cyber'],
    source_class: 'news',
    mechanism: 'candidate_issue',
    interpretation: [{ domain: 'cyber', text: 'Synthetic read-across.' }],
    validation_question: 'Is the synthetic control tested?',
    candidate_issue_statement: 'Where the synthetic control is untested, failures may go unseen.',
    awareness_rationale: null,
    sources: [{ publication: 'Example News', url: 'https://example.com/a', headline: 'Synthetic headline', published: '2026-10-01' }],
    backfilled: false,
    update_of: null,
    ...over,
  };
}

describe('ET formatting', () => {
  test('formats in America/New_York regardless of the host zone', () => {
    assert.equal(M.fmtFull('2026-10-02T14:00:00-04:00'), 'Fri 2 Oct 2026, 14:00 ET');
    assert.equal(M.fmtFull('2026-10-02T18:00:00Z'), 'Fri 2 Oct 2026, 14:00 ET');
    assert.equal(M.fmtFull('2026-01-15T10:00:00-05:00'), 'Thu 15 Jan 2026, 10:00 ET');
    assert.equal(M.hm('2026-10-02T04:05:00Z'), '00:05');
    assert.equal(M.dShort('2026-10-03T03:30:00Z'), 'Fri 2 Oct');
    assert.equal(M.fmtDate('2026-01-15T10:00:00-05:00'), '15 Jan 2026');
  });

  test('DST: last EST slot and first EDT slot (fixtures)', () => {
    const est = data.byId.get('RS-260305-1800-01');
    const edt = data.byId.get('RS-260308-0600-01');
    assert.equal(M.fmtFull(est.date), 'Thu 5 Mar 2026, 18:00 ET');
    assert.equal(M.fmtFull(edt.date), 'Sun 8 Mar 2026, 06:00 ET');
    assert.equal(M.etOffsetMinutes(est.date), -300);
    assert.equal(M.etOffsetMinutes(edt.date), -240);
  });

  test('DST boundaries: spring forward and fall back', () => {
    assert.equal(M.hm('2026-03-08T06:59:00Z'), '01:59'); // EST
    assert.equal(M.hm('2026-03-08T07:00:00Z'), '03:00'); // EDT
    assert.equal(M.hm('2026-11-01T05:59:00Z'), '01:59'); // EDT
    assert.equal(M.hm('2026-11-01T06:00:00Z'), '01:00'); // EST again
    assert.equal(M.etWallToDate(2026, 3, 8, 6).toISOString(), '2026-03-08T10:00:00.000Z');
    assert.equal(M.etWallToDate(2026, 3, 7, 18).toISOString(), '2026-03-07T23:00:00.000Z');
    assert.equal(M.etWallToDate(2026, 11, 1, 6).toISOString(), '2026-11-01T11:00:00.000Z');
    assert.equal(M.etWallToDate(2026, 10, 32).toISOString(), '2026-11-01T04:00:00.000Z'); // overflow normalised
  });

  test('calendar keys use the ET date, not UTC', () => {
    assert.equal(M.etDateKey('2026-10-02T03:30:00Z'), '2026-10-01');
    assert.equal(M.monthKey('2026-10-01T03:30:00Z'), '2026-09');
    assert.equal(M.monthKey('2026-11-01T03:30:00Z'), '2026-10');
    assert.equal(M.monthName('2026-09'), 'September 2026');
    assert.equal(M.fmtDayMonth('2026-08-01'), '1 Aug');
  });

  test('whenShort: weekday inside six days, date beyond', () => {
    assert.equal(M.whenShort(new Date('2026-09-30T14:00:00-04:00'), NOW), 'Wed 14:00');
    assert.equal(M.whenShort(new Date('2026-09-26T18:00:00-04:00'), NOW), 'Sat 18:00');
    assert.equal(M.whenShort(new Date('2026-09-21T10:00:00-04:00'), NOW), '21 Sep, 10:00');
  });
});

describe('data preparation', () => {
  test('loads every fixture item and run, newest first', () => {
    assert.equal(data.items.length, 32);
    assert.equal(data.runs.length, 69);
    assert.equal(data.items[0].ts >= data.items[1].ts, true);
    assert.equal(data.items.at(-1).id, 'RS-260115-1000-01');
    assert.equal(data.earliest.toISOString(), new Date('2026-01-15T10:00:00-05:00').toISOString());
  });

  test('source classes: union of item and per-source classes, item first', () => {
    assert.deepEqual(data.byId.get('RS-260819-0600-01').classes, ['vendor_threat_research', 'news', 'regulator']);
    assert.deepEqual(data.byId.get('RS-261002-1400-04').classes, ['vendor_threat_research', 'industry_trade']);
  });

  test('throws on the wrong top-level shape', () => {
    assert.throws(() => M.prepare(null, RAW_RUNS));
    assert.throws(() => M.prepare({ items: {} }, RAW_RUNS));
    assert.throws(() => M.prepare(RAW_ARCHIVE, { runs: 'x' }));
  });

  test('drops malformed or unsafe records rather than rendering them', () => {
    const d = M.prepare({
      items: [
        item(),
        item({ id: '<script>' }),
        item({ id: 'RS-261001-1800-10', timestamp: 'yesterday' }),
        item({ id: 'RS-261001-1800-11', section: 'gossip' }),
        item({ id: 'RS-261001-1800-12', mechanism: 'panic' }),
        item({ id: 'RS-261001-1800-09' }), // duplicate id
        'not an object',
      ],
    }, { runs: [{ slot: 'nope' }, { slot: '2026-10-01T18:00:00-04:00', status: 'weird', items: [1, 'x'] }] });
    assert.deepEqual(d.items.map((i) => i.id), ['RS-261001-1800-09']);
    assert.equal(d.runs.length, 1);
    assert.equal(d.runs[0].status, 'failed');
    assert.deepEqual(d.runs[0].items, ['x']);
  });
});

describe('report windows', () => {
  const count = (span) => data.items.filter((i) => M.inRange(i, M.reportRange(span, NOW))).length;

  test('24 h / 7 d / 30 d with injected now', () => {
    assert.equal(count('day'), 7);
    assert.equal(count('week'), 13);
    assert.equal(count('month'), 22);
  });

  test('lower bound is inclusive; items after now still count (viewer clock behind)', () => {
    const d = M.prepare({
      items: [
        item({ id: 'RS-261001-1500-01', timestamp: '2026-10-01T15:00:00-04:00' }),
        item({ id: 'RS-261001-1459-01', timestamp: '2026-10-01T14:59:59-04:00' }),
        item({ id: 'RS-261002-1800-01', timestamp: '2026-10-02T18:00:00-04:00' }),
      ],
    }, { runs: [] });
    const ids = d.items.filter((i) => M.inRange(i, M.reportRange('day', NOW))).map((i) => i.id);
    assert.deepEqual(ids.sort(), ['RS-261001-1500-01', 'RS-261002-1800-01']);
  });

  test('list model: sections, empty states and "last published"', () => {
    const lm = M.listModel(data, ui({ page: 'report', repTime: 'day' }), NOW);
    assert.equal(lm.shown.length, 7);
    assert.deepEqual(lm.groups.map((g) => g.items.length), [3, 4, 0]);
    const s3 = lm.groups[2];
    assert.equal(s3.countLabel, 'None published');
    assert.equal(s3.empty.title, 'Nothing cleared the bar in the last 24 hours.');
    assert.match(s3.empty.body, /The entry test was applied in 4 runs\.$/);
    assert.equal(s3.empty.last.item.id, 'RS-261001-0600-01');
    assert.equal(s3.empty.last.mech, 'Awareness only');
  });

  test('section filter shows only the chosen sections', () => {
    const lm = M.listModel(data, ui({ page: 'report', repTime: 'week', secs: ['executive_visibility'] }), NOW);
    assert.deepEqual(lm.groups.map((g) => g.key), ['executive_visibility']);
    assert.equal(lm.shown.length, 5);
  });

  test('hidden-by-filter empty state offers to clear domain and source filters', () => {
    const lm = M.listModel(data, ui({ page: 'report', repTime: 'day', doms: ['risk_quantification'] }), NOW);
    const s1 = lm.groups[0];
    assert.equal(s1.items.length, 0);
    assert.equal(s1.empty.title, 'Nothing here matches your filters.');
    assert.equal(s1.empty.body, '3 items in this section sit outside your domain or source selection.');
    assert.equal(s1.empty.hasHidden, true);
    assert.equal(s1.empty.last, null);
  });
});

describe('archive ranges', () => {
  const ids = (u) => M.listModel(data, ui({ page: 'archive', ...u }), NOW).shown.map((i) => i.id);

  test('all time, month and custom', () => {
    assert.equal(ids({ archTime: 'all' }).length, 32);
    assert.equal(ids({ archTime: 'm-2026-09' }).length, 14);
    assert.deepEqual(ids({ archTime: 'm-2026-03' }).sort(), ['RS-260305-1800-01', 'RS-260308-0600-01']);
    assert.deepEqual(ids({ archTime: 'custom', from: '2026-10-02', to: '2026-10-02' }).sort(), [
      'RS-261002-0600-01', 'RS-261002-1000-01', 'RS-261002-1400-01', 'RS-261002-1400-02', 'RS-261002-1400-03', 'RS-261002-1400-04',
    ]);
    // reversed bounds are treated as the same range
    assert.equal(ids({ archTime: 'custom', from: '2026-10-02', to: '2026-10-01' }).length,
      ids({ archTime: 'custom', from: '2026-10-01', to: '2026-10-02' }).length);
  });

  test('custom range and months follow ET calendar days across UTC midnight', () => {
    const d = M.prepare({
      items: [
        item({ id: 'RS-261001-2330-01', timestamp: '2026-10-01T23:30:00-04:00' }), // 03:30Z on 2 Oct
        item({ id: 'RS-260930-2330-01', timestamp: '2026-09-30T23:30:00-04:00' }), // 03:30Z on 1 Oct
      ],
    }, { runs: [] });
    const r = M.archiveRange({ archTime: 'custom', from: '2026-10-01', to: '2026-10-01' }, NOW);
    assert.deepEqual(d.items.filter((i) => M.inRange(i, r)).map((i) => i.id), ['RS-261001-2330-01']);
    const sep = M.archiveRange({ archTime: 'm-2026-09' }, NOW);
    assert.deepEqual(d.items.filter((i) => M.inRange(i, sep)).map((i) => i.id), ['RS-260930-2330-01']);
    assert.deepEqual(d.months, ['2026-10', '2026-09']);
  });

  test('month grouping in ET, newest month first', () => {
    const lm = M.listModel(data, ui({ page: 'archive' }), NOW);
    assert.deepEqual(lm.groups.map((g) => g.title), [
      'October 2026', 'September 2026', 'August 2026', 'July 2026', 'June 2026', 'May 2026', 'April 2026',
      'March 2026', 'February 2026', 'January 2026',
    ]);
    assert.deepEqual(lm.groups.map((g) => g.items.length), [8, 14, 1, 2, 1, 1, 1, 2, 1, 1]);
    assert.equal(lm.sub, '32 items · all time · since 15 Jan 2026');
  });

  test('search covers claim, domain labels, publications and headlines', () => {
    assert.deepEqual(ids({ q: 'cloud' }).sort(), ['RS-260925-1000-01', 'RS-261002-1400-01']);
    assert.ok(ids({ q: 'EXAMPLE GAZETTE' }).includes('RS-261002-1400-01')); // publication
    assert.ok(ids({ q: 'failover plans missed' }).includes('RS-261002-1400-01')); // headline
    assert.equal(ids({ q: 'risk quantification' }).length,
      data.items.filter((i) => i.domains.includes('risk_quantification')).length);
    assert.ok(ids({ q: "banks' mobile" }).includes('RS-261002-1400-01')); // straight quote matches ’
    assert.equal(ids({ q: 'zzzz-no-match' }).length, 0);
  });

  test('custom range label adds years only when they differ', () => {
    assert.equal(M.rangeLabel({ page: 'archive', archTime: 'custom', from: '2026-08-01', to: '2026-10-02' }), '1 Aug – 2 Oct');
    assert.equal(M.rangeLabel({ page: 'archive', archTime: 'custom', from: '2025-09-03', to: '2026-10-02' }), '3 Sep 2025 – 2 Oct 2026');
  });
});

describe('filters and option counts', () => {
  test('predicates: empty selection passes everything; multi-select is OR within a filter', () => {
    const p = M.predicates({ secs: [], doms: ['fraud', 'ai'], srcs: [] });
    const it = data.byId.get('RS-261002-1400-04'); // fraud, ai, data
    assert.equal(p.allOK(it), true);
    assert.equal(M.predicates({ secs: [], doms: ['resilience'], srcs: [] }).allOK(it), false);
    assert.equal(M.predicates({ secs: [], doms: [], srcs: ['industry_trade'] }).allOK(it), true); // per-source class
  });

  test('per-option counts apply the other filters, not their own', () => {
    const lm = M.listModel(data, ui({ page: 'report', repTime: 'week', doms: ['fraud'] }), NOW);
    const opts = Object.fromEntries(lm.filters.map((f) => [f.key, f.opts]));
    const n = (key, v) => opts[key].find((o) => o.value === v).n;
    assert.equal(n('domain', 'fraud'), 5);
    assert.equal(n('section', 'executive_visibility'), 2);
    assert.equal(n('section', 'capability_shift'), 3);
    assert.equal(n('section', 'regulatory_trajectory'), 0);
    assert.equal(opts.section[0].n, ''); // "All sections" carries no count
    assert.deepEqual(opts.time.map((o) => [o.value, o.n, o.sel]), [['day', 4, false], ['week', 5, true], ['month', 7, false]]);
    assert.equal(lm.filters.find((f) => f.key === 'domain').value, 'Fraud');
    assert.equal(lm.filters.find((f) => f.key === 'time').active, true);
    assert.equal(lm.hasActive, true);
  });

  test('source option counts use the union of classes', () => {
    const lm = M.listModel(data, ui({ page: 'report', repTime: 'week' }), NOW);
    const src = lm.filters.find((f) => f.key === 'source').opts;
    assert.equal(src.find((o) => o.value === 'regulator').n, 4);
  });

  test('archive time options list months with counts and a custom range', () => {
    const lm = M.listModel(data, ui({ page: 'archive' }), NOW);
    const t = lm.filters[0].opts;
    assert.deepEqual(t[0], { value: 'all', label: 'All time', n: 32, sel: true, rule: false });
    assert.equal(t.find((o) => o.value === 'm-2026-09').n, 14);
    assert.deepEqual(t.at(-1), { value: 'custom', label: 'Custom range', n: '', sel: false, rule: true });
  });

  test('multi-select value label and export summary', () => {
    const lm = M.listModel(data, ui({ page: 'report', doms: ['fraud', 'ai'], srcs: ['regulator'] }), NOW);
    assert.equal(lm.filters.find((f) => f.key === 'domain').value, '2 selected');
    assert.equal(lm.selSummary, `Last 24 hours · All sections · Fraud, AI · Regulator — ${M.plural(lm.shown.length, 'item')}`);
  });
});

describe('permalink reveal', () => {
  test('window by age: day, week, month, archive', () => {
    const w = (id) => {
      const p = M.revealPatch(data, id, ui(), NOW);
      return [p.page, p.repTime || p.archTime];
    };
    assert.deepEqual(w('RS-261001-1800-01'), ['report', 'day']); // 0.9 d
    assert.deepEqual(w('RS-260926-1800-01'), ['report', 'week']); // 5.9 d
    assert.deepEqual(w('RS-260921-1000-01'), ['report', 'month']); // 11.2 d
    assert.deepEqual(w('RS-260819-0600-01'), ['archive', 'all']);
    assert.equal(M.revealPatch(data, 'RS-000000-0000-01', ui(), NOW), null);
  });

  test('clears only the filters that would hide it, and expands it', () => {
    const start = ui({ secs: ['capability_shift'], doms: ['ai'], srcs: ['vendor_threat_research'], open: { x: true } });
    const p = M.revealPatch(data, 'RS-260921-1000-01', start, NOW);
    assert.equal(p.secs, undefined); // same section: kept
    assert.deepEqual(p.doms, []); // no AI domain: cleared
    assert.equal(p.srcs, undefined); // has a vendor/threat research source: kept
    assert.deepEqual(p.open, { x: true, 'RS-260921-1000-01': true });
    const q = M.revealPatch(data, 'RS-260115-1000-01', ui({ q: 'nothing like it' }), NOW);
    assert.equal(q.q, '');
  });

  test('revealWindow edges', () => {
    assert.equal(M.revealWindow(DAY).repTime, 'day');
    assert.equal(M.revealWindow(DAY + 1).repTime, 'week');
    assert.equal(M.revealWindow(30 * DAY).repTime, 'month');
    assert.equal(M.revealWindow(30 * DAY + 1).page, 'archive');
    assert.equal(M.revealWindow(-5000).repTime, 'day');
  });

  test('hash parsing', () => {
    assert.deepEqual(M.parseHash(''), { page: 'dashboard' });
    assert.deepEqual(M.parseHash('#report'), { page: 'report' });
    assert.deepEqual(M.parseHash('#RS-261002-1400-01'), { id: 'RS-261002-1400-01' });
    assert.deepEqual(M.parseHash('#%3Cimg%20src%3Dx%3E'), { page: 'dashboard' });
    assert.deepEqual(M.parseHash('#%E0%A4%A'), { page: 'dashboard' }); // malformed escape
  });
});

describe('editions and runs', () => {
  test('latest edition comes from the latest published run', () => {
    const le = M.latestEdition(data);
    assert.equal(M.fmtFull(le.date), 'Fri 2 Oct 2026, 14:00 ET');
    assert.deepEqual(le.items.map((i) => i.id), ['RS-261002-1400-01', 'RS-261002-1400-03', 'RS-261002-1400-02', 'RS-261002-1400-04']);
    assert.equal(M.mastheadLatest(data), 'Fri 2 Oct 2026, 14:00 ET');
  });

  test('fallback without published runs: latest non-backfilled item', () => {
    const d = M.prepare({ items: [item(), item({ id: 'RS-261002-0600-07', timestamp: '2026-10-02T06:00:00-04:00', backfilled: true })] }, { runs: [] });
    assert.equal(M.latestEdition(d).items[0].id, 'RS-261001-1800-09');
  });

  test('"As of" is the latest run of any status', () => {
    assert.equal(M.fmtFull(M.asOf(data)), 'Fri 2 Oct 2026, 14:21 ET');
    const d = M.prepare({ items: [] }, { runs: [{ slot: '2026-10-02T06:00:00-04:00', status: 'silent', started_at: '2026-10-02T06:01:00-04:00', finished_at: '2026-10-02T06:09:00-04:00', items: [] }] });
    assert.equal(M.fmtFull(M.asOf(d)), 'Fri 2 Oct 2026, 06:09 ET');
    assert.equal(M.latestEdition(d), null);
    assert.equal(M.mastheadLatest(d), 'None yet');
  });

  test('run counts per window; silent and failed are not editions', () => {
    const rs = (span) => M.runStats(data, M.reportRange(span, NOW));
    assert.deepEqual(rs('day'), { total: 4, published: 4, silent: 0, failed: 0, applied: 4 });
    assert.deepEqual(rs('week'), { total: 28, published: 9, silent: 18, failed: 1, applied: 27 });
    assert.deepEqual(rs('month'), { total: 61, published: 17, silent: 42, failed: 2, applied: 59 });
    const lm = M.listModel(data, ui({ page: 'report', repTime: 'week' }), NOW);
    assert.equal(lm.sub, '13 items · last 7 days · from 9 of 28 runs, 18 silent, 1 failed');
  });

  test('backfilled items never count as editions', () => {
    const editionIds = new Set(data.runs.filter((r) => r.status === 'published').flatMap((r) => r.items));
    for (const it of data.items.filter((i) => i.backfilled)) assert.equal(editionIds.has(it.id), false);
    const jan = M.listModel(data, ui({ page: 'archive', archTime: 'm-2026-01' }), NOW);
    assert.deepEqual(jan.shown.map((i) => i.backfilled), [true]);
  });
});

describe('dashboard aggregates', () => {
  const d = M.dashboard(data, NOW);

  test('executive visibility, last 7 days, newest first', () => {
    assert.deepEqual(d.exec.map((e) => e.item.id), [
      'RS-261002-1400-01', 'RS-261002-1400-03', 'RS-261002-1000-01', 'RS-260930-1400-01', 'RS-260926-1800-01',
    ]);
    assert.equal(d.exec[0].when, 'Last update · 14:00');
    assert.equal(d.exec[0].isNew, true);
    assert.equal(d.exec[2].when, 'Fri 10:00');
    assert.equal(d.exec[2].isNew, false);
  });

  test('latest edition list and "As of"', () => {
    assert.equal(d.latest.title, 'Fri 2 Oct, 14:00 ET · 4 items');
    assert.deepEqual(d.latest.items.map((x) => x.secLabel), ['01 Executive Visibility', '01 Executive Visibility', '02 Capability & Control Shift', '02 Capability & Control Shift']);
    assert.equal(d.asOf, 'As of Fri 2 Oct 2026, 14:21 ET');
  });

  test('mechanism board: counts, Executive Visibility first, then newest', () => {
    assert.deepEqual(d.board.map((b) => [b.label, b.n]), [['Candidate issue', 4], ['KRI / KPI', 3], ['PRAF coverage', 3], ['Awareness only', 3]]);
    const ci = d.board[0].items.map((x) => x.item.section);
    assert.deepEqual(ci.slice(0, 2), ['executive_visibility', 'executive_visibility']);
    assert.match(d.board[0].items[0].meta, /^Fri 14:00 · Section 1$/);
    assert.equal(d.weekLink, 'All 13 items in the report');
  });

  test('section rows', () => {
    assert.deepEqual(d.secRows.map((r) => [r.count, r.last]), [
      [5, 'Last published Fri 2 Oct'], [6, 'Last published Fri 2 Oct'], [2, 'Last published Thu 1 Oct'],
    ]);
  });

  test('domain rows: Ask action = non-awareness count, dash for zero', () => {
    assert.deepEqual(d.domRows.map((r) => [r.label, r.n, r.act]), [
      ['Cyber', 9, 6], ['Fraud', 5, 4], ['AI', 5, 5], ['Data', 5, 3], ['Resilience', 5, 4], ['Third party', 5, 5], ['Risk quantification', 2, 1],
    ]);
    const wk = data.items.filter((i) => i.ts >= +NOW - 7 * DAY);
    for (const r of d.domRows) {
      const l = wk.filter((i) => i.domains.includes(r.key));
      assert.equal(r.act, l.filter((i) => i.mechanism !== 'awareness_only').length || '—');
    }
  });

  test('archive line', () => {
    assert.equal(d.archLine, '32 items published since 15 Jan 2026. Nothing is replaced; everything stays searchable.');
  });
});

describe('item detail and email', () => {
  test('detail strings', () => {
    const it = data.byId.get('RS-261002-1400-01');
    const d = M.itemDetail(it, data);
    assert.equal(d.corrob, 'Corroborated: 3 sources across 2 classes');
    assert.equal(d.srcClassLabel, 'News + Industry/trade');
    assert.equal(d.srcCount, '3 sources');
    assert.equal(d.asks, 'Send the validation question to the owner. If the answer is no or unknown, raise the candidate issue.');
    assert.equal(d.noRead, 'AI · Data · Risk quantification');
    assert.equal(d.sources[0].date, '2 Oct');
    const single = M.itemDetail(data.byId.get('RS-260926-1800-01'), data);
    assert.equal(single.corrob, 'Single source');
    const fincen = M.itemDetail(data.byId.get('RS-261002-1000-01'), data).sources.find((s) => s.pub === 'Example Reserve Board');
    assert.equal(fincen.date, '');
  });

  test('PRAF asks text follows the brief', () => {
    assert.equal(M.mechOf('praf_coverage').asks,
      'Confirm the risk assessment framework represents this risk at all. If it does not, the issue language applies.');
  });

  test('update_of resolves to the earlier claim', () => {
    const d = M.itemDetail(data.byId.get('RS-261002-1400-02'), data);
    assert.deepEqual(d.updateOf, { id: 'RS-260921-1000-01', claim: data.byId.get('RS-260921-1000-01').claim, found: true });
  });

  test('mailto body: candidate issue', () => {
    const it = data.byId.get('RS-261002-1400-01');
    const body = M.mailBody(it, 'https://example.org/readiness-signal/#RS-261002-1400-01');
    const lines = body.split('\r\n');
    assert.equal(lines[0], it.claim);
    assert.deepEqual(lines.slice(2, 5), ['Mechanism: Candidate issue', 'Section: Executive Visibility', 'Domains: Resilience, Third party']);
    assert.ok(lines.includes('Validation question:'));
    assert.ok(lines.includes(it.validation_question));
    assert.ok(lines.includes('If the answer is no or unknown, consider this language:'));
    assert.ok(lines.includes(`“${it.candidate_issue_statement}”`));
    assert.ok(lines.includes('- Example Wire: Bank apps go dark as cloud sign-in service fails https://example.com/example-wire/technology/'));
    assert.equal(lines.at(-1), 'Permalink: https://example.org/readiness-signal/#RS-261002-1400-01');
    assert.ok(!body.includes('Why awareness only'));
    assert.ok(!/If asked/i.test(body));
  });

  test('mailto body: awareness only carries the rationale', () => {
    const it = data.byId.get('RS-261002-1400-03');
    const lines = M.mailBody(it, 'L').split('\r\n');
    const k = lines.indexOf('Why awareness only:');
    assert.ok(k > 0);
    assert.equal(lines[k + 1], it.awareness_rationale);
    assert.ok(!lines.includes('Validation question:'));
  });

  test('mailto href is strictly encoded and accepted by safeHref', () => {
    const it = M.prepare({ items: [item({ claim: "Attackers' (new) kit! *now* sells sessions for banks" })] }, { runs: [] }).items[0];
    const href = M.mailtoHref(it, 'https://x/#a');
    assert.ok(href.startsWith('mailto:?subject=Readiness%20Signal%3A%20Attackers%27%20%28new%29'));
    assert.equal(M.safeHref(href), href);
    assert.ok(decodeURIComponent(href.split('&body=')[1]).startsWith("Attackers' (new) kit!"));
  });

  test('mailto href stays inside the length budget for an item at the SPEC maxima', () => {
    // Word counts at the SPEC limits (claim 22, question 40, issue 70), 7-character words,
    // four sources with 200-character headlines and ~90-character URLs.
    const words = (n, w) => Array.from({ length: n }, (_, k) => `${w}${k % 10}`).join(' ');
    const longUrl = (k) => `https://www.example-publication-${k}.com/technology/2026/10/02/${'a'.repeat(40)}-story-${k}`;
    const big = M.prepare({ items: [item({
      claim: words(22, 'signal'),
      validation_question: `${words(39, 'govern')} ok?`,
      candidate_issue_statement: `Where ${words(34, 'monitr')}, ${words(35, 'effect')}.`,
      sources: [1, 2, 3, 4].map((k) => ({ publication: `Publication number ${k}`, url: longUrl(k), headline: 'H'.repeat(200) })),
    })] }, { runs: [] }).items[0];
    const link = 'https://emergingtechrisk.com/readiness-signal/#RS-261001-1800-09';
    assert.ok(encodeURIComponent(M.mailBody(big, link)).length > M.MAILTO_BUDGET, 'the untrimmed body is over budget');
    const href = M.mailtoHref(big, link);
    assert.ok(href.length <= M.MAILTO_BUDGET, `mailto is ${href.length} chars`);
    assert.equal(M.safeHref(href), href);
    const body = decodeURIComponent(href.split('&body=')[1]);
    assert.ok(body.startsWith(big.claim));
    assert.ok(body.includes(big.validation_question));
    assert.ok(body.includes(`“${big.candidate_issue_statement}”`));
    assert.ok(body.endsWith(`Permalink: ${link}`));
    assert.ok(!body.includes('H'.repeat(200)), 'headlines go first');
  });

  test('mailto trims sources in order: headlines, then later sources, then the list', () => {
    const it = data.byId.get('RS-261002-1400-01');
    const L = 'https://x/#RS-261002-1400-01';
    assert.ok(M.mailBody(it, L, 0).includes('- Example Wire: Bank apps go dark'));
    const one = M.mailBody(it, L, 1).split('\r\n');
    assert.ok(one.includes('- Example Wire https://example.com/example-wire/technology/'));
    const two = M.mailBody(it, L, 2).split('\r\n');
    assert.ok(two.includes('- Example Wire https://example.com/example-wire/technology/'));
    assert.ok(two.includes('- 2 more sources at the permalink'));
    const three = M.mailBody(it, L, 3).split('\r\n');
    assert.ok(three.includes('Sources: 3, listed at the permalink.'));
    assert.equal(three.at(-1), `Permalink: ${L}`);
    // a normal item keeps the full body
    assert.equal(decodeURIComponent(M.mailtoHref(it, L).split('&body=')[1]), M.mailBody(it, L));
  });

  test('source without headline falls back to the publication', () => {
    const it = M.prepare({ items: [item({ sources: [{ publication: 'FinCEN', url: 'https://www.fincen.gov/' }] })] }, { runs: [] }).items[0];
    assert.equal(M.itemDetail(it, empty).sources[0].title, 'FinCEN');
    assert.ok(M.mailBody(it, 'L').split('\r\n').includes('- FinCEN https://www.fincen.gov/'));
  });
});

describe('URL safety', () => {
  test('only https, our mailto and safe #ids', () => {
    assert.equal(M.safeHttps('https://example.com/x?y=1'), 'https://example.com/x?y=1');
    assert.equal(M.safeHttps('http://example.com/'), '');
    assert.equal(M.safeHttps('javascript:alert(1)'), '');
    assert.equal(M.safeHttps(' JaVaScRiPt:alert(1)'), '');
    assert.equal(M.safeHttps('data:text/html,<b>x</b>'), '');
    assert.equal(M.safeHttps('https://user:pw@example.com/'), '');
    assert.equal(M.safeHttps('//example.com/'), '');
    assert.equal(M.safeHref('#RS-261002-1400-01'), '#RS-261002-1400-01');
    assert.equal(M.safeHref('#"><b>'), '');
    assert.equal(M.safeHref('mailto:?subject=a"b'), '');
    assert.equal(M.safeHref('vbscript:x'), '');
  });

  test('unsafe source URLs render without a link', () => {
    const it = M.prepare({ items: [item({ sources: [{ publication: 'X', url: 'javascript:alert(1)', headline: 'H' }] })] }, { runs: [] }).items[0];
    assert.equal(M.itemDetail(it, empty).sources[0].href, '');
  });
});

describe('empty archive and empty runs (day one)', () => {
  test('dashboard', () => {
    const d = M.dashboard(empty, NOW);
    assert.equal(d.asOf, '');
    assert.equal(d.latest, null);
    assert.deepEqual(d.exec, []);
    assert.deepEqual(d.board.map((b) => b.n), [0, 0, 0, 0]);
    assert.deepEqual(d.secRows.map((r) => r.last), Array(3).fill('Quiet this week · Last published never'));
    assert.deepEqual(d.domRows.map((r) => [r.n, r.act]), Array(7).fill(['—', '—']));
    assert.match(d.archLine, /^Nothing published yet\./);
    assert.equal(M.mastheadLatest(empty), 'None yet');
  });

  test('report and archive', () => {
    const rep = M.listModel(empty, ui({ page: 'report' }), NOW);
    assert.equal(rep.sub, '0 items · last 24 hours · no runs in this period');
    assert.deepEqual(rep.groups.map((g) => g.empty.title), Array(3).fill('Nothing published in the last 24 hours.'));
    assert.deepEqual(rep.groups.map((g) => g.empty.body), Array(3).fill('No run in this period has applied the entry test yet.'));
    assert.equal(rep.allOpen, false);
    const arc = M.listModel(empty, ui({ page: 'archive' }), NOW);
    assert.equal(arc.archiveEmpty, true);
    assert.equal(arc.sub, '0 items · all time');
    assert.deepEqual(arc.filters[0].opts.map((o) => o.value), ['all', 'custom']);
  });

  test('runs without items: silent runs counted, nothing published', () => {
    const d = M.prepare({ items: [] }, { runs: [
      { slot: '2026-10-02T06:00:00-04:00', status: 'silent', items: [] },
      { slot: '2026-10-02T10:00:00-04:00', status: 'failed', items: [] },
    ] });
    const rep = M.listModel(d, ui({ page: 'report' }), NOW);
    assert.equal(rep.sub, '0 items · last 24 hours · from 0 of 2 runs, 1 silent, 1 failed');
    assert.equal(rep.groups[0].empty.title, 'Nothing cleared the bar in the last 24 hours.');
    assert.match(rep.groups[0].empty.body, /applied in 1 run\.$/);
    const failedOnly = M.prepare({ items: [] }, { runs: [{ slot: '2026-10-02T10:00:00-04:00', status: 'failed', items: [] }] });
    assert.equal(M.listModel(failedOnly, ui({ page: 'report' }), NOW).groups[0].empty.body,
      'No run in this period completed the entry test (1 failed run).');
  });
});

describe('UI defaults', () => {
  test('custom range defaults: from two months back, to today in ET', () => {
    const u = M.defaultUi(NOW);
    assert.equal(u.from, '2026-08-01');
    assert.equal(u.to, '2026-10-02');
    assert.equal(M.defaultUi(new Date('2026-01-01T03:00:00Z')).from, '2025-10-01'); // still 31 Dec in ET
    assert.equal(M.defaultUi(new Date('2026-01-01T03:00:00Z')).to, '2025-12-31');
  });

  test('print mode overrides per-item open state', () => {
    const it = data.items[0];
    assert.equal(M.isOpen(it, { open: {}, printMode: 'expanded' }), true);
    assert.equal(M.isOpen(it, { open: { [it.id]: true }, printMode: 'collapsed' }), false);
    assert.equal(M.isOpen(it, { open: { [it.id]: true }, printMode: null }), true);
  });
});

describe('review hardening', () => {
  test('item ids must match the SPEC format; prototype names and page names are not ids', () => {
    for (const bad of ['constructor', 'valueOf', '__proto__', 'report', 'about', 'section-1', 'main', 'RS-261002-1400-1', 'RS-2610021-1400-01']) {
      assert.equal(M.SAFE_ID.test(bad), false, bad);
    }
    assert.equal(M.SAFE_ID.test('RS-261002-1400-01'), true);
    assert.deepEqual(M.parseHash('#main'), { page: 'dashboard' });
    assert.deepEqual(M.parseHash('#constructor'), { page: 'dashboard' });
    const d = M.prepare({ items: [item(), item({ id: 'constructor' }), item({ id: 'section-1' })] }, { runs: [] });
    assert.deepEqual(d.items.map((i) => i.id), ['RS-261001-1800-09']);
    assert.equal(M.prepare({ items: [item({ update_of: 'valueOf' })] }, { runs: [] }).items[0].update_of, null);
  });

  test('open state reads own properties only', () => {
    const it = data.items[0];
    assert.equal(M.isOpen({ ...it, id: 'constructor' }, { open: {}, printMode: null }), false);
    assert.equal(M.isOpenId({}, 'toString'), false);
    assert.equal(M.isOpenId({ [it.id]: true }, it.id), true);
    assert.equal(M.isOpenId({ [it.id]: false }, it.id), false);
  });

  test('custom-range dates: partial keyboard years are ignored, future dates clamp, fields stay independent', () => {
    const max = '2026-10-02';
    for (const partial of ['0002-09-30', '0020-09-30', '0202-09-30', '1989-12-31']) assert.equal(M.acceptDate(partial, max), null, partial);
    assert.equal(M.acceptDate('2026-09-30', max), '2026-09-30');
    assert.equal(M.acceptDate('1990-01-01', max), '1990-01-01');
    assert.equal(M.acceptDate('2027-01-15', max), max);
    assert.equal(M.acceptDate('2026-02-30', max), null);
    assert.equal(M.acceptDate('', max), null);
    // a From after the To is a valid state: the range and its label order the two dates
    const u = ui({ page: 'archive', archTime: 'custom', from: '2026-09-30', to: '2026-09-01' });
    assert.deepEqual(M.archiveRange(u, NOW), [+M.etDayStart('2026-09-01'), +M.etDayStart('2026-09-30', 1)]);
    assert.equal(M.rangeLabel(u), '1 Sep – 30 Sep');
    const lm = M.listModel(data, u, NOW);
    assert.equal(lm.minDate, M.MIN_DATE);
    assert.equal(lm.maxDate, max);
  });

  test('effective clock: the later of the viewer clock and the newest pipeline write', () => {
    const behind = new Date('2026-03-08T03:30:00-04:00');
    assert.equal(+M.effectiveNow(data, behind), Date.parse('2026-10-02T14:21:40-04:00'));
    assert.equal(+M.effectiveNow(data, NOW), +NOW);
    assert.equal(+M.effectiveNow(null, NOW), +NOW);
    assert.equal(+M.effectiveNow(empty, NOW), +NOW);
    const lm = M.listModel(data, ui({ page: 'report' }), M.effectiveNow(data, behind));
    assert.equal(lm.sub, '7 items · last 24 hours · from 4 of 4 runs');
    // backfilled items never move the clock
    const bf = M.prepare({ items: [item({ id: 'RS-271001-1800-01', timestamp: '2027-10-01T18:00:00-04:00', backfilled: true })] }, { runs: [] });
    assert.equal(+M.effectiveNow(bf, NOW), +NOW);
  });

  test('dashboard: week link and Executive Visibility empty copy depend on what ran', () => {
    assert.equal(M.dashboard(data, NOW).weekLink, `All ${M.plural(M.dashboard(data, NOW).weekCount, 'item')} in the report`);
    assert.equal(M.dashboard(empty, NOW).weekLink, 'Open the report');
    assert.match(M.dashboard(empty, NOW).execNone, /^Nothing published this week\./);
    const silent = M.prepare({ items: [] }, { runs: [{ slot: '2026-10-01T06:00:00-04:00', status: 'silent', items: [] }] });
    assert.equal(M.dashboard(silent, NOW).execNone, 'Nothing cleared the Executive Visibility test this week.');
    const failed = M.prepare({ items: [] }, { runs: [{ slot: '2026-10-01T06:00:00-04:00', status: 'failed', items: [] }] });
    assert.match(M.dashboard(failed, NOW).execNone, /^Nothing published this week\./);
    assert.equal(M.dashboard(data, NOW).domRows[0].name, `Cyber: ${M.plural(data.items.filter((i) => i.ts >= +NOW - 7 * DAY && i.domains.includes('cyber')).length, 'item')}, ${data.items.filter((i) => i.ts >= +NOW - 7 * DAY && i.domains.includes('cyber') && i.mechanism !== 'awareness_only').length} ask action`);
  });

  test('list controls: nothing to expand or export in an empty selection', () => {
    const arc = M.listModel(empty, ui({ page: 'archive' }), NOW);
    assert.equal(arc.showToggleAll, false);
    assert.equal(arc.showExport, false);
    const rep = M.listModel(empty, ui({ page: 'report' }), NOW);
    assert.equal(rep.showToggleAll, false);
    assert.equal(rep.showExport, true);
    const full = M.listModel(data, ui({ page: 'report' }), NOW);
    assert.equal(full.showToggleAll, true);
    assert.equal(full.showExport, true);
  });
});
