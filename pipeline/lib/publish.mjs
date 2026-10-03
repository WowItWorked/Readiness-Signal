// Pure helpers for scripts/publish.mjs: id assignment, item finalisation, run record, log, seen.

import { DEDUP_OUTCOMES, MECHANISMS, SECTIONS } from './enums.mjs';
import { normaliseUrl } from './url.mjs';

export const SEEN_RETENTION_DAYS = 120;
const PUBLISHED_DEDUP = ['new', 'material_update', 'cluster_merged'];

export const isPublishedJudgment = (j) => j?.verdict === 'pass' && PUBLISHED_DEDUP.includes(j?.dedup);

/**
 * Order draft items by section (executive_visibility, capability_shift, regulatory_trajectory),
 * then mechanism (candidate_issue, kri_kpi, praf_coverage, awareness_only), then the primary
 * source's published date (earliest first, undated last; FILTER.md §7.9), then draft order, and
 * number them NN = 01... Returns [{ draftIndex, id }] in publication order.
 */
export function assignIds(draftItems, idStem) {
  const primaryDate = (item) => (typeof item.sources?.[0]?.published === 'string' ? item.sources[0].published : '9999-99-99');
  const order = draftItems
    .map((item, draftIndex) => ({ item, draftIndex }))
    .sort(
      (a, b) =>
        SECTIONS.indexOf(a.item.section) - SECTIONS.indexOf(b.item.section) ||
        MECHANISMS.indexOf(a.item.mechanism) - MECHANISMS.indexOf(b.item.mechanism) ||
        primaryDate(a.item).localeCompare(primaryDate(b.item)) ||
        a.draftIndex - b.draftIndex,
    );
  if (order.length > 99) throw new Error(`${order.length} items in one edition: ids allow at most 99 (NN)`);
  return order.map(({ draftIndex }, i) => ({ draftIndex, id: `${idStem}-${String(i + 1).padStart(2, '0')}` }));
}

function finaliseSource(s) {
  const out = { publication: s.publication, url: s.url };
  if (s.headline !== undefined) out.headline = s.headline;
  if (s.published !== undefined) out.published = s.published;
  if (s.source_class !== undefined) out.source_class = s.source_class;
  return out;
}

/** Draft item -> archive item in canonical key order (candidate_ids stripped). */
export function finaliseItem(draft, { id, timestamp }) {
  const awareness = draft.mechanism === 'awareness_only';
  return {
    id,
    timestamp,
    section: draft.section,
    claim: draft.claim,
    domains: [...draft.domains],
    source_class: draft.source_class,
    mechanism: draft.mechanism,
    interpretation: draft.interpretation.map((x) => ({ domain: x.domain, text: x.text })),
    validation_question: awareness ? null : draft.validation_question,
    candidate_issue_statement: awareness ? null : draft.candidate_issue_statement,
    awareness_rationale: awareness ? draft.awareness_rationale : null,
    sources: draft.sources.map(finaliseSource),
    backfilled: false,
    update_of: draft.update_of ?? null,
  };
}

export function emptyStage2BySection() {
  return Object.fromEntries(SECTIONS.map((s) => [s, { tested: 0, passed: 0 }]));
}

/** Stories, not members (FILTER.md §8.1): cluster_merged judgments are not counted. */
export function stage2BySection(judgments) {
  const out = emptyStage2BySection();
  for (const j of judgments) {
    if (!SECTIONS.includes(j?.section_tested) || j.dedup === 'cluster_merged') continue;
    out[j.section_tested].tested++;
    if (j.verdict === 'pass') out[j.section_tested].passed++;
  }
  return out;
}

export function mechanismDistribution(items) {
  const out = Object.fromEntries(MECHANISMS.map((m) => [m, 0]));
  for (const it of items) if (MECHANISMS.includes(it.mechanism)) out[it.mechanism]++;
  return out;
}

/**
 * Funnel from the work files (missing files count as zero). Stage 2 counts stories, not members
 * (FILTER.md §8.1): stage2_pass = pass judgments that are not cluster members (= items published).
 * dedup_dropped = stage-1 survivors removed by stage 3: resurfacing published stories
 * (same_story_dropped) plus members merged into another candidate's story (cluster_merged).
 */
export function computeFunnel({ fetchReport, stage1, judgments = [], published = 0 }) {
  const t = fetchReport?.totals ?? {};
  const n = (x) => (Number.isInteger(x) && x >= 0 ? x : 0);
  return {
    sources_ok: n(t.sources_ok),
    sources_failed: n(t.sources_failed),
    fetched: n(t.fetched),
    in_window: n(t.in_window),
    unseen: n(t.unseen),
    stage1_pass: Array.isArray(stage1?.survivors) ? stage1.survivors.length : 0,
    stage2_pass: judgments.filter((j) => j?.verdict === 'pass' && j.dedup !== 'cluster_merged').length,
    dedup_dropped: judgments.filter((j) => j?.dedup === 'same_story_dropped' || j?.dedup === 'cluster_merged').length,
    published,
  };
}

