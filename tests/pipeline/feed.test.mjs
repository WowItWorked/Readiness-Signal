import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, elementText, feedDateOnly, makeLead, parseFeed, parseFeedDate, leadWordsFor } from '../../pipeline/lib/feed.mjs';
import { feedCandidates } from '../../pipeline/lib/collect.mjs';
import { fixture } from './_helpers.mjs';

test('RSS 2.0: CDATA, entities, tracking params kept for later normalisation, HTML stripped, no body stored', () => {
  const f = parseFeed(fixture('rss2.xml'), { baseUrl: 'https://news.example.com/feed/' });
  assert.equal(f.format, 'rss');
  assert.equal(f.title, 'Example Security Wire');
  assert.equal(f.entries.length, 4);
  const [a, b, c, d] = f.entries;
  assert.equal(a.title, 'Attackers exploit zero-day in Example Gateway & VPN appliances');
  assert.equal(a.link, 'https://news.example.com/2026/10/gateway-zero-day/?utm_source=rss&utm_medium=feed');
  assert.equal(a.published, '2026-10-02T13:15:00.000Z');
  assert.equal(a.lead, 'Threat actors are actively exploiting a pre-authentication flaw in Example Gateway devices, the vendor said on Friday.');
  const all = JSON.stringify(f);
  assert.ok(!all.includes('FULL BODY TEXT'), 'content:encoded must never be read');
  assert.ok(!all.includes('Media title'), 'media:title must not replace the title');
  assert.ok(!all.includes('appeared first on'), 'WordPress tail stripped');
  // numeric + hex entities, curly quotes, relative link, dc:date, double-escaped HTML
  assert.equal(b.title, 'Regulator’s speech flags AI model risk — “early signal”');
  assert.equal(b.link, 'https://news.example.com/2026/10/regulator-speech-ai/');
  assert.equal(b.published, '2026-10-01T18:30:00.000Z');
  assert.equal(b.lead, 'A deputy governor said firms & vendors must evidence model validation.');
  // missing date, permalink guid as link
  assert.equal(c.published, null);
  assert.equal(c.link, 'https://news.example.com/2026/10/undated-item');
  // date-only publication (midnight GMT) is flagged as such
  assert.equal(d.published, '2026-09-30T00:00:00.000Z');
  assert.equal(d.date_only, '2026-09-30');
});

test('lead is the first N words; paywalled sources are capped at 40', () => {
  const f = parseFeed(fixture('rss2.xml'), { leadWords: 60 });
  const lead = f.entries[3].lead;
  assert.equal(lead.split(' ').filter((w) => w !== '…').length, 60);
  assert.ok(lead.endsWith('…'));
  const f40 = parseFeed(fixture('rss2.xml'), { leadWords: leadWordsFor({ paywalled: true, lead_words: 60 }) });
  assert.equal(f40.entries[3].lead.split(' ').filter((w) => w !== '…').length, 40);
  assert.equal(leadWordsFor({ paywalled: false }), 60);
  assert.equal(leadWordsFor({ paywalled: false, lead_words: 25 }), 25);
  assert.equal(leadWordsFor({ paywalled: true }), 40);
  assert.equal(makeLead('a b c', 0), '');
});

test('Atom: rel=alternate link, xml:base, summary not content, nested source ignored, updated fallback', () => {
  const f = parseFeed(fixture('atom.xml'), { baseUrl: 'https://research.example.org/atom.xml' });
  assert.equal(f.format, 'atom');
  assert.equal(f.title, 'Example Research Notes');
  assert.equal(f.entries.length, 3);
  const [a, b, c] = f.entries;
  assert.equal(a.title, 'Loss data study quantifies third-party outage costs');
  assert.equal(a.link, 'https://research.example.org/notes/2026/outage-costs');
  assert.equal(a.published, '2026-10-02T12:00:00.000Z');
  assert.equal(a.lead, 'An analysis of 400 incidents estimates median losses per outage hour.');
  assert.ok(!JSON.stringify(f).includes('FULL ATOM CONTENT'));
  assert.ok(!JSON.stringify(f).includes('Upstream Syndication'));
  assert.equal(b.published, '2026-09-30T12:00:00.000Z');
  assert.equal(b.link, 'https://research.example.org/notes/2026/updated-only');
  assert.equal(c.published, null);
  assert.equal(c.link, 'https://research.example.org/notes/2026/no-date');
  assert.equal(c.lead, '');
});

test('RSS 1.0 (RDF): items outside channel, rdf:about fallback link, date-only dc:date', () => {
  const f = parseFeed(fixture('rdf.xml'));
  assert.equal(f.format, 'rdf');
  assert.equal(f.title, 'Example Central Bank Speeches');
  assert.equal(f.entries.length, 2);
  assert.equal(f.entries[0].title, 'Operational resilience and third-party concentration');
  assert.equal(f.entries[0].date_only, '2026-10-01');
  assert.equal(f.entries[1].link, 'https://cb.example.int/speeches/2026-09-29-monetary');
  assert.equal(f.entries[1].published, '2026-09-29T08:00:00.000Z');
  assert.equal(f.entries[1].date_only, null);
});

