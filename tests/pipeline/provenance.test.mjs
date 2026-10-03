// Source provenance and dedup enforcement (review findings F02, F13, F14, F15), stage 1 for event
// listings and extra sources, and the all-or-nothing file writer (F04). FICTIONAL data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeFilesAtomically } from '../../pipeline/lib/io.mjs';
import { eventUrlSegment, outrightDrop, runPrefilter } from '../../pipeline/lib/prefilter.mjs';
import { computeFunnel, seenConflicts } from '../../pipeline/lib/publish.mjs';
import { isKnownPaywalled, paywalledOnSite, sourceForUrl, validateSources } from '../../pipeline/lib/sources.mjs';
import { disallowedSourceReason } from '../../pipeline/lib/url.mjs';
import { parseReasonCodes, validateDecisions } from '../../pipeline/lib/validate.mjs';
import { fixture, judgment, makeCandidate, makeDraft, rmrf, tempDir } from './_helpers.mjs';

const RUN = '2026-10-02-1400';
const CODES = parseReasonCodes(fixture('filter-codes.md'));
const lead = makeCandidate({ url: 'https://news.example.com/gateway', headline: 'Gateway flaw exploited at several firms' });
const advisory = makeCandidate({
  url: 'https://agency.example.gov/advisories/aa26-275a', headline: 'Advisory AA26-275A: gateway exploitation',
  publication: 'Example Agency', source_class: 'vendor_threat_research', source_id: null, extra: true,
});
const ctx = (o = {}) => ({ runId: RUN, candidates: [lead, advisory], survivorIds: [lead.candidate_id], archiveItems: [], reasonCodes: CODES, ...o });
const errs = (r) => r.errors.join('\n');

test('F02: a public primary source found by search is listed as sources[0] through an extra candidate', () => {
  const item = makeDraft([advisory, lead], { source_class: 'vendor_threat_research' });
  const r = validateDecisions({ run_id: RUN, threshold_level: 'high', judgments: [judgment(lead)], items: [item] }, ctx());
  assert.deepEqual(r.errors, [], errs(r));
  assert.ok(!r.warnings.some((w) => /was not a stage-1 survivor/.test(w)), 'sanctioned extras are not warned about');
  // without registering it, the URL is refused with the way out named
  const unregistered = makeDraft([lead]);
  unregistered.sources.unshift({ publication: 'Example Agency', url: 'https://agency.example.gov/advisories/other', source_class: 'vendor_threat_research' });
  const r2 = validateDecisions({ run_id: RUN, threshold_level: 'high', judgments: [judgment(lead)], items: [unregistered] }, ctx());
  assert.match(errs(r2), /not the URL of any candidate .*add-manual\.mjs --extra/);
  // an extra cannot be judged (it is never a survivor)
  const r3 = validateDecisions({ run_id: RUN, threshold_level: 'high', judgments: [judgment(lead), judgment(advisory, { verdict: 'drop', reason_code: 'GL_OFF_DOMAIN', section_tested: null, reason: 'G1 x', draft_index: null })], items: [makeDraft([lead])] }, ctx());
  assert.match(errs(r3), /is not a stage-1 survivor/);
});

test('F13: re-listing a published source URL is an error unless the item is a material update of that story', () => {
  const published = { id: 'RS-261001-1000-01', sources: [{ url: 'https://news.example.com/gateway' }], update_of: null };
  const update1 = { id: 'RS-261001-1800-01', sources: [{ url: 'https://wire.example.org/gateway-follow-up' }], update_of: 'RS-261001-1000-01' };
  const other = { id: 'RS-260930-1000-01', sources: [{ url: 'https://news.example.com/unrelated' }], update_of: null };
  const archiveItems = [other, published, update1];
  const fresh = makeCandidate({ url: 'https://wire.example.org/gateway-new', headline: 'New coverage' });
  const c = ctx({ candidates: [fresh, lead], survivorIds: [fresh.candidate_id], archiveItems });
  const item = makeDraft([fresh, lead]);
  // dedup new: error naming the published item
  const r = validateDecisions({ run_id: RUN, threshold_level: 'high', judgments: [judgment(fresh)], items: [item] }, c);
  assert.match(errs(r), /sources\[1\]\.url: already a source of published item RS-261001-1000-01; .*material update/);
  // material update of the latest item in the chain: allowed (the URL belongs to the chain's first item)
  const upd = (matchId) => validateDecisions({
    run_id: RUN, threshold_level: 'high',
    judgments: [judgment(fresh, { dedup: 'material_update', match_id: matchId, reason: '[M2] spread to new sectors; C1-C6 hold | candidate_issue CI1-5' })],
    items: [{ ...item, update_of: matchId }],
  }, c);
  assert.deepEqual(upd('RS-261001-1800-01').errors, []);
  assert.deepEqual(upd('RS-261001-1000-01').errors, []);
  // a material update of a different story may not borrow this story's source
  assert.match(errs(upd('RS-260930-1000-01')), /already a source of published item RS-261001-1000-01/);
});

