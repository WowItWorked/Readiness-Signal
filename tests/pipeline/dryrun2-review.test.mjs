// Dry run 2 review (two judges): institution names in public notes and reasons, writing-rule gaps
// (advice, unintroduced events, unattributed primary-document claims, version-check questions,
// reused §10 wording), replay leakage (window.replay, fetch --now, publish --seen-out), page entries
// identified by an anchor, extra-source attribution by host, BIS reposts, the loss signal at
// stage 1, and fixed-element near-misses in calibration. FICTIONAL data, apart from the dry run's
// own wording quoted as the defect each rule targets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { feedCandidates, FUTURE_TOLERANCE_HOURS, leadDateFor } from '../../pipeline/lib/collect.mjs';
import { parseFeed } from '../../pipeline/lib/feed.mjs';
import { findInstitutions } from '../../pipeline/lib/institutions.mjs';
import { LEXICON_VERSION } from '../../pipeline/lib/lexicon.mjs';
import { runPrefilter, scoreCandidate } from '../../pipeline/lib/prefilter.mjs';
import { candidateId, fragmentIsIdentity, normaliseUrl } from '../../pipeline/lib/url.mjs';
import {
  decisionStyleIssues, findNamedInstitutionEvent, modelWordingNgrams, styleIssues, validateDecisions, validateItem,
} from '../../pipeline/lib/validate.mjs';
import { ROOT, judgment, makeCandidate, makeDraft, makeSurvivor, readJson, rmrf, runScript, tempDir, workspace, writeJson } from './_helpers.mjs';

