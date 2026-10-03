# Readiness Signal

Read `SPEC.md` before changing anything; it is the build contract. Hard rules:

- Fully static site in `/docs` (GitHub Pages, branch `main`, folder `/docs`). No backend, no
  storage APIs (`localStorage`, `sessionStorage`, IndexedDB, cookies), no runtime CDN scripts.
  Relative URLs only — the site is served under `/Readiness-Signal/`.
- Public sources only; paywalled publications are headline-and-lead reference only.
- No generated text may state or imply any specific financial institution's position. No
  first-person voice in generated fields. Validation questions and issue language are generic.
- No monospace type anywhere. Sans with tabular numerals instead.
- The archive (`docs/data/archive.json`) and run log (`docs/data/runs.json`) are append-only.
  Only `pipeline/scripts/publish.mjs` writes them.
- The backfill pass is not built and must not be run (`pipeline/BACKFILL.md`).
- `.design-handoff/` is local design reference; never commit it or copy its sample content.
