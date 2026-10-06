# Readiness Signal — build contract

This file is the single contract the site, the pipeline and the tests are built against.
Where it is silent, the owner's brief governs; where the brief is silent, the approved
design (`.design-handoff/project/Readiness Signal.dc.html`, local only, never committed)
governs. **Where the design and the brief disagree on behaviour, the brief wins.**

## 1. What this is

A static, stateless, publicly hosted technology-risk triage archive. A filter, not a feed.
Four scheduled runs a day surface only items clearing a deliberately high materiality bar,
each tagged with exactly one mechanism saying what it wants from the reader. Runs are silent
when nothing clears. Items are append-only; editions never overwrite.

### Hard constraints (binding everywhere)

1. **Fully static.** No backend, no database, no server-side send, no auth, no
   `localStorage`/`sessionStorage`/IndexedDB/cookies. UI state lives in memory and the URL hash.
2. **Public sources only.** No paywalled or licensed content. For paywalled publications,
   headline and lead-level reference only — never fetch, quote or paraphrase body text.
3. **Nothing attributable to any specific financial institution's position.** No generated
   text may state, imply or hint at any institution's internal control, exposure, risk or
   remediation position. Validation questions, candidate issue statements and awareness
   rationales are generic to any risk professional at any institution. No first-person
   voice (`we`, `our`, `us`, `I`, `my`) anywhere in generated text. Claims may report what
   public sources say happened to, or was said publicly by, an organisation. **Launch
   setting (stricter):** no financial institution is named in any generated field, claims
   included; a category form is used ("a large US bank", "a G-SIB chief executive").
   Knob `claims_may_name_institutions` in `pipeline/thresholds.json` (launch `false`).
4. **Desktop and mobile.** Every page works from 320 px to 1600 px wide, touch and mouse.
5. **No monospace type** anywhere (owner preference). Use the sans with tabular numerals.

## 2. Hosting

- Repo `WowItWorked/Readiness-Signal`, GitHub Pages **deploy from branch `main`, folder `/docs`**.
- Served as a project sub-site of the user site (CNAME `emergingtechrisk.com`):
  `https://emergingtechrisk.com/Readiness-Signal/`. **All URLs in the site are relative**
  (`data/archive.json`, `assets/app.js`) so it works under any base path. The one exception is
  the permalink that leaves the page (email, Copy link, print): it is always the absolute live
  URL, `SITE_URL` in `docs/assets/model.js`. No CNAME file in this repo. `docs/.nojekyll` present.
- No build step. Plain ES modules, no framework, no runtime CDN scripts. Google Fonts only
  (IBM Plex Sans 400/500/600; Source Serif 4 opsz 8..60, 400/500/600, italic 400).

## 3. Data model

### 3.1 `docs/data/archive.json`

```json
{ "schema_version": 1, "items": [ /* Item, in append order (oldest first) */ ] }
```

### 3.2 Item

