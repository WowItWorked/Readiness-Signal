// pipeline/lib/backfill.mjs units: month windows, slots and §4 timestamps, the KEV month filter,
// the Federal Register response parser, add validation, soft 404s, same-site and URL freshness.
// No network. All fixture content is FICTIONAL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  CANARY_PREFIX, CANONICAL_HOSTS, PASSES, accessWall, accessWallReason, backfillReasonCodes, candidateSlot, canaryUrl, checkUrl, checkUrls,
  contentKind, expectedChecks, federalRegisterAgencies, federalRegisterApiUrl, federalRegisterCandidates, federalRegisterDocOf,
  federalRegisterQueryUrl, federalRegisterRecordProblem, firstSlotAtOrAfter,
  headings, itemTiming, kevCveOf, kevIndex, kevMonthCandidates, mainText, mergeCandidates, mergeUrlChecks, metaRefreshTarget,
  monthWindow, pageTitle, passSections, prepareAddEntries, publicationInstant, requirePass, retryAfterMs, sameSite, samePage,
  siteOf, slotForPublication, soft404Reason, urlCheckIssue, urlsToVerify, visibleTextStart,
} from '../../pipeline/lib/backfill.mjs';
import { USER_AGENT } from '../../pipeline/lib/collect.mjs';
import { KEV_URL } from '../../pipeline/lib/sources.mjs';
import { loadSources } from '../../pipeline/lib/sources.mjs';
import { normaliseUrl } from '../../pipeline/lib/url.mjs';
import { toEtIso } from '../../pipeline/lib/time.mjs';
import { FILTER_FIXTURE, ROOT, fixture } from './_helpers.mjs';
import fs from 'node:fs';

const W = monthWindow('2026-01');

test('monthWindow: January 2026 in ET (-05:00), first and last slots, pass id', () => {
  assert.equal(W.id, 'backfill-2026-01');
  assert.equal(W.since, '2026-01-01T00:00:00-05:00');
  assert.equal(W.until, '2026-01-31T23:59:59-05:00');
  assert.equal(W.firstDate, '2026-01-01');
  assert.equal(W.lastDate, '2026-01-31');
  assert.equal(W.firstSlot.iso, '2026-01-01T06:00:00-05:00');
  assert.equal(W.lastSlot.iso, '2026-01-31T18:00:00-05:00');
  assert.equal(W.end.toISOString(), '2026-02-01T05:00:00.000Z');
  // December rolls into the next year; March ends in daylight time
  assert.equal(monthWindow('2025-12').end.toISOString(), '2026-01-01T05:00:00.000Z');
  assert.equal(monthWindow('2026-03').lastSlot.iso, '2026-03-31T18:00:00-04:00');
  assert.equal(monthWindow('2026-02').lastDate, '2026-02-28');
  for (const bad of ['2026-1', '2026-13', '26-01', '', undefined]) assert.throws(() => monthWindow(bad), /YYYY-MM/);
});

test('passSections: the BACKFILL.md §1 table; --sections only narrows it; no pass, no month (MED-6)', () => {
  assert.deepEqual(passSections('2026-01'), ['capability_shift', 'regulatory_trajectory']);
  assert.deepEqual([...PASSES['2026-01'].sections], ['capability_shift', 'regulatory_trajectory']);
  assert.equal(requirePass('2026-01'), PASSES['2026-01']);
  assert.throws(() => requirePass('2025-12'), /no backfill pass is defined for 2025-12 \(BACKFILL\.md §1 lists 2026-01, 2026-02, .*, 2026-09, 2026-10-01, 2026-10-02, 2026-10-03, 2026-10-04\)/);
  assert.throws(() => passSections('2025-12'), /no backfill pass is defined/);
  assert.throws(() => passSections('2025-12', 'regulatory_trajectory'), /no backfill pass is defined/, 'a flag never creates a pass');
  assert.deepEqual(passSections('2026-01', 'regulatory_trajectory'), ['regulatory_trajectory']);
  assert.deepEqual(passSections('2026-01', 'capability_shift, capability_shift'), ['capability_shift']);
  assert.throws(() => passSections('2026-01', 'executive_visibility'), /executive_visibility is not in the 2026-01 pass .*only narrows a pass/);
  assert.throws(() => passSections('2026-01', 'capability_shift,board_view'), /not one of/);
  assert.throws(() => passSections('2026-01', ' , '), /give one or more/);
});

test('firstSlotAtOrAfter: at-or-after, exact slot instants, seconds past, evening rolls to next 06:00', () => {
  const s = (iso) => firstSlotAtOrAfter(new Date(iso)).iso;
  assert.equal(s('2026-01-05T00:00:00-05:00'), '2026-01-05T06:00:00-05:00');
  assert.equal(s('2026-01-05T06:00:00-05:00'), '2026-01-05T06:00:00-05:00');
  assert.equal(s('2026-01-05T09:30:00-05:00'), '2026-01-05T10:00:00-05:00');
  assert.equal(s('2026-01-05T14:00:00-05:00'), '2026-01-05T14:00:00-05:00');
  assert.equal(s('2026-01-05T14:00:01-05:00'), '2026-01-05T18:00:00-05:00');
  assert.equal(s('2026-01-05T18:00:00-05:00'), '2026-01-05T18:00:00-05:00');
  assert.equal(s('2026-01-05T18:00:01-05:00'), '2026-01-06T06:00:00-05:00');
  assert.equal(s('2026-01-05T23:59:00-05:00'), '2026-01-06T06:00:00-05:00');
  // a UTC timestamp is converted to ET first: 18:00Z = 13:00 ET
  assert.equal(s('2026-01-05T18:00:00Z'), '2026-01-05T14:00:00-05:00');
  assert.equal(s('2026-01-31T19:00:00-05:00'), '2026-02-01T06:00:00-05:00');
});

test('publicationInstant: date-only counts as 18:00 ET; a time is used as stated; inferred precision', () => {
  const d = publicationInstant({ published_date: '2026-01-05', published_precision: 'date', published: '2026-01-05T05:00:00.000Z' });
  assert.equal(toEtIso(d.instant), '2026-01-05T18:00:00-05:00');
  assert.equal(d.precision, 'date');
  const t = publicationInstant({ published: '2026-01-05T14:30:00.000Z', published_precision: 'time' });
  assert.equal(toEtIso(t.instant), '2026-01-05T09:30:00-05:00');
  // no precision recorded: ET midnight is a date, any other time is a time
  assert.equal(publicationInstant({ published: '2026-01-05T05:00:00.000Z', published_date: '2026-01-05' }).precision, 'date');
  assert.equal(publicationInstant({ published: '2026-01-05T15:00:00.000Z', published_date: '2026-01-05' }).precision, 'time');
  assert.equal(publicationInstant({ published: null, published_date: null }), null);
  // an unreadable stated time is no publication time, never a crash (LOW-13)
  assert.equal(publicationInstant({ published: 'garbage', published_precision: 'time' }), null);
  assert.equal(candidateSlot({ published: 'garbage', published_precision: 'time' }, W), null);
});

function cand(url, published, precision, extra = {}) {
  const t = precision === 'date' ? new Date(`${published}T05:00:00.000Z`) : new Date(published);
  return { candidate_id: 'c-0000000000', url, published: t.toISOString(), published_date: precision === 'date' ? published : null, published_precision: precision, ...extra };
}
const timing = (sources) => {
  const byNorm = new Map(sources.map((c) => [normaliseUrl(c.url), c]));
  return itemTiming({ sources: sources.map((c) => ({ publication: 'X', url: c.url })) }, byNorm, W);
};

