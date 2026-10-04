// backfill.mjs verify-urls and collect against a local HTTP server (no network beyond this
// machine): status, redirects on and off the site, soft 404s (title, heading, main text, canary),
// dead links answering 200 (home, error, search and parent redirects, meta refresh), the honest
// user agent only (every request the server sees carries it), one same-agent retry and
// Retry-After, access walls never bypassed, timeout, content type, url-check.json history and
// clock; KEV month filter and the paginated Federal Register API through the CLI; Federal
// Register documents verified through the API with a mocked fetch. FICTIONAL data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { USER_AGENT } from '../../pipeline/lib/collect.mjs';
import { checkUrl } from '../../pipeline/lib/backfill.mjs';
import { normaliseUrl } from '../../pipeline/lib/url.mjs';
import { isEtIso } from '../../pipeline/lib/time.mjs';
import { FIXTURES, SCRIPTS, fixture, readJson, rmrf, tempDir, writeJson } from './_helpers.mjs';

const MOCK = pathToFileURL(path.join(FIXTURES, 'backfill-mock-fetch.mjs')).href;

/** Run backfill.mjs; with `preload`, node --import <module> first (the fetch mock), `env` added. */
function runAsync(args, { preload = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), path.join(SCRIPTS, 'backfill.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
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

const HTML = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const NAV = `<nav>${Array.from({ length: 120 }, (_, i) => `<a href="/s${i}">Section link number ${i}</a>`).join(' ')}</nav>`;
const HOME = HTML('Example Agency', '<h1>Welcome to Example Agency</h1>');

function startServer() {
  const hits = [];
  const count = new Map();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push([u.pathname + u.search, req.headers['user-agent']]);
    count.set(u.pathname, (count.get(u.pathname) ?? 0) + 1);
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (status, body, type = 'text/html; charset=utf-8', headers = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    const redirect = (location, status = 301) => send(status, '', 'text/plain', { location });
    // a catch-all: every path under /esma-news/ answers the same listing (ESMA-like soft 404)
    if (u.pathname.startsWith('/esma-news/')) return send(200, HTML('ESMA News | Example Authority', `${NAV}<main><h2>News</h2><p>Latest items one two three four five six seven.</p></main>`));
    // a document resolved by its id; the trailing slug is decorative (Federal Register-like)
    if (/^\/documents\/2026\/01\/07\/2026-00085\/[^/]+$/.test(u.pathname)) return send(200, HTML('Fictional Rule on Resilience | Federal Register', '<main><h1>Fictional Rule on Resilience</h1><p>Rule text.</p></main>'));
    if (u.pathname === '/' && u.searchParams.has('p')) return redirect('/');
    switch (u.pathname) {
      // where dead links are commonly redirected (HIGH-1)
      case '/dead-to-home-alias': return redirect('/home');
      case '/dead-to-en': return redirect('/en/');
      case '/dead-to-index': return redirect('/index.html');
      case '/dead-to-root-query': return redirect('/?from=old-site');
      case '/home': case '/en/': case '/index.html': return send(200, HOME);
      case '/dead-to-meta': return redirect('/meta-refresh');
      case '/meta-refresh': return send(200, '<html><head><title>Example Agency</title><meta http-equiv="refresh" content="0; url=/"></head><body></body></html>');
      case '/old-a': return redirect('/404.html', 302);
      case '/404.html': return send(200, HTML('Example Agency', '<h1>Oops!</h1><p>That link is broken.</p>'));
      case '/old-b': return redirect('/page-not-found', 302);
      case '/page-not-found': return send(200, HTML('Example Agency', '<p>Try the search.</p>'));
      case '/old-c': return redirect('/search?q=old-c', 302);
      case '/search': return send(200, HTML('Search | Example Agency', '<p>0 results</p>'));
      case '/newsroom/2026/old-release': return redirect('/newsroom', 302);
      case '/newsroom': return send(200, HTML('Newsroom | Example Agency', '<h1>Press releases</h1>'));
      case '/longnav-404': return send(200, HTML('Example Agency', `${NAV}<main><h1>Page not found</h1></main>`));
      // busy once: 429 with Retry-After 1, then the page (one retry, same user agent)
      case '/busy':
        return count.get(u.pathname) === 1 ? send(429, 'slow down', 'text/plain', { 'retry-after': '1' }) : send(200, HTML('Fictional notice | Example Agency', '<p>Notice.</p>'));
      case '/2026/01/05/fictional-post/': return send(200, HTML('A fictional post | Example Blog', '<main><h1>A fictional post</h1><p>Post text.</p></main>'));
      case '/ok': return send(200, HTML('Fictional notice on resilience testing | Example Agency', '<h1>Fictional notice</h1><p>Rule 404 text.</p>'));
      case '/missing': return send(404, HTML('Not Found', 'gone'));
      case '/moved': return send(301, '', 'text/plain', { location: '/ok' });
      case '/chain': return send(302, '', 'text/plain', { location: `${base}/moved` });
      case '/offsite': return send(302, '', 'text/plain', { location: `http://localhost:${server.address().port}/ok` });
      case '/soft404': return send(200, HTML('Page not found | Example Agency', '<p>Sorry, we could not find that page.</p>'));
      case '/soft404-body': return send(200, HTML('Example Agency', '<nav>Home</nav><h1>The page you requested could not be found.</h1>'));
      // serves a browser only: the project user agent gets 403 (never bypassed)
      case '/botwall':
        return req.headers['user-agent'] === USER_AGENT ? send(403, 'Forbidden', 'text/plain') : send(200, HTML('Fictional speech', '<p>Speech text.</p>'));
      case '/always403': return send(403, 'Forbidden', 'text/plain');
      // a CDN bot challenge: 403 with an interstitial page
      case '/challenge': return send(403, HTML('Just a moment...', '<p>Checking your browser before accessing the site.</p>'));
      case '/slow': setTimeout(() => send(200, HTML('late', 'late')), 4000); return undefined;
      case '/': return send(200, HTML('Example Agency home', '<p>Welcome</p>'));
      case '/request-access': return send(200, HTML('Example Agency :: Request Access', '<p>Automated access is limited.</p>'));
      // walls the project user agent (a browser would get the page): never bypassed
      case '/walled':
        return req.headers['user-agent'] === USER_AGENT ? send(302, '', 'text/plain', { location: '/request-access' }) : send(200, HTML('Fictional rule text | Example Agency', '<p>Rule.</p>'));
      case '/wall-always': return send(302, '', 'text/plain', { location: '/request-access' });
      case '/gone-home': return send(301, '', 'text/plain', { location: '/' });
      case '/pdf': return send(200, '%PDF-1.7 fictional', 'application/pdf');
      case '/image': return send(200, 'PNG', 'image/png');
      case '/loop': return send(302, '', 'text/plain', { location: '/loop' });
      case '/kev.json': return send(200, fixture('backfill-kev.json'), 'application/json');
      case '/api/v1/documents.json': {
        const slug = u.searchParams.get('conditions[agencies][]');
        if (slug === 'broken-agency') return send(500, 'oops', 'text/plain');
        if (u.searchParams.get('page') === '2') return send(200, fixture('backfill-fr-page2.json'), 'application/json');
        if (slug === 'federal-reserve-system') return send(200, fixture('backfill-fr-page1.json').replace('__BASE__', base), 'application/json');
        if (slug === 'comptroller-of-the-currency') {
          const p1 = JSON.parse(fixture('backfill-fr-page1.json'));
          return send(200, JSON.stringify({ count: 1, total_pages: 1, results: [p1.results[0]] }), 'application/json');
        }
        return send(200, fixture('backfill-fr-empty.json'), 'application/json');
      }
      default: return send(404, 'not found', 'text/plain');
    }
  });
  // no host: dual-stack, so http://localhost:<port> (the "other domain") reaches it too
  return new Promise((resolve) => server.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, hits })));
}

