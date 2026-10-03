// Eastern-time helpers for Readiness Signal (SPEC §4). No dependencies: Intl only.
//
// Edition slots are 06:00, 10:00, 14:00 and 18:00 America/New_York. A run's slot is the
// latest slot at or before its start time; before 06:00 ET it is the previous day's 18:00.

export const TZ = 'America/New_York';
export const SLOT_HOURS = Object.freeze([6, 10, 14, 18]);

const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

const pad = (n, w = 2) => String(n).padStart(w, '0');

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${value}`);
  return d;
}

/** Wall-clock parts of an instant in ET. */
export function etParts(value) {
  const date = toDate(value);
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

/** UTC offset of ET at an instant, in minutes (-240 during EDT, -300 during EST). */
export function etOffsetMinutes(value) {
  const date = toDate(value);
  const p = etParts(date);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSeconds = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((wallAsUtc - wholeSeconds) / 60000);
}

export function formatOffset(minutes) {
  const sign = minutes <= 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** ISO 8601 with the ET offset, second precision: 2026-10-02T14:00:00-04:00 */
export function toEtIso(value) {
  const date = toDate(value);
  const p = etParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${formatOffset(etOffsetMinutes(date))}`;
}

/** ET calendar date (YYYY-MM-DD) of an instant. */
export function etDateString(value) {
  const p = etParts(value);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Instant for an ET wall-clock time. Unambiguous for every slot hour (DST changes at 02:00). */
export function etWallToDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = etOffsetMinutes(new Date(wall));
  let t = wall - off1 * 60000;
  const off2 = etOffsetMinutes(new Date(t));
  if (off2 !== off1) t = wall - off2 * 60000;
  return new Date(t);
}

/** Build the slot descriptor for an ET date and slot hour. */
export function slotAt(year, month, day, hour) {
  if (!SLOT_HOURS.includes(hour)) throw new Error(`not a slot hour: ${hour}`);
  // normalise calendar overflow (e.g. day 0)
  const norm = new Date(Date.UTC(year, month - 1, day));
  const y = norm.getUTCFullYear();
  const m = norm.getUTCMonth() + 1;
  const d = norm.getUTCDate();
  const instant = etWallToDate(y, m, d, hour, 0, 0);
  const date = `${y}-${pad(m)}-${pad(d)}`;
  const hhmm = `${pad(hour)}00`;
  return {
    date,
    hour,
    hhmm,
    instant,
    iso: toEtIso(instant),
    run_id: `${date}-${hhmm}`,
    id_stem: `RS-${String(y).slice(2)}${pad(m)}${pad(d)}-${hhmm}`,
  };
}

/** Latest slot at or before `now` (ET, DST-aware). Before 06:00 -> previous day's 18:00. */
export function slotFor(now = new Date()) {
  const p = etParts(now);
  let hour = null;
  for (const h of SLOT_HOURS) if (p.hour >= h) hour = h;
  if (hour === null) return slotAt(p.year, p.month, p.day - 1, 18);
  return slotAt(p.year, p.month, p.day, hour);
}

/** The slot strictly after the given slot. */
export function nextSlot(slot) {
  const i = SLOT_HOURS.indexOf(slot.hour);
  const [y, m, d] = slot.date.split('-').map(Number);
  if (i < SLOT_HOURS.length - 1) return slotAt(y, m, d, SLOT_HOURS[i + 1]);
  return slotAt(y, m, d + 1, SLOT_HOURS[0]);
}

const RUN_ID_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/;

/** Parse a run id ('YYYY-MM-DD-HHMM'); null unless it names a real slot. */
export function parseRunId(runId) {
  const m = RUN_ID_RE.exec(String(runId ?? ''));
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mi !== 0 || !SLOT_HOURS.includes(h)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return slotAt(y, mo, d, h);
}

export const ET_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})$/;

/** True when `s` is second-precision ISO 8601 carrying the correct ET offset for its instant. */
export function isEtIso(s) {
  if (typeof s !== 'string' || !ET_ISO_RE.test(s)) return false;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return false;
  return toEtIso(d) === s;
}

/** True when `s` is an ET ISO timestamp exactly at an edition slot. */
export function isSlotIso(s) {
  if (!isEtIso(s)) return false;
  const p = etParts(s);
  return p.minute === 0 && p.second === 0 && SLOT_HOURS.includes(p.hour);
}

/** 'YYYY-MM-DD' calendar validity. */
export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 'Fri 2 Oct 2026, 14:00 ET' */
export function formatEtHuman(value) {
  const p = etParts(value);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${p.weekday} ${p.day} ${months[p.month - 1]} ${p.year}, ${pad(p.hour)}:${pad(p.minute)} ET`;
}

/** Parse a --now style argument (any Date-parsable string, ISO recommended). */
export function parseNow(value) {
  if (value === undefined || value === null || value === '') return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`--now: not a valid date: ${value}`);
  return d;
}
