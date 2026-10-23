import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, calculate, parseOptions, roundShares, toCSV, terminal, glob } from '../contribution.mjs';

const script = fileURLToPath(new URL('../contribution.mjs', import.meta.url));
const temporary = [];
after(() => temporary.forEach(path => rmSync(path, { recursive: true, force: true })));
const date = day => new Date(Date.UTC(2026, 0, 1 + day, 12)).toISOString();
function repo(branch = 'main') {
  const cwd = mkdtempSync(join(tmpdir(), 'contribution-test-')); temporary.push(cwd);
  const git = (args, options = {}) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...options.env }, ...options,
  }).trim();
  git(['init', '-b', branch]); git(['config', 'user.name', 'Alice']); git(['config', 'user.email', 'alice@example.test']);
  let day = 0;
  const put = (path, text) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text); };
  const env = (author, at, committed = at) => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.test`, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author.toLowerCase()}@example.test`, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: committed });
  const commit = (author = 'Alice', at = date(day++), committed = at) => {
    git(['add', '-A']); git(['commit', '--allow-empty', '-m', 'fixture'], { env: env(author, at, committed) }); return git(['rev-parse', 'HEAD']);
  };
  const merge = (branch, at = date(day++)) => { git(['merge', '--no-ff', '--no-edit', branch], { env: env('Merger', at) }); return git(['rev-parse', 'HEAD']); };
  return { cwd, git, put, commit, merge, env, read: options => analyse(cwd, options), remove: path => rmSync(join(cwd, path), { force: true, recursive: true }) };
}
const row = (report, name) => report.identities.find(r => r.names.includes(name));
const lines = (count, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i}\n`).join('');
const sum = (report, key) => report.identities.reduce((a, r) => a + r[key], 0);

function createMergeTimingFixture() {
  const fixture = repo();
  fixture.put('base.txt', 'base\n');
  const baseline = fixture.commit('Alice', date(0));
  fixture.git(['checkout', '-b', 'feature']);
  fixture.put('branch.txt', 'branch\n');
  fixture.commit('Bob', date(1));
  fixture.git(['checkout', 'main']);
  fixture.git(['merge', '--no-ff', '--no-commit', 'feature']);
  fixture.put('resolution.txt', 'new at merge\n');
  fixture.put('dist/generated.txt', lines(100));
  const integration = fixture.commit('Merger', date(14));
  return { fixture, baseline, integration };
}

function findUnattributed(summary) {
  return summary.bucket;
}

function findResolutionEvidence(evidence) {
  return evidence.path === 'resolution.txt';
}

function writeCommitWithUnknownAuthorDate(fixture, author, committed) {
  fixture.git(['add', '-A']);
  const tree = fixture.git(['write-tree']);
  const parent = fixture.git(['rev-parse', '--verify', 'HEAD'], { stdio: 'pipe' });
  const committerTime = Date.parse(committed) / 1000;
  const object = `tree ${tree}\nparent ${parent}\n` +
    `author ${author} <${author.toLowerCase()}@example.test> 9999999999999 +0000\n` +
    `committer Recorder <recorder@example.test> ${committerTime} +0000\n\nUnknown author date\n`;
  const commitHash = execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], {
    cwd: fixture.cwd,
    input: object,
    encoding: 'utf8',
  }).trim();
  fixture.git(['update-ref', 'HEAD', commitHash]);
  return commitHash;
}

function parseCsvRecord(record) {
  const values = [];
  for (const match of record.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)) {
    values.push(match[1].replace(/""/g, '"'));
  }
  return values;
}

test('full history, deletion credit and retained ownership; exact repeats cross identities/weeks', () => {
  const r = repo(); r.put('code.txt', lines(100)); r.commit('Alice', date(0));
  r.remove('code.txt'); r.commit('Bob', date(7));
  r.put('code.txt', lines(100)); const restore = r.commit('Carol', date(14));
  const restored = r.read();
  assert.equal(row(restored, 'Alice').retained, 100);
  assert.equal(row(restored, 'Bob').deleted, 100);
  assert.equal(row(restored, 'Carol').added, 0);
  assert.equal(row(restored, 'Carol').repeated, 100);
  r.remove('code.txt'); r.commit('Dave', date(21));
  const result = r.read();
  assert.equal(sum(result, 'rawAdded') + sum(result, 'rawDeleted'), 400);
  assert.equal(sum(result, 'activity'), 200);
  assert.equal(sum(result, 'repeated'), 200);
  assert.equal(row(result, 'Alice').weekly[0], 100);
  assert.equal(result.status, 'unscorable');
  assert.deepEqual(r.read({ end: restore }).identities, restored.identities);
});

test('unrelated identical text is not a repeated change', () => {
  const r = repo(); r.put('one.txt', 'same\n'); r.commit(); r.remove('one.txt'); r.commit('Bob');
  r.put('two.txt', 'same\n'); r.commit('Carol');
  const result = r.read(); assert.equal(row(result, 'Carol').added, 1); assert.equal(sum(result, 'repeated'), 0);
});

test('baseline excludes starter retained credit, even when its author later contributes', () => {
  const r = repo(); r.put('a.txt', 'starter\n'); const start = r.commit();
  r.put('b.txt', 'new\n'); const end = r.commit();
  const result = r.read({ start, end });
  assert.equal(row(result, 'Alice').retained, 1); assert.equal(row(result, 'Alice').added, 1);
  assert.equal(result.scope.start, start); assert.equal(result.scope.end, end);
  assert.throws(() => r.read({ start: end, end: start }), /precede/);
  assert.throws(() => r.read({ end: 'HEAD' }), /commit hash/);
});

test('replacement preserves accepted activity but changes surviving attribution', () => {
  const r = repo(); r.put('a.txt', lines(20)); r.commit(); r.put('a.txt', lines(20, 'replacement')); r.commit('Bob');
  const report = r.read(); assert.equal(row(report, 'Alice').activity, 20); assert.equal(row(report, 'Alice').retained, 0);
  assert.equal(row(report, 'Bob').activity, 40); assert.equal(row(report, 'Bob').retained, 20);
});

test('a merge credits original authors, ignores discarded branch churn and gives no merge bonus', () => {
  const r = repo(); r.put('starter.txt', 'starter\n'); r.commit('Starter', date(0));
  r.git(['checkout', '-b', 'feature']); r.put('a.txt', lines(100)); r.commit('Alice', date(1));
  r.put('a.txt', lines(80)); r.commit('Alice', date(2)); r.put('b.txt', lines(20)); r.commit('Bob', date(3));
  const feature = r.git(['rev-parse', 'HEAD']); r.git(['checkout', 'main']); const end = r.merge('feature', date(14));
  const report = r.read(); assert.equal(row(report, 'Alice').added, 80); assert.equal(row(report, 'Bob').added, 20);
  assert.equal(row(report, 'Merger').activity, 0); assert.equal(row(report, 'Merger').retained, 0);
  assert.equal(row(report, 'Alice').weekly[0], 80); assert.equal(row(report, 'Alice').weekly[2], 0);
  assert.throws(() => r.read({ end: feature }), /first-parent/);
  r.git(['checkout', 'feature']); assert.deepEqual(r.read(), report); assert.equal(report.scope.end, end);
});

test('merge deletion belongs to deleting author rather than merger or original owner', () => {
  const r = repo(); r.put('a.txt', lines(5)); r.put('keep.txt', 'keep\n'); r.commit();
  r.git(['checkout', '-b', 'feature']); r.remove('a.txt'); r.commit('Bob'); r.git(['checkout', 'main']); r.merge('feature');
  const report = r.read(); assert.equal(row(report, 'Bob').deleted, 5); assert.equal(row(report, 'Merger').deleted, 0);
  assert.equal(report.status, 'scorable');
});

test('merge-only changes use first integration timing, preserve weights and export coverage', function testMergeTiming() {
  const { fixture, integration } = createMergeTimingFixture();
  const report = fixture.read();
  const unattributed = report.identities.find(findUnattributed);
  const accepted = report.evidence.accepted.find(findResolutionEvidence);
  assert.equal(report.status, 'scorable');
  assert.deepEqual(report.reasons, []);
  assert.equal(unattributed.activity, 1);
  assert.equal(unattributed.retained, 1);
  assert.equal(unattributed.integrationFallbackActivity, 1);
  assert.deepEqual(unattributed.weekly, [0, 0, 1]);
  assert.deepEqual(row(report, 'Bob').weekly, [1, 0, 0]);
  assert.deepEqual(report.teamWeekly, [2, 0, 1]);
  assert.equal(report.lambda, 2);
  assert.equal(row(report, 'Merger').activity, 0);
  assert.equal(row(report, 'Merger').overall, 0);
  assert.equal(accepted.authorTime, null);
  assert.equal(accepted.originCommit, null);
  assert.equal(accepted.integration, integration);
  assert.equal(accepted.integrationTime, date(14));
  assert.equal(accepted.activityTime, date(14));
  assert.equal(accepted.timingSource, 'integration');
  assert.equal(accepted.week, 2);
  assert.equal(report.timing.totalActivity, 3);
  assert.equal(report.timing.originalActivity, 2);
  assert.equal(report.timing.integrationFallbackActivity, 1);
  assert.equal(report.timing.unplacedActivity, 0);
  assert.equal(report.timing.fallbackPercentage, 100 / 3);
  assert.ok(Math.abs(unattributed.overall - 36.6666666667) < 1e-9);
  let displayedTotal = 0;
  for (const summary of report.identities) {
    const expected = 0.50 * summary.components.sustained +
      0.35 * summary.components.activity + 0.15 * summary.components.retained;
    assert.equal(summary.overall, expected);
    displayedTotal += summary.display.overall;
  }
  assert.equal(displayedTotal, 100);

  const result = spawnSync(process.execPath, [script, '--code', '--json'], {
    cwd: fixture.cwd,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'Pacific/Auckland' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('scorable with warnings'));
  assert.ok(result.stdout.includes('1 of 3 eligible activity units (33.33%)'));
  assert.ok(result.stdout.replace(/\s+/g, ' ').includes('Sustained scores are partly estimated'));
  const exported = JSON.parse(readFileSync(join(fixture.cwd, 'contribution-evidence.json'), 'utf8'));
  assert.deepEqual(exported, report);
  const csv = readFileSync(join(fixture.cwd, 'contribution-summary.csv'), 'utf8');
  const records = csv.trimEnd().split('\r\n').map(parseCsvRecord);
  const headings = records[0];
  for (const record of records.slice(1)) {
    assert.equal(record.length, headings.length);
    assert.equal(record[headings.indexOf('Eligible activity total')], '3');
    assert.equal(record[headings.indexOf('Original-timed activity')], '2');
    assert.equal(record[headings.indexOf('Integration-date fallback activity')], '1');
    assert.equal(Number(record[headings.indexOf('Integration-date fallback %')]), 100 / 3);
    const expectedFallback = record[0] === 'Unattributed' ? '1' : '0';
    assert.equal(record[headings.indexOf('Identity fallback activity')], expectedFallback);
  }
});

test('fallback respects commit baselines and date cutoffs without moving known dates', function testFallbackScope() {
  const { fixture, baseline, integration } = createMergeTimingFixture();
  const beforeMerge = fixture.read({ enddate: '2026-01-14' });
  assert.equal(beforeMerge.timing.integrationFallbackActivity, 0);
  assert.equal(beforeMerge.timing.fallbackPercentage, 0);
  const bounded = fixture.read({ start: baseline, end: integration, startdate: '2026-01-10', enddate: '2026-01-15' });
  assert.equal(bounded.status, 'scorable');
  assert.equal(bounded.timing.totalActivity, 1);
  assert.equal(bounded.timing.originalActivity, 0);
  assert.equal(bounded.timing.fallbackPercentage, 100);
  assert.equal(bounded.identities.find(findUnattributed).overall, 100);
  assert.equal(row(bounded, 'Bob'), undefined);
  fixture.put('later.txt', lines(10));
  fixture.commit('Carol', date(28));
  const frozen = fixture.read({ start: baseline, end: integration, startdate: '2026-01-10', enddate: '2026-01-15' });
  // The branch tip advances, but the selected snapshot and its evidence stay frozen.
  assert.equal(frozen.scope.end, bounded.scope.end);
  assert.equal(frozen.status, bounded.status);
  assert.deepEqual(frozen.timing, bounded.timing);
  assert.deepEqual(frozen.identities, bounded.identities);
  assert.deepEqual(frozen.evidence, bounded.evidence);
});

test('restoring merge-only work does not inflate fallback coverage or transfer retained ownership', function testFallbackRepeats() {
  const { fixture } = createMergeTimingFixture();
  fixture.remove('resolution.txt');
  fixture.commit('Carol', date(21));
  fixture.git(['checkout', '-b', 'second-feature']);
  fixture.put('second.txt', 'second\n');
  fixture.commit('Dave', date(22));
  fixture.git(['checkout', 'main']);
  fixture.git(['merge', '--no-ff', '--no-commit', 'second-feature']);
  fixture.put('resolution.txt', 'new at merge\n');
  fixture.commit('Another Merger', date(28));
  const report = fixture.read();
  const unattributed = report.identities.find(findUnattributed);
  assert.equal(report.status, 'scorable');
  assert.equal(report.timing.totalActivity, 5);
  assert.equal(report.timing.integrationFallbackActivity, 1);
  assert.equal(report.timing.fallbackPercentage, 20);
  assert.equal(unattributed.repeated, 1);
  assert.equal(unattributed.retained, 1);
  assert.deepEqual(unattributed.weekly, [0, 0, 1, 0, 0]);
  const restoration = report.evidence.accepted.filter(findResolutionEvidence).at(-1);
  assert.equal(restoration.repeated, 1);
  assert.equal(restoration.week, null);
  assert.equal(restoration.timingSource, null);
});

test('unknown original dates retain known authorship and use first mainline integration', function testKnownAuthorFallback() {
  const fixture = repo();
  fixture.put('base.txt', 'base\n');
  fixture.commit('Alice', date(0));
  fixture.git(['checkout', '-b', 'feature']);
  fixture.put('authored.txt', 'authored\n');
  const originCommit = writeCommitWithUnknownAuthorDate(fixture, 'Bob', date(1));
  fixture.git(['checkout', 'main']);
  fixture.merge('feature', date(14));
  const report = fixture.read();
  const contributor = row(report, 'Bob');
  assert.equal(report.status, 'scorable');
  assert.equal(contributor.activity, 1);
  assert.equal(contributor.retained, 1);
  assert.equal(contributor.integrationFallbackActivity, 1);
  assert.deepEqual(contributor.weekly, [0, 0, 1]);
  assert.equal(report.identities.find(findUnattributed), undefined);
  const accepted = report.evidence.accepted.at(-1);
  assert.equal(accepted.authorTime, null);
  assert.equal(accepted.originCommit, originCommit);
  assert.equal(accepted.activityTime, date(14));
  assert.equal(accepted.timingSource, 'integration');
  assert.equal(report.timing.fallbackPercentage, 50);
});

test('merge-only deletions use fallback and remain unattributed', function testDeletionFallback() {
  const fixture = repo();
  fixture.put('base.txt', 'remove\nkeep\n');
  fixture.commit('Alice', date(0));
  fixture.git(['checkout', '-b', 'feature']);
  fixture.put('branch.txt', 'branch\n');
  fixture.commit('Bob', date(1));
  fixture.git(['checkout', 'main']);
  fixture.git(['merge', '--no-ff', '--no-commit', 'feature']);
  fixture.put('base.txt', 'keep\n');
  fixture.commit('Merger', date(14));
  const report = fixture.read();
  const unattributed = report.identities.find(findUnattributed);
  assert.equal(report.status, 'scorable');
  assert.equal(unattributed.deleted, 1);
  assert.equal(unattributed.added, 0);
  assert.equal(unattributed.retained, 0);
  assert.deepEqual(unattributed.weekly, [0, 0, 1]);
  assert.equal(unattributed.integrationFallbackActivity, 1);
  assert.equal(row(report, 'Merger').activity, 0);
  assert.equal(report.timing.totalActivity, 4);
  assert.equal(report.timing.originalActivity, 3);
  assert.equal(report.timing.fallbackPercentage, 25);
});

test('unusable integration dates still withhold scores and report unplaced activity', function testUnusableFallback() {
  const { fixture } = createMergeTimingFixture();
  fixture.commit('Merger', date(7));
  const report = fixture.read();
  assert.equal(report.status, 'unscorable');
  assert.equal(report.timing.integrationFallbackActivity, 0);
  assert.equal(report.timing.unplacedActivity, 1);
  assert.equal(report.timing.originalActivity, 2);
  assert.equal(report.timing.totalActivity, 3);
  for (const summary of report.identities) {
    assert.equal(summary.overall, null);
  }
});

test('whitespace, blank lines and pure renames cannot transfer ownership or create activity', () => {
  const r = repo(); r.put('a.txt', 'hello world\nsecond\n'); r.commit();
  r.put('a.txt', 'hello  world  \n second\n\n'); r.commit('Bob'); r.git(['mv', 'a.txt', 'renamed.txt']); r.commit('Carol');
  const report = r.read(); assert.equal(sum(report, 'activity'), 2); assert.equal(row(report, 'Alice').retained, 2);
  assert.equal(row(report, 'Bob').activity, 0); assert.equal(row(report, 'Carol').activity, 0);
});

test('renamed file restoration retains original owner and repeat history', () => {
  const r = repo(); r.put('a.txt', 'one\ntwo\n'); r.commit(); r.git(['mv', 'a.txt', 'b.txt']); r.commit();
  r.remove('b.txt'); r.commit('Bob'); r.put('b.txt', 'one\ntwo\n'); r.commit('Carol');
  const report = r.read(); assert.equal(row(report, 'Carol').repeated, 2); assert.equal(row(report, 'Alice').retained, 2);
});

test('built-in exclusions, explicit precedence and historical generated files', () => {
  const r = repo();
  for (const path of ['node_modules/a.js', 'vendor/a.txt', '.venv/a.py', 'dist/a.js', 'build/scripts/tool.js', 'coverage/a.txt', 'package-lock.json', 'a.min.js', 'a.js.map', 'contribution-summary.csv', 'contribution-evidence.json', 'contribution-scriptv2.2.mjs']) r.put(path, lines(3));
  r.put('generated.txt', '// @generated\n' + lines(3)); r.put('binary.dat', Buffer.from([0, 1, 2])); r.put('image.png', 'text\n');
  r.put('source.js', 'code\n'); r.put('README.md', 'docs\n'); r.put('config.json', '{}\n'); r.put('test.js', 'test\n');
  r.commit(); const initial = r.read(); assert.equal(sum(initial, 'activity'), 4);
  assert.equal(sum(r.read({ include: ['build/scripts/**'] }), 'activity'), 7);
  assert.equal(sum(r.read({ include: ['build/**'], exclude: ['**/tool.js'] }), 'activity'), 4);
  assert.equal(sum(r.read({ include: ['binary.dat', 'image.png', 'contribution-summary.csv'] }), 'activity'), 4);
  r.remove('generated.txt'); r.commit(); assert.equal(sum(r.read(), 'activity'), 4);
  assert.ok(initial.evidence.files.some(f => f.reason.includes('generation marker')));
});

test('large authored text remains eligible and unusual filenames are parsed safely', () => {
  const r = repo(); r.put('- odd\nname\t".txt', lines(3000)); r.commit();
  assert.equal(sum(r.read(), 'activity'), 3000);
});

test('date cutoffs freeze final snapshot using committer dates and intersect hash boundaries', () => {
  const r = repo(); r.put('a.txt', 'first\n'); const first = r.commit('Alice', '2026-05-01T00:00:00Z');
  r.put('a.txt', 'first\nmay\n'); const may = r.commit('Bob', '2026-05-31T23:59:59Z');
  const report = r.read({ enddate: '2026-05-31' });
  r.put('a.txt', 'june\n'); r.commit('Carol', '2026-05-10T12:00:00Z', '2026-06-01T00:00:00Z');
  const after = r.read({ enddate: '2026-05-31' });
  // The selected reference tip is diagnostic metadata; the snapshot evidence stays frozen.
  assert.deepEqual(after.identities, report.identities); assert.deepEqual(after.evidence, report.evidence); assert.equal(after.scope.end, may);
  assert.equal(r.read({ end: first, enddate: '2026-05-31' }).scope.end, first);
  assert.equal(sum(r.read({ start: first, startdate: '2026-05-31', enddate: '2026-05-31' }), 'activity'), 1);
  assert.throws(() => r.read({ start: may, enddate: '2026-04-30' }), /No mainline snapshot/);
});

test('main/master priority, custom recorded default, ambiguous branch errors and cached fallback', () => {
  const r = repo(); r.put('a.txt', 'one\n'); const sha = r.commit(); r.git(['branch', 'develop']);
  r.git(['update-ref', 'refs/remotes/origin/develop', sha]); r.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop']);
  assert.equal(r.read().scope.branch.name, 'main'); r.git(['branch', 'master']);
  assert.equal(r.read().scope.branch.name, 'develop');
  r.git(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']); assert.throws(() => r.read(), /ambiguous/);
  r.git(['branch', '-D', 'master']); r.git(['update-ref', 'refs/remotes/origin/main', sha]);
  r.put('b.txt', 'two\n'); r.commit(); assert.ok(r.read().warnings.some(w => w.includes('differs from cached')));
  r.git(['checkout', 'develop']); r.git(['branch', '-D', 'main']); assert.equal(r.read().scope.branch.ref, 'refs/remotes/origin/main');
});

test('no conventional branch or recorded default means stop, even on a feature checkout', () => {
  const r = repo('feature'); r.put('a.txt', 'one\n'); r.commit(); assert.throws(() => r.read(), /ambiguous or unavailable/);
  r.git(['update-ref', 'refs/remotes/origin/feature', r.git(['rev-parse', 'HEAD'])]);
  r.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature']); assert.equal(r.read().scope.branch.name, 'feature');
});

test('shallow and missing-object histories stop without a complete score', () => {
  const r = repo(); r.put('a.txt', 'one\n'); r.commit(); r.put('a.txt', 'two\n'); r.commit();
  const target = mkdtempSync(join(tmpdir(), 'contribution-shallow-')); temporary.push(target);
  execFileSync('git', ['clone', '--depth=1', `file://${r.cwd}`, target], { stdio: 'pipe' });
  assert.throws(() => analyse(target), /Shallow history/);
  const sha = r.git(['rev-parse', 'HEAD:a.txt']); rmSync(join(r.cwd, '.git', 'objects', sha.slice(0, 2), sha.slice(2)));
  assert.throws(() => r.read(), /Cannot read Git evidence/);
});

