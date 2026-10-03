// Source registry (pipeline/sources.json) loading and validation. See schema/sources.schema.json.

import { readJson } from './io.mjs';
import { REGIONS, SOURCE_CLASSES, SOURCE_TYPES } from './enums.mjs';
import { PAYWALLED_MAX_LEAD_WORDS } from './feed.mjs';
import { hostOf, registrableDomain } from './url.mjs';

export const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
export const PREFILTER_PROFILES = Object.freeze(['lenient', 'authority', 'primary', 'standard', 'strict', 'high_volume']);

/**
 * Publications behind a hard paywall, used when a source found by search (add-manual.mjs --extra)
 * is not in the registry: their entries are headline-and-lead only (lead capped at 40 words).
 * Registered sources use their own `paywalled` flag.
 */
export const KNOWN_PAYWALLED_DOMAINS = Object.freeze([
  'ft.com', 'wsj.com', 'bloomberg.com', 'economist.com', 'nytimes.com', 'washingtonpost.com', 'barrons.com',
  'thetimes.co.uk', 'telegraph.co.uk', 'risk.net', 'americanbanker.com', 'theinformation.com', 'politico.eu',
  'handelsblatt.com', 'lesechos.fr', 'globalcapital.com', 'insurancejournal.com', 'thebanker.com',
]);

const KNOWN_KEYS = new Set([
  'id', 'publication', 'source_class', 'type', 'url', 'paywalled', 'region', 'lead_words', 'notes',
  'enabled', 'prefilter', 'exclude_url_patterns', 'tier',
]);
/** News tiers for FILTER.md §2.7.4 and §2.9 source order: general or business press, or trade press. */
export const NEWS_TIERS = Object.freeze(['general', 'trade']);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate a parsed sources.json document.
 * @param {object} doc
 * @param {{allowHttp?: boolean}} opts allowHttp is for local test servers only
 */
