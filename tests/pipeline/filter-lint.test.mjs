// FILTER.md §7 and §2.9 lint (review round): the hard-constraint errors at the publishing gate,
// the style rules selfcheck.mjs makes errors, FILTER's own Good and Bad examples and §10.2 model
// items, the claims_may_name_institutions knob, and the source checks. FICTIONAL data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadThresholds } from '../../pipeline/lib/thresholds.mjs';
import {
  decisionStyleIssues, extraSentences, isComposedHeadline, styleIssues, validateDecisions, validateItem,
} from '../../pipeline/lib/validate.mjs';
import { ROOT, judgment, makeCandidate, makeDraft, makeSurvivor, rmrf, runScript, tempDir, workspace, writeJson } from './_helpers.mjs';

const FILTER_MD = fs.readFileSync(path.join(ROOT, 'pipeline', 'FILTER.md'), 'utf8');
/** FILTER.md §10.2 model items (fictional), as decisions.json drafts. */
const MODELS = [...FILTER_MD.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((m) => JSON.parse(m[1])).filter((x) => x.claim)
  .map((m) => ({ ...m, update_of: m.update_of ? 'RS-261009-1000-01' : null, candidate_ids: ['c-0000000000'] }));
const [A, , , , E] = MODELS;

/** publish = SPEC §6 / hard-constraint errors; banned = errors in selfcheck.mjs; warn = heuristics. */
function layers(item, opts = {}) {
  const r = validateItem(item, { mode: 'draft', ...opts });
  const st = styleIssues(item);
  return { publish: r.errors, banned: st.filter((s) => s.banned), warn: st.filter((s) => !s.banned), warnings: r.warnings };
}
const withField = (field, value) => {
  if (field === 'awareness_rationale') return { ...E, awareness_rationale: value };
  if (field === 'interpretation') return { ...A, interpretation: [{ domain: 'fraud', text: value }, A.interpretation[1]] };
  return { ...A, [field]: value };
};
const clean = (item, label = '') => {
  const l = layers(item);
  assert.deepEqual(l.publish, [], `${label}: ${l.publish.join(' | ')}`);
  assert.deepEqual(l.banned.map((s) => `${s.rule} ${s.field}: ${s.message}`), [], label);
  return l;
};
const publishError = (item, re, opts) => {
  const l = layers(item, opts);
  assert.ok(l.publish.some((e) => re.test(e)), `expected a publishing error ${re}; got:\n${l.publish.join('\n')}`);
};
const banned = (item, re) => {
  const l = layers(item);
  assert.deepEqual(l.publish, [], l.publish.join('\n'));
  assert.ok(l.banned.some((s) => re.test(`${s.rule} ${s.field}: ${s.message}`)), `expected a banned style rule ${re}; got:\n${[...l.banned, ...l.warn].map((s) => `${s.banned ? 'B' : 'w'} ${s.rule} ${s.field}: ${s.message}`).join('\n')}`);
};
const warned = (item, re) => {
  const l = layers(item);
  assert.deepEqual(l.publish, [], l.publish.join('\n'));
  assert.ok(l.warn.some((s) => re.test(`${s.rule} ${s.field}: ${s.message}`)), `expected a heuristic warning ${re}; got:\n${[...l.banned, ...l.warn].map((s) => `${s.rule} ${s.field}: ${s.message}`).join('\n')}`);
};

test('FILTER §10.2 model items A-E and the §7 Good examples raise no error and no banned rule', () => {
  assert.equal(MODELS.length, 5);
  MODELS.forEach((m, i) => assert.deepEqual(layers(m).warn, [], `model ${'ABCDE'[i]}`) || clean(m, `model ${'ABCDE'[i]}`));
  const GOOD = [
    ['claim', 'A nine-hour cloud region outage disrupted payment apps at several UK and US banks.'],
    ['claim', 'An AI developer says it disrupted a largely autonomous intrusion campaign against about 30 organisations.'],
    ['claim', 'Attackers persuaded an IT help desk to reset staff MFA, then halted operations for 10 days.'],
    ['claim', 'A large UK bank says a core-platform migration left customers without access for two days.'],
    ['claim', 'A G-SIB chief executive told legislators online platforms should share scam reimbursement costs.'],
    ['claim', 'A regional US lender and a card processor disclosed the same supplier breach, regulators say.'],
    ['claim', 'The Bank of England says firms must map dependencies on AI model providers.'],
    ['interpretation', 'Live video presence no longer verifies a payment instruction; approval steps that accept a call as verification inherit the attacker’s control of the channel.'],
    ['interpretation', 'The institutions failed together because each depended on the same region, a correlation that per-vendor assessments do not capture.'],
    ['validation_question', 'Does authorisation of high-value payments require confirmation through a channel independent of the requesting call or meeting, with no exception for live video or voice?'],
    ['validation_question', 'How many important business services depend on a single cloud region, and when was that count last reported?'],
    ['candidate_issue_statement', 'Where passkey-enrolled customers can still complete login through SMS-code or password fallback without additional verification, adversary-in-the-middle phishing can force the fallback and take over accounts the passkey rollout was expected to protect.'],
    ['awareness_rationale', 'The speech signals intent only: no consultation, definition or timetable has been issued. Reliance on external AI model providers already falls within the third-party and concentration categories supervisors expect frameworks to contain, so no framework change or new metric follows until a concrete proposal is published.'],
    ['awareness_rationale', 'The technique is addressed by the phishing-resistant authentication that common frameworks already expect, so the change is in tempo rather than in the control set and no control, metric or framework action follows.'],
    ['awareness_rationale', 'Transaction monitoring rules that supervisors already expect address the mule pattern, so no new control, metric or framework entry follows.'],
  ];
  for (const [f, v] of GOOD) clean(withField(f, v), `${f}: ${v}`);
});

test('FILTER §7 Bad tables: every example is flagged, hard constraints at the publishing gate', () => {
  // §7.2
  banned(withField('claim', 'What the latest cloud outage means for banks.'), /FILTER 7\.2 claim: headline or teaser construction "What"/);
  publishError(withField('claim', 'AI threats keep growing.'), /claim: 4 words/);
  publishError(withField('claim', 'Barclays’s lax help-desk controls let attackers bypass MFA.'), /claim: names a specific financial institution.*Barclays/);
  publishError(withField('claim', 'Our MFA assumptions may not hold.'), /claim: first-person voice "Our"/);
  // §7.4
  banned(withField('interpretation', 'Criminals used deepfake video to steal money from a company.'), /FILTER 7\.4 interpretation\[0\]\.text: 10 words/);
  banned(withField('interpretation', 'The outage affected many companies.'), /FILTER 7\.4 interpretation\[0\]\.text: 5 words/);
  // §7.5
  publishError(withField('validation_question', 'Are we ready for deepfakes?'), /first-person voice "we"/);
  banned(withField('validation_question', 'Can you confirm that controls over AI are adequate?'), /FILTER 7\.5 validation_question: open or leading "confirm that controls over AI are adequate"/);
  banned(withField('validation_question', 'Can you confirm that controls over AI are adequate?'), /FILTER V2 validation_question: second person "you"/);
  publishError(withField('validation_question', 'What is Barclays doing after its outage?'), /validation_question: names a specific financial institution/);
  banned(withField('validation_question', 'Has the risk described above been considered?'), /not paste-ready: "described above"/);
  banned(withField('validation_question', 'Does the help desk verify callers, is MFA enforced everywhere, and are logs reviewed?'), /3 yes\/no clauses/);
  banned(withField('validation_question', 'Has the organisation considered the risk of deepfaked payment instructions?'), /"Has the organisation considered" cannot be resolved/);
  banned(withField('validation_question', 'Following the 30 September outage, does the organisation hold an exit plan for its cloud provider?'), /only makes sense at one institution "Following the 30 September outage"/);
  publishError(withField('validation_question', 'Like many banks, does the organisation accept SMS-code fallback after passkey enrolment?'), /sector-level position "Like many banks"/);
  // §7.6
  publishError(withField('candidate_issue_statement', 'The bank’s payment controls are weak and should be strengthened.'), /presumes the reader's institution type "The bank’s"/);
  banned(withField('candidate_issue_statement', 'Where controls may be inadequate, there may be increased risk.'), /vague consequence "may be inadequate"/);
  banned(withField('candidate_issue_statement', 'If the answer is no, raise an issue.'), /the conditional clause restates the answer/);
  // §7.7
  banned(withField('awareness_rationale', 'No action needed at this time; continue to monitor.'), /banned fallback phrase "No action needed"/);
  publishError(withField('awareness_rationale', 'Already covered by existing controls.'), /states or implies a position "Already covered"/);
  banned(withField('awareness_rationale', 'If asked, say the institution is covered.'), /banned fallback phrase "If asked"/);
});

test('2a: "the bank" is lowercase and never "the Bank of England"; reader types in paste-ready fields are errors', () => {
  for (const t of ['The Bank of England signalled direction on AI model concentration and third-party risk for firms.',
    'Supervisors at the Bank for International Settlements published the consultation on concentration risk.',
    'Erosion along the bank of the river flooded the data centre that hosted the payment switch.',
    'The bank holiday weekend left payment queues building until processors reopened the settlement window.']) {
    const l = layers(withField('interpretation', t));
    assert.ok(!l.banned.some((s) => s.rule === 'FILTER V3'), t);
    assert.deepEqual(l.publish, [], t);
  }
  banned(withField('interpretation', 'Customers of the bank faced an identical exposure window until the vendor patch shipped to every site.'), /FILTER V3 interpretation\[0\]\.text: positioning word "the bank"/);
  banned(withField('interpretation', 'Peers that run the same appliance face an identical exposure window until the vendor patch ships.'), /positioning word "Peers"/);
  clean(withField('validation_question', 'Does the organisation report to the Bank of England within the incident window, with evidence from the last test?'), 'Bank of England in a question');
  for (const type of ['bank', 'insurer', 'lender', 'credit union', 'building society', 'asset manager', 'broker-dealer']) {
    publishError(withField('validation_question', `Does the ${type} require step-up verification before a help-desk MFA reset, with evidence from the last test?`), new RegExp(`presumes the reader's institution type "the ${type}"`));
  }
  publishError(withField('validation_question', 'Is gateway patch latency at the organisation slower than at peers, with evidence from the last quarter?'), /validation_question: positioning word "peers"/);
});

test('2b: the second-person check applies to the claim', () => {
  banned(withField('claim', 'Attackers can take over your mail gateway with one crafted request, the vendor says.'), /FILTER V2 claim: second person "your"/);
});

test('2c: V4 unique descriptors; V5 positions; V7, V9, V10 and §7.2/7.5/7.6/7.7 rule lists', () => {
  publishError(withField('claim', 'The largest US card network says attackers abused its token vault for 9 hours.'), /unique descriptor "The largest US card network"/);
  publishError(withField('claim', 'Attackers disrupted its only clearing bank for 6 hours, a fintech firm says.'), /unique descriptor "its only clearing bank"/);
  publishError(withField('claim', 'The custodian whose chief executive testified on 30 September disclosed a 5-hour outage.'), /unique descriptor "The custodian whose"/);
  for (const t of ['The largest exchange hack on record drained $1.5bn in tokens, investigators say.', 'The largest banks reported card authorisation delays for 5 hours, a processor says.',
    'Attackers used its only Exchange server to reach mailboxes for 12 days, the firm says.']) clean(withField('claim', t), t);
  // V5 evaluative words: judgments are banned; "failed to"/"inadequate" also describe a failed control (warning)
  banned(withField('claim', 'Lax help-desk checks at a regional lender let attackers reset staff MFA, police say.'), /FILTER V5 claim: evaluative word about an institution's controls "Lax"/);
  warned(withField('claim', 'A large US bank failed to patch gateway devices before attackers struck, sources say.'), /FILTER V5 claim: evaluative word about controls "failed to"/);
  // positions: errors in every non-claim field
  publishError(withField('awareness_rationale', 'Existing controls are adequate for this technique, so no control, metric or framework action follows from it.'), /position "Existing controls are adequate"/);
  publishError(withField('awareness_rationale', 'The organisation already enforces phishing-resistant authentication, so no control, metric or framework action follows.'), /position "The organisation already"/);
  publishError(withField('awareness_rationale', 'Institutions of all sizes apply the baseline controls that address the technique, so no framework action follows.'), /position "Institutions of all sizes"/);
  publishError(withField('awareness_rationale', 'Card issuers are not exposed because tokens are merchant-scoped, so no control, metric or framework action follows.'), /position "not exposed"/);
  publishError(withField('interpretation', 'Few banks rely on the affected appliance, so sector exposure is limited to a handful of regional lenders.'), /position "sector exposure is limited"/);
  publishError(withField('validation_question', 'Do most firms have phishing-resistant authentication for remote access, with evidence from the last test?'), /sector-level position "most firms have"/);
  banned(withField('interpretation', 'Most firms have phishing-resistant authentication in place, so the technique changes little across the sector.'), /sector-level position "Most firms have" without attribution/);
  warned(withField('interpretation', 'Most firms have phishing-resistant authentication in place, a regulator survey of 400 lenders found, so the technique changes little.'), /sector-level statement/);
  clean(withField('interpretation', 'Merchant-scoped tokens leave no exposure window for issuers once the processor rotates its signing keys across regions.'), 'no exposure window');
  // V7, V9, V10
  banned(withField('validation_question', 'Does the PRAF include a risk covering payments initiated by AI agents, and when was it last assessed?'), /FILTER V7/);
  banned(withField('claim', 'An unprecedented gateway flaw let attackers reach thousands of servers, the vendor says.'), /hype word "unprecedented"/);
  banned(withField('claim', 'Attackers exploited the gateway flaw at several lenders last year, the vendor says.'), /relative date "last year"/);
  banned(withField('claim', 'Scammers stole $25 million from a multinational using a deepfaked video call, police say.'), /currency "\$25 million"; write m and bn/);
  warned(withField('interpretation', 'The organization authorized payments that a fraud model flagged, so detection without blocking left the loss in place.'), /American spelling "organization"/);
  clean(withField('interpretation', 'The Department of Defense and the Center for Internet Security both list the flaw in the Known Exploited Vulnerabilities Catalog.'), 'proper names keep US spelling');
  // §7.2 headline constructions
  for (const [t, hit] of [['Appliance zero-day: attackers reached thousands of internet-facing gateways, the vendor says.', ':'], ['A new report highlights faster exploitation of internet-facing gateways by state actors.', 'highlights'],
    ['The gateway breach raises questions about appliance patching across the sector.', 'raises questions'], ['The gateway breach underscores the risk of unpatched appliances across the sector.', 'underscores']]) {
    banned(withField('claim', t), new RegExp(`headline or teaser construction "${hit}"`));
  }
  warned(withField('claim', 'Attackers could be compromising mail gateways across the financial sector.'), /unattributed hedge "could"/);
  assert.equal(extraSentences('U.S. agencies and Example Inc. said the flaw was exploited.'), 0);
  assert.equal(extraSentences('Attackers exploited the flaw. The vendor patched it.'), 1);
  // §7.5
  for (const [q, re] of [['Has this vulnerability been mitigated on every affected gateway appliance?', /"this" points at the item/],
    ['Why are gateway appliances still reachable from the internet?', /open or leading "Why"/],
    ['How is the organisation managing gateway appliance exposure?', /open or leading "How"/],
    ['What steps has the organisation taken on gateway appliance exposure?', /open or leading "What steps"/],
    ['Why hasn’t the mail gateway been isolated from the internet?', /open or leading/],
    ['Are gateways patched? Are their interfaces exposed to the internet?', /more than one question mark/]]) banned(withField('validation_question', q), re);
  banned(withField('validation_question', 'Has the organisation completed the gateway forensic review its lead supervisor requested?'), /only makes sense at one institution "its lead supervisor/);
  warned(withField('validation_question', 'Is the gateway inventory complete, and is it reconciled against the last external scan?'), /second yes\/no clause/);
  // §7.6
  for (const [s, re] of [['If not, attackers can write files to the appliance and read inbound mail.', /restates the answer/],
    ['Where unknown, attackers can write files to the appliance and read inbound mail.', /restates the answer/],
    ['Where push MFA is used for remote access without number matching, fatigue attacks.', /consequence clause under 5 words/],
    ['Where push MFA is used for remote access without number matching, there is heightened risk.', /vague consequence "heightened risk"/],
    ['If this vulnerability is unpatched, attackers can write files to the appliance and read inbound mail.', /"this" points at the item/]]) banned(withField('candidate_issue_statement', s), re);
  warned(withField('candidate_issue_statement', 'Where gateway interfaces face the internet, the organisation must patch and isolate them from staff networks.'), /no recommendation \("must"\)/);
  warned(withField('candidate_issue_statement', 'Where gateway interfaces face the internet, there is a high likelihood of compromise of the mail system.'), /rating "high likelihood"/);
  // §7.7
  for (const p of ['Continue monitoring', 'Keep an eye on', 'Remain vigilant', 'Track developments', 'Watch this space', 'Directionally important', 'For now']) {
    banned(withField('awareness_rationale', `${p}: no authority has consulted on agent payment standards, so no framework change follows.`), new RegExp(`banned fallback phrase "${p}"`, 'i'));
  }
});

test('2d: claims_may_name_institutions is read from thresholds.json (nested under writing)', () => {
  const dir = tempDir();
  try {
    const f = path.join(dir, 't.json');
    assert.equal(loadThresholds(path.join(dir, 'none.json')).bool('claims_may_name_institutions'), false, 'launch default');
    writeJson(f, { level: 'high', writing: { claims_may_name_institutions: { value: true, launch: false } } });
    assert.equal(loadThresholds(f).bool('claims_may_name_institutions'), true);
    writeJson(f, { level: 'high', writing: { claims_may_name_institutions: { value: 'yes' } } });
    assert.equal(loadThresholds(f).bool('claims_may_name_institutions'), false, 'non-boolean falls back to the launch value');
    const live = loadThresholds(path.join(ROOT, 'pipeline', 'thresholds.json'));
    if (live.found) assert.equal(typeof live.bool('claims_may_name_institutions'), 'boolean');
  } finally {
    rmrf(dir);
  }
});

const RUN = '2026-10-02-1400';
const STARTED = '2026-10-02T14:03:12-04:00';
const NOW = '2026-10-02T14:21:40-04:00';

function namedClaimWorkspace(knob) {
  const c = makeCandidate({ url: 'https://news.example.com/gateway', headline: 'Gateway zero-day exploited against several sectors' });
  const ws = workspace({
    runId: RUN,
    candidates: [c],
    survivors: [makeSurvivor(c)],
    decisions: { run_id: RUN, threshold_level: 'high', judgments: [judgment(c)], items: [makeDraft([c], { claim: 'HSBC says attackers exploited an unpatched gateway flaw across several sectors.' })] },
    startedAt: STARTED,
  });
  if (knob !== undefined) writeJson(path.join(ws.dir, 'thresholds.json'), { level: 'high', writing: { claims_may_name_institutions: { value: knob } } });
  return ws;
}

test('2d: publish.mjs and selfcheck.mjs treat a named institution in the claim per the knob', () => {
  for (const [knob, status] of [[undefined, 1], [false, 1], [true, 0]]) {
    const ws = namedClaimWorkspace(knob);
    try {
      const p = runScript('publish', ['--run', RUN, '--now', NOW, '--dry-run', ...ws.flags]);
      assert.equal(p.status, status, `publish knob ${knob}: ${p.stderr}`);
      if (status) assert.match(p.stderr, /claim: names a specific financial institution.*claims_may_name_institutions false/);
      else assert.match(p.stderr, /warn .*claim: names a specific financial institution.*claims_may_name_institutions true/);
      const s = runScript('selfcheck', ['--run', RUN, '--work-dir', ws.work, '--archive', ws.archive, '--thresholds', path.join(ws.dir, 'thresholds.json'), '--filter', ws.flags[ws.flags.indexOf('--filter') + 1]]);
      assert.equal(s.status, status, `selfcheck knob ${knob}: ${s.stderr}`);
    } finally {
      rmrf(ws.dir);
    }
  }
});

test('2d: validate.mjs --strict-lint reads the knob for archive items', () => {
  const dir = tempDir();
  try {
    const item = {
      id: 'RS-261002-1400-01', timestamp: '2026-10-02T14:00:00-04:00', section: 'capability_shift',
      claim: 'HSBC says attackers exploited an unpatched gateway flaw across several sectors.', domains: ['cyber'], source_class: 'news', mechanism: 'awareness_only',
      interpretation: [{ domain: 'cyber', text: 'Edge appliances remain a primary intrusion route, and patch latency sets the exposure window for every operator.' }],
      validation_question: null, candidate_issue_statement: null,
      awareness_rationale: 'The flaw sits within the patch-and-hunt expectation common frameworks set for edge appliances, so no new control, metric or framework entry follows.',
      sources: [{ publication: 'Example News', url: 'https://news.example.com/a', source_class: 'news' }], backfilled: true, update_of: null,
    };
    const archive = path.join(dir, 'archive.json');
    const runs = path.join(dir, 'runs.json');
    writeJson(archive, { schema_version: 1, items: [item] });
    writeJson(runs, { schema_version: 1, runs: [] });
    const args = ['--archive', archive, '--runs', runs, '--seen', path.join(dir, 'none.json'), '--strict-lint'];
    const off = runScript('validate', [...args, '--thresholds', path.join(dir, 'none.json')]);
    assert.equal(off.status, 1, off.stderr);
    assert.match(off.stderr, /claims_may_name_institutions false/);
    const t = path.join(dir, 'thresholds.json');
    writeJson(t, { level: 'high', writing: { claims_may_name_institutions: { value: true } } });
    const on = runScript('validate', [...args, '--thresholds', t]);
    assert.equal(on.status, 0, on.stderr);
  } finally {
    rmrf(dir);
  }
});

// ---------------------------------------------------------------- 2e: sources

const PUB = makeCandidate({ url: 'https://news.example.com/gateway', headline: 'Gateway zero-day exploited against several sectors' });
const PAY = makeCandidate({ url: 'https://paywall.example.com/content/1234?syn-25a6b1a6=1', publication: 'Example Paper', paywalled: true, headline: 'Gateway attacks spread' });
const WRAP = makeCandidate({ url: 'https://content.govdelivery.com/accounts/USTREAS/bulletins/3f1a2b', publication: 'U.S. Treasury – Press Releases (GovDelivery topic USTREAS_49)', source_class: 'regulator', headline: 'Treasury sanctions network' });
const ECB = makeCandidate({ url: 'https://www.ecb.europa.eu//press/key/date/2026/html/ecb.sp261001~cf3c630379.en.html', publication: 'European Central Bank – Press, speeches, interviews', source_class: 'regulator', headline: 'Speech on cyber resilience' });
const KEV = makeCandidate({ url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-90001', publication: 'CISA', source_class: 'vendor_threat_research', headline: 'CISA KEV adds CVE-2026-90001: Example Gateway — Example Gateway Path Traversal Vulnerability', headline_composed: true, kev: { cve: 'CVE-2026-90001' } });
const ALL = [PUB, PAY, WRAP, ECB, KEV];

function decide(cands, draftOver = {}, { lead = cands[0] } = {}) {
  const judgments = ALL.map((c) => (cands.includes(c)
    ? judgment(c, c === lead ? {} : { dedup: 'cluster_merged', match_id: lead.candidate_id, reason: `cluster member of ${lead.candidate_id}` })
    : judgment(c, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'C1 nothing specific changed', draft_index: null })));
  return { run_id: RUN, threshold_level: 'high', judgments, items: [makeDraft(cands, { source_class: cands[0].source_class, ...draftOver })] };
}
const ctx = { runId: RUN, candidates: ALL, survivorIds: ALL.map((c) => c.candidate_id), archiveItems: [], reasonCodes: null };
const errorsOf = (d) => validateDecisions(d, ctx).errors;

test('2e: wrapper and redirect hosts are publishing errors; the original page is not', () => {
  assert.ok(errorsOf(decide([WRAP])).some((e) => /sources\[0\]\.url: govdelivery\.com is an aggregator, cache, archive, mailing-list wrapper/.test(e)));
  assert.deepEqual(errorsOf(decide([PUB])), []);
});

test('2e: a paywalled source is never sources[0] while a public source is listed (NP5)', () => {
  assert.ok(errorsOf(decide([PAY, PUB])).some((e) => /sources\[0\]: paywalled .* while sources\[1\] is public/.test(e)));
  assert.deepEqual(errorsOf(decide([PUB, PAY])), []);
  assert.deepEqual(errorsOf(decide([PAY])), [], 'a paywalled source alone may be primary (its headline and lead carry the facts)');
});

test('5: a KEV candidate is cited without its composed headline; with it, publishing fails', () => {
  assert.equal(isComposedHeadline(KEV), true);
  assert.equal(isComposedHeadline({ kev: { cve: 'CVE-2026-1' }, headline: 'CISA KEV adds CVE-2026-1: X — Y' }), true, 'older candidates without the flag');
  assert.equal(isComposedHeadline(PUB), false);
  assert.ok(errorsOf(decide([KEV, PUB])).some((e) => /sources\[0\]\.headline: .* composed by the collector/.test(e)));
  const d = decide([KEV, PUB]);
  delete d.items[0].sources[0].headline;
  assert.deepEqual(errorsOf(d), []);
});

test('2e: feed labels and domains as publications warn; "//" and tracking parameters in a cited URL are banned; source order', () => {
  const st = (d) => styleIssues(d.items[0]).map((s) => `${s.banned ? 'B' : 'w'} ${s.rule} ${s.field}: ${s.message}`).join('\n');
  const labels = st(decide([WRAP, ECB]));
  assert.match(labels, /w FILTER 7\.8 sources\[0\]\.publication: .*looks like a registry feed label/);
  assert.match(labels, /w FILTER 7\.8 sources\[1\]\.publication: .*looks like a registry feed label/);
  assert.match(labels, /B FILTER 7\.8 sources\[1\]\.url: "\/\/" inside the path/);
  for (const p of ['FinCEN – News Releases (listing page)', 'EIOPA – News', 'Example RSS', 'bleepingcomputer.com']) {
    const d = decide([PUB]);
    d.items[0].sources[0].publication = p;
    assert.match(st(d), /w FILTER 7\.8 sources\[0\]\.publication/, p);
  }
  for (const p of ['European Central Bank', 'U.S. Department of the Treasury', 'NIST National Vulnerability Database', 'Risk.net', 'Pay.UK']) {
    const d = decide([PUB]);
    d.items[0].sources[0].publication = p;
    assert.doesNotMatch(st(d), /publication/, p);
  }
  assert.match(st(decide([PUB, PAY])), /B FILTER 7\.8 sources\[1\]\.url: tracking parameter "syn-25a6b1a6"/);
  const clean2 = decide([PUB, PAY]);
  clean2.items[0].sources[1].url = 'https://paywall.example.com/content/1234';
  assert.deepEqual(errorsOf(clean2), [], 'the clean URL matches the candidate after normalisation');
  assert.doesNotMatch(st(clean2), /tracking/);
  // §2.9: after the primary, non-news by authority, then news
  const ordered = decide([PUB, KEV, ECB]);
  for (const s of ordered.items[0].sources) delete s.headline;
  assert.match(st(ordered), /B FILTER 2\.9 sources\[2\]: regulator after vendor_threat_research/);
  const order2 = decide([KEV, PUB, ECB]);
  for (const s of order2.items[0].sources) delete s.headline;
  assert.match(st(order2), /B FILTER 2\.9 sources\[2\]: regulator after news/);
  const good = decide([KEV, ECB, PUB]);
  for (const s of good.items[0].sources) delete s.headline;
  good.items[0].sources[1].url = 'https://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp261001~cf3c630379.en.html';
  good.items[0].sources[1].publication = 'European Central Bank';
  assert.doesNotMatch(st(good), /FILTER 2\.9|FILTER 7\.8/);
  // an NVD URL is attributed to the NVD; a headline naming an institution with a characterisation is omitted
  const nvd = decide([PUB]);
  nvd.items[0].sources[0] = { ...nvd.items[0].sources[0], url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-90001', publication: 'CISA' };
  assert.match(st(nvd), /B FILTER 7\.8 sources\[0\]\.publication: "CISA" but the URL is an NVD record/);
  const head = decide([PUB]);
  head.items[0].sources[0].headline = 'Regulator fines Barclays for weak cyber controls';
  assert.match(st(head), /B FILTER 7\.8 sources\[0\]\.headline: names a financial institution together with a characterisation/);
  head.items[0].sources[0].headline = 'Gateway zero-day exploited against several sectors - Example News';
  assert.match(st(head), /w FILTER 7\.8 sources\[0\]\.headline: ends with the site name "Example News"/);
});

test('decision-level FILTER rules: AO3 repetition, reasons and notes (V2, V4, V9), NEAR grammar', () => {
  const published = { id: 'RS-261001-1000-01', awareness_rationale: 'The speech signals intent only: no consultation, definition or timetable has been issued, so no framework change or new metric follows until a proposal is published.' };
  const d = decide([PUB], {
    mechanism: 'awareness_only', validation_question: null, candidate_issue_statement: null,
    awareness_rationale: 'The remarks name no instrument. No consultation, definition or timetable has been issued, so no framework change or new metric follows until a proposal is published.',
  });
  d.judgments[1] = { ...d.judgments[1], reason: 'C1 a massive campaign hit HSBC; G6 your guess' };
  d.judgments[2] = { ...d.judgments[2], reason: 'G7 stale; NEAR C5: published last month' };
  d.judgments[3] = { ...d.judgments[3], reason_code: 'EV_NO_PROMINENCE', section_tested: 'executive_visibility', reason: '[M3] NEAR E3/ev_min_general_outlets: 1 general outlet [alt CS:C5]' };
  d.notes = 'source: eiopa-news re-dates old documents';
  const out = decisionStyleIssues(d, { candidates: ALL, archiveItems: [published] }).map((s) => `${s.banned ? 'B' : 'w'} ${s.rule} ${s.at} ${s.message}`).join('\n');
  assert.match(out, /B FILTER 7\.7 decisions\.items\[0\] awareness_rationale: repeats 12\+ consecutive words of a published rationale/);
  assert.match(out, /B FILTER V2 decisions\.judgments\[1\].* reason: second person "your"/);
  assert.match(out, /B FILTER V4 decisions\.judgments\[1\].* reason: names "HSBC"/);
  assert.match(out, /B FILTER V9 decisions\.judgments\[1\].* reason: hype word "massive"/);
  assert.match(out, /B FILTER 8\.4 decisions\.judgments\[2\].* write "NEAR <element>\[\/<knob>\]: <text>" at the start/);
  assert.doesNotMatch(out, /judgments\[3\]/, 'a well-formed [M#] NEAR reason with an alt marker');
  assert.doesNotMatch(out, /notes/);
  // publish reports them as warnings, never errors
  const r = validateDecisions(d, { ...ctx, archiveItems: [{ ...published, sources: [] }] });
  assert.ok(r.warnings.some((w) => /FILTER V4/.test(w)));
  assert.ok(!r.errors.some((e) => /FILTER V4|FILTER 8\.4|FILTER 7\.7/.test(e)), r.errors.join('\n'));
});
