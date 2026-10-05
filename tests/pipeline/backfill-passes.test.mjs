// Backfill pass keys (BACKFILL.md §1): the month passes 2026-01 to 2026-09 and the day passes of
// the current month (2026-10-01 to 2026-10-04, the last ended early at its until), their windows,
// the per-key publish refusal, and references to items of earlier (never later) passes. Library
// level (planPublish with in-memory data and fake verified checks), then the CLI (--month and
// --day) in temp dirs with the fetch mock preloaded (fixtures/backfill-mock-fetch.mjs): no
// network, nothing real written. All data is FICTIONAL (example.* domains).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PASSES, dayWindow, docPassKey, emptyCandidatesDoc, emptyUrlCheckDoc, instantInWindow, itemTiming, mergeUrlChecks, monthWindow,
  passFields, passKeyAt, passKind, passSections, passWindow, planPublish, prepareAddEntries, requirePass, slotForPublication,
  windowDoc, windowOpenIssue, windowUntil,
} from '../../pipeline/lib/backfill.mjs';
import { USER_AGENT } from '../../pipeline/lib/collect.mjs';
import { loadThresholds } from '../../pipeline/lib/thresholds.mjs';
import { etDateString, toEtIso } from '../../pipeline/lib/time.mjs';
import { normaliseUrl } from '../../pipeline/lib/url.mjs';
import { FILTER_FIXTURE, FIXTURES, ROOT, SCRIPTS, judgment, makeCandidate, makeDraft, readJson, rmrf, runScript, tempDir, writeJson } from './_helpers.mjs';

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const DAYS = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
const UNTIL = '2026-10-04T18:00:00-04:00';
const SECTIONS = ['capability_shift', 'regulatory_trajectory'];

// ---------------------------------------------------------------- PASSES and windows

