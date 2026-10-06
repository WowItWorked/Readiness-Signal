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

  test('an item near a window edge gets the next window, so it is still inside when rendered', () => {
    // 23 h 30 min old when the window is chosen; the render a moment later must still show it.
    const it = item({ id: 'RS-261001-1530-01', timestamp: new Date(+NOW - DAY + 30 * 60e3).toISOString() });
    const d = M.prepare({ items: [it] }, { runs: [] });
    const p = M.revealPatch(d, it.id, ui(), NOW);
    assert.equal(p.repTime, 'week');
    const later = new Date(+NOW + 45 * 60e3);
    assert.ok(M.listModel(d, { ...ui(), ...p }, later).shown.some((i) => i.id === it.id));
  });

  test('last-resort reveal: all-time archive, no search, no filters, item open', () => {
    const start = ui({ page: 'report', repTime: 'day', q: 'x', secs: ['executive_visibility'], doms: ['ai'], srcs: ['news'], open: { a: true } });
    const p = M.revealAllPatch('RS-260115-1000-01', start);
    assert.deepEqual(p, {
      page: 'archive', archTime: 'all', q: '', secs: [], doms: [], srcs: [],
      open: { a: true, 'RS-260115-1000-01': true }, pop: null, printMode: null,
    });
    assert.ok(M.listModel(data, { ...start, ...p }, NOW).shown.some((i) => i.id === 'RS-260115-1000-01'));
  });

  test('every item in the archive is shown, expanded, by its reveal from the default view', () => {
    for (const it of data.items) {
      const p = M.revealPatch(data, it.id, ui(), NOW);
      const lm = M.listModel(data, { ...ui(), ...p }, NOW);
      assert.ok(lm.shown.some((i) => i.id === it.id), it.id);
      assert.equal(M.isOpen(it, { ...ui(), ...p }), true, it.id);
    }
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
    assert.equal(M.mastheadTimes(data).edition, 'Fri 2 Oct 2026, 14:00 ET');
  });

  test('fallback without published runs: latest non-backfilled item', () => {
    const d = M.prepare({ items: [item(), item({ id: 'RS-261002-0600-07', timestamp: '2026-10-02T06:00:00-04:00', backfilled: true })] }, { runs: [] });
    assert.equal(M.latestEdition(d).items[0].id, 'RS-261001-1800-09');
  });

  test('"Last checked" is the latest completed run, silent included; a failed run leaves it', () => {
    assert.equal(M.fmtFull(M.lastChecked(data)), 'Fri 2 Oct 2026, 14:21 ET');
    const run = (slot, status, fin) => ({ slot: `2026-10-02T${slot}:00-04:00`, status, started_at: `2026-10-02T${slot}:30-04:00`, finished_at: `2026-10-02T${fin}:00-04:00`, items: [] });
    const silent = M.prepare({ items: [] }, { runs: [run('06:00', 'silent', '06:09')] });
    assert.deepEqual(M.mastheadTimes(silent), { edition: 'None yet', checked: 'Fri 2 Oct 2026, 06:09 ET' });
    assert.equal(M.latestEdition(silent), null);
    const failed = M.prepare({ items: [] }, { runs: [run('06:00', 'silent', '06:09'), run('10:00', 'failed', '10:20')] });
    assert.equal(M.mastheadTimes(failed).checked, 'Fri 2 Oct 2026, 06:09 ET');
    const onlyFailed = M.prepare({ items: [] }, { runs: [run('10:00', 'failed', '10:20')] });
    assert.deepEqual(M.mastheadTimes(onlyFailed), { edition: 'None yet', checked: 'Not yet' });
  });

  test('a silent run moves "Last checked" and leaves "Last edition" alone', () => {
    const before = M.mastheadTimes(data);
    const next = { ...RAW_RUNS, runs: [...RAW_RUNS.runs, { run_id: '2026-10-02-1800', slot: '2026-10-02T18:00:00-04:00', started_at: '2026-10-02T18:05:00-04:00', finished_at: '2026-10-02T18:31:00-04:00', status: 'silent', items: [] }] };
    const after = M.mastheadTimes(M.prepare(RAW_ARCHIVE, next));
    assert.equal(after.edition, before.edition);
    assert.equal(after.checked, 'Fri 2 Oct 2026, 18:31 ET');
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

describe('dashboard analysis', () => {
  const d = M.dashboard(data, NOW);
  const archive = (over) => M.prepare({ items: over.map((o) => item(o)) }, { runs: [] });

  test('brief: four readings, each built from the archive or the run log', () => {
    assert.deepEqual(d.brief.map((b) => b.kicker), ['Building', 'Concentrating', 'Asking', 'The bar']);
    const [building, conc, asking, bar] = d.brief;
    assert.equal(building.text, '2 developments in one thread since 21 Sep 2026, 2 of them in the last 30 days.');
    assert.equal(building.item.id, 'RS-261002-1400-02');
    const recentFrom = +NOW - 90 * DAY;
    const recent = data.items.filter((i) => i.ts >= recentFrom);
    const prior = data.items.filter((i) => i.ts >= recentFrom - 90 * DAY && i.ts < recentFrom);
    const cyber = (l) => l.filter((i) => i.domains.includes('cyber')).length;
    assert.equal(conc.text, `Cyber is on ${cyber(recent)} of the ${recent.length} items from the last 90 days, against ${cyber(prior)} of ${prior.length} in the 90 days before.`);
    assert.equal(conc.sub, 'Every domain has items from the last 90 days.');
    assert.equal(asking.text, '20 of the 25 items from the last 90 days ask for action: 7 candidate issues, 7 KRI / KPI checks and 6 PRAF coverage checks.');
    assert.equal(asking.sub, 'In the 90 days before: 2 of 3.');
    assert.equal(bar.text, '26 runs in the last 7 days read 4,001 new headlines; 573 passed the first screen and 13 cleared the bar.');
    assert.equal(bar.sub, '1 of 27 scheduled runs failed.');
  });

  test('brief on thin data reads plainly', () => {
    assert.deepEqual(M.dashboard(empty, NOW).brief.map((b) => b.text), [
      'No developing thread yet. A thread forms when an item materially updates an earlier one.',
      'Nothing was added in the last 90 days.',
      'Nothing was added in the last 90 days.',
      'No scheduled run has been recorded yet.',
    ]);
    const aware = { mechanism: 'awareness_only', validation_question: null, candidate_issue_statement: null, awareness_rationale: 'Known.' };
    const one = M.dashboard(archive([{ ...aware, domains: ['cyber', 'data'] }]), NOW).brief;
    assert.equal(one[1].text, 'The one item from the last 90 days is on Cyber and Data.');
    assert.equal(one[1].sub, 'Nothing in the last 90 days on Fraud, AI, Resilience, Third party and Risk quantification.');
    assert.equal(one[2].text, 'The one item from the last 90 days resolves as awareness only.');
    assert.equal(M.dashboard(archive([{}]), NOW).brief[2].text, 'The one item from the last 90 days asks for action: a candidate issue.');
    const two = archive([{ ...aware }, { ...aware, id: 'RS-260930-1000-01', timestamp: '2026-09-30T10:00:00-04:00' }]);
    assert.equal(M.dashboard(two, NOW).brief[2].text, 'None of the 2 items from the last 90 days asks for action; each resolves as awareness only.');
  });

  test('threads: update_of links join items into stories; a lone item is not a thread', () => {
    assert.equal(d.threadCount, 1);
    assert.deepEqual(d.threads[0].items.map((i) => i.id), ['RS-260921-1000-01', 'RS-261002-1400-02']);
    assert.equal(d.threads[0].recent, 2);
    const x = archive([
      { id: 'RS-260101-0600-01', timestamp: '2026-01-01T06:00:00-05:00' },
      { id: 'RS-260201-0600-01', timestamp: '2026-02-01T06:00:00-05:00', update_of: 'RS-260101-0600-01' },
      { id: 'RS-260301-0600-01', timestamp: '2026-03-01T06:00:00-05:00', update_of: 'RS-260101-0600-01' },
      { id: 'RS-260401-1000-01', timestamp: '2026-04-01T10:00:00-04:00', update_of: 'RS-260301-0600-01' },
      { id: 'RS-260501-1000-01', timestamp: '2026-05-01T10:00:00-04:00' },
      { id: 'RS-260601-1000-01', timestamp: '2026-06-01T10:00:00-04:00', update_of: 'RS-260501-1000-01' },
      { id: 'RS-260701-1000-01', timestamp: '2026-07-01T10:00:00-04:00' },
    ]);
    const ts = M.threads(x, NOW);
    assert.deepEqual(ts.map((t) => t.n), [2, 4], 'most recently active first');
    assert.deepEqual(ts[1].items.map((i) => i.id), ['RS-260101-0600-01', 'RS-260201-0600-01', 'RS-260301-0600-01', 'RS-260401-1000-01'], 'a branching chain is one thread');
    assert.deepEqual(M.threads(archive([{ update_of: 'RS-200101-0600-01' }]), NOW), [], 'a link to an item outside the archive');
  });

  test('months: first item to now, at most twelve, the year where the axis starts or turns', () => {
    assert.deepEqual(d.months.map((m) => m.key), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    assert.deepEqual(d.months.filter((m) => m.year).map((m) => m.key), ['2026-01']);
    const long = M.monthSpan(archive([{ id: 'RS-241101-0600-01', timestamp: '2024-11-01T06:00:00-04:00' }]), NOW);
    assert.equal(long.length, 12);
    assert.deepEqual(long.filter((m) => m.year).map((m) => `${m.label} ${m.year}`), ['Nov 2025', 'Jan 2026']);
    assert.deepEqual(M.monthSpan(empty, NOW).map((m) => m.key), ['2026-10']);
    assert.equal(M.dashboard(archive([{ id: 'RS-241101-0600-01', timestamp: '2024-11-01T06:00:00-04:00' }]), NOW).beforeChart, 1);
  });

  test('month positions: equal-width months, null off the axis', () => {
    assert.equal(M.monthPos(d.months, new Date('2026-01-01T00:00:00-05:00')), 0);
    assert.ok(Math.abs(M.monthPos(d.months, new Date('2026-10-16T12:00:00-04:00')) - (9 + 15.5 / 31) / 10) < 1e-9);
    assert.equal(M.monthPos(d.months, new Date('2025-12-31T12:00:00-05:00')), null);
  });

  test('additions by month: actions first, then awareness, oldest first within each', () => {
    const sep = d.additions.find((a) => a.key === '2026-09');
    const items = data.items.filter((i) => i.month === '2026-09');
    assert.equal(sep.items.length, items.length);
    assert.equal(sep.action, items.filter((i) => i.mechanism !== 'awareness_only').length);
    const flags = sep.items.map(M.asksForAction);
    assert.deepEqual(flags, [...flags].sort((a, b) => Number(b) - Number(a)));
    assert.equal(d.additions.reduce((n, a) => n + a.items.length, 0), data.items.length);
    assert.equal(d.beforeChart, 0);
  });

  test('domain matrix: per month, and the last 90 days against the 90 before, in fixed order', () => {
    assert.deepEqual(d.domains.rows.map((r) => r.key), M.DOMAINS.map((x) => x.key));
    const recentFrom = +NOW - 90 * DAY;
    for (const r of d.domains.rows) {
      const has = (i) => i.domains.includes(r.key);
      assert.equal(r.recent, data.items.filter((i) => i.ts >= recentFrom && has(i)).length, r.key);
      assert.equal(r.prior, data.items.filter((i) => i.ts >= recentFrom - 90 * DAY && i.ts < recentFrom && has(i)).length, r.key);
      assert.equal(r.cells.reduce((a, b) => a + b, 0), r.total, r.key);
    }
  });

  test('asks and regulatory signals, newest first', () => {
    assert.equal(d.asksTotal, data.items.filter((i) => i.mechanism !== 'awareness_only').length);
    assert.ok(d.asks.length === 5 && d.asks.every((i) => i.mechanism !== 'awareness_only' && i.validation_question));
    assert.deepEqual(d.asks.map((i) => i.ts), [...d.asks.map((i) => i.ts)].sort((a, b) => b - a));
    assert.equal(d.regulatoryTotal, data.items.filter((i) => i.section === 'regulatory_trajectory').length);
    assert.deepEqual(d.regulatory.slice(0, 2).map((r) => [r.item.id, r.issuer]), [
      ['RS-261001-0600-01', 'Example Senate Committee'], ['RS-260929-1000-01', 'Example House Committee'],
    ]);
    assert.deepEqual(d.sections.map((s) => s.count), [11, 13, 8]);
  });

  test('the bar: run-log sums over the last 7 calendar days, and what became of each slot', () => {
    const b = d.bar;
    assert.equal(b.from, +new Date('2026-09-26T00:00:00-04:00'));
    const runs = RAW_RUNS.runs.filter((r) => Date.parse(r.slot) >= b.from && Date.parse(r.slot) <= +NOW);
    const done = runs.filter((r) => r.status !== 'failed');
    assert.equal(b.completed, done.length);
    assert.equal(b.unseen, done.reduce((n, r) => n + r.funnel.unseen, 0));
    assert.equal(b.stage1, done.reduce((n, r) => n + r.funnel.stage1_pass, 0));
    assert.equal(b.tested, done.reduce((n, r) => n + Object.values(r.stage2_by_section).reduce((m, s) => m + s.tested, 0), 0));
    assert.equal(b.cleared, done.reduce((n, r) => n + r.items.length, 0));
    assert.deepEqual([b.published, b.silent, b.failed, b.missed, b.scheduled], [9, 17, 1, 0, 27]);
    assert.equal(b.grid.length, 7);
    assert.deepEqual(b.grid.at(-1).slots.map((s) => s.state), ['published', 'published', 'published', 'later']);
  });

  test('the bar counts a slot as missed only after its hour, and only once runs have begun', () => {
    const x = M.prepare({ items: [] }, { runs: [
      { slot: '2026-10-01T10:00:00-04:00', status: 'silent', items: [], funnel: { unseen: 100, stage1_pass: 5 } },
      { slot: '2026-10-02T06:00:00-04:00', status: 'silent', items: [], funnel: { unseen: 50, stage1_pass: 2 } },
    ] });
    const at = new Date('2026-10-02T14:30:00-04:00');
    const b = M.barStats(x, at);
    assert.deepEqual(b.grid.at(-2).slots.map((s) => s.state), ['off', 'silent', 'missed', 'missed']);
    assert.deepEqual(b.grid.at(-1).slots.map((s) => s.state), ['silent', 'missed', 'due', 'later']);
    assert.deepEqual([b.missed, b.scheduled, b.completed, b.unseen, b.stage1, b.cleared], [3, 5, 2, 150, 7, 0]);
    const bar = M.dashboard(x, at).brief[3];
    assert.equal(bar.text, '2 runs in the last 7 days read 150 new headlines; 7 passed the first screen and none cleared the bar.');
    assert.equal(bar.sub, '3 of 5 scheduled runs did not run.');
  });

  test('archive line', () => {
    assert.equal(d.archLine, '32 items published since 15 Jan 2026. Nothing is replaced; everything stays searchable.');
    assert.equal(d.scope, '32 items since 15 Jan 2026');
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

  test('email body: claim, tags, interpretation in two sentences, then the permalink', () => {
    const it = data.byId.get('RS-261002-1400-01');
    const link = M.permalinkUrl(it.id);
    assert.equal(link, 'https://emergingtechrisk.com/Readiness-Signal/#RS-261002-1400-01');
    assert.deepEqual(M.mailBody(it).split('\r\n'), [
      "A cloud identity-service failure took several banks' mobile apps offline for four hours.",
      '',
      'Mechanism: Candidate issue',
      'Domains: Resilience, Third party',
      '',
      "Failover assumed a healthy secondary region, but the provider's shared identity service failed in both. Four hours is longer than many impact tolerances set for mobile banking.",
      '',
      'Full item, validation question, candidate issue statement and sources:',
      link,
    ]);
  });

  test('email body: an awareness-only item points to its rationale', () => {
    const it = data.byId.get('RS-261002-1400-03');
    const lines = M.mailBody(it).split('\r\n');
    assert.equal(lines[0], "A widely shared 'mega-leak' of bank logins is recompiled old breach data, not a new compromise.");
    assert.equal(lines[2], 'Mechanism: Awareness only');
    assert.equal(lines[3], 'Domains: Data, Fraud, Cyber');
    assert.equal(lines.at(-2), 'Full item, awareness rationale and sources:');
    assert.equal(lines.at(-1), M.permalinkUrl(it.id));
  });

  test('email body leaves the question, issue language, rationale and sources to the permalink', () => {
    for (const it of data.items) {
      const body = M.mailBody(it);
      for (const field of [it.validation_question, it.candidate_issue_statement, it.awareness_rationale]) {
        if (field) assert.ok(!body.includes(M.plainText(field)), it.id);
      }
      for (const s of it.sources) if (s.url) assert.ok(!body.includes(s.url), it.id);
    }
  });

  test('every email ends with the absolute permalink on the live site', () => {
    for (const it of data.items) {
      const body = decodeURIComponent(M.mailtoHref(it).split('&body=')[1]);
      const last = body.split('\r\n').at(-1);
      assert.equal(last, `https://emergingtechrisk.com/Readiness-Signal/#${it.id}`);
      assert.equal(new URL(last).hash, `#${it.id}`);
    }
  });

  test('sentences: abbreviations, initials and decimals do not end a sentence', () => {
    assert.deepEqual(M.sentences('One. Two! Three? Four'), ['One.', 'Two!', 'Three?', 'Four']);
    assert.deepEqual(M.sentences('The U.S. Treasury and the U.K. FCA spoke, e.g. on Jan. 5. A second one.'),
      ['The U.S. Treasury and the U.K. FCA spoke, e.g. on Jan. 5.', 'A second one.']);
    assert.deepEqual(M.sentences('Rates rose 2.5 percent. "Quoted." (Aside.) Last'), ['Rates rose 2.5 percent.', '"Quoted."', '(Aside.)', 'Last']);
    assert.deepEqual(M.sentences('J. Smith of No. 10 spoke. Then left.'), ['J. Smith of No. 10 spoke.', 'Then left.']);
  });

  test('interpretation: read-across in domain order, cut to two sentences', () => {
    const one = (interpretation) => M.prepare({ items: [item({ interpretation })] }, { runs: [] }).items[0];
    assert.equal(M.mailInterpretation(one([
      { domain: 'cyber', text: 'First sentence here. Second sentence here.' },
      { domain: 'data', text: 'Third sentence, from another domain.' },
    ])), 'First sentence here. Second sentence here.');
    assert.equal(M.mailInterpretation(one([
      { domain: 'cyber', text: 'One sentence without a stop' },
      { domain: 'data', text: 'Then another — with a dash. And a third.' },
    ])), 'One sentence without a stop. Then another - with a dash.');
  });

  test('typographic punctuation goes out as plain ASCII', () => {
    assert.equal(M.plainText('“Quoted” — it’s 2–3… ok'), '"Quoted" - it\'s 2-3... ok');
  });

  test('mailto link: %20 spaces, %0D%0A line breaks, strict encoding, accepted by safeHref', () => {
    const it = M.prepare({ items: [item({ claim: "Attackers' (new) kit! *now* sells sessions + tokens for banks" })] }, { runs: [] }).items[0];
    const href = M.mailtoHref(it);
    assert.ok(href.startsWith('mailto:?subject=Readiness%20Signal%3A%20Attackers%27%20%28new%29%20kit%21%20%2Anow%2A%20sells%20sessions%20%2B%20tokens'));
    assert.ok(!href.includes('+'), 'spaces are %20 and a literal plus is %2B');
    assert.ok(href.includes('%0D%0A'));
    assert.ok(href.split('%0A').slice(0, -1).every((part) => part.endsWith('%0D')), 'every line break is CRLF');
    assert.equal(M.safeHref(href), href);
    const [, subject, body] = /^mailto:\?subject=([^&]*)&body=([^&]*)$/.exec(href);
    assert.equal(decodeURIComponent(subject), "Readiness Signal: Attackers' (new) kit! *now* sells sessions + tokens for banks");
    assert.equal(decodeURIComponent(body), M.mailBody(it));
  });

  test('mailto stays under 1,800 characters: the interpretation is dropped first, never the link', () => {
    // SPEC maxima: a 22-word claim, all seven domains, each read-across one 60-word sentence.
    const words = (n, w) => Array.from({ length: n }, (_, k) => `${w}${k % 10}`).join(' ');
    const big = M.prepare({ items: [item({
      claim: words(22, 'Signalling'),
      domains: M.DOMAINS.map((d) => d.key),
      interpretation: M.DOMAINS.map((d) => ({ domain: d.key, text: `${words(59, 'consequential')} end.` })),
    })] }, { runs: [] }).items[0];
    const href = M.mailtoHref(big);
    assert.ok(href.length < M.MAILTO_LIMIT, `mailto is ${href.length} chars`);
    assert.equal(M.safeHref(href), href);
    const body = decodeURIComponent(href.split('&body=')[1]);
    assert.ok(!body.includes('consequential'), 'interpretation dropped');
    assert.ok(body.startsWith(big.claim));
    assert.ok(body.includes('Domains: Cyber, Fraud, AI, Data, Resilience, Third party, Risk quantification'));
    assert.ok(body.endsWith(`\r\n${M.permalinkUrl(big.id)}`));
    // An ordinary item keeps its interpretation, and every archive item is under the limit.
    const it = data.byId.get('RS-261002-1400-01');
    assert.equal(decodeURIComponent(M.mailtoHref(it).split('&body=')[1]), M.mailBody(it));
    for (const x of data.items) assert.ok(M.mailtoHref(x).length < M.MAILTO_LIMIT, x.id);
  });

  test('source without headline falls back to the publication', () => {
    const it = M.prepare({ items: [item({ sources: [{ publication: 'FinCEN', url: 'https://www.fincen.gov/' }] })] }, { runs: [] }).items[0];
    assert.equal(M.itemDetail(it, empty).sources[0].title, 'FinCEN');
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
    assert.equal(M.lastChecked(empty), null);
    assert.equal(d.scope, '');
    assert.deepEqual(d.latest, []);
    assert.deepEqual(d.threads, []);
    assert.deepEqual([d.asksTotal, d.regulatoryTotal, d.additionsMax], [0, 0, 0]);
    assert.deepEqual(d.months.map((m) => m.key), ['2026-10']);
    assert.equal(d.bar.any, false);
    assert.ok(d.bar.grid.every((g) => g.slots.every((s) => s.state === 'off' || s.state === 'later')), 'nothing counts as missed before runs begin');
    assert.match(d.archLine, /^Nothing published yet\./);
    assert.deepEqual(M.mastheadTimes(empty), { edition: 'None yet', checked: 'Not yet' });
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
