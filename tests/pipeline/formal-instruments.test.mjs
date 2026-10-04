// Owner decision 2026-10-03: newly issued formal rules and exam notices are in scope in the
// regulatory_trajectory section (thresholds.json formal_instrument_scope, launch
// "new_in_regulatory_trajectory"). Stage 1 keeps domain-relevant instruments and still drops
// off-domain rules and macro noise; validation, publish and selfcheck accept the RT
// formal-instrument codes and keep GL_FORMAL_RULE for the "none" setting. Calibration fixes of
// 2026-10-04: generic new-technology wording in the lexicon, Federal Register entries dated by their
// URL, and instrument verbs as attribution for a regulator source (FILTER 7.2 rule 10). FICTIONAL data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { feedCandidates, urlDateFor } from '../../pipeline/lib/collect.mjs';
import { compileTerm, outrightDrop, runPrefilter, scoreCandidate } from '../../pipeline/lib/prefilter.mjs';
import { DOMAIN_GATED_GROUPS, MATERIALITY_GROUPS, NON_TECH_PRUDENTIAL, TECH_CONTENT } from '../../pipeline/lib/lexicon.mjs';
import { loadThresholds } from '../../pipeline/lib/thresholds.mjs';
import {
  FORMAL_INSTRUMENT_SCOPES, RT_FORMAL_INSTRUMENT_CODES, decisionStyleIssues, formalScopeIssue, parseReasonCodeElements,
  parseReasonCodes, styleIssues, validateDecisions,
} from '../../pipeline/lib/validate.mjs';
import {
  FILTER_FIXTURE, ROOT, fixture, judgment, makeCandidate, makeDraft, makeSurvivor, readJson, rmrf, runScript, workspace, writeJson,
} from './_helpers.mjs';

const RUN = '2026-10-02-1400';
const STARTED = '2026-10-02T14:03:12-04:00';
const NOW = '2026-10-02T14:21:40-04:00';
const CODES = parseReasonCodes(fixture('filter-codes.md'));
const ELEMENTS = parseReasonCodeElements(fixture('filter-codes.md'));

const reg = (headline, lead = '', extra = {}) => makeCandidate({
  url: `https://agency.example.gov/news/${Math.random().toString(36).slice(2)}`,
  publication: 'Example Agency',
  source_id: 'example-agency',
  source_class: 'regulator',
  headline,
  lead,
  ...extra,
});

// ---------------------------------------------------------------- stage 1

test('stage 1 keeps a domain-relevant final rule, exam procedures and supervisory statement from a regulator feed', () => {
  const keep = [
    reg('Agencies issue final rule on computer-security incident notification requirements'),
    reg('Agencies update examination procedures for information security'),
    reg('Supervisory statement SS2/26: managing model risk in artificial intelligence systems'),
    reg('Cybersecurity: Cybersecurity Supervision Work Program', 'The agency updated the cybersecurity work program used by examiners.'),
    reg('Example authority publishes final guidelines on ICT risk management'),
    reg('Commission adopts delegated regulation on major ICT-related incident reporting'),
    reg('Industry letter on AI-enabled social engineering and deepfake fraud'),
    reg('Example regulator announces 2027 examination priorities including cybersecurity and AI'),
  ];
  const r = runPrefilter(keep);
  for (const c of keep) {
    const s = r.survivors.find((x) => x.candidate_id === c.candidate_id);
    const d = r.dropped.find((x) => x.candidate_id === c.candidate_id);
    assert.ok(s, `expected to survive: ${c.headline} (${d?.reason} ${d?.score ?? ''} ${d?.detail ?? ''})`);
    assert.equal(s.profile, 'lenient');
    assert.ok(s.matched.materiality.some((m) => /^formal_instrument: /.test(m)), `${c.headline}: ${JSON.stringify(s.matched)}`);
    assert.equal(s.components.noise, 0, `${c.headline}: formal-instrument vocabulary is not noise`);
  }
});