test('itemTiming (§4): earliest in-window source, date-only 18:00, exact times, last-day evening, offsets', () => {
  assert.equal(timing([cand('https://a.example.com/1', '2026-01-05', 'date')]).slot.iso, '2026-01-05T18:00:00-05:00');
  assert.equal(timing([cand('https://a.example.com/1', '2026-01-05T09:30:00-05:00', 'time')]).slot.iso, '2026-01-05T10:00:00-05:00');
  assert.equal(timing([cand('https://a.example.com/1', '2026-01-05T14:00:00-05:00', 'time')]).slot.iso, '2026-01-05T14:00:00-05:00');
  assert.equal(timing([cand('https://a.example.com/1', '2026-01-05T18:00:00-05:00', 'time')]).slot.iso, '2026-01-05T18:00:00-05:00');
  assert.equal(timing([cand('https://a.example.com/1', '2026-01-01T00:00:00-05:00', 'time')]).slot.iso, '2026-01-01T06:00:00-05:00');
  // the earliest source wins, comparing a date-only source at 18:00
  const mixed = timing([cand('https://a.example.com/1', '2026-01-05', 'date'), cand('https://b.example.com/2', '2026-01-05T09:00:00-05:00', 'time')]);
  assert.equal(mixed.slot.iso, '2026-01-05T10:00:00-05:00');
  assert.equal(timing([cand('https://a.example.com/1', '2026-01-06T08:00:00-05:00', 'time'), cand('https://b.example.com/2', '2026-01-05', 'date')]).slot.iso, '2026-01-05T18:00:00-05:00');
  // last day: a date-only source takes the last slot; so does a time after 18:00 that is still
  // inside the window (BACKFILL.md §4: "takes that slot only if it is still inside the window")
  const lastDay = timing([cand('https://a.example.com/1', '2026-01-31', 'date')]);
  assert.equal(lastDay.slot.iso, '2026-01-31T18:00:00-05:00');
  assert.deepEqual(lastDay.issues, []);
  const evening = timing([cand('https://a.example.com/1', '2026-01-31T19:00:00-05:00', 'time')]);
  assert.equal(evening.slot.iso, '2026-01-31T18:00:00-05:00');
  assert.deepEqual(evening.issues, []);
  assert.match(evening.basis.note, /published after the window's last slot 2026-01-31T18:00:00-05:00 but inside the window: takes that last slot/);
  assert.equal(timing([cand('https://a.example.com/1', '2026-01-31T23:59:59-05:00', 'time')]).slot.iso, '2026-01-31T18:00:00-05:00');
  // an offset other than ET: 2026-01-31T23:30Z = 18:30 ET, inside the window
  assert.equal(timing([cand('https://a.example.com/1', '2026-01-31T23:30:00Z', 'time')]).slot.iso, '2026-01-31T18:00:00-05:00');
  // midnight ET on 1 February is February's: outside, BF_OUT_OF_WINDOW
  assert.match(timing([cand('https://a.example.com/1', '2026-02-01T00:00:00-05:00', 'time')]).issues.join(' '), /no source is published inside the 2026-01 window.*BF_OUT_OF_WINDOW/);
  // slotForPublication: the clamp applies only inside the window
  assert.deepEqual(Object.values(slotForPublication(new Date('2026-01-31T22:00:00-05:00'), W)).map((x) => x.iso ?? x), ['2026-01-31T18:00:00-05:00', true]);
  assert.deepEqual(Object.values(slotForPublication(new Date('2026-01-30T22:00:00-05:00'), W)).map((x) => x.iso ?? x), ['2026-01-31T06:00:00-05:00', false]);
  assert.deepEqual(Object.values(slotForPublication(new Date('2026-02-01T01:00:00-05:00'), W)).map((x) => x.iso ?? x), ['2026-02-01T06:00:00-05:00', false]);
  // a later corroborating source never sets the timestamp
  const corroborated = timing([cand('https://a.example.com/1', '2026-01-20', 'date'), cand('https://b.example.com/2', '2026-02-03', 'date', { outside_window: true })]);
  assert.equal(corroborated.slot.iso, '2026-01-20T18:00:00-05:00');
  assert.deepEqual(corroborated.issues, []);
  // the primary must be inside the window
  const later = timing([cand('https://b.example.com/2', '2026-02-03', 'date', { outside_window: true }), cand('https://a.example.com/1', '2026-01-20', 'date')]);
  assert.match(later.issues.join(' '), /sources\[0\].*outside the 2026-01 window/);
  assert.match(timing([cand('https://a.example.com/1', '2025-12-31', 'date')]).issues.join(' '), /no source is published inside the 2026-01 window/);
});

test('kevMonthCandidates: only dateAdded inside the month (ET dates), live KEV shape, date-only', () => {
  const json = JSON.parse(fixture('backfill-kev.json'));
  const source = { id: 'cisa-kev', publication: 'CISA', source_class: 'vendor_threat_research', paywalled: false, region: 'US' };
  const { total, candidates } = kevMonthCandidates(json, W, source);
  assert.equal(total, 7);
  assert.deepEqual(candidates.map((c) => c.kev.cve), ['CVE-2026-91001', 'CVE-2026-91002', 'CVE-2026-91003']);
  const c = candidates[0];
  assert.equal(c.url, 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-91001');
  assert.equal(c.publication, 'CISA');
  assert.equal(c.source_class, 'vendor_threat_research');
  assert.equal(c.headline_composed, true);
  assert.match(c.headline, /^CISA KEV adds CVE-2026-91001: /);
  assert.equal(c.published_date, '2026-01-01');
  assert.equal(c.published_precision, 'date');
  assert.equal(c.discovery_mode, 'archive');
  assert.equal(c.outside_window, false);
  assert.equal(candidates[2].published_date, '2026-01-31');
  assert.equal(toEtIso(publicationInstant(candidates[2]).instant), '2026-01-31T18:00:00-05:00');
});

test('federalRegisterAgencies and query URL: every fedreg-* registry feed, RULE, month bounds, fields', () => {
  const { sources } = loadSources(path.join(ROOT, 'pipeline', 'sources.json'));
  const agencies = federalRegisterAgencies(sources);
  assert.ok(agencies.length >= 7, `expected the registry's Federal Register feeds, got ${agencies.length}`);
  assert.ok(agencies.every((a) => /^fedreg-/.test(a.source.id)));
  assert.ok(agencies.some((a) => a.slug === 'federal-reserve-system'));
  const u = new URL(federalRegisterQueryUrl('federal-reserve-system', W));
  assert.equal(u.origin + u.pathname, 'https://www.federalregister.gov/api/v1/documents.json');
  assert.deepEqual(u.searchParams.getAll('conditions[agencies][]'), ['federal-reserve-system']);
  assert.deepEqual(u.searchParams.getAll('conditions[type][]'), ['RULE']);
  assert.equal(u.searchParams.get('conditions[publication_date][gte]'), '2026-01-01');
  assert.equal(u.searchParams.get('conditions[publication_date][lte]'), '2026-01-31');
  assert.deepEqual(u.searchParams.getAll('fields[]'), ['title', 'abstract', 'html_url', 'publication_date', 'agencies', 'document_number', 'type']);
  assert.equal(u.searchParams.get('per_page'), '100');
});

test('federalRegisterCandidates: issuing agency, lead from the abstract, skips, pagination, empty page', () => {
  const occ = { id: 'fedreg-occ-final-rules', publication: 'Office of the Comptroller of the Currency', source_class: 'regulator', region: 'US', paywalled: false };
  const fed = { id: 'fedreg-fed-final-rules', publication: 'Federal Reserve', source_class: 'regulator', region: 'US', paywalled: false, lead_words: 12 };
  const agencies = [{ slug: 'comptroller-of-the-currency', source: occ }, { slug: 'federal-reserve-system', source: fed }];
  const p1 = federalRegisterCandidates(JSON.parse(fixture('backfill-fr-page1.json')), { source: fed, agencies, window: W });
  assert.equal(p1.count, 5);
  assert.equal(p1.next_page_url, '__BASE__/api/v1/documents.json?page=2');
  assert.deepEqual(p1.skipped, { invalid: 0, not_rule: 1, out_of_window: 0 });
  assert.equal(p1.candidates.length, 2);
  const [joint, amend] = p1.candidates;
  // the first listed agency with a registry feed issues it (Treasury has none; the OCC does)
  assert.equal(joint.publication, 'Office of the Comptroller of the Currency');
  assert.equal(joint.source_id, 'fedreg-occ-final-rules');
  assert.equal(joint.source_class, 'regulator');
  assert.equal(joint.headline, 'Fictional Joint Rule on Operational Resilience Testing');
  assert.equal(joint.lead.split(' ').length, 61); // 60 words + the ellipsis marker
  assert.ok(joint.lead.endsWith(' …'));
  assert.equal(joint.published_date, '2026-01-05');
  assert.equal(joint.published_precision, 'date');
  assert.equal(joint.discovery_mode, 'archive');
  assert.deepEqual(joint.fr, { document_number: '2026-90001', type: 'Rule', agencies: ['Treasury Department', 'Comptroller of the Currency', 'Federal Reserve System'] });
  assert.equal(amend.publication, 'Federal Reserve');
  // the issuing source's registry lead_words (12 here) cut the abstract
  assert.equal(amend.lead, 'The Board is amending a fictional regulation to shorten an incident notification …');
  const p2 = federalRegisterCandidates(JSON.parse(fixture('backfill-fr-page2.json')), { source: fed, agencies, window: W });
  assert.deepEqual(p2.skipped, { invalid: 1, not_rule: 0, out_of_window: 1 });
  assert.equal(p2.next_page_url, null);
  assert.equal(p2.candidates.length, 1);
  assert.equal(p2.candidates[0].lead, '');
  assert.equal(p2.candidates[0].publication, 'Federal Reserve');
  const empty = federalRegisterCandidates(JSON.parse(fixture('backfill-fr-empty.json')), { source: fed, agencies, window: W });
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.count, 0);
  assert.throws(() => federalRegisterCandidates([], { source: fed, agencies, window: W }), /not a JSON object/);
  assert.throws(() => federalRegisterCandidates({ results: {} }, { source: fed, agencies, window: W }), /not an array/);
  // a document page is on federalregister.gov; any other html_url is skipped (LOW-15)
  const offHost = federalRegisterCandidates({ results: [
    { title: 'Fictional Rule', type: 'Rule', html_url: 'https://federalregister.example.com/documents/2026/01/05/2026-90009/x', publication_date: '2026-01-05' },
    { title: 'Fictional Rule', type: 'Rule', html_url: 'https://www.federalregister.gov.example.com/documents/2026/01/05/2026-90010/x', publication_date: '2026-01-05' },
    { title: 'Fictional Rule', type: 'Rule', html_url: 'https://www.federalregister.gov/documents/2026/01/05/2026-90011/x', publication_date: '2026-01-05' },
  ] }, { source: fed, agencies, window: W });
  assert.deepEqual([offHost.skipped.invalid, offHost.candidates.length], [2, 1]);
});

test('mergeCandidates: dedup by normalised URL, also_in, existing entries kept as they were', () => {
  const a = { candidate_id: 'c-aaaaaaaaaa', url: 'https://x.example.com/a', source_id: 'fedreg-occ-final-rules', publication: 'OCC', also_in: [] };
  const a2 = { ...a, source_id: 'fedreg-fed-final-rules', publication: 'Federal Reserve', headline: 'changed' };
  const b = { candidate_id: 'c-bbbbbbbbbb', url: 'https://x.example.com/b', source_id: null, publication: 'Example' };
  const r = mergeCandidates([a], [a2, b, a2]);
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.candidates[0].also_in, ['fedreg-fed-final-rules']);
  assert.equal(r.candidates[0].headline, undefined);
  assert.equal(r.added.length, 1);
  assert.equal(r.already.length, 2);
  assert.deepEqual(a.also_in, [], 'input not mutated');
});

