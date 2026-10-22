import { readFileSync } from 'node:fs';
import { canonical, hash, serialise } from './util.mjs';

export const DEFAULT_EXCLUDES = [
  '**/node_modules/**', '**/vendor/**', '**/.venv/**', '**/venv/**',
  '**/__pycache__/**', '**/dist/**', '**/build/**', '**/target/**',
  '**/coverage/**', '**/.next/**', '**/.nuxt/**', '**/bin/**', '**/obj/**',
  '**/*.min.js', '**/*.min.css', '**/*.map', '**/*.generated.*',
  '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock',
  '**/pnpm-lock.yaml', '**/bun.lock', '**/bun.lockb', '**/Cargo.lock',
  '**/composer.lock', '**/poetry.lock', '**/uv.lock', '**/Pipfile.lock',
  '**/Gemfile.lock', '**/packages.lock.json', '**/go.sum', '**/.mailmap'
];
const KEYS = ['start', 'end', 'timezone', 'mainBranch', 'weights', 'include', 'exclude',
  'useDefaultExcludes', 'identityExclusions', 'excludeKnownBots', 'repositories', 'thresholds'];
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
function strings(value, label) {
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x || x.includes('\0'))) throw new Error(`${label} must be an array of non-empty strings`);
  return value;
}
function instant(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new Error(`${label} requires an ISO timestamp with an explicit UTC offset`);
  }
  const n = Date.parse(value);
  // Reject normalised impossible dates, e.g. 30 February.
  const day = value.slice(0, 10);
  if (!Number.isFinite(n) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error(`Invalid ${label}`);
  return n;
}
export function validateConfig(input) {
  keys(input, KEYS, 'configuration');
  const startMs = instant(input.start, 'start'), endMs = instant(input.end, 'end');
  if (endMs <= startMs) throw new Error('end must be after start (exclusive)');
  const timezone = input.timezone ?? 'UTC';
  new Intl.DateTimeFormat('en-AU', { timeZone: timezone }).format(0);
  const mainBranch = input.mainBranch ?? 'main';
  if (typeof mainBranch !== 'string' || !mainBranch || mainBranch.startsWith('-') || /[\0\r\n]/.test(mainBranch)) throw new Error('Invalid mainBranch');
  const weights = input.weights ?? { sustained: 0.50, activity: 0.35, retained: 0.15 };
  keys(weights, ['sustained', 'activity', 'retained'], 'weights');
  if (['sustained', 'activity', 'retained'].some(k => !Number.isFinite(weights[k]) || weights[k] < 0) ||
      Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) > 1e-12) throw new Error('Three non-negative weights must sum to 1');
  const thresholds = { largeChange: 5000, churnRatio: 5, minAttributionCoverage: 0.8,
    authorCommitterSkewHours: 168, timestampToleranceSeconds: 0, ...input.thresholds };
  keys(thresholds, ['largeChange', 'churnRatio', 'minAttributionCoverage', 'authorCommitterSkewHours', 'timestampToleranceSeconds'], 'thresholds');
  for (const [key, value] of Object.entries(thresholds)) if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid threshold: ${key}`);
  if (thresholds.minAttributionCoverage > 1) throw new Error('minAttributionCoverage must be <= 1');
  for (const key of ['useDefaultExcludes', 'excludeKnownBots']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  const repositories = input.repositories ?? {};
  object(repositories, 'repositories');
  for (const [id, entry] of Object.entries(repositories)) {
    keys(entry, ['submitted', 'baseline'], `repositories.${id}`);
    for (const key of Object.keys(entry)) if (entry[key] !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry[key])) throw new Error(`${id}.${key} must be a full commit SHA`);
  }
  const identityExclusions = input.identityExclusions ?? [];
  if (!Array.isArray(identityExclusions)) throw new Error('identityExclusions must be an array');
  for (const entry of identityExclusions) {
    keys(entry, ['name', 'email', 'reason'], 'identityExclusions');
    if ((!entry.name && !entry.email) || !entry.reason || Object.values(entry).some(x => typeof x !== 'string')) throw new Error('Identity exclusions need exact name/email and a reason');
  }
  return canonical({ start: input.start, end: input.end, timezone, mainBranch, weights,
    include: strings(input.include ?? ['**'], 'include'),
    exclude: strings(input.exclude ?? [], 'exclude'), useDefaultExcludes: input.useDefaultExcludes ?? true,
    excludeKnownBots: input.excludeKnownBots ?? false, identityExclusions, thresholds, repositories });
}
export function loadConfig(path) {
  const bytes = readFileSync(path);
  return { config: validateConfig(JSON.parse(bytes.toString('utf8'))), sourceHash: hash(bytes) };
}
export const configHash = config => hash(serialise(config));
const weekCache = new WeakMap();
export function weeks(config) {
  if (weekCache.has(config)) return weekCache.get(config);
  const start = Date.parse(config.start), end = Date.parse(config.end);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const wallTime = ms => {
    const parts = Object.fromEntries(formatter.formatToParts(ms).map(p => [p.type, p.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)) + ((ms % 1000) + 1000) % 1000;
  };
  const anchor = wallTime(start), result = [];
  let cursor = start;
  while (cursor < end) {
    const wall = anchor + (result.length + 1) * 7 * 86400000;
    if (wall >= wallTime(end)) {
      result.push({ index: result.length, start: new Date(cursor).toISOString(), end: new Date(end).toISOString() });
      break;
    }
    // Resolve a local calendar boundary using the offsets on either side of DST.
    const offsets = new Set([-2, 0, 2].map(days => {
      const probe = wall + days * 86400000;
      return wallTime(probe) - probe;
    }));
    const matches = [...offsets].map(offset => wall - offset).filter(ms => wallTime(ms) === wall);
    if (matches.length !== 1) throw new Error('An assessment week boundary is an ambiguous/nonexistent local time; choose a different start time (for example midday)');
    const next = Math.min(matches[0], end);
    result.push({ index: result.length, start: new Date(cursor).toISOString(), end: new Date(next).toISOString() });
    cursor = next;
  }
  weekCache.set(config, result);
  return result;
}
export function weekOf(seconds, config) {
  const t = seconds * 1000, start = Date.parse(config.start), end = Date.parse(config.end);
  return Number.isFinite(t) && t >= start && t < end ? weeks(config).findIndex(w => t < Date.parse(w.end)) : null;
}
