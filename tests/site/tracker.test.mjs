// Tracker demo (docs/assets/tracker.js; owner decisions 2026-11-19, SPEC §7.6): notifications
// follow the archive's read-across, the seeded example is deterministic, the reducer is pure and
// logs what matters, the filters narrow the register, the page says it is a demo with a fictional
// institution, and every data-derived string is escaped.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../../docs/assets/model.js';
import * as V from '../../docs/assets/view.js';
import * as T from '../../docs/assets/tracker.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const NOW = new Date('2026-10-02T15:00:00-04:00');
const TODAY = '2026-10-02';
const data = M.prepare(fixture('archive.json'), fixture('runs.json'));
const ui = (patch = {}) => ({ ...M.defaultUi(NOW), ...patch });
const render = (trk, d = data) => V.renderApp({ ui: ui({ page: 'tracker' }), data: d, now: NOW, error: null, loading: false, trk }).replace(/>\s+</g, '><');
const act = (trk, d, value) => T.trackerAct(trk, d, value, data);

describe('Tracker demo', () => {
  test('one notification per read-across entry, routed to that domain’s owner, newest first', () => {
    const notes = T.notifications(data);
    const expected = data.items.reduce((n, it) => n + it.interpretation.length, 0);
    assert.equal(notes.length, expected);
    for (const x of notes) {
      const it = data.byId.get(x.itemId);
      assert.ok(it.interpretation.some((r) => r.domain === x.domain && r.text === x.text));
      assert.ok(T.OWNERS.some((o) => o.domain === x.domain));
    }
    const dates = notes.map((x) => x.date);
    assert.deepEqual(dates, [...dates].sort().reverse());
    assert.equal(new Set(notes.map((x) => x.key)).size, notes.length, 'keys are unique');
    assert.deepEqual(T.notifications(null), []);
  });

  test('every domain has an owner role; no person is named', () => {
    assert.deepEqual(T.OWNERS.map((o) => o.domain), M.DOMAINS.map((d) => d.key));
    for (const o of T.OWNERS) assert.match(o.role, /^Head of /);
  });

  test('seeding is deterministic, starts with unread notifications, and puts gaps only on items that ask for action', () => {
    const a = T.initTracker(data, TODAY);
    assert.deepEqual(a, T.initTracker(data, TODAY));
    const notes = T.notifications(data);
    for (const o of T.OWNERS) {
      const mine = notes.filter((x) => x.domain === o.domain);
      mine.slice(0, 2).forEach((x) => assert.equal(T.stateOf(a.resp[x.key]), 'new'));
    }
    for (const x of notes) {
      const r = a.resp[x.key];
      if (r.control === 'none' || r.control === 'partial') assert.notEqual(x.mechanism, 'awareness_only');
      if (x.mechanism === 'awareness_only' && r.read) assert.equal(r.control, 'na');
    }
  });

  test('recommendations start with what the item asks, then the domain playbook', () => {
    const ci = data.items.find((it) => it.mechanism === 'candidate_issue');
    const recs = T.recommendations(ci, ci.domains[0]);
    assert.ok(recs[0].includes(ci.validation_question));
    assert.ok(recs[1].includes(ci.candidate_issue_statement));
    assert.deepEqual(recs.slice(2), T.PLAYBOOK[ci.domains[0]]);
    for (const list of Object.values(T.PLAYBOOK)) for (const t of list) assert.ok(!/\b(we|our|us|I|my)\b/.test(t), `first person: ${t}`);
  });

  test('the reducer: open marks read, a control answer with a gap takes a plan, steps cycle, close the gap, reset restores', () => {
    let t = T.initTracker(data, TODAY);
    const x = T.notifications(data)[0];
    t = act(t, { act: 'trk-owner', v: x.domain });
    t = act(t, { act: 'trk-open', key: x.key });
    assert.equal(t.sel, x.key);
    assert.equal(T.stateOf(t.resp[x.key]), 'open');
    assert.equal(act(t, { act: 'trk-control', key: x.key, v: 'bogus' }), t, 'unknown answers are ignored');
    t = act(t, { act: 'trk-control', key: x.key, v: 'none' });
    assert.equal(T.stateOf(t.resp[x.key]), 'gap');
    t = act(t, { act: 'trk-add', key: x.key, rec: '0' });
    t = act(t, { act: 'trk-draft' }, '  Own step  ');
    t = act(t, { act: 'trk-add', key: x.key });
    assert.equal(t.draft, '');
    const steps = t.resp[x.key].steps;
    assert.equal(steps.length, 2);
    assert.equal(steps[1].text, 'Own step');
    assert.equal(act(t, { act: 'trk-add', key: x.key }), t, 'an empty draft adds nothing');
    for (const s of steps) {
      t = act(t, { act: 'trk-status', key: x.key, step: s.id });
      t = act(t, { act: 'trk-status', key: x.key, step: s.id });
    }
    assert.equal(T.stateOf(t.resp[x.key]), 'closed');
    assert.equal(act(t, { act: 'trk-step', f: 'due', key: x.key, step: steps[0].id }, '2026-1'), t, 'a partial date is ignored');
    t = act(t, { act: 'trk-remove', key: x.key, step: steps[0].id });
    assert.equal(t.resp[x.key].steps.length, 1);
    t = act(t, { act: 'trk-disp', f: 'disposition', key: x.key }, 'mitigated');
    assert.equal(T.stateOf(t.resp[x.key]), 'covered');
    const reset = act(t, { act: 'trk-reset' });
    assert.deepEqual(reset.resp, T.initTracker(data, TODAY).resp);
    assert.equal(reset.owner, x.domain, 'reset keeps the view');
  });

  test('overdue counts only unfinished steps past their due date', () => {
    const t = T.initTracker(data, TODAY);
    const sum = T.ownerSummary(t, data);
    const all = Object.values(t.resp).flatMap((r) => r.steps);
    const late = all.filter((s) => s.status !== 'done' && s.due < TODAY).length;
    assert.equal(sum.reduce((n, o) => n + o.late, 0), late);
    assert.ok(late > 0, 'the seeded example shows an overdue step');
  });

  test('page: in the nav, labelled a demo with a fictional institution, overview, inbox and detail views', () => {
    const t = T.initTracker(data, TODAY);
    const html = render(t);
    assert.ok(html.includes('data-page="tracker"'), 'in the nav');
    assert.ok(html.includes('class="trk-demo">Demo<'));
    assert.ok(html.includes(T.DEMO_ORG) && html.includes('Nothing is saved or sent'));
    assert.equal((html.match(/class="trk-owner-card"/g) || []).length, T.OWNERS.length);
    const x = T.notifications(data)[0];
    const inbox = render(act(t, { act: 'trk-owner', v: x.domain }));
    assert.ok(inbox.includes(`data-key="${x.key}"`));
    let d = act(act(t, { act: 'trk-owner', v: x.domain }), { act: 'trk-open', key: x.key });
    d = act(d, { act: 'trk-control', key: x.key, v: 'partial' });
    const page = render(d);
    assert.ok(page.includes('Recommended to close the gap') && page.includes('Remediation plan'));
    assert.ok(page.includes(`href="#${x.itemId}"`), 'links back to the item');
    const mitigated = act(act(d, { act: 'trk-control', key: x.key, v: 'in_place' }), { act: 'trk-disp', f: 'disposition', key: x.key }, 'mitigated');
    assert.ok(!render(mitigated).includes('Remediation plan'), 'no plan once a control mitigates it');
    assert.equal(V.PAGE_TITLES.tracker, 'Risk Tracker · Readiness Signal');
    assert.match(html, /data-page="tracker"[^>]*>Risk Tracker<\/a>/, 'the nav label is Risk Tracker');
    assert.deepEqual(M.parseHash('#tracker'), { page: 'tracker' });
    assert.ok(render(null).includes('<h1 class="h1">Risk Tracker</h1>'), 'renders before the demo is seeded');
  });

  test('escapes every data-derived string, including what the viewer types', () => {
    const EVIL = '<img src=x onerror="alert(1)">';
    const bad = M.prepare({ items: [{
      id: 'RS-261002-1400-09', timestamp: '2026-10-02T14:00:00-04:00', section: 'capability_shift', claim: `Claim ${EVIL}`,
      domains: ['cyber'], source_class: 'news', mechanism: 'candidate_issue', interpretation: [{ domain: 'cyber', text: `Read ${EVIL}` }],
      validation_question: `Q ${EVIL}?`, candidate_issue_statement: `Where ${EVIL}, harm follows.`, awareness_rationale: null,
      sources: [{ publication: 'Pub', url: 'https://example.com/a' }], backfilled: false, update_of: null,
    }] }, { runs: [] });
    let t = T.initTracker(bad, TODAY);
    const key = T.notifications(bad)[0].key;
    t = T.trackerAct(t, { act: 'trk-owner', v: 'cyber' }, undefined, bad);
    t = T.trackerAct(t, { act: 'trk-open', key }, undefined, bad);
    t = T.trackerAct(t, { act: 'trk-control', key, v: 'none' }, undefined, bad);
    t = T.trackerAct(t, { act: 'trk-ref', key }, EVIL, bad);
    t = T.trackerAct(t, { act: 'trk-disp', f: 'rootCause', key }, EVIL, bad);
    t = T.trackerAct(t, { act: 'trk-disp', f: 'issueId', key }, EVIL, bad, { type: 'change', at: EVIL });
    t = T.trackerAct(t, { act: 'trk-filter', f: 'q' }, '', bad);
    t = T.trackerAct(t, { act: 'trk-draft' }, EVIL, bad);
    t = T.trackerAct(t, { act: 'trk-add', key, rec: '0' }, undefined, bad);
    t = T.trackerAct({ ...t, preview: true }, { act: 'trk-draft' }, EVIL, bad);
    const html = render(t, bad);
    assert.ok(!html.includes('<img'), 'no raw markup');
    assert.ok(html.includes('&lt;img src=x'));
  });

  test('answering the control question suggests a disposition; the owner can change it', () => {
    let t = T.initTracker(data, TODAY);
    const x = T.notifications(data)[0];
    const r = (tt) => tt.resp[x.key];
    t = act(t, { act: 'trk-control', key: x.key, v: 'none' });
    assert.equal(r(t).disp.disposition, 'issue_raised');
    assert.equal(r(t).disp.identified, TODAY);
    assert.equal(r(t).disp.issueOwner, T.OWNERS.find((o) => o.domain === x.domain).role, 'the notified owner is accountable by default');
    t = act(t, { act: 'trk-control', key: x.key, v: 'in_place' });
    assert.equal(r(t).disp.disposition, 'issue_raised', 'a decision is never overwritten by a later answer');
    t = act(t, { act: 'trk-disp', f: 'disposition', key: x.key }, 'risk_accepted');
    assert.equal(T.stateOf(r(t)), 'accepted');
    assert.equal(act(t, { act: 'trk-disp', f: 'disposition', key: x.key }, 'bogus'), t);
    assert.equal(act(t, { act: 'trk-disp', f: 'rating', key: x.key }, 'red'), t, 'ratings come from the closed list');
    assert.equal(act(t, { act: 'trk-disp', f: 'notAField', key: x.key }, 'x'), t);
    assert.equal(act(t, { act: 'trk-disp', f: 'acceptExpiry', key: x.key }, '2027-13'), t, 'a partial date is ignored');
  });

  test('the activity log records decisions and committed edits, never each keystroke', () => {
    let t = T.initTracker(data, TODAY);
    const x = T.notifications(data)[0];
    const log = () => t.resp[x.key].log.map((e) => e.text);
    t = act(t, { act: 'trk-open', key: x.key });
    t = act(t, { act: 'trk-control', key: x.key, v: 'partial' });
    const n = log().length;
    t = T.trackerAct(t, { act: 'trk-disp', f: 'title', key: x.key }, 'Gap in', data, { type: 'input' });
    t = T.trackerAct(t, { act: 'trk-disp', f: 'title', key: x.key }, 'Gap in coverage', data, { type: 'input' });
    assert.equal(log().length, n, 'typing is not logged');
    t = T.trackerAct(t, { act: 'trk-disp', f: 'title', key: x.key }, 'Gap in coverage', data, { type: 'change', at: 'Thu 19 Nov 2026, 15:00 ET' });
    assert.equal(t.resp[x.key].disp.title, 'Gap in coverage');
    assert.deepEqual(t.resp[x.key].log.at(-1), { at: 'Thu 19 Nov 2026, 15:00 ET', text: 'Issue title updated.' });
    const again = T.trackerAct(t, { act: 'trk-disp', f: 'title', key: x.key }, 'Gap in coverage', data, { type: 'change' });
    assert.equal(again.resp[x.key].log.length, t.resp[x.key].log.length, 'one edit committed twice is logged once');
    assert.ok(log().includes('Notification read.') && log().some((l) => l.startsWith('Control answer')) && log().some((l) => l.startsWith('Disposition set')));
  });

  test('filters: domain, time window, date range, status, disposition, what it asks, rating, search; clear', () => {
    const base = T.initTracker(data, TODAY);
    const all = T.notifications(data);
    const f = (patch, owner = 'all') => T.register({ ...base, owner, f: { ...base.f, ...patch } }, data);
    assert.equal(f({}).length, all.length);
    const dom = all[0].domain;
    assert.ok(f({}, dom).every((x) => x.domain === dom));
    assert.deepEqual(act(base, { act: 'trk-owner-sel' }, dom).owner, dom);
    assert.equal(act(base, { act: 'trk-owner-sel' }, '').owner, 'all');
    assert.equal(act(base, { act: 'trk-owner', v: 'nope' }), base);
    const week = f({ time: 'week' });
    assert.ok(week.every((x) => x.date >= '2026-09-25'));
    const d0 = all[all.length - 1].date;
    const range = f({ time: 'custom', from: d0, to: d0 });
    assert.ok(range.length && range.every((x) => x.date === d0));
    assert.equal(f({ time: 'all', from: '2099-01-01' }).length, all.length, 'a range applies only when chosen');
    assert.ok(f({ status: 'new' }).every((x) => T.stateOf(base.resp[x.key]) === 'new'));
    assert.ok(f({ status: 'overdue' }).every((x) => base.resp[x.key].steps.some((s) => s.status !== 'done' && s.due < TODAY)));
    assert.ok(f({ disposition: 'none' }).every((x) => !base.resp[x.key].disp.disposition));
    assert.ok(f({ disposition: 'risk_accepted' }).every((x) => base.resp[x.key].disp.disposition === 'risk_accepted'));
    assert.ok(f({ mech: 'awareness_only' }).every((x) => x.mechanism === 'awareness_only'));
    assert.ok(f({ rating: 'high' }).every((x) => base.resp[x.key].disp.rating === 'high'));
    const id = Object.values(base.resp).find((r) => r.disp.issueId).disp.issueId;
    assert.equal(f({ q: id.toLowerCase() }).length, 1, 'search finds an issue by its ID');
    assert.equal(act(base, { act: 'trk-filter', f: 'from' }, '2026-1'), base, 'a partial date is ignored');
    assert.equal(act(base, { act: 'trk-filter', f: 'nope' }, 'x'), base);
    const busy = act(act(base, { act: 'trk-filter', f: 'status' }, 'gap'), { act: 'trk-filter', f: 'q' }, 'x');
    assert.ok(render(busy).includes('Clear 2 filters'));
    assert.deepEqual(act(busy, { act: 'trk-clear' }).f, base.f);
    assert.ok(render(act(base, { act: 'trk-filter', f: 'q' }, 'zzzz-no-match')).includes('No notification matches these filters.'));
  });

  test('the record shows the fields each disposition needs', () => {
    let t = T.initTracker(data, TODAY);
    const x = T.notifications(data)[0];
    t = act(act(t, { act: 'trk-owner', v: x.domain }), { act: 'trk-open', key: x.key });
    assert.ok(!render(t).includes('data-f="disposition"'), 'no record before the control question is answered');
    t = act(t, { act: 'trk-control', key: x.key, v: 'none' });
    let html = render(t);
    for (const k of ['disposition', 'rating', 'issueId', 'title', 'issueOwner', 'controlOwner', 'identified', 'target', 'revised', 'rootCause', 'validatedBy', 'validated', 'closed', 'evidence', 'notes']) {
      assert.ok(html.includes(`data-f="${k}"`), `issue record has ${k}`);
    }
    assert.ok(html.includes('data-f="owner"') || !t.resp[x.key].steps.length);
    t = act(t, { act: 'trk-disp', f: 'disposition', key: x.key }, 'risk_accepted');
    html = render(t);
    for (const k of ['acceptApprover', 'acceptExpiry', 'acceptRationale']) assert.ok(html.includes(`data-f="${k}"`));
    assert.ok(!html.includes('data-f="target"'));
    t = act(t, { act: 'trk-disp', f: 'disposition', key: x.key }, 'duplicate');
    assert.ok(render(t).includes('data-f="duplicateOf"'));
    assert.ok(render(t).includes('class="trk-log"'), 'the activity log is shown');
  });

  test('items show the analyst\'s disposition once tracked, on screen only, labelled a demo', () => {
    const t = T.initTracker(data, TODAY);
    const it = data.items.find((i) => T.itemTracking(t, data, i.id).length);
    const rows = T.itemTracking(t, data, it.id);
    assert.deepEqual(rows.map((r) => r.domain), it.interpretation.map((r) => r.domain));
    const html = V.renderApp({ ui: ui({ page: 'archive', archTime: 'all', open: { [it.id]: true } }), data, now: NOW, error: null, loading: false, trk: t });
    assert.ok(html.includes('Disposition by the analyst') && html.includes('class="trk-demo">Demo<'));
    assert.ok(html.includes(`data-act="trk-goto" data-key="${rows[0].key}"`));
    assert.ok(html.includes('class="meta-trk">Tracked'));
    const paper = V.renderApp({ ui: ui({ page: 'archive', archTime: 'all', open: { [it.id]: true }, printMode: 'expanded' }), data, now: NOW, error: null, loading: false, trk: t });
    assert.ok(!paper.includes('Disposition by the analyst') && !paper.includes('meta-trk'), 'never on paper');
    assert.ok(!V.renderApp({ ui: ui({ page: 'archive', archTime: 'all', open: { [it.id]: true } }), data, now: NOW, error: null, loading: false, trk: null }).includes('Disposition by the analyst'));
    const goto = act(t, { act: 'trk-goto', key: rows[0].key });
    assert.equal(goto.owner, rows[0].domain);
    assert.equal(goto.sel, rows[0].key);
    assert.equal(act(t, { act: 'trk-goto', key: 'x:nope' }), t);
  });

  test('risk-response metrics follow the responses', () => {
    let t = T.initTracker(data, TODAY);
    const m = T.trackerMetrics(t, data);
    assert.equal(m.notified, T.notifications(data).length);
    for (const k of ['ackRate', 'coverage']) assert.ok(m[k] >= 0 && m[k] <= 1, k);
    const x = T.notifications(data)[0];
    t = act(t, { act: 'trk-control', key: x.key, v: 'none' });
    const m2 = T.trackerMetrics(t, data);
    assert.equal(m2.openIssues, m.openIssues + 1, 'a new gap is an open issue');
    assert.ok(m2.ackRate > m.ackRate);
  });
});

