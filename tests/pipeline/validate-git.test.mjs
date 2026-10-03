// validate.mjs --against-git-ref in a throwaway temp git repo. Refs are tree objects made with
// `git write-tree`, so no commits (and no identity or signing config) are needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rmrf, runScript, tempDir, writeJson } from './_helpers.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

const item = (slot, nn, claim = 'Attackers are exploiting an unpatched gateway flaw across several sectors this week') => ({
  id: `RS-261002-${slot}-${nn}`,
  timestamp: `2026-10-02T${slot.slice(0, 2)}:00:00-04:00`,
  section: 'capability_shift',
  claim,
  domains: ['cyber'],
  source_class: 'news',
  mechanism: 'awareness_only',
  interpretation: [{ domain: 'cyber', text: 'Edge appliances remain a primary intrusion route.' }],
  validation_question: null,
  candidate_issue_statement: null,
  awareness_rationale: 'Directional only; no control, metric or framework change follows.',
  sources: [{ publication: 'Example News', url: `https://news.example.com/${slot}/${nn}` }],
  backfilled: false,
  update_of: null,
});
const run = (slot, ids) => ({
  run_id: `2026-10-02-${slot}`,
  slot: `2026-10-02T${slot.slice(0, 2)}:00:00-04:00`,
  started_at: `2026-10-02T${slot.slice(0, 2)}:02:00-04:00`,
  finished_at: `2026-10-02T${slot.slice(0, 2)}:20:00-04:00`,
  status: ids.length ? 'published' : 'silent',
  items: ids,
  threshold_level: 'high',
  funnel: { sources_ok: 5, sources_failed: 0, fetched: 50, in_window: 20, unseen: 20, stage1_pass: 3, stage2_pass: ids.length, dedup_dropped: 0, published: ids.length },
  stage2_by_section: { executive_visibility: { tested: 0, passed: 0 }, capability_shift: { tested: 3, passed: ids.length }, regulatory_trajectory: { tested: 0, passed: 0 } },
  mechanism_distribution: { candidate_issue: 0, kri_kpi: 0, praf_coverage: 0, awareness_only: ids.length },
});

test('append-only check against a git ref', { skip: !hasGit && 'git not available' }, () => {
  const dir = fs.realpathSync.native(tempDir('rs-git-'));
  try {
    const archive = path.join(dir, 'docs', 'data', 'archive.json');
    const runs = path.join(dir, 'docs', 'data', 'runs.json');
    const seen = path.join(dir, 'pipeline', 'state', 'seen.json');
    const flags = ['--archive', archive, '--runs', runs, '--seen', seen];
    git(dir, 'init', '-q');
    const emptyTree = git(dir, 'write-tree'); // nothing staged yet: the empty tree

    const a1 = item('1000', '01');
    const r1 = run('1000', [a1.id]);
    writeJson(archive, { schema_version: 1, items: [a1] });
    writeJson(runs, { schema_version: 1, runs: [r1] });
    writeJson(seen, { schema_version: 1, urls: {} });
    git(dir, 'add', '-A');
    const treeA = git(dir, 'write-tree');

    // unchanged and appended states pass
    let r = runScript('validate', [...flags, '--against-git-ref', treeA]);
    assert.equal(r.status, 0, r.stderr);
    const a2 = item('1400', '01');
    writeJson(archive, { schema_version: 1, items: [a1, a2] });
    writeJson(runs, { schema_version: 1, runs: [r1, run('1400', [a2.id])] });
    r = runScript('validate', [...flags, '--against-git-ref', treeA]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.append_only.before.items, 1);
    assert.match(r.stderr, /append-only vs .* \(\+1 items, \+1 runs\)/);

    // a changed item fails
    writeJson(archive, { schema_version: 1, items: [{ ...a1, claim: 'Attackers are exploiting a gateway flaw across many sectors this month' }, a2] });
    r = runScript('validate', [...flags, '--against-git-ref', treeA]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /items\[0\] RS-261002-1000-01: changed at claim/);

    // a removed item and run record fail
    writeJson(archive, { schema_version: 1, items: [a2] });
    writeJson(runs, { schema_version: 1, runs: [run('1400', [a2.id])] });
    r = runScript('validate', [...flags, '--against-git-ref', treeA]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /RS-261002-1000-01: removed/);
    assert.match(r.stderr, /runs\[0\] 2026-10-02-1000: removed/);

    // files missing at the ref count as empty
    writeJson(archive, { schema_version: 1, items: [a1] });
    writeJson(runs, { schema_version: 1, runs: [r1] });
    r = runScript('validate', [...flags, '--against-git-ref', emptyTree]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.append_only.before.items, 0);

    // unknown ref is a usage error
    r = runScript('validate', [...flags, '--against-git-ref', 'no-such-ref']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /git ref not found/);
  } finally {
    rmrf(dir);
  }
});

test('validate.mjs reports schema errors with exit 1 and passes clean data', () => {
  const dir = tempDir();
  try {
    const archive = path.join(dir, 'archive.json');
    const runs = path.join(dir, 'runs.json');
    const flags = ['--archive', archive, '--runs', runs, '--seen', path.join(dir, 'none.json')];
    writeJson(archive, { schema_version: 1, items: [] });
    writeJson(runs, { schema_version: 1, runs: [] });
    let r = runScript('validate', flags);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    writeJson(archive, { schema_version: 1, items: [{ ...item('1000', '01'), validation_question: 'Should we act?' }] });
    r = runScript('validate', flags);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /validation_question: must be null for awareness_only/);
    assert.match(r.stderr, /live item not listed by any run record/);
  } finally {
    rmrf(dir);
  }
});
