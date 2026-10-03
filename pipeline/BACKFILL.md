# Backfill pass — NOT BUILT, DO NOT RUN

The historical backfill (2026-01-01 to the build date) is a separate job with its own
binding selection rules. Those rules have not been supplied yet, so this job does not
exist. Do not populate the archive with historical items, and do not substitute the live
selection standard (`FILTER.md`) for the backfill rules.

What is already in place for when the rules arrive:
- the item schema carries `backfilled: boolean` (default `false`);
- the site labels backfilled items and never counts them as editions.
