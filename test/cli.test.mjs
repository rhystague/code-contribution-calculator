import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Fixture, A, lines, configuration } from './fixtures.mjs';

const cli = resolve('assess.mjs');
function run(args) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' }); }
test('cohort continues after invalid repositories and writes auditable frozen outputs', t => {
  const temp = mkdtempSync(join(tmpdir(), 'ccc-cli-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const submissions = join(temp, 'submissions'); mkdirSync(submissions);
  mkdirSync(join(submissions, 'bad-repository'));
  const f = new Fixture(undefined, join(submissions, 'valid-group'));
  f.branch('a'); f.commit(A, 1, { 'a.txt': lines('a', 2) }); const submitted = f.merge('a');
  const config = join(temp, 'config.json'), output = join(temp, 'results');
  writeFileSync(config, JSON.stringify(configuration()));
  const result = run(['--repos', submissions, '--config', config, '--output', output]);
  assert.equal(result.status, 1, result.stderr); assert.match(result.stdout, /2 repositories/);
  const csv = readFileSync(join(output, 'contributions.csv'), 'utf8'); assert.match(csv, /Student A/); assert.match(csv, /unscorable/);
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json')));
  assert.equal(manifest.repositories.length, 2);
  const freeze = join(output, 'frozen.config.json');
  assert.equal(JSON.parse(readFileSync(freeze)).repositories['valid-group'].submitted, submitted);
  f.commit(A, 3, { 'later.txt': lines('later', 100) });
  const replay = run(['--repo', f.path, '--config', freeze, '--output', join(temp, 'replay')]);
  assert.equal(replay.status, 0, replay.stderr);
  const audit = JSON.parse(readFileSync(join(temp, 'replay', 'audit', readdirSync(join(temp, 'replay', 'audit'))[0])));
  assert.equal(audit.canonical.scores.rows[0].activity, 2);
  assert.equal(audit.canonical.submitted, submitted);
});
test('CLI rejects invalid usage/config before assessment', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['--repo', '.', '--repos', '.', '--config', 'missing']).status, 2);
  assert.equal(run(['--help']).status, 0);
  assert.equal(run(['--version']).stdout.trim(), '3.0.0');
});
test('output is rejected inside an assessed repository', t => {
  const temp = mkdtempSync(join(tmpdir(), 'ccc-output-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const config = join(temp, 'config.json'); writeFileSync(config, JSON.stringify(configuration()));
  const result = run(['--repo', temp, '--config', config, '--output', join(temp, 'reports')]);
  assert.equal(result.status, 2); assert.match(result.stderr, /outside/);
});
