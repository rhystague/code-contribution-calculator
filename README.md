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

The calculator measures your share of the team's recorded contributions. Code,
tests, documentation and configuration count once they reach the analysed branch.
Code quality, teamwork and marks require separate judgement.

**One non-blank line added or deleted counts as one activity unit**, subject to
the exclusions below.

| Change | Activity credited |
| --- | ---: |
| Add 20 lines | 20 units |
| Delete 20 lines | 20 units |
| Replace 20 lines with 20 new lines | 40 units |
| Add 100 lines, then remove 80 before merging | 20 units |

Later edits or deletion do not erase accepted activity credit. The **retained**
component measures what remains at the end. Your share can still change as the
team contributes more work.

Credit goes to the authors of the changes, with no bonus for merging. Direct changes
to the analysed branch count, with a workflow warning. **Commit counts do not affect the score.**

### What does not earn credit?

- Dependencies, generated files, build output and binary files.
- The calculator itself and its reports.
- Blank lines, whitespace-only edits, file renames and traceable moves within a file.
- Recognised repetitions of changes that have already earned credit.

Adding 100 lines, deleting them, then restoring and deleting the same block again
gives **200 credited units**, not 400. Changing the author or week does not reset
this rule. Traceable restorations keep the original author's retained credit.

Large handwritten files remain eligible. Detection is not exhaustive; uncertain
cases are flagged for review.

<details>
<summary>File exclusions and repeat detection: technical details</summary>

Default file exclusions include:

- Dependencies and environments: `node_modules`, `vendor`, `.venv`, `venv`.
- Build output and caches: `dist`, `build`, `coverage`, `__pycache__`, `.next`,
  `.nuxt`, `.cache`, `.pytest_cache`, `.mypy_cache`.
- Recognised lockfiles, minified JS/CSS, source maps and generated filenames;
  recognised generation markers in the first eight lines of a file.
- Git history exports: `commit-history.txt`, `git-log.txt`, `git-history.txt`.
- Binary files, invalid UTF-8, unsupported formats, symlinks and submodule entries.
- Calculator files, contribution reports and byte-identical copies of the running
  calculator, including copies committed to the repository.

Exclusions apply to past activity and retained lines. JSON records the reasons.

`--exclude` takes priority over `--include`, which restores eligible text caught by
default exclusions. Inclusion cannot restore binary or calculator/report files,
bypass scoring rules, or restrict the report to only those paths.

Patterns match paths from the repository root: `*` stays within one folder level,
`**` crosses folders, and `?` matches one character other than `/`. For example,
`**/*.js` matches JavaScript at any depth; `*.js` matches only the root. Quote patterns
to prevent shell expansion. Braces and character classes are literal.

Repeat detection checks complete blocks, ignoring whitespace, plus their file history
and surrounding non-blank lines. Identical text elsewhere is not automatically a
repeat. Partial restorations and complex moves may remain uncertain; warnings do
not establish misconduct.

</details>

## How your score is calculated

Your overall percentage combines **three shares of the team's contribution**:

| Component | Weight | What it measures |
| --- | ---: | --- |
| **Sustained development (S)** | **50%** | Your activity across the project's weeks, considering both its amount and spread over time. |
| **Development activity (A)** | **35%** | Your share of all credited additions and deletions. |
| **Retained contribution (R)** | **15%** | Your share of credited lines still present at the end. |

Here, **S, A and R are percentage shares**, each between 0 and 100:

$$
\text{Overall contribution (\%)} = 0.50S + 0.35A + 0.15R
$$

For example, if your shares are **40% sustained**, **30% activity** and **20% retained**:

$$
0.50 \times 40 + 0.35 \times 30 + 0.15 \times 20 = \boxed{33.5\%}
$$

Sustained development considers both consistency and the amount of work. It uses
seven-day periods from the analysis start date, including inactive weeks and a
final partial week.

<details>
<summary>How the sustained component is calculated</summary>

For contributor $i$ in week $w$:

| Symbol | Meaning |
| --- | --- |
| $L_{i,w}$ | Their credited additions and deletions that week |
| $T_w$ | The team's total credited activity that week |
| $W$ | Number of weeks, including inactive and partial weeks |
| $\lambda$ | Twice the team's average weekly activity |

$$
\lambda = \frac{2 \times \text{total credited activity}}{W}
\qquad
U_i = \sum_{w=1}^{W} \frac{L_{i,w}}{T_w + \lambda}
$$

The extra term $\lambda$ reduces the influence of very small changes in quiet weeks.
Convert $U_i$ into a percentage of the team total:

$$
S_i = 100 \times \frac{U_i}{\sum_j U_j}
$$

Activity and retained percentages use their respective team totals in the same way.
All totals include Unattributed work.

**Example:** over ten weeks, two contributors each record 1,000 activity units and
have equal retained lines:

| Contributor | When they contribute | Overall share |
| --- | --- | ---: |
| A | All 1,000 units in the final week | 38.16% |
| B | 100 units in each of the ten weeks | 61.84% |

Here $\lambda = 400$; only the sustained shares differ. Scores use unrounded values;
displayed percentages use two decimal places and total 100%.

</details>

### Reading the results

**Unattributed** is work whose author could not be established. Its share stays in
the totals and is never redistributed to named contributors.

Entries are grouped by exact email, or exact name when no email is recorded. A
student using multiple emails may appear more than once. Check identities before
interpreting individual scores.

### Missing development dates

If the original date is unknown, the calculator uses when the change first entered
the analysed branch. This **integration-date fallback** preserves authorship and
the 50/35/15 weights. It never replaces a known original date.

For example:

```text
Status:               scorable with warnings
Timing fallback:      3 of 100 eligible activity units (3.00%)
```

Here, 3% of credited additions and deletions use fallback dates, after exclusions.
Integration may happen later than development, so the sustained score is partly
estimated. JSON records the unknown original date and the date used separately.

**N/A** means a required component has no usable evidence, the period is unknown,
or work cannot be dated even with fallback. Missing required history stops analysis.
With no eligible activity, the fallback percentage is also `N/A`.

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
