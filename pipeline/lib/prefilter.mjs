// Stage 1 (SPEC §5 step 2): seen / roundup / marketing drops, then lexicon scoring.
// The lexicon and every weight live in lexicon.mjs; this module only applies them.

import {
  ADVERSARY_SUBJECT, AUTHORITY_HOSTS, CAPS, CLASS_PROFILE, DOMAIN_CAP, DOMAIN_QUALIFY, DOMAIN_TERMS, DOMAIN_TOTAL_CAP,
  ENTERPRISE_TERMS, EVENT_URL_SEGMENTS, HIGH_VOLUME_HOSTS, KEV_ANNOUNCEMENT, LEAD_FACTOR, LEXICON_VERSION, MARKETING_PATTERNS,
  MATERIALITY_GROUPS, NOISE, PROFILES, ROUNDUP_PATTERNS, SECTOR_TERMS, STANDARD_PATH_SEGMENTS, WEIGHTS,
} from './lexicon.mjs';
import { DOMAINS } from './enums.mjs';
import { findInstitutions } from './institutions.mjs';
import { hostOf } from './url.mjs';

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compile a lexicon term (see TERM SYNTAX in lexicon.mjs). */
export function compileTerm(term) {
  if (term.startsWith('re:')) return { id: term.slice(3), re: new RegExp(term.slice(3), 'iu') };
  let t = term;
  let caseSensitive = false;
  if (t.startsWith('cs:')) {
    caseSensitive = true;
    t = t.slice(3);
  }
  let wildcard = false;
  if (t.endsWith('*')) {
    wildcard = true;
    t = t.slice(0, -1);
  }
  const parts = t.split(/[\s-]+/).filter(Boolean).map(reEscape);
  let body = parts.join('[\\s\\-]?');
  if (wildcard) body += '[\\p{L}\\p{N}]*';
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, caseSensitive ? 'u' : 'iu');
  return { id: term.replace(/^cs:/, ''), re };
}

const compileTiers = (tiers) =>
  Object.entries(tiers).map(([tier, terms]) => ({
    weight: typeof WEIGHTS[tier] === 'number' ? WEIGHTS[tier] : Number(tier),
    tier,
    terms: terms.map(compileTerm),
  }));

const C = {
  domains: Object.fromEntries(DOMAINS.map((d) => [d, compileTiers(DOMAIN_TERMS[d])])),
  materiality: Object.fromEntries(Object.entries(MATERIALITY_GROUPS).map(([g, tiers]) => [g, compileTiers(tiers)])),
  sector: compileTiers(SECTOR_TERMS),
  enterprise: compileTiers(ENTERPRISE_TERMS),
  noise: Object.fromEntries(Object.entries(NOISE).map(([k, tiers]) => [k, compileTiers(tiers)])),
};

export function normaliseText(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-–]/g, '-');
}

const onHost = (hosts, list) => hosts.some((h) => list.some((x) => h === x || h.endsWith(`.${x}`)));

