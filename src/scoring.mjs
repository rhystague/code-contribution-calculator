import { compare } from './util.mjs';

export function roundPercentages(rows, field = 'percentage') {
  const list = rows.map(row => ({ id: row.id, basis: Math.floor(row[field] * 100), remainder: row[field] * 100 - Math.floor(row[field] * 100) }));
  let remaining = 10000 - list.reduce((n, r) => n + r.basis, 0);
  list.sort((a, b) => b.remainder - a.remainder || compare(a.id, b.id));
  for (let i = 0; i < remaining; i++) list[i % list.length].basis++;
  return new Map(list.map(r => [r.id, r.basis / 100]));
}
export function score(raw, weekCount, weights, fatal = []) {
  const totalsByWeek = Array(weekCount).fill(0);
  for (const row of raw) if (!row.excluded) row.weekly.forEach((n, w) => { totalsByWeek[w] += n; });
  const totalActivity = totalsByWeek.reduce((a, b) => a + b, 0);
  const lambda = 2 * totalActivity / weekCount;
  const rows = raw.map(row => ({ ...row, sustained: row.weekly.reduce((n, value, w) => n + (totalsByWeek[w] + lambda > 0 ? value / (totalsByWeek[w] + lambda) : 0), 0),
    activity: row.weekly.reduce((a, b) => a + b, 0) }));
  return normalise(rows, weights, { fatal, lambda, totalsByWeek });
}
// Downstream reconciliation: sum U/A/R per student, remove non-students, then call
// this function. Do not recompute U from weekly data after reconciliation.
export function normalise(rows, weights, extra = {}) {
  const totals = Object.fromEntries(['sustained', 'activity', 'retained'].map(k => [k, rows.filter(r => !r.excluded).reduce((n, r) => n + r[k], 0)]));
  const reasons = [...(extra.fatal ?? [])];
  for (const [key, value] of Object.entries(totals)) if (weights[key] > 0 && !(value > 0)) reasons.push(`No usable ${key} evidence`);
  const results = rows.map(row => {
    const components = Object.fromEntries(Object.keys(totals).map(k => [k, !row.excluded && totals[k] > 0 ? 100 * row[k] / totals[k] : 0]));
    const percentage = reasons.length || row.excluded ? null : Object.keys(weights).reduce((n, k) => n + weights[k] * components[k], 0);
    return { ...row, components, percentage, displayedPercentage: null };
  }).sort((a, b) => compare(a.id, b.id));
  if (!reasons.length) {
    const rounded = roundPercentages(results.filter(r => !r.excluded));
    for (const row of results) if (!row.excluded) row.displayedPercentage = rounded.get(row.id);
  }
  return { ...extra, fatal: undefined, reasons, totals, rows: results };
}
