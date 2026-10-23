# Code Contribution Calculator

Version 3 measures contributions accepted into a repository's integration branch:
**50% sustained development, 35% development activity and 15% retained code**.
Deletions earn activity credit. Later removal of work does not erase earlier activity.

One file, **`contribution.mjs`**, runs with **Node.js 20+ and Git**. It uses only
Node's built-in modules. There is no package installation, build step, account,
network access or configuration file.

## Run it

From the repository you want to analyse:

```sh
node /path/to/contribution.mjs
node /path/to/contribution.mjs --code
```

This repository also provides:

```sh
npm run contribution
npm run contribution -- --code
```

For another project, copy `contribution.mjs` into its root and add
`"contribution": "node contribution.mjs"` to its existing `package.json` scripts.
A project without `package.json` can use this minimal file, without running
`npm install`:

```json
{
  "scripts": {
    "contribution": "node contribution.mjs"
  }
}
```

Academics can run their own trusted copy by absolute path from a submitted
repository. There is no need to execute a student's npm shortcut or submitted
calculator. The same script, Git objects and options produce the same calculation.

## Options

| Option | Effect |
| --- | --- |
| `--code` | Show raw and eligible additions/deletions, retained lines, commits and excluded repetitions. |
| `--start HASH` | Exclude this mainline snapshot as a baseline; assess subsequent accepted changes. |
| `--end HASH` | Include this mainline snapshot as the endpoint. |
| `--startdate YYYY-MM-DD` | Restrict work from this UTC day, inclusive. |
| `--enddate YYYY-MM-DD` | Restrict work through this UTC day and freeze the final snapshot. |
| `--exclude "GLOB"` | Add a path exclusion; repeat as needed. |
| `--include "GLOB"` | Override a default text exclusion; repeat as needed. |
| `--no-csv` | Suppress the default CSV export. |
| `--json` | Also export the detailed evidence ledger. |
| `--help` | Show command help. |

```sh
npm run contribution -- --start abc1234 --end def5678 --code
npm run contribution -- --startdate 2026-03-01 --enddate 2026-05-31
npm run contribution -- --exclude "data/**" --include "build/scripts/**"
npm run contribution -- --code --json --no-csv
```

Use the extra `--` when passing options through npm. Commit options accept full
or unambiguous abbreviated hashes, not branch names or revision expressions.
Both endpoints must be on the selected branch's first-parent history. A merged
feature commit is not itself a mainline snapshot. The excluded start must precede
the inclusive end. Without limits, the initial commit is included.

Date and commit limits intersect. Snapshot cutoffs use mainline **committer dates**;
weekly activity uses original **author dates** where known. If an original date is
unknown, the first mainline integration's committer date is used as a visible fallback.
Work must have been accepted within the selected mainline range and meet the date
limits. Baseline/starter lines do not earn retained credit just because their author
also works later. The period begins at the baseline's committer date, or the earliest
recorded author/root date for full history, and ends at the selected snapshot's
committer date. Date limits restrict this period. Known original dates are never
replaced to move work inside a selected range. An eligible change with a known date
outside the effective reporting period, or without a usable fallback date, still
prevents an overall score. No calculation depends on today's date or the machine's timezone.

## Which branch?

Selection is offline and independent of your checkout:

1. If exactly one of `main` or `master` is available, choose it, even if a recorded
   remote default names another branch.
2. Otherwise use an unambiguous locally recorded remote default, such as
   `origin/HEAD`. This can disambiguate `main` and `master` or select a custom name.
3. If selection remains ambiguous or unavailable, stop with an explanation.

The local branch takes priority over its cached remote-tracking reference. When
only cached versions exist, conflicting candidates cause an error. The report
shows the selected reference, selection method and exact snapshot; differing cached
state produces a warning. The calculator does not fetch or change your checkout.
Local metadata does not establish the current remote state.

## What counts?

Each accepted, eligible non-blank line added or deleted is one activity unit.
Replacing 20 lines with 20 new lines gives 40 units. Adding 100 lines then removing
80 **before integration** gives 20 accepted additions. A merge earns no extra units.

