// Tolerant, dependency-free feed parser: RSS 2.0, Atom 1.0 and RSS 1.0 (RDF), auto-detected.
//
// Keeps only headline-level reference data per entry: title, link, published and a LEAD (the
// first N words of description/summary). Full bodies (content:encoded, Atom <content>) are never
// read or stored. Tolerates junk before the XML declaration or root element (some feeds prepend
// HTML comments), CDATA, named and numeric entities, namespaced elements and HTML in text.

export const DEFAULT_LEAD_WORDS = 60;
export const PAYWALLED_MAX_LEAD_WORDS = 40;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '', zwj: '', lrm: '', rlm: '', shy: '',
  ndash: '–', mdash: '—', minus: '−', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”',
  bdquo: '„', lsaquo: '‹', rsaquo: '›', laquo: '«', raquo: '»', prime: '′', Prime: '″',
  hellip: '…', bull: '•', middot: '·', dagger: '†', Dagger: '‡', permil: '‰', sect: '§', para: '¶',
  copy: '©', reg: '®', trade: '™', deg: '°', micro: 'µ', plusmn: '±', times: '×', divide: '÷',
  frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', ordf: 'ª', ordm: 'º',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤', iexcl: '¡', iquest: '¿', not: '¬',
  macr: '¯', acute: '´', cedil: '¸', uml: '¨', brvbar: '¦', larr: '←', rarr: '→', uarr: '↑',
  darr: '↓', harr: '↔', check: '✓',
  szlig: 'ß', aelig: 'æ', AElig: 'Æ', oelig: 'œ', OElig: 'Œ', oslash: 'ø', Oslash: 'Ø',
  aring: 'å', Aring: 'Å', ccedil: 'ç', Ccedil: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ', eth: 'ð', ETH: 'Ð',
  thorn: 'þ', THORN: 'Þ', yuml: 'ÿ', Yuml: 'Ÿ', scaron: 'š', Scaron: 'Š', zcaron: 'ž', Zcaron: 'Ž',
};
// Accented vowels: &aacute; &Agrave; &ecirc; &ouml; &atilde; ...
{
  const marks = { acute: String.fromCharCode(0x301), grave: String.fromCharCode(0x300), circ: String.fromCharCode(0x302), uml: String.fromCharCode(0x308), tilde: String.fromCharCode(0x303) };
  for (const v of ['a', 'e', 'i', 'o', 'u', 'y', 'n']) {
    for (const [name, mark] of Object.entries(marks)) {
      const lower = (v + mark).normalize('NFC');
      const upper = (v.toUpperCase() + mark).normalize('NFC');
      if (lower.length === 1) NAMED_ENTITIES[v + name] = lower;
      if (upper.length === 1) NAMED_ENTITIES[v.toUpperCase() + name] = upper;
    }
  }
}
// Windows-1252 code points that feeds sometimes emit as numeric references.
const CP1252 = {
  128: '€', 130: '‚', 132: '„', 133: '…', 134: '†', 135: '‡', 137: '‰', 139: '‹', 145: '‘', 146: '’',
  147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 153: '™', 155: '›',
};

export function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s ?? '';
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (CP1252[cp]) return CP1252[cp];
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
      return String.fromCodePoint(cp);
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e)) return NAMED_ENTITIES[e];
    const lower = e.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) return NAMED_ENTITIES[lower];
    return m;
  });
}

