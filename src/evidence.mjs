import { Git } from './git.mjs';
import { fileFilter, identityExclusion } from './filter.mjs';
import { weekOf, weeks, configHash } from './config.mjs';
import { compare, hash, cleanLine, nonblank, warn, identityKey, username, VERSION } from './util.mjs';

function commitEligibility(commit, integration, config, baselineAncestors) {
  if (!commit || commit.parents.length > 1) return 'not_development_commit';
  if (baselineAncestors.has(commit.sha)) return 'baseline_history';
  if (weekOf(commit.timestamp, config) === null) return 'outside_assessment_window';
  if (weekOf(integration.timestamp, config) === null) return 'integration_outside_window';
  if (commit.timestamp > integration.timestamp + config.thresholds.timestampToleranceSeconds) return 'after_integration';
  return null;
}
function fileReason(file, filter, git) {
  for (const [path, mode, oid] of [[file.oldPath, file.oldMode, file.oldOid], [file.newPath, file.newMode, file.newOid]]) {
    if (mode === '000000') continue;
    if (!['100644', '100755'].includes(mode)) return 'non_regular_file';
    const reason = filter(path) ?? git.blob(oid).reason;
    if (reason) return reason;
  }
  return null;
}
function delta(git, before, after, filter, excluded, stage) {
  return git.changes(before, after).map(file => {
    const reason = fileReason(file, filter, git);
    if (reason) {
      const info = mode => ['100644', '100755'].includes(mode);
      const old = info(file.oldMode) ? git.blob(file.oldOid) : null;
      const next = info(file.newMode) ? git.blob(file.newOid) : null;
      const omitted = old?.text !== null && next?.text !== null &&
        (old || file.oldMode === '000000') && (next || file.newMode === '000000') ? git.patch(before, after, file) : null;
      excluded.push({ stage, commit: after, path: file.newPath, oldPath: file.oldPath, reason,
        beforeBytes: old?.bytes ?? null, afterBytes: next?.bytes ?? null,
        beforeNonblankLines: old?.lines ?? null, afterNonblankLines: next?.lines ?? null,
        omittedAdded: omitted?.added.length ?? null, omittedDeleted: omitted?.deleted.length ?? null });
      return { ...file, reason, added: [], deleted: [] };
    }
    return { ...file, reason: null, ...git.patch(before, after, file) };
  });
}
function pathsTogether(files) {
  const parent = new Map();
  function root(path) {
    if (!parent.has(path)) parent.set(path, path);
    let p = path;
    while (parent.get(p) !== p) p = parent.get(p);
    return p;
  }
  for (const file of files) if (file.status.startsWith('R')) {
    const a = root(file.oldPath), b = root(file.newPath);
    parent.set(a, compare(a, b) < 0 ? a : b); parent.set(b, compare(a, b) < 0 ? a : b);
  }
  return root;
}

