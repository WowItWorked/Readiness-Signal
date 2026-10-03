// End-to-end checks for the review fixes, run as CLIs in temp dirs (no network beyond 127.0.0.1):
// publish.mjs slot/start/fetch-report refusals (F05), all-or-nothing writes (F04), historical-item
// lint tolerance (F03), seen conflicts (F13); selfcheck.mjs (F10); add-manual.mjs --extra (F02);
// slot.mjs --run (F11); fetch.mjs date warnings and an undated item across two runs (F06, F19).
// FICTIONAL data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { normaliseUrl } from '../../pipeline/lib/url.mjs';
import { SCRIPTS, fixture, judgment, makeCandidate, makeDraft, makeSurvivor, readJson, rmrf, runScript, tempDir, workspace, writeJson } from './_helpers.mjs';

const RUN = '2026-10-02-1400';
const STARTED = '2026-10-02T14:03:12-04:00';
const NOW = '2026-10-02T14:21:40-04:00';

function runAsync(name, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, `${name}.mjs`), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not json */ }
      resolve({ status, stdout, stderr, json });
    });
  });
}

/** One clean candidate, survivor, pass judgment and item. */
function simple(overrides = {}) {
  const c = makeCandidate({ url: 'https://news.example.com/gateway', headline: 'Gateway flaw exploited at several firms', ...overrides.candidate });
  return {
    c,
    candidates: [c],
    survivors: [makeSurvivor(c)],
    decisions: { run_id: overrides.runId ?? RUN, threshold_level: 'high', judgments: [judgment(c)], items: [makeDraft([c])] },
  };
}

const snapshot = (files) => files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '<none>')).join('\n--\n');

test('publish F05: refuses a slot that has not started, a run that started in another slot, and a missing fetch report', () => {
  // future slot (e.g. a mistyped $RUN): would block every real slot until the clock caught up
  const fut = simple({ runId: '2026-10-05-1400' });
  let ws = workspace({ runId: '2026-10-05-1400', ...fut, startedAt: '2026-10-02T12:50:31-04:00' });
  try {
    const before = snapshot([ws.runs, ws.archive, ws.seen]);
    const r = runScript('publish', ['--run', '2026-10-05-1400', '--now', '2026-10-02T12:50:31-04:00', ...ws.flags]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /slot 2026-10-05-1400 has not started yet/);
    assert.equal(snapshot([ws.runs, ws.archive, ws.seen]), before);
    // the same with --status failed is refused too
    const f = runScript('publish', ['--run', '2026-10-05-1400', '--status', 'failed', '--reason', 'x', '--now', '2026-10-02T12:50:31-04:00', ...ws.flags]);
    assert.match(f.stderr, /has not started yet/);
  } finally {
    rmrf(ws.dir);
  }
  // fetch started in the 10:00 slot but published as 14:00
  const s = simple();
  ws = workspace({ runId: RUN, ...s, startedAt: '2026-10-02T12:50:00-04:00' });
  try {
    const r = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /started_at 2026-10-02T12:50:00-04:00 falls in slot 2026-10-02-1000, not 2026-10-02-1400/);
    assert.equal(readJson(ws.runs).runs.length, 0);
  } finally {
    rmrf(ws.dir);
  }
  // no fetch-report.json: refused for a published or silent run, allowed for --status failed
  ws = workspace({ runId: RUN, ...s, startedAt: STARTED });
  try {
    fs.rmSync(path.join(ws.work, RUN, 'fetch-report.json'));
    const r = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /fetch-report\.json not found: run fetch\.mjs for this run first, or record --status failed/);
    // a failed run recorded late (now in the 18:00 slot) is still recorded, with a warning
    const late = runScript('publish', ['--run', RUN, '--status', 'failed', '--reason', 'fetch error: network unreachable', '--now', '2026-10-02T18:05:00-04:00', ...ws.flags]);
    assert.equal(late.status, 0, late.stderr);
    assert.match(late.stderr, /warn {2}started_at 2026-10-02T18:05:00-04:00 falls in slot 2026-10-02-1800, not 2026-10-02-1400/);
    assert.equal(readJson(ws.runs).runs[0].status, 'failed');
  } finally {
    rmrf(ws.dir);
  }
});