test('PASSES: months 2026-01 to 2026-09 and days 2026-10-01 to 2026-10-04, the January sections, the owner instruction', () => {
  assert.deepEqual(Object.keys(PASSES), [...MONTHS, ...DAYS]);
  for (const key of Object.keys(PASSES)) {
    assert.deepEqual([...PASSES[key].sections], SECTIONS, key);
    assert.deepEqual(passSections(key), SECTIONS, key);
    assert.equal(requirePass(key), PASSES[key]);
    assert.ok(Object.isFrozen(PASSES[key]) && Object.isFrozen(PASSES[key].sections), `${key} frozen`);
    assert.equal(passKind(key), MONTHS.includes(key) ? 'month' : 'day');
  }
  for (const key of [...MONTHS.slice(1), ...DAYS]) {
    assert.match(PASSES[key].instruction, /Now run all months sequentially until October and then run each day up until today so that nothing is missed from this year on it's first load/, key);
  }
  // only the last day pass ends early
  assert.deepEqual(Object.keys(PASSES).filter((k) => PASSES[k].until), ['2026-10-04']);
  assert.equal(PASSES['2026-10-04'].until, UNTIL);
  // --sections narrows a day pass too, never widens it
  assert.deepEqual(passSections('2026-10-02', 'regulatory_trajectory'), ['regulatory_trajectory']);
  assert.throws(() => passSections('2026-10-02', 'executive_visibility'), /executive_visibility is not in the 2026-10-02 pass/);
  for (const none of ['2025-12', '2026-10', '2026-10-05', '2026-09-15', '2026-01-20']) {
    assert.throws(() => requirePass(none), new RegExp(`no backfill pass is defined for ${none} \\(BACKFILL\\.md §1 lists 2026-01, .*2026-10-04\\)`), none);
  }
});

test('the passes cover 2026-01-01 00:00 ET to 2026-10-04 18:00 ET without gap or overlap, in order', () => {
  const windows = Object.keys(PASSES).map((k) => passWindow(k));
  assert.equal(windows[0].since, '2026-01-01T00:00:00-05:00');
  for (let i = 1; i < windows.length; i++) {
    assert.equal(windows[i].start.getTime(), windows[i - 1].end.getTime(), `${windows[i - 1].key} ends where ${windows[i].key} starts`);
  }
  const last = windows[windows.length - 1];
  assert.equal(last.until, UNTIL);
  assert.equal(last.end.getTime(), Date.parse(UNTIL) + 1, 'the until instant itself is inside');
  // every instant of the year so far belongs to exactly one pass
  assert.equal(passKeyAt('2026-01-01T00:00:00-05:00'), '2026-01');
  assert.equal(passKeyAt('2026-02-28T23:59:59-05:00'), '2026-02');
  assert.equal(passKeyAt('2026-03-08T03:30:00-04:00'), '2026-03', 'the spring DST change');
  assert.equal(passKeyAt('2026-09-30T23:59:59-04:00'), '2026-09');
  assert.equal(passKeyAt('2026-10-01T00:00:00-04:00'), '2026-10-01');
  assert.equal(passKeyAt('2026-10-03T21:00:00-04:00'), '2026-10-03');
  assert.equal(passKeyAt(UNTIL), '2026-10-04');
  assert.equal(passKeyAt('2026-10-04T18:00:01-04:00'), null, 'after the until: the live routine');
  assert.equal(passKeyAt('2025-12-31T23:59:59-05:00'), null);
  assert.equal(passKeyAt('garbage'), null);
});

test('month passes 2026-02 to 2026-09: windows, ids, slots (daylight time from March)', () => {
  const expect = {
    '2026-02': ['2026-02-01T00:00:00-05:00', '2026-02-28T23:59:59-05:00', '2026-02-28T18:00:00-05:00'],
    '2026-03': ['2026-03-01T00:00:00-05:00', '2026-03-31T23:59:59-04:00', '2026-03-31T18:00:00-04:00'],
    '2026-06': ['2026-06-01T00:00:00-04:00', '2026-06-30T23:59:59-04:00', '2026-06-30T18:00:00-04:00'],
    '2026-09': ['2026-09-01T00:00:00-04:00', '2026-09-30T23:59:59-04:00', '2026-09-30T18:00:00-04:00'],
  };
  for (const m of MONTHS.slice(1)) {
    const w = passWindow(m, 'month');
    assert.deepEqual([w.kind, w.key, w.month, w.id, w.endsEarly], ['month', m, m, `backfill-${m}`, undefined], m);
    assert.deepEqual(passWindow(m), w, `${m}: the kind follows the key`);
    assert.deepEqual(w, monthWindow(m), `${m}: no until`);
    assert.deepEqual(passFields(w), { month: m });
    if (expect[m]) assert.deepEqual([w.since, w.until, w.lastSlot.iso], expect[m], m);
  }
  // a month key never passes for a day and the reverse
  assert.throws(() => passWindow('2026-02', 'day'), /--day: "2026-02" is not YYYY-MM-DD/);
  assert.throws(() => passWindow('2026-10-01', 'month'), /--month: "2026-10-01" is not YYYY-MM/);
  assert.throws(() => passWindow('2026-10', 'month'), /no backfill pass is defined for 2026-10/);
  // March: slots carry -05:00 before the 8 March DST change and -04:00 from its 06:00 slot on
  const mar = passWindow('2026-03');
  const slotOf = (iso) => slotForPublication(new Date(iso), mar).slot;
  assert.deepEqual([mar.firstSlot.iso, slotOf('2026-03-07T15:00:00-05:00').iso], ['2026-03-01T06:00:00-05:00', '2026-03-07T18:00:00-05:00']);
  assert.deepEqual([slotOf('2026-03-07T20:00:00-05:00').iso, slotOf('2026-03-08T01:30:00-05:00').id_stem], ['2026-03-08T06:00:00-04:00', 'RS-260308-0600']);
  assert.equal(slotOf('2026-03-08T03:30:00-04:00').instant.toISOString(), '2026-03-08T10:00:00.000Z', '06:00 EDT');
  assert.equal(mar.end.toISOString(), '2026-04-01T04:00:00.000Z');
  // a date-only source counts as 18:00 ET in either offset
  const dated = (date) => itemTiming({ sources: [{ url: `https://research.example.com/${date}` }] }, new Map([[normaliseUrl(`https://research.example.com/${date}`), makeCandidate({ url: `https://research.example.com/${date}`, published: `${date}T12:00:00.000Z`, published_date: date, published_precision: 'date' })]]), mar).slot.iso;
  assert.deepEqual([dated('2026-03-07'), dated('2026-03-08'), dated('2026-03-31')], ['2026-03-07T18:00:00-05:00', '2026-03-08T18:00:00-04:00', '2026-03-31T18:00:00-04:00']);
});

test('day passes: one ET calendar day, slots 06:00 to 18:00, key, run id, documents keyed by day', () => {
  const w = passWindow('2026-10-01', 'day');
  assert.deepEqual(w, dayWindow('2026-10-01'));
  assert.deepEqual([w.kind, w.key, w.day, w.id, w.month], ['day', '2026-10-01', '2026-10-01', 'backfill-2026-10-01', undefined]);
  assert.deepEqual([w.since, w.until, w.firstDate, w.lastDate], ['2026-10-01T00:00:00-04:00', '2026-10-01T23:59:59-04:00', '2026-10-01', '2026-10-01']);
  assert.deepEqual([w.firstSlot.iso, w.lastSlot.iso, w.lastSlot.id_stem], ['2026-10-01T06:00:00-04:00', '2026-10-01T18:00:00-04:00', 'RS-261001-1800']);
  assert.equal(w.end.toISOString(), '2026-10-02T04:00:00.000Z');
  assert.deepEqual(windowDoc(w), { day: '2026-10-01', since: w.since, until: w.until, first_slot: w.firstSlot.iso, last_slot: w.lastSlot.iso });
  // the work files and the audit log rows carry the day as the pass key
  const now = new Date('2026-10-04T12:00:00-04:00');
  const cand = emptyCandidatesDoc(w, now);
  assert.equal(cand.day, '2026-10-01');
  assert.ok(!('month' in cand));
  assert.equal(docPassKey(cand), '2026-10-01');
  assert.equal(docPassKey(emptyUrlCheckDoc(w)), '2026-10-01');
  assert.equal(mergeUrlChecks(emptyUrlCheckDoc(w), [], now).day, '2026-10-01');
  assert.equal(mergeUrlChecks(emptyUrlCheckDoc(monthWindow('2026-01')), [], now).month, '2026-01');
  assert.equal(docPassKey({ month: '2026-01' }), '2026-01');
  assert.equal(docPassKey(null), null);
  // a 23:30 development inside the day takes its 18:00 slot (§4 clamp); the next morning is the next pass
  assert.deepEqual(Object.values(slotForPublication(new Date('2026-10-01T23:30:00-04:00'), w)).map((x) => x.iso ?? x), ['2026-10-01T18:00:00-04:00', true]);
  assert.deepEqual(Object.values(slotForPublication(new Date('2026-10-01T05:00:00-04:00'), w)).map((x) => x.iso ?? x), ['2026-10-01T06:00:00-04:00', false]);
  assert.equal(instantInWindow('2026-10-02T00:00:00-04:00', w), false);
  for (const bad of ['2026-10', '2026-10-32', '2026-02-30', '20261001', '', undefined]) assert.throws(() => dayWindow(bad), /--day: .* is not YYYY-MM-DD/, String(bad));
  // add: inside the day only; a later date needs --allow-outside and is flagged
  const entry = (published, url = 'https://research.example.com/2026/10/one') => ({ url, publication: 'Example Research', source_class: 'vendor_threat_research', headline: 'A fictional headline', published, paywalled: false, discovery_mode: 'search' });
  const ok = prepareAddEntries([entry('2026-10-01'), entry('2026-10-01T23:59:00-04:00', 'https://research.example.com/2026/10/two')], { window: w });
  assert.deepEqual(ok.errors, []);
  const bad = prepareAddEntries([entry('2026-09-30'), entry('2026-10-02T00:30:00-04:00', 'https://research.example.com/2026/10/three')], { window: w });
  assert.match(bad.errors[0], /published 2026-09-30 is outside the 2026-10-01 window .*before the window is dropped BF_OUT_OF_WINDOW/);
  assert.match(bad.errors[1], /outside the 2026-10-01 window .*after the window is dropped BF_OUT_OF_WINDOW; .*--allow-outside/);
});

test('partial day 2026-10-04: the window ends at its until; later is BF_OUT_OF_WINDOW; not ended before it passes', () => {
  const w = passWindow('2026-10-04', 'day');
  assert.deepEqual([w.key, w.id, w.since, w.until, w.lastDate, w.lastSlot.iso, w.endsEarly], ['2026-10-04', 'backfill-2026-10-04', '2026-10-04T00:00:00-04:00', UNTIL, '2026-10-04', UNTIL, true]);
  assert.equal(windowDoc(w).until, UNTIL);
  assert.equal(windowDoc(w).ends_early, true);
  assert.equal(instantInWindow(UNTIL, w), true);
  assert.equal(instantInWindow('2026-10-04T18:00:01-04:00', w), false);
  assert.equal(instantInWindow('2026-10-04T17:59:59-04:00', w), true);
  // the effective end decides when the window has ended
  assert.match(windowOpenIssue(w, new Date('2026-10-04T17:00:00-04:00')), /the 2026-10-04 window has not ended \(it ends at 2026-10-04T18:00:00-04:00 ET, the last edition slot this pass covers; the live routine covers what follows\); a backfill covers history only/);
  assert.match(windowOpenIssue(w, new Date(UNTIL)), /has not ended/, 'at the until itself it has not passed');
  assert.equal(windowOpenIssue(w, new Date(Date.parse(UNTIL) + 1)), null);
  assert.match(windowOpenIssue(w, new Date('2026-10-04T16:00:00-04:00'), { clock: 'real clock' }), /has not ended \(.*\) at the real clock 2026-10-04T16:00:00-04:00/);
  // the real clock: open until 18:00 ET on 4 October 2026, ended after it
  assert.equal(windowOpenIssue(w, new Date()) === null, Date.now() > Date.parse(UNTIL));
  // a full day's window would have stayed open to midnight
  assert.match(windowOpenIssue(dayWindow('2026-10-04'), new Date('2026-10-04T20:00:00-04:00')), /it closes 2026-10-04T23:59:59-04:00 ET/);
  assert.equal(windowOpenIssue(passWindow('2026-10-03'), new Date('2026-10-04T00:00:00-04:00')), null);
  // add: a date only counts as 18:00 ET (the until itself: inside); 18:30 is after the window
  const entry = (published, url) => ({ url, publication: 'Example Research', source_class: 'vendor_threat_research', headline: 'A fictional headline', published, paywalled: false, discovery_mode: 'search' });
  const ok = prepareAddEntries([entry('2026-10-04', 'https://research.example.com/2026/10/a'), entry('2026-10-04T17:59:00-04:00', 'https://research.example.com/2026/10/b')], { window: w });
  assert.deepEqual(ok.errors, []);
  const late = prepareAddEntries([entry('2026-10-04T18:30:00-04:00', 'https://research.example.com/2026/10/c')], { window: w });
  assert.match(late.errors[0], /published 2026-10-04T18:30:00-04:00 is outside the 2026-10-04 window \(2026-10-04T00:00:00-04:00 to 2026-10-04T18:00:00-04:00 ET\); a development first made public after the window is dropped BF_OUT_OF_WINDOW/);
  const corroborating = prepareAddEntries([entry('2026-10-04T18:30:00-04:00', 'https://research.example.com/2026/10/c')], { window: w, allowOutside: true });
  assert.deepEqual([corroborating.errors, corroborating.candidates[0].outside_window], [[], true]);
  // an item whose development came out after the until is never placed
  const after = makeCandidate({ url: 'https://research.example.com/2026/10/c', published: new Date('2026-10-04T18:30:00-04:00').toISOString(), published_date: '2026-10-04', published_precision: 'time' });
  const t = itemTiming({ sources: [{ url: after.url }] }, new Map([[normaliseUrl(after.url), after]]), w);
  assert.equal(t.slot, null);
  assert.match(t.issues.join(' '), /is outside the 2026-10-04 window.*no source is published inside the 2026-10-04 window \(2026-10-04T00:00:00-04:00 to 2026-10-04T18:00:00-04:00\); drop it BF_OUT_OF_WINDOW/);
  // until must be an edition slot inside the window
  assert.throws(() => windowUntil(dayWindow('2026-10-04'), '2026-10-04T17:30:00-04:00'), /is not an edition slot/);
  assert.throws(() => windowUntil(dayWindow('2026-10-04'), '2026-10-05T06:00:00-04:00'), /is not inside the 2026-10-04 window/);
  assert.throws(() => windowUntil(dayWindow('2026-10-04'), '2026-10-04T22:00:00Z'), /is not an ET ISO timestamp/);
  assert.equal(windowUntil(dayWindow('2026-10-04'), '2026-10-04T14:00:00-04:00').lastSlot.iso, '2026-10-04T14:00:00-04:00');
});

// ---------------------------------------------------------------- planPublish across pass keys

const FILTER_TEXT = fs.readFileSync(FILTER_FIXTURE, 'utf8');
const THRESHOLDS = loadThresholds(path.join(ROOT, 'tests', 'pipeline', 'fixtures', 'no-such-thresholds.json'));
const EMPTY_ARCHIVE = { schema_version: 1, items: [] };

const onDate = (date) => ({ published: new Date(`${date}T12:00:00.000Z`).toISOString(), published_date: date, published_precision: 'date' });
const bc = (url, date, o = {}) => makeCandidate({
  url, discovery_mode: 'search', outside_window: false, publication: 'Example Research', source_class: 'vendor_threat_research', ...onDate(date), ...o,
});
/** A live check made just now that verified the page (what publish's own checks record). */
const verified = (url) => ({ url, check_id: 'abcdef012345', status: 200, final_url: url, content_type: 'text/html; charset=utf-8', verified: true, verified_by: 'page', reason: 'ok', checked_at: toEtIso(new Date()), user_agent: USER_AGENT, retried: false, retry_status: null, redirects: 0, title: null });

/** A pass's first story: one capability-shift item on `date`. */
function story(key, date, slug, claim) {
  const c = bc(`https://research.example.com/${date}/${slug}`, date, { headline: `Fictional ${slug} report`, lead: `Fictional lead text for the ${slug} report.` });
  return { c, item: makeDraft([c], { claim }), j: (draftIndex) => judgment(c, { draft_index: draftIndex }) };
}

/** planPublish for a pass key with the given candidates, judgments and items (every source verified now). */
function plan(key, { candidates, judgments, items, archive = EMPTY_ARCHIVE, auditRows = null, appendMissing = false }) {
  const decisions = { run_id: `backfill-${key}`, threshold_level: 'high', judgments, items, notes: 'Fixture backfill.' };
  const urls = [...items.flatMap((it) => it.sources.map((s) => s.url))];
  return planPublish({
    decisions: structuredClone(decisions),
    candidates,
    archive,
    runs: { schema_version: 1, runs: [] },
    urlChecks: Object.fromEntries(urls.map((u) => [normaliseUrl(u), verified(u)])),
    urlHistory: {},
    auditRows,
    thresholds: THRESHOLDS,
    filterText: FILTER_TEXT,
    window: passWindow(key),
    sections: passSections(key),
    now: new Date(),
    appendMissing,
  });
}

const A = story('2026-10-01', '2026-10-01', 'loader-signing', 'A malware loader carried a stolen code-signing certificate past signature checks, researchers report.');
const B = story('2026-10-02', '2026-10-02', 'push-floods', 'Criminal kits now generate push-approval prompts at volume to defeat app-based MFA, researchers report.');
const C = story('2026-10-03', '2026-10-03', 'token-replay', 'Attackers replayed stolen session tokens against edge appliances in several sectors, researchers report.');
const single = (s) => ({ candidates: [s.c], judgments: [s.j(0)], items: [s.item] });

test('planPublish for day passes: ids and timestamps inside each day; run_id backfill-<day>', () => {
  const a = plan('2026-10-01', single(A));
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.newItems.map((i) => [i.id, i.timestamp, i.backfilled]), [['RS-261001-1800-01', '2026-10-01T18:00:00-04:00', true]]);
  assert.ok(a.logRows.every((r) => r.day === '2026-10-01' && !('month' in r)), 'audit rows keyed by the day');
  const wrongRun = planPublish({ ...{ decisions: { run_id: 'backfill-2026-10', threshold_level: 'high', judgments: [A.j(0)], items: [A.item] } }, candidates: [A.c], archive: EMPTY_ARCHIVE, thresholds: THRESHOLDS, filterText: FILTER_TEXT, window: passWindow('2026-10-01'), sections: SECTIONS });
  assert.match(wrongRun.errors.join('\n'), /run_id: "backfill-2026-10" must be "backfill-2026-10-01" for the 2026-10-01 pass/);
  // a candidate of the next day is outside this day's window
  const b = plan('2026-10-01', { candidates: [A.c, B.c], judgments: [A.j(0), B.j(1)], items: [A.item, B.item] });
  assert.match(b.errors.join('\n'), /items\[1\]: .*outside the 2026-10-01 window/);
  // the partial day publishes its date-only sources in the 18:00 slot
  const D = story('2026-10-04', '2026-10-04', 'relay-flaw', 'Attackers exploited a command injection flaw in a mail relay product across several sectors, researchers report.');
  const d = plan('2026-10-04', single(D));
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.newItems.map((i) => [i.id, i.timestamp]), [['RS-261004-1800-01', UNTIL]]);
});

