// publish.mjs end to end in temp dirs: published, silent, failed, dry-run, refusals, append-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkAppendOnly, validateArchive, validateRuns } from '../../pipeline/lib/validate.mjs';
import { assignIds } from '../../pipeline/lib/publish.mjs';
import { judgment, makeCandidate, makeDraft, makeSurvivor, readJson, rmrf, runScript, workspace } from './_helpers.mjs';

const RUN = '2026-10-02-1400';
const STARTED = '2026-10-02T14:03:12-04:00';
const NOW = '2026-10-02T14:21:40-04:00';

function scenario() {
  const gw1 = makeCandidate({ url: 'https://news.example.com/gateway-zero-day?utm_source=rss', headline: 'Gateway zero-day exploited against several sectors', lead: 'Threat actors are actively exploiting a pre-authentication flaw in Example Gateway devices, the vendor said.' });
  const gw2 = makeCandidate({ url: 'https://wire.example.org/gateway-flaw', publication: 'Example Wire', headline: 'Example Gateway flaw under attack' });
  const reg = makeCandidate({ url: 'https://supervisor.example.gov/speeches/ai-model-risk', publication: 'Example Supervisor', source_class: 'regulator', headline: 'Speech on AI model risk expectations', published_date: '2026-10-01' });
  const fraud = makeCandidate({ url: 'https://news.example.com/mules', headline: 'Mule networks shift to instant payments' });
  const dropped = makeCandidate({ url: 'https://news.example.com/noise', headline: 'Vendor patches minor bug' });
  const candidates = [gw1, gw2, reg, fraud, dropped];
  const survivors = candidates.map((c) => makeSurvivor(c));
  const decisions = {
    run_id: RUN,
    threshold_level: 'high',
    judgments: [
      judgment(gw1, { draft_index: 1 }),
      judgment(gw2, { draft_index: 1, dedup: 'cluster_merged', match_id: gw1.candidate_id }),
      judgment(reg, { section_tested: 'regulatory_trajectory', reason_code: 'RT_PASS_SPEECH', draft_index: 0 }),
      judgment(fraud, { section_tested: 'executive_visibility', reason_code: 'EV_PASS_LOSS', draft_index: 2 }),
      judgment(dropped, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'C1 routine patch, nothing specific changed', draft_index: null }),
    ],
    items: [
      makeDraft([reg], {
        section: 'regulatory_trajectory',
        claim: 'A supervisor signalled closer scrutiny of AI model validation in a speech.',
        domains: ['ai'],
        source_class: 'regulator',
        mechanism: 'awareness_only',
        interpretation: [{ domain: 'ai', text: 'Validation evidence for AI models is becoming a supervisory expectation rather than good practice.' }],
        validation_question: null,
        candidate_issue_statement: null,
        awareness_rationale: 'The remarks indicate direction only; no control, metric or framework change follows until formal guidance appears.',
      }),
      makeDraft([gw1, gw2]),
      makeDraft([fraud], {
        section: 'executive_visibility',
        claim: 'Mule networks moved stolen funds through instant payment rails within minutes, police say.',
        domains: ['fraud'],
        mechanism: 'kri_kpi',
        interpretation: [{ domain: 'fraud', text: 'Time-to-exit for mule funds is shrinking, compressing the window for recovery.' }],
        validation_question: 'Is the time from inbound fraud report to mule-account freeze measured and reported?',
        candidate_issue_statement: 'If mule-account freeze times are not measured, recovery failures may go unnoticed.',
      }),
    ],
    notes: 'Fixture run.',
  };
  return { candidates, survivors, decisions, gw1, gw2, reg, fraud, dropped };
}

