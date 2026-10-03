#!/usr/bin/env node
// RUNBOOK step 10: check decisions.json against SPEC §5/§6 and FILTER.md before the dry run.
//
//   node pipeline/scripts/selfcheck.mjs --run <run_id> [--lenient]
//        [--work-dir D] [--archive F] [--thresholds F] [--filter F]
//
// Read-only: reads decisions.json, candidates.json and stage1.json for the run, the archive,
// pipeline/thresholds.json (level, candidate_issue_share_warn, claims_may_name_institutions), the
// FILTER.md §8.2 code list and its §10 worked examples (no generated text reuses them), and
// candidates.json window.replay (a replay cites nothing published after its window); writes
// nothing. Exit 0 when there are no errors, 1 when there are, 2 on usage error.

import fs from 'node:fs';
import { parseCli, runMain, log, out, UsageError } from '../lib/cli.mjs';
import { MECHANISMS } from '../lib/enums.mjs';
import { exists, readJson } from '../lib/io.mjs';
import { runWorkPaths } from '../lib/paths.mjs';
import { loadThresholds } from '../lib/thresholds.mjs';
import { parseRunId } from '../lib/time.mjs';
import { decisionStyleIssues, Issues, parseReasonCodeElements, parseReasonCodes, styleWarnings, validateDecisions } from '../lib/validate.mjs';

