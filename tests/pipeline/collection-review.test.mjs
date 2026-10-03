// Review round: GL_NOT_JUDGED candidates are re-collected (not marked seen), URL normalisation
// (tracking parameters, duplicate slashes), selfcheck "source:" notes, calibration "[M#] NEAR",
// CISA KEV catalogue URLs, stage-1 recall (service outages, "state-sponsored", primary and
// authority profiles) and EIOPA URL dating. FICTIONAL data except the real dry-run URLs in the
// normalisation test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { feedCandidates, kevCandidates, kevCatalogueUrl, urlDateFor } from '../../pipeline/lib/collect.mjs';
import { CLASS_PROFILE, PROFILES } from '../../pipeline/lib/lexicon.mjs';
import { outrightDrop, profileFor, runPrefilter, scoreCandidate } from '../../pipeline/lib/prefilter.mjs';
import { updateSeen } from '../../pipeline/lib/publish.mjs';
import { PREFILTER_PROFILES } from '../../pipeline/lib/sources.mjs';
import { candidateId, disallowedSourceReason, isTrackingParam, normaliseUrl, trackingParams } from '../../pipeline/lib/url.mjs';
import { judgment, makeCandidate, makeDraft, makeSurvivor, readJson, rmrf, runScript, tempDir, workspace, writeJson } from './_helpers.mjs';

const RUN = '2026-10-02-1400';
const STARTED = '2026-10-02T14:03:12-04:00';
const NOW = '2026-10-02T14:21:40-04:00';

// ---------------------------------------------------------------- 1. GL_NOT_JUDGED

test('1: updateSeen leaves GL_NOT_JUDGED survivors out of seen.json so the next run re-collects them', () => {
  const judged = makeCandidate({ url: 'https://news.example.com/judged' });
  const late = makeCandidate({ url: 'https://news.example.com/late' });
  const r = updateSeen({ schema_version: 1, urls: {} }, {
    runId: RUN, firstSeen: STARTED, now: new Date(NOW), survivors: [judged, late],
    judgments: [
      judgment(judged, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'C1 nothing changed', draft_index: null }),
      judgment(late, { verdict: 'drop', section_tested: null, reason_code: 'GL_NOT_JUDGED', reason: 'time budget: not judged', draft_index: null }),
    ],
    draftItems: [], candidatesById: new Map(), itemIdByDraftIndex: new Map(),
  });
  assert.equal(r.added, 1);
  assert.ok(r.doc.urls[normaliseUrl(judged.url)]);
  assert.equal(r.doc.urls[normaliseUrl(late.url)], undefined);
});

test('1: publish.mjs end to end: a GL_NOT_JUDGED survivor is logged but not marked seen', () => {
  const a = makeCandidate({ url: 'https://news.example.com/gateway', headline: 'Gateway zero-day exploited against several sectors' });
  const b = makeCandidate({ url: 'https://news.example.com/unjudged', headline: 'Late story' });
  const ws = workspace({
    runId: RUN,
    candidates: [a, b],
    survivors: [makeSurvivor(a), makeSurvivor(b)],
    decisions: {
      run_id: RUN, threshold_level: 'high',
      judgments: [judgment(a), judgment(b, { verdict: 'drop', section_tested: null, reason_code: 'GL_NOT_JUDGED', reason: 'time budget: not judged', draft_index: null })],
      items: [makeDraft([a])],
      notes: 'budget: 1 not judged',
    },
    startedAt: STARTED,
  });
  try {
    const r = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
    assert.equal(r.status, 0, r.stderr);
    const seen = readJson(ws.seen).urls;
    assert.equal(seen[normaliseUrl(a.url)].verdict, 'published');
    assert.equal(seen[normaliseUrl(b.url)], undefined);
  } finally {
    rmrf(ws.dir);
  }
});

// ---------------------------------------------------------------- 3. URL normalisation

