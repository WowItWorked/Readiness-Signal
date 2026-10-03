// Lint fixes from the adversarial review: first person (F08), institution names (F07), verbatim
// normalisation (F09), lint severity for published items (F03) and FILTER.md §7 style rules (F10).
// FICTIONAL data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInstitutions } from '../../pipeline/lib/institutions.mjs';
import {
  buildNgramSet, findFirstPerson, findVerbatim, styleIssues, styleWarnings, validateArchive, validateItem, verbatimWords,
} from '../../pipeline/lib/validate.mjs';

const names = (s) => [...new Set(findInstitutions(s).map((m) => m.name))];

function item(overrides = {}) {
  return {
    id: 'RS-261002-1400-01',
    timestamp: '2026-10-02T14:00:00-04:00',
    section: 'capability_shift',
    claim: 'Attackers exploited an unpatched gateway flaw across several sectors, the vendor says.',
    domains: ['cyber'],
    source_class: 'news',
    mechanism: 'candidate_issue',
    interpretation: [{ domain: 'cyber', text: 'Edge appliances remain a primary intrusion route, and patch latency sets the exposure window.' }],
    validation_question: 'Can the owner show every internet-facing gateway was patched within the emergency window?',
    candidate_issue_statement: 'Where emergency patches are not tracked to completion, exploitation could go undetected and lead to network compromise.',
    awareness_rationale: null,
    sources: [{ publication: 'Example News', url: 'https://news.example.com/a', source_class: 'news' }],
    backfilled: false,
    update_of: null,
    ...overrides,
  };
}

test('F08 first person: no false positives on region names, I/O, accented words; let\'s is caught', () => {
  for (const s of ['A us-east-1 outage stopped card authorisations.', 'Failover from us-west-2 took nine hours.', 'Disk I/O saturation slowed batch jobs.',
    'Re-enabling MFA for usérs took weeks.', 'La cinquième version (éme) ships.', 'US and U.S. agencies agree.', 'An I-95 corridor data centre flooded.']) {
    assert.equal(findFirstPerson(s), null, s);
  }
  assert.equal(findFirstPerson('Let’s assume the control holds.'), 'Let’s');
  assert.equal(findFirstPerson("let's assume"), "let's");
  assert.equal(findFirstPerson('This affects us.'), 'us');
  assert.equal(findFirstPerson('Let us assume'), 'us');
  assert.equal(findFirstPerson('A SOC 2 Type I report'), 'I', 'a standalone Roman numeral I still fails (FILTER V1: write Type 1)');
  assert.equal(findFirstPerson("We're exposed"), 'We');
  assert.equal(findFirstPerson('ourselves'), 'ourselves');
  assert.equal(validateItem(item({ claim: 'A us-east-1 cloud outage stopped card authorisations at several lenders for hours.' })).errors.length, 0);
});

test('F07 institutions: the Prudential Regulation Authority is a supervisor; short forms are caught', () => {
  for (const s of ['The Prudential Regulation Authority signalled direction only.', 'Prudential standards apply to all firms.', 'prudential rules',
    'the Deutsche Bundesbank said', 'A Swift response limits damage.', 'a swift response', 'a boa constrictor', 'cap one notch']) {
    assert.deepEqual(names(s), [], s);
  }
  assert.deepEqual(names('Prudential said it was investigating.'), ['Prudential']);
  assert.deepEqual(names('Prudential plc and Prudential Financial'), ['Prudential']);
  assert.deepEqual(names('JPM reported losses'), ['JPMorgan Chase']);
  assert.deepEqual(names('BoA customers'), ['Bank of America']);
  assert.deepEqual(names('Deutsche said'), ['Deutsche Bank']);
  assert.deepEqual(names('Deutsche Börse and Deutsche Bank'), ['Deutsche Börse', 'Deutsche Bank']);
  assert.deepEqual(names('AON'), ['Aon']);
  assert.deepEqual(names('the Swift network'), ['SWIFT']);
  assert.deepEqual(names("Swift's messaging platform"), ['SWIFT']);
  assert.deepEqual(names('Cap One'), ['Capital One']);
  // the PRA in an awareness rationale is not an institution-lint error
  const r = validateItem(item({
    mechanism: 'awareness_only', validation_question: null, candidate_issue_statement: null,
    awareness_rationale: 'The Prudential Regulation Authority signalled direction only; no expectation has been set, so no control, metric or framework change follows.',
  }));
  assert.deepEqual(r.errors, []);
});

