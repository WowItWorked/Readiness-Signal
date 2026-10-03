// Live date and lead formats (review findings F06, F15, F16, F17). The fmt-*.xml fixtures are
// FICTIONAL; their structure mirrors the live feeds named in each fixture's header comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFeedDate, descriptionText, feedDateOnly, parseFeed, parseFeedDate, removeElementsWithClass, stripLeadingHeadline,
} from '../../pipeline/lib/feed.mjs';
import { dateWarnings, feedCandidates, urlExcluder } from '../../pipeline/lib/collect.mjs';
import { fixture } from './_helpers.mjs';

function entryDate(text) {
  const d = classifyFeedDate(text);
  return { published: d.iso, date_only: d.iso ? feedDateOnly(text) : null, date_status: d.status };
}

test('dates: Drupal "Weekday, Month D, YYYY - HH:MM", CEST/CET, date-only strings, implausible and unparsed', () => {
  assert.equal(parseFeedDate('Friday, October 2, 2026 - 11:58'), '2026-10-02T11:58:00.000Z');
  assert.equal(parseFeedDate('Monday, September 28, 2026 – 14:29'), '2026-09-28T14:29:00.000Z');
  assert.equal(parseFeedDate('Sun, 27 Sep 2026 19:40:52 CEST'), '2026-09-27T17:40:52.000Z');
  assert.equal(parseFeedDate('Thu, 05 Nov 2026 10:00:00 CET'), '2026-11-05T09:00:00.000Z');
  assert.deepEqual(classifyFeedDate('Sat, 30 Dec 1899 15:00:00 GMT'), { status: 'implausible', iso: null });
  assert.deepEqual(classifyFeedDate('Published soon after the meeting'), { status: 'unparsed', iso: null });
  assert.deepEqual(classifyFeedDate(''), { status: 'missing', iso: null });
  assert.deepEqual(classifyFeedDate(undefined), { status: 'missing', iso: null });
  assert.equal(classifyFeedDate('Fri, 02 Oct 2026 14:00:00 EDT').status, 'ok');
  // date-only strings keep the calendar date the feed wrote (F17)
  assert.equal(feedDateOnly('October 2, 2026'), '2026-10-02');
  assert.equal(feedDateOnly('Fri, 02 Oct 2026'), '2026-10-02');
  assert.equal(feedDateOnly('2 October 2026'), '2026-10-02');
  assert.equal(feedDateOnly('Friday, October 2, 2026 - 11:58'), null);
  assert.equal(feedDateOnly('not a date'), null);
});

test('feedCandidates: a date written without a time is kept on its own calendar day (F17)', () => {
  const source = { id: 'example-news', publication: 'Example', source_class: 'news', region: 'US', paywalled: false };
  // 2026-10-02T00:00Z is 20:00 ET on 1 Oct; the window opens 2 Oct 06:00 ET; the feed says 2 Oct.
  for (const text of ['October 2, 2026', 'Fri, 02 Oct 2026']) {
    const parsed = { entries: [{ title: 'Same-day item', link: 'https://news.example.com/x', ...entryDate(text), lead: '' }] };
    const r = feedCandidates(source, parsed, { since: new Date('2026-10-02T10:00:00Z'), now: new Date('2026-10-02T18:00:00Z') });
    assert.equal(r.candidates.length, 1, text);
    assert.equal(r.candidates[0].published_date, '2026-10-02', text);
  }
});

test('Drupal feed with "- HH:MM" pubDates: every entry dated; an unreadable date is flagged, not silent', () => {
  const f = parseFeed(fixture('fmt-drupal-dash-date.xml'));
  assert.deepEqual(f.entries.map((e) => e.date_status), ['ok', 'ok', 'unparsed']);
  assert.equal(f.entries[0].published, '2026-10-02T11:58:00.000Z');
  assert.equal(f.entries[0].link, 'https://regulator.example.org.uk/news/news-stories/firms-told-strengthen-mule-account-detection');
  assert.equal(f.entries[2].date_text, 'Published soon after the meeting');
  const source = { id: 'example-regulator', publication: 'Example Conduct Authority', source_class: 'regulator', region: 'UK', paywalled: false };
  const r = feedCandidates(source, f, { since: new Date('2026-10-01T00:00:00Z'), now: new Date('2026-10-02T18:00:00Z') });
  // the 28 Sep entry is outside the window; the unreadable one is kept as undated and counted
  assert.deepEqual(r.candidates.map((c) => c.headline), ['Firms told to strengthen controls on mule account detection', 'Board appointment announced']);
  assert.equal(r.date_unparsed, 1);
  assert.equal(r.dateless, 1);
  assert.equal(r.bad_date, 0);
  assert.deepEqual(r.date_samples, ['Published soon after the meeting']);
  const warns = dateWarnings({ id: 'example-regulator', ...r });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /example-regulator: 1 entry has a date in an unreadable format \(e\.g\. "Published soon after the meeting"\); kept as undated/);
});