test('3: tracking parameters are stripped conservatively; duplicate slashes collapse (real dry-run URLs)', () => {
  // ECB and ESRB feeds emit "//" after the host; the FT feed adds a syndication token.
  assert.equal(normaliseUrl('https://www.ecb.europa.eu//press/key/date/2026/html/ecb.sp261001~cf3c630379.en.html'), 'https://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp261001~cf3c630379.en.html');
  assert.equal(normaliseUrl('https://www.esrb.europa.eu//news/speeches/date/2026/html/esrb.sp261001~0eb8b60ef2.en.html'), 'https://www.esrb.europa.eu/news/speeches/date/2026/html/esrb.sp261001~0eb8b60ef2.en.html');
  assert.equal(normaliseUrl('https://www.ft.com/content/11502a49-5319-4df5-95ea-2d76669c31a6?syn-25a6b1a6=1'), 'https://www.ft.com/content/11502a49-5319-4df5-95ea-2d76669c31a6');
  assert.equal(candidateId('https://www.ecb.europa.eu//press/x.en.html'), candidateId('https://www.ecb.europa.eu/press/x.en.html'));
  // always tracking
  assert.equal(normaliseUrl('https://news.example.com/a?ref=rss&cmpid=x1&ito=792&sr_share=twitter&CMP=Share_iOSApp_Other&smid=nytcore-ios-share&partner=rss&id=7'), 'https://news.example.com/a?id=7');
  // mod: Dow Jones placement tokens only
  assert.equal(normaliseUrl('https://www.wsj.com/tech/cyber-flaw-1234?mod=rss_Technology'), 'https://www.wsj.com/tech/cyber-flaw-1234');
  assert.equal(normaliseUrl('https://www.wsj.com/tech/cyber-flaw-1234?mod=hp_lead_pos1'), 'https://www.wsj.com/tech/cyber-flaw-1234');
  assert.equal(normaliseUrl('https://www.wsj.com/tech/cyber-flaw-1234?mod=djemalertNEWS'), 'https://www.wsj.com/tech/cyber-flaw-1234');
  assert.equal(normaliseUrl('https://cms.example.org/index.php?mod=news&id=5'), 'https://cms.example.org/index.php?mod=news&id=5');
  // ref names a branch on code hosts
  assert.equal(normaliseUrl('https://github.com/example/repo/security/advisories?ref=main'), 'https://github.com/example/repo/security/advisories?ref=main');
  // content parameters survive: the CISA KEV catalogue search
  assert.equal(normaliseUrl('https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-90001'), 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-90001');
  assert.equal(normaliseUrl('https://www.example.com/search?q=gateway&page=2'), 'https://www.example.com/search?q=gateway&page=2');
  assert.equal(isTrackingParam('syn-25a6b1a6', '1'), true);
  assert.equal(isTrackingParam('abc-12', '1'), false, 'too short to be a token');
  assert.equal(isTrackingParam('Syn-25A6B1A6', '1'), false, 'lower-case word and hex only');
  assert.deepEqual(trackingParams('https://www.ft.com/content/x?syn-25a6b1a6=1&page=2'), ['syn-25a6b1a6']);
  assert.deepEqual(trackingParams('not a url'), []);
});

test('3/2e: mailing-list wrappers and redirectors are never sources', () => {
  for (const u of ['https://content.govdelivery.com/accounts/USTREAS/bulletins/3f1a2b', 'https://lnks.gd/l/eyJhbGciOi', 'https://news.google.com/rss/articles/CBMi',
    'https://l.facebook.com/l.php?u=https%3A%2F%2Fnews.example.com', 'https://t.co/abc', 'https://lnkd.in/abc', 'https://www-example-com.cdn.ampproject.org/c/s/www.example.com/x',
    'https://web.archive.org/web/2026/https://news.example.com/x', 'https://archive.today/abc', 'https://nam02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fx.example.com']) {
    assert.ok(disallowedSourceReason(u), u);
  }
});

// ---------------------------------------------------------------- 4. selfcheck notes, calibration NEAR

test('4: selfcheck accepts "source:" notes; calibration counts "[M#] NEAR" reasons', () => {
  const a = makeCandidate({ url: 'https://news.example.com/gateway', headline: 'Gateway zero-day exploited against several sectors' });
  const ws = workspace({
    runId: RUN,
    candidates: [a],
    survivors: [makeSurvivor(a)],
    decisions: { run_id: RUN, threshold_level: 'high', judgments: [judgment(a)], items: [makeDraft([a])], notes: 'source: eiopa-news re-dates old documents in its feed; odd note' },
    startedAt: STARTED,
  });
  try {
    const s = runScript('selfcheck', ['--run', RUN, '--work-dir', ws.work, '--archive', ws.archive, '--thresholds', path.join(ws.dir, 'thresholds.json'), '--filter', ws.flags[ws.flags.indexOf('--filter') + 1]]);
    assert.equal(s.status, 0, s.stderr);
    assert.doesNotMatch(s.stderr, /"source: eiopa-news/);
    assert.match(s.stderr, /"odd note" does not start with a FILTER 9\.1 prefix/);
  } finally {
    rmrf(ws.dir);
  }
  const dir = tempDir();
  try {
    const runs = path.join(dir, 'runs.json');
    const logs = path.join(dir, 'logs');
    writeJson(runs, { schema_version: 1, runs: [{ run_id: RUN, slot: '2026-10-02T14:00:00-04:00', status: 'silent', items: [], funnel: { stage1_pass: 4 } }] });
    const row = (reason, extra = {}) => JSON.stringify({ run_id: RUN, candidate_id: 'c-0000000000', publication: 'Example News', section_tested: 'executive_visibility', verdict: 'drop', reason_code: 'EV_NO_PROMINENCE', reason, dedup: 'new', ...extra });
    const file = path.join(logs, '2026', '10', `${RUN}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${[
      row('[M3] NEAR E3/ev_min_general_outlets: 1 general outlet (wire) plus trade press', { dedup: 'material_update', match_id: 'RS-261001-1000-01' }),
      row('NEAR E3/ev_min_general_outlets: trade press only [alt CS:C1]'),
      row('NEAR E3/ev_min_general_outlets: cluster member', { dedup: 'cluster_merged' }),
      row('E3 trade press only; not NEAR'),
    ].join('\n')}\n`);
    const r = runScript('calibration', ['--json', '--runs', runs, '--logs-dir', logs, '--archive', path.join(dir, 'none.json'), '--thresholds', path.join(dir, 'none.json'), '--now', '2026-10-03T00:00:00-04:00']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.near_misses, { 'E3/ev_min_general_outlets': 2 });
  } finally {
    rmrf(dir);
  }
});

// ---------------------------------------------------------------- 5. CISA KEV

test('5: KEV candidates link to the CISA catalogue entry, keep publication CISA and mark the headline composed', () => {
  const source = { id: 'cisa-kev', publication: 'CISA Known Exploited Vulnerabilities Catalog', source_class: 'vendor_threat_research', region: 'US', paywalled: false, type: 'cisa-kev' };
  const json = { vulnerabilities: [{ cveID: 'CVE-2026-90001', vendorProject: 'Meari', product: 'IoT Cloud Platform', vulnerabilityName: 'Meari IoT Cloud Platform Missing Authentication', dateAdded: '2026-10-01', shortDescription: 'Missing authentication.', knownRansomwareCampaignUse: 'Known' }] };
  const { candidates: [c] } = kevCandidates(source, json, { since: new Date('2026-09-30T00:00:00Z'), now: new Date('2026-10-02T18:00:00Z') });
  assert.equal(c.url, 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-90001');
  assert.equal(c.url, kevCatalogueUrl('CVE-2026-90001'));
  assert.equal(c.url_normalised, c.url);
  assert.equal(c.publication, 'CISA');
  assert.equal(c.source_class, 'vendor_threat_research');
  assert.equal(c.headline_composed, true);
  // stage 1: a composed "... Cloud Platform ..." headline is not a product launch; survivors carry the flag
  assert.equal(outrightDrop({ ...c, seen: false }, profileFor(c, source)), null);
  const r = runPrefilter([{ ...c, seen: false }], { sources: new Map([[source.id, source]]) });
  assert.equal(r.survivors.length, 1, JSON.stringify(r.dropped));
  assert.equal(r.survivors[0].headline_composed, true);
});

test('5: publish.mjs publishes a KEV source without a headline and refuses its composed headline', () => {
  const kev = makeCandidate({ url: kevCatalogueUrl('CVE-2026-90001'), publication: 'CISA', source_class: 'vendor_threat_research', source_id: 'cisa-kev',
    headline: 'CISA KEV adds CVE-2026-90001: Example Gateway — Example Gateway Path Traversal Vulnerability', headline_composed: true, kev: { cve: 'CVE-2026-90001' } });
  const news = makeCandidate({ url: 'https://news.example.com/gateway', headline: 'Gateway zero-day exploited against several sectors' });
  const decisions = (withHeadline) => {
    const draft = makeDraft([kev, news], { source_class: 'vendor_threat_research' });
    if (!withHeadline) delete draft.sources[0].headline;
    return { run_id: RUN, threshold_level: 'high', judgments: [judgment(kev), judgment(news, { dedup: 'cluster_merged', match_id: kev.candidate_id, reason: `cluster member of ${kev.candidate_id}` })], items: [draft] };
  };
  for (const withHeadline of [true, false]) {
    const ws = workspace({ runId: RUN, candidates: [kev, news], survivors: [makeSurvivor(kev), makeSurvivor(news)], decisions: decisions(withHeadline), startedAt: STARTED });
    try {
      const r = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
      if (withHeadline) {
        assert.equal(r.status, 1);
        assert.match(r.stderr, /sources\[0\]\.headline: .*composed by the collector/);
        continue;
      }
      assert.equal(r.status, 0, r.stderr);
      const [item] = readJson(ws.archive).items;
      assert.deepEqual(Object.keys(item.sources[0]).sort(), ['published', 'publication', 'source_class', 'url'].sort());
      assert.equal(item.sources[0].url, 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-90001');
      assert.equal(item.sources[1].headline, news.headline);
    } finally {
      rmrf(ws.dir);
    }
  }
});

// ---------------------------------------------------------------- 6. stage 1 recall

const PIR = { url: 'https://azure.status.microsoft/en-us/status/history/?trackingId=7Q30-010', source_id: 'azure-post-incident-reviews', publication: 'Microsoft Azure Status History (Post Incident Reviews)', source_class: 'vendor_threat_research',
  headline: 'Mitigated- Multiple services experiencing connectivity issues in multiple regions',
  lead: 'Between 20:30 UTC on 30 September 2026 and 02:15 UTC on 01 October 2026, a subset of customers using gateway services in multiple regions experienced degraded or interrupted network connectivity.' };

test('6: profiles: primary sources pass on less evidence than secondary news', () => {
  assert.ok(PROFILES.lenient.threshold < PROFILES.standard.threshold);
  assert.ok(PROFILES.authority.threshold < PROFILES.standard.threshold);
  assert.ok(PROFILES.primary.threshold < PROFILES.standard.threshold);
  assert.equal(CLASS_PROFILE.vendor_threat_research, 'primary');
  assert.equal(CLASS_PROFILE.regulator, 'lenient');
  assert.equal(CLASS_PROFILE.standards_body, 'lenient');
  assert.equal(CLASS_PROFILE.news, 'standard');
  for (const p of Object.keys(PROFILES)) assert.ok(PREFILTER_PROFILES.includes(p), p);
  const vtr = (url) => makeCandidate({ url, source_class: 'vendor_threat_research' });
  assert.equal(profileFor(vtr('https://www.cisa.gov/news-events/alerts/2026/10/01/x')), 'authority');
  assert.equal(profileFor(vtr('https://www.ncsc.gov.uk/news/x')), 'authority');
  assert.equal(profileFor(vtr('https://cert.europa.eu/publications/security-advisories/2026-101')), 'authority');
  assert.equal(profileFor(vtr('https://www.cisa.gov/news-events/ics-advisories/icsa-26-274-01')), 'standard', 'ICS product advisories');
  assert.equal(profileFor(vtr('https://www.microsoft.com/en-us/security/blog/2026/10/01/x/')), 'primary');
  assert.equal(profileFor(makeCandidate({ url: 'https://www.cisa.gov/news/x', source_class: 'news' })), 'standard');
  assert.equal(profileFor(vtr('https://www.cisa.gov/x'), { prefilter: 'standard' }), 'standard', 'the registry override wins');
});

test('6: a multi-region cloud outage post-incident report passes stage 1; the same text from secondary news needs more', () => {
  const pir = makeCandidate(PIR);
  const r = runPrefilter([pir]);
  assert.equal(r.survivors.length, 1, JSON.stringify(r.dropped));
  assert.ok(r.survivors[0].domains.includes('resilience'));
  assert.equal(r.survivors[0].profile, 'primary');
  const s = scoreCandidate(pir, 'primary');
  assert.ok(s.matched.resilience.some((t) => /multiple regions|connectivity/.test(t)), JSON.stringify(s.matched));
  const asNews = makeCandidate({ ...PIR, url: 'https://news.example.com/cloud-connectivity', source_class: 'news', source_id: 'example-news' });
  assert.equal(runPrefilter([asNews]).survivors.length, 0, 'a vague status line from a news feed stays below the news threshold');
  // a post-incident review with its root cause scores the post_incident materiality group
  const final = makeCandidate({ ...PIR, url: 'https://azure.status.microsoft/en-us/status/history/?trackingId=7Q30-011', headline: 'Post Incident Review (PIR) - Azure Front Door - connectivity issues across multiple regions', lead: 'Root cause: a configuration change propagated to edge sites in multiple regions.' });
  assert.ok(scoreCandidate(final, 'primary').matched.materiality.some((m) => /post_incident/.test(m)));
});

test('6: "state-sponsored" in a lead is not sponsored content; sponsored labels still are', () => {
  const cyberscoop = makeCandidate({ url: 'https://cyberscoop.com/citrix-netscaler-zero-day-attacks-three-weeks-undetected/', headline: 'Attackers exploited Citrix NetScaler zero-day for at least three weeks undetected',
    lead: 'Mandiant researchers said dozens of organizations have been impacted by attacks attributed to advanced and suspected state-sponsored threat groups. They expect more attacks to come.' });
  assert.equal(outrightDrop(cyberscoop, 'standard'), null);
  assert.equal(runPrefilter([cyberscoop]).survivors.length, 1);
  for (const [headline, lead] of [['Five ways to harden payment APIs', 'Sponsored content from Example Vendor.'], ['Sponsored: Five ways to harden payment APIs', ''],
    ['Five ways to harden payment APIs (Sponsored)', ''], ['Partner content: zero trust for lenders', '']]) {
    assert.equal(outrightDrop(makeCandidate({ url: 'https://news.example.com/s', headline, lead }), 'standard')?.reason, 'marketing', `${headline} | ${lead}`);
  }
  for (const headline of ['State sponsored hackers breach telecom carriers', 'Senate passes bill sponsored by Sen. Example on data brokers']) {
    assert.notEqual(outrightDrop(makeCandidate({ url: 'https://news.example.com/t', headline }), 'standard')?.detail, 'sponsored', headline);
  }
});

test('6: EIOPA entries are dated from the URL (-YYYY-MM-DD_en), so re-dated old documents fall out of the window', () => {
  const source = { id: 'eiopa-news', publication: 'EIOPA – News', source_class: 'regulator', region: 'EU', paywalled: false, url: 'https://www.eiopa.europa.eu/node/4816/rss_en' };
  const other = { id: 'example-news', publication: 'Example News', source_class: 'news', region: 'US', paywalled: false, url: 'https://news.example.com/feed' };
  const old = 'https://www.eiopa.europa.eu/eiopa-insurance-risk-dashboard-shows-broadly-stable-risk-environment-even-cyber-and-geopolitical-2026-07-30_en';
  const fresh = 'https://www.eiopa.europa.eu/eiopa-names-extreme-heat-key-climate-related-risk-life-and-health-insurers-and-pension-providers-2026-09-30_en';
  assert.equal(urlDateFor(source, old), '2026-07-30');
  assert.equal(urlDateFor(source, 'https://www.eiopa.europa.eu/publications/undated-page_en'), null);
  assert.equal(urlDateFor(source, 'https://www.eiopa.europa.eu/x-2026-02-31_en'), null, 'not a calendar date');
  assert.equal(urlDateFor(other, 'https://news.example.com/x-2026-07-30_en'), null, 'other sources keep the feed date');
  const parsed = { entries: [
    { title: 'Risk dashboard (re-dated by the feed)', link: old, published: '2026-10-02T08:00:00.000Z', date_only: null, date_status: 'ok', lead: '' },
    { title: 'Extreme heat risk', link: fresh, published: '2026-10-02T08:00:00.000Z', date_only: null, date_status: 'ok', lead: '' },
    { title: 'Undated-URL news', link: 'https://www.eiopa.europa.eu/news-item_en', published: '2026-10-02T08:00:00.000Z', date_only: null, date_status: 'ok', lead: '' },
  ] };
  const r = feedCandidates(source, parsed, { since: new Date('2026-09-29T17:00:00Z'), now: new Date('2026-10-02T18:00:00Z') });
  assert.deepEqual(r.candidates.map((c) => c.headline), ['Extreme heat risk', 'Undated-URL news']);
  assert.equal(r.candidates[0].published_date, '2026-09-30');
  assert.equal(r.url_dated, 2);
  assert.equal(r.redated, 2);
});
