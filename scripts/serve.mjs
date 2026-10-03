#!/usr/bin/env node
// Zero-dependency static server for local preview (SPEC §8).
//
//   node scripts/serve.mjs [--port 8148] [--fixtures]
//
// Serves /docs under /Readiness-Signal/ (GitHub Pages sub-path emulation) and redirects / there.
// --fixtures answers data/archive.json and data/runs.json from tests/fixtures/ inside this server
// only; nothing is copied into /docs and the site has no fixture-loading code.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DOCS = join(ROOT, 'docs');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const BASE = '/Readiness-Signal/';
const DEFAULT_PORT = 8148;

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
});

export function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, fixtures: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixtures') opts.fixtures = true;
    else if (a === '--port' || a.startsWith('--port=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`--port: not a valid port: ${v}`);
      opts.port = n;
    } else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function redirect(res, location) {
  res.writeHead(302, { ...HEADERS, Location: location, 'Content-Length': 0 });
  res.end();
}

/** Map a request path under BASE to a file on disk, or null when it escapes /docs. */
export function resolvePath(rel, { fixtures = false } = {}) {
  if (fixtures && (rel === 'data/archive.json' || rel === 'data/runs.json')) {
    return join(FIXTURES, rel.slice('data/'.length));
  }
  const target = normalize(join(DOCS, rel));
  if (target !== DOCS && !target.startsWith(DOCS + sep)) return null;
  return target;
}

export function createHandler(opts = {}) {
  return async function handle(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, 'Method not allowed\n', undefined, { Allow: 'GET, HEAD' });
      }
      const url = new URL(req.url, 'http://localhost');
      let path;
      try { path = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request\n'); }
      if (path.includes('\0')) return send(res, 400, 'Bad request\n');
      if (path === '/' || path === '/index.html') return redirect(res, BASE);
      if (path === BASE.slice(0, -1)) return redirect(res, BASE + url.search);
      if (!path.startsWith(BASE)) return send(res, 404, 'Not found. The site is served under /Readiness-Signal/\n');

      let rel = path.slice(BASE.length);
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      let file = resolvePath(rel, opts);
      if (!file) return send(res, 403, 'Forbidden\n');

      let info;
      try { info = await stat(file); } catch { return send(res, 404, 'Not found\n'); }
      if (info.isDirectory()) {
        if (!path.endsWith('/')) return redirect(res, `${path}/`);
        file = join(file, 'index.html');
        try { info = await stat(file); } catch { return send(res, 404, 'Not found\n'); }
      }
      const body = await readFile(file);
      const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { ...HEADERS, 'Content-Type': type, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      if (!res.headersSent) send(res, 500, 'Internal error\n');
      else res.end();
      console.error(err);
    }
  };
}

/** Listen on loopback (IPv4, plus IPv6 when available). Resolves with the bound port. */
export function start(opts = {}) {
  const handler = createHandler(opts);
  const servers = [];
  const listen = (host, port) => new Promise((ok, fail) => {
    const s = createServer(handler);
    s.once('error', fail);
    s.listen(port, host, () => { servers.push(s); ok(s.address().port); });
  });
  return listen('127.0.0.1', opts.port ?? DEFAULT_PORT).then(async (port) => {
    try { await listen('::1', port); } catch { /* no IPv6 loopback: IPv4 is enough */ }
    return { port, close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))) };
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`serve: ${err.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log('Usage: node scripts/serve.mjs [--port 8148] [--fixtures]');
    process.exit(0);
  }
  start(opts).then(({ port }) => {
    const mode = opts.fixtures ? ' with FICTIONAL fixture data from tests/fixtures/' : '';
    console.log(`Readiness Signal: http://localhost:${port}${BASE}${mode}`);
  }).catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? `serve: port ${opts.port} is already in use (try --port)` : `serve: ${err.message}`);
    process.exit(1);
  });
}