const USAGE = `node pipeline/scripts/selfcheck.mjs --run <run_id> [--lenient]
  [--work-dir D] [--archive F] [--thresholds F] [--filter F]

Checks pipeline/work/<run_id>/decisions.json before publish.mjs --dry-run (RUNBOOK step 10).
Read-only. Prints "warn ..." and "ERROR ..." lines and a final "self-check: N error(s), M
warning(s)" line on stderr, and a JSON summary on stdout. Exit 1 while any error remains.

Layer 1, the publishing gate (identical to publish.mjs): every rule of SPEC §5/§6 and the
FILTER.md §8.1-8.4 judgment invariants, through pipeline/lib/validate.mjs validateDecisions:
one judgment per stage-1 survivor, closed reason-code list, pass iff *_PASS_ code, section and
gate-code rules, dedup and match_id rules, cluster members mirror their lead, draft_index iff
pass, item schema, null/present rules by mechanism, word limits, first person, and the hard
neutrality constraints: a financial institution named (the lexicon, or a name ending in Bank,
Bancorp, Credit Union, Building Society or Trust Company) or uniquely described ("Britain's
biggest lender", "a G-SIB whose chief executive ...", "a card network that processes most ...")
in any generated field (in the claim only while thresholds.json claims_may_name_institutions is
false; a warning when it is true), a stated institution or sector position (V5, AO2: "already
cover", "unlikely to be affected", "existing frameworks already capture"), and questions, issue
statements and rationales that presume the reader's institution type, position it against
others, refer back to an institution in the story ("the UK lender", "the affected bank") or
state a sector-level position ("like most banks", "as is common across the sector", "banks
rarely") (V3, V4, V5); the 8-word verbatim guard against every candidate headline and lead;
sources drawn from the item's candidate_ids (including extra sources registered with
add-manual.mjs --extra), never an aggregator, cache, AMP, mailing-list or redirect URL, never a
paywalled sources[0] while a public source is listed, no headline on a source whose headline
the collector composed (CISA KEV); and no reuse of a published item's source URL outside a
material update.

Layer 2, FILTER.md rules that publish.mjs only warns about (errors here; warnings with
--lenient):
  - threshold_level equals pipeline/thresholds.json level (FILTER Appendix A)
  - a cluster member's reason begins "cluster member of " (FILTER 8.3.6)
  - V2 second person (claim included), V3 positioning words and lowercase "the bank" (not "the
    Bank of England"), V5 in a claim or interpretation: an unattributed sector-level position
    ("most banks still", "the majority of lenders", "standard practice", "widely deployed across
    retail banking"), an unattributed lapse inferred from an outcome ("had not patched", "left
    ... unpatched", "left its ... without callback verification") and evaluative words ("lax",
    "negligent", "sloppy", "reckless", "weak ... controls", "lagged behind the industry",
    "poorly secured"); V7 "PRAF", V9 hype words, V10 relative dates and currency written as
    million/billion (FILTER 7.1)
  - claim: ends with a full stop, no headline or teaser construction (7.2); interpretation: at
    least 12 words per entry, in the order of domains (7.4); validation question: one question
    mark, at most one "and", fewer than 3 yes/no clauses, no "this"/"described above", no
    Why/How/"what ... doing"/"confirm ... adequate", no "considered", "aware of", "prepared
    for", "confident" or "satisfied that" (7.5); question and issue statement: no reference to
    the development, its date or its victim ("following the 30 September outage", "unlike the
    UK lender"), the reader's own supervisor or finding, or a presupposed weakness (7.5.7);
    issue statement: conditional clause names the control (not "If the answer is no"), no
    "this", a consequence of 5+ words naming a harm, not "increased risk", "faces significant
    exposure" or "there could be problems" (7.6); no banned awareness phrases, and no 12+ words
    repeated from a published rationale (7.7, AO3); every source has source_class, no "//" or
    tracking parameter in a cited URL, an NVD URL is attributed to the NVD, no headline naming an
    institution with a characterisation of its position (7.8); item source_class equals
    sources[0].source_class (7.9); after the primary, non-news sources by authority, then news
    (2.9); reasons and notes free of second person, named institutions (the lexicon, a legal-form
    ending, or a capitalised name before an institution type and an event: "Bitget $388m exchange
    hack"; write "a crypto exchange's $388m hack") and hype (7.1); no run of 8 or more words from a
    FILTER.md section 10 worked example in any generated field, the section 7.5 rule 6 question
    shapes aside (FILTER 10); and in generated fields, the same capitalised-name-and-event pattern
    (V4)
  - reason markers (8.4): "NEAR" written as "NEAR <element>[/<knob>]: " at the start of a drop
    reason; the NEAR element is the element of the recorded code (FILTER.md 8.2); gate and dedup
    codes are never NEAR except a knob-controlled gate (G5, G7, G8, G9) or M2 with its knob;
    CS_ROUTINE_VULN only as "NEAR C6/cs_routine_vuln_exceptions", RT_JURISDICTION only as "NEAR
    R2/rt_standard_setters"; a knob named in a NEAR or "[alt ...]" marker exists in
    thresholds.json and controls that element; an "[alt ...]" marker naming a knob follows an EV
    or CS drop and names the other section
Warnings only (heuristics): a source published after a replay's window closed (candidates.json
window.replay; FILTER 2.7.5(e)); a claim resting on one primary document (regulator, standards
body, vendor or research source) with no attribution verb (7.2); advice in an interpretation,
including "has to be" and "needs to be", and an interpretation relying on a month-dated event the
claim never introduces ("The June cut-off ...") (7.4); a candidate_issue question that only checks
for a version ("older than 2.16.1.0") (7.5); quotation marks (V8), "sophisticated" (V9), American spelling (V10),
"failed to" or "inadequate" in a claim or interpretation, attributed sector statements and
attributed lapses, and a reference back to an institution in the story in an interpretation
(V5); a possible institution name ending in Insurance, Assurance or Securities (V4); unattributed
hedges and extra sentences in the claim (7.2), advice or repetition in an interpretation (7.4),
a second yes/no clause, "after the incident" or a vendor product name in a question (7.5), a
recommendation, rating ("significant exposure") or "already" in an issue statement (7.6), more
than 3 domains (7.3), a feed label or domain as the publication or a site-name suffix on a
headline (7.8), news out of tier order (general or business press after trade press, or public after
paywalled within a tier, by the sources.json tier; a guess where it is unknown) (2.9), a malformed "[alt ...]" marker, or one
that does not name the other section of an EV or CS drop (8.4), notes segments without a
FILTER 9.1 prefix, and a candidate_issue share above thresholds.json candidate_issue_share_warn
(with at least 2 candidate_issue items).

  --lenient   report the layer-2 rules as warnings (layer 1 stays errors)`;

const NOTE_PREFIXES = ['self-audit:', 'surge-recheck', 'ambiguity:', 'injection:', 'S1-GAP:', 'CORRECTION-PENDING:',
  'FILTER-SPEC conflict:', 'manual-unread:', 'budget:', 'thresholds: defaults used', 'source:'];

