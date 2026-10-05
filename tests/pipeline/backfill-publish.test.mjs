// backfill.mjs add and publish end to end in temp dirs (BACKFILL.md §4-§6): ids and timestamps,
// append-only, runs.json and seen.json untouched, the audit log, BF codes, section restriction,
// live URL checks at publish, second-publish refusal and --append-missing, dry run, references,
// as-of-date dedup, paywalled primaries, unjudged candidates, AO3 inside a pass, KEV sources.
// publish checks URLs live: the CLI runs with a fetch mock preloaded (fixtures/backfill-mock-fetch.mjs)
// that serves the FICTIONAL pages below. All data is FICTIONAL (example.* domains).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { monthWindow, windowDoc } from '../../pipeline/lib/backfill.mjs';
import { USER_AGENT } from '../../pipeline/lib/collect.mjs';
import { KEV_URL } from '../../pipeline/lib/sources.mjs';
import { normaliseUrl } from '../../pipeline/lib/url.mjs';
import { etDateString, isEtIso } from '../../pipeline/lib/time.mjs';
import { FILTER_FIXTURE, FIXTURES, ROOT, SCRIPTS, fixture, judgment, makeCandidate, makeDraft, readJson, rmrf, runScript, tempDir, writeJson } from './_helpers.mjs';

const W = monthWindow('2026-01');
const NOW = '2026-10-04T12:00:00-04:00';
// a preflight verify-urls time safely in the past of any test run (publish re-checks live anyway)
const CHECKED = '2026-02-03T11:00:00-05:00';
const MOCK = pathToFileURL(path.join(FIXTURES, 'backfill-mock-fetch.mjs')).href;

const onDate = (date) => ({ published: new Date(`${date}T05:00:00.000Z`).toISOString(), published_date: date, published_precision: 'date' });
const atTime = (iso) => ({ published: new Date(iso).toISOString(), published_date: etDateString(new Date(iso)), published_precision: 'time' });
const bc = (url, when, o = {}) => makeCandidate({ url, discovery_mode: 'search', outside_window: false, ...when, ...o });

/** The fictional page a candidate's URL serves: 200 HTML with its headline. */
const page = (c, o = {}) => ({ status: 200, type: 'text/html; charset=utf-8', body: `<!doctype html><html><head><title>${c.headline} | ${c.publication}</title></head><body><main><h1>${c.headline}</h1><p>${c.lead || 'Fictional body text.'}</p></main></body></html>`, ...o });
const routesFor = (cands, skip = []) => Object.fromEntries(cands.filter((c) => !skip.includes(c)).map((c) => [c.url, page(c)]));

function scenario() {
  const csA = bc('https://research.example.com/2026/01/token-replay', onDate('2026-01-05'), {
    publication: 'Example Research', source_class: 'vendor_threat_research',
    headline: 'Token replay campaign hits edge appliances', lead: 'Researchers saw stolen session tokens replayed against edge appliances in several sectors.',
  });
  const rtB = bc('https://agency.example.gov/rules/2026-01-05-resilience', onDate('2026-01-05'), {
    publication: 'Example Agency', source_class: 'regulator', headline: 'Final rule on operational resilience testing', lead: 'The agency adopted a final rule.',
  });
  const csC = bc('https://research.example.com/2026/01/push-fatigue', atTime('2026-01-12T09:30:00-05:00'), {
    publication: 'Example Research', source_class: 'vendor_threat_research', headline: 'Push-fatigue kits now automate approval prompts', lead: 'A kit sold on criminal forums automates push approval prompts.',
  });
  const csC2 = bc('https://news.example.com/2026/02/push-fatigue-follow-up', onDate('2026-02-10'), {
    publication: 'Example News', source_class: 'news', outside_window: true, headline: 'Push-fatigue kits spread', lead: 'Follow-up coverage.',
  });
  const dropD = bc('https://news.example.com/2026/01/minor-patch', onDate('2026-01-08'), { headline: 'Vendor ships a minor patch' });
  const exE = bc('https://news.example.com/2026/01/payments-outage', onDate('2026-01-09'), { headline: 'Payments outage disrupts card transactions' });
  const outF = bc('https://news.example.com/2026/01/late-night', atTime('2026-02-01T00:30:00-05:00'), { headline: 'Disclosure just after midnight' });
  const goneH = bc('https://news.example.com/2026/01/gone', onDate('2026-01-14'), { headline: 'A story whose page is gone' });
  const unG = bc('https://agency.example.gov/speeches/2026-01-20', onDate('2026-01-20'), { publication: 'Example Agency', source_class: 'regulator', headline: 'Speech on supervision' });
  const candidates = [csA, rtB, csC, csC2, dropD, exE, outF, goneH, unG];
  const items = [
    makeDraft([csA]),
    makeDraft([rtB], {
      section: 'regulatory_trajectory',
      claim: 'An agency adopted a rule requiring annual recovery tests of critical operations.',
      domains: ['resilience'],
      source_class: 'regulator',
      mechanism: 'awareness_only',
      interpretation: [{ domain: 'resilience', text: 'Recovery testing against severe scenarios moves from supervisory expectation to a stated legal obligation for covered firms.' }],
      validation_question: null,
      candidate_issue_statement: null,
      awareness_rationale: 'The rule applies only to covered firms under that agency, and its testing duty takes effect later, so no control, metric or framework change follows from the adoption itself.',
    }),
    makeDraft([csC, csC2], {
      claim: 'Criminal kits now automate push-approval prompts to defeat app-based MFA, researchers report.',
      domains: ['cyber', 'fraud'],
      interpretation: [
        { domain: 'cyber', text: 'Push approval is no longer a strong second factor where prompts can be generated at volume without rate limits.' },
        { domain: 'fraud', text: 'Account takeover through repeated prompts shifts losses toward channels that trust an approved login session.' },
      ],
      validation_question: 'Does the organisation limit or block repeated push-approval prompts for a single account within a short period?',
      candidate_issue_statement: 'Where push-approval prompts are not rate limited, automated prompt floods could lead to account takeover and fraudulent transactions.',
    }),
  ];
  const decisions = {
    run_id: 'backfill-2026-01',
    threshold_level: 'high',
    judgments: [
      judgment(csA, { draft_index: 0 }),
      judgment(rtB, { section_tested: 'regulatory_trajectory', reason_code: 'RT_PASS_FORMAL_RULE', reason: 'R1 final rule; R1f all covered firms; R2 US agency; R3f first issued in final form; R4f recovery testing duty; R5 public rule text', draft_index: 1 }),
      judgment(csC, { draft_index: 2 }),
      judgment(dropD, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'C1 routine patch, nothing specific changed', draft_index: null }),
      judgment(exE, { section_tested: 'executive_visibility', verdict: 'drop', reason_code: 'BF_SECTION_EXCLUDED', reason: 'would qualify only as executive visibility, outside this pass', draft_index: null }),
      judgment(outF, { section_tested: null, verdict: 'drop', reason_code: 'BF_OUT_OF_WINDOW', reason: 'first published after the January window closed', draft_index: null }),
      judgment(goneH, { verdict: 'drop', reason_code: 'BF_URL_UNVERIFIED', reason: 'primary page returns 404 and no other source carries the facts', draft_index: null }),
      judgment(unG, { section_tested: 'regulatory_trajectory', verdict: 'drop', reason_code: 'RT_NO_DIRECTION', reason: 'R3 restates existing expectations; no new direction', draft_index: null }),
    ],
    items,
    notes: 'Fixture backfill.',
  };
  // every page is live except goneH's
  const routes = routesFor(candidates, [goneH]);
  return { candidates, decisions, routes, csA, rtB, csC, csC2, dropD, exE, outF, goneH, unG };
}

