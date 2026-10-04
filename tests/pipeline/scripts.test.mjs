// fetch.mjs against a local HTTP server, then add-manual, prefilter, dedup-hints, slot and
// calibration as CLIs. Everything runs in temp dirs; no network beyond 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { USER_AGENT } from '../../pipeline/lib/collect.mjs';
import { normaliseUrl } from '../../pipeline/lib/url.mjs';
import { SCRIPTS, fixture, judgment, makeCandidate, makeDraft, makeSurvivor, readJson, rmrf, runScript, tempDir, workspace, writeJson } from './_helpers.mjs';

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

function startServer() {
  const uas = [];
  const hits = new Map();
  const server = http.createServer((req, res) => {
    uas.push([req.url, req.headers['user-agent']]);
    hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
    const send = (status, body, type = 'application/xml', headers = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    switch (req.url) {
      case '/rss2.xml': return send(200, fixture('rss2.xml'));
      case '/atom.xml': return send(200, fixture('atom.xml'));
      case '/rdf.xml': return send(200, fixture('rdf.xml'));
      case '/junk.xml': return send(200, fixture('junk-prefix.xml'));
      case '/kev.json': return send(200, fixture('kev.json'), 'application/json');
      // refuses the project user agent (it would serve a browser): reported failed, never bypassed
      case '/browser-only.xml':
        return req.headers['user-agent'] === USER_AGENT ? send(403, 'Forbidden', 'text/plain') : send(200, fixture('rss2.xml'));
      // busy once: 503 with Retry-After 1, then the feed (one retry, same user agent)
      case '/busy-once.xml':
        return hits.get(req.url) === 1 ? send(503, 'busy', 'text/plain', { 'retry-after': '1' }) : send(200, fixture('rss2.xml'));
      case '/broken.xml': return send(500, 'oops', 'text/plain');
      case '/html': return send(200, '<!doctype html><html><body>not a feed</body></html>', 'text/html');
      case '/slow.xml': setTimeout(() => send(200, fixture('rss2.xml')), 3000); return undefined;
      default: return send(404, 'not found', 'text/plain');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, uas })));
}

const src = (id, url, o = {}) => ({ id, publication: `Example ${id}`, source_class: 'news', type: 'feed', url, paywalled: false, region: 'US', notes: 'fixture', ...o });

