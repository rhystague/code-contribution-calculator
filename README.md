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
weekly activity uses original **author dates**, never a substituted merge date.
Work must have been accepted within the selected mainline range and meet the date
limits. Baseline/starter lines do not earn retained credit just because their author
also works later. The period begins at the baseline's committer date, or the earliest
recorded author/root date for full history, and ends at the selected snapshot's
committer date. Date limits restrict this period. Original activity that cannot be
placed within it makes the overall score unavailable rather than being shifted to
another week. No calculation depends on today's date or the machine's timezone.

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

When authorship is unresolved but timing is available, an **Unattributed** bucket
stays in the team totals and percentages. Missing required timing, missing history,
or a component with no evidence prevents an overall score. Weights are never
redistributed. In an unscorable report, available component figures are partial
evidence, and the overall is `N/A`/`null`, never an invented zero.

## Reports

- The terminal shows scope, component shares, overall shares and warnings.
  `--code` expands this view without changing the calculation.
- `contribution-summary.csv` is written by default, with identity/evidence columns,
  component percentages, status, warnings, filters and resolved scope.
- `--json` also writes `contribution-evidence.json`: full-precision values, raw
  identities, weekly activity, accepted line IDs and originating commits, retained
  attribution, exclusions, unresolved evidence and direct-commit IDs. It contains
  enough data to recalculate the score or reconcile identities externally.

Reports are written in the current directory, replacing previous reports of the
same name. Presentation flags do not change the evidence. CSV cells are quoted and
formula-like identity fields escaped for spreadsheets; JSON preserves raw metadata.
Exit codes: **0** = scorable report, **2** = report with unavailable overall score,
**1** = invalid input, unavailable history or another failure. A failed run does
not refresh older exports.

## Evidence limits

Use a complete local clone. Shallow histories and active ancestry grafts are rejected;
required missing objects stop analysis. Replacement objects are ignored. Git dates
can be edited; detectable anomalies are flagged, not treated as verified timestamps.
Squashing or rewriting history can destroy attribution that this tool cannot recover
or always detect. Complex merges may leave unresolved evidence and prevent scoring.
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