test('published run: ids by section then mechanism, slot timestamp, run record, log, seen, append-only', () => {
  const s = scenario();
  const ws = workspace({ runId: RUN, candidates: s.candidates, survivors: s.survivors, decisions: s.decisions, startedAt: STARTED });
  try {
    const before = { archive: readJson(ws.archive), runs: readJson(ws.runs) };
    const r = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
    assert.equal(r.status, 0, r.stderr);
    const archive = readJson(ws.archive);
    const runs = readJson(ws.runs);
    assert.equal(archive.items.length, 3);
    // executive_visibility first, then capability_shift, then regulatory_trajectory
    assert.deepEqual(archive.items.map((i) => [i.id, i.section, i.mechanism]), [
      ['RS-261002-1400-01', 'executive_visibility', 'kri_kpi'],
      ['RS-261002-1400-02', 'capability_shift', 'candidate_issue'],
      ['RS-261002-1400-03', 'regulatory_trajectory', 'awareness_only'],
    ]);
    for (const it of archive.items) {
      assert.equal(it.timestamp, '2026-10-02T14:00:00-04:00');
      assert.equal(it.backfilled, false);
      assert.equal(it.update_of, null);
      assert.ok(!('candidate_ids' in it));
    }
    assert.equal(archive.items[1].sources.length, 2);
    assert.equal(archive.items[2].validation_question, null);
    assert.equal(archive.items[0].awareness_rationale, null);
    const rec = runs.runs[0];
    assert.equal(rec.status, 'published');
    assert.equal(rec.slot, '2026-10-02T14:00:00-04:00');
    assert.equal(rec.started_at, STARTED);
    assert.equal(rec.finished_at, NOW);
    assert.deepEqual(rec.items, ['RS-261002-1400-01', 'RS-261002-1400-02', 'RS-261002-1400-03']);
    assert.deepEqual(rec.funnel, { sources_ok: 4, sources_failed: 1, fetched: 40, in_window: 5, unseen: 5, stage1_pass: 5, stage2_pass: 3, dedup_dropped: 1, published: 3 });
    assert.deepEqual(rec.stage2_by_section, {
      executive_visibility: { tested: 1, passed: 1 },
      capability_shift: { tested: 2, passed: 1 },
      regulatory_trajectory: { tested: 1, passed: 1 },
    });
    assert.deepEqual(rec.mechanism_distribution, { candidate_issue: 1, kri_kpi: 1, praf_coverage: 0, awareness_only: 1 });
    assert.equal(rec.notes, 'Fixture run.');
    assert.equal(rec.threshold_level, 'high');
    // file format: 2-space JSON with trailing newline
    const text = fs.readFileSync(ws.archive, 'utf8');
    assert.ok(text.endsWith('}\n'));
    assert.ok(text.includes('\n  "items": ['));
    // log rows: one per survivor, with verdicts and item ids
    const logFile = path.join(ws.logs, '2026', '10', `${RUN}.jsonl`);
    const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 5);
    assert.equal(rows.find((x) => x.candidate_id === s.gw2.candidate_id).item_id, 'RS-261002-1400-02');
    assert.equal(rows.find((x) => x.candidate_id === s.dropped.candidate_id).verdict, 'drop');
    // seen: every judged survivor recorded under its normalised URL
    const seen = readJson(ws.seen);
    assert.equal(Object.keys(seen.urls).length, 5);
    assert.equal(seen.urls['https://news.example.com/gateway-zero-day'].verdict, 'published');
    assert.equal(seen.urls['https://news.example.com/gateway-zero-day'].item_id, 'RS-261002-1400-02');
    assert.equal(seen.urls['https://news.example.com/noise'].verdict, 'dropped');
    // stdout summary + commit message
    assert.equal(r.json.status, 'published');
    assert.equal(r.json.commit_message, 'edition: 2026-10-02 14:00 ET (+3 items)');
    // result is valid and append-only relative to before
    assert.deepEqual(validateArchive(archive).errors, []);
    assert.deepEqual(validateRuns(runs, archive).errors, []);
    assert.deepEqual(checkAppendOnly(before.archive, archive, 'archive').errors, []);
    assert.deepEqual(checkAppendOnly(before.runs, runs, 'runs').errors, []);

    // same slot again: refused, nothing changes
    const archiveText = fs.readFileSync(ws.archive, 'utf8');
    const again = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already exists/);
    assert.equal(fs.readFileSync(ws.archive, 'utf8'), archiveText);

    // a later run appends without touching earlier items (append-only preserved)
    const later = '2026-10-02-1800';
    const c = makeCandidate({ url: 'https://news.example.com/later', headline: 'Later story' });
    const ws2dir = path.join(ws.work, later);
    fs.mkdirSync(ws2dir, { recursive: true });
    fs.writeFileSync(path.join(ws2dir, 'candidates.json'), JSON.stringify({ schema_version: 1, run_id: later, candidates: [c] }));
    fs.writeFileSync(path.join(ws2dir, 'fetch-report.json'), JSON.stringify({ schema_version: 1, run_id: later, started_at: '2026-10-02T18:02:00-04:00', totals: { sources_ok: 5, sources_failed: 0, fetched: 10, in_window: 1, unseen: 1 } }));
    fs.writeFileSync(path.join(ws2dir, 'stage1.json'), JSON.stringify({ schema_version: 1, run_id: later, survivors: [makeSurvivor(c)] }));
    fs.writeFileSync(path.join(ws2dir, 'decisions.json'), JSON.stringify({
      run_id: later,
      threshold_level: 'high',
      judgments: [judgment(c, { draft_index: 0, dedup: 'material_update', match_id: 'RS-261002-1400-02', reason: '[M2] spread to managed service providers; C1-C6 hold | candidate_issue CI1-5' })],
      items: [makeDraft([c], { update_of: 'RS-261002-1400-02', claim: 'Exploitation of the gateway flaw spread to managed service providers, the vendor says.' })],
    }));
    const r2 = runScript('publish', ['--run', later, '--now', '2026-10-02T18:10:00-04:00', ...ws.flags]);
    assert.equal(r2.status, 0, r2.stderr);
    const archive2 = readJson(ws.archive);
    assert.equal(archive2.items.length, 4);
    assert.equal(archive2.items[3].id, 'RS-261002-1800-01');
    assert.equal(archive2.items[3].update_of, 'RS-261002-1400-02');
    assert.deepEqual(checkAppendOnly(archive, archive2, 'archive').errors, []);
    assert.deepEqual(checkAppendOnly(runs, readJson(ws.runs), 'runs').errors, []);

    // an earlier slot after a later one is refused
    const early = runScript('publish', ['--run', '2026-10-02-1000', '--status', 'failed', '--reason', 'late', '--now', NOW, ...ws.flags]);
    assert.notEqual(early.status, 0);
    assert.match(early.stderr, /not after the latest recorded run/);
  } finally {
    rmrf(ws.dir);
  }
});

