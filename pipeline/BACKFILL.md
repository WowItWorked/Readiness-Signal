# Backfill pass — binding procedure

**Status:** binding for every backfill run. The brief's own backfill rules were truncated and never
supplied; on 2026-10-04 the owner instructed the build to "follow what you believe to be best
practice". This file is that practice. It applies the live selection standard to a historical
window rather than inventing a different one.

## 1. Scope of a pass

A pass covers one calendar month in America/New_York time, or, for the current month, one calendar
day, and the sections the owner names for it. Its **pass key** is the month (`YYYY-MM`) or the day
(`YYYY-MM-DD`); the key names the pass's work directory (`pipeline/work/backfill-<key>/`), its
audit log (`pipeline/logs/backfill/<key>.jsonl`) and its `decisions.json` run id (`backfill-<key>`).
Day passes exist for the current month, and the last one ends at its `until`: its window ends at that
edition slot (included), the last slot the backfill covers, and the live routine covers everything
after it.

| Pass | Window (ET) | Sections | Owner instruction |
|---|---|---|---|
| 2026-01 | 2026-01-01 00:00 – 2026-01-31 23:59 | `capability_shift`, `regulatory_trajectory` | 2026-10-04: "January 2026 only … Capability shift and regulatory trajectory only … Verify every source URL is live … do not commit." |
| 2026-02 | 2026-02-01 00:00 – 2026-02-28 23:59 | `capability_shift`, `regulatory_trajectory` | Year to date (below) |
| 2026-03 | 2026-03-01 00:00 – 2026-03-31 23:59 | `capability_shift`, `regulatory_trajectory` | Year to date |
| 2026-04 | 2026-04-01 00:00 – 2026-04-30 23:59 | `capability_shift`, `regulatory_trajectory` | Year to date |
| 2026-05 | 2026-05-01 00:00 – 2026-05-31 23:59 | `capability_shift`, `regulatory_trajectory` | Year to date |
| 2026-06 | 2026-06-01 00:00 – 2026-06-30 23:59 | `capability_shift`, `regulatory_trajectory` | Year to date |
| 2026-07 | 2026-07-01 00:00 – 2026-07-31 23:59 | `capability_shift`, `regulatory_trajectory` | Year to date |
| 2026-08 | 2026-08-01 00:00 – 2026-08-31 23:59 | `capability_shift`, `regulatory_trajectory` | Year to date |
| 2026-09 | 2026-09-01 00:00 – 2026-09-30 23:59 | `capability_shift`, `regulatory_trajectory` | Year to date |
| 2026-10-01 (day) | 2026-10-01 00:00 – 23:59 | `capability_shift`, `regulatory_trajectory` | Year to date |
| 2026-10-02 (day) | 2026-10-02 00:00 – 23:59 | `capability_shift`, `regulatory_trajectory` | Year to date |
| 2026-10-03 (day) | 2026-10-03 00:00 – 23:59 | `capability_shift`, `regulatory_trajectory` | Year to date |
| 2026-10-04 (day) | 2026-10-04 00:00 – 18:00 (`until` 2026-10-04T18:00:00-04:00) | `capability_shift`, `regulatory_trajectory` | Year to date |

**Year to date** — owner, 2026-10-04 15:57 ET: "Now run all months sequentially until October and then
run each day up until today so that nothing is missed from this year on it's first load". The build
owner set every one of these passes to the 2026-01 pass's sections. The passes are run in key order;
the 2026-10-04 pass is published only after 18:00 ET that day (real clock), and the live routine takes
over at 06:05 ET on 2026-10-05 with its own 72-hour window.

The windows never overlap and leave no gap from 2026-01-01 00:00 ET to the last `until`, so each
backfilled item belongs to exactly one pass. A candidate that would qualify only under a section
outside the pass is dropped `BF_SECTION_EXCLUDED` (it is not re-routed). A development first made
public outside the window (for the last day pass, after its `until`) is dropped `BF_OUT_OF_WINDOW`.

## 2. Selection standard: the live standard, judged as of the date

- **Same tests, same bar.** Every candidate is judged against `pipeline/FILTER.md` (gates G1–G9, §4.3
  Capability & Control Shift C1–C6 with the vulnerability rule, §4.4 Regulatory & Executive Trajectory
  soft-signal R1–R5 / X1–X6 and formal-instrument R1/R1f/R2/R3f/R4f/R5), at the values in
  `pipeline/thresholds.json`. Default verdict is DROP. Mechanism tagging (§6) and writing rules (§7) are
  unchanged.
- **As of the date, no hindsight.** Judge each development on what was public at its own date:
  - novelty (C5, R3, R3f) is measured against what was public *before* the development, not against
    what is known now;
  - a development never passes because of what it later became; later public sources may be cited only
    to confirm facts that were stated at the time;
  - the event-age gate G7 (`max_event_age_days`) is measured from the development's first publication to
    the item's slot (§4), not to today.
