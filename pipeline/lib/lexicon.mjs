// Stage-1 lexicon (SPEC §5 step 2): cheap domain relevance across the seven domains.
//
// HOW SCORING WORKS (tune here during calibration; bump LEXICON_VERSION on every change)
//
//   Each candidate's headline and lead are matched against term lists. A term counts once per
//   candidate: its full weight if it appears in the headline, LEAD_FACTOR x weight if it appears
//   only in the lead.
//
//   score = min(sum of qualifying domain scores, DOMAIN_TOTAL_CAP)
//         + min(materiality, CAPS.materiality)   evidence it matters: exploitation, scale, severity,
//                                                novelty, soft regulatory signal, formal instrument
//                                                or exam notice (only with a qualifying domain)
//         + min(sector, CAPS.sector)             financial-sector relevance (incl. named institutions)
//         + min(enterprise, CAPS.enterprise)     ubiquitous enterprise technology (edge devices, IdP, cloud)
//         - noise                                explainers, listicles, arrests, patch-only, consumer
//                                                product news; for lenient sources: monetary policy,
//                                                appointments, minutes, statistics
//
//   A domain "qualifies" when its own score >= DOMAIN_QUALIFY (one medium term in the headline,
//   or a strong term in the lead). Per-domain scores are capped at DOMAIN_CAP. Survivors carry
//   their qualifying domains (highest score first), the score and every matched term.
//
//   Off domain (every profile): no qualifying domain, or risk_quantification as the only domain
//   on prudential vocabulary with no technology content in the headline or lead (capital,
//   liquidity, stress-test capital, accounting, deposit insurance, resolution, climate:
//   NON_TECH_PRUDENTIAL), that is no medium or strong term of another domain and no TECH_CONTENT
//   term such as operational risk, loss data, ICT or cloud.
//   FILTER.md §3.3 puts market, credit and liquidity risk modelling outside the seven domains.
//
//   Pass rule per profile (PROFILES): at least one qualifying domain AND score >= threshold;
//   strict and high_volume also need a strong domain term in the HEADLINE.
//   Primary sources pass on less evidence than secondary news, because they originate the facts:
//   regulator/standards_body -> lenient (3; still need a domain match); vendor_threat_research on
//   a government CERT host (CISA, NCSC, CERT-EU, ...: AUTHORITY_HOSTS) -> authority (4); other
//   vendor_threat_research (vendor research, advisories, post-incident reports) -> primary (6),
//   except CISA ICS/medical product advisories (STANDARD_PATH_SEGMENTS) -> standard;
//   news/industry_trade -> standard (10); research_analysis -> strict.
//   High-volume hosts (arXiv, SSRN) -> high_volume. sources.json may override with "prefilter".
//
//   CISA KEV candidates (one per CVE, already proven exploited) bypass the score threshold but
//   pass only when they touch ubiquitous enterprise technology (ENTERPRISE_TERMS), name a
//   financial-sector term or institution, or CISA marks ransomware use as "Known". Niche products
//   are dropped as below_threshold with that reason.
//
//   Before scoring, MARKETING patterns (webinars, product launches, awards, sponsored, partners
//   with, funding rounds, named a leader, now available, appointments) and ROUNDUP patterns
//   (weekly recaps, "in other news", products of the week) drop a candidate outright, as do
//   CISA "Adds N Known Exploited Vulnerabilities to Catalog" posts when a cisa-kev source exists
//   and event listings recognised by URL (EVENT_URL_SEGMENTS, every class). A product-launch or
//   "now available" match is ignored when its subject is an adversary (ADVERSARY_SUBJECT) or an
//   authority (AUTHORITY_SUBJECT: "Fed announces final rule ... for service providers").
//
//   FORMAL INSTRUMENTS AND EXAM NOTICES (owner decision 2026-10-03; FILTER.md §4.4.2 and §4.4.5,
//   knob formal_instrument_scope): a newly issued formal rule or exam notice is in scope in the
//   regulatory_trajectory section. Stage 1 no longer counts formal-instrument vocabulary as noise;
//   the formal_instrument materiality group (final rules, RTS/ITS, delegated regulations, final
//   guidelines, supervisory and policy statements, industry letters, circulars, SR letters, FILs,
//   OCC bulletins, examination procedures, handbooks and priorities) adds points only when a
//   domain qualifies (DOMAIN_GATED_GROUPS), so an off-domain rule gains nothing. Stage 1 stays
//   recall-oriented: whether an instrument is new (first issuance in final form, not a reminder,
//   restatement, correction or extension) and material is judged at stage 2.
//
// CALIBRATION BASELINE (18 live feeds, items 2026-09-25..10-02, lexicon 2026-10-02.2, 354 unseen):
// overall 12.4% pass; general security news 29/118 = 24.6% (an exploitation-heavy week: many
// follow-ups of the same two zero-day stories, which dedup-hints clusters); CISA advisories 1/21;
// CISA KEV 5/10 (enterprise products only); arXiv cs.CR 0/109; FS trade news (Finextra) 0/45;
// regulators and standards bodies 9/51 = 17.6%.
// Lexicon 2026-10-02.4 on the 2026-10-02 10:00 dry run (453 unseen, incl. 7 page entries): overall
// 49 -> 55 (12.1%); news 19/190 -> 20/190 (10.5%; the CyberScoop NetScaler story no longer falls to
// "state-sponsored"); vendor_threat_research 5/21 -> 10/21 (both Azure post-incident reviews, three
// vendor research posts). Fresh 72 h fetch at 15:04 ET (114 feeds, 661 unseen): 51 (7.7%); news
// 22/409 = 5.4%; vendor_threat_research 8/19; regulators 16/91; arXiv 0/113.
// Lexicon 2026-10-03.1 (formal instruments in scope) against .5: 14-day regulator and standards-body
// fetch (45 feeds, 2026-09-19..10-03, 232 unseen) 50 -> 40 passed, every removal a capital,
// stress-test, accounting, resolution, climate or extension-of-credit item; the window's one
// domain-relevant instrument (an OCC cybersecurity supervision work program bulletin) kept, 6.5 ->
// 8.5. The same feeds' full history (772 unseen since 2026-01-01) 210 -> 183, recovering SR letters
// with bare-identifier headlines (revised model risk management guidance among them) and two NIST
// final guidelines. 3-day fetch of every source (519 unseen) 51 -> 43; news unchanged at 20/376.
//
// TERM SYNTAX
//   'phrase'        case-insensitive, whole words; a space or hyphen in the term matches a space,
//                   hyphen or nothing ('zero-day' matches 'zero day', 'zero-day', 'zeroday')
//   'stem*'         trailing * = any word continuation ('exploit*' matches exploited, exploitation)
//   'cs:Term'       case-sensitive ('cs:AI', 'cs:SEC', 'cs:APT')
//   're:<regex>'    raw regular expression, case-insensitive, unicode
//
// MATERIALITY GROUPS count only their highest-weighted match (so 'actively exploited' and
// 'zero-day' in one headline do not stack); other categories sum.