test('per-key publish refusal: a day pass is refused only by its own items or audit log, never another day\'s', () => {
  const a = plan('2026-10-01', single(A));
  assert.deepEqual(a.errors, []);
  // the next day's pass is not blocked by the first day's items
  const b = plan('2026-10-02', { ...single(B), archive: a.nextArchive });
  assert.deepEqual(b.errors, []);
  assert.deepEqual(b.newItems.map((i) => i.id), ['RS-261002-1800-01']);
  const both = b.nextArchive;
  // each pass's second publish is refused, naming only its own items
  const againA = plan('2026-10-01', { ...single(A), archive: both });
  assert.match(againA.errors.join('\n'), /the 2026-10-01 backfill was already published \(1 backfilled item\(s\) in the window: RS-261001-1800-01\); refusing to publish twice/);
  assert.doesNotMatch(againA.errors.join('\n'), /RS-261002/);
  const againB = plan('2026-10-02', { ...single(B), archive: both });
  assert.match(againB.errors.join('\n'), /the 2026-10-02 backfill was already published \(1 backfilled item\(s\) in the window: RS-261002-1800-01\)/);
  assert.doesNotMatch(againB.errors.join('\n'), /RS-261001/);
  // neither blocks a third day, and its own audit log blocks only it
  const c = plan('2026-10-03', { ...single(C), archive: both });
  assert.deepEqual(c.errors, []);
  const logged = plan('2026-10-03', { ...single(C), archive: both, auditRows: [{ day: '2026-10-03', candidate_id: 'c-0000000000', verdict: 'drop' }] });
  assert.match(logged.errors.join('\n'), /the 2026-10-03 backfill was already published \(0 backfilled item\(s\) in the window; audit log present\)/);
  // --append-missing applies per key: the first day's own items are recognised, the second day's never counted
  const rows = a.logRows;
  const missing = plan('2026-10-01', { ...single(A), archive: both, auditRows: rows, appendMissing: true });
  assert.deepEqual([missing.errors, missing.nothingNew, missing.skipped.items], [[], true, [{ draft_index: 0, id: 'RS-261001-1800-01' }]]);
  // a month pass is independent of the day passes and the reverse
  const sept = story('2026-09', '2026-09-30', 'late-september', 'A ransomware crew abused a remote support tool to reach backup servers at several firms, researchers report.');
  const s = plan('2026-09', { ...single(sept), archive: both });
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.newItems.map((i) => [i.id, i.timestamp]), [['RS-260930-1800-01', '2026-09-30T18:00:00-04:00']]);
  assert.deepEqual(plan('2026-10-01', { ...single(A), archive: s.nextArchive }).errors.filter((e) => /already published/.test(e)).length, 1);
});

