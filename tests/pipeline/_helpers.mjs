// Shared test helpers for pipeline tests. All data here is FICTIONAL and uses example.* domains.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateId, normaliseUrl } from '../../pipeline/lib/url.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(ROOT, 'tests', 'pipeline', 'fixtures');
export const SCRIPTS = path.join(ROOT, 'pipeline', 'scripts');

export const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
export const FILTER_FIXTURE = path.join(FIXTURES, 'filter-codes.md');

export function tempDir(prefix = 'rs-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Run a pipeline script with node; returns { status, stdout, stderr, json }. */
export function runScript(name, args = [], opts = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, `${name}.mjs`), ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 60000,
  });
  let json = null;
  try {
    json = r.stdout ? JSON.parse(r.stdout) : null;
  } catch {
    json = null;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** A candidate record as fetch.mjs writes it. */
export function makeCandidate(overrides = {}) {
  const url = overrides.url ?? `https://news.example.com/story/${Math.random().toString(36).slice(2)}`;
  return {
    candidate_id: candidateId(url),
    url,
    url_normalised: normaliseUrl(url),
    source_id: 'example-news',
    publication: 'Example News',
    source_class: 'news',
    region: 'US',
    paywalled: false,
    headline: 'Example headline',
    lead: '',
    published: '2026-10-02T12:00:00.000Z',
    published_date: '2026-10-02',
    date_missing: false,
    seen: false,
    seen_verdict: null,
    also_in: [],
    ...overrides,
  };
}

/** A valid draft item (decisions.json) for the given candidates. */
export function makeDraft(cands, overrides = {}) {
  return {
    candidate_ids: cands.map((c) => c.candidate_id),
    section: 'capability_shift',
    claim: 'Attackers exploited an unpatched gateway flaw across several sectors, the vendor says.',
    domains: ['cyber', 'third_party'],
    source_class: cands[0]?.source_class ?? 'news',
    mechanism: 'candidate_issue',
    interpretation: [
      { domain: 'cyber', text: 'Edge appliances remain a primary intrusion route; patch latency is the exposure window.' },
      { domain: 'third_party', text: 'Managed providers that operate these appliances for many clients inherit the same exposure window.' },
    ],
    validation_question: 'Can the owner show every internet-facing gateway was patched or isolated within the emergency window?',
    candidate_issue_statement: 'Where emergency patches for internet-facing appliances are not tracked to completion, exploitation could go undetected and lead to network compromise.',
    awareness_rationale: null,
    sources: cands.map((c) => ({ publication: c.publication, url: c.url, headline: c.headline, published: c.published_date, source_class: c.source_class })),
    update_of: null,
    ...overrides,
  };
}

/** A stage-1 survivor record for a candidate. */
export function makeSurvivor(c, extra = {}) {
  return {
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
    profile: 'standard',
    domains: ['cyber'],
    domain_scores: { cyber: 5 },
    score: 11,
    components: { domain: 5, materiality: 4, sector: 0, enterprise: 2, noise: 0 },
    matched: { cyber: ['zero-day*'] },
    ...extra,
  };
}

export function judgment(c, overrides = {}) {
  return {
    candidate_id: c.candidate_id,
    section_tested: 'capability_shift',
    verdict: 'pass',
    reason_code: 'CS_PASS_CONTROL_FAILURE',
    reason: 'C1 exploited pre-auth flaw; C3 patch-window assumption invalidated | candidate_issue CI1-5',
    dedup: 'new',
    match_id: null,
    draft_index: 0,
    ...overrides,
  };
}

/**
 * Lay out a temp pipeline workspace: data files + work/<run_id>/ files.
 * Returns paths and the CLI path flags.
 */
export function workspace({ runId, archive, runs, seen, candidates = [], survivors = [], decisions, fetchTotals, startedAt }) {
  const dir = tempDir();
  const p = {
    dir,
    archive: path.join(dir, 'docs', 'data', 'archive.json'),
    runs: path.join(dir, 'docs', 'data', 'runs.json'),
    seen: path.join(dir, 'pipeline', 'state', 'seen.json'),
    logs: path.join(dir, 'pipeline', 'logs'),
    work: path.join(dir, 'pipeline', 'work'),
  };
  writeJson(p.archive, archive ?? { schema_version: 1, items: [] });
  writeJson(p.runs, runs ?? { schema_version: 1, runs: [] });
  writeJson(p.seen, seen ?? { schema_version: 1, urls: {} });
  if (runId) {
    const w = path.join(p.work, runId);
    writeJson(path.join(w, 'candidates.json'), { schema_version: 1, run_id: runId, generated_at: startedAt, window: { since: startedAt, until: startedAt }, candidates });
    writeJson(path.join(w, 'fetch-report.json'), {
      schema_version: 1,
      run_id: runId,
      started_at: startedAt,
      finished_at: startedAt,
      healthy: true,
      totals: { sources_ok: 4, sources_failed: 1, sources_manual: 0, fetched: 40, in_window: candidates.length, unseen: candidates.filter((c) => !c.seen).length, duplicates_in_run: 0, ...(fetchTotals ?? {}) },
      sources: [],
      manual: [],
    });
    writeJson(path.join(w, 'stage1.json'), { schema_version: 1, run_id: runId, lexicon_version: 'test', counts: {}, by_source: {}, survivors, dropped: [] });
    if (decisions) writeJson(path.join(w, 'decisions.json'), decisions);
  }
  p.flags = ['--archive', p.archive, '--runs', p.runs, '--seen', p.seen, '--logs-dir', p.logs, '--work-dir', p.work,
    '--filter', FILTER_FIXTURE, '--thresholds', path.join(dir, 'thresholds.json')];
  return p;
}
