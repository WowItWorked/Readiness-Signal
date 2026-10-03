# FICTIONAL TEST FIXTURE: a cut-down reason-code table in the FILTER.md §8.2 format

Tests point publish.mjs at this file with `--filter` so they do not depend on the live FILTER.md.

| Code | Verdict | `section_tested` | Element | Use when |
|---|---|---|---|---|
| `GL_OFF_DOMAIN` | drop | null | G1 | off domain |
| `GL_MARKETING` | drop | null | G3 | marketing |
| `GL_NO_DEVELOPMENT` | drop | null | G6 | nothing happened |
| `GL_PAYWALL_INSUFFICIENT` | drop | null or the section | G11 | paywall |
| `GL_NO_MECHANISM` | drop | the section passed | §6.2 | no mechanism |
| `GL_NOT_JUDGED` | drop | null | RUNBOOK | time budget |
| `DD_SAME_STORY` | drop | null or the section | §5.3 | same story |
| `DD_SAME_SIGNAL` | drop | null or the section | §5.1 | same signal |
| `EV_NO_EXEC_QUESTION` | drop | executive_visibility | E5 | no question |
| `EV_PASS_LOSS` | pass | executive_visibility | E1-E5 | loss |
| `CS_NO_SPECIFIC_CHANGE` | drop | capability_shift | C1 | nothing changed |
| `CS_PASS_CONTROL_FAILURE` | pass | capability_shift | C1-C6 | control failure |
| `RT_NO_DIRECTION` | drop | regulatory_trajectory | R3 | no direction |
| `RT_PASS_SPEECH` | pass | regulatory_trajectory | R1-R5 | speech |