test('stage 1 still drops off-domain rules, prudential-only instruments and monetary-policy noise', () => {
  const drop = {
    'Final rule amending Community Reinvestment Act regulations': null,
    'Agencies issue final rule on capital requirements for large banks': /no technology content \(capital requirement\*\)/,
    'Board finalizes changes to its stress test and stress capital buffer': /no technology content/,
    'Letter on thematic feedback on IFRS 9 expected credit losses accounting': /no technology content/,
    'Final guidelines on liquidity risk appetite': /no technology content \(liquidity\)/,
    'Monetary policy statement and interest rate decision': null,
    'Minutes of the Monetary Policy Committee meeting': null,
    'Appointment of members of the Enforcement Decision Making Committee': null,
    'Quarterly statistical release on mortgage lending': null,
  };
  const cands = Object.keys(drop).map((h) => reg(h));
  const r = runPrefilter(cands);
  assert.equal(r.survivors.length, 0, r.survivors.map((s) => s.headline).join('; '));
  for (const c of cands) {
    const d = r.dropped.find((x) => x.candidate_id === c.candidate_id);
    assert.equal(d.reason, 'off_domain', c.headline);
    if (drop[c.headline]) assert.match(d.detail, drop[c.headline], c.headline);
  }
  assert.equal(r.counts.off_domain, cands.length);
});

test('formal-instrument points count only with a qualifying domain; technology content keeps a quantification rule', () => {
  assert.deepEqual([...DOMAIN_GATED_GROUPS], ['formal_instrument']);
  assert.ok(MATERIALITY_GROUPS.formal_instrument);
  const off = scoreCandidate(reg('Final rule amending Community Reinvestment Act regulations'), 'lenient');
  assert.deepEqual(off.domains, []);
  assert.ok(!(off.matched.materiality ?? []).some((m) => m.startsWith('formal_instrument')), JSON.stringify(off.matched));
  const on = scoreCandidate(reg('Final rule on computer-security incident notification'), 'lenient');
  assert.ok(on.matched.materiality.includes('formal_instrument: final rule*'), JSON.stringify(on.matched));
  // the same rule scored before the change lost 2 points to lenient noise; now it gains them
  assert.equal(on.components.noise, 0);
  // risk_quantification with technology content is not prudential-only
  const r = runPrefilter([reg('Final rule on operational risk capital and loss data reporting')]);
  assert.equal(r.survivors.length, 1, JSON.stringify(r.dropped));
  for (const t of [...NON_TECH_PRUDENTIAL, ...TECH_CONTENT]) compileTerm(t);
});

test('formal-instrument identifiers match; look-alikes do not', () => {
  const terms = Object.values(MATERIALITY_GROUPS.formal_instrument).flat().map(compileTerm);
  const hits = (s) => terms.filter((t) => t.re.test(s)).map((t) => t.id);
  for (const s of ['SR 26-3: guidance on third-party risk', 'FIL-45-2026 cybersecurity resources', 'OCC Bulletin 2026-48', 'PS7/26 operational resilience',
    'FG26/9: guidance on operational resilience', 'PS26/19: policy statement',
    'Circular 22/806 on outsourcing arrangements', 'Authority issues revised circular on ICT risk', 'Interim final rule on incident notification',
    'Final report on draft RTS on ICT risk', 'Revised Comptroller\'s Handbook booklet', 'IT Handbook update', 'Final rule rescinds guidance']) {
    assert.ok(hits(s).length, s);
  }
  for (const s of ['Circular relationships among AI firms', 'The circular economy and data centres', 'Microsoft security bulletin for October',
    'Its new chatbot leaks data', 'Finance ministers meet', 'it handbook']) {
    assert.deepEqual(hits(s), [], s);
  }
});

test('a bare identifier headline is scored with its lead; agency names and credit extensions are not domain terms', () => {
  // the SR-letter feed carries "SR 26-2" as the headline and the title as the description
  const sr = reg('SR 26-2', 'Revised Guidance on Model Risk Management', { url: 'https://agency.example.gov/srletters/sr2602.htm' });
  const plainLead = reg('Weekly update', 'Revised Guidance on Model Risk Management');
  const r = runPrefilter([sr, plainLead]);
  assert.ok(r.survivors.some((s) => s.candidate_id === sr.candidate_id), JSON.stringify(r.dropped));
  assert.ok(!r.survivors.some((s) => s.candidate_id === plainLead.candidate_id));
  const s = r.survivors.find((x) => x.candidate_id === sr.candidate_id);
  assert.ok(s.matched.materiality.some((m) => /^formal_instrument: /.test(m)));
  assert.ok(!Object.values(s.matched).flat().some((m) => m.endsWith('(lead)')), 'scored as the headline');
  // "Federal Deposit Insurance Corporation" in a lead is not insurance; "Extensions of Credit" is not a browser extension
  const fdic = reg('Interim final rule on expanded examination cycle', 'The Office of the Comptroller of the Currency and the Federal Deposit Insurance Corporation issued an interim final rule.');
  const credit = reg('Regulation A: Extensions of Credit by Federal Reserve Banks', 'The Board adopted final amendments to Regulation A.');
  const ext = reg('Malicious browser extensions steal session tokens');
  const r2 = runPrefilter([fdic, credit, ext]);
  assert.deepEqual(r2.survivors.map((x) => x.candidate_id), [ext.candidate_id], JSON.stringify(r2.dropped));
});

