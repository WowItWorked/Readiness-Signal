import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTerm, outrightDrop, profileFor, runPrefilter, scoreCandidate } from '../../pipeline/lib/prefilter.mjs';
import { DOMAIN_TERMS, LEXICON_VERSION, PROFILES } from '../../pipeline/lib/lexicon.mjs';
import { DOMAINS } from '../../pipeline/lib/enums.mjs';
import { fixture, makeCandidate } from './_helpers.mjs';

const sample = JSON.parse(fixture('prefilter-sample.json')).candidates.map((s, i) =>
  ({ ...makeCandidate({ url: s.url ?? `https://news.example.com/sample/${i}`, headline: s.headline, lead: s.lead, source_class: s.source_class }), expect: s.expect }));

test('lexicon defines every domain with strong/medium/weak tiers and compiles', () => {
  assert.match(LEXICON_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  for (const d of DOMAINS) {
    assert.ok(DOMAIN_TERMS[d], d);
    for (const tier of ['strong', 'medium', 'weak']) for (const t of DOMAIN_TERMS[d][tier]) compileTerm(t);
  }
  for (const p of Object.values(PROFILES)) assert.ok(p.threshold > 0);
});

test('term syntax: hyphen/space variants, wildcard, case-sensitive, regex', () => {
  const zd = compileTerm('zero-day*').re;
  for (const s of ['zero-day', 'zero day', 'Zero-Days', 'zeroday']) assert.ok(zd.test(s), s);
  assert.ok(!zd.test('nonzero-dayx'));
  const ai = compileTerm('cs:AI').re;
  assert.ok(ai.test('AI agents'));
  assert.ok(!ai.test('Thai food'));
  assert.ok(!ai.test('ai'));
  assert.ok(compileTerm('re:\\bCVE-\\d{4}-\\d{4,}\\b').re.test('cve-2026-1234'));
});

test('realistic mixed sample: clear cases kept, marketing/roundups/off-domain dropped', () => {
  const r = runPrefilter(sample, { hasKevSource: true });
  const passed = new Set(r.survivors.map((s) => s.candidate_id));
  const dropped = new Map(r.dropped.map((d) => [d.candidate_id, d]));
  for (const c of sample) {
    const d = dropped.get(c.candidate_id);
    const why = d ? `${d.reason} ${d.score ?? ''} ${d.detail ?? ''}` : 'passed';
    if (c.expect === 'pass') assert.ok(passed.has(c.candidate_id), `expected pass: ${c.headline} (${why})`);
    if (c.expect === 'drop') assert.ok(!passed.has(c.candidate_id), `expected drop: ${c.headline}`);
    if (c.expect === 'marketing') assert.equal(d?.reason, 'marketing', `expected marketing drop: ${c.headline} (${why})`);
    if (c.expect === 'roundup') assert.equal(d?.reason, 'roundup', `expected roundup drop: ${c.headline} (${why})`);
    if (c.expect === 'redundant') assert.equal(d?.reason, 'redundant', `expected redundant drop: ${c.headline} (${why})`);
  }
  // survivors carry domains, score and matched terms
  const top = r.survivors[0];
  assert.ok(top.domains.length >= 1);
  assert.equal(typeof top.score, 'number');
  assert.ok(Object.keys(top.matched).length > 0);
  assert.equal(r.counts.passed + r.counts.seen + r.counts.roundup + r.counts.redundant + r.counts.marketing + r.counts.off_domain + r.counts.below_threshold, sample.length);
});

test('kills most volume on a realistic general security-news day', () => {
  // A typical day: a few material items among many routine ones (FICTIONAL headlines).
  const routine = [
    'Exampletech patches medium-severity bug in router admin panel',
    'Police dismantle phishing-as-a-service platform',
    'Researchers detail new Android banking trojan variant targeting Latin America',
    'Exampleco fixes cross-site scripting flaw in content management system',
    'Why zero trust projects stall, and how to restart them',
    'New macOS stealer spreads via fake meeting apps',
    'Browser maker adds passkey support to mobile app',
    'Hacktivists deface municipal websites in protest',
    'Security researcher wins bug bounty for VPN client flaw',
    'Spam campaign impersonates parcel delivery firms',
    'Open-source library maintainer steps away after burnout',
    'Exampleco confirms brief email outage, no data affected',
    'Example City school district hit by ransomware',
    'State hackers target think tanks with fake conference invites',
    'Report: phishing click rates fell slightly this year',
    'Exampletech releases emergency fix for game launcher bug',
  ].map((h, i) => makeCandidate({ url: `https://news.example.com/routine/${i}`, headline: h, lead: '' }));
  const material = sample.filter((c) => c.expect === 'pass' && c.source_class === 'news').slice(0, 4);
  const day = [...routine, ...material];
  const r = runPrefilter(day, { hasKevSource: true });
  const rate = r.counts.passed / day.length;
  assert.ok(rate <= 0.3, `pass rate ${Math.round(rate * 100)}% on a general security-news day`);
  for (const m of material) assert.ok(r.survivors.some((s) => s.candidate_id === m.candidate_id), m.headline);
});

test('seen candidates are dropped before scoring', () => {
  const c = makeCandidate({ headline: 'Attackers exploit zero-day in Fortinet FortiGate firewalls to breach networks', seen: true, seen_verdict: 'published' });
  const r = runPrefilter([c]);
  assert.equal(r.counts.seen, 1);
  assert.equal(r.dropped[0].reason, 'seen');
});

test('regulators need a domain match but face less volume suppression', () => {
  const reg = makeCandidate({ source_class: 'regulator', headline: 'Speech: artificial intelligence and the new frontiers of risk', lead: '' });
  const news = makeCandidate({ source_class: 'news', headline: 'Speech: artificial intelligence and the new frontiers of risk', lead: '' });
  const off = makeCandidate({ source_class: 'regulator', headline: 'Speech: the future of European competitiveness', lead: '' });
  const r = runPrefilter([reg, news, off]);
  assert.ok(r.survivors.some((s) => s.candidate_id === reg.candidate_id));
  assert.ok(!r.survivors.some((s) => s.candidate_id === news.candidate_id));
  assert.equal(r.dropped.find((d) => d.candidate_id === off.candidate_id).reason, 'off_domain');
  // regulators are never treated as marketing
  assert.equal(outrightDrop(makeCandidate({ source_class: 'regulator', headline: 'Supervisor launches new data collection platform' }), 'lenient'), null);
});

test('profiles: class defaults, high-volume hosts, sources.json override', () => {
  assert.equal(profileFor(makeCandidate({ source_class: 'regulator' })), 'lenient');
  assert.equal(profileFor(makeCandidate({ source_class: 'news' })), 'standard');
  assert.equal(profileFor(makeCandidate({ source_class: 'research_analysis' })), 'strict');
  assert.equal(profileFor(makeCandidate({ source_class: 'research_analysis', url: 'https://arxiv.org/abs/1' })), 'high_volume');
  assert.equal(profileFor(makeCandidate({ source_class: 'news' }), { prefilter: 'lenient' }), 'lenient');
});

test('high-volume research needs a strong term in the headline', () => {
  const weakTitle = makeCandidate({ source_class: 'research_analysis', url: 'https://arxiv.org/abs/2', headline: 'On robustness of classifiers', lead: 'zero-day ransomware deepfake fraud banks' });
  assert.equal(runPrefilter([weakTitle]).survivors.length, 0);
});

test('KEV entries pass only for ubiquitous enterprise tech, a sector link or known ransomware use', () => {
  const kev = (vendor, product, ransomware = 'Unknown') => makeCandidate({
    source_class: 'vendor_threat_research',
    publication: 'CISA',
    url: `https://nvd.nist.gov/vuln/detail/CVE-2026-${Math.floor(Math.random() * 90000 + 10000)}`,
    headline: `CISA KEV adds CVE-2026-12345: ${vendor} ${product} — ${vendor} ${product} Path Traversal Vulnerability`,
    lead: `${vendor} ${product} contains a path traversal vulnerability that may allow an unauthenticated attacker to write files.`,
    kev: { cve: 'CVE-2026-12345', vendor, product, known_ransomware_use: ransomware },
  });
  const r = runPrefilter([kev('Cisco', 'Catalyst SD-WAN Manager'), kev('Examplesoft', 'Widget Server'), kev('Examplesoft', 'Other Box', 'Known')]);
  assert.equal(r.survivors.length, 2);
  assert.ok(r.survivors.some((s) => s.headline.includes('Cisco')));
  assert.ok(r.survivors.some((s) => s.headline.includes('Other Box')));
  assert.match(r.dropped[0].detail, /KEV entry/);
});

test('scoreCandidate does not stack overlapping synonyms', () => {
  const s = scoreCandidate(makeCandidate({ headline: 'AI agents', lead: '' }), 'standard');
  assert.deepEqual(s.matched.ai, ['ai agent*']);
  assert.equal(s.domain_scores.ai, 3);
});