/** A material update on `date` of `target` (an RS id or a candidate id), plus a same-story repeat of it. */
function follow(date, target, { slug = 'follow-up', at = null } = {}) {
  // `at`: a stated publication time instead of the date only
  const when = at ? { published: new Date(at).toISOString(), published_date: etDateString(new Date(at)), published_precision: 'time' } : {};
  const upd = bc(`https://research.example.com/${date}/${slug}`, date, { headline: `Fictional ${slug} report`, lead: `Fictional lead for the ${slug} report.`, ...when });
  const rep = bc(`https://news.example.com/${date}/${slug}-repeat`, date, { publication: 'Example News', source_class: 'news', headline: `Fictional ${slug} repeat`, lead: 'Repeat.', ...when });
  const item = makeDraft([upd], {
    claim: 'The earlier campaign extended to a second product family with the same technique, researchers report.',
    domains: ['cyber'],
    interpretation: [{ domain: 'cyber', text: 'The exposure now spans a second product family, widening the set of systems the same technique reaches.' }],
    validation_question: 'Does the organisation track which product families in its estate are exposed to the campaign\'s technique?',
    candidate_issue_statement: 'Where exposure tracking covers only the first product family, systems in the second family could stay exposed and lead to compromise.',
    update_of: target,
  });
  return {
    candidates: [upd, rep],
    items: [item],
    judgments: [
      judgment(upd, { dedup: 'material_update', match_id: target, reason: '[M1] second product family affected; C1 C3 hold', draft_index: 0 }),
      judgment(rep, { verdict: 'drop', reason_code: 'DD_SAME_STORY', dedup: 'same_story_dropped', match_id: target, reason: 'repeats the earlier campaign story', draft_index: null }),
    ],
  };
}