- **Dedup within the pass** follows FILTER §5: several outlets on one story make one item with every
  verified outlet as a source; a follow-up is dropped `DD_SAME_STORY` unless it is a material update,
  which becomes a new item with `update_of` pointing at the earlier backfilled item. The earlier item
  (for `update_of` and for a `DD_SAME_STORY` match) may belong to this pass or to an earlier pass of any
  key, named by its id; never to a later pass, and its slot is always strictly earlier than the
  candidate's own. A backfilled item never references a live item.
- **No quota.** Whatever clears, publishes; silence for a section is a result.

## 3. Discovery (how candidates are found)

Feeds only hold recent weeks, so a backfill collects from three modes and records which one found
each candidate:

1. **Machine-readable archives:** the CISA KEV catalogue (`dateAdded` in the window) and the Federal
   Register API (final rules, by publication date, for the agencies in `sources.json`); collected by
   `backfill.mjs collect`.
2. **Publishers' dated archive and listing pages** for publishers in `pipeline/sources.json`
   (speeches, testimony, press, publications, research blogs).
3. **Targeted web search** restricted to registry publishers and primary issuers.

Rules: public sources only; paywalled publications at headline and lead level only and never as the
primary source; never an aggregator, cache, AMP page or social post (FILTER §2.7). For each candidate the
collector records the URL, publication, source class, the headline verbatim, a verbatim lead of at most
`lead_words` (paywalled: 30), the publication date (and time if stated), and the discovery mode.

## 4. Timestamp and id

- **Timestamp** = the first edition slot (06:00, 10:00, 14:00, 18:00 ET) at or after the earliest
  publication of the item's development among its sources: when a live run would first have caught it.
  A source with a date but no time counts as published at 18:00 ET that day, so its item takes the
  18:00 slot (never an earlier slot than the source could support). A development published after the
  window's last slot takes that slot only if it is still inside the window; otherwise
  `BF_OUT_OF_WINDOW`. (A day pass's last slot is 18:00 that day; for the last day pass it is its
  `until`, and nothing after it is inside the window.)
- **Id** = `RS-YYMMDD-HHMM-NN` from the slot, `NN` ordered within the slot by section
  (capability_shift before regulatory_trajectory) then mechanism (candidate_issue, kri_kpi,
  praf_coverage, awareness_only), then the primary source's date, as live publish does. Ids never
  collide with existing items.
- `backfilled: true` on every item. Backfilled items create **no** run records (`docs/data/runs.json`
  is untouched) and never count as editions on the site. `pipeline/state/seen.json` is untouched.

## 5. Source URL verification (owner requirement)

Every source URL of every item is checked live before the item is written:

- `GET` with the honest project user agent only (`ReadinessSignal/1.0`), following redirects, 20 s
  timeout; a 403/429/503 may be retried once with the same user agent after honouring `Retry-After`.
  The pipeline never impersonates a browser or works around a bot check or access wall: a walled page
  is simply **not verified**;
- **verified** = final status 200; final URL on the same registrable domain as the original (or a
  documented canonical host of that publisher), not a redirect to a home, search, error or parent
  listing page; content type HTML, PDF, XML or JSON; and no soft-404 (a page whose title or opening
  text says the page was not found);
- where a publisher offers an official machine-readable record, that record is the check: Federal
  Register documents through its public API (`/api/v1/documents/<number>.json`, matching URL and
  date) and CISA catalogue entries through the KEV JSON (CVE listed, matching `dateAdded`);
- the judging agent must also have read the page (paywalled: headline and lead only) and confirmed it
  carries the facts it is cited for.

A source that fails is removed from the item. If the primary source fails and no other verified source
independently carries the claim's facts, the item is dropped `BF_URL_UNVERIFIED`. Every check (status,
final URL, content type, time) is recorded in the pass's audit log.

## 6. Writing to the archive

Only `node pipeline/scripts/backfill.mjs publish --month YYYY-MM` (a day pass: `--day YYYY-MM-DD`)
writes backfilled items. It:

- validates every item exactly as live publish does (schema, every FILTER §7 lint rule, the verbatim
  guard against captured headlines and leads, institution and first-person rules), plus that every
  source URL passed verification in a check no older than 24 hours;
- assigns timestamps and ids per §4, sets `backfilled: true`, and appends to `docs/data/archive.json`
  (atomic write; existing items byte-for-byte unchanged);
- writes the audit log `pipeline/logs/backfill/<key>.jsonl` (one line per candidate: verdict, reason
  code, reason, URL checks, resulting item id);
- refuses to run before the pass's window has ended (its `until` when it has one);
- refuses to run twice for the same pass key (the archive already holds backfilled items in that
  pass's window, or its audit log exists) unless `--append-missing` is given, which only adds items
  whose ids are new; another month's or day's pass neither blocks it nor is blocked by it;
- never touches `docs/data/runs.json` or `pipeline/state/seen.json`; `--dry-run` writes nothing.

Backfill-only reason codes: `BF_SECTION_EXCLUDED`, `BF_OUT_OF_WINDOW`, `BF_URL_UNVERIFIED`. All other
codes are FILTER §8.2's closed list.

## 7. Commit policy

The 2026-01 pass was first to stay uncommitted; the owner then instructed (2026-10-04): "once
complete, commit and push to github". It is committed and pushed once it is verified, with the
archive, the audit log and the tooling in clearly separated commits.