const entry = (o = {}) => ({
  url: 'https://research.example.com/2026/01/edge-campaign',
  publication: 'Example Research',
  source_class: 'vendor_threat_research',
  headline: 'Edge appliance campaign uses stolen session tokens',
  lead: 'Researchers describe a campaign that replays stolen session tokens against edge appliances.',
  published: '2026-01-14',
  paywalled: false,
  discovery_mode: 'search',
  ...o,
});

test('prepareAddEntries: validated fields, ids, precision, registry lead words, seen marking', () => {
  const sources = [{ id: 'example-research', publication: 'Example Research', source_class: 'vendor_threat_research', type: 'feed', url: 'https://research.example.com/feed', paywalled: false, region: 'INTL', notes: '', lead_words: 5 }];
  const seenDoc = { schema_version: 1, urls: { 'https://research.example.com/2026/01/edge-campaign': { verdict: 'dropped' } } };
  const r = prepareAddEntries([entry(), entry({ url: 'https://other.example.org/x', published: '2026-01-14T09:30:00-05:00', lead: 'one two three' })], { sources, window: W, seenDoc });
  assert.deepEqual(r.errors, []);
  const [a, b] = r.candidates;
  assert.match(a.candidate_id, /^c-[0-9a-f]{10}$/);
  assert.equal(a.source_id, 'example-research');
  assert.equal(a.region, 'INTL');
  assert.equal(a.lead, 'Researchers describe a campaign that …');
  assert.match(r.notices.join(' '), /lead cut to 5 words/);
  assert.equal(a.published_precision, 'date');
  assert.equal(a.published_date, '2026-01-14');
  assert.equal(a.seen, true);
  assert.equal(a.seen_verdict, 'dropped');
  assert.equal(a.outside_window, false);
  assert.equal(b.published_precision, 'time');
  assert.equal(b.published, '2026-01-14T14:30:00.000Z');
  assert.equal(b.source_id, null);
  assert.equal(b.lead, 'one two three');
});

test('prepareAddEntries: paywalled leads capped at 30 words, forced for paywalled publications', () => {
  const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
  const r = prepareAddEntries([
    entry({ url: 'https://www.ft.com/content/fictional-0001', publication: 'Financial Times', source_class: 'news', paywalled: false, lead: long }),
    entry({ url: 'https://news.example.com/paywalled', publication: 'Example News', source_class: 'news', paywalled: true, lead: long }),
    entry({ url: 'https://news.example.com/open', publication: 'Example News', source_class: 'news', paywalled: false, lead: long }),
  ], { sources: [], window: W });
  assert.deepEqual(r.errors, []);
  const [ft, pw, open] = r.candidates;
  assert.equal(ft.paywalled, true, 'a known paywalled publication is forced paywalled');
  assert.match(r.notices.join(' '), /ft\.com is a paywalled publication/);
  assert.equal(ft.lead.replace(/ …$/, '').split(' ').length, 30);
  assert.equal(pw.lead.replace(/ …$/, '').split(' ').length, 30);
  assert.equal(open.lead.replace(/ …$/, '').split(' ').length, 50);
});

test('prepareAddEntries: refuses wrappers, aggregators, http, bad fields and out-of-window dates', () => {
  const bad = [
    entry({ url: 'https://news.google.com/articles/abc' }),
    entry({ url: 'https://t.co/abc123' }),
    entry({ url: 'https://www.example.com/out?url=https://real.example.org/story' }),
    entry({ url: 'https://web.archive.org/web/2026/https://real.example.org/story' }),
    entry({ url: 'http://research.example.com/plain-http' }),
    entry({ source_class: 'blog' }),
    entry({ headline: '   ' }),
    entry({ published: '14 January 2026' }),
    entry({ published: '2026-01-14T09:30:00' }),
    entry({ paywalled: 'no' }),
    entry({ discovery_mode: 'memory' }),
    entry({ publised: '2026-01-14' }),
    entry({ published: '2025-12-31' }),
    entry({ published: '2026-02-01' }),
    entry({ published: '2026-02-01T04:59:00Z' }), // 23:59 ET on 31 January: inside
  ];
  const r = prepareAddEntries(bad, { sources: [], window: W });
  const msg = (i) => r.errors.filter((e) => e.startsWith(`entries[${i}]`)).join(' | ');
  assert.match(msg(0), /news\.google\.com is an aggregator/);
  assert.match(msg(1), /t\.co is an aggregator, cache, archive, mailing-list wrapper, shortener or social platform/);
  assert.match(msg(2), /redirect wrapper \(url=\)/);
  assert.match(msg(3), /web\.archive\.org/);
  assert.match(msg(4), /must be https/);
  assert.match(msg(5), /source_class/);
  assert.match(msg(6), /headline: required/);
  assert.match(msg(7), /neither "YYYY-MM-DD" nor ISO 8601 with an offset/);
  assert.match(msg(8), /neither "YYYY-MM-DD" nor ISO 8601 with an offset/);
  assert.match(msg(9), /paywalled: required true or false/);
  assert.match(msg(10), /discovery_mode/);
  assert.match(msg(11), /publised: unknown field/);
  assert.match(msg(12), /outside the 2026-01 window.*first made public before the window is dropped BF_OUT_OF_WINDOW/);
  assert.match(msg(13), /outside the 2026-01 window.*--allow-outside/);
  assert.equal(msg(14), '');
  assert.equal(r.candidates.length, 1);
  // --allow-outside admits later sources only, flagged
  const later = prepareAddEntries([entry({ published: '2026-02-10' }), entry({ url: 'https://x.example.com/old', published: '2025-12-30' })], { sources: [], window: W, allowOutside: true });
  assert.equal(later.candidates.length, 1);
  assert.equal(later.candidates[0].outside_window, true);
  assert.match(later.errors.join(' '), /before the window is dropped BF_OUT_OF_WINDOW/);
  assert.deepEqual(prepareAddEntries({}, { sources: [], window: W }).errors, ['expected a JSON array of entries, or { "candidates": [...] }']);
});

test('prepareAddEntries: an exact midnight stamp is the date written, date only (LOW-11)', () => {
  const r = prepareAddEntries([
    entry({ url: 'https://a.example.com/1', published: '2026-01-01T00:00:00Z' }),
    entry({ url: 'https://a.example.com/2', published: '2026-01-15T00:00:00Z' }),
    entry({ url: 'https://a.example.com/3', published: '2026-01-15T00:00:00.000-05:00' }),
    entry({ url: 'https://a.example.com/4', published: '2026-01-15T00:00+01:00' }),
    entry({ url: 'https://a.example.com/5', published: '2026-01-15T00:00:01Z' }),
  ], { sources: [], window: W });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.candidates.map((c) => [c.published_date, c.published_precision]), [
    ['2026-01-01', 'date'], ['2026-01-15', 'date'], ['2026-01-15', 'date'], ['2026-01-15', 'date'], ['2026-01-14', 'time'],
  ]);
  assert.equal(r.notices.filter((n) => /midnight stamp; recorded as the date/.test(n)).length, 4);
  // date only counts as 18:00 ET, never the 06:00 slot of a midnight instant
  assert.equal(candidateSlot(r.candidates[1], W).slot.iso, '2026-01-15T18:00:00-05:00');
  // February 1 at UTC midnight is February's, not 19:00 ET on 31 January
  const feb = prepareAddEntries([entry({ published: '2026-02-01T00:00:00Z' })], { sources: [], window: W });
  assert.match(feb.errors.join(' '), /outside the 2026-01 window.*--allow-outside/);
});