const pathSegments = (url) => {
  try {
    return new URL(url).pathname.toLowerCase().split('/').filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Profile for a candidate: sources.json override, high-volume host, ICS/medical product
 * advisories (standard), a government CERT's vendor_threat_research feed (authority), else by
 * class (lexicon.mjs CLASS_PROFILE: primary for other vendor_threat_research).
 */
export function profileFor(candidate, source) {
  if (source?.prefilter && PROFILES[source.prefilter]) return source.prefilter;
  const hosts = [hostOf(candidate.url), hostOf(source?.url)].filter(Boolean);
  if (onHost(hosts, HIGH_VOLUME_HOSTS)) return 'high_volume';
  if (candidate.source_class === 'vendor_threat_research') {
    if (pathSegments(candidate.url).some((s) => STANDARD_PATH_SEGMENTS.includes(s))) return 'standard';
    if (onHost(hosts, AUTHORITY_HOSTS)) return 'authority';
  }
  return CLASS_PROFILE[candidate.source_class] ?? 'standard';
}

function hitFactor(re, title, lead) {
  if (re.test(title)) return 1;
  if (lead && re.test(lead)) return LEAD_FACTOR;
  return 0;
}

/**
 * Matches for a tier list, de-duplicated by text span: where several terms match overlapping text
 * (e.g. 'ai agent*', 'AI' and 'agents' on "AI agents") only the heaviest counts.
 */
function collectHits(tiers, title, lead) {
  const raw = [];
  for (const { weight, tier, terms } of tiers) {
    for (const t of terms) {
      let m = t.re.exec(title);
      let field = 'title';
      if (!m && lead) {
        m = t.re.exec(lead);
        field = 'lead';
      }
      if (!m) continue;
      const f = field === 'title' ? 1 : LEAD_FACTOR;
      raw.push({ id: t.id, tier, value: weight * f, field, start: m.index, end: m.index + m[0].length });
    }
  }
  raw.sort((a, b) => b.value - a.value || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  for (const h of raw) {
    if (kept.some((k) => k.field === h.field && h.start < k.end && k.start < h.end)) continue;
    kept.push(h);
  }
  return kept;
}

const label = (h) => (h.field === 'lead' ? `${h.id} (lead)` : h.id);

const round1 = (n) => Math.round(n * 10) / 10;

/** Score one candidate. Pure. */
export function scoreCandidate(candidate, profileName = 'standard') {
  const profile = PROFILES[profileName] ?? PROFILES.standard;
  const title = normaliseText(candidate.headline);
  const lead = normaliseText(candidate.lead);
  const matched = {};
  const domainScores = {};
  let strongInTitle = false;

  for (const d of DOMAINS) {
    const hits = collectHits(C.domains[d], title, lead);
    if (!hits.length) continue;
    const s = hits.reduce((n, h) => n + h.value, 0);
    matched[d] = hits.map(label);
    if (hits.some((h) => h.tier === 'strong' && h.field === 'title')) strongInTitle = true;
    domainScores[d] = round1(Math.min(s, DOMAIN_CAP));
  }
  const domains = DOMAINS.filter((d) => (domainScores[d] ?? 0) >= DOMAIN_QUALIFY).sort(
    (a, b) => domainScores[b] - domainScores[a] || DOMAINS.indexOf(a) - DOMAINS.indexOf(b),
  );
  const domainTotal = Math.min(domains.reduce((n, d) => n + domainScores[d], 0), DOMAIN_TOTAL_CAP);

  let materiality = 0;
  for (const [group, tiers] of Object.entries(C.materiality)) {
    let best = 0;
    let bestId = null;
    for (const { weight, terms } of tiers) {
      for (const t of terms) {
        const f = hitFactor(t.re, title, lead);
        if (f && weight * f > best) {
          best = weight * f;
          bestId = f < 1 ? `${t.id} (lead)` : t.id;
        }
      }
    }
    if (best) {
      materiality += best;
      (matched.materiality ??= []).push(`${group}: ${bestId}`);
    }
  }
  materiality = Math.min(materiality, CAPS.materiality);

  const sumTiers = (tiers, key) => {
    const hits = collectHits(tiers, title, lead);
    if (hits.length) matched[key] = hits.map(label);
    return hits.reduce((n, h) => n + h.value, 0);
  };

  let sector = sumTiers(C.sector, 'sector');
  const instTitle = findInstitutions(title);
  const instLead = instTitle.length ? [] : findInstitutions(lead);
  if (instTitle.length) {
    sector += 2;
    (matched.sector ??= []).push(`institution: ${instTitle[0].name}`);
  } else if (instLead.length) {
    sector += 1;
    (matched.sector ??= []).push(`institution: ${instLead[0].name} (lead)`);
  }
  sector = Math.min(sector, CAPS.sector);
  const enterprise = Math.min(sumTiers(C.enterprise, 'enterprise'), CAPS.enterprise);
  const noise = sumTiers(profile.noise.flatMap((n) => C.noise[n] ?? []), 'noise');

  const score = round1(domainTotal + materiality + sector + enterprise - noise);
  return {
    domains,
    domain_scores: domainScores,
    score,
    components: {
      domain: round1(domainTotal),
      materiality: round1(materiality),
      sector: round1(sector),
      enterprise: round1(enterprise),
      noise: round1(noise),
    },
    strong_in_title: strongInTitle,
    matched,
  };
}

/** The event-listing URL path segment of a candidate URL, or null (EVENT_URL_SEGMENTS). */
export function eventUrlSegment(url) {
  let path;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  return path.split('/').find((seg) => EVENT_URL_SEGMENTS.includes(seg)) ?? null;
}

/** Outright drops that precede scoring. Returns { reason, detail } or null. */
export function outrightDrop(candidate, profileName, { hasKevSource = false } = {}) {
  const title = normaliseText(candidate.headline);
  const lead = normaliseText(candidate.lead);
  const seg = candidate.kev ? null : eventUrlSegment(candidate.url);
  if (seg) return { reason: 'event', detail: `event listing URL (/${seg}/)` };
  for (const [name, re] of ROUNDUP_PATTERNS) if (re.test(title)) return { reason: 'roundup', detail: name };
  if (hasKevSource && KEV_ANNOUNCEMENT.test(title)) return { reason: 'redundant', detail: 'CISA KEV announcement duplicates the KEV catalogue source' };
  // Regulators publish no marketing; a KEV entry's composed headline ("... Cloud Platform ...")
  // would trip the product-launch pattern on its "adds".
  if (profileName === 'lenient' || candidate.kev) return null;
  for (const [name, re] of MARKETING_PATTERNS) {
    if (name === 'sponsored' && re.test(lead)) return { reason: 'marketing', detail: name };
    const m = re.exec(title);
    if (!m) continue;
    // "Hackers launch ...", "Ransomware gang raises ..." describe adversaries, not vendors.
    const always = name === 'sponsored' || name === 'webinar';
    if (!always && ADVERSARY_SUBJECT.test(title.slice(0, m.index))) continue;
    return { reason: 'marketing', detail: name };
  }
  return null;
}

/** Threshold rule for a scored candidate (KEV entries use the enterprise/sector/ransomware rule). */
export function passRule(candidate, scored, profileName) {
  if (candidate.kev) {
    const ransomware = String(candidate.kev.known_ransomware_use ?? '').toLowerCase() === 'known';
    if (scored.components.enterprise > 0 || scored.components.sector > 0 || ransomware) return { pass: true, detail: null };
    return { pass: false, detail: 'KEV entry outside ubiquitous enterprise technology, no sector link, no known ransomware use' };
  }
  const rule = PROFILES[profileName] ?? PROFILES.standard;
  if (rule.strongInTitle && !scored.strong_in_title) return { pass: false, detail: `${profileName} profile: no strong domain term in headline` };
  if (scored.score < rule.threshold) return { pass: false, detail: `score ${scored.score} < ${rule.threshold}` };
  return { pass: true, detail: null };
}

/**
 * Run stage 1 over candidates.
 * @param {object[]} candidates  candidates.json entries
 * @param {{sources?: Map<string, object>, hasKevSource?: boolean}} opts
 */
export function runPrefilter(candidates, { sources = new Map(), hasKevSource } = {}) {
  const kev = hasKevSource ?? (candidates.some((c) => c.kev) || [...sources.values()].some((s) => s.type === 'cisa-kev' && s.enabled !== false));
  const survivors = [];
  const dropped = [];
  // Search-found sources registered with add-manual.mjs --extra are attachments for items, not
  // candidates: they are never scored or judged, and they are left out of every count but `extra`.
  const pool = candidates.filter((c) => !c.extra);
  const counts = { input: pool.length, seen: 0, event: 0, roundup: 0, redundant: 0, marketing: 0, off_domain: 0, below_threshold: 0, passed: 0, extra: candidates.length - pool.length };
  const bySource = {};

  for (const c of pool) {
    const source = sources.get(c.source_id);
    const profile = profileFor(c, source);
    const bs = (bySource[c.source_id] ??= { profile, input: 0, unseen: 0, passed: 0 });
    bs.input++;
    const base = { candidate_id: c.candidate_id, source_id: c.source_id, headline: c.headline };
    if (c.seen) {
      counts.seen++;
      dropped.push({ ...base, reason: 'seen', detail: c.seen_verdict ?? null });
      continue;
    }
    bs.unseen++;
    const out = outrightDrop(c, profile, { hasKevSource: kev });
    if (out) {
      counts[out.reason]++;
      dropped.push({ ...base, reason: out.reason, detail: out.detail });
      continue;
    }
    const s = scoreCandidate(c, profile);
    const rule = PROFILES[profile];
    if (!s.domains.length) {
      counts.off_domain++;
      dropped.push({ ...base, reason: 'off_domain', score: s.score, detail: null });
      continue;
    }
    const verdict = passRule(c, s, profile);
    if (!verdict.pass) {
      counts.below_threshold++;
      dropped.push({ ...base, reason: 'below_threshold', score: s.score, detail: verdict.detail });
      continue;
    }
    counts.passed++;
    bs.passed++;
    survivors.push({
      candidate_id: c.candidate_id,
      url: c.url,
      headline: c.headline,
      lead: c.lead,
      publication: c.publication,
      source_id: c.source_id,
      source_class: c.source_class,
      region: c.region,
      paywalled: c.paywalled,
      published: c.published,
      published_date: c.published_date,
      ...(c.also_in?.length ? { also_in: c.also_in } : {}),
      ...(c.kev ? { kev: c.kev } : {}),
      ...(c.headline_composed ? { headline_composed: true } : {}),
      ...(c.manual ? { manual: true } : {}),
      profile,
      domains: s.domains,
      domain_scores: s.domain_scores,
      score: s.score,
      components: s.components,
      matched: s.matched,
    });
  }
  survivors.sort((a, b) => b.score - a.score);
  return { lexicon_version: LEXICON_VERSION, counts, by_source: bySource, survivors, dropped };
}