The engine compares consecutive mainline snapshots and traces accepted lines into
the development history. Additions belong to their originating authors; deletions
belong to the authors who removed them. Merge-only resolutions without originating
evidence remain unresolved. Direct mainline changes count, with a workflow warning.
Whitespace-only changes, pure renames and uniquely traceable same-file block moves
earn no activity. Authored source, tests, documentation and configuration carry
equal weight. This is line evidence, not a semantic measure of code quality.

Previously accepted activity and its weekly entry remain after later replacement
or deletion. The separate retained component counts surviving eligible lines.
Restoring traceable previously accepted code retains its original owner.

### Repeated changes

The first accepted addition and first deletion of a block can earn credit.
Restoring that exact block at the same location, then deleting it again, adds no
further activity or weekly credit, even under another identity or in another week.
For add 100 / delete 100 / restore 100 / delete 100, the report shows 400 raw units,
200 eligible units and 200 excluded repetitions.

Matching uses the entire whitespace-normalised changed block, its file lineage
(following Git-detected renames), and the accepted line IDs immediately before
and after it, skipping blank lines. File boundaries act as anchors. This prevents common text in unrelated
locations from being treated as repetition. It is conservative: changed context,
partial restorations and complex rearrangements may not establish an exact match.
It does not detect every attempt to inflate contributions or establish misconduct.
Matching removed text that reappears with different surrounding lines is flagged
for review without automatically excluding it or asserting original ownership.

### Exclusions

Default exclusions cover:

- Dependency/environment directories: `node_modules`, `vendor`, `.venv`, `venv`.
- Build/cache directories: `dist`, `build`, `coverage`, `__pycache__`, `.next`,
  `.nuxt`, `.cache`, `.pytest_cache`, `.mypy_cache`.
- Recognised package lockfiles, minified JS/CSS, source maps and generated filenames.
- Recognised Git history exports: `commit-history.txt`, `git-log.txt`, `git-history.txt`.
- Recognised generation markers in the first eight lines of a file.
- Binary/invalid UTF-8 files, unsuitable formats, symlinks and submodule entries.
- Calculator files and contribution reports, including committed reports and
  byte-identical copies of the running calculator.

File size alone is never an exclusion rule. Exclusions apply to historical changes
as well as retained files. The JSON ledger records excluded file versions, matched
reasons and applied inclusion overrides. Automatic rules cannot identify all
generated or copied material.

Patterns match the complete repository-relative path: `*` matches within a path
segment, `**` crosses directories, and `?` matches one non-slash character.
For example, `**/*.js` matches JavaScript at any depth; `*.js` matches only the root.
Quote patterns so your shell does not expand them. Braces and character classes
are literal characters, not extra glob syntax.

Explicit exclusions win over explicit inclusions. An inclusion restores eligible
text caught by a default rule; it does not limit the whole report to that pattern.
It cannot restore binary/unsuitable files or calculator/report files, or bypass
scope, authorship or repetition rules.

## Calculation

Seven-day intervals begin at the effective period start. Inactive intervals and a
final partial interval count; an event exactly seven days later starts the next
interval. Commit counts are descriptive and have no scoring weight.

For identity `i` and week `w`:

```text
L(i,w) = eligible additions + deletions in that week
T(w)   = team total in that week
W      = number of weeks, including inactive/partial weeks
lambda = 2 × total eligible activity / W
U(i)   = sum_w L(i,w) / (T(w) + lambda)
A(i)   = total eligible additions + deletions
R(i)   = eligible retained lines

Overall(i) = 100 × [0.50 × U(i)/sum(U)
                 + 0.35 × A(i)/sum(A)
                 + 0.15 × R(i)/sum(R)]
```

An explicit ten-week fixture with A contributing 1,000 units in week ten, B
contributing 100 each week, and equal retained lines gives **A 38.16%, B 61.84%**
(`lambda = 400`). Full precision is retained internally. Displayed component and
overall shares use deterministic largest-remainder rounding to total 100%.

Git identities are grouped only by exact email (or exact name when email is absent).
All recorded names/emails remain in JSON. A Git identity is not a verified student.
The calculator does not infer team size, reconcile students or calculate marks.

An **Unattributed** bucket keeps work with unresolved authorship in team totals and
percentages. Known authorship is preserved even if the original development date is
unknown. Performing a merge does not transfer credit to the merger.

### Missing development dates