const verified = (url, checked = CHECKED, o = {}) => ({ url, status: 200, final_url: url, content_type: 'text/html; charset=utf-8', verified: true, verified_by: 'page', reason: 'ok', checked_at: checked, user_agent: USER_AGENT, retried: false, retry_status: null, redirects: 0, title: null, ...o });
function checksFor(urls, checked = CHECKED) {
  return Object.fromEntries(urls.map((u) => [normaliseUrl(u), verified(u, checked)]));
}
const itemUrls = (decisions) => decisions.items.flatMap((it) => it.sources.map((s) => s.url));

const LIVE_ITEM = {
  id: 'RS-261002-1400-01',
  timestamp: '2026-10-02T14:00:00-04:00',
  section: 'capability_shift',
  claim: 'A fictional live item used to prove existing items stay unchanged.',
  domains: ['cyber'],
  source_class: 'news',
  mechanism: 'awareness_only',
  interpretation: [{ domain: 'cyber', text: 'A fictional interpretation for the live fixture item, long enough to read as one.' }],
  validation_question: null,
  candidate_issue_statement: null,
  awareness_rationale: 'A fictional rationale for the live fixture item.',
  sources: [{ publication: 'Example News', url: 'https://news.example.com/live-story' }],
  backfilled: false,
  update_of: null,
};
const liveRun = (slotRunId, slotIso, items) => ({
  run_id: slotRunId,
  slot: slotIso,
  started_at: slotIso,
  finished_at: slotIso,
  status: 'published',
  items,
  threshold_level: 'high',
  funnel: { sources_ok: 1, sources_failed: 0, fetched: 1, in_window: 1, unseen: 1, stage1_pass: 1, stage2_pass: items.length, dedup_dropped: 0, published: items.length },
  stage2_by_section: { executive_visibility: { tested: 0, passed: 0 }, capability_shift: { tested: items.length, passed: items.length }, regulatory_trajectory: { tested: 0, passed: 0 } },
  mechanism_distribution: { candidate_issue: 0, kri_kpi: 0, praf_coverage: 0, awareness_only: items.length },
});

function bfWorkspace({ candidates, decisions, checks, archive, runs, seen, routes = {} }) {
  const dir = tempDir('rs-bf-');
  const p = {
    dir,
    routes,
    archive: path.join(dir, 'docs', 'data', 'archive.json'),
    runs: path.join(dir, 'docs', 'data', 'runs.json'),
    seen: path.join(dir, 'pipeline', 'state', 'seen.json'),
    logs: path.join(dir, 'pipeline', 'logs'),
    work: path.join(dir, 'pipeline', 'work', 'backfill-2026-01'),
  };
  writeJson(p.archive, archive ?? { schema_version: 1, items: [LIVE_ITEM] });
  writeJson(p.runs, runs ?? { schema_version: 1, runs: [liveRun('2026-10-02-1400', '2026-10-02T14:00:00-04:00', ['RS-261002-1400-01'])] });
  writeJson(p.seen, seen ?? { schema_version: 1, urls: { 'https://news.example.com/live-story': { first_seen: '2026-10-02T14:03:00-04:00', run_id: '2026-10-02-1400', verdict: 'published', item_id: 'RS-261002-1400-01' } } });
  if (candidates) writeJson(path.join(p.work, 'candidates.json'), { schema_version: 1, month: '2026-01', window: windowDoc(W), generated_at: NOW, candidates });
  if (decisions) writeJson(path.join(p.work, 'decisions.json'), decisions);
  if (checks) writeJson(path.join(p.work, 'url-check.json'), { schema_version: 1, month: '2026-01', updated_at: CHECKED, checks });
  p.logFile = path.join(p.logs, 'backfill', '2026-01.jsonl');
  p.urlCheck = path.join(p.work, 'url-check.json');
  p.fetchLog = path.join(dir, 'fetch-log.jsonl');
  p.flags = ['--month', '2026-01', '--archive', p.archive, '--runs', p.runs, '--seen', p.seen, '--logs-dir', p.logs, '--work-dir', p.work,
    '--filter', FILTER_FIXTURE, '--thresholds', path.join(dir, 'thresholds.json'), '--sources', path.join(ROOT, 'pipeline', 'sources.json')];
  p.bytes = () => ({ archive: fs.readFileSync(p.archive, 'utf8'), runs: fs.readFileSync(p.runs, 'utf8'), seen: fs.readFileSync(p.seen, 'utf8') });
  return p;
}