| field | type | rule |
|---|---|---|
| `id` | string | `RS-YYMMDD-HHMM-NN`; date/time = edition slot in ET; `NN` = 01.. within the edition. Unique, immutable. Used as permalink anchor. |
| `timestamp` | string | ISO 8601 with ET offset, e.g. `2026-10-02T14:00:00-04:00`. Live items: the edition slot time (not the actual run time). |
| `section` | enum | `executive_visibility` \| `capability_shift` \| `regulatory_trajectory` |
| `claim` | string | One line, ~12 words (hard limits 6–22), an assertion of fact, not a headline teaser. |
| `domains` | enum[] | 1–7 unique of `cyber`, `fraud`, `ai`, `data`, `resilience`, `third_party`, `risk_quantification`. Primary domains first. |
| `source_class` | enum | Class of the primary source: `news` \| `regulator` \| `standards_body` \| `industry_trade` \| `vendor_threat_research` \| `research_analysis` |
| `mechanism` | enum | Exactly one: `candidate_issue` \| `kri_kpi` \| `praf_coverage` \| `awareness_only` |
| `interpretation` | object[] | Cross-domain implication, one entry per affected domain: `{ "domain": <domain enum>, "text": string ≤ 60 words }`. Must cover every tagged domain; may add others. Unique domains. Order: tagged domains first. |
| `validation_question` | string \| null | Short, paste-ready, ends with `?`, ≤ 40 words. **Null iff `awareness_only`.** |
| `candidate_issue_statement` | string \| null | Conditional, phrased as a control weakness with consequence: begins `Where …` or `If …`, weakness clause then consequence clause, ≤ 70 words. **Null iff `awareness_only`.** |
| `awareness_rationale` | string \| null | **Present iff `awareness_only`** (owner decision). Why no control, metric or framework action follows — institution-neutral, ≤ 70 words. |
| `sources` | object[] | ≥ 1, unique URLs: `{ "publication": string, "url": https string, "headline"?: string ≤ 200, "published"?: "YYYY-MM-DD", "source_class"?: <class enum> }`. Required keys are the brief's `{publication, url}`; the optional keys are headline-level reference only. A source's class defaults to the item's `source_class`. First source = primary. |
| `backfilled` | boolean | Default `false`. `true` only for items from the separate historical backfill pass. |
| `update_of` | string \| null | Optional. Id of an earlier item this one materially updates (owner decision on dedup: a resurfacing story is dropped unless there is a material update, which becomes a new item linked here). |

Generated-text fields: `claim`, `interpretation[].text`, `validation_question`,
`candidate_issue_statement`, `awareness_rationale`.

### 3.3 `docs/data/runs.json`

Every scheduled run appends exactly one record, whether it published or was silent. This is
the per-run calibration log (mechanism distribution) and the site's source of truth for
edition counts. A silent run is logged but is **not** an edition.

```json
{ "schema_version": 1, "runs": [ {
  "run_id": "2026-10-02-1400",
  "slot": "2026-10-02T14:00:00-04:00",
  "started_at": "2026-10-02T14:03:12-04:00",
  "finished_at": "2026-10-02T14:21:40-04:00",
  "status": "published | silent | failed",
  "items": ["RS-261002-1400-01"],
  "threshold_level": "high",
  "funnel": { "sources_ok": 0, "sources_failed": 0, "fetched": 0, "in_window": 0, "unseen": 0,
              "stage1_pass": 0, "stage2_pass": 0, "dedup_dropped": 0, "published": 0 },
  "stage2_by_section": { "executive_visibility": {"tested": 0, "passed": 0},
                         "capability_shift": {"tested": 0, "passed": 0},
                         "regulatory_trajectory": {"tested": 0, "passed": 0} },
  "mechanism_distribution": { "candidate_issue": 0, "kri_kpi": 0, "praf_coverage": 0, "awareness_only": 0 },
  "notes": "≤ 280 chars, optional"
} ] }
```

### 3.4 Pipeline state and logs (committed, outside `/docs`)

- `pipeline/state/seen.json` — `{ "schema_version": 1, "urls": { "<normalised url>": { "first_seen": ISO, "run_id": str, "verdict": "published|dropped|duplicate", "item_id": str|null } } }`. Pruned to 120 days. Stops the same candidate being re-judged every run. Written only by `publish.mjs` (judged survivors and item sources; candidates dropped as `GL_NOT_JUDGED` are not recorded, so they are re-collected next run).
- `pipeline/logs/YYYY/MM/<run_id>.jsonl` — one JSON line per stage-1 survivor with its stage-2
  verdict, reason code, one-line reason and dedup outcome. Calibration review reads these.
- `pipeline/work/<run_id>/` — scratch, git-ignored.

## 4. Edition slots and time

