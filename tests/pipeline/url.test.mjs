import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateId, isHttpsUrl, normaliseUrl, registrableDomain } from '../../pipeline/lib/url.mjs';

test('normaliseUrl lowercases host, drops fragment, tracking params and trailing slash, forces https', () => {
  assert.equal(
    normaliseUrl('HTTP://News.Example.COM:80/Story/Path/?utm_source=x&id=7&fbclid=abc&gclid=1&mc_cid=2&mc_eid=3&UTM_Medium=y#top'),
    'https://news.example.com/Story/Path?id=7',
  );
  assert.equal(normaliseUrl('https://example.com/'), 'https://example.com');
  assert.equal(normaliseUrl('https://example.com'), 'https://example.com');
  assert.equal(normaliseUrl('https://example.com/a//'), 'https://example.com/a');
  assert.equal(normaliseUrl('https://example.com:443/a?b=1&utm_campaign=z'), 'https://example.com/a?b=1');
  assert.equal(normaliseUrl('https://example.com:8443/a'), 'https://example.com:8443/a');
  assert.equal(normaliseUrl('https://user:pw@example.com/a'), 'https://example.com/a');
  assert.equal(normaliseUrl('ftp://example.com/a'), null);
  assert.equal(normaliseUrl('not a url'), null);
});

test('candidate id is c- + 10 hex chars of sha256(normalised url) and stable across variants', () => {
  const a = candidateId('https://news.example.com/story/1/?utm_source=rss');
  const b = candidateId('http://NEWS.example.com/story/1#comments');
  assert.match(a, /^c-[0-9a-f]{10}$/);
  assert.equal(a, b);
  assert.notEqual(a, candidateId('https://news.example.com/story/2'));
  assert.throws(() => candidateId('nope'), /invalid url/);
});

test('isHttpsUrl and registrableDomain', () => {
  assert.equal(isHttpsUrl('https://example.com/x'), true);
  assert.equal(isHttpsUrl('http://example.com/x'), false);
  assert.equal(isHttpsUrl(' https://example.com/x'), false);
  assert.equal(isHttpsUrl(''), false);
  assert.equal(registrableDomain('www.bankofengland.co.uk'), 'bankofengland.co.uk');
  assert.equal(registrableDomain('news.example.com'), 'example.com');
  assert.equal(registrableDomain('eba.europa.eu'), 'eba.europa.eu');
  assert.equal(registrableDomain('example.com'), 'example.com');
});
