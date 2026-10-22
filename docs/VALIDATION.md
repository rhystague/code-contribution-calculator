# Validation notes

## Automated validation

Run `npm test` from the repository root. Tests use Node's built-in test runner and construct complete temporary Git repositories with deterministic identities, timestamps, content and merge parents. No package installation or network access is needed.

The suite covers:

- The approved numerical reference: lambda 400, Student A 38.16%, Student B 61.84%.
- The same reference through real multi-author Git histories, with final-week integration and original development weeks.
- Equal shares, one contributor, inactive weeks, partial final weeks and deterministic 100.00% rounding.
- Australian daylight-saving boundaries and strict configuration validation.
- Source/documentation parity, positive deletions and starter/baseline exclusion.
- Trivial commits, intermediate add/revert churn, whitespace-only changes and empty evidence.
- Pure renames and formatting-only renames without artificial credit.
- Unmerged branches and exact canonical reruns after local refs move.
- Multi-author branches, raw identity variants, mailmap independence and optional bot exclusion.
- Deletion-match fallback, occurrence caps and unattributed merge-only conflict resolutions.
- Binary and non-UTF-8 exclusions, symlinks and custom file filters.
- Direct/squash/rebase-shaped histories, late integration and inconsistent commit dates.
- Shallow repositories, missing reachable objects and invalid baselines.
- Shell metacharacters, unusual filenames, local diff-driver/attribute isolation and CSV formula escaping.
- Cohort continuation after an invalid repository, frozen-SHA replay, CLI errors and output placement.
- Raw-component identity reconciliation and missing-dimension handling without weight redistribution.

The implementation was exercised locally on macOS with Node 22.7.0 and Apple Git 2.50.1. Other platforms are supported in the implementation where practical but have not been certified by this local run. The fixture that creates a symlink skips on Windows where creating one may require additional privileges; POSIX filename fixtures are intended for macOS/Linux.

## v2.2 comparison

`npm run sample` assesses the same synthetic ten-week history with both implementations. Each student contributes 1,000 accepted and retained lines. Student A develops in one week and Student B develops in all ten. A separate merger creates the one-line starter and two integration commits.

| Identity | v2.2 displayed share | v3.0 displayed share |
| --- | ---: | ---: |
| Student A | 39.27% | 38.16% |
| Student B | 55.34% | 61.84% |
| Starter author / merger | 5.40% | No eligible contribution |

The legacy displayed total is 100.01% because it rounds components separately. V3's two displayed shares sum to 100.00%. The new method excludes starter/merge-operation credit, uses accepted additions plus deletions, measures the weekly distribution rather than commit counts, and reserves 15% for retained lines. These differences are intentional and are not calibrated to reproduce legacy percentages.

`examples/reference-results.json` contains full-precision raw components and the original legacy terminal output. `examples/sample-output/` contains a small complete inspectable example (CSV, JSON audit, exceptions, frozen configuration and summary). The larger reference audit is generated under `results/reference-sample/` to keep the source repository compact.

A historical comparison was also run against this repository's real pre-v3 main snapshot `14f24f4fc13902700c0cba6e427758909f45781c`, with a 1 October 2024 to 1 May 2025 UTC window. Its seven commits are direct-main history. V2.2 assigns contribution from that history; v3 correctly reports it as unscorable under the required merge-only workflow and flags all seven direct-main commits. The configuration and outputs are recorded in `examples/historical-comparison.json`.

## Remaining external validation

No historical student cohort repositories were supplied with the brief. The historical calculator repository is not a substitute for a representative student-project trial. Before summative use, run the calculator on a small authorised sample of actual submissions and inspect exclusions, complex merges and low-coverage warnings. This is a validation limit, not a request to change the approved weights or add discretionary scoring.

The synthetic suite validates the specified measurements and documented approximations. It does not establish that Git histories reveal actual effort, learning, quality or misconduct, and it does not independently authenticate timestamps or authorship.