test('raw identities group only exact email aliases and remain available for reconciliation', () => {
  const r = repo(); r.put('a.txt', 'one\n'); r.commit();
  r.put('b.txt', 'two\n'); r.git(['add', '-A']);
  r.git(['commit', '-m', 'alias'], { env: { ...r.env('Alice Alias', date(1)), GIT_AUTHOR_EMAIL: 'alice@example.test' } });
  const report = r.read(); assert.equal(report.identities.length, 1); assert.equal(report.identities[0].rawIdentities.length, 2);
});

test('formula regression includes inactive weeks, and Unattributed stays in denominators', () => {
  const rows = [
    { weekly: [...Array(9).fill(0), 1000], activity: 1000, retained: 500 },
    { weekly: Array(10).fill(100), activity: 1000, retained: 500 },
  ];
  const score = calculate(rows, 10); assert.equal(score.lambda, 400);
  assert.ok(Math.abs(rows[0].overall - 38.1578947368) < 1e-9); assert.ok(Math.abs(rows[1].overall - 61.8421052632) < 1e-9);
  assert.deepEqual(rows.map(r => r.display.overall), [38.16, 61.84]);
  const unknown = [45, 45, 10].map(n => ({ weekly: [n], activity: n, retained: n }));
  calculate(unknown, 1); assert.deepEqual(unknown.map(r => r.display.overall), [45, 45, 10]);
  const incomplete = [{ weekly: [1], activity: 1, retained: 0 }]; assert.equal(calculate(incomplete, 1).status, 'unscorable'); assert.equal(incomplete[0].overall, null);
  assert.deepEqual(roundShares([100 / 3, 100 / 3, 100 / 3]), [33.34, 33.33, 33.33]);
});