const escapeXmlText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function stripHtml(s) {
  return String(s ?? '')
    .replace(/<(script|style|noscript|iframe|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|blockquote|tr|td|th|table|section|article|figure|figcaption)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
}

export function collapseWhitespace(s) {
  // JS \s already covers NBSP, the U+2000 spaces, line/paragraph separators, U+3000 and BOM;
  // zero-width format characters (\p{Cf}) are removed outright.
  return String(s ?? '').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
}

/** XML element text -> plain text (nested markup removed, entities decoded twice, HTML stripped). */
export function elementText(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(/<[^>]*>/g, ' '); // nested XML elements (e.g. Atom xhtml)
  s = decodeEntities(s); // XML layer -> may yield escaped HTML
  s = stripHtml(s);
  s = decodeEntities(s); // HTML layer (double-escaped feeds)
  return collapseWhitespace(s);
}

const TAIL_PATTERNS = [
  /\s*The post\b[\s\S]{0,400}?\bappeared first on\b[\s\S]{0,200}$/i,
  /\s*(?:Continue reading|Read more|Read the full (?:article|story|post)|Click here to read)\b[\s\S]*$/i,
  /\s*\[(?:…|\.\.\.)\]\s*$/,
];

/** First `n` words of a description/summary; appends '…' when truncated. */
export function makeLead(text, n = DEFAULT_LEAD_WORDS) {
  let s = collapseWhitespace(text);
  for (const re of TAIL_PATTERNS) s = s.replace(re, '');
  s = s.trim();
  if (!s || n <= 0) return '';
  const words = s.split(' ');
  if (words.length <= n) return s;
  return `${words.slice(0, n).join(' ')} …`;
}

const TZ_ABBREV = {
  UT: '+0000', UTC: '+0000', GMT: '+0000', Z: '+0000', BST: '+0100', IST: '+0100', CET: '+0100',
  CEST: '+0200', EET: '+0200', EEST: '+0300', MSK: '+0300', JST: '+0900', KST: '+0900',
  AEST: '+1000', AEDT: '+1100', SGT: '+0800', HKT: '+0800',
  EST: '-0500', EDT: '-0400', CST: '-0600', CDT: '-0500', MST: '-0700', MDT: '-0600', PST: '-0800', PDT: '-0700',
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Calendar date when a feed date carries no real time of day: a bare 'YYYY-MM-DD', midnight
 * (00:00[:00]) in its own offset, which many feeds emit for date-only publication, or any other
 * parseable date written without a time ('October 2, 2026', 'Fri, 02 Oct 2026'). Else null.
 */
export function feedDateOnly(input) {
  const s = collapseWhitespace(input);
  if (!s) return null;
  let m = /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) return m[1];
  m = /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{2,4})\s+00:00(?::00)?(?!\d)/i.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${pad2(MONTHS[m[2].toLowerCase()])}-${pad2(Number(m[1]))}`;
  }
  // No time of day at all: parseFeedDate reads it as 00:00 UTC, so its UTC calendar date is the
  // date the feed wrote (comparing instants would put it on the previous ET day).
  if (!/\d{1,2}:\d{2}/.test(s)) {
    const iso = parseFeedDate(s);
    if (iso) return iso.slice(0, 10);
  }
  return null;
}

/** Parse RFC 822 / ISO 8601 / common variants. Returns ISO UTC string or null. */
export function parseFeedDate(input) {
  return classifyFeedDate(input).iso;
}

/**
 * Parse a feed date and say why it failed when it did:
 *   ok           parsed, year 1990-2100 ({ iso } is set)
 *   missing      no date text
 *   implausible  parsed, but outside 1990-2100 (e.g. the 'Sat, 30 Dec 1899' null date some CMSs emit)
 *   unparsed     present, in a format this parser does not read
 * @returns {{status: 'ok'|'missing'|'implausible'|'unparsed', iso: string|null}}
 */
export function classifyFeedDate(input) {
  const s0 = collapseWhitespace(input);
  if (!s0) return { status: 'missing', iso: null };
  // Never let Date.parse fall back to the machine's local zone: results must be identical on
  // Windows (ET) and Linux (UTC). Zone-less timestamps are read as UTC.
  // Drupal 'Friday, October 2, 2026 - 11:58' (FCA): drop the dash between the date and the time.
  // That time is the publisher's wall time read as UTC: for UK sources in summer it is at most an
  // hour later than the real instant, which can only keep an entry in the window, never drop it.
  let s = s0.replace(/(\d{4})\s+[-–—]\s+(\d{1,2}:\d{2})/, '$1 $2');
  const isoNoZone = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?$/.exec(s);
  if (isoNoZone) {
    s = `${isoNoZone[1]}T${isoNoZone[2]}${isoNoZone[3] ?? ''}Z`;
  } else {
    const m = /^(.*\S)\s+\(?([A-Z]{1,5})\)?$/.exec(s);
    if (m && TZ_ABBREV[m[2]]) s = `${m[1]} ${TZ_ABBREV[m[2]]}`;
    else if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
      if (/\d{1,2}:\d{2}/.test(s)) s = `${s} +0000`;
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s} 00:00:00 +0000`;
    }
  }
  // Also try without a leading weekday ("Fri, ", "Friday "), which some parsers reject.
  const tries = [s, s.replace(/^[A-Za-z]{3,9},?\s+/, '')];
  let implausible = false;
  for (const t of tries) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      const y = d.getUTCFullYear();
      if (y >= 1990 && y <= 2100) return { status: 'ok', iso: d.toISOString() };
      implausible = true;
    }
  }
  return { status: implausible ? 'implausible' : 'unparsed', iso: null };
}

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function entry(title, link, dateText, lead) {
  const d = classifyFeedDate(dateText);
  const e = { title, link, published: d.iso, date_only: d.iso ? feedDateOnly(dateText) : null, date_status: d.status, lead };
  if (d.status === 'implausible' || d.status === 'unparsed') e.date_text = collapseWhitespace(dateText).slice(0, 80);
  return e;
}

