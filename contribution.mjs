#!/usr/bin/env node
// Code Contribution Calculator v3. Copy this file and run it with Node; no packages needed.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const VERSION = '3.0.0';

const SECONDS_PER_DAY = 86400;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
const UNATTRIBUTED_IDENTITY = 'Unattributed';
const CALCULATOR_PATH = fileURLToPath(import.meta.url);
const CALCULATOR_HASH = hashContent(readFileSync(CALCULATOR_PATH));
const COMPONENT_NAMES = ['sustained', 'activity', 'retained'];

// Shared text, date and ordering helpers.

function compareValues(firstValue, secondValue) {
  if (firstValue < secondValue) {
    return -1;
  }
  if (firstValue > secondValue) {
    return 1;
  }
  return 0;
}

function compareSerializedValues(firstValue, secondValue) {
  return compareValues(JSON.stringify(firstValue), JSON.stringify(secondValue));
}

function compareIdentityIds(firstIdentity, secondIdentity) {
  return compareValues(firstIdentity.id, secondIdentity.id);
}

function compareReferenceNames(firstReference, secondReference) {
  return compareValues(firstReference.ref, secondReference.ref);
}

function compareFilePaths(firstEntry, secondEntry) {
  return compareValues(firstEntry[0], secondEntry[0]);
}

function normaliseWhitespace(text) {
  return text.replace(/\s/g, '');
}

function formatTimestamp(seconds) {
  return new Date(seconds * 1000).toISOString();
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

function escapeControlCharacter(character) {
  const characterCode = character.charCodeAt(0).toString(16).padStart(4, '0');
  return `\\u${characterCode}`;
}

function escapeTerminalText(value) {
  const controlCharacters = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
  return String(value).replace(controlCharacters, escapeControlCharacter);
}

function splitNonEmptyLines(text) {
  return text.trim().split('\n').filter(Boolean);
}

function blockSignature(lines) {
  return JSON.stringify(lines.map(normaliseWhitespace));
}

function hasMissingAuthorIdentity(author) {
  return !(author?.name || author?.email);
}

// Command-line options and the intentionally small path-pattern language.

function validateDateOption(optionName, value) {
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  const hasDateFormat = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const isValidTimestamp = Number.isFinite(milliseconds);

  if (hasDateFormat && isValidTimestamp) {
    const parsedDate = new Date(milliseconds).toISOString().slice(0, 10);
    if (parsedDate === value) {
      return;
    }
  }

  throw new Error(`--${optionName} must be a real date in YYYY-MM-DD format (UTC).`);
}

function assignOptionValue(options, optionName, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`--${optionName} needs a value.`);
  }

  if (optionName === 'include' || optionName === 'exclude') {
    options[optionName].push(value);
    return;
  }

  if (options[optionName] !== undefined) {
    throw new Error(`--${optionName} was supplied more than once.`);
  }
  options[optionName] = value;
}

export function parseOptions(argumentsList) {
  const options = {
    exclude: [],
    include: [],
    code: false,
    csv: true,
    json: false,
  };
  const valueOptions = new Set([
    'start', 'end', 'startdate', 'enddate', 'exclude', 'include',
  ]);

  for (let argumentIndex = 0; argumentIndex < argumentsList.length; argumentIndex++) {
    const argument = argumentsList[argumentIndex];

    switch (argument) {
      case '--code':
        options.code = true;
        continue;
      case '--no-csv':
        options.csv = false;
        continue;
      case '--json':
        options.json = true;
        continue;
      case '--help':
      case '-h':
        options.help = true;
        continue;
    }

    const optionMatch = /^--([^=]+)(?:=(.*))?$/.exec(argument);
    if (!optionMatch || !valueOptions.has(optionMatch[1])) {
      throw new Error(`Unknown option: ${escapeTerminalText(argument)}. Use --help.`);
    }

    const optionName = optionMatch[1];
    let optionValue = optionMatch[2];
    if (optionValue === undefined) {
      argumentIndex++;
      optionValue = argumentsList[argumentIndex];
    }
    assignOptionValue(options, optionName, optionValue);
  }

  for (const optionName of ['startdate', 'enddate']) {
    if (options[optionName]) {
      validateDateOption(optionName, options[optionName]);
    }
  }

  if (options.startdate && options.enddate && options.startdate > options.enddate) {
    throw new Error('Start date must not follow end date.');
  }
  return options;
}

// Patterns match the entire repository-relative path; only *, ** and ? are special.
export function glob(pattern) {
  if (pattern.startsWith('/') || pattern.split('/').includes('..')) {
    throw new Error('Filter patterns must be repository-relative.');
  }

  let expression = '^';
  for (let characterIndex = 0; characterIndex < pattern.length; characterIndex++) {
    const character = pattern[characterIndex];
    const nextCharacter = pattern[characterIndex + 1];

    if (character === '*' && nextCharacter === '*') {
      characterIndex++;
      if (pattern[characterIndex + 1] === '/') {
        expression += '(?:.*/)?';
        characterIndex++;
      } else {
        expression += '.*';
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return new RegExp(expression + '$');
}

// Git access and integration-branch selection.

function createGitReader(workingDirectory) {
  function readGit(argumentsList, { buffer = false, optional = false } = {}) {
    const gitArguments = [
      '--no-replace-objects',
      '-c', 'core.fsmonitor=false',
      '-c', 'protocol.allow=never',
      '-c', 'diff.renameLimit=0',
      ...argumentsList,
    ];

    try {
      const output = execFileSync('git', gitArguments, {
        cwd: workingDirectory,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LC_ALL: 'C',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      });

      if (buffer) {
        return output;
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(output);
    } catch (error) {
      if (optional && error.status !== undefined) {
        return null;
      }
      const errorDetails = error.stderr?.toString().trim() || error.message;
      throw new Error(
        `Cannot read Git evidence (${argumentsList[0]}): ` +
        `${escapeTerminalText(errorDetails)}. No complete score was produced.`,
      );
    }
  }

  return readGit;
}

function readReferences(readGit) {
  const output = readGit([
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(symref)',
    'refs/heads',
    'refs/remotes',
  ]);
  const references = [];

  for (const referenceLine of output.trimEnd().split('\n')) {
    if (!referenceLine) {
      continue;
    }
    const [referenceName, commitHash, symbolicTarget] = referenceLine.split('\0');
    references.push({ ref: referenceName, sha: commitHash, target: symbolicTarget });
  }
  return references;
}

function remoteBranchName(referenceName) {
  return referenceName.split('/').slice(3).join('/');
}

function findLocalBranch(references, branchName) {
  for (const reference of references) {
    if (reference.ref === `refs/heads/${branchName}`) {
      return reference;
    }
  }
  return undefined;
}

function findCachedBranches(references, branchName) {
  const cachedReferences = [];
  for (const reference of references) {
    if (reference.target || !reference.ref.startsWith('refs/remotes/')) {
      continue;
    }
    if (remoteBranchName(reference.ref) === branchName) {
      cachedReferences.push(reference);
    }
  }
  return cachedReferences;
}

function resolveRecordedDefault(references) {
  const branchNames = new Set();
  const defaultTargets = new Set();

  for (const reference of references) {
    const isRemoteHead = reference.ref.startsWith('refs/remotes/') &&
      reference.ref.endsWith('/HEAD');
    if (reference.target && isRemoteHead) {
      branchNames.add(remoteBranchName(reference.target));
      defaultTargets.add(reference.target);
    }
  }

  if (branchNames.size !== 1) {
    throw new Error(
      'Integration branch is ambiguous or unavailable: expected exactly one main/master, ' +
      'or an unambiguous locally recorded remote default. ' +
      'No network lookup or checkout fallback was used.',
    );
  }

  const preferredReferences = [];
  for (const reference of references) {
    if (defaultTargets.has(reference.ref)) {
      preferredReferences.push(reference);
    }
  }
  return { branchName: [...branchNames][0], preferredReferences };
}

function selectCachedReference(candidates, branchName) {
  const commitHashes = new Set();
  for (const candidate of candidates) {
    commitHashes.add(candidate.sha);
  }
  if (!candidates.length || commitHashes.size !== 1) {
    throw new Error(
      `Cached references for ${branchName} are unavailable or disagree; cannot select a snapshot.`,
    );
  }
  return [...candidates].sort(compareReferenceNames)[0];
}

export function selectBranch(readGit) {
  const references = readReferences(readGit);
  const conventionalBranches = [];

  for (const branchName of ['main', 'master']) {
    const localBranch = findLocalBranch(references, branchName);
    const cachedBranches = findCachedBranches(references, branchName);
    if (localBranch || cachedBranches.length) {
      conventionalBranches.push(branchName);
    }
  }

  let branchName;
  let selectionMethod;
  let preferredReferences = [];

  if (conventionalBranches.length === 1) {
    [branchName] = conventionalBranches;
    selectionMethod = 'conventional main/master name';
  } else {
    const recordedDefault = resolveRecordedDefault(references);
    branchName = recordedDefault.branchName;
    preferredReferences = recordedDefault.preferredReferences;
    selectionMethod = 'locally recorded remote default';
  }

  const cachedBranches = findCachedBranches(references, branchName);
  const candidates = preferredReferences.length ? preferredReferences : cachedBranches;
  const selectedReference = findLocalBranch(references, branchName) ||
    selectCachedReference(candidates, branchName);
  const warnings = [];

  for (const cachedReference of cachedBranches) {
    if (cachedReference.sha !== selectedReference.sha) {
      warnings.push(
        `Selected ${selectedReference.ref} differs from cached ${cachedReference.ref}; ` +
        'remote state has not been refreshed.',
      );
    }
  }

  return {
    name: branchName,
    ref: selectedReference.ref,
    tip: selectedReference.sha,
    method: selectionMethod,
    warnings,
  };
}

function readFileChanges(readGit, parentHash, commitHash) {
  const argumentsList = [
    'diff-tree', '--no-commit-id', '--raw', '-z', '-r', '--no-abbrev',
    '-M50%', '--no-ext-diff', '--no-textconv',
  ];
  if (parentHash) {
    argumentsList.push(parentHash, commitHash);
  } else {
    argumentsList.push('--root', commitHash);
  }

  const fields = readGit(argumentsList).split('\0');
  const fileChanges = [];
  let fieldIndex = 0;

  while (fieldIndex < fields.length && fields[fieldIndex]) {
    const changeHeader = fields[fieldIndex++];
    const headerMatch = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/.exec(changeHeader);
    if (!headerMatch) {
      throw new Error('Unexpected Git raw diff; refusing incomplete evidence.');
    }

    const [, oldMode, newMode, oldBlob, newBlob, status] = headerMatch;
    const oldPath = fields[fieldIndex++];
    let newPath = oldPath;
    if (/^[RC]/.test(status)) {
      newPath = fields[fieldIndex++];
    }
    fileChanges.push({ oldMode, newMode, oldBlob, newBlob, status, oldPath, newPath });
  }
  return fileChanges;
}

// File eligibility. Explicit exclusions precede inclusions; hard exclusions always apply.

const UNSUITABLE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf',
  'zip', 'gz', 'bz2', 'xz', '7z', 'tar', 'jar',
  'class', 'pyc', 'pyo', 'wasm', 'exe', 'dll', 'so', 'dylib',
  'woff', 'woff2', 'ttf', 'mp3', 'mp4', 'mov',
  'sqlite', 'db', 'docx', 'xlsx', 'pptx',
]);
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', 'vendor', '.venv', 'venv', '.git',
  'dist', 'build', 'coverage', '__pycache__', '.next', '.nuxt',
  '.cache', '.pytest_cache', '.mypy_cache',
]);
const LOCKFILE_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock',
  'composer.lock', 'Gemfile.lock', 'go.sum', 'packages.lock.json', 'pubspec.lock',
  'paket.lock', 'gradle.lockfile', 'flake.lock',
]);
const GENERATED_FILENAME_PATTERNS = [
  /\.min\.(?:js|css)$/i,
  /\.map$/i,
  /\.generated\.[^/]+$/i,
  /\.g\.(?:cs|dart)$/i,
  /_pb2(?:_grpc)?\.py$/i,
  /\.pb\.(?:go|h|cc)$/i,
];
const GENERATION_MARKERS = [
  /@generated\b/i,
  /\bcode generated\b.*\bdo not edit\b/i,
  /\bautomatically generated\b/i,
  /\bauto-generated\b/i,
];

