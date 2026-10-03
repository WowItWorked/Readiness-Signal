// SPEC §6 lint and §3 schema: every rule with a passing and a failing case. FICTIONAL data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNgramSet, checkAppendOnly, findFirstPerson, findVerbatim, lintItemText, validateArchive, validateItem,
  validateRun, validateRuns, validateSeen, wordCount,
} from '../../pipeline/lib/validate.mjs';

function item(overrides = {}) {
  return {
    id: 'RS-261002-1400-01',
    timestamp: '2026-10-02T14:00:00-04:00',
    section: 'capability_shift',
    claim: 'Attackers exploited an unpatched gateway flaw across several sectors, the vendor says.',
    domains: ['cyber', 'third_party'],
    source_class: 'news',
    mechanism: 'candidate_issue',
    interpretation: [
      { domain: 'cyber', text: 'Edge appliances remain a primary intrusion route, and patch latency sets the exposure window.' },
      { domain: 'third_party', text: 'Managed providers that run these appliances for many clients share the same exposure window.' },
    ],
    validation_question: 'Can the owner show every internet-facing gateway was patched or isolated within the emergency window?',
    candidate_issue_statement: 'Where emergency patches are not tracked to completion, exploitation could go undetected and lead to network compromise.',
    awareness_rationale: null,
    sources: [{ publication: 'Example News', url: 'https://news.example.com/a', headline: 'Gateway flaw exploited', published: '2026-10-02', source_class: 'news' }],
    backfilled: false,
    update_of: null,
    ...overrides,
  };
}

const awareness = (o = {}) => item({
  mechanism: 'awareness_only',
  validation_question: null,
  candidate_issue_statement: null,
  awareness_rationale: 'The shift is directional; no control, metric or framework change follows until guidance is final.',
  ...o,
});

const errs = (r) => r.errors.join('\n');
const ok = (r) => assert.deepEqual(r.errors, [], errs(r));
const fails = (r, re) => assert.ok(r.errors.some((e) => re.test(e)), `expected an error matching ${re}; got:\n${errs(r)}`);

test('a valid item and a valid awareness-only item pass', () => {
  ok(validateItem(item()));
  ok(validateItem(awareness()));
});

test('first-person voice: we/our/ours/ourselves/my/me (any case), I/us/Us (case-sensitive); US allowed', () => {
  for (const [w, field] of [['We', 'claim'], ['our', 'validation_question'], ['ours', 'candidate_issue_statement'], ['ourselves', 'claim'], ['MY', 'claim'], ['me', 'claim'], ['I', 'claim'], ['us', 'claim'], ['Us', 'claim']]) {
    const base = item();
    const text = field === 'validation_question'
      ? `Can ${w} show every gateway was patched?`
      : field === 'candidate_issue_statement'
        ? `Where ${w} controls fail, exploitation could go undetected.`
        : `Analysts say ${w} gateway flaw spreads across several sectors this week`;
    fails(validateItem({ ...base, [field]: text }), /first-person voice/);
  }
  fails(validateItem(item({ interpretation: [{ domain: 'cyber', text: 'This affects us.' }, { domain: 'third_party', text: 'x' }] })), /interpretation\[0\]\.text: first-person/);
  fails(validateItem(awareness({ awareness_rationale: "We think it's directional." })), /awareness_rationale: first-person/);
  ok(validateItem(item({ claim: 'US and UK supervisors signal tougher operational resilience testing this year' })));
  assert.equal(findFirstPerson('The U.S. Treasury and US agencies'), null);
  assert.equal(findFirstPerson("we're"), 'we');
  assert.equal(findFirstPerson('Ask them, not me'), 'me');
});

