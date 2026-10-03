// Dedup hints (SPEC §5 step 3): cheap, conservative story-similarity signals. The agent makes the
// final call; these only point at likely matches.
//
// Evidence per pair:
//   jaccard          token-set Jaccard of headline/claim tokens after stopwording and light stemming
//   shared_cves      CVE ids in common (headline + lead / item text)
//   shared_proper    distinctive proper nouns in common (acronyms, CamelCase, alphanumerics, capitalised
//                    words outside title-case headlines), minus very common names
//   shared_numbers   distinctive figures in common ($25m, 3.2 billion, 41%, 13,000)
//
// score = jaccard + PROPER_BONUS x min(shared_proper, 3) + NUMBER_BONUS x min(shared_numbers, 2);
// a shared CVE sets score >= 0.9 when either side names at most CVE_FOCUS CVEs (else >= 0.6).
// level: 'exact' (same normalised URL), 'likely' (>= LIKELY), 'possible' (>= POSSIBLE).
// Clusters among this run's survivors join 'likely'/'exact' pairs only.

import { normaliseUrl } from './url.mjs';

export const THRESHOLDS = Object.freeze({ LIKELY: 0.55, POSSIBLE: 0.35 });
export const PROPER_BONUS = 0.12;
export const NUMBER_BONUS = 0.08;
export const CVE_FOCUS = 2;
export const ARCHIVE_WINDOW_DAYS = 21;

export const STOPWORDS = new Set(`a about above after again against all also am amid an and any are as at be because been
before being below between both but by can could did do does doing down during each few for from further had has have having
he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other
our out over own same she should so some such than that the their them then there these they this those through to too under
until up upon very via was we were what when where which while who whom why will with would you your yours
says said say report reports reported reporting new warns warn warning amid after over could would may might
latest update updates updated announces announced according week today year years day days time percent per cent
more less first last one two three four five six seven eight nine ten using use used uses like get gets got make makes
just now still yet already ahead across within without against toward towards behind among
cisa kev adds add catalog catalogue known vulnerability vulnerabilities flaw flaws bug bugs critical severity high
attack attacks attacker attackers hacker hackers exploit exploits exploited exploiting exploitation security cyber
threat threats actor actors multiple products product`.split(/\s+/).filter(Boolean));

/** Names so common in this corpus that sharing them says little. */
export const COMMON_NAMES = new Set(`US UK EU AI CEO CFO CTO CISO CISA FBI NSA SEC FTC DOJ NIST NCSC ECB FED IMF BIS FSB
UN NATO USA OK API APIs IT OT IoT VPN SaaS GDPR Microsoft Google Apple Amazon AWS Meta Windows Linux Android iOS Chrome
Cloud Azure Office Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July
August September October November December Q1 Q2 Q3 Q4 CVE KEV RCE PoC RAT C2 MFA SSO`.split(/\s+/).filter(Boolean).map((s) => s.toLowerCase()));

const stem = (w) => {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
};

const norm = (s) => String(s ?? '').normalize('NFC').replace(/[‘’]/g, "'");

export function tokenize(text) {
  const out = new Set();
  const cleaned = norm(text).replace(/\bCVE-\d{4}-\d{4,}\b/gi, ' ');
  for (const raw of cleaned.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue; // figures are compared separately
    out.add(stem(raw));
  }
  return out;
}

export function extractCves(text) {
  return new Set((norm(text).match(/\bCVE-\d{4}-\d{4,}\b/gi) ?? []).map((c) => c.toUpperCase()));
}

export function extractNumbers(text) {
  const out = new Set();
  const s = norm(text).replace(/\bCVE-\d{4}-\d{4,}\b/gi, ' ');
  const re = /(\d[\d,]*(?:\.\d+)?)\s?(%|percent\b|per cent\b|million\b|billion\b|trillion\b|bn\b|m\b|k\b|tb\b|gb\b)?/gi;
  let m;
  while ((m = re.exec(s))) {
    const num = m[1].replace(/,/g, '');
    const unitRaw = (m[2] ?? '').toLowerCase();
    const unit = { percent: '%', 'per cent': '%', million: 'm', billion: 'b', bn: 'b', trillion: 't' }[unitRaw] ?? unitRaw;
    const value = Number(num);
    if (!Number.isFinite(value)) continue;
    if (!unit) {
      if (/^(19|20)\d{2}$/.test(num)) continue; // years
      if (value < 100) continue; // small counts are not distinctive
    }
    out.add(`${num.replace(/\.0+$/, '')}${unit}`);
  }
  return out;
}