/**
 * Remove elements whose class attribute matches `classRe`, with their content (nested tags of the
 * same name are balanced). Used on description HTML to drop CMS metadata fields before the lead
 * is cut. An unbalanced element loses its opening tag only.
 */
export function removeElementsWithClass(html, classRe) {
  let out = String(html ?? '');
  const cls = classRe.source;
  const open = new RegExp(`<(div|span|section|p|time)\\b[^>]*\\bclass\\s*=\\s*(?:"[^"]*(?:${cls})[^"]*"|'[^']*(?:${cls})[^']*')[^>]*>`, 'i');
  for (let guard = 0; guard < 100; guard++) {
    const m = open.exec(out);
    if (!m) break;
    const tag = m[1].toLowerCase();
    const start = m.index;
    let end = -1;
    if (!m[0].endsWith('/>')) {
      const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
      re.lastIndex = start + m[0].length;
      let depth = 1;
      let t;
      while ((t = re.exec(out))) {
        if (t[1]) {
          depth--;
          if (depth === 0) {
            end = t.index + t[0].length;
            break;
          }
        } else if (!t[0].endsWith('/>')) depth++;
      }
    }
    out = `${out.slice(0, start)} ${out.slice(end === -1 ? start + m[0].length : end)}`;
  }
  return out;
}

// Drupal field wrappers that carry metadata rather than a summary: the title repeated, the created
// date and taxonomy labels (ESMA and other Drupal sites put them at the top of <description>).
const CMS_METADATA_CLASS = /field--name-(?:title|created|changed|uid|field-news-section|field-tags|field-category|field-topics?)(?![\w-])/;

/** Description/summary text for the lead: like elementText, minus CMS metadata fields. */
export function descriptionText(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(/<[^>]*>/g, ' '); // nested XML elements
  s = decodeEntities(s); // XML layer -> HTML
  if (/&lt;\/?[a-z][^&]{0,200}&gt;/i.test(s)) s = decodeEntities(s); // double-escaped HTML markup
  if (s.includes('field--name-')) s = removeElementsWithClass(s, CMS_METADATA_CLASS);
  s = stripHtml(s);
  s = decodeEntities(s); // HTML layer
  return collapseWhitespace(s);
}

/** The lead without a leading copy of the headline (some feeds start the description with it). */
export function stripLeadingHeadline(lead, headline) {
  const l = collapseWhitespace(lead);
  const h = collapseWhitespace(headline);
  if (!h || l.length <= h.length || l.slice(0, h.length).toLowerCase() !== h.toLowerCase()) return l;
  const rest = l.slice(h.length);
  if (/^[\p{L}\p{N}]/u.test(rest)) return l; // the headline is only the start of a longer word
  return rest.replace(/^[\s:|.\-–—]+/, '').trim();
}

