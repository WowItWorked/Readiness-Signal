// The Dropped page's data (owner request 2026-10-21): in-domain stories the filter judged and
// dropped, each with its reason, compiled from the live run logs (pipeline/logs/YYYY/MM/*.jsonl)
// and the backfill audit logs (pipeline/logs/backfill/*.jsonl) into docs/data/dropped.json.
// Derived and rebuilt whole every time: the logs stay the record, this file is a view of them.
//
// Rules:
//   - drops only, never Global watch records (RT_GLOBAL_WATCH, their own page); noise codes (off-domain, marketing, stale reposts, round-ups, advocacy, out of a
//     backfill window or its sections, never judged) and same-story drops are left out;
//   - cluster members fold into their lead, which counts them;
//   - a story whose URL is a source of a published item is left out (it was published later);
//   - one row per story URL: a backfill judgment (a re-judge under a later FILTER.md) replaces a
//     live one, and within a log a later row replaces an earlier one (--rejudge appends);
//   - a headline that names a financial institution is withheld (CLAUDE.md: nothing on the site
//     may state or imply an institution's position); the outlet and link remain.

import path from 'node:path';
import fs from 'node:fs';
import { findInstitutions } from './institutions.mjs';
import { listFiles, readJsonl } from './io.mjs';
import { normaliseUrl } from './url.mjs';

export const DROPPED_SCHEMA_VERSION = 1;

/** Drops that say nothing about the bar for an in-domain story (owner choice: in-domain only). */
export const NOISE_CODES = Object.freeze([
  'GL_OFF_DOMAIN', 'GL_MARKETING', 'GL_STALE', 'GL_NO_DEVELOPMENT', 'GL_ADVOCACY', 'GL_NOT_JUDGED',
  'BF_OUT_OF_WINDOW', 'BF_SECTION_EXCLUDED', 'DD_SAME_STORY',
]);

const BF_LABELS = Object.freeze({
  BF_URL_UNVERIFIED: 'the source could not be verified live',
});

/** Plain names for the tests the reason lines cite by ID (FILTER.md §3.4, §4, §5.4). */
export const ELEMENT_NAMES = Object.freeze({
  G1: 'Within the seven domains', G2: 'Public source', G3: 'Not marketing', G4: 'Not advocacy', G5: 'Formal rule scope',
  G6: 'A specific development', G7: 'Recent enough', G8: 'Verifiable sourcing', G9: 'Research standard',
  G10: 'Not one institution’s position', G11: 'Enough public facts',
  E1: 'A dated event', E2: 'Consequence floor', E2a: 'Consequence floor: disruption', E2b: 'Consequence floor: data compromise',
  E2c: 'Consequence floor: loss', E2d: 'Consequence floor: official action', E2e: 'Consequence floor: confirmed campaign',
  E2f: 'Consequence floor: provider control failure',
  E2g: 'Consequence floor: government technology restriction', E3: 'Prominence', E4: 'Relevance to financial services', E5: 'A question a director would ask',
  C1: 'A specific change', C2: 'Quality of evidence', C3: 'An assumption others rely on fails', C4: 'Widely used in financial services',
  C5: 'Novelty', C6: 'More than a routine vulnerability',
  R1: 'An eligible kind of document', R1f: 'Applies to a class of firms', R2: 'An eligible issuer or speaker', R3: 'A change of direction',
  R3b: 'About the sector, not the speaker’s own firm', R3f: 'Newly issued', R4: 'A specific topic and expectation', R4f: 'Technology-risk substance',
  R5: 'Substance confirmed from a public text', M2: 'A big enough update',
});