test('a source headline that is not the collected headline (e.g. lead text) is warned about', () => {
  const item = makeDraft([lead]);
  item.sources[0].headline = 'Threat actors are exploiting the flaw at several firms, according to the lead paragraph';
  const r = validateDecisions({ run_id: RUN, threshold_level: 'high', judgments: [judgment(lead)], items: [item] }, ctx());
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /sources\[0\]\.headline: not the collected headline/.test(w)));
  const trimmed = makeDraft([makeCandidate({ url: lead.url, headline: 'Gateway flaw exploited at several firms | Example News' })]);
  trimmed.sources[0].headline = 'Gateway flaw exploited at several firms';
  const r2 = validateDecisions({ run_id: RUN, threshold_level: 'high', judgments: [judgment(lead)], items: [trimmed] }, ctx({ candidates: [{ ...lead, headline: 'Gateway flaw exploited at several firms | Example News' }, advisory] }));
  assert.ok(!r2.warnings.some((w) => /headline: not the collected headline/.test(w)));
});

test('F13: seenConflicts names survivors that another run has since recorded as published or duplicate', () => {
  const seen = { urls: {
    'https://news.example.com/gateway': { verdict: 'published', item_id: 'RS-261002-1000-01', run_id: '2026-10-02-1000' },
    'https://news.example.com/b': { verdict: 'dropped', item_id: null, run_id: '2026-10-02-1000' },
  } };
  const b = makeCandidate({ url: 'https://news.example.com/b' });
  assert.deepEqual(seenConflicts([lead, b], seen), [{ candidate_id: lead.candidate_id, headline: lead.headline, verdict: 'published', item_id: 'RS-261002-1000-01', run_id: '2026-10-02-1000' }]);
  assert.deepEqual(seenConflicts([lead], { urls: {} }), []);
});

test('F14: funnel counts stories at stage 2 and both kinds of dedup drop', () => {
  const j = [
    { verdict: 'pass', dedup: 'new' },
    { verdict: 'pass', dedup: 'cluster_merged' },
    { verdict: 'pass', dedup: 'material_update' },
    { verdict: 'drop', dedup: 'same_story_dropped' },
    { verdict: 'drop', dedup: 'cluster_merged' },
    { verdict: 'drop', dedup: 'new' },
  ];
  const f = computeFunnel({ fetchReport: null, stage1: { survivors: new Array(6).fill({}) }, judgments: j, published: 2 });
  assert.equal(f.stage1_pass, 6);
  assert.equal(f.stage2_pass, 2);
  assert.equal(f.dedup_dropped, 3);
  assert.equal(f.published, 2);
});

test('F15: event-listing URLs are dropped at stage 1 for every class; extra sources are never scored', () => {
  assert.equal(eventUrlSegment('https://fintech.example.com/event-info/627/ai-without-the-hype?utm_source=x'), 'event-info');
  assert.equal(eventUrlSegment('https://standards.example.gov/news-events/events/2026/10/workshop'), 'events');
  assert.equal(eventUrlSegment('https://reserve.example.gov/newsevents/speech/governor20261001a.htm'), null);
  assert.equal(eventUrlSegment('https://news.example.com/2026/10/eventual-consistency'), null);
  const webinar = makeCandidate({ url: 'https://fintech.example.com/event-info/601/ransomware-msp', headline: 'Ransomware operators breach managed service provider used by lenders', lead: 'Ransomware, zero-day, critical infrastructure.' });
  for (const profile of ['lenient', 'standard', 'strict']) assert.deepEqual(outrightDrop(webinar, profile), { reason: 'event', detail: 'event listing URL (/event-info/)' });
  const r = runPrefilter([webinar, advisory, lead]);
  assert.equal(r.counts.event, 1);
  assert.equal(r.counts.extra, 1);
  assert.equal(r.counts.input, 2);
  assert.ok(![...r.survivors, ...r.dropped].some((x) => x.candidate_id === advisory.candidate_id));
});