test('F09 verbatim guard: U.S./US, diacritics, hyphenated compounds, & and thousands separators', () => {
  const set = buildNgramSet(['Hackers exploit gateway flaw to breach U.S. government networks across several agencies']);
  assert.equal(findVerbatim('Hackers exploit gateway flaw to breach US government networks across several agencies.', set), 'hackers exploit gateway flaw to breach us government');
  const set2 = buildNgramSet(['Société Générale-style cyber-attack hits 1,000 R&D accounts across the region today']);
  assert.ok(findVerbatim('Societe Generale style cyberattack hits 1000 R and D accounts across the region', set2));
  assert.deepEqual(verbatimWords('U.S. e.g. cyber-attack 1,000 R&D Café'), ['us', 'eg', 'cyberattack', '1000', 'r', 'and', 'd', 'cafe']);
  assert.equal(findVerbatim('Gateway flaw breach hits several agencies in the US government', set), null);
});

test('F03 lint severity: published items are linted as warnings or not at all; schema stays an error', () => {
  const bad = item({ validation_question: 'Has JPM patched every gateway?' });
  assert.match(validateItem(bad).errors.join('\n'), /names a specific financial institution/);
  const warn = validateItem(bad, { lint: 'warn' });
  assert.deepEqual(warn.errors, []);
  assert.ok(warn.warnings.some((w) => /names a specific financial institution.*published item, not re-checked as an error/.test(w)));
  assert.deepEqual(validateItem(bad, { lint: 'off' }), { errors: [], warnings: [] });
  // schema errors are never downgraded
  assert.match(validateItem({ ...bad, mechanism: 'issue' }, { lint: 'off' }).errors.join('\n'), /mechanism: must be exactly one of/);
  const archive = { schema_version: 1, items: [bad, item({ id: 'RS-261002-1400-02', claim: 'We say attackers exploited an unpatched gateway flaw in several sectors.' })] };
  const perItem = validateArchive(archive, { lint: (it) => (it.id === 'RS-261002-1400-01' ? 'warn' : 'error') });
  assert.equal(perItem.errors.length, 1);
  assert.match(perItem.errors[0], /RS-261002-1400-02.*first-person/);
});

test('style rules: refined positioning and hype; banned rules become errors only in strict mode', () => {
  const rules = (o) => styleIssues(item(o)).map((s) => s.rule);
  assert.deepEqual(rules({ interpretation: [{ domain: 'cyber', text: 'A peer-reviewed study and a peer review confirm the route; peer-to-peer links too.' }] }), []);
  assert.deepEqual(rules({ interpretation: [{ domain: 'cyber', text: 'Breaking encryption at scale remains costly for attackers, so stolen ciphertext stays protected for years.' }] }), []);
  assert.deepEqual(rules({ interpretation: [{ domain: 'cyber', text: 'Peers face the same route through unpatched gateways that sit outside endpoint monitoring tools.' }] }), ['FILTER V3']);
  assert.deepEqual(rules({ claim: 'Breaking news: attackers exploited an unpatched gateway flaw across sectors.' }), ['FILTER V9', 'FILTER 7.2']);
  assert.deepEqual(rules({ claim: 'Attackers exploited a "critical" gateway flaw across several sectors, the vendor says.' }), ['FILTER V8']);
  const o = { validation_question: 'Can your team show every gateway was patched?' };
  assert.equal(styleWarnings(item(o)).errors.length, 0);
  assert.match(styleWarnings(item(o), 'it', { strict: true }).errors[0], /second person "your" \(FILTER V2\)/);
  // heuristics stay warnings even in strict mode
  const h = styleWarnings(item({ candidate_issue_statement: 'If patches lag, exploitation follows and controls should be reviewed.' }), 'it', { strict: true });
  assert.equal(h.errors.length, 0);
  assert.match(h.warnings[0], /no recommendation/);
});
