#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readdirSync } from 'node:fs';
import { resolve, basename, join, relative, isAbsolute } from 'node:path';
import { loadConfig } from './src/config.mjs';
import { assess } from './src/assess.mjs';
import { writeReports, terminalSummary } from './src/reporting.mjs';
import { compare, VERSION } from './src/util.mjs';

const help = `Code Contribution Calculator ${VERSION}
Usage:
  node assess.mjs --repo ./group --config contribution.config.json [--output ./results]
  node assess.mjs --repos ./submissions --config contribution.config.json [--output ./results]

Requires Node.js 22+, Git, complete local repositories and an explicit assessment period.
Outputs contributions.csv, audit/*.json, exceptions.json, frozen.config.json and summary.txt.
Replay frozen SHAs with --config ./results/frozen.config.json.
Exit codes: 0 all scored/flagged; 1 one or more unscorable; 2 configuration/usage/output error.
Flags: --help, --version. No network access, student setup or GitHub authentication required.
`;
try {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, repos: { type: 'string' }, config: { type: 'string' }, output: { type: 'string', default: './results' },
    help: { type: 'boolean' }, version: { type: 'boolean' }
  }, allowPositionals: false });
  if (values.help) console.log(help);
  else if (values.version) console.log(VERSION);
  else {
    if (Boolean(values.repo) === Boolean(values.repos) || !values.config) throw new Error('Supply exactly one of --repo/--repos, plus --config. Use --help for examples.');
    const { config, sourceHash } = loadConfig(values.config);
    const output = resolve(values.output);
    const root = resolve(values.repo ?? values.repos);
    const paths = values.repo ? [root] : readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && resolve(root, entry.name) !== output)
      .map(entry => join(root, entry.name)).sort(compare);
    if (!paths.length) throw new Error('No repository directories found');
    for (const path of paths) {
      const inside = relative(path, output);
      if (!inside || (!inside.startsWith('..') && !isAbsolute(inside))) throw new Error('Output must be outside the assessed repositories');
    }
    const reports = [];
    for (const path of paths) {
      process.stderr.write(`Analysing ${JSON.stringify(basename(path))}…\n`);
      reports.push(assess(path, basename(path), config));
    }
    writeReports(reports, output, config, sourceHash);
    process.stdout.write(terminalSummary(reports));
    if (reports.some(r => r.canonical.status === 'unscorable')) process.exitCode = 1;
  }
} catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 2; }