function hasUnsuitableExtension(filePath) {
  const extensionStart = filePath.lastIndexOf('.');
  if (extensionStart < 0) {
    return false;
  }
  const extension = filePath.slice(extensionStart + 1).toLowerCase();
  return UNSUITABLE_EXTENSIONS.has(extension);
}

function isInExcludedDirectory(filePath) {
  for (const pathSegment of filePath.split('/')) {
    if (EXCLUDED_DIRECTORIES.has(pathSegment)) {
      return true;
    }
  }
  return false;
}

function isMissingBlob(blobHash) {
  return /^0+$/.test(blobHash);
}

function isCalculatorFile(fileName, contentHash) {
  return contentHash === CALCULATOR_HASH ||
    fileName === basename(CALCULATOR_PATH) ||
    /^contribution(?:-script.*)?\.(?:mjs|js|py)$/.test(fileName) ||
    /^py-contribution-script/.test(fileName) ||
    /(?:^|-)contribution-(?:summary\.csv|evidence\.json)$/.test(fileName);
}

function firstMatchingPattern(patterns, filePath) {
  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex++) {
    if (patterns[patternIndex].test(filePath)) {
      return patternIndex;
    }
  }
  return -1;
}

function defaultExclusionReason(filePath, content) {
  const fileName = basename(filePath);
  if (isInExcludedDirectory(filePath)) {
    return 'dependency, environment, build or cache directory';
  }
  if (LOCKFILE_NAMES.has(fileName)) {
    return 'package-manager lockfile';
  }
  if (/^(?:commit-history|git-log|git-history)\.txt$/.test(fileName)) {
    return 'recognised Git history export';
  }
  if (firstMatchingPattern(GENERATED_FILENAME_PATTERNS, filePath) >= 0) {
    return 'recognised generated filename';
  }
  const fileHeader = content.lines.slice(0, 8).join('\n');
  if (firstMatchingPattern(GENERATION_MARKERS, fileHeader) >= 0) {
    return 'generation marker in first eight lines';
  }
  return null;
}

function createEligibilityChecker(readBlob, options) {
  const includePatterns = options.include.map(glob);
  const excludePatterns = options.exclude.map(glob);

  function checkEligibility(filePath, blobHash, fileMode) {
    if (isMissingBlob(blobHash)) {
      return { eligible: false, reason: 'absent' };
    }
    if (!/^100(644|755)$/.test(fileMode)) {
      return { eligible: false, reason: 'non-regular file (symlink/submodule)' };
    }

    const content = readBlob(blobHash);
    if (isCalculatorFile(basename(filePath), content.hash)) {
      return { eligible: false, reason: 'calculator or generated contribution report' };
    }
    if (content.binary || hasUnsuitableExtension(filePath)) {
      return { eligible: false, reason: 'binary or unsuitable for line counting' };
    }

    const excludedPatternIndex = firstMatchingPattern(excludePatterns, filePath);
    if (excludedPatternIndex >= 0) {
      return {
        eligible: false,
        reason: `explicit --exclude ${options.exclude[excludedPatternIndex]}`,
      };
    }

    const includedPatternIndex = firstMatchingPattern(includePatterns, filePath);
    if (includedPatternIndex >= 0) {
      return {
        eligible: true,
        reason: `explicit --include ${options.include[includedPatternIndex]}`,
      };
    }

    const exclusionReason = defaultExclusionReason(filePath, content);
    return { eligible: !exclusionReason, reason: exclusionReason || 'authored text' };
  }

  return checkEligibility;
}

// Git objects and line provenance. A line origin records who introduced a line;
// accepted-history records, built later, decide whether that work earns credit.

function parseDiffHunks(patch) {
  const hunks = [];
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

  for (const headerMatch of patch.matchAll(hunkHeader)) {
    const removedCount = Number(headerMatch[2] ?? 1);
    const addedCount = Number(headerMatch[4] ?? 1);
    hunks.push({
      oldStart: Number(headerMatch[1]) - (removedCount ? 1 : 0),
      removedCount,
      newStart: Number(headerMatch[3]) - (addedCount ? 1 : 0),
      addedCount,
    });
  }
  return hunks;
}

function wholeFileHunk(oldLineCount, newLineCount) {
  return [{
    oldStart: 0,
    removedCount: oldLineCount,
    newStart: 0,
    addedCount: newLineCount,
  }];
}

// Copy unchanged positions; leave changed positions for the attribution step.
function alignUnchangedLines(previousLines, newLineCount, hunks, unassignedValue = undefined) {
  const alignedLines = new Array(newLineCount).fill(unassignedValue);
  let oldLineIndex = 0;
  let newLineIndex = 0;

  for (const hunk of hunks) {
    while (newLineIndex < hunk.newStart) {
      alignedLines[newLineIndex] = previousLines?.[oldLineIndex];
      oldLineIndex++;
      newLineIndex++;
    }
    oldLineIndex = hunk.oldStart + hunk.removedCount;
    newLineIndex = hunk.newStart + hunk.addedCount;
  }

  while (newLineIndex < alignedLines.length) {
    alignedLines[newLineIndex] = previousLines?.[oldLineIndex];
    oldLineIndex++;
    newLineIndex++;
  }
  return alignedLines;
}

function parseCommitPerson(header, personType) {
  const personPattern = new RegExp(
    `^${personType} (.*) <([^>]*)> (-?\\d+) ([+-]\\d{4})$`,
    'm',
  );
  const personMatch = personPattern.exec(header);
  if (!personMatch) {
    return null;
  }
  return {
    name: personMatch[1],
    email: personMatch[2],
    time: Number(personMatch[3]),
    offset: personMatch[4],
  };
}

function hasValidTimestamp(person) {
  return person && Number.isFinite(person.time) && Math.abs(person.time) < 8640000000000;
}

function createLineOrigin(commit, filePath, lineNumber) {
  const lineOrigin = {
    id: `${commit.sha}:${filePath}:${lineNumber}`,
    commit: commit.sha,
    author: commit.author,
    time: commit.authorTime,
  };
  if (hasMissingAuthorIdentity(commit.author)) {
    lineOrigin.reason = 'recorded author identity is missing';
  }
  return lineOrigin;
}

function lineOriginId(lineOrigin) {
  return lineOrigin?.lineage || lineOrigin?.id || '';
}

function createSnapshot(previousSnapshot) {
  return {
    files: new Map(previousSnapshot?.files),
    removedBlocks: new Map(previousSnapshot?.removedBlocks),
    fileLineages: new Map(previousSnapshot?.fileLineages),
  };
}

function findBlocksWithSignature(blocks, signature) {
  const matches = [];
  for (const block of blocks) {
    if (blockSignature(block.texts) === signature) {
      matches.push(block);
    }
  }
  return matches;
}

function createChangedBlocks(hunks, oldLines, newLines, previousRecords) {
  const removals = [];
  const additions = [];

  for (const hunk of hunks) {
    removals.push({
      hunk,
      entries: previousRecords.slice(hunk.oldStart, hunk.oldStart + hunk.removedCount),
      texts: oldLines.slice(hunk.oldStart, hunk.oldStart + hunk.removedCount),
    });
    additions.push({
      hunk,
      texts: newLines.slice(hunk.newStart, hunk.newStart + hunk.addedCount),
    });
  }
  return { removals, additions };
}

