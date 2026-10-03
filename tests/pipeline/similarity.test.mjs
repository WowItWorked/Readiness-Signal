import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHints, compareDocs, extractCves, extractNumbers, extractProperNouns, jaccard, prepareDoc, tokenize,
} from '../../pipeline/lib/similarity.mjs';

// FICTIONAL headlines.
const doc = (id, headline, lead = '', url = `https://example.com/${id}`) => prepareDoc({ id, texts: [headline], context: lead, urls: [url] });

test('tokenize stopwords, stems and drops generic security words and bare numbers', () => {
  const t = tokenize('Attackers are exploiting the new Gateway flaws in 2026, report says');
  assert.deepEqual([...t].sort(), ['gateway']);
  assert.ok(tokenize('Banks report rising mule accounts').has('mule'));
  assert.ok(tokenize('Banks report rising mule accounts').has('bank'));
});

test('jaccard basics', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['c'])), 0);
  assert.equal(jaccard(new Set(), new Set(['c'])), 0);
});

test('extractors: CVEs, distinctive numbers, proper nouns', () => {
  assert.deepEqual([...extractCves('fixes cve-2026-12345 and CVE-2026-777777')], ['CVE-2026-12345', 'CVE-2026-777777']);
  assert.deepEqual([...extractNumbers('Thieves took $387.5 million from 13,000 accounts in 2026; 41% of 7 firms')].sort(), ['13000', '387.5m', '41%']);
  const p = extractProperNouns('Examplebank says FrostLynx gang used MOVEit-style flaw in Ex2 gateways');
  assert.ok(p.has('frostlynx'));
  assert.ok(p.has('moveit-style'));
  assert.ok(p.has('ex2'));
  assert.ok(!p.has('microsoft'));
});

test('same story across outlets scores likely; unrelated stories do not match', () => {
  const a = doc('a', 'FrostLynx ransomware crew hits Examplebank payment processor', 'The gang stole 2.3 million records.');
  const b = doc('b', 'Examplebank payment processor confirms FrostLynx ransomware attack');
  const c = doc('c', 'Regulator consults on operational resilience testing for insurers');
  const ab = compareDocs(a, b);
  assert.equal(ab.level, 'likely');
  assert.ok(ab.evidence.shared_proper.includes('frostlynx'));
  assert.equal(compareDocs(a, c).level, null);
});

test('shared CVE is strong evidence; identical URL is exact', () => {
  const a = doc('a', 'Vendor warns of exploited gateway bug', 'Tracked as CVE-2026-55555.');
  const b = doc('b', 'Emergency directive orders agencies to patch appliances', 'CVE-2026-55555 is under attack.');
  const r = compareDocs(a, b);
  assert.equal(r.level, 'likely');
  assert.deepEqual(r.evidence.shared_cves, ['CVE-2026-55555']);
  const c = doc('c', 'Totally different words', '', 'https://example.com/a?utm_source=x');
  assert.equal(compareDocs(doc('a2', 'Some headline', '', 'https://example.com/a'), c).level, 'exact');
});

test('buildHints: clusters survivors and matches recent archive items', () => {
  const s = (id, headline, lead = '') => ({ candidate_id: id, headline, lead, url: `https://example.com/${id}` });
  const survivors = [
    s('c-0000000001', 'FrostLynx ransomware crew hits Examplebank payment processor'),
    s('c-0000000002', 'Examplebank payment processor confirms FrostLynx ransomware attack'),
    s('c-0000000003', 'Supervisor speech sets out expectations on AI model validation'),
    s('c-0000000004', 'New phishing kit bypasses passkeys at Exampleco', 'CVE-2026-11111'),
  ];
  const archive = [{
    id: 'RS-261001-1400-01',
    timestamp: '2026-10-01T14:00:00-04:00',
    claim: 'Phishing kit defeats passkey enrolment at Exampleco customers',
    sources: [{ publication: 'Example', url: 'https://example.com/old', headline: 'Exampleco passkey phishing kit spreads' }],
    interpretation: [{ domain: 'fraud', text: 'Tracked as CVE-2026-11111.' }],
  }];
  const { hints, clusters } = buildHints(survivors, archive);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].candidate_ids, ['c-0000000001', 'c-0000000002']);
  assert.equal(hints[0].cluster, clusters[0].cluster_id);
  assert.equal(hints[2].cluster, null);
  assert.equal(hints[2].archive_matches.length, 0);
  assert.equal(hints[3].archive_matches[0].item_id, 'RS-261001-1400-01');
  assert.equal(hints[3].archive_matches[0].level, 'likely');
});