test('no generated field names an institution; the claim follows claims_may_name_institutions (FILTER V4)', () => {
  fails(validateItem(item({ validation_question: 'Does the JPMorgan approach to gateways apply here?' })), /validation_question: names a specific financial institution.*JPMorgan/);
  fails(validateItem(item({ candidate_issue_statement: 'Where SWIFT messaging controls are bypassed, fraud could follow.' })), /candidate_issue_statement: names a specific/);
  fails(validateItem(awareness({ awareness_rationale: 'Barclays already disclosed it, so nothing follows.' })), /awareness_rationale: names a specific/);
  const named = item({ claim: 'HSBC says attackers exploited a gateway flaw affecting several customers.' });
  fails(validateItem(named), /claim: names a specific financial institution.*HSBC.*claims_may_name_institutions false/);
  const knobOn = validateItem(named, { claimsMayNameInstitutions: true });
  ok(knobOn);
  assert.ok(knobOn.warnings.some((w) => /claim: names a specific financial institution.*claims_may_name_institutions true/.test(w)), knobOn.warnings.join('\n'));
  // an interpretation never names one, whatever the knob
  const interp = [{ domain: 'cyber', text: 'HSBC customers saw the same exposure window as every other gateway operator in the sector.' }, item().interpretation[1]];
  fails(validateItem(item({ interpretation: interp }), { claimsMayNameInstitutions: true }), /interpretation\[0\]\.text: names a specific financial institution/);
  // a published item is linted as a warning only
  assert.deepEqual(validateItem(named, { lint: 'warn' }).errors, []);
  ok(validateItem(item({ validation_question: 'Can a swift response plan be shown for every gateway?' })));
});

test('claim: single line, 6-22 words (warn outside 8-16)', () => {
  fails(validateItem(item({ claim: 'Too short a claim' })), /claim: 4 words/);
  fails(validateItem(item({ claim: Array.from({ length: 23 }, (_, i) => `word${i}`).join(' ') })), /claim: 23 words/);
  fails(validateItem(item({ claim: 'Attackers exploit a gateway flaw\nacross several sectors this week' })), /claim: must be a single line/);
  const w = validateItem(item({ claim: 'Attackers exploit gateway flaw in six sectors' }));
  ok(w);
  assert.ok(w.warnings.some((x) => /claim: 7 words/.test(x)));
  assert.equal(validateItem(item()).warnings.length, 0);
  assert.equal(wordCount('U.S. zero-day hits 3.2m users’ accounts'), 6);
});

test('validation_question: ends with ?, <= 40 words, single line', () => {
  fails(validateItem(item({ validation_question: 'Show that every gateway was patched.' })), /must end with "\?"/);
  fails(validateItem(item({ validation_question: `${Array.from({ length: 41 }, () => 'word').join(' ')}?` })), /validation_question: 41 words/);
  fails(validateItem(item({ validation_question: 'Was every gateway\npatched?' })), /single line/);
});

test('candidate_issue_statement: starts Where/If, contains a comma, <= 70 words', () => {
  fails(validateItem(item({ candidate_issue_statement: 'Patches are not tracked, so exploitation could go undetected.' })), /must begin "Where " or "If "/);
  fails(validateItem(item({ candidate_issue_statement: 'If patches are not tracked exploitation could go undetected.' })), /must contain a comma/);
  fails(validateItem(item({ candidate_issue_statement: `If ${Array.from({ length: 70 }, () => 'word').join(' ')}, loss.` })), /candidate_issue_statement: 7\d words/);
  ok(validateItem(item({ candidate_issue_statement: 'If patches are not tracked, exploitation could go undetected.' })));
});

test('interpretation: <= 60 words, covers tagged domains, tagged first, unique', () => {
  fails(validateItem(item({ interpretation: [{ domain: 'cyber', text: Array.from({ length: 61 }, () => 'w').join(' ') }, { domain: 'third_party', text: 'x' }] })), /interpretation\[0\]\.text: 61 words/);
  fails(validateItem(item({ interpretation: [{ domain: 'cyber', text: 'x' }] })), /missing an entry for tagged domain "third_party"/);
  fails(validateItem(item({ interpretation: [{ domain: 'cyber', text: 'x' }, { domain: 'fraud', text: 'y' }, { domain: 'third_party', text: 'z' }] })), /tagged domains must come before/);
  fails(validateItem(item({ interpretation: [{ domain: 'cyber', text: 'x' }, { domain: 'cyber', text: 'y' }, { domain: 'third_party', text: 'z' }] })), /duplicate "cyber"/);
  ok(validateItem(item({ interpretation: [{ domain: 'third_party', text: 'x' }, { domain: 'cyber', text: 'y' }, { domain: 'resilience', text: 'z' }] })));
});