function preserveUniqueMovedBlocks(removals, additions, nextRecords, includeBlankBlocks = false) {
  const movedBlocks = new Set();

  for (const addition of additions) {
    if (!addition.texts.length || (!includeBlankBlocks && !addition.texts.some(normaliseWhitespace))) {
      continue;
    }
    const signature = blockSignature(addition.texts);
    const matchingRemovals = findBlocksWithSignature(removals, signature);
    const matchingAdditions = findBlocksWithSignature(additions, signature);
    if (matchingRemovals.length !== 1 || matchingAdditions.length !== 1) {
      continue;
    }

    const [removal] = matchingRemovals;
    movedBlocks.add(removal);
    movedBlocks.add(addition);
    for (let lineIndex = 0; lineIndex < removal.entries.length; lineIndex++) {
      nextRecords[addition.hunk.newStart + lineIndex] = removal.entries[lineIndex];
    }
  }
  return movedBlocks;
}

function createEvidenceEngine(readGit, options, fileDecisions) {
  const blobCache = new Map();
  const diffCache = new Map();
  const snapshots = new Map();
  const commitCache = new Map();
  const deletionEvents = new Map();
  const checkEligibility = createEligibilityChecker(readBlob, options);

  function readBlob(blobHash) {
    if (!blobHash || isMissingBlob(blobHash)) {
      return { lines: [], text: '', binary: false };
    }
    if (blobCache.has(blobHash)) {
      return blobCache.get(blobHash);
    }

    const data = readGit(['cat-file', 'blob', blobHash], { buffer: true });
    let isBinary = data.includes(0);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      isBinary = true;
      text = '';
    }
    if (/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
      isBinary = true;
    }

    const lines = text === '' ? [] : text.split('\n');
    if (lines.at(-1) === '') {
      lines.pop();
    }
    const content = { text, lines, binary: isBinary, hash: hashContent(data) };
    blobCache.set(blobHash, content);
    return content;
  }

  function readLineChanges(oldBlobHash, newBlobHash) {
    const cacheKey = `${oldBlobHash}:${newBlobHash}`;
    if (diffCache.has(cacheKey)) {
      return diffCache.get(cacheKey);
    }

    const oldLines = readBlob(oldBlobHash).lines;
    const newLines = readBlob(newBlobHash).lines;
    let hunks;
    if (oldBlobHash === newBlobHash) {
      hunks = [];
    } else if (!oldLines.length || !newLines.length) {
      hunks = wholeFileHunk(oldLines.length, newLines.length);
    } else {
      const patch = readGit([
        'diff', '--text', '--no-ext-diff', '--no-textconv', '--no-color',
        '--no-renames', '--diff-algorithm=myers', '--no-indent-heuristic',
        '--unified=0', '-w', oldBlobHash, newBlobHash, '--',
      ]);
      hunks = parseDiffHunks(patch);
    }

    diffCache.set(cacheKey, hunks);
    return hunks;
  }

  function alignFileOrigins(previousFile, newBlobHash) {
    const newLineCount = readBlob(newBlobHash).lines.length;
    const hunks = readLineChanges(previousFile?.blob, newBlobHash);
    return alignUnchangedLines(previousFile?.lineOrigins, newLineCount, hunks);
  }

  function readCommit(commitHash) {
    if (commitCache.has(commitHash)) {
      return commitCache.get(commitHash);
    }

    const rawCommit = readGit(['cat-file', 'commit', commitHash]);
    const header = rawCommit.slice(0, rawCommit.indexOf('\n\n'));
    const author = parseCommitPerson(header, 'author');
    const committer = parseCommitPerson(header, 'committer');
    const parentHashes = [];
    for (const parentMatch of header.matchAll(/^parent ([0-9a-f]+)$/gm)) {
      parentHashes.push(parentMatch[1]);
    }

    const commit = {
      sha: commitHash,
      parents: parentHashes,
      author,
      authorTime: hasValidTimestamp(author) ? author.time : null,
      committerTime: hasValidTimestamp(committer) ? committer.time : null,
    };
    commitCache.set(commitHash, commit);
    return commit;
  }

  function originBlockKey(fileLineage, previousFile, hunk, lines) {
    const previousLines = previousFile ? readBlob(previousFile.blob).lines : [];
    let leftAnchorIndex = hunk.oldStart - 1;
    let rightAnchorIndex = hunk.oldStart + hunk.removedCount;

    while (leftAnchorIndex >= 0 && !normaliseWhitespace(previousLines[leftAnchorIndex])) {
      leftAnchorIndex--;
    }
    while (rightAnchorIndex < previousLines.length &&
      !normaliseWhitespace(previousLines[rightAnchorIndex])) {
      rightAnchorIndex++;
    }

    return JSON.stringify([
      fileLineage,
      lineOriginId(previousFile?.lineOrigins[leftAnchorIndex]),
      lineOriginId(previousFile?.lineOrigins[rightAnchorIndex]),
      lines.map(normaliseWhitespace),
    ]);
  }

  function rememberRemovedOrigins(snapshot, fileLineage, previousFile, hunks) {
    if (!previousFile?.eligible) {
      return;
    }
    const previousLines = readBlob(previousFile.blob).lines;
    for (const hunk of hunks) {
      if (!hunk.removedCount) {
        continue;
      }
      const endLine = hunk.oldStart + hunk.removedCount;
      const removedLines = previousLines.slice(hunk.oldStart, endLine);
      const matchingKey = originBlockKey(fileLineage, previousFile, hunk, removedLines);
      const removedOrigins = previousFile.lineOrigins.slice(hunk.oldStart, endLine);
      snapshot.removedBlocks.set(matchingKey, removedOrigins);
    }
  }

  function recordFileDecision(filePath, blobHash, decision) {
    const isExplicitInclusion = decision.reason.startsWith('explicit --include');
    if (decision.reason === 'absent' || (decision.eligible && !isExplicitInclusion)) {
      return;
    }
    const decisionKey = `${filePath}\0${blobHash}\0${decision.reason}`;
    fileDecisions.set(decisionKey, { path: filePath, blob: blobHash, ...decision });
  }

  function findIncomingFile(parentSnapshot, fileChange) {
    let incomingFile = parentSnapshot.files.get(fileChange.newPath);
    if (!incomingFile && fileChange.oldPath !== fileChange.newPath) {
      incomingFile = parentSnapshot.files.get(fileChange.oldPath);
    }
    if (incomingFile) {
      return incomingFile;
    }

    const matchingFiles = [];
    for (const candidateFile of parentSnapshot.files.values()) {
      if (candidateFile.eligible && candidateFile.blob === fileChange.newBlob) {
        matchingFiles.push(candidateFile);
      }
    }
    if (matchingFiles.length === 1) {
      return matchingFiles[0];
    }
    return undefined;
  }

  function readIncomingOrigins(parentSnapshots, fileChange) {
    const incomingOrigins = [];
    for (const parentSnapshot of parentSnapshots.slice(1)) {
      const incomingFile = findIncomingFile(parentSnapshot, fileChange);
      if (incomingFile?.eligible) {
        incomingOrigins.push(alignFileOrigins(incomingFile, fileChange.newBlob));
      } else {
        incomingOrigins.push([]);
      }
    }
    return incomingOrigins;
  }

  function resolveMergeLineOrigin(commit, filePath, lineIndex, incomingOrigins) {
    const candidatesById = new Map();
    for (const parentOrigins of incomingOrigins) {
      const candidate = parentOrigins[lineIndex];
      if (candidate) {
        candidatesById.set(candidate.id, candidate);
      }
    }
    const candidates = [...candidatesById.values()];
    if (candidates.length === 1) {
      return candidates[0];
    }

    let sharedTimestamp = null;
    if (candidates.length) {
      sharedTimestamp = candidates[0].time;
      for (const candidate of candidates) {
        if (candidate.time !== candidates[0].time) {
          sharedTimestamp = null;
          break;
        }
      }
    }

    return {
      id: `${commit.sha}:${filePath}:${lineIndex + 1}`,
      commit: null,
      author: null,
      time: sharedTimestamp,
      reason: candidates.length
        ? 'incoming parents disagree on authorship'
        : 'merge-only change has no originating development evidence',
    };
  }

  function attributeNewLines(lineOrigins, commit, fileChange, parentSnapshots) {
    // Only unchanged lines from an incoming parent establish merge provenance.
    const incomingOrigins = readIncomingOrigins(parentSnapshots, fileChange);
    for (let lineIndex = 0; lineIndex < lineOrigins.length; lineIndex++) {
      if (lineOrigins[lineIndex]) {
        continue;
      }
      if (parentSnapshots.length < 2) {
        lineOrigins[lineIndex] = createLineOrigin(commit, fileChange.newPath, lineIndex + 1);
      } else {
        lineOrigins[lineIndex] = resolveMergeLineOrigin(
          commit, fileChange.newPath, lineIndex, incomingOrigins,
        );
      }
    }
  }

  function restoreOriginalLineages(snapshot, fileLineage, previousFile, hunks, newLines, lineOrigins) {
    for (const hunk of hunks) {
      if (!hunk.addedCount) {
        continue;
      }
      const addedLines = newLines.slice(hunk.newStart, hunk.newStart + hunk.addedCount);
      const matchingKey = originBlockKey(fileLineage, previousFile, hunk, addedLines);
      const restoredOrigins = snapshot.removedBlocks.get(matchingKey);
      if (!restoredOrigins) {
        continue;
      }

      for (let lineIndex = 0; lineIndex < restoredOrigins.length; lineIndex++) {
        const targetIndex = hunk.newStart + lineIndex;
        lineOrigins[targetIndex] = {
          ...lineOrigins[targetIndex],
          lineage: lineOriginId(restoredOrigins[lineIndex]),
        };
      }
    }
  }

  function recordDeletedOrigins(previousOrigins, nextOrigins, commitHash, deletedOrigins) {
    const survivingOriginIds = new Set(nextOrigins.map(lineOriginId));
    for (const previousOrigin of previousOrigins) {
      if (previousOrigin && !survivingOriginIds.has(lineOriginId(previousOrigin))) {
        deletedOrigins.push({ token: lineOriginId(previousOrigin), commit: commitHash });
      }
    }
  }

  function updateSnapshotFile(fileChange, commit, parentSnapshots, previousSnapshot, snapshot, deletedOrigins) {
    const previousFile = previousSnapshot.files.get(fileChange.oldPath);
    const oldEligibility = checkEligibility(fileChange.oldPath, fileChange.oldBlob, fileChange.oldMode);
    const newEligibility = checkEligibility(fileChange.newPath, fileChange.newBlob, fileChange.newMode);
    const fileLineage = previousSnapshot.fileLineages.get(fileChange.oldPath) ||
      `${commit.sha}:${fileChange.oldPath}`;

    if (fileChange.oldPath !== fileChange.newPath) {
      snapshot.fileLineages.delete(fileChange.oldPath);
    }
    snapshot.fileLineages.set(fileChange.newPath, fileLineage);

    let hunks;
    if (previousFile?.eligible && newEligibility.eligible) {
      hunks = readLineChanges(previousFile.blob, fileChange.newBlob);
    } else {
      const oldLineCount = previousFile?.lineOrigins.length || 0;
      const newLineCount = newEligibility.eligible ? readBlob(fileChange.newBlob).lines.length : 0;
      hunks = wholeFileHunk(oldLineCount, newLineCount);
    }

    rememberRemovedOrigins(snapshot, fileLineage, previousFile, hunks);
    recordFileDecision(fileChange.oldPath, fileChange.oldBlob, oldEligibility);
    recordFileDecision(fileChange.newPath, fileChange.newBlob, newEligibility);

    if (fileChange.oldPath !== fileChange.newPath || fileChange.status === 'D') {
      snapshot.files.delete(fileChange.oldPath);
    }
    if (fileChange.status === 'D') {
      recordDeletedOrigins(previousFile?.lineOrigins || [], [], commit.sha, deletedOrigins);
      return;
    }
    if (!newEligibility.eligible) {
      snapshot.files.set(fileChange.newPath, {
        blob: fileChange.newBlob,
        mode: fileChange.newMode,
        lineOrigins: [],
        eligible: false,
      });
      return;
    }

    const newLines = readBlob(fileChange.newBlob).lines;
    let lineOrigins = new Array(newLines.length);
    if (previousFile?.eligible) {
      lineOrigins = alignFileOrigins(previousFile, fileChange.newBlob);
      const oldLines = readBlob(previousFile.blob).lines;
      const changedBlocks = createChangedBlocks(hunks, oldLines, newLines, previousFile.lineOrigins);
      preserveUniqueMovedBlocks(changedBlocks.removals, changedBlocks.additions, lineOrigins, true);
    }

    attributeNewLines(lineOrigins, commit, fileChange, parentSnapshots);
    restoreOriginalLineages(snapshot, fileLineage, previousFile, hunks, newLines, lineOrigins);
    recordDeletedOrigins(previousFile?.lineOrigins || [], lineOrigins, commit.sha, deletedOrigins);
    snapshot.files.set(fileChange.newPath, {
      blob: fileChange.newBlob,
      mode: fileChange.newMode,
      lineOrigins,
      eligible: true,
    });
  }

  function buildSnapshot(commitHash) {
    const commit = readCommit(commitHash);
    const parentSnapshots = [];
    for (const parentHash of commit.parents) {
      const parentSnapshot = snapshots.get(parentHash);
      if (!parentSnapshot) {
        throw new Error('A required parent snapshot is missing. Full local history is required.');
      }
      parentSnapshots.push(parentSnapshot);
    }

    const previousSnapshot = parentSnapshots[0] || createSnapshot();
    const snapshot = createSnapshot(previousSnapshot);
    const deletedOrigins = [];
    const fileChanges = readFileChanges(readGit, commit.parents[0], commitHash);
    for (const fileChange of fileChanges) {
      updateSnapshotFile(fileChange, commit, parentSnapshots, previousSnapshot, snapshot, deletedOrigins);
    }

    snapshots.set(commitHash, snapshot);
    deletionEvents.set(commitHash, deletedOrigins);
    return snapshot;
  }

  return { snapshots, deletionEvents, readBlob, readLineChanges, readCommit, buildSnapshot };
}

