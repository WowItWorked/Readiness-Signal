// Readiness Signal: the Tracker demo (owner decisions 2026-11-19, SPEC §7.6). A simulation for
// demonstrations only: each cross-domain read-across in the archive becomes a notification to a
// fictional risk owner at a fictional institution, who records whether a control manages the
// risk and how the matter is disposed of: an issue record, its remediation plan, risk acceptance
// or validation and closure, with an activity log. State lives in memory only (no storage APIs):
// a reload or "Reset demo" starts again from the same seeded example.
// Pure functions and string templates (no DOM access), so it can be tested in Node.

import * as M from './model.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** The fictional institution every response belongs to. Never a real one (SPEC §7.6). */
export const DEMO_ORG = 'Example Bank';

/** One fictional owner role per domain; roles only, never a person's name. */
export const OWNERS = Object.freeze([
  { domain: 'cyber', role: 'Head of Cyber Risk', initials: 'CR' },
  { domain: 'fraud', role: 'Head of Fraud Risk', initials: 'FR' },
  { domain: 'ai', role: 'Head of AI and Model Risk', initials: 'AI' },
  { domain: 'data', role: 'Head of Data Risk', initials: 'DR' },
  { domain: 'resilience', role: 'Head of Operational Resilience', initials: 'OR' },
  { domain: 'third_party', role: 'Head of Third-Party Risk', initials: 'TP' },
  { domain: 'risk_quantification', role: 'Head of Risk Quantification', initials: 'RQ' },
]);
const OWNER_BY_DOMAIN = new Map(OWNERS.map((o) => [o.domain, o]));

export const CONTROL = Object.freeze({
  in_place: { label: 'Yes, a control manages this risk', short: 'Control in place' },
  partial: { label: 'Partly: the control has gaps', short: 'Partly covered' },
  none: { label: 'No control is in place', short: 'No control' },
  na: { label: 'Not applicable here', short: 'Not applicable' },
});
const CONTROL_KEYS = Object.keys(CONTROL);
const needsPlan = (c) => c === 'partial' || c === 'none';

/** How the matter is disposed of. The control answer suggests one; the owner decides. */
export const DISPOSITION = Object.freeze({
  under_assessment: 'Under assessment',
  issue_raised: 'Issue raised: remediation required',
  risk_accepted: 'Risk accepted',
  mitigated: 'Mitigated by an existing control',
  not_applicable: 'Not applicable',
  duplicate: 'Duplicate of an existing issue',
});
const SUGGESTED = { in_place: 'mitigated', partial: 'issue_raised', none: 'issue_raised', na: 'not_applicable' };

/** The institution's own rating of the issue. A label only: never coloured (SPEC §7.5). */
export const RATING = Object.freeze({ low: 'Low', moderate: 'Moderate', high: 'High', critical: 'Critical' });

export const STEP_STATUS = Object.freeze({ todo: 'Not started', doing: 'In progress', done: 'Done' });
const NEXT_STATUS = { todo: 'doing', doing: 'done', done: 'todo' };

/** The issue record's fields: [key, label, kind]. Dates are YYYY-MM-DD; text is capped. */
const TEXT = 'text';
const DATE = 'date';
const AREA = 'area';
export const FIELDS = Object.freeze({
  issueId: ['Issue ID', TEXT], title: ['Issue title', TEXT], issueOwner: ['Accountable owner', TEXT], controlOwner: ['Control owner', TEXT],
  identified: ['Date identified', DATE], target: ['Target remediation date', DATE], revised: ['Revised target date', DATE],
  rootCause: ['Gap and root cause', AREA], acceptApprover: ['Approved by', TEXT], acceptExpiry: ['Acceptance expires', DATE],
  acceptRationale: ['Rationale for acceptance', AREA], duplicateOf: ['Existing issue ID', TEXT], evidence: ['Closure evidence', AREA],
  validatedBy: ['Validated by', TEXT], validated: ['Validation date', DATE], closed: ['Date closed', DATE], notes: ['Notes', AREA],
});

/** Generic ways to close a gap, by domain: starting points for any institution, never one firm's. */
export const PLAYBOOK = Object.freeze({
  cyber: ['Identify affected assets in the inventory and confirm exposure.', 'Confirm patch or compensating-control status with the control owner.', 'Add detection for the technique and test that it fires.'],
  fraud: ['Review fraud rules and scenarios against this typology.', 'Confirm authentication and payment controls cover the vector.', 'Brief front-line and contact-centre teams on the pattern.'],
  ai: ['Check the AI and model inventory for affected systems or providers.', 'Confirm validation, monitoring and permission scoping for those systems.', 'Update the AI risk assessment and record the decision.'],
  data: ['Locate the affected data sets and their owners.', 'Confirm access, encryption and retention controls on them.', 'Test the breach-notification path end to end.'],
  resilience: ['Map the scenario to important business services and impact tolerances.', 'Run or schedule a scenario test against it.', 'Confirm recovery plans and communications cover it.'],
  third_party: ['Identify suppliers and fourth parties that depend on the affected provider.', 'Request assurance or incident information from them.', 'Review contract terms, exit plans and concentration exposure.'],
  risk_quantification: ['Add the event to the loss-data and scenario library.', 'Reassess the affected scenario’s severity and frequency.', 'Report the change to the risk committee.'],
});

/** Day arithmetic on ET date keys (YYYY-MM-DD). */
function addDays(key, n) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fmtKey = (key) => (key ? M.fmtDate(new Date(`${key}T12:00:00Z`)) : '');
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Every read-across entry in the archive as a notification to that domain's owner, newest first. */
export function notifications(data) {
  const out = [];
  for (const it of data ? data.items : []) {
    for (const r of it.interpretation || []) {
      if (!OWNER_BY_DOMAIN.has(r.domain)) continue;
      out.push({ key: `${it.id}:${r.domain}`, itemId: it.id, domain: r.domain, text: r.text, date: M.todayEt(it.date), mechanism: it.mechanism, claim: it.claim });
    }
  }
  return out;
}

