# Test fixtures: fictional data, never deployed

`archive.json` and `runs.json` in this folder are **entirely fictional**. They exist only to
exercise the site and the pipeline libraries locally:

- `npm run serve:fixtures` serves `/docs` with these two files substituted for
  `data/archive.json` and `data/runs.json`. The substitution happens **in the local server
  only**; the site contains no fixture-loading code.
- `npm test` uses them as inputs to model and pipeline tests.

They are never copied into `docs/data/`, never published, and never committed as live data.

## What is fictional

Every event, incident, speech, hearing, consultation, figure, headline and date here is
invented. Publication names are real outlets and bodies, and each `url` points only at that
publication's public section page (not at an article), so the source links resolve without
implying that any specific article exists. Nothing here reports a real incident at any real
organisation, and no text describes any institution's control position.

The writing follows the live rules (SPEC.md sections 3 and 6): no first-person voice,
institution-neutral validation questions, issue language and awareness rationales, and
`Where …` / `If …` issue statements.

## Reference clock

The data is built around **now = Fri 2 Oct 2026, 15:00 ET** (`2026-10-02T15:00:00-04:00`).
The site uses the browser clock, so on any other date the 24 h / 7 d / 30 d windows shift.
Tests that depend on windows should inject this time.

- Latest edition: 2026-10-02 14:00 ET, 4 items (sections 1 and 2, three mechanisms).
  The latest run finished at 14:21:40 ET ("Last checked" in the masthead).
- Regulatory & Executive Trajectory: no items in the last 24 hours (empty state), latest
  item `RS-261001-0600-01` (shows "Last published in this section").
- Executive Visibility: 5 items in the last 7 days.

## Contents

- **32 items**, 2026-01-15 to 2026-10-02, in append order (oldest first). Executive
  Visibility 11, Capability & Control Shift 13, Regulatory & Executive Trajectory 8.
  Candidate issue 9, KRI / KPI 7, PRAF coverage 8, Awareness only 8. All seven domains and
  all six source classes appear.
- **69 runs**: one per slot from 2026-09-18 06:00 to 2026-10-02 14:00 ET (59 runs: 15
  published, 42 silent, 2 failed), plus a published run for each older live item's slot.
  Funnels are plausible but invented; each run's `mechanism_distribution` matches its items.

## Edge cases included

| case | ids |
|---|---|
| Backfilled (`backfilled: true`, not in any run, never an edition) | `RS-260115-1000-01`, `RS-260219-1400-01` |
| Material update (`update_of`) | `RS-261002-1400-02` updates `RS-260921-1000-01` |
| DST offsets: last slot on -05:00 / first slot on -04:00 | `RS-260305-1800-01` (`-05:00`), `RS-260308-0600-01` (`-04:00`, the day DST starts) |
| Single source | e.g. `RS-260305-1800-01`, `RS-260926-1800-01`, `RS-260930-1400-02` |
| Three sources spanning three source classes | `RS-260819-0600-01` (vendor/threat research, news, regulator) |
| Three sources, two classes | `RS-261001-1800-01`, `RS-261002-1400-01` |
| Source with no `published` date | `RS-261002-1000-01` (regulator reference with no date) |
| Item with one domain | `RS-260308-0600-01` |
| Item with four domains | `RS-261001-1800-01` |
| Interpretation adds domains beyond the tagged ones | e.g. `RS-260115-1000-01`, `RS-261002-1400-01` |
| Failed runs (fewer than half of sources responded) | runs `2026-09-24-1800`, `2026-10-01-1000` |
| Silent runs with a same-story dedup drop (`dedup_dropped: 1`) | runs `2026-09-23-1800`, `2026-09-30-1800`, `2026-10-01-1400` |
| Run with several items across sections | run `2026-10-02-1400` (4 items) |

## Changing these files

Keep them valid against SPEC.md: ids match timestamps on 06:00/10:00/14:00/18:00 ET slots
with the correct offset (`-05:00` before 2026-03-08 02:00 ET and after 2026-11-01 02:00 ET,
otherwise `-04:00`), every published run's items exist in the archive with the run's slot as
their timestamp, every non-backfilled item belongs to exactly one published run, and
mechanism distributions match. If an id or count listed above changes, update this README.