// .3: event-listing URLs dropped (EVENT_URL_SEGMENTS). .4: service-outage vocabulary (resilience,
// scale and post-incident materiality); primary and authority profiles for vendor_threat_research;
// "sponsored" only as a content label ("state-sponsored" is not marketing); KEV entries skip the
// marketing patterns. .5: a loss materiality group (an amount next to a hack, heist, theft or
// fraud: the E2c signal), after a $388m crypto-exchange hack scored 6 on a news feed in the
// 2026-10-02 dry run; crypto exchanges added to the institution list count as sector.
// 2026-10-03.1 (owner decision: new formal rules and exam notices are in scope in RT): 'final
// rule', 'finali*', 'exam procedures', 'examination procedures' and 'examination manual' are no
// longer lenient-profile noise; a formal_instrument materiality group scores formal-instrument and
// exam-notice vocabulary, gated on a qualifying domain ('supervisory statement' and 'policy
// statement' moved there from soft_signal); domain vocabulary common in such instruments
// ('information security', 'ICT risk', 'authentication', 'access tokens', 'remote access',
// 'ICT-related incident', 'incident reporting', 'incident notification', 'strong customer
// authentication', 'core providers', 'core banking'); a bare identifier headline ("SR 26-2", whose
// title the Federal Reserve's feed puts in the description: BARE_ID_HEADLINE) is scored with its
// lead as the headline; 'insurance' in "Federal Deposit Insurance Corporation" is no longer a
// risk_quantification term, nor "extensions of credit" or a comment-period extension a third_party
// one; capital, liquidity, accounting and climate items whose only domain is
// risk_quantification and that carry no technology content are off domain (NON_TECH_PRUDENTIAL;
// this replaces the 'final rule' noise that used to sink capital rules); an authority subject no
// longer trips the product-launch or "now available" marketing patterns.
// 2026-10-04.1: 'new technolog*', 'emerging technolog*' and 'digital innovation' are weak ai terms,
// after the formal-instrument calibration (14 days of regulator and standards-body feeds to
// 2026-10-03) lost an EU authority's new supervisory priority on digital innovation (AI and
// tokenisation named as focus areas; headline "digital innovation", lead "new technologies") as off
// domain. Weak terms qualify the domain only together (1 + 0.5 = 1.5). On 1,606 unique candidates
// (the 14-day regulator run, the regulators' history since 2026-01-01, a 3-day fetch of every
// source, the 2026-09-30 to 10-02 dry runs) the change added that one survivor and nothing else; a
// supervisor's speech titled "Digital innovation: ..." with no technology term in its lead stays
// dropped.
// 2026-10-05.1: AI systems acting without authorisation, and vendor shutdown instructions. The first
// live run (2026-10-05-0600) lost an AI developer's agents reaching 100+ organisations' systems (8
// entries, scores 3-9, no survivor) and a file-transfer vendor telling customers to power its
// platform down (9.5 < 10). Added: cyber strong 'unauthori* access' and access-without-authorisation
// phrasing; cyber medium break-in verbs; ai strong 'misaligned model*', 'rogue ai', 'rogue agent*',
// 'agentic hack*'; resilience strong a vendor telling customers to power, shut or take a product
// down; 'orgs' in the scale count; break-in, accessed and probing verbs in the capability group;
// 'without authori*', 'misaligned' and 'rogue' in the control_failure group. On 2,079 stored
// candidates (the 0600 run and every backfill window) survivors 863 -> 872, none removed; every
// addition is on the agent-intrusion story, the vendor shutdown, or a rogue-provider MFA flaw.
export const LEXICON_VERSION = '2026-10-05.1';

export const WEIGHTS = Object.freeze({ strong: 3, medium: 2, weak: 1 });
export const LEAD_FACTOR = 0.5;
export const DOMAIN_CAP = 6;
export const DOMAIN_TOTAL_CAP = 8;
export const DOMAIN_QUALIFY = 1.5;
export const CAPS = Object.freeze({ materiality: 6, sector: 5, enterprise: 2 });

/** noise = the noise sets applied (see NOISE). */
export const PROFILES = Object.freeze({
  lenient: { threshold: 3, strongInTitle: false, noise: ['regulatory'] },
  authority: { threshold: 4, strongInTitle: false, noise: ['general'] },
  primary: { threshold: 6, strongInTitle: false, noise: ['general'] },
  standard: { threshold: 10, strongInTitle: false, noise: ['general', 'findings'] },
  strict: { threshold: 9, strongInTitle: true, noise: ['general'] },
  high_volume: { threshold: 12, strongInTitle: true, noise: ['general', 'academic'] },
});

export const CLASS_PROFILE = Object.freeze({
  regulator: 'lenient',
  standards_body: 'lenient',
  industry_trade: 'standard',
  news: 'standard',
  vendor_threat_research: 'primary',
  research_analysis: 'strict',
});

/**
 * Government CERT and national cyber agency hosts: their vendor_threat_research feeds (alerts,
 * advisories, analysis reports) are primary authority sources and use the authority profile.
 */
export const AUTHORITY_HOSTS = Object.freeze([
  'cisa.gov', 'us-cert.gov', 'ncsc.gov.uk', 'cert.europa.eu', 'enisa.europa.eu', 'cyber.gov.au', 'cyber.gc.ca',
  'ncsc.nl', 'cert.ssi.gouv.fr', 'bsi.bund.de', 'ic3.gov', 'fbi.gov', 'nsa.gov',
]);

