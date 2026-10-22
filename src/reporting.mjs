import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, serialise, compare } from './util.mjs';

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Spreadsheet formula protection; JSON always preserves the original identity.
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const headers = ['repository', 'identity', 'name', 'email', 'github_username',
  'sustained_raw', 'sustained_pct', 'activity_raw', 'activity_pct', 'retained_raw', 'retained_pct',
  'provisional_percentage', 'displayed_percentage', 'excluded_reason', 'status', 'warning_count', 'submitted_sha', 'model_version'];
export function csv(reports) {
  const rows = [headers];
  for (const report of reports) {
    const c = report.canonical;
    if (!c.scores.rows.length) rows.push([c.repository, '', '', '', '', '', '', '', '', '', '', '', '', '', c.status, c.warnings.length, c.submitted, c.version]);
    for (const row of c.scores.rows) rows.push([c.repository, row.id, row.name, row.email, row.githubUsername,
      row.sustained, row.components.sustained, row.activity, row.components.activity,
      row.retained, row.components.retained, row.percentage, row.displayedPercentage?.toFixed(2), row.excluded,
      c.status, c.warnings.length, c.submitted, c.version]);
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
const terminalText = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
export function terminalSummary(reports) {
  const lines = ['Repository | Contributor | Sustained % | Activity % | Retained % | Provisional % | Status'];
  for (const { canonical: c } of reports) {
    for (const row of c.scores.rows) lines.push([c.repository, `${row.name} <${row.email}>`,
      row.components.sustained.toFixed(2), row.components.activity.toFixed(2), row.components.retained.toFixed(2),
      row.displayedPercentage?.toFixed(2) ?? '—', row.excluded ? `excluded: ${row.excluded}` : c.status].map(terminalText).join(' | '));
    if (!c.scores.rows.length) lines.push(`${terminalText(c.repository)} | unscorable: ${terminalText(c.scores.reasons.join('; '))}`);
    if (c.scores.rows.length && c.scores.reasons.length) lines.push(`  ${terminalText(c.scores.reasons.join('; '))}`);
  }
  const counts = ['scored', 'flagged', 'unscorable'].map(s => `${reports.filter(r => r.canonical.status === s).length} ${s}`);
  lines.push('', `${reports.length} repositories: ${counts.join(', ')}.`,
    'Percentages are provisional Git identities. Reconcile raw U/A/R before marking.');
  return lines.join('\n') + '\n';
}
export function writeReports(reports, output, config, sourceHash) {
  mkdirSync(join(output, 'audit'), { recursive: true });
  const ordered = [...reports].sort((a, b) => compare(a.canonical.repository, b.canonical.repository));
  writeFileSync(join(output, 'contributions.csv'), csv(ordered));
  const exceptions = [], manifest = [];
  const frozen = structuredClone(config);
  for (const report of ordered) {
    const c = report.canonical;
    const name = c.repository.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) + '-' + hash(c.repository).slice(0, 12) + '.json';
    writeFileSync(join(output, 'audit', name), serialise(report));
    manifest.push({ repository: c.repository, submitted: c.submitted, baseline: c.baseline, status: c.status, audit: `audit/${name}`, evidenceHash: report.evidenceHash });
    for (const warning of c.warnings) exceptions.push({ repository: c.repository, ...warning });
    for (const reason of c.scores.reasons) exceptions.push({ repository: c.repository, code: 'UNSCORABLE', message: reason });
    if (report.observations.outsideSnapshot?.length) exceptions.push({ repository: c.repository, code: 'REFS_OUTSIDE_SNAPSHOT',
      message: 'Local branch refs contain commits outside the submitted snapshot. They receive no credit; refs may include later work.', refs: report.observations.outsideSnapshot });
    if (c.submitted) Object.defineProperty(frozen.repositories, c.repository, { value: { submitted: c.submitted, baseline: c.baseline }, enumerable: true, configurable: true, writable: true });
  }
  writeFileSync(join(output, 'exceptions.json'), serialise(exceptions));
  writeFileSync(join(output, 'manifest.json'), serialise({ sourceConfigHash: sourceHash, repositories: manifest }));
  writeFileSync(join(output, 'frozen.config.json'), serialise(frozen));
  writeFileSync(join(output, 'summary.txt'), terminalSummary(ordered));
}