test('news of a formal instrument is not marketing when an authority is the subject; a vendor launch still is', () => {
  const news = (headline) => makeCandidate({ headline, lead: '' });
  assert.equal(outrightDrop(news('Fed announces final rule on third-party risk management for bank service providers'), 'standard'), null);
  assert.equal(outrightDrop(news('Regulators release updated cybersecurity assessment tool for banks'), 'standard'), null);
  assert.deepEqual(outrightDrop(news('Exampleco announces new fraud detection service for banks'), 'standard'), { reason: 'marketing', detail: 'product launch' });
  // an authority subject exempts only the product-launch and availability patterns
  assert.deepEqual(outrightDrop(news('Regulator appoints new chief information officer'), 'standard'), { reason: 'marketing', detail: 'appointment' });
});

test('calibration 2026-10-04: a supervisory priority on digital innovation and new technologies survives; the phrase alone does not', () => {
  const priority = reg('Example authority sets new supervisory priority on digital innovation from 2027',
    'The priority aims to ensure supervisors have the expertise to oversee the use of new technologies.');
  const speech = reg('Example official: Digital innovation - hindrance or booster for business models?', 'Keynote speech at an annual conference.');
  const r = runPrefilter([priority, speech]);
  const s = r.survivors.find((x) => x.candidate_id === priority.candidate_id);
  assert.ok(s, JSON.stringify(r.dropped));
  assert.deepEqual(s.domains, ['ai']);
  assert.equal(r.dropped.find((x) => x.candidate_id === speech.candidate_id)?.reason, 'off_domain', 'one weak term never qualifies a domain');
});

test('Federal Register entries are dated from the URL as a calendar date, so every run that day collects them', () => {
  const source = { id: 'fedreg-example-final-rules', publication: 'Example Agency', source_class: 'regulator', region: 'US', paywalled: false,
    url: 'https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=example-agency&conditions%5Btype%5D%5B%5D=RULE' };
  const link = 'https://www.federalregister.gov/documents/2026/10/02/2026-00001/computer-security-incident-notification';
  assert.equal(urlDateFor(source, link), '2026-10-02');
  assert.equal(urlDateFor(source, 'https://www.federalregister.gov/public-inspection/current'), null);
  assert.equal(urlDateFor({ ...source, url: 'https://agency.example.gov/rss' }, link), null, 'other hosts keep the feed date');
  // pubDate is midnight ET of the issue date (04:00 GMT); a 10:05 ET run's window opens at 00:05 ET
  const parsed = { entries: [
    { title: 'Computer-Security Incident Notification', link, published: '2026-10-02T04:00:00.000Z', date_only: null, date_status: 'ok', lead: '' },
    { title: 'Earlier rule', link: 'https://www.federalregister.gov/documents/2026/10/01/2026-00002/earlier-rule', published: '2026-10-01T04:00:00.000Z', date_only: null, date_status: 'ok', lead: '' },
  ] };
  for (const since of ['2026-10-02T00:05:00-04:00', '2026-10-02T12:05:00-04:00']) {
    const r = feedCandidates(source, parsed, { since: new Date(since), now: new Date('2026-10-02T18:05:00-04:00') });
    assert.deepEqual(r.candidates.map((c) => c.headline), ['Computer-Security Incident Notification'], since);
    assert.equal(r.candidates[0].published_date, '2026-10-02');
    assert.equal(r.url_dated, 2);
    assert.equal(r.redated, 0, 'the URL date equals the feed date in ET');
  }
});