const stop = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

test('checkUrl: verified only for a final 200 on the same site with an allowed type and no soft 404', async () => {
  const { server, base, hits } = await startServer();
  const opts = { allowHttp: true, timeoutMs: 1500 };
  try {
    const ok = await checkUrl(`${base}/ok`, opts);
    assert.equal(ok.verified, true);
    assert.equal(ok.status, 200);
    assert.equal(ok.reason, 'ok');
    assert.equal(ok.final_url, `${base}/ok`);
    assert.match(ok.content_type, /^text\/html/);
    assert.equal(ok.title, 'Fictional notice on resilience testing | Example Agency');
    assert.match(ok.checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[45]:00$/);
    const missing = await checkUrl(`${base}/missing`, opts);
    assert.deepEqual([missing.verified, missing.status, missing.reason], [false, 404, 'HTTP 404']);
    const moved = await checkUrl(`${base}/moved`, opts);
    assert.deepEqual([moved.verified, moved.status, moved.final_url, moved.redirects], [true, 200, `${base}/ok`, 1]);
    const chain = await checkUrl(`${base}/chain`, opts);
    assert.deepEqual([chain.verified, chain.redirects], [true, 2]);
    const off = await checkUrl(`${base}/offsite`, opts);
    assert.equal(off.verified, false);
    assert.equal(off.status, 200);
    assert.match(off.final_url, /^http:\/\/localhost:\d+\/ok$/);
    assert.match(off.reason, /^redirected off-site to localhost/);
    const soft = await checkUrl(`${base}/soft404`, opts);
    assert.equal(soft.verified, false);
    assert.match(soft.reason, /^soft 404: title "Page not found \| Example Agency"/);
    const softBody = await checkUrl(`${base}/soft404-body`, opts);
    assert.match(softBody.reason, /^soft 404: heading "The page you requested could not be found\." says "page you requested could not be found"/);
    // a page that refuses the project user agent: one retry with the same agent, then unverified
    // (the pipeline never retries as a browser)
    const wall = await checkUrl(`${base}/botwall`, opts);
    assert.deepEqual([wall.verified, wall.status, wall.retried, wall.retry_status, wall.reason], [false, 403, true, 403, 'HTTP 403 (retried once after HTTP 403)']);
    assert.equal(wall.user_agent, USER_AGENT);
    assert.equal('retried_with_browser_ua' in wall, false);
    assert.deepEqual(hits.filter(([p]) => p === '/botwall').map(([, ua]) => ua), [USER_AGENT, USER_AGENT]);
    const wall2 = await checkUrl(`${base}/always403`, opts);
    assert.deepEqual([wall2.verified, wall2.reason], [false, 'HTTP 403 (retried once after HTTP 403)']);
    // a bot challenge served with 403 is an access wall, not verified
    const challenge = await checkUrl(`${base}/challenge`, opts);
    assert.deepEqual([challenge.verified, challenge.status], [false, 403]);
    assert.equal(challenge.reason, 'access wall (HTTP 403): title "Just a moment..." (retried once after HTTP 403)');
    const slow = await checkUrl(`${base}/slow`, { ...opts, timeoutMs: 300 });
    assert.deepEqual([slow.verified, slow.status, slow.reason], [false, null, 'timeout after 300 ms']);
    // an access wall served with 200 is simply not verified: no retry, no other user agent
    const walled = await checkUrl(`${base}/walled`, opts);
    assert.deepEqual([walled.verified, walled.status, walled.retried, walled.final_url], [false, 200, false, `${base}/request-access`]);
    assert.equal(walled.reason, 'access wall: title "Example Agency :: Request Access"');
    assert.equal(hits.filter(([p]) => p === '/walled').length, 1, 'a wall is not retried');
    const wallAlways = await checkUrl(`${base}/wall-always`, opts);
    assert.deepEqual([wallAlways.verified, wallAlways.status, wallAlways.retried], [false, 200, false]);
    assert.equal(wallAlways.reason, 'access wall: title "Example Agency :: Request Access"');
    const home = await checkUrl(`${base}/gone-home`, opts);
    assert.equal(home.verified, false);
    assert.equal(home.reason, `redirected to the site's home page ${base}/ (a removed page or an access wall)`);
    assert.equal((await checkUrl(`${base}/`, opts)).verified, true, 'the home page itself is fine');
    const pdf = await checkUrl(`${base}/pdf`, opts);
    assert.deepEqual([pdf.verified, pdf.content_type], [true, 'application/pdf']);
    const img = await checkUrl(`${base}/image`, opts);
    assert.equal(img.verified, false);
    assert.match(img.reason, /content type "image\/png" is not HTML, PDF, XML or JSON/);
    const loop = await checkUrl(`${base}/loop`, opts);
    assert.deepEqual([loop.verified, loop.reason], [false, 'more than 10 redirects']);
    const http1 = await checkUrl(`${base}/ok`, { timeoutMs: 1500 });
    assert.deepEqual([http1.verified, http1.reason, http1.status], [false, 'not an https URL', null]);
    const down = await checkUrl('http://127.0.0.1:1/nothing', opts);
    assert.equal(down.verified, false);
    assert.match(down.reason, /fetch failed|ECONNREFUSED/);
    // a verified page records its canary probe, a 404 here
    assert.deepEqual([ok.verified_by, ok.canary.status, ok.canary.same_page], ['page', 404, false]);
    assert.match(ok.canary.url, new RegExp(`^${base}/rs-canary-[0-9a-f]{10}$`));
    // every request the server saw (pages, redirects, retries, canaries) carried the project user agent
    assert.ok(hits.length > 20);
    assert.deepEqual(hits.filter(([, ua]) => ua !== USER_AGENT), []);
  } finally {
    await stop(server);
  }
});