test('publish F04: a failed write leaves archive, run log, seen and logs exactly as they were', { skip: process.getuid?.() === 0 && 'root ignores file permissions' }, () => {
  const s = simple();
  const ws = workspace({ runId: RUN, ...s, startedAt: STARTED });
  // Make the last write (runs.json) fail: on Windows a read-only file cannot be replaced; on POSIX
  // a read-only directory refuses the temp file.
  const roDir = path.join(ws.dir, 'ro');
  const runsFile = path.join(roDir, 'runs.json');
  writeJson(runsFile, { schema_version: 1, runs: [] });
  const flags = ws.flags.map((f) => (f === ws.runs ? runsFile : f));
  const lock = () => (process.platform === 'win32' ? fs.chmodSync(runsFile, 0o444) : fs.chmodSync(roDir, 0o555));
  const unlock = () => (process.platform === 'win32' ? fs.chmodSync(runsFile, 0o644) : fs.chmodSync(roDir, 0o755));
  try {
    const files = [ws.archive, runsFile, ws.seen];
    const before = snapshot(files);
    lock();
    const r = runScript('publish', ['--run', RUN, '--now', NOW, ...flags]);
    unlock();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /write failed .*the 3 file\(s\) already written were restored/);
    assert.equal(snapshot(files), before);
    assert.equal(fs.existsSync(path.join(ws.logs, '2026', '10', `${RUN}.jsonl`)), false);
    // the same run then publishes normally
    const again = runScript('publish', ['--run', RUN, '--now', NOW, ...flags]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readJson(runsFile).runs.length, 1);
    assert.equal(readJson(ws.archive).items.length, 1);
    assert.equal(runScript('validate', ['--archive', ws.archive, '--runs', runsFile, '--seen', ws.seen]).status, 0);
  } finally {
    try { unlock(); } catch { /* already unlocked */ }
    rmrf(ws.dir);
  }
});

test('publish F03: an archive item that a newer lint rule flags does not block later runs; validate.mjs warns', () => {
  // A live item published before "JPM" was a listed alias (validation_question names it).
  const old = {
    id: 'RS-261002-1000-01', timestamp: '2026-10-02T10:00:00-04:00', section: 'capability_shift',
    claim: 'Attackers exploited an unpatched gateway flaw across several sectors, the vendor says.', domains: ['cyber'], source_class: 'news',
    mechanism: 'candidate_issue', interpretation: [{ domain: 'cyber', text: 'Edge appliances remain a primary intrusion route.' }],
    validation_question: 'Does the JPM-style gateway patch window apply to every internet-facing appliance?',
    candidate_issue_statement: 'Where emergency patches are not tracked to completion, exploitation could go undetected.',
    awareness_rationale: null, sources: [{ publication: 'Example News', url: 'https://news.example.com/old', source_class: 'news' }], backfilled: false, update_of: null,
  };
  const oldRun = {
    run_id: '2026-10-02-1000', slot: '2026-10-02T10:00:00-04:00', started_at: '2026-10-02T10:02:00-04:00', finished_at: '2026-10-02T10:20:00-04:00',
    status: 'published', items: [old.id], threshold_level: 'high',
    funnel: { sources_ok: 5, sources_failed: 0, fetched: 50, in_window: 20, unseen: 20, stage1_pass: 1, stage2_pass: 1, dedup_dropped: 0, published: 1 },
    stage2_by_section: { executive_visibility: { tested: 0, passed: 0 }, capability_shift: { tested: 1, passed: 1 }, regulatory_trajectory: { tested: 0, passed: 0 } },
    mechanism_distribution: { candidate_issue: 1, kri_kpi: 0, praf_coverage: 0, awareness_only: 0 },
  };
  const s = simple();
  const ws = workspace({ runId: RUN, archive: { schema_version: 1, items: [old] }, runs: { schema_version: 1, runs: [oldRun] }, ...s, startedAt: STARTED });
  try {
    const r = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJson(ws.archive).items.length, 2);
    const v = runScript('validate', ['--archive', ws.archive, '--runs', ws.runs, '--seen', ws.seen]);
    assert.equal(v.status, 0, v.stderr);
    assert.match(v.stderr, /warn .*RS-261002-1000-01.*names a specific financial institution.*published item, not re-checked as an error/);
    const strict = runScript('validate', ['--archive', ws.archive, '--runs', ws.runs, '--seen', ws.seen, '--strict-lint']);
    assert.equal(strict.status, 1);
    // a new item with the same problem is still refused
    const RUN2 = '2026-10-02-1800';
    const c2 = makeCandidate({ url: 'https://news.example.com/new', headline: 'New gateway story' });
    const w2 = path.join(ws.work, RUN2);
    writeJson(path.join(w2, 'candidates.json'), { schema_version: 1, run_id: RUN2, candidates: [c2] });
    writeJson(path.join(w2, 'fetch-report.json'), { schema_version: 1, run_id: RUN2, started_at: '2026-10-02T18:02:00-04:00', totals: { sources_ok: 5, sources_failed: 0, fetched: 9, in_window: 1, unseen: 1 } });
    writeJson(path.join(w2, 'stage1.json'), { schema_version: 1, run_id: RUN2, survivors: [makeSurvivor(c2)] });
    writeJson(path.join(w2, 'decisions.json'), { run_id: RUN2, threshold_level: 'high', judgments: [judgment(c2)], items: [makeDraft([c2], { validation_question: 'Has JPM patched every internet-facing gateway?' })] });
    const r2 = runScript('publish', ['--run', RUN2, '--now', '2026-10-02T18:10:00-04:00', '--dry-run', ...ws.flags]);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /names a specific financial institution: "JPM"/);
  } finally {
    rmrf(ws.dir);
  }
});