test('Drupal feed without pubDate: the date comes from <time datetime> in the description; metadata leaves the lead', () => {
  const f = parseFeed(fixture('fmt-drupal-time-in-description.xml'));
  const [a, b] = f.entries;
  assert.equal(a.published, '2026-09-30T13:25:31.000Z');
  assert.equal(a.date_status, 'ok');
  // no repeated title, date or taxonomy labels at the start of the lead; the body is never reached
  assert.match(a.lead, /^The Example Markets Authority has responded to a public consultation/);
  assert.ok(!a.lead.includes('30 September 2026'));
  assert.ok(!a.lead.includes('Investor protection'));
  assert.ok(!a.lead.includes('Authority calls for changes'));
  assert.ok(a.lead.split(' ').filter((w) => w !== '…').length <= 60);
  // double-escaped markup: date still found, no tags left in the lead
  assert.equal(b.published, '2026-09-29T07:00:00.000Z');
  assert.equal(b.lead, 'A double-escaped description: firms relying on a single cloud region are reminded of exit planning expectations.');
});

test('CDATA feed with "Sat, 30 Dec 1899" null dates: implausible dates are skipped and counted, never undated', () => {
  const f = parseFeed(fixture('fmt-cdata-null-dates.xml'));
  assert.deepEqual(f.entries.map((e) => e.date_status), ['ok', 'implausible', 'implausible', 'ok']);
  assert.equal(f.entries[0].link, 'https://reserve.example.gov/newsevents/testimony/governor20261001a.htm');
  const source = { id: 'example-testimony', publication: 'Example Reserve', source_class: 'regulator', region: 'US', paywalled: false };
  const r = feedCandidates(source, f, { since: new Date('2026-09-29T00:00:00Z'), now: new Date('2026-10-02T18:00:00Z') });
  assert.deepEqual(r.candidates.map((c) => c.url), ['https://reserve.example.gov/newsevents/testimony/governor20261001a.htm']);
  assert.equal(r.bad_date, 2);
  assert.equal(r.dateless, 0, 'a bad date is not "undated": it never bypasses the window');
  assert.deepEqual(r.date_samples, ['Sat, 30 Dec 1899 15:00:00 GMT', 'Sat, 30 Dec 1899 21:30:00 GMT']);
  assert.match(dateWarnings({ id: 'example-testimony', ...r })[0], /example-testimony: 2 entries have an implausible date .*; skipped/);
});

test('undated items: kept (up to the per-source cap) with date_missing; the lead keeps the text after the image', () => {
  const f = parseFeed(fixture('fmt-undated-items.xml'));
  assert.deepEqual(f.entries.map((e) => e.date_status), ['missing', 'missing']);
  assert.match(f.entries[0].lead, /^Social Engineering Campaign Targets IT Service Desks Attackers persuaded/);
  const source = { id: 'example-banksec', publication: 'Example Bank Security', source_class: 'news', region: 'US', paywalled: false };
  const r = feedCandidates(source, f, { since: new Date('2026-10-02T00:00:00Z'), now: new Date('2026-10-02T18:00:00Z') });
  assert.equal(r.candidates.length, 2);
  assert.ok(r.candidates.every((c) => c.date_missing && c.published === null));
  assert.equal(r.date_unparsed, 0);
  assert.deepEqual(dateWarnings({ id: 'example-banksec', ...r }), []);
});

test('event listings: far-future ones are skipped by date; exclude_url_patterns skips them all at fetch (F15)', () => {
  const f = parseFeed(fixture('fmt-event-listings.xml'));
  const base = { id: 'example-fintech', publication: 'Example Fintech News', source_class: 'news', region: 'UK', paywalled: false };
  const window = { since: new Date('2026-09-30T00:00:00Z'), now: new Date('2026-10-02T18:00:00Z') };
  const r = feedCandidates(base, f, window);
  // 3 Oct 15:00Z is within 24 h, so it reaches the window (stage 1 drops it by URL); 3 Nov is skipped
  assert.equal(r.future_dated, 1);
  assert.equal(r.candidates.length, 3);
  const r2 = feedCandidates({ ...base, exclude_url_patterns: ['/EVENT-INFO/'] }, f, window);
  assert.equal(r2.excluded, 3);
  assert.deepEqual(r2.candidates.map((c) => c.headline), ['Card processor discloses outage that halted authorisations for six hours']);
  assert.equal(urlExcluder({}), null);
  assert.equal(urlExcluder({ exclude_url_patterns: ['/webinars/'] })('https://x.example.com/Webinars/1'), true);
});

test('lead helpers: leading headline copy removed; nested CMS metadata removed with balanced tags (F16)', () => {
  assert.equal(stripLeadingHeadline('Big outage hits banks: Services were down for nine hours.', 'Big outage hits banks'), 'Services were down for nine hours.');
  assert.equal(stripLeadingHeadline('Big outage hits banks', 'Big outage hits banks'), 'Big outage hits banks');
  assert.equal(stripLeadingHeadline('Outages rise again', 'Outage'), 'Outages rise again');
  assert.equal(stripLeadingHeadline('A different lead.', 'Big outage'), 'A different lead.');
  const html = '<div class="field field--name-field-news-section"><div class="field__item">A</div><div class="field__item">B</div></div><p>Kept.</p>';
  assert.equal(removeElementsWithClass(html, /field--name-field-news-section/).trim(), '<p>Kept.</p>');
  assert.equal(removeElementsWithClass('<div class="field--name-title">unclosed <p>x</p>', /field--name-title/).trim(), 'unclosed <p>x</p>');
  assert.equal(descriptionText('&lt;span class="field field--name-title"&gt;Title&lt;/span&gt;&lt;p&gt;Body &amp;amp; more&lt;/p&gt;'), 'Body & more');
});