test('synthetic ten-week history reproduces the agreed scoring regression', () => {
  const r = repo();
  for (let week = 0; week < 10; week++) {
    r.put('b.txt', lines((week + 1) * 100, 'B')); r.commit('Bob', date(week * 7));
  }
  r.put('a.txt', lines(1000, 'A')); r.commit('Alice', date(63));
  const report = r.read(); assert.equal(report.weekCount, 10); assert.equal(report.lambda, 400);
  assert.equal(row(report, 'Alice').display.overall, 38.16); assert.equal(row(report, 'Bob').display.overall, 61.84);
});

test('inactive and partial weeks, direct warning, empty evidence and timestamp anomalies', () => {
  const r = repo(); r.put('a.txt', 'one\n'); r.commit('Alice', date(0)); r.put('b.txt', 'two\n'); r.commit('Bob', date(15));
  const report = r.read(); assert.equal(report.weekCount, 3); assert.equal(report.teamWeekly[1], 0); assert.ok(report.warnings.some(w => w.includes('Direct mainline')));
  r.put('c.txt', 'three\n'); r.commit('Carol', date(30), date(16));
  const anomalous = r.read(); assert.equal(anomalous.status, 'unscorable'); assert.ok(anomalous.warnings.some(w => w.includes('Author time follows')));
  assert.equal(anomalous.timing.integrationFallbackActivity, 0);
  assert.equal(anomalous.timing.unplacedActivity, 1);
  const empty = repo(); empty.commit(); const noEvidence = empty.read(); assert.equal(noEvidence.status, 'unscorable'); assert.equal(sum(noEvidence, 'activity'), 0);
  const unborn = repo(); assert.throws(() => unborn.read(), /ambiguous or unavailable/);
});