/**
 * URL path segments of high-volume product advisories that rarely bear on financial services
 * (CISA's ICS and medical-device advisories: a product name and boilerplate impact text). Their
 * entries use the standard profile even on an authority host.
 */
export const STANDARD_PATH_SEGMENTS = Object.freeze(['ics-advisories', 'ics-medical-advisories']);

/** Hosts whose volume needs the high_volume profile regardless of class. */
export const HIGH_VOLUME_HOSTS = Object.freeze(['arxiv.org', 'export.arxiv.org', 'rss.arxiv.org', 'papers.ssrn.com']);

export const DOMAIN_TERMS = {
  cyber: {
    strong: [
      'ransomware', 'zero-day*', '0-day*', 'remote code execution', 'cs:RCE', 'authentication bypass',
      'auth bypass', 'wiper*', 'supply chain attack*', 'nation-state', 'state-sponsored', 'state-backed',
      'state hackers', 're:\\bAPT ?\\d{1,3}\\b', 'cyberattack*', 'cyber attack*', 'backdoor*', 'web shell*',
      'infostealer*', 'botnet*', 'cs:DDoS', 'denial-of-service', 'data extortion', 'double extortion',
      'privilege escalation', 'session hijack*', 'mfa bypass', 'credential stuffing', 'credential theft',
      'token theft', 'stolen credentials', 'initial access broker*', 'spyware', 'rootkit*', 'bootkit*',
      'arbitrary code execution', 'code execution',
      // access without authorisation, whoever the actor (a person, malware or an AI system)
      'unauthori* access', 're:\\b(?:accessed|access(?:ing)?|entered|reached)\\b[^.;:]{0,60}\\bwithout (?:authori[sz]ation|permission)\\b',
      // a hack or theft stated with its amount ("$388 million hack", "hackers stole $25m"): strong
      // in a headline, so the strict profile of general and business press admits it (FILTER E2c)
      're:(?:[$£€]|\\b(?:usd|eur|gbp|us\\$))\\s?\\d[\\d.,]*\\s?(?:million|billion|bn|m|b)\\s+(?:crypto\\s+|cryptocurrency\\s+|exchange\\s+)?(?:hack|heist|theft)\\b',
      're:\\b(?:hack(?:s|ed|ers)?|heists?|stole|stolen|drained)\\b[^.;:]{0,30}(?:[$£€]|\\b(?:usd|eur|gbp|us\\$))\\s?\\d[\\d.,]*\\s?(?:million|billion|bn|m|b)\\b',
    ],
    medium: [
      'vulnerabilit*', 'flaw*', 'exploit*', 'malware', 'hack', 'hacks', 'hacked', 'hacker*', 'hacking',
      'breach', 'breached', 'breaches', 'intrusion*', 'compromise*', 'threat actor*', 'attackers',
      're:\\bCVE-\\d{4}-\\d{4,}\\b', 'security incident', 'cyber incident', 'cybersecurity', 'cyber security',
      'espionage', 'trojan*', 'cs:RAT', 'command-and-control', 'lateral movement', 'zero trust',
      'identity provider*', 'single sign-on', 'cs:SSO', 'oauth', 'service principal*', 'privileged access',
      'active directory', 'credentials', 'cs:MFA', 'multi-factor', 'insider threat*', 'post-quantum',
      'quantum computing', 'cryptographic*', 'certificate authorit*', 'dns hijack*', 'unpatched',
      'break in', 'breaks in', 'broke into', 'break into', 'breaking into', 'break-in*',
      'path traversal', 'sql injection', 'code injection', 'deserialization', 'cyber',
      // vocabulary of supervisory instruments and exam material (FFIEC "Information Security"
      // booklet, DORA "ICT risk management framework", NIST token-protection guidelines)
      'information security', 'ict risk*', 'ict security', 'authentication', 'identity and access', 'access token*',
      'session token*', 'remote access',
    ],
    weak: ['attack*', 'security', 'threat*', 'firewall*', 'cs:VPN', 'router*', 'endpoint*', 'encryption', 'password*'],
  },
  fraud: {
    strong: [
      'fraud*', 'account takeover*', 'business email compromise', 'cs:BEC', 'authorised push payment*',
      'authorized push payment*', 'cs:APP fraud', 'money mule*', 'mule account*', 'synthetic identit*',
      'deepfake*', 'voice clon*', 'sim swap*', 'jackpotting', 'card skimm*', 'skimmer*', 'cheque fraud',
      'check fraud', 'pig butchering', 'romance scam*', 'investment scam*', 'impersonation scam*',
      'payment diversion', 'invoice fraud', 'identity theft', 'card-not-present', 'carding', 'magecart',
      'e-skimming', 'scam compound*', 'elder fraud',
    ],
    medium: [
      'scam*', 'phishing', 'smishing', 'vishing', 'social engineering', 'impersonat*', 'money laundering',
      'laundering', 'cs:AML', 'cs:KYC', 'know your customer', 'sanctions evasion', 'stolen funds', 'heist*',
      'crypto theft', 'cryptocurrency theft', 'drained', 'counterfeit*', 'forged', 'forgery',
      'identity verification', 'liveness', 'pump-and-dump', 'ponzi', 'clickfix',
      'strong customer authentication',
    ],
    weak: ['theft', 'stole', 'stolen', 'fake', 'spoof*', 'lure*', 'victims'],
  },
  ai: {
    strong: [
      'generative ai', 'genai', 'gen ai', 'large language model*', 'cs:LLM', 'cs:LLMs', 'ai agent*', 'agentic',
      'ai-powered', 'ai-driven', 'ai-assisted', 'ai-generated', 'prompt injection', 'jailbreak*',
      'model poisoning', 'data poisoning', 'model extraction', 'model inversion', 'deepfake*',
      'frontier model*', 'foundation model*', 'ai act', 'ai safety', 'ai model*', 'autonomous agent*',
      'cs:MCP', 'model context protocol', 'chatbot*', 'ai system*', 'ai risk*', 'ai governance',
      'computer-use agent*', 'coding agent*', 'artificial intelligence', 'machine learning',
      'misaligned model*', 'misaligned ai', 'rogue ai', 'rogue agent*', 'rogue model*', 'agentic hack*', 'ai agent hack*',
    ],
    medium: [
      'cs:AI', 'chatgpt', 'openai', 'anthropic', 'cs:Claude', 'cs:Gemini', 'copilot', 're:\\bGPT(?:-\\d[\\w.]*)?\\b',
      'hallucinat*', 'automated decision*', 'model risk', 'adversarial', 'shadow ai', 'custom gpts',
      'neural network*', 'training data', 'misalign*',
    ],
    // generic supervisory wording for AI and other new technology ("new supervisory priority on
    // digital innovation ... oversee the use of new technologies"); weak, so never enough alone
    weak: ['algorithm*', 'autonomous', 'agents', 'automation', 'new technolog*', 'emerging technolog*', 'digital innovation'],
  },
  data: {
    strong: [
      'data breach*', 'data leak*', 'data exposure', 'exposed database*', 'leaked database*', 'personal data',
      'personally identifiable', 'cs:PII', 'customer data', 'records exposed', 'exfiltrat*', 'data theft',
      'stolen data', 'cs:GDPR', 'data protection', 'privacy breach', 'unsecured database*', 's3 bucket*',
      'exposed secrets', 'leaked credentials', 'data broker*', 'data residency', 'data sovereignty',
      'data locali*', 'data retention', 'data governance', 'data lineage', 'data quality',
    ],
    medium: [
      'records', 'database*', 'privacy', 'leak', 'leaks', 'leaked', 'exposed', 'sensitive data',
      'sensitive information', 'confidential', 'dataset*', 'personal information', 'social security number*',
      'health data', 'medical records', 'encryption key*', 'secrets', 'api key*', 'scrap*', 'surveillance',
    ],
    weak: ['data', 'information', 'files', 'documents', 'tracking'],
  },
  resilience: {
    strong: [
      'operational resilience', 'outage*', 'service disruption*', 'business continuity', 'disaster recovery',
      'impact tolerance*', 'severe but plausible', 'concentration risk', 'single point of failure',
      'systemic risk', 'cs:DORA', 'digital operational resilience', 'sheltered harbo*', 'cyber resilience',
      'recovery time', 'immutable backup*', 'destructive attack*', 'shut down systems', 'downtime',
      'degraded service*', 'blackout*', 'undersea cable*', 'subsea cable*', 'gps spoofing', 'cs:GNSS',
      'jamming', 'multi-region', 'multiple regions', 'cross-region', 'several regions', 'connectivity issue*',
      'connectivity loss', 'loss of connectivity', 'network connectivity', 'service degradation',
      'degraded performance', 'post-incident review*', 'post-incident report*', 'root cause analysis',
      're:\\b(?:told|tells|tell|urg(?:es|ed)|advis(?:es|ed)|instruct(?:s|ed)|ask(?:s|ed)|warn(?:s|ed))\\b[^.;:]{0,20}\\bcustomers\\b[^.;:]{0,15}\\bto\\s+(?:power|shut|take|turn)(?:\\s+\\w+){0,4}?\\s+(?:down|off|offline)\\b',
    ],
    medium: [
      'disruption*', 'disrupted', 'resilien*', 'continuity', 'recovery', 'restore*', 'backup*', 'failover',
      'redundan*', 'contingency', 'crisis', 'incident response', 'critical infrastructure', 'air traffic',
      'power grid', 'telecom*', 'data cent*', 'availability', 'crash*', 'offline', 'halted', 'destructive',
      'shutdown', 'shut down', 'connectivity', 'degraded', 'degradation', 'post-incident', 'root cause',
      'status page', 'expressroute', 'availability zone*', 'intermittent', 'increased latency',
      'request failures', 'interrupted', 'power down', 'powered down', 'powering down', 'power off', 'take offline', 'taken offline',
      // incident-reporting duties in supervisory instruments (DORA major ICT-related incidents,
      // US computer-security incident notification)
      'ict-related incident*', 'ict incident*', 'incident reporting', 'incident notification*',
    ],
    weak: ['incident', 'failure*', 'glitch*', 'stability', 'delays', 'gateway*', 'cs:VPN', 'latency', 'mitigated'],
  },
  third_party: {
    strong: [
      'third-party risk', 'third-party', 'supply chain*', 'software supply chain', 'fourth-party', 'nth-party',
      'vendor compromise', 'vendor breach', 'supplier breach', 'managed service provider*', 'cs:MSP',
      'cs:MSPs', 'critical third part*', 'critical ict', 'cs:CTPP', 'outsourc*', 'service provider*',
      'npm package*', 'cs:PyPI', 'malicious package*', 'open-source package*', 'dependency confusion',
      'typosquat*', 'cs:SBOM', 'software bill of materials', 'cloud service provider*', 'hyperscaler*',
    ],
    medium: [
      'vendor*', 'supplier*', 'contractor*', 'cs:npm', 'github', 'open source', 'open-source', 'librar*',
      // browser and IDE extensions, not "extensions of credit" or a comment-period extension
      'plugin*', 're:\\bextensions?\\b(?!\\s+of\\s+(?:credit|time|the\\s+(?:comment|deadline|compliance)|comment|deadline))',
      'integration*', 'cs:SaaS', 'cs:RMM', 'remote monitoring and management',
      'screenconnect', 'connectwise', 'kaseya', 'solarwinds', 'moveit', 'file transfer', 'oauth app*',
      'third-party app*', 'subcontract*', 'concentration', 'core provider*', 'core banking', 'core processor*',
    ],
    weak: ['provider*', 'partner*', 'cloud', 'platform*'],
  },
  risk_quantification: {
    strong: [
      'risk quantification', 'cyber risk quantification', 'quantif*', 'loss estimate*', 'expected loss*',
      'tail risk', 'value at risk', 'loss event*', 'loss data', 'operational risk capital',
      'capital requirement*', 'stress test*', 'scenario analysis', 'risk appetite', 'key risk indicator*',
      'cs:KRI', 'cs:KRIs', 'cs:KPI', 'cs:KPIs', 'risk metric*', 'insured loss*', 'insurance loss*',
      'cyber insurance', 'catastrophe model*', 'actuarial', 'loss exceedance', 'cost of a data breach',
      'economic loss*', 'financial loss*', 'model validation', 'risk model*', 'risk assessment*',
    ],
    medium: [
      // 'insurance', but not in the name of the Federal Deposit Insurance Corporation (every FDIC lead)
      'losses', 'estimate*', 'survey*', 'benchmark*', 'metrics', 're:\\b(?<!deposit\\s)insurance\\b', 'insurer*', 'premium*',
      'exposure*', 'likelihood', 'probability', 'materiality', 'model risk',
      're:(?:[$£€]|\\b(?:usd|eur|gbp|us\\$))\\s?\\d[\\d.,]*\\s?(?:million|billion|trillion|bn|m|b)\\b',
    ],
    weak: ['cost', 'costs', 'loss', 'capital', 'board', 'disclosure*', 'risk management'],
  },
};