test('7.2 rule 10: an issuer\'s instrument verb attributes a claim resting on one regulator source, and nothing else', () => {
  const item = (claim, cls) => ({
    section: 'regulatory_trajectory', claim, domains: ['resilience'], source_class: cls, mechanism: 'kri_kpi',
    interpretation: [{ domain: 'resilience', text: 'Fictional interpretation text with enough words to satisfy the interpretation length rule here.' }],
    validation_question: 'Is the time from incident classification to the initial report measured?',
    candidate_issue_statement: 'Where the time is not measured, a late report goes unseen until the supervisor notices it.',
    awareness_rationale: null,
    sources: [{ publication: 'Example Authority', url: 'https://agency.example.gov/ps1', source_class: cls }],
  });
  const warns = (claim, cls) => styleIssues(item(claim, cls)).some((x) => x.rule === 'FILTER 7.2' && /attribution verb/.test(x.message));
  for (const claim of ['The authority adopts incident rules for banks and insurers.', 'Two US agencies require banks to notify incidents within 36 hours.',
    'The authority withdraws its cloud outsourcing guidance for all regulated firms.', 'The agency will examine broker-dealers\' controls over trading algorithms.']) {
    assert.equal(warns(claim, 'regulator'), false, claim);
    assert.equal(warns(claim, 'vendor_threat_research'), true, `${claim} (not an instrument class)`);
  }
  assert.equal(warns('Incident notification deadlines for banks shorten to 36 hours.', 'regulator'), true, 'no verb at all still warns');
});

// ---------------------------------------------------------------- codes and scope

test('formal_instrument_scope: GL_FORMAL_RULE only at "none"; the RT formal-instrument codes never then', () => {
  assert.deepEqual(Object.keys(FORMAL_INSTRUMENT_SCOPES), ['none', 'new_in_regulatory_trajectory', 'new_any_section']);
  assert.deepEqual([...RT_FORMAL_INSTRUMENT_CODES], ['RT_PASS_FORMAL_RULE', 'RT_PASS_EXAM_NOTICE', 'RT_INSTRUMENT_NOT_NEW']);
  assert.match(formalScopeIssue('GL_FORMAL_RULE', 'new_in_regulatory_trajectory'), /only while formal_instrument_scope is "none"/);
  assert.match(formalScopeIssue('GL_FORMAL_RULE', 'new_any_section'), /only while formal_instrument_scope is "none"/);
  assert.equal(formalScopeIssue('GL_FORMAL_RULE', 'none'), null);
  for (const code of RT_FORMAL_INSTRUMENT_CODES) {
    assert.match(formalScopeIssue(code, 'none'), /drops at G5 as GL_FORMAL_RULE/, code);
    assert.equal(formalScopeIssue(code, 'new_in_regulatory_trajectory'), null, code);
    assert.equal(formalScopeIssue(code, 'new_any_section'), null, code);
  }
  // other codes, unknown or missing scopes: no opinion
  assert.equal(formalScopeIssue('RT_PASS_SPEECH', 'none'), null);
  assert.equal(formalScopeIssue('GL_FORMAL_RULE', undefined), null);
  assert.equal(formalScopeIssue('GL_FORMAL_RULE', 'toString'), null);
  // RT codes keep the section invariants: prefix RT_ is regulatory_trajectory, *_PASS_ is a pass
  assert.equal(CODES.get('RT_PASS_FORMAL_RULE'), 'pass');
  assert.equal(CODES.get('RT_PASS_EXAM_NOTICE'), 'pass');
  assert.equal(CODES.get('RT_INSTRUMENT_NOT_NEW'), 'drop');
  assert.equal(ELEMENTS.get('RT_INSTRUMENT_NOT_NEW'), 'R3f');
  assert.equal(ELEMENTS.get('RT_PASS_FORMAL_RULE'), 'R1');
});