// Resolve the assessment scope before collecting accepted changes.

function verifyCompleteHistory(readGit, workingDirectory) {
  readGit(['rev-parse', '--show-toplevel']);
  const graftsPath = resolve(workingDirectory, readGit(['rev-parse', '--git-path', 'info/grafts']).trim());
  if (existsSync(graftsPath)) {
    for (const graftLine of readFileSync(graftsPath, 'utf8').split('\n')) {
      if (graftLine.trim() && !graftLine.trim().startsWith('#')) {
        throw new Error(
          'Local grafts rewrite ancestry. Remove the graft overlay or use an unmodified clone ' +
          'for a reproducible analysis.',
        );
      }
    }
  }

  if (readGit(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error(
      'Shallow history is incomplete. Obtain the full repository history before calculating contributions.',
    );
  }
}

function resolveCommitBoundary(readGit, commitInput, optionName, mainline, branch) {
  if (!/^[0-9a-fA-F]{4,64}$/.test(commitInput)) {
    throw new Error(`${optionName} must be a commit hash (not a branch, tag or revision expression).`);
  }
  const commitHash = readGit([
    'rev-parse', '--verify', '--end-of-options', `${commitInput}^{commit}`,
  ]).trim();
  const mainlineIndex = mainline.indexOf(commitHash);
  if (mainlineIndex < 0) {
    throw new Error(`${optionName} is not a first-parent snapshot on ${branch.ref}.`);
  }
  return mainlineIndex;
}

function resolveHistoryScope(readGit, engine, branch, options) {
  const mainline = splitNonEmptyLines(readGit([
    'rev-list', '--first-parent', '--reverse', branch.tip,
  ]));
  const startIndex = options.start
    ? resolveCommitBoundary(readGit, options.start, '--start', mainline, branch)
    : -1;
  let endIndex = options.end
    ? resolveCommitBoundary(readGit, options.end, '--end', mainline, branch)
    : mainline.length - 1;

  if (startIndex >= endIndex) {
    throw new Error('The excluded start baseline must precede the inclusive end snapshot.');
  }

  const dateStart = options.startdate
    ? Date.parse(`${options.startdate}T00:00:00Z`) / 1000
    : -Infinity;
  const dateEnd = options.enddate
    ? Date.parse(`${options.enddate}T00:00:00Z`) / 1000 + SECONDS_PER_DAY - 1
    : Infinity;

  if (options.enddate) {
    while (endIndex >= 0) {
      const endpoint = engine.readCommit(mainline[endIndex]);
      if (endpoint.committerTime !== null && endpoint.committerTime <= dateEnd) {
        break;
      }
      endIndex--;
    }
  }
  if (endIndex <= startIndex) {
    throw new Error('No mainline snapshot satisfies the supplied commit and date boundaries.');
  }

  const endHash = mainline[endIndex];
  const startHash = startIndex >= 0 ? mainline[startIndex] : null;
  const commitOrder = splitNonEmptyLines(readGit([
    'rev-list', '--topo-order', '--reverse', endHash,
  ]));
  const baselineCommits = new Set();
  if (startHash) {
    for (const commitHash of splitNonEmptyLines(readGit(['rev-list', startHash]))) {
      baselineCommits.add(commitHash);
    }
  }

  const selectedCommits = [];
  for (const commitHash of commitOrder) {
    if (!baselineCommits.has(commitHash)) {
      selectedCommits.push(commitHash);
    }
  }

  return {
    mainline,
    startIndex,
    endIndex,
    startHash,
    endHash,
    dateStart,
    dateEnd,
    commitOrder,
    selectedCommits,
  };
}

function collectTimestampWarnings(engine, history, options, warnings, problems) {
  if (options.enddate) {
    for (const commitHash of history.mainline.slice(0, history.endIndex + 1)) {
      if (engine.readCommit(commitHash).committerTime > history.dateEnd) {
        problems.push(
          'The selected snapshot contains a mainline ancestor dated after the requested cutoff; ' +
          'timestamp order cannot establish a reliable date-limited score.',
        );
        break;
      }
    }
  }

  for (const commitHash of history.commitOrder) {
    const commit = engine.readCommit(commitHash);
    if (commit.authorTime === null || commit.committerTime === null) {
      warnings.add(`Invalid timestamp metadata at ${commitHash}.`);
    } else if (commit.authorTime > commit.committerTime) {
      warnings.add(`Author time follows committer time at ${commitHash}; Git timestamps are editable.`);
    }

    for (const parentHash of commit.parents) {
      if (engine.readCommit(parentHash).committerTime > commit.committerTime) {
        warnings.add(`Committer time goes backwards at ${commitHash}; snapshot order follows ancestry.`);
        break;
      }
    }
  }
}

function resolveReportingPeriod(engine, history, problems) {
  const firstCommit = engine.readCommit(history.mainline[0]);
  const lastCommit = engine.readCommit(history.endHash);
  let historyStart;

  if (history.startHash) {
    historyStart = engine.readCommit(history.startHash).committerTime ?? Infinity;
  } else {
    historyStart = firstCommit.committerTime ?? Infinity;
    for (const commitHash of history.commitOrder) {
      const authorTime = engine.readCommit(commitHash).authorTime ?? Infinity;
      historyStart = Math.min(historyStart, authorTime);
    }
  }

  const periodStart = Math.max(historyStart, history.dateStart);
  const periodEnd = Math.min(lastCommit.committerTime ?? -Infinity, history.dateEnd);
  let weekCount = 0;
  if (Number.isFinite(periodStart) && periodEnd >= periodStart) {
    weekCount = Math.floor((periodEnd - periodStart) / SECONDS_PER_WEEK) + 1;
  }

  // Reject pathological metadata rather than silently shortening a reporting period.
  if (weekCount > 100000) {
    throw new Error('Recorded timestamps span over 100,000 weeks; review the history timestamps.');
  }
  if (lastCommit.committerTime === null || !Number.isFinite(historyStart)) {
    problems.push('Required reporting-period timestamps are unavailable.');
  }
  return { periodStart, periodEnd, weekCount };
}

// Accepted-history accounting. These records retain original ownership and whether
// an addition/deletion has already earned credit, even after the line is removed.

function identityKey(person) {
  if (person?.email) {
    return `email:${person.email}`;
  }
  if (person?.name) {
    return `name:${person.name}`;
  }
  return UNATTRIBUTED_IDENTITY;
}

function createIdentitySummary(identityId, weekCount) {
  return {
    id: identityId,
    bucket: identityId === UNATTRIBUTED_IDENTITY,
    names: [],
    emails: [],
    rawIdentities: [],
    commits: 0,
    acceptedCommits: [],
    rawAdded: 0,
    rawDeleted: 0,
    added: 0,
    deleted: 0,
    repeated: 0,
    activity: 0,
    integrationFallbackActivity: 0,
    retained: 0,
    weekly: Array(weekCount).fill(0),
  };
}

function preserveIdentityAliases(summary, person) {
  if (!person) {
    return;
  }
  if (!summary.names.includes(person.name)) {
    summary.names.push(person.name);
  }
  if (!summary.emails.includes(person.email)) {
    summary.emails.push(person.email);
  }

  for (const rawIdentity of summary.rawIdentities) {
    if (rawIdentity.name === person.name && rawIdentity.email === person.email) {
      return;
    }
  }
  summary.rawIdentities.push({ name: person.name, email: person.email });
}

function sortIdentityEvidence(identities) {
  const summaries = [...identities.values()].sort(compareIdentityIds);
  for (const summary of summaries) {
    summary.names.sort(compareValues);
    summary.emails.sort(compareValues);
    summary.rawIdentities.sort(compareSerializedValues);
    summary.acceptedCommits.sort(compareValues);
  }
  return summaries;
}

function acceptedBlockKey(fileLineage, leftAnchor, rightAnchor, lines) {
  const contentHash = hashContent(blockSignature(lines));
  return `${fileLineage}:${leftAnchor || '^'}:${rightAnchor || '$'}:${contentHash}`;
}

function removedContentKey(fileLineage, lines) {
  return `${fileLineage}:${hashContent(blockSignature(lines))}`;
}

function findAcceptedAnchors(records, hunk) {
  let leftAnchorIndex = hunk.oldStart - 1;
  let rightAnchorIndex = hunk.oldStart + hunk.removedCount;
  while (leftAnchorIndex >= 0 && !records[leftAnchorIndex]) {
    leftAnchorIndex--;
  }
  while (rightAnchorIndex < records.length && !records[rightAnchorIndex]) {
    rightAnchorIndex++;
  }
  return [records[leftAnchorIndex]?.id, records[rightAnchorIndex]?.id];
}

function authorEvidence(commit) {
  return { author: commit.author, time: commit.authorTime, commit: commit.sha };
}

function findDeletionCommits(engine, lineOrigin, incomingCommits) {
  const matchingCommits = [];
  const originId = lineOrigin.lineage || lineOrigin.id;

  for (const commit of incomingCommits) {
    if (commit.parents.length >= 2) {
      continue;
    }
    for (const deletion of engine.deletionEvents.get(commit.sha) || []) {
      if (deletion.token === originId) {
        matchingCommits.push(commit);
        break;
      }
    }
  }
  return matchingCommits;
}

function isLatestDeletion(readGit, candidates, latestCandidate) {
  for (const candidate of candidates.slice(0, -1)) {
    const ancestry = readGit([
      'merge-base', '--is-ancestor', candidate.sha, latestCandidate.sha,
    ], { optional: true });
    if (ancestry === null) {
      return false;
    }
  }
  return true;
}

function resolveDeletionAuthor(readGit, engine, lineOrigin, incomingCommits, integrationCommit) {
  if (integrationCommit.parents.length < 2) {
    const evidence = {
      ...integrationCommit,
      time: integrationCommit.authorTime,
      commit: integrationCommit.sha,
    };
    if (hasMissingAuthorIdentity(integrationCommit.author)) {
      evidence.reason = 'recorded author identity is missing';
    }
    return evidence;
  }

  const candidates = findDeletionCommits(engine, lineOrigin, incomingCommits);
  if (candidates.length === 1) {
    return authorEvidence(candidates[0]);
  }
  if (candidates.length > 1) {
    const latestCandidate = candidates.at(-1);
    if (isLatestDeletion(readGit, candidates, latestCandidate)) {
      return authorEvidence(latestCandidate);
    }
  }

  let sharedTimestamp = null;
  if (candidates.length) {
    sharedTimestamp = candidates[0].authorTime;
    for (const candidate of candidates) {
      if (candidate.authorTime !== candidates[0].authorTime) {
        sharedTimestamp = null;
        break;
      }
    }
  }
  return {
    author: null,
    time: sharedTimestamp,
    commit: null,
    reason: candidates.length
      ? 'competing deletion histories'
      : 'deletion has no originating development evidence',
  };
}

function collectAcceptedEvidence(readGit, engine, history, period, warnings, problems) {
  const identities = new Map();
  const acceptedChanges = [];
  const unresolvedChanges = [];
  const retainedLines = [];
  const directCommits = [];
  const fileRecords = new Map();
  const fileLineages = new Map();
  const removedBlocks = new Map();
  const removedContents = new Set();
  let lineSequence = 0;
  let fileSequence = 0;

  function getIdentity(person) {
    const identityId = identityKey(person);
    if (!identities.has(identityId)) {
      identities.set(identityId, createIdentitySummary(identityId, period.weekCount));
    }
    const summary = identities.get(identityId);
    preserveIdentityAliases(summary, person);
    return summary;
  }

  function countSelectedCommits() {
    for (const commitHash of history.selectedCommits) {
      const commit = engine.readCommit(commitHash);
      const isWithinDateLimits = commit.authorTime !== null &&
        commit.authorTime >= history.dateStart && commit.authorTime <= history.dateEnd;
      if (isWithinDateLimits) {
        getIdentity(commit.author).commits++;
      }
    }
  }

  function assignActivityWeek(evidence, actor, summary, integrationCommit) {
    evidence.week = null;
    evidence.activityTime = null;
    evidence.timingSource = null;
    if (!evidence.eligible) {
      return;
    }

    // A missing development date uses first acceptance, without changing authorship.
    // Known dates outside the period must not be moved to a more convenient week.
    const usesIntegrationDate = actor.time === null;
    const activityTime = usesIntegrationDate ? integrationCommit.committerTime : actor.time;
    evidence.activityTime = activityTime === null ? null : formatTimestamp(activityTime);
    evidence.timingSource = usesIntegrationDate ? 'integration' : 'author';

    const hasUsableTime = activityTime !== null &&
      activityTime >= period.periodStart && activityTime <= period.periodEnd;
    if (hasUsableTime && period.weekCount) {
      const weekIndex = Math.floor((activityTime - period.periodStart) / SECONDS_PER_WEEK);
      summary.weekly[weekIndex] += evidence.eligible;
      if (usesIntegrationDate) {
        summary.integrationFallbackActivity += evidence.eligible;
      }
      evidence.week = weekIndex;
      return;
    }

    problems.push('Eligible activity has no usable timing, even with integration-date fallback, ' +
      'or lies outside the effective history period.');
    warnings.add(
      `Cannot place ${evidence.eligible} ${evidence.kind} units into a week ` +
      `at ${evidence.integration}:${evidence.path}.`,
    );
  }

  function recordActivity(changeKind, actor, lineRecord, integrationCommit, filePath, inScope) {
    const isAddition = changeKind === 'add';
    const creditedField = isAddition ? 'added' : 'deleted';
    const alreadyCounted = lineRecord[creditedField];
    lineRecord[creditedField] = true;

    const isWithinDateLimits = actor.time !== null &&
      actor.time >= history.dateStart && actor.time <= history.dateEnd;
    if (!inScope || (!isWithinDateLimits && actor.time !== null)) {
      return;
    }

    const summary = getIdentity(actor.author);
    const repeatedUnits = alreadyCounted ? 1 : 0;
    const eligibleUnits = 1 - repeatedUnits;
    const rawField = isAddition ? 'rawAdded' : 'rawDeleted';
    summary[rawField]++;
    summary[creditedField] += eligibleUnits;
    summary.repeated += repeatedUnits;
    summary.activity += eligibleUnits;

    if (actor.commit && !summary.acceptedCommits.includes(actor.commit)) {
      summary.acceptedCommits.push(actor.commit);
    }

    const evidence = {
      integration: integrationCommit.sha,
      path: filePath,
      kind: changeKind,
      identity: summary.id,
      originCommit: actor.commit,
      authorTime: actor.time === null ? null : formatTimestamp(actor.time),
      integrationTime: integrationCommit.committerTime === null
        ? null
        : formatTimestamp(integrationCommit.committerTime),
      raw: 1,
      eligible: eligibleUnits,
      repeated: repeatedUnits,
      lineIds: [lineRecord.id],
      reason: repeatedUnits ? 'exact accepted change already credited at this location' : null,
    };
    if (actor.reason) {
      evidence.attributionIssue = actor.reason;
      unresolvedChanges.push(evidence);
    }
    acceptedChanges.push(evidence);
    assignActivityWeek(evidence, actor, summary, integrationCommit);

    if (isAddition && !alreadyCounted) {
      lineRecord.owner = summary.id;
    }
  }

  function prepareFileHistory(fileChange, previousSnapshot, nextSnapshot) {
    const previousFile = previousSnapshot.files.get(fileChange.oldPath);
    const nextFile = nextSnapshot.files.get(fileChange.newPath);
    if (!previousFile?.eligible && !nextFile?.eligible) {
      return null;
    }

    const oldLines = previousFile?.eligible ? engine.readBlob(previousFile.blob).lines : [];
    const newLines = nextFile?.eligible ? engine.readBlob(nextFile.blob).lines : [];
    const previousRecords = fileRecords.get(fileChange.oldPath) || new Array(oldLines.length).fill(null);
    let fileLineage = fileLineages.get(fileChange.oldPath) || fileLineages.get(fileChange.newPath);
    if (!fileLineage) {
      fileLineage = `file:${++fileSequence}`;
    }
    if (fileChange.oldPath !== fileChange.newPath) {
      fileLineages.delete(fileChange.oldPath);
    }
    fileLineages.set(fileChange.newPath, fileLineage);

    const hunks = previousFile?.eligible && nextFile?.eligible
      ? engine.readLineChanges(previousFile.blob, nextFile.blob)
      : wholeFileHunk(oldLines.length, newLines.length);
    const nextRecords = alignUnchangedLines(previousRecords, newLines.length, hunks, null);

    const changedBlocks = createChangedBlocks(hunks, oldLines, newLines, previousRecords);
    const movedBlocks = preserveUniqueMovedBlocks(
      changedBlocks.removals, changedBlocks.additions, nextRecords,
    );
    return {
      previousFile,
      nextFile,
      previousRecords,
      nextRecords,
      fileLineage,
      removals: changedBlocks.removals,
      additions: changedBlocks.additions,
      movedBlocks,
    };
  }

  function recordRemovedBlocks(fileHistory, fileChange, commit, incomingCommits, inScope) {
    let changedUnits = 0;
    for (const removal of fileHistory.removals) {
      if (fileHistory.movedBlocks.has(removal) || !removal.texts.some(normaliseWhitespace)) {
        continue;
      }
      const [leftAnchor, rightAnchor] = findAcceptedAnchors(fileHistory.previousRecords, removal.hunk);
      const matchingKey = acceptedBlockKey(
        fileHistory.fileLineage, leftAnchor, rightAnchor, removal.texts,
      );
      if (!removedBlocks.has(matchingKey)) {
        removedBlocks.set(matchingKey, removal.entries);
      }
      removedContents.add(removedContentKey(fileHistory.fileLineage, removal.texts));

      for (let lineIndex = 0; lineIndex < removal.entries.length; lineIndex++) {
        const lineRecord = removal.entries[lineIndex];
        if (!lineRecord || !normaliseWhitespace(removal.texts[lineIndex])) {
          continue;
        }
        const originIndex = removal.hunk.oldStart + lineIndex;
        const lineOrigin = fileHistory.previousFile.lineOrigins[originIndex];
        const actor = resolveDeletionAuthor(readGit, engine, lineOrigin, incomingCommits, commit);
        recordActivity('delete', actor, lineRecord, commit, fileChange.oldPath, inScope);
        changedUnits++;
      }
    }
    return changedUnits;
  }

  function recordAddedBlocks(fileHistory, fileChange, commit, inScope) {
    let changedUnits = 0;
    for (const addition of fileHistory.additions) {
      if (fileHistory.movedBlocks.has(addition)) {
        continue;
      }
      const [leftAnchor, rightAnchor] = findAcceptedAnchors(fileHistory.previousRecords, addition.hunk);
      const matchingKey = acceptedBlockKey(
        fileHistory.fileLineage, leftAnchor, rightAnchor, addition.texts,
      );
      const restoredRecords = removedBlocks.get(matchingKey);
      const previousContentKey = removedContentKey(fileHistory.fileLineage, addition.texts);
      if (!restoredRecords && inScope && removedContents.has(previousContentKey)) {
        warnings.add(
          `Matching removed text reappears with different surrounding lines at ` +
          `${commit.sha}:${fileChange.newPath}; repetition and original ownership are uncertain. ` +
          'No repeat exclusion was inferred.',
        );
      }

      for (let lineIndex = 0; lineIndex < addition.texts.length; lineIndex++) {
        if (!normaliseWhitespace(addition.texts[lineIndex])) {
          continue;
        }
        let lineRecord = restoredRecords?.[lineIndex];
        if (!lineRecord) {
          lineRecord = { id: `line:${++lineSequence}`, added: false, deleted: false, owner: null };
        }
        const targetIndex = addition.hunk.newStart + lineIndex;
        fileHistory.nextRecords[targetIndex] = lineRecord;
        const actor = fileHistory.nextFile.lineOrigins[targetIndex];
        recordActivity('add', actor, lineRecord, commit, fileChange.newPath, inScope);
        changedUnits++;
      }
    }
    return changedUnits;
  }

  function processAcceptedFile(fileChange, previousSnapshot, snapshot, commit, incomingCommits, inScope) {
    const fileHistory = prepareFileHistory(fileChange, previousSnapshot, snapshot);
    if (!fileHistory) {
      return 0;
    }

    const deletedUnits = recordRemovedBlocks(fileHistory, fileChange, commit, incomingCommits, inScope);
    const addedUnits = recordAddedBlocks(fileHistory, fileChange, commit, inScope);

    if (fileChange.oldPath !== fileChange.newPath || fileChange.status === 'D') {
      fileRecords.delete(fileChange.oldPath);
    }
    if (fileHistory.nextFile?.eligible) {
      fileRecords.set(fileChange.newPath, fileHistory.nextRecords);
    } else {
      fileRecords.delete(fileChange.newPath);
    }
    return deletedUnits + addedUnits;
  }

  function replayMainlineHistory() {
    let previouslyReachable = new Set();
    for (let mainlineIndex = 0; mainlineIndex <= history.endIndex; mainlineIndex++) {
      const commitHash = history.mainline[mainlineIndex];
      const commit = engine.readCommit(commitHash);
      const snapshot = engine.snapshots.get(commitHash);
      const previousSnapshot = engine.snapshots.get(commit.parents[0]) || createSnapshot();
      const reachableCommits = new Set(splitNonEmptyLines(readGit(['rev-list', commitHash])));
      const incomingCommits = [];

      for (const candidateHash of history.commitOrder) {
        if (reachableCommits.has(candidateHash) &&
          !previouslyReachable.has(candidateHash) && candidateHash !== commitHash) {
          incomingCommits.push(engine.readCommit(candidateHash));
        }
      }
      previouslyReachable = reachableCommits;

      const inScope = mainlineIndex > history.startIndex && commit.committerTime !== null &&
        commit.committerTime >= history.dateStart && commit.committerTime <= history.dateEnd;
      const fileChanges = readFileChanges(readGit, commit.parents[0], commitHash);
      let changedUnits = 0;
      for (const fileChange of fileChanges) {
        changedUnits += processAcceptedFile(
          fileChange, previousSnapshot, snapshot, commit, incomingCommits, inScope,
        );
      }

      if (inScope && commit.parents.length < 2 && changedUnits) {
        directCommits.push(commitHash);
      }
      if (mainlineIndex > history.startIndex && commit.committerTime === null) {
        problems.push(`Missing mainline committer timestamp at ${commitHash}.`);
      }
    }
  }

  function countRetainedLines() {
    const finalSnapshot = engine.snapshots.get(history.endHash);
    const sortedFiles = [...fileRecords].sort(compareFilePaths);
    for (const [filePath, records] of sortedFiles) {
      if (!finalSnapshot.files.get(filePath)?.eligible) {
        continue;
      }
      for (let lineIndex = 0; lineIndex < records.length; lineIndex++) {
        const lineRecord = records[lineIndex];
        if (!lineRecord?.owner) {
          continue;
        }
        identities.get(lineRecord.owner).retained++;
        retainedLines.push({
          path: filePath,
          line: lineIndex + 1,
          lineId: lineRecord.id,
          identity: lineRecord.owner,
        });
      }
    }
  }

  countSelectedCommits();
  replayMainlineHistory();
  countRetainedLines();

  if (directCommits.length) {
    warnings.add(
      `Direct mainline commits: ${directCommits.length} with accepted changes; ` +
      'expected merge workflow was not used. Commit IDs are in JSON evidence.',
    );
  }
  if (unresolvedChanges.length) {
    warnings.add('Some accepted changes have unresolved authorship; the Unattributed bucket remains in totals.');
  }

  return {
    identities: sortIdentityEvidence(identities),
    acceptedChanges,
    unresolvedChanges,
    retainedLines,
    directCommits,
  };
}

// Scoring uses full precision; rounding is applied only to displayed percentages.

export function roundShares(percentages, decimalPlaces = 2) {
  for (const percentage of percentages) {
    if (percentage === null) {
      return new Array(percentages.length).fill(null);
    }
  }
  if (!percentages.length) {
    return [];
  }

  const multiplier = 10 ** decimalPlaces;
  const targetUnits = 100 * multiplier;
  const scaledPercentages = [];
  const roundedUnits = [];
  const allocationOrder = [];
  let allocatedUnits = 0;

  for (let identityIndex = 0; identityIndex < percentages.length; identityIndex++) {
    const scaledPercentage = percentages[identityIndex] * multiplier;
    const wholeUnits = Math.floor(scaledPercentage);
    scaledPercentages.push(scaledPercentage);
    roundedUnits.push(wholeUnits);
    allocationOrder.push(identityIndex);
    allocatedUnits += wholeUnits;
  }

  function compareRemainders(firstIndex, secondIndex) {
    const firstRemainder = scaledPercentages[firstIndex] - roundedUnits[firstIndex];
    const secondRemainder = scaledPercentages[secondIndex] - roundedUnits[secondIndex];
    return secondRemainder - firstRemainder || firstIndex - secondIndex;
  }

  allocationOrder.sort(compareRemainders);
  const remainingUnits = targetUnits - allocatedUnits;
  for (let unitIndex = 0; unitIndex < remainingUnits; unitIndex++) {
    const identityIndex = allocationOrder[unitIndex % allocationOrder.length];
    roundedUnits[identityIndex]++;
  }

  const roundedPercentages = [];
  for (const units of roundedUnits) {
    roundedPercentages.push(units / multiplier);
  }
  return roundedPercentages;
}

function calculateTeamActivity(identities, weekCount) {
  const teamWeekly = new Array(weekCount).fill(0);
  let totalActivity = 0;

  for (const summary of identities) {
    totalActivity += summary.activity;
    for (let weekIndex = 0; weekIndex < weekCount; weekIndex++) {
      teamWeekly[weekIndex] += summary.weekly[weekIndex] || 0;
    }
  }
  return { teamWeekly, totalActivity };
}

function calculateSustainedCredit(identities, teamWeekly, smoothingFactor) {
  for (const summary of identities) {
    summary.sustained = 0;
    for (let weekIndex = 0; weekIndex < summary.weekly.length; weekIndex++) {
      const denominator = teamWeekly[weekIndex] + smoothingFactor;
      if (denominator) {
        summary.sustained += summary.weekly[weekIndex] / denominator;
      }
    }
  }
}

function sumComponentValues(identities) {
  const totals = { sustained: 0, activity: 0, retained: 0 };
  for (const componentName of COMPONENT_NAMES) {
    for (const summary of identities) {
      totals[componentName] += summary[componentName];
    }
  }
  return totals;
}

function calculateIdentityShares(identities, totals, isScorable) {
  for (const summary of identities) {
    summary.components = {};
    for (const componentName of COMPONENT_NAMES) {
      const componentTotal = totals[componentName];
      summary.components[componentName] = componentTotal
        ? 100 * summary[componentName] / componentTotal
        : null;
    }

    summary.overall = null;
    if (isScorable) {
      summary.overall =
        0.50 * summary.components.sustained +
        0.35 * summary.components.activity +
        0.15 * summary.components.retained;
    }
    summary.display = {};
  }
}

function roundDisplayedShares(identities) {
  for (const componentName of [...COMPONENT_NAMES, 'overall']) {
    const percentages = [];
    for (const summary of identities) {
      const percentage = componentName === 'overall'
        ? summary.overall
        : summary.components[componentName];
      percentages.push(percentage);
    }

    const roundedPercentages = roundShares(percentages);
    for (let identityIndex = 0; identityIndex < identities.length; identityIndex++) {
      identities[identityIndex].display[componentName] = roundedPercentages[identityIndex];
    }
  }
}

export function calculate(identities, weekCount, problems = []) {
  const { teamWeekly, totalActivity } = calculateTeamActivity(identities, weekCount);
  const smoothingFactor = weekCount ? 2 * totalActivity / weekCount : 0;
  calculateSustainedCredit(identities, teamWeekly, smoothingFactor);
  const totals = sumComponentValues(identities);
  const reasons = [...problems];

  for (const componentName of COMPONENT_NAMES) {
    if (!totals[componentName]) {
      reasons.push(`No eligible ${componentName} evidence; its weight cannot be redistributed.`);
    }
  }
  if (!weekCount) {
    reasons.push('No non-empty reporting period.');
  }

  calculateIdentityShares(identities, totals, reasons.length === 0);
  roundDisplayedShares(identities);
  return {
    status: reasons.length ? 'unscorable' : 'scorable',
    reasons: [...new Set(reasons)],
    lambda: smoothingFactor,
    weekCount,
    teamWeekly,
    totals,
  };
}

function summariseActivityTiming(acceptedChanges) {
  const timing = {
    totalActivity: 0,
    originalActivity: 0,
    integrationFallbackActivity: 0,
    unplacedActivity: 0,
    fallbackPercentage: null,
  };
  for (const evidence of acceptedChanges) {
    timing.totalActivity += evidence.eligible;
    if (evidence.week === null) {
      timing.unplacedActivity += evidence.eligible;
    } else if (evidence.timingSource === 'integration') {
      timing.integrationFallbackActivity += evidence.eligible;
    } else {
      timing.originalActivity += evidence.eligible;
    }
  }
  if (timing.totalActivity) {
    timing.fallbackPercentage = 100 * timing.integrationFallbackActivity / timing.totalActivity;
  }
  return timing;
}

// Public analysis entry point: scope, provenance, accepted evidence, then scoring.

export function analyse(workingDirectory = process.cwd(), suppliedOptions = {}) {
  const options = { exclude: [], include: [], ...suppliedOptions };
  const readGit = createGitReader(workingDirectory);
  verifyCompleteHistory(readGit, workingDirectory);

  const branch = selectBranch(readGit);
  const warnings = new Set(branch.warnings);
  const problems = [];
  const fileDecisions = new Map();
  const engine = createEvidenceEngine(readGit, options, fileDecisions);
  const history = resolveHistoryScope(readGit, engine, branch, options);

  for (const commitHash of history.commitOrder) {
    engine.buildSnapshot(commitHash);
  }
  collectTimestampWarnings(engine, history, options, warnings, problems);
  const period = resolveReportingPeriod(engine, history, problems);
  const evidence = collectAcceptedEvidence(readGit, engine, history, period, warnings, problems);
  const score = calculate(evidence.identities, period.weekCount, problems);
  const timing = summariseActivityTiming(evidence.acceptedChanges);
  if (timing.integrationFallbackActivity) {
    warnings.add(
      `Integration-date fallback: ${formatActivityTiming(timing)}. ` +
      'Original development dates are unknown for this activity; first integration dates ' +
      'were used for weekly credit. Sustained scores are partly estimated.',
    );
  }
  const selectedCommitEvidence = history.selectedCommits.map(engine.readCommit);

  return {
    version: VERSION,
    calculatorSha256: CALCULATOR_HASH,
    scope: {
      branch,
      start: history.startHash,
      end: history.endHash,
      periodStart: period.weekCount ? formatTimestamp(period.periodStart) : null,
      periodEnd: period.weekCount ? formatTimestamp(period.periodEnd) : null,
      timezone: 'UTC',
      options: {
        start: options.start || null,
        end: options.end || null,
        startdate: options.startdate || null,
        enddate: options.enddate || null,
        exclude: options.exclude,
        include: options.include,
      },
    },
    ...score,
    timing,
    warnings: [...warnings].sort(compareValues),
    identities: evidence.identities,
    evidence: {
      accepted: evidence.acceptedChanges,
      retained: evidence.retainedLines,
      files: [...fileDecisions.values()].sort(compareSerializedValues),
      unresolved: evidence.unresolvedChanges,
      directCommits: evidence.directCommits,
      commits: selectedCommitEvidence,
    },
  };
}

// CSV and terminal formatting preserve the report's existing public field names.

function formatCsvCell(value) {
  let text;
  if (value === null || value === undefined) {
    text = '';
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }

  // Escape formula-like cells even when whitespace precedes the formula character.
  const startsWithFormula = /^[\s\x00-\x1f]*[=+@-]/.test(text);
  const startsWithControlCharacter = /^[\t\r\n]/.test(text);
  if (startsWithFormula || startsWithControlCharacter) {
    text = "'" + text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function formatCsvRow(cells) {
  return cells.map(formatCsvCell).join(',');
}

function csvReportMetadata(report) {
  return [
    report.status,
    report.reasons,
    report.warnings,
    report.version,
    report.calculatorSha256,
    report.scope.branch.name,
    report.scope.branch.ref,
    report.scope.branch.method,
    report.scope.start,
    report.scope.end,
    report.scope.periodStart,
    report.scope.periodEnd,
    report.weekCount,
    report.lambda,
    report.scope.options,
    report.timing.totalActivity,
    report.timing.originalActivity,
    report.timing.integrationFallbackActivity,
    report.timing.unplacedActivity,
    report.timing.fallbackPercentage,
  ];
}

function csvIdentityValues(summary) {
  return [
    summary.id,
    summary.names.join('; '),
    summary.emails.join('; '),
    summary.bucket,
    summary.commits,
    summary.acceptedCommits.length,
    summary.rawAdded,
    summary.rawDeleted,
    summary.added,
    summary.deleted,
    summary.repeated,
    summary.activity,
    summary.retained,
    summary.sustained,
    summary.display.sustained,
    summary.display.activity,
    summary.display.retained,
    summary.display.overall,
  ];
}

export function toCSV(report) {
  const columns = [
    'Identity', 'Names', 'Emails', 'Unattributed', 'Commits', 'Accepted commits',
    'Raw added', 'Raw deleted', 'Eligible added', 'Eligible deleted',
    'Excluded repetitions', 'Activity', 'Retained', 'Sustained raw',
    'Sustained %', 'Activity %', 'Retained %', 'Overall %', 'Status', 'Reasons',
    'Warnings', 'Version', 'Calculator SHA256', 'Branch', 'Reference', 'Selection',
    'Start baseline', 'End snapshot', 'Period start UTC', 'Period end UTC',
    'Weeks', 'Lambda', 'Filters',
    'Eligible activity total', 'Original-timed activity', 'Integration-date fallback activity',
    'Unplaced activity', 'Integration-date fallback %', 'Identity fallback activity',
  ];
  const metadata = csvReportMetadata(report);
  const rows = [columns];
  for (const summary of report.identities) {
    rows.push([...csvIdentityValues(summary), ...metadata, summary.integrationFallbackActivity]);
  }

  // Empty reports still need their scope and status exported.
  if (!report.identities.length) {
    rows.push([...Array(18).fill(null), ...metadata, null]);
  }
  return rows.map(formatCsvRow).join('\r\n') + '\r\n';
}

function formatPercentage(percentage) {
  return percentage === null ? 'N/A' : `${percentage.toFixed(2)}%`;
}

function formatActivityTiming(timing) {
  return `${timing.integrationFallbackActivity} of ${timing.totalActivity} eligible activity units ` +
    `(${formatPercentage(timing.fallbackPercentage)})`;
}

function formatReportStatus(report) {
  if (report.status === 'scorable' && report.warnings.length) {
    return 'scorable with warnings';
  }
  return report.status;
}

function formatIdentityLines(summary) {
  if (summary.bucket) {
    return ['Unattributed', '(reporting bucket)'];
  }
  return [summary.names.join(' / '), `<${summary.emails.join(' / ')}>`];
}

function formatIdentityPercentages(summary) {
  return [
    formatIdentityLines(summary),
    formatPercentage(summary.display.sustained),
    formatPercentage(summary.display.activity),
    formatPercentage(summary.display.retained),
    formatPercentage(summary.display.overall),
  ];
}

function formatIdentityCodeEvidence(summary) {
  return [
    formatIdentityLines(summary),
    `${summary.added} / ${summary.rawAdded}`,
    `${summary.deleted} / ${summary.rawDeleted}`,
    summary.retained,
    `${summary.commits} / ${summary.acceptedCommits.length}`,
    summary.repeated,
  ];
}

function wrapTerminalText(value, width) {
  // Escape repository-controlled text before measuring or padding it.
  let remainingText = escapeTerminalText(value);
  const lines = [];
  while (remainingText.length > width) {
    let breakPosition = remainingText.lastIndexOf(' ', width);
    if (breakPosition <= 0) {
      breakPosition = width;
    }
    lines.push(remainingText.slice(0, breakPosition));
    remainingText = remainingText.slice(breakPosition).trimStart();
  }
  lines.push(remainingText);
  return lines;
}

function formatTerminalRow(cells, widths) {
  const paddedCells = [];
  for (let columnIndex = 0; columnIndex < cells.length; columnIndex++) {
    const cell = cells[columnIndex];
    const width = widths[columnIndex];
    paddedCells.push(columnIndex === 0 ? cell.padEnd(width) : cell.padStart(width));
  }
  return paddedCells.join(' | ');
}

function formatTerminalTable(headings, rows) {
  const widths = [];
  for (const heading of headings) {
    widths.push(heading.length);
  }

  const preparedRows = [];
  for (const row of rows) {
    const preparedCells = [];
    for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
      const cell = row[columnIndex];
      const sourceLines = Array.isArray(cell) ? cell : [cell];
      const cellLines = [];
      for (const sourceLine of sourceLines) {
        // Only identities wrap; numerical evidence remains intact.
        const width = columnIndex === 0 ? 48 : Infinity;
        cellLines.push(...wrapTerminalText(sourceLine, width));
      }
      for (const cellLine of cellLines) {
        widths[columnIndex] = Math.max(widths[columnIndex], cellLine.length);
      }
      preparedCells.push(cellLines);
    }
    preparedRows.push(preparedCells);
  }

  const separators = [];
  for (const width of widths) {
    separators.push('-'.repeat(width));
  }
  const separator = separators.join('-+-');
  const lines = [formatTerminalRow(headings, widths), separator];

  for (const row of preparedRows) {
    let rowHeight = 1;
    for (const cellLines of row) {
      rowHeight = Math.max(rowHeight, cellLines.length);
    }
    for (let lineIndex = 0; lineIndex < rowHeight; lineIndex++) {
      const cells = [];
      for (const cellLines of row) {
        cells.push(cellLines[lineIndex] || '');
      }
      lines.push(formatTerminalRow(cells, widths));
    }
    lines.push(separator);
  }
  if (!rows.length) {
    lines.push('No identities in the selected scope.');
  }
  return lines;
}

function formatTerminalDetail(label, value) {
  const lines = wrapTerminalText(value, 74);
  const formattedLines = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const prefix = lineIndex === 0 ? `${label}:` : '';
    formattedLines.push(`${prefix.padEnd(22)}${lines[lineIndex]}`);
  }
  return formattedLines;
}

function formatTerminalOptions(options) {
  const lines = [];
  for (const [optionName, optionValue] of Object.entries(options)) {
    if (optionValue === null) {
      continue;
    }
    const values = Array.isArray(optionValue) ? optionValue : [optionValue];
    for (const value of values) {
      lines.push(...formatTerminalDetail(`--${optionName}`, value));
    }
  }
  return lines;
}

function formatTerminalMessages(heading, messages) {
  if (!messages.length) {
    return [];
  }
  const lines = ['', heading];
  for (const message of messages) {
    const messageLines = wrapTerminalText(message, 94);
    for (let lineIndex = 0; lineIndex < messageLines.length; lineIndex++) {
      const prefix = lineIndex === 0 ? '- ' : '  ';
      lines.push(prefix + messageLines[lineIndex]);
    }
  }
  return lines;
}

export function terminal(report, showCode = false) {
  const lines = [
    `Contribution Calculator ${escapeTerminalText(report.version)}`,
    '',
    ...formatTerminalDetail('Status', formatReportStatus(report)),
    ...formatTerminalDetail('Timing fallback', formatActivityTiming(report.timing)),
    ...formatTerminalDetail('Branch', report.scope.branch.ref),
    ...formatTerminalDetail('Selection', report.scope.branch.method),
    ...formatTerminalDetail('End snapshot', report.scope.end),
    ...formatTerminalDetail('Baseline (excluded)', report.scope.start || 'none; initial commit included'),
    ...formatTerminalDetail('Period start (UTC)', report.scope.periodStart || 'unavailable'),
    ...formatTerminalDetail('Period end (UTC)', report.scope.periodEnd || 'unavailable'),
    ...formatTerminalDetail('Weeks', report.weekCount),
    ...formatTerminalDetail('File filters', 'Built-in exclusions'),
    ...formatTerminalOptions(report.scope.options),
    '',
    'Contribution shares',
    'Weights: Sustained 50% / Activity 35% / Retained 15%',
    '',
    ...formatTerminalTable(
      ['Identity', 'Sustained', 'Activity', 'Retained', 'Overall'],
      report.identities.map(formatIdentityPercentages),
    ),
  ];

  if (showCode) {
    lines.push(
      '',
      'Code and commit evidence',
      'Added / Deleted: eligible / raw lines. Commits: total / with accepted changes.',
      'Retained: surviving lines. Repeated: excluded activity units.',
      '',
      ...formatTerminalTable(
        ['Identity', 'Added', 'Deleted', 'Retained', 'Commits', 'Repeated'],
        report.identities.map(formatIdentityCodeEvidence),
      ),
    );
  }

  let excludedFileCount = 0;
  for (const fileDecision of report.evidence.files) {
    if (!fileDecision.eligible) {
      excludedFileCount++;
    }
  }
  lines.push(
    '',
    `Excluded file versions: ${excludedFileCount}. Use --json for the evidence ledger.`,
    ...formatTerminalMessages('Score unavailable', report.reasons),
    ...formatTerminalMessages('Warnings', report.warnings),
  );
  return lines.join('\n') + '\n';
}

function helpText() {
  return `Contribution Calculator ${VERSION}
Usage: node contribution.mjs [options]
       npm run contribution -- [options]

--code                 Show line and commit evidence
--start HASH           Excluded mainline baseline
--end HASH             Inclusive mainline snapshot
--startdate YYYY-MM-DD  Start day, UTC
--enddate YYYY-MM-DD    End day and frozen snapshot, UTC
--exclude GLOB          Exclude repository-relative paths (repeatable)
--include GLOB          Override default text exclusions (repeatable)
--no-csv                Suppress contribution-summary.csv
--json                  Write contribution-evidence.json
--help                  Show this help

One file; Node.js 20+ and Git. Offline. No installation or configuration.
`;
}

// Replacing the directory entry avoids following a submitted report symlink/hardlink.
function writeReport(outputPath, content) {
  const temporaryPath = resolve(`.contribution-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, content, { flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, resolve(outputPath));
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function main(argumentsList = process.argv.slice(2)) {
  try {
    const options = parseOptions(argumentsList);
    if (options.help) {
      process.stdout.write(helpText());
      return 0;
    }

    const report = analyse(process.cwd(), options);
    process.stdout.write(terminal(report, options.code));
    if (options.csv) {
      writeReport('contribution-summary.csv', toCSV(report));
      process.stdout.write('CSV: contribution-summary.csv\n');
    }
    if (options.json) {
      writeReport('contribution-evidence.json', JSON.stringify(report, null, 2) + '\n');
      process.stdout.write('JSON: contribution-evidence.json\n');
    }
    return report.status === 'scorable' ? 0 : 2;
  } catch (error) {
    process.stderr.write(`Contribution analysis stopped: ${escapeTerminalText(error.message)}\n`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(CALCULATOR_PATH)) {
  process.exitCode = main();
}