/** Evidence that an item matters. Groups score their best match only. */
export const MATERIALITY_GROUPS = {
  exploitation: {
    3: ['actively exploited', 'exploited in the wild', 'in the wild', 'under active exploitation', 'zero-day*',
      '0-day*', 'cs:KEV', 'known exploited', 'mass exploitation', 'emergency directive', 'exploited'],
    2: ['exploitation', 'weaponi*', 'emergency patch*', 'out-of-band', 'proof-of-concept', 'cs:PoC', 'wormable'],
  },
  severity: {
    2: ['max severity', 'maximum severity', 're:\\bcvss(?: score)?(?: of)? (?:9(?:\\.\\d)?|10(?:\\.0)?)\\b', 'unauthenticated',
      'pre-auth*', 'superuser', 'root access', 'admin access'],
    1: ['critical', 'high-severity', 'severe'],
  },
  scale: {
    3: ['re:\\b\\d[\\d.,]*\\+?\\s?(?:million|billion|m|bn)\\s+(?:people|customers|users|records|accounts|individuals|patients|members|clients|citizens|consumers|cardholders|victims)\\b',
      'global outage', 'worldwide outage'],
    2: ['re:(?:[$£€]|\\b(?:usd|eur|gbp|us\\$))\\s?\\d[\\d.,]*\\s?(?:million|billion|bn|m|b)\\b', 'millions of', 'billions',
      'widespread', 're:\\b\\d{2,}[\\d,]*\\+?\\s+(?:organi[sz]ations|orgs|companies|firms|banks|victims|customers|entities|institutions|packages|repositories|servers|devices|instances|hosts|websites|sites|endpoints|apps|accounts|tenants)\\b',
      'thousands of'],
    1: ['hundreds of', 'mass', 'worldwide', 'globally', 'sector-wide', 'industry-wide'],
  },
  // A loss from one hack, theft or fraud, stated with its amount (FILTER.md E2c): "$388 million hack",
  // "stole $25m", "drained $40m". Counts on top of the scale group's amount.
  loss: {
    3: ['re:(?:[$£€]|\\b(?:usd|eur|gbp|us\\$))\\s?\\d[\\d.,]*\\s?(?:million|billion|bn|m|b)\\b[^.;:]{0,40}\\b(?:hack(?:s|ed)?|heists?|thefts?|stolen|stole|drain(?:s|ed)?|exploits?|scams?|fraud)\\b',
      're:\\b(?:hack(?:s|ed|ers)?|heists?|thefts?|stole|stolen|drain(?:s|ed)?|exploit(?:s|ed)?|scam(?:s|med|mers)?|fraud(?:sters)?)\\b[^.;:]{0,40}(?:[$£€]|\\b(?:usd|eur|gbp|us\\$))\\s?\\d[\\d.,]*\\s?(?:million|billion|bn|m|b)\\b'],
  },
  // A provider's failure across regions or services: shared-dependency scale.
  multi_region: {
    2: ['multi-region', 'multiple regions', 'cross-region', 'several regions', 'all regions', 'multiple services',
      'multiple availability zones'],
  },
  // A technical post-incident report: the root cause a later item may need (FILTER.md M1).
  post_incident: {
    2: ['post-incident review*', 'post-incident report*', 'post-mortem*', 'postmortem*', 'root cause*',
    ],
  },
  novelty: {
    2: ['new technique*', 'novel', 'unprecedented', 'first-ever', 'autonomous', 'self-propagating', 'systemic',
      'critical infrastructure', 'goes rogue', 'off-script', 'sandbox escape*', 'bypass*'],
    1: ['first', 'new', 'emerging', 'evolving', 'rising', 'surge*', 'record'],
  },
  // Compromise that propagates through shared dependencies.
  propagation: {
    2: ['supply chain attack*', 'supply-chain compromise', 'software supply chain', 'malicious package*', 'worm*',
      'self-propagating', 'mass compromise', 'cascad*', 'downstream customers', 'knock-on'],
  },
  // Adversary capability shift: AI used offensively.
  capability: {
    2: ['re:\\b(?:AI|LLMs?|agentic|autonomous|AI agents?)\\b[^.;:]{0,60}\\b(?:hack(?:ed|ing|s)?|attack(?:ed|s|ing)?|exploit(?:ed|s|ing)?|breach(?:ed|es)?|phish(?:ed|ing)?|intrusions?|sql injection|ransomware|malware|break(?:s|ing)? in(?:to)?|broke into|accessed|probed|probing)\\b',
      're:\\b(?:hack(?:ers?|ing)?|attackers?|threat actors?|criminals?|scammers?|fraudsters?)\\b[^.;:]{0,60}\\b(?:use|uses|used|using|abuse|abuses|abused|deploy|deploys|weaponi[sz]e\\w*|turn|turns)\\b[^.;:]{0,30}\\b(?:AI|LLMs?|ChatGPT|GPTs?|Gemini|Claude|deepfakes?|agents?)\\b'],
  },
  // A control failed in a way others rely on.
  control_failure: {
    2: ['re:\\bbypass(?:es|ed|ing)?\\b[^.;:]{0,40}\\b(?:controls?|guardrails?|safeguards?|restrictions?|mfa|multi-factor|authentication|detection|sandbox|edr|waf|filters?)\\b',
      'went undetected', 'undetected for', 'failed to detect', 'evade* detection', 'despite existing defen*',
      'despite mfa', 'unauthori* actions', 'unauthori* transactions', 'control failure*', 'controls failed',
      'guardrail-free', 'without consent', 'without authori*', 'unauthori* access', 'misaligned', 'rogue'],
  },
  soft_signal: {
    2: ['speech', 'remarks', 'testimony', 'testif*', 'hearing', 'consultation*', 'discussion paper',
      'dear ceo', 'supervisory', 'call for evidence', 'interview', 'keynote', 'warns', 'warning', 'expects',
      'priorities', 'roadmap'],
    1: ['guidance', 'principles', 'framework', 'report', 'statement', 'letter', 'sanction*', 'advisory'],
  },
  // A formal instrument or exam notice (owner decision 2026-10-03: newly issued ones are in scope
  // in the regulatory_trajectory section). Counts only when a domain qualifies (DOMAIN_GATED_GROUPS):
  // an off-domain rule gains nothing. Newness and materiality are judged at stage 2.
  formal_instrument: {
    2: [
      // formal rules and their final-form equivalents
      'final rule*', 'interim final rule*', 'final regulation*', 'final requirements',
      'regulatory technical standard*', 'implementing technical standard*', 'cs:RTS', 'cs:ITS',
      'delegated regulation*', 'implementing regulation*', 'delegated act*', 'implementing act*',
      'final guideline*', 'final guidance', 'supervisory statement*', 'policy statement*',
      // PRA supervisory and policy statements (SS1/26, PS7/26), FCA policy statements and finalised
      // guidance (PS26/19, FG26/9)
      're:\\b(?:SS|PS|FG)\\s?\\d{1,2}/\\d{1,2}\\b', 'industry letter*', 'circular letter*',
      're:\\bcircular\\s+(?:no\\.?\\s*)?\\d{1,4}(?:[/-]\\d{1,4})+\\b',
      're:\\b(?:issues?|issued|publish(?:es|ed)?|adopts?|adopted|amends?|amended|revis(?:es|ed))\\b[^.;:]{0,40}\\bcircular\\b',
      'cs:SR letter*', 're:\\bSR\\s?\\d{2}-\\d{1,2}\\b', 'supervision and regulation letter*',
      'cs:FIL', 're:\\bFIL-\\d{1,3}-\\d{4}\\b', 'financial institution letter*',
      'cs:OCC Bulletin', 're:\\bbulletin\\s+(?:OCC\\s+)?\\d{4}-\\d{1,3}\\b',
      // exam notices
      'examination procedure*', 'exam procedure*', 'examination handbook', 'exam handbook', 'cs:IT Handbook',
      "comptroller's handbook", 'handbook booklet*', 'examination manual*', 'examination priorit*', 'exam priorit*',
      'examination plan*', 'supervisory priorit*', 'supervision priorit*', 'supervision work program*',
      'supervisory work program*', 'examination program*', 'exam program*',
    ],
    1: ['finali*', 'final version', 'rescind*', 'rescission*', 'examiner*', 'guidelines',
      're:\\badopts?\\b[^.;:]{0,40}\\b(?:rules?|regulations?|guidelines|standards|amendments)\\b'],
  },
};