/** Run backfill.mjs with the fetch mock serving `routes` (default: the workspace's). */
function runBf(ws, args, routes = ws.routes) {
  const routesFile = path.join(ws.dir, 'mock-routes.json');
  writeJson(routesFile, routes);
  const r = spawnSync(process.execPath, ['--import', MOCK, path.join(SCRIPTS, 'backfill.mjs'), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, RS_BACKFILL_MOCK_FETCH: routesFile, RS_BACKFILL_MOCK_FETCH_LOG: ws.fetchLog },
    timeout: 60000,
  });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { json = null; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const publish = (ws, extra = [], now = NOW, routes = ws.routes) => runBf(ws, ['publish', ...ws.flags, '--now', now, ...extra], routes);
const readLog = (ws) => fs.readFileSync(ws.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const fetched = (ws) => (fs.existsSync(ws.fetchLog) ? fs.readFileSync(ws.fetchLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).url) : []);

test('publish: §4 timestamps and ids, backfilled items appended, runs.json and seen.json untouched, audit log', () => {
  const s = scenario();
  // a preflight verify-urls check: kept as history, never trusted
  const ws = bfWorkspace({ candidates: s.candidates, decisions: s.decisions, checks: checksFor(itemUrls(s.decisions)), routes: s.routes });
  try {
    const before = ws.bytes();
    const r = publish(ws);
    assert.equal(r.status, 0, r.stderr);
    const archive = readJson(ws.archive);
    assert.equal(archive.items.length, 4);
    // existing items byte-for-byte unchanged, in place
    assert.deepEqual(archive.items[0], LIVE_ITEM);
    assert.ok(fs.readFileSync(ws.archive, 'utf8').startsWith(before.archive.slice(0, before.archive.indexOf('"backfilled": false'))));
    const added = archive.items.slice(1);
    assert.deepEqual(added.map((i) => [i.id, i.timestamp, i.section, i.mechanism]), [
      ['RS-260105-1800-01', '2026-01-05T18:00:00-05:00', 'capability_shift', 'candidate_issue'],
      ['RS-260105-1800-02', '2026-01-05T18:00:00-05:00', 'regulatory_trajectory', 'awareness_only'],
      ['RS-260112-1000-01', '2026-01-12T10:00:00-05:00', 'capability_shift', 'candidate_issue'],
    ]);
    for (const it of added) {
      assert.equal(it.backfilled, true);
      assert.equal(it.update_of, null);
      assert.ok(!('candidate_ids' in it));
    }
    // the corroborating later source stays on the item but never set its timestamp
    assert.deepEqual(added[2].sources.map((x) => x.url), [s.csC.url, s.csC2.url]);
    // runs.json and seen.json untouched
    assert.equal(fs.readFileSync(ws.runs, 'utf8'), before.runs);
    assert.equal(fs.readFileSync(ws.seen, 'utf8'), before.seen);
    // every item source and the BF_URL_UNVERIFIED candidate were fetched live
    const got = fetched(ws);
    for (const u of [s.csA.url, s.rtB.url, s.csC.url, s.csC2.url, s.goneH.url]) assert.ok(got.includes(u), `fetched ${u}`);
    assert.ok(got.some((u) => u.includes('rs-canary-')), 'a canary was probed');
    // with the honest project user agent only
    const uas = fs.readFileSync(ws.fetchLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l).ua);
    assert.deepEqual([...new Set(uas)], [USER_AGENT]);
    assert.equal(r.json.urls_checked, 5);
    // audit log: one line per judged candidate, then the unjudged ones
    const rows = readLog(ws);
    assert.equal(rows.filter((x) => x.judged).length, 8);
    const by = (c) => rows.find((x) => x.candidate_id === c.candidate_id);
    assert.equal(by(s.csA).item_id, 'RS-260105-1800-01');
    assert.equal(by(s.csA).verdict, 'pass');
    assert.equal(by(s.csA).url_check.verified, true);
    assert.equal(by(s.csA).url_check.verified_by, 'page');
    assert.ok(isEtIso(by(s.csA).url_check.checked_at), 'stamped with the real clock');
    assert.notEqual(by(s.csA).url_check.checked_at, CHECKED, 'the publish check, not the preflight one');
    // every check is recorded: the preflight check and the publish check
    assert.deepEqual(by(s.csA).url_check_history.map((h) => h.checked_at)[0], CHECKED);
    assert.equal(by(s.csA).url_check_history.length, 2);
    assert.deepEqual(by(s.csC).item_sources.map((x) => [x.url, x.url_check.verified]), [[s.csC.url, true], [s.csC2.url, true]]);
    assert.equal(by(s.exE).reason_code, 'BF_SECTION_EXCLUDED');
    assert.equal(by(s.outF).reason_code, 'BF_OUT_OF_WINDOW');
    assert.equal(by(s.goneH).reason_code, 'BF_URL_UNVERIFIED');
    assert.deepEqual([by(s.goneH).url_check.status, by(s.goneH).url_check.verified], [404, false], 'the failed check is logged');
    assert.equal(by(s.unG).verdict, 'drop');
    assert.equal(by(s.csC2).judged, false);
    assert.equal(by(s.csC2).item_id, 'RS-260112-1000-01', 'an unjudged source is logged with its item');
    assert.equal(rows.length, 9);
    assert.deepEqual(r.json.items, ['RS-260105-1800-01', 'RS-260105-1800-02', 'RS-260112-1000-01']);
    assert.deepEqual(r.json.not_judged, [s.csC2.candidate_id]);
    assert.deepEqual(r.json.reason_codes, { CS_PASS_CONTROL_FAILURE: 2, RT_PASS_FORMAL_RULE: 1, CS_NO_SPECIFIC_CHANGE: 1, BF_SECTION_EXCLUDED: 1, BF_OUT_OF_WINDOW: 1, BF_URL_UNVERIFIED: 1, RT_NO_DIRECTION: 1 });
    // url-check.json now holds the publish checks with their history
    const uc = readJson(ws.urlCheck);
    assert.equal(uc.checks[normaliseUrl(s.csA.url)].history.length, 2);
    assert.equal(uc.checks[normaliseUrl(s.goneH.url)].verified, false);
    // whole-archive validation accepts backfilled items that no run record lists
    const v = runScript('validate', ['--archive', ws.archive, '--runs', ws.runs, '--seen', ws.seen, '--thresholds', path.join(ws.dir, 'thresholds.json'), '--strict-lint']);
    assert.equal(v.status, 0, v.stderr);
    assert.equal(v.json.ok, true);
  } finally {
    rmrf(ws.dir);
  }
});

test('publish --dry-run checks and prints the plan and writes nothing', () => {
  const s = scenario();
  const ws = bfWorkspace({ candidates: s.candidates, decisions: s.decisions, checks: checksFor(itemUrls(s.decisions)), routes: s.routes });
  try {
    const before = ws.bytes();
    const ucBefore = fs.readFileSync(ws.urlCheck, 'utf8');
    const r = publish(ws, ['--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.urls_checked, 5);
    assert.equal(r.json.new_items.length, 3);
    assert.equal(r.json.new_items[0].backfilled, true);
    assert.equal(r.json.log_rows.length, 9);
    assert.deepEqual(r.json.would_write, [ws.logFile, ws.archive]);
    assert.deepEqual(ws.bytes(), before);
    assert.equal(fs.readFileSync(ws.urlCheck, 'utf8'), ucBefore, 'url-check.json untouched');
    assert.equal(fs.existsSync(ws.logFile), false);
    assert.match(r.stderr, /dry run: nothing written/);
  } finally {
    rmrf(ws.dir);
  }
});

test('a second publish for the month is refused; --append-missing adds only new items with new ids', () => {
  const s = scenario();
  const late = bc('https://research.example.com/2026/01/loader-signing', onDate('2026-01-05'), {
    publication: 'Example Research', source_class: 'vendor_threat_research', headline: 'Loader signed with stolen certificate', lead: 'A loader carried a valid code-signing certificate.',
  });
  const ws = bfWorkspace({ candidates: s.candidates, decisions: s.decisions, routes: { ...s.routes, ...routesFor([late]) } });
  try {
    assert.equal(publish(ws).status, 0);
    const afterFirst = ws.bytes();
    const logFirst = fs.readFileSync(ws.logFile, 'utf8');
    const again = publish(ws);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already published \(3 backfilled item\(s\) in the window: RS-260105-1800-01, RS-260105-1800-02, RS-260112-1000-01; audit log present\); refusing to publish twice\. Use --append-missing/);
    // re-running the same decisions with --append-missing is a no-op
    const same = publish(ws, ['--append-missing']);
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stderr, /nothing new to publish/);
    assert.deepEqual(ws.bytes(), afterFirst);
    assert.equal(fs.readFileSync(ws.logFile, 'utf8'), logFirst);
    // a missed candidate on 5 January takes the next free NN in that slot
    const cands = [...s.candidates, late];
    const dec = structuredClone(s.decisions);
    dec.items.push(makeDraft([late], {
      claim: 'A malware loader carried a valid stolen code-signing certificate, researchers report.',
      domains: ['cyber'],
      interpretation: [{ domain: 'cyber', text: 'Signature trust alone no longer separates malicious loaders from legitimate software where certificates are stolen.' }],
      validation_question: 'Does the organisation block signed executables whose certificates appear on revocation or abuse lists?',
      candidate_issue_statement: 'Where executables are trusted on signature alone, malware signed with stolen certificates could run undetected and lead to compromise.',
    }));
    dec.judgments.push(judgment(late, { draft_index: 3 }));
    writeJson(path.join(ws.work, 'candidates.json'), { schema_version: 1, month: '2026-01', window: windowDoc(W), generated_at: NOW, candidates: cands });
    writeJson(path.join(ws.work, 'decisions.json'), dec);
    const add = publish(ws, ['--append-missing']);
    assert.equal(add.status, 0, add.stderr);
    assert.deepEqual(add.json.items, ['RS-260105-1800-03']);
    assert.equal(add.json.skipped.items.length, 3);
    const archive = readJson(ws.archive);
    assert.equal(archive.items.length, 5);
    assert.deepEqual(archive.items.slice(0, 4), JSON.parse(afterFirst.archive).items, 'existing items unchanged');
    assert.equal(archive.items[4].id, 'RS-260105-1800-03');
    const log = fs.readFileSync(ws.logFile, 'utf8');
    assert.ok(log.startsWith(logFirst), 'the audit log is appended to');
    const newRows = log.slice(logFirst.length).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(newRows.map((x) => [x.candidate_id, x.item_id]), [[late.candidate_id, 'RS-260105-1800-03']]);
    assert.equal(fs.readFileSync(ws.runs, 'utf8'), afterFirst.runs);
    assert.equal(fs.readFileSync(ws.seen, 'utf8'), afterFirst.seen);
  } finally {
    rmrf(ws.dir);
  }
});

