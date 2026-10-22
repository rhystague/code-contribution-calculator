# Code Contribution Calculator v3.0

Run one offline command to measure each Git identity's contribution to accepted group-project work. The default model assigns **50% to sustained development, 35% to development activity and 15% to retained contribution**. It measures recorded development evidence; code quality, competence and academic marks are assessed separately.

## Quick start

Requirements: **Node.js 22 or later**, **Git 2.39 or later**, and complete local repositories. No npm installation, GitHub API, authentication or cloud service is needed for analysis.

1. Copy `contribution.config.example.json` to `contribution.config.json`.
2. Set the assessment start/end timestamps, timezone and main branch. End is **exclusive**. Use midnight on the following day to include a whole final day.
3. Run either command from this calculator's directory:

```sh
node assess.mjs --repo ../group-project --config contribution.config.json
node assess.mjs --repos ../submissions --config contribution.config.json --output ../results
```

The cohort mode assesses each immediate, non-hidden subdirectory. It continues after an individual repository fails. Output defaults to `./results`. Existing report files with the same names are replaced; use a fresh output directory for each assessment. Never place the output in an assessed repository.

Use `node assess.mjs --help` for arguments. Exit status `0` means every repository was scored or flagged, `1` means at least one was unscorable, and `2` means invalid usage/configuration or an output failure.

## Required project workflow

Protect main and require feature branches and pull requests with **merge commits only**. Do not use squash or rebase merges. This tool detects history inconsistent with that workflow but cannot prove that a GitHub pull request existed. Enforce that requirement through repository rules.

Only accepted work in the selected main snapshot is eligible. Both the development commit's recorded **committer time** and the accepting merge must be inside the assessment period. The merger receives no automatic credit. Unmerged work is excluded.

For summative marking, supply the submitted and (where available) starter/baseline SHAs:

```json
{
  "start": "2026-03-02T00:00:00+11:00",
  "end": "2026-05-11T00:00:00+10:00",
  "timezone": "Australia/Sydney",
  "mainBranch": "main",
  "repositories": {
    "group-project": {
      "submitted": "FULL_40_OR_64_CHARACTER_COMMIT_SHA",
      "baseline": "FULL_40_OR_64_CHARACTER_COMMIT_SHA"
    }
  }
}
```

Replace the placeholders with full commit IDs. Repository keys are directory basenames. An explicit baseline must be on the submitted snapshot's first-parent chain. Without one, the tool uses the contiguous pre-assessment prefix of that chain as the baseline. Without a submitted SHA, it resolves the configured local main branch once. It never fetches or checks out student repositories.

## Read the results

| File | Purpose |
| --- | --- |
| `contributions.csv` | Raw U/A/R, component percentages and provisional weighted percentages per Git identity |
| `audit/*.json` | Exact configuration, SHAs, commits, accepted deltas, per-line attribution evidence, weekly activity, exclusions and warnings |
| `exceptions.json` | Workflow, timestamp, attribution, mechanical-change and local-reference issues |
| `summary.txt` | Terminal summary saved as text |
| `manifest.json` | Source configuration hash, audit paths and evidence hashes |
| `frozen.config.json` | Resolved submitted/baseline SHAs for repeat assessment |

A **flagged** result has usable evidence plus warnings requiring attention. An **unscorable** result has no percentage: a required dimension is empty, history is incomplete, or extraction failed. Existing raw measurements are retained. A flag does not imply misconduct.

All percentages are **provisional identity-level results**. No roster or identity matching is required. Name/email pairs are preserved exactly; different names with the same email remain distinct. GitHub usernames are recovered only from recognisable GitHub no-reply addresses. No API lookup or fuzzy matching occurs.

Before sending scores to a mark calculator, combine each student's raw **U, A and R**, remove non-students and normalise each dimension again. **Do not add rounded percentages or renormalise the weighted percentages.** See [reconciliation](docs/METHODOLOGY.md#identity-reconciliation). The informational relative contribution factor is `number of reconciled students × percentage / 100`; the tool does not guess that student count or change marks.

To repeat the same submitted history after repositories change:

```sh
node assess.mjs --repos ../submissions --config ../results/frozen.config.json --output ../results-repeat
```

Keep repository directory names stable and retain the Git objects. Pin the calculator release and Git/Node versions for exact reproducibility. Local branch observations and runtime diagnostics sit outside the canonical, hashed scoring evidence.

## Method and configuration

Read the [scoring specification](docs/METHODOLOGY.md) for the formulas, calendar-week boundaries, attribution approximations and limits. Read [configuration and audit fields](docs/CONFIGURATION.md) for exclusions, thresholds and output interpretation.

Default exclusions cover common dependencies, generated/minified files, build output, coverage and lockfiles. Ordinary source, tests, documentation, scripts and configuration receive the same per-line treatment. Binary/non-UTF-8 files, symlinks and submodules are excluded explicitly. Review exclusions for your technology; no filename rule can identify every generated file.

## Validation and examples

```sh
npm test
npm run sample
```

Tests construct real Git repositories with fixed identities/timestamps. No dependencies are installed. `npm run sample` generates the ten-week reference assessment in `results/reference-sample`, compares it with the archived v2.2 script, and refreshes the small checked-in [sample report](examples/sample-output/summary.txt) and [reference results](examples/reference-results.json).

The required equal-volume/equal-retention reference yields **38.16%** for the final-week contributor and **61.84%** for the sustained contributor. See [validation notes](docs/VALIDATION.md) for coverage and limits.

## Legacy v2.2

The original scripts, README and screenshot are preserved unchanged under [`legacy/`](legacy/). They use the old 75% net-additions / 25% commit-count model and are not maintained as a second v3 implementation. The original main snapshot is `14f24f4fc13902700c0cba6e427758909f45781c`, also preserved on `legacy/v2.2`. The implementation workspace has a `v2.2` tag at that snapshot; the connected GitHub tooling did not support publishing that tag.
