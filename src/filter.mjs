import { DEFAULT_EXCLUDES } from './config.mjs';

// Small, documented glob dialect: *, ?, ** and **/. No regexes or extglobs.
export function glob(pattern) {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; result += '(?:.*/)?'; }
      else result += '.*';
    } else if (c === '*') result += '[^/]*';
    else if (c === '?') result += '[^/]';
    else result += c.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
  }
  return new RegExp(result + '$', 's');
}
export function fileFilter(config) {
  const include = config.include.map(glob);
  const exclude = [...(config.useDefaultExcludes ? DEFAULT_EXCLUDES : []), ...config.exclude].map(rule => ({ rule, re: glob(rule) }));
  return path => {
    if (!include.some(re => re.test(path))) return 'not_included';
    return exclude.find(({ re }) => re.test(path))?.rule ?? null;
  };
}
export function identityExclusion(commit, config) {
  const rule = config.identityExclusions.find(r => (!r.name || r.name === commit.name) && (!r.email || r.email === commit.email));
  if (rule) return rule.reason;
  if (config.excludeKnownBots && (/^(?:\d+\+)?(?:dependabot|renovate|github-actions)\[bot\]@users\.noreply\.github\.com$/.test(commit.email))) return 'known_github_bot';
  return null;
}
