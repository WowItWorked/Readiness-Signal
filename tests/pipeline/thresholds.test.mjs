import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LAUNCH_DEFAULTS, loadThresholds } from '../../pipeline/lib/thresholds.mjs';
import { rmrf, tempDir, writeJson } from './_helpers.mjs';

test('thresholds reader: plain values, {value} knobs, knobs{} nesting, defaults when missing or invalid', () => {
  const dir = tempDir();
  try {
    const f = path.join(dir, 't.json');
    const missing = loadThresholds(path.join(dir, 'none.json'));
    assert.equal(missing.found, false);
    assert.equal(missing.level, 'high');
    assert.equal(missing.number('dedup_window_days'), LAUNCH_DEFAULTS.dedup_window_days);
    writeJson(f, { level: 'medium', dedup_window_days: 14, candidate_issue_share_warn: { value: 0.5 }, knobs: { surge_recheck_items: { value: 6 } } });
    const t = loadThresholds(f);
    assert.equal(t.found, true);
    assert.equal(t.level, 'medium');
    assert.equal(t.number('dedup_window_days'), 14);
    assert.equal(t.number('candidate_issue_share_warn'), 0.5);
    assert.equal(t.get('surge_recheck_items'), 6);
    writeJson(f, ['not', 'an', 'object']);
    assert.equal(loadThresholds(f).found, false);
    writeJson(f, { level: 'NOT VALID' });
    assert.equal(loadThresholds(f).level, 'high');
  } finally {
    rmrf(dir);
  }
});