function formalRun() {
  const rule = reg('Agencies adopt incident notification rule for banking organisations',
    'Banking organisations must notify their primary regulator of a significant computer-security incident within 36 hours of determining it occurred.',
    { url: 'https://agency.example.gov/news/final-rule-incident-notification', published_date: '2026-10-01' });
  const reminder = reg('Reminder: incident notification compliance date approaches', 'The compliance date for the existing rule is next month.',
    { url: 'https://agency.example.gov/news/compliance-date-reminder' });
  const decisions = {
    run_id: RUN,
    threshold_level: 'high',
    judgments: [
      judgment(rule, {
        section_tested: 'regulatory_trajectory',
        reason_code: 'RT_PASS_FORMAL_RULE',
        reason: 'R1 final rule; R1f all banking organisations; R2 two US banking agencies; R3f new (issued 2026-10-01; archive: none); R4f 36h incident notification; R5 rule text public | kri_kpi K1-4: determination-to-notification time',
      }),
      judgment(reminder, { section_tested: 'regulatory_trajectory', verdict: 'drop', reason_code: 'RT_INSTRUMENT_NOT_NEW', reason: 'R3f compliance-date reminder for an existing rule; not new', draft_index: null }),
    ],
    items: [makeDraft([rule], {
      section: 'regulatory_trajectory',
      claim: 'US banking agencies publish a final rule requiring computer-security incident notification within 36 hours.',
      domains: ['cyber', 'resilience'],
      source_class: 'regulator',
      mechanism: 'kri_kpi',
      interpretation: [
        { domain: 'cyber', text: 'The notification clock starts at determination, so triage speed now carries a regulatory deadline as well as a containment one.' },
        { domain: 'resilience', text: 'Incident classification feeds the notification decision, so unclear severity criteria delay escalation and recovery coordination together.' },
      ],
      validation_question: 'Is the time from incident determination to external notification measured and reported for every significant incident?',
      candidate_issue_statement: 'If the time from incident determination to external notification is not measured, missed notification deadlines could go undetected and lead to regulatory breaches.',
    })],
  };
  const ws = workspace({ runId: RUN, candidates: [rule, reminder], survivors: [rule, reminder].map((c) => makeSurvivor(c, { profile: 'lenient' })), decisions, startedAt: STARTED });
  const setScope = (value) => writeJson(path.join(ws.dir, 'thresholds.json'), {
    level: 'high',
    global: {
      max_event_age_days: { value: 7, element: 'G7, C5 Branch B, E3 recency, R3f window', launch: 7, loosening_steps: [14] },
      formal_instrument_scope: { value, element: 'G5; §4.1 route', launch: 'new_in_regulatory_trajectory', loosening_steps: ['new_any_section'] },
    },
  });
  setScope('new_in_regulatory_trajectory');
  const selfcheck = (extra = []) => runScript('selfcheck', ['--run', RUN, '--work-dir', ws.work, '--archive', ws.archive, '--thresholds', path.join(ws.dir, 'thresholds.json'), '--filter', FILTER_FIXTURE, ...extra]);
  return { ws, rule, reminder, decisions, setScope, selfcheck };
}

test('validateDecisions: RT formal-instrument codes follow the RT invariants', () => {
  const { ws, rule, reminder, decisions } = formalRun();
  try {
    const ctx = { runId: RUN, candidates: [rule, reminder], survivorIds: [rule.candidate_id, reminder.candidate_id], archiveItems: [], reasonCodes: CODES, style: false };
    assert.deepEqual(validateDecisions(decisions, ctx).errors, []);
    const bad = structuredClone(decisions);
    bad.judgments[1].section_tested = null;
    assert.ok(validateDecisions(bad, ctx).errors.some((e) => /RT_INSTRUMENT_NOT_NEW requires regulatory_trajectory/.test(e)));
    const bad2 = structuredClone(decisions);
    bad2.judgments[0].section_tested = 'capability_shift';
    assert.ok(validateDecisions(bad2, ctx).errors.some((e) => /RT_PASS_FORMAL_RULE requires regulatory_trajectory/.test(e)));
    // FILTER §8.3 invariant 10: RT_INSTRUMENT_NOT_NEW is NEAR only as "NEAR R3f/max_event_age_days"
    const knobs = loadThresholds(path.join(ws.dir, 'thresholds.json')).knobs();
    const nearIssues = (reason) => {
      const near = structuredClone(decisions);
      near.judgments[1].reason = reason;
      return decisionStyleIssues(near, { reasonElements: ELEMENTS, knobs }).filter((x) => x.rule === 'FILTER 8.4').map((x) => x.message);
    };
    assert.deepEqual(nearIssues('NEAR R3f/max_event_age_days: final rule first issued 10 days before the slot'), []);
    assert.ok(nearIssues('NEAR R3f: compliance-date reminder; not new').some((m) => /RT_INSTRUMENT_NOT_NEW is NEAR only as "NEAR R3f\/max_event_age_days: "/.test(m)));
    assert.ok(nearIssues('NEAR R3f/formal_instrument_scope: reminder').some((m) => /NEAR only as "NEAR R3f\/max_event_age_days: "/.test(m)));
  } finally {
    rmrf(ws.dir);
  }
});