test('--rejudge judges a logged drop again after a FILTER.md revision; published items and plain runs are refused', () => {
  const s = scenario();
  const ws = bfWorkspace({ candidates: s.candidates, decisions: s.decisions, routes: s.routes });
  try {
    assert.equal(publish(ws).status, 0);
    const afterFirst = ws.bytes();
    const logFirst = fs.readFileSync(ws.logFile, 'utf8');
    const dec = structuredClone(s.decisions);
    dec.items.push(makeDraft([s.dropD], {
      claim: 'A vendor patch removed a default that let unsigned plug-ins load, researchers report.',
      domains: ['cyber'],
      interpretation: [{ domain: 'cyber', text: 'Plug-in signing was optional by default, so hosts relying on vendor defaults accepted unsigned code until the patch.' }],
      validation_question: 'Does the organisation enforce signature checks on plug-ins for the affected product rather than relying on its default setting?',
      candidate_issue_statement: 'Where plug-in signature checks rely on the product default, unsigned plug-ins could load and lead to undetected compromise.',
    }));
    const k = dec.judgments.findIndex((j) => j.candidate_id === s.dropD.candidate_id);
    dec.judgments[k] = judgment(s.dropD, { draft_index: 3 });
    writeJson(path.join(ws.work, 'decisions.json'), dec);
    // without --rejudge the logged judgment is skipped and the item is refused
    const plain = publish(ws, ['--append-missing']);
    assert.equal(plain.status, 1);
    assert.match(plain.stderr, /a candidate is judged once per pass/);
    // --rejudge needs --append-missing
    const noAppend = publish(ws, ['--rejudge', s.dropD.candidate_id]);
    assert.equal(noAppend.status, 1);
    assert.match(noAppend.stderr, /--rejudge needs --append-missing/);
    // a candidate of a published item is never re-judged
    const pub = publish(ws, ['--append-missing', '--rejudge', s.csA.candidate_id]);
    assert.equal(pub.status, 1);
    assert.match(pub.stderr, /published items are never re-judged/);
    assert.deepEqual(ws.bytes(), afterFirst);
    // the logged drop is judged again; earlier rows are kept, the new row is appended and marked
    const r = publish(ws, ['--append-missing', '--rejudge', s.dropD.candidate_id]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.items, ['RS-260108-1800-01']);
    assert.deepEqual(r.json.rejudge, [s.dropD.candidate_id]);
    const log = fs.readFileSync(ws.logFile, 'utf8');
    assert.ok(log.startsWith(logFirst), 'the audit log is appended to');
    const newRows = log.slice(logFirst.length).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(newRows.map((x) => [x.candidate_id, x.verdict, x.rejudged, x.previous_reason_code, x.item_id]),
      [[s.dropD.candidate_id, 'pass', true, 'CS_NO_SPECIFIC_CHANGE', 'RS-260108-1800-01']]);
    assert.equal(readJson(ws.archive).items.length, 5);
    assert.equal(fs.readFileSync(ws.runs, 'utf8'), afterFirst.runs);
    assert.equal(fs.readFileSync(ws.seen, 'utf8'), afterFirst.seen);
  } finally {
    rmrf(ws.dir);
  }
});