test('dry run prints everything and writes nothing', () => {
  const s = scenario();
  const ws = workspace({ runId: RUN, candidates: s.candidates, survivors: s.survivors, decisions: s.decisions, startedAt: STARTED });
  try {
    const snapshot = () => [ws.archive, ws.runs, ws.seen].map((f) => fs.readFileSync(f, 'utf8')).join('|');
    const before = snapshot();
    const r = runScript('publish', ['--run', RUN, '--dry-run', '--now', NOW, ...ws.flags]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.new_items.length, 3);
    assert.equal(r.json.run_record.status, 'published');
    assert.ok(r.json.would_write.length >= 3);
    assert.equal(snapshot(), before);
    assert.equal(fs.existsSync(path.join(ws.logs, '2026')), false);
  } finally {
    rmrf(ws.dir);
  }
});

test('silent run: no survivors and no decisions file records a silent run', () => {
  const ws = workspace({ runId: RUN, candidates: [makeCandidate()], survivors: [], startedAt: STARTED });
  try {
    const r = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
    assert.equal(r.status, 0, r.stderr);
    const rec = readJson(ws.runs).runs[0];
    assert.equal(rec.status, 'silent');
    assert.deepEqual(rec.items, []);
    assert.equal(rec.funnel.published, 0);
    assert.equal(readJson(ws.archive).items.length, 0);
    assert.equal(r.json.commit_message, 'run: 2026-10-02 14:00 ET (silent)');
  } finally {
    rmrf(ws.dir);
  }
});

test('silent run with judgments that all drop', () => {
  const c = makeCandidate();
  const ws = workspace({
    runId: RUN,
    candidates: [c],
    survivors: [makeSurvivor(c)],
    decisions: { run_id: RUN, threshold_level: 'high', judgments: [judgment(c, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'C1 nothing specific changed', draft_index: null })], items: [] },
    startedAt: STARTED,
  });
  try {
    const r = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
    assert.equal(r.status, 0, r.stderr);
    const rec = readJson(ws.runs).runs[0];
    assert.equal(rec.status, 'silent');
    assert.deepEqual(rec.stage2_by_section.capability_shift, { tested: 1, passed: 0 });
    assert.equal(Object.values(readJson(ws.seen).urls)[0].verdict, 'dropped');
  } finally {
    rmrf(ws.dir);
  }
});