test('fetch.mjs: formats, honest user agent only, one same-agent retry, failures, timeout, KEV, manual pages, seen, in-run duplicates', async () => {
  const { server, base, uas } = await startServer();
  const dir = tempDir();
  try {
    const sourcesFile = path.join(dir, 'sources.json');
    writeJson(sourcesFile, {
      schema_version: 1,
      sources: [
        src('wire', `${base}/rss2.xml`),
        src('wire-mirror', `${base}/rss2.xml`),
        src('research', `${base}/atom.xml`, { source_class: 'research_analysis', region: 'INTL' }),
        src('central-bank', `${base}/rdf.xml`, { source_class: 'regulator', region: 'INTL' }),
        src('association', `${base}/junk.xml`, { source_class: 'industry_trade' }),
        src('kev', `${base}/kev.json`, { type: 'cisa-kev', source_class: 'vendor_threat_research', publication: 'CISA' }),
        src('picky', `${base}/browser-only.xml`, { paywalled: true, lead_words: 10 }),
        src('busy', `${base}/busy-once.xml`, { paywalled: true, lead_words: 10 }),
        src('broken', `${base}/broken.xml`),
        src('not-a-feed', `${base}/html`),
        src('slow', `${base}/slow.xml`),
        src('speeches-page', 'https://supervisor.example.gov/speeches', { type: 'page', source_class: 'regulator' }),
        src('disabled', `${base}/rss2.xml`, { enabled: false }),
      ],
    });
    const seen = path.join(dir, 'seen.json');
    writeJson(seen, { schema_version: 1, urls: { [normaliseUrl('https://research.example.org/notes/2026/updated-only')]: { first_seen: '2026-10-01T10:02:00-04:00', run_id: '2026-10-01-1000', verdict: 'dropped', item_id: null } } });
    const work = path.join(dir, 'work');
    const r = await runAsync('fetch', ['--run', '2026-10-02-1400', '--now', '2026-10-02T14:05:00-04:00', '--since', '2026-09-29T00:00:00Z', '--timeout-ms', '1000',
      '--sources', sourcesFile, '--seen', seen, '--runs', path.join(dir, 'runs.json'), '--work-dir', work, '--allow-http']);
    assert.equal(r.status, 0, r.stderr);
    const report = readJson(path.join(work, '2026-10-02-1400', 'fetch-report.json'));
    const by = Object.fromEntries(report.sources.map((s) => [s.id, s]));
    assert.equal(by.wire.status, 'ok');
    assert.equal(by.wire.format, 'rss');
    assert.equal(by.research.format, 'atom');
    assert.equal(by['central-bank'].format, 'rdf');
    assert.equal(by.association.status, 'ok');
    assert.equal(by.kev.format, 'kev-json');
    // a source refusing the project user agent is retried once with the same agent, then fails
    assert.deepEqual([by.picky.status, by.picky.http_status, by.picky.retried, by.picky.retry_status], ['failed', 403, true, 403]);
    assert.equal(by.picky.error, 'HTTP 403 (retried once after HTTP 403)');
    assert.equal('retried_with_browser_ua' in by.picky, false);
    // 503 + Retry-After: waited for, then one retry with the same agent
    assert.deepEqual([by.busy.status, by.busy.http_status, by.busy.retried, by.busy.retry_status], ['ok', 200, true, 503]);
    assert.ok(by.busy.elapsed_ms >= 900, `waited ${by.busy.elapsed_ms} ms`);
    assert.deepEqual([by.wire.retried, by.wire.retry_status], [false, null]);
    assert.equal(by.broken.status, 'failed');
    assert.match(by.broken.error, /HTTP 500/);
    assert.match(by['not-a-feed'].error, /not a recognised feed/);
    assert.match(by.slow.error, /timeout/);
    assert.equal(by['speeches-page'].status, 'manual');
    assert.equal(by.disabled, undefined);
    assert.equal(report.manual[0].id, 'speeches-page');
    assert.deepEqual([report.totals.sources_ok, report.totals.sources_failed, report.totals.sources_manual], [7, 4, 1]);
    assert.equal(report.healthy, true);
    assert.equal(report.user_agent, USER_AGENT);
    // every request carried the honest project user agent; never anything else
    assert.ok(uas.length > 0 && uas.every(([, ua]) => ua === USER_AGENT), JSON.stringify(uas.filter(([, ua]) => ua !== USER_AGENT)));
    assert.equal(uas.filter(([u]) => u === '/browser-only.xml').length, 2, 'one retry, same agent');
    assert.equal(uas.filter(([u]) => u === '/busy-once.xml').length, 2);
    assert.match(r.stderr, /picky \[HTTP 403 → retried once, same user agent\]: HTTP 403/);

    const cand = readJson(path.join(work, '2026-10-02-1400', 'candidates.json')).candidates;
    const kev = cand.filter((c) => c.kev);
    assert.deepEqual(kev.map((c) => c.kev.cve).sort(), ['CVE-2026-90001', 'CVE-2026-90002']);
    const k1 = kev.find((c) => c.kev.cve === 'CVE-2026-90001');
    assert.equal(k1.headline, 'CISA KEV adds CVE-2026-90001: Microsoft SharePoint — Microsoft SharePoint Deserialization Vulnerability');
    assert.equal(k1.url, 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-90001');
    assert.equal(k1.url_normalised, k1.url, 'the catalogue query parameter survives normalisation');
    assert.equal(k1.headline_composed, true, 'the KEV headline is composed by the collector (FILTER 7.8)');
    assert.equal(k1.publication, 'CISA');
    assert.equal(k1.source_class, 'vendor_threat_research');
    assert.equal(k1.published_date, '2026-10-01');
    // the same URL from two feeds is one candidate with also_in
    const gw = cand.filter((c) => c.url_normalised === 'https://news.example.com/2026/10/gateway-zero-day');
    assert.equal(gw.length, 1);
    assert.deepEqual(gw[0].also_in.sort(), ['busy', 'wire-mirror']);
    // seen marking
    assert.equal(cand.find((c) => c.url_normalised === 'https://research.example.org/notes/2026/updated-only').seen, true);
    // never a full body
    assert.ok(!JSON.stringify(cand).includes('FULL BODY'));
    assert.ok(!JSON.stringify(cand).includes('FULL ATOM CONTENT'));
    // window: the 2026-09-29 RDF speech (08:00Z) is before --since 2026-09-29T00:00Z? no: it is after, so kept
    assert.ok(cand.some((c) => c.headline === 'Monetary policy outlook'));

    // manual page items enter the pool through add-manual.mjs
    const manual = path.join(dir, 'manual.json');
    writeJson(manual, { candidates: [
      { source_id: 'speeches-page', url: 'https://supervisor.example.gov/speeches/2026/ai-resilience', headline: 'Speech: AI and operational resilience expectations', published: '2026-10-01', lead: 'Remarks on third-party concentration and AI model risk.' },
    ] });
    const bad = path.join(dir, 'bad.json');
    writeJson(bad, { candidates: [{ source_id: 'speeches-page', url: 'https://elsewhere.example.com/x', headline: 'Off-site' }] });
    const common = ['--run', '2026-10-02-1400', '--sources', sourcesFile, '--seen', seen, '--work-dir', work, '--allow-http'];
    const badRun = runScript('add-manual', [...common, '--file', bad]);
    assert.equal(badRun.status, 1);
    assert.match(badRun.stderr, /not on Example speeches-page's site/);
    const addRun = runScript('add-manual', [...common, '--file', manual]);
    assert.equal(addRun.status, 0, addRun.stderr);
    assert.equal(addRun.json.added.length, 1);
    const cand2 = readJson(path.join(work, '2026-10-02-1400', 'candidates.json')).candidates;
    assert.equal(cand2.length, cand.length + 1);
    assert.equal(cand2.at(-1).manual, true);
    assert.equal(readJson(path.join(work, '2026-10-02-1400', 'fetch-report.json')).totals.in_window, report.totals.in_window + 1);
    assert.equal(runScript('add-manual', [...common, '--file', manual]).json.added.length, 0, 'idempotent');

    // stage 1 + dedup hints over the result
    const pf = runScript('prefilter', ['--run', '2026-10-02-1400', '--sources', sourcesFile, '--work-dir', work]);
    assert.equal(pf.status, 0, pf.stderr);
    const stage1 = readJson(path.join(work, '2026-10-02-1400', 'stage1.json'));
    assert.equal(stage1.counts.input, cand2.length);
    assert.equal(stage1.counts.seen, 1);
    assert.ok(stage1.survivors.every((s) => s.domains.length && typeof s.score === 'number'));
    assert.ok(stage1.survivors.some((s) => s.kev?.cve === 'CVE-2026-90001'), 'enterprise KEV entry survives');
    assert.ok(!stage1.survivors.some((s) => s.kev?.cve === 'CVE-2026-90002'), 'niche KEV entry dropped');
    assert.ok(stage1.survivors.some((s) => s.manual), 'manual regulator speech survives');
    const dh = runScript('dedup-hints', ['--run', '2026-10-02-1400', '--work-dir', work, '--archive', path.join(dir, 'archive-none.json'), '--thresholds', path.join(dir, 'none.json')]);
    assert.equal(dh.status, 0, dh.stderr);
    const hints = readJson(path.join(work, '2026-10-02-1400', 'dedup-hints.json'));
    assert.equal(hints.hints.length, stage1.survivors.length);
    assert.equal(hints.archive_window.days, 21);

    // unhealthy: most sources failing -> exit 3
    writeJson(sourcesFile, { schema_version: 1, sources: [src('a', `${base}/broken.xml`), src('b', `${base}/html`), src('c', `${base}/rss2.xml`)] });
    const unhealthy = await runAsync('fetch', ['--run', '2026-10-02-1800', '--now', '2026-10-02T18:05:00-04:00', '--sources', sourcesFile, '--seen', seen, '--runs', path.join(dir, 'runs.json'), '--work-dir', work, '--allow-http']);
    assert.equal(unhealthy.status, 3);
    assert.match(unhealthy.stderr, /UNHEALTHY/);
    assert.equal(unhealthy.json.healthy, false);

    // invalid registry -> exit 1 with the problems listed
    writeJson(sourcesFile, { schema_version: 1, sources: [{ id: 'Bad Id', publication: '', source_class: 'blog', type: 'rss', url: 'ftp://x', paywalled: 'no', region: 'MARS' }] });
    const invalid = await runAsync('fetch', ['--run', '2026-10-02-1800', '--sources', sourcesFile, '--work-dir', work]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /id: must be kebab-case/);
    assert.match(invalid.stderr, /url: must be an https URL/);
  } finally {
    server.close();
    rmrf(dir);
  }
});

test('fetch.mjs default window: previous successful run started_at - 6 h, floored at now - 72 h', () => {
  const dir = tempDir();
  try {
    const sourcesFile = path.join(dir, 'sources.json');
    writeJson(sourcesFile, { schema_version: 1, sources: [src('page-only', 'https://supervisor.example.gov/speeches', { type: 'page' })] });
    const runs = path.join(dir, 'runs.json');
    writeJson(runs, { schema_version: 1, runs: [
      { run_id: '2026-10-02-0600', status: 'published', started_at: '2026-10-02T06:02:00-04:00' },
      { run_id: '2026-10-02-1000', status: 'failed', started_at: '2026-10-02T10:02:00-04:00' },
    ] });
    const r = runScript('fetch', ['--run', '2026-10-02-1400', '--now', '2026-10-02T14:02:00-04:00', '--sources', sourcesFile, '--runs', runs, '--seen', path.join(dir, 's.json'), '--work-dir', path.join(dir, 'w')]);
    assert.equal(r.json.window.since, '2026-10-02T00:02:00-04:00');
    assert.equal(r.status, 3, 'no fetchable sources is unhealthy');
    writeJson(runs, { schema_version: 1, runs: [{ run_id: '2026-09-20-0600', status: 'silent', started_at: '2026-09-20T06:02:00-04:00' }] });
    const r2 = runScript('fetch', ['--run', '2026-10-02-1400', '--now', '2026-10-02T14:02:00-04:00', '--sources', sourcesFile, '--runs', runs, '--seen', path.join(dir, 's.json'), '--work-dir', path.join(dir, 'w')]);
    assert.equal(r2.json.window.since, '2026-09-29T14:02:00-04:00');
  } finally {
    rmrf(dir);
  }
});

test('slot.mjs reports the slot and whether it already ran', () => {
  const dir = tempDir();
  try {
    const runs = path.join(dir, 'runs.json');
    writeJson(runs, { schema_version: 1, runs: [{ run_id: '2026-10-02-1000', slot: '2026-10-02T10:00:00-04:00', status: 'silent', started_at: '2026-10-02T10:01:00-04:00', finished_at: '2026-10-02T10:09:00-04:00' }] });
    let r = runScript('slot', ['--now', '2026-10-02T13:59:59-04:00', '--runs', runs]);
    assert.equal(r.status, 0);
    assert.equal(r.json.run_id, '2026-10-02-1000');
    assert.equal(r.json.already_run, true);
    r = runScript('slot', ['--now', '2026-10-02T14:03:12-04:00', '--runs', runs]);
    assert.deepEqual([r.json.run_id, r.json.slot, r.json.already_run, r.json.id_stem], ['2026-10-02-1400', '2026-10-02T14:00:00-04:00', false, 'RS-261002-1400']);
    assert.equal(r.json.previous_run.run_id, '2026-10-02-1000');
    assert.equal(r.json.fetch_since, '2026-10-02T04:01:00-04:00');
    assert.equal(runScript('slot', ['--now', 'not-a-date']).status, 2);
  } finally {
    rmrf(dir);
  }
});

test('calibration.mjs: funnel, section pass rates, mechanism warning above 40% candidate_issue, reason codes', () => {
  const RUN = '2026-10-02-1400';
  const a = makeCandidate({ url: 'https://news.example.com/a', headline: 'Story A' });
  const b = makeCandidate({ url: 'https://news.example.com/b', headline: 'Story B' });
  const ws = workspace({
    runId: RUN,
    candidates: [a, b],
    survivors: [makeSurvivor(a), makeSurvivor(b)],
    decisions: { run_id: RUN, threshold_level: 'high', judgments: [judgment(a), judgment(b, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'NEAR C1: vendor advisory only', draft_index: null })], items: [makeDraft([a])] },
    startedAt: '2026-10-02T14:03:00-04:00',
  });
  try {
    assert.equal(runScript('publish', ['--run', RUN, '--now', '2026-10-02T14:20:00-04:00', ...ws.flags]).status, 0);
    const r = runScript('calibration', ['--json', '--runs', ws.runs, '--logs-dir', ws.logs, '--archive', ws.archive, '--thresholds', path.join(ws.dir, 'none.json'), '--now', '2026-10-03T00:00:00-04:00']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.runs.published, 1);
    assert.equal(r.json.funnel.published, 1);
    assert.equal(r.json.stage2_by_section.capability_shift.tested, 2);
    assert.equal(r.json.stage2_by_section.capability_shift.pass_rate, 0.5);
    assert.equal(r.json.mechanism_distribution.counts.candidate_issue, 1);
    assert.deepEqual(r.json.reason_codes, { CS_NO_SPECIFIC_CHANGE: 1, CS_PASS_CONTROL_FAILURE: 1 });
    assert.deepEqual(r.json.near_misses, { C1: 1 });
    assert.ok(r.json.warnings.some((w) => /candidate_issue is 100% of items/.test(w)));
    assert.match(r.stderr, /Mechanism distribution/);
    const human = runScript('calibration', ['--runs', ws.runs, '--logs-dir', ws.logs, '--archive', ws.archive, '--days', '1', '--now', '2026-10-03T00:00:00-04:00']);
    assert.match(human.stdout, /WARNING: candidate_issue/);
  } finally {
    rmrf(ws.dir);
  }
});

test('the repo sources.json, when present, is a valid registry', () => {
  const file = path.join(SCRIPTS, '..', 'sources.json');
  if (!fs.existsSync(file)) return;
  return import('../../pipeline/lib/sources.mjs').then(({ loadSources }) => {
    const { errors } = loadSources(file);
    assert.deepEqual(errors, []);
  });
});
