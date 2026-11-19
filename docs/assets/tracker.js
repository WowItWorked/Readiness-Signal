// Readiness Signal: the risk tracker demo (owner decision 2026-11-19, SPEC §7.6). A simulation for
// demonstrations only: each cross-domain read-across in the archive becomes a notification to a
// fictional risk owner at a fictional institution, who records whether a control manages the
// risk and, where one does not, tracks the steps that close the gap. State lives in memory only
// (no storage APIs): a reload or "Reset demo" starts again from the same seeded example.
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

export const STEP_STATUS = Object.freeze({ todo: 'Not started', doing: 'In progress', done: 'Done' });
const NEXT_STATUS = { todo: 'doing', doing: 'done', done: 'todo' };

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

/**
 * The seeded demo: per domain, the two newest notifications are unread. Of the older ones that ask
 * for action (candidate issue or KRI / KPI), the first has no control and a three-step plan (one
 * done, one in progress, one overdue) and the second is partly covered with two steps. Everything
 * else is covered by a control, and awareness-only items are marked not applicable.
 */
export function initTracker(data, today) {
  const resp = {};
  let n = 0;
  const step = (text, due, status) => ({ id: `s${++n}`, text, due, status });
  const seen = {};
  const gaps = {};
  for (const x of notifications(data)) {
    const i = (seen[x.domain] = (seen[x.domain] ?? -1) + 1);
    const recs = recommendations(data.byId.get(x.itemId), x.domain);
    const actionable = x.mechanism !== 'awareness_only';
    const g = actionable && i >= 2 ? (gaps[x.domain] = (gaps[x.domain] ?? 0) + 1) : 0;
    if (i < 2) resp[x.key] = { read: false, control: null, ref: '', steps: [] };
    else if (g === 1) {
      resp[x.key] = { read: true, control: 'none', ref: '', steps: [step(recs[0], addDays(today, -9), 'done'), step(recs[1], addDays(today, 6), 'doing'), step(recs[2], addDays(today, -2), 'todo')] };
    } else if (g === 2) {
      resp[x.key] = { read: true, control: 'partial', ref: 'Existing control covers part of the exposure.', steps: [step(recs[0], addDays(today, -4), 'done'), step(recs[recs.length - 1], addDays(today, 14), 'todo')] };
    } else resp[x.key] = { read: true, control: actionable ? 'in_place' : 'na', ref: actionable ? 'Covered by an existing control.' : '', steps: [] };
  }
  return { today, owner: 'all', sel: null, preview: false, resp, n, draft: '' };
}

/** Where one notification stands, from its response. */
export function stateOf(r) {
  if (!r || !r.read) return 'new';
  if (!r.control) return 'open';
  if (!needsPlan(r.control)) return 'covered';
  if (r.steps.length && r.steps.every((s) => s.status === 'done')) return 'closed';
  return 'gap';
}
export const STATE_LABEL = { new: 'New', open: 'Awaiting response', covered: 'Covered', gap: 'Gap open', closed: 'Gap closed' };

const overdue = (s, today) => s.status !== 'done' && s.due && s.due < today;

/** Counts per owner, for the overview. */
export function ownerSummary(trk, data) {
  const all = notifications(data);
  return OWNERS.map((o) => {
    const mine = all.filter((x) => x.domain === o.domain);
    const st = mine.map((x) => stateOf(trk.resp[x.key]));
    const steps = mine.flatMap((x) => (trk.resp[x.key] ? trk.resp[x.key].steps : []));
    return {
      ...o,
      label: M.DOMAIN_BY_KEY.get(o.domain).label,
      total: mine.length,
      fresh: st.filter((s) => s === 'new').length,
      open: st.filter((s) => s === 'open').length,
      gaps: st.filter((s) => s === 'gap').length,
      closed: st.filter((s) => s === 'closed').length,
      covered: st.filter((s) => s === 'covered').length,
      stepsDone: steps.filter((s) => s.status === 'done').length,
      steps: steps.length,
      late: steps.filter((s) => overdue(s, trk.today)).length,
    };
  });
}

// ---------------------------------------------------------------------------------------
// Actions: a pure reducer. `d` is the element's dataset; `value` the field's value.

function patchResp(trk, key, fn) {
  const cur = trk.resp[key] || { read: false, control: null, ref: '', steps: [] };
  return { ...trk, resp: { ...trk.resp, [key]: fn(cur) } };
}