When an eligible change has no known original development date, use the committer
date of the mainline commit that first accepted that change. This applies to both
additions and deletions, including merge-only resolutions. The change enters that
week's ledger under its known author or the Unattributed bucket. Original dates that
are known continue to take precedence; later merges, restorations and repeated
changes cannot move existing credit into another week.

The **50% sustained / 35% activity / 15% retained** formula, smoothing and denominators
stay unchanged. Fallback activity remains in all applicable totals. No weight or
Unattributed share is redistributed to other contributors.

Reports show the number and percentage of eligible activity units using fallback:

```text
Status:               scorable with warnings
Timing fallback:      3 of 100 eligible activity units (3.00%)
```

The denominator is all eligible accepted additions plus deletions in the selected
scope, after file and repetition exclusions. It is not commits or retained lines.
With no eligible activity the percentage is `N/A`. There is no arbitrary coverage
threshold: the amount is always visible. Integration may occur after development,
so sustained scores using fallback are partly estimated. JSON preserves the unknown
original date separately from the integration date used.

An overall score remains unavailable when a required component has no eligible
evidence, no usable reporting period exists, or eligible activity cannot be placed
even with fallback. Missing required history stops analysis. In an unscorable report,
available component figures are partial evidence and overall is `N/A`/`null`.

## Reports

- The terminal shows scope, component shares, overall shares, timing-fallback counts
  and percentage, and warnings. A calculable report with warnings is labelled
  **scorable with warnings**.
  `--code` expands this view without changing the calculation.
- `contribution-summary.csv` is written by default, with identity/evidence columns,
  component percentages, status, warnings, filters and resolved scope. Appended
  columns give team-wide total, original-timed, fallback and unplaced activity,
  fallback percentage, and each identity's fallback activity count.
- `--json` also writes `contribution-evidence.json`: full-precision values, raw
  identities, weekly activity, accepted line IDs and originating commits, retained
  attribution, exclusions, unresolved evidence and direct-commit IDs. It contains
  enough data to recalculate the score or reconcile identities externally. `timing`
  contains `totalActivity`, `originalActivity`, `integrationFallbackActivity`,
  `unplacedActivity` and `fallbackPercentage`. Each identity also has an
  `integrationFallbackActivity` count. Accepted events retain `authorTime` (null when
  unknown), `integrationTime`, the selected `activityTime`, `timingSource` (`author`
  or `integration`) and `week`. Excluded repetitions have no selected timing or week.

Reports are written in the current directory, replacing previous reports of the
same name. Presentation flags do not change the evidence. CSV cells are quoted and
formula-like identity fields escaped for spreadsheets; JSON preserves raw metadata.
CSV/JSON keep the machine status `scorable` or `unscorable`; warnings are separate.
Exit codes: **0** = scorable report, including one with fallback warnings,
**2** = report with unavailable overall score,
**1** = invalid input, unavailable history or another failure. A failed run does
not refresh older exports.

## Evidence limits

Use a complete local clone. Shallow histories and active ancestry grafts are rejected;
required missing objects stop analysis. Replacement objects are ignored. Git dates
can be edited; detectable anomalies are flagged, not treated as verified timestamps.
Squashing or rewriting history can destroy attribution that this tool cannot recover
or always detect. Complex merges may leave unresolved authorship and require the
integration-date fallback. Fallback dates describe acceptance, not verified development time.
Metadata and paths must be valid UTF-8; unsupported encodings stop analysis rather
than silently combining identities or paths. Reports with a date cutoff are also
unscorable if an ancestor within the chosen snapshot is dated after that cutoff.

Analysis reads Git objects through argument-based Git calls. It does not run
repository applications, hooks, external diff drivers or text conversion commands.
For assessment, retain the report's snapshot hash, filters, calculator version and
calculator SHA-256 alongside the result. Review limitations and identity evidence
before using percentages in an assessment process.

## Development and previous versions

```sh
npm test
```

Tests use Node's built-in test runner and temporary Git repositories. No dependency
installation is needed. They cover scoring, scope, authorship, repetitions,
exclusions, exports and standalone/npm execution.

The original `contribution-scriptv2.2.mjs` and `py-contribution-scriptv2.2.py` remain
available for reproducing legacy results. They retain their original 75% net-lines /
25% commits model and interface; the new npm shortcut uses version 3.