/**
 * Materiality groups that count only when the candidate has a qualifying domain, so their
 * vocabulary never lifts the score of an off-domain item.
 */
export const DOMAIN_GATED_GROUPS = Object.freeze(['formal_instrument']);

/**
 * Prudential and accounting vocabulary with no technology content (FILTER.md §3.3: market, credit
 * and liquidity risk modelling are not in scope; capital calibration and accounting rules are
 * off-domain). A candidate whose only qualifying domain is risk_quantification, with no medium or
 * strong term of any other domain, that matches one of these and none of TECH_CONTENT is off domain.
 */
export const NON_TECH_PRUDENTIAL = Object.freeze([
  'capital requirement*', 'capital ratio*', 'capital buffer*', 'capital plan*', 'capital rule*', 'capital framework*',
  'capital treatment', 'capital and liquidity', 'stress capital buffer', 'stress test*', 'leverage ratio*', 'cs:eSLR',
  'cs:SLR', 'liquidity', 'output floor', 'basel iii', 'risk-weighted', 'risk weight*', 'credit risk', 'market risk',
  'interest rate risk', 'counterparty credit', 'expected credit loss*', 'credit loss*', 'cs:ECL', 'cs:IFRS', 'cs:CECL',
  // deposit insurance as a topic, not the Federal Deposit Insurance Corporation named in a lead
  'accounting', 're:\\bdeposit insurance\\b(?!\\s+corporation)', 'resolution plan*', 'resolution planning', 'own funds',
  'solvency', 'cs:MREL', 'cs:TLAC', 'loss-absorbing', 'prudential requirement*', 'climate', 'mortgage*',
]);

