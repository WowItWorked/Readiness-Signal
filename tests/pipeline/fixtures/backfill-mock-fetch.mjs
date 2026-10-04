// TEST PRELOAD ONLY (node --import): replaces globalThis.fetch so backfill.mjs subcommands can
// "check" FICTIONAL https URLs offline. Never imported by pipeline code.
//
// RS_BACKFILL_MOCK_FETCH names a JSON file of routes keyed by exact URL:
//   { "<url>": { "status": 200, "type": "text/html; charset=utf-8", "body": "...", "headers": {} }
//            | { "status": 301, "redirect": "<location>" }
//            | { ..., "touch": { "file": "<path>", "append": "<text>" } } }
// "touch" appends to a file when the URL is fetched (a concurrent writer). Any other URL, such as
// a canary, answers 404. RS_BACKFILL_MOCK_FETCH_LOG, when set, receives one JSON line per request.
import fs from 'node:fs';

const file = process.env.RS_BACKFILL_MOCK_FETCH;
const routes = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const logFile = process.env.RS_BACKFILL_MOCK_FETCH_LOG;

globalThis.fetch = async (input, init = {}) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? input);
  const headers = init.headers ?? {};
  const ua = typeof headers.get === 'function' ? headers.get('user-agent') : headers['user-agent'];
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ url, ua: ua ?? null })}\n`);
  const r = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : null;
  if (!r) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  if (r.touch) fs.appendFileSync(r.touch.file, r.touch.append ?? '');
  if (r.redirect) return new Response(null, { status: r.status ?? 301, headers: { location: r.redirect } });
  return new Response(r.body ?? '', { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'text/html; charset=utf-8', ...(r.headers ?? {}) } });
};
