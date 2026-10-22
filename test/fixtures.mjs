import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { validateConfig } from '../src/config.mjs';

export const A = { name: 'Student A', email: 'a@example.test' };
export const B = { name: 'Student B', email: '123+student-b@users.noreply.github.com' };
export const LEADER = { name: 'Merger', email: 'merger@example.test' };
export const START = Date.parse('2026-01-01T00:00:00Z');
export const at = days => new Date(START + days * 86400000).toISOString();
export const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `const ${prefix}_${i} = "meaningful unique content for ${prefix} line ${i}";`).join('\n') + (n ? '\n' : '');
export const configuration = (extra = {}) => validateConfig({ start: at(0), end: at(70), timezone: 'UTC', ...extra });
export class Fixture {
  constructor(seed = { 'starter.txt': 'starter code from teacher\n' }, path = null) {
    this.path = path ?? mkdtempSync(join(tmpdir(), 'ccc-fixture-'));
    mkdirSync(this.path, { recursive: true });
    this.git(['init', '-b', 'main']);
    this.git(['config', 'user.name', LEADER.name]);
    this.git(['config', 'user.email', LEADER.email]);
    this.git(['config', 'commit.gpgsign', 'false']);
    this.git(['config', 'core.autocrlf', 'false']);
    this.baseline = this.commit(LEADER, -2, seed, 'Starter');
  }
  git(args, { person = LEADER, day = 1, input, allowed = false } = {}) {
    const r = spawnSync('git', ['-C', this.path, ...args], { input, encoding: 'utf8',
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_AUTHOR_NAME: person.name, GIT_AUTHOR_EMAIL: person.email, GIT_COMMITTER_NAME: person.name,
        GIT_COMMITTER_EMAIL: person.email, GIT_AUTHOR_DATE: at(day), GIT_COMMITTER_DATE: at(day), LC_ALL: 'C' } });
    if (r.error || (r.status !== 0 && !allowed)) throw new Error(r.error?.message ?? r.stderr);
    return r.stdout.trim();
  }
  branch(name) { this.git(['checkout', '-b', name, 'main']); }
  commit(person, day, files = {}, message = 'Development') {
    for (const [path, content] of Object.entries(files)) {
      const target = join(this.path, path);
      if (content === null) rmSync(target, { force: true });
      else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); }
    }
    this.git(['add', '--all']);
    this.git(['commit', '--allow-empty', '-m', message], { person, day });
    return this.git(['rev-parse', 'HEAD']);
  }
  merge(branch, day = 2) {
    this.git(['checkout', 'main']);
    this.git(['merge', '--no-ff', '-m', `Merge ${branch}`, branch], { day });
    return this.git(['rev-parse', 'HEAD']);
  }
  close() { rmSync(this.path, { recursive: true, force: true }); }
}
export function fixture(t, seed) { const f = new Fixture(seed); t.after(() => f.close()); return f; }