test('checkUrl: dead links that answer 200 are not verified (HIGH-1); live pages still are', async () => {
  const { server, base, hits } = await startServer();
  const opts = { allowHttp: true, timeoutMs: 3000 };
  const check = (p) => checkUrl(`${base}${p}`, opts);
  try {
    const cases = [
      ['/dead-to-home-alias', /^redirected to the site's home page .*\/home/],
      ['/dead-to-en', /^redirected to the site's home page .*\/en\//],
      ['/dead-to-index', /^redirected to the site's home page .*\/index\.html/],
      ['/dead-to-root-query', /^redirected to the site's home page .*\/\?from=old-site/],
      ['/?p=1234', /^redirected to the site's home page/],
      ['/dead-to-meta', /^redirected to the site's home page/],
      ['/old-a', /^redirected to an error page \/404\.html/],
      ['/old-b', /^redirected to an error page \/page-not-found/],
      ['/old-c', /^redirected to a search page \/search\?q=old-c/],
      ['/newsroom/2026/old-release', /^redirected to \/newsroom, a parent of the original path/],
      ['/longnav-404', /^soft 404: heading "Page not found"/],
      ['/esma-news/fictional-xyz', /^soft 404: a made-up sibling URL .*\/esma-news\/rs-canary-[0-9a-f]{10}\) answers 200 with the same page/],
    ];
    for (const [p, re] of cases) {
      const r = await check(p);
      assert.equal(r.verified, false, `${p}: ${r.reason}`);
      assert.match(r.reason, re, p);
    }
    const meta = await check('/dead-to-meta');
    assert.deepEqual([meta.redirects, meta.meta_refreshes, meta.final_url], [2, 1, `${base}/`]);
    // live pages whose canary answers 404: an id with a decorative slug, a dated blog post
    const rule = await check('/documents/2026/01/07/2026-00085/fictional-rule-on-resilience');
    assert.deepEqual([rule.verified, rule.canary.status], [true, 404], rule.reason);
    assert.match(rule.canary.url, /\/documents\/2026\/01\/07\/rs-canary-[0-9a-f]{10}\/fictional-rule-on-resilience$/);
    const post = await check('/2026/01/05/fictional-post/');
    assert.deepEqual([post.verified, post.canary.status], [true, 404], post.reason);
    // 429 with Retry-After: waited for, then one retry with the same user agent
    const t0 = Date.now();
    const busy = await check('/busy');
    assert.deepEqual([busy.verified, busy.retried, busy.retry_status, busy.reason], [true, true, 429, 'ok (retried once after HTTP 429)']);
    assert.ok(Date.now() - t0 >= 900, `waited ${Date.now() - t0} ms`);
    assert.deepEqual(hits.filter(([p]) => p === '/busy').map(([, ua]) => ua), [USER_AGENT, USER_AGENT]);
    assert.deepEqual(hits.filter(([, ua]) => ua !== USER_AGENT), [], 'only the project user agent');
  } finally {
    await stop(server);
  }
});

test('verify-urls CLI: records every check in url-check.json (history, newest on top, real clock), exit 3 on failures', async () => {
  const { server, base } = await startServer();
  const dir = tempDir('rs-bf-verify-');
  try {
    const work = path.join(dir, 'work');
    // a BF_URL_UNVERIFIED drop's URL is checked too (MED-8)
    const gone = { candidate_id: 'c-0000000001', url: `${base}/soft404` };
    writeJson(path.join(work, 'candidates.json'), { schema_version: 1, month: '2026-01', candidates: [gone] });
    const decisions = {
      run_id: 'backfill-2026-01',
      judgments: [{ candidate_id: gone.candidate_id, verdict: 'drop', reason_code: 'BF_URL_UNVERIFIED' }],
      items: [{ sources: [{ url: `${base}/ok` }, { url: `${base}/moved` }] }, { sources: [{ url: `${base}/missing` }, { url: `${base}/ok` }] }],
    };
    writeJson(path.join(work, 'decisions.json'), decisions);
    const common = ['--month', '2026-01', '--work-dir', work, '--allow-http', '--timeout-ms', '2000'];
    const before = Date.now();
    const r = await runAsync(['verify-urls', ...common]);
    assert.equal(r.status, 3, r.stderr);
    assert.equal(r.json.checked, 4, 'deduplicated by normalised URL');
    assert.equal(r.json.verified, 2);
    assert.deepEqual(r.json.failed.map((f) => [f.url, f.reason.slice(0, 8)]), [[`${base}/missing`, 'HTTP 404'], [gone.url, 'soft 404']]);
    const doc = readJson(path.join(work, 'url-check.json'));
    assert.equal(doc.month, '2026-01');
    const rec = doc.checks[normaliseUrl(`${base}/moved`)];
    assert.deepEqual([rec.status, rec.final_url, rec.verified, rec.reason], [200, `${base}/ok`, true, 'ok']);
    // stamped with the real clock (HIGH-2)
    assert.ok(isEtIso(rec.checked_at) && Math.abs(Date.parse(rec.checked_at) - before) < 60000, rec.checked_at);
    assert.equal(rec.history.length, 1);
    assert.match(r.stderr, /FAIL  404  HTTP 404/);
    // a later check of one URL goes on top of that record's history (LOW-12)
    const r2 = await runAsync(['verify-urls', ...common, '--url', `${base}/ok`]);
    assert.equal(r2.status, 0, r2.stderr);
    const doc2 = readJson(path.join(work, 'url-check.json'));
    assert.equal(Object.keys(doc2.checks).length, 4);
    assert.equal(doc2.checks[normaliseUrl(`${base}/ok`)].history.length, 2);
    assert.equal(doc2.checks[normaliseUrl(`${base}/missing`)].history.length, 1);
    // a record stamped in the future (a forged clock) never outranks a real check (HIGH-2)
    doc2.checks[normaliseUrl(`${base}/missing`)] = { url: `${base}/missing`, status: 200, final_url: `${base}/missing`, verified: true, reason: 'ok', checked_at: '2099-12-01T09:00:00-05:00', history: [] };
    writeJson(path.join(work, 'url-check.json'), doc2);
    const r3a = await runAsync(['verify-urls', ...common, '--url', `${base}/missing`]);
    assert.equal(r3a.status, 3);
    assert.match(r3a.stderr, /ignored a check of .*\/missing: checked_at 2099-12-01T09:00:00-05:00 is after the real time/);
    const missing = readJson(path.join(work, 'url-check.json')).checks[normaliseUrl(`${base}/missing`)];
    assert.deepEqual([missing.verified, missing.status, missing.history.length], [false, 404, 1]);
    // --now never applies to verify-urls
    const withNow = await runAsync(['verify-urls', ...common, '--now', '2026-12-01T09:00:00-05:00', '--url', `${base}/ok`]);
    assert.equal(withNow.status, 2);
    assert.match(withNow.stderr, /--now does not apply to verify-urls/);
    // --file with a plain list; one source of URLs at a time
    const list = path.join(dir, 'urls.json');
    writeJson(list, [`${base}/soft404`]);
    const r3 = await runAsync(['verify-urls', ...common, '--file', list]);
    assert.equal(r3.status, 3);
    assert.match(r3.json.failed[0].reason, /^soft 404/);
    const both = await runAsync(['verify-urls', ...common, '--file', list, '--url', `${base}/ok`]);
    assert.equal(both.status, 2);
  } finally {
    await stop(server);
    rmrf(dir);
  }
});

test('collect CLI: KEV month filter and paginated Federal Register rules merged into candidates.json', async () => {
  const { server, base, hits } = await startServer();
  const dir = tempDir('rs-bf-collect-');
  try {
    const work = path.join(dir, 'work');
    const sourcesFile = path.join(dir, 'sources.json');
    const fr = (id, slug, publication) => ({ id, publication, source_class: 'regulator', type: 'feed', url: `https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=${slug}&conditions%5Btype%5D%5B%5D=RULE`, paywalled: false, region: 'US', notes: 'fixture' });
    writeJson(sourcesFile, {
      schema_version: 1,
      sources: [
        { id: 'cisa-kev', publication: 'CISA', source_class: 'vendor_threat_research', type: 'cisa-kev', url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', paywalled: false, region: 'US', notes: 'fixture' },
        fr('fedreg-occ-final-rules', 'comptroller-of-the-currency', 'Office of the Comptroller of the Currency'),
        fr('fedreg-fed-final-rules', 'federal-reserve-system', 'Federal Reserve'),
        fr('fedreg-ncua-final-rules', 'national-credit-union-administration', 'National Credit Union Administration'),
      ],
    });
    const seen = path.join(dir, 'seen.json');
    writeJson(seen, { schema_version: 1, urls: {} });
    const args = ['collect', '--month', '2026-01', '--work-dir', work, '--sources', sourcesFile, '--seen', seen, '--allow-http',
      '--kev-url', `${base}/kev.json`, '--fr-api-url', `${base}/api/v1/documents.json`, '--now', '2026-10-04T12:00:00-04:00'];
    const r = await runAsync(args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.kev.catalogue_entries, 7);
    assert.equal(r.json.kev.in_window, 3);
    const byAgency = Object.fromEntries(r.json.federal_register.map((f) => [f.source_id, [f.status, f.in_window, f.pages, f.api_count]]));
    assert.deepEqual(byAgency, {
      'fedreg-occ-final-rules': ['ok', 1, 1, 1],
      'fedreg-fed-final-rules': ['ok', 3, 2, 5],
      'fedreg-ncua-final-rules': ['ok', 0, 1, 0],
    });
    // the joint rule came back from two agency queries: one candidate, issued by the OCC, also in the Fed's feed
    assert.equal(r.json.totals.collected, 7);
    assert.equal(r.json.totals.duplicates_in_run, 1);
    assert.equal(r.json.totals.added, 6);
    const doc = readJson(path.join(work, 'candidates.json'));
    assert.equal(doc.month, '2026-01');
    assert.equal(doc.candidates.length, 6);
    const joint = doc.candidates.find((c) => c.fr?.document_number === '2026-90001');
    assert.equal(joint.publication, 'Office of the Comptroller of the Currency');
    assert.deepEqual(joint.also_in, ['fedreg-fed-final-rules']);
    assert.ok(doc.candidates.every((c) => c.discovery_mode === 'archive' && c.published_precision === 'date' && c.seen === false));
    assert.deepEqual(doc.candidates.filter((c) => c.kev).map((c) => c.kev.cve), ['CVE-2026-91001', 'CVE-2026-91002', 'CVE-2026-91003']);
    // the API query: RULE, the month's bounds, page 2 followed from next_page_url
    const q = hits.find(([p]) => p.includes('federal-reserve-system'))[0];
    assert.match(decodeURIComponent(q), /conditions\[type\]\[\]=RULE/);
    assert.match(decodeURIComponent(q), /conditions\[publication_date\]\[gte\]=2026-01-01/);
    assert.match(decodeURIComponent(q), /conditions\[publication_date\]\[lte\]=2026-01-31/);
    assert.ok(hits.some(([p]) => p === '/api/v1/documents.json?page=2'));
    const report = readJson(path.join(work, 'collect-report.json'));
    assert.equal(report.totals.candidates, 6);
    // re-running merges: nothing new
    const again = await runAsync(args);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.json.totals.added, 0);
    assert.equal(again.json.totals.already_registered, 6);
    assert.equal(readJson(path.join(work, 'candidates.json')).candidates.length, 6);
    // a failing agency is reported, the rest still merge, exit 3
    const withBroken = readJson(sourcesFile);
    withBroken.sources.push(fr('fedreg-broken', 'broken-agency', 'Broken Agency'));
    writeJson(sourcesFile, withBroken);
    const partial = await runAsync([...args, '--only', 'federal-register']);
    assert.equal(partial.status, 3);
    assert.equal(partial.json.kev, null);
    assert.match(partial.json.federal_register.find((f) => f.source_id === 'fedreg-broken').error, /HTTP 500/);
    assert.equal(partial.json.user_agent, USER_AGENT);
    assert.deepEqual(hits.filter(([, ua]) => ua !== USER_AGENT), [], 'only the project user agent');
  } finally {
    await stop(server);
    rmrf(dir);
  }
});

test('verify-urls CLI: Federal Register documents through the API only (mocked fetch), walls unverified, honest user agent', async () => {
  const dir = tempDir('rs-bf-fr-');
  try {
    const work = path.join(dir, 'work');
    const FR = 'https://www.federalregister.gov';
    const doc = (date, num, slug) => `${FR}/documents/${date.replace(/-/g, '/')}/${num}/${slug}`;
    const api = (num) => `${FR}/api/v1/documents/${num}.json`;
    const json = (o) => ({ status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(o) });
    const cand = (id, url, date) => ({ candidate_id: id, url, published_date: date, published_precision: 'date', publication: 'Example Agency', source_class: 'regulator' });
    const good = cand('c-0000000101', doc('2026-01-07', '2026-90085', 'fictional-rule-on-resilience'), '2026-01-07');
    const shifted = cand('c-0000000102', doc('2026-01-12', '2026-90086', 'fictional-amendment'), '2026-01-12');
    const gone = cand('c-0000000103', doc('2026-01-20', '2026-90087', 'fictional-withdrawn-rule'), '2026-01-20');
    const other = cand('c-0000000104', doc('2026-01-21', '2026-90088', 'fictional-notice'), '2026-01-21');
    const walledPage = cand('c-0000000105', 'https://agency.example.gov/news/2026/fictional-release', '2026-01-08');
    writeJson(path.join(work, 'candidates.json'), { schema_version: 1, month: '2026-01', candidates: [good, shifted, gone, other, walledPage] });
    const routes = {
      // the slug in the API's html_url differs from the source URL's: same document
      [api('2026-90085')]: json({ document_number: '2026-90085', title: 'Fictional Rule on Resilience', html_url: doc('2026-01-07', '2026-90085', 'fictional-rule-on-operational-resilience'), publication_date: '2026-01-07' }),
      [api('2026-90086')]: json({ document_number: '2026-90086', title: 'Fictional Amendment', html_url: doc('2026-01-12', '2026-90086', 'fictional-amendment'), publication_date: '2026-01-13' }),
      [api('2026-90087')]: { status: 404, type: 'application/json', body: '{"errors":{"document_number":"not found"}}' },
      // the API names a different document
      [api('2026-90088')]: json({ document_number: '2026-90099', title: 'Another', html_url: doc('2026-01-21', '2026-90099', 'another'), publication_date: '2026-01-21' }),
      // the HTML document pages answer a non-browser agent with an access wall; they must never be fetched
      ...Object.fromEntries([good, shifted, gone, other].map((c) => [c.url, { status: 302, redirect: 'https://unblock.federalregister.gov/' }])),
      'https://unblock.federalregister.gov/': { status: 200, body: '<html><head><title>Federal Register :: Request Access</title></head><body>Request access</body></html>' },
      // an ordinary page that redirects the project agent to a challenge host: not verified
      [walledPage.url]: { status: 302, redirect: 'https://challenge.example-cdn.net/?return=agency' },
      'https://challenge.example-cdn.net/?return=agency': { status: 200, body: '<html><head><title>One more step</title></head><body>Checking</body></html>' },
    };
    const routesFile = path.join(dir, 'routes.json');
    writeJson(routesFile, routes);
    const fetchLog = path.join(dir, 'fetch-log.jsonl');
    const r = await runAsync(['verify-urls', '--month', '2026-01', '--work-dir', work, '--candidates'], { preload: MOCK, env: { RS_BACKFILL_MOCK_FETCH: routesFile, RS_BACKFILL_MOCK_FETCH_LOG: fetchLog } });
    assert.equal(r.status, 3, r.stderr);
    assert.deepEqual([r.json.checked, r.json.verified], [5, 1]);
    const checks = readJson(path.join(work, 'url-check.json')).checks;
    const rec = (c) => checks[normaliseUrl(c.url)];
    const g = rec(good);
    assert.deepEqual([g.verified, g.verified_by, g.status, g.final_url], [true, 'federalregister-api', 200, api('2026-90085')]);
    assert.equal(g.reason, 'ok: document 2026-90085 in the Federal Register API (publication_date 2026-01-07)');
    assert.deepEqual(g.fr, { document_number: '2026-90085', api_url: api('2026-90085'), html_url: doc('2026-01-07', '2026-90085', 'fictional-rule-on-operational-resilience'), publication_date: '2026-01-07', expected_date: '2026-01-07', title: 'Fictional Rule on Resilience' });
    assert.equal(g.history.at(-1).fr.publication_date, '2026-01-07', 'the history keeps the API record');
    assert.match(rec(shifted).reason, /publication_date 2026-01-13 is not the candidate's date 2026-01-12$/);
    assert.match(rec(gone).reason, /^Federal Register API .*2026-90087\.json: HTTP 404$/);
    assert.match(rec(other).reason, /html_url .*2026-90099\/another is not the source URL's document \/documents\/2026\/01\/21\/2026-90088$/);
    assert.equal(rec(walledPage).verified, false);
    assert.match(rec(walledPage).reason, /^access wall at challenge\.example-cdn\.net/);
    const requests = fs.readFileSync(fetchLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // the Federal Register document pages were never requested: only their API records
    assert.deepEqual(requests.filter((q) => q.url.startsWith(`${FR}/documents/`)), []);
    assert.deepEqual(requests.filter((q) => q.url.startsWith(`${FR}/api/`)).map((q) => q.url).sort(), ['2026-90085', '2026-90086', '2026-90087', '2026-90088'].map(api));
    // every request carried the honest project user agent
    assert.ok(requests.length >= 6);
    assert.deepEqual(requests.filter((q) => q.ua !== USER_AGENT), []);
  } finally {
    rmrf(dir);
  }
});
