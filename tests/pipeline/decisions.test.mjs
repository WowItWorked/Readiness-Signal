// validateDecisions: cross-file rules between decisions.json, candidates.json, stage1.json and the
// archive (SPEC §5/§6), plus the FILTER.md §8.1-§8.4 judgment invariants. FICTIONAL data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseReasonCodes, validateDecisions } from '../../pipeline/lib/validate.mjs';
import { FILTER_FIXTURE, ROOT, fixture, judgment, makeCandidate, makeDraft } from './_helpers.mjs';

const RUN = '2026-10-02-1400';
const CODES = parseReasonCodes(fixture('filter-codes.md'));
const c1 = makeCandidate({ url: 'https://news.example.com/gateway-zero-day', headline: 'Gateway zero-day exploited against several sectors', lead: 'Threat actors are actively exploiting a pre-authentication flaw in Example Gateway devices, the vendor said.' });
const c2 = makeCandidate({ url: 'https://wire.example.org/gateway-flaw', publication: 'Example Wire', headline: 'Example Gateway flaw under attack' });
const c3 = makeCandidate({ url: 'https://news.example.com/other', headline: 'Unrelated story' });
const extra = makeCandidate({ url: 'https://blog.example.net/gateway', publication: 'Example Blog', headline: 'Gateway post' });
const archiveItem = { id: 'RS-261001-1000-01', sources: [{ url: 'https://old.example.com/x' }] };

const ctx = (o = {}) => ({ runId: RUN, candidates: [c1, c2, c3, extra], survivorIds: [c1.candidate_id, c2.candidate_id, c3.candidate_id], archiveItems: [archiveItem], reasonCodes: CODES, ...o });
const drop3 = (o = {}) => judgment(c3, { verdict: 'drop', section_tested: 'executive_visibility', reason_code: 'EV_NO_EXEC_QUESTION', reason: 'E5 no unprompted executive question', draft_index: null, ...o });
const base = (o = {}) => ({
  run_id: RUN,
  threshold_level: 'high',
  judgments: [judgment(c1), judgment(c2, { dedup: 'cluster_merged', match_id: c1.candidate_id }), drop3()],
  items: [makeDraft([c1, c2])],
  ...o,
});
const withJ = (i, patch) => {
  const j = base().judgments;
  j[i] = { ...j[i], ...patch };
  return base({ judgments: j });
};
const errs = (r) => r.errors.join('\n');
const ok = (d, c = ctx()) => {
  const r = validateDecisions(d, c);
  assert.deepEqual(r.errors, [], errs(r));
  return r;
};
const fails = (d, re, c = ctx()) => {
  const r = validateDecisions(d, c);
  assert.ok(r.errors.some((e) => re.test(e)), `expected ${re}; got:\n${errs(r)}`);
};

test('reason-code table parses from FILTER.md format (fixture and, when present, the live file)', () => {
  assert.equal(CODES.get('CS_PASS_CONTROL_FAILURE'), 'pass');
  assert.equal(CODES.get('DD_SAME_STORY'), 'drop');
  assert.equal(parseReasonCodes('no table here'), null);
  assert.equal(parseReasonCodes(null), null);
  const live = path.join(ROOT, 'pipeline', 'FILTER.md');
  if (fs.existsSync(live)) {
    const codes = parseReasonCodes(fs.readFileSync(live, 'utf8'));
    assert.ok(codes && codes.size >= 20, 'live FILTER.md reason-code table should parse');
    for (const [code, verdict] of codes) assert.equal(/^(EV|CS|RT)_PASS_/.test(code), verdict === 'pass', code);
  }
  assert.ok(fs.existsSync(FILTER_FIXTURE));
});

test('a well-formed decisions file passes; without a code list only a warning is added', () => {
  ok(base());
  const r = ok(base(), ctx({ reasonCodes: null }));
  assert.ok(r.warnings.some((w) => /code list unavailable/.test(w)));
});

test('every stage-1 survivor judged exactly once, and only survivors', () => {
  fails(base({ judgments: base().judgments.slice(0, 2) }), /1 stage-1 survivor\(s\) not judged/);
  fails(base({ judgments: [...base().judgments, drop3()] }), /judged more than once/);
  fails(base({ judgments: [...base().judgments, judgment(extra, { verdict: 'drop', reason_code: 'GL_OFF_DOMAIN', reason: 'G1 off domain', section_tested: null, draft_index: null })] }), /is not a stage-1 survivor/);
});

test('run id, threshold level, notes', () => {
  fails(base({ run_id: '2026-10-02-1000' }), /does not match this run/);
  fails(base({ threshold_level: '' }), /threshold_level/);
  fails(base({ notes: 'x'.repeat(281) }), /notes: 281 chars/);
  fails(base({ notes: 'self-audit: we re-checked every pass' }), /notes: first-person voice "we"/);
  fails(base({ extra: true }), /extra: unknown top-level field/);
});

