import { createHash } from 'node:crypto';

export const VERSION = '3.0.0';
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort(compare).map(key => [key, canonical(value[key])]));
  return value;
}
export const serialise = value => JSON.stringify(canonical(value), null, 2) + '\n';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const identityKey = (name, email) => JSON.stringify([name, email]);
export const username = email => email.match(/^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/)?.[1] ?? null;
export const cleanLine = value => value.replace(/\s/g, '');
export const nonblank = value => /\S/.test(value);
export const textLines = value => value === '' ? [] : value.replace(/\n$/, '').split('\n');
export function warn(list, code, message, details = {}) {
  list.push({ code, message, ...details });
}
