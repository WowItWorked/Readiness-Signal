// scripts/serve.mjs: sub-path emulation, redirects, MIME types, no-cache, fixture swap,
// traversal protection. Each server binds an ephemeral loopback port.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { start, parseArgs } from '../../scripts/serve.mjs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

function get(port, path, method = 'GET') {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

describe('serve.mjs', () => {
  let live;
  let fx;
  before(async () => {
    live = await start({ port: 0 });
    fx = await start({ port: 0, fixtures: true });
  });
  after(async () => {
    await live.close();
    await fx.close();
  });

  test('argument parsing', () => {
    assert.deepEqual(parseArgs([]), { port: 8148, fixtures: false });
    assert.deepEqual(parseArgs(['--port', '8149']), { port: 8149, fixtures: false });
    assert.deepEqual(parseArgs(['--fixtures', '--port=9000']), { port: 9000, fixtures: true });
    assert.throws(() => parseArgs(['--port', 'abc']));
    assert.throws(() => parseArgs(['--nope']));
  });

  test('redirects / and the bare sub-path to /readiness-signal/', async () => {
    const a = await get(live.port, '/');
    assert.equal(a.status, 302);
    assert.equal(a.headers.location, '/readiness-signal/');
    const b = await get(live.port, '/readiness-signal');
    assert.equal(b.status, 302);
    assert.equal(b.headers.location, '/readiness-signal/');
  });

  test('serves the site with correct MIME types and no-cache headers', async () => {
    const cases = [
      ['/readiness-signal/', 'text/html; charset=utf-8'],
      ['/readiness-signal/index.html', 'text/html; charset=utf-8'],
      ['/readiness-signal/assets/app.js', 'text/javascript; charset=utf-8'],
      ['/readiness-signal/assets/app.css', 'text/css; charset=utf-8'],
      ['/readiness-signal/favicon.svg', 'image/svg+xml'],
      ['/readiness-signal/data/archive.json', 'application/json; charset=utf-8'],
    ];
    for (const [path, type] of cases) {
      const r = await get(live.port, path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers['content-type'], type, path);
      assert.match(r.headers['cache-control'], /no-cache/, path);
    }
    const head = await get(live.port, '/readiness-signal/assets/app.js', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal((await get(live.port, '/readiness-signal/', 'POST')).status, 405);
  });

  test('live mode serves docs/data; --fixtures swaps in tests/fixtures inside the server only', async () => {
    assert.equal((await get(live.port, '/readiness-signal/data/archive.json')).body, read('docs/data/archive.json'));
    assert.equal((await get(live.port, '/readiness-signal/data/runs.json')).body, read('docs/data/runs.json'));
    assert.equal((await get(fx.port, '/readiness-signal/data/archive.json')).body, read('tests/fixtures/archive.json'));
    assert.equal((await get(fx.port, '/readiness-signal/data/runs.json')).body, read('tests/fixtures/runs.json'));
    assert.equal((await get(fx.port, '/readiness-signal/index.html')).body, read('docs/index.html'));
  });

  test('does not serve outside /docs', async () => {
    for (const p of ['/readiness-signal/..%2f..%2fpackage.json', '/readiness-signal/..%5c..%5cpackage.json',
      '/readiness-signal/%2e%2e/SPEC.md', '/package.json', '/readiness-signal/../tests/fixtures/archive.json']) {
      const r = await get(live.port, p);
      assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.ok(!r.body.includes('"readiness-signal"'), p);
    }
    assert.equal((await get(live.port, '/readiness-signal/missing.js')).status, 404);
  });
});