test('judgment field shapes', () => {
  fails(withJ(0, { verdict: 'maybe' }), /verdict/);
  fails(withJ(0, { reason_code: 'lower' }), /reason_code: UPPER_SNAKE_CASE/);
  fails(withJ(2, { reason: 'two\nlines' }), /reason: must be one line/);
  fails(withJ(2, { reason: 'x'.repeat(201) }), /reason: 201 chars \(max 200 for a drop\)/);
  ok(base({ judgments: [judgment(c1, { reason: 'C1 '.padEnd(400, 'x') }), judgment(c2, { dedup: 'cluster_merged', match_id: c1.candidate_id }), drop3()] }));
  fails(withJ(0, { reason: 'C1 '.padEnd(401, 'x') }), /reason: 401 chars \(max 400 for a pass\)/);
  fails(withJ(2, { reason: 'G6 opinion column; I think nothing happened' }), /reason: first-person voice "I"/);
  fails(withJ(0, { dedup: 'dupe' }), /dedup: must be one of/);
  fails(withJ(0, { draft_index: 5 }), /draft_index: must be null or an index/);
  const r = validateDecisions(withJ(2, { reason: 'E5 a HSBC outage does not prompt a question' }), ctx());
  assert.ok(r.warnings.some((w) => /reason: names "HSBC"/.test(w)));
});

test('FILTER §8.2/8.3: closed code list; pass iff *_PASS_ code; prefix matches section; gate codes have no section', () => {
  fails(withJ(2, { reason_code: 'EV_NOT_IN_LIST' }), /EV_NOT_IN_LIST is not in the FILTER\.md §8\.2 list/);
  fails(withJ(2, { reason_code: 'EV_PASS_LOSS' }), /is a pass code but verdict is drop/);
  fails(base({ judgments: [judgment(c1, { reason_code: 'CS_NO_SPECIFIC_CHANGE' }), judgment(c2, { dedup: 'cluster_merged', match_id: c1.candidate_id, reason_code: 'CS_NO_SPECIFIC_CHANGE' }), drop3()] }), /is not an EV_\/CS_\/RT_PASS_ code but verdict is pass/);
  fails(withJ(2, { reason_code: 'CS_NO_SPECIFIC_CHANGE' }), /section_tested: CS_NO_SPECIFIC_CHANGE requires capability_shift/);
  fails(withJ(2, { reason_code: 'GL_OFF_DOMAIN' }), /gate code GL_OFF_DOMAIN requires null/);
  ok(withJ(2, { reason_code: 'GL_OFF_DOMAIN', section_tested: null, reason: 'G1 nothing within the seven domains' }));
  ok(withJ(2, { reason_code: 'GL_PAYWALL_INSUFFICIENT', reason: 'E2 not establishable behind a paywall' }));
  fails(withJ(2, { reason_code: 'GL_NO_MECHANISM', section_tested: null }), /GL_NO_MECHANISM names the section that passed/);
  ok(withJ(2, { reason_code: 'GL_NO_MECHANISM', reason: 'section passed; no mechanism guard holds' }));
  // without the list, the structural invariants still apply
  fails(withJ(2, { reason_code: 'EV_PASS_LOSS' }), /is a pass code but verdict is drop/, ctx({ reasonCodes: null }));
});

test('FILTER §8.3: DD_ codes are same_story_dropped against a published item; new has no match; draft_index iff pass', () => {
  ok(withJ(2, { reason_code: 'DD_SAME_STORY', section_tested: null, dedup: 'same_story_dropped', match_id: archiveItem.id, reason: `same story as ${archiveItem.id}; new outlet, no M fact` }));
  fails(withJ(2, { reason_code: 'DD_SAME_STORY', section_tested: null, dedup: 'new' }), /dedup: DD_SAME_STORY requires "same_story_dropped"/);
  fails(withJ(2, { reason_code: 'DD_SAME_STORY', section_tested: null, dedup: 'same_story_dropped', match_id: c1.candidate_id }), /must name the published item it repeats/);
  fails(withJ(2, { dedup: 'same_story_dropped', match_id: null }), /same_story_dropped must name the published item/);
  fails(withJ(2, { dedup: 'new', match_id: archiveItem.id }), /match_id: must be null when dedup is "new"/);
  fails(withJ(2, { draft_index: 0 }), /draft_index: must be null when verdict is drop/);
  fails(withJ(0, { draft_index: null }), /draft_index: required when verdict is pass/);
  fails(withJ(0, { section_tested: 'executive_visibility' }), /section_tested: executive_visibility but items\[0\]\.section is capability_shift/);
});