test('publish F13: a survivor that another run has since recorded as published is named in a warning', () => {
  const s = simple();
  const seen = { schema_version: 1, urls: { [normaliseUrl(s.c.url)]: { first_seen: '2026-10-02T10:02:00-04:00', run_id: '2026-10-02-1000', verdict: 'published', item_id: 'RS-261002-1000-01' } } };
  const ws = workspace({ runId: RUN, ...s, seen, startedAt: STARTED });
  try {
    const r = runScript('publish', ['--run', RUN, '--now', NOW, '--dry-run', ...ws.flags]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`survivor ${s.c.candidate_id} .* is now in seen\\.json as published \\(RS-261002-1000-01\\) from run 2026-10-02-1000`));
  } finally {
    rmrf(ws.dir);
  }
});

// ---------------------------------------------------------------- selfcheck.mjs (F10)

function selfcheckWorkspace(mutate = (d) => d) {
  const gw1 = makeCandidate({ url: 'https://news.example.com/gateway-zero-day', headline: 'Gateway zero-day exploited against several sectors' });
  const gw2 = makeCandidate({ url: 'https://wire.example.org/gateway-flaw', publication: 'Example Wire', headline: 'Example Gateway flaw under attack' });
  const other = makeCandidate({ url: 'https://news.example.com/noise', headline: 'Vendor patches minor bug' });
  const outlet = makeCandidate({ url: 'https://trade.example.net/gateway', publication: 'Example Trade', headline: 'Gateway attacks spread' }); // collected, not a survivor
  const advisory = makeCandidate({ url: 'https://agency.example.gov/advisories/aa26-275a', publication: 'Example Agency', source_class: 'vendor_threat_research', headline: 'Advisory AA26-275A', source_id: null, extra: true });
  const decisions = mutate({
    run_id: RUN,
    threshold_level: 'high',
    judgments: [
      judgment(gw1),
      judgment(gw2, { dedup: 'cluster_merged', match_id: gw1.candidate_id, reason: `cluster member of ${gw1.candidate_id}` }),
      judgment(other, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'C1 routine patch, nothing specific changed', draft_index: null }),
    ],
    items: [makeDraft([advisory, gw1, gw2, outlet], { source_class: 'vendor_threat_research' })],
    notes: 'self-audit: CI 1/1 re-verified, 0 retagged',
  }, { gw1, gw2, other, outlet, advisory });
  const ws = workspace({ runId: RUN, candidates: [gw1, gw2, other, outlet, advisory], survivors: [gw1, gw2, other].map((c) => makeSurvivor(c)), decisions, startedAt: STARTED });
  return ws;
}
const selfcheck = (ws, extra = []) => runScript('selfcheck', ['--run', RUN, '--work-dir', ws.work, '--archive', ws.archive, '--thresholds', path.join(ws.dir, 'thresholds.json'), '--filter', ws.flags[ws.flags.indexOf('--filter') + 1], ...extra]);