test('argument validation and documented glob semantics', () => {
  assert.throws(() => parseOptions(['--startdate', '2026-02-30']), /real date/);
  assert.throws(() => parseOptions(['--end']), /needs a value/); assert.throws(() => parseOptions(['--oops']), /Unknown/);
  assert.throws(() => parseOptions(['--startdate=2026-02-01', '--enddate=2026-01-01']), /follow/);
  assert.deepEqual(parseOptions(['--include=a/**', '--include', 'b/**']).include, ['a/**', 'b/**']);
  assert.ok(glob('**/*.js').test('a.js')); assert.ok(glob('**/*.js').test('src/a.js')); assert.ok(!glob('*.js').test('src/a.js'));
  assert.throws(() => glob('../a'), /repository-relative/);
});

test('standalone trusted copy, npm shortcut and output combinations require no install', () => {
  const r = repo(); r.put('a.txt', 'one\n'); r.commit();
  const trustedDir = mkdtempSync(join(tmpdir(), 'contribution-trusted-')); temporary.push(trustedDir);
  const trusted = join(trustedDir, 'trusted-calculator.mjs'); cpSync(script, trusted); cpSync(script, join(r.cwd, 'contribution.mjs'));
  r.put('package.json', JSON.stringify({ scripts: { contribution: 'node contribution.mjs' } }));
  const run = (file, args = [], timezone = 'UTC') => execFileSync(process.execPath, [file, ...args], { cwd: r.cwd, env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
  run(script, ['--json']); const standard = readFileSync(join(r.cwd, 'contribution-evidence.json'), 'utf8'); const csv = readFileSync(join(r.cwd, 'contribution-summary.csv'), 'utf8');
  run(trusted, ['--code', '--json'], 'Pacific/Auckland'); assert.equal(readFileSync(join(r.cwd, 'contribution-evidence.json'), 'utf8'), standard); assert.equal(readFileSync(join(r.cwd, 'contribution-summary.csv'), 'utf8'), csv);
  r.remove('contribution-summary.csv'); run(script, ['--json', '--no-csv'], 'America/Los_Angeles'); assert.ok(!existsSync(join(r.cwd, 'contribution-summary.csv')));
  execFileSync('npm', ['run', 'contribution', '--', '--no-csv'], { cwd: r.cwd, stdio: 'pipe' }); assert.ok(!existsSync(join(r.cwd, 'node_modules')));
  assert.equal(JSON.parse(standard).identities[0].overall, 100);
});

test('CSV and terminal neutralise hostile identity fields while JSON preserves raw evidence', () => {
  const r = repo(); r.put('a.txt', 'one\n'); r.git(['add', '-A']);
  r.git(['commit', '-m', 'untrusted metadata'], { env: { ...r.env('Alice', date(0)), GIT_AUTHOR_NAME: '=1+1, "name"\x1b[31m' } });
  const report = r.read(), csv = toCSV(report), output = terminal(report, true);
  assert.ok(csv.includes('"\'=1+1, ""name""')); assert.ok(!output.includes('\x1b')); assert.ok(output.includes('\\u001b'));
  assert.ok(report.identities[0].names[0].includes('\x1b'));
});

test('discarded deletion/restoration churn on a branch credits the final deleting author', () => {
  const r = repo(); r.put('a.txt', lines(3)); r.put('keep.txt', 'keep\n'); r.commit('Alice', date(0));
  r.git(['checkout', '-b', 'feature']); r.remove('a.txt'); r.commit('Bob', date(1));
  r.put('a.txt', lines(3)); r.commit('Carol', date(2)); r.remove('a.txt'); r.commit('Dave', date(3));
  r.git(['checkout', 'main']); r.merge('feature', date(4)); const report = r.read();
  assert.equal(row(report, 'Dave').deleted, 3); assert.equal(row(report, 'Bob').deleted, 0); assert.equal(row(report, 'Carol').activity, 0);
});

test('within-file movement preserves the original author before and after integration', () => {
  const r = repo(); r.put('starter.txt', 'starter\n'); r.commit('Starter'); r.git(['checkout', '-b', 'feature']);
  r.put('a.txt', 'A\nB\nC\nD\nE\n'); r.commit('Alice'); r.put('a.txt', 'A\nC\nD\nE\nB\n'); r.commit('Bob');
  r.git(['checkout', 'main']); r.merge('feature');
  const report = r.read(); assert.equal(row(report, 'Alice').added, 5); assert.equal(row(report, 'Bob').added, 0);
  r.put('a.txt', 'B\nA\nC\nD\nE\n'); r.commit('Carol');
  const moved = r.read(); assert.equal(row(moved, 'Alice').retained, 5); assert.equal(row(moved, 'Carol').activity, 0);
});

test('reusing an old pathname after a rename does not share repeat identity', () => {
  const r = repo(); r.put('a.txt', 'one\ntwo\n'); r.commit(); r.git(['mv', 'a.txt', 'b.txt']); r.commit();
  r.remove('b.txt'); r.commit('Bob'); r.put('a.txt', 'one\ntwo\n'); r.commit('Carol');
  const report = r.read(); assert.equal(row(report, 'Carol').added, 2); assert.equal(row(report, 'Carol').repeated, 0);
});

test('same removed text in changed context is flagged without automatic exclusion', () => {
  const r = repo(); r.put('a.txt', 'top\nblock\nbottom\n'); r.commit();
  r.put('a.txt', 'top\nbottom\n'); r.commit('Bob');
  r.put('a.txt', 'top\nbottom\nblock\n'); r.commit('Carol');
  const report = r.read(); assert.equal(row(report, 'Carol').added, 1);
  assert.ok(report.warnings.some(w => w.includes('different surrounding lines')));
});

test('known timing with missing identity keeps a genuine Unattributed share', () => {
  const r = repo(); r.put('a.txt', lines(45)); r.commit('Alice', date(0)); r.put('b.txt', lines(45)); r.commit('Bob', date(1));
  r.put('unknown.txt', lines(10)); r.git(['add', '-A']);
  const tree = r.git(['write-tree']), parent = r.git(['rev-parse', 'HEAD']), time = Date.parse(date(2)) / 1000;
  const object = `tree ${tree}\nparent ${parent}\nauthor  <> ${time} +0000\ncommitter Recorder <recorder@example.test> ${time} +0000\n\nMissing recorded author\n`;
  const sha = execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], { cwd: r.cwd, input: object, encoding: 'utf8' }).trim();
  r.git(['update-ref', 'refs/heads/main', sha]);
  const report = r.read(); assert.equal(report.status, 'scorable');
  assert.equal(row(report, 'Alice').display.overall, 45); assert.equal(row(report, 'Bob').display.overall, 45);
  assert.equal(report.identities.find(r => r.bucket).display.overall, 10); assert.ok(report.evidence.unresolved.length);
  assert.equal(report.timing.integrationFallbackActivity, 0);
  assert.equal(report.timing.originalActivity, report.timing.totalActivity);
});