test('publish checks every item source live and trusts no recorded verdict (HIGH-2)', () => {
  const s = scenario();
  const urls = itemUrls(s.decisions);
  // url-check.json claims every source verified an hour ago; the pages say otherwise now
  const forged = { ...checksFor(urls), [normaliseUrl(s.csC2.url)]: verified(s.csC2.url, '2099-01-01T00:00:00-05:00') };
  const cases = [
    ['404', { ...s.routes, [s.csC2.url]: { status: 404, body: 'gone' } }, /push-fatigue-follow-up: failed verification \(HTTP 404/],
    ['soft 404', { ...s.routes, [s.rtB.url]: page(s.rtB, { body: '<html><head><title>Page not found | Example Agency</title></head><body><p>x</p></body></html>' }) }, /2026-01-05-resilience: failed verification \(soft 404: title "Page not found \| Example Agency"/],
    ['home redirect', { ...s.routes, [s.csA.url]: { status: 301, redirect: 'https://research.example.com/' }, 'https://research.example.com/': page(s.csA) }, /token-replay: failed verification \(redirected to the site's home page/],
    ['off-site', { ...s.routes, [s.csA.url]: { status: 302, redirect: 'https://elsewhere.example.net/x' }, 'https://elsewhere.example.net/x': page(s.csA) }, /token-replay: failed verification \(redirected off-site to elsewhere\.example\.net/],
  ];
  for (const [name, routes, re] of cases) {
    const ws = bfWorkspace({ candidates: s.candidates, decisions: s.decisions, checks: forged, routes });
    try {
      const before = ws.bytes();
      const r = publish(ws);
      assert.equal(r.status, 1, `${name}: ${r.stderr}`);
      assert.match(r.stderr, re, name);
      assert.match(r.stderr, /nothing was written to the archive or the audit log \(the URL checks were recorded/);
      assert.deepEqual(ws.bytes(), before, `${name}: nothing written`);
      assert.equal(fs.existsSync(ws.logFile), false);
      // the forged future record is dropped from url-check.json; the real checks are recorded
      const uc = readJson(ws.urlCheck);
      assert.ok(Object.values(uc.checks).every((c) => !c.checked_at.startsWith('2099') && c.history.every((h) => !h.checked_at.startsWith('2099'))), name);
      assert.match(r.stderr, /ignored a check of .*push-fatigue-follow-up: checked_at 2099-01-01T00:00:00-05:00 is after the real time/);
    } finally {
      rmrf(ws.dir);
    }
  }
});

test('section restriction: only the pass sections publish; --sections narrows and never widens (MED-6)', () => {
  const s = scenario();
  const dec = structuredClone(s.decisions);
  dec.items[0].section = 'executive_visibility';
  dec.judgments[0].section_tested = 'executive_visibility';
  dec.judgments[0].reason_code = 'EV_PASS_LOSS';
  dec.judgments[3].section_tested = 'executive_visibility';
  dec.judgments[3].reason_code = 'EV_NO_EXEC_QUESTION';
  dec.judgments[4].section_tested = 'capability_shift';
  const ws = bfWorkspace({ candidates: s.candidates, decisions: dec, routes: s.routes });
  try {
    const r = publish(ws);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /items\[0\]: section: executive_visibility is outside the 2026-01 pass \(capability_shift, regulatory_trajectory\); drop the story BF_SECTION_EXCLUDED/);
    assert.match(r.stderr, /judgments\[0\].*section_tested: executive_visibility is outside the 2026-01 pass/);
    assert.match(r.stderr, /judgments\[3\].*section_tested: executive_visibility is outside the 2026-01 pass/);
    assert.match(r.stderr, /judgments\[4\].*BF_SECTION_EXCLUDED names a section outside the pass \(or null\), not capability_shift/);
    // --sections cannot add a section the owner did not name
    const wide = publish(ws, ['--sections', 'executive_visibility,capability_shift,regulatory_trajectory', '--dry-run']);
    assert.equal(wide.status, 2);
    assert.match(wide.stderr, /--sections: executive_visibility is not in the 2026-01 pass \(capability_shift, regulatory_trajectory\); --sections only narrows a pass/);
    // narrowing to one section: the other section's item is then out of the pass
    writeJson(path.join(ws.work, 'decisions.json'), s.decisions);
    const narrow = publish(ws, ['--sections', 'capability_shift', '--dry-run']);
    assert.equal(narrow.status, 1);
    assert.match(narrow.stderr, /items\[1\]: section: regulatory_trajectory is outside the 2026-01 pass \(capability_shift\)/);
  } finally {
    rmrf(ws.dir);
  }
});

test('BF codes are drop codes with their section rules; a BF code on a pass is refused', () => {
  const s = scenario();
  const dec = structuredClone(s.decisions);
  dec.judgments[5].section_tested = 'capability_shift'; // BF_OUT_OF_WINDOW requires null
  dec.judgments[6].verdict = 'pass'; // BF_URL_UNVERIFIED is a drop code
  dec.judgments[6].draft_index = 0;
  dec.judgments.push(judgment(s.csC2, { draft_index: 2 })); // outside the window: never a pass
  dec.items[2].candidate_ids = [s.csC.candidate_id, s.csC2.candidate_id];
  const ws = bfWorkspace({ candidates: s.candidates, decisions: dec, routes: s.routes });
  try {
    const r = publish(ws);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BF_OUT_OF_WINDOW requires null/);
    assert.match(r.stderr, /reason_code: BF_URL_UNVERIFIED is a drop code but verdict is pass/);
    assert.match(r.stderr, /registered outside the window \(outside_window\); it can only corroborate/);
  } finally {
    rmrf(ws.dir);
  }
});

test('BF_URL_UNVERIFIED: its URL is checked and logged; a URL that verifies leaves a warning (MED-8)', () => {
  const s = scenario();
  // goneH's page answers 200 after all: the code then rests on the page's content alone
  const ws = bfWorkspace({ candidates: s.candidates, decisions: s.decisions, routes: { ...s.routes, ...routesFor([s.goneH]) } });
  try {
    const r = publish(ws, ['--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /warn .*\(c-[0-9a-f]{10}\): reason_code: BF_URL_UNVERIFIED, but https:\/\/news\.example\.com\/2026\/01\/gone verified at .*; the code then stands only if the page was read and does not carry the claim's facts/);
    const row = r.json.log_rows.find((x) => x.candidate_id === s.goneH.candidate_id);
    assert.equal(row.url_check.verified, true);
  } finally {
    rmrf(ws.dir);
  }
});

test('ids never collide with existing items; a last-evening development takes the last slot (MED-9)', () => {
  const s = scenario();
  // a (fictional) existing live item already holds RS-260105-1800-01
  const occupied = { ...LIVE_ITEM, id: 'RS-260105-1800-01', timestamp: '2026-01-05T18:00:00-05:00', sources: [{ publication: 'Example News', url: 'https://news.example.com/occupied' }] };
  const ws = bfWorkspace({
    candidates: s.candidates, decisions: s.decisions, routes: s.routes,
    archive: { schema_version: 1, items: [occupied] },
    runs: { schema_version: 1, runs: [liveRun('2026-01-05-1800', '2026-01-05T18:00:00-05:00', ['RS-260105-1800-01'])] },
  });
  try {
    const r = publish(ws);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /id RS-260105-1800-01 already exists in the archive; ids never collide with existing items/);
  } finally {
    rmrf(ws.dir);
  }
  // published at 21:00 ET on 31 January: inside the window, after its last slot -> that last slot
  const evening = bc('https://news.example.com/2026/01/late-evening', atTime('2026-01-31T21:00:00-05:00'), { headline: 'Late evening disclosure', lead: 'A disclosure late on the last evening of the month.' });
  const dec = structuredClone(s.decisions);
  dec.items[0] = makeDraft([evening]);
  dec.judgments[0] = judgment(evening, { draft_index: 0 });
  dec.judgments.push(judgment(s.csA, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'C1 nothing specific changed', draft_index: null }));
  const ws2 = bfWorkspace({ candidates: [...s.candidates, evening], decisions: dec, routes: { ...s.routes, ...routesFor([evening]) } });
  try {
    const r = publish(ws2, ['--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    const it = r.json.new_items.find((x) => x.sources[0].url === evening.url);
    assert.deepEqual([it.id, it.timestamp], ['RS-260131-1800-01', '2026-01-31T18:00:00-05:00']);
  } finally {
    rmrf(ws2.dir);
  }
  // first published after the window (00:30 ET on 1 February): BF_OUT_OF_WINDOW, never placed
  const dec3 = structuredClone(s.decisions);
  dec3.items[0] = makeDraft([s.outF]);
  dec3.judgments[0] = judgment(s.outF, { draft_index: 0 });
  dec3.judgments.splice(5, 1);
  dec3.judgments.push(judgment(s.csA, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'C1 nothing specific changed', draft_index: null }));
  const ws3 = bfWorkspace({ candidates: s.candidates, decisions: dec3, routes: s.routes });
  try {
    const r = publish(ws3);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /items\[0\]: no source is published inside the 2026-01 window .*drop it BF_OUT_OF_WINDOW/);
  } finally {
    rmrf(ws3.dir);
  }
});

function withUpdate(s, { matchId, updateOf, date = '2026-01-20' }) {
  const upd = bc('https://research.example.com/2026/01/token-replay-update', onDate(date), {
    publication: 'Example Research', source_class: 'vendor_threat_research', headline: 'Token replay campaign adds a second appliance family', lead: 'The campaign now targets a second family of appliances.',
  });
  const dec = structuredClone(s.decisions);
  dec.items.push(makeDraft([upd], {
    claim: 'The token replay campaign extended to a second appliance family, researchers report.',
    domains: ['cyber'],
    interpretation: [{ domain: 'cyber', text: 'The exposure now spans a second appliance family, widening the set of edge devices whose sessions can be replayed.' }],
    validation_question: 'Does the organisation invalidate active sessions on edge appliances after applying the vendor fix?',
    candidate_issue_statement: 'Where sessions on edge appliances survive patching, replayed tokens could keep attackers inside the network after remediation.',
    update_of: updateOf,
  }));
  dec.judgments.push(judgment(upd, { dedup: 'material_update', match_id: matchId, reason: '[M1] second appliance family affected; C1 C3 hold', draft_index: dec.items.length - 1 }));
  return { cands: [...s.candidates, upd], dec, upd, routes: { ...s.routes, ...routesFor([upd]) } };
}

test('material updates: a candidate id resolves to the earlier batch item; live or later targets are refused', () => {
  const s = scenario();
  const ok = withUpdate(s, { matchId: s.csA.candidate_id, updateOf: s.csA.candidate_id });
  const ws = bfWorkspace({ candidates: ok.cands, decisions: ok.dec, routes: ok.routes });
  try {
    const r = publish(ws);
    assert.equal(r.status, 0, r.stderr);
    const archive = readJson(ws.archive);
    const upd = archive.items.find((i) => i.id === 'RS-260120-1800-01');
    assert.equal(upd.update_of, 'RS-260105-1800-01');
    assert.ok(archive.items.findIndex((i) => i.id === 'RS-260105-1800-01') < archive.items.indexOf(upd));
    assert.equal(readLog(ws).find((x) => x.candidate_id === ok.upd.candidate_id).match_id, 'RS-260105-1800-01');
  } finally {
    rmrf(ws.dir);
  }
  const live = withUpdate(s, { matchId: 'RS-261002-1400-01', updateOf: 'RS-261002-1400-01' });
  const ws2 = bfWorkspace({ candidates: live.cands, decisions: live.dec, routes: live.routes });
  try {
    const r = publish(ws2);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /update_of: RS-261002-1400-01 is a live item; a backfilled item never references a live item/);
    assert.match(r.stderr, /match_id: RS-261002-1400-01 is a live item/);
  } finally {
    rmrf(ws2.dir);
  }
  const later = withUpdate(s, { matchId: s.csC.candidate_id, updateOf: s.csC.candidate_id, date: '2026-01-06' });
  const ws3 = bfWorkspace({ candidates: later.cands, decisions: later.dec, routes: later.routes });
  try {
    const r = publish(ws3);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /update_of: RS-260112-1000-01 is not earlier than this item \(2026-01-06T18:00:00-05:00\)/);
    assert.match(r.stderr, /match_id: RS-260112-1000-01 \(2026-01-12T10:00:00-05:00\) is not earlier than this candidate's own slot 2026-01-06T18:00:00-05:00/);
  } finally {
    rmrf(ws3.dir);
  }
});

test('DD_SAME_STORY must name a story out before the candidate, never a later or live one (MED-5)', () => {
  const s = scenario();
  const early = bc('https://news.example.com/2026/01/token-replay-early', onDate('2026-01-03'), { headline: 'Early coverage of token replay', lead: 'Early report.' });
  const dup = bc('https://news.example.com/2026/01/token-replay-repeat', onDate('2026-01-09'), { headline: 'Token replay story repeated', lead: 'Repeat.' });
  const sameStory = (c, matchId) => judgment(c, { verdict: 'drop', reason_code: 'DD_SAME_STORY', dedup: 'same_story_dropped', match_id: matchId, reason: 'repeats the token replay story', draft_index: null });
  const cands = [...s.candidates, early, dup];
  const routes = { ...s.routes, ...routesFor([early, dup]) };
  const cases = [
    ['a 3 January candidate against the 5 January item', sameStory(early, s.csA.candidate_id), /match_id: RS-260105-1800-01 \(2026-01-05T18:00:00-05:00\) is not earlier than this candidate's own slot 2026-01-03T18:00:00-05:00; the earlier story must precede this candidate/],
    ['a January candidate against a live October item', sameStory(early, 'RS-261002-1400-01'), /match_id: RS-261002-1400-01 \(2026-10-02T14:00:00-04:00\) is not earlier than this candidate's own slot 2026-01-03T18:00:00-05:00/],
  ];
  for (const [name, j, re] of cases) {
    const dec = structuredClone(s.decisions);
    dec.judgments.push(j, sameStory(dup, s.csA.candidate_id));
    const ws = bfWorkspace({ candidates: cands, decisions: dec, routes });
    try {
      const r = publish(ws, ['--dry-run']);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, re, name);
    } finally {
      rmrf(ws.dir);
    }
  }
  // a 9 January repeat of the 5 January item is fine
  const dec = structuredClone(s.decisions);
  dec.judgments.push(sameStory(dup, s.csA.candidate_id));
  const ws = bfWorkspace({ candidates: [...s.candidates, dup], decisions: dec, routes });
  try {
    const r = publish(ws, ['--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.log_rows.find((x) => x.candidate_id === dup.candidate_id).match_id, 'RS-260105-1800-01');
  } finally {
    rmrf(ws.dir);
  }
});

test('every registered in-window candidate is judged; cited, outside-window ones excepted (MED-7)', () => {
  const s = scenario();
  const dec = structuredClone(s.decisions);
  dec.judgments = dec.judgments.filter((j) => j.candidate_id !== s.unG.candidate_id && j.candidate_id !== s.dropD.candidate_id);
  const ws = bfWorkspace({ candidates: s.candidates, decisions: dec, routes: s.routes });
  try {
    const r = publish(ws);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`decisions\\.judgments: 2 registered in-window candidate\\(s\\) not judged: ${s.dropD.candidate_id}, ${s.unG.candidate_id}; every candidate is judged`));
    assert.doesNotMatch(r.stderr, new RegExp(`not judged: .*${s.csC2.candidate_id}`), 'a cited outside-window source needs no judgment');
  } finally {
    rmrf(ws.dir);
  }
});

test('a paywalled publication is never an item\'s primary source, even alone (MED-4)', () => {
  const s = scenario();
  const pw = bc('https://www.ft.com/content/fictional-0001', onDate('2026-01-07'), { publication: 'Financial Times', source_class: 'news', paywalled: true, headline: 'Token replay hits appliances', lead: 'Paywalled lead.' });
  const dec = structuredClone(s.decisions);
  dec.items.push(makeDraft([pw], { claim: 'Attackers replayed stolen session tokens against edge appliances, a newspaper reports.', source_class: 'news' }));
  dec.judgments.push(judgment(pw, { draft_index: 3 }));
  const ws = bfWorkspace({ candidates: [...s.candidates, pw], decisions: dec, routes: { ...s.routes, ...routesFor([pw]) } });
  try {
    const r = publish(ws, ['--dry-run']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /items\[3\]\.sources\[0\]: https:\/\/www\.ft\.com\/content\/fictional-0001: Financial Times is paywalled \(headline and lead only\) and never the primary source of a backfilled item/);
  } finally {
    rmrf(ws.dir);
  }
});

test('AO3 inside a pass: a rationale repeating an earlier item\'s rationale is refused (MED-10)', () => {
  const s = scenario();
  const rtB2 = bc('https://agency.example.gov/rules/2026-01-22-recovery', onDate('2026-01-22'), { publication: 'Example Agency', source_class: 'regulator', headline: 'Final rule on recovery planning', lead: 'The agency adopted a second final rule.' });
  const dec = structuredClone(s.decisions);
  dec.items.push(makeDraft([rtB2], {
    ...dec.items[1],
    candidate_ids: [rtB2.candidate_id],
    claim: 'An agency adopted a second rule requiring documented recovery plans for critical operations.',
    sources: [{ publication: rtB2.publication, url: rtB2.url, headline: rtB2.headline, published: rtB2.published_date, source_class: 'regulator' }],
  }));
  dec.judgments.push(judgment(rtB2, { section_tested: 'regulatory_trajectory', reason_code: 'RT_PASS_FORMAL_RULE', reason: 'R1 final rule; R1f all covered firms; R2 US agency; R3f first issued in final form; R4f recovery plan duty; R5 public rule text', draft_index: 3 }));
  const ws = bfWorkspace({ candidates: [...s.candidates, rtB2], decisions: dec, routes: { ...s.routes, ...routesFor([rtB2]) } });
  try {
    const r = publish(ws, ['--dry-run']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /items\[3\]: awareness_rationale: repeats 12\+ consecutive words of the rationale of RS-260105-1800-02, earlier in this pass/);
    assert.doesNotMatch(r.stderr, /items\[1\]: awareness_rationale: repeats/, 'the first item is not refused');
  } finally {
    rmrf(ws.dir);
  }
});

test('a KEV catalogue source is verified against the KEV catalogue JSON (MED-3)', () => {
  const s = scenario();
  const kevUrl = 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-91001';
  const kev = bc(kevUrl, onDate('2026-01-01'), {
    publication: 'CISA', source_class: 'vendor_threat_research', headline: 'CISA KEV adds CVE-2026-91001: Examplesoft Mail Relay — Examplesoft Mail Relay Command Injection Vulnerability',
    headline_composed: true, lead: 'Examplesoft Mail Relay contains a command injection vulnerability.', kev: { cve: 'CVE-2026-91001' },
  });
  const item = makeDraft([kev], { claim: 'Attackers are exploiting a command injection flaw in a mail relay product, CISA says.', source_class: 'vendor_threat_research' });
  delete item.sources[0].headline;
  const catalogue = { status: 200, body: '<html><head><title>Known Exploited Vulnerabilities Catalog | CISA</title></head><body><main><h1>Known Exploited Vulnerabilities Catalog</h1><p>CVE-2099-00001 first row</p></main></body></html>' };
  const build = (cand, kevJson) => {
    const dec = structuredClone(s.decisions);
    dec.items.push({ ...item, candidate_ids: [cand.candidate_id] });
    dec.judgments.push(judgment(cand, { draft_index: 3 }));
    return bfWorkspace({ candidates: [...s.candidates, cand], decisions: dec, routes: { ...s.routes, [kevUrl]: catalogue, ...(kevJson ? { [KEV_URL]: { status: 200, type: 'application/json', body: kevJson } } : {}) } });
  };
  const ws = build(kev, fixture('backfill-kev.json'));
  try {
    const r = publish(ws, ['--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    const row = r.json.log_rows.find((x) => x.candidate_id === kev.candidate_id);
    assert.equal(row.url_check.verified_by, 'kev-json');
    assert.deepEqual(row.url_check.kev, { cve: 'CVE-2026-91001', date_added: '2026-01-01', catalog_version: '2026.02.03' });
    assert.ok(!fetched(ws).some((u) => u.includes('rs-canary-')  && u.includes('cisa.gov')), 'no canary on the catalogue page');
  } finally {
    rmrf(ws.dir);
  }
  // the candidate's date is not the catalogue's dateAdded
  const wrong = { ...kev, ...onDate('2026-01-02') };
  const ws2 = build(wrong, fixture('backfill-kev.json'));
  try {
    const r = publish(ws2, ['--dry-run']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /failed verification \(the KEV catalogue JSON lists CVE-2026-91001 with dateAdded 2026-01-01, not 2026-01-02/);
  } finally {
    rmrf(ws2.dir);
  }
  // the catalogue JSON is unavailable: the page alone proves nothing
  const ws3 = build(kev, null);
  try {
    const r = publish(ws3, ['--dry-run']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the KEV catalogue page answers 200 for any query, so CVE-2026-91001 is verified against the catalogue JSON, which was unavailable \(HTTP 404\)/);
  } finally {
    rmrf(ws3.dir);
  }
});

test('publish refuses when the archive changes while it checks URLs (LOW-15)', () => {
  const s = scenario();
  const ws = bfWorkspace({ candidates: s.candidates, decisions: s.decisions, routes: s.routes });
  try {
    // fetching csA's page stands in for a live run writing the archive meanwhile
    const routes = { ...s.routes, [s.csA.url]: { ...page(s.csA), touch: { file: ws.archive, append: '\n' } } };
    const before = fs.readFileSync(ws.archive, 'utf8');
    const r = publish(ws, [], NOW, routes);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /archive\.json changed while this publish ran; nothing was written to the archive or the audit log/);
    assert.equal(fs.readFileSync(ws.archive, 'utf8'), `${before}\n`, 'only the concurrent change');
    assert.equal(fs.existsSync(ws.logFile), false);
  } finally {
    rmrf(ws.dir);
  }
});

test('publish refusals: undefined pass, window not ended, run_id, unregistered candidate, empty judgments, bad dates', () => {
  const s = scenario();
  const ws = bfWorkspace({ candidates: s.candidates, decisions: s.decisions, routes: s.routes });
  try {
    const noPass = runBf(ws, ['publish', ...ws.flags.map((f) => (f === '2026-01' ? '2025-12' : f)), '--now', NOW]);
    assert.equal(noPass.status, 2);
    assert.match(noPass.stderr, /no backfill pass is defined for 2025-12/);
    const early = publish(ws, [], '2026-01-31T20:00:00-05:00');
    assert.equal(early.status, 1);
    assert.match(early.stderr, /the 2026-01 window has not ended/);
    const dec = structuredClone(s.decisions);
    dec.run_id = '2026-01-05-1800';
    dec.judgments.push(judgment({ candidate_id: 'c-0123456789' }, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'C1 nothing changed', draft_index: null }));
    writeJson(path.join(ws.work, 'decisions.json'), dec);
    const bad = publish(ws);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /run_id: "2026-01-05-1800" must be "backfill-2026-01"/);
    assert.match(bad.stderr, /c-0123456789\): candidate_id: not a registered candidate of this pass/);
    assert.doesNotMatch(bad.stderr, /stage-1 survivor/);
    writeJson(path.join(ws.work, 'decisions.json'), { ...s.decisions, judgments: [], items: [] });
    const empty = publish(ws);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /judgments: empty/);
    const wrongFlag = runBf(ws, ['publish', ...ws.flags, '--allow-outside']);
    assert.equal(wrongFlag.status, 2);
    // an unreadable timed publication is reported, never a crash (LOW-13): on a dropped candidate
    // it is logged without a date; on an item source it stops the item
    writeJson(path.join(ws.work, 'decisions.json'), s.decisions);
    const garble = (which) => s.candidates.map((c) => (which.includes(c) ? { ...c, published: 'garbage', published_precision: 'time' } : c));
    writeJson(path.join(ws.work, 'candidates.json'), { schema_version: 1, month: '2026-01', window: windowDoc(W), generated_at: NOW, candidates: garble([s.dropD]) });
    const dropped = publish(ws, ['--dry-run']);
    assert.equal(dropped.status, 0, dropped.stderr);
    assert.equal(dropped.json.log_rows.find((x) => x.candidate_id === s.dropD.candidate_id).published, null);
    writeJson(path.join(ws.work, 'candidates.json'), { schema_version: 1, month: '2026-01', window: windowDoc(W), generated_at: NOW, candidates: garble([s.dropD, s.csA]) });
    const g = publish(ws, ['--dry-run']);
    assert.equal(g.status, 1, g.stderr);
    assert.match(g.stderr, new RegExp(`items\\[0\\]: sources\\[0\\]: candidate ${s.csA.candidate_id} has no usable publication date`));
    assert.doesNotMatch(g.stderr, /invalid date/);
    assert.equal(fs.existsSync(ws.logFile), false);
  } finally {
    rmrf(ws.dir);
  }
});

test('--now is refused where a backfill would write real data; verify-urls never takes it (HIGH-2)', () => {
  // these refusals happen before anything is read or written
  const pub = runScript('backfill', ['publish', '--month', '2026-01', '--now', NOW, '--dry-run']);
  assert.equal(pub.status, 2);
  assert.match(pub.stderr, /--now is for tests only and is refused with the work directory .*, the archive .*archive\.json, the logs /);
  const col = runScript('backfill', ['collect', '--month', '2026-01', '--now', NOW, '--only', 'kev']);
  assert.equal(col.status, 2);
  assert.match(col.stderr, /--now is for tests only and is refused with the work directory/);
  const dir = tempDir('rs-bf-now-');
  try {
    const ver = runScript('backfill', ['verify-urls', '--month', '2026-01', '--work-dir', dir, '--now', NOW, '--url', 'https://example.com/']);
    assert.equal(ver.status, 2);
    assert.match(ver.stderr, /--now does not apply to verify-urls: URL checks are always stamped with the real time/);
    // a work dir inside the real one counts as real
    const inside = runScript('backfill', ['add', '--month', '2026-01', '--now', NOW, '--work-dir', path.join(ROOT, 'pipeline', 'work', 'backfill-2026-01', 'sub'), '--file', path.join(dir, 'none.json')]);
    assert.equal(inside.status, 2);
    assert.match(inside.stderr, /--now is for tests only/);
  } finally {
    rmrf(dir);
  }
  const mdir = tempDir('rs-bf-m-');
  try {
    // October has day passes only; a month before January has none
    for (const month of ['2026-10', '2025-12']) {
      const months = runScript('backfill', ['collect', '--month', month, '--work-dir', mdir]);
      assert.equal(months.status, 2, month);
      assert.match(months.stderr, new RegExp(`no backfill pass is defined for ${month}`), month);
    }
    assert.deepEqual(fs.readdirSync(mdir), [], 'nothing written');
  } finally {
    rmrf(mdir);
  }
});

test('add: validates the file, refuses it whole on any error, registers ids, dedups, --allow-outside, midnight stamps', () => {
  const ws = bfWorkspace({});
  try {
    const file = path.join(ws.dir, 'found.json');
    const good = {
      url: 'https://research.example.com/2026/01/edge-campaign',
      publication: 'Example Research',
      source_class: 'vendor_threat_research',
      headline: 'Edge appliance campaign uses stolen session tokens',
      lead: 'Researchers describe a campaign.',
      published: '2026-01-14',
      paywalled: false,
      discovery_mode: 'search',
    };
    writeJson(file, [good, { ...good, url: 'https://t.co/abc' }]);
    const bad = runScript('backfill', ['add', ...ws.flags, '--now', NOW, '--file', file]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /entries\[1\]\.url: t\.co is an aggregator/);
    assert.match(bad.stderr, /1 error\(s\); nothing was added/);
    assert.equal(fs.existsSync(path.join(ws.work, 'candidates.json')), false);
    writeJson(file, { candidates: [good, { ...good, url: 'https://research.example.com/2026/01/edge-campaign?utm_source=x' }] });
    const ok = runScript('backfill', ['add', ...ws.flags, '--now', NOW, '--file', file]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.json.added.length, 1);
    assert.deepEqual(ok.json.registered.map((x) => x.status), ['added', 'already a candidate']);
    assert.equal(ok.json.registered[0].candidate_id, ok.json.registered[1].candidate_id);
    const doc = readJson(path.join(ws.work, 'candidates.json'));
    assert.equal(doc.month, '2026-01');
    assert.equal(doc.window.last_slot, '2026-01-31T18:00:00-05:00');
    assert.equal(doc.candidates.length, 1);
    assert.equal(doc.candidates[0].discovery_mode, 'search');
    // a later corroborating source needs --allow-outside
    writeJson(file, [{ ...good, url: 'https://news.example.com/2026/02/later', publication: 'Example News', source_class: 'news', published: '2026-02-03T08:00:00-05:00' }]);
    const later = runScript('backfill', ['add', ...ws.flags, '--now', NOW, '--file', file]);
    assert.equal(later.status, 1);
    assert.match(later.stderr, /--allow-outside/);
    const allowed = runScript('backfill', ['add', ...ws.flags, '--now', NOW, '--file', file, '--allow-outside']);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.json.added[0].outside_window, true);
    assert.equal(readJson(path.join(ws.work, 'candidates.json')).candidates.length, 2);
    // a CMS midnight stamp is the date written (LOW-11)
    writeJson(file, [{ ...good, url: 'https://research.example.com/2026/01/new-year', published: '2026-01-01T00:00:00Z' }]);
    const midnight = runScript('backfill', ['add', ...ws.flags, '--now', NOW, '--file', file]);
    assert.equal(midnight.status, 0, midnight.stderr);
    assert.match(midnight.stderr, /is a midnight stamp; recorded as the date 2026-01-01/);
    assert.equal(midnight.json.added[0].published, '2026-01-01');
    // the window must have ended
    const early = runScript('backfill', ['add', ...ws.flags, '--now', '2026-01-20T12:00:00-05:00', '--file', file]);
    assert.equal(early.status, 1);
    assert.match(early.stderr, /has not ended/);
  } finally {
    rmrf(ws.dir);
  }
});

test('the live gate applies: verbatim guard, first person, strict self-check rules, threshold level', () => {
  const s = scenario();
  const dec = structuredClone(s.decisions);
  dec.threshold_level = 'medium';
  // 8+ consecutive words of csA's lead
  dec.items[0].claim = 'Researchers saw stolen session tokens replayed against edge appliances in several sectors.';
  dec.items[0].validation_question = 'Can we show every internet-facing gateway was patched within the emergency window?';
  dec.items[2].claim = 'An unprecedented wave of criminal kits automates push prompts, researchers report.';
  const ws = bfWorkspace({ candidates: s.candidates, decisions: dec, routes: s.routes });
  try {
    const before = ws.bytes();
    const r = publish(ws);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /items\[0\]: claim: copies 8\+ consecutive words from a source headline or lead/);
    assert.match(r.stderr, /items\[0\]: validation_question: first-person voice "we"/);
    assert.match(r.stderr, /ERROR decisions\.items\[2\]: .*hype word "unprecedented"/);
    assert.match(r.stderr, /threshold_level: "medium" must equal thresholds\.json level "high"/);
    assert.deepEqual(ws.bytes(), before);
  } finally {
    rmrf(ws.dir);
  }
});
