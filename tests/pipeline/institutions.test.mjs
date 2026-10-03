import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInstitutions, INSTITUTIONS } from '../../pipeline/lib/institutions.mjs';

const names = (s) => [...new Set(findInstitutions(s).map((m) => m.name))];

test('registry covers about 150 or more institutions across banks, networks, payments, insurers and FMIs', () => {
  assert.ok(INSTITUTIONS.length >= 140, `only ${INSTITUTIONS.length}`);
  for (const n of ['JPMorgan Chase', 'HSBC', 'Barclays', 'Lloyds Banking Group', 'Visa', 'Mastercard', 'SWIFT', 'DTCC', 'Allianz', 'PayPal']) {
    assert.ok(INSTITUTIONS.some((i) => i.name === n), n);
  }
});

test('matches names and short forms case-insensitively on word boundaries', () => {
  assert.deepEqual(names('Does jpmorgan have a plan?'), ['JPMorgan Chase']);
  assert.deepEqual(names('Where hsbc and BARCLAYS rely on it,'), ['HSBC', 'Barclays']);
  assert.deepEqual(names('If Lloyds Bank customers are targeted,'), ['Lloyds Banking Group']);
  assert.deepEqual(names('Visa and Mastercard tokens'), ['Visa', 'Mastercard']);
  assert.deepEqual(names('the SWIFT network'), ['SWIFT']);
  assert.deepEqual(names('Lloyd’s of London syndicates'), ["Lloyd's of London"]);
  assert.deepEqual(names('Crédit Agricole and Société Générale'), ['Crédit Agricole', 'Société Générale']);
  assert.deepEqual(names('M&T Bank'), ['M&T Bank']);
});

test('does not fire on ordinary words or substrings', () => {
  for (const s of [
    'A swift response limits the blast radius.',
    'Teams chase alerts without triage.',
    'Discover which suppliers hold the data.',
    'An ally in the business can sponsor the fix.',
    'Nationwide outages hit several sectors.',
    'Any US bank or UK building society could be exposed.',
    'Citizens and customers lose trust.',
    'The vanguard of attackers uses AI.',
    'Fidelity of the backup copies is unverified.',
    'Visibility into stripes of data',
    'Citation needed; citizenship records',
    'ingest pipelines and ingress rules',
  ]) {
    assert.deepEqual(names(s), [], s);
  }
});