test('publish and selfcheck accept an RT_PASS_FORMAL_RULE item at the launch scope', () => {
  const { ws, rule, reminder, selfcheck } = formalRun();
  try {
    const s = selfcheck();
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stderr, /self-check: 0 error\(s\)/);
    const r = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /FILTER 8\.3/);
    const archive = readJson(ws.archive);
    assert.deepEqual(archive.items.map((i) => [i.id, i.section, i.mechanism, i.source_class]), [['RS-261002-1400-01', 'regulatory_trajectory', 'kri_kpi', 'regulator']]);
    const rec = readJson(ws.runs).runs[0];
    assert.deepEqual(rec.stage2_by_section.regulatory_trajectory, { tested: 2, passed: 1 });
    const rows = fs.readFileSync(path.join(ws.logs, '2026', '10', `${RUN}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.find((x) => x.candidate_id === rule.candidate_id).reason_code, 'RT_PASS_FORMAL_RULE');
    assert.equal(rows.find((x) => x.candidate_id === reminder.candidate_id).reason_code, 'RT_INSTRUMENT_NOT_NEW');
  } finally {
    rmrf(ws.dir);
  }
});

test('selfcheck: the RT formal-instrument codes are errors at "none"; GL_FORMAL_RULE is an error at the launch scope (warnings in publish)', () => {
  const { ws, rule, setScope, selfcheck } = formalRun();
  try {
    setScope('none');
    const s = selfcheck();
    assert.equal(s.status, 1, s.stderr);
    assert.match(s.stderr, /ERROR decisions\.judgments\[0\].*RT_PASS_FORMAL_RULE applies only while formal_instrument_scope is not "none".*\(FILTER 8\.3\)/);
    assert.match(s.stderr, /ERROR decisions\.judgments\[1\].*RT_INSTRUMENT_NOT_NEW applies only while/);
    assert.equal(selfcheck(['--lenient']).status, 0);

    // GL_FORMAL_RULE at the launch scope
    setScope('new_in_regulatory_trajectory');
    const file = path.join(ws.work, RUN, 'decisions.json');
    const d = readJson(file);
    d.judgments[1] = { ...d.judgments[1], section_tested: null, reason_code: 'GL_FORMAL_RULE', reason: 'G5 compliance-date reminder for an existing rule' };
    writeJson(file, d);
    const g = selfcheck();
    assert.equal(g.status, 1, g.stderr);
    assert.match(g.stderr, /ERROR decisions\.judgments\[1\].*GL_FORMAL_RULE is recorded only while formal_instrument_scope is "none" \(now "new_in_regulatory_trajectory"\)/);
    const dry = runScript('publish', ['--run', RUN, '--now', NOW, '--dry-run', ...ws.flags]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stderr, /warn .*GL_FORMAL_RULE is recorded only while formal_instrument_scope is "none"/);
    // at "none", GL_FORMAL_RULE is the code (the pass is then inconsistent, so drop the item)
    setScope('none');
    d.judgments[0] = judgment(rule, { section_tested: null, verdict: 'drop', reason_code: 'GL_FORMAL_RULE', reason: 'G5 final rule while formal instruments are out of scope', draft_index: null });
    d.items = [];
    writeJson(file, d);
    const n = selfcheck();
    assert.equal(n.status, 0, n.stderr);
  } finally {
    rmrf(ws.dir);
  }
});

// ---------------------------------------------------------------- sync with the live standard

test('sync: FILTER.md §8.2 lists the formal-instrument codes; thresholds.json sets a known formal_instrument_scope', () => {
  const filter = fs.readFileSync(path.join(ROOT, 'pipeline', 'FILTER.md'), 'utf8');
  const codes = parseReasonCodes(filter);
  assert.equal(codes.get('RT_PASS_FORMAL_RULE'), 'pass');
  assert.equal(codes.get('RT_PASS_EXAM_NOTICE'), 'pass');
  assert.equal(codes.get('RT_INSTRUMENT_NOT_NEW'), 'drop');
  assert.equal(codes.get('RT_INSTRUMENT_INELIGIBLE'), 'drop');
  assert.equal(codes.get('GL_FORMAL_RULE'), 'drop');
  const elements = parseReasonCodeElements(filter);
  assert.ok(elements.get('RT_INSTRUMENT_NOT_NEW'), 'RT_INSTRUMENT_NOT_NEW names an element');
  const knob = loadThresholds(path.join(ROOT, 'pipeline', 'thresholds.json')).knobs()?.get('formal_instrument_scope');
  assert.ok(knob, 'formal_instrument_scope knob');
  assert.ok(Object.hasOwn(FORMAL_INSTRUMENT_SCOPES, knob.value), `value ${knob.value}`);
  assert.equal(knob.launch, 'new_in_regulatory_trajectory');
});
