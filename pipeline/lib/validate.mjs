// SPEC §3 schema + §6 lint, shared by publish.mjs, validate.mjs and CI.
//
// Every function returns { errors: string[], warnings: string[] }. Messages name the location
// (e.g. `items[3] (RS-261002-1400-02) validation_question: ...`). Errors block publishing;
// warnings are printed and recorded but do not block.

import {
  CANDIDATE_ID_RE, DEDUP_OUTCOMES, DOMAINS, FUNNEL_KEYS, ITEM_ID_RE, ITEM_KEYS, MECHANISMS, REASON_CODE_RE,
  RUN_STATUSES, SECTIONS, SEEN_VERDICTS, SOURCE_CLASSES, SOURCE_KEYS, THRESHOLD_LEVELS, VERDICTS,
} from './enums.mjs';
import { findInstitutions } from './institutions.mjs';
import { canonical } from './io.mjs';
import { etParts, isEtIso, isIsoDate, isSlotIso, parseRunId } from './time.mjs';
import { disallowedSourceReason, isHttpsUrl, normaliseUrl, trackingParams } from './url.mjs';

export const LIMITS = Object.freeze({
  claimMin: 6,
  claimMax: 22,
  claimWarnMin: 8,
  claimWarnMax: 16,
  interpretationWords: 60,
  questionWords: 40,
  issueWords: 70,
  rationaleWords: 70,
  headlineChars: 200,
  notesChars: 280,
  reasonDropChars: 200,
  reasonPassChars: 400,
  verbatimWords: 8,
});

