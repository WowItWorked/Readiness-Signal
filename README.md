# Readiness Signal

**A filter, not a feed.** A static, stateless technology-risk triage archive. Four scheduled
runs a day read public sources and publish only what clears a deliberately high materiality
bar. Each item carries exactly one mechanism that says what it wants from the reader: a
candidate issue, a KRI/KPI, PRAF coverage, or awareness only. When nothing clears, the run is
silent.

Live: <https://emergingtechrisk.com/Readiness-Signal/>

## How it works

| Piece | Where | What it does |
|---|---|---|
| Site | [`docs/`](docs/) | Dashboard, Report, Archive, About. Plain HTML/CSS/ES modules, no build step, no storage, no backend. Served by GitHub Pages (branch `main`, folder `/docs`). |
| Archive | [`docs/data/archive.json`](docs/data/archive.json) | Every published item, append-only. Editions never overwrite. |
| Run log | [`docs/data/runs.json`](docs/data/runs.json) | One record per scheduled run (published, silent or failed) with the funnel and the mechanism distribution. |
| Selection standard | [`pipeline/FILTER.md`](pipeline/FILTER.md) | **Binding.** The three-stage filter, per-section entry tests, dedup, mechanism tagging, writing rules, reason codes and calibration. §11 lists every launch choice that goes beyond the brief's literal text, with its knob. |
| Launch thresholds | [`pipeline/thresholds.json`](pipeline/thresholds.json) | The knobs the first-week calibration loosens. All start at `launch` (deliberately high). |
| Runbook | [`pipeline/RUNBOOK.md`](pipeline/RUNBOOK.md) | **Binding.** The exact procedure the scheduled routine follows each run. |
| Source registry | [`pipeline/sources.json`](pipeline/sources.json) | Public feeds by source class, each live-verified. Paywalled publications are headline and lead only. |
| Scripts | [`pipeline/scripts/`](pipeline/scripts/) | Zero-dependency Node: `slot`, `fetch`, `add-manual`, `prefilter`, `dedup-hints`, `selfcheck`, `publish`, `validate`, `calibration`. Each has `--help`. |
| Contract | [`SPEC.md`](SPEC.md) | The build contract for the data model, site behaviour and pipeline. |

Each run (06:00, 10:00, 14:00, 18:00 ET) is a scheduled Claude routine. It checks out this
repo and does the following:

1. Collects candidates from the registry (`fetch.mjs`).
2. Applies the cheap domain-relevance gate (`prefilter.mjs`, stage 1).
3. Judges every survivor against the section tests in `FILTER.md` (stage 2) and confirms
   duplicates (stage 3), helped by `dedup-hints.mjs`.
4. Tags exactly one mechanism per item and writes the item fields.
5. Validates everything mechanically (`selfcheck.mjs`, then `publish.mjs --dry-run`).
6. Appends to the archive and run log (`publish.mjs`), then commits and pushes. Pages
   redeploys.

Only `publish.mjs` writes the archive. It refuses anything that breaks the schema, the
mechanical checks on the hard constraints (no first person, no named institution in
questions, issues or rationales, no copied text, conditional issue statements), or
append-only. A CI workflow re-checks append-only against the pre-push commit; it is parked at
[`ci/github-actions-ci.yml`](ci/github-actions-ci.yml) until it is pushed with a GitHub credential that has the
`workflow` scope (move it to `.github/workflows/ci.yml` to enable it).

### Hard constraints

- Fully static: no backend, database, server-side send, auth or browser storage.
- Public sources only. Paywalled publications are referenced at headline and lead level and
  never republished.
- Nothing may reference, imply or be attributable to any specific financial institution's
  position. Validation questions and issue statements are generic to any risk professional
  at any institution.
- Works on desktop and mobile, from 320 px to 1600 px.

## Local development

Requires Node 20 or newer. No dependencies to install.

```bash
npm test
```

```bash
npm run serve:fixtures
```

Then open <http://localhost:8148/Readiness-Signal/>. This serves the site with the
**fictional** fixture data in `tests/fixtures/`, swapped in by the local server only. The
fixtures are never deployed. `npm run serve` serves the real `docs/data`.

```bash
npm run validate
```

`npm run validate` checks the archive, run log and seen-ledger.

## Calibration (first week)

The brief sets every threshold deliberately high at launch, to be loosened after a first-week
review.

```bash
npm run calibration
```

`npm run calibration` reports per-run and aggregate funnels, pass rates by section, the
mechanism distribution (it warns when `candidate_issue` exceeds 40 % of items) and
reason-code tallies. Near-miss drops are marked `NEAR` in `pipeline/logs/`. FILTER.md §9
gives the review procedure and the evidence each knob needs before it is loosened.

## Backfill

The historical backfill is a **separate job**, run one month at a time when the owner asks, under
the binding procedure in [`pipeline/BACKFILL.md`](pipeline/BACKFILL.md): the live selection standard
judged as of each development's date, every source URL checked live, and writes only through
`node pipeline/scripts/backfill.mjs` (`collect`, `add`, `verify-urls`, `publish`). Backfilled items
are labelled on the site, create no run records and never count as editions. Each pass leaves an
audit log of every candidate's judgment in `pipeline/logs/backfill/`.