export function validateSources(doc, { allowHttp = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { errors: ['sources: not a JSON object'], warnings };
  if (doc.schema_version !== 1) errors.push('sources: schema_version must be 1');
  if (!Array.isArray(doc.sources)) return { errors: [...errors, 'sources: "sources" must be an array'], warnings };
  const ids = new Set();
  doc.sources.forEach((s, i) => {
    const at = `sources[${i}]${s && typeof s.id === 'string' ? ` (${s.id})` : ''}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    for (const k of Object.keys(s)) if (!KNOWN_KEYS.has(k)) warnings.push(`${at}: unknown key "${k}" ignored`);
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) errors.push(`${at} id: must be kebab-case`);
    else if (ids.has(s.id)) errors.push(`${at} id: duplicate id "${s.id}"`);
    else ids.add(s.id);
    if (typeof s.publication !== 'string' || !s.publication.trim()) errors.push(`${at} publication: required non-empty string`);
    if (!SOURCE_CLASSES.includes(s.source_class)) errors.push(`${at} source_class: must be one of ${SOURCE_CLASSES.join(', ')}`);
    if (!SOURCE_TYPES.includes(s.type)) errors.push(`${at} type: must be one of ${SOURCE_TYPES.join(', ')}`);
    let url = null;
    try { url = new URL(s.url); } catch { /* handled below */ }
    if (!url || (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:'))) errors.push(`${at} url: must be an https URL`);
    if (typeof s.paywalled !== 'boolean') errors.push(`${at} paywalled: must be boolean`);
    if (!REGIONS.includes(s.region)) errors.push(`${at} region: must be one of ${REGIONS.join(', ')}`);
    if (s.lead_words !== undefined) {
      if (!Number.isInteger(s.lead_words) || s.lead_words < 0 || s.lead_words > 200) errors.push(`${at} lead_words: integer 0-200`);
      else if (s.paywalled === true && s.lead_words > PAYWALLED_MAX_LEAD_WORDS) errors.push(`${at} lead_words: paywalled sources max ${PAYWALLED_MAX_LEAD_WORDS}`);
    }
    if (typeof s.notes !== 'string') errors.push(`${at} notes: required string (may be empty)`);
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') errors.push(`${at} enabled: must be boolean`);
    if (s.prefilter !== undefined && !PREFILTER_PROFILES.includes(s.prefilter)) errors.push(`${at} prefilter: must be one of ${PREFILTER_PROFILES.join(', ')}`);
    if (s.exclude_url_patterns !== undefined && (!Array.isArray(s.exclude_url_patterns) || s.exclude_url_patterns.some((p) => typeof p !== 'string' || p.trim().length < 3))) {
      errors.push(`${at} exclude_url_patterns: array of URL substrings, 3 or more characters each (e.g. "/event-info/")`);
    }
    if (s.type === 'cisa-kev' && s.source_class !== 'vendor_threat_research') warnings.push(`${at}: cisa-kev sources are normally vendor_threat_research`);
    if (s.tier !== undefined) {
      if (!NEWS_TIERS.includes(s.tier)) errors.push(`${at} tier: must be one of ${NEWS_TIERS.join(', ')} (FILTER.md 2.7.4)`);
      else if (s.source_class !== 'news') warnings.push(`${at} tier: only news sources have a tier`);
    }
  });
  return { errors, warnings };
}

export function loadSources(file, opts) {
  const doc = readJson(file);
  const result = validateSources(doc, opts);
  return { doc, sources: Array.isArray(doc?.sources) ? doc.sources : [], ...result };
}

export function sourceMap(sources) {
  return new Map(sources.map((s) => [s.id, s]));
}

/** Host prefixes that name the same site (feeds.example.com and www.example.com are one publication). */
const SAME_SITE_PREFIX = /^(?:www\d?|feeds?|rss|m|mobile|amp)\./;
const siteHost = (host) => {
  let h = String(host ?? '').toLowerCase();
  while (SAME_SITE_PREFIX.test(h) && h.split('.').length > 2) h = h.replace(SAME_SITE_PREFIX, '');
  return h;
};

/**
 * Registered source for a URL: the same host first, then the same site (the host without a
 * www/feeds/rss/m prefix: feed hosts often differ from article hosts). Never another subdomain of
 * the registrable domain: nvd.nist.gov is not csrc.nist.gov's feed, so an extra registered on it
 * borrows no publication, class or source id. Paywalled sources win ties. Returns the source or null.
 * paywalledOnSite() keeps the domain-wide paywall check, so a paywall is never missed.
 */
export function sourceForUrl(sources, url) {
  const host = hostOf(url);
  if (!host) return null;
  const live = sources.filter((s) => s && s.enabled !== false && typeof s.url === 'string');
  const pick = (list) => list.find((s) => s.paywalled === true) ?? list[0] ?? null;
  const byHost = pick(live.filter((s) => hostOf(s.url) === host));
  if (byHost) return byHost;
  return pick(live.filter((s) => siteHost(hostOf(s.url)) === siteHost(host)));
}

/**
 * A paywalled registered source on the URL's registrable domain (multi-tenant platforms by exact
 * host only), or null: an extra on any subdomain of a paywalled publication is paywalled.
 */
export function paywalledOnSite(sources, url) {
  const host = hostOf(url);
  if (!host) return null;
  const domain = registrableDomain(host);
  const live = sources.filter((s) => s && s.enabled !== false && typeof s.url === 'string' && s.paywalled === true);
  if (MULTI_TENANT_DOMAINS.includes(domain)) return live.find((s) => hostOf(s.url) === host) ?? null;
  return live.find((s) => registrableDomain(hostOf(s.url)) === domain) ?? null;
}

/** Hosting platforms whose subdomains are different publications: match these by exact host only. */
const MULTI_TENANT_DOMAINS = Object.freeze([
  'substack.com', 'medium.com', 'github.io', 'blogspot.com', 'wordpress.com', 'feedburner.com', 'tumblr.com',
  'ghost.io', 'beehiiv.com', 'gitlab.io', 'netlify.app', 'pages.dev', 'vercel.app', 'sharepoint.com',
]);

/** True when the URL is on a publication known to be paywalled (KNOWN_PAYWALLED_DOMAINS). */
export function isKnownPaywalled(url) {
  const domain = registrableDomain(hostOf(url));
  return Boolean(domain && KNOWN_PAYWALLED_DOMAINS.includes(domain));
}