test('cross-pass references: update_of and DD_SAME_STORY may name an earlier pass\'s backfilled item, never a later pass\'s', () => {
  const a = plan('2026-10-01', single(A));
  assert.deepEqual(a.errors, []);
  // the next day updates and repeats the first day's item, by its id
  const ok = plan('2026-10-02', { ...follow('2026-10-02', 'RS-261001-1800-01'), archive: a.nextArchive });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.newItems.map((i) => [i.id, i.update_of]), [['RS-261002-1800-01', 'RS-261001-1800-01']]);
  assert.deepEqual(ok.logRows.filter((r) => r.judged).map((r) => [r.dedup, r.match_id]), [['material_update', 'RS-261001-1800-01'], ['same_story_dropped', 'RS-261001-1800-01']]);
  // across months: September updates a January item; October updates a September one
  const jan = { id: 'RS-260120-0600-01', timestamp: '2026-01-20T06:00:00-05:00', backfilled: true };
  const janArchive = { schema_version: 1, items: [{ ...a.nextArchive.items[0], ...jan, sources: [{ publication: 'Example Research', url: 'https://research.example.com/2026-01-20/january' }] }] };
  const sep = plan('2026-09', { ...follow('2026-09-15', jan.id, { slug: 'sep-follow' }), archive: janArchive });
  assert.deepEqual(sep.errors, []);
  assert.equal(sep.newItems[0].update_of, jan.id);
  const oct = plan('2026-10-03', { ...follow('2026-10-03', sep.newItems[0].id, { slug: 'oct-follow' }), archive: sep.nextArchive });
  assert.deepEqual(oct.errors, []);
  assert.equal(oct.newItems[0].update_of, 'RS-260915-1800-01');

  // a later pass's item is refused (passes published out of order: 2 October first, then 1 October)
  const b = plan('2026-10-02', single(B));
  assert.deepEqual(b.errors, []);
  const back = plan('2026-10-01', { ...follow('2026-10-01', 'RS-261002-1800-01', { slug: 'back-ref' }), archive: b.nextArchive });
  const errs = back.errors.join('\n');
  assert.match(errs, /items\[0\]: update_of: RS-261002-1800-01 \(2026-10-02T18:00:00-04:00\) is an item of the later 2026-10-02 pass; a pass references only backfilled items of earlier passes or of its own, never a later pass's/);
  assert.match(errs, /judgments\[0\] .*match_id: RS-261002-1800-01 \(2026-10-02T18:00:00-04:00\) is an item of the later 2026-10-02 pass/);
  assert.match(errs, /judgments\[1\] .*match_id: RS-261002-1800-01 .*is an item of the later 2026-10-02 pass/, 'DD_SAME_STORY too');
  // a month pass never names a day pass's item either
  const fromSep = plan('2026-09', { ...follow('2026-09-20', 'RS-261002-1800-01', { slug: 'sep-back' }), archive: b.nextArchive });
  assert.match(fromSep.errors.join('\n'), /update_of: RS-261002-1800-01 .*is an item of the later 2026-10-02 pass/);

  // the target's slot must still be strictly earlier than the candidate's own: a 09:30 follow-up
  // cannot update or repeat its own pass's 18:00 item (an earlier publish of 2 October)
  const same = plan('2026-10-02', { ...follow('2026-10-02', 'RS-261002-1800-01', { slug: 'same-day', at: '2026-10-02T09:30:00-04:00' }), archive: b.nextArchive, appendMissing: true });
  const sameErrs = same.errors.join('\n');
  assert.match(sameErrs, /update_of: RS-261002-1800-01 is not earlier than this item \(2026-10-02T10:00:00-04:00\)/);
  assert.match(sameErrs, /match_id: RS-261002-1800-01 \(2026-10-02T18:00:00-04:00\) is not earlier than this candidate's own slot 2026-10-02T10:00:00-04:00/);
  assert.doesNotMatch(sameErrs, /later 2026-10-02 pass/, 'its own pass is not a later pass');
  // a follow-up dated the day before belongs to that day's pass, not this one
  const dayBefore = plan('2026-10-02', { ...follow('2026-10-01', 'RS-261001-1800-01', { slug: 'day-before' }), archive: a.nextArchive });
  assert.match(dayBefore.errors.join('\n'), /outside the 2026-10-02 window/);
  // an earlier pass's item is named by its id; its candidate id is not this pass's
  const byCand = plan('2026-10-02', { ...follow('2026-10-02', A.c.candidate_id, { slug: 'by-cand' }), archive: a.nextArchive });
  assert.match(byCand.errors.join('\n'), new RegExp(`update_of: ${A.c.candidate_id} is not a candidate of any item of this batch or of an earlier publish of 2026-10-02; name an item of an earlier pass by its id \\(RS-YYMMDD-HHMM-NN\\)`));
});

// ---------------------------------------------------------------- CLI: month passes 2026-02 to 2026-09

test('CLI: every month pass 2026-02 to 2026-09 is accepted (add, temp work dirs); October as a month is not', () => {
  const dir = tempDir('rs-bf-months-');
  try {
    const seen = path.join(dir, 'seen.json');
    writeJson(seen, { schema_version: 1, urls: {} });
    for (const m of MONTHS.slice(1)) {
      const work = path.join(dir, `backfill-${m}`);
      const file = path.join(dir, `found-${m}.json`);
      writeJson(file, [{ url: `https://research.example.com/${m}/finding`, publication: 'Example Research', source_class: 'vendor_threat_research', headline: `A fictional finding of ${m}`, published: `${m}-15`, paywalled: false, discovery_mode: 'search' }]);
      const flags = ['--month', m, '--work-dir', work, '--seen', seen, '--sources', path.join(ROOT, 'pipeline', 'sources.json'), '--now', '2026-10-04T12:00:00-04:00'];
      const r = runScript('backfill', ['add', ...flags, '--file', file]);
      assert.equal(r.status, 0, `${m}: ${r.stderr}`);
      const doc = readJson(path.join(work, 'candidates.json'));
      assert.deepEqual([doc.month, doc.window.since.slice(0, 10), doc.window.last_slot.slice(0, 10), doc.candidates.length], [m, `${m}-01`, passWindow(m).lastDate, 1], m);
      // a date outside the month is refused
      writeJson(file, [{ url: `https://research.example.com/${m}/other`, publication: 'Example Research', source_class: 'vendor_threat_research', headline: 'Another fictional finding', published: '2026-01-15', paywalled: false, discovery_mode: 'search' }]);
      const out = runScript('backfill', ['add', ...flags, '--file', file]);
      assert.equal(out.status, 1, m);
      assert.match(out.stderr, new RegExp(`outside the ${m} window`), m);
    }
    const oct = runScript('backfill', ['add', '--month', '2026-10', '--work-dir', path.join(dir, 'oct'), '--file', path.join(dir, 'none.json')]);
    assert.equal(oct.status, 2);
    assert.match(oct.stderr, /no backfill pass is defined for 2026-10/);
    assert.equal(fs.existsSync(path.join(dir, 'oct')), false, 'nothing written');
  } finally {
    rmrf(dir);
  }
});

// ---------------------------------------------------------------- CLI: day passes (--day)

const MOCK = pathToFileURL(path.join(FIXTURES, 'backfill-mock-fetch.mjs')).href;
const KEV_MOCK = 'https://kev.example.com/known_exploited_vulnerabilities.json';
const AFTER = '2026-10-04T18:30:00-04:00';

/** A temp data set (empty archive, no runs) shared by the passes of one test. */
function dayWorkspace() {
  const dir = tempDir('rs-bf-days-');
  const p = {
    dir,
    routes: {},
    archive: path.join(dir, 'docs', 'data', 'archive.json'),
    runs: path.join(dir, 'docs', 'data', 'runs.json'),
    seen: path.join(dir, 'pipeline', 'state', 'seen.json'),
    logs: path.join(dir, 'pipeline', 'logs'),
  };
  writeJson(p.archive, EMPTY_ARCHIVE);
  writeJson(p.runs, { schema_version: 1, runs: [] });
  writeJson(p.seen, { schema_version: 1, urls: {} });
  p.work = (key) => path.join(dir, 'pipeline', 'work', `backfill-${key}`);
  p.flags = (key, flag = '--day', work = p.work(key)) => [flag, key, '--archive', p.archive, '--runs', p.runs, '--seen', p.seen, '--logs-dir', p.logs,
    '--work-dir', work, '--filter', FILTER_FIXTURE, '--thresholds', path.join(dir, 'thresholds.json'), '--sources', path.join(ROOT, 'pipeline', 'sources.json')];
  p.logFile = (key) => path.join(p.logs, 'backfill', `${key}.jsonl`);
  return p;
}

/** backfill.mjs with the fetch mock serving the workspace's routes. */
function runDay(ws, args) {
  const routesFile = path.join(ws.dir, 'mock-routes.json');
  writeJson(routesFile, ws.routes);
  const r = spawnSync(process.execPath, ['--import', MOCK, path.join(SCRIPTS, 'backfill.mjs'), ...args], {
    encoding: 'utf8', cwd: ROOT, env: { ...process.env, RS_BACKFILL_MOCK_FETCH: routesFile }, timeout: 60000,
  });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { json = null; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const finding = (url, published, headline, o = {}) => ({ url, publication: 'Example Research', source_class: 'vendor_threat_research', headline, lead: `Fictional lead: ${headline}.`, published, paywalled: false, discovery_mode: 'search', ...o });
const pageFor = (c) => ({ status: 200, type: 'text/html; charset=utf-8', body: `<!doctype html><html><head><title>${c.headline} | ${c.publication}</title></head><body><main><h1>${c.headline}</h1><p>${c.lead}</p></main></body></html>` });

/** add the findings to a pass through the CLI; serve their pages; return the registered candidates. */
function addFindings(ws, key, findings, now = AFTER, flag = '--day') {
  const file = path.join(ws.dir, `found-${key}.json`);
  writeJson(file, findings);
  const r = runDay(ws, ['add', ...ws.flags(key, flag), '--now', now, '--file', file]);
  assert.equal(r.status, 0, `${key}: ${r.stderr}`);
  const cands = readJson(path.join(ws.work(key), 'candidates.json')).candidates;
  for (const c of cands) ws.routes[c.url] = pageFor(c);
  return findings.map((f) => cands.find((c) => c.url === f.url));
}

test('CLI --day: every day pass is accepted; one pass key, the right flag; work files keyed by the day', () => {
  const ws = dayWorkspace();
  try {
    for (const day of DAYS) {
      const [c] = addFindings(ws, day, [finding(`https://research.example.com/${day}/finding`, day, `A fictional finding of ${day}`)]);
      const doc = readJson(path.join(ws.work(day), 'candidates.json'));
      assert.equal(doc.day, day);
      assert.ok(!('month' in doc), `${day}: no month field`);
      assert.deepEqual(doc.window, windowDoc(passWindow(day)), day);
      assert.equal(c.published_date, day);
    }
    // a date outside the day is refused
    const file = path.join(ws.dir, 'outside.json');
    writeJson(file, [finding('https://research.example.com/2026-10-02/outside', '2026-10-01', 'A fictional finding of the day before')]);
    const before = runDay(ws, ['add', ...ws.flags('2026-10-02'), '--now', AFTER, '--file', file]);
    assert.equal(before.status, 1);
    assert.match(before.stderr, /published 2026-10-01 is outside the 2026-10-02 window .*before the window is dropped BF_OUT_OF_WINDOW/);
    // usage: exactly one of --month or --day; each takes only its own shape; only listed passes
    const usage = (args, re) => {
      const r = runDay(ws, ['add', ...args, '--work-dir', path.join(ws.dir, 'never'), '--file', file]);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, re, args.join(' '));
    };
    usage([], /a pass key is required: --month YYYY-MM or --day YYYY-MM-DD/);
    usage(['--month', '2026-09', '--day', '2026-10-01'], /use one of --month or --day, not both/);
    usage(['--month', '2026-10-01'], /--month: "2026-10-01" is not YYYY-MM/);
    usage(['--day', '2026-10'], /--day: "2026-10" is not YYYY-MM-DD/);
    usage(['--day', '2026-10-05'], /no backfill pass is defined for 2026-10-05 .*run a pass only when the owner asks for that day/);
    usage(['--day', '2026-09-30'], /no backfill pass is defined for 2026-09-30/);
    usage(['--day', '2026-02-30'], /--day: "2026-02-30" is not YYYY-MM-DD/);
    assert.equal(fs.existsSync(path.join(ws.dir, 'never')), false, 'nothing written');
    // a pass never uses another pass's work files: another day's or a month's
    const inside = (date) => {
      const f = path.join(ws.dir, `inside-${date}.json`);
      writeJson(f, [finding(`https://research.example.com/${date}/inside`, date, `A fictional finding inside ${date}`)]);
      return f;
    };
    const otherDay = runDay(ws, ['add', ...ws.flags('2026-10-02', '--day', ws.work('2026-10-01')), '--now', AFTER, '--file', inside('2026-10-02')]);
    assert.equal(otherDay.status, 1);
    assert.match(otherDay.stderr, /candidates\.json: day "2026-10-01" is not the 2026-10-02 pass; use the pass's own --work-dir/);
    const month = runDay(ws, ['add', ...ws.flags('2026-09', '--month', ws.work('2026-10-01')), '--now', AFTER, '--file', inside('2026-09-15')]);
    assert.equal(month.status, 1);
    assert.match(month.stderr, /candidates\.json: day "2026-10-01" is not the 2026-09 pass/);
    assert.equal(readJson(path.join(ws.work('2026-10-01'), 'candidates.json')).candidates.length, 1, 'the other pass\'s file is untouched');
    writeJson(path.join(ws.work('2026-10-03'), 'url-check.json'), { schema_version: 1, month: '2026-10-03', updated_at: null, checks: {} });
    const wrongField = runDay(ws, ['verify-urls', ...ws.flags('2026-10-03'), '--candidates']);
    assert.equal(wrongField.status, 1);
    assert.match(wrongField.stderr, /url-check\.json: month "2026-10-03" is not the 2026-10-03 pass/, 'a day key in the month field is refused');
  } finally {
    rmrf(ws.dir);
  }
});

test('CLI --day 2026-10-04: refused until 18:00 ET; 17:59 and date-only take the 18:00 slot; 18:01 is out; keyed by the day', () => {
  const ws = dayWorkspace();
  const day = '2026-10-04';
  try {
    // collect: KEV entries added that day only, and only once the window has ended
    ws.routes[KEV_MOCK] = { status: 200, type: 'application/json', body: JSON.stringify({ vulnerabilities: [
      { cveID: 'CVE-2026-0103', vendorProject: 'Example', product: 'Gateway', vulnerabilityName: 'Example Gateway Flaw', dateAdded: '2026-10-03', shortDescription: 'A fictional flaw.' },
      { cveID: 'CVE-2026-0104', vendorProject: 'Example', product: 'Relay', vulnerabilityName: 'Example Relay Flaw', dateAdded: day, shortDescription: 'A fictional flaw.' },
    ] }) };
    const collect = (now) => runDay(ws, ['collect', ...ws.flags(day, '--day', path.join(ws.dir, 'kev-work')), '--now', now, '--only', 'kev', '--kev-url', KEV_MOCK]);
    const early = collect('2026-10-04T17:30:00-04:00');
    assert.equal(early.status, 1);
    assert.match(early.stderr, /the 2026-10-04 window has not ended \(it ends at 2026-10-04T18:00:00-04:00 ET, the last edition slot this pass covers; the live routine covers what follows\); a backfill covers history only/);
    assert.equal(fs.existsSync(path.join(ws.dir, 'kev-work')), false, 'nothing written');
    const kev = collect(AFTER);
    assert.equal(kev.status, 0, kev.stderr);
    assert.equal(kev.json.day, day);
    assert.equal(kev.json.window.until, UNTIL);
    assert.equal(kev.json.window.ends_early, true);
    assert.deepEqual(readJson(path.join(ws.dir, 'kev-work', 'candidates.json')).candidates.map((c) => c.kev.cve), ['CVE-2026-0104']);

    // add: the until bounds the window (a date only counts as 18:00 ET, inside)
    const [dated, at1759] = addFindings(ws, day, [
      finding('https://research.example.com/2026-10-04/date-only', day, 'A fictional date-only report'),
      finding('https://research.example.com/2026-10-04/at-1759', '2026-10-04T17:59:00-04:00', 'A fictional report at 17:59'),
    ]);
    const lateFile = path.join(ws.dir, 'late.json');
    writeJson(lateFile, [finding('https://research.example.com/2026-10-04/at-1801', '2026-10-04T18:01:00-04:00', 'A fictional report at 18:01')]);
    const late = runDay(ws, ['add', ...ws.flags(day), '--now', AFTER, '--file', lateFile]);
    assert.equal(late.status, 1);
    assert.match(late.stderr, /published 2026-10-04T18:01:00-04:00 is outside the 2026-10-04 window \(2026-10-04T00:00:00-04:00 to 2026-10-04T18:00:00-04:00 ET\); a development first made public after the window is dropped BF_OUT_OF_WINDOW/);

    writeJson(path.join(ws.work(day), 'decisions.json'), {
      run_id: `backfill-${day}`,
      threshold_level: 'high',
      judgments: [judgment(dated, { draft_index: 0 }), judgment(at1759, { draft_index: 1 })],
      items: [makeDraft([dated]), makeDraft([at1759], { claim: 'Criminal kits now generate push-approval prompts at volume to defeat app-based MFA, researchers report.' })],
      notes: 'Fixture backfill.',
    });
    // publish: not before the until has passed (the until itself is inside the window)
    for (const now of ['2026-10-04T17:59:00-04:00', UNTIL]) {
      const r = runDay(ws, ['publish', ...ws.flags(day), '--now', now, '--dry-run']);
      assert.equal(r.status, 1, now);
      assert.match(r.stderr, /the 2026-10-04 window has not ended \(it ends at 2026-10-04T18:00:00-04:00 ET/, now);
    }
    const before = fs.readFileSync(ws.archive, 'utf8');
    const dry = runDay(ws, ['publish', ...ws.flags(day), '--now', '2026-10-04T18:00:01-04:00', '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual([dry.json.day, 'month' in dry.json, dry.json.items], [day, false, ['RS-261004-1800-01', 'RS-261004-1800-02']]);
    assert.deepEqual(dry.json.would_write, [ws.logFile(day), ws.archive]);
    assert.equal(fs.readFileSync(ws.archive, 'utf8'), before, 'dry run: archive untouched');
    assert.equal(fs.existsSync(ws.logFile(day)), false, 'dry run: no audit log');

    const pub = runDay(ws, ['publish', ...ws.flags(day), '--now', AFTER]);
    assert.equal(pub.status, 0, pub.stderr);
    assert.equal(pub.json.day, day);
    const items = readJson(ws.archive).items;
    assert.deepEqual(items.map((i) => [i.id, i.timestamp, i.backfilled]), [['RS-261004-1800-01', UNTIL, true], ['RS-261004-1800-02', UNTIL, true]]);
    const rows = fs.readFileSync(ws.logFile(day), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows.length === 2 && rows.every((x) => x.day === day && !('month' in x)), 'audit rows keyed by the day');
    const uc = readJson(path.join(ws.work(day), 'url-check.json'));
    assert.deepEqual([uc.day, 'month' in uc], [day, false]);
    assert.match(pub.stderr, /owner instruction: 2026-10-04 15:57 ET/);

    // the same key again is refused; --append-missing finds nothing new
    const again = runDay(ws, ['publish', ...ws.flags(day), '--now', AFTER]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /the 2026-10-04 backfill was already published \(2 backfilled item\(s\) in the window: RS-261004-1800-01, RS-261004-1800-02; audit log present\)/);
    const missing = runDay(ws, ['publish', ...ws.flags(day), '--now', AFTER, '--append-missing']);
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stderr, /--append-missing: nothing new to publish for 2026-10-04/);

    // whole-archive validation accepts the day pass's items
    const v = runScript('validate', ['--archive', ws.archive, '--runs', ws.runs, '--seen', ws.seen, '--thresholds', path.join(ws.dir, 'thresholds.json'), '--strict-lint']);
    assert.equal(v.status, 0, v.stderr);
  } finally {
    rmrf(ws.dir);
  }
});

test('CLI day passes in key order: own log and refusal per day; a later day updates an earlier day\'s item by id', () => {
  const ws = dayWorkspace();
  try {
    const [a] = addFindings(ws, '2026-10-01', [finding('https://research.example.com/2026-10-01/loader', '2026-10-01T09:15:00-04:00', 'A fictional loader report')]);
    writeJson(path.join(ws.work('2026-10-01'), 'decisions.json'), {
      run_id: 'backfill-2026-10-01', threshold_level: 'high', judgments: [judgment(a, { draft_index: 0 })], items: [makeDraft([a])], notes: 'Fixture backfill.',
    });
    const one = runDay(ws, ['publish', ...ws.flags('2026-10-01'), '--now', AFTER]);
    assert.equal(one.status, 0, one.stderr);
    assert.deepEqual(one.json.items, ['RS-261001-1000-01']);

    // 2 October: a material update of the 1 October item and a same-story repeat, both by its id
    const f = follow('2026-10-02', 'RS-261001-1000-01');
    const registered = addFindings(ws, '2026-10-02', f.candidates.map((c) => finding(c.url, '2026-10-02', c.headline, { publication: c.publication, source_class: c.source_class, lead: c.lead })));
    const idOf = new Map(f.candidates.map((c, k) => [c.candidate_id, registered[k].candidate_id]));
    assert.deepEqual([...idOf.keys()], [...idOf.values()], 'candidate ids follow the URL');
    writeJson(path.join(ws.work('2026-10-02'), 'decisions.json'), {
      run_id: 'backfill-2026-10-02', threshold_level: 'high', judgments: f.judgments, items: f.items, notes: 'Fixture backfill.',
    });
    const two = runDay(ws, ['publish', ...ws.flags('2026-10-02'), '--now', AFTER]);
    assert.equal(two.status, 0, two.stderr);
    const items = readJson(ws.archive).items;
    assert.deepEqual(items.map((i) => [i.id, i.update_of]), [['RS-261001-1000-01', null], ['RS-261002-1800-01', 'RS-261001-1000-01']]);
    assert.deepEqual(fs.readdirSync(path.join(ws.logs, 'backfill')).sort(), ['2026-10-01.jsonl', '2026-10-02.jsonl']);

    // the first day again is refused for its own item only; the third day is not blocked
    const again = runDay(ws, ['publish', ...ws.flags('2026-10-01'), '--now', AFTER]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /the 2026-10-01 backfill was already published \(1 backfilled item\(s\) in the window: RS-261001-1000-01; audit log present\)/);
    assert.doesNotMatch(again.stderr, /RS-261002/);
    const [c] = addFindings(ws, '2026-10-03', [finding('https://research.example.com/2026-10-03/edge', '2026-10-03', 'A fictional edge appliance report')]);
    writeJson(path.join(ws.work('2026-10-03'), 'decisions.json'), {
      run_id: 'backfill-2026-10-03', threshold_level: 'high', judgments: [judgment(c, { draft_index: 0 })],
      items: [makeDraft([c], { claim: 'Attackers replayed stolen session tokens against edge appliances in several sectors, researchers report.' })], notes: 'Fixture backfill.',
    });
    const three = runDay(ws, ['publish', ...ws.flags('2026-10-03'), '--now', AFTER, '--dry-run']);
    assert.equal(three.status, 0, three.stderr);
    assert.deepEqual(three.json.items, ['RS-261003-1800-01']);
  } finally {
    rmrf(ws.dir);
  }
});