test('null/present rules by mechanism', () => {
  fails(validateItem(awareness({ validation_question: 'Is it patched?' })), /validation_question: must be null for awareness_only/);
  fails(validateItem(awareness({ candidate_issue_statement: 'If x, y.' })), /candidate_issue_statement: must be null/);
  fails(validateItem(awareness({ awareness_rationale: null })), /awareness_rationale: required for awareness_only/);
  fails(validateItem(item({ validation_question: null })), /validation_question: required for candidate_issue/);
  fails(validateItem(item({ mechanism: 'kri_kpi', candidate_issue_statement: null })), /candidate_issue_statement: required for kri_kpi/);
  fails(validateItem(item({ mechanism: 'praf_coverage', awareness_rationale: 'Not needed.' })), /awareness_rationale: must be null unless/);
});

test('sources: https, unique, non-empty publication, headline <= 200, YYYY-MM-DD, class enum', () => {
  const s = (o) => ({ publication: 'Example News', url: 'https://news.example.com/a', ...o });
  fails(validateItem(item({ sources: [s({ url: 'http://news.example.com/a' })] })), /sources\[0\]\.url: must be an https URL/);
  fails(validateItem(item({ sources: [s(), s({ url: 'https://NEWS.example.com/a/?utm_source=x' })] })), /duplicate source URL/);
  fails(validateItem(item({ sources: [s({ publication: ' ' })] })), /publication: required/);
  fails(validateItem(item({ sources: [s({ headline: 'x'.repeat(201) })] })), /201 chars/);
  fails(validateItem(item({ sources: [s({ published: '02/10/2026' })] })), /published: must be YYYY-MM-DD/);
  fails(validateItem(item({ sources: [s({ source_class: 'blog' })] })), /source_class: must be one of/);
  fails(validateItem(item({ sources: [s({ body: 'full text' })] })), /sources\[0\]\.body: unknown field/);
  fails(validateItem(item({ sources: [] })), /sources: required non-empty/);
  ok(validateItem(item({ sources: [s()] })));
});

test('schema: enums, id/timestamp rules, unknown fields', () => {
  fails(validateItem(item({ section: 'other' })), /section: must be one of/);
  fails(validateItem(item({ mechanism: 'issue' })), /mechanism: must be exactly one of/);
  fails(validateItem(item({ source_class: 'blog' })), /source_class/);
  fails(validateItem(item({ domains: [] })), /domains: array of 1-7/);
  fails(validateItem(item({ domains: ['cyber', 'cyber'] })), /domains: duplicates/);
  fails(validateItem(item({ domains: ['cyber', 'crypto'] })), /domains\[1\]/);
  fails(validateItem(item({ id: 'RS-261002-1400-1' })), /id: must match/);
  fails(validateItem(item({ id: 'RS-261002-1400-00' })), /NN starts at 01/);
  fails(validateItem(item({ id: 'RS-261002-1000-01' })), /expected RS-261002-1400-NN/);
  fails(validateItem(item({ timestamp: '2026-10-02T14:00:00-05:00' })), /timestamp: must be ISO 8601 with the correct ET offset/);
  fails(validateItem(item({ timestamp: '2026-10-02T14:30:00-04:00', id: 'RS-261002-1430-01' })), /edition slot time/);
  fails(validateItem(item({ backfilled: 'no' })), /backfilled: must be boolean/);
  fails(validateItem(item({ owner: 'Head of X' })), /owner: unknown field/);
  fails(validateItem(item({ update_of: 'earlier' })), /update_of: must be null or an item id/);
  // backfilled items may carry non-slot times (warning only on id mismatch)
  const bf = validateItem(item({ backfilled: true, timestamp: '2026-03-04T09:12:00-05:00', id: 'RS-260304-0900-01' }));
  ok(bf);
  assert.ok(bf.warnings.some((w) => /id: date\/time/.test(w)));
});

test('draft mode forbids publish-assigned fields and requires candidate_ids', () => {
  const { id, timestamp, backfilled, ...draft } = item();
  ok(validateItem({ ...draft, candidate_ids: ['c-0123456789'] }, { mode: 'draft' }));
  fails(validateItem({ ...draft }, { mode: 'draft' }), /candidate_ids: required/);
  fails(validateItem({ ...draft, id, candidate_ids: ['c-0123456789'] }, { mode: 'draft' }), /id: is assigned by publish\.mjs/);
  fails(validateItem({ ...draft, candidate_ids: ['c-123'] }, { mode: 'draft' }), /candidate_ids\[0\]/);
});