- Slots: **06:00, 10:00, 14:00, 18:00 America/New_York** (brief; the design's 06:30/11:00/15:30/20:00 is superseded).
- A run's slot = the latest slot at or before its start time (ET, DST-aware). If a run record
  for that slot already exists, the run exits without doing anything (idempotent).
- All site times display in ET regardless of viewer timezone, e.g. `Fri 2 Oct 2026, 14:00 ET`.

## 5. Pipeline (executed by a scheduled Claude routine; see `pipeline/RUNBOOK.md`)

Cloud routine, cron `CRON_TZ=America/New_York 5 6,10,14,18 * * *` (minute 5, so a scheduler
that fires a few seconds early still lands in the intended slot; the edition timestamp is the
slot time), checks out the repo, follows `pipeline/RUNBOOK.md` (binding) and
`pipeline/FILTER.md` (binding selection standard). Tunable launch thresholds live in
`pipeline/thresholds.json`; every rule the standard adds beyond the brief's literal text is
listed in FILTER.md §11 with its knob. Deterministic work is done by zero-dependency Node ≥ 20
scripts; judgment by the agent. Every script documents its flags with `--help`; the RUNBOOK
is authoritative for the exact sequence. Additional scripts beyond the table:
`add-manual.mjs` (registers entries read from `page` sources, and with `--extra` public
primary sources found by search), `selfcheck.mjs` (publish's checks plus FILTER §7 style
rules, run before the dry run). `fetch.mjs` exits 3 when fewer than half of sources respond.

| step | who | command / artefact |
|---|---|---|
| 0 slot | script | `node pipeline/scripts/slot.mjs [--now ISO]` → stdout JSON `{slot, run_id, already_run, previous_run}` |
| 1 fetch | script | `node pipeline/scripts/fetch.mjs --run <run_id> [--since ISO] [--now ISO]` → `work/<run_id>/candidates.json`, `fetch-report.json`. Window default: previous run's `started_at` − 6 h, floor now − 72 h. Marks `seen`. |
| 2 stage 1 | script | `node pipeline/scripts/prefilter.mjs --run <run_id>` → `work/<run_id>/stage1.json`. Domain relevance across the seven domains via a lexicon (`pipeline/lib/lexicon.mjs`). Cheap, recall-oriented, kills most volume; also drops `seen` and principally-marketing items. |
| 3 dedup hints | script | `node pipeline/scripts/dedup-hints.mjs --run <run_id>` → `work/<run_id>/dedup-hints.json`: for each survivor, likely matches among archive items from the last 21 days and among other survivors (clusters). |
| 4 stage 2 + 3 + writing | agent | Applies `FILTER.md`: per-section threshold, dedup confirmation, mechanism tagging, field writing. Writes `work/<run_id>/decisions.json`. |
| 5 publish | script | `node pipeline/scripts/publish.mjs --run <run_id> [--dry-run]` validates `decisions.json` (schema + lint, §6), assigns ids/timestamps, appends items to `docs/data/archive.json`, appends the run record to `docs/data/runs.json`, writes the jsonl log, updates `seen.json`. Never modifies an existing item. Non-zero exit with a readable error list on any violation. `--status failed --reason "…"` records a failed run with no items. |
| 6 commit | agent | Subject = `commit_message` printed by publish: `edition: YYYY-MM-DD HH:MM ET (+N items)` or `run: YYYY-MM-DD HH:MM ET (silent)` / `(failed)`; push to `main` (rebase-retry; on a conflict in `docs/data`, reset to `origin/main` and re-publish from the same `decisions.json` unless the slot is already recorded). |

`decisions.json`:

```json
{
  "run_id": "2026-10-02-1400",
  "threshold_level": "high",
  "judgments": [ { "candidate_id": "c-…", "section_tested": "capability_shift|…|null",
                   "verdict": "pass|drop", "reason_code": "CS_ASSUMPTION_INVALIDATED", "reason": "one line",
                   "dedup": "new|cluster_merged|same_story_dropped|material_update", "match_id": "RS-…|c-…|null",
                   "draft_index": 0 } ],
  "items": [ { /* Item without id/timestamp/backfilled */ "candidate_ids": ["c-…"] } ],
  "notes": "optional"
}
```

Every stage-1 survivor gets exactly one judgment. Reason codes are the closed list in
`FILTER.md` §8.2, which the scripts parse at runtime (the `CS_ASSUMPTION_INVALIDATED` above is
illustrative only). Funnel counts: `stage2_pass` counts stories (pass judgments that are not
cluster members); `dedup_dropped` counts same-story drops plus cluster members.
Failure mode: if fewer than half of sources respond, record a `failed` run and publish nothing.

Backfill is a **separate job**. The brief's own backfill rules were truncated and never supplied; on
2026-10-04 the owner instructed the build to follow best practice, recorded as the binding procedure
in `pipeline/BACKFILL.md`: the live selection standard applied as of each development's date, one
month and the owner-named sections per pass, every source URL checked live, and writes only through
`node pipeline/scripts/backfill.mjs` (`collect`, `add`, `verify-urls`, `publish`). Backfilled items
carry `backfilled: true`, create no run records, and never count as editions. The live routine never
runs the backfill. No fetcher in the pipeline impersonates a browser or works around an access wall:
every request carries the honest `ReadinessSignal/1.0` user agent, and a walled page is simply not
collected or not verified.

## 6. Validation and lint (`pipeline/lib/validate.mjs`, used by publish, validate and CI)

Schema: §3. Lint applies at full severity to items being published; items already in the
archive are checked for schema, with lint findings reported as warnings (so a later lint rule
never blocks a run over an older item). `validate.mjs --against-git-ref <ref>` treats lint as
an error for items added since `<ref>`. The baseline rules below are extended by the
mechanically checkable FILTER.md §7 writing rules (see `pipeline/lib/validate.mjs`).
Lint (errors unless marked warn):
- No first-person in generated-text fields: case-insensitive `\b(we|our|ours|ourselves|my|me)\b`;
  case-sensitive `\bI\b`, `\bus\b`, `\bUs\b` (uppercase `US` is the country and allowed).
- `validation_question`, `candidate_issue_statement`, `awareness_rationale` must not name a
  specific financial institution (checked against `pipeline/lib/institutions.mjs`; heuristic).
- `claim`: single line, 6–22 words (warn outside 8–16).
- Verbatim guard: no run of ≥ 8 consecutive words in any generated-text field may match a source
  headline or lead captured in `candidates.json` (publish-time only).
- Null/present rules for `validation_question`, `candidate_issue_statement`, `awareness_rationale` by mechanism.
- `candidate_issue_statement` starts with `Where ` or `If ` and contains a comma.
- Sources: https, unique, non-empty publication.
- `update_of`, if set, must reference an existing earlier item.
- Append-only: `node pipeline/scripts/validate.mjs --against-git-ref <ref>` fails if any item present
  at `<ref>` is missing or changed, or any run record at `<ref>` is missing or changed.

## 7. Site (`/docs`) — the v2 design's layout and behaviour, with the §7.5 visual refresh

Files: `docs/index.html`, `docs/assets/app.css`, `docs/assets/model.js` (pure logic, no DOM,
importable by Node tests), `docs/assets/view.js` (rendering + escaping), `docs/assets/app.js`
(entry: load data, hash routing, events), `docs/favicon.svg`, `docs/.nojekyll`.

### 7.1 Field mapping from the design

| design | this build |
|---|---|
| sections 1/2/3 | `executive_visibility`/`capability_shift`/`regulatory_trajectory`; titles "Executive Visibility", "Capability & Control Shift", "Regulatory & Executive Trajectory" |
| mech `issue/kri/praf/aware` | `candidate_issue/kri_kpi/praf_coverage/awareness_only`; labels "Candidate issue", "KRI / KPI", "PRAF coverage", "Awareness only"; four-square rail position 0/1/2/3 |
| `read` `[[domain,text]]` | `interpretation[] {domain,text}` |
| `q` | `validation_question` |
| `issue` | `candidate_issue_statement` |
| `why` (awareness) | `awareness_rationale` |
| `ifAsked`, "If asked" box | **removed** (stated one institution's position) |
| `owner`, "Paste-ready · for {owner}" | **removed** → "Paste-ready" |
| `src.pub/title/cls/date` | `publication` / `headline` (fallback: publication) / `source_class` (fallback item's) / `published` (fallback: omit) |
| `classes` (filter, collapsed meta) | union of item `source_class` and per-source classes, item's first |
| `ed` / edition | `timestamp` |
| hard-coded NOW / LATEST | NOW = the later of the browser clock and the newest pipeline write (so a viewer whose clock runs behind still sees the latest edition); latest edition = latest `published` run in runs.json (fallback: latest non-backfilled item timestamp) |
| `editionsIn()` from SLOTS | runs in runs.json whose `slot` is in range; silent = `status: silent`. Copy says **runs**, not editions, where silent runs are counted ("from 4 of 5 runs, 1 silent", "The entry test was applied in 5 runs"), because a silent run is not an edition (§3.3); failed runs are listed separately. An empty section says "Nothing cleared the bar" only when a run in range actually applied the test; otherwise "Nothing published in the …" with the reason. |

Domain labels: Cyber, Fraud, AI, Data, Resilience, Third party, Risk quantification.
Source class labels: News, Regulator, Standards body, Industry/trade, Vendor/threat research, Research & analysis.

### 7.2 Behaviour (brief wins over design)

- Pages via hash: `#dashboard` (default), `#report`, `#archive`, `#about`, `#<item id>` (reveal:
  ≤ 24 h → report day, ≤ 7 d → week, ≤ 30 d → month, else archive all-time; clears filters that would hide it; expands; scrolls).
  The age carries one hour of slack, so an item at a window edge is still inside the window when it renders. If the
  chosen view still does not show the item, the all-time archive with every filter and the search cleared, for that
  page load only. A permalink opened from outside the page jumps straight to the item (no smooth scroll) and holds it
  in view while fonts and layout settle: until the reader scrolls, taps, clicks or types, or 3 s after the page is visible.
- Report (24 h / 7 d / 30 d; Section, Domain, Source filters with counts; expand/collapse all;
  export collapsed/expanded via print), Archive (All / month / custom range; search over claim, domains,
  publications, headlines; grouped by month), About — all exactly as designed, with the copy changes below.
  Owner change 2026-10-06 (the dashboard's design carried over; the design's mechanism-count strip is gone):
  the Report opens with a brief of its window, the dashboard's readings for the selected 24 h / 7 d / 30 d:
  **Arrived** (items and what they ask, against the window before), **Concentrating** (leading domain, then the
  next three), **Building** (items that continue threads, the longest thread's length) and **The bar** (the
  window's runs, as on the dashboard). Item readings follow the filters; the bar covers every run in the
  window. An empty window shows Arrived and The bar only. The Archive opens with a month navigator: the
  dashboard's unit chart over every item (at most 12 months), squares outside the current selection faded,
  each month's label a button that picks that month (or all time again once picked). Item rows in a thread
  show "Thread · N"; an expanded item in a thread shows the thread's timeline on its own month axis (this
  development haloed) and steps to the earlier and later developments.
- Dashboard (owner change 2026-10-06, replacing the design's 7-day counts, which said little with so few items):
  analysis, not counts, all computed in `model.js` from `archive.json` and `runs.json` (never at build time).
  1. A brief of four readings in plain sentences: **Building** (the update thread with the most developments in
     the last 90 days: size, start, last 30 days, its latest item), **Concentrating** (the domain on the most items
     from the last 90 days against the 90 days before; domains with nothing in 90 days), **Asking** (how many of
     the last 90 days' items ask for action, by mechanism, against the 90 days before) and **The bar** (the last 7
     ET calendar days of runs: new headlines read, first-screen passes, items cleared; scheduled slots missed or
     failed). 2. Latest additions (five newest items, live or backfilled). 3. Additions by month: a unit chart,
     one square per item, filled where it asks for action, open where it resolves as awareness only; section
     totals beneath. 4. Developing threads: items joined by `update_of` into stories (2+ items), each a timeline
     on a shared month axis with its latest item. 5. Questions to put to owners: the newest actionable items'
     validation questions. 6. Regulatory direction: the newest section 3 items with their primary source.
     7. Where the signal concentrates: items per domain per month as sized dots, with the last 90 days against
     the 90 before. 8. The bar, last 7 days: the run-log funnel and each scheduled slot (published, silent, failed,
     did not run). A slot counts as missed only an hour after its time and only from the first recorded run on.
  Charts use the one navy ink; what an item asks is carried by fill, labels and the mechanism tag, never by hue
  alone; sizes mean volume, never severity. Chart marks are pointer shortcuts (tooltips, click to open); every
  chart has a table or list equivalent for keyboard and screen-reader users. Months span at most 12; phones show
  the domain grid's last six months.
- Mechanism "asks" text: Candidate issue — "Send the validation question to the owner. If the answer is no or
  unknown, raise the candidate issue." KRI / KPI — "Confirm an indicator exists, is measured, and reaches
  someone who acts on it. If not, the issue language applies." PRAF coverage — "Confirm the risk assessment
  framework represents this risk at all. If it does not, the issue language applies." Awareness only —
  "Nothing to action. This is a complete resolution: know it, in case you are asked."
- Awareness-only items render the "Why this resolves as awareness only" panel from `awareness_rationale`, styled
  as a resolution (same weight as the validation question panel, never greyed or de-emphasised). No "If asked".
- Validation question panel footer: "Paste-ready". Copy buttons for question, issue language, permalink (the
  absolute live URL, `https://emergingtechrisk.com/Readiness-Signal/#<id>`).
- "Email this item" (owner change 2026-10-05): a real `<a href="mailto:…">`, no script handler, outside the row
  that expands the item, so following it never toggles the item. No server send. Subject
  `Readiness Signal: <claim>`. Plain-text body, CRLF lines: the claim; `Mechanism: <label>` and
  `Domains: <labels>`; the interpretation (read-across texts in domain order) cut to its first two sentences;
  then "Full item, validation question, candidate issue statement and sources:" ("Full item, awareness
  rationale and sources:" for awareness-only items, which have neither) and the item's absolute permalink on the
  live site. Encoded with `encodeURIComponent` (plus `!'()*`): spaces `%20`, never `+`; line breaks
  `%0D%0A`; typographic punctuation goes out as ASCII. The whole mailto URL stays under 1,800 characters: if
  the full body would not, the interpretation is dropped, never the link.
- `backfilled: true` items: small text label "Backfilled" in the collapsed meta line; expanded footer note
  "Added by the historical backfill pass, not by a live edition." Backfilled items never count as editions.
- `update_of`: expanded view shows "Update to: <earlier claim>" linking to `#<earlier id>`.
- Masthead times (owner change 2026-10-05), both in ET and read from `runs.json` at page load, never set
  when the site is built, so they move on their own as runs are pushed: "Last edition" = slot of the latest
  run that published at least one new item ("None yet" before the first); "Last checked" = `finished_at` of
  the latest run that completed, published or silent ("Not yet" before the first). A silent run publishes no
  edition and moves only "Last checked"; a failed run moves neither. The dashboard has no separate "As of".
- Empty states everywhere (empty archive on day one must look intentional): masthead "Last edition — None yet",
  "Last checked — Not yet".
- Data load failure: a plain message in the main column; never a blank page.
- Footer (replaces "Illustrative content…"): "Public sources only: headlines and leads are referenced, never
  republished. Nothing here describes any institution's control position; validation questions and issue
  language are generic starting points."
- No storage APIs. Print styles for export. Keyboard: item rows toggle on Enter/Space; popovers close on
  Escape and outside click; visible focus.
- Section entry tests (report headers): 1 "Could a director or executive credibly ask 'what are we doing about
  this?' unprompted?" 2 "Has adversary capability changed, or has a control failed somewhere in a way that
  invalidates an assumption others rely on?" 3 "Is this a signal of where regulators or executives are
  heading — a speech, testimony, consultation or supervisory direction in the US, UK or EU, a public statement by a
  leading bank executive, or a newly issued formal rule or exam notice? Reminders and restatements of existing rules
  do not count." (Owner decision 2026-10-03: new formal rules and exam notices are in scope in this section; the
  brief had excluded formal rules and exam notices as "covered elsewhere".)

### 7.3 About page copy (institution-neutral rewrite of the design)

- Lead: "Readiness Signal is a triage digest for technology risk professionals. It reads widely so you don't
  have to, and publishes only what changes what you should check, measure, cover, or be ready to answer."
- No "Why it exists" section (owner change 2026-10-05: removed).
- Three entry tests: as §7.2, with the design's layout. Section 3 adds "Most candidates fail this test, so the
  section is often empty."
- Every item says what it wants: design copy; PRAF coverage line "Confirm the risk assessment framework
  represents this risk at all."
- How an item is built: design copy, "a validation question you can paste to a program owner", plus (owner
  change 2026-10-06) a sentence on threads. Then "How the charts read": a key to the unit squares (filled asks
  for action, open is awareness only, same weight), thread timelines, the run slots, and dot sizes ("Counts and
  sizes mean volume, never severity"). Section titles carry the brief's short accent.
- What it is not: "It is not a risk rating. Nothing here is red, amber or green; the green mark is emphasis only
  and never means safe. Colours mark what an item asks of you, never how serious it is." / "It is not a threat
  feed or a news service, and it says nothing about any
  institution's control position. The validation question is where that record starts, inside your own
  organisation."
- Where things live: design copy, except (owner change 2026-10-06) Dashboard: "A brief of what is building,
  where the signal concentrates and what the archive asks, with the threads, trends and run log behind it.";
  Report: "The last 24 hours, week or month: a brief of the window, then its items by the three sections.
  Filter, expand and export."; Archive: "Everything ever published, charted and listed by month, with search
  and a custom date range. Nothing is replaced."

### 7.4 Layout breakpoints

The design switches on the root width: narrow `< 640`, wide `≥ 980`, else medium. Implement with CSS media
queries at those widths reproducing every `L.*` value in the design (`lineCols/lineAreas`, `bodyCols/bodyAreas`,
`dashLine/dashAreas`, `boardCols`, `mixCols`, paddings, popover placement, search width, about columns).

### 7.5 Visual refresh (owner request, 2026-10-03)

The owner asked for "more personality, more color, and rounded edges". Layout, breakpoints, behaviour and copy
stay as above; the visual layer changes:

- Rounded surfaces (cards 16 px, panels 12 px, controls 10 px, chips and filter buttons as pills) with soft
  shadows in place of hard rules; a navy-to-indigo masthead gradient with a faint decorative texture.
- Each mechanism has a categorical hue used on its tag, rail, board column, mix strip and expanded panels:
  Candidate issue deep teal, KRI / KPI cyan, PRAF coverage violet, Awareness only blue-indigo (kept clearly apart from the violet and from the brand indigo). Hues stay outside red,
  amber and green so colour never reads as severity or safety; awareness only carries the same weight as the
  others. The brand green remains emphasis only.
- Text meets WCAG AA on every background; animation respects `prefers-reduced-motion`; no monospace.

## 8. Tests and tooling

- `npm test` → `node --test` over `tests/**/*.test.mjs` (model logic, pipeline libs/scripts with fixtures).
- `npm run serve` → `node scripts/serve.mjs` serves `/docs` at `http://localhost:8148/Readiness-Signal/`
  (sub-path emulation). `--fixtures` substitutes `tests/fixtures/archive.json` and `runs.json` for
  `data/*.json` **in the server only** — no fixture-loading code exists in the site.
- `npm run validate` → `node pipeline/scripts/validate.mjs`.
- `npm run calibration` → `node pipeline/scripts/calibration.mjs` (funnel, pass rates by section,
  mechanism distribution with a warning when `candidate_issue` exceeds 40 % of items, reason-code tallies).
- CI (Node 20 and 22): `npm test`, `npm run validate`, append-only check against the pre-push commit
  (`github.event.before`, or the PR base; falls back to `HEAD^`). The workflow is **parked** at
  `ci/github-actions-ci.yml` because the credential that pushed the repo lacked GitHub's `workflow` scope;
  to enable it, move it to `.github/workflows/ci.yml` and push with a credential that has that scope.
- Fixtures in `tests/fixtures/` are fictional, clearly marked, never deployed.
