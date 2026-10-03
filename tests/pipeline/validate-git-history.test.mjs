// Append-only checks across several commits (review finding F01) and text lint relative to a git
// ref (F03), in a throwaway temp repository. Git runs with an empty global config and no system
// config, so the user's identity, hooks and signing settings are never read or needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, rmrf, runScript, tempDir, writeJson } from './_helpers.mjs';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function isolatedGit(dir) {
  const globalCfg = path.join(dir, '.gitconfig-empty');
  fs.writeFileSync(globalCfg, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalCfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  return (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
}

const item = (slot, nn, o = {}) => ({
  id: `RS-261002-${slot}-${nn}`,
  timestamp: `2026-10-02T${slot.slice(0, 2)}:00:00-04:00`,
  section: 'capability_shift',
  claim: 'Attackers are exploiting an unpatched gateway flaw across several sectors, the vendor says.',
  domains: ['cyber'],
  source_class: 'news',
  mechanism: 'awareness_only',
  interpretation: [{ domain: 'cyber', text: 'Edge appliances remain a primary intrusion route.' }],
  validation_question: null,
  candidate_issue_statement: null,
  awareness_rationale: 'Directional only; no control, metric or framework change follows.',
  sources: [{ publication: 'Example News', url: `https://news.example.com/${slot}/${nn}`, source_class: 'news' }],
  backfilled: false,
  update_of: null,
  ...o,
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

test('F01: a rewrite in an earlier commit of a multi-commit push is caught against the pre-push commit, not HEAD^', { skip: !hasGit && 'git not available' }, () => {
  const dir = fs.realpathSync.native(tempDir('rs-git-'));
  try {
    const git = isolatedGit(dir);
    const repo = path.join(dir, 'repo');
    const archive = path.join(repo, 'docs', 'data', 'archive.json');
    const runs = path.join(repo, 'docs', 'data', 'runs.json');
    const flags = ['--archive', archive, '--runs', runs, '--seen', path.join(repo, 'none.json'), '--repo', repo];
    git('init', '-q');
    const a1 = item('1000', '01');
    writeJson(archive, { schema_version: 1, items: [a1] });
    writeJson(runs, { schema_version: 1, runs: [run('1000', [a1.id])] });
    git('add', '-A');
    git('commit', '-q', '-m', 'run: 2026-10-02 10:00 ET');
    const prePush = git('rev-parse', 'HEAD');
    // commit 2 rewrites a published claim; commit 3 touches something else
    writeJson(archive, { schema_version: 1, items: [{ ...a1, claim: 'Attackers are exploiting a gateway flaw across many sectors, the vendor says.' }] });
    git('commit', '-q', '-am', 'edit');
    fs.writeFileSync(path.join(repo, 'note.txt'), 'x');
    git('add', 'note.txt');
    git('commit', '-q', '-m', 'note');
    // HEAD^ (the old CI) sees nothing wrong
    let r = runScript('validate', [...flags, '--against-git-ref', 'HEAD^']);
    assert.equal(r.status, 0, r.stderr);
    // the pre-push commit (CI now uses github.event.before) catches it
    for (const ref of [prePush, 'HEAD~2']) {
      r = runScript('validate', [...flags, '--against-git-ref', ref]);
      assert.equal(r.status, 1, ref);
      assert.match(r.stderr, /ERROR docs\/data\/archive\.json: items\[0\] RS-261002-1000-01: changed at claim \(append-only\)/);
    }
  } finally {
    rmrf(dir);
  }
});

test('F03: against a ref, items new since the ref are linted as errors and items already there as warnings', { skip: !hasGit && 'git not available' }, () => {
  const dir = fs.realpathSync.native(tempDir('rs-git-'));
  try {
    const git = isolatedGit(dir);
    const repo = path.join(dir, 'repo');
    const archive = path.join(repo, 'docs', 'data', 'archive.json');
    const runs = path.join(repo, 'docs', 'data', 'runs.json');
    const flags = ['--archive', archive, '--runs', runs, '--seen', path.join(repo, 'none.json'), '--repo', repo];
    git('init', '-q');
    // published before "JPM" was a listed alias
    const old = item('1000', '01', { awareness_rationale: 'JPM disclosed it; no control, metric or framework change follows.' });
    writeJson(archive, { schema_version: 1, items: [old] });
    writeJson(runs, { schema_version: 1, runs: [run('1000', [old.id])] });
    git('add', '-A');
    git('commit', '-q', '-m', 'edition');
    let r = runScript('validate', [...flags, '--against-git-ref', 'HEAD']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /warn .*RS-261002-1000-01.*names a specific financial institution/);
    // a new item with the same problem fails
    const fresh = item('1400', '01', { awareness_rationale: 'JPM disclosed it; no control, metric or framework change follows.' });
    writeJson(archive, { schema_version: 1, items: [old, fresh] });
    writeJson(runs, { schema_version: 1, runs: [run('1000', [old.id]), run('1400', [fresh.id])] });
    r = runScript('validate', [...flags, '--against-git-ref', 'HEAD']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERROR items\[1\] \(RS-261002-1400-01\): awareness_rationale: names a specific financial institution/);
    assert.doesNotMatch(r.stderr, /ERROR .*RS-261002-1000-01/);
  } finally {
    rmrf(dir);
  }
});

test('CI workflow: full history, pre-push base, fail closed, Node 20 and 22', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(yml, /fetch-depth: 0/);
  assert.match(yml, /github\.event\.pull_request\.base\.sha \|\| github\.event\.before/);
  assert.match(yml, /node pipeline\/scripts\/validate\.mjs --against-git-ref "\$BASE"/);
  assert.match(yml, /exit 1/);
  assert.match(yml, /node: \[20, 22\]/);
  assert.doesNotMatch(yml, /--against-git-ref HEAD\^/);
  // npm test enumerates test files itself (Node 20's test runner has no glob support)
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.doesNotMatch(pkg.scripts.test, /\*\*/);
  assert.match(pkg.scripts.test, /--test/);
});