test('untrusted diff drivers and attributes cannot execute or alter the line calculation', () => {
  const r = repo(); r.put('a.txt', 'first\n'); r.commit(); r.put('a.txt', 'second\n'); r.commit('Bob');
  const before = r.read();
  r.put('driver.sh', '#!/bin/sh\ntouch "' + join(r.cwd, 'executed') + '"\n');
  r.git(['config', 'diff.external', `sh ${join(r.cwd, 'driver.sh')}`]); r.git(['config', 'diff.hostile.textconv', `sh ${join(r.cwd, 'driver.sh')}`]);
  r.put('.gitattributes', '* diff=hostile\n'); assert.deepEqual(r.read().identities, before.identities); assert.ok(!existsSync(join(r.cwd, 'executed')));
  r.put('.gitattributes', '* -diff\n'); assert.deepEqual(r.read().identities, before.identities);
});

test('exports replace symlinks safely and unavailable reports use exit code 2', () => {
  const r = repo(); r.commit(); const outside = join(mkdtempSync(join(tmpdir(), 'contribution-target-')), 'keep.txt'); temporary.push(dirname(outside));
  writeFileSync(outside, 'preserve'); symlinkSync(outside, join(r.cwd, 'contribution-summary.csv'));
  const result = spawnSync(process.execPath, [script, '--json'], { cwd: r.cwd, encoding: 'utf8' });
  assert.equal(result.status, 2); assert.equal(readFileSync(outside, 'utf8'), 'preserve');
  const report = JSON.parse(readFileSync(join(r.cwd, 'contribution-evidence.json'), 'utf8')); assert.equal(report.status, 'unscorable');
  assert.ok(readFileSync(join(r.cwd, 'contribution-summary.csv'), 'utf8').includes('unscorable'));
});