test('failed run: --status failed --reason records a failed run without items, even with no work files', () => {
  const ws = workspace({});
  try {
    const r = runScript('publish', ['--run', RUN, '--status', 'failed', '--reason', 'Only 3 of 30 sources responded', '--now', NOW, ...ws.flags]);
    assert.equal(r.status, 0, r.stderr);
    const rec = readJson(ws.runs).runs[0];
    assert.equal(rec.status, 'failed');
    assert.deepEqual(rec.items, []);
    assert.equal(rec.notes, 'Only 3 of 30 sources responded');
    assert.equal(rec.threshold_level, 'high');
    assert.equal(readJson(ws.archive).items.length, 0);
    assert.deepEqual(readJson(ws.seen).urls, {});
    assert.equal(r.json.commit_message, 'run: 2026-10-02 14:00 ET (failed)');
    const usage = runScript('publish', ['--run', '2026-10-02-1800', '--status', 'failed', ...ws.flags]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /requires --reason/);
    const voice = runScript('publish', ['--run', '2026-10-02-1800', '--status', 'failed', '--reason', 'we lost the network', ...ws.flags]);
    assert.equal(voice.status, 2);
    assert.match(voice.stderr, /first-person voice "we"/);
  } finally {
    rmrf(ws.dir);
  }
});

test('fewer than half of sources responding blocks publishing', () => {
  const s = scenario();
  const ws = workspace({ runId: RUN, candidates: s.candidates, survivors: s.survivors, decisions: s.decisions, startedAt: STARTED, fetchTotals: { sources_ok: 2, sources_failed: 5 } });
  try {
    const r = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /fewer than half of sources responded \(2\/7\)/);
    assert.equal(readJson(ws.runs).runs.length, 0);
  } finally {
    rmrf(ws.dir);
  }
});

test('invalid decisions are refused with a readable error list and nothing is written', () => {
  const s = scenario();
  s.decisions.items[1].validation_question = 'Has Examplebank patched? Ask HSBC, as we did';
  s.decisions.items[1].sources.push({ publication: 'Uncollected', url: 'https://elsewhere.example.com/x' });
  s.decisions.judgments.pop(); // one survivor left unjudged
  const ws = workspace({ runId: RUN, candidates: s.candidates, survivors: s.survivors, decisions: s.decisions, startedAt: STARTED });
  try {
    const r = runScript('publish', ['--run', RUN, '--now', NOW, ...ws.flags]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /names a specific financial institution/);
    assert.match(r.stderr, /first-person voice "we"/);
    assert.match(r.stderr, /must end with "\?"/);
    assert.match(r.stderr, /not the URL of any candidate/);
    assert.match(r.stderr, /not judged/);
    assert.match(r.stderr, /nothing was written/);
    assert.equal(readJson(ws.archive).items.length, 0);
    assert.equal(readJson(ws.runs).runs.length, 0);
  } finally {
    rmrf(ws.dir);
  }
});

test('assignIds: section, then mechanism, then earliest primary-source date, then draft order', () => {
  const d = (section, mechanism, published) => ({ section, mechanism, sources: [{ publication: 'x', url: 'https://x.example.com', ...(published ? { published } : {}) }] });
  const order = assignIds([
    d('regulatory_trajectory', 'awareness_only', '2026-10-01'),
    d('capability_shift', 'kri_kpi', '2026-10-02'),
    d('capability_shift', 'kri_kpi', '2026-09-30'),
    d('capability_shift', 'candidate_issue'),
    d('executive_visibility', 'awareness_only', '2026-10-02'),
    d('capability_shift', 'kri_kpi'),
  ], 'RS-261002-1400');
  assert.deepEqual(order.map((o) => o.draftIndex), [4, 3, 2, 1, 5, 0]);
  assert.deepEqual(order.map((o) => o.id), ['RS-261002-1400-01', 'RS-261002-1400-02', 'RS-261002-1400-03', 'RS-261002-1400-04', 'RS-261002-1400-05', 'RS-261002-1400-06']);
});

test('usage errors: missing or invalid --run', () => {
  const ws = workspace({});
  try {
    assert.equal(runScript('publish', [...ws.flags]).status, 2);
    assert.equal(runScript('publish', ['--run', '2026-10-02-1430', ...ws.flags]).status, 2);
    assert.equal(runScript('publish', ['--run', RUN, '--bogus', ...ws.flags]).status, 2);
  } finally {
    rmrf(ws.dir);
  }
});