export function trackerAct(trk, d, value, data) {
  switch (d.act) {
    case 'trk-owner': return { ...trk, owner: d.v, sel: null, preview: false, draft: '' };
    case 'trk-open': return { ...patchResp(trk, d.key, (r) => ({ ...r, read: true })), sel: d.key, preview: false, draft: '' };
    case 'trk-back': return { ...trk, sel: null, preview: false };
    case 'trk-preview': return { ...trk, preview: !trk.preview };
    case 'trk-control':
      if (!CONTROL_KEYS.includes(d.v)) return trk;
      return patchResp(trk, d.key, (r) => ({ ...r, read: true, control: d.v }));
    case 'trk-ref': return patchResp(trk, d.key, (r) => ({ ...r, ref: String(value ?? '').slice(0, 300) }));
    case 'trk-add': {
      const x = notifications(data).find((n) => n.key === d.key);
      const recs = x ? recommendations(data.byId.get(x.itemId), x.domain) : [];
      const text = d.rec !== undefined ? recs[Number(d.rec)] : trk.draft.trim();
      if (!text) return trk;
      const id = `s${trk.n + 1}`;
      const next = patchResp(trk, d.key, (r) => ({ ...r, steps: [...r.steps, { id, text, due: addDays(trk.today, 14), status: 'todo' }] }));
      return { ...next, n: trk.n + 1, draft: d.rec !== undefined ? trk.draft : '' };
    }
    case 'trk-draft': return { ...trk, draft: String(value ?? '').slice(0, 300) };
    case 'trk-status':
      return patchResp(trk, d.key, (r) => ({ ...r, steps: r.steps.map((s) => (s.id === d.step ? { ...s, status: NEXT_STATUS[s.status] } : s)) }));
    case 'trk-due':
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return trk;
      return patchResp(trk, d.key, (r) => ({ ...r, steps: r.steps.map((s) => (s.id === d.step ? { ...s, due: value || '' } : s)) }));
    case 'trk-remove':
      return patchResp(trk, d.key, (r) => ({ ...r, steps: r.steps.filter((s) => s.id !== d.step) }));
    case 'trk-reset': return { ...initTracker(data, trk.today), owner: trk.owner };
    default: return trk;
  }
}

// ---------------------------------------------------------------------------------------
// Rendering

const pill = (state) => `<span class="trk-state trk-${state}">${esc(STATE_LABEL[state])}</span>`;
const mechTag = (k) => `<span class="mech" data-mech="${esc(k)}"><span class="mech-label">${esc(M.mechOf(k).label)}</span></span>`;

function overview(trk, data) {
  const rows = ownerSummary(trk, data);
  const cards = rows.map((o) => `<button type="button" class="trk-owner-card" data-act="trk-owner" data-v="${o.domain}" data-k="trk-oc-${o.domain}">
      <span class="trk-avatar" aria-hidden="true">${esc(o.initials)}</span>
      <span class="trk-oc-t"><span class="trk-oc-role">${esc(o.role)}</span><span class="trk-oc-dom">${esc(o.label)} · ${o.total} read-across</span></span>
      <span class="trk-oc-n">
        ${o.fresh ? `<span class="trk-badge">${o.fresh} new</span>` : ''}
        <span>${o.gaps} gap${o.gaps === 1 ? '' : 's'} open</span>
        <span>${o.stepsDone}/${o.steps} steps done</span>
        ${o.late ? `<span class="trk-late">${o.late} overdue</span>` : ''}
      </span>
    </button>`).join('');
  const tot = rows.reduce((a, o) => ({ fresh: a.fresh + o.fresh, gaps: a.gaps + o.gaps, closed: a.closed + o.closed, late: a.late + o.late, covered: a.covered + o.covered }), { fresh: 0, gaps: 0, closed: 0, late: 0, covered: 0 });
  const stat = (n, l) => `<div class="trk-stat"><b>${n}</b><span>${esc(l)}</span></div>`;
  return `<section class="card trk-card" aria-labelledby="trk-ov-h" data-k="trk-ov">
    ${'<header class="card-head"><h2 class="h-19" id="trk-ov-h">Risk owners</h2><span class="sub-13">Each owner is notified when an item’s read-across cites their domain.</span></header>'}
    <div class="trk-stats">${stat(tot.fresh, 'new notifications')}${stat(tot.gaps, 'gaps open')}${stat(tot.late, 'steps overdue')}${stat(tot.closed, 'gaps closed')}${stat(tot.covered, 'covered by a control')}</div>
    <div class="trk-owner-grid">${cards}</div>
  </section>`;
}