test('committed reports and identical calculator copies do not inflate evidence', () => {
  const r = repo(); r.put('a.txt', 'first\n'); r.commit(); const before = r.read();
  cpSync(script, join(r.cwd, 'renamed-tool.mjs')); r.put('contribution-summary.csv', lines(100)); r.put('contribution-evidence.json', lines(100)); r.commit('Bob');
  const after = r.read(); assert.equal(sum(after, 'activity'), sum(before, 'activity')); assert.equal(row(after, 'Bob').retained, 0);
});

test('blank lines do not conflate unrelated locations containing the same text', () => {
  const r = repo(); r.put('a.txt', 'heading A\n\nblock\n\nend A\nheading B\n\n\nend B\n'); r.commit();
  r.put('a.txt', 'heading A\n\n\nend A\nheading B\n\n\nend B\n'); r.commit('Bob');
  r.put('a.txt', 'heading A\n\n\nend A\nheading B\n\nblock\n\nend B\n'); r.commit('Carol');
  const report = r.read(); assert.equal(row(report, 'Carol').added, 1); assert.equal(row(report, 'Carol').repeated, 0);
});

test('a backdated endpoint with a future ancestor cannot certify a date-limited score', () => {
  const r = repo(); r.put('a.txt', 'one\n'); r.commit('Alice', '2026-05-01T00:00:00Z');
  r.put('b.txt', 'two\n'); r.commit('Bob', '2026-06-01T00:00:00Z');
  r.put('c.txt', 'three\n'); r.commit('Carol', '2026-05-31T00:00:00Z');
  const report = r.read({ enddate: '2026-05-31' }); assert.equal(report.status, 'unscorable');
  assert.ok(report.reasons.some(r => r.includes('ancestor dated after')));
});

test('recognised history exports are excluded with a text inclusion override', () => {
  const r = repo(); r.put('a.txt', 'one\n'); r.put('commit-history.txt', lines(100)); r.commit();
  assert.equal(sum(r.read(), 'activity'), 1); assert.equal(sum(r.read({ include: ['commit-history.txt'] }), 'activity'), 101);
});
