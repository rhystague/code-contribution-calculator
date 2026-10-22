# Scoring specification — model 3.0.0

## Scope

This is a reproducible measurement of observable, accepted Git development. It is not a measurement of hours worked, software quality, complexity, student competence, task difficulty or learning. It does not assign academic marks. All identity percentages remain provisional until external reconciliation.

Default weights are sustained development 0.50, development activity 0.35 and retained contribution 0.15. Configuration may explicitly replace them for future models; they are never silently redistributed when evidence is missing.

## Assessment boundaries

- Timestamps must include an explicit UTC offset. `timezone` is an IANA timezone, defaulting to UTC.
- The interval is `[start, end)`: start inclusive, end exclusive.
- Weeks comprise **seven local calendar days** anchored at the local time corresponding to the start instant, in the configured timezone. Daylight-saving weeks can contain 167 or 169 hours. A partial final week counts as one whole interval with no pro-rating; inactive weeks remain in W.
- A weekly boundary falling in an ambiguous or nonexistent local time is rejected instead of inventing a time. Choose a start time away from the transition (for example midday). An explicitly offset final end instant remains authoritative.
- Both an original non-merge development commit and its first accepting integration must be inside the window. Attribution uses the **committer** timestamp, never the merge timestamp or author timestamp, for weekly placement.
- A commit timestamp later than its integration beyond the configured tolerance receives no credit. Author/committer skew and child-before-parent dates produce warnings. No penalty is applied for a warning alone.
- Git timestamps are mutable. Sustained development measures the **recorded Git timeline**, not verified real-world activity.
- The submitted SHA is an assertion by the assessor that this is the accepted main snapshot. When supplied, it remains usable even if the main ref later moves or is removed. It is never substituted with HEAD.
- An explicit baseline must lie on that snapshot's first-parent chain. Otherwise, use the most recent commit in the contiguous first-parent prefix dated before the assessment start. All baseline ancestors are excluded from eligible development. Specify the true starter baseline when timestamps are unreliable.

## Accepted development and traversal

Walk main's first-parent chain in topology order. For each two-parent integration M, compare the first-parent tree M^1 against M. Enumerate commits reachable from M^2 but not M^1 or the baseline, and deduplicate by full SHA. Only newly introduced non-merge commits can receive attribution. Nested branch-merge commits do not receive automatic credit.

Direct commits and histories consistent with fast-forward, squash or rebase integration are flagged and excluded. Git alone cannot distinguish those cases conclusively. They do not erase valid evidence from other integrations. More-than-two-parent (octopus) integrations inside the window make the repository unscorable because their provenance is unsupported.

The **accepted merge delta caps credit**, including proportional allocations. Branch churn that disappears before acceptance contributes nothing. Changes accepted and later reverted in a different integration can still receive development activity: they were accepted work. Repeated/reversed integration deltas and excessive intermediate churn are flagged without undocumented deductions.

Each eligible nonblank added or deleted line is one change unit. A modified line generally supplies one deletion and one addition. Deletions are positive activity; net additions are not used. A comment, test, configuration line and source line have equal weight. `git diff --ignore-all-space --ignore-blank-lines` suppresses whitespace-only differences; blank lines are also filtered within mixed hunks. As with Git's `-w`, this is lexical whitespace ignoring and does not parse language semantics.

Rename detection uses Git's pinned 50% similarity threshold. Exact pure renames have no change volume. Otherwise unmatched deleted/added regular text files with identical whitespace-normalised nonblank line sequences are paired deterministically by path; formatting-only moves likewise receive zero activity. A substantive move below the similarity threshold may remain a deletion plus addition. This is a documented line-based limitation.

## Attribution evidence and approximations

### Additions

For accepted added-line positions, run whitespace-ignoring blame on the resulting merge tree. If the origin is a newly introduced non-merge commit, allocate the unit to that commit's raw author and recorded week. An origin outside the eligibility window is labelled ineligible; its share is **not** redistributed to eligible authors. A merge-only resolution, nested merge resolution or existing non-introduced origin remains unattributed. No fallback assigns those additions to the merge operator.

Movement/copy tracing is deliberately reserved for retained contribution; newly accepted copies can be development activity even if their retained provenance belongs to starter code.

### Deletions

Git does not retain direct per-deleted-line authorship. Index the newly introduced branch commits' deleted lines by rename-connected path and whitespace-normalised line contents. Match each accepted deleted line against that index:

1. One candidate commit: `unique_branch_deletion_match`.
2. Several candidates: `proportional_matching_deletions`, weighted by each candidate's matching deletion occurrences. This is an explicit fallback, reported with a warning.
3. No candidate: unattributed; no fabricated author or week.

Consume the matching occurrence capacity as each accepted line is allocated, so one branch deletion cannot explain multiple additional merge-only deletions. Ineligible and excluded candidates participate in the matching before their shares are labelled; no surviving contributor inherits their portion.