export class Issues {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }
  error(at, msg) {
    this.errors.push(at ? `${at}: ${msg}` : msg);
  }
  warn(at, msg) {
    this.warnings.push(at ? `${at}: ${msg}` : msg);
  }
  merge(other) {
    this.errors.push(...other.errors);
    this.warnings.push(...other.warnings);
    return this;
  }
  get ok() {
    return this.errors.length === 0;
  }
  result() {
    return { errors: this.errors, warnings: this.warnings };
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isInt = (v) => Number.isInteger(v) && v >= 0;
const quote = (s) => JSON.stringify(s);

/** Words: runs of letters/digits, allowing internal apostrophes, dots and hyphens (U.S., zero-day). */
export function wordCount(s) {
  return (String(s ?? '').match(/[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

// ---------------------------------------------------------------- generated-text lint (SPEC §6)
//
// Two severities, following FILTER.md §7 and the owner's hard constraints (SPEC §1.3):
//   lintItemText  hard constraints, errors at the publishing gate: first person (V1); a financial
//                 institution named or uniquely described (V4; in the claim per the knob
//                 claims_may_name_institutions); an institution's or the sector's position (V5,
//                 AO2, 7.7.4); paste-ready fields (question, issue statement, rationale) that
//                 presume the reader's institution type, position it against others (V3) or
//                 state a sector-level position (V5); plus the SPEC §6 shapes and word limits.
//   styleIssues   the other mechanically checkable writing rules of FILTER.md §7 and §2.9, as
//                 warnings at publish. `banned` marks the rules FILTER.md states absolutely;
//                 selfcheck.mjs makes those errors (RUNBOOK step 10). The rest are heuristics.

// Unicode-aware boundaries (an accented letter is part of the word: "éme", "usérs" never match).
// Case-sensitive I/us/Us are not matched when joined by a hyphen ("us-east-1", "I-95") or as I/O;
// "let's" is first-person plural. Uppercase US (the country) and U.S. are allowed. A standalone
// Roman numeral "I" ("Type I") still fails: FILTER.md V1 says write "Type 1".
const FIRST_PERSON_CI = /(?<![\p{L}\p{N}_])(we|our|ours|ourselves|my|me|let['’]s)(?![\p{L}\p{N}_])/iu;
const FIRST_PERSON_CS = /(?<![\p{L}\p{N}_-])(I|us|Us)(?![\p{L}\p{N}_-]|\/O)/u;

/** First-person token in text, or null. Uppercase US (the country) is allowed. */
export function findFirstPerson(text) {
  const s = String(text ?? '');
  const a = FIRST_PERSON_CI.exec(s);
  const b = FIRST_PERSON_CS.exec(s);
  if (a && b) return a.index <= b.index ? a[0] : b[0];
  return (a ?? b)?.[0] ?? null;
}

/** [{ field, text }] for every generated-text field present. */
export function generatedTexts(item) {
  const out = [];
  if (typeof item?.claim === 'string') out.push({ field: 'claim', text: item.claim });
  if (Array.isArray(item?.interpretation)) {
    item.interpretation.forEach((x, i) => {
      if (typeof x?.text === 'string') out.push({ field: `interpretation[${i}].text`, text: x.text });
    });
  }
  for (const f of ['validation_question', 'candidate_issue_statement', 'awareness_rationale']) {
    if (typeof item?.[f] === 'string') out.push({ field: f, text: item[f] });
  }
  return out;
}

/** The paste-ready fields: generic to any risk professional at any institution (SPEC §1.3). */
export const INSTITUTION_NEUTRAL_FIELDS = Object.freeze(['validation_question', 'candidate_issue_statement', 'awareness_rationale']);
const PASTE_READY = new Set(INSTITUTION_NEUTRAL_FIELDS);

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const rx = (s, flags = 'iu') => new RegExp(s, flags);
const firstMatch = (re, s) => re.exec(String(s ?? ''))?.[0] ?? null;

// FILTER V3: the reader's institution type in a paste-ready field ("the bank", "the insurer's").
// The type word is matched in lower case, so proper names ("the Bank of England", "the Bank")
// never match, and "the bank of ..." / "the bank for ..." are names, not positioning.
const READER_TYPE = rx(`${B}[Tt]he\\s+(?:bank|insurer|lender|credit\\s+union|building\\s+society|asset\\s+manager|broker-dealer)(?:['’]s)?(?![\\p{L}\\p{N}-])(?!\\s+(?:of|for)${E})`, 'u');
// FILTER V3 everywhere: lowercase "the bank" (it presumes the reader works at a bank).
const THE_BANK = rx(`${B}the\\s+bank(?:['’]s)?(?![\\p{L}\\p{N}-])(?!\\s+(?:of|for)${E})`, 'u');
// FILTER V3 positioning words. "peer-reviewed", "peer review" and "peer-to-peer" are not positioning.
const POSITIONING = /(?<![\p{L}\p{N}-])(peers(?![\p{L}\p{N}-])|peer(?![\p{L}\p{N}-])(?!\s+review)|competitors?(?![\p{L}\p{N}])|rivals?(?![\p{L}\p{N}])|our sector(?![\p{L}\p{N}])|institutions like this one)/iu;
// FILTER V4: a category form that identifies one institution is a name ("the largest US card
// network", "Britain's biggest lender", "its only clearing bank", "the custodian whose chief
// executive testified ...", "a G-SIB whose chief executive ...", "a bank that is the sole clearer
// for ...", "a card network that processes most debit transactions"). Plural categories ("the
// largest banks") fit several institutions and do not match; neither does a superlative about an
// event ("the largest exchange hack"), nor, in a paste-ready field, the reader's own organisation
// ("the organisation's only clearing bank", "its only clearing bank").
const FI_TYPE = '(?:bank|lender|insurer|reinsurer|card\\s+network|card\\s+issuer|payments?\\s+(?:processor|network|firm|company|provider)|processor|exchange|clearing\\s*house|central\\s+counterparty|custodian|credit\\s+union|building\\s+society|asset\\s+manager|wealth\\s+manager|broker-dealer|brokerage|clearer|depositary|G-SIB)';
const EVENT_NOUN = '(?:servers?|hacks?|breach(?:es)?|heists?|outages?|attacks?|theft|thefts|incidents?|fines?|penalt(?:y|ies)|failures?|collapses?|loss(?:es)?|fraud|scams?|rates?|holidays?|accounts?)';
const SUPERLATIVE = '(?:(?:second|third|fourth|fifth)-)?(?:largest|biggest)|oldest|only|sole';
// A modifier between a determiner and an institution type is a content word, never a function word:
// "the only way a bank can ..." and "the future of global bank supervision" describe no institution.
const MOD = '(?:(?!(?:of|for|to|that|which|who|whom|whose|a|an|the|and|or|in|on|at|by|with|from|as|is|are|was|were|be|been|its|their|this|these|those|than|can|could|may|might|will|would|should|must|has|have|had|not)\\s)[\\p{L}-]+\\s+)';
const LEADER_ROLE = '(?:chief\\s+[\\p{L}-]+(?:\\s+officer)?|CEO|CFO|CRO|CISO|CIO|CTO|COO|chair(?:man|woman|person)?|president|founder|head)';
const UNIQUE_DESCRIPTOR = rx(`${B}(?:(?:(?:the|its)\\s+(?:[\\p{L}.]+['’]s\\s+)?|[\\p{L}.]+['’]s\\s+)(?:${SUPERLATIVE})\\s+${MOD}{0,3}?${FI_TYPE}(?![\\p{L}\\p{N}-])(?!\\s+${EVENT_NOUN}${E})|the\\s+${MOD}{0,2}?${FI_TYPE}\\s+whose${E}|an?\\s+${MOD}{0,3}?${FI_TYPE}\\s+whose\\s+(?:[\\p{L}-]+\\s+){0,2}?${LEADER_ROLE}${E}|${FI_TYPE}\\s+(?:that|which)\\s+(?:is|was)\\s+(?:the|its)\\s+(?:${SUPERLATIVE})${E}|${FI_TYPE}\\s+(?:that|which)\\s+(?:processes|handles|clears|holds|serves|settles|carries|issues)\\s+(?:most|the\\s+majority|half|over\\s+half|more\\s+than\\s+half|nearly\\s+all|almost\\s+all)${E})`, 'giu');
const OWN_ORGANISATION = /(?<![\p{L}\p{N}])(?:organi[sz]ation['’]s|its)(?![\p{L}\p{N}])/iu;
/** First unique descriptor in text, or null; in a paste-ready field the organisation's own is generic. */
export function findUniqueDescriptor(text, { pasteReady = false } = {}) {
  UNIQUE_DESCRIPTOR.lastIndex = 0;
  for (const m of String(text ?? '').matchAll(UNIQUE_DESCRIPTOR)) {
    if (pasteReady && OWN_ORGANISATION.test(m[0])) continue;
    if (/organi[sz]ation['’]s/iu.test(m[0])) continue;
    return m[0];
  }
  return null;
}
// FILTER V4: a name the lexicon lacks, recognised by its legal-form ending ("Patelco Credit Union",
// "First Horizon Bank"). Authorities and places are not names of institutions ("European Central
// Bank", "World Bank", "Swiss National Bank", "West Bank"; "Bank of ...", "Bank for ..."); "Insurance",
// "Assurance" and "Securities" also end everyday phrases, so they only warn.
const SUFFIX_NAME = /(?<![\p{L}\p{N}])((?:\p{Lu}[\p{L}\p{N}&'’.-]*\s+){1,3})(Bank|Bancorp|Bancorporation|Bancshares|BancShares|Credit\s+Union|Building\s+Society|Savings\s+Bank|Trust\s+Company|Insurance|Assurance|Securities)(?![\p{L}\p{N}])(?!\s+(?:of|for|and|Corporation|Fund|Scheme|Program|Programme|Guarantee|Guaranty|Agency|Office|Commission|Authority|Administration|Board|Act|Bill|Regulation|Directive|Committee|Supervision|Supervisor|Policy|Institute|Journal|Federation|Association|Council|Forum|Ombudsman|Service|Services|Holiday|Holidays|Rate|Week|Day)(?![\p{L}\p{N}]))/gu;
const SUFFIX_NOT_A_NAME = /(?:^|\s)(?:Central|Reserve|Development|Investment|Infrastructure|Reconstruction|World|National|People['’]s|Export-Import|Settlements|Deposit|Flood|Data|Food|Blood|Seed|Memory|West|East|North|South|Left)\s*$/u;
const SUFFIX_DETERMINER = /^(?:(?:The|A|An|Any|Each|Every|One|Some|This|That|US|UK|EU|U\.S\.|U\.K\.)\s+)+/u;
/** { match, soft } for a financial-institution name recognised by its legal-form ending, or null. */
export function findNameBySuffix(text) {
  SUFFIX_NAME.lastIndex = 0;
  for (const m of String(text ?? '').matchAll(SUFFIX_NAME)) {
    const words = m[1].replace(SUFFIX_DETERMINER, '');
    if (!words.trim() || SUFFIX_NOT_A_NAME.test(words.trimEnd())) continue;
    return { match: `${words}${m[2]}`.trim(), soft: /^(?:Insurance|Assurance|Securities)$/.test(m[2]) };
  }
  return null;
}
// FILTER V4: a capitalised name the lexicon lacks, directly before an institution type and an event
// ("Bitget $388m exchange hack", "Acme Pay processor outage"); logs and notes are public. A category
// form opens with an article or quantifier ("a crypto exchange's $388m hack", "a Hong Kong exchange
// outage"), and place or category words alone are not names ("UK bank outage", "Crypto exchange hacks").
const FI_EVENT_TYPE = '(?:exchange|bank|lender|insurer|processor|wallet|custodian|broker|neobank)';
const FI_EVENT_NOUN = '(?:hacks?|breach(?:es)?|heists?|outages?|attacks?|thefts?|incidents?|fines?|penalt(?:y|ies)|failures?|collapses?|loss(?:es)?|fraud|scams?|exploits?)';
const NAMED_FI_EVENT = new RegExp(`(?<![\\p{L}\\p{N}-])(\\p{Lu}[\\p{L}\\p{N}&.'’-]*(?:\\s+\\p{Lu}[\\p{L}\\p{N}&.'’-]*){0,2})(?:['’]s)?\\s+(?:[$£€][\\d.,]+\\s?(?:k|m|bn)?\\s+)?(?:crypto(?:-asset)?\\s+|payments?\\s+|card\\s+)?${FI_EVENT_TYPE}\\s+${FI_EVENT_NOUN}(?![\\p{L}\\p{N}])`, 'gu');
const NAME_DETERMINER = new Set(['A', 'An', 'One', 'Another', 'Any', 'Each', 'Every', 'Some', 'Several', 'No', 'The', 'This', 'That', 'These', 'Those', 'Its', 'Their']);
const NAME_INDEFINITE = new Set(['A', 'An', 'One', 'Another', 'Any', 'Each', 'Every', 'Some', 'Several', 'No']);
const NAME_GENERIC = new Set(`UK US U.S. USA EU E.U. G-SIB G-SIBs British American European Asian African Nordic Gulf Latin Middle
  Britain England Scotland Wales Ireland Irish Europe America Canada Canadian Australia Australian Japan Japanese China Chinese Korea Korean
  India Indian Germany German France French Switzerland Swiss Netherlands Dutch Italy Italian Spain Spanish Brazil Brazilian Singapore
  Singaporean Hong Kong Taiwan Taiwanese Russia Russian Turkey Turkish Dubai UAE Israeli Mexican Nigerian African South North East West
  Global Major Large Big Small Mid-sized Regional National International Digital Online Retail Crypto Cryptocurrency Bitcoin Ethereum
  DeFi Decentralised Decentralized Payment Payments Card Central Commercial Community Challenger Mutual Private Public State Federal
  Fintech Offshore Overseas Foreign Domestic Local Tier Top Leading Second Third New Former Same Unnamed Many Multiple Largest Biggest
  SEC FCA PRA OCC FDIC CFPB FINRA ECB EBA ESMA EIOPA ESRB BoE Fed FinCEN OFAC CFTC NYDFS DOJ FBI CISA NCSC ENISA BIS FSB IOSCO IMF
  FTC Treasury Reserve Bundesbank BaFin AMF APRA ASIC MAS HKMA Europol Interpol Commission Parliament Council Government Congress
  Senate House Court Regulator Supervisor Police`.split(/\s+/));
/** A capitalised name before an institution type and an event ("Bitget $388m exchange hack"), or null. */
export function findNamedInstitutionEvent(text) {
  const s = String(text ?? '');
  NAMED_FI_EVENT.lastIndex = 0;
  for (const m of s.matchAll(NAMED_FI_EVENT)) {
    const tokens = m[1].split(/\s+/);
    if (NAME_INDEFINITE.has(tokens[0])) continue;
    if (/(?:^|[^\p{L}\p{N}])(?:a|an|one|another|any|each|every|some|several|no)\s+$/iu.test(s.slice(0, m.index))) continue;
    const name = tokens.filter((t) => !NAME_DETERMINER.has(t) && !NAME_GENERIC.has(t));
    if (name.length) return m[0];
  }
  return null;
}
// FILTER V4 and 7.5-7.7: outside the claim, a reference back to one institution in the story ("the
// UK lender", "the affected bank", "the targeted insurer's"). The type word is matched in lower case
// ("the European Central Bank" never matches); role words name a counterparty generically ("the
// receiving bank", "the sponsor bank", "the card issuer", "the same bank", "the backup processor").
const BACKREF = new RegExp(`${B}[Tt]he\\s+(${MOD}{0,3}?)((?:bank|lender|insurer|reinsurer|card\\s+network|card\\s+issuer|payments?\\s+(?:processor|network|firm|company|provider)|processor|exchange|clearing\\s*house|central\\s+counterparty|custodian|credit\\s+union|building\\s+society|asset\\s+manager|wealth\\s+manager|broker-dealer|brokerage|G-SIB))(?:['’]s(?![\\p{L}\\p{N}])|(?![\\p{L}\\p{N}'’-])(?!\\s+(?:of|for|supervision|supervisory|supervisors?|regulation|regulatory|regulators?|holidays?|rates?|runs?|failures?|resolution|charters?|levy|levies|capital|lending|deposits?|branch(?:es)?|accounts?|statements?|transfers?|cards?)${E}))`, 'gu');
const BACKREF_ROLE = /(?:^|\s)(?:central|reserve|development|investment|sponsor|sponsoring|partner|correspondent|issuing|acquiring|settlement|clearing|receiving|sending|beneficiary|originating|intermediary|paying|collecting|payer|payee|card|payment|payments|third-party|outsourced|cloud|chosen|relevant|appropriate|responsible|primary|secondary|backup|alternate|alternative|fallback|existing|current|incumbent|new|replacement|contracted|designated|nominated|main|principal|same|single|other|customer|client|counterparty|home|host|local|domestic|foreign|key|token|code|data|message|messaging|file|information|email|mail|cyber)\s*$/iu;
/** A back-reference to one institution in the story ("the UK lender"), or null; role words are generic. */
export function findBackReference(text) {
  BACKREF.lastIndex = 0;
  for (const m of String(text ?? '').matchAll(BACKREF)) {
    if (m[2] === 'G-SIB' && !m[1].trim()) return m[0];
    if (m[1].trim() && !BACKREF_ROLE.test(m[1])) return m[0];
  }
  return null;
}
// FILTER V5, AO2 and 7.7.4: an institution's or the sector's position, stated or implied.
const POSITION = rx(`${B}(already\\s+cover(?:s|ed|ing)?|existing\\s+controls\\s+(?:are|were|remain)\\s+(?:adequate|sufficient|effective|appropriate)|not\\s+exposed|no\\s+exposure(?!\\s+(?:window|path|route))|(?:sector|industry)\\s+exposure\\s+is\\s+(?:limited|low|minimal|contained|small)|exposure\\s+is\\s+(?:limited|low|minimal)|the\\s+organisation\\s+already|institutions\\s+of\\s+all\\s+sizes|(?:organi[sz]ations?|it|they|firms|institutions|banks|lenders|insurers|sector|industry)\\s+(?:is|are)\\s+(?:\\p{L}+\\s+)?(?:un)?likely\\s+to\\s+be\\s+(?:affected|exposed|impacted|vulnerable)|(?:organi[sz]ations?|firms|institutions|banks|lenders|insurers|sector|industry)\\s+(?:is|are|was|were|remains?|remained|would\\s+be|will\\s+be)\\s+(?:largely\\s+|mostly\\s+|broadly\\s+)?unaffected|(?:existing|current|internal|their)\\s+(?:[\\p{L}-]+\\s+)?(?:controls?|frameworks?|programmes?|defences|processes|policies)\\s+(?:\\p{L}+\\s+)?already\\s+(?:capture|address|include|handle|cover|account\\s+for|meet|compl[yi]|mitigate|prevent)\\w*|(?:organi[sz]ations|firms|institutions|banks|lenders|insurers)\\s+(?:\\p{L}+\\s+)?already\\s+(?:capture|address|include|handle|cover|account\\s+for|meet|compl[yi]|mitigate|prevent|have|run|use|enforce|require)\\w*|(?:existing|current)\\s+(?:controls|frameworks|defences|processes)\\s+(?:capture|address|cover|handle|mitigate|prevent)\\w*)${E}`);
// FILTER V5 and 7.7.4: a sector-level position, how many institutions have, lack or do something.
// SECTOR_QUANT (bare, for questions and issue statements, which concern the organisation alone);
// SECTOR_POSITION (a quantifier with a state verb); SECTOR_PHRASE (prevalence and comfort phrases).
const FI_PLURAL = '(?:firms|institutions|banks|organisations|organizations|lenders|insurers|credit\\s+unions|building\\s+societies|processors|exchanges|custodians|financial\\s+institutions|G-SIBs)';
const SECTOR_QUANT = rx(`${B}(?:(?:most|many|few|nearly\\s+all|almost\\s+all|the\\s+majority\\s+of|a\\s+minority\\s+of|like\\s+(?:most|many|other|all))\\s+(?:[\\p{L}-]+\\s+){0,2}?${FI_PLURAL})${E}`);
const SECTOR_POSITION = rx(`${B}((?:most|many|all|few|some|nearly\\s+all|almost\\s+all|the\\s+majority\\s+of|a\\s+minority\\s+of)\\s+(?:[\\p{L}-]+\\s+){0,2}?${FI_PLURAL}\\s+(?:[\\p{L}-]+\\s+){0,2}?(?:have|has|already|are|do|lack|lacks|will|still|rely|use|allow|run|route|accept|depend|keep|retain|permit|offer|remain)|few\\s+(?:firms|banks|institutions|lenders|insurers)|like\\s+(?:most|many|other|all)\\s+(?:[\\p{L}-]+\\s+){0,2}?${FI_PLURAL})${E}`);
const SECTOR_PHRASE = rx(`${B}((?:common|typical|usual|standard|widespread|prevalent)\\s+(?:practice\\s+)?(?:across|in|among|throughout)\\s+(?:the\\s+)?(?:sector|industry|market|financial\\s+services)|(?:industry|sector|market|standard|common)\\s+practice|widely\\s+(?:adopted|deployed|implemented|used|in\\s+place)\\s+(?:across|in|by|among|throughout)\\s+(?:the\\s+)?(?:sector|industry|retail\\s+banking|banking|financial\\s+services|${FI_PLURAL})|${FI_PLURAL}\\s+(?:rarely|seldom|typically|generally|usually|commonly|routinely|largely|mostly)|(?:the\\s+)?(?:sector|industry)\\s+is\\s+(?:well|largely|broadly|generally|already)|(?:organi[sz]ations?|firms|institutions|banks|lenders|insurers|sector|industry)\\s+(?:is|are|remains?|seems?|appears?)\\s+(?:\\p{L}+\\s+)?well\\s+(?:placed|positioned|prepared|protected|defended)|largely\\s+(?:mitigated|addressed)|generally\\s+compliant)${E}`);
const ATTRIBUTION = rx(`${B}(says?|said|warns?|warned|reports?|reported|expects?|plans?|estimates?|forecasts?|according\\s+to|told|proposes?|testified|stated|announced|argued|wrote|found|finds|disclosed|confirmed|claims?|survey(?:ed)?)${E}`);

/**
 * Hard-constraint lint on generated text, plus the SPEC §6 shapes; adds the FILTER.md §7 style
 * rules as warnings unless `style` is false.
 * @param {{style?: boolean, claimsMayNameInstitutions?: boolean}} opts
 *   claimsMayNameInstitutions: thresholds.json writing.claims_may_name_institutions. false
 *   (launch): a financial institution named or uniquely described in the claim is an error;
 *   true: a warning (the claim may name the subject of a reported event or public statement).
 */
export function lintItemText(item, at = 'item', { style = true, claimsMayNameInstitutions = false } = {}) {
  const v = new Issues();
  for (const { field, text } of generatedTexts(item)) {
    const fp = findFirstPerson(text);
    if (fp) v.error(at, `${field}: first-person voice ${quote(fp)} is not allowed in generated text`);
    const paste = PASTE_READY.has(field);
    const hits = findInstitutions(text);
    const unique = findUniqueDescriptor(text, { pasteReady: paste });
    const bySuffix = findNameBySuffix(text);
    if (hits.length || unique || (bySuffix && !bySuffix.soft)) {
      const what = hits.length
        ? `names a specific financial institution: ${[...new Set(hits.map((h) => `${quote(h.match)} (${h.name})`))].join(', ')}`
        : unique
          ? `names a specific financial institution through a unique descriptor ${quote(unique)}`
          : `names a specific financial institution ${quote(bySuffix.match)} (a name ending in a legal form)`;
      if (paste) v.error(at, `${field}: ${what}; keep it generic to any institution (FILTER V4)`);
      else if (field === 'claim' && claimsMayNameInstitutions) v.warn(at, `claim: ${what}; allowed only as the subject of a publicly reported event or statement, with an attribution verb and no evaluative word (FILTER V4, claims_may_name_institutions true)`);
      else v.error(at, `${field}: ${what}; use the category form, e.g. "a large UK bank" (FILTER V4${field === 'claim' ? ', claims_may_name_institutions false' : ''})`);
    } else if (bySuffix) {
      v.warn(at, `${field}: ${quote(bySuffix.match)} may name a financial institution; use the category form if it does (FILTER V4)`);
    }
    if (field !== 'claim') {
      const pos = firstMatch(POSITION, text);
      if (pos) v.error(at, `${field}: states or implies a position ${quote(pos)}; describe the development, never anyone's controls or exposure (FILTER V5, AO2)`);
    }
    if (paste) {
      const type = firstMatch(READER_TYPE, text);
      if (type) v.error(at, `${field}: presumes the reader's institution type ${quote(type)}; write "the organisation" (FILTER V3)`);
      const posWord = firstMatch(POSITIONING, text);
      if (posWord) v.error(at, `${field}: positioning word ${quote(posWord)}; paste-ready text is generic to any institution (FILTER V3)`);
      const back = findBackReference(text);
      if (back) v.error(at, `${field}: refers back to an institution in the story ${quote(back)}; paste-ready text is generic to any institution (write "the organisation", or name the role: "the receiving bank") (FILTER V4, 7.5.7)`);
      const sector = firstMatch(SECTOR_POSITION, text) ?? firstMatch(SECTOR_PHRASE, text)
        ?? (field === 'awareness_rationale' ? null : firstMatch(SECTOR_QUANT, text));
      if (sector) v.error(at, `${field}: states a sector-level position ${quote(sector)}; paste-ready text concerns the organisation alone (FILTER V5, 7.7.4)`);
    }
  }
  if (typeof item?.claim === 'string') {
    if (/[\r\n]/.test(item.claim)) v.error(at, 'claim: must be a single line');
    const n = wordCount(item.claim);
    if (n < LIMITS.claimMin || n > LIMITS.claimMax) v.error(at, `claim: ${n} words (must be ${LIMITS.claimMin}-${LIMITS.claimMax})`);
    else if (n < LIMITS.claimWarnMin || n > LIMITS.claimWarnMax) v.warn(at, `claim: ${n} words (aim for ${LIMITS.claimWarnMin}-${LIMITS.claimWarnMax}, ~12)`);
    if (/\?\s*$/.test(item.claim)) v.warn(at, 'claim: reads as a question; a claim is an assertion of fact');
  }
  if (Array.isArray(item?.interpretation)) {
    item.interpretation.forEach((x, i) => {
      if (typeof x?.text === 'string' && wordCount(x.text) > LIMITS.interpretationWords) {
        v.error(at, `interpretation[${i}].text: ${wordCount(x.text)} words (max ${LIMITS.interpretationWords})`);
      }
    });
  }
  if (typeof item?.validation_question === 'string') {
    const q = item.validation_question;
    if (/[\r\n]/.test(q)) v.error(at, 'validation_question: must be a single line (paste-ready)');
    if (!/\?$/.test(q.trim())) v.error(at, 'validation_question: must end with "?"');
    if (wordCount(q) > LIMITS.questionWords) v.error(at, `validation_question: ${wordCount(q)} words (max ${LIMITS.questionWords})`);
  }
  if (typeof item?.candidate_issue_statement === 'string') {
    const s = item.candidate_issue_statement;
    if (!/^(Where|If) /.test(s)) v.error(at, 'candidate_issue_statement: must begin "Where " or "If " (conditional control weakness)');
    if (!s.includes(',')) v.error(at, 'candidate_issue_statement: must contain a comma separating the weakness clause from the consequence clause');
    if (wordCount(s) > LIMITS.issueWords) v.error(at, `candidate_issue_statement: ${wordCount(s)} words (max ${LIMITS.issueWords})`);
  }
  if (typeof item?.awareness_rationale === 'string' && wordCount(item.awareness_rationale) > LIMITS.rationaleWords) {
    v.error(at, `awareness_rationale: ${wordCount(item.awareness_rationale)} words (max ${LIMITS.rationaleWords})`);
  }
  if (style) v.merge(styleWarnings(item, at));
  return v.result();
}

// ---------------------------------------------------------------- FILTER.md §7 and §2.9 style

const SECOND_PERSON = rx(`${B}(you|your|yours|yourself|yourselves)${E}`);
// "breaking" only as news hype ("breaking news", "Breaking:"), not "breaking encryption".
const HYPE = /(?<![\p{L}\p{N}])(unprecedented|alarming|massive|game-changing|game-changer|wake-up call|landmark|breaking(?=\s+news(?![\p{L}]))|breaking(?=\s*:))(?![\p{L}\p{N}])/iu;
const SOPHISTICATED = rx(`${B}sophisticated${E}`);
const RELATIVE_DATE = /\b(yesterday|today|tonight|tomorrow|this (?:week|month|year|quarter|weekend|morning|afternoon|evening)|last (?:week|month|year|quarter|weekend|night)|next (?:week|month|year|quarter)|recently)\b/i;
// FILTER V10 British spelling: lower-case American forms only, so proper names ("Department of
// Defense", "Center for Internet Security", "Known Exploited Vulnerabilities Catalog") never match.
const AMERICAN_SPELLING = rx(`${B}((?:un)?authoriz(?:e|es|ed|ing|ation|ations)|organization(?:s|al)?|prioritiz(?:e|es|ed|ing|ation)|recogniz(?:e|es|ed|ing)|analyz(?:e|es|ed|ing)|minimiz(?:e|es|ed|ing)|utiliz(?:e|es|ed|ing|ation)|optimiz(?:e|es|ed|ing|ation)|behavior(?:s|al)?|modeling|modeled|labeled|labeling|canceled|defense|defenses|center|centers|catalog|catalogs)${E}`, 'u');
// FILTER V10: currency with m and bn ("$25m", "£1.2bn"), not "million"/"billion".
const CURRENCY_WORDS = rx(`(?:[$£€]|${B}(?:USD|EUR|GBP|US\\$)\\s?)\\s?\\d[\\d.,]*\\s?(?:million|billion|trillion|mn|bln)${E}`);
// FILTER V5: evaluative words about an institution's controls. "lax", "negligent", "sloppy" and
// "reckless" only ever judge someone's controls (banned); "failed to" and "inadequate" also
// describe a control failing in a real event, the language of capability shift (heuristic).
const EVALUATIVE_JUDGMENT = rx(`${B}(lax|negligent|negligence|sloppy|reckless|weak(?:er|est)?\\s+(?:[\\p{L}-]+\\s+)?(?:controls?|oversight|governance|defen[cs]es|processes|procedures|practices)|(?:lagg(?:ed|ing)|lags?|fell|falls?|fallen)\\s+behind\\s+(?:the\\s+)?(?:industry|sector|market|other|its|their|peers|competitors|rivals|best\\s+practice|regulatory|supervisory)|behind\\s+(?:the\\s+)?(?:industry|sector|other\\s+(?:firms|banks|institutions|lenders|insurers))|immature\\s+(?:[\\p{L}-]+\\s+)?(?:controls?|security|processes|practices|programmes?|governance|capabilit(?:y|ies))|poorly\\s+(?:controlled|managed|secured|governed|protected))${E}`);
const EVALUATIVE = rx(`${B}(failed\\s+to|inadequate|inadequately)${E}`);
// FILTER V5: a lapse inferred from an outcome ("had not patched", "left ... unpatched", "left its
// reset process without callback verification"). A generic condition ("firms that have not
// enabled ...") is not a lapse; an attributed one is a warning.
const LAPSE = rx(`${B}(?<!(?:that|which|who|where|if|when|unless|whether)\\s+(?:[\\p{L}-]+\\s+){0,2})((?:had|has|have)\\s+not\\s+(?:yet\\s+)?(?:patched|updated|upgraded|enabled|applied|rotated|revoked|tested|fixed|encrypted|segmented|removed)|did\\s+not\\s+(?:patch|update|upgrade|enable|apply|rotate|revoke|test|fix|encrypt|detect|notice|segment|remove)|left\\s+(?:[\\p{L}-]+\\s+){0,6}?(?:unpatched|unencrypted|unprotected|unsecured|unmonitored)|left\\s+(?:its|their)\\s+(?:[\\p{L}-]+\\s+){0,4}?without\\s+(?:[\\p{L}-]+\\s+){0,2}?(?:verification|authentication|MFA|multi-factor|encryption|monitoring|logging|backups?|segmentation|patch(?:es|ing)?|testing|oversight|controls?|protection|callbacks?)|neglected\\s+to|ignored\\s+(?:the\\s+)?(?:warnings?|alerts?|advisories)|never\\s+(?:patched|enabled|tested|encrypted|rotated))${E}`);
// FILTER 7.2: headline constructions and teaser verbs; hedges without attribution.
const CLAIM_TEASER = rx(`(:\\s)|^(?:what|why|how|here['’]s)${E}|${B}(?:what\\s+[\\p{L}\\s]{0,40}\\s+means|highlights?|sheds?\\s+light|raises?\\s+(?:concerns|questions)|underscores?|spotlights?)${E}`);
const CLAIM_HEDGE = rx(`${B}(may|might|could|possibly|potentially|appears\\s+to|seems\\s+to)${E}`);
// FILTER 7.4: advice in an interpretation ("limits have to be enforced by the environment" is advice).
const ADVICE = rx(`${B}(should|must|ought\\s+to|be\\s+aware|it\\s+is\\s+(?:important|essential|vital)|(?:has|have)\\s+to\\s+be|needs?\\s+to\\s+be)${E}`);
// FILTER 7.4 rule 5: an interpretation relying on a dated event the claim never introduces ("The
// June cut-off came from a government directive" under a claim that mentions no June event).
const MONTH_EVENT = /(?<![\p{L}\p{N}])[Tt]he\s+(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{4})?\s+[\p{L}-]+/u;
// FILTER 7.2 rule 4: a claim resting on a single source attributes it ("..., Microsoft says").
const CLAIM_ATTRIBUTION = rx(`${B}(says?|said|warns?|warned|reports?|reported|expects?|plans?|estimates?|estimated|forecasts?|according\\s+to|told|tells|proposes?|proposed|testified|stated|states|announced|announces|argued|argues|wrote|writes|found|finds|disclosed|discloses|confirmed|confirms|claims?|claimed|counts?|counted|records?|recorded|lists?|listed|publish(?:es|ed)|describes?|described|notes?|noted|admits?|admitted|acknowledges?|acknowledged|asks?|asked|urges?|urged|calls?\\s+(?:for|on)|called\\s+(?:for|on)|signals?|signalled|signaled|outlines?|outlined|survey(?:ed|s)?)${E}`);
// FILTER 7.2 rule 10: a formal rule or exam notice is its issuer's own act, so the issuer as subject
// with an instrument verb ("The PRA adopts ...", "Two agencies require ...", "... will examine")
// needs no further attribution. Accepted only for a regulator-class source: formal instruments are
// always regulator class (FILTER 2.2), and the verbs prove nothing about another class's claim.
const INSTRUMENT_ATTRIBUTION = rx(`${B}(requires?|sets?|adopts?|issues?|withdraws?|rescinds?|finali[sz]es?|will\\s+(?:examine|assess|review))${E}`);
const PRIMARY_DOCUMENT_CLASSES = Object.freeze(['regulator', 'standards_body', 'vendor_threat_research', 'research_analysis']);
// FILTER 7.5 rule 7: a question whose content is whether a fixed version is installed is patch
// management (C6), never a candidate_issue question.
const VERSION_CHECK = /(?:older|earlier|lower|below|prior\s+to|before)\s+(?:than\s+)?(?:version\s+|v)?\d+(?:\.\d+)+/i;
// FILTER 7.5.3 and 7.6: paste-ready fields never point back at the item.
const DEICTIC = rx(`${B}(this|these|the\\s+above|above-mentioned|aforementioned|described\\s+above|mentioned\\s+above|the\\s+incident\\s+described)${E}`);
// FILTER 7.5.4 and 7.5.5: open or leading questions ("How many ..." and "What is the maximum ..." pass).
const OPEN_Q = rx(`^why${E}|^how(?!\\s+(?:many|much|long|often|quickly|frequently|soon)${E})${E}|^(?:what|how)${E}[^?]*${B}doing${E}|^what\\s+(?:steps|actions|measures|plans?|is\\s+being\\s+done)${E}|${B}why\\s+(?:has|have|is|are|does|do|was|were)n['’]?t${E}|${B}confirm${E}[^?]*${B}(adequate|sufficient|effective|appropriate)${E}`);
// FILTER 7.5.4: answers that settle nothing ("Has the organisation considered ...", "Is the
// organisation aware of / prepared for / confident ...").
const UNRESOLVABLE_Q = rx(`${B}((?:has|have|had)\\s+(?:the\\s+organi[sz]ation\\s+|it\\s+)?(?:fully\\s+|properly\\s+|adequately\\s+)?considered|considered\\s+(?:the\\s+)?(?:risks?|threats?|impacts?|possibility|implications)|thought\\s+about|aware\\s+of|(?:organi[sz]ation|it)\\s+(?:is\\s+|be\\s+)?(?:fully\\s+|adequately\\s+)?(?:ready|prepared)\\s+for|confident|comfortable|satisfied\\s+that|reassured)${E}`);
// FILTER 7.5.2: clause-initial auxiliaries; 3 or more is a checklist, 2 a second question.
const CLAUSE_AUX = /(?:^|,\s*|\band\s+|\bor\s+)(is|are|does|do|did|has|have|had|was|were|can|could|will|would|should)\b/gi;
// FILTER 7.5 rule 7: a question that only makes sense at one institution. Banned: the reader's own
// supervisor or finding; a reference to the development, its date or its victim; a presupposed
// weakness. A plain "after the incident" is a heuristic warning.
const OWN_SUPERVISOR = rx(`${B}((?:its|the\\s+organi[sz]ation['’]s)\\s+(?:own\\s+)?(?:lead|primary|home)\\s+(?:supervisor|regulator|examiner)|(?:its|the\\s+organi[sz]ation['’]s)\\s+(?:supervisor|regulator|examiner|auditor)\\s+(?:requested|asked|required|found|identified|raised)|the\\s+(?:finding|findings|issue|issues|request)\\s+(?:its|the\\s+organi[sz]ation['’]s)\\s+(?:own\\s+)?(?:lead\\s+)?(?:supervisor|regulator|examiner|auditor))${E}`);
const EVENT_REF = new RegExp(`${B}(?:after|following|since|to|from|by|in|during|before)\\s+the\\s+((?:[\\p{L}\\p{N}-]+\\s+){1,3}?)(?:intrusion|breach|incident|outage|attack|theft|hack|heist|campaign|compromise|finding|examination|exam|disruption|failure|scam)${E}`, 'giu');
const EVENT_IDENTIFIER = /\d|(?<![\p{L}])\p{Lu}\p{Ll}|(?<![\p{L}])(?:recent|reported|disclosed|publici[sz]ed|latest|same|above|aforementioned)(?![\p{L}])/u;
const EVENT_GENERIC = rx(`${B}((?:after|following|since)\\s+the\\s+(?:[\\p{L}-]+\\s+){0,2}(?:intrusion|breach|incident|outage|attack|finding|examination|exam))${E}`);
const VICTIM_REF = rx(`${B}((?:unlike|like|as\\s+at|as\\s+with)\\s+(?:the|a|an)\\s+${MOD}{0,3}?${FI_TYPE}|(?:its|the\\s+organi[sz]ation['’]s)\\s+(?:own\\s+)?(?:weakness(?:es)?|lapses?|deficienc(?:y|ies)|shortfalls?|failings?))(?![\\p{L}\\p{N}-])`);
/** A reference to the development, its date or a named party ("following the 30 September outage"), or null. */
export function findEventReference(text) {
  EVENT_REF.lastIndex = 0;
  for (const m of String(text ?? '').matchAll(EVENT_REF)) if (EVENT_IDENTIFIER.test(m[1])) return m[0];
  return null;
}
// FILTER 7.5.7: a vendor product named in a question (CamelCase or mixed case, e.g. a product
// called "ExampleMail"); class terms written in mixed case are not products.
const PRODUCT_NAME = /(?<![\p{L}\p{N}])(?:\p{Lu}\p{Ll}+\p{Lu}[\p{L}\p{N}]*|\p{Lu}{2,}\p{Ll}{2,}[\p{L}\p{N}]*|\p{Ll}+\p{Lu}[\p{L}\p{N}]*)(?![\p{L}\p{N}])/gu;
const MIXED_CASE_TERMS = new Set(['SaaS', 'PaaS', 'IaaS', 'OAuth', 'WebAuthn', 'DevOps', 'DevSecOps', 'FinTech', 'RegTech', 'InsurTech', 'IoT', 'eSIM', 'eID', 'eIDAS', 'iOS', 'macOS', 'DDoS', 'NetFlow', 'PowerShell', 'JavaScript', 'TypeScript', 'GitOps', 'MLOps', 'LLMs', 'APIs', 'HSMs', 'CVEs', 'IDs', 'URLs', 'VPNs', 'ATMs', 'SIMs', 'MiCA', 'RegNMS']);
function findProductName(text) {
  PRODUCT_NAME.lastIndex = 0;
  for (const m of String(text ?? '').matchAll(PRODUCT_NAME)) if (!MIXED_CASE_TERMS.has(m[0])) return m[0];
  return null;
}
// FILTER 7.6: the weakness clause restates the answer; vague harm; recommendation; rating; "already".
const ISSUE_ECHO = rx(`^(?:if|where)\\s+(?:the\\s+answer|(?:not|no|unknown)(?=\\s*[,.])|this\\s+is\\s+not|it\\s+is\\s+not|the\\s+owner\\s+(?:cannot|does\\s+not|doesn['’]t))`);
const VAGUE_HARM = rx(`${B}((?:increased|heightened|elevated|greater|additional|more)\\s+risk|may\\s+be\\s+(?:inadequate|insufficient)|risk\\s+(?:may|could|would)\\s+(?:increase|rise)|(?:faces?|suffers?|incurs?)\\s+(?:(?:significant|serious|material|greater|potential|some|considerable)\\s+)?(?:exposure|problems|issues|consequences|impacts?)|there\\s+(?:could|may|might|would|will)\\s+be\\s+(?:(?:significant|serious|some)\\s+)?(?:problems|issues|consequences|impacts?))${E}`);
const RECOMMEND = rx(`${B}(should|must|needs?\\s+to|ought\\s+to|is\\s+required\\s+to|recommend\\w*|ensure)${E}`);
const LIKELIHOOD = rx(`${B}((?:high|low|elevated|significant|material)\\s+(?:likelihood|severity)|high[- ]risk|low[- ]risk|(?:is|are)\\s+(?:highly\\s+)?(?:likely|probable)|severe|(?:significant|serious|major|considerable)\\s+(?:exposure|risk|impact|harm|damage))${E}`);
const ASSERTS_ALREADY = rx(`${B}(?:(?:is|are|has|have|was|were)\\s+already|already\\s+(?:compromised|breached|exposed|affected|in\\s+place))${E}`);
// FILTER 7.7.5 (a control name such as "transaction monitoring" is not a fallback phrase).
const RATIONALE_BANNED = rx(`${B}(no\\s+action\\s+(?:needed|required|is\\s+required|necessary)|nothing\\s+to\\s+(?:action|do)|(?:continue|keep)\\s+(?:to\\s+)?monitor\\w*|monitor(?:ing)?\\s+(?:developments|the\\s+situation|closely|for\\s+changes)|close\\s+monitoring|keep\\s+(?:an\\s+eye\\s+on|watching|track)|remain\\s+vigilant|stay\\s+(?:alert|vigilant|informed)|track(?:ing)?\\s+(?:developments|the\\s+situation)|watch\\s+(?:this\\s+space|closely)|for\\s+awareness|for\\s+information|FYI|may\\s+become\\s+relevant|low\\s+risk|not\\s+relevant|if\\s+asked|directionally\\s+important|at\\s+(?:this|the\\s+present)\\s+time|for\\s+now)${E}`);
const ADEQUACY = rx(`${B}(?:is|are)\\s+(?:adequate|sufficient)\\s+(?:for|to)${E}`);
// FILTER 7.8: a registry feed label or a domain is not a publication's common name.
const FEED_LABEL = /[()]|\blisting page\b|GovDelivery|\btopic\b|\bRSS\b|\bAtom feed\b|\s[–—-]\s+\p{Lu}/u;
// A bare host in lower case ("bleepingcomputer.com"); brands written like one ("Risk.net", "Pay.UK") are names.
const DOMAIN_LIKE = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
// FILTER 7.8: omit a source headline that names an institution with a characterisation of its
// controls, exposure, maturity, readiness or remediation (heuristic words).
const HEADLINE_CHARACTERISATION = rx(`${B}(fined|fines|fine\\s+of|penalt(?:y|ies)|lax|weak|inadequate|deficien\\w*|failed\\s+to|failings?|lapses?|negligen\\w*|consent\\s+order|cease[- ]and[- ]desist|ordered\\s+to|sanctioned|reprimand\\w*|exposed\\s+to|vulnerable|behind|immature|mature)${E}`);
/** FILTER.md §2.9 source order after the primary: non-news by authority, then news. */
export const SOURCE_AUTHORITY_ORDER = Object.freeze(['regulator', 'standards_body', 'vendor_threat_research', 'research_analysis', 'industry_trade', 'news']);

const STOP = new Set('that this with from into than then they them their there which while where when have been were will would could should about after before over under more most some such only also each other these those what your does upon onto within without across between because since until being'.split(' '));
const contentWords = (s) => new Set((String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.replace(/(?:ies|es|s)$/, '')));
/** Share of the smaller text's content words found in the other (0-1). */
export function contentOverlap(a, b) {
  const A = contentWords(a);
  const Bw = contentWords(b);
  if (!A.size || !Bw.size) return 0;
  let n = 0;
  for (const w of A) if (Bw.has(w)) n++;
  return n / Math.min(A.size, Bw.size);
}

const ABBREVIATION = /^(?:inc|ltd|co|corp|plc|no|st|mr|mrs|ms|dr|prof|gen|sen|rep|gov|vs|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|approx|est|e\.g|i\.e)$/i;
/** Sentence breaks inside a one-sentence field (abbreviations such as "U.S." and "Inc." are not breaks). */
export function extraSentences(s) {
  let n = 0;
  const re = /([\p{L}\p{N}.]*)([.!?])["”’)]?\s+(?=["“‘(]?\p{Lu})/gu;
  for (const m of String(s ?? '').trim().matchAll(re)) {
    const word = m[1].replace(/\.$/, '');
    if (m[2] === '.' && (/^(?:\p{Lu}\.?)+$/u.test(m[1]) || ABBREVIATION.test(word))) continue;
    n++;
  }
  return n;
}

/**
 * FILTER.md §7 and §2.9 writing rules that can be checked mechanically, as
 * [{ rule, field, message, banned }]. `banned` marks rules FILTER.md states absolutely; the others
 * are heuristics. publish.mjs reports all of them as warnings (SPEC §6 and the hard constraints in
 * lintItemText are the publishing gate); selfcheck.mjs makes the banned ones errors.
 */
export function styleIssues(item) {
  const out = [];
  const add = (rule, field, message, banned = true) => out.push({ rule, field, message, banned });
  for (const { field, text } of generatedTexts(item)) {
    const paste = PASTE_READY.has(field);
    const second = firstMatch(SECOND_PERSON, text);
    if (second) add('FILTER V2', field, `second person ${quote(second)}`);
    if (!paste) {
      const bank = firstMatch(THE_BANK, text);
      if (bank) add('FILTER V3', field, `positioning word ${quote(bank)} (presumes the reader works at a bank)`);
      const posWord = firstMatch(POSITIONING, text);
      if (posWord) add('FILTER V3', field, `positioning word ${quote(posWord)}`);
    }
    // A name the lexicon lacks, before an institution type and an event (named ones are errors in lintItemText).
    if (!findInstitutions(text).length) {
      const named = findNamedInstitutionEvent(text);
      if (named) add('FILTER V4', field, `${quote(named)} may name a financial institution with an event; use the category form ("a crypto exchange's $388m hack")`);
    }
    const hype = firstMatch(HYPE, text);
    if (hype) add('FILTER V9', field, `hype word ${quote(hype)}`);
    const soph = firstMatch(SOPHISTICATED, text);
    if (soph) add('FILTER V9', field, `${quote(soph)} only as a source's own technical label`, false);
    const rel = firstMatch(RELATIVE_DATE, text);
    if (rel) add('FILTER V10', field, `relative date ${quote(rel)}; items persist`);
    const us = firstMatch(AMERICAN_SPELLING, text);
    if (us) add('FILTER V10', field, `American spelling ${quote(us)}; British spelling (organisation, authorise)`, false);
    const cur = firstMatch(CURRENCY_WORDS, text);
    if (cur) add('FILTER V10', field, `currency ${quote(cur)}; write m and bn ($25m, £1.2bn)`);
    if (/\bPRAF\b/.test(text)) add('FILTER V7', field, 'internal acronym "PRAF"; write "risk assessment framework"');
    if (/["“”]/.test(text)) add('FILTER V8', field, 'quotation marks; no direct quotes of source wording', false);
    if (field === 'claim' || field.startsWith('interpretation')) {
      const judged = firstMatch(EVALUATIVE_JUDGMENT, text);
      if (judged) add('FILTER V5', field, `evaluative word about an institution's controls ${quote(judged)}; report only the facts a source states, attributed`);
      const ev = firstMatch(EVALUATIVE, text);
      if (ev) add('FILTER V5', field, `evaluative word about controls ${quote(ev)}; report only what a source states, attributed`, false);
      const lapse = firstMatch(LAPSE, text);
      if (lapse) {
        if (ATTRIBUTION.test(text)) add('FILTER V5', field, `lapse ${quote(lapse)}: only inside a clause attributed to the public source that states it`, false);
        else add('FILTER V5', field, `infers a lapse ${quote(lapse)} from an outcome; report only a lapse a public source states, attributed`);
      }
      const sector = firstMatch(SECTOR_POSITION, text) ?? firstMatch(SECTOR_PHRASE, text);
      if (sector) {
        if (ATTRIBUTION.test(text)) {
          if (field !== 'claim') add('FILTER V5', field, `sector-level statement ${quote(sector)}: only from a public source with a disclosed method, attributed`, false);
        } else add('FILTER V5', field, `states a sector-level position ${quote(sector)} without attribution`);
      }
    }
    if (field.startsWith('interpretation')) {
      const back = findBackReference(text);
      if (back) add('FILTER V5', field, `${quote(back)} refers back to an institution in the story; state only facts a source reports about the event, never its controls or exposure`, false);
    }
    if (field !== 'claim') {
      const adequacy = firstMatch(ADEQUACY, text);
      if (adequacy) add('FILTER V5', field, `${quote(adequacy)} reads as an adequacy judgment; describe expectations and facts`, false);
    }
    if (paste) {
      // A rationale describes the development (AO3), so only the question and the issue statement
      // must avoid referring to it; none of the three refers to the reader's own supervisor.
      const asks = field !== 'awareness_rationale';
      const own = firstMatch(OWN_SUPERVISOR, text) ?? (asks ? findEventReference(text) ?? firstMatch(VICTIM_REF, text) : null);
      if (own) add('FILTER 7.5', field, `only makes sense at one institution ${quote(own)}: never refer to the development, its date or its victim, or to the reader's own supervisor, finding or weakness; keep it generic`);
      else if (asks) {
        const generic = firstMatch(EVENT_GENERIC, text);
        if (generic) add('FILTER 7.5', field, `${quote(generic)} may refer to one institution's event; keep it generic ("after an incident")`, false);
      }
    }
  }

  const c = item?.claim;
  if (typeof c === 'string') {
    if (!/\.$/.test(c.trim())) add('FILTER 7.2', 'claim', 'one sentence ending with a full stop');
    const teaser = CLAIM_TEASER.exec(c);
    if (teaser) add('FILTER 7.2', 'claim', `headline or teaser construction ${quote(teaser[0].trim() || ':')}; assert the fact`);
    const hedge = firstMatch(CLAIM_HEDGE, c);
    if (hedge && !ATTRIBUTION.test(c)) add('FILTER 7.2', 'claim', `unattributed hedge ${quote(hedge)}`, false);
    if (extraSentences(c)) add('FILTER 7.2', 'claim', 'more than one sentence', false);
    // Heuristic scope: a single primary document (a provider's status page or post-incident
    // report, a vendor study, an authority's or standard setter's text) is its issuer's own account,
    // which the claim must not present as settled fact. A single news or trade source is that
    // publication's own reporting and is left to the agent.
    const only = Array.isArray(item?.sources) && item.sources.length === 1 ? item.sources[0] : null;
    const onlyClass = only ? only.source_class ?? item.source_class : null;
    if (only && PRIMARY_DOCUMENT_CLASSES.includes(onlyClass) && !CLAIM_ATTRIBUTION.test(c)
      && !(onlyClass === 'regulator' && INSTRUMENT_ATTRIBUTION.test(c))) {
      add('FILTER 7.2', 'claim', 'rests on one primary document (its issuer\'s own account) with no attribution verb; attribute it ("..., the provider says")', false);
    }
  }

  if (Array.isArray(item?.interpretation)) {
    item.interpretation.forEach((x, i) => {
      if (typeof x?.text !== 'string') return;
      const f = `interpretation[${i}].text`;
      const n = wordCount(x.text);
      if (n < 12) add('FILTER 7.4', f, `${n} words; each entry has at least 12 words stating an implication`);
      const adv = firstMatch(ADVICE, x.text);
      if (adv) add('FILTER 7.4', f, `advice ${quote(adv)}; state the implication`, false);
      const dated = MONTH_EVENT.exec(x.text);
      if (dated && !(typeof c === 'string' && c.includes(dated[1])) && !x.text.slice(0, dated.index).includes(dated[1])) {
        add('FILTER 7.4', f, `${quote(dated[0])} relies on an event the claim does not introduce; say what it was, who acted and when`, false);
      }
      if (typeof c === 'string' && contentOverlap(c, x.text) >= 0.7) add('FILTER 7.4', f, `restates the claim (${Math.round(contentOverlap(c, x.text) * 100)}% shared content words)`, false);
      item.interpretation.slice(0, i).forEach((y, k) => {
        if (typeof y?.text === 'string' && contentOverlap(y.text, x.text) >= 0.6) add('FILTER 7.4', f, `repeats interpretation[${k}] (${Math.round(contentOverlap(y.text, x.text) * 100)}% shared content words)`, false);
      });
    });
  }
  if (Array.isArray(item?.domains) && Array.isArray(item?.interpretation)) {
    const order = item.interpretation.map((x) => x?.domain).filter((d) => item.domains.includes(d));
    if (order.join() !== item.domains.filter((d) => order.includes(d)).join()) add('FILTER 7.4', 'interpretation', 'tagged entries should follow the order of domains');
  }
  if (Array.isArray(item?.domains) && item.domains.length > 3) add('FILTER 7.3', 'domains', `${item.domains.length} domains; a 4th needs a distinct implication in interpretation`, false);

  const q = item?.validation_question;
  if (typeof q === 'string') {
    if ((q.match(/\?/g) ?? []).length > 1) add('FILTER 7.5', 'validation_question', 'more than one question mark; exactly one question');
    if ((q.match(/\band\b/gi) ?? []).length > 1) add('FILTER 7.5', 'validation_question', 'more than one "and"; one question, not a checklist');
    const aux = (q.match(CLAUSE_AUX) ?? []).length;
    if (aux >= 3) add('FILTER 7.5', 'validation_question', `${aux} yes/no clauses; a checklist, not one question`);
    else if (aux === 2) add('FILTER 7.5', 'validation_question', 'second yes/no clause; attach evidence or a date, not a second question', false);
    const deictic = firstMatch(DEICTIC, q);
    if (deictic) add('FILTER 7.5', 'validation_question', `not paste-ready: ${quote(deictic)} points at the item; name the thing itself`);
    const open = OPEN_Q.exec(q);
    if (open) add('FILTER 7.5', 'validation_question', `open or leading ${quote(open[0])}; ask for yes, no, unknown, a number or a list`);
    const unresolvable = firstMatch(UNRESOLVABLE_Q, q);
    if (unresolvable) add('FILTER 7.5', 'validation_question', `${quote(unresolvable)} cannot be resolved; ask whether a named control, metric or framework entry exists or works`);
    const product = findProductName(q);
    if (product) add('FILTER 7.5', 'validation_question', `${quote(product)} looks like a vendor product; name the class of system unless the item is about that product`, false);
    const version = item?.mechanism === 'candidate_issue' ? VERSION_CHECK.exec(q) : null;
    if (version) add('FILTER 7.5', 'validation_question', `${quote(version[0])}: a check that a fixed version is installed is patch management (C6), not a candidate_issue control question`, false);
  }

  const s = item?.candidate_issue_statement;
  if (typeof s === 'string') {
    if (ISSUE_ECHO.test(s)) add('FILTER 7.6', 'candidate_issue_statement', 'the conditional clause restates the answer; name the control and its failure mode');
    const deictic = firstMatch(DEICTIC, s);
    if (deictic) add('FILTER 7.6', 'candidate_issue_statement', `not paste-ready: ${quote(deictic)} points at the item; name the thing itself`);
    const vague = firstMatch(VAGUE_HARM, s);
    if (vague) add('FILTER 7.6', 'candidate_issue_statement', `vague consequence ${quote(vague)}; name the harm`);
    if (s.includes(',') && wordCount(s.slice(s.indexOf(',') + 1)) < 5) add('FILTER 7.6', 'candidate_issue_statement', 'consequence clause under 5 words; name the harm and what it happens to');
    const rec = firstMatch(RECOMMEND, s);
    if (rec) add('FILTER 7.6', 'candidate_issue_statement', `weakness and consequence only, no recommendation (${quote(rec)})`, false);
    const already = firstMatch(ASSERTS_ALREADY, s);
    if (already) add('FILTER 7.6', 'candidate_issue_statement', `${quote(already)} asserts the weakness or harm exists; keep it conditional`, false);
    const rating = firstMatch(LIKELIHOOD, s);
    if (rating) add('FILTER 7.6', 'candidate_issue_statement', `likelihood or severity rating ${quote(rating)}`, false);
    if (extraSentences(s)) add('FILTER 7.6', 'candidate_issue_statement', 'more than one sentence', false);
  }

  const r = item?.awareness_rationale;
  if (typeof r === 'string') {
    const banned = firstMatch(RATIONALE_BANNED, r);
    if (banned) add('FILTER 7.7', 'awareness_rationale', `banned fallback phrase ${quote(banned)}`);
  }

  if (Array.isArray(item?.sources) && item.sources.length) {
    item.sources.forEach((src, i) => {
      if (!isObj(src)) return;
      const f = `sources[${i}]`;
      if (src.source_class === undefined) add('FILTER 7.8', `${f}.source_class`, 'always set it');
      if (isNonEmptyString(src.publication)) {
        if (FEED_LABEL.test(src.publication)) add('FILTER 7.8', `${f}.publication`, `${quote(src.publication)} looks like a registry feed label; use the outlet's or issuer's common name`, false);
        else if (DOMAIN_LIKE.test(src.publication.trim())) add('FILTER 7.8', `${f}.publication`, `${quote(src.publication)} is a domain; use the outlet's or issuer's common name`, false);
      }
      if (typeof src.url === 'string') {
        let u = null;
        try { u = new URL(src.url); } catch { u = null; }
        if (u && /\/\//.test(u.pathname)) add('FILTER 7.8', `${f}.url`, '"//" inside the path; cite the canonical URL (it matches the candidate after normalisation)');
        const tracking = u ? trackingParams(src.url) : [];
        if (tracking.length) add('FILTER 7.8', `${f}.url`, `tracking parameter ${tracking.map(quote).join(', ')}; cite the clean URL (it matches the candidate after normalisation)`);
        if (u && /(?:^|\.)nvd\.nist\.gov$/i.test(u.hostname) && isNonEmptyString(src.publication) && !/NVD|National Vulnerability Database/i.test(src.publication)) {
          add('FILTER 7.8', `${f}.publication`, `${quote(src.publication)} but the URL is an NVD record; the publication is "NIST National Vulnerability Database"`);
        }
      }
      if (isNonEmptyString(src.headline)) {
        const suffix = /\s(?:\||[–—-])\s([^|–—]{2,60})$/u.exec(src.headline);
        const squash = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        if (suffix && isNonEmptyString(src.publication) && squash(suffix[1]).length >= 2 && (squash(src.publication).includes(squash(suffix[1])) || squash(suffix[1]).includes(squash(src.publication)))) {
          add('FILTER 7.8', `${f}.headline`, `ends with the site name ${quote(suffix[1].trim())}; drop the suffix`, false);
        }
        if (findInstitutions(src.headline).length && HEADLINE_CHARACTERISATION.test(src.headline)) {
          add('FILTER 7.8', `${f}.headline`, 'names a financial institution together with a characterisation of its position; omit the headline (publication and url suffice)');
        }
      }
    });
    const first = item.sources[0];
    if (isObj(first) && first.source_class !== undefined && item.source_class !== undefined && first.source_class !== item.source_class) {
      add('FILTER 7.9', 'source_class', `${item.source_class} differs from sources[0].source_class ${first.source_class}`);
    }
    // §2.9 order after the primary source: non-news by authority, then news.
    const rest = item.sources.slice(1).map((x, k) => ({ k: k + 1, cls: isObj(x) ? x.source_class ?? null : null })).filter((x) => SOURCE_AUTHORITY_ORDER.includes(x.cls));
    for (let k = 1; k < rest.length; k++) {
      const a = SOURCE_AUTHORITY_ORDER.indexOf(rest[k - 1].cls);
      const b = SOURCE_AUTHORITY_ORDER.indexOf(rest[k].cls);
      if (b < a) {
        add('FILTER 2.9', `sources[${rest[k].k}]`, `${rest[k].cls} after ${rest[k - 1].cls}; after the primary source, list non-news sources by authority (${SOURCE_AUTHORITY_ORDER.slice(0, -1).join(', ')}), then news`);
        break;
      }
    }
  }
  return out;
}

/** styleIssues as Issues: all warnings, or (strict) banned rules as errors. */
export function styleWarnings(item, at = 'item', { strict = false } = {}) {
  const v = new Issues();
  for (const s of styleIssues(item)) {
    const msg = `${s.field}: ${s.message} (${s.rule})`;
    if (strict && s.banned) v.error(at, msg);
    else v.warn(at, msg);
  }
  return v.result();
}

// ---------------------------------------------------------------- item schema (SPEC §3.2)

const DRAFT_FORBIDDEN = ['id', 'timestamp', 'backfilled'];

/**
 * Validate one item: schema (always errors) and the SPEC §6 text lint.
 * @param {object} item
 * @param {{at?: string, mode?: 'archive'|'draft', lint?: 'error'|'warn'|'off', style?: boolean}} opts
 *   mode: draft = decisions.json item (no id/timestamp/backfilled; has candidate_ids).
 *   lint: severity of the text lint. Published items are frozen (append-only), so a lint rule
 *   tightened after publication must not make them invalid: callers lint new items as errors and
 *   existing ones as warnings ('warn') or not at all ('off').
 *   style: include the FILTER.md §7 style warnings (default true; only with lint 'error').
 *   claimsMayNameInstitutions: thresholds.json writing.claims_may_name_institutions (default false,
 *   the launch value): whether an institution named in the claim is an error or a warning.
 */
export function validateItem(item, { at = 'item', mode = 'archive', lint = 'error', style = true, claimsMayNameInstitutions = false } = {}) {
  const v = new Issues();
  if (!isObj(item)) {
    v.error(at, 'must be an object');
    return v.result();
  }
  const allowed = new Set(mode === 'draft' ? [...ITEM_KEYS.filter((k) => !DRAFT_FORBIDDEN.includes(k)), 'candidate_ids'] : ITEM_KEYS);
  for (const k of Object.keys(item)) {
    if (allowed.has(k)) continue;
    if (mode === 'draft' && DRAFT_FORBIDDEN.includes(k)) v.error(at, `${k}: is assigned by publish.mjs; omit it from decisions.json`);
    else v.error(at, `${k}: unknown field (not in the data model)`);
  }

  if (mode === 'archive') {
    if (typeof item.id !== 'string' || !ITEM_ID_RE.test(item.id)) v.error(at, 'id: must match RS-YYMMDD-HHMM-NN');
    else if (item.id.endsWith('-00')) v.error(at, 'id: NN starts at 01');
    if (!isEtIso(item.timestamp)) v.error(at, 'timestamp: must be ISO 8601 with the correct ET offset, e.g. 2026-10-02T14:00:00-04:00');
    if (typeof item.backfilled !== 'boolean') v.error(at, 'backfilled: must be boolean');
    if (typeof item.id === 'string' && ITEM_ID_RE.test(item.id) && isEtIso(item.timestamp)) {
      const p = etParts(item.timestamp);
      const stem = `RS-${String(p.year).slice(2)}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}-${String(p.hour).padStart(2, '0')}${String(p.minute).padStart(2, '0')}`;
      if (!item.id.startsWith(`${stem}-`)) {
        if (item.backfilled === true) v.warn(at, `id: date/time does not match timestamp (expected ${stem}-NN)`);
        else v.error(at, `id: date/time must match the edition slot in timestamp (expected ${stem}-NN)`);
      }
      if (item.backfilled === false && !isSlotIso(item.timestamp)) v.error(at, 'timestamp: live items carry the edition slot time (06:00, 10:00, 14:00 or 18:00 ET)');
    }
  } else {
    if (!Array.isArray(item.candidate_ids) || item.candidate_ids.length === 0) v.error(at, 'candidate_ids: required non-empty array');
    else {
      item.candidate_ids.forEach((c, i) => {
        if (typeof c !== 'string' || !CANDIDATE_ID_RE.test(c)) v.error(at, `candidate_ids[${i}]: must look like c-xxxxxxxxxx`);
      });
      if (new Set(item.candidate_ids).size !== item.candidate_ids.length) v.error(at, 'candidate_ids: duplicates');
    }
  }

  if (!SECTIONS.includes(item.section)) v.error(at, `section: must be one of ${SECTIONS.join(', ')}`);
  if (!isNonEmptyString(item.claim)) v.error(at, 'claim: required non-empty string');
  if (!SOURCE_CLASSES.includes(item.source_class)) v.error(at, `source_class: must be one of ${SOURCE_CLASSES.join(', ')}`);
  if (!MECHANISMS.includes(item.mechanism)) v.error(at, `mechanism: must be exactly one of ${MECHANISMS.join(', ')}`);

  // domains
  if (!Array.isArray(item.domains) || item.domains.length < 1 || item.domains.length > DOMAINS.length) {
    v.error(at, `domains: array of 1-${DOMAINS.length} domains`);
  } else {
    item.domains.forEach((d, i) => {
      if (!DOMAINS.includes(d)) v.error(at, `domains[${i}]: ${quote(d)} is not one of ${DOMAINS.join(', ')}`);
    });
    if (new Set(item.domains).size !== item.domains.length) v.error(at, 'domains: duplicates');
  }

  // interpretation
  if (!Array.isArray(item.interpretation) || item.interpretation.length === 0) {
    v.error(at, 'interpretation: required non-empty array of { domain, text }');
  } else {
    const seen = new Set();
    item.interpretation.forEach((x, i) => {
      const a = `interpretation[${i}]`;
      if (!isObj(x)) {
        v.error(at, `${a}: must be an object { domain, text }`);
        return;
      }
      for (const k of Object.keys(x)) if (k !== 'domain' && k !== 'text') v.error(at, `${a}.${k}: unknown field`);
      if (!DOMAINS.includes(x.domain)) v.error(at, `${a}.domain: ${quote(x.domain)} is not a domain`);
      else if (seen.has(x.domain)) v.error(at, `${a}.domain: duplicate ${quote(x.domain)}`);
      seen.add(x.domain);
      if (!isNonEmptyString(x.text)) v.error(at, `${a}.text: required non-empty string`);
    });
    if (Array.isArray(item.domains)) {
      for (const d of item.domains) if (!seen.has(d)) v.error(at, `interpretation: missing an entry for tagged domain ${quote(d)}`);
      const tagged = new Set(item.domains);
      const firstExtra = item.interpretation.findIndex((x) => !tagged.has(x?.domain));
      if (firstExtra !== -1 && item.interpretation.slice(firstExtra).some((x) => tagged.has(x?.domain))) {
        v.error(at, 'interpretation: tagged domains must come before any additional domains');
      }
    }
  }

  // mechanism-dependent fields
  const has = (k) => Object.prototype.hasOwnProperty.call(item, k);
  if (item.mechanism === 'awareness_only') {
    if (item.validation_question !== null) v.error(at, 'validation_question: must be null for awareness_only');
    if (item.candidate_issue_statement !== null) v.error(at, 'candidate_issue_statement: must be null for awareness_only');
    if (!isNonEmptyString(item.awareness_rationale)) v.error(at, 'awareness_rationale: required for awareness_only (why no control, metric or framework action follows)');
  } else if (MECHANISMS.includes(item.mechanism)) {
    if (!isNonEmptyString(item.validation_question)) v.error(at, `validation_question: required for ${item.mechanism}`);
    if (!isNonEmptyString(item.candidate_issue_statement)) v.error(at, `candidate_issue_statement: required for ${item.mechanism}`);
    if (has('awareness_rationale') && item.awareness_rationale !== null) v.error(at, 'awareness_rationale: must be null unless mechanism is awareness_only');
  }
  for (const f of ['validation_question', 'candidate_issue_statement', 'awareness_rationale']) {
    if (has(f) && item[f] !== null && typeof item[f] !== 'string') v.error(at, `${f}: must be a string or null`);
  }

  // sources
  if (!Array.isArray(item.sources) || item.sources.length === 0) {
    v.error(at, 'sources: required non-empty array of { publication, url }');
  } else {
    const urls = new Set();
    item.sources.forEach((s, i) => {
      const a = `sources[${i}]`;
      if (!isObj(s)) {
        v.error(at, `${a}: must be an object`);
        return;
      }
      for (const k of Object.keys(s)) if (!SOURCE_KEYS.includes(k)) v.error(at, `${a}.${k}: unknown field`);
      if (!isNonEmptyString(s.publication)) v.error(at, `${a}.publication: required non-empty string`);
      if (!isHttpsUrl(s.url)) v.error(at, `${a}.url: must be an https URL`);
      else {
        const n = normaliseUrl(s.url);
        if (urls.has(n)) v.error(at, `${a}.url: duplicate source URL`);
        urls.add(n);
      }
      if (s.headline !== undefined) {
        if (!isNonEmptyString(s.headline)) v.error(at, `${a}.headline: must be a non-empty string when present`);
        else if (s.headline.length > LIMITS.headlineChars) v.error(at, `${a}.headline: ${s.headline.length} chars (max ${LIMITS.headlineChars}; headline-level reference only)`);
      }
      if (s.published !== undefined && !isIsoDate(s.published)) v.error(at, `${a}.published: must be YYYY-MM-DD`);
      if (s.source_class !== undefined && !SOURCE_CLASSES.includes(s.source_class)) v.error(at, `${a}.source_class: must be one of ${SOURCE_CLASSES.join(', ')}`);
    });
  }

  if (has('update_of') && item.update_of !== null && (typeof item.update_of !== 'string' || !ITEM_ID_RE.test(item.update_of))) {
    v.error(at, 'update_of: must be null or an item id (RS-YYMMDD-HHMM-NN)');
  }

  if (lint === 'error') v.merge(lintItemText(item, at, { style, claimsMayNameInstitutions }));
  else if (lint === 'warn') {
    for (const e of lintItemText(item, at, { style: false, claimsMayNameInstitutions }).errors) v.warn(null, `${e} (lint; published item, not re-checked as an error)`);
  }
  return v.result();
}

const itemAt = (prefix, i, item) => `${prefix}[${i}]${item && typeof item.id === 'string' ? ` (${item.id})` : ''}`;

// ---------------------------------------------------------------- archive (SPEC §3.1)

/**
 * archive.json: schema, ids, update_of chain, order.
 * @param {{at?: string, lint?: 'error'|'warn'|'off'|((item: object) => 'error'|'warn'|'off')}} opts
 *   lint: text-lint severity for each item (see validateItem); a function decides per item, e.g.
 *   errors for items new since a git ref and warnings for items already published there.
 *   claimsMayNameInstitutions: see validateItem.
 */
export function validateArchive(doc, { at = 'archive', lint = 'error', claimsMayNameInstitutions = false } = {}) {
  const v = new Issues();
  if (!isObj(doc)) {
    v.error(at, 'must be a JSON object { schema_version, items }');
    return v.result();
  }
  if (doc.schema_version !== 1) v.error(at, 'schema_version: must be 1');
  for (const k of Object.keys(doc)) if (k !== 'schema_version' && k !== 'items') v.error(at, `${k}: unknown top-level field`);
  if (!Array.isArray(doc.items)) {
    v.error(at, 'items: must be an array');
    return v.result();
  }
  const index = new Map();
  let lastLive = null;
  doc.items.forEach((item, i) => {
    const a = itemAt('items', i, item);
    v.merge(validateItem(item, { at: a, mode: 'archive', lint: typeof lint === 'function' ? lint(item) : lint, claimsMayNameInstitutions }));
    if (!isObj(item)) return;
    if (typeof item.id === 'string') {
      if (index.has(item.id)) v.error(a, `id: duplicate of items[${index.get(item.id)}]`);
      else index.set(item.id, i);
    }
    if (item.update_of != null && typeof item.update_of === 'string') {
      const j = index.get(item.update_of);
      if (item.update_of === item.id) v.error(a, 'update_of: an item cannot update itself');
      else if (j === undefined) v.error(a, `update_of: ${item.update_of} is not an earlier item in the archive`);
    }
    if (item.backfilled === false && isEtIso(item.timestamp)) {
      if (lastLive && Date.parse(item.timestamp) < Date.parse(lastLive)) v.warn(a, 'timestamp: earlier than the previous live item (archive is append-ordered)');
      lastLive = item.timestamp;
    }
  });
  return v.result();
}

// ---------------------------------------------------------------- runs (SPEC §3.3)

const RUN_KEYS = ['run_id', 'slot', 'started_at', 'finished_at', 'status', 'items', 'threshold_level', 'funnel',
  'stage2_by_section', 'mechanism_distribution', 'notes'];

export function validateRun(run, { at = 'run' } = {}) {
  const v = new Issues();
  if (!isObj(run)) {
    v.error(at, 'must be an object');
    return v.result();
  }
  for (const k of Object.keys(run)) if (!RUN_KEYS.includes(k)) v.error(at, `${k}: unknown field`);
  const slot = parseRunId(run.run_id);
  if (!slot) v.error(at, 'run_id: must be YYYY-MM-DD-HHMM at an edition slot (0600, 1000, 1400, 1800)');
  if (!isSlotIso(run.slot)) v.error(at, 'slot: must be an ET slot timestamp, e.g. 2026-10-02T14:00:00-04:00');
  else if (slot && slot.iso !== run.slot) v.error(at, `slot: ${run.slot} does not match run_id (expected ${slot.iso})`);
  if (!isEtIso(run.started_at)) v.error(at, 'started_at: must be ISO 8601 with the ET offset');
  if (!isEtIso(run.finished_at)) v.error(at, 'finished_at: must be ISO 8601 with the ET offset');
  if (isEtIso(run.started_at) && isEtIso(run.finished_at) && Date.parse(run.finished_at) < Date.parse(run.started_at)) v.error(at, 'finished_at: before started_at');
  if (isEtIso(run.started_at) && isSlotIso(run.slot) && Date.parse(run.started_at) < Date.parse(run.slot)) v.warn(at, 'started_at: before the slot time');
  if (!RUN_STATUSES.includes(run.status)) v.error(at, `status: must be one of ${RUN_STATUSES.join(', ')}`);
  if (!Array.isArray(run.items)) v.error(at, 'items: must be an array of item ids');
  else {
    run.items.forEach((id, i) => {
      if (typeof id !== 'string' || !ITEM_ID_RE.test(id)) v.error(at, `items[${i}]: not an item id`);
      else if (slot && !id.startsWith(`${slot.id_stem}-`)) v.error(at, `items[${i}]: ${id} does not belong to slot ${slot.id_stem}`);
    });
    if (new Set(run.items).size !== run.items.length) v.error(at, 'items: duplicates');
    if (run.status === 'published' && run.items.length === 0) v.error(at, 'status: published runs list at least one item');
    if ((run.status === 'silent' || run.status === 'failed') && run.items.length) v.error(at, `status: ${run.status} runs list no items`);
  }
  if (!isNonEmptyString(run.threshold_level) || !/^[a-z_]{1,20}$/.test(run.threshold_level)) v.error(at, 'threshold_level: required lowercase label, e.g. "high"');
  else if (!THRESHOLD_LEVELS.includes(run.threshold_level)) v.warn(at, `threshold_level: ${quote(run.threshold_level)} is not one of ${THRESHOLD_LEVELS.join(', ')}`);

  if (!isObj(run.funnel)) v.error(at, 'funnel: required object');
  else {
    for (const k of Object.keys(run.funnel)) if (!FUNNEL_KEYS.includes(k)) v.error(at, `funnel.${k}: unknown field`);
    for (const k of FUNNEL_KEYS) if (!isInt(run.funnel[k])) v.error(at, `funnel.${k}: required non-negative integer`);
    const f = run.funnel;
    if (FUNNEL_KEYS.every((k) => isInt(f[k]))) {
      if (Array.isArray(run.items) && f.published !== run.items.length) v.error(at, `funnel.published: ${f.published} but ${run.items.length} item id(s) listed`);
      if (f.unseen > f.in_window) v.warn(at, 'funnel: unseen > in_window');
      if (f.stage1_pass > f.unseen) v.warn(at, 'funnel: stage1_pass > unseen');
      if (f.stage2_pass > f.stage1_pass) v.warn(at, 'funnel: stage2_pass > stage1_pass');
      if (f.published > f.stage2_pass) v.warn(at, 'funnel: published > stage2_pass');
    }
  }
  if (!isObj(run.stage2_by_section)) v.error(at, 'stage2_by_section: required object');
  else {
    for (const k of Object.keys(run.stage2_by_section)) if (!SECTIONS.includes(k)) v.error(at, `stage2_by_section.${k}: unknown section`);
    for (const s of SECTIONS) {
      const x = run.stage2_by_section[s];
      if (!isObj(x) || !isInt(x.tested) || !isInt(x.passed)) v.error(at, `stage2_by_section.${s}: required { tested, passed } non-negative integers`);
      else if (x.passed > x.tested) v.error(at, `stage2_by_section.${s}: passed > tested`);
    }
  }
  if (!isObj(run.mechanism_distribution)) v.error(at, 'mechanism_distribution: required object');
  else {
    for (const k of Object.keys(run.mechanism_distribution)) if (!MECHANISMS.includes(k)) v.error(at, `mechanism_distribution.${k}: unknown mechanism`);
    let sum = 0;
    for (const m of MECHANISMS) {
      if (!isInt(run.mechanism_distribution[m])) v.error(at, `mechanism_distribution.${m}: required non-negative integer`);
      else sum += run.mechanism_distribution[m];
    }
    if (Array.isArray(run.items) && sum !== run.items.length) v.error(at, `mechanism_distribution: sums to ${sum} but ${run.items.length} item(s) published`);
  }
  if (run.notes !== undefined && run.notes !== null) {
    if (typeof run.notes !== 'string') v.error(at, 'notes: must be a string');
    else if (run.notes.length > LIMITS.notesChars) v.error(at, `notes: ${run.notes.length} chars (max ${LIMITS.notesChars})`);
  }
  return v.result();
}

/** runs.json, cross-checked against the archive when given. */
export function validateRuns(doc, archiveDoc = null, { at = 'runs' } = {}) {
  const v = new Issues();
  if (!isObj(doc)) {
    v.error(at, 'must be a JSON object { schema_version, runs }');
    return v.result();
  }
  if (doc.schema_version !== 1) v.error(at, 'schema_version: must be 1');
  for (const k of Object.keys(doc)) if (k !== 'schema_version' && k !== 'runs') v.error(at, `${k}: unknown top-level field`);
  if (!Array.isArray(doc.runs)) {
    v.error(at, 'runs: must be an array');
    return v.result();
  }
  const seen = new Map();
  let prevSlot = null;
  doc.runs.forEach((run, i) => {
    const a = `runs[${i}]${isObj(run) && typeof run.run_id === 'string' ? ` (${run.run_id})` : ''}`;
    v.merge(validateRun(run, { at: a }));
    if (!isObj(run)) return;
    if (typeof run.run_id === 'string') {
      if (seen.has(run.run_id)) v.error(a, `run_id: duplicate of runs[${seen.get(run.run_id)}] (one record per slot)`);
      else seen.set(run.run_id, i);
    }
    const s = parseRunId(run.run_id);
    if (s) {
      if (prevSlot && s.instant <= prevSlot) v.error(a, 'run_id: runs must be appended in slot order');
      prevSlot = s.instant;
    }
  });

  if (archiveDoc && isObj(archiveDoc) && Array.isArray(archiveDoc.items)) {
    const items = new Map();
    archiveDoc.items.forEach((it) => isObj(it) && typeof it.id === 'string' && items.set(it.id, it));
    const claimed = new Map();
    doc.runs.forEach((run, i) => {
      if (!isObj(run) || !Array.isArray(run.items)) return;
      const a = `runs[${i}] (${run.run_id})`;
      const mech = Object.fromEntries(MECHANISMS.map((m) => [m, 0]));
      for (const id of run.items) {
        const it = items.get(id);
        if (!it) {
          v.error(a, `items: ${id} is not in the archive`);
          continue;
        }
        if (claimed.has(id)) v.error(a, `items: ${id} is already listed by ${claimed.get(id)}`);
        claimed.set(id, run.run_id);
        if (it.timestamp !== run.slot) v.error(a, `items: ${id} timestamp ${it.timestamp} does not match run slot ${run.slot}`);
        if (it.backfilled === true) v.error(a, `items: ${id} is backfilled; backfilled items are never part of an edition`);
        if (MECHANISMS.includes(it.mechanism)) mech[it.mechanism]++;
      }
      if (isObj(run.mechanism_distribution)) {
        for (const m of MECHANISMS) {
          if (isInt(run.mechanism_distribution[m]) && run.mechanism_distribution[m] !== mech[m]) {
            v.error(a, `mechanism_distribution.${m}: ${run.mechanism_distribution[m]} but the listed items have ${mech[m]}`);
          }
        }
      }
    });
    for (const [id, it] of items) {
      if (it.backfilled === false && !claimed.has(id)) v.error('archive', `${id}: live item not listed by any run record`);
    }
  }
  return v.result();
}

// ---------------------------------------------------------------- seen.json (SPEC §3.4)

export function validateSeen(doc, { at = 'seen' } = {}) {
  const v = new Issues();
  if (!isObj(doc)) {
    v.error(at, 'must be a JSON object { schema_version, urls }');
    return v.result();
  }
  if (doc.schema_version !== 1) v.error(at, 'schema_version: must be 1');
  if (!isObj(doc.urls)) {
    v.error(at, 'urls: must be an object keyed by normalised URL');
    return v.result();
  }
  for (const [url, e] of Object.entries(doc.urls)) {
    const a = `urls[${quote(url)}]`;
    if (normaliseUrl(url) !== url) v.warn(at, `${a}: key is not a normalised URL`);
    if (!isObj(e)) {
      v.error(at, `${a}: must be an object`);
      continue;
    }
    if (Number.isNaN(Date.parse(e.first_seen))) v.error(at, `${a}.first_seen: must be an ISO timestamp`);
    if (!parseRunId(e.run_id)) v.error(at, `${a}.run_id: not a run id`);
    if (!SEEN_VERDICTS.includes(e.verdict)) v.error(at, `${a}.verdict: must be one of ${SEEN_VERDICTS.join(', ')}`);
    if (e.item_id !== null && (typeof e.item_id !== 'string' || !ITEM_ID_RE.test(e.item_id))) v.error(at, `${a}.item_id: must be null or an item id`);
  }
  return v.result();
}

// ---------------------------------------------------------------- verbatim guard (publish-time)

/**
 * Words for the verbatim guard, normalised on both sides so trivial edits do not hide a copy:
 * diacritics removed (Société = Societe), dotted acronyms joined (U.S. = US), '&' = 'and',
 * hyphenated compounds joined (cyber-attack = cyberattack), thousands separators dropped (1,000 = 1000).
 */
export function verbatimWords(s) {
  let t = String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[‘’ʼ]/g, "'");
  t = t.replace(/(?<![\p{L}\p{N}])(?:\p{L}\.){2,}/gu, (m) => m.replace(/\./g, ''));
  t = t.replace(/&/g, ' and ');
  t = t.replace(/(\p{L})[-‐‑](?=\p{L})/gu, '$1');
  t = t.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  return t.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function buildNgramSet(texts, n = LIMITS.verbatimWords) {
  const set = new Set();
  for (const t of texts) {
    const w = verbatimWords(t);
    for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(' '));
  }
  return set;
}

/**
 * FILTER.md §10 preface: live items never reuse the worked examples' wording. The n-grams of §10
 * (decision table and model items), minus those of the mechanism question shapes of §7.5 rule 6
 * and the praf_coverage issue opener, which every item of that mechanism may share. An empty set
 * when the text has no §10.
 */
const MODEL_SHAPE_OPENERS = Object.freeze([
  'If the risk assessment framework does not represent the risk',
  'Where the risk assessment framework does not represent the risk',
]);
export function modelWordingNgrams(filterText, n = LIMITS.verbatimWords) {
  const t = String(filterText ?? '');
  const from = t.indexOf('\n## 10.');
  if (from === -1) return new Set();
  const to = t.indexOf('\n## 11.', from);
  const set = buildNgramSet([t.slice(from, to === -1 ? undefined : to)], n);
  const shapes = t.match(/^\s*- (?:candidate_issue|kri_kpi|praf_coverage): ".*"$/gm) ?? [];
  for (const g of buildNgramSet([...shapes, ...MODEL_SHAPE_OPENERS], n)) set.delete(g);
  return set;
}

/** First run of >= n consecutive words of `text` found in the n-gram set, or null. */
export function findVerbatim(text, ngramSet, n = LIMITS.verbatimWords) {
  const w = verbatimWords(text);
  for (let i = 0; i + n <= w.length; i++) {
    const g = w.slice(i, i + n).join(' ');
    if (ngramSet.has(g)) return g;
  }
  return null;
}

// ---------------------------------------------------------------- decisions.json (SPEC §5 step 4)

const DECISION_KEYS = ['run_id', 'threshold_level', 'judgments', 'items', 'notes'];
const JUDGMENT_KEYS = ['candidate_id', 'section_tested', 'verdict', 'reason_code', 'reason', 'dedup', 'match_id', 'draft_index'];
const PUBLISHED_DEDUP = ['new', 'material_update', 'cluster_merged'];

const SECTION_OF_PREFIX = { EV: 'executive_visibility', CS: 'capability_shift', RT: 'regulatory_trajectory' };

/**
 * Reason codes from FILTER.md §8.2 (the closed list): Map code -> 'pass' | 'drop' | null.
 * Returns null when the file is missing or the table cannot be found.
 */
export function parseReasonCodes(filterText) {
  if (typeof filterText !== 'string') return null;
  const codes = new Map();
  for (const m of filterText.matchAll(/^\|\s*`([A-Z][A-Z0-9_]{1,47})`\s*\|\s*(pass|drop)\s*\|/gm)) codes.set(m[1], m[2]);
  return codes.size >= 10 ? codes : null;
}

/**
 * The FILTER.md §8.2 Element column: Map code -> the first element ID it names ("G7", "E2", "C6",
 * "R3b", "R3f"), or null where it names a procedure ("§6.2", "§5.3, §5.7", "RUNBOOK"). Null when
 * the table cannot be found.
 */
export function parseReasonCodeElements(filterText) {
  if (typeof filterText !== 'string') return null;
  const out = new Map();
  for (const m of filterText.matchAll(/^\|\s*`([A-Z][A-Z0-9_]{1,47})`\s*\|\s*(?:pass|drop)\s*\|[^|\n]*\|\s*([^|\n]*?)\s*\|/gm)) {
    const el = /^([A-Z]\d+[a-z]?)(?![\p{L}\p{N}])/u.exec(m[2]);
    out.set(m[1], el ? el[1] : null);
  }
  return out.size >= 10 ? out : null;
}

/**
 * FILTER.md §4.3 and §8.4: codes that may carry NEAR only with this knob (a knob-controlled gate,
 * M2 for a resurfacing story, the C6 loosening step, a standard setter while rt_standard_setters
 * is none, a formal instrument first issued just outside max_event_age_days). Every other gate
 * and dedup code is never NEAR. GL_FORMAL_RULE (G5) is recorded only while formal_instrument_scope
 * is "none" (FORMAL_INSTRUMENT_SCOPES), so its NEAR is the step to "new_in_regulatory_trajectory";
 * RT_INSTRUMENT_NOT_NEW (R3f) is never NEAR for a reminder, restatement, correction, extension or
 * re-publication, only as "NEAR R3f/max_event_age_days" (FILTER.md §4.4.5, §8.3).
 */
export const NEAR_KNOB_REQUIRED = Object.freeze({
  GL_FORMAL_RULE: { element: 'G5', knob: 'formal_instrument_scope' },
  GL_STALE: { element: 'G7', knob: 'max_event_age_days' },
  GL_UNVERIFIABLE: { element: 'G8', knob: 'unnamed_source_reporting' },
  GL_RESEARCH_EXCLUDED: { element: 'G9', knob: 'research_require_sample' },
  DD_SAME_STORY: { element: 'M2', knob: 'm2_min_scope_factor' },
  CS_ROUTINE_VULN: { element: 'C6', knob: 'cs_routine_vuln_exceptions' },
  RT_JURISDICTION: { element: 'R2', knob: 'rt_standard_setters' },
  RT_INSTRUMENT_NOT_NEW: { element: 'R3f', knob: 'max_event_age_days' },
});

/**
 * thresholds.json formal_instrument_scope (owner decision 2026-10-03), tightest first:
 *   none                          G5 drops every formal instrument and exam notice (GL_FORMAL_RULE);
 *   new_in_regulatory_trajectory  launch: a newly issued one is tested in RT (RT_PASS_FORMAL_RULE,
 *                                 RT_PASS_EXAM_NOTICE; RT_INSTRUMENT_NOT_NEW for a reminder,
 *                                 restatement, correction, extension or re-publication);
 *   new_any_section               it may also be tested under EV or CS on its facts.
 * gate: GL_FORMAL_RULE is the code for a formal instrument; rt: the RT formal-instrument codes apply.
 */
export const FORMAL_INSTRUMENT_SCOPES = Object.freeze({
  none: Object.freeze({ gate: true, rt: false }),
  new_in_regulatory_trajectory: Object.freeze({ gate: false, rt: true }),
  new_any_section: Object.freeze({ gate: false, rt: true }),
});

/** Codes for a formal instrument or exam notice tested in RT (FILTER.md §8.2). */
export const RT_FORMAL_INSTRUMENT_CODES = Object.freeze(['RT_PASS_FORMAL_RULE', 'RT_PASS_EXAM_NOTICE', 'RT_INSTRUMENT_NOT_NEW']);

/**
 * A judgment's reason code against formal_instrument_scope: a message, or null when they agree or
 * the scope is unknown. GL_FORMAL_RULE only at "none"; the RT formal-instrument codes never at "none".
 */
export function formalScopeIssue(code, scope) {
  const s = Object.hasOwn(FORMAL_INSTRUMENT_SCOPES, String(scope)) ? FORMAL_INSTRUMENT_SCOPES[scope] : null;
  if (!s || typeof code !== 'string') return null;
  if (code === 'GL_FORMAL_RULE' && !s.gate) {
    return `GL_FORMAL_RULE is recorded only while formal_instrument_scope is "none" (now "${scope}"); a formal rule or exam notice, or a notice about one, takes the formal-instrument path in regulatory_trajectory (R1, R1f, R2, R3f, R4f, R5; FILTER 4.4.5)`;
  }
  if (RT_FORMAL_INSTRUMENT_CODES.includes(code) && !s.rt) {
    return `${code} applies only while formal_instrument_scope is not "none" (now "${scope}": a formal rule or exam notice drops at G5 as GL_FORMAL_RULE)`;
  }
  return null;
}

/** Whether a thresholds.json knob's `element` text covers element ID `el` ("E2a" covers E2 and E2a). */
function knobCovers(knobElement, el) {
  const base = String(el).replace(/[a-z]$/, '');
  return new RegExp(`(?<![A-Za-z0-9])${base}(?![0-9])`).test(String(knobElement ?? ''));
}

/**
 * Validate decisions.json against this run's candidates and stage-1 survivors, SPEC §5/§6, and
 * the judgment invariants of FILTER.md §8.1-§8.4 (pass iff a *_PASS_ code; code prefix matches
 * section_tested; gate codes have no section; DD_ codes are same_story_dropped against a published
 * item; [M#] iff material_update; cluster members mirror their lead; new has no match; draft_index
 * iff pass; reason one line, <= 200 chars for drops and <= 400 for passes, no first person).
 *
 * Provenance: every item source is the URL of a candidate in the item's candidate_ids. Those are
 * the item's stage-1 survivors (each with a pass judgment pointing at the item), plus optionally
 * (a) extra sources the agent found by search and registered with add-manual.mjs --extra
 * (`extra: true`, never judged) and (b) other collected candidates that were not survivors (seen
 * or dropped at stage 1; warning). A URL that is already a source of a published item may be listed
 * again only by a material update of that item's story (FILTER.md §5.3).
 *
 * Sources (FILTER.md §2.4, §2.7.2, §2.9, §7.8), errors: an aggregator, cache, archive, AMP,
 * mailing-list wrapper, shortener, redirect or social URL; a paywalled sources[0] while a
 * non-paywalled source is listed (NP5); a headline on a source whose candidate headline was
 * composed by the collector (`headline_composed`, e.g. a CISA KEV entry).
 * @param {object} decisions
 * Replay (candidates.json window.replay, set by fetch.mjs --now): a source published after the
 * window closed is a warning, because a replayed slot could not have cited it (FILTER.md
 * §2.7.5(e)); live runs cite what existed when they ran.
 * @param {{runId: string, candidates: object[], survivorIds: string[], archiveItems: object[], reasonCodes?: Map<string,string>|null, reasonElements?: Map<string,string|null>|null, knobs?: Map<string,{element: string}>|null, style?: boolean, claimsMayNameInstitutions?: boolean, window?: {until?: string, replay?: boolean}|null, filterText?: string|null}} ctx
 *   style: include the FILTER.md §7 style warnings on items and decisionStyleIssues (default
 *   true; selfcheck.mjs applies them itself). claimsMayNameInstitutions: see validateItem.
 *   reasonElements, knobs, filterText: see decisionStyleIssues. window: candidates.json window.
 */
export function validateDecisions(decisions, { runId, candidates = [], survivorIds = [], archiveItems = [], reasonCodes = null, reasonElements = null, knobs = null, style = true, claimsMayNameInstitutions = false, window = null, filterText = null }) {
  const v = new Issues();
  const at = 'decisions';
  if (!isObj(decisions)) {
    v.error(at, 'must be a JSON object');
    return v.result();
  }
  for (const k of Object.keys(decisions)) if (!DECISION_KEYS.includes(k)) v.error(at, `${k}: unknown top-level field`);
  if (decisions.run_id !== runId) v.error(at, `run_id: ${quote(decisions.run_id)} does not match this run (${runId})`);
  if (!isNonEmptyString(decisions.threshold_level) || !/^[a-z_]{1,20}$/.test(decisions.threshold_level)) v.error(at, 'threshold_level: required lowercase label, e.g. "high"');
  else if (!THRESHOLD_LEVELS.includes(decisions.threshold_level)) v.warn(at, `threshold_level: ${quote(decisions.threshold_level)} is not one of ${THRESHOLD_LEVELS.join(', ')}`);
  if (decisions.notes !== undefined && decisions.notes !== null) {
    if (typeof decisions.notes !== 'string') v.error(at, 'notes: must be a string');
    else if (decisions.notes.length > LIMITS.notesChars) v.error(at, `notes: ${decisions.notes.length} chars (max ${LIMITS.notesChars}; it becomes the run record's notes)`);
  }
  const judgments = Array.isArray(decisions.judgments) ? decisions.judgments : null;
  const items = Array.isArray(decisions.items) ? decisions.items : null;
  if (!judgments) v.error(at, 'judgments: must be an array');
  if (!items) v.error(at, 'items: must be an array');
  if (!judgments || !items) return v.result();

  const candById = new Map(candidates.map((c) => [c.candidate_id, c]));
  const survivors = new Set(survivorIds);
  const archiveIds = new Set(archiveItems.map((i) => i?.id).filter(Boolean));
  const archiveUrls = new Map(); // normalised URL -> ids of the published items listing it
  for (const it of archiveItems) {
    for (const s of it?.sources ?? []) {
      const n = s?.url ? normaliseUrl(s.url) : null;
      if (n) archiveUrls.set(n, [...(archiveUrls.get(n) ?? []), it.id]);
    }
  }
  // Story chains: an item and its material updates share the root of their update_of chain.
  const parentOf = new Map(archiveItems.filter((i) => typeof i?.id === 'string').map((i) => [i.id, typeof i.update_of === 'string' ? i.update_of : null]));
  const chainRoot = (id) => {
    let x = id;
    for (let guard = 0; guard < 1000 && parentOf.get(x); guard++) x = parentOf.get(x);
    return x;
  };

  if (typeof decisions.notes === 'string') {
    const fp = findFirstPerson(decisions.notes);
    if (fp) v.error(at, `notes: first-person voice ${quote(fp)} (run notes are public)`);
  }
  if (!reasonCodes) v.warn(at, 'reason_code: FILTER.md code list unavailable; only the code shape and the §8.3 invariants were checked');

  // judgments (shape: SPEC §5; invariants: FILTER.md §8.1-§8.4)
  const judged = new Map();
  const byCandidate = new Map();
  judgments.forEach((j, i) => {
    const a = `${at}.judgments[${i}]${isObj(j) && typeof j.candidate_id === 'string' ? ` (${j.candidate_id})` : ''}`;
    if (!isObj(j)) {
      v.error(a, 'must be an object');
      return;
    }
    for (const k of Object.keys(j)) if (!JUDGMENT_KEYS.includes(k)) v.error(a, `${k}: unknown field`);
    if (typeof j.candidate_id !== 'string' || !CANDIDATE_ID_RE.test(j.candidate_id)) v.error(a, 'candidate_id: must look like c-xxxxxxxxxx');
    else if (!survivors.has(j.candidate_id)) v.error(a, `candidate_id: ${j.candidate_id} is not a stage-1 survivor of this run`);
    else if (judged.has(j.candidate_id)) v.error(a, `candidate_id: judged more than once (also judgments[${judged.get(j.candidate_id)}])`);
    else {
      judged.set(j.candidate_id, i);
      byCandidate.set(j.candidate_id, j);
    }
    const st = j.section_tested;
    if (st !== null && !SECTIONS.includes(st)) v.error(a, `section_tested: must be null or one of ${SECTIONS.join(', ')}`);
    const verdictOk = VERDICTS.includes(j.verdict);
    if (!verdictOk) v.error(a, 'verdict: must be "pass" or "drop"');
    const code = typeof j.reason_code === 'string' && REASON_CODE_RE.test(j.reason_code) ? j.reason_code : null;
    if (!code) v.error(a, 'reason_code: UPPER_SNAKE_CASE code from FILTER.md §8.2');
    const reasonLimit = j.verdict === 'pass' ? LIMITS.reasonPassChars : LIMITS.reasonDropChars;
    if (!isNonEmptyString(j.reason)) v.error(a, 'reason: required one-line string');
    else {
      if (/[\r\n]/.test(j.reason)) v.error(a, 'reason: must be one line');
      if (j.reason.length > reasonLimit) v.error(a, `reason: ${j.reason.length} chars (max ${reasonLimit} for a ${j.verdict})`);
      const fp = findFirstPerson(j.reason);
      if (fp) v.error(a, `reason: first-person voice ${quote(fp)} (logs are public)`);
    }
    if (!DEDUP_OUTCOMES.includes(j.dedup)) v.error(a, `dedup: must be one of ${DEDUP_OUTCOMES.join(', ')}`);
    const m = j.match_id;
    if (m !== null && m !== undefined && (typeof m !== 'string' || !(ITEM_ID_RE.test(m) || CANDIDATE_ID_RE.test(m)))) v.error(a, 'match_id: must be null, an item id or a candidate id');
    const di = j.draft_index;
    const hasIndex = Number.isInteger(di);
    if (di !== null && di !== undefined && (!hasIndex || di < 0 || di >= items.length)) v.error(a, `draft_index: must be null or an index into items (0-${items.length - 1})`);

    if (code) {
      // closed list
      if (reasonCodes && !reasonCodes.has(code)) v.error(a, `reason_code: ${code} is not in the FILTER.md §8.2 list`);
      else if (reasonCodes && verdictOk && reasonCodes.get(code) && reasonCodes.get(code) !== j.verdict) v.error(a, `reason_code: ${code} is a ${reasonCodes.get(code)} code but verdict is ${j.verdict}`);
      // 1. pass iff an (EV|CS|RT)_PASS_ code
      const passCode = /^(EV|CS|RT)_PASS_/.test(code);
      if (verdictOk && (j.verdict === 'pass') !== passCode) v.error(a, `reason_code: ${code} ${passCode ? 'is a pass code but verdict is drop' : 'is not an EV_/CS_/RT_PASS_ code but verdict is pass'}`);
      // 2. section codes match section_tested
      const sec = /^(EV|CS|RT)_/.exec(code);
      if (sec && st !== SECTION_OF_PREFIX[sec[1]]) v.error(a, `section_tested: ${code} requires ${SECTION_OF_PREFIX[sec[1]]}`);
      // 3. gate codes
      if (code === 'GL_NO_MECHANISM') {
        if (!SECTIONS.includes(st)) v.error(a, 'section_tested: GL_NO_MECHANISM names the section that passed');
      } else if (code.startsWith('GL_') && code !== 'GL_PAYWALL_INSUFFICIENT' && st !== null) {
        v.error(a, `section_tested: gate code ${code} requires null`);
      }
      // 4. dedup codes
      if (code.startsWith('DD_')) {
        if (j.dedup !== 'same_story_dropped') v.error(a, `dedup: ${code} requires "same_story_dropped"`);
        if (typeof m !== 'string' || !archiveIds.has(m)) v.error(a, `match_id: ${code} must name the published item it repeats`);
      }
    }
    // 5. material_update iff the reason starts [M1]-[M6]; match is a published item
    const mTag = typeof j.reason === 'string' && /^\[M[1-6]\] /.test(j.reason);
    if (j.dedup === 'material_update' && !mTag) v.error(a, 'reason: a material_update reason begins "[M1] " to "[M6] "');
    if (j.dedup !== 'material_update' && mTag) v.error(a, 'reason: "[M#]" prefix is only for dedup "material_update"');
    if (j.dedup === 'material_update' && (typeof m !== 'string' || !archiveIds.has(m))) v.error(a, 'match_id: material_update must name the earlier published item (RS-...) it updates');
    if (j.dedup === 'same_story_dropped') {
      if (typeof m !== 'string' || !archiveIds.has(m)) v.error(a, 'match_id: same_story_dropped must name the published item it repeats (same-run duplicates are cluster_merged)');
      if (j.verdict === 'pass') v.error(a, 'verdict: a resurfacing story without a material update is a drop');
    }
    // 7. new has no match
    if (j.dedup === 'new' && m !== null && m !== undefined) v.error(a, 'match_id: must be null when dedup is "new"');
    // 8. draft_index iff pass
    if (verdictOk && (j.verdict === 'pass') !== hasIndex) v.error(a, j.verdict === 'pass' ? 'draft_index: required when verdict is pass' : 'draft_index: must be null when verdict is drop');

    if (j.verdict === 'pass') {
      if (!SECTIONS.includes(st)) v.error(a, 'section_tested: required when verdict is pass');
      const item = hasIndex && di >= 0 && di < items.length ? items[di] : null;
      if (item) {
        if (!Array.isArray(item.candidate_ids) || !item.candidate_ids.includes(j.candidate_id)) v.error(a, `draft_index: items[${di}].candidate_ids does not include ${j.candidate_id}`);
        if (SECTIONS.includes(st) && item.section !== st) v.error(a, `section_tested: ${st} but items[${di}].section is ${item.section}`);
        if (j.dedup === 'material_update' && typeof m === 'string' && item.update_of !== m) v.error(a, `items[${di}].update_of: must be ${m} for a material update`);
      }
    }
  });
  // 6. cluster members mirror their lead
  judgments.forEach((j, i) => {
    if (!isObj(j) || j.dedup !== 'cluster_merged') return;
    const a = `${at}.judgments[${i}] (${j.candidate_id})`;
    const lead = typeof j.match_id === 'string' ? byCandidate.get(j.match_id) : null;
    if (!lead || lead === j) {
      v.error(a, 'match_id: cluster_merged must name the lead candidate_id (another judgment in this file)');
      return;
    }
    if (lead.dedup === 'cluster_merged') v.error(a, `match_id: ${j.match_id} is itself cluster_merged; point at the cluster lead`);
    for (const k of ['verdict', 'reason_code', 'section_tested', 'draft_index']) {
      if ((lead[k] ?? null) !== (j[k] ?? null)) v.error(a, `${k}: cluster members carry the lead's ${k} (${quote(lead[k] ?? null)})`);
    }
  });
  const missing = [...survivors].filter((id) => !judged.has(id));
  if (missing.length) v.error(at, `judgments: ${missing.length} stage-1 survivor(s) not judged: ${missing.join(', ')}`);

  // items
  const ngrams = buildNgramSet(candidates.flatMap((c) => [c.headline, c.lead]).filter(Boolean));
  const owner = new Map();
  items.forEach((item, i) => {
    const a = `${at}.items[${i}]`;
    v.merge(validateItem(item, { at: a, mode: 'draft', style, claimsMayNameInstitutions }));
    if (!isObj(item)) return;
    const primaries = judgments.filter((j) => isObj(j) && j.draft_index === i && j.verdict === 'pass' && (j.dedup === 'new' || j.dedup === 'material_update'));
    const updateOf = primaries.length === 1 && primaries[0].dedup === 'material_update' && typeof primaries[0].match_id === 'string' ? primaries[0].match_id : null;
    const cids = Array.isArray(item.candidate_ids) ? item.candidate_ids.filter((c) => typeof c === 'string') : [];
    const cands = [];
    for (const cid of cids) {
      const c = candById.get(cid);
      if (!c) {
        v.error(a, `candidate_ids: ${cid} is not in this run's candidates.json`);
        continue;
      }
      cands.push(c);
      if (owner.has(cid)) v.error(a, `candidate_ids: ${cid} is also used by items[${owner.get(cid)}]`);
      else owner.set(cid, i);
      if (survivors.has(cid)) {
        const ji = judged.get(cid);
        const j = ji === undefined ? null : judgments[ji];
        if (j && !(j.verdict === 'pass' && PUBLISHED_DEDUP.includes(j.dedup) && j.draft_index === i)) {
          v.error(a, `candidate_ids: ${cid} is attached here but its judgment is ${j.verdict}/${j.dedup} with draft_index ${j.draft_index ?? null}`);
        }
      } else if (!c.extra) {
        v.warn(a, `candidate_ids: ${cid} was not a stage-1 survivor (${c.seen ? 'seen' : 'dropped at stage 1'}); attached as an extra source`);
      }
    }
    const candUrls = new Map(cands.map((c) => [normaliseUrl(c.url), c]));
    if (Array.isArray(item.sources)) {
      item.sources.forEach((s, k) => {
        if (!isObj(s) || typeof s.url !== 'string') return;
        const wrapper = isHttpsUrl(s.url) ? disallowedSourceReason(s.url) : null;
        if (wrapper) v.error(a, `sources[${k}].url: ${wrapper} (register that page with add-manual.mjs --extra) (FILTER 2.7.2, 7.8)`);
        const n = normaliseUrl(s.url);
        const c = candUrls.get(n);
        if (!c) {
          v.error(a, `sources[${k}].url: not the URL of any candidate in this item's candidate_ids (sources must come from collected candidates; register a source found by search with add-manual.mjs --extra and add its candidate_id)`);
          return;
        }
        if (s.headline !== undefined && isComposedHeadline(c)) {
          v.error(a, `sources[${k}].headline: ${quote(c.headline)} was composed by the collector, not published by the source; omit headline (publication and url suffice) (FILTER 7.8)`);
        }
        const owners = archiveUrls.get(n);
        if (owners) {
          const sameStory = updateOf !== null && owners.some((id) => chainRoot(id) === chainRoot(updateOf));
          if (!sameStory) {
            v.error(a, `sources[${k}].url: already a source of published item ${owners.join(', ')}; a published story is listed again only by a material update of it (dedup material_update with match_id in that item's update chain). Otherwise the candidate repeats the story (DD_SAME_STORY), or remove this source`);
          }
        }
        if (isNonEmptyString(s.publication) && s.publication !== c.publication) v.warn(a, `sources[${k}].publication: ${quote(s.publication)} differs from the registry (${quote(c.publication)})`);
        // headline is reference metadata: the source's own headline (or a trimmed part of it), never lead or body text
        const norm = (x) => String(x).replace(/\s+/g, ' ').trim().toLowerCase();
        if (isNonEmptyString(s.headline) && isNonEmptyString(c.headline) && !norm(c.headline).includes(norm(s.headline))) {
          v.warn(a, `sources[${k}].headline: not the collected headline ${quote(c.headline)}; use the source's own headline, never lead or body text (FILTER 7.8)`);
        }
        if (s.published !== undefined && c.published_date && s.published !== c.published_date) v.warn(a, `sources[${k}].published: ${s.published} differs from the feed date ${c.published_date}`);
        if (window?.replay === true && typeof window.until === 'string' && typeof c.published === 'string' && Date.parse(c.published) > Date.parse(window.until)) {
          v.warn(a, `sources[${k}]: published ${c.published_date ?? c.published}, after this replay's window closed (${window.until}); a replayed slot cites only what existed when it ran (FILTER 2.7.5(e), G7, E3)`);
        }
        const cls = s.source_class ?? (k === 0 ? item.source_class : undefined);
        if (cls && c.source_class && cls !== c.source_class) v.warn(a, `sources[${k}]: class ${cls} differs from the registry class ${c.source_class} for ${c.publication}`);
      });
      for (const c of cands) {
        if (!item.sources.some((s) => isObj(s) && normaliseUrl(s.url) === normaliseUrl(c.url))) v.warn(a, `candidate_ids: ${c.candidate_id} contributes no source`);
      }
      // NP5 / §2.9: a paywalled source is never sources[0] while a public source is listed.
      const paywalledOf = (s) => (isObj(s) && typeof s.url === 'string' ? candUrls.get(normaliseUrl(s.url))?.paywalled : undefined);
      if (paywalledOf(item.sources[0]) === true) {
        const pub = item.sources.findIndex((s, k) => k > 0 && paywalledOf(s) === false);
        if (pub !== -1) v.error(a, `sources[0]: paywalled (headline and lead only) while sources[${pub}] is public; the public source is primary (FILTER NP5, 2.9)`);
      }
    }
    if (primaries.length !== 1) v.error(a, `needs exactly one judgment with verdict pass and dedup new/material_update pointing to it (found ${primaries.length})`);
    if (item.update_of !== null && item.update_of !== undefined) {
      if (!archiveIds.has(item.update_of)) v.error(a, `update_of: ${item.update_of} is not a published item`);
      if (primaries.length === 1 && primaries[0].dedup !== 'material_update') v.error(a, 'update_of: set, but the primary judgment is not dedup "material_update"');
    }
    for (const { field, text } of generatedTexts(item)) {
      const hit = findVerbatim(text, ngrams);
      if (hit) v.error(a, `${field}: copies ${LIMITS.verbatimWords}+ consecutive words from a source headline or lead (${quote(hit)}); write it in your own words`);
    }
  });
  items.forEach((item, i) => {
    if (!judgments.some((j) => isObj(j) && j.draft_index === i)) v.error(`${at}.items[${i}]`, 'not referenced by any judgment');
  });
  if (style) {
    for (const s of decisionStyleIssues(decisions, { candidates, archiveItems, reasonElements, knobs, filterText })) v.warn(s.at, `${s.message} (${s.rule})`);
  }
  return v.result();
}

/** A candidate headline the collector composed (CISA KEV entries), never the source's own. */
export function isComposedHeadline(c) {
  return Boolean(c?.headline_composed) || (Boolean(c?.kev) && /^CISA KEV adds CVE-/.test(String(c?.headline ?? '')));
}

const NEAR_RE = /(?<![\p{L}\p{N}])NEAR(?![\p{L}\p{N}])/u;
const REASON_HEAD_RE = /^(?:\[M[1-6]\] )?NEAR ([A-Z][A-Za-z0-9]*)(?:\/([a-z][a-z0-9_]*))?: /;
const ALT_RE = /\[alt\b/;
const ALT_TAIL_RE = / \[alt (EV|CS):([A-Z][A-Za-z0-9]*)(?:\/([a-z][a-z0-9_]*))?\]$/;

/** FILTER.md §8.4: problems with a drop's "NEAR <element>[/<knob>]: " head, as messages. */
function nearMarkerIssues(code, el, knob, { reasonElements = null, knobs = null } = {}) {
  const out = [];
  const fixed = NEAR_KNOB_REQUIRED[code];
  if (fixed) {
    if (el !== fixed.element || knob !== fixed.knob) out.push(`${code} is NEAR only as "NEAR ${fixed.element}/${fixed.knob}: " when the candidate would clear at that knob's next step; otherwise drop the NEAR marker`);
  } else if (/^(?:GL|DD)_/.test(code)) {
    out.push(`${code}: gate and dedup drops are never NEAR, except the knob-controlled gates and M2`);
  } else if (/^(?:EV|CS|RT)_/.test(code) && reasonElements?.get(code)) {
    const codeEl = reasonElements.get(code);
    const fits = el === codeEl || (el.startsWith(codeEl) && /^[a-z]$/.test(el.slice(codeEl.length))) || (codeEl === 'R2' && (el === 'X1' || el === 'R2b'));
    if (!fits) out.push(`NEAR ${el} with ${code} (element ${codeEl}); the NEAR element is the element of the recorded code`);
  }
  if (knob && knobs) {
    if (!knobs.has(knob)) out.push(`"${knob}" is not a knob in thresholds.json`);
    else if (!knobCovers(knobs.get(knob)?.element, el)) out.push(`knob ${knob} controls ${knobs.get(knob)?.element}, not ${el}`);
  }
  return out;
}

/**
 * FILTER.md rules on decisions.json that need the run's candidates or the archive, beyond the
 * per-item styleIssues: [{ rule, at, message, banned }]. publish.mjs reports them as warnings;
 * selfcheck.mjs makes the banned ones errors.
 *   - §2.9: among news sources, general or business press before trade press, and within a tier
 *     public before paywalled (by the candidates' registry tier; a guess where it is unknown).
 *   - §7.7.6 (AO3): an awareness rationale repeating 12+ consecutive words of a published one.
 *   - §10 preface (with filterText): no run of 8+ words of a worked example (modelWordingNgrams).
 *   - §7.1 for reasons and notes (logs are public): V2 second person, V4 a named financial
 *     institution (the lexicon, a legal-form ending, or a capitalised name before an institution
 *     type and an event: findNamedInstitutionEvent), V9 hype (V1 first person is a publishing
 *     error in validateDecisions).
 *   - §8.4 reason grammar: "NEAR" only at the start (after an optional "[M#] "), as
 *     "NEAR <element>[/<knob>]: ", never on a pass; the NEAR element is the recorded code's element
 *     (with reasonElements, from parseReasonCodeElements); gate and dedup codes are never NEAR
 *     except with their knob (NEAR_KNOB_REQUIRED, which also covers CS_ROUTINE_VULN and
 *     RT_JURISDICTION); a knob exists and controls the element (with knobs, from thresholds.mjs
 *     knobs()); "[alt EV:<element>[/<knob>]]" or "[alt CS:<element>[/<knob>]]" last, naming the
 *     other section.
 *   - §8.3 invariant 9 (with knobs): GL_FORMAL_RULE only while formal_instrument_scope is
 *     "none"; RT_PASS_FORMAL_RULE, RT_PASS_EXAM_NOTICE and RT_INSTRUMENT_NOT_NEW never then
 *     (formalScopeIssue).
 * @param {{candidates?: object[], archiveItems?: object[], reasonElements?: Map<string,string|null>|null, knobs?: Map<string,{element: string}>|null, filterText?: string|null}} ctx
 */
export function decisionStyleIssues(decisions, { candidates = [], archiveItems = [], reasonElements = null, knobs = null, filterText = null } = {}) {
  const out = [];
  const add = (rule, at, message, banned = true) => out.push({ rule, at, message, banned });
  if (!isObj(decisions)) return out;
  const items = Array.isArray(decisions.items) ? decisions.items : [];
  const judgments = Array.isArray(decisions.judgments) ? decisions.judgments : [];
  const candByUrl = new Map(candidates.filter((c) => typeof c?.url === 'string').map((c) => [normaliseUrl(c.url), c]));
  const published = buildNgramSet(archiveItems.map((it) => it?.awareness_rationale).filter((r) => typeof r === 'string'), 12);
  const modelWording = filterText ? modelWordingNgrams(filterText) : null;
  items.forEach((item, i) => {
    if (!isObj(item)) return;
    const a = `decisions.items[${i}]`;
    if (modelWording?.size) {
      for (const { field, text } of generatedTexts(item)) {
        const hit = findVerbatim(text, modelWording);
        if (hit) add('FILTER 10', a, `${field}: repeats ${LIMITS.verbatimWords}+ consecutive words of a FILTER.md §10 worked example (${quote(hit)}); write it fresh for this development`);
      }
    }
    if (Array.isArray(item.sources)) {
      // sources[0] is the primary; a paywalled primary is a publishing error (NP5) in validateDecisions.
      // §2.9 news order: general or business press, then trade; within a tier, public before paywalled.
      // A candidate carries its registry `tier` when sources.json gives one; without it the tier is
      // unknown and the public-before-paywalled check is only a guess.
      const news = item.sources.map((s, k) => ({ k, s, c: isObj(s) && typeof s.url === 'string' ? candByUrl.get(normaliseUrl(s.url)) : undefined }))
        .filter(({ k, s }) => k > 0 && isObj(s) && s.source_class === 'news' && typeof s.url === 'string');
      outer: for (let x = 1; x < news.length; x++) {
        for (let y = 0; y < x; y++) {
          const [p, q] = [news[y], news[x]];
          const [tp, tq] = [p.c?.tier, q.c?.tier];
          if (tp && tq) {
            if (tp === 'trade' && tq === 'general') {
              add('FILTER 2.9', `${a}`, `sources[${q.k}]: general or business press listed after trade press sources[${p.k}]`, false);
              break outer;
            }
            if (tp === tq && p.c?.paywalled === true && q.c?.paywalled === false) {
              add('FILTER 2.9', `${a}`, `sources[${q.k}]: public ${tq} press listed after paywalled ${tp} press sources[${p.k}]; within a tier, public before paywalled`, false);
              break outer;
            }
          } else if (p.c?.paywalled === true && q.c?.paywalled === false) {
            add('FILTER 2.9', `${a}`, `sources[${q.k}]: public news source listed after paywalled sources[${p.k}]; within a tier, public before paywalled (tier unknown: ignore this if sources[${p.k}] is general or business press and sources[${q.k}] trade press)`, false);
            break outer;
          }
        }
      }
    }
    if (typeof item.awareness_rationale === 'string') {
      const hit = findVerbatim(item.awareness_rationale, published, 12);
      if (hit) add('FILTER 7.7', a, `awareness_rationale: repeats 12+ consecutive words of a published rationale (${quote(hit)}); it fails AO3 specificity`);
    }
  });
  const voice = (at, field, text) => {
    const second = firstMatch(SECOND_PERSON, text);
    if (second) add('FILTER V2', at, `${field}: second person ${quote(second)} (logs are public)`);
    const inst = findInstitutions(text);
    const bySuffix = inst.length ? null : findNameBySuffix(text);
    const named = inst.length || (bySuffix && !bySuffix.soft) ? null : findNamedInstitutionEvent(text);
    if (inst.length) add('FILTER V4', at, `${field}: names ${quote(inst[0].match)}; refer to institutions by category (logs are public)`);
    else if (bySuffix && !bySuffix.soft) add('FILTER V4', at, `${field}: names ${quote(bySuffix.match)}; refer to institutions by category (logs are public)`);
    else if (named) add('FILTER V4', at, `${field}: ${quote(named)} may name a financial institution with an event; use the category form ("a crypto exchange's $388m hack") (logs are public)`);
    const hype = firstMatch(HYPE, text);
    if (hype) add('FILTER V9', at, `${field}: hype word ${quote(hype)}`);
  };
  const formalScope = knobs instanceof Map ? knobs.get('formal_instrument_scope')?.value : undefined;
  judgments.forEach((j, i) => {
    if (!isObj(j)) return;
    const a = `decisions.judgments[${i}]${typeof j.candidate_id === 'string' ? ` (${j.candidate_id})` : ''}`;
    // FILTER.md §8.3 invariant 9: the formal-instrument codes follow formal_instrument_scope
    const scopeIssue = formalScopeIssue(j.reason_code, formalScope);
    if (scopeIssue) add('FILTER 8.3', a, `reason_code: ${scopeIssue}`);
    if (typeof j.reason !== 'string') return;
    voice(a, 'reason', j.reason);
    if (NEAR_RE.test(j.reason)) {
      const head = REASON_HEAD_RE.exec(j.reason);
      if (j.verdict === 'pass') add('FILTER 8.4', a, 'reason: "NEAR" marks a drop; a pass never carries it');
      else if (!head) add('FILTER 8.4', a, 'reason: write "NEAR <element>[/<knob>]: <text>" at the start (after an optional "[M#] "), so calibration counts it');
      else if (typeof j.reason_code === 'string') {
        for (const m of nearMarkerIssues(j.reason_code, head[1], head[2], { reasonElements, knobs })) add('FILTER 8.4', a, `reason: ${m}`);
      }
    }
    if (ALT_RE.test(j.reason)) {
      const alt = ALT_TAIL_RE.exec(j.reason);
      if (!alt) add('FILTER 8.4', a, 'reason: the alternative-route marker is " [alt EV:<element>[/<knob>]]" or " [alt CS:<element>[/<knob>]]" at the end', false);
      else {
        const sec = typeof j.reason_code === 'string' ? /^(EV|CS)_/.exec(j.reason_code)?.[1] : null;
        const wrongSection = !sec || sec === alt[1];
        if (wrongSection) add('FILTER 8.4', a, `reason: an alternative-route marker follows an EV or CS drop and names the other section (${j.reason_code} with [alt ${alt[1]}:...])`, Boolean(alt[3]));
        if (alt[3] && knobs) {
          if (!knobs.has(alt[3])) add('FILTER 8.4', a, `reason: "${alt[3]}" in the alternative-route marker is not a knob in thresholds.json`);
          else if (!knobCovers(knobs.get(alt[3])?.element, alt[2])) add('FILTER 8.4', a, `reason: knob ${alt[3]} controls ${knobs.get(alt[3])?.element}, not ${alt[2]}`);
        }
      }
    }
  });
  if (typeof decisions.notes === 'string') voice('decisions.notes', 'notes', decisions.notes);
  return out;
}

// ---------------------------------------------------------------- append-only

function firstDifference(a, b, path = '') {
  if (canonical(a) === canonical(b)) return null;
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDifference(a[k], b[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path || '(root)'} length ${a.length} -> ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
  }
  return path || '(root)';
}

/**
 * Fail when anything present before is missing, changed or reordered after.
 * @param {object|null} before parsed document at the reference (null = did not exist)
 * @param {object} after current document
 * @param {'archive'|'runs'} kind
 */
export function checkAppendOnly(before, after, kind) {
  const v = new Issues();
  const key = kind === 'archive' ? 'items' : 'runs';
  const idKey = kind === 'archive' ? 'id' : 'run_id';
  const label = kind === 'archive' ? 'docs/data/archive.json' : 'docs/data/runs.json';
  if (before === null || before === undefined) return v.result();
  const prev = Array.isArray(before?.[key]) ? before[key] : [];
  const cur = Array.isArray(after?.[key]) ? after[key] : null;
  if (!cur) {
    if (prev.length) v.error(label, `${key}: missing, but the reference has ${prev.length} entr${prev.length === 1 ? 'y' : 'ies'}`);
    return v.result();
  }
  if (before.schema_version !== after.schema_version) v.error(label, `schema_version changed (${before.schema_version} -> ${after.schema_version})`);
  const curIndex = new Map(cur.map((x, i) => [x?.[idKey], i]));
  prev.forEach((x, i) => {
    const id = x?.[idKey] ?? `#${i}`;
    if (i < cur.length && canonical(cur[i]) === canonical(x)) return;
    const j = curIndex.get(x?.[idKey]);
    if (j === undefined) v.error(label, `${key}[${i}] ${id}: removed (append-only)`);
    else if (canonical(cur[j]) !== canonical(x)) v.error(label, `${key}[${i}] ${id}: changed at ${firstDifference(x, cur[j])} (append-only)`);
    else v.error(label, `${key}[${i}] ${id}: moved to position ${j} (append-only; new entries go at the end)`);
  });
  return v.result();
}