/** Fewer than half of the fetchable sources responded? */
export function fetchUnhealthy(fetchReport) {
  const t = fetchReport?.totals;
  if (!t) return null;
  const total = (t.sources_ok ?? 0) + (t.sources_failed ?? 0);
  if (total === 0) return { ok: 0, total: 0 };
  return t.sources_ok * 2 < total ? { ok: t.sources_ok, total } : null;
}

/** One JSONL row per stage-1 survivor. */
export function buildLogRows({ runId, survivors, judgments = [], itemIdByDraftIndex = new Map(), failedReason = null }) {
  const byCand = new Map(judgments.map((j) => [j.candidate_id, j]));
  return survivors.map((s) => {
    const j = byCand.get(s.candidate_id) ?? null;
    return {
      run_id: runId,
      candidate_id: s.candidate_id,
      url: s.url,
      publication: s.publication,
      source_id: s.source_id,
      source_class: s.source_class,
      headline: s.headline,
      stage1: { profile: s.profile ?? null, score: s.score ?? null, domains: s.domains ?? [] },
      section_tested: j ? j.section_tested : null,
      verdict: j ? j.verdict : null,
      reason_code: j ? j.reason_code : failedReason ? 'RUN_FAILED' : null,
      reason: j ? j.reason : failedReason,
      dedup: j ? j.dedup : null,
      match_id: j?.match_id ?? null,
      item_id: j && isPublishedJudgment(j) ? itemIdByDraftIndex.get(j.draft_index) ?? null : null,
    };
  });
}

/** Code given to survivors the run's time budget left unjudged (RUNBOOK step 9.5). */
export const NOT_JUDGED_CODE = 'GL_NOT_JUDGED';

/**
 * Add this run's judged candidates (and extra sources attached to items) to seen.json, then prune
 * entries older than SEEN_RETENTION_DAYS. Existing entries are never overwritten. Survivors
 * dropped GL_NOT_JUDGED were never judged, so they are not marked seen: the next run collects
 * them again while they are inside its window (RUNBOOK step 9.5).
 */
export function updateSeen(seenDoc, { runId, firstSeen, now, survivors, judgments, draftItems, candidatesById, itemIdByDraftIndex }) {
  const urls = { ...(seenDoc?.urls ?? {}) };
  let added = 0;
  const put = (url, entry) => {
    const key = normaliseUrl(url);
    if (!key || urls[key]) return;
    urls[key] = entry;
    added++;
  };
  const byCand = new Map(judgments.map((j) => [j.candidate_id, j]));
  for (const s of survivors) {
    const j = byCand.get(s.candidate_id);
    if (!j || j.reason_code === NOT_JUDGED_CODE) continue;
    let verdict = 'dropped';
    let itemId = null;
    if (isPublishedJudgment(j)) {
      verdict = 'published';
      itemId = itemIdByDraftIndex.get(j.draft_index) ?? null;
    } else if (j.dedup === 'same_story_dropped') {
      verdict = 'duplicate';
    }
    put(s.url, { first_seen: firstSeen, run_id: runId, verdict, item_id: itemId });
  }
  draftItems.forEach((item, i) => {
    for (const cid of item.candidate_ids ?? []) {
      const c = candidatesById.get(cid);
      if (c) put(c.url, { first_seen: firstSeen, run_id: runId, verdict: 'published', item_id: itemIdByDraftIndex.get(i) ?? null });
    }
  });
  const cutoff = now.getTime() - SEEN_RETENTION_DAYS * 86400e3;
  let pruned = 0;
  for (const [k, e] of Object.entries(urls)) {
    const t = Date.parse(e?.first_seen);
    if (Number.isFinite(t) && t < cutoff) {
      delete urls[k];
      pruned++;
    }
  }
  return { doc: { schema_version: 1, urls }, added, pruned };
}

/**
 * Survivors that seen.json now records as published or duplicate. In a normal run there are none
 * (stage 1 drops seen candidates); after a rebase or reset brings in another run's seen.json they
 * name the candidates to re-check against FILTER.md §5 before publishing.
 */
export function seenConflicts(survivors, seenDoc) {
  const urls = seenDoc?.urls && typeof seenDoc.urls === 'object' ? seenDoc.urls : {};
  const out = [];
  for (const s of survivors ?? []) {
    const e = urls[normaliseUrl(s?.url)];
    if (e && (e.verdict === 'published' || e.verdict === 'duplicate')) {
      out.push({ candidate_id: s.candidate_id, headline: s.headline, verdict: e.verdict, item_id: e.item_id ?? null, run_id: e.run_id ?? null });
    }
  }
  return out;
}

export { DEDUP_OUTCOMES };