test('extra-source URL rules: aggregators, caches, archives, AMP, shorteners, social and redirects are refused', () => {
  for (const u of ['https://news.google.com/articles/abc', 'https://web.archive.org/web/2026/https://news.example.com/x', 'https://archive.ph/abc',
    'https://www-example-com.cdn.ampproject.org/c/s/www.example.com/x', 'https://news.example.com/amp/story-1', 'https://news.example.com/story?outputType=amp',
    'https://t.co/abc', 'https://www.linkedin.com/posts/x', 'https://x.com/agency/status/1', 'https://www.msn.com/en-us/news/x',
    'https://out.example.com/redirect?url=https://news.example.com/x', 'https://example-com.translate.goog/x']) {
    assert.ok(disallowedSourceReason(u), u);
  }
  for (const u of ['https://agency.example.gov/advisories/aa26-275a', 'https://news.example.com/2026/10/ample-story', 'https://www.example.com/search?q=gateway']) {
    assert.equal(disallowedSourceReason(u), null, u);
  }
});

test('registry lookup for extra sources: same host, then same site; never another subdomain; paywall domain-wide; platforms by host only', () => {
  const sources = [
    { id: 'ex-news', publication: 'Example News', url: 'https://feeds.example.com/rss', paywalled: false, source_class: 'news' },
    { id: 'ex-pro', publication: 'Example News Pro', url: 'https://pro.example.com/feed', paywalled: true, source_class: 'news' },
    { id: 'blog-a', publication: 'Blog A', url: 'https://a.substack.com/feed', paywalled: false, source_class: 'research_analysis' },
    { id: 'std-drafts', publication: 'Example Standards', url: 'https://csrc.standards.example.gov/feeds/drafts.xml', paywalled: false, source_class: 'standards_body' },
  ];
  assert.equal(sourceForUrl(sources, 'https://feeds.example.com/x').id, 'ex-news');
  assert.equal(sourceForUrl(sources, 'https://www.example.com/story').id, 'ex-news', 'www and feeds are the same site');
  assert.equal(sourceForUrl(sources, 'https://pro.example.com/story').id, 'ex-pro');
  assert.equal(paywalledOnSite(sources, 'https://www.example.com/story').id, 'ex-pro', 'a paywall on the domain is never missed');
  assert.equal(paywalledOnSite(sources, 'https://csrc.standards.example.gov/x'), null);
  // friction 14: a records database on another subdomain borrows nothing from the drafts feed
  assert.equal(sourceForUrl(sources, 'https://nvd.standards.example.gov/vuln/detail/CVE-2026-1'), null);
  assert.equal(sourceForUrl(sources, 'https://csrc.standards.example.gov/pubs/x').id, 'std-drafts');
  assert.equal(sourceForUrl(sources, 'https://b.substack.com/p/x'), null);
  assert.equal(paywalledOnSite(sources, 'https://b.substack.com/p/x'), null);
  assert.equal(sourceForUrl(sources, 'https://a.substack.com/p/x').id, 'blog-a');
  assert.equal(isKnownPaywalled('https://www.ft.com/content/x'), true);
  assert.equal(isKnownPaywalled('https://agency.example.gov/x'), false);
  const v = validateSources({ schema_version: 1, sources: [{ id: 'a', publication: 'A', source_class: 'news', type: 'feed', url: 'https://a.example.com/f', paywalled: false, region: 'US', notes: '', exclude_url_patterns: ['/event-info/', 'x'] }] });
  assert.match(v.errors.join('\n'), /exclude_url_patterns: array of URL substrings/);
});

test('F04: writeFilesAtomically restores every file already written when a later write fails', () => {
  const dir = tempDir();
  try {
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    const c = path.join(dir, 'sub', 'c.jsonl');
    const d = path.join(dir, 'd.json');
    fs.writeFileSync(a, 'A0');
    fs.writeFileSync(b, 'B0');
    fs.writeFileSync(d, 'D0');
    let n = 0;
    const flaky = (file, text) => {
      if (++n === 4) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    assert.throws(() => writeFilesAtomically([[c, 'C1'], [a, 'A1'], [b, 'B1'], [d, 'D1']], { write: flaky }), (err) => {
      assert.match(err.message, /write failed \(ENOSPC: disk full\); the 3 file\(s\) already written were restored/);
      assert.equal(err.restored, true);
      return true;
    });
    assert.equal(fs.readFileSync(a, 'utf8'), 'A0');
    assert.equal(fs.readFileSync(b, 'utf8'), 'B0');
    assert.equal(fs.readFileSync(d, 'utf8'), 'D0');
    assert.equal(fs.existsSync(c), false, 'a file that did not exist before is removed');
    assert.deepEqual(writeFilesAtomically([[a, 'A2'], [b, 'B2']]), [a, b]);
    assert.equal(fs.readFileSync(b, 'utf8'), 'B2');
  } finally {
    rmrf(dir);
  }
});