test('verbatim guard: 8 consecutive words from a headline or lead', () => {
  const set = buildNgramSet(['Threat actors are actively exploiting a pre-authentication flaw in Example Gateway devices, the vendor said.']);
  assert.equal(findVerbatim('Analysts note threat actors are actively exploiting a pre-authentication flaw in gateways', set), 'threat actors are actively exploiting a preauthentication flaw');
  assert.equal(findVerbatim('Threat actors are exploiting a pre-authentication gateway flaw', set), null);
  assert.equal(findVerbatim('short', set), null);
});

test('lintItemText reports nothing for clean text', () => {
  assert.deepEqual(lintItemText(item()).errors, []);
});

test('FILTER.md §7 style rules surface as warnings, never errors', () => {
  const warns = (o) => {
    const r = validateItem(item(o));
    assert.deepEqual(r.errors, [], r.errors.join('\n'));
    return r.warnings.join('\n');
  };
  assert.match(warns({ validation_question: 'Can your team show every gateway was patched?' }), /second person "your"/);
  assert.match(warns({ interpretation: [{ domain: 'cyber', text: 'Peers face the same route.' }, { domain: 'third_party', text: 'x' }] }), /positioning word "Peers"/);
  assert.match(warns({ claim: 'Attackers exploited a massive gateway flaw across several sectors, the vendor says.' }), /hype word "massive"/);
  assert.match(warns({ claim: 'Attackers exploited a gateway flaw across several sectors this week, the vendor says.' }), /relative date "this week"/);
  assert.match(warns({ claim: 'Attackers exploited an unpatched gateway flaw across several sectors, the vendor says' }), /full stop/);
  assert.match(warns({ candidate_issue_statement: 'If patches lag, exploitation could follow and controls should be reviewed.' }), /no recommendation/);
  assert.match(warns({ validation_question: 'Is X patched and tested and logged and reviewed?' }), /more than one "and"/);
  assert.match(warns({ interpretation: [{ domain: 'third_party', text: 'x' }, { domain: 'cyber', text: 'y' }] }), /follow the order of domains/);
  assert.match(warns({ sources: [{ publication: 'Example News', url: 'https://news.example.com/a' }] }), /sources\[0\]\.source_class: always set it/);
  assert.match(warns({ source_class: 'regulator' }), /differs from sources\[0\]\.source_class/);
  const aw = validateItem(awareness({ awareness_rationale: 'Directional only; monitor developments.' }));
  assert.match(aw.warnings.join('\n'), /banned fallback phrase "monitor developments"/);
  // a control name is not a fallback phrase
  assert.doesNotMatch(validateItem(awareness({ awareness_rationale: 'Transaction monitoring rules already expected by supervisors address the pattern, so no new control, metric or framework entry follows.' })).warnings.join('\n'), /fallback/);
});

const run = (o = {}) => ({
  run_id: '2026-10-02-1400',
  slot: '2026-10-02T14:00:00-04:00',
  started_at: '2026-10-02T14:03:12-04:00',
  finished_at: '2026-10-02T14:21:40-04:00',
  status: 'published',
  items: ['RS-261002-1400-01'],
  threshold_level: 'high',
  funnel: { sources_ok: 30, sources_failed: 1, fetched: 600, in_window: 300, unseen: 250, stage1_pass: 40, stage2_pass: 2, dedup_dropped: 1, published: 1 },
  stage2_by_section: { executive_visibility: { tested: 10, passed: 0 }, capability_shift: { tested: 25, passed: 2 }, regulatory_trajectory: { tested: 5, passed: 0 } },
  mechanism_distribution: { candidate_issue: 1, kri_kpi: 0, praf_coverage: 0, awareness_only: 0 },
  notes: 'Calibration week.',
  ...o,
});

test('run records', () => {
  ok(validateRun(run()));
  fails(validateRun(run({ run_id: '2026-10-02-1430' })), /run_id: must be/);
  fails(validateRun(run({ slot: '2026-10-02T10:00:00-04:00' })), /does not match run_id/);
  fails(validateRun(run({ status: 'silent' })), /silent runs list no items/);
  fails(validateRun(run({ status: 'published', items: [], funnel: { ...run().funnel, published: 0 }, mechanism_distribution: { candidate_issue: 0, kri_kpi: 0, praf_coverage: 0, awareness_only: 0 } })), /published runs list at least one item/);
  fails(validateRun(run({ items: ['RS-261002-1000-01'] })), /does not belong to slot/);
  fails(validateRun(run({ funnel: { ...run().funnel, published: 2 } })), /funnel.published: 2 but 1/);
  fails(validateRun(run({ mechanism_distribution: { candidate_issue: 0, kri_kpi: 0, praf_coverage: 0, awareness_only: 0 } })), /sums to 0/);
  fails(validateRun(run({ notes: 'x'.repeat(281) })), /notes: 281 chars/);
  fails(validateRun(run({ finished_at: '2026-10-02T14:00:00-04:00' })), /finished_at: before started_at/);
  fails(validateRun(run({ stage2_by_section: { ...run().stage2_by_section, capability_shift: { tested: 1, passed: 2 } } })), /passed > tested/);
  ok(validateRun(run({ status: 'silent', items: [], funnel: { ...run().funnel, published: 0 }, mechanism_distribution: { candidate_issue: 0, kri_kpi: 0, praf_coverage: 0, awareness_only: 0 } })));
});