function inbox(trk, data, owner) {
  const mine = notifications(data).filter((x) => x.domain === owner.domain);
  const rows = mine.map((x) => {
    const s = stateOf(trk.resp[x.key]);
    return `<li data-k="trk-n-${esc(x.key)}"><button type="button" class="trk-note${s === 'new' ? ' unread' : ''}" data-act="trk-open" data-key="${esc(x.key)}">
        <span class="trk-note-top">${s === 'new' ? '<span class="trk-dot" aria-hidden="true"></span>' : ''}<span class="trk-note-d">${esc(fmtKey(x.date))}</span>${mechTag(x.mechanism)}${pill(s)}</span>
        <span class="trk-note-c">${esc(x.claim)}</span>
        <span class="trk-note-r">${esc(x.text)}</span>
      </button></li>`;
  }).join('');
  const fresh = mine.filter((x) => stateOf(trk.resp[x.key]) === 'new').length;
  return `<section class="card trk-card" aria-labelledby="trk-in-h" data-k="trk-inbox-${owner.domain}">
    <header class="card-head"><h2 class="h-19" id="trk-in-h">Notifications · ${esc(owner.role)}</h2><span class="sub-13">${fresh ? `${fresh} new · ` : ''}${mine.length} read-across in ${esc(M.DOMAIN_BY_KEY.get(owner.domain).label)}</span></header>
    ${mine.length ? `<ul class="trk-notes">${rows}</ul>` : '<p class="trk-empty">No published item has cited this domain in its read-across yet. Notifications appear here as soon as one does.</p>'}
  </section>`;
}

function detail(trk, data, x, ui) {
  const it = data.byId.get(x.itemId);
  const r = trk.resp[x.key] || { control: null, ref: '', steps: [] };
  const s = stateOf(r);
  const owner = OWNER_BY_DOMAIN.get(x.domain);
  const dom = M.DOMAIN_BY_KEY.get(x.domain).label;
  const ctl = CONTROL_KEYS.map((k) => `<button type="button" class="drop-btn" data-act="trk-control" data-key="${esc(x.key)}" data-v="${k}" aria-pressed="${r.control === k}">${esc(CONTROL[k].label)}</button>`).join('');
  const recs = recommendations(it, x.domain);
  const have = new Set(r.steps.map((st) => st.text));
  const recList = recs.map((t, i) => `<li class="trk-rec"><span>${esc(t)}</span>${have.has(t) ? '<span class="trk-added">In the plan</span>' : `<button type="button" class="copy-btn" data-act="trk-add" data-key="${esc(x.key)}" data-rec="${i}">Add to plan</button>`}</li>`).join('');
  const done = r.steps.filter((st) => st.status === 'done').length;
  const steps = r.steps.map((st) => `<li class="trk-step${overdue(st, trk.today) ? ' late' : ''}" data-k="trk-st-${esc(st.id)}">
      <button type="button" class="trk-status trk-st-${st.status}" data-act="trk-status" data-key="${esc(x.key)}" data-step="${esc(st.id)}" aria-label="Status: ${esc(STEP_STATUS[st.status])}. Change status">${esc(STEP_STATUS[st.status])}</button>
      <span class="trk-step-t">${esc(st.text)}</span>
      <label class="trk-due"><span>Due</span><input type="date" value="${esc(st.due)}" data-act="trk-due" data-key="${esc(x.key)}" data-step="${esc(st.id)}" aria-label="Due date">${overdue(st, trk.today) ? '<span class="trk-late">Overdue</span>' : ''}</label>
      <button type="button" class="trk-x" data-act="trk-remove" data-key="${esc(x.key)}" data-step="${esc(st.id)}" aria-label="Remove step">Remove</button>
    </li>`).join('');
  const plan = needsPlan(r.control) ? `
    <div class="trk-block">
      <span class="kicker">Recommended to close the gap</span>
      <ul class="trk-recs">${recList}</ul>
    </div>
    <div class="trk-block">
      <div class="trk-plan-h"><span class="kicker">Remediation plan</span><span class="trk-prog"><progress max="${Math.max(1, r.steps.length)}" value="${done}"></progress> ${done} of ${r.steps.length} done</span></div>
      ${r.steps.length ? `<ul class="trk-steps">${steps}</ul>` : '<p class="trk-empty">No steps yet. Add a recommendation above or write your own.</p>'}
      <div class="trk-addrow"><input type="text" class="trk-input" value="${esc(trk.draft)}" data-act="trk-draft" placeholder="Add your own step" aria-label="New step"><button type="button" class="copy-btn" data-act="trk-add" data-key="${esc(x.key)}">Add step</button></div>
    </div>` : '';
  const mail = `To: ${owner.role}, ${DEMO_ORG}\nSubject: New read-across for ${dom}: ${x.claim}\n\nReadiness Signal published an item on ${fmtKey(x.date)} whose read-across cites ${dom}:\n\n${x.text}\n\nRecord whether a control manages this risk in the risk tracker.`;
  return `<section class="card trk-card trk-detail" aria-labelledby="trk-d-h" data-k="trk-d-${esc(x.key)}">
    <header class="card-head trk-d-head">
      <button type="button" class="small-link trk-back" data-act="trk-back">All notifications</button>
      <div class="trk-d-meta">${mechTag(x.mechanism)}${pill(s)}<span class="trk-note-d">Notified ${esc(fmtKey(x.date))}</span></div>
      <h2 class="h-19" id="trk-d-h">${esc(x.claim)}</h2>
      <a class="small-link" href="#${esc(x.itemId)}" data-act="reveal" data-id="${esc(x.itemId)}">Open the item</a>
    </header>
    <div class="trk-d-body">
      <div class="trk-block" data-mech="${esc(x.mechanism)}">
        <span class="kicker">Read-across for ${esc(dom)}</span>
        <p class="trk-read">${esc(x.text)}</p>
        <p class="trk-asks"><span class="trk-asks-k">What the item asks</span> ${esc(M.mechOf(x.mechanism).asks)}</p>
        <button type="button" class="small-link" data-act="trk-preview" aria-expanded="${trk.preview}">${trk.preview ? 'Hide' : 'Show'} the notification ${esc(owner.role)} received</button>
        ${trk.preview ? `<div class="trk-mail">${esc(mail)}</div>` : ''}
      </div>
      <div class="trk-block">
        <span class="kicker">Is there a control in place that manages this risk?</span>
        <div class="drop-group" role="group" aria-label="Control in place">${ctl}</div>
        ${r.control ? `<label class="trk-ref"><span>${r.control === 'in_place' || r.control === 'partial' ? 'Control reference or evidence' : 'Note'}</span><input type="text" class="trk-input" value="${esc(r.ref)}" data-act="trk-ref" data-key="${esc(x.key)}" placeholder="${r.control === 'in_place' ? 'For example, the control ID and its last test date' : 'Optional'}"></label>` : ''}
      </div>
      ${plan}
    </div>
  </section>`;
}