test('soft404Reason: error pages by title, heading, main or opening text; ordinary documents never', () => {
  const page = (title, body) => `<!doctype html><html><head><title>${title}</title><script>var x = "page not found";</script></head><body>${body}</body></html>`;
  assert.match(soft404Reason(page('Page Not Found | Example Agency', '<p>Welcome</p>')), /title/);
  assert.match(soft404Reason(page('404 | Federal Register', '<p>x</p>')), /404/);
  assert.match(soft404Reason(page('Document not found', '<p>x</p>')), /not found/);
  assert.match(soft404Reason(page('Example Agency', '<nav>Home About</nav><h1>Sorry, we can\'t find that page.</h1>')), /^heading "Sorry, we can't find that page\." says/);
  assert.match(soft404Reason(page('Example Agency', '<h1>The page you requested could not be found.</h1>')), /^heading/);
  assert.match(soft404Reason(page('Example Agency', '<p>This content is no longer available.</p>')), /opening text/);
  assert.match(soft404Reason(page('Example Agency', '<p>Error 404</p>')), /opening text/);
  assert.match(soft404Reason(page('Example Agency', '<p>This page has been removed.</p>')), /opening text/);
  // ordinary documents
  assert.equal(soft404Reason(page('Final Rule: Amendments to Rule 404 Disclosure Requirements', '<p>FR Doc. 2026-00404 Filed 1-5-26</p>')), null);
  assert.equal(soft404Reason(page('Attackers exploit flaw for which a patch does not exist', '<p>A fix does not exist yet. The malicious file was removed by the attacker.</p>')), null);
  assert.equal(soft404Reason(page('Known Exploited Vulnerabilities Catalog | CISA', '<p>Search CVE-2026-0404</p>')), null);
  // a script mentioning "page not found" is not visible text
  assert.equal(visibleTextStart(page('t', '<p>Hello</p>')), 'Hello');
  assert.equal(pageTitle('<title>A &amp; B\n  rule</title>'), 'A & B rule');
  // only the opening 2 KB of visible text counts
  const late = page('Example', `<p>${'filler text '.repeat(400)}</p><p>Page not found</p>`);
  assert.equal(soft404Reason(late), null);
  // ... but site chrome does not count towards it, and <main> and <h1> are read first (HIGH-1)
  const nav = `<nav>${Array.from({ length: 120 }, (_, i) => `<a href="/s${i}">Section link number ${i}</a>`).join(' ')}</nav>`;
  assert.match(soft404Reason(page('Example Agency', `${nav}<div><p>Page not found</p></div>`)), /^opening text says "Page not found"/);
  assert.match(soft404Reason(page('Example Agency', `<header>${nav}</header><main><p>Sorry, the requested URL was not found on this server.</p></main>`)), /^main text says/);
  assert.match(soft404Reason(page('Example Agency', `<div role="navigation"><div>${nav}</div></div><p>Page not found</p>`)), /^opening text/);
  assert.equal(visibleTextStart(page('t', '<header><nav>Menu</nav></header><aside>Related</aside><p>Body</p><footer>Contact</footer>')), 'Body');
  assert.equal(mainText(page('t', '<nav>Menu</nav><main id="m"><nav>Crumbs</nav><p>Inner <b>text</b></p></main><p>After</p>')), 'Inner text');
  assert.equal(mainText(page('t', '<div role="main"><div><p>Role main</p></div></div><p>After</p>')), 'Role main');
  assert.equal(mainText(page('t', '<p>No main</p>')), '');
  assert.deepEqual(headings(page('t', '<h1>One</h1><h1><span>Two</span></h1>')), ['One', 'Two']);
  // the phrasings the review found missing (opening text and titles)
  const body = (b) => soft404Reason(page('Example Agency | Official website of the Example Agency', `<p>${b}</p>`));
  for (const b of [
    "We can't find the page you're looking for.",
    'Hmm, we cannot find that page.',
    'Looks like this page is missing.',
    'The page you were looking for has moved or no longer exists.',
    'The page you requested may have been removed.',
    "We couldn't find what you were looking for.",
    'It looks like nothing was found at this location.',
  ]) assert.ok(body(b), b);
  for (const t of ["We can't find that page", 'Page Missing | Example', 'Error | Example Agency', 'Oops! | Example', 'Not Available', 'Error 404', 'Example | 404']) {
    assert.match(soft404Reason(page(t, '<p>x</p>')), /^title/, t);
  }
  assert.match(soft404Reason(page('Example Agency', '<h1>Oops!</h1><p>That link is broken.</p>')), /^heading "Oops!"/);
  assert.match(soft404Reason(page('Example Agency', '<h1>Content not available</h1>')), /^heading/);
  // ordinary titles and text that merely use the words
  for (const [t, b] of [
    ['Rule 404 | SEC', '<p>Amendments to Rule 404.</p>'],
    ['Errors and Omissions in Financial Reporting', '<p>x</p>'],
    ['Sorry state of patching at edge appliances', '<p>Researchers could not find the file the attackers dropped.</p>'],
    ['Agency moves supervision page', '<p>The agency has moved its supervision team to a new division.</p>'],
  ]) assert.equal(soft404Reason(page(t, b)), null, t);
});

test('sameSite: registrable domain, www and subdomains, documented canonical hosts', () => {
  assert.equal(sameSite('https://federalreserve.gov/x', 'https://www.federalreserve.gov/x'), true);
  assert.equal(sameSite('https://www.cisa.gov/a', 'https://us-cert.cisa.gov/b'), true);
  assert.equal(sameSite('https://www.ncsc.gov.uk/a', 'https://ncsc.gov.uk/b'), true);
  assert.equal(sameSite('https://www.occ.treas.gov/news', 'https://www.occ.gov/news'), true);
  assert.equal(sameSite('https://www.ecb.europa.eu/a', 'https://www.bankingsupervision.europa.eu/b'), true);
  assert.ok(CANONICAL_HOSTS.length >= 2);
  assert.equal(sameSite('https://www.eba.europa.eu/a', 'https://www.esma.europa.eu/b'), false);
  assert.equal(sameSite('https://www.example.com/a', 'https://login.example.net/b'), false);
  assert.equal(sameSite('https://www.example.com/a', 'https://www.treas.gov/b'), false);
  // tenants of a shared suffix are different sites (LOW-15)
  assert.equal(sameSite('https://www.economie.gouv.fr/a', 'https://www.interieur.gouv.fr/'), false);
  assert.equal(sameSite('https://www.economie.gouv.fr/a', 'https://economie.gouv.fr/b'), true);
  assert.equal(sameSite('https://acme.github.io/post', 'https://evil.github.io/x'), false);
  assert.equal(sameSite('https://x.blogspot.com/2026/01/a.html', 'https://y.blogspot.com/'), false);
  assert.equal(siteOf('a.b.acme.github.io'), 'acme.github.io');
  assert.equal(siteOf('www.ncsc.gov.uk'), 'ncsc.gov.uk');
});

test('contentKind: HTML, PDF, XML and JSON only', () => {
  assert.equal(contentKind('text/html; charset=utf-8'), 'html');
  assert.equal(contentKind('application/xhtml+xml'), 'html');
  assert.equal(contentKind('application/pdf'), 'pdf');
  assert.equal(contentKind('application/rss+xml'), 'xml');
  assert.equal(contentKind('text/xml'), 'xml');
  assert.equal(contentKind('application/json'), 'json');
  assert.equal(contentKind('application/ld+json'), 'json');
  assert.equal(contentKind('image/png'), null);
  assert.equal(contentKind('application/octet-stream'), null);
  assert.equal(contentKind(null), null);
});