/** Suggested steps for a gap: what the item itself asks, then the domain playbook. */
export function recommendations(it, domain) {
  const recs = [];
  if (it) {
    if (it.mechanism === 'candidate_issue') {
      recs.push(`Send the validation question to the control owner: ${it.validation_question}`);
      recs.push(`If the answer is no or unknown, raise the issue: ${it.candidate_issue_statement}`);
    } else if (it.mechanism === 'kri_kpi') {
      recs.push('Confirm an indicator for this exposure exists, is measured, and reaches someone who acts on it.');
      if (it.validation_question) recs.push(`Ask the indicator owner: ${it.validation_question}`);
    } else {
      recs.push('Brief the domain leadership so the development is known if asked.');
    }
  }
  return [...recs, ...(PLAYBOOK[domain] || [])];
}

const blankDisp = () => ({ disposition: '', rating: '', ...Object.fromEntries(Object.keys(FIELDS).map((k) => [k, ''])) });
const blankResp = () => ({ read: false, control: null, ref: '', steps: [], disp: blankDisp(), log: [] });
const NO_FILTERS = { q: '', time: 'all', from: '', to: '', status: '', disposition: '', mech: '', rating: '' };

/**
 * The seeded demo: per domain, the two newest notifications are unread. Of the older ones that ask
 * for action (candidate issue or KRI / KPI), the first has no control and an open issue with a
 * three-step plan (one done, one in progress, one overdue), the second is partly covered with a
 * closed and validated issue, and the third has its risk accepted. Everything else is mitigated by
 * a control, and awareness-only items are not applicable.
 */
export function initTracker(data, today) {
  const resp = {};
  let n = 0;
  let seq = 0;
  const step = (text, owner, due, status) => ({ id: `s${++n}`, text, owner, due, status });
  const seen = {};
  const acts = {};
  for (const x of notifications(data)) {
    const i = (seen[x.domain] = (seen[x.domain] ?? -1) + 1);
    const o = OWNER_BY_DOMAIN.get(x.domain);
    const recs = recommendations(data.byId.get(x.itemId), x.domain);
    const actionable = x.mechanism !== 'awareness_only';
    const g = actionable && i >= 2 ? (acts[x.domain] = (acts[x.domain] ?? 0) + 1) : 0;
    const seeded = (control, disposition, extra = {}, steps = []) => {
      const d = addDays(x.date, 1);
      return {
        read: true, control, ref: extra.ref || '', steps,
        disp: { ...blankDisp(), disposition, identified: d, issueOwner: o.role, ...extra.disp },
        log: [{ at: fmtKey(d), text: `Acknowledged by ${o.role}: ${CONTROL[control].short.toLowerCase()}.` }, { at: fmtKey(d), text: `Disposition set to ${DISPOSITION[disposition].toLowerCase()}.` }, ...(extra.log || [])],
      };
    };
    const id = () => `EB-${x.date.slice(0, 4)}-${String(++seq).padStart(3, '0')}`;
    if (i < 2) resp[x.key] = blankResp();
    else if (g === 1) {
      resp[x.key] = seeded('none', 'issue_raised', {
        disp: { issueId: id(), title: `${M.DOMAIN_BY_KEY.get(x.domain).label} control gap: ${x.claim.slice(0, 80)}`, rating: 'high', controlOwner: 'Control owner, first line', target: addDays(today, 21), rootCause: 'No control covers the exposure described in the read-across.' },
        log: [{ at: fmtKey(addDays(x.date, 2)), text: 'Remediation plan created with 3 steps.' }],
      }, [step(recs[0], o.role, addDays(today, -9), 'done'), step(recs[1], 'Control owner, first line', addDays(today, 6), 'doing'), step(recs[2], 'Second-line risk', addDays(today, -2), 'todo')]);
    } else if (g === 2) {
      const closed = addDays(today, -5);
      resp[x.key] = seeded('partial', 'issue_raised', {
        ref: 'Existing control covers part of the exposure.',
        disp: { issueId: id(), title: `${M.DOMAIN_BY_KEY.get(x.domain).label} partial coverage: ${x.claim.slice(0, 80)}`, rating: 'moderate', controlOwner: 'Control owner, first line', target: addDays(today, -3), rootCause: 'The control covers the main path but not the variant in the read-across.', evidence: 'Control design updated and tested; test results on file.', validatedBy: 'Second-line risk', validated: closed, closed },
        log: [{ at: fmtKey(closed), text: 'Validated by second-line risk and closed.' }],
      }, [step(recs[0], o.role, addDays(today, -12), 'done'), step(recs[recs.length - 1], 'Control owner, first line', addDays(today, -6), 'done')]);
    } else if (g === 3) {
      resp[x.key] = seeded('partial', 'risk_accepted', {
        ref: 'Compensating control in place.',
        disp: { issueId: id(), title: `${M.DOMAIN_BY_KEY.get(x.domain).label} residual risk: ${x.claim.slice(0, 80)}`, rating: 'low', acceptApprover: 'Chief Risk Officer', acceptExpiry: addDays(today, 75), acceptRationale: 'Residual exposure is within appetite given the compensating control; reassess at expiry.' },
      });
    } else if (actionable) resp[x.key] = seeded('in_place', 'mitigated', { ref: 'Covered by an existing control.' });
    else resp[x.key] = seeded('na', 'not_applicable');
  }
  return { today, owner: 'all', sel: null, preview: false, resp, n, draft: '', f: { ...NO_FILTERS } };
}