const FILTER_MD = fs.readFileSync(path.join(ROOT, 'pipeline', 'FILTER.md'), 'utf8');
const MODELS = [...FILTER_MD.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((m) => JSON.parse(m[1])).filter((x) => x.claim)
  .map((m) => ({ ...m, update_of: m.update_of ? 'RS-261009-1000-01' : null, candidate_ids: ['c-0000000000'] }));
const [A, B, C, , E] = MODELS;
const RUN = '2026-10-02-1400';
const STARTED = '2026-10-02T14:03:12-04:00';
const NOW = '2026-10-02T14:21:40-04:00';

const style = (item) => styleIssues(item).map((s) => `${s.banned ? 'B' : 'w'} ${s.rule} ${s.field}: ${s.message}`);
const hasStyle = (item, re) => assert.ok(style(item).some((s) => re.test(s)), `expected ${re}; got:\n${style(item).join('\n')}`);
const noStyle = (item, re) => assert.ok(!style(item).some((s) => re.test(s)), `unexpected ${re}:\n${style(item).join('\n')}`);
const withInterp = (text) => ({ ...A, interpretation: [{ domain: 'fraud', text }, A.interpretation[1]] });
const dsi = (d, ctx = {}) => decisionStyleIssues(d, ctx).map((s) => `${s.banned ? 'B' : 'w'} ${s.rule} ${s.at} ${s.message}`);

// ---------------------------------------------------------------- V4 in public notes and reasons

test('V4: crypto exchanges and a market infrastructure product are in the lexicon', () => {
  for (const [t, name] of [['Bitget $388m exchange hack', 'Bitget'], ['a Huobi wallet drain', 'HTX'], ['default 3SKey connector', 'SWIFT'], ['Gate.io outage', 'Gate.io']]) {
    assert.ok(findInstitutions(t).some((m) => m.name === name), t);
  }
  assert.deepEqual(findInstitutions('a crypto exchange lost $388m; the htx file was signed'), []);
});

test('V4: a capitalised name before an institution type and an event is caught; category forms are not', () => {
  for (const [t, hit] of [
    ['S1-GAP: cnbc-finance Zentrix $388m exchange hack below stage-1 threshold', 'Zentrix $388m exchange hack'],
    ['G1 Acme Pay processor outage, no technology mechanism', 'G1 Acme Pay processor outage'],
    ["The Zentrix exchange breach exposed hot wallets", 'The Zentrix exchange breach'],
  ]) assert.equal(findNamedInstitutionEvent(t), hit, t);
  for (const t of [
    "S1-GAP: cnbc-finance a crypto exchange's $388m hack below stage-1 threshold", 'A UK bank outage lasted 9 hours', 'UK bank outage',
    'Crypto exchange hacks rose in 2026', 'European Central Bank fines', 'Azure gateway outage', 'a Hong Kong crypto exchange hack',
    'An Asian payments processor outage', 'Payments processor failures', 'Microsoft Exchange attacks', 'the Bank of England outage report',
  ]) assert.equal(findNamedInstitutionEvent(t), null, t);
});

test('V4: notes and reasons naming an institution are banned (selfcheck errors); generated fields too', () => {
  const c = makeCandidate({ url: 'https://news.example.com/a' });
  const d = {
    run_id: RUN, threshold_level: 'high', items: [],
    judgments: [judgment(c, { verdict: 'drop', reason_code: 'CS_ROUTINE_VULN', reason: 'C6: default 3SKey connector flaw patched; no exception', draft_index: null })],
    notes: 'S1-GAP: cnbc-finance Bitget $388m exchange hack below stage-1 threshold; S1-GAP: news-feed Zentrix $40m exchange hack',
  };
  const out = dsi(d).join('\n');
  assert.match(out, /B FILTER V4 decisions\.judgments\[0\].* reason: names "3SKey"/);
  assert.match(out, /B FILTER V4 decisions\.notes notes: names "Bitget"/);
  d.notes = 'S1-GAP: news-feed Zentrix $40m exchange hack';
  assert.match(dsi(d).join('\n'), /B FILTER V4 decisions\.notes notes: "Zentrix \$40m exchange hack" may name a financial institution/);
  d.notes = "S1-GAP: news-feed a crypto exchange's $40m hack";
  assert.doesNotMatch(dsi(d).join('\n'), /FILTER V4 decisions\.notes/);
  hasStyle(withInterp('The Zentrix exchange hack moved stolen funds through bridges faster than freezes could follow, so recovery assumptions fail.'), /^B FILTER V4 interpretation\[0\]\.text: "The Zentrix exchange hack" may name/);
});

// ---------------------------------------------------------------- §7.2, §7.4, §7.5 heuristics

test('7.4: "has to be" and "needs to be" are advice; an unintroduced dated event warns', () => {
  hasStyle(withInterp('Task instructions do not bound agent behaviour; limits on what an agent can reach have to be enforced by its environment.'), /w FILTER 7\.4 interpretation\[0\]\.text: advice "have to be"/);
  hasStyle(withInterp('Recovery depends on the provider, so failover needs to be tested with the management plane down across both regions.'), /advice "needs to be"/);
  noStyle(withInterp('The attacker has to hold a session token before the fallback opens, which narrows the window to sessions already phished.'), /advice/);
  hasStyle({ ...withInterp('The June cut-off came from a government directive, not a provider failure, so exit plans that assume a willing provider miss this route.') }, /"The June cut-off" relies on an event the claim does not introduce/);
  noStyle({ ...withInterp('The June cut-off came from a government directive, so exit plans that assume a willing provider miss this route.'), claim: 'A provider cut off model access in June after a directive, the ECB President says.' }, /does not introduce/);
  noStyle(withInterp('In June a directive suspended model access in Europe; the June suspension shows a jurisdictional route to losing an AI service.'), /does not introduce/);
});

test('7.2: a claim resting on one primary document needs an attribution verb; news and multi-source claims are left to the agent', () => {
  const azure = {
    ...C, update_of: null, claim: 'An Azure gateway-management fault degraded connectivity in multiple regions for 5h45m.',
    sources: [{ ...C.sources[0], source_class: 'vendor_threat_research' }],
  };
  hasStyle(azure, /w FILTER 7\.2 claim: rests on one primary document .* attribute it/);
  noStyle({ ...azure, claim: 'An Azure gateway-management fault degraded connectivity in multiple regions for 5h45m, Microsoft says.' }, /rests on one primary document/);
  noStyle({ ...azure, sources: [{ ...azure.sources[0], source_class: 'news' }], source_class: 'news' }, /rests on one primary document/);
  for (const m of MODELS) noStyle(m, /rests on one primary document/);
  noStyle({ ...azure, claim: 'A congressional committee chair asked whether lenders can explain AI-driven credit declines.' }, /rests on one primary document/);
});

test('7.5: a candidate_issue question that only checks a version is patch management', () => {
  hasStyle({ ...A, validation_question: 'Is every workstation used with hardware signing tokens free of connector hosts older than version 2.16.1.0, with a current inventory as evidence?' },
    /w FILTER 7\.5 validation_question: "older than version 2\.16\.1\.0": a check that a fixed version is installed is patch management/);
  noStyle({ ...A, mechanism: 'kri_kpi', validation_question: 'Is the share of hosts running connector releases before 2.16.1 measured, against a threshold, and reported to the head of endpoint security?' }, /patch management/);
  noStyle(A, /patch management/);
});

// ---------------------------------------------------------------- §10 wording

test('FILTER 10: generated text never reuses a worked example; the question shapes and the praf opener are shared', () => {
  const ngrams = modelWordingNgrams(FILTER_MD);
  assert.ok(ngrams.size > 1000);
  assert.equal(modelWordingNgrams('# no section ten').size, 0);
  const c = makeCandidate({ url: 'https://status.example.com/history#incident-1' });
  const item = makeDraft([c], {
    mechanism: 'kri_kpi',
    validation_question: 'Is the number of important business services whose private connectivity depends on gateways in one region pair measured, against a threshold, and reported to the operational resilience owner?',
    candidate_issue_statement: 'If no indicator tracks how many important business services rely on gateways in one cloud region pair, a fault across both regions can cut them off together.',
  });
  const d = { run_id: RUN, threshold_level: 'high', judgments: [judgment(c)], items: [item] };
  const out = dsi(d, { candidates: [c], filterText: FILTER_MD }).join('\n');
  assert.match(out, /B FILTER 10 decisions\.items\[0\] candidate_issue_statement: repeats 8\+ consecutive words of a FILTER\.md §10 worked example \("if no indicator tracks how many important business"\)/);
  assert.doesNotMatch(out, /validation_question: repeats/, 'the kri_kpi shape is shared wording');
  const praf = makeDraft([c], {
    mechanism: 'praf_coverage',
    validation_question: 'Does the risk assessment framework include a risk covering AI agents acting beyond their authorisation against third-party systems, and when was it last assessed?',
    candidate_issue_statement: 'If the risk assessment framework does not represent the risk of agents acting beyond their authorisation, intrusions launched from inside the organisation can go unassessed.',
  });
  assert.doesNotMatch(dsi({ ...d, items: [praf] }, { candidates: [c], filterText: FILTER_MD }).join('\n'), /FILTER 10/);
  assert.doesNotMatch(dsi(d, { candidates: [c] }).join('\n'), /FILTER 10/, 'without the FILTER text the check is off');
});

// ---------------------------------------------------------------- replays

test('2.7.5(e): in a replay, a source published after the window closed warns; live runs never', () => {
  const early = makeCandidate({ url: 'https://news.example.com/early', published: '2026-09-30T20:00:00.000Z', published_date: '2026-09-30' });
  const late = makeCandidate({ url: 'https://news.example.com/late', published: '2026-10-01T19:01:00.000Z', published_date: '2026-10-01' });
  const d = { run_id: RUN, threshold_level: 'high', judgments: [judgment(early), judgment(late, { dedup: 'cluster_merged', match_id: early.candidate_id, reason: `cluster member of ${early.candidate_id}` })], items: [makeDraft([early, late])] };
  const ctx = { runId: RUN, candidates: [early, late], survivorIds: [early.candidate_id, late.candidate_id], archiveItems: [], style: false };
  const until = '2026-09-30T22:51:42-04:00';
  const replay = validateDecisions(d, { ...ctx, window: { since: '2026-09-28T22:51:42-04:00', until, replay: true } });
  assert.deepEqual(replay.errors, []);
  assert.ok(replay.warnings.some((w) => /sources\[1\]: published 2026-10-01, after this replay's window closed/.test(w)), replay.warnings.join('\n'));
  assert.ok(!replay.warnings.some((w) => /sources\[0\]: published/.test(w)));
  const live = validateDecisions(d, { ...ctx, window: { since: '2026-09-28T22:51:42-04:00', until } });
  assert.ok(!live.warnings.some((w) => /window closed/.test(w)));
});

const RSS = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><link>https://news.example.com/</link>${items.map(([t, l, d, desc = '']) => `<item><title>${t}</title><link>${l}</link><pubDate>${d}</pubDate><description>${desc}</description></item>`).join('')}</channel></rss>`;

test('collect: a replay keeps nothing dated after --now; live runs keep the tolerance for event listings', () => {
  const parsed = parseFeed(RSS([
    ['Before now', 'https://news.example.com/before', 'Fri, 02 Oct 2026 12:00:00 +0000'],
    ['An hour after now', 'https://news.example.com/after', 'Fri, 02 Oct 2026 14:00:00 +0000'],
    ['Next day, date only', 'https://news.example.com/next', 'Sat, 03 Oct 2026 00:00:00 GMT'],
  ]));
  const source = { id: 'ex', publication: 'Example', source_class: 'news', region: 'US', paywalled: false };
  const window = { since: new Date('2026-10-01T00:00:00Z'), now: new Date('2026-10-02T13:00:00Z') };
  const live = feedCandidates(source, parsed, window);
  const replay = feedCandidates(source, parsed, { ...window, replay: true });
  assert.equal(FUTURE_TOLERANCE_HOURS, 24);
  assert.deepEqual(live.candidates.map((c) => c.headline), ['Before now', 'An hour after now', 'Next day, date only']);
  assert.deepEqual(replay.candidates.map((c) => c.headline), ['Before now']);
  assert.equal(replay.future_dated, 2);
});

test('collect: BIS reposts are reported with the date the lead states; the entry keeps its feed date', () => {
  assert.equal(leadDateFor({ id: 'bis-cb-speeches' }, 'Speech by a deputy governor, to an association of lawyers, Paris, 9 September 2026.'), '2026-09-09');
  assert.equal(leadDateFor({ id: 'other-feed' }, 'Remarks, Paris, 9 September 2026.'), null);
  assert.equal(leadDateFor({ id: 'bis-cb-speeches' }, 'Speech on 31 February 2026.'), null);
  const parsed = parseFeed(RSS([
    ['Artificial intelligence and risk', 'https://www.bis.org/review/r260928a.htm', 'Mon, 28 Sep 2026 00:00:00 GMT', 'Speech by a deputy governor, Paris, 9 September 2026.'],
    ['Payments resilience', 'https://www.bis.org/review/r260928b.htm', 'Mon, 28 Sep 2026 00:00:00 GMT', 'Speech by a governor, Rome, 27 September 2026.'],
  ]));
  const r = feedCandidates({ id: 'bis-cb-speeches', publication: 'Bank for International Settlements', source_class: 'regulator', region: 'INTL', paywalled: false, url: 'https://www.bis.org/doclist/cbspeeches.rss' }, parsed,
    { since: new Date('2026-09-27T00:00:00Z'), now: new Date('2026-09-28T18:00:00Z') });
  assert.equal(r.candidates.length, 2, 'both stay in the window');
  assert.equal(r.reposted, 1, 'a 1-day lag is not a repost');
  assert.match(r.repost_samples[0], /stated 2026-09-09, feed 2026-09-28/);
});

test('fetch.mjs --now marks the window as a replay; publish.mjs --dry-run --seen-out writes the chained seen file only', async () => {
  const c = makeCandidate({ url: 'https://news.example.com/judged', headline: 'Gateway flaw exploited against several sectors' });
  const ws = workspace({
    runId: RUN, candidates: [c], survivors: [makeSurvivor(c)], startedAt: STARTED,
    decisions: { run_id: RUN, threshold_level: 'high', judgments: [judgment(c, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'C1 nothing specific changed', draft_index: null })], items: [] },
  });
  try {
    const out = path.join(ws.dir, 'scratch', 'seen-after-run1.json');
    const seenBefore = fs.readFileSync(ws.seen, 'utf8');
    const r = runScript('publish', ['--run', RUN, '--now', NOW, '--dry-run', '--seen-out', out, ...ws.flags]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.seen_out, out);
    assert.equal(readJson(out).urls[normaliseUrl(c.url)].verdict, 'dropped');
    assert.equal(fs.readFileSync(ws.seen, 'utf8'), seenBefore, 'seen.json untouched');
    assert.deepEqual(r.json.dedup_dropped_split, { same_story: 0, cluster_members: 0 });
    assert.match(r.stderr, /dedup dropped 0 \(same story 0, cluster members 0\)/);
    const noDry = runScript('publish', ['--run', RUN, '--now', NOW, '--seen-out', out, ...ws.flags]);
    assert.equal(noDry.status, 2);
    assert.match(noDry.stderr, /--seen-out is only for --dry-run/);
    const over = runScript('publish', ['--run', RUN, '--now', NOW, '--dry-run', '--seen-out', ws.seen, ...ws.flags]);
    assert.equal(over.status, 2);
    assert.match(over.stderr, /never over seen\.json/);
    const intoState = runScript('publish', ['--run', RUN, '--now', NOW, '--dry-run', '--seen-out', path.join(ROOT, 'pipeline', 'state', 'replay.json'), ...ws.flags]);
    assert.equal(intoState.status, 2);
    assert.ok(!fs.existsSync(path.join(ROOT, 'pipeline', 'state', 'replay.json')));
  } finally {
    rmrf(ws.dir);
  }
});

test('2.9: news order follows the registry tier where known; unknown tiers keep the guess, worded as one', () => {
  const pub = makeCandidate({ url: 'https://wire.example.com/a', source_class: 'vendor_threat_research' });
  const paper = makeCandidate({ url: 'https://paper.example.com/b', paywalled: true, tier: 'general' });
  const trade = makeCandidate({ url: 'https://trade.example.com/c', tier: 'trade' });
  const daily = makeCandidate({ url: 'https://daily.example.com/d', tier: 'general' });
  const run = (order) => {
    const d = { run_id: RUN, threshold_level: 'high', judgments: [], items: [makeDraft(order, { source_class: 'vendor_threat_research' })] };
    return dsi(d, { candidates: [pub, paper, trade, daily] }).filter((s) => /FILTER 2\.9/.test(s));
  };
  assert.deepEqual(run([pub, paper, trade]), [], 'paywalled general press before public trade press is the §2.9 order');
  assert.match(run([pub, trade, daily]).join('\n'), /sources\[2\]: general or business press listed after trade press sources\[1\]/);
  assert.match(run([pub, paper, daily]).join('\n'), /sources\[2\]: public general press listed after paywalled general press sources\[1\]/);
  const untiered = [pub, { ...paper, tier: undefined }, { ...trade, tier: undefined }];
  const d = { run_id: RUN, threshold_level: 'high', judgments: [], items: [makeDraft(untiered, { source_class: 'vendor_threat_research' })] };
  assert.match(dsi(d, { candidates: untiered }).join('\n'), /w FILTER 2\.9 .*public news source listed after paywalled sources\[1\].*tier unknown/);
});

test('sources.json: an optional news tier is validated and carried onto candidates', async () => {
  const { validateSources } = await import('../../pipeline/lib/sources.mjs');
  const base = { id: 'a', publication: 'A', source_class: 'news', type: 'feed', url: 'https://a.example.com/f', paywalled: false, region: 'US', notes: '' };
  assert.deepEqual(validateSources({ schema_version: 1, sources: [{ ...base, tier: 'general' }] }), { errors: [], warnings: [] });
  assert.match(validateSources({ schema_version: 1, sources: [{ ...base, tier: 'national' }] }).errors.join('\n'), /tier: must be one of general, trade/);
  assert.match(validateSources({ schema_version: 1, sources: [{ ...base, source_class: 'regulator', tier: 'trade' }] }).warnings.join('\n'), /only news sources have a tier/);
  const parsed = parseFeed(RSS([['Gateway outage', 'https://a.example.com/x', 'Fri, 02 Oct 2026 12:00:00 +0000']]));
  const r = feedCandidates({ ...base, tier: 'general' }, parsed, { since: new Date('2026-10-01T00:00:00Z'), now: new Date('2026-10-02T18:00:00Z') });
  assert.equal(r.candidates[0].tier, 'general');
  assert.equal(feedCandidates(base, parsed, { since: new Date('2026-10-01T00:00:00Z'), now: new Date('2026-10-02T18:00:00Z') }).candidates[0].tier, undefined);
});

// ---------------------------------------------------------------- page entries with an anchor

test('url: the Azure status history anchor is the entry identity; other fragments are still dropped', () => {
  const a = 'https://azure.status.microsoft/en-us/status/history/#incident-history-collapse-7Q30-010';
  const b = 'https://azure.status.microsoft/en-us/status/history/#incident-history-collapse-7QL5-Z50';
  assert.equal(normaliseUrl(a), 'https://azure.status.microsoft/en-us/status/history#incident-history-collapse-7Q30-010');
  assert.notEqual(candidateId(a), candidateId(b));
  assert.equal(fragmentIsIdentity(a), true);
  assert.equal(normaliseUrl('https://azure.status.microsoft/en-us/status/history/#history-section'), 'https://azure.status.microsoft/en-us/status/history');
  assert.equal(normaliseUrl('https://news.example.com/story/#comments'), 'https://news.example.com/story');
  assert.equal(normaliseUrl('https://www.example.com/status/history/#incident-history-collapse-1'), 'https://www.example.com/status/history');
  // a source cited with its anchor matches its candidate; the bare listing does not
  const cand = makeCandidate({ url: a, source_class: 'vendor_threat_research', publication: 'Microsoft Azure' });
  const d = { run_id: RUN, threshold_level: 'high', judgments: [judgment(cand)], items: [makeDraft([cand], { source_class: 'vendor_threat_research' })] };
  const ctx = { runId: RUN, candidates: [cand], survivorIds: [cand.candidate_id], archiveItems: [], style: false };
  assert.deepEqual(validateDecisions(d, ctx).errors, []);
  d.items[0].sources[0].url = 'https://azure.status.microsoft/en-us/status/history/';
  assert.ok(validateDecisions(d, ctx).errors.some((e) => /not the URL of any candidate/.test(e)));
});

// ---------------------------------------------------------------- stage 1 and calibration

test('stage 1: a hack with a stated loss is strong in a headline, so the strict profile admits it', () => {
  assert.equal(LEXICON_VERSION, '2026-10-02.5');
  const c = makeCandidate({ url: 'https://news.example.com/exchange-hack', headline: "Zentrix 'not expecting to recover a lot' from $388 million hack, CEO says" });
  const s = scoreCandidate(c, 'strict');
  assert.equal(s.strong_in_title, true);
  assert.ok(s.matched.materiality.some((m) => /^loss: /.test(m)), JSON.stringify(s.matched));
  const r = runPrefilter([c], { sources: new Map([['example-news', { id: 'example-news', prefilter: 'strict' }]]) });
  assert.equal(r.survivors.length, 1, JSON.stringify(r.dropped));
  for (const h of ["Scoop: a model developer's annual recurring revenue nears $70B", 'An AI firm president backs out of a pledged $25 million donation']) {
    assert.ok(!scoreCandidate({ headline: h, lead: '' }, 'strict').strong_in_title, h);
  }
});

test('calibration.mjs: stories near each fixed element are reported as prominently as knob near-misses', () => {
  const cands = ['a', 'b', 'c', 'd'].map((x) => makeCandidate({ url: `https://news.example.com/${x}`, headline: `Story ${x}` }));
  const reasons = ['NEAR C5: technique public since July', 'NEAR C5: tooling documented in 2025', 'NEAR R3: restates an earlier warning', 'NEAR C5/cs_novelty_window_days: first disclosed 71 days earlier'];
  const codes = ['CS_NOT_NEW', 'CS_NOT_NEW', 'RT_NO_DIRECTION', 'CS_NOT_NEW'];
  const ws = workspace({
    runId: RUN, candidates: cands, survivors: cands.map((c) => makeSurvivor(c)), startedAt: '2026-10-02T14:03:00-04:00',
    decisions: {
      run_id: RUN, threshold_level: 'high', items: [],
      judgments: cands.map((c, i) => judgment(c, { verdict: 'drop', reason_code: codes[i], section_tested: codes[i].startsWith('RT') ? 'regulatory_trajectory' : 'capability_shift', reason: reasons[i], draft_index: null })),
    },
  });
  try {
    const flags = ws.flags.map((x, i) => (ws.flags[i - 1] === '--filter' ? path.join(ROOT, 'pipeline', 'FILTER.md') : x));
    const p = runScript('publish', ['--run', RUN, '--now', '2026-10-02T14:20:00-04:00', ...flags]);
    assert.equal(p.status, 0, p.stderr);
    const r = runScript('calibration', ['--json', '--runs', ws.runs, '--logs-dir', ws.logs, '--archive', ws.archive, '--thresholds', path.join(ws.dir, 'none.json'), '--now', '2026-10-03T00:00:00-04:00']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.near_misses_fixed_elements, { C5: 2, R3: 1 });
    assert.deepEqual(r.json.near_misses_by_knob, { cs_novelty_window_days: 1 });
    assert.match(r.stderr, /Stories near each fixed element \(NEAR without a knob; FILTER 9\.6 fixed-element route\)/);
    assert.match(r.stderr, /dedup dropped\s+0 {2}\(same story 0, cluster members 0, from the logs\)/);
  } finally {
    rmrf(ws.dir);
  }
});

// ---------------------------------------------------------------- corpora stay clean

test('no new rule fires on FILTER §10.2 model items (warnings included) or model B rewritten for its own story', () => {
  for (const m of MODELS) {
    const r = validateItem(m, { mode: 'draft' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(styleIssues(m), [], m.claim);
  }
  assert.ok(B && E);
});
