// Second dry-run review: writing-rule and lint gaps on the hard constraints (institution names,
// unique descriptors, back-references, sector positions, inferred lapses, unresolvable or
// event-specific questions, vague harms), the FILTER.md §8.4 NEAR and [alt] marker rules, the
// knob reader, calibration of [alt] knob markers, and the lexicon additions. FICTIONAL data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findInstitutions } from '../../pipeline/lib/institutions.mjs';
import { loadThresholds } from '../../pipeline/lib/thresholds.mjs';
import {
  NEAR_KNOB_REQUIRED, decisionStyleIssues, findNameBySuffix, parseReasonCodeElements, parseReasonCodes, styleIssues, validateItem,
} from '../../pipeline/lib/validate.mjs';
import { ROOT, judgment, makeCandidate, makeDraft, makeSurvivor, rmrf, runScript, tempDir, workspace, writeJson } from './_helpers.mjs';

const FILTER_PATH = path.join(ROOT, 'pipeline', 'FILTER.md');
const THRESHOLDS_PATH = path.join(ROOT, 'pipeline', 'thresholds.json');
const FILTER_MD = fs.readFileSync(FILTER_PATH, 'utf8');
const MODELS = [...FILTER_MD.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((m) => JSON.parse(m[1])).filter((x) => x.claim)
  .map((m) => ({ ...m, update_of: m.update_of ? 'RS-261009-1000-01' : null, candidate_ids: ['c-0000000000'] }));
const [A, , , , E] = MODELS;

function layers(item) {
  const r = validateItem(item, { mode: 'draft' });
  const st = styleIssues(item);
  return { publish: r.errors, warnings: r.warnings, banned: st.filter((s) => s.banned), warn: st.filter((s) => !s.banned) };
}
const withField = (field, value) => {
  if (field === 'awareness_rationale') return { ...E, awareness_rationale: value };
  if (field === 'interpretation') return { ...A, interpretation: [{ domain: 'fraud', text: value }, A.interpretation[1]] };
  return { ...A, [field]: value };
};
const fmt = (l) => [...l.publish.map((e) => `E ${e}`), ...l.banned.map((s) => `B ${s.rule} ${s.field}: ${s.message}`), ...l.warn.map((s) => `w ${s.rule} ${s.field}: ${s.message}`), ...l.warnings.map((w) => `w ${w}`)].join('\n');
const publishError = (field, value, re) => {
  const l = layers(withField(field, value));
  assert.ok(l.publish.some((e) => re.test(e)), `${value}\nexpected a publishing error ${re}; got:\n${fmt(l)}`);
};
const banned = (field, value, re) => {
  const l = layers(withField(field, value));
  assert.deepEqual(l.publish, [], `${value}\n${fmt(l)}`);
  assert.ok(l.banned.some((s) => re.test(`${s.rule} ${s.field}: ${s.message}`)), `${value}\nexpected a banned rule ${re}; got:\n${fmt(l)}`);
};
const warned = (field, value, re) => {
  const l = layers(withField(field, value));
  assert.deepEqual(l.publish, [], `${value}\n${fmt(l)}`);
  assert.ok([...l.warn.map((s) => `${s.rule} ${s.field}: ${s.message}`), ...l.warnings].some((s) => re.test(s)), `${value}\nexpected a warning ${re}; got:\n${fmt(l)}`);
};
const clean = (field, value) => {
  const l = layers(withField(field, value));
  assert.deepEqual(l.publish, [], `${value}\n${fmt(l)}`);
  assert.deepEqual(l.banned.map((s) => `${s.rule} ${s.field}: ${s.message}`), [], value);
  return l;
};

test('V4: possessive, relative and majority-share descriptors identify one institution', () => {
  publishError('claim', 'A US card network that processes most debit transactions disclosed a 9-hour outage.', /unique descriptor "card network that processes most"/);
  publishError('claim', 'A G-SIB whose chief executive testified on 30 September disclosed a breach.', /unique descriptor "A G-SIB whose chief executive"/);
  publishError('claim', 'The second-biggest UK high-street lender disclosed a 2-day app outage.', /unique descriptor "The second-biggest UK high-street lender"/);
  publishError('claim', 'Britain’s biggest lender says a 2-day app outage followed a supplier change.', /unique descriptor "Britain’s biggest lender"/);
  publishError('claim', 'A bank that is the sole clearer for government bonds disclosed a ransomware attack.', /unique descriptor "bank that is the sole"/);
  // not identifying: plural categories, event superlatives, a relative clause about the event, the organisation's own
  for (const t of ['The largest banks reported card authorisation delays for 5 hours, a processor says.', 'Britain’s biggest bank outage of 2026 lasted 9 hours, the regulator says.',
    'A regional lender whose app failed for 9 hours says a supplier change caused it.']) clean('claim', t);
  clean('validation_question', 'Can payments continue if the organisation’s only clearing bank is unavailable for a full business day?');
  clean('validation_question', 'Can payments continue if its only clearing bank is unavailable for a full business day, and when was that last tested?');
});

test('V4: names the lexicon lacks are caught by their legal-form ending; authorities and places are not', () => {
  publishError('claim', 'Patelco Credit Union says ransomware halted online banking for 2 weeks.', /names a specific financial institution/);
  publishError('claim', 'First Horizon Bank says a vendor breach exposed account numbers for 3 weeks.', /names a specific financial institution "First Horizon Bank"/);
  for (const t of ['The European Central Bank says banks must map dependencies on AI model providers.', 'The Federal Reserve Bank of New York says the payment system ran for 9 hours on backup.',
    'The World Bank and the Swiss National Bank published a joint study on cyber losses.', 'The National Credit Union Administration says 3 credit unions lost access for 6 hours.',
    'The Federal Deposit Insurance Corporation says the failed lender’s deposits moved within 2 days.', 'The Bank for International Settlements says tokenised deposits need new resilience tests.']) {
    const l = layers(withField('claim', t));
    assert.ok(!l.publish.some((e) => /names a specific financial institution/.test(e)), `${t}\n${fmt(l)}`);
  }
  assert.equal(findNameBySuffix('Unrest in the West Bank closed branches.'), null);
  assert.deepEqual(findNameBySuffix('Example Mutual Insurance says data was taken.'), { match: 'Example Mutual Insurance', soft: true });
  warned('interpretation', 'Example Mutual Insurance says policyholder data was taken through a file-transfer flaw, so claims systems inherit the exposure.', /"Example Mutual Insurance" may name a financial institution; use the category form if it does \(FILTER V4\)/);
});

test('V4: questions, issue statements and rationales never refer back to the story’s institution; role words are generic', () => {
  publishError('validation_question', 'Does help-desk MFA reset at the organisation require a callback, unlike the UK lender in the September breach?', /refers back to an institution in the story "the UK lender"/);
  publishError('candidate_issue_statement', 'Where help-desk staff reset MFA after a phone call alone, attackers can repeat the $25m loss the affected bank suffered.', /refers back .* "the affected bank"/);
  publishError('candidate_issue_statement', 'Where help-desk staff reset MFA after a phone call alone, attackers can repeat the $25m loss the targeted insurer suffered.', /"the targeted insurer"/);
  for (const q of ['Are the primary and backup operating accounts held at the same bank, with the date of the last review?',
    'Does confirmation of payee run against the receiving bank’s records before release of high-value payments?',
    'Does the TLS configuration of payment gateways disable the RSA key exchange, with evidence from the last scan?',
    'Can card payments continue if the primary card processor is unavailable for 4 hours?']) clean('validation_question', q);
  // in an interpretation a back-reference with a modifier warns; a bare one does not
  warned('interpretation', 'The affected lender restored payments after 9 hours, so impact tolerances set below that duration were exceeded across retail channels.', /"The affected lender" refers back to an institution in the story/);
  const l = clean('interpretation', 'The processor sits several links down most acquiring chains, so any exposure path is fourth-party at most and limited to merchant-side token data.');
  assert.ok(!l.warn.some((s) => /refers back/.test(s.message)));
});

test('V5: sector-level positions in every field; attributed statements only in a claim or interpretation', () => {
  banned('claim', 'Most UK banks still allow SMS fallback for passkey-enrolled customers.', /FILTER V5 claim: states a sector-level position "Most UK banks still"/);
  clean('claim', 'Most UK banks still allow SMS fallback for passkey users, a survey of 200 lenders finds.');
  banned('interpretation', 'Most large banks already route help-desk resets through a callback, so the exposure sits mainly with smaller lenders and fintech partners.', /sector-level position "Most large banks already"/);
  banned('interpretation', 'The majority of lenders still rely on SMS codes as a fallback, so passkey rollouts leave a phishable path open across retail banking.', /sector-level position "The majority of lenders still/);
  banned('interpretation', 'Few UK lenders have removed SMS fallback, so passkey rollouts across the sector leave a phishable path open for account takeover.', /sector-level position "Few UK lenders have"/);
  publishError('candidate_issue_statement', 'Where the organisation, like most banks, accepts SMS-code fallback after passkey enrolment, adversary-in-the-middle phishing can take over customer accounts.', /sector-level position "like most banks"/);
  publishError('candidate_issue_statement', 'Where help-desk staff reset MFA after a phone call alone, as is common across the sector, attackers can take over staff accounts.', /sector-level position "common across the sector"/);
  publishError('validation_question', 'Like many financial institutions, does the organisation accept SMS-code fallback after passkey enrolment, and when was it last tested?', /sector-level position "Like many financial institutions"/);
  publishError('awareness_rationale', 'The guidance restates expectations only. Passkeys are widely deployed across retail banking and standard practice already removes SMS fallback, so no framework change follows until a rule is proposed.', /sector-level position "widely deployed across retail banking"/);
  publishError('awareness_rationale', 'The paper restates expectations. The sector is well placed and the exposure is largely mitigated by current controls, so no framework change follows until supervisors set a deadline.', /sector-level position "The sector is well"/);
  publishError('awareness_rationale', 'The statement restates existing expectations. Firms are generally compliant with existing outsourcing rules, so no framework change follows until a consultation names new obligations.', /sector-level position "generally compliant"/);
  publishError('awareness_rationale', 'Banks rarely run this appliance, so no control, metric or framework change follows until a server edition is affected.', /sector-level position "Banks rarely"/);
  // not positions: an event's reach, a generic condition, an event fact, attackers' position
  clean('claim', 'Scammers targeted customers of many UK banks with cloned payment pages for 3 weeks.');
  for (const t of ['Firms that have not enabled number matching remain open to push-fatigue attacks on remote access for staff.',
    'The incident was largely contained to one region, so cross-region failover assumptions held for every affected service.',
    'Attackers are well positioned to reuse stolen session tokens until providers force re-authentication across tenants.']) clean('interpretation', t);
});

test('V5 and AO2: position paraphrases in rationales are errors', () => {
  publishError('awareness_rationale', 'The speech signals intent only. Existing third-party frameworks already capture concentration on AI model providers, so no new metric follows until a consultation is published.', /position "Existing third-party frameworks already capture"/);
  publishError('awareness_rationale', 'The organisation is unlikely to be affected because the flaw sits in a consumer product, so no control or metric change follows.', /position "organisation is unlikely to be affected"/);
  // FILTER's own Good rationales stay clean
  clean('awareness_rationale', 'The technique is addressed by the phishing-resistant authentication that common frameworks already expect, so the change is in tempo rather than in the control set and no control, metric or framework action follows.');
});

test('V5: evaluative words and lapses inferred from an outcome; attributed lapses warn', () => {
  banned('claim', 'A regional US lender with weak help-desk controls lost $25m to a deepfaked call.', /evaluative word about an institution's controls "weak help-desk controls"/);
  banned('interpretation', 'The processor lagged behind industry practice on token rotation, which shows how slow remediation turns a disclosed flaw into account takeover.', /evaluative word .* "lagged behind industry"/);
  banned('claim', 'A large UK bank had not patched the gateway flaw for 6 months before the breach.', /infers a lapse "had not patched"/);
  banned('claim', 'A crypto exchange left a hot wallet key on an unpatched server, losing $40m.', /infers a lapse "left a hot wallet key on an unpatched"/);
  banned('interpretation', 'The lender left its help-desk reset process without callback verification, so any caller with public staff details could take over accounts.', /infers a lapse "left its help-desk reset process without callback/);
  warned('claim', 'A large UK bank had not patched the gateway flaw for 6 months, its regulator says.', /lapse "had not patched": only inside a clause attributed/);
  for (const t of ['The outage left customers without access to payment apps for 9 hours across several regions.',
    'SMS fallback offers weaker security than passkeys, so the fallback sets the effective strength of the login flow.']) clean('interpretation', t);
});

test('7.5: unresolvable questions, references to the development or its victim, the reader’s own supervisor', () => {
  for (const q of ['Has the organisation considered the risk of deepfaked payment instructions?', 'Is the organisation prepared for deepfaked video calls requesting urgent payments?',
    'Is the organisation confident that help-desk MFA resets resist voice impersonation?', 'Is the organisation aware of the risk that passkey users can fall back to SMS codes?']) {
    banned('validation_question', q, /FILTER 7\.5 validation_question: ".*" cannot be resolved/);
  }
  banned('validation_question', 'Following the 30 September outage, does the organisation hold an exit plan for its cloud region?', /only makes sense at one institution "Following the 30 September outage"/);
  banned('validation_question', 'Does the organisation’s exposure to the Salesforce token theft extend to customer data, and when was it assessed?', /only makes sense at one institution "to the Salesforce token theft"/);
  banned('validation_question', 'Has the organisation remediated the finding its supervisor raised on help-desk MFA resets?', /only makes sense at one institution "the finding its supervisor"/);
  banned('candidate_issue_statement', 'Where help-desk resets accept a phone call alone, attackers can repeat the outcome seen in the September intrusion and halt operations for days.', /only makes sense at one institution "in the September intrusion"/);
  warned('validation_question', 'Are all ExampleMail appliances patched to the fixed release, and when was that verified?', /"ExampleMail" looks like a vendor product/);
  warned('validation_question', 'Is the root cause of a payment outage recorded after the incident is closed, with the date of the last review?', /"after the incident" may refer to one institution's event/);
  for (const q of ['Is the failover region ready for production load within the impact tolerance, with evidence from the last test?',
    'Is any payment instruction received by video call considered verified without an independent callback?',
    'Does each SaaS provider holding customer data notify the organisation of a compromise within 24 hours?']) {
    const l = clean('validation_question', q);
    assert.deepEqual(l.warn.map((s) => s.message), [], q);
  }
  // a rationale describes the development (AO3): a dated reference to it is allowed there
  clean('awareness_rationale', 'After the 30 September outage the provider published a root cause: a failed certificate rotation. Certificate expiry is a failure mode common frameworks already expect providers to manage, so no control, metric or framework action follows.');
});

test('7.6: vague harms and ratings', () => {
  banned('candidate_issue_statement', 'If help-desk resets accept a phone call alone, the organisation faces significant exposure from voice impersonation.', /vague consequence "faces significant exposure"/);
  banned('candidate_issue_statement', 'Where help-desk resets accept a phone call alone without a callback, there could be problems for staff accounts.', /vague consequence "there could be problems"/);
  warned('candidate_issue_statement', 'Where help-desk resets accept a phone call alone, attackers can take over staff accounts, a serious impact on payment operations.', /rating "serious impact"/);
});

test('FILTER §8.4: NEAR markers carry the recorded code’s element; gate, dedup, routine-vulnerability and jurisdiction codes only with their knob', () => {
  const reasonElements = parseReasonCodeElements(FILTER_MD);
  const knobs = loadThresholds(THRESHOLDS_PATH).knobs();
  const c = makeCandidate({ url: 'https://news.example.com/near' });
  const check = (code, reason, section = null, opts = { reasonElements, knobs }) => decisionStyleIssues({
    judgments: [judgment(c, { verdict: 'drop', reason_code: code, section_tested: section, reason, draft_index: null })], items: [],
  }, opts).map((s) => `${s.banned ? 'B' : 'w'} ${s.message}`);
  const ok = (...a) => assert.deepEqual(check(...a), [], a[1]);
  const bad = (re, ...a) => assert.ok(check(...a).some((m) => re.test(m)), `${a[1]}: ${check(...a).join(' | ')}`);
  bad(/^B reason: CS_ROUTINE_VULN is NEAR only as "NEAR C6\/cs_routine_vuln_exceptions: "/, 'CS_ROUTINE_VULN', 'NEAR C6: exploited zero-day; fixes pending; mass exploitation not shown', 'capability_shift');
  ok('CS_ROUTINE_VULN', 'NEAR C6/cs_routine_vuln_exceptions: mass exploitation, no patch for 4 days; C1-C5 hold', 'capability_shift');
  bad(/^B reason: RT_JURISDICTION is NEAR only as "NEAR R2\/rt_standard_setters: "/, 'RT_JURISDICTION', 'NEAR R2: standard setter meeting release; not a consultation', 'regulatory_trajectory');
  bad(/^B reason: NEAR C2 with CS_NO_SPECIFIC_CHANGE \(element C1\)/, 'CS_NO_SPECIFIC_CHANGE', 'NEAR C2: one researcher blog only', 'capability_shift');
  bad(/^B reason: knob ev_min_general_outlets controls E3, not E2a/, 'EV_BELOW_FLOOR', 'NEAR E2a/ev_min_general_outlets: 2.5h outage', 'executive_visibility');
  bad(/^B reason: "ev_min_outlets" is not a knob in thresholds\.json/, 'EV_NO_PROMINENCE', 'NEAR E3/ev_min_outlets: 1 general outlet', 'executive_visibility');
  bad(/^B reason: GL_OFF_DOMAIN: gate and dedup drops are never NEAR/, 'GL_OFF_DOMAIN', 'NEAR G1: lexicon false positive');
  ok('EV_BELOW_FLOOR', 'NEAR E2a/ev_disruption_min_hours: 2.5h app outage at a large bank', 'executive_visibility');
  ok('CS_NO_ASSUMPTION', 'NEAR C3/cs_branch_a_requires_assumption: exploited CVEs per month up from 10.5 to 18', 'capability_shift');
  ok('CS_NOT_NEW', 'NEAR C5: backups reachable by ransomware is established (T3) [alt EV:E3]', 'capability_shift');
  ok('CS_NOT_NEW', 'NEAR C5: established failure mode [alt EV:E3/ev_min_general_outlets]', 'capability_shift');
  ok('RT_SPEAKER_INELIGIBLE', 'NEAR X1/rt_bank_exec_scope: domestic systemic bank chief executive; sector call', 'regulatory_trajectory');
  ok('GL_STALE', 'NEAR G7/max_event_age_days: disclosed 9 days before the slot');
  ok('DD_SAME_STORY', 'NEAR M2/m2_min_scope_factor: scope grew 1.6x and crossed the 10m floor');
  // [alt] markers name the other section of an EV or CS drop; a knob there must control the element
  bad(/^B reason: an alternative-route marker follows an EV or CS drop and names the other section/, 'CS_NOT_NEW', 'C5 established [alt CS:C1/cs_accept_preprints]', 'capability_shift');
  bad(/^w reason: an alternative-route marker follows an EV or CS drop/, 'RT_NO_DIRECTION', 'R3 restatement [alt EV:E3]', 'regulatory_trajectory');
  bad(/^B reason: knob ev_disruption_min_hours controls E2a, not E3/, 'CS_NOT_NEW', 'C5 established [alt EV:E3/ev_disruption_min_hours]', 'capability_shift');
  // without the code table and the knobs only the fixed knob rules apply
  assert.deepEqual(check('CS_NO_SPECIFIC_CHANGE', 'NEAR C2: one researcher blog only', 'capability_shift', {}), []);
  assert.ok(check('CS_ROUTINE_VULN', 'NEAR C6: no exception', 'capability_shift', {}).some((m) => /CS_ROUTINE_VULN is NEAR only/.test(m)));
});

test('sync: §8.2 elements parse; every NEAR knob exists in thresholds.json and controls its element', () => {
  const elements = parseReasonCodeElements(FILTER_MD);
  const codes = parseReasonCodes(FILTER_MD);
  assert.equal(elements.size, codes.size);
  for (const [code, verdict] of codes) {
    if (verdict === 'drop' && /^(?:EV|CS|RT)_/.test(code)) assert.match(String(elements.get(code)), /^[ECR]\d[a-z]?$/, code);
    if (/^GL_/.test(code) && !['GL_NO_MECHANISM', 'GL_NOT_JUDGED'].includes(code)) assert.match(String(elements.get(code)), /^G\d+$/, code);
  }
  assert.equal(elements.get('RT_EXEC_OWN_POSITION'), 'R3b');
  assert.equal(elements.get('GL_NO_MECHANISM'), null);
  const knobs = loadThresholds(THRESHOLDS_PATH).knobs();
  assert.equal(knobs.size, 33);
  for (const [code, { element, knob }] of Object.entries(NEAR_KNOB_REQUIRED)) {
    assert.ok(codes.has(code), code);
    assert.ok(knobs.has(knob), `${code}: ${knob}`);
    assert.match(knobs.get(knob).element, new RegExp(`(?<![A-Za-z0-9])${element}(?![0-9])`), `${knob} element ${knobs.get(knob).element}`);
    if (elements.get(code)) assert.equal(elements.get(code), element, code);
  }
  for (const [, k] of knobs) assert.equal(typeof k.element, 'string');
  const dir = tempDir();
  try {
    assert.equal(loadThresholds(path.join(dir, 'none.json')).knobs(), null);
    writeJson(path.join(dir, 't.json'), { level: 'high', global: { max_event_age_days: { value: 7, element: 'G7' } }, surge_recheck_items: 4 });
    assert.deepEqual([...loadThresholds(path.join(dir, 't.json')).knobs().keys()], ['max_event_age_days']);
  } finally {
    rmrf(dir);
  }
});

test('FILTER models, Good examples and the fixture archive stay free of errors and banned rules', () => {
  for (const m of MODELS) {
    const l = layers(m);
    assert.deepEqual([...l.publish, ...l.banned.map((s) => s.message), ...l.warn.map((s) => s.message)], [], m.claim);
  }
  const archive = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'archive.json'), 'utf8'));
  for (const it of archive.items) {
    const r = validateItem(it, { mode: 'archive' });
    assert.deepEqual(r.errors, [], it.id);
    // The fixtures predate some earlier style rules (source_class on every source, source order,
    // relative dates, one "and" per question); none of the rules added in this review may fire.
    const predating = /^(?:always set it|relative date|more than one "and"|regulator after news)/;
    assert.deepEqual(styleIssues(it).filter((s) => s.banned && !predating.test(s.message)).map((s) => `${s.rule} ${s.field}: ${s.message}`), [], it.id);
  }
});

test('lexicon: crypto exchanges, payment and core-banking firms; "Chase", "Kraken", "CHIPS" disambiguated', () => {
  const names = (s) => [...new Set(findInstitutions(s).map((m) => m.name))];
  for (const [s, n] of [['Hackers stole $40m from Bybit', 'Bybit'], ['Kraken says withdrawals resumed', 'Kraken'], ['Finastra says data was taken', 'Finastra'],
    ['Marqeta and TSYS', 'Marqeta'], ['Patelco members lost access', 'Patelco Credit Union'], ['HKEX halted trading', 'Hong Kong Exchanges and Clearing'],
    ['CHIPS settled late', 'The Clearing House'], ['Chase customers lost access', 'JPMorgan Chase'], ['M&T said', 'M&T Bank'], ['Tether froze the wallets', 'Tether']]) {
    assert.ok(names(s).includes(n), `${s}: ${names(s)}`);
  }
  for (const s of ['Chase the outage until it is closed.', 'Kraken botnet infrastructure returned.', 'Engineers tether the device to a laptop.',
    'The CHIPS Act funds new fabs.', 'Anchorage hosts a data centre.', 'Azure Synapse pipelines failed.']) assert.deepEqual(names(s), [], s);
});

test('calibration counts knob-bearing [alt] markers and the stories near each knob', () => {
  const RUN = '2026-10-02-1400';
  const dir = tempDir();
  try {
    const runs = path.join(dir, 'runs.json');
    const logs = path.join(dir, 'logs');
    writeJson(runs, { schema_version: 1, runs: [{ run_id: RUN, slot: '2026-10-02T14:00:00-04:00', status: 'silent', items: [], funnel: { stage1_pass: 3 } }] });
    const row = (reason, code = 'CS_NOT_NEW') => JSON.stringify({ run_id: RUN, candidate_id: 'c-0000000000', publication: 'Example News', section_tested: 'capability_shift', verdict: 'drop', reason_code: code, reason, dedup: 'new' });
    const file = path.join(logs, '2026', '10', `${RUN}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${[
      row('NEAR C5: established failure mode [alt EV:E3/ev_min_general_outlets]'),
      row('C1 nothing new [alt EV:E3/ev_min_general_outlets]', 'CS_NO_SPECIFIC_CHANGE'),
      row('NEAR E3/ev_min_general_outlets: trade press only [alt CS:C1]', 'EV_NO_PROMINENCE'),
      row('C5 established [alt EV:E3]'),
    ].join('\n')}\n`);
    const r = runScript('calibration', ['--json', '--runs', runs, '--logs-dir', logs, '--archive', path.join(dir, 'none.json'), '--thresholds', path.join(dir, 'none.json'), '--now', '2026-10-03T00:00:00-04:00']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.near_misses, { C5: 1, 'E3/ev_min_general_outlets': 1 });
    assert.deepEqual(r.json.alt_near_misses, { 'E3/ev_min_general_outlets': 2 });
    assert.deepEqual(r.json.near_misses_by_knob, { ev_min_general_outlets: 3 });
    assert.match(r.stderr, /Stories near each knob/);
  } finally {
    rmrf(dir);
  }
});

test('selfcheck.mjs: a NEAR marker that breaks FILTER §8.4 is an error (a warning with --lenient)', () => {
  const RUN = '2026-10-02-1400';
  const a = makeCandidate({ url: 'https://news.example.com/vpn', headline: 'VPN appliance flaw exploited' });
  const ws = workspace({
    runId: RUN,
    candidates: [a],
    survivors: [makeSurvivor(a)],
    decisions: { run_id: RUN, threshold_level: 'high', judgments: [judgment(a, { verdict: 'drop', reason_code: 'CS_ROUTINE_VULN', reason: 'NEAR C6: exploited; patch available', draft_index: null })], items: [] },
    startedAt: '2026-10-02T14:03:12-04:00',
  });
  try {
    const args = ['--run', RUN, '--work-dir', ws.work, '--archive', ws.archive, '--thresholds', THRESHOLDS_PATH, '--filter', FILTER_PATH];
    const s = runScript('selfcheck', args);
    assert.equal(s.status, 1, s.stderr);
    assert.match(s.stderr, /ERROR decisions\.judgments\[0\].*CS_ROUTINE_VULN is NEAR only as "NEAR C6\/cs_routine_vuln_exceptions: "/);
    assert.equal(runScript('selfcheck', [...args, '--lenient']).status, 0);
    const fixed = JSON.parse(fs.readFileSync(path.join(ws.work, RUN, 'decisions.json'), 'utf8'));
    fixed.judgments[0].reason = 'C6: exploited; patch available; no exception';
    writeJson(path.join(ws.work, RUN, 'decisions.json'), fixed);
    assert.equal(runScript('selfcheck', args).status, 0);
  } finally {
    rmrf(ws.dir);
  }
});