/** Where one notification stands, from its response. */
export function stateOf(r) {
  if (!r || !r.read) return 'new';
  const disp = r.disp && r.disp.disposition;
  if (disp === 'risk_accepted') return 'accepted';
  if (disp === 'mitigated' || disp === 'not_applicable' || disp === 'duplicate') return 'covered';
  if (!r.control && !disp) return 'open';
  if (disp === 'issue_raised' || needsPlan(r.control)) {
    if ((r.disp && r.disp.closed) || (r.steps.length && r.steps.every((s) => s.status === 'done'))) return 'closed';
    return 'gap';
  }
  if (disp === 'under_assessment') return 'open';
  return 'covered';
}
export const STATE_LABEL = { new: 'New', open: 'Awaiting decision', gap: 'Issue open', accepted: 'Risk accepted', closed: 'Issue closed', covered: 'Covered' };

const overdue = (s, today) => s.status !== 'done' && s.due && s.due < today;
const lateSteps = (r, today) => (r ? r.steps.filter((s) => overdue(s, today)).length : 0);

// ---------------------------------------------------------------------------------------
// Filters

export const TIMES = Object.freeze({ all: 'Any time', day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days', custom: 'Date range' });
const TIME_DAYS = { day: 1, week: 7, month: 30 };
export const STATUS_FILTERS = Object.freeze({ new: 'New', open: 'Awaiting decision', gap: 'Issue open', overdue: 'Has overdue steps', accepted: 'Risk accepted', closed: 'Issue closed', covered: 'Covered' });

/** The register: notifications that pass the owner and every filter. */
export function register(trk, data) {
  const f = trk.f || NO_FILTERS;
  const q = f.q.trim().toLowerCase();
  const since = TIME_DAYS[f.time] ? addDays(trk.today, -TIME_DAYS[f.time]) : '';
  return notifications(data).filter((x) => {
    const r = trk.resp[x.key];
    const st = stateOf(r);
    if (trk.owner !== 'all' && x.domain !== trk.owner) return false;
    if (since && x.date < since) return false;
    if (f.time === 'custom' && ((f.from && x.date < f.from) || (f.to && x.date > f.to))) return false;
    if (f.status === 'overdue' ? !lateSteps(r, trk.today) : f.status && st !== f.status) return false;
    if (f.disposition && (f.disposition === 'none' ? r && r.disp.disposition : !r || r.disp.disposition !== f.disposition)) return false;
    if (f.mech && x.mechanism !== f.mech) return false;
    if (f.rating && (f.rating === 'none' ? r && r.disp.rating : !r || r.disp.rating !== f.rating)) return false;
    if (q && ![x.claim, x.text, r && r.disp.issueId, r && r.disp.title].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
}
const activeFilters = (f) => Object.entries(f).filter(([k, v]) => v && !(k === 'time' && v === 'all') && !((k === 'from' || k === 'to') && f.time !== 'custom')).length;

/** Counts per owner, for the overview. */
export function ownerSummary(trk, data) {
  const all = notifications(data);
  return OWNERS.map((o) => {
    const mine = all.filter((x) => x.domain === o.domain);
    const st = mine.map((x) => stateOf(trk.resp[x.key]));
    const steps = mine.flatMap((x) => (trk.resp[x.key] ? trk.resp[x.key].steps : []));
    const count = (s) => st.filter((v) => v === s).length;
    return {
      ...o, label: M.DOMAIN_BY_KEY.get(o.domain).label, total: mine.length,
      fresh: count('new'), open: count('open'), gaps: count('gap'), accepted: count('accepted'), closed: count('closed'), covered: count('covered'),
      stepsDone: steps.filter((s) => s.status === 'done').length, steps: steps.length, late: steps.filter((s) => overdue(s, trk.today)).length,
    };
  });
}

// ---------------------------------------------------------------------------------------
// Risk-response metrics (owner request 2026-11-24): KRI-style measures of how the demo owners
// respond to read-across. Example data only, like everything the Tracker holds.

const daysBetween = (a, b) => (isDate(a) && isDate(b) ? Math.round((+new Date(`${b}T12:00:00Z`) - +new Date(`${a}T12:00:00Z`)) / 864e5) : null);
const mean = (xs) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null);

export function trackerMetrics(trk, data) {
  const notes = notifications(data);
  const rs = notes.map((x) => ({ x, r: trk.resp[x.key] || blankResp() }));
  const answered = rs.filter(({ r }) => r.control || r.disp.disposition);
  const st = rs.map(({ r }) => stateOf(r));
  const covered = st.filter((s) => s === 'covered').length;
  const issues = rs.filter(({ r }) => ['gap', 'closed'].includes(stateOf(r)));
  const closed = issues.filter(({ r }) => stateOf(r) === 'closed');
  const steps = rs.flatMap(({ r }) => r.steps);
  const openSteps = steps.filter((s) => s.status !== 'done');
  const late = openSteps.filter((s) => overdue(s, trk.today)).length;
  const toDecide = answered.map(({ x, r }) => daysBetween(x.date, r.disp.identified)).filter((n) => n != null && n >= 0);
  const toClose = closed.map(({ r }) => daysBetween(r.disp.identified, r.disp.closed)).filter((n) => n != null && n >= 0);
  const in90 = addDays(trk.today, 90);
  const expiring = rs.filter(({ r }) => r.disp.disposition === 'risk_accepted' && isDate(r.disp.acceptExpiry) && r.disp.acceptExpiry <= in90).length;
  const rated = Object.fromEntries(Object.keys(RATING).map((k) => [k, issues.filter(({ r }) => r.disp.rating === k && stateOf(r) !== 'closed').length]));
  return {
    notified: notes.length,
    ackRate: notes.length ? answered.length / notes.length : null,
    coverage: answered.length ? covered / answered.length : null,
    openIssues: issues.length - closed.length,
    closedIssues: closed.length,
    onSchedule: openSteps.length ? (openSteps.length - late) / openSteps.length : null,
    lateSteps: late,
    daysToDecide: mean(toDecide),
    daysToClose: mean(toClose),
    acceptances: st.filter((s) => s === 'accepted').length,
    expiring,
    rated,
  };
}

/** Each owner's record for one item: what the item view shows once its read-across is tracked. */
export function itemTracking(trk, data, itemId) {
  if (!trk || !data) return [];
  return notifications(data).filter((x) => x.itemId === itemId).map((x) => {
    const r = trk.resp[x.key] || blankResp();
    const done = r.steps.filter((s) => s.status === 'done').length;
    return {
      key: x.key, domain: x.domain, role: OWNER_BY_DOMAIN.get(x.domain).role, label: M.DOMAIN_BY_KEY.get(x.domain).label,
      state: stateOf(r), control: r.control, disp: r.disp, done, steps: r.steps.length, late: lateSteps(r, trk.today),
    };
  });
}

/** One line for an item's collapsed row: where its tracking stands, or '' when nothing is tracked. */
export function itemTrackLine(rows) {
  if (!rows.length) return '';
  const n = (s) => rows.filter((r) => r.state === s).length;
  if (n('gap')) return `Tracked · ${n('gap')} issue${n('gap') === 1 ? '' : 's'} open`;
  if (n('new') || n('open')) return 'Tracked · awaiting decision';
  return 'Tracked · dispositioned';
}

/** The "Disposition by the analyst" block in an expanded item (demo data, labelled as such). */
export function itemTrackBlock(rows) {
  if (!rows.length) return '';
  const line = (r) => {
    const facts = [
      r.control ? CONTROL[r.control].short : '',
      r.disp.disposition ? DISPOSITION[r.disp.disposition] : '',
      r.disp.rating ? `Rated ${RATING[r.disp.rating].toLowerCase()}` : '',
      r.disp.issueId,
      r.state === 'gap' && (r.disp.revised || r.disp.target) ? `Target ${fmtKey(r.disp.revised || r.disp.target)}` : '',
      r.state === 'closed' && r.disp.closed ? `Closed ${fmtKey(r.disp.closed)}` : '',
      r.disp.disposition === 'risk_accepted' && r.disp.acceptExpiry ? `Acceptance expires ${fmtKey(r.disp.acceptExpiry)}` : '',
      r.steps ? `${r.done} of ${r.steps} steps done` : '',
    ].filter(Boolean);
    return `<li class="trk-item-row" data-k="trk-ir-${esc(r.key)}">
        <span class="trk-item-who"><span class="trk-item-dom">${esc(r.label)}</span><span class="trk-item-role">${esc(r.role)}</span></span>
        <span class="trk-item-what">${pill(r.state)}${r.late ? `<span class="trk-late">${r.late} overdue</span>` : ''}<span class="trk-item-facts">${facts.length ? esc(facts.join(' · ')) : 'Not yet acknowledged'}</span></span>
        <button type="button" class="copy-btn" data-act="trk-goto" data-key="${esc(r.key)}">Open in Tracker</button>
      </li>`;
  };
  return `<div class="b-trk">
        <div class="trk-item-h"><span class="kicker">Disposition by the analyst</span><span class="trk-demo">Demo</span><span class="trk-item-sub">${esc(DEMO_ORG)}, example data</span></div>
        <ul class="trk-item-list">${rows.map(line).join('')}</ul>
      </div>`;
}

// ---------------------------------------------------------------------------------------
// Actions: a pure reducer. `d` is the element's dataset; `value` the field's value; `meta`
// { type: 'input' | 'change' | 'click', at: display time } decides what reaches the log.

function patchResp(trk, key, fn) {
  const cur = trk.resp[key] || blankResp();
  return { ...trk, resp: { ...trk.resp, [key]: fn(cur) } };
}
/** Append to the activity log; the same entry twice in a row (one edit committed twice) is kept once. */
const logged = (r, at, text) => (r.log.length && r.log[r.log.length - 1].text === text ? r : { ...r, log: [...r.log, { at, text }] });

export function trackerAct(trk, d, value, data, meta = {}) {
  const at = meta.at || fmtKey(trk.today);
  const commit = meta.type !== 'input'; // typing is logged once, when the field is left
  const v = String(value ?? '');
  switch (d.act) {
    case 'trk-owner':
      if (d.v !== 'all' && !OWNER_BY_DOMAIN.has(d.v)) return trk;
      return { ...trk, owner: d.v, sel: null, preview: false, draft: '' };
    case 'trk-owner-sel': return trackerAct(trk, { act: 'trk-owner', v: v || 'all' }, undefined, data, meta);
    case 'trk-goto': {
      // From an item's disposition block: open that owner's record in the Tracker.
      const domain = String(d.key || '').split(':')[1];
      if (!OWNER_BY_DOMAIN.has(domain)) return trk;
      return trackerAct({ ...trk, owner: domain }, { act: 'trk-open', key: d.key }, undefined, data, meta);
    }
    case 'trk-open': return { ...patchResp(trk, d.key, (r) => (r.read ? r : logged({ ...r, read: true }, at, 'Notification read.'))), sel: d.key, preview: false, draft: '' };
    case 'trk-back': return { ...trk, sel: null, preview: false };
    case 'trk-preview': return { ...trk, preview: !trk.preview };
    case 'trk-filter': {
      const k = d.f;
      if (!(k in NO_FILTERS)) return trk;
      if (k === 'from' || k === 'to') { if (v && !isDate(v)) return trk; }
      return { ...trk, f: { ...trk.f, [k]: v.slice(0, 120) } };
    }
    case 'trk-clear': return { ...trk, f: { ...NO_FILTERS } };
    case 'trk-control':
      if (!CONTROL_KEYS.includes(d.v)) return trk;
      return patchResp(trk, d.key, (r) => {
        if (r.control === d.v) return r;
        const role = (OWNER_BY_DOMAIN.get(String(d.key).split(':')[1]) || {}).role || '';
        const disp = r.disp.disposition ? r.disp : { ...r.disp, disposition: SUGGESTED[d.v], identified: r.disp.identified || trk.today, issueOwner: r.disp.issueOwner || role };
        let out = logged({ ...r, read: true, control: d.v, disp }, at, `Control answer: ${CONTROL[d.v].short.toLowerCase()}.`);
        if (!r.disp.disposition) out = logged(out, at, `Disposition set to ${DISPOSITION[disp.disposition].toLowerCase()}.`);
        return out;
      });
    case 'trk-disp':
      if (d.f === 'disposition') {
        if (v && !DISPOSITION[v]) return trk;
        return patchResp(trk, d.key, (r) => (r.disp.disposition === v ? r : logged({ ...r, disp: { ...r.disp, disposition: v } }, at, v ? `Disposition set to ${DISPOSITION[v].toLowerCase()}.` : 'Disposition cleared.')));
      }
      if (d.f === 'rating') {
        if (v && !RATING[v]) return trk;
        return patchResp(trk, d.key, (r) => (r.disp.rating === v ? r : logged({ ...r, disp: { ...r.disp, rating: v } }, at, v ? `Rated ${RATING[v].toLowerCase()}.` : 'Rating cleared.')));
      }
      if (!FIELDS[d.f]) return trk;
      if (FIELDS[d.f][1] === DATE && v && !isDate(v)) return trk;
      return patchResp(trk, d.key, (r) => {
        const next = { ...r, disp: { ...r.disp, [d.f]: v.slice(0, FIELDS[d.f][1] === AREA ? 1000 : 160) } };
        if (!commit) return next;
        const label = FIELDS[d.f][0];
        return logged(next, at, FIELDS[d.f][1] === DATE ? `${label}: ${v ? fmtKey(v) : 'cleared'}.` : `${label} updated.`);
      });
    case 'trk-ref': return patchResp(trk, d.key, (r) => {
      const next = { ...r, ref: v.slice(0, 300) };
      return commit ? logged(next, at, 'Control reference updated.') : next;
    });
    case 'trk-add': {
      const x = notifications(data).find((nn) => nn.key === d.key);
      const recs = x ? recommendations(data.byId.get(x.itemId), x.domain) : [];
      const text = d.rec !== undefined ? recs[Number(d.rec)] : trk.draft.trim();
      if (!text) return trk;
      const id = `s${trk.n + 1}`;
      const owner = x ? OWNER_BY_DOMAIN.get(x.domain).role : '';
      const next = patchResp(trk, d.key, (r) => logged({ ...r, steps: [...r.steps, { id, text, owner, due: addDays(trk.today, 14), status: 'todo' }] }, at, `Step added: ${text}`));
      return { ...next, n: trk.n + 1, draft: d.rec !== undefined ? trk.draft : '' };
    }
    case 'trk-draft': return { ...trk, draft: v.slice(0, 300) };
    case 'trk-status':
      return patchResp(trk, d.key, (r) => {
        const s = r.steps.find((st) => st.id === d.step);
        if (!s) return r;
        const status = NEXT_STATUS[s.status];
        return logged({ ...r, steps: r.steps.map((st) => (st === s ? { ...st, status } : st)) }, at, `Step marked ${STEP_STATUS[status].toLowerCase()}: ${s.text}`);
      });
    case 'trk-step': {
      if (d.f !== 'due' && d.f !== 'owner') return trk;
      if (d.f === 'due' && v && !isDate(v)) return trk;
      return patchResp(trk, d.key, (r) => {
        const s = r.steps.find((st) => st.id === d.step);
        if (!s) return r;
        const next = { ...r, steps: r.steps.map((st) => (st === s ? { ...st, [d.f]: v.slice(0, 160) } : st)) };
        if (!commit) return next;
        return logged(next, at, d.f === 'due' ? `Step due date ${v ? fmtKey(v) : 'cleared'}: ${s.text}` : `Step owner set to ${v || 'nobody'}: ${s.text}`);
      });
    }
    case 'trk-remove':
      return patchResp(trk, d.key, (r) => {
        const s = r.steps.find((st) => st.id === d.step);
        return s ? logged({ ...r, steps: r.steps.filter((st) => st !== s) }, at, `Step removed: ${s.text}`) : r;
      });
    case 'trk-reset': return { ...initTracker(data, trk.today), owner: trk.owner, f: trk.f };
    default: return trk;
  }
}

// ---------------------------------------------------------------------------------------
// Rendering

const pill = (state) => `<span class="trk-state trk-${state}">${esc(STATE_LABEL[state])}</span>`;
const mechTag = (k) => `<span class="mech" data-mech="${esc(k)}"><span class="mech-label">${esc(M.mechOf(k).label)}</span></span>`;
const opts = (map, cur, first) => `${first ? `<option value=""${cur ? '' : ' selected'}>${esc(first)}</option>` : ''}${Object.entries(map).map(([k, l]) => `<option value="${esc(k)}"${cur === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}`;

function overview(trk, data) {
  const rows = ownerSummary(trk, data);
  const cards = rows.map((o) => `<button type="button" class="trk-owner-card" data-act="trk-owner" data-v="${o.domain}" data-k="trk-oc-${o.domain}">
      <span class="trk-avatar" aria-hidden="true">${esc(o.initials)}</span>
      <span class="trk-oc-t"><span class="trk-oc-role">${esc(o.role)}</span><span class="trk-oc-dom">${esc(o.label)} · ${o.total} read-across</span></span>
      <span class="trk-oc-n">
        ${o.fresh ? `<span class="trk-badge">${o.fresh} new</span>` : ''}
        <span>${o.gaps} open issue${o.gaps === 1 ? '' : 's'}</span>
        <span>${o.stepsDone}/${o.steps} steps done</span>
        ${o.late ? `<span class="trk-late">${o.late} overdue</span>` : ''}
      </span>
    </button>`).join('');
  const tot = rows.reduce((a, o) => ({ fresh: a.fresh + o.fresh, gaps: a.gaps + o.gaps, accepted: a.accepted + o.accepted, closed: a.closed + o.closed, late: a.late + o.late }), { fresh: 0, gaps: 0, accepted: 0, closed: 0, late: 0 });
  const stat = (n, l) => `<div class="trk-stat"><b>${n}</b><span>${esc(l)}</span></div>`;
  return `<section class="card trk-card" aria-labelledby="trk-ov-h" data-k="trk-ov">
    <header class="card-head"><h2 class="h-19" id="trk-ov-h">Risk owners</h2><span class="sub-13">Each owner is notified when an item’s read-across cites their domain.</span></header>
    <div class="trk-stats">${stat(tot.fresh, 'new notifications')}${stat(tot.gaps, 'issues open')}${stat(tot.late, 'steps overdue')}${stat(tot.accepted, 'risks accepted')}${stat(tot.closed, 'issues closed')}</div>
    <div class="trk-owner-grid">${cards}</div>
  </section>`;
}

function filterBar(trk) {
  const f = trk.f;
  const sel = (key, label, map, first) => `<label class="trk-f"><span>${esc(label)}</span><select data-act="trk-filter" data-f="${key}">${opts(map, f[key], first)}</select></label>`;
  const domains = Object.fromEntries(OWNERS.map((o) => [o.domain, M.DOMAIN_BY_KEY.get(o.domain).label]));
  const n = activeFilters(f);
  return `<div class="trk-filters" role="search" aria-label="Filter notifications" data-k="trk-filters">
      <label class="trk-f trk-f-q"><span>Search</span><input type="search" class="trk-input" value="${esc(f.q)}" data-act="trk-filter" data-f="q" placeholder="Claim, read-across, issue ID or title"></label>
      <label class="trk-f"><span>Domain</span><select data-act="trk-owner-sel">${opts(domains, trk.owner === 'all' ? '' : trk.owner, 'All domains')}</select></label>
      ${sel('time', 'Notified', TIMES)}
      ${f.time === 'custom' ? `<label class="trk-f"><span>From</span><input type="date" class="trk-input" value="${esc(f.from)}" data-act="trk-filter" data-f="from"></label><label class="trk-f"><span>To</span><input type="date" class="trk-input" value="${esc(f.to)}" data-act="trk-filter" data-f="to"></label>` : ''}
      ${sel('status', 'Status', STATUS_FILTERS, 'Any status')}
      ${sel('disposition', 'Disposition', { ...DISPOSITION, none: 'None recorded' }, 'Any disposition')}
      ${sel('mech', 'What it asks', Object.fromEntries(M.MECHANISMS.map((m) => [m.key, m.label])), 'Any')}
      ${sel('rating', 'Rating', { ...RATING, none: 'Not rated' }, 'Any rating')}
      ${n ? `<button type="button" class="copy-btn trk-clear" data-act="trk-clear">Clear ${n} filter${n === 1 ? '' : 's'}</button>` : ''}
    </div>`;
}

function registerCard(trk, data) {
  const owner = OWNER_BY_DOMAIN.get(trk.owner);
  const all = notifications(data).filter((x) => !owner || x.domain === owner.domain);
  const rows = register(trk, data);
  const items = rows.map((x) => {
    const r = trk.resp[x.key];
    const s = stateOf(r);
    const late = lateSteps(r, trk.today);
    const dp = r && r.disp;
    return `<li data-k="trk-n-${esc(x.key)}"><button type="button" class="trk-note${s === 'new' ? ' unread' : ''}" data-act="trk-open" data-key="${esc(x.key)}">
        <span class="trk-note-top">${s === 'new' ? '<span class="trk-dot" aria-hidden="true"></span>' : ''}<span class="trk-note-d">${esc(fmtKey(x.date))}</span>${owner ? '' : `<span class="chip">${esc(M.DOMAIN_BY_KEY.get(x.domain).label)}</span>`}${mechTag(x.mechanism)}${pill(s)}${late ? `<span class="trk-late">${late} overdue</span>` : ''}</span>
        <span class="trk-note-c">${esc(x.claim)}</span>
        ${dp && (dp.issueId || dp.disposition) ? `<span class="trk-note-i">${[dp.issueId, dp.disposition && DISPOSITION[dp.disposition], dp.rating && `Rated ${RATING[dp.rating].toLowerCase()}`, dp.target && s === 'gap' && `Target ${fmtKey(dp.revised || dp.target)}`].filter(Boolean).map(esc).join(' · ')}</span>` : `<span class="trk-note-r">${esc(x.text)}</span>`}
      </button></li>`;
  }).join('');
  const fresh = all.filter((x) => stateOf(trk.resp[x.key]) === 'new').length;
  const title = owner ? `Notifications · ${owner.role}` : 'All notifications';
  const empty = all.length
    ? '<p class="trk-empty">No notification matches these filters.</p>'
    : '<p class="trk-empty">No published item has cited this domain in its read-across yet. Notifications appear here as soon as one does.</p>';
  return `<section class="card trk-card" aria-labelledby="trk-in-h" data-k="trk-register">
    <header class="card-head"><h2 class="h-19" id="trk-in-h">${esc(title)}</h2><span class="sub-13">${rows.length === all.length ? `${all.length}` : `${rows.length} of ${all.length}`} notification${all.length === 1 ? '' : 's'}${fresh ? ` · ${fresh} new` : ''}</span></header>
    ${filterBar(trk)}
    ${rows.length ? `<ul class="trk-notes">${items}</ul>` : empty}
  </section>`;
}

function field(x, r, k, extra = '') {
  const [label, kind] = FIELDS[k];
  const v = r.disp[k];
  const attrs = `data-act="trk-disp" data-key="${esc(x.key)}" data-f="${k}" id="trk-${k}"`;
  const input = kind === AREA
    ? `<textarea class="trk-input trk-area" ${attrs} rows="3">${esc(v)}</textarea>`
    : `<input type="${kind === DATE ? 'date' : 'text'}" class="trk-input" value="${esc(v)}" ${attrs}${extra}>`;
  return `<label class="trk-fld${kind === AREA ? ' wide' : ''}" for="trk-${k}"><span>${esc(label)}</span>${input}</label>`;
}

function detail(trk, data, x) {
  const it = data.byId.get(x.itemId);
  const r = trk.resp[x.key] || blankResp();
  const s = stateOf(r);
  const owner = OWNER_BY_DOMAIN.get(x.domain);
  const dom = M.DOMAIN_BY_KEY.get(x.domain).label;
  const key = esc(x.key);
  const dp = r.disp;
  const ctl = CONTROL_KEYS.map((k) => `<button type="button" class="drop-btn" data-act="trk-control" data-key="${key}" data-v="${k}" aria-pressed="${r.control === k}">${esc(CONTROL[k].label)}</button>`).join('');
  const isIssue = dp.disposition === 'issue_raised';
  const recs = recommendations(it, x.domain);
  const have = new Set(r.steps.map((st) => st.text));
  const recList = recs.map((t, i) => `<li class="trk-rec"><span>${esc(t)}</span>${have.has(t) ? '<span class="trk-added">In the plan</span>' : `<button type="button" class="copy-btn" data-act="trk-add" data-key="${key}" data-rec="${i}">Add to plan</button>`}</li>`).join('');
  const done = r.steps.filter((st) => st.status === 'done').length;
  const steps = r.steps.map((st) => `<li class="trk-step${overdue(st, trk.today) ? ' late' : ''}" data-k="trk-st-${esc(st.id)}">
      <button type="button" class="trk-status trk-st-${st.status}" data-act="trk-status" data-key="${key}" data-step="${esc(st.id)}" aria-label="Status: ${esc(STEP_STATUS[st.status])}. Change status">${esc(STEP_STATUS[st.status])}</button>
      <span class="trk-step-t">${esc(st.text)}</span>
      <label class="trk-due"><span>Owner</span><input type="text" class="trk-input trk-sm" value="${esc(st.owner)}" data-act="trk-step" data-f="owner" data-key="${key}" data-step="${esc(st.id)}" aria-label="Step owner"></label>
      <label class="trk-due"><span>Due</span><input type="date" class="trk-input trk-sm" value="${esc(st.due)}" data-act="trk-step" data-f="due" data-key="${key}" data-step="${esc(st.id)}" aria-label="Due date">${overdue(st, trk.today) ? '<span class="trk-late">Overdue</span>' : ''}</label>
      <button type="button" class="trk-x" data-act="trk-remove" data-key="${key}" data-step="${esc(st.id)}" aria-label="Remove step">Remove</button>
    </li>`).join('');

  const record = r.control || dp.disposition ? `
    <div class="trk-block">
      <span class="kicker">Disposition</span>
      <div class="trk-grid">
        <label class="trk-fld" for="trk-disposition"><span>Disposition</span><select id="trk-disposition" data-act="trk-disp" data-key="${key}" data-f="disposition">${opts(DISPOSITION, dp.disposition, 'Not decided')}</select></label>
        <label class="trk-fld" for="trk-rating"><span>Risk rating</span><select id="trk-rating" data-act="trk-disp" data-key="${key}" data-f="rating">${opts(RATING, dp.rating, 'Not rated')}</select></label>
        ${field(x, r, 'issueId', ' placeholder="For example, EB-2026-014"')}
        ${field(x, r, 'title')}
        ${field(x, r, 'issueOwner')}
        ${field(x, r, 'controlOwner')}
        ${field(x, r, 'identified')}
        ${isIssue ? `${field(x, r, 'target')}${field(x, r, 'revised')}` : ''}
        ${dp.disposition === 'duplicate' ? field(x, r, 'duplicateOf') : ''}
        ${field(x, r, 'rootCause')}
      </div>
    </div>
    ${dp.disposition === 'risk_accepted' ? `<div class="trk-block">
      <span class="kicker">Risk acceptance</span>
      <div class="trk-grid">${field(x, r, 'acceptApprover')}${field(x, r, 'acceptExpiry')}${field(x, r, 'acceptRationale')}</div>
    </div>` : ''}` : '';

  const plan = isIssue || needsPlan(r.control) ? `
    <div class="trk-block">
      <span class="kicker">Recommended to close the gap</span>
      <ul class="trk-recs">${recList}</ul>
    </div>
    <div class="trk-block">
      <div class="trk-plan-h"><span class="kicker">Remediation plan</span><span class="trk-prog"><progress max="${Math.max(1, r.steps.length)}" value="${done}"></progress> ${done} of ${r.steps.length} done</span></div>
      ${r.steps.length ? `<ul class="trk-steps">${steps}</ul>` : '<p class="trk-empty">No steps yet. Add a recommendation above or write your own.</p>'}
      <div class="trk-addrow"><input type="text" class="trk-input" value="${esc(trk.draft)}" data-act="trk-draft" placeholder="Add your own step" aria-label="New step"><button type="button" class="copy-btn" data-act="trk-add" data-key="${key}">Add step</button></div>
    </div>
    ${isIssue ? `<div class="trk-block">
      <span class="kicker">Validation and closure</span>
      <div class="trk-grid">${field(x, r, 'validatedBy')}${field(x, r, 'validated')}${field(x, r, 'closed')}${field(x, r, 'evidence')}</div>
    </div>` : ''}` : '';

  const notes = r.control || dp.disposition ? `<div class="trk-block"><div class="trk-grid">${field(x, r, 'notes')}</div></div>` : '';
  const log = r.log.length ? `<div class="trk-block">
      <span class="kicker">Activity</span>
      <ol class="trk-log">${[...r.log].reverse().map((e) => `<li><span class="trk-log-at">${esc(e.at)}</span><span>${esc(e.text)}</span></li>`).join('')}</ol>
    </div>` : '';
  const mail = `To: ${owner.role}, ${DEMO_ORG}\nSubject: New read-across for ${dom}: ${x.claim}\n\nReadiness Signal published an item on ${fmtKey(x.date)} whose read-across cites ${dom}:\n\n${x.text}\n\nRecord whether a control manages this risk, and its disposition, in the Tracker.`;
  return `<section class="card trk-card trk-detail" aria-labelledby="trk-d-h" data-k="trk-d-${key}">
    <header class="card-head trk-d-head">
      <button type="button" class="trk-back" data-act="trk-back">Back to notifications</button>
      <div class="trk-d-meta">${mechTag(x.mechanism)}${pill(s)}<span class="trk-note-d">${esc(owner.role)} · notified ${esc(fmtKey(x.date))}</span>${dp.issueId ? `<span class="trk-note-d">${esc(dp.issueId)}</span>` : ''}</div>
      <h2 class="h-19" id="trk-d-h">${esc(x.claim)}</h2>
      <a class="small-link" href="#${esc(x.itemId)}" data-act="reveal" data-id="${esc(x.itemId)}">Open the item</a>
    </header>
    <div class="trk-d-body">
      <div class="trk-block" data-mech="${esc(x.mechanism)}">
        <span class="kicker">Read-across for ${esc(dom)}</span>
        <p class="trk-read">${esc(x.text)}</p>
        <p class="trk-asks"><span class="trk-asks-k">What the item asks</span> ${esc(M.mechOf(x.mechanism).asks)}</p>
        <button type="button" class="trk-link" data-act="trk-preview" aria-expanded="${trk.preview}">${trk.preview ? 'Hide' : 'Show'} the notification ${esc(owner.role)} received</button>
        ${trk.preview ? `<div class="trk-mail">${esc(mail)}</div>` : ''}
      </div>
      <div class="trk-block">
        <span class="kicker">Is there a control in place that manages this risk?</span>
        <div class="drop-group" role="group" aria-label="Control in place">${ctl}</div>
        ${r.control ? `<label class="trk-fld trk-ref"><span>${r.control === 'in_place' || r.control === 'partial' ? 'Control reference or evidence' : 'Note'}</span><input type="text" class="trk-input" value="${esc(r.ref)}" data-act="trk-ref" data-key="${key}" placeholder="${r.control === 'in_place' ? 'For example, the control ID and its last test date' : 'Optional'}"></label>` : ''}
      </div>
      ${record}
      ${plan}
      ${notes}
      ${log}
    </div>
  </section>`;
}

/** The Tracker page. `trk` is null until the archive has loaded. */
export function trackerMain(st) {
  const { trk, data } = st;
  const owners = [['all', 'All owners'], ...OWNERS.map((o) => [o.domain, o.role])];
  const ownerBtns = owners.map(([k, l]) => `<button type="button" class="drop-btn" data-act="trk-owner" data-v="${k}" aria-pressed="${trk ? trk.owner === k : k === 'all'}">${esc(l)}</button>`).join('');
  const intro = `<section class="card drop-intro trk-intro" aria-labelledby="trk-h">
    <h2 class="h-19" id="trk-h"><span class="trk-demo">Demo</span> Read-across, routed to the people who own it</h2>
    <p class="drop-p">A simulation with a fictional institution, ${esc(DEMO_ORG)}, and fictional risk owners. When a published item’s cross-domain read-across cites a domain, that domain’s owner is notified, records whether a control manages the risk, and records its disposition: an issue and its remediation plan, a risk acceptance, or closure once validated. The items are real; every response is example data. Nothing is saved or sent: reloading the page or resetting the demo starts again.</p>
    <div class="trk-intro-f"><div class="drop-group" role="group" aria-label="View as">${ownerBtns}</div><button type="button" class="copy-btn" data-act="trk-reset">Reset demo</button></div>
  </section>`;
  let body = '';
  if (trk && data) {
    const sel = trk.sel ? notifications(data).find((x) => x.key === trk.sel) : null;
    body = sel ? detail(trk, data, sel) : `${trk.owner === 'all' ? overview(trk, data) : ''}${registerCard(trk, data)}`;
  }
  return `<main id="main" tabindex="-1" class="main" data-k="main-tracker">
  <div class="title-row start"><h1 class="h1">Risk Tracker</h1><span class="list-sub">Demo · example data</span></div>
  ${intro}
  ${body}
</main>`;
}