/** Plain names for the settings a near-miss can name (pipeline/thresholds.json). */
const KNOB_NAMES = Object.freeze({
  max_event_age_days: 'the 7-day age limit', ev_min_general_outlets: 'the general-press minimum', ev_min_independent_outlets: 'the outlet minimum',
  cs_routine_vuln_exceptions: 'the vulnerability exceptions', cs_novelty_window_days: 'the 30-day novelty window',
  cs_demonstration_evidence: 'the demonstration evidence standard', cs_accept_preprints: 'the preprint rule', rt_standard_setters: 'the standard-setter scope',
  rt_speaker_tier: 'the speaker tier', ev_gov_tech_restriction_scope: 'the government-restriction scope', rt_cyber_agencies: 'the cyber-agency scope', rt_us_bills: 'the US bill stage',
  research_require_sample: 'the research sample rule', unnamed_source_reporting: 'the unnamed-source rule', m2_min_scope_factor: 'the update size factor',
});
const SECTION_NAMES = Object.freeze({ EV: 'Executive Visibility', CS: 'Capability & Control Shift', RT: 'Regulatory & Executive Trajectory' });

/** One plain-English sentence per drop code: why stories with this code do not publish. */
export const CODE_EXPLAIN = Object.freeze({
  CS_ROUTINE_VULN: 'An exploited or newly disclosed vulnerability is routine on its own. It clears only with an exception: an attacker surviving the vendor’s full clean-up, a fix shown not to work, a compromised update channel, a flaw that defeats an identity control across customers, or a repeated or long pre-patch run in a remote-access, edge or email-security product.',
  CS_NO_SPECIFIC_CHANGE: 'Nothing changed in what attackers can do or what controls withstand: a known technique used by a new group or against a new victim is not a shift.',
  CS_MECHANISM_UNKNOWN: 'The root cause or technique has not been disclosed, so no control can be shown to have failed.',
  CS_SPECULATIVE: 'The evidence is below the bar: a prediction, a lab result against a test system, or a claim without artefacts, rather than something observed or demonstrated against products in use.',
  CS_NO_ASSUMPTION: 'The failure does not undo anything institutions commonly rely on.',
  CS_NARROW: 'The affected product or control is not widely used in financial services: a niche product, one bespoke system or one firm’s misconfiguration.',
  CS_NOT_NEW: 'The shift was already public, or is already in the archive; a repeat of a known failure is not new.',
  EV_NOT_AN_EVENT: 'Not a dated event: a trend piece, survey, forecast or explainer.',
  EV_BELOW_FLOOR: 'The consequence is below every floor, or its size was not confirmed: no outage, data loss, financial loss, penalty, confirmed campaign or government technology restriction of the required scale.',
  EV_NO_PROMINENCE: 'Not covered widely enough: it needs two independent outlets, at least one of them general or business press.',
  EV_NO_SECTOR_NEXUS: 'No link to financial services: the incident is outside the sector and its cause would not carry over to institutions.',
  EV_NO_EXEC_QUESTION: 'There is no question a director would ask unprompted about their own organisation.',
  RT_INSTRUMENT_INELIGIBLE: 'Not a kind of document the section admits: a press release, report, work programme or note rather than a speech, consultation, supervisory direction or new rule.',
  RT_JURISDICTION: 'The issuer is outside the US, UK, EU and Canada, and outside the Global watch list.',
  RT_SPEAKER_INELIGIBLE: 'The speaker or issuer does not qualify: staff below the senior tier, a trade body, or an authority type the section does not admit.',
  RT_NO_DIRECTION: 'No change of direction: it restates an existing position, repeats a published signal, or asks questions without signalling intent.',
  RT_EXEC_OWN_POSITION: 'A bank executive speaking about their own institution rather than the sector.',
  RT_INSTRUMENT_NOT_NEW: 'A rule or exam notice that is not new: a reminder, restatement, correction, extension or re-publication, or first issued too long ago.',
  RT_NOT_SPECIFIC: 'No specific technology-risk topic with an expected behaviour or obligation.',
  RT_SUBSTANCE_UNVERIFIED: 'The substance could not be confirmed from a public text.',
  GL_NOT_PUBLIC: 'The source is not public: gated, licensed or leaked.',
  GL_UNVERIFIABLE: 'It rests on claims that cannot be confirmed: leak sites, anonymous or unnamed sources, or an aggregator with no original.',
  GL_RESEARCH_EXCLUDED: 'Research that does not meet the evidence standard: no original data, no method open to scrutiny, or no disclosed sample.',
  GL_INSTITUTION_POSITION: 'Its value rests on one institution’s own position, which the site never states.',
  GL_INSUFFICIENT_SUBSTANCE: 'Too few facts to test any part of the bar.',
  GL_PAYWALL_INSUFFICIENT: 'Paywalled, and the public headline, lead and other sources do not carry enough facts to test it.',
  GL_FORMAL_RULE: 'A formal rule or exam notice while those were out of scope.',
  GL_NO_MECHANISM: 'It passed a section, but no action (a question, an indicator or an awareness rationale) could be justified.',
  BF_URL_UNVERIFIED: 'The source page could not be verified live when the backfill ran, so it could not be cited.',
});

