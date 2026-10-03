// URL normalisation and candidate ids (SPEC §5 steps 1-3).
//
// normaliseUrl() is an identity key, not a display URL: it forces https (item sources must be
// https and a feed may still emit http links), lowercases the host, drops the fragment (except on
// FRAGMENT_IDENTITY_PAGES, where the page's anchor is the entry's only identifier), the tracking
// parameters (isTrackingParam), the default port and any trailing slash, and collapses repeated
// slashes in the path (ECB and ESRB feeds emit "https://www.ecb.europa.eu//press/...").

import { createHash } from 'node:crypto';

// Always tracking, whatever the value: utm_*, fbclid, gclid, mc_* (Mailchimp), cmpid, CMP (The
// Guardian), ito (The Economist), sr_share (WSJ), smid (New York Times), partner (syndication
// tag). Case-insensitive.
const TRACKING_PARAM = /^(?:utm_[a-z0-9_]*|fbclid|gclid|mc_[a-z0-9_]*|cmpid|cmp|ito|sr_share|smid|partner)$/i;
// FT gift and syndication tokens: a lowercase word, a hyphen and 6+ hex digits ("syn-25a6b1a6=1").
const TOKEN_KEY_PARAM = /^[a-z]+-[0-9a-f]{6,}$/;
// "mod" is a Dow Jones (WSJ, Barron's, MarketWatch) placement tag ("hp_lead_pos1", "rss_Technology",
// "djemalertNEWS", "e2tw"), but some CMSs use it to select a module ("index.php?mod=news&id=5"):
// stripped only when the value looks like a tracking token.
const MOD_TOKEN_VALUE = /^(?:[a-z]+_[\w-]+|rss\w*|djem\w*|hp\w*|e2\w+|itp\w*|mktw\w*|wsj\w*|article_inline|lead_pos\d+)$/i;
// "ref" is a referrer tag on news sites but names a branch or tag on code hosts ("?ref=main").
const CODE_HOSTS = /(?:^|\.)(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sourceforge\.net)$/i;

/** Is this query parameter a tracking parameter that normaliseUrl drops? */
export function isTrackingParam(key, value = '', host = '') {
  const k = String(key);
  if (TRACKING_PARAM.test(k) || TOKEN_KEY_PARAM.test(k)) return true;
  if (/^mod$/i.test(k)) return MOD_TOKEN_VALUE.test(String(value));
  if (/^ref$/i.test(k)) return !CODE_HOSTS.test(String(host));
  return false;
}

/** Tracking parameter names present in a URL (empty when none or not a URL). */
export function trackingParams(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    return [];
  }
  return [...u.searchParams].filter(([k, v]) => isTrackingParam(k, v, u.hostname)).map(([k]) => k);
}

/**
 * Pages whose entries have no URL of their own: the page's own anchor for an entry is the entry's
 * only identifier, so normaliseUrl keeps the fragment there (FILTER.md §2.7.5(a), RUNBOOK step 5).
 * Without it every entry collapses to the listing URL: one candidate id for all of them, and once
 * one is judged, seen.json hides every later entry. Matched on the exact host and the path.
 */
export const FRAGMENT_IDENTITY_PAGES = Object.freeze([
  // Azure status history: each post-incident review is an element "incident-history-collapse-<Tracking ID>".
  { host: 'azure.status.microsoft', path: /^\/(?:[a-z]{2}-[a-z]{2}\/)?status\/history\/?$/i, fragment: /^#?incident-history-collapse-[A-Za-z0-9-]+$/ },
]);

/** Is this URL's fragment the identity of an entry on a FRAGMENT_IDENTITY_PAGES page? */
export function fragmentIsIdentity(input) {
  let u;
  try {
    u = input instanceof URL ? input : new URL(String(input).trim());
  } catch {
    return false;
  }
  if (!u.hash || u.hash === '#') return false;
  const host = u.hostname.toLowerCase();
  return FRAGMENT_IDENTITY_PAGES.some((p) => p.host === host && p.path.test(u.pathname) && p.fragment.test(u.hash));
}

export function normaliseUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase();
  if (u.port === '443' || u.port === '80') u.port = '';
  const keepHash = fragmentIsIdentity(u) ? u.hash : '';
  u.hash = '';
  u.username = '';
  u.password = '';
  for (const [key, value] of [...u.searchParams]) {
    if (isTrackingParam(key, value, u.hostname)) u.searchParams.delete(key);
  }
  let path = u.pathname.replace(/\/{2,}/g, '/');
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';
  const search = [...u.searchParams.keys()].length ? `?${u.searchParams.toString()}` : '';
  return `https://${u.host}${path}${search}${keepHash}`;
}