runMain(async () => {
  const { values, paths } = parseCli(process.argv.slice(2), {
    run: { type: 'string' },
    lenient: { type: 'boolean' },
  }, USAGE);
  if (!values.run) throw new UsageError(`--run <run_id> is required\n\n${USAGE}`);
  if (!parseRunId(values.run)) throw new UsageError(`--run: "${values.run}" is not a slot run id (YYYY-MM-DD-HHMM at 0600/1000/1400/1800 ET)`);
  const runId = values.run;
  const strict = !values.lenient;
  const wp = runWorkPaths(paths.workDir, runId);
  for (const f of [wp.decisions, wp.stage1, wp.candidates]) if (!exists(f)) throw new Error(`${f} not found`);
  const decisions = readJson(wp.decisions);
  const stage1 = readJson(wp.stage1);
  const candidatesDoc = readJson(wp.candidates);
  const archive = readJson(paths.archive, { schema_version: 1, items: [] });
  const thresholds = loadThresholds(paths.thresholds);
  const claimsMayNameInstitutions = thresholds.bool('claims_may_name_institutions');
  const filterText = exists(paths.filter) ? fs.readFileSync(paths.filter, 'utf8') : null;
  const reasonCodes = parseReasonCodes(filterText);
  const reasonElements = parseReasonCodeElements(filterText);
  const knobs = thresholds.knobs();
  const survivors = Array.isArray(stage1?.survivors) ? stage1.survivors : [];
  const candidates = Array.isArray(candidatesDoc?.candidates) ? candidatesDoc.candidates : [];
  const judgments = Array.isArray(decisions?.judgments) ? decisions.judgments : [];
  const items = Array.isArray(decisions?.items) ? decisions.items : [];

  // Layer 1: exactly what publish.mjs enforces (style rules are applied below at layer-2 severity).
  const v = new Issues().merge(validateDecisions(decisions, {
    runId,
    candidates,
    survivorIds: survivors.map((s) => s.candidate_id),
    archiveItems: Array.isArray(archive?.items) ? archive.items : [],
    reasonCodes,
    style: false,
    claimsMayNameInstitutions,
    window: candidatesDoc?.window ?? null,
  }));

  // Layer 2: FILTER.md rules.
  const filterIssue = (at, msg) => (strict ? v.error(at, msg) : v.warn(at, msg));
  if (decisions && typeof decisions === 'object' && decisions.threshold_level !== thresholds.level) {
    filterIssue('decisions.threshold_level', `${JSON.stringify(decisions.threshold_level)} must equal thresholds.json level ${JSON.stringify(thresholds.level)}${thresholds.found ? '' : ' (thresholds.json missing: launch default; add "thresholds: defaults used" to notes)'} (FILTER Appendix A)`);
  }
  judgments.forEach((j, i) => {
    if (j && j.dedup === 'cluster_merged' && !(typeof j.reason === 'string' && j.reason.startsWith('cluster member of '))) {
      filterIssue(`decisions.judgments[${i}] (${j.candidate_id})`, 'reason: a cluster member\'s reason begins "cluster member of <lead candidate_id>" (FILTER 5.2, 8.3.6)');
    }
  });
  items.forEach((item, i) => {
    if (item && typeof item === 'object') v.merge(styleWarnings(item, `decisions.items[${i}]`, { strict }));
  });
  for (const s of decisionStyleIssues(decisions, { candidates, archiveItems: Array.isArray(archive?.items) ? archive.items : [], reasonElements, knobs, filterText })) {
    const msg = `${s.message} (${s.rule})`;
    if (strict && s.banned) v.error(s.at, msg);
    else v.warn(s.at, msg);
  }
  if (typeof decisions?.notes === 'string' && decisions.notes.trim()) {
    for (const seg of decisions.notes.split(';').map((s) => s.trim()).filter(Boolean)) {
      if (!NOTE_PREFIXES.some((p) => seg.startsWith(p)) && !/\b(?:down|failed|unreachable|timeout|HTTP \d{3})\b/i.test(seg)) {
        v.warn('decisions.notes', `${JSON.stringify(seg.slice(0, 60))} does not start with a FILTER 9.1 prefix`);
      }
    }
  }
  const mix = Object.fromEntries(MECHANISMS.map((m) => [m, 0]));
  for (const it of items) if (MECHANISMS.includes(it?.mechanism)) mix[it.mechanism]++;
  const share = thresholds.number('candidate_issue_share_warn');
  if (items.length && mix.candidate_issue >= 2 && mix.candidate_issue / items.length > share) {
    v.warn('decisions.items', `candidate_issue ${mix.candidate_issue}/${items.length} exceeds ${share}: re-verify each against CI1-CI5 (RUNBOOK step 10); never retag to reduce the share`);
  }

  const { errors, warnings } = v.result();
  log(`self-check ${runId}: judgments ${judgments.length} for ${survivors.length} survivor(s); items ${items.length}; mechanisms ${JSON.stringify(mix)}${strict ? '' : ' (lenient)'}`);
  for (const w of warnings) log(`warn  ${w}`);
  for (const e of errors) log(`ERROR ${e}`);
  log(`self-check: ${errors.length} error(s), ${warnings.length} warning(s)`);
  out({ run_id: runId, ok: errors.length === 0, strict, judgments: judgments.length, survivors: survivors.length, items: items.length, mechanism_distribution: mix, errors, warnings });
  return errors.length ? 1 : 0;
});