/** Tests that FILTER.md §8.2 names by section rather than element ID. */
const TEST_FALLBACK = Object.freeze({ GL_NO_MECHANISM: 'A justified action for the reader', GL_NOT_JUDGED: 'Judged in the run' });

const elementName = (id) => ELEMENT_NAMES[id] ?? ELEMENT_NAMES[String(id).replace(/[a-z]$/, '')] ?? id;

/** A near-miss marker in a reason line, in plain English, or null. */
export function nearMissOf(reason) {
  const m = /^(?:\[M\d\] )?NEAR ([A-Z]\d+[a-z]?)(?:\/([a-z_]+))?/.exec(String(reason ?? ''));
  if (!m) return null;
  const knob = m[2] ? KNOB_NAMES[m[2]] ?? m[2].replace(/_/g, ' ') : null;
  return `Near-miss: only “${elementName(m[1])}” failed${knob ? `; loosening ${knob} one step would admit it` : ''}.`;
}

/** The other section's failed test, from an [alt …] marker, in plain English, or null. */
export function altOf(reason) {
  const m = /\[alt (EV|CS):([A-Z]\d+[a-z]?)(?:\/([a-z_]+))?\]/.exec(String(reason ?? ''));
  if (!m) return null;
  const knob = m[3] ? KNOB_NAMES[m[3]] ?? m[3].replace(/_/g, ' ') : null;
  return `Also tested as ${SECTION_NAMES[m[1]]}: failed “${elementName(m[2])}”${knob ? ` (a near-miss on ${knob})` : ''}.`;
}

/** Short label per code, from the last column of FILTER.md §8.2. */
export function codeLabels(filterText) {
  return codeInfo(filterText, 'label');
}