test('urlCheckIssue: verified within 24 h of now; stale, failed, missing, future and inconsistent records refused', () => {
  const now = new Date('2026-10-04T12:00:00-04:00');
  const ok = (checked, o = {}) => ({ url: 'https://a.example.com/x', status: 200, final_url: 'https://a.example.com/x', content_type: 'text/html', verified: true, verified_by: 'page', reason: 'ok', checked_at: checked, redirects: 0, title: 'A page', ...o });
  assert.equal(urlCheckIssue(ok('2026-10-03T12:00:00-04:00'), now), null, 'exactly 24 h old');
  assert.equal(urlCheckIssue(ok('2026-10-04T11:59:00-04:00'), now), null);
  assert.match(urlCheckIssue(ok('2026-10-03T11:59:59-04:00'), now), /more than 24 h before/);
  assert.match(urlCheckIssue(ok('2026-10-04T12:30:00-04:00'), now), /is after now/);
  assert.equal(urlCheckIssue(ok('2026-10-04T12:04:00-04:00'), now), null, 'small clock skew tolerated');
  assert.match(urlCheckIssue({ ...ok('2026-10-04T11:00:00-04:00'), verified: false, reason: 'HTTP 404' }, now), /failed verification \(HTTP 404.*BF_URL_UNVERIFIED/);
  assert.match(urlCheckIssue(undefined, now), /^not checked$/);
  assert.match(urlCheckIssue(ok('yesterday'), now), /no valid checked_at/);
  // the verdict is re-derived from the record's own fields (HIGH-2)
  const at = '2026-10-04T11:00:00-04:00';
  const url = 'https://a.example.com/x';
  assert.equal(urlCheckIssue(ok(at), now, { url }), null);
  assert.match(urlCheckIssue(ok(at), now, { url: 'https://a.example.com/other' }), /the check is of https:\/\/a\.example\.com\/x, not this URL/);
  assert.match(urlCheckIssue(ok(at, { url: 'http://a.example.com/x', final_url: 'http://a.example.com/x' }), now, { url }), /the checked URL is not https/);
  assert.match(urlCheckIssue(ok(at, { final_url: 'https://a.example.com/', redirects: 1 }), now, { url }), /home page/);
  assert.match(urlCheckIssue(ok(at, { final_url: 'https://elsewhere.example.net/x' }), now, { url }), /off-site/);
  assert.match(urlCheckIssue(ok(at, { status: 404 }), now, { url }), /status 404, not 200/);
  assert.match(urlCheckIssue(ok(at, { content_type: 'image/png' }), now, { url }), /content type "image\/png"/);
  assert.match(urlCheckIssue(ok(at, { verified_by: null }), now, { url }), /verified_by is not "page"/);
  const kev = 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-91001';
  assert.match(urlCheckIssue(ok(at, { url: kev, final_url: kev }), now, { url: kev }), /verified only against the catalogue JSON/);
  assert.equal(urlCheckIssue(ok(at, { url: kev, final_url: kev, verified_by: 'kev-json', kev: { cve: 'CVE-2026-91001', date_added: '2026-01-01' } }), now, { url: kev }), null);
  // a Federal Register document holds up only as an API record of the same document
  const frDoc = 'https://www.federalregister.gov/documents/2026/01/07/2026-90085/a-rule';
  const frApi = 'https://www.federalregister.gov/api/v1/documents/2026-90085.json';
  const frRec = (o = {}) => ok(at, { url: frDoc, final_url: frApi, content_type: 'application/json', title: null, verified_by: 'federalregister-api', fr: { document_number: '2026-90085', api_url: frApi, html_url: 'https://www.federalregister.gov/documents/2026/01/07/2026-90085/a-rule-renamed', publication_date: '2026-01-07' }, ...o });
  assert.equal(urlCheckIssue(frRec(), now, { url: frDoc }), null);
  assert.match(urlCheckIssue(frRec({ verified_by: 'page', final_url: frDoc, content_type: 'text/html' }), now, { url: frDoc }), /verified only through the Federal Register API/);
  assert.match(urlCheckIssue(frRec({ final_url: frDoc }), now, { url: frDoc }), /is not a Federal Register API document record/);
  assert.match(urlCheckIssue(frRec({ fr: { document_number: '2026-90085', html_url: 'https://www.federalregister.gov/documents/2026/01/07/2026-90099/x', publication_date: '2026-01-07' } }), now, { url: frDoc }), /is not the source URL's document/);
  assert.match(urlCheckIssue(frRec({ fr: { document_number: '2026-90085', html_url: frDoc, publication_date: null } }), now, { url: frDoc }), /publication_date null is not a date/);
});

test('federalRegisterDocOf, federalRegisterApiUrl, federalRegisterRecordProblem', () => {
  const u = 'https://www.federalregister.gov/documents/2026/01/07/2026-00085/truth-in-lending-act-regulation-z';
  assert.deepEqual(federalRegisterDocOf(u), { document_number: '2026-00085', date: '2026-01-07', path: '/documents/2026/01/07/2026-00085' });
  assert.equal(federalRegisterDocOf('https://federalregister.gov/documents/2026/01/07/2026-00085')?.document_number, '2026-00085', 'no slug, bare host');
  assert.equal(federalRegisterDocOf('http://www.federalregister.gov/documents/2026/01/07/2026-00085/x'), null, 'https only');
  assert.equal(federalRegisterDocOf('https://www.federalregister.gov/public-inspection/2026-00085/x'), null);
  assert.equal(federalRegisterDocOf('https://www.federalregister.gov/documents/2026/02/30/2026-00085/x'), null, 'not a calendar date');
  assert.equal(federalRegisterDocOf('https://www.federalregister.gov/documents/2026/01/07/search/x'), null, 'a number has a digit');
  assert.equal(federalRegisterDocOf('https://www.federalregister.gov.example.com/documents/2026/01/07/2026-00085/x'), null);
  assert.equal(federalRegisterDocOf('https://unblock.federalregister.gov/documents/2026/01/07/2026-00085/x'), null);
  assert.equal(federalRegisterApiUrl('2026-00085'), 'https://www.federalregister.gov/api/v1/documents/2026-00085.json');
  const d = federalRegisterDocOf(u);
  const rec = (o = {}) => ({ document_number: '2026-00085', html_url: 'https://www.federalregister.gov/documents/2026/01/07/2026-00085/another-slug', publication_date: '2026-01-07', ...o });
  assert.equal(federalRegisterRecordProblem(d, rec(), '2026-01-07'), null, 'the slug may differ');
  assert.match(federalRegisterRecordProblem(d, rec(), '2026-01-08'), /publication_date 2026-01-07 is not the candidate's date 2026-01-08/);
  assert.match(federalRegisterRecordProblem(d, rec({ html_url: 'https://www.federalregister.gov/documents/2026/01/08/2026-00085/x' }), '2026-01-07'), /not the source URL's document/);
  assert.match(federalRegisterRecordProblem(d, rec({ document_number: '2026-00099' }), '2026-01-07'), /document_number "2026-00099" is not 2026-00085/);
  assert.match(federalRegisterRecordProblem(d, rec({ html_url: 'https://example.com/x' }), '2026-01-07'), /is not a Federal Register document URL/);
  assert.match(federalRegisterRecordProblem(d, [], '2026-01-07'), /not a JSON object/);
  // the candidate dates the official records must confirm
  const exp = expectedChecks([{ url: u, published_date: '2026-01-07' }, { url: 'https://a.example.com/x', published_date: '2026-01-05' }]);
  assert.deepEqual([...exp.entries()], [[normaliseUrl(u), { publication_date: '2026-01-07' }]]);
});

test('accessWall: bot and challenge interstitials on any host, on 200 or 403/429/503; never a retry under another identity', () => {
  assert.equal(accessWall({ status: 200, final_url: 'https://captcha.cdn.example.net/x', title: '' }), 'access wall at captcha.cdn.example.net');
  assert.equal(accessWall({ status: 403, final_url: 'https://www.example.gov/x', title: 'Just a moment...' }), 'access wall (HTTP 403): title "Just a moment..."');
  assert.equal(accessWall({ status: 503, final_url: 'https://www.example.gov/x', title: 'Attention Required! | Cloudflare' }), 'access wall (HTTP 503): title "Attention Required! | Cloudflare"');
  assert.equal(accessWall({ status: 403, final_url: 'https://www.example.gov/x', title: 'Forbidden' }), null, 'a plain 403 is reported as HTTP 403');
  assert.equal(accessWall({ status: 404, final_url: 'https://unblock.example.gov/', title: 'Request Access' }), null);
  assert.equal(accessWall({ status: 200, final_url: 'https://www.example.gov/x', title: 'Fictional rule on access controls' }), null);
});

test('mergeUrlChecks keeps every check as history, the newest on top, and ignores future-stamped ones; urlsToVerify', () => {
  const real = new Date('2026-10-05T00:00:00-04:00');
  const a = { url: 'https://a.example.com/x?utm_source=feed', status: 404, verified: false, reason: 'HTTP 404', checked_at: '2026-10-04T10:00:00-04:00' };
  const b = { url: 'https://a.example.com/x', status: 200, verified: true, reason: 'ok', checked_at: '2026-10-04T11:00:00-04:00' };
  const doc = mergeUrlChecks({ month: '2026-01', checks: {} }, [b], real);
  const doc2 = mergeUrlChecks(doc, [a], real);
  assert.equal(Object.keys(doc2.checks).length, 1);
  assert.equal(doc2.checks['https://a.example.com/x'].verified, true, 'an older check never replaces a newer one');
  // ... but it is recorded (LOW-12)
  assert.deepEqual(doc2.checks['https://a.example.com/x'].history.map((h) => [h.checked_at, h.verified]), [['2026-10-04T10:00:00-04:00', false], ['2026-10-04T11:00:00-04:00', true]]);
  const doc3 = mergeUrlChecks(doc2, [{ ...a, checked_at: '2026-10-04T12:00:00-04:00' }], real);
  assert.equal(doc3.checks['https://a.example.com/x'].verified, false);
  assert.equal(doc3.checks['https://a.example.com/x'].history.length, 3);
  assert.equal(mergeUrlChecks(doc3, [b], real).checks['https://a.example.com/x'].history.length, 3, 'the same check is recorded once');
  // two checks in the same second are two checks (check_id), recorded once each however often merged
  const twin = (id) => ({ ...b, check_id: id, checked_at: '2026-10-04T13:00:00-04:00' });
  const doc3b = mergeUrlChecks(mergeUrlChecks(doc3, [twin('aaaaaaaaaaaa')], real), [twin('bbbbbbbbbbbb'), twin('aaaaaaaaaaaa')], real);
  assert.deepEqual(doc3b.checks['https://a.example.com/x'].history.slice(-2).map((h) => h.check_id), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  // a check stamped after the real time (a forged --now) is ignored, and so is one already in the file (HIGH-2)
  const ignored = [];
  const onIgnored = (key, rec, why) => ignored.push([key, why]);
  const forged = { ...b, checked_at: '2026-12-01T09:00:00-05:00' };
  const doc4 = mergeUrlChecks(doc3, [forged], real, { onIgnored });
  assert.equal(doc4.checks['https://a.example.com/x'].verified, false);
  assert.match(ignored[0][1], /checked_at 2026-12-01T09:00:00-05:00 is after the real time 2026-10-05T00:00:00-04:00/);
  const planted = { month: '2026-01', checks: { 'https://a.example.com/x': { ...forged, history: [{ ...forged }, { checked_at: '2026-10-04T10:00:00-04:00', status: 404, verified: false, reason: 'HTTP 404' }] } } };
  const doc5 = mergeUrlChecks(planted, [], real, { onIgnored });
  const e5 = doc5.checks['https://a.example.com/x'];
  assert.deepEqual([e5.verified, e5.checked_at, e5.history.length], [false, '2026-10-04T10:00:00-04:00', 1]);
  assert.equal(mergeUrlChecks({ checks: { k: { ...forged, history: [] } } }, [], real).checks.k, undefined);
  assert.equal(mergeUrlChecks({ checks: {} }, [{ ...b, checked_at: 'soon' }], real, { onIgnored }).checks['https://a.example.com/x'], undefined);
  assert.match(ignored.at(-1)[1], /no valid checked_at/);
  // urlsToVerify: with candidates, the URL of every BF_URL_UNVERIFIED drop too (MED-8)
  const cands = [{ candidate_id: 'c-1111111111', url: 'https://d.example.com/gone' }, { candidate_id: 'c-2222222222', url: 'https://d.example.com/other' }];
  const dec = { items: [{ sources: [{ url: 'https://a.example.com/1' }] }], judgments: [{ candidate_id: 'c-1111111111', reason_code: 'BF_URL_UNVERIFIED' }, { candidate_id: 'c-2222222222', reason_code: 'CS_NO_SPECIFIC_CHANGE' }] };
  assert.deepEqual(urlsToVerify(dec, cands), ['https://a.example.com/1', 'https://d.example.com/gone']);
  assert.deepEqual(urlsToVerify(dec), ['https://a.example.com/1']);
  assert.deepEqual(urlsToVerify({ items: [{ sources: [{ url: 'https://a.example.com/1' }, { url: 'https://b.example.com/2' }] }, { sources: [{ url: 'https://c.example.com/3' }] }] }), ['https://a.example.com/1', 'https://b.example.com/2', 'https://c.example.com/3']);
  assert.deepEqual(urlsToVerify(['https://a.example.com/1', 5]), ['https://a.example.com/1']);
  assert.deepEqual(urlsToVerify({ urls: ['https://a.example.com/1'] }), ['https://a.example.com/1']);
});

test('backfillReasonCodes: FILTER §8.2 closed list plus the three BF_ drop codes', () => {
  const codes = backfillReasonCodes(fs.readFileSync(FILTER_FIXTURE, 'utf8'));
  for (const c of ['BF_SECTION_EXCLUDED', 'BF_OUT_OF_WINDOW', 'BF_URL_UNVERIFIED']) assert.equal(codes.get(c), 'drop');
  assert.equal(codes.get('CS_PASS_CONTROL_FAILURE'), 'pass');
  assert.equal(backfillReasonCodes(null), null);
  const live = backfillReasonCodes(fs.readFileSync(path.join(ROOT, 'pipeline', 'FILTER.md'), 'utf8'));
  assert.equal(live.size, 51 + 3);
});

test('accessWallReason: bot interstitials and redirects to the home page; ordinary pages never', () => {
  const doc = 'https://www.federalregister.gov/documents/2026/01/07/2026-00085/a-rule';
  assert.match(accessWallReason(doc, { status: 200, final_url: 'https://unblock.federalregister.gov/', redirects: 1, title: 'Federal Register :: Request Access' }), /^access wall at unblock\.federalregister\.gov/);
  assert.match(accessWallReason(doc, { status: 200, final_url: doc, title: 'Just a moment...' }), /^access wall: title/);
  assert.match(accessWallReason(doc, { status: 200, final_url: doc, title: 'Attention Required! | Cloudflare' }), /^access wall/);
  assert.match(accessWallReason(doc, { status: 200, final_url: 'https://www.federalregister.gov/', redirects: 1, title: 'Federal Register' }), /home page/);
  assert.equal(accessWallReason(doc, { status: 200, final_url: doc, title: 'Federal Register :: Truth in Lending Act (Regulation Z) Adjustment' }), null);
  assert.equal(accessWallReason(doc, { status: 200, final_url: doc, title: 'How to request access to agency records under the Freedom of Information Act' }), null, 'a long title about access is not a wall');
  assert.equal(accessWallReason('https://www.example.gov/', { status: 200, final_url: 'https://www.example.gov/', redirects: 1, title: 'Home' }), null);
  assert.equal(accessWallReason(doc, { status: 404, final_url: 'https://unblock.federalregister.gov/', title: '' }), null);
  // where dead links go (HIGH-1): every home-page form, error pages, search pages, parent listings
  const o = 'https://www.example.gov/news/2026/01/fictional-release';
  const via = (final, original = o) => accessWallReason(original, { status: 200, final_url: final, redirects: 1, title: 'Example Agency' });
  for (const f of ['https://www.example.gov/', 'https://www.example.gov/en/', 'https://www.example.gov/fr-fr', 'https://www.example.gov/index.html', 'https://www.example.gov/home', 'https://www.example.gov/en/default.aspx', 'https://www.example.gov/?from=old-site']) {
    assert.match(via(f), /home page/, f);
  }
  assert.match(via('https://www.example.gov/', 'https://www.example.gov/?p=1234'), /home page/, 'a query-identified page sent home');
  assert.equal(via('https://www.example.gov/index.php?p=1234&lang=en', 'https://www.example.gov/index.php?p=1234'), null, 'the identifying query kept');
  assert.equal(via('https://www.example.gov/en/', 'https://www.example.gov/'), null, 'the home page itself');
  for (const f of ['https://www.example.gov/404.html', 'https://www.example.gov/page-not-found', 'https://www.example.gov/error/404.html?item=x', 'https://www.example.gov/errors/']) assert.match(via(f), /error page/, f);
  assert.equal(via('https://www.example.gov/blog/404-errors-explained/', 'https://www.example.gov/blog/404-errors-explained'), null);
  for (const f of ['https://www.example.gov/search?q=fictional-release', 'https://www.example.gov/en/search/']) assert.match(via(f), /search page/, f);
  for (const f of ['https://www.example.gov/news', 'https://www.example.gov/news/2026/']) assert.match(via(f), /a parent of the original path/, f);
  assert.equal(via('https://www.example.gov/news/2026/01/fictional-release/'), null, 'a trailing slash');
  assert.equal(via('https://www.example.gov/news/x/', 'https://www.example.gov/news/x/index.html'), null, 'an index file');
  assert.equal(via('https://www.example.gov/newsroom/2026/fictional-release'), null, 'a moved page');
  assert.equal(via('https://www.example.gov/ok', 'https://www.example.gov/moved'), null, 'a two-letter path is no locale unless it is a language code');
  assert.equal(accessWallReason(o, { status: 200, final_url: 'https://www.example.gov/', redirects: 0, title: 'x' }), null, 'no redirect');
});

test('canaryUrl: a made-up sibling that replaces what identifies the page', () => {
  const t = `${CANARY_PREFIX}abc`;
  assert.equal(canaryUrl('https://www.esma.europa.eu/press-news/esma-news/fictional-xyz', t), 'https://www.esma.europa.eu/press-news/esma-news/rs-canary-abc');
  // an id segment before a decorative slug: the id is replaced (the Federal Register ignores the slug)
  assert.equal(canaryUrl('https://www.federalregister.gov/documents/2026/01/07/2026-00085/a-rule', t), 'https://www.federalregister.gov/documents/2026/01/07/rs-canary-abc/a-rule');
  assert.equal(canaryUrl('https://www.finextra.com/newsarticle/99999999/fictional-xyz', t), 'https://www.finextra.com/newsarticle/rs-canary-abc/fictional-xyz');
  // a date path before a slug: the slug identifies the post
  assert.equal(canaryUrl('https://krebsonsecurity.com/2026/01/fictional-article-xyz/', t), 'https://krebsonsecurity.com/2026/01/rs-canary-abc/');
  assert.equal(canaryUrl('https://www.federalreserve.gov/newsevents/pressreleases/bcreg20260199a.htm', t), 'https://www.federalreserve.gov/newsevents/pressreleases/rs-canary-abc.htm');
  assert.equal(canaryUrl('https://www.sec.gov/newsroom/press-releases/2026-5', t), 'https://www.sec.gov/newsroom/press-releases/rs-canary-abc');
  // an identifying query value
  assert.equal(canaryUrl('https://www.example.gov/?p=1234', t), 'https://www.example.gov/?p=rs-canary-abc');
  assert.equal(canaryUrl('https://www.example.gov/news/article.aspx?id=5&utm_source=x', t), 'https://www.example.gov/news/article.aspx?id=rs-canary-abc&utm_source=x');
  assert.equal(canaryUrl('https://www.example.gov/view.php?doc=annual', t), 'https://www.example.gov/view.php?doc=rs-canary-abc');
  assert.equal(canaryUrl('https://www.example.gov/', t), 'https://www.example.gov/rs-canary-abc');
  assert.equal(canaryUrl('https://www.example.gov/a#frag', t), 'https://www.example.gov/rs-canary-abc');
});

test('samePage: a canary answering 200 with the same page means the 200 proves nothing', () => {
  const html = (title, text) => ({ status: 200, content_type: 'text/html', body: `<html><head><title>${title}</title></head><body><nav>Menu</nav><main><p>${text}</p></main></body></html>` });
  const listing = 'ESMA news listing with the latest items one two three four five six seven eight nine ten';
  const real = { ...html('ESMA News | ESMA', listing), final_url: 'https://www.esma.europa.eu/press-news/esma-news/fictional-xyz' };
  const canary = { ...html('ESMA News | ESMA', listing), final_url: 'https://www.esma.europa.eu/press-news/esma-news/rs-canary-abc' };
  assert.equal(samePage(real, canary), true);
  assert.equal(samePage(real, { ...canary, status: 404 }), false);
  assert.equal(samePage(real, { ...canary, error: 'timeout' }), false);
  // one shared <title> for every page, different content: not the same page
  assert.equal(samePage({ ...real, ...html('Example', 'A real article about resilience testing rules and their effect on firms') }, { ...canary, ...html('Example', 'We could not route this request; try the menu') }), false);
  // redirected to the very page that was checked
  assert.equal(samePage(real, { ...html('Other', 'other'), final_url: real.final_url }), true);
  assert.equal(samePage({ status: 200, content_type: 'application/pdf', final_url: 'https://a.example.com/x.pdf' }, { status: 200, content_type: 'application/pdf', final_url: 'https://a.example.com/c.pdf' }), false);
  const json = (body, u) => ({ status: 200, content_type: 'application/json', body, final_url: u });
  assert.equal(samePage(json('{"a":1}', 'https://a.example.com/1'), json('{"a":1}', 'https://a.example.com/c')), true);
  assert.equal(samePage(json('{"a":1}', 'https://a.example.com/1'), json('{"error":"none"}', 'https://a.example.com/c')), false);
});

test('metaRefreshTarget and retryAfterMs', () => {
  assert.equal(metaRefreshTarget('<head><meta http-equiv="refresh" content="0; url=/"></head>'), '/');
  assert.equal(metaRefreshTarget(`<meta content='3;URL="https://a.example.com/x"' http-equiv='Refresh'>`), 'https://a.example.com/x');
  assert.equal(metaRefreshTarget('<meta http-equiv="refresh" content="30; url=/">'), null, 'a slow refresh is no redirect');
  assert.equal(metaRefreshTarget('<meta http-equiv="refresh" content="60">'), null, 'a reload');
  assert.equal(metaRefreshTarget('<noscript><meta http-equiv="refresh" content="0;url=/nojs"></noscript>'), null);
  assert.equal(metaRefreshTarget('<meta name="description" content="0; url=/">'), null);
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs(new Date(Date.UTC(2026, 9, 4, 12, 0, 30)).toUTCString(), Date.UTC(2026, 9, 4, 12, 0, 0)), 30000);
  assert.equal(retryAfterMs(''), 0);
  assert.equal(retryAfterMs('soon'), 0);
});

test('KEV helpers: catalogue URLs, the catalogue JSON index and the dates candidates expect', () => {
  assert.equal(kevCveOf('https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=cve-2026-91001'), 'CVE-2026-91001');
  assert.equal(kevCveOf('https://www.cisa.gov/known-exploited-vulnerabilities-catalog'), null);
  assert.equal(kevCveOf('https://www.cisa.gov/news-events/alerts/2026/01/05/x?search_api_fulltext=CVE-2026-91001'), null);
  assert.equal(kevCveOf('https://cisa.example.com/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-91001'), null);
  const idx = kevIndex(JSON.parse(fixture('backfill-kev.json')));
  assert.equal(idx.version, '2026.02.03');
  assert.equal(idx.entries.get('CVE-2026-91003'), '2026-01-31', 'ids normalised to upper case');
  assert.equal(idx.entries.has('CVE-2026-91005'), false, 'an unreadable date is no entry');
  assert.throws(() => kevIndex({}), /no "vulnerabilities" array/);
  const k = kevMonthCandidates(JSON.parse(fixture('backfill-kev.json')), W, { id: 'cisa-kev', publication: 'CISA', source_class: 'vendor_threat_research', paywalled: false, region: 'US' }).candidates;
  const exp = expectedChecks([...k, { url: 'https://a.example.com/x', published_date: '2026-01-05' }]);
  assert.deepEqual([...exp.values()].map((x) => x.kev_date_added), ['2026-01-01', '2026-01-15', '2026-01-31']);
});

/** A fetch stand-in serving canned responses by URL: { url: [status, headers, body] | (init) => [...] }. */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push([String(url), init.headers?.['user-agent']]);
    let r = routes[String(url)];
    if (typeof r === 'function') r = r(init);
    if (!r) return new Response('nf', { status: 404, headers: { 'content-type': 'text/plain' } });
    const [status, headers = {}, body = null] = r;
    return new Response(body, { status, headers });
  };
}
const HTML_T = { 'content-type': 'text/html; charset=utf-8' };
const htmlDoc = (title, text = 'Fictional body text for this page.') => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

test('checkUrl (fake fetch): https never redirected to http, canary verdicts, Retry-After, KEV against the JSON', async () => {
  const kevPage = 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-91002';
  const calls = [];
  const fetchImpl = fakeFetch({
    'https://a.example.com/doc': [301, { location: 'http://a.example.com/doc' }],
    'http://a.example.com/doc': [200, HTML_T, htmlDoc('A document')],
    'https://b.example.com/news/fictional-xyz': [200, HTML_T, htmlDoc('News | B', 'the listing of news items')],
    'https://b.example.com/news/real-article': [200, HTML_T, htmlDoc('A real article | B')],
    // busy once: 429 asking for an hour, then the page (one retry, same user agent, wait capped)
    'https://c.example.com/busy': () => (calls.filter(([u]) => u === 'https://c.example.com/busy').length > 1 ? [200, HTML_T, htmlDoc('Busy page')] : [429, { 'retry-after': '3600' }, 'slow down']),
    // the catalogue page answers the same first rows for any query
    ...Object.fromEntries(['91002', '91001', '99999'].map((n) => [kevPage.replace('91002', n), [200, HTML_T, htmlDoc('Known Exploited Vulnerabilities Catalog | CISA', 'first rows of the catalogue whatever is searched')]])),
    [KEV_URL]: [200, { 'content-type': 'application/json' }, fixture('backfill-kev.json')],
  }, calls);
  // https -> http refused unless allowHttp (LOW-15)
  const down = await checkUrl('https://a.example.com/doc', { fetchImpl });
  assert.deepEqual([down.verified, down.reason], [false, 'redirected to insecure http://a.example.com/doc']);
  assert.equal((await checkUrl('https://a.example.com/doc', { fetchImpl, allowHttp: true })).verified, true);
  // canary (HIGH-1): a site answering every /news/ path with the listing proves nothing for a dead
  // link there, while a real article whose title and text differ from the listing still verifies
  const catchAll = async (url, init) => (String(url).startsWith(`https://b.example.com/news/${CANARY_PREFIX}`) ? new Response(htmlDoc('News | B', 'the listing of news items'), { status: 200, headers: HTML_T }) : fetchImpl(url, init));
  const fake = await checkUrl('https://b.example.com/news/fictional-xyz', { fetchImpl: catchAll });
  assert.equal(fake.verified, false);
  assert.match(fake.reason, /^soft 404: a made-up sibling URL \(https:\/\/b\.example\.com\/news\/rs-canary-[0-9a-f]{10}\) answers 200 with the same page/);
  assert.equal(fake.canary.same_page, true);
  const realOnCatchAll = await checkUrl('https://b.example.com/news/real-article', { fetchImpl: catchAll });
  assert.deepEqual([realOnCatchAll.verified, realOnCatchAll.canary.status, realOnCatchAll.canary.same_page], [true, 200, false]);
  const live = await checkUrl('https://b.example.com/news/real-article', { fetchImpl });
  assert.deepEqual([live.verified, live.verified_by, live.canary.status, live.canary.same_page], [true, 'page', 404, false]);
  assert.equal((await checkUrl('https://b.example.com/news/real-article', { fetchImpl, canary: false })).canary, undefined);
  // Retry-After is honoured, capped (MAX_RETRY_AFTER_MS; lowered here)
  const t0 = Date.now();
  const busy = await checkUrl('https://c.example.com/busy', { fetchImpl, maxRetryAfterMs: 150 });
  const waited = Date.now() - t0;
  assert.deepEqual([busy.verified, busy.retried, busy.retry_status, busy.reason], [true, true, 429, 'ok (retried once after HTTP 429)']);
  assert.ok(waited >= 140 && waited < 5000, `waited ${waited} ms`);
  assert.deepEqual(calls.filter(([u]) => u === 'https://c.example.com/busy').map(([, ua]) => ua), [USER_AGENT, USER_AGENT]);
  // KEV (MED-3): verified against the catalogue JSON, fetched once for many URLs; no canary on the page
  calls.length = 0;
  const k1 = kevPage.replace('91002', '91001');
  const recs = await checkUrls([kevPage, k1, kevPage.replace('91002', '99999')], {
    fetchImpl,
    expected: new Map([[normaliseUrl(kevPage), { kev_date_added: '2026-01-15' }], [normaliseUrl(k1), { kev_date_added: '2026-01-02' }]]),
  });
  assert.deepEqual(recs.map((r) => [r.verified, r.verified_by]), [[true, 'kev-json'], [false, null], [false, null]]);
  assert.deepEqual(recs[0].kev, { cve: 'CVE-2026-91002', date_added: '2026-01-15', catalog_version: '2026.02.03' });
  assert.match(recs[1].reason, /lists CVE-2026-91001 with dateAdded 2026-01-01, not 2026-01-02/);
  assert.match(recs[2].reason, /CVE-2026-99999 is not in the KEV catalogue JSON \(version 2026\.02\.03\); the catalogue page answers 200 for any query/);
  assert.equal(calls.filter(([u]) => u === KEV_URL).length, 1, 'the catalogue JSON is fetched once');
  assert.equal(calls.filter(([u]) => u.includes(CANARY_PREFIX)).length, 0, 'no canary on a catalogue page');
  // no KEV URL, no catalogue fetch
  calls.length = 0;
  await checkUrls(['https://b.example.com/news/real-article'], { fetchImpl });
  assert.equal(calls.filter(([u]) => u === KEV_URL).length, 0);
  assert.deepEqual(calls.filter(([, ua]) => ua !== USER_AGENT), []);
});

test('checkUrl (fake fetch): a Federal Register document is verified through the API record only', async () => {
  const FR = 'https://www.federalregister.gov';
  const docUrl = (date, num, slug) => `${FR}/documents/${date.replace(/-/g, '/')}/${num}/${slug}`;
  const api = (num) => federalRegisterApiUrl(num);
  const JSON_T = { 'content-type': 'application/json; charset=utf-8' };
  const record = (num, date, slug = 'fictional-rule', o = {}) => JSON.stringify({ document_number: num, title: 'Fictional Rule', html_url: docUrl(date, num, slug), publication_date: date, ...o });
  const calls = [];
  const fetchImpl = fakeFetch({
    [api('2026-90001')]: [200, JSON_T, record('2026-90001', '2026-01-05', 'fictional-joint-rule-renamed')],
    [api('2026-90002')]: () => (calls.filter(([u]) => u === api('2026-90002')).length > 1 ? [200, JSON_T, record('2026-90002', '2026-01-31')] : [429, { 'retry-after': '1' }, 'slow down']),
    [api('2026-90003')]: [200, HTML_T, htmlDoc('Federal Register')],
    [api('2026-90004')]: [200, JSON_T, 'not json'],
    [api('2026-90005')]: [301, { location: 'https://unblock.federalregister.gov/' }],
    'https://unblock.federalregister.gov/': [200, HTML_T, htmlDoc('Federal Register :: Request Access')],
    // the document pages wall a non-browser agent; the check must never request them
    ...Object.fromEntries(['2026-90001', '2026-90002'].map((n) => [docUrl('2026-01-05', n, 'x'), [302, { location: 'https://unblock.federalregister.gov/' }]])),
  }, calls);
  const src = docUrl('2026-01-05', '2026-90001', 'fictional-joint-rule');
  const ok = await checkUrl(src, { fetchImpl, expectedPublicationDate: '2026-01-05' });
  assert.deepEqual([ok.verified, ok.verified_by, ok.status, ok.final_url, ok.title], [true, 'federalregister-api', 200, api('2026-90001'), null]);
  assert.deepEqual([ok.fr.document_number, ok.fr.publication_date, ok.fr.html_url], ['2026-90001', '2026-01-05', docUrl('2026-01-05', '2026-90001', 'fictional-joint-rule-renamed')]);
  assert.equal(ok.canary, undefined, 'no canary: the API record is the check');
  // without a candidate the date in the URL is expected; a candidate's other date fails
  assert.equal((await checkUrl(src, { fetchImpl })).verified, true);
  const wrongDate = await checkUrl(src, { fetchImpl, expectedPublicationDate: '2026-01-06' });
  assert.equal(wrongDate.verified, false);
  assert.match(wrongDate.reason, /publication_date 2026-01-05 is not the candidate's date 2026-01-06$/);
  // a 429 from the API: Retry-After honoured (capped), one retry with the same agent
  const busy = await checkUrl(docUrl('2026-01-31', '2026-90002', 'x'), { fetchImpl, maxRetryAfterMs: 100 });
  assert.deepEqual([busy.verified, busy.retried, busy.retry_status], [true, true, 429], busy.reason);
  assert.match(busy.reason, /^ok: document 2026-90002 in the Federal Register API \(publication_date 2026-01-31\) \(retried once after HTTP 429\)$/);
  assert.match((await checkUrl(docUrl('2026-01-05', '2026-90003', 'x'), { fetchImpl })).reason, /content type "text\/html; charset=utf-8" is not JSON$/);
  assert.match((await checkUrl(docUrl('2026-01-05', '2026-90004', 'x'), { fetchImpl })).reason, /the response is not valid JSON$/);
  const walled = await checkUrl(docUrl('2026-01-05', '2026-90005', 'x'), { fetchImpl });
  assert.equal(walled.verified, false);
  assert.match(walled.reason, /^access wall at unblock\.federalregister\.gov .*\(Federal Register API /);
  assert.match((await checkUrl(docUrl('2026-01-05', '2026-90006', 'x'), { fetchImpl })).reason, /2026-90006\.json: HTTP 404$/);
  // expected dates flow from the candidates through checkUrls
  const recs = await checkUrls([src], { fetchImpl, expected: expectedChecks([{ url: src, published_date: '2026-01-04' }]) });
  assert.match(recs[0].reason, /is not the candidate's date 2026-01-04$/);
  // never the document pages, never another user agent
  assert.deepEqual(calls.filter(([u]) => u.startsWith(`${FR}/documents/`)), []);
  assert.deepEqual(calls.filter(([, ua]) => ua !== USER_AGENT), []);
  // an ordinary page sent to a challenge host on another domain: an access wall, not bypassed
  const page = await checkUrl('https://d.example.com/rule', { fetchImpl: fakeFetch({ 'https://d.example.com/rule': [302, { location: 'https://challenge.cdn.example.net/?r=1' }], 'https://challenge.cdn.example.net/?r=1': [200, HTML_T, htmlDoc('One more step')] }) });
  assert.deepEqual([page.verified, page.retried], [false, false]);
  assert.match(page.reason, /^access wall at challenge\.cdn\.example\.net/);
});