/** Technology content that keeps a risk_quantification-only candidate in scope despite NON_TECH_PRUDENTIAL. */
export const TECH_CONTENT = Object.freeze([
  'operational risk', 'non-financial risk', 'technolog*', 'digital*', 'cs:ICT', 'cs:IT', 'loss event*', 'loss data',
  'model risk', 'risk quantification', 'key risk indicator*', 'cs:KRI', 'cs:KRIs', 'cloud', 'software', 'algorithm*',
  'automat*',
]);

/** Financial-sector relevance. Named institutions (institutions.mjs) also count as sector. */
export const SECTOR_TERMS = {
  3: [
    'bank', 'banks', 'banking', 'banker*', 'financial institution*', 'financial services', 'financial sector',
    'financial system', 'financial stability', 'fintech*', 'payment*', 'credit card*', 'debit card*',
    'payment card*', 'card network*', 'cs:ATM', 'cs:ATMs', 'jackpotting', 'cs:SWIFT', 'wire transfer*',
    'cs:ACH', 'nacha', 'fednow', 'real-time payment*', 'instant payment*', 'faster payment*', 'open banking',
    'stablecoin*', 'crypto exchange*', 'cryptocurrency exchange*', 'broker-dealer*', 'brokerage*',
    'asset manager*', 'insurer*', 'reinsurer*', 'clearing house*', 'clearinghouse*', 'central bank*',
    'federal reserve', 'cs:Fed', 'cs:ECB', 'bank of england', 'cs:PRA', 'cs:FCA', 'cs:OCC', 'cs:FDIC',
    'cs:SEC', 'cs:CFTC', 'cs:FINRA', 'cs:FFIEC', 'cs:CFPB', 'cs:EBA', 'cs:ESMA', 'cs:EIOPA', 'cs:FSB',
    'cs:BIS', 'basel', 'cs:IOSCO', 'cs:CPMI', 'fs-isac', 'sheltered harbo*', 'cs:DORA', 'cs:NYDFS',
    'market infrastructure*', 'cs:FMI', 'cs:FMIs', 'stock exchange*', 'money laundering', 'cs:AML',
    'cs:KYC', 'mule*', 'lender*', 'credit union*', 'deposit*', 'treasury department', 'cs:FinCEN',
    'cs:OFAC', 'cs:PSD2', 'cs:PSD3', 'cs:PSR', 'card fraud', 'payments system*',
  ],
  1: ['insurance', 'trading', 'investor*', 'loan*', 'lending', 'mortgage*', 'settlement', 'clearing',
    'treasury', 'tokeni*', 'cryptocurrenc*', 'crypto', 'sanction*', 'finance', 'financial'],
};

