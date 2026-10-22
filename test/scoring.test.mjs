import test from 'node:test';
import assert from 'node:assert/strict';
import { score, normalise, roundPercentages } from '../src/scoring.mjs';
import { validateConfig, weeks, weekOf } from '../src/config.mjs';
import { configuration, at } from './fixtures.mjs';
import { glob } from '../src/filter.mjs';
import { csvCell } from '../src/reporting.mjs';
const weights = configuration().weights;
const row = (id, weekly, retained) => ({ id, weekly, retained, excluded: null });

test('approved ten-week reference: 38.16 / 61.84 with lambda 400', () => {
  const result = score([row('A', [...Array(9).fill(0), 1000], 100), row('B', Array(10).fill(100), 100)], 10, weights);
  assert.equal(result.lambda, 400);
  assert.deepEqual(result.rows.map(r => r.displayedPercentage), [38.16, 61.84]);
  assert.ok(Math.abs(result.rows[0].percentage - 38.1578947368421) < 1e-10);
});
test('inactive weeks and short final weeks are included as whole intervals', () => {
  const config = configuration({ end: at(7.5) });
  assert.equal(weeks(config).length, 2);
  assert.equal(weekOf(Date.parse(at(7)) / 1000, config), 1);
  assert.equal(weekOf(Date.parse(at(7.5)) / 1000, config), null);
  assert.equal(weekOf(Date.parse(at(0)) / 1000, config), 0);
});
test('equal shares, single contributor and exact deterministic rounding totals', () => {
  assert.equal(score([row('A', [2], 2)], 1, weights).rows[0].percentage, 100);
  const result = score(['A', 'B', 'C'].map(id => row(id, [1, 1], 1)), 2, weights);
  assert.deepEqual(result.rows.map(r => r.displayedPercentage), [33.34, 33.33, 33.33]);
  assert.equal([...roundPercentages(result.rows).values()].reduce((n, v) => n + Math.round(v * 100), 0), 10000);
});
test('no evidence does not redistribute weights; non-student exclusions retain raw data', () => {
  const result = score([row('A', [10], 0)], 1, weights);
  assert.equal(result.rows[0].percentage, null);
  assert.match(result.reasons.join(), /retained/);
  const x = score([row('A', [10], 1), { ...row('staff', [100], 100), excluded: 'staff' }], 1, weights);
  assert.equal(x.rows[0].percentage, 100);
  assert.equal(x.rows[1].activity, 100);
  assert.equal(x.rows[1].percentage, null);
});
test('reconcile summed raw components and recalculate all denominators', () => {
  const raw = [{ id: 'a1', sustained: 1, activity: 1, retained: 20 }, { id: 'a2', sustained: 2, activity: 3, retained: 10 },
    { id: 'b', sustained: 3, activity: 4, retained: 30 }, { id: 'staff', sustained: 100, activity: 1, retained: 1 }];
  const result = normalise([{ id: 'A', sustained: 3, activity: 4, retained: 30 }, raw[2]], weights);
  assert.deepEqual(result.rows.map(r => r.percentage), [50, 50]);
  assert.notEqual(normalise(raw, weights).rows[0].percentage + normalise(raw, weights).rows[1].percentage, 50);
});
test('configuration validation catches misspellings, invalid dates, weights and refs', () => {
  assert.throws(() => validateConfig({ start: '2026-02-30T00:00:00Z', end: at(70) }));
  assert.throws(() => configuration({ weights: { sustained: 50, activity: 35, retained: 15 } }));
  assert.throws(() => configuration({ typo: true }));
  assert.throws(() => configuration({ start: '2026-01-01' }));
  assert.throws(() => configuration({ repositories: { group: { submitted: 'main' } } }));
  assert.throws(() => configuration({ timezone: 'Not/AZone' }));
});
test('glob matching handles root/nested paths literally, CSV quotes and formulas', () => {
  assert.ok(glob('**/node_modules/**').test('node_modules/x.js'));
  assert.ok(glob('**/node_modules/**').test('client/node_modules/x.js'));
  assert.ok(!glob('**/node_modules/**').test('my_node_modules/x.js'));
  assert.ok(glob('src/a[1].js').test('src/a[1].js'));
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell('=1+1'), "'=1+1");
});
test('Sydney calendar weeks retain their anchor through daylight-saving transitions', () => {
  const autumn = configuration({ start: '2026-03-02T00:00:00+11:00', end: '2026-05-11T00:00:00+10:00', timezone: 'Australia/Sydney' });
  assert.equal(weeks(autumn).length, 10);
  const spring = configuration({ start: '2026-09-28T00:00:00+10:00', end: '2026-10-12T00:00:00+11:00', timezone: 'Australia/Sydney' });
  assert.equal(weeks(spring).length, 2);
  assert.equal(weekOf(Date.parse('2026-10-05T00:00:00+11:00') / 1000, spring), 1);
  assert.equal(Date.parse(weeks(spring)[0].end) - Date.parse(weeks(spring)[0].start), 167 * 3600000);
});
