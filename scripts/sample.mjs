import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Fixture, A, B, lines, configuration } from '../test/fixtures.mjs';
import { assess } from '../src/assess.mjs';
import { writeReports, terminalSummary } from '../src/reporting.mjs';
import { serialise, hash } from '../src/util.mjs';

const output = resolve(process.argv[2] ?? 'results/reference-sample');
const f = new Fixture();
try {
  f.branch('sustained');
  for (let w = 0; w < 10; w++) f.commit(B, 7 * w + 1, { [`b-${w}.txt`]: lines(`student_b_week_${w}`, 100) });
  f.git(['checkout', 'main']); f.branch('final-week'); f.commit(A, 64, { 'a.txt': lines('student_a', 1000) });
  f.merge('sustained', 69); f.merge('final-week', 69);
  const config = configuration();
  const report = assess(f.path, 'reference-group', config);
  writeReports([report], output, config, hash(serialise(config)));
  writeFileSync(join(output, 'input.config.json'), serialise(config));
  console.log(terminalSummary([report]));
  const legacy = spawnSync(process.execPath, [resolve('legacy/contribution-scriptv2.2.mjs'), '--no-csv'], { cwd: f.path, encoding: 'utf8' });
  if (legacy.status !== 0) throw new Error(legacy.stderr);
  writeFileSync(join(output, 'legacy-summary.txt'), legacy.stdout);
  mkdirSync('examples', { recursive: true });
  writeFileSync('examples/reference-results.json', serialise({ scores: report.canonical.scores, legacyOutput: legacy.stdout }));
  console.log(`Saved deterministic reference outputs to ${output}`);
} finally { f.close(); }

const small = new Fixture();
try {
  small.branch('feature'); small.commit(A, 1, { 'a.txt': lines('a', 2) });
  small.commit(B, 8, { 'b.txt': lines('b', 2) }); small.merge('feature', 9);
  const config = configuration();
  writeReports([assess(small.path, 'small-group', config)], 'examples/sample-output', config, hash(serialise(config)));
} finally { small.close(); }