/** Date carried by a <time datetime="..."> inside (escaped) description HTML, or null. */
function timeDatetime(rawDescription) {
  if (!rawDescription || !/time/i.test(rawDescription)) return null;
  let s = decodeEntities(rawDescription);
  if (!/<time\b/i.test(s)) s = decodeEntities(s); // double-escaped feeds
  const m = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(s);
  return m ? m[1] : null;
}

function attr(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${reEscape(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(attrs || '');
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : null;
}

/** All elements in `block` with one of the exact qualified names. */
function elements(block, qnames) {
  const out = [];
  for (const qn of qnames) {
    const re = new RegExp(`<(${reEscape(qn)})(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${reEscape(qn)}\\s*>)`, 'g');
    let m;
    while ((m = re.exec(block))) out.push({ name: qn, attrs: m[2] || '', inner: m[3] ?? '', index: m.index });
  }
  return out;
}

function first(block, qnames) {
  for (const qn of qnames) {
    const els = elements(block, [qn]);
    for (const el of els) {
      const text = elementText(el.inner);
      if (text) return { ...el, text };
    }
  }
  return null;
}

function resolveUrl(link, base) {
  if (!link) return null;
  const s = collapseWhitespace(link);
  try {
    const u = base ? new URL(s, base) : new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

const RSS = {
  title: ['title', 'dc:title', 'rss:title'],
  link: ['feedburner:origLink', 'link', 'rss:link'],
  description: ['description', 'rss:description', 'dc:description', 'summary'],
  date: ['pubDate', 'dc:date', 'dcterms:issued', 'dcterms:created', 'dcterms:modified', 'published',
    'atom:published', 'updated', 'atom:updated', 'a10:updated', 'prism:publicationDate'],
};
const ATOM = {
  title: ['title', 'atom:title'],
  summary: ['summary', 'atom:summary'],
  date: ['published', 'atom:published', 'issued', 'updated', 'atom:updated', 'modified', 'dc:date'],
};

function detect(xml) {
  const m = /<((?:[\w.-]+:)?(rss|feed|RDF))\b/.exec(xml);
  if (!m) return null;
  const local = m[2];
  return { format: local === 'feed' ? 'atom' : local === 'RDF' ? 'rdf' : 'rss', index: m.index };
}

/** Clean raw text: BOM, CDATA (escaped in place), comments, junk before the root element. */
export function preprocess(raw) {
  let s = String(raw ?? '').replace(/^\s+/, ''); // \s includes the BOM
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => escapeXmlText(c));
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  const d = detect(s);
  if (!d) return { xml: null, format: null };
  return { xml: s.slice(d.index), format: d.format };
}

function parseRssLike(xml, format, baseUrl, leadWords) {
  const entries = [];
  const re = /<((?:[\w.-]+:)?item)(\s[^>]*?)?>([\s\S]*?)<\/\1\s*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[2] || '';
    const block = m[3];
    const title = first(block, RSS.title)?.text ?? '';
    let link = null;
    const linkEl = first(block, RSS.link);
    if (linkEl) link = resolveUrl(linkEl.text, baseUrl);
    if (!link) {
      for (const el of elements(block, ['atom:link', 'atom10:link'])) {
        const rel = attr(el.attrs, 'rel');
        if (!rel || rel === 'alternate') { link = resolveUrl(attr(el.attrs, 'href'), baseUrl); if (link) break; }
      }
    }
    if (!link) {
      const guid = elements(block, ['guid'])[0];
      if (guid && (attr(guid.attrs, 'isPermaLink') ?? 'true').toLowerCase() !== 'false') {
        const g = elementText(guid.inner);
        if (/^https?:\/\//i.test(g)) link = resolveUrl(g, baseUrl);
      }
    }
    if (!link) link = resolveUrl(attr(attrs, 'rdf:about'), baseUrl);
    const descEl = first(block, RSS.description);
    const desc = descEl ? descriptionText(descEl.inner) : '';
    const dateEl = first(block, RSS.date);
    // No date element: some Drupal feeds (ESMA) carry the date only as <time datetime> in the description.
    const dateText = dateEl?.text || (descEl ? timeDatetime(descEl.inner) : null);
    entries.push(entry(title, link, dateText, makeLead(stripLeadingHeadline(desc, title), leadWords)));
  }
  return entries;
}

function parseAtom(xml, baseUrl, leadWords) {
  const entries = [];
  const re = /<((?:[\w.-]+:)?entry)(\s[^>]*?)?>([\s\S]*?)<\/\1\s*>/g;
  const feedBase = attr(/<(?:[\w.-]+:)?feed\b([^>]*)>/.exec(xml)?.[1] ?? '', 'xml:base');
  const base0 = resolveUrl(feedBase, baseUrl) || baseUrl;
  let m;
  while ((m = re.exec(xml))) {
    const entryBase = resolveUrl(attr(m[2] || '', 'xml:base'), base0) || base0;
    // A nested <source> carries the origin feed's own <title>/<link>; ignore it.
    const block = m[3].replace(/<((?:[\w.-]+:)?source)\b[\s\S]*?<\/\1\s*>/g, ' ');
    const title = first(block, ATOM.title)?.text ?? '';
    let link = null;
    let fallback = null;
    for (const el of elements(block, ['link', 'atom:link'])) {
      const href = resolveUrl(attr(el.attrs, 'href') ?? elementText(el.inner), entryBase);
      if (!href) continue;
      const rel = (attr(el.attrs, 'rel') || 'alternate').toLowerCase();
      const type = (attr(el.attrs, 'type') || '').toLowerCase();
      if (rel === 'alternate' && (!type || type.includes('html'))) { link = href; break; }
      if (rel === 'alternate' && !fallback) fallback = href;
      else if (!fallback && rel !== 'self' && rel !== 'replies' && rel !== 'edit' && rel !== 'enclosure') fallback = href;
    }
    if (!link) link = fallback;
    if (!link) {
      const id = first(block, ['id', 'atom:id'])?.text;
      if (id && /^https?:\/\//i.test(id)) link = resolveUrl(id, entryBase);
    }
    const summaryEl = first(block, ATOM.summary);
    const summary = summaryEl ? descriptionText(summaryEl.inner) : '';
    const dateEl = first(block, ATOM.date);
    entries.push(entry(title, link, dateEl?.text, makeLead(stripLeadingHeadline(summary, title), leadWords)));
  }
  return entries;
}

/**
 * Parse a feed document.
 * @param {string} raw  response body
 * @param {{baseUrl?: string, leadWords?: number}} opts
 * @returns {{format: 'rss'|'atom'|'rdf', title: string, entries: Array<{title:string, link:string|null, published:string|null,
 *   date_only:string|null, date_status:'ok'|'missing'|'implausible'|'unparsed', date_text?:string, lead:string}>}}
 */
export function parseFeed(raw, { baseUrl, leadWords = DEFAULT_LEAD_WORDS } = {}) {
  const { xml, format } = preprocess(raw);
  if (!xml) throw new Error('not a recognised feed (no <rss>, <feed> or <rdf:RDF> root element)');
  let channelTitle = '';
  if (format === 'atom') {
    const head = xml.split(/<(?:[\w.-]+:)?entry\b/)[0];
    channelTitle = first(head, ATOM.title)?.text ?? '';
  } else {
    const ch = /<(?:[\w.-]+:)?channel\b[\s\S]*?(?=<(?:[\w.-]+:)?item\b|<\/(?:[\w.-]+:)?channel>)/.exec(xml);
    channelTitle = ch ? first(ch[0], RSS.title)?.text ?? '' : '';
  }
  const entries = format === 'atom' ? parseAtom(xml, baseUrl, leadWords) : parseRssLike(xml, format, baseUrl, leadWords);
  return { format, title: channelTitle, entries };
}

/** Effective lead length for a source entry (default 60; paywalled sources max 40). */
export function leadWordsFor(source) {
  const requested = Number.isInteger(source?.lead_words) ? source.lead_words : DEFAULT_LEAD_WORDS;
  return source?.paywalled ? Math.min(requested, PAYWALLED_MAX_LEAD_WORDS) : requested;
}
