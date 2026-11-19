// Risk tracker demo (docs/assets/tracker.js; owner decision 2026-11-19, SPEC §7.6): notifications
// follow the archive's read-across, the seeded example is deterministic, the reducer is pure, the
// page says it is a demo with a fictional institution, and every data-derived string is escaped.

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

describe('risk tracker demo', () => {
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
    assert.equal(act(t, { act: 'trk-due', key: x.key, step: steps[0].id }, '2026-1'), t, 'a partial date is ignored');
    t = act(t, { act: 'trk-remove', key: x.key, step: steps[0].id });
    assert.equal(t.resp[x.key].steps.length, 1);
    t = act(t, { act: 'trk-control', key: x.key, v: 'in_place' });
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
    assert.ok(!render(act(d, { act: 'trk-control', key: x.key, v: 'in_place' })).includes('Remediation plan'), 'no plan when a control is in place');
    assert.equal(V.PAGE_TITLES.tracker, 'Risk tracker · Readiness Signal');
    assert.deepEqual(M.parseHash('#tracker'), { page: 'tracker' });
    assert.ok(render(null).includes('Risk tracker'), 'renders before the demo is seeded');
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
    t = T.trackerAct(t, { act: 'trk-draft' }, EVIL, bad);
    t = T.trackerAct(t, { act: 'trk-add', key, rec: '0' }, undefined, bad);
    t = T.trackerAct({ ...t, preview: true }, { act: 'trk-draft' }, EVIL, bad);
    const html = render(t, bad);
    assert.ok(!html.includes('<img'), 'no raw markup');
    assert.ok(html.includes('&lt;img src=x'));
  });
});