/** Per drop code: its short label, the test it fails (plain name) and a plain-English explanation. */
export function codeInfo(filterText, only = null) {
  const out = {};
  for (const [c, label] of Object.entries(BF_LABELS)) out[c] = { label, test: 'Source verification', explain: CODE_EXPLAIN[c] ?? null };
  for (const line of String(filterText ?? '').split('\n')) {
    const m = /^\|\s*`([A-Z][A-Z0-9_]{1,47})`\s*\|\s*drop\s*\|/.exec(line);
    if (!m) continue;
    const cells = line.split('|').map((c) => c.trim());
    const label = cells[cells.length - 2];
    const el = /^([A-Z]\d+[a-z]?)/.exec(cells[4] ?? '');
    if (label) out[m[1]] = { label: label.replace(/\s*\(§[^)]*\)/g, '').replace(/`/g, ''), test: el ? elementName(el[1]) : (TEST_FALLBACK[m[1]] ?? null), explain: CODE_EXPLAIN[m[1]] ?? null };
  }
  if (only) return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v[only]]));
  return out;
}

export const isCluster = (r) => r.dedup === 'cluster_merged' || /^cluster member of /.test(String(r.reason ?? ''));
export const dateOfRun = (runId) => (/^(\d{4}-\d{2}-\d{2})/.exec(String(runId ?? '')) || [])[1] ?? null;

/** Rows of one log file with their origin: { rows, judged: 'live'|'backfill', key } */
function readLog(file, logsDir) {
  const rel = path.relative(logsDir, file).split(path.sep);
  const judged = rel[0] === 'backfill' ? 'backfill' : 'live';
  return { rows: readJsonl(file), judged, key: path.basename(file, '.jsonl') };
}

/**
 * Build the dropped.json document. `logs` is [{ rows, judged, key }] in chronological order
 * (live logs, then backfill logs: the re-judge passes postdate the live runs they replace).
 */
export function buildDropped({ logs, archive, filterText }) {
  const info = codeInfo(filterText);
  const published = new Set();
  for (const it of Array.isArray(archive?.items) ? archive.items : []) {
    for (const s of Array.isArray(it.sources) ? it.sources : []) if (s?.url) published.add(normaliseUrl(s.url));
  }
  const byUrl = new Map();
  for (const { rows, judged, key } of logs) {
    const members = new Map();
    for (const r of rows) {
      if (r.judged === false || !r.verdict) continue;
      if (isCluster(r) && r.match_id) members.set(r.match_id, (members.get(r.match_id) ?? 0) + 1);
    }
    for (const r of rows) {
      if (r.judged === false || !r.verdict || !r.url) continue;
      const url = normaliseUrl(r.url);
      if (isCluster(r)) {
        // a cluster member never stands alone; a later judgment of it still replaces an earlier one
        byUrl.delete(url);
        continue;
      }
      // a Global watch record is not a drop to audit: it has its own page (pipeline/lib/watch.mjs)
      if (r.verdict !== 'drop' || NOISE_CODES.includes(r.reason_code) || r.reason_code === 'RT_GLOBAL_WATCH') {
        byUrl.delete(url);
        continue;
      }
      const withheld = findInstitutions(r.headline).length > 0;
      const more = members.get(r.candidate_id) ?? 0;
      // optional fields appear only when they say something (keeps the file small)
      byUrl.set(url, {
        id: r.candidate_id,
        date: judged === 'backfill' ? String(r.published ?? '').slice(0, 10) || null : dateOfRun(r.run_id),
        section: r.section_tested ?? null,
        code: r.reason_code,
        reason: r.reason,
        publication: r.publication ?? null,
        headline: withheld ? null : (r.headline ?? null),
        ...(withheld ? { headline_withheld: true } : {}),
        url: r.url,
        ...(more ? { more_sources: more } : {}),
        judged,
        run: judged === 'backfill' ? key : r.run_id,
        ...(r.rejudged === true ? { rejudged: true } : {}),
        ...(nearMissOf(r.reason) ? { near: nearMissOf(r.reason) } : {}),
        ...(altOf(r.reason) ? { alt: altOf(r.reason) } : {}),
      });
    }
  }
  const items = [...byUrl.entries()]
    .filter(([url]) => !published.has(url))
    .map(([, v]) => v)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)));
  const usedCodes = [...new Set(items.map((i) => i.code))].sort();
  return {
    schema_version: DROPPED_SCHEMA_VERSION,
    note: 'Derived from pipeline/logs by pipeline/scripts/dropped.mjs; rebuilt whole after every publish. The logs are the record.',
    codes: Object.fromEntries(usedCodes.map((c) => [c, info[c] ?? { label: c, test: null, explain: null }])),
    items,
  };
}

/** Read every log under logsDir in chronological order (live first, then backfill). */
export function readAllLogs(logsDir) {
  const files = listFiles(logsDir, (p) => p.endsWith('.jsonl'));
  const live = files.filter((f) => !path.relative(logsDir, f).startsWith(`backfill${path.sep}`));
  const backfill = files.filter((f) => path.relative(logsDir, f).startsWith(`backfill${path.sep}`));
  return [...live, ...backfill].map((f) => readLog(f, logsDir));
}

export const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