export function extractProperNouns(text) {
  const out = new Set();
  const s = norm(text).replace(/\bCVE-\d{4}-\d{4,}\b/gi, ' ');
  const words = s.match(/[\p{L}\p{N}][\p{L}\p{N}&'.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? [];
  const long = words.filter((w) => /^\p{L}/u.test(w) && w.length > 3);
  const titleCase = long.length > 0 && long.filter((w) => /^\p{Lu}/u.test(w)).length / long.length > 0.6;
  words.forEach((w, i) => {
    const clean = w.replace(/['.]+$/g, '').replace(/'s$/i, '');
    const lower = clean.toLowerCase();
    if (clean.length < 2 || COMMON_NAMES.has(lower) || STOPWORDS.has(lower)) return;
    const acronym = /^[\p{Lu}\p{N}&-]{2,10}$/u.test(clean) && /\p{Lu}/u.test(clean) && !/^\d+$/.test(clean);
    const innerCaps = /^[\p{L}-]+$/u.test(clean) && /\p{Lu}/u.test(clean.slice(1)) && /\p{Ll}/u.test(clean);
    const alnum = /\p{L}/u.test(clean) && /\p{N}/u.test(clean);
    const capitalised = /^\p{Lu}\p{Ll}/u.test(clean) && clean.length > 2 && !titleCase && i > 0;
    if (acronym || innerCaps || alnum || capitalised) out.add(lower);
  });
  return out;
}

/** Prepare a comparable document. `texts` are the short strings compared by Jaccard (headline/claim). */
export function prepareDoc({ id, texts = [], context = '', urls = [] }) {
  const variants = texts.filter(Boolean).map((t) => tokenize(t));
  const all = [...texts, context].join(' \n ');
  return {
    id,
    variants,
    cves: extractCves(all),
    proper: extractProperNouns(texts.join(' . ')),
    numbers: extractNumbers(texts.join(' . ')),
    urls: new Set(urls.map(normaliseUrl).filter(Boolean)),
  };
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const intersect = (a, b) => [...a].filter((x) => b.has(x));
const r2 = (n) => Math.round(n * 100) / 100;

/** Compare two prepared docs. */
export function compareDocs(a, b) {
  let jac = 0;
  for (const va of a.variants) for (const vb of b.variants) jac = Math.max(jac, jaccard(va, vb));
  const sharedCves = intersect(a.cves, b.cves);
  const sharedProper = intersect(a.proper, b.proper);
  const sharedNumbers = intersect(a.numbers, b.numbers);
  const sameUrl = intersect(a.urls, b.urls).length > 0;
  let score = jac + PROPER_BONUS * Math.min(sharedProper.length, 3) + NUMBER_BONUS * Math.min(sharedNumbers.length, 2);
  if (sharedCves.length) {
    const focused = Math.min(a.cves.size, b.cves.size) <= CVE_FOCUS;
    score = Math.max(score, focused ? 0.9 : 0.6);
  }
  if (sameUrl) score = 1;
  score = r2(Math.min(score, 1));
  const level = sameUrl ? 'exact' : score >= THRESHOLDS.LIKELY ? 'likely' : score >= THRESHOLDS.POSSIBLE ? 'possible' : null;
  return {
    score,
    level,
    evidence: { jaccard: r2(jac), shared_cves: sharedCves, shared_proper: sharedProper, shared_numbers: sharedNumbers, same_url: sameUrl },
  };
}

export function candidateDoc(s) {
  return prepareDoc({ id: s.candidate_id, texts: [s.headline], context: s.lead ?? '', urls: [s.url] });
}

export function archiveDoc(item) {
  const texts = [item.claim, ...(item.sources ?? []).map((x) => x.headline).filter(Boolean)];
  const context = [
    ...(item.interpretation ?? []).map((x) => x.text),
    item.validation_question,
    item.candidate_issue_statement,
    item.awareness_rationale,
  ].filter(Boolean).join(' ');
  return prepareDoc({ id: item.id, texts, context, urls: (item.sources ?? []).map((x) => x.url) });
}

/**
 * Build hints for stage-1 survivors against recent archive items and each other.
 * @param {object[]} survivors stage1.json survivors
 * @param {object[]} archiveItems archive items (already restricted to the window)
 */
export function buildHints(survivors, archiveItems) {
  const cDocs = survivors.map(candidateDoc);
  const aDocs = archiveItems.map(archiveDoc);
  const byId = new Map(archiveItems.map((i) => [i.id, i]));
  const parent = cDocs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const pairs = new Map();

  for (let i = 0; i < cDocs.length; i++) {
    for (let j = i + 1; j < cDocs.length; j++) {
      const r = compareDocs(cDocs[i], cDocs[j]);
      if (!r.level) continue;
      pairs.set(`${i}:${j}`, r);
      if (r.level === 'likely' || r.level === 'exact') parent[find(i)] = find(j);
    }
  }

  const clusterIds = new Map();
  const members = new Map();
  cDocs.forEach((_, i) => {
    const root = find(i);
    if (!members.has(root)) members.set(root, []);
    members.get(root).push(i);
  });
  let k = 0;
  const clusters = [];
  for (const [, idx] of members) {
    if (idx.length < 2) continue;
    const cid = `k${++k}`;
    idx.forEach((i) => clusterIds.set(i, cid));
    clusters.push({
      cluster_id: cid,
      candidate_ids: idx.map((i) => survivors[i].candidate_id),
      headlines: idx.map((i) => survivors[i].headline),
    });
  }

  const hints = survivors.map((s, i) => {
    const archive_matches = aDocs
      .map((d) => ({ d, r: compareDocs(cDocs[i], d) }))
      .filter((x) => x.r.level)
      .sort((x, y) => y.r.score - x.r.score)
      .slice(0, 5)
      .map(({ d, r }) => ({
        item_id: d.id,
        claim: byId.get(d.id)?.claim ?? null,
        timestamp: byId.get(d.id)?.timestamp ?? null,
        score: r.score,
        level: r.level,
        evidence: r.evidence,
      }));
    const candidate_matches = [];
    for (let j = 0; j < cDocs.length; j++) {
      if (j === i) continue;
      const r = pairs.get(i < j ? `${i}:${j}` : `${j}:${i}`);
      if (!r) continue;
      candidate_matches.push({ candidate_id: survivors[j].candidate_id, headline: survivors[j].headline, score: r.score, level: r.level, evidence: r.evidence });
    }
    candidate_matches.sort((x, y) => y.score - x.score);
    return {
      candidate_id: s.candidate_id,
      headline: s.headline,
      cluster: clusterIds.get(i) ?? null,
      archive_matches,
      candidate_matches,
    };
  });
  return { hints, clusters };
}
