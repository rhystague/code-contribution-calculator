# Configuration and audit reference

The example JSON is complete. Omitted optional fields receive recorded defaults. Unknown keys, invalid weights, incomplete SHA identifiers and offset-free timestamps are rejected.

| Field | Default / meaning |
| --- | --- |
| `start`, `end` | Required ISO timestamps with offsets; end exclusive |
| `timezone` | `UTC`; IANA zone for anchored calendar weeks |
| `mainBranch` | `main`; local branch used only when no submitted SHA is configured |
| `weights` | `{ "sustained": 0.50, "activity": 0.35, "retained": 0.15 }`; three non-negative numbers summing to 1 |
| `include` | `["**"]`; path must match at least one inclusion |
| `exclude` | `[]`; extra path exclusions |
| `useDefaultExcludes` | `true`; disable to supply a fully custom exclusion list |
| `excludeKnownBots` | `false`; opt in to exact known no-reply signatures |
| `identityExclusions` | `[]`; exact name and/or email match with required `reason` |
| `repositories` | `{}`; directory basename to full `submitted` and optional `baseline` commit IDs |
| `thresholds.largeChange` | 5000 accepted units in one integration |
| `thresholds.churnRatio` | 5 branch units per accepted unit; positive branch work with zero accepted units is also flagged |
| `thresholds.minAttributionCoverage` | 0.8; origin attribution before eligibility/identity exclusions |
| `thresholds.authorCommitterSkewHours` | 168 |
| `thresholds.timestampToleranceSeconds` | 0; allowable development time after the integration, for explicit future policies |

Example identity exclusion:

```json
{"identityExclusions": [{"email": "teacher@example.edu.au", "reason": "Teaching staff"}]}
```

When both `name` and `email` are supplied both must match exactly. Built-in bot matching is limited to GitHub no-reply addresses for `dependabot[bot]`, `renovate[bot]` and `github-actions[bot]`, with an optional numeric ID prefix. Other identities are never silently removed.

## File matching

Paths are repository-relative with `/` separators. `*` matches within a path component; `?` matches one character within a component; `**` crosses directories; `**/` also matches the repository root. Patterns are case-sensitive. There are no negation rules, regular expressions, character classes or extglobs. An exclusion wins over an inclusion. For rename-connected changes either endpoint's exclusion excludes the change, avoiding new credit merely from moving vendor content into a source directory.

The authoritative default list is exported as `DEFAULT_EXCLUDES` in `src/config.mjs`. It covers dependency/vendor directories, common virtual environments and caches, `dist`, `build`, `target`, `bin`, `obj`, coverage, framework output, minified files, source maps, `*.generated.*`, common package-manager lockfiles and `.mailmap`. Some projects use `bin` or `build` for hand-written code; use a custom exclusion list in those cases. Unconventionally named generated code is not magically detectable: configure it explicitly. Large accepted changes are flagged to support this review.

Each omitted change records stage, paths, rule, before/after bytes, nonblank line totals and whitespace-filtered omitted additions/deletions where measurable. Binary byte counts are reported without inventing a line count. Retained-stage exclusions record final byte/line totals. Exclusion records from different stages are separate observations, not figures to sum together as a single omitted-volume total.

## Audit structure

`canonical` is the reproducible evidence object. `evidenceHash` is its SHA-256 after recursive key sorting and pretty JSON serialisation with a final newline. `observations` contains current local refs outside the submitted history; `runtime` holds runtime versions and process counts.

Canonical contents:

- `version`, `repository`, `submitted`, `baseline`, `selection`, `config`, `configHash`.
- `periods`: each week's UTC start/end and zero-based index.
- `commits`: original author, committer/author times, integration SHA, identity key, week and eligibility reason.
- `integrations`: parent SHAs, introduced commits, accepted added/deleted volume, branch volume, coverage, credited/identity-excluded/ineligible/unattributed units and per-file changes.
- `integrations[].evidence`: accepted line location, normalised content hash, attribution method, origin allocations and any unmatched fraction. The credited/excluded/ineligible/unattributed quantities sum to the accepted cap, within floating-point tolerance.
- `retained`: final file and blob, origin commit, eligible identity or exclusion reason, and final line numbers.
- `identities`: raw weekly activity/retention and exact exclusion/reconciliation metadata.
- `scores`: weekly team totals, lambda, raw U/A/R, component shares, full-precision and rounded weighted percentages, and unscorable reasons.
- `excludedFiles`, `warnings`, `fatal`, `status`; `incomplete` when extraction stopped before finishing.

Evidence collected before a fatal extraction failure is diagnostic only. Its raw values are not a completed measurement and its weighted percentages remain null.

The CSV quotes commas, quotes and newlines. Text cells beginning with spreadsheet formula characters are prefixed with an apostrophe; JSON preserves their exact original values. Weighted percentages are numeric percentage points, not spreadsheet fractional percentages. `displayed_percentage` is the rounded share; use `*_raw` for reconciliation. Terminal control characters are sanitised for display only.

`manifest.json` separately records the SHA-256 of the original configuration file bytes. `configHash` records the fully resolved effective configuration, so formatting and optional default spelling can be audited separately.

## Review flags

| Code | Meaning / action |
| --- | --- |
| `NON_MERGE_MAIN_COMMIT` | Direct, fast-forward, squash or rebase-shaped history; excluded, verify workflow |
| `OCTOPUS_MERGE` | Unsupported more-than-two-parent integration; unscorable |
| `COMMIT_AFTER_INTEGRATION` | Impossible recorded order beyond tolerance; commit excluded |
| `AUTHOR_COMMITTER_SKEW`, `CHILD_BEFORE_PARENT`, `MAIN_TIMESTAMP_ORDER` | Review recorded chronology; no discretionary deduction |
| `PROPORTIONAL_ATTRIBUTION` | Ambiguous matching deletions used the documented fallback |
| `UNATTRIBUTED_CHANGES`, `LOW_ATTRIBUTION_COVERAGE` | Inspect unresolved provenance and merge resolutions |
| `LARGE_CHANGE`, `INTERMEDIATE_CHURN`, `REPEATED_OR_REVERSED_DELTA` | Inspect generated/mechanical/repeated work; no hidden penalty |
| `UNKNOWN_IDENTITY`, `BOT_REVIEW`, `BOT_EXCLUDED` | Review raw identity and explicit exclusion decision |
| `REFS_OUTSIDE_SNAPSHOT` | Local refs contain unmerged or later commits; exception observation only |
| `ANALYSIS_ERROR`, `UNSCORABLE` | No defensible weighted percentage available; read the reason |

All well-formed unrecognised identities remain visible as unreconciled: without an external roster, the calculator cannot infer which accounts represent students.