export function collectEvidence(path, repository, config) {
  const git = new Git(path);
  const warnings = [], excludedFiles = [], integrations = [], identities = new Map();
  const fatal = [], eligibility = new Map(), seen = new Set(), acceptedCommits = [];
  const periods = weeks(config), filter = fileFilter(config);
  let submitted = null, baseline = null;
  const rawIdentity = commit => {
    const id = identityKey(commit.name, commit.email);
    if (!identities.has(id)) {
      const excluded = identityExclusion(commit, config);
      identities.set(id, { id, name: commit.name, email: commit.email, githubUsername: username(commit.email),
        excluded, reconciliation: 'unreconciled', weekly: Array(periods.length).fill(0), retained: 0 });
      if (!commit.name || !commit.email || !commit.email.includes('@')) warn(warnings, 'UNKNOWN_IDENTITY', 'Incomplete Git identity; retained for external reconciliation', { identity: id });
      if (/\[bot\]/.test(commit.name) || /\[bot\]/.test(commit.email)) warn(warnings, excluded ? 'BOT_EXCLUDED' : 'BOT_REVIEW', 'Bot-like identity detected; no identity inference was made', { identity: id, excluded });
    }
    return identities.get(id);
  };
  try {
    git.open();
    const selection = Object.hasOwn(config.repositories, repository) ? config.repositories[repository] : {};
    submitted = git.resolve(selection.submitted ?? `refs/heads/${config.mainBranch}`);
    git.verify(submitted);
    const commits = git.commits(submitted), main = git.firstParent(submitted);
    const start = Date.parse(config.start) / 1000;
    if (selection.baseline) {
      baseline = git.resolve(selection.baseline);
      if (!main.includes(baseline)) throw new Error('Baseline must be on the submitted snapshot\'s first-parent chain');
    } else {
      // Only the contiguous pre-assessment prefix is an inferred baseline.
      for (const sha of main) {
        if (commits.get(sha).timestamp >= start) break;
        baseline = sha;
      }
    }
    const baselineAncestors = new Set(baseline ? git.run(['rev-list', baseline]).trim().split('\n') : []);
    const selectedMain = main.slice(baseline ? main.indexOf(baseline) + 1 : 0);
    const fingerprints = new Map();
    for (const sha of selectedMain) {
      const merge = commits.get(sha);
      const inWindow = weekOf(merge.timestamp, config) !== null;
      if (merge.parents.length < 2) {
        if (inWindow) {
          rawIdentity(merge);
          warn(warnings, 'NON_MERGE_MAIN_COMMIT', 'Direct, fast-forward, squash or rebase history cannot establish the required integration; excluded', { commit: sha });
        }
        continue;
      }
      if (merge.parents.length !== 2) {
        if (inWindow) { warn(warnings, 'OCTOPUS_MERGE', 'More than two parents: unsupported integration', { commit: sha }); fatal.push(`Unsupported merge ${sha}`); }
        continue;
      }
      const introduced = git.introduced(merge, merge.parents[0], baseline);
      const newlyIntroduced = introduced.filter(id => !seen.has(id));
      for (const id of introduced) seen.add(id);
      if (!inWindow) {
        for (const id of newlyIntroduced) eligibility.set(id, 'integration_outside_window');
        if (merge.timestamp < start) warn(warnings, 'MAIN_TIMESTAMP_ORDER', 'An integration after the baseline is dated before the assessment start', { commit: sha });
        integrations.push({ sha, parents: merge.parents, timestamp: merge.timestamp, disposition: 'outside_assessment_window', introduced: newlyIntroduced });
        continue;
      }
      if (merge.timestamp < commits.get(merge.parents[0]).timestamp) warn(warnings, 'MAIN_TIMESTAMP_ORDER', 'Integration is dated before its first parent', { commit: sha });
      const development = newlyIntroduced.map(id => commits.get(id)).filter(c => c.parents.length < 2).sort((a, b) => compare(a.sha, b.sha));
      const branchChanges = [];
      for (const commit of development) {
        const reason = commitEligibility(commit, merge, config, baselineAncestors);
        eligibility.set(commit.sha, reason);
        const identity = rawIdentity(commit);
        const record = { ...commit, identity: identity.id, integration: sha, week: weekOf(commit.timestamp, config), eligibility: reason };
        acceptedCommits.push(record);
        if (commit.timestamp > merge.timestamp + config.thresholds.timestampToleranceSeconds) warn(warnings, 'COMMIT_AFTER_INTEGRATION', 'Commit is dated after its accepting merge and receives no credit', { commit: commit.sha, integration: sha });
        if (Math.abs(commit.timestamp - commit.authorTimestamp) > config.thresholds.authorCommitterSkewHours * 3600) warn(warnings, 'AUTHOR_COMMITTER_SKEW', 'Author and committer times differ beyond the configured threshold', { commit: commit.sha });
        if (commit.parents.some(parent => commits.get(parent)?.timestamp > commit.timestamp)) warn(warnings, 'CHILD_BEFORE_PARENT', 'Commit is dated before a parent; recorded timeline requires review', { commit: commit.sha });
        const files = delta(git, commit.parents[0] ?? git.emptyTree, commit.sha, filter, excludedFiles, 'branch');
        branchChanges.push({ commit, files });
      }
      const files = delta(git, merge.parents[0], sha, filter, excludedFiles, 'integration');
      const groupPath = pathsTogether([...files, ...branchChanges.flatMap(c => c.files)]);
      const removed = new Map();
      for (const { commit, files: changes } of branchChanges) for (const file of changes) for (const line of file.deleted) {
        const key = JSON.stringify([groupPath(file.oldPath), cleanLine(line.text)]);
        if (!removed.has(key)) removed.set(key, new Map());
        const candidates = removed.get(key);
        candidates.set(commit.sha, (candidates.get(commit.sha) ?? 0) + 1);
      }
      const evidence = [], introducedSet = new Set(development.map(c => c.sha));
      let credited = 0, unattributed = 0, ineligible = 0, identityExcluded = 0, fallback = 0;
      const allocate = (file, direction, line, allocations, method) => {
        const record = { path: direction === 'added' ? file.newPath : file.oldPath, direction, line: line.line,
          contentHash: hash(cleanLine(line.text)), method, allocations: [] };
        const unmatched = Math.max(0, 1 - allocations.reduce((n, [, units]) => n + units, 0));
        if (unmatched > 1e-12) { unattributed += unmatched; record.unattributed = unmatched; }
        for (const [origin, units] of allocations) {
          const commit = commits.get(origin), row = rawIdentity(commit);
          const reason = eligibility.get(origin) ?? null;
          const disposition = reason ?? (row.excluded ? 'identity_excluded' : 'credited');
          record.allocations.push({ commit: origin, identity: row.id, week: weekOf(commit.timestamp, config), units, disposition });
          if (reason) ineligible += units;
          else {
            // Preserve excluded identities' activity in raw exports; scoring omits them.
            row.weekly[weekOf(commit.timestamp, config)] += units;
            if (row.excluded) identityExcluded += units; else credited += units;
          }
        }
        evidence.push(record);
      };
      for (const file of files) {
        if (file.reason) continue;
        if (file.added.length) {
          const lines = git.blame(sha, file.newPath);
          for (const line of file.added) {
            const origin = lines.get(line.line)?.sha;
            allocate(file, 'added', line, introducedSet.has(origin) ? [[origin, 1]] : [],
              introducedSet.has(origin) ? 'blame_origin' : 'unattributed_merge_or_existing_origin');
          }
        }
        for (const line of file.deleted) {
          const candidates = removed.get(JSON.stringify([groupPath(file.oldPath), cleanLine(line.text)]));
          const entries = [...(candidates?.entries() ?? [])].filter(([, n]) => n > 1e-12).sort((a, b) => compare(a[0], b[0]));
          const total = entries.reduce((n, [, count]) => n + count, 0);
          const allocations = entries.map(([id, count]) => [id, count / total * Math.min(1, total)]);
          for (const [id, units] of allocations) candidates.set(id, candidates.get(id) - units);
          if (entries.length > 1) fallback++;
          allocate(file, 'deleted', line, allocations,
            entries.length === 1 ? 'unique_branch_deletion_match' : entries.length ? 'proportional_matching_deletions' : 'unattributed_deletion');
        }
      }
      const added = files.reduce((n, f) => n + f.added.length, 0), deleted = files.reduce((n, f) => n + f.deleted.length, 0);
      const accepted = added + deleted;
      const rawBranch = branchChanges.reduce((n, c) => n + c.files.reduce((m, f) => m + f.added.length + f.deleted.length, 0), 0);
      const coverage = accepted ? (accepted - unattributed) / accepted : 1;
      if (fallback) warn(warnings, 'PROPORTIONAL_ATTRIBUTION', 'Ambiguous matching branch deletions allocated in proportion to matching deletion occurrences', { integration: sha, units: fallback });
      if (unattributed) warn(warnings, 'UNATTRIBUTED_CHANGES', 'Accepted changes have no reliable introduced-commit attribution; no merge-operator credit', { integration: sha, units: unattributed });
      if (coverage < config.thresholds.minAttributionCoverage) warn(warnings, 'LOW_ATTRIBUTION_COVERAGE', 'Attribution coverage is below the configured review threshold', { integration: sha, coverage });
      if (accepted >= config.thresholds.largeChange) warn(warnings, 'LARGE_CHANGE', 'Large accepted change; inspect for generated or mechanical work', { integration: sha, units: accepted });
      if (rawBranch > 0 && (accepted === 0 || rawBranch / accepted >= config.thresholds.churnRatio)) warn(warnings, 'INTERMEDIATE_CHURN', 'Intermediate branch activity substantially exceeds the accepted merge delta', { integration: sha, branchUnits: rawBranch, acceptedUnits: accepted });
      const signature = evidence.map(e => [e.path, e.direction, e.contentHash]).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
      const fingerprint = hash(JSON.stringify(signature));
      const inverse = hash(JSON.stringify(signature.map(([p, d, h]) => [p, d === 'added' ? 'deleted' : 'added', h]).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))));
      if (accepted && (fingerprints.has(fingerprint) || fingerprints.has(inverse))) warn(warnings, 'REPEATED_OR_REVERSED_DELTA', 'A previous integration has an identical or reversed delta; inspect for churn (no automatic penalty)', { integration: sha, previous: fingerprints.get(fingerprint) ?? fingerprints.get(inverse) });
      if (accepted) fingerprints.set(fingerprint, sha);
      integrations.push({ sha, parents: merge.parents, timestamp: merge.timestamp, disposition: 'analysed', introduced: newlyIntroduced,
        added, deleted, accepted, rawBranch, credited, identityExcluded, ineligible, unattributed, fallback, coverage,
        files: files.map(({ added: a, deleted: d, ...f }) => ({ ...f, added: a.length, deleted: d.length })), evidence });
    }
    const retained = [];
    const finalFiles = git.tree(submitted);
    git.loadBlobs(finalFiles.filter(f => ['100644', '100755'].includes(f.mode)).map(f => f.oid));
    for (const file of finalFiles) {
      const reason = !['100644', '100755'].includes(file.mode) ? 'non_regular_file' : filter(file.path) ?? git.blob(file.oid).reason;
      if (reason) {
        const blob = ['100644', '100755'].includes(file.mode) ? git.blob(file.oid) : null;
        excludedFiles.push({ stage: 'retained', commit: submitted, path: file.path, reason, bytes: blob?.bytes ?? null, nonblankLines: blob?.lines ?? null });
        continue;
      }
      const counts = new Map();
      for (const line of git.blame(submitted, file.path, true).values()) {
        if (!nonblank(line.text)) continue;
        const commit = commits.get(line.sha);
        const reason = !eligibility.has(line.sha) ? 'not_eligible_accepted_development' : eligibility.get(line.sha);
        let id = null;
        if (!reason) { const row = rawIdentity(commit); row.retained++; id = row.id; }
        const key = JSON.stringify([line.sha, id, reason]);
        if (!counts.has(key)) counts.set(key, { commit: line.sha, identity: id, exclusion: reason ?? null, lines: [] });
        counts.get(key).lines.push(line.line);
      }
      retained.push({ path: file.path, oid: file.oid, attribution: [...counts.values()].sort((a, b) => compare(a.commit, b.commit)) });
    }
    // Observations are explicitly outside canonical evidence: local refs can change.
    let outsideSnapshot = [];
    try { outsideSnapshot = git.refsOutside(submitted); } catch (error) { outsideSnapshot = [{ error: error.message }]; }
    const evidence = { version: VERSION, repository, submitted, baseline,
      selection: { submitted: selection.submitted ? 'explicit' : 'main_branch', baseline: selection.baseline ? 'explicit' : 'inferred_pre_assessment_prefix' },
      config, configHash: configHash(config), periods, identities: [...identities.values()].sort((a, b) => compare(a.id, b.id)),
      commits: acceptedCommits.sort((a, b) => compare(a.sha, b.sha)), integrations, retained,
      excludedFiles, warnings, fatal, timelineBasis: 'recorded_committer_timestamps',
      attribution: 'merge-delta-v1: blame additions; normalised file/line deletion matches; proportional ambiguous matches',
      identityNotice: 'All identity-level percentages are provisional until external reconciliation.' };
    return { evidence, observations: { outsideSnapshot }, runtime: { git: asTextVersion(git), node: process.version, icu: process.versions.icu, tz: process.versions.tz, gitCalls: git.calls } };
  } catch (error) {
    // Preserve collected evidence but never issue a percentage from incomplete extraction.
    if (!submitted) throw error;
    warn(warnings, 'ANALYSIS_ERROR', error.message);
    return { evidence: { version: VERSION, repository, submitted, baseline, config, configHash: configHash(config),
      periods, identities: [...identities.values()].sort((a, b) => compare(a.id, b.id)),
      commits: acceptedCommits, integrations, excludedFiles, warnings,
      fatal: [...fatal, error.message], incomplete: true }, observations: {}, runtime: { node: process.version } };
  } finally { git.close(); }
}
function asTextVersion(git) { return git.source(['--version']).stdout.toString('utf8').trim(); }
