import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  etOffsetMinutes, etWallToDate, formatEtHuman, isEtIso, isIsoDate, isSlotIso, nextSlot, parseRunId,
  slotAt, slotFor, toEtIso,
} from '../../pipeline/lib/time.mjs';

test('ET offset is -04:00 in summer and -05:00 in winter', () => {
  assert.equal(etOffsetMinutes(new Date('2026-07-01T12:00:00Z')), -240);
  assert.equal(etOffsetMinutes(new Date('2026-01-15T12:00:00Z')), -300);
});

test('DST starts 2026-03-08 at 02:00 EST (07:00Z)', () => {
  assert.equal(etOffsetMinutes(new Date('2026-03-08T06:59:59Z')), -300);
  assert.equal(etOffsetMinutes(new Date('2026-03-08T07:00:00Z')), -240);
  assert.equal(toEtIso(new Date('2026-03-08T06:59:59Z')), '2026-03-08T01:59:59-05:00');
  assert.equal(toEtIso(new Date('2026-03-08T07:00:00Z')), '2026-03-08T03:00:00-04:00');
});

test('DST ends 2026-11-01 at 02:00 EDT (06:00Z)', () => {
  assert.equal(etOffsetMinutes(new Date('2026-11-01T05:59:59Z')), -240);
  assert.equal(etOffsetMinutes(new Date('2026-11-01T06:00:00Z')), -300);
  assert.equal(toEtIso(new Date('2026-11-01T05:59:59Z')), '2026-11-01T01:59:59-04:00');
  assert.equal(toEtIso(new Date('2026-11-01T06:00:00Z')), '2026-11-01T01:00:00-05:00');
});

test('slots on DST transition days carry the right offset', () => {
  assert.equal(slotAt(2026, 3, 8, 6).iso, '2026-03-08T06:00:00-04:00');
  assert.equal(slotAt(2026, 3, 8, 6).instant.toISOString(), '2026-03-08T10:00:00.000Z');
  assert.equal(slotAt(2026, 11, 1, 6).iso, '2026-11-01T06:00:00-05:00');
  assert.equal(slotAt(2026, 11, 1, 6).instant.toISOString(), '2026-11-01T11:00:00.000Z');
  // before 06:00 on the transition days -> previous evening's 18:00 in the previous offset
  assert.equal(slotFor(new Date('2026-03-08T09:59:00Z')).iso, '2026-03-07T18:00:00-05:00');
  assert.equal(slotFor(new Date('2026-11-01T10:59:00Z')).iso, '2026-10-31T18:00:00-04:00');
  assert.equal(slotFor(new Date('2026-11-01T11:00:00Z')).iso, '2026-11-01T06:00:00-05:00');
});

test('slot edges: exactly at, just before and between slots', () => {
  const at = (iso) => slotFor(new Date(iso)).run_id;
  assert.equal(at('2026-10-02T06:00:00-04:00'), '2026-10-02-0600');
  assert.equal(at('2026-10-02T05:59:59-04:00'), '2026-10-01-1800');
  assert.equal(at('2026-10-02T09:59:59-04:00'), '2026-10-02-0600');
  assert.equal(at('2026-10-02T10:00:00-04:00'), '2026-10-02-1000');
  assert.equal(at('2026-10-02T13:59:00-04:00'), '2026-10-02-1000');
  assert.equal(at('2026-10-02T14:03:12-04:00'), '2026-10-02-1400');
  assert.equal(at('2026-10-02T17:59:59-04:00'), '2026-10-02-1400');
  assert.equal(at('2026-10-02T18:00:00-04:00'), '2026-10-02-1800');
  assert.equal(at('2026-10-02T23:59:59-04:00'), '2026-10-02-1800');
  assert.equal(at('2026-10-03T00:00:00-04:00'), '2026-10-02-1800');
  // month and year boundaries
  assert.equal(at('2026-03-01T01:00:00-05:00'), '2026-02-28-1800');
  assert.equal(at('2027-01-01T05:00:00-05:00'), '2026-12-31-1800');
});

test('run id, id stem and ISO formats', () => {
  const s = slotFor(new Date('2026-10-02T14:03:12-04:00'));
  assert.equal(s.run_id, '2026-10-02-1400');
  assert.equal(s.id_stem, 'RS-261002-1400');
  assert.equal(s.iso, '2026-10-02T14:00:00-04:00');
  assert.equal(formatEtHuman(s.instant), 'Fri 2 Oct 2026, 14:00 ET');
  assert.equal(nextSlot(s).run_id, '2026-10-02-1800');
  assert.equal(nextSlot(slotAt(2026, 10, 2, 18)).run_id, '2026-10-03-0600');
});

test('parseRunId accepts only real slots', () => {
  assert.equal(parseRunId('2026-10-02-1400').iso, '2026-10-02T14:00:00-04:00');
  assert.equal(parseRunId('2026-10-02-1430'), null);
  assert.equal(parseRunId('2026-10-02-1200'), null);
  assert.equal(parseRunId('2026-02-30-0600'), null);
  assert.equal(parseRunId('20261002-1400'), null);
  assert.equal(parseRunId(undefined), null);
});

test('isEtIso requires the correct offset for the instant', () => {
  assert.equal(isEtIso('2026-10-02T14:00:00-04:00'), true);
  assert.equal(isEtIso('2026-10-02T14:00:00-05:00'), false);
  assert.equal(isEtIso('2026-12-02T14:00:00-05:00'), true);
  assert.equal(isEtIso('2026-10-02T14:00:00Z'), false);
  assert.equal(isEtIso('2026-10-02T14:00-04:00'), false);
  assert.equal(isSlotIso('2026-10-02T14:00:00-04:00'), true);
  assert.equal(isSlotIso('2026-10-02T14:30:00-04:00'), false);
  assert.equal(isSlotIso('2026-10-02T12:00:00-04:00'), false);
  assert.equal(isIsoDate('2026-02-29'), false);
  assert.equal(isIsoDate('2028-02-29'), true);
  assert.equal(etWallToDate(2026, 10, 2, 14).toISOString(), '2026-10-02T18:00:00.000Z');
});
