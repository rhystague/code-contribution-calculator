import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compare, textLines, nonblank, cleanLine } from './util.mjs';

const MAX_BUFFER = 256 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C', TZ: 'UTC' });
function execute(args, input, allowFailure = false) {
  const r = spawnSync('git', args, { input, env: environment(), maxBuffer: MAX_BUFFER, timeout: 120000, windowsHide: true });
  if (r.error) throw new Error(`Git process failed: ${r.error.message}`);
  if (r.status !== 0 && !allowFailure) throw new Error(`git ${args.find(a => !a.startsWith('-'))}: ${r.stderr.toString('utf8').trim()}`);
  return r;
}
const asText = buffer => decoder.decode(buffer);
export class Git {
  constructor(path) {
    this.path = resolve(path);
    this.temp = null;
    this.calls = 0;
    this.blobs = new Map();
    this.blames = new Map();
  }
  source(args, allowFailure = false) { return execute(['-C', this.path, ...args], undefined, allowFailure); }
  open() {
    if (asText(this.source(['rev-parse', '--is-shallow-repository']).stdout).trim() === 'true') throw new Error('Incomplete history: shallow repository; obtain a full clone before assessment');
    if (this.source(['config', '--get', 'extensions.partialClone'], true).status === 0 ||
        this.source(['config', '--get-regexp', '^remote\..*\.promisor$'], true).status === 0) throw new Error('Partial/promisor repositories are unsupported; obtain a complete offline clone');
    const gitDir = asText(this.source(['rev-parse', '--absolute-git-dir']).stdout).trim();
    if (existsSync(join(gitDir, 'info', 'grafts')) && readFileSync(join(gitDir, 'info', 'grafts'), 'utf8').trim()) throw new Error('History grafts are unsupported');
    const objects = asText(this.source(['rev-parse', '--path-format=absolute', '--git-path', 'objects']).stdout).trim();
    if (/[\r\n]/.test(objects)) throw new Error('Object directory contains an unsupported newline');
    const format = asText(this.source(['rev-parse', '--show-object-format']).stdout).trim();
    this.temp = mkdtempSync(join(tmpdir(), 'contribution-git-'));
    execute(['init', '--bare', `--object-format=${format}`, this.temp]);
    mkdirSync(join(this.temp, 'objects', 'info'), { recursive: true });
    writeFileSync(join(this.temp, 'objects', 'info', 'alternates'), objects + '\n');
    // This isolated bare view reads the original object database, never its hooks,
    // worktree, mailmap, diff drivers, local config, replacement refs or attributes.
    this.emptyTree = this.run(['hash-object', '-w', '-t', 'tree', '--stdin'], '').trim();
    return this;
  }
  close() { if (this.temp) rmSync(this.temp, { recursive: true, force: true }); }
  raw(args, input) { this.calls++; return execute(['--git-dir', this.temp,
    '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=false', '-c', 'diff.renameLimit=0',
    '-c', 'core.quotePath=true', ...args], input).stdout; }
  run(args, input) { return asText(this.raw(args, input)); }
  resolve(ref) {
    if (typeof ref !== 'string' || ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw new Error('Invalid Git reference');
    return asText(this.source(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).stdout).trim();
  }
  verify(sha) {
    const objects = this.run(['rev-list', '--objects', '--no-object-names', sha]).trim();
    const checked = this.run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], objects + '\n');
    if (checked.includes(' missing')) throw new Error('Incomplete history: a reachable Git object is missing');
  }
  commits(sha) {
    const fields = this.run(['log', '--topo-order', '-z', '--format=%H%x00%P%x00%an%x00%ae%x00%ct%x00%at%x00%cI%x00%aI', sha]).split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 8) throw new Error('Malformed Git commit metadata');
    const out = new Map();
    for (let i = 0; i < fields.length; i += 8) {
      const [id, parents, name, email, ct, at, committerDate, authorDate] = fields.slice(i, i + 8);
      if (!/^[a-f0-9]{40,64}$/.test(id)) throw new Error('Malformed commit ID');
      out.set(id, { sha: id, parents: parents ? parents.split(' ') : [], name, email,
        timestamp: Number(ct), authorTimestamp: Number(at), committerDate, authorDate });
    }
    return out;
  }
  firstParent(sha) { return this.run(['rev-list', '--first-parent', '--reverse', sha]).trim().split('\n').filter(Boolean); }
  introduced(merge, previous, baseline) {
    return this.run(['rev-list', '--topo-order', '--reverse', ...merge.parents.slice(1), '--not', previous,
      ...(baseline ? [baseline] : [])]).trim().split('\n').filter(Boolean);
  }
  tree(sha) {
    return this.run(['ls-tree', '-r', '-z', sha]).split('\0').filter(Boolean).map(record => {
      const split = record.indexOf('\t'), [mode, type, oid] = record.slice(0, split).split(' ');
      return { mode, type, oid, path: record.slice(split + 1) };
    }).sort((a, b) => compare(a.path, b.path));
  }
  loadBlobs(ids) {
    const wanted = [...new Set(ids)].filter(id => id && !/^0+$/.test(id) && !this.blobs.has(id)).sort(compare);
    if (!wanted.length) return;
    const data = this.raw(['cat-file', '--batch'], wanted.join('\n') + '\n');
    let p = 0;
    for (const id of wanted) {
      const end = data.indexOf(10, p);
      const [oid, type, sizeText] = data.subarray(p, end).toString().split(' ');
      const size = Number(sizeText);
      if (oid !== id || type !== 'blob' || !Number.isSafeInteger(size)) throw new Error(`Missing or invalid blob ${id}`);
      p = end + 1;
      const bytes = data.subarray(p, p + size); p += size + 1;
      if (bytes.length !== size) throw new Error(`Truncated blob ${id}`);
      let text = null, reason = null;
      if (bytes.includes(0)) reason = 'binary_nul';
      else { try { text = asText(bytes); } catch { reason = 'non_utf8'; } }
      this.blobs.set(id, { text, reason, bytes: size, lines: text === null ? null : textLines(text).filter(nonblank).length });
    }
  }
  blob(id) {
    if (!id || /^0+$/.test(id)) return { text: '', reason: null, bytes: 0, lines: 0 };
    this.loadBlobs([id]); return this.blobs.get(id);
  }
  changes(before, after) {
    const parts = this.run(['diff', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--find-renames=50%', before, after, '--']).split('\0');
    const changes = [];
    for (let i = 0; i < parts.length && parts[i];) {
      const [oldMode, newMode, oldOid, newOid, status] = parts[i++].slice(1).split(' ');
      const oldPath = parts[i++];
      const newPath = /^[RC]/.test(status) ? parts[i++] : oldPath;
      changes.push({ oldMode, newMode, oldOid, newOid, status, oldPath, newPath });
    }
    this.loadBlobs(changes.flatMap(c => [
      ...(['100644', '100755'].includes(c.oldMode) ? [c.oldOid] : []),
      ...(['100644', '100755'].includes(c.newMode) ? [c.newOid] : [])]));
    // Git's rename similarity is byte-based. Pair otherwise unmatched deletion /
    // addition files with identical nonblank, whitespace-normalised contents so
    // a formatting-only move cannot manufacture activity.
    const semantic = id => {
      const blob = this.blobs.get(id);
      return blob?.text == null ? null : textLines(blob.text).filter(nonblank).map(cleanLine).join('\n');
    };
    const removed = changes.filter(c => c.status === 'D').sort((a, b) => compare(a.oldPath, b.oldPath));
    const used = new Set();
    for (const add of changes.filter(c => c.status === 'A').sort((a, b) => compare(a.newPath, b.newPath))) {
      const signature = semantic(add.newOid);
      const old = signature === null ? null : removed.find(c => !used.has(c) && semantic(c.oldOid) === signature);
      if (old) {
        used.add(old); add.oldOid = old.oldOid; add.oldMode = old.oldMode;
        add.oldPath = old.oldPath; add.status = 'R-normalised';
      }
    }
    return changes.filter(c => !used.has(c)).sort((a, b) => compare(a.newPath, b.newPath) || compare(a.oldPath, b.oldPath));
  }
  patch(before, after, file) {
    if (file.status === 'R-normalised') return { added: [], deleted: [] };
    const patch = this.run(['diff', '--no-ext-diff', '--no-textconv', '--text', '--no-color',
      '--find-renames=50%', '--unified=0', '--ignore-all-space', '--ignore-blank-lines', before, after, '--',
      ...new Set([file.oldPath, file.newPath])]);
    let oldLine = 0, newLine = 0, inHunk = false;
    const added = [], deleted = [];
    for (const line of patch.split('\n')) {
      const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) { oldLine = Number(h[1]); newLine = Number(h[2]); inHunk = true; continue; }
      if (line.startsWith('diff --git ')) { inHunk = false; continue; }
      if (!inHunk) continue;
      if (line.startsWith('+')) { if (nonblank(line.slice(1))) added.push({ line: newLine, text: line.slice(1) }); newLine++; }
      else if (line.startsWith('-')) { if (nonblank(line.slice(1))) deleted.push({ line: oldLine, text: line.slice(1) }); oldLine++; }
      else if (line.startsWith(' ')) { oldLine++; newLine++; }
    }
    return { added, deleted };
  }
  blame(sha, path, movement = false) {
    const key = JSON.stringify([sha, path, movement]);
    if (this.blames.has(key)) return this.blames.get(key);
    const output = this.run(['blame', '--line-porcelain', '--root', '-w', ...(movement ? ['-M', '-C', '-C'] : []), sha, '--', path]);
    const lines = new Map(); let current = null;
    for (const line of output.split('\n')) {
      const match = line.match(/^(\^?[a-f0-9]{40,64}) (\d+) (\d+)(?: \d+)?$/);
      if (match) current = { sha: match[1].replace(/^\^/, ''), originalLine: Number(match[2]), line: Number(match[3]) };
      else if (line.startsWith('\t') && current) { lines.set(current.line, { ...current, text: line.slice(1) }); current = null; }
    }
    this.blames.set(key, lines); return lines;
  }
  refsOutside(snapshot) {
    const refs = asText(this.source(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/remotes']).stdout).trim().split('\n').filter(Boolean);
    return refs.map(row => { const [ref, sha] = row.split('\0'); return { ref, sha }; })
      .filter(({ sha }) => this.run(['rev-list', '--count', sha, '--not', snapshot]).trim() !== '0')
      .sort((a, b) => compare(a.ref, b.ref));
  }
}
