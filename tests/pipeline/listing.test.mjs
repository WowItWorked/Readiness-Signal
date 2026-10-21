// Listing sources (owner audit 2026-10-21): publishers' listing pages parsed by the collector with
// the source's own pattern (feed.mjs parseListing), their registry validation, and the collector's
// label for hosts the cloud environment refuses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListing } from '../../pipeline/lib/feed.mjs';
import { collectSource } from '../../pipeline/lib/collect.mjs';
import { validateSources, loadSources } from '../../pipeline/lib/sources.mjs';
import { ROOT } from './_helpers.mjs';
import path from 'node:path';

const PAGE = `<ul>
  <li><strong><a href="&#x2f;news&#x2f;pdf&#x2f;N2.pdf" class="text-reset">Regulator consults on AI &amp; cloud</a></strong><br /> 14 Oct 2026</li>
  <li><strong><a href="&#x2f;news&#x2f;pdf&#x2f;N1.pdf" class="text-reset">Older <em>release</em></a></strong><br /> 05 Oct 2026</li>
  <li><strong><a href="&#x2f;news&#x2f;pdf&#x2f;N1.pdf" class="text-reset">Duplicate link</a></strong><br /> 05 Oct 2026</li>
</ul>`;
const ITEM = '<strong>\\s*<a href="(?<url>[^"]+)"[^>]*class="text-reset">(?<title>[\\s\\S]*?)</a>\\s*</strong>\\s*<br\\s*/?>\\s*(?<date>\\d{1,2} [A-Z][a-z]{2} \\d{4})';

test('parseListing: entities decoded, links resolved, markup stripped, duplicates once, date-only dates', () => {
  const p = parseListing(PAGE, { baseUrl: 'https://www.example.org/media/?s=1', listing: { item: ITEM } });
  assert.equal(p.format, 'listing');
  assert.deepEqual(p.entries.map((e) => [e.title, e.link, e.date_only]), [
    ['Regulator consults on AI & cloud', 'https://www.example.org/news/pdf/N2.pdf', '2026-10-14'],
    ['Older release', 'https://www.example.org/news/pdf/N1.pdf', '2026-10-05'],
  ]);
  assert.throws(() => parseListing('<p>redesigned</p>', { baseUrl: 'https://www.example.org/', listing: { item: ITEM } }), /matched no entries/);
});

test('parseListing: anchors become the page URL with a fragment; a JSON-embedded list is unescaped first', () => {
  const az = '<button data-target="#incident-history-collapse-AB12" x><span class="hide-text">09/30/2026</span><div class="t">Post Incident Review – Gateway</div>';
  const a = parseListing(az, { baseUrl: 'https://status.example.com/history/#top', listing: { item: 'data-target="#(?<anchor>incident-history-collapse-[^"]+)"[\\s\\S]*?<span class="hide-text">(?<date>[^<]+)</span>\\s*<div class="t">(?<title>[^<]+)</div>' } });
  assert.equal(a.entries[0].link, 'https://status.example.com/history/#incident-history-collapse-AB12');
  assert.equal(a.entries[0].date_only, '2026-09-30');
  const js = '{"body":"<ul>\\n <li><a href=\\"/message/101925/\\">Summary of the event</a>&nbsp;October 19, 2026\\n</li></ul>"}';
  const j = parseListing(js, { baseUrl: 'https://aws.example.com/pes/', listing: { unescape: 'json', item: '<li><a href="(?<url>[^"]+)">(?<title>Summary of[^<]*)</a>(?:&nbsp;|\\s)*(?<date>[A-Z][a-z]+ \\d{1,2}, \\d{4})' } });
  assert.deepEqual([j.entries[0].link, j.entries[0].date_only], ['https://aws.example.com/message/101925/', '2026-10-19']);
});

test('sources.json: listing patterns are validated; the registry has no page sources left', () => {
  const base = { id: 'x-news', publication: 'X', source_class: 'regulator', type: 'listing', url: 'https://x.example.org/news', paywalled: false, region: 'US', notes: '' };
  assert.deepEqual(validateSources({ schema_version: 1, sources: [{ ...base, listing: { item: ITEM } }] }).errors, []);
  const err = (listing, extra = {}) => validateSources({ schema_version: 1, sources: [{ ...base, ...extra, listing }] }).errors.join('\n');
  assert.match(err(undefined), /required/);
  assert.match(err({ item: '(?<title>a)(?<url>b)' }), /title and date/);
  assert.match(err({ item: '(?<title>a)(?<date>b)' }), /exactly one of the named groups url or anchor/);
  assert.match(err({ item: '(?<title>[' }), /does not compile/);
  assert.match(err({ item: ITEM, unescape: 'xml' }), /unescape/);
  assert.match(err({ item: ITEM }, { type: 'feed' }), /only a source of type "listing"/);
  const reg = loadSources(path.join(ROOT, 'pipeline', 'sources.json'));
  assert.deepEqual([reg.errors, reg.warnings], [[], []]);
  assert.equal(reg.sources.filter((s) => s.type === 'page').length, 0, 'every former page source is a listing');
  assert.ok(reg.sources.filter((s) => s.tier === 'general' && s.enabled !== false).length >= 15);
  assert.equal(reg.sources.find((s) => s.id === 'techcrunch-security').tier, 'trade', 'FILTER 2.7.4: technology titles are trade press');
});

test('collectSource: a listing source yields candidates; an egress-policy 403 is labelled as the environment, not the publisher', async () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const fetchImpl = async (url) => (String(url).includes('blocked')
    ? new Response('Blocked by egress policy', { status: 403 })
    : new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } }));
  const src = { id: 'x-media', publication: 'X', source_class: 'regulator', type: 'listing', url: 'https://www.example.org/media/', paywalled: false, region: 'INTL', notes: '', listing: { item: ITEM } };
  const ok = await collectSource(src, { since: new Date('2026-10-10T00:00:00Z'), now, timeoutMs: 1000, fetchImpl });
  assert.equal(ok.report.status, 'ok');
  assert.equal(ok.report.format, 'listing');
  assert.deepEqual(ok.candidates.map((c) => c.headline), ['Regulator consults on AI & cloud']);
  const blocked = await collectSource({ ...src, type: 'feed', listing: undefined, url: 'https://blocked.example.org/rss' }, { since: new Date('2026-10-10T00:00:00Z'), now, timeoutMs: 1000, fetchImpl });
  assert.equal(blocked.report.status, 'failed');
  assert.match(blocked.report.error, /blocked by the environment's network policy, not the publisher/);
});