Even a unique text match is evidence of a matching branch deletion, not proof of intent or exact line ancestry. Repeated content, intermediate removal/restoration and complex rename histories can make provenance ambiguous. Fractional units are retained at full numerical precision. Line hashes, file/line positions, origin SHAs, allocation units and dispositions are exported for every accepted change; source text is recoverable from the Git objects rather than embedded in reports.

Unattributed changes are counted separately. Low coverage is a review flag, not an invented grade penalty. The available attributed evidence can be provisionally scored when all required dimensions remain usable. Assessors should inspect low-coverage reports before using those scores.

## Raw components

For included identity i in week w, let L(i,w) be its credited accepted change units. Let T(w) be the included team's total units in week w; W includes every assessment week.

```text
lambda = 2 × sum_w T(w) / W
U(i) = sum_w [ L(i,w) / (T(w) + lambda) ]
A(i) = sum_w L(i,w)
```

When the whole period has zero eligible activity, the stored raw U values are zero and the repository is unscorable. There is no flat active-week bonus or independent commit-count bonus.

R(i) counts final eligible nonblank lines. Blame runs against the submitted tree with `-w -M -C -C`. Only origins that are eligible accepted development commits count. Starter/baseline code, direct-main work, out-of-window origins and merge-only resolutions do not count. Whitespace/movement/copy detection is Git's heuristic; pin Git for exact reruns. Small copies below Git's detection thresholds may not be recognised.

## Normalisation and rounding

For included contributors:

```text
P(i) = 100 × [0.50 U(i)/sum(U) + 0.35 A(i)/sum(A) + 0.15 R(i)/sum(R)]
```

All positively weighted dimensions must have a positive denominator. Otherwise preserve raw results and emit `unscorable`, with null weighted percentages. A deletion-only project with no eligible retained lines therefore cannot receive a weighted score under the default model. Weights are not redistributed.

IEEE-754 double precision is retained internally and in raw JSON/CSV numeric fields. Final displayed percentages use a largest-remainder allocation of 10,000 hundredths of a percentage point. Fractional remainders are ordered descending, with the exact JSON `[name,email]` identity key as the deterministic tie-break. Displayed included shares sum to 100.00%; rounding does not modify raw data.

## Identity reconciliation

Raw Git **name/email pairs** are keys; no case folding, fuzzy matching, automatic mailmap or alias consolidation occurs. GitHub usernames are only parsed from standard no-reply addresses. Co-authored-by trailers are not independently authenticated authors and are not split into additional identities in v3.0.

All identities are marked `unreconciled`. Without a roster the tool cannot determine which well-formed identity is a student; malformed identities and known bot-like names are flagged. Other contributors remain visible. Exact configured exclusions and optional known GitHub bot exclusions are explicit and audited.

For downstream reconciliation:

1. Add each student's identities' raw U, A and R separately.
2. Remove staff/bots/non-students.
3. Recompute each component denominator and the weighted result.
4. Apply the same final rounding rule.

Do not recompute U or lambda after this downstream operation: aggregate the already measured raw U as approved. Explicit exclusions applied in the assessment configuration affect the initial team's T and lambda; applying different exclusions at extraction time is a different, hashed configuration. Excluded identities retain their measured activity/retention and diagnostic U but have no percentage. To include a previously excluded identity, rerun with the intended configuration.

`normalise()` in `src/scoring.mjs` supports already-aggregated raw rows. Reconciliation and academic mark policy are intentionally external. For N reconciled students, the optional informational contribution factor is `N × P(i)/100`.

## Determinism and operational limits

Read immutable Git objects through an isolated bare Git view. Student working-tree edits, custom diff drivers, hooks, local attributes, replacement refs and mailmap identity rewriting are not used. Raw author metadata comes from the original commit objects. Object traversal, patch algorithm, rename threshold, identity sorting and output key ordering are fixed. Processes use argument arrays without a shell.

Canonical evidence includes model version, effective configuration/hash, resolved SHAs, week boundaries, raw evidence and scores. A separate SHA-256 covers that canonical JSON. Runtime Git/Node/ICU/timezone-data versions and observations of branch refs outside the snapshot are outside that hash. Local refs may change after submission without changing canonical scores/evidence. Preserve exact tool/runtime versions and Git objects to reproduce results.

Shallow and partial/promisor clones, grafts, missing reachable objects and unsupported data fail explicitly. Binary/NUL and invalid UTF-8 data are excluded with their byte counts; non-UTF-8 paths fail safely rather than merging distinct paths. Symlinks and submodules are excluded. There is a 256 MiB per-process output limit and 120-second Git-process timeout; exceeding either makes the repository unscorable, with any collected raw evidence marked incomplete. The next cohort repository still runs.

The tool caches commit metadata, blobs and blame results within a repository and releases them between repositories. It does not traverse history once per student. Patch/blame process counts still grow with changed files; unusually large monorepositories should be trialled before cohort marking.

Technical references: [Git diff](https://git-scm.com/docs/git-diff), [Git blame](https://git-scm.com/docs/git-blame), [Git rev-list](https://git-scm.com/docs/git-rev-list). These document Git behaviour; the academic scoring policy comes from the approved implementation brief.