test('archive + runs cross-checks', () => {
  const archive = { schema_version: 1, items: [item()] };
  const runs = { schema_version: 1, runs: [run()] };
  ok(validateArchive(archive));
  ok(validateRuns(runs, archive));
  fails(validateRuns({ schema_version: 1, runs: [] }, archive), /live item not listed by any run record/);
  fails(validateRuns({ schema_version: 1, runs: [run(), run()] }, archive), /duplicate/);
  fails(validateRuns(runs, { schema_version: 1, items: [] }), /not in the archive/);
  fails(validateRuns(runs, { schema_version: 1, items: [item({ mechanism: 'kri_kpi' })] }), /mechanism_distribution\.candidate_issue: 1 but the listed items have 0/);
  fails(validateArchive({ schema_version: 1, items: [item(), item()] }), /duplicate of items\[0\]/);
  fails(validateArchive({ schema_version: 1, items: [item({ update_of: 'RS-261001-1400-01' })] }), /update_of: RS-261001-1400-01 is not an earlier item/);
  fails(validateArchive({ schema_version: 2, items: [] }), /schema_version/);
  const earlier = item({ id: 'RS-261002-1000-01', timestamp: '2026-10-02T10:00:00-04:00' });
  ok(validateArchive({ schema_version: 1, items: [earlier, item({ update_of: 'RS-261002-1000-01' })] }));
  const later = run({ run_id: '2026-10-02-1000', slot: '2026-10-02T10:00:00-04:00', started_at: '2026-10-02T10:01:00-04:00', finished_at: '2026-10-02T10:05:00-04:00', status: 'silent', items: [], funnel: { ...run().funnel, published: 0 }, mechanism_distribution: { candidate_issue: 0, kri_kpi: 0, praf_coverage: 0, awareness_only: 0 } });
  fails(validateRuns({ schema_version: 1, runs: [run(), later] }, archive), /appended in slot order/);
});

test('seen.json', () => {
  ok(validateSeen({ schema_version: 1, urls: { 'https://news.example.com/a': { first_seen: '2026-10-02T14:03:12-04:00', run_id: '2026-10-02-1400', verdict: 'published', item_id: 'RS-261002-1400-01' } } }));
  fails(validateSeen({ schema_version: 1, urls: { 'https://news.example.com/a': { first_seen: 'x', run_id: 'y', verdict: 'maybe', item_id: 3 } } }), /verdict/);
});

test('append-only: removed, changed and moved entries fail; appends pass; missing reference is empty', () => {
  const a1 = item({ id: 'RS-261002-1000-01', timestamp: '2026-10-02T10:00:00-04:00' });
  const a2 = item();
  const before = { schema_version: 1, items: [a1] };
  assert.deepEqual(checkAppendOnly(before, { schema_version: 1, items: [a1, a2] }, 'archive').errors, []);
  assert.deepEqual(checkAppendOnly(null, { schema_version: 1, items: [a2] }, 'archive').errors, []);
  assert.match(checkAppendOnly(before, { schema_version: 1, items: [a2] }, 'archive').errors[0], /removed/);
  assert.match(checkAppendOnly(before, { schema_version: 1, items: [{ ...a1, claim: 'Edited claim text that is long enough to be valid' }] }, 'archive').errors[0], /changed at claim/);
  assert.match(checkAppendOnly({ schema_version: 1, items: [a1, a2] }, { schema_version: 1, items: [a2, a1] }, 'archive').errors[0], /moved/);
  assert.match(checkAppendOnly({ schema_version: 1, runs: [run()] }, { schema_version: 1, runs: [] }, 'runs').errors[0], /removed/);
});
