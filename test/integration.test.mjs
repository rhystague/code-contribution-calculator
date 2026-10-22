import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assess } from '../src/assess.mjs';
import { serialise } from '../src/util.mjs';
import { fixture, A, B, LEADER, lines, configuration, at } from './fixtures.mjs';
const run = (f, config = configuration()) => assess(f.path, 'group', config).canonical;
const byEmail = (c, email) => c.scores.rows.find(r => r.email === email);
const activity = c => c.scores.rows.reduce((n, r) => n + r.activity, 0);
const check = c => { assert.notEqual(c.status, 'unscorable', JSON.stringify(c.scores.reasons)); return c; };

test('equal work, two branch authors, documentation/source parity, no automatic merger or starter credit', t => {
  const f = fixture(t); f.branch('feature');
  f.commit(A, 1, { 'code.js': lines('a', 10) }); f.commit(B, 1, { 'README.md': lines('b', 10) }); f.merge('feature');
  const c = check(run(f));
  assert.deepEqual(c.scores.rows.map(r => r.displayedPercentage), [50, 50]);
  assert.equal(byEmail(c, LEADER.email), undefined);
  assert.equal(c.scores.totals.retained, 20);
  assert.equal(c.integrations[0].accepted, 20);
  assert.equal(c.integrations[0].unattributed, 0);
});
test('ten-week reference through real merges and recorded development timestamps', t => {
  const f = fixture(t);
  f.branch('b');
  for (let w = 0; w < 10; w++) f.commit(B, w * 7 + 1, { [`b${w}.txt`]: lines(`b${w}`, 100) });
  f.git(['checkout', 'main']); f.branch('a'); f.commit(A, 64, { 'a.txt': lines('a', 1000) });
  f.merge('b', 69); f.merge('a', 69);
  const c = check(run(f));
  assert.equal(byEmail(c, A.email).displayedPercentage, 38.16);
  assert.equal(byEmail(c, B.email).displayedPercentage, 61.84);
  assert.equal(c.scores.lambda, 400);
});
test('deleting starter content receives positive activity while starter lines remain excluded', t => {
  const f = fixture(t, { 'old.txt': lines('starter', 50) }); f.branch('delete');
  f.commit(A, 1, { 'old.txt': null, 'new.txt': lines('new', 10) }); f.merge('delete');
  const c = check(run(f));
  assert.equal(byEmail(c, A.email).activity, 60); assert.equal(byEmail(c, A.email).retained, 10);
  assert.equal(c.integrations[0].deleted, 50);
});
test('trivial commits, intermediate additions/reverts and whitespace earn no independent credit', t => {
  const f = fixture(t); f.branch('feature');
  f.commit(A, 1, { 'temp.txt': lines('throwaway', 40) }); f.commit(A, 1, { 'temp.txt': null });
  for (let n = 0; n < 5; n++) f.commit(A, 1);
  f.commit(A, 1, { 'starter.txt': '   starter    code from teacher   \n\n', 'a.txt': lines('a', 1) });
  f.commit(B, 1, { 'b.txt': lines('b', 1) }); f.merge('feature');
  const c = check(run(f));
  assert.equal(activity(c), 2); assert.equal(byEmail(c, A.email).displayedPercentage, 50);
  assert.ok(c.warnings.some(w => w.code === 'INTERMEDIATE_CHURN'));
});
test('whitespace-only and empty merges produce unscorable zero evidence', t => {
  const f = fixture(t); f.branch('space'); f.commit(A, 1, { 'starter.txt': ' starter code  from teacher \n\n' }); f.merge('space');
  const c = run(f); assert.equal(c.status, 'unscorable'); assert.equal(activity(c), 0);
});
test('unmerged feature work excluded; current refs do not change canonical replay', t => {
  const f = fixture(t); f.branch('a'); f.commit(A, 1, { 'a.txt': lines('a', 3) }); const submitted = f.merge('a');
  const config = configuration({ repositories: { group: { submitted } } });
  const before = assess(f.path, 'group', config);
  f.branch('unmerged'); f.commit(B, 3, { 'b.txt': lines('b', 100) });
  const after = assess(f.path, 'group', config);
  assert.equal(serialise(before.canonical), serialise(after.canonical));
  assert.equal(before.evidenceHash, after.evidenceHash);
  assert.ok(after.observations.outsideSnapshot.length);
});
test('pure rename gives no activity, retains original authorship, and avoids duplicate traversal', t => {
  const f = fixture(t); f.branch('a'); f.commit(A, 1, { 'old.txt': lines('a', 10) }); f.merge('a');
  f.branch('rename'); f.git(['mv', 'old.txt', 'new.txt']); f.commit(B, 3); f.merge('rename', 4);
  const c = check(run(f)); assert.equal(activity(c), 10); assert.equal(byEmail(c, B.email).activity, 0);
  assert.equal(byEmail(c, A.email).retained, 10);
  assert.equal(new Set(c.commits.map(x => x.sha)).size, c.commits.length);
});
test('identity variants remain separate, raw names ignore .mailmap, bots are opt-in exclusions', t => {
  const f = fixture(t); f.branch('a');
  f.commit(A, 1, { 'a.txt': lines('a', 1) });
  f.commit({ ...A, name: 'Alias' }, 1, { 'alias.txt': lines('alias', 1) });
  f.commit({ name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' }, 1, { 'bot.txt': lines('bot', 1), '.mailmap': 'Someone Else <else@example.test> Student A <a@example.test>\n' });
  f.merge('a');
  const c = check(run(f, configuration({ excludeKnownBots: true })));
  assert.equal(c.scores.rows.length, 3);
  assert.deepEqual(c.scores.rows.filter(r => !r.excluded).map(r => r.percentage), [50, 50]);
  assert.ok(c.scores.rows.some(r => r.name === 'Student A'));
});
test('default exclusions, binaries, non-UTF8, symlinks and configuration overrides', t => {
  const f = fixture(t); f.branch('files');
  f.commit(A, 1, { 'app.js': lines('a', 3), 'node_modules/lib.js': lines('lib', 10),
    'package-lock.json': lines('lock', 10), 'dist/app.js': lines('build', 10), 'photo.bin': Buffer.from([0, 1, 2]), 'latin.txt': Buffer.from([255, 254, 1]) });
  f.merge('files'); const c = check(run(f)); assert.equal(activity(c), 3);
  assert.ok(c.excludedFiles.some(x => x.reason === 'binary_nul'));
  assert.ok(c.excludedFiles.some(x => x.reason === 'non_utf8'));
  const included = check(run(f, configuration({ useDefaultExcludes: false })));
  assert.equal(activity(included), 33);
});
test('timestamps after integration, outside window and stale starter branches do not earn credit', t => {
  const f = fixture(t); f.branch('time');
  f.commit(B, -1, { 'old.txt': lines('old', 5) });
  f.commit(A, 4, { 'late.txt': lines('late', 5) }); f.merge('time', 2);
  const c = run(f); assert.equal(c.status, 'unscorable'); assert.equal(activity(c), 0);
  assert.ok(c.warnings.some(w => w.code === 'COMMIT_AFTER_INTEGRATION'));
  assert.equal(c.scores.totals.retained, 0);
});
test('direct/squash/rebase-shaped main changes are flagged and excluded', t => {
  const f = fixture(t); f.commit(B, 1, { 'direct.txt': lines('direct', 100) });
  f.branch('a'); f.commit(A, 2, { 'a.txt': lines('a', 2) }); f.merge('a', 3);
  const c = check(run(f)); assert.equal(byEmail(c, B.email).activity, 0); assert.equal(byEmail(c, B.email).retained, 0);
  assert.ok(c.warnings.some(w => w.code === 'NON_MERGE_MAIN_COMMIT'));
});
test('ambiguous matching deletions use audited proportional fallback and merge cap', t => {
  const f = fixture(t, { 'code.txt': 'one meaningful starter line\n' }); f.branch('a');
  f.commit(A, 1, { 'code.txt': '' }); f.commit(A, 1, { 'code.txt': 'one meaningful starter line\n' });
  f.commit(B, 2, { 'code.txt': '', 'b.txt': lines('b', 1) }); f.merge('a', 3);
  const c = check(run(f)); assert.equal(activity(c), 2);
  assert.equal(byEmail(c, A.email).activity, 0.5); assert.equal(byEmail(c, B.email).activity, 1.5);
  assert.equal(c.integrations[0].fallback, 1);
});
test('merge-only conflict resolutions are visible and unattributed', t => {
  const f = fixture(t, { 'conflict.txt': 'base meaningful line\n' });
  f.branch('a'); f.commit(A, 1, { 'conflict.txt': 'student A proposal\n' });
  f.git(['checkout', 'main']); f.branch('b'); f.commit(B, 1, { 'conflict.txt': 'student B proposal\n', 'b.txt': lines('b', 1) }); f.merge('b', 2);
  f.git(['merge', '--no-ff', '--no-commit', 'a'], { day: 3, allowed: true });
  f.commit(LEADER, 3, { 'conflict.txt': 'entirely new resolution by merge operator\n' });
  const c = check(run(f));
  const last = c.integrations.at(-1); assert.equal(last.unattributed, 2); assert.equal(last.credited, 0);
  assert.equal(byEmail(c, LEADER.email), undefined);
});
test('file/identity shell metacharacters, newline paths and local diff configuration are inert', t => {
  const f = fixture(t); f.branch('odd');
  f.commit({ name: '$(echo unsafe)', email: 'a;echo@example.test' }, 1, { 'a\tline\n".txt': lines('odd', 2), '-flag.txt': lines('flag', 2) }); f.merge('odd');
  f.git(['config', 'diff.external', 'false']);
  mkdirSync(join(f.path, '.git', 'info'), { recursive: true }); writeFileSync(join(f.path, '.git', 'info', 'attributes'), '* -diff\n');
  const c = check(run(f)); assert.equal(activity(c), 4);
});
test('shallow history and missing reachable objects fail explicitly', t => {
  const f = fixture(t); f.branch('a'); f.commit(A, 1, { 'a.txt': lines('a', 1) }); const sha = f.merge('a');
  writeFileSync(join(f.path, '.git', 'shallow'), sha + '\n');
  const c = run(f); assert.equal(c.status, 'unscorable'); assert.match(c.scores.reasons.join(), /shallow/);
});
test('explicit baseline on main excludes all earlier accepted work; invalid baseline rejected', t => {
  const f = fixture(t); f.branch('a'); const branch = f.commit(A, 1, { 'a.txt': lines('a', 10) }); const baseline = f.merge('a');
  f.branch('b'); f.commit(B, 3, { 'b.txt': lines('b', 1) }); const submitted = f.merge('b', 4);
  const c = check(run(f, configuration({ repositories: { group: { baseline, submitted } } })));
  assert.equal(c.scores.rows.length, 1); assert.equal(byEmail(c, B.email).percentage, 100);
  const bad = run(f, configuration({ repositories: { group: { baseline: branch, submitted } } }));
  assert.equal(bad.status, 'unscorable'); assert.match(bad.scores.reasons.join(), /first-parent/);
});
test('copy detection prevents retained starter-code credit', t => {
  const f = fixture(t, { 'starter.txt': lines('starter', 10) }); f.branch('copy');
  f.commit(A, 1, { 'copy.txt': lines('starter', 10), 'real.txt': lines('real', 1) }); f.merge('copy');
  const c = check(run(f)); assert.equal(byEmail(c, A.email).activity, 11); assert.equal(byEmail(c, A.email).retained, 1);
});
test('late integration is outside assessment even if development was earlier', t => {
  const f = fixture(t); f.branch('late'); f.commit(A, 60, { 'a.txt': lines('a', 3) }); f.merge('late', 71);
  const c = run(f); assert.equal(c.status, 'unscorable'); assert.equal(activity(c), 0);
  assert.equal(c.integrations[0].disposition, 'outside_assessment_window');
});
test('repeated and reversed changes across integrations are flagged without hidden penalties', t => {
  const f = fixture(t); f.branch('a'); f.commit(A, 1, { 'a.txt': lines('a', 2) }); f.merge('a');
  f.branch('undo'); f.commit(B, 3, { 'a.txt': null, 'b.txt': lines('b', 1) }); f.merge('undo', 4);
  f.branch('redo'); f.commit(A, 5, { 'a.txt': lines('a', 2) }); f.merge('redo', 6);
  const c = check(run(f)); assert.equal(activity(c), 7);
  assert.ok(c.warnings.some(w => w.code === 'REPEATED_OR_REVERSED_DELTA'));
});
test('missing blob is unscorable; no partial confident result', async t => {
  const { rmSync } = await import('node:fs');
  const f = fixture(t); f.branch('a'); f.commit(A, 1, { 'a.txt': lines('a', 3) }); f.merge('a');
  const oid = f.git(['rev-parse', 'main:a.txt']);
  rmSync(join(f.path, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  const c = run(f); assert.equal(c.status, 'unscorable'); assert.match(c.scores.reasons.join(), /missing|unable|bad object/i);
});
test('a symlink receives no line credit', async t => {
  const { symlinkSync } = await import('node:fs');
  const f = fixture(t); f.branch('a');
  if (process.platform === 'win32') { t.skip('Symlink creation needs Windows developer mode'); return; }
  symlinkSync('starter.txt', join(f.path, 'link.txt'));
  f.commit(A, 1, { 'a.txt': lines('a', 1) }); f.merge('a');
  const c = check(run(f)); assert.equal(activity(c), 1); assert.ok(c.excludedFiles.some(x => x.reason === 'non_regular_file'));
});
test('ambiguous deletion matching cannot allocate more occurrences than branch evidence supports', t => {
  const f = fixture(t, { 'repeat.txt': 'same starter line\nsame starter line\n' });
  f.branch('a'); f.commit(A, 1, { 'repeat.txt': 'same starter line\n', 'a.txt': lines('a', 1) });
  // Additional deletion exists only in the resulting merge, not the branch.
  f.git(['checkout', 'main']); f.git(['merge', '--no-ff', '--no-commit', 'a'], { day: 2 });
  f.commit(LEADER, 2, { 'repeat.txt': '' });
  const c = check(run(f)); assert.equal(c.integrations[0].accepted, 3);
  assert.equal(c.integrations[0].credited, 2); assert.equal(c.integrations[0].unattributed, 1);
});
test('renaming plus whitespace formatting cannot manufacture development credit', t => {
  const f = fixture(t); f.branch('a'); f.commit(A, 1, { 'old.txt': lines('a', 10) }); f.merge('a');
  f.branch('formatted'); f.commit(B, 3, { 'old.txt': null, 'new.txt': lines('a', 10).replaceAll(' ', '     ') }); f.merge('formatted', 4);
  const c = check(run(f)); assert.equal(activity(c), 10); assert.equal(byEmail(c, B.email).activity, 0);
  assert.equal(byEmail(c, A.email).retained, 10);
});