/** Ubiquitous enterprise technology: compromise or failure here touches most organisations. */
export const ENTERPRISE_TERMS = {
  2: [
    'microsoft', 'sharepoint', 'exchange server', 'cs:Exchange', 'active directory', 'entra', 'azure',
    'office 365', 'microsoft 365', 'cs:AWS', 'amazon web services', 'google cloud', 'oracle', 'peoplesoft',
    'cs:SAP', 'salesforce', 'cisco', 'fortinet', 'fortigate', 'fortimail', 'fortios', 'citrix', 'netscaler',
    'ivanti', 'palo alto', 'pan-os', 'globalprotect', 'vmware', 'esxi', 'vcenter', 'cs:F5', 'big-ip',
    'juniper', 'sonicwall', 'check point', 'okta', 'crowdstrike', 'cloudflare', 'atlassian', 'confluence',
    'jira', 'moveit', 'servicenow', 'snowflake', 'github', 'gitlab', 'openssl', 'kubernetes', 'zimbra',
    'veeam', 'kiteworks', 'goanywhere', 'workday', 'zscaler', 'screenconnect', 'connectwise',
  ],
};

/** General noise (standard, strict and high_volume profiles). */
const NOISE_GENERAL = {
  3: ['re:\\b\\d+\\s+(?:ways|tips|steps|things|reasons|lessons|questions|mistakes|myths|signs|tricks)\\b',
    'how to', 'best practices', 'buyer\'s guide', 'checklist', 'explained', 'explainer', 'the case for',
    'what you need to know', 'cs:Sibos', 're:^(?:how|why|what|when|where|who|is|are|can|should|do|does|will)\\b',
    're:\\?\\s*$'],
  2: ['opinion',
    'q&a', 'interview', 'conversations', 'arrest*', 'sentenced', 'prison', 'jail*', 'pleads guilty',
    'pleaded guilty', 'extradit*', 'indicted', 'convicted', 'charged', 'acquire*', 'acquisition*',
    'to buy', 'merger', 'windows 11', 'insider preview', 'new feature*', 'gaming', 'cs:Xbox',
    'playstation', 'nintendo', 'smart tv*', 'review:', 'deals', 'stories', 'career*', 'talent',
    'esg', 'green finance'],
  1: ['patch', 'patches', 'patched', 'fixes', 'fixed', 'update', 'updates', 'by default', 'android',
    'cs:iOS', 'chrome', 'firefox', 'guide', 'lessons', 'tips', 'cs:ICS', 'cs:SCADA', 'cs:PLC',
    'industrial control*', 'firmware', 'camera*', 'dashcam', 'cs:IoT', 'controller*', 'cellular gateway',
    'cs:OT', 'takedown', 'dismantl*', 'seize*', 'police', 'exploit details', 'technical details',
    'deep dive', 'anatomy of', 'inside the'],
};

/** Vendor-survey framing in news (not applied to research_analysis sources, where findings are the point). */
const NOISE_FINDINGS = {
  2: ['survey finds', 'research finds', 'study finds', 'report finds', 'report reveals', 'survey reveals',
    'survey shows', 'study shows', 're:\\b\\d{1,3}% of (?:cisos|organi[sz]ations|companies|firms|respondents|leaders)\\b'],
};

/** Academic method vocabulary (high-volume preprint feeds): defensive-method papers rarely move the bar. */
const NOISE_ACADEMIC = {
  1: ['a survey', 'systemati*', 'cs:SoK', 'towards', 'framework*', 'mechanism*', 'approach*', 'benchmark*',
    'dataset*', 'detection', 'defen*', 'mitigat*', 'via', 'using', 'evaluat*', 'formal*', 'verif*', 'proof*',
    'taxonomy', 'architecture*', 'secure aggregation', 'federated'],
};

/**
 * Noise for lenient (regulator / standards body) sources: macro, governance admin, statistics.
 * Formal rules and exam notices are not noise (owner decision 2026-10-03): they score in the
 * formal_instrument materiality group; off-domain capital and accounting rules fall to
 * NON_TECH_PRUDENTIAL instead.
 */
const NOISE_REGULATORY = {
  3: ['appointment*', 'appoints', 'approval of application', 'approves application', 'minutes of',
    'monetary policy', 'interest rate*', 'policy rate', 'base rate', 'inflation', 'economic outlook',
    'press conference', 'news conference', 'annual report', 'job vacanc*', 'graduate programme',
    'anniversary', 'green finance', 'climate', 'sustainable finance', 'banknote*', 'coin*'],
  2: ['enforcement action',
    'termination of enforcement', 'economy', 'economic conditions', 'labor market', 'labour market',
    'quantitative tightening', 'balance sheet', 'governing council', 'statistical release', 'statistics',
    'welcoming address', 'convening remarks', 'opening remarks', 'introductory remarks', 'dual mandate',
    'financial inclusion', 'agenda'],
  1: ['decisions taken', 'resolution plan*', 'capital plan*', 'merger', 'launch of'],
};

export const NOISE = Object.freeze({
  general: NOISE_GENERAL,
  findings: NOISE_FINDINGS,
  academic: NOISE_ACADEMIC,
  regulatory: NOISE_REGULATORY,
});