test('selfcheck.mjs: a clean file passes (extra sources and collected outlets accepted); read-only', () => {
  const ws = selfcheckWorkspace();
  try {
    const files = ['decisions.json', 'stage1.json', 'candidates.json', 'fetch-report.json'].map((f) => path.join(ws.work, RUN, f));
    const before = snapshot([...files, ws.archive]);
    const r = selfcheck(ws);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /self-check: 0 error\(s\)/);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.items, 1);
    assert.ok(r.json.warnings.some((w) => /was not a stage-1 survivor .*attached as an extra source/.test(w)), 'collected non-survivor outlet: warning only');
    assert.equal(snapshot([...files, ws.archive]), before);
    // publish agrees
    assert.equal(runScript('publish', ['--run', RUN, '--now', NOW, '--dry-run', ...ws.flags]).status, 0);
  } finally {
    rmrf(ws.dir);
  }
});

test('selfcheck.mjs: FILTER-only rules are errors by default and warnings with --lenient; layer 1 always errors', () => {
  const ws = selfcheckWorkspace((d) => {
    d.items[0].claim = 'Attackers exploited a massive gateway flaw across several sectors, the vendor says';
    d.items[0].interpretation = [...d.items[0].interpretation].reverse();
    d.items[0].validation_question = 'Can your team show every gateway was patched within the window?';
    d.judgments[1].reason = 'merged';
    d.threshold_level = 'medium';
    return d;
  });
  try {
    const r = selfcheck(ws);
    assert.equal(r.status, 1);
    for (const re of [/hype word "massive" \(FILTER V9\)/, /full stop \(FILTER 7\.2\)/, /order of domains \(FILTER 7\.4\)/, /second person "your" \(FILTER V2\)/,
      /cluster member's reason begins "cluster member of /, /threshold_level: "medium" must equal thresholds\.json level "high"/]) {
      assert.match(r.stderr, new RegExp(`ERROR .*${re.source}`), re.source);
    }
    const lenient = selfcheck(ws, ['--lenient']);
    assert.equal(lenient.status, 0, lenient.stderr);
    assert.match(lenient.stderr, /warn .*hype word "massive"/);
  } finally {
    rmrf(ws.dir);
  }
  const ws2 = selfcheckWorkspace((d, { other }) => {
    d.judgments = d.judgments.filter((j) => j.candidate_id !== other.candidate_id);
    return d;
  });
  try {
    const r = selfcheck(ws2, ['--lenient']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERROR decisions: judgments: 1 stage-1 survivor\(s\) not judged/);
  } finally {
    rmrf(ws2.dir);
  }
});

test('selfcheck.mjs: --help documents it; usage errors exit 2', () => {
  const help = runScript('selfcheck', ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stderr, /node pipeline\/scripts\/selfcheck\.mjs --run <run_id>/);
  assert.match(help.stderr, /--lenient/);
  assert.equal(runScript('selfcheck', []).status, 2);
  assert.equal(runScript('selfcheck', ['--run', '2026-10-02-1430']).status, 2);
  const dir = tempDir();
  try {
    const r = runScript('selfcheck', ['--run', RUN, '--work-dir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /decisions\.json not found/);
  } finally {
    rmrf(dir);
  }
});

// ---------------------------------------------------------------- add-manual.mjs --extra (F02)

test('add-manual.mjs --extra: registers search-found sources, inherits the registry, forces paywalls, refuses aggregators', () => {
  const dir = tempDir();
  try {
    const work = path.join(dir, 'work');
    const sourcesFile = path.join(dir, 'sources.json');
    writeJson(sourcesFile, { schema_version: 1, sources: [
      { id: 'agency-news', publication: 'Example Agency', source_class: 'regulator', type: 'feed', url: 'https://agency.example.gov/news.xml', paywalled: false, region: 'US', notes: '' },
      { id: 'pro-news', publication: 'Example Pro', source_class: 'news', type: 'feed', url: 'https://feeds.pro.example.com/rss', paywalled: true, region: 'UK', notes: '' },
    ] });
    const fetched = makeCandidate({ url: 'https://news.example.com/gateway', headline: 'Gateway flaw exploited' });
    const w = path.join(work, RUN);
    writeJson(path.join(w, 'candidates.json'), { schema_version: 1, run_id: RUN, window: { since: STARTED, until: STARTED }, candidates: [fetched] });
    const report = { schema_version: 1, run_id: RUN, started_at: STARTED, totals: { sources_ok: 2, sources_failed: 0, in_window: 1, unseen: 1 }, sources: [] };
    writeJson(path.join(w, 'fetch-report.json'), report);
    const common = ['--run', RUN, '--extra', '--sources', sourcesFile, '--seen', path.join(dir, 'seen.json'), '--work-dir', work];
    const longLead = Array.from({ length: 70 }, (_, i) => `w${i}`).join(' ');
    const good = path.join(w, 'extra.json');
    writeJson(good, { candidates: [
      { url: 'https://agency.example.gov/advisories/aa26-275a', headline: 'Advisory AA26-275A: gateway exploitation', source_class: 'vendor_threat_research', published: '2026-09-20' },
      { url: 'https://www.pro.example.com/content/abc', headline: 'Lenders hit by gateway attacks', paywalled: false, lead: longLead },
      { url: 'https://www.ft.com/content/xyz', headline: 'Gateway attacks spread', publication: 'Financial Times', source_class: 'news' },
      { url: 'https://research.example.org/gateway-study', headline: 'Gateway exploitation study', publication: 'Example Research', source_class: 'research_analysis' },
      { url: 'https://news.example.com/gateway', headline: 'Gateway flaw exploited', publication: 'Example News', source_class: 'news' },
    ] });
    const r = runScript('add-manual', [...common, '--file', good]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.mode, 'extra');
    assert.equal(r.json.added.length, 4);
    assert.match(r.json.skipped[0], /already a candidate \(c-[0-9a-f]{10}, fetched from example-news\); use that candidate_id/);
    // every entry's citable id, the already-collected one included (friction 12: that is success)
    assert.deepEqual(r.json.registered.map((x) => x.status), ['added', 'added', 'added', 'added', 'already a candidate']);
    assert.equal(r.json.registered[4].candidate_id, fetched.candidate_id);
    assert.match(r.stderr, /added 4 extra source\(s\); 1 already a candidate \(registered: cite the candidate_id shown\)/);
    const cands = readJson(path.join(w, 'candidates.json')).candidates;
    const by = Object.fromEntries(cands.map((c) => [c.url, c]));
    const adv = by['https://agency.example.gov/advisories/aa26-275a'];
    assert.deepEqual([adv.extra, adv.publication, adv.source_class, adv.source_id, adv.paywalled, adv.published_date], [true, 'Example Agency', 'vendor_threat_research', 'agency-news', false, '2026-09-20']);
    const pro = by['https://www.pro.example.com/content/abc'];
    assert.equal(pro.paywalled, true, 'a registered paywalled site cannot be marked open');
    assert.equal(pro.publication, 'Example Pro');
    assert.equal(pro.lead.split(' ').filter((x) => x !== '…').length, 40);
    assert.equal(by['https://www.ft.com/content/xyz'].paywalled, true, 'a known paywalled publication');
    assert.equal(by['https://research.example.org/gateway-study'].source_id, null);
    assert.deepEqual(readJson(path.join(w, 'fetch-report.json')), report, 'extras are not part of the fetched pool');
    // idempotent
    const again = runScript('add-manual', [...common, '--file', good]);
    assert.equal(again.json.added.length, 0);
    // stage 1 never scores extras
    const pf = runScript('prefilter', ['--run', RUN, '--work-dir', work, '--sources', sourcesFile]);
    assert.equal(pf.status, 0, pf.stderr);
    const stage1 = readJson(path.join(w, 'stage1.json'));
    assert.equal(stage1.counts.extra, 4);
    assert.equal(stage1.counts.input, 1);
    // refusals: nothing written
    const bad = path.join(w, 'bad.json');
    writeJson(bad, { candidates: [
      { url: 'https://news.google.com/articles/abc', headline: 'x', publication: 'X', source_class: 'news' },
      { url: 'https://www.example.com/story/amp', headline: 'x', publication: 'X', source_class: 'news' },
      { url: 'https://unregistered.example.org/a', headline: 'No class given' },
      { url: 'http://insecure.example.org/a', headline: 'x', publication: 'X', source_class: 'news' },
    ] });
    const before = fs.readFileSync(path.join(w, 'candidates.json'), 'utf8');
    const refused = runScript('add-manual', [...common, '--file', bad]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /news\.google\.com is an aggregator/);
    assert.match(refused.stderr, /AMP URL/);
    assert.match(refused.stderr, /publication: required \(no source in .* on unregistered\.example\.org\)/);
    assert.match(refused.stderr, /must be https/);
    assert.equal(fs.readFileSync(path.join(w, 'candidates.json'), 'utf8'), before);
    // --help documents the mode
    assert.match(runScript('add-manual', ['--help']).stderr, /EXTRA MODE \(--extra; RUNBOOK step 9\)/);
  } finally {
    rmrf(dir);
  }
});

// ---------------------------------------------------------------- slot.mjs --run (F11)

test('slot.mjs --run: already_run and superseded for a given run id, without reading the clock', () => {
  const dir = tempDir();
  try {
    const runs = path.join(dir, 'runs.json');
    writeJson(runs, { schema_version: 1, runs: [
      { run_id: '2026-10-02-1000', slot: '2026-10-02T10:00:00-04:00', status: 'silent', started_at: '2026-10-02T10:01:00-04:00', finished_at: '2026-10-02T10:09:00-04:00' },
      { run_id: '2026-10-02-1800', slot: '2026-10-02T18:00:00-04:00', status: 'published', started_at: '2026-10-02T18:01:00-04:00', finished_at: '2026-10-02T18:19:00-04:00' },
    ] });
    let r = runScript('slot', ['--run', '2026-10-02-1400', '--runs', runs]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([r.json.run_id, r.json.already_run, r.json.superseded, r.json.previous_run.run_id, r.json.latest_run.run_id], ['2026-10-02-1400', false, true, '2026-10-02-1000', '2026-10-02-1800']);
    assert.equal(r.json.now, undefined);
    assert.match(r.stderr, /SUPERSEDED by 2026-10-02-1800/);
    r = runScript('slot', ['--run', '2026-10-02-1800', '--runs', runs]);
    assert.deepEqual([r.json.already_run, r.json.superseded], [true, false]);
    r = runScript('slot', ['--run', '2026-10-03-0600', '--runs', runs]);
    assert.deepEqual([r.json.already_run, r.json.superseded], [false, false]);
    assert.equal(runScript('slot', ['--run', '2026-10-02-1430', '--runs', runs]).status, 2);
    assert.equal(runScript('slot', ['--run', '2026-10-02-1400', '--now', '2026-10-02T14:00:00-04:00', '--runs', runs]).status, 2);
    // the clock form still reports superseded when a later slot is recorded
    r = runScript('slot', ['--now', '2026-10-02T14:05:00-04:00', '--runs', runs]);
    assert.deepEqual([r.json.run_id, r.json.already_run, r.json.superseded], ['2026-10-02-1400', false, true]);
  } finally {
    rmrf(dir);
  }
});

// ---------------------------------------------------------------- fetch.mjs dates; undated across runs (F06, F19)

function startServer() {
  const server = http.createServer((req, res) => {
    const files = { '/dash.xml': 'fmt-drupal-dash-date.xml', '/null-dates.xml': 'fmt-cdata-null-dates.xml', '/undated.xml': 'fmt-undated-items.xml', '/time.xml': 'fmt-drupal-time-in-description.xml' };
    if (files[req.url]) {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(fixture(files[req.url]));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const src = (id, url, o = {}) => ({ id, publication: `Example ${id}`, source_class: 'regulator', type: 'feed', url, paywalled: false, region: 'US', notes: 'fixture', ...o });

test('fetch.mjs: date problems are counted per source and printed; implausible dates never enter the pool', async () => {
  const { server, base } = await startServer();
  const dir = tempDir();
  try {
    const sourcesFile = path.join(dir, 'sources.json');
    writeJson(sourcesFile, { schema_version: 1, sources: [src('dash', `${base}/dash.xml`), src('null-dates', `${base}/null-dates.xml`), src('time', `${base}/time.xml`)] });
    const work = path.join(dir, 'work');
    const r = await runAsync('fetch', ['--run', RUN, '--now', '2026-10-02T14:05:00-04:00', '--since', '2026-09-29T00:00:00Z', '--sources', sourcesFile,
      '--seen', path.join(dir, 'seen.json'), '--runs', path.join(dir, 'runs.json'), '--work-dir', work, '--allow-http']);
    assert.equal(r.status, 0, r.stderr);
    const report = readJson(path.join(work, RUN, 'fetch-report.json'));
    const by = Object.fromEntries(report.sources.map((s) => [s.id, s]));
    assert.deepEqual([by.dash.date_unparsed, by.dash.bad_date, by['null-dates'].bad_date, by.time.dateless], [1, 0, 2, 0]);
    assert.deepEqual([report.totals.bad_date, report.totals.date_unparsed, report.totals.undated], [2, 1, 1]);
    assert.equal(report.date_warnings.length, 2);
    assert.match(r.stderr, /warn {2}dash: 1 entry has a date in an unreadable format/);
    assert.match(r.stderr, /warn {2}null-dates: 2 entries have an implausible date/);
    const cands = readJson(path.join(work, RUN, 'candidates.json')).candidates;
    assert.ok(!cands.some((c) => /20241120a|20240709a/.test(c.url)));
    assert.ok(cands.some((c) => c.url === 'https://authority.example.eu/press-news/news/authority-calls-changes-crypto-asset-rules' && c.published_date === '2026-09-30'));
  } finally {
    server.close();
    rmrf(dir);
  }
});

test('an undated item judged in one run is dropped as seen in the next (it does not resurface)', async () => {
  const { server, base } = await startServer();
  const url = 'https://banksec.example.com/attackers-abuse-help-desk-resets-a-33003';
  const c = makeCandidate({ url, headline: 'Attackers abuse help-desk resets to bypass MFA at payment firms', published: null, published_date: null, date_missing: true });
  const ws = workspace({
    runId: RUN, candidates: [c], survivors: [makeSurvivor(c)], startedAt: STARTED,
    decisions: { run_id: RUN, threshold_level: 'high', judgments: [judgment(c, { verdict: 'drop', section_tested: null, reason_code: 'GL_NO_DEVELOPMENT', reason: 'G6 campaign write-up, no new development', draft_index: null })], items: [] },
  });
  try {
    assert.equal(runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]).status, 0);
    assert.equal(readJson(ws.seen).urls[normaliseUrl(url)].verdict, 'dropped');
    const RUN2 = '2026-10-02-1800';
    const sourcesFile = path.join(ws.dir, 'sources.json');
    writeJson(sourcesFile, { schema_version: 1, sources: [src('banksec', `${base}/undated.xml`, { source_class: 'news' })] });
    const f = await runAsync('fetch', ['--run', RUN2, '--now', '2026-10-02T18:02:00-04:00', '--sources', sourcesFile, '--seen', ws.seen, '--runs', ws.runs, '--work-dir', ws.work, '--allow-http']);
    assert.equal(f.status, 0, f.stderr);
    const cands = readJson(path.join(ws.work, RUN2, 'candidates.json')).candidates;
    assert.equal(cands.find((x) => x.url === url).seen, true);
    assert.equal(runScript('prefilter', ['--run', RUN2, '--work-dir', ws.work, '--sources', sourcesFile]).status, 0);
    const stage1 = readJson(path.join(ws.work, RUN2, 'stage1.json'));
    assert.deepEqual(stage1.dropped.find((d) => d.candidate_id === c.candidate_id), { candidate_id: c.candidate_id, source_id: 'banksec', headline: c.headline, reason: 'seen', detail: 'dropped' });
    assert.ok(!stage1.survivors.some((s) => s.candidate_id === c.candidate_id));
  } finally {
    server.close();
    rmrf(ws.dir);
  }
});