test('FILTER §8.3: cluster members mirror their lead (verdict, code, section, draft_index)', () => {
  fails(withJ(1, { match_id: null }), /cluster_merged must name the lead candidate_id/);
  fails(withJ(1, { match_id: c3.candidate_id }), /cluster members carry the lead's verdict/);
  fails(withJ(1, { reason_code: 'CS_NO_SPECIFIC_CHANGE', verdict: 'drop', draft_index: null }), /cluster members carry the lead's/);
  // a failed cluster: lead and member both drop with the lead's code
  ok({
    run_id: RUN,
    threshold_level: 'high',
    judgments: [
      judgment(c1, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'NEAR C2: one researcher blog only', draft_index: null }),
      judgment(c2, { verdict: 'drop', reason_code: 'CS_NO_SPECIFIC_CHANGE', reason: 'member of the same cluster', draft_index: null, dedup: 'cluster_merged', match_id: c1.candidate_id }),
      drop3(),
    ],
    items: [],
  });
});

test('each item needs exactly one lead (pass + new/material_update) and every attached survivor must point to it', () => {
  fails(withJ(1, { dedup: 'new', match_id: null }), /exactly one judgment with verdict pass and dedup new\/material_update/);
  fails(base({ items: [makeDraft([c1, c2]), makeDraft([c3])] }), /items\[1\].*not referenced by any judgment|items\[1\]: needs exactly one/);
  fails(base({ items: [makeDraft([c1, c2, c3])] }), /c-[0-9a-f]+ is attached here but its judgment is drop/);
});

test('sources must come from the item\'s candidates; extra non-survivor outlets are allowed with a warning', () => {
  const draft = makeDraft([c1, c2]);
  draft.sources.push({ publication: 'Elsewhere', url: 'https://elsewhere.example.com/not-collected', source_class: 'news' });
  fails(base({ items: [draft] }), /sources\[2\]\.url: not the URL of any candidate/);
  const r = ok(base({ items: [makeDraft([c1, c2, extra])] }));
  assert.ok(r.warnings.some((w) => /was not a stage-1 survivor/.test(w)));
  fails(base({ items: [makeDraft([c1, c2], { candidate_ids: [c1.candidate_id, c2.candidate_id, 'c-ffffffffff'] })] }), /c-ffffffffff is not in this run's candidates\.json/);
  // an http feed link may be published as https (same normalised URL)
  const httpCand = makeCandidate({ url: 'http://plain.example.com/story', headline: 'Plain story' });
  ok({ run_id: RUN, threshold_level: 'high', judgments: [judgment(httpCand)], items: [makeDraft([httpCand], { sources: [{ publication: 'Example News', url: 'https://plain.example.com/story', source_class: 'news' }] })] },
    ctx({ candidates: [httpCand], survivorIds: [httpCand.candidate_id] }));
});

test('a candidate used by two items is rejected', () => {
  fails(base({ items: [makeDraft([c1, c2]), makeDraft([c2])], judgments: [judgment(c1), judgment(c2, { draft_index: 1 }), drop3()] }), /also used by items\[0\]/);
});

test('material updates: [M#] reason prefix, published match, update_of', () => {
  const lead = (o) => judgment(c1, { dedup: 'material_update', match_id: archiveItem.id, reason: '[M3] patch shown bypassed; C1-C6 hold | candidate_issue CI1-5', ...o });
  const member = judgment(c2, { dedup: 'cluster_merged', match_id: c1.candidate_id });
  ok(base({ items: [makeDraft([c1, c2], { update_of: archiveItem.id })], judgments: [lead(), member, drop3()] }));
  fails(base({ items: [makeDraft([c1, c2])], judgments: [lead(), member, drop3()] }), /update_of: must be RS-261001-1000-01/);
  fails(base({ items: [makeDraft([c1, c2], { update_of: archiveItem.id })] }), /primary judgment is not dedup "material_update"/);
  fails(base({ items: [makeDraft([c1, c2], { update_of: archiveItem.id })], judgments: [lead({ reason: 'patch bypassed' }), member, drop3()] }), /material_update reason begins "\[M1\] "/);
  fails(withJ(2, { reason: '[M2] scope doubled' }), /"\[M#\]" prefix is only for dedup "material_update"/);
  fails(base({ items: [makeDraft([c1, c2], { update_of: 'RS-260101-0600-01' })], judgments: [lead({ match_id: 'RS-260101-0600-01' }), member, drop3()] }), /material_update must name the earlier published item/);
  // an update that fails its section is a drop carrying material_update and the match
  ok(withJ(2, { dedup: 'material_update', match_id: archiveItem.id, reason: '[M2] scope grew but E3 not met' }));
});

test('a resurfacing story cannot pass', () => {
  fails(withJ(2, { verdict: 'pass', section_tested: 'capability_shift', reason_code: 'CS_PASS_CONTROL_FAILURE', dedup: 'same_story_dropped', match_id: archiveItem.id, draft_index: null }), /resurfacing story without a material update is a drop/);
});

test('item lint applies inside decisions: verbatim copy, institutions, first person, forbidden fields', () => {
  fails(base({ items: [makeDraft([c1, c2], { claim: 'Threat actors are actively exploiting a pre-authentication flaw in Example Gateway devices.' })] }), /claim: copies 8\+ consecutive words/);
  fails(base({ items: [makeDraft([c1, c2], { validation_question: 'Has Citigroup patched every gateway?' })] }), /names a specific financial institution/);
  fails(base({ items: [makeDraft([c1, c2], { candidate_issue_statement: 'Where our patches lag, exploitation could follow.' })] }), /first-person/);
  fails(base({ items: [{ ...makeDraft([c1, c2]), id: 'RS-261002-1400-01' }] }), /id: is assigned by publish\.mjs/);
});