test('junk before the XML declaration (and a BOM) is tolerated', () => {
  const bom = String.fromCharCode(0xfeff);
  const f = parseFeed(bom + fixture('junk-prefix.xml'));
  assert.equal(f.format, 'rss');
  assert.equal(f.entries.length, 1);
  assert.equal(f.entries[0].title, 'Association issues advisory on payment diversion fraud & mule accounts');
  assert.equal(f.entries[0].published, '2026-10-01T13:00:00.000Z');
});

test('non-feed documents are rejected with a clear error', () => {
  assert.throws(() => parseFeed('<!doctype html><html><body>Not a feed</body></html>'), /not a recognised feed/);
});

test('entities and dates', () => {
  assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&apos;&#39;&#x27;&eacute;&Uuml;&hellip;&#146;&nbsp;&bogus;'), `&<>"'''éÜ…’ &bogus;`);
  assert.equal(elementText('&lt;b&gt;Bold&lt;/b&gt; &amp;amp; more'), 'Bold & more');
  assert.equal(parseFeedDate('Fri, 02 Oct 2026 14:00:00 EDT'), '2026-10-02T18:00:00.000Z');
  assert.equal(parseFeedDate('Fri, 02 Oct 2026 14:00:00 BST'), '2026-10-02T13:00:00.000Z');
  // zone-less timestamps are UTC on every machine (never the local zone)
  assert.equal(parseFeedDate('2026-10-02 14:00:00'), '2026-10-02T14:00:00.000Z');
  assert.equal(parseFeedDate('2026-10-02T14:00:00'), '2026-10-02T14:00:00.000Z');
  assert.equal(parseFeedDate('Fri, 02 Oct 2026 14:00:00'), '2026-10-02T14:00:00.000Z');
  assert.equal(parseFeedDate('October 2, 2026'), '2026-10-02T00:00:00.000Z');
  assert.equal(parseFeedDate('2026-10-02'), '2026-10-02T00:00:00.000Z');
  assert.equal(parseFeedDate('2026-10-02T14:00:00+01:00'), '2026-10-02T13:00:00.000Z');
  assert.equal(parseFeedDate('not a date'), null);
  assert.equal(parseFeedDate(''), null);
  assert.equal(feedDateOnly('2026-10-02'), '2026-10-02');
  assert.equal(feedDateOnly('2026-10-02T00:00:00+02:00'), '2026-10-02');
  assert.equal(feedDateOnly('Tue, 1 Sep 2026 00:00:00 GMT'), '2026-09-01');
  assert.equal(feedDateOnly('Tue, 1 Sep 2026 10:00:00 GMT'), null);
});

test('feedCandidates applies the window, keeps date-only items by calendar date, skips future-dated listings', () => {
  const source = { id: 'example-news', publication: 'Example Security Wire', source_class: 'news', region: 'US', paywalled: false };
  const parsed = parseFeed(fixture('rss2.xml'), { baseUrl: 'https://news.example.com/feed/' });
  parsed.entries.push({ title: 'Event listing next month', link: 'https://news.example.com/events/x', published: '2026-11-20T15:00:00.000Z', date_only: null, lead: '' });
  // window starts 2026-09-30 10:00 ET: the date-only 2026-09-30 item is kept by date
  const r = feedCandidates(source, parsed, { since: new Date('2026-09-30T14:00:00Z'), now: new Date('2026-10-02T18:10:00Z') });
  const heads = r.candidates.map((c) => c.headline);
  assert.ok(heads.includes('Date-only publication'));
  assert.ok(heads.includes('Undated item with permalink guid'));
  assert.ok(!heads.includes('Event listing next month'));
  assert.equal(r.future_dated, 1);
  assert.equal(r.dateless, 1);
  const dated = r.candidates.find((c) => c.headline === 'Date-only publication');
  assert.equal(dated.published_date, '2026-09-30');
  const first = r.candidates[0];
  assert.match(first.candidate_id, /^c-[0-9a-f]{10}$/);
  assert.equal(first.url_normalised, 'https://news.example.com/2026/10/gateway-zero-day');
  // narrower window drops older items
  const r2 = feedCandidates(source, parsed, { since: new Date('2026-10-02T00:00:00Z'), now: new Date('2026-10-02T18:10:00Z') });
  assert.deepEqual(r2.candidates.map((c) => c.headline).sort(), ['Attackers exploit zero-day in Example Gateway & VPN appliances', 'Undated item with permalink guid']);
});