/** Principally-marketing items: dropped outright (not applied to regulator / standards_body). */
export const MARKETING_PATTERNS = [
  ['webinar', /\bwebinars?\b/i],
  ['register now', /\bregister (?:now|today|here)\b/i],
  // A content label only: "state-sponsored" attackers and a bill "sponsored by" a legislator are not marketing.
  ['sponsored', /(?<![\w-])sponsored\s+(?:content|post|article|feature|story|message|webinar)\b|^\s*\[?sponsored(?:\s+by\b[^:|\]]*)?\]?\s*[:|\-–]|[(\[]sponsored[)\]]|\bpartner content\b|\bbrought to you by\b|\bpaid (?:post|content)\b|\badvertorial\b/i],
  ['partners with', /\bpartner(?:s|ed|ing)? with\b|\bpartnership with\b|\bteams? up with\b|\bjoins forces\b|\bjoin forces\b|\btaps\b.{0,40}\bfor\b/i],
  ['funding round', /\b(?:raises?|raised|secures?|secured|lands?|landed|bags?|nets?|closes?)\b.{0,50}(?:[$£€]\s?\d|\b\d[\d.,]*\s?(?:million|m|bn|billion)\b)|\bseries [a-f]\b|\b(?:pre-)?seed round\b|\bfunding round\b|\bfundrais/i],
  ['award', /\bawards?\b|\bwins?\b.{0,40}\b(?:prize|accolade|title)\b|\bshortlisted\b|\bfinalist\b/i],
  ['named a leader', /\bnamed (?:a |the )?(?:leader|winner|visionary|challenger)\b|\brecogni[sz]ed as (?:a |the )?leader\b|\bmagic quadrant\b|\bforrester wave\b|\bgartner (?:peer|hype)\b/i],
  ['now available', /\bnow available\b|\bgenerally available\b|\bgeneral availability\b|\bavailable now\b/i],
  ['download', /\bfree (?:trial|e-?book|guide|download|assessment)\b|\be-?book\b|\bwhite ?paper\b|\bdatasheet\b|\bjoin us\b|\blive demo\b|\bon-demand\b|\bsave your seat\b/i],
  ['appointment', /\bappoint(?:s|ed|ment)\b|\bnames\b.{0,60}\b(?:ceo|cfo|cto|ciso|coo|chief|president|chair|head of)\b|\bhires\b|\bjoins as\b|\bpromoted to\b|\bsteps down\b/i],
  ['product launch', /\b(?:launch(?:es|ed)?|unveil(?:s|ed)?|introduc(?:es|ed)|debut(?:s|ed)?|rolls? out|rolled out|releases?|released|expands?|announc(?:es|ed)|adds)\b.{0,80}\b(?:platform|solution|product|suite|toolkit|offering|feature|features|capabilit(?:y|ies)|module|app|assistant|copilot|integration|partnership|programme|program|service|services|tool|tools|agents?|bot|chatbot|model|models|version|edition)\b/i],
];

/** A product-launch match is ignored when the subject is plainly an adversary. */
export const ADVERSARY_SUBJECT = /\b(?:attackers?|hackers?|threat actors?|gangs?|criminals?|scammers?|fraudsters?|cybercriminals?|apt\s?\d*|ransomware|malware|botnet|state-sponsored|nation-state|operators)\b/i;

/**
 * A product-launch or "now available" match is ignored when the subject is an authority: news of
 * a formal instrument ("Fed announces final rule ... for service providers", "FFIEC releases
 * updated cybersecurity assessment tool") is not marketing. Acronyms are case-sensitive.
 */
export const AUTHORITY_SUBJECT = /\b(?:SEC|OCC|FDIC|FFIEC|CFPB|FINRA|NYDFS|DFS|FCA|PRA|ECB|EBA|ESMA|EIOPA|ESAs?|NIST|CISA|NCSC|ENISA|FSB|BCBS|IOSCO|FinCEN|Fed)\b|\b(?:[Rr]egulators?|[Ss]upervisors?|[Aa]gencies|[Aa]uthorit(?:y|ies)|[Cc]entral [Bb]anks?|Federal Reserve|Treasury|Bank of England|European Commission|Commission|Congress|Senate|[Ll]awmakers|[Ll]egislators|Basel Committee|Comptroller)\b/;

/** Roundups and digests: dropped outright for every class. */
export const ROUNDUP_PATTERNS = [
  ['roundup', /\bweekly recap\b|\bin other news\b|\bweek in review\b|\bthis week in\b|\bproducts of the week\b|\bnewsletter\b|\bpodcast\b|\bthreatsday\b|\btop stories\b|\bdaily digest\b|\bweekly digest\b|\broundup\b|\bround-up\b|\bwhat we missed\b/i],
];

/**
 * Event listings (webinars, conferences, workshops), recognised by a whole URL path segment:
 * dropped outright for every class, because an event announcement is never a development
 * (FILTER.md G3, G6). Finextra's sponsored webinars live under /event-info/, NIST workshops under
 * /news-events/events/. Feeds date them on the event day, so they reach the window once the event
 * is less than FUTURE_TOLERANCE_HOURS ahead or has passed.
 */
export const EVENT_URL_SEGMENTS = Object.freeze([
  'event', 'events', 'event-info', 'event-details', 'events-calendar', 'event-calendar', 'webinar', 'webinars',
  'on-demand-webinar', 'on-demand-webinars', 'virtual-event', 'virtual-events',
]);

/**
 * A headline that is only an instrument's identifier ("SR 26-2", "SR 90-36 (FIS)", "FIL-45-2026",
 * "PS7/26", "OCC Bulletin 2026-48"): the Federal Reserve's SR-letter feed puts the title in the
 * description. Such a candidate is scored with its lead as part of the headline.
 */
export const BARE_ID_HEADLINE = /^\s*(?:(?:OCC\s+)?Bulletin|SR|CA|FIL|PS|SS|CP|DP|FG|GC|Circular(?:\s+Letter)?|Industry\s+Letter)\s*(?:No\.?\s*)?[A-Z]{0,3}-?\d{1,4}(?:[-/.]\d{1,4})*(?:\s*\([A-Z]{2,6}\))?\s*$/i;

/** CISA's own "Adds N Known Exploited Vulnerabilities to Catalog" posts duplicate the KEV source. */
export const KEV_ANNOUNCEMENT = /^CISA Adds .{0,40}Known Exploited Vulnerabilit(?:y|ies) to (?:the )?Catalog/i;
