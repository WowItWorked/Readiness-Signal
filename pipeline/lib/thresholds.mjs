// Tolerant reader for pipeline/thresholds.json (owned by FILTER.md §9; the agent never edits it).
// A knob may be a plain value or an object with `value`, at the top level, under `knobs`, or in a
// section group (`global`, `executive_visibility`, ..., `writing`, `dedup`), as thresholds.json
// lays them out. Missing or invalid file -> launch defaults (FILTER.md §9.2).

import { readJson } from './io.mjs';

export const LAUNCH_DEFAULTS = Object.freeze({
  level: 'high',
  dedup_window_days: 21,
  candidate_issue_share_warn: 0.4,
  claims_may_name_institutions: false,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function loadThresholds(file) {
  let doc = null;
  try {
    doc = readJson(file, null);
  } catch {
    doc = null;
  }
  const ok = isObj(doc);
  const lookup = (key) => {
    if (doc[key] !== undefined) return doc[key];
    if (isObj(doc.knobs) && doc.knobs[key] !== undefined) return doc.knobs[key];
    for (const group of Object.values(doc)) {
      if (isObj(group) && group[key] !== undefined) return group[key];
    }
    return undefined;
  };
  const get = (key, fallback = LAUNCH_DEFAULTS[key]) => {
    if (!ok) return fallback;
    const raw = lookup(key);
    const value = isObj(raw) && 'value' in raw ? raw.value : raw;
    return value === undefined || value === null ? fallback : value;
  };
  const level = get('level');
  return {
    found: ok,
    level: typeof level === 'string' && /^[a-z_]{1,20}$/.test(level) ? level : LAUNCH_DEFAULTS.level,
    get,
    number(key) {
      const n = Number(get(key));
      return Number.isFinite(n) ? n : LAUNCH_DEFAULTS[key];
    },
    /** A boolean knob; anything but a literal true/false falls back to the launch default. */
    bool(key) {
      const v = get(key);
      return typeof v === 'boolean' ? v : Boolean(LAUNCH_DEFAULTS[key]);
    },
    /**
     * Every knob written as an object with `value` (top level, under `knobs`, or in a section
     * group): Map name -> { value, element, launch }. null when the file is missing or invalid.
     */
    knobs() {
      if (!ok) return null;
      const out = new Map();
      const take = (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (isObj(v) && 'value' in v) out.set(k, { value: v.value, element: typeof v.element === 'string' ? v.element : null, launch: v.launch });
        }
      };
      take(doc);
      for (const group of Object.values(doc)) if (isObj(group) && !('value' in group)) take(group);
      return out;
    },
  };
}
