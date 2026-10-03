// File helpers: JSON read with clear errors, atomic writes (temp + rename), JSONL.

import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) {
      return typeof fallback === 'function' ? fallback() : structuredClone(fallback);
    }
    if (err.code === 'ENOENT') throw new Error(`file not found: ${file}`);
    throw err;
  }
  try {
    return JSON.parse(text.replace(/^\s+/, '')); // \s includes the BOM
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${err.message}`);
  }
}

export function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Serialise as 2-space JSON with a trailing newline. */
export function toJsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write text atomically: temp file in the same directory, then rename over the target. */
export function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  fs.writeFileSync(tmp, text, 'utf8');
  // Windows (and synced folders) can transiently lock the target; retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt < 8 && ['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        sleepSync(50 * (attempt + 1));
        continue;
      }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  }
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, toJsonText(value));
}

/**
 * Write several files as one unit. Each file is written atomically, in order; if any write fails,
 * every file already written is put back as it was (restored, or removed if it did not exist) and
 * the error is rethrown with what happened. `write` is injectable for tests.
 * @param {Array<[string, string]>} entries [file, text] pairs, written in this order
 * @returns {string[]} the files written
 */
export function writeFilesAtomically(entries, { write = writeFileAtomic } = {}) {
  const before = new Map();
  for (const [file] of entries) {
    try {
      before.set(file, fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      before.set(file, null);
    }
  }
  const written = [];
  try {
    for (const [file, text] of entries) {
      write(file, text);
      written.push(file);
    }
    return written;
  } catch (err) {
    const failed = [];
    for (const file of [...written].reverse()) {
      try {
        const prev = before.get(file);
        if (prev === null) fs.rmSync(file, { force: true });
        else writeFileAtomic(file, prev);
      } catch (e) {
        failed.push(`${file} (${e.code ?? e.message})`);
      }
    }
    const what = written.length
      ? failed.length
        ? `RESTORE FAILED for ${failed.join(', ')}; restore those files from git before retrying`
        : `the ${written.length} file(s) already written were restored`
      : 'nothing had been written';
    const reason = err.code && !String(err.message).startsWith(err.code) ? `${err.code}: ${err.message}` : err.message;
    const e = new Error(`write failed (${reason}); ${what}`);
    e.code = err.code;
    e.restored = failed.length === 0;
    throw e;
  }
}

export function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`invalid JSON on line ${i + 1} of ${file}: ${err.message}`);
    }
  });
  return out;
}

export function toJsonlText(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

/** Recursively list files under dir matching a predicate (sorted). Missing dir -> []. */
export function listFiles(dir, predicate = () => true) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (predicate(p)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Stable deep equality for JSON values (key order ignored). */
export function jsonEqual(a, b) {
  return canonical(a) === canonical(b);
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