/** The Risk tracker page. `trk` is null until the archive has loaded. */
export function trackerMain(st) {
  const { trk, data, ui } = st;
  const owners = [['all', 'All owners'], ...OWNERS.map((o) => [o.domain, o.role])];
  const ownerBtns = owners.map(([k, l]) => `<button type="button" class="drop-btn" data-act="trk-owner" data-v="${k}" aria-pressed="${trk ? trk.owner === k : k === 'all'}">${esc(l)}</button>`).join('');
  const intro = `<section class="card drop-intro trk-intro" aria-labelledby="trk-h">
    <h2 class="h-19" id="trk-h"><span class="trk-demo">Demo</span> Read-across, routed to the people who own it</h2>
    <p class="drop-p">A simulation with a fictional institution, ${esc(DEMO_ORG)}, and fictional risk owners. When a published item’s cross-domain read-across cites a domain, that domain’s owner is notified, records whether a control manages the risk, and, if not, tracks the steps that close the gap. The items are real; every response is example data. Nothing is saved or sent: reloading the page or resetting the demo starts again.</p>
    <div class="trk-intro-f"><div class="drop-group" role="group" aria-label="View as">${ownerBtns}</div><button type="button" class="copy-btn" data-act="trk-reset">Reset demo</button></div>
  </section>`;
  let body = '';
  if (trk && data) {
    const owner = OWNER_BY_DOMAIN.get(trk.owner);
    const sel = trk.sel && owner ? notifications(data).find((x) => x.key === trk.sel) : null;
    body = !owner ? overview(trk, data) : sel ? detail(trk, data, sel, ui) : inbox(trk, data, owner);
  }
  return `<main id="main" tabindex="-1" class="main" data-k="main-tracker">
  <div class="title-row start"><h1 class="h1">Risk tracker</h1><span class="list-sub">Demo · example data</span></div>
  ${intro}
  ${body}
</main>`;
}