/** 'c-' + first 10 hex chars of sha256(normalised url). */
export function candidateId(url) {
  const norm = normaliseUrl(url);
  if (!norm) throw new Error(`cannot build candidate id from invalid url: ${url}`);
  return `c-${createHash('sha256').update(norm).digest('hex').slice(0, 10)}`;
}

export function isHttpsUrl(s) {
  if (typeof s !== 'string' || s.trim() !== s || s === '') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && Boolean(u.hostname);
  } catch {
    return false;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'nhs.uk', 'police.uk',
  'com.au', 'gov.au', 'org.au', 'net.au', 'edu.au', 'co.nz', 'govt.nz', 'gc.ca', 'gov.ie',
  'co.jp', 'go.jp', 'or.jp', 'com.sg', 'gov.sg', 'com.hk', 'gov.hk', 'co.in', 'gov.in', 'nic.in',
  'com.br', 'gov.br', 'co.za', 'gov.za', 'europa.eu',
]);

// FILTER.md §2.7.2 and NP3: aggregators, caches, archives, link shorteners, paywall bypasses,
// translation proxies and social platforms are never sources. Matched on the registrable domain
// unless the entry has a dot-prefixed host (exact host or its subdomains).
const DISALLOWED_SOURCE_HOSTS = Object.freeze([
  // aggregators and syndication readers
  'news.google.com', 'news.yahoo.com', 'msn.com', 'flipboard.com', 'apple.news', 'newsbreak.com', 'ground.news',
  'smartnews.com', 'techmeme.com', 'feedly.com', 'inoreader.com', 'newsnow.co.uk', 'newsnow.com', 'allsides.com',
  'muckrack.com', 'pressreader.com', 'headtopics.com', 'biztoc.com', 'newsbreakapp.com', 'feeds.feedburner.com',
  'feedproxy.google.com', 'bing.com', 'duckduckgo.com',
  // caches, archives, readers and paywall bypasses
  'webcache.googleusercontent.com', 'googleusercontent.com', 'ampproject.org', 'bing-amp.com', 'web.archive.org',
  'archive.org', 'archive.ph', 'archive.today', 'archive.is', 'archive.li', 'archive.vn', 'archive.md', 'archive.fo',
  'ghostarchive.org', '12ft.io', 'removepaywall.com', 'smry.ai', 'r.jina.ai', 'outline.com', 'printfriendly.com',
  'translate.goog', 'translate.google.com',
  // mailing-list and bulletin wrappers (FILTER.md §7.8: "content.govdelivery.com")
  'govdelivery.com', 'lnks.gd', 'list-manage.com', 'mailchi.mp', 'hubspotlinks.com', 'safelinks.protection.outlook.com',
  'urldefense.com', 'urldefense.proofpoint.com',
  // link shorteners and redirectors
  't.co', 'bit.ly', 'lnkd.in', 'ow.ly', 'buff.ly', 'tinyurl.com', 'dlvr.it', 'trib.al', 'shorturl.at', 'rebrand.ly',
  'l.facebook.com', 'lm.facebook.com', 'out.reddit.com',
  // social platforms and forums
  'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'threads.net', 'linkedin.com', 'bsky.app', 'reddit.com',
  'news.ycombinator.com', 't.me', 'tiktok.com', 'youtube.com', 'youtu.be', 'mastodon.social', 'truthsocial.com',
]);

/**
 * Why a URL can never be an item source (aggregator, cache, archive, shortener, social, AMP or a
 * redirect wrapper), or null when it may be. FILTER.md §2.7.2, §7.8.2 and NP3.
 */
export function disallowedSourceReason(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return 'not a URL';
  }
  const host = u.hostname.toLowerCase();
  const domain = registrableDomain(host);
  for (const h of DISALLOWED_SOURCE_HOSTS) {
    if (host === h || host.endsWith(`.${h}`) || domain === h) return `${h} is an aggregator, cache, archive, mailing-list wrapper, shortener or social platform, never a source; use the original publication's own URL`;
  }
  if (host.endsWith('.cdn.ampproject.org') || /^amp\./.test(host) || /(?:^|\/)amp(?:\/|$)|\.amp(?:\.html?)?$/i.test(u.pathname)) return 'AMP URL; use the canonical article URL';
  for (const [k, v] of u.searchParams) {
    if (/^(?:amp|outputtype)$/i.test(k) && /^(?:1|true|amp)?$/i.test(v)) return 'AMP URL; use the canonical article URL';
    if (/^(?:url|u|q|target|dest|destination|redirect|redirect_uri)$/i.test(k) && /^https?:\/\//i.test(v)) return `redirect wrapper (${k}=); use the target URL itself`;
  }
  return null;
}

/** Heuristic registrable domain (eTLD+1) used to keep manual candidates on their source's site. */
export function registrableDomain(host) {
  if (!host) return null;
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const last2 = labels.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIXES.has(last2)) return labels.slice(-3).join('.');
  return last2;
}
