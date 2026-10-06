#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_PATH_PATTERN = /\.test\.[^/]+$/;
// GitHub hosted runner는 4 vCPU다. 한 job 안에서 그보다 많은 test 프로세스를 돌리지 않는다.
export const MAX_WORKERS_LIMIT = 4;
// 한 파일이 이 시간보다 길면(기록된 durationMs 기준) top-level test 이름으로 나눠 병렬 실행한다.
export const PARTITION_TARGET_MS = 120_000;
// 직렬 그룹: 실제 저장소의 추적 파일을 다시 쓰는 테스트다. 같은 job의 다른 테스트가 그 파일을
// 읽는 도중 잘린 내용을 보지 않도록 병렬 pool 앞에서 혼자 실행한다(삭제·skip하지 않는다).
//  - prepare-nationwide-candidate-run: tools/datapack/release/의 nationwide-candidate-preparation.json,
//    전국 팩·route/station-line 입력·격리 증거 등 6개 파일을 writeFiles: true로 다시 쓴다.
export const EXCLUSIVE_TESTS = ['tools/datapack/prepare-nationwide-candidate-run.test.mjs'];
const TOP_LEVEL_REPORTER = fileURLToPath(new URL('./data-test-top-level-reporter.mjs', import.meta.url));
const SUPPORTED_TEST_PATTERN = /\.test\.mjs$/;
const GIT_EXECUTABLE = '/usr/bin/git';
const REGEX_PREFIX_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'else',
  'in',
  'instanceof',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

class OwnershipValidationError extends Error {
  constructor(issues) {
    super(`data test ownership validation failed with ${issues.length} issue(s)`);
    this.name = 'OwnershipValidationError';
    this.issues = issues;
  }
}

function issue(issues, code, path, detail) {
  issues.push({ code, path, detail });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isPathInsideRoot(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function isSafeRepositoryPath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..') &&
    !path.split('/').includes('.')
  );
}

function countOccurrences(source, needle) {
  if (!needle) return 0;
  return source.split(needle).length - 1;
}

function workflowStepContaining(source, invocation) {
  const lines = source.split('\n');
  const invocationLine = lines.findIndex((line) => line.includes(invocation));
  if (invocationLine === -1) return '';

  let start = invocationLine;
  while (start > 0 && !/^\s+-\s+(?:name|run|uses):/.test(lines[start])) start -= 1;
  let end = invocationLine + 1;
  while (
    end < lines.length
    && !/^\s+-\s+(?:name|run|uses):/.test(lines[end])
    && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end])
  ) end += 1;
  return lines.slice(start, end).join('\n');
}

function startsRegexLiteral(output) {
  const prefix = output.trimEnd();
  if (prefix.length === 0) return true;
  if ('([{:;,=!?&|+-*%^~<>/'.includes(prefix.at(-1))) return true;
  const previousWord = /([A-Za-z_$][A-Za-z0-9_$]*)$/u.exec(prefix)?.[1];
  return REGEX_PREFIX_KEYWORDS.has(previousWord);
}

function executableJavaScript(source) {
  let output = '';
  let state = 'code';
  let escaped = false;
  let regexCharacterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (character === '/' && next === '/') {
        state = 'line-comment';
        output += '  ';
        index += 1;
      } else if (character === '/' && next === '*') {
        state = 'block-comment';
        output += '  ';
        index += 1;
      } else if (character === '/' && startsRegexLiteral(output)) {
        state = 'regex';
        escaped = false;
        regexCharacterClass = false;
        output += ' ';
      } else if (character === "'") {
        state = 'single-quote';
        escaped = false;
        output += ' ';
      } else if (character === '"') {
        state = 'double-quote';
        escaped = false;
        output += ' ';
      } else if (character === '`') {
        state = 'template';
        escaped = false;
        output += ' ';
      } else {
        output += character;
      }
      continue;
    }

    if (state === 'regex') {
      output += character === '\n' ? '\n' : ' ';
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '[') {
        regexCharacterClass = true;
      } else if (character === ']') {
        regexCharacterClass = false;
      } else if (character === '/' && !regexCharacterClass) {
        state = 'code';
      } else if (character === '\n') {
        state = 'code';
      }
      continue;
    }

    if (state === 'line-comment') {
      if (character === '\n') {
        state = 'code';
        output += '\n';
      } else {
        output += ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        state = 'code';
        output += '  ';
        index += 1;
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }

    output += character === '\n' ? '\n' : ' ';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (
      (state === 'single-quote' && character === "'") ||
      (state === 'double-quote' && character === '"') ||
      (state === 'template' && character === '`')
    ) {
      state = 'code';
    }
  }
  return output;
}

function hasForbiddenSelection(source) {
  const executable = executableJavaScript(source);
  return (
    /\b(?:test|it|describe)\s*\.\s*(?:skip|only)\s*\(/.test(executable) ||
    /\b(?:skip|only)\s*:\s*true\b/.test(executable)
  );
}

export function parseGitIndex(raw) {
  if (typeof raw !== 'string') throw new TypeError('Git index output must be a string');
  const entries = [];
  for (const record of raw.split('\0')) {
    if (record === '') continue;
    const match = /^(\d{6}) [a-f0-9]{40,64} \d\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`malformed Git index record: ${record}`);
    entries.push({ mode: match[1], path: match[2] });
  }
  return entries;
}

export function buildDurationShards(entries, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('shard count must be a positive integer');
  }
  if (entries.length < shardCount) throw new Error('empty shard would be created');

  const ordered = [...entries].sort(
    (left, right) => right.durationMs - left.durationMs || left.path.localeCompare(right.path),
  );
  const shards = Array.from({ length: shardCount }, (_, index) => ({
    index: index + 1,
    estimatedDurationMs: 0,
    tests: [],
  }));

  for (const entry of ordered) {
    if (!Number.isFinite(entry.durationMs) || entry.durationMs <= 0) {
      throw new Error(`invalid duration for ${entry.path}`);
    }
    const target = [...shards].sort(
      (left, right) =>
        left.estimatedDurationMs - right.estimatedDurationMs || left.index - right.index,
    )[0];
    target.tests.push(entry.path);
    target.estimatedDurationMs += entry.durationMs;
  }

  for (const shard of shards) shard.tests.sort(compareStrings);
  return shards;
}

export function selectDurationShard(entries, shardCount, shardIndex) {
  const shards = buildDurationShards(entries, shardCount);
  if (!Number.isInteger(shardIndex) || shardIndex < 1 || shardIndex > shardCount) {
    throw new Error(`shard index must be between 1 and ${shardCount}`);
  }
  return shards[shardIndex - 1];
}


export function parseMaxWorkers(value) {
  const parsed = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_WORKERS_LIMIT) {
    throw new Error(`--max-workers must be an integer from 1 to ${MAX_WORKERS_LIMIT}`);
  }
  return parsed;
}

function decodeStringLiteral(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === quote) return { value, end: index + 1 };
    if (character === '\n') return null;
    if (character !== '\\') {
      value += character;
      continue;
    }
    const next = source[index + 1];
    const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '0': '\0' };
    if (Object.hasOwn(simple, next)) {
      value += simple[next];
      index += 1;
    } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
      value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
      index += 5;
    } else {
      return null;
    }
  }
  return null;
}

// 한 파일의 top-level test 이름을 정적으로 읽는다. 이름 목록이 파일의 top-level test 전체라고
// 확신할 수 있는 모양일 때만 이름을 돌려준다(default import `test`, 0열 `test("literal", ...)`
// 호출뿐, top-level suite·hook·test 멤버 호출 없음). 그 밖에는 null이고 파일 전체를 한 번에
// 실행한다. 정적 판정이 놓친 test는 실행 시 remainder 검사가 드러낸다.
export function extractTopLevelTestNames(source) {
  const refuse = (reason) => ({ names: null, reason });
  const imports = source.match(/^import[^;]*from\s+["']node:test["'];?\s*$/gm) ?? [];
  if (imports.length !== 1 || !/^import test from ["']node:test["'];?\s*$/.test(imports[0])) {
    return refuse('node:test must be a single default import named test');
  }
  const executable = executableJavaScript(source);
  if (/^(?:describe|suite|it|before|after|beforeEach|afterEach)\s*\(/m.test(executable)) {
    return refuse('top-level hook or suite is not partitionable');
  }
  if (/(?:^|[^.\w$])test\s*\.\s*[A-Za-z_$]/.test(executable)) {
    return refuse('test member calls are not partitionable');
  }
  const names = [];
  for (const match of executable.matchAll(/(^|[^.\w$])test\s*\(/gm)) {
    const callStart = match.index + match[1].length;
    const lineStart = executable.lastIndexOf('\n', callStart - 1) + 1;
    if (callStart !== lineStart) return refuse('every test call must start at column 0');
    let cursor = callStart + match[0].length - match[1].length;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    const literal = decodeStringLiteral(source, cursor);
    if (literal === null) return refuse('top-level test name must be a plain string literal');
    let after = literal.end;
    while (/\s/.test(source[after] ?? '')) after += 1;
    if (source[after] !== ',' && source[after] !== ')') {
      return refuse('top-level test name must be a plain string literal');
    }
    names.push(literal.value);
  }
  if (names.length === 0) return refuse('no top-level tests');
  return { names, reason: null };
}

// 실행 그룹: 파일 하나가 하나의 그룹이다. 긴 파일은 정적으로 읽은 top-level test 이름을
// 라운드로빈으로 나눈 partition 여러 개로 실행한다. CI shard 배정은 그룹(파일) 단위라서 한
// 파일의 partition은 항상 같은 job 안에 모이고, 그 job이 이름 집합을 대조한다.
export function buildExecutionGroups(
  entries,
  { maxWorkers, sources, partitionTargetMs = PARTITION_TARGET_MS, exclusivePaths = EXCLUSIVE_TESTS },
) {
  return entries.map(({ path, durationMs }) => {
    const group = { path, durationMs, partitions: null };
    const wanted = Math.min(maxWorkers, Math.ceil(durationMs / partitionTargetMs));
    if (maxWorkers < 2 || wanted < 2 || exclusivePaths.includes(path)) return group;
    if (typeof sources?.[path] !== 'string') throw new Error(`missing test source: ${path}`);
    const { names } = extractTopLevelTestNames(sources[path]);
    if (names === null || names.length < 2) return group;
    const count = Math.min(wanted, names.length);
    const partitions = Array.from({ length: count }, (_, index) => ({ index: index + 1, names: [] }));
    names.forEach((name, index) => partitions[index % count].names.push(name));
    return { ...group, partitions };
  });
}

export function planWorkerUnits(groups) {
  const units = [];
  for (const group of groups) {
    if (group.partitions === null) {
      units.push({ path: group.path, partition: null, estimatedDurationMs: group.durationMs });
      continue;
    }
    for (const partition of group.partitions) {
      units.push({
        path: group.path,
        partition,
        estimatedDurationMs: Math.max(1, Math.round(group.durationMs / group.partitions.length)),
      });
    }
  }
  return units.sort(
    (left, right) =>
      right.estimatedDurationMs - left.estimatedDurationMs ||
      compareStrings(left.path, right.path) ||
      (left.partition?.index ?? 0) - (right.partition?.index ?? 0),
  );
}

function nameMultiset(names) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

export function verifyPartitionCoverage(group, executedPerPartition, remainderNames) {
  if (remainderNames.length > 0) {
    throw new Error(
      `${group.path}: top-level tests ran outside the static partition names: ${remainderNames.join(', ')}`,
    );
  }
  const expected = nameMultiset(group.partitions.flatMap(({ names }) => names));
  const actual = nameMultiset(executedPerPartition.flat());
  const same =
    expected.size === actual.size &&
    [...expected].every(([name, count]) => actual.get(name) === count);
  if (!same) throw new Error(`${group.path}: partition coverage mismatch`);
}

// required class의 모든 테스트가 profile 실행 또는 기본 shard 실행 중 정확히 한 곳에서 돈다.
export function validateExecutionCoverage({ tests, className, profiles, defaultShardCount }) {
  const plan = [];
  const selected = tests.filter(({ classes }) => classes?.includes(className));
  for (const entry of selected) {
    const profile = entry.executionProfile ?? null;
    const runs =
      profile === null
        ? Number.isInteger(defaultShardCount) && defaultShardCount >= 1 ? 1 : 0
        : profiles.filter((name) => name === profile).length;
    if (runs === 0) throw new Error(`required test is not executed: ${entry.path}`);
    if (runs > 1) throw new Error(`required test is executed more than once: ${entry.path}`);
    plan.push({ path: entry.path, executionProfile: profile, runs });
  }
  const defaults = selected.filter(({ executionProfile }) => (executionProfile ?? null) === null);
  if (defaults.length > 0) {
    const shards = buildDurationShards(
      defaults.map(({ path, durationMs }) => ({ path, durationMs: durationMs ?? 1 })),
      defaultShardCount,
    );
    const counts = nameMultiset(shards.flatMap(({ tests: paths }) => paths));
    for (const { path } of defaults) {
      if (counts.get(path) !== 1) throw new Error(`default shard coverage mismatch: ${path}`);
    }
    if (counts.size !== defaults.length) throw new Error('default shards contain unknown tests');
  }
  return plan;
}

export function validateOwnership({
  manifest,
  trackedEntries,
  sources,
  workflowSources,
  fixtureStates = {},
  requireFixtureStates = true,
  requiredFixtureNames = null,
  requireDurations = true,
  durationClass = null,
  executionProfile = null,
  fixtureProfiles = {},
}) {
  const issues = [];
  if (!manifest || manifest.version !== 1) {
    issue(issues, 'UNSUPPORTED_MANIFEST_VERSION', 'manifest', 'version must be 1');
  }

  const roots = Array.isArray(manifest?.roots) ? manifest.roots : [];
  const owners = manifest?.owners && typeof manifest.owners === 'object' ? manifest.owners : {};
  const workflows =
    manifest?.workflows && typeof manifest.workflows === 'object' ? manifest.workflows : {};
  const fixtures =
    manifest?.fixtures && typeof manifest.fixtures === 'object' ? manifest.fixtures : {};
  const executionProfiles =
    manifest?.executionProfiles && typeof manifest.executionProfiles === 'object'
      ? manifest.executionProfiles
      : {};
  const manifestTests = Array.isArray(manifest?.tests) ? manifest.tests : [];
  const tracked = Array.isArray(trackedEntries) ? trackedEntries : [];
  const requiredFixtureSet =
    requiredFixtureNames === null ? null : new Set(requiredFixtureNames);

  if (!Object.hasOwn(owners, String(manifest?.executionOwner))) {
    issue(issues, 'UNKNOWN_EXECUTION_OWNER', 'manifest', String(manifest?.executionOwner));
  }
  const requiredWorkflow = Object.hasOwn(workflows, 'required-pr')
    ? workflows['required-pr']
    : null;
  if (requiredWorkflow?.required !== true) {
    issue(
      issues,
      'REQUIRED_WORKFLOW_ADVISORY',
      requiredWorkflow?.file ?? 'required-pr',
      'required-pr workflow must be required',
    );
  }

  const trackedTests = tracked.filter(({ path }) => TEST_PATH_PATTERN.test(path));
  const trackedByPath = new Map();
  for (const entry of trackedTests) {
    if (!isSafeRepositoryPath(entry.path)) {
      issue(issues, 'UNSAFE_TEST_PATH', entry.path, 'tracked test path is not normalized');
      continue;
    }
    if (!roots.some((root) => isPathInsideRoot(entry.path, root))) {
      issue(issues, 'TEST_OUTSIDE_ROOTS', entry.path, 'tracked test is outside approved roots');
    }
    if (!SUPPORTED_TEST_PATTERN.test(entry.path)) {
      issue(issues, 'UNSUPPORTED_TEST_EXTENSION', entry.path, 'only .test.mjs is supported');
    }
    if (entry.mode !== '100644') {
      issue(issues, 'NON_REGULAR_TEST', entry.path, `Git mode ${entry.mode}`);
    }
    if (trackedByPath.has(entry.path)) {
      issue(issues, 'DUPLICATE_TRACKED_PATH', entry.path, 'duplicate Git index path');
    }
    trackedByPath.set(entry.path, entry);
  }

  const manifestByPath = new Map();
  for (const entry of manifestTests) {
    const path = entry?.path;
    if (!isSafeRepositoryPath(path) || !SUPPORTED_TEST_PATTERN.test(path)) {
      issue(issues, 'UNSAFE_TEST_PATH', String(path), 'manifest test path is unsafe or unsupported');
      continue;
    }
    if (!roots.some((root) => isPathInsideRoot(path, root))) {
      issue(issues, 'TEST_OUTSIDE_ROOTS', path, 'manifest test is outside approved roots');
    }
    if (manifestByPath.has(path)) {
      issue(issues, 'DUPLICATE_TEST_PATH', path, 'duplicate manifest path');
    }
    manifestByPath.set(path, entry);

    if (!Object.hasOwn(owners, String(entry.semanticOwner))) {
      issue(issues, 'UNKNOWN_OWNER', path, String(entry.semanticOwner));
    }
    if (!Array.isArray(entry.classes) || entry.classes.length === 0) {
      issue(issues, 'MISSING_EXECUTION_CLASS', path, 'classes must be non-empty');
    } else {
      const uniqueClasses = new Set(entry.classes);
      if (uniqueClasses.size !== entry.classes.length) {
        issue(issues, 'DUPLICATE_EXECUTION_CLASS', path, 'duplicate execution class');
      }
      for (const className of uniqueClasses) {
        if (!Object.hasOwn(workflows, String(className))) {
          issue(issues, 'UNKNOWN_EXECUTION_CLASS', path, String(className));
        }
      }
    }
    if (
      requireDurations &&
      (durationClass === null || entry.classes?.includes(durationClass)) &&
      (!Number.isInteger(entry.durationMs) || entry.durationMs <= 0)
    ) {
      issue(issues, 'INVALID_DURATION', path, String(entry.durationMs));
    }
    if (
      entry.executionProfile !== undefined &&
      (typeof entry.executionProfile !== 'string' ||
        !Object.hasOwn(executionProfiles, entry.executionProfile))
    ) {
      issue(issues, 'UNKNOWN_EXECUTION_PROFILE', path, String(entry.executionProfile));
    }
    const source = sources?.[path];
    if (typeof source !== 'string') {
      issue(issues, 'TEST_SOURCE_MISSING', path, 'test source could not be read');
    } else if (hasForbiddenSelection(source)) {
      issue(issues, 'FORBIDDEN_TEST_SELECTION', path, 'skip/only marker is forbidden');
    }
  }

  for (const path of trackedByPath.keys()) {
    if (!manifestByPath.has(path)) {
      issue(issues, 'UNOWNED_TRACKED_TEST', path, 'tracked test has no manifest entry');
    }
  }
  for (const path of manifestByPath.keys()) {
    if (!trackedByPath.has(path)) {
      issue(issues, 'STALE_MANIFEST_TEST', path, 'manifest entry is not tracked');
    }
  }

  for (const [fixtureName, fixture] of Object.entries(fixtures)) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fixture.repository ?? '')) {
      issue(issues, 'INVALID_FIXTURE_REPOSITORY', fixtureName, String(fixture.repository));
    }
    if (!/^[a-f0-9]{40}$/.test(fixture.commit ?? '')) {
      issue(issues, 'INVALID_FIXTURE_COMMIT', fixtureName, String(fixture.commit));
    }
    const profileCommit = fixture.profileCommit;
    if (
      profileCommit !== undefined &&
      (!profileCommit || typeof profileCommit !== 'object' || Array.isArray(profileCommit))
    ) {
      issue(issues, 'INVALID_FIXTURE_PROFILE_COMMITS', fixtureName, String(profileCommit));
    }
    for (const [profileName, commit] of Object.entries(
      profileCommit && typeof profileCommit === 'object' && !Array.isArray(profileCommit)
        ? profileCommit
        : {},
    )) {
      if (!Object.hasOwn(executionProfiles, profileName) || !/^[a-f0-9]{40}$/.test(commit)) {
        issue(issues, 'INVALID_FIXTURE_PROFILE_COMMIT', fixtureName, `${profileName}:${commit}`);
      }
    }
    if (!isSafeRepositoryPath(fixture.path)) {
      issue(issues, 'INVALID_FIXTURE_PATH', fixtureName, String(fixture.path));
    }
    if (!isSafeRepositoryPath(fixture.checkoutPath)) {
      issue(issues, 'INVALID_FIXTURE_CHECKOUT_PATH', fixtureName, String(fixture.checkoutPath));
    }
    if (!isSafeRepositoryPath(fixture.sourcePath)) {
      issue(issues, 'INVALID_FIXTURE_SOURCE_PATH', fixtureName, String(fixture.sourcePath));
    }
    if (!Array.isArray(fixture.requiredFiles) || fixture.requiredFiles.length === 0) {
      issue(issues, 'FIXTURE_REQUIRED_FILES_MISSING', fixtureName, 'requiredFiles must be non-empty');
    }
    for (const requiredFile of fixture.requiredFiles ?? []) {
      if (!isSafeRepositoryPath(requiredFile.path) || !/^[a-f0-9]{64}$/.test(requiredFile.sha256 ?? '')) {
        issue(issues, 'INVALID_FIXTURE_FILE', fixtureName, String(requiredFile.path));
      }
      // #979: ITX 승격마다 바뀌는 파생 팩 해시는 코드·workflow에 박지 않고 커밋된 증거 JSON의 값을 가리킨다.
      const derived = requiredFile.derivedProfileSha256;
      if (derived !== undefined && (!derived || typeof derived !== 'object' || Array.isArray(derived))) {
        issue(issues, 'INVALID_FIXTURE_DERIVED_HASH', fixtureName, String(requiredFile.path));
      }
      for (const [profileName, source] of Object.entries(
        derived && typeof derived === 'object' && !Array.isArray(derived) ? derived : {},
      )) {
        if (
          !Object.hasOwn(executionProfiles, profileName) ||
          !isSafeRepositoryPath(source?.jsonPath) ||
          !Array.isArray(source?.pointer) ||
          source.pointer.length === 0 ||
          source.pointer.some((segment) => typeof segment !== 'string' || segment === '')
        ) {
          issue(issues, 'INVALID_FIXTURE_DERIVED_HASH', fixtureName, `${requiredFile.path}:${profileName}`);
        }
      }
      const profileSha256 = requiredFile.profileSha256;
      if (
        profileSha256 !== undefined &&
        (!profileSha256 || typeof profileSha256 !== 'object' || Array.isArray(profileSha256))
      ) {
        issue(issues, 'INVALID_FIXTURE_PROFILE_HASHES', fixtureName, String(requiredFile.path));
      }
      for (const [profileName, profileHash] of Object.entries(
        profileSha256 && typeof profileSha256 === 'object' && !Array.isArray(profileSha256)
          ? profileSha256
          : {},
      )) {
        if (
          !Object.hasOwn(executionProfiles, profileName) ||
          !/^[a-f0-9]{64}$/.test(profileHash)
        ) {
          issue(issues, 'INVALID_FIXTURE_PROFILE_HASH', fixtureName, `${requiredFile.path}:${profileName}`);
        }
      }
    }
    if (
      requireFixtureStates &&
      (requiredFixtureSet === null || requiredFixtureSet.has(fixtureName))
    ) {
      const state = Object.hasOwn(fixtureStates, fixtureName) ? fixtureStates[fixtureName] : null;
      if (state === null || state.error) {
        issue(issues, 'EXTERNAL_FIXTURE_MISSING', fixtureName, fixture.path);
        continue;
      }
      const fixtureProfile = fixtureProfiles?.[fixtureName] ?? executionProfile;
      const expectedCommit = fixture.profileCommit?.[fixtureProfile] ?? fixture.commit;
      if (state.headSha !== expectedCommit) {
        issue(issues, 'FIXTURE_HEAD_MISMATCH', fixtureName, String(state.headSha));
      }
      for (const requiredFile of fixture.requiredFiles ?? []) {
        const actualHash = state.files?.[requiredFile.path];
        const expectedHash = requiredFile.derivedProfileSha256?.[fixtureProfile] === undefined
          ? requiredFile.profileSha256?.[fixtureProfile] ?? requiredFile.sha256
          : state.derived?.[requiredFile.path]?.[fixtureProfile];
        if (actualHash !== expectedHash) {
          issue(
            issues,
            'FIXTURE_HASH_MISMATCH',
            `${fixtureName}:${requiredFile.path}`,
            String(actualHash),
          );
        }
      }
    }
  }

  for (const [className, workflow] of Object.entries(workflows)) {
    const source = workflowSources?.[workflow.file];
    if (typeof source !== 'string') {
      issue(issues, 'WORKFLOW_SOURCE_MISSING', workflow.file, className);
      continue;
    }
    const jobPattern = new RegExp(`^  ${workflow.jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`, 'm');
    if (!jobPattern.test(source) || !source.includes(`name: ${workflow.checkName}`)) {
      issue(issues, 'WORKFLOW_JOB_MISSING', workflow.file, `${workflow.jobId}/${workflow.checkName}`);
    }
    const rawDefaultProfileShards = workflow.defaultProfileShards;
    const hasDefaultProfileShards = rawDefaultProfileShards !== undefined;
    const defaultProfileShardsValid =
      hasDefaultProfileShards &&
      rawDefaultProfileShards !== null &&
      typeof rawDefaultProfileShards === 'object' &&
      !Array.isArray(rawDefaultProfileShards) &&
      Number.isInteger(rawDefaultProfileShards.count) &&
      rawDefaultProfileShards.count >= 2 &&
      Number.isInteger(rawDefaultProfileShards.maxWorkers) &&
      rawDefaultProfileShards.maxWorkers >= 1 &&
      rawDefaultProfileShards.maxWorkers <= MAX_WORKERS_LIMIT;
    if (hasDefaultProfileShards && !defaultProfileShardsValid) {
      issue(issues, 'INVALID_DEFAULT_PROFILE_SHARDS', workflow.file, className);
    }
    if (defaultProfileShardsValid) {
      if (countOccurrences(source, workflow.invocation) !== rawDefaultProfileShards.count) {
        issue(
          issues,
          'DEFAULT_PROFILE_SHARD_TOTAL_INVOCATION_MISMATCH',
          workflow.file,
          workflow.invocation,
        );
      }
      for (let shardIndex = 1; shardIndex <= rawDefaultProfileShards.count; shardIndex += 1) {
        const invocation = `${workflow.invocation} --max-workers ${rawDefaultProfileShards.maxWorkers} --shard-count ${rawDefaultProfileShards.count} --shard-index ${shardIndex}`;
        if (countOccurrences(source, invocation) !== 1) {
          issue(issues, 'DEFAULT_PROFILE_SHARD_INVOCATION_MISMATCH', workflow.file, invocation);
        }
        const invocationStep = workflowStepContaining(source, invocation);
        if (/continue-on-error:\s*true/.test(invocationStep)) {
          issue(issues, 'WORKFLOW_WARNING_ONLY', workflow.file, invocation);
        }
        if (/^\s*if\s*:/m.test(invocationStep)) {
          issue(issues, 'WORKFLOW_CONDITIONAL_SKIP', workflow.file, invocation);
        }
      }
    } else if (!hasDefaultProfileShards && countOccurrences(source, workflow.invocation) !== 1) {
      issue(issues, 'WORKFLOW_INVOCATION_MISSING', workflow.file, workflow.invocation);
    }
    const rawContextInvocations = workflow.contextInvocations;
    const contextInvocations = Array.isArray(rawContextInvocations) ? rawContextInvocations : [];
    if (rawContextInvocations !== undefined && !Array.isArray(rawContextInvocations)) {
      issue(issues, 'INVALID_CONTEXT_INVOCATIONS', workflow.file, 'contextInvocations must be an array');
    }
    const uniqueContextInvocations = new Set(contextInvocations);
    if (uniqueContextInvocations.size !== contextInvocations.length) {
      issue(issues, 'DUPLICATE_CONTEXT_INVOCATION', workflow.file, className);
    }
    let sourceWithoutContextInvocations = source;
    for (const invocation of uniqueContextInvocations) {
      if (
        typeof invocation !== 'string' ||
        !/^node --test(?: --test-name-pattern='[^'\n]+')? [A-Za-z0-9._/-]+\.test\.mjs$/u.test(invocation)
      ) {
        issue(issues, 'INVALID_CONTEXT_INVOCATION', workflow.file, String(invocation));
        continue;
      }
      if (countOccurrences(source, invocation) !== 1) {
        issue(issues, 'CONTEXT_INVOCATION_MISMATCH', workflow.file, invocation);
      }
      const testPath = invocation.split(/\s+/u).at(-1);
      const entry = manifestByPath.get(testPath);
      if (!entry || !entry.classes?.includes(className)) {
        issue(issues, 'CONTEXT_TEST_NOT_OWNED', testPath, className);
      }
      sourceWithoutContextInvocations = sourceWithoutContextInvocations.split(invocation).join('');
    }
    if (/node\s+--test[\s\S]{0,500}?\.test\.mjs/.test(sourceWithoutContextInvocations)) {
      issue(issues, 'WORKFLOW_HAND_LIST', workflow.file, 'direct test file list is forbidden');
    }
    if (
      !defaultProfileShardsValid &&
      /continue-on-error:\s*true/.test(workflowStepContaining(source, workflow.invocation))
    ) {
      issue(issues, 'WORKFLOW_WARNING_ONLY', workflow.file, 'owned-test invocation cannot continue on error');
    }
    const rawProfileInvocations = workflow.profileInvocations;
    const profileInvocations = Array.isArray(rawProfileInvocations) ? rawProfileInvocations : [];
    if (rawProfileInvocations !== undefined && !Array.isArray(rawProfileInvocations)) {
      issue(issues, 'INVALID_PROFILE_INVOCATIONS', workflow.file, className);
    }
    const uniqueProfileInvocations = new Set(profileInvocations);
    if (uniqueProfileInvocations.size !== profileInvocations.length) {
      issue(issues, 'DUPLICATE_PROFILE_INVOCATION', workflow.file, className);
    }
    for (const invocation of uniqueProfileInvocations) {
      if (
        typeof invocation !== 'string' ||
        !invocation.startsWith(`node tools/ci/data-test-discovery.mjs run --class ${className} --profile `)
      ) {
        issue(issues, 'INVALID_PROFILE_INVOCATION', workflow.file, String(invocation));
        continue;
      }
      if (countOccurrences(source, invocation) !== 1) {
        issue(issues, 'PROFILE_INVOCATION_MISMATCH', workflow.file, invocation);
      }
      if (/continue-on-error:\s*true/.test(workflowStepContaining(source, invocation))) {
        issue(issues, 'WORKFLOW_WARNING_ONLY', workflow.file, invocation);
      }
    }
    if (defaultProfileShardsValid) {
      try {
        validateExecutionCoverage({
          tests: [...manifestByPath.values()],
          className,
          profiles: profileInvocations
            .filter((invocation) => typeof invocation === 'string')
            .map((invocation) => /--profile (\S+)/.exec(invocation)?.[1] ?? null),
          defaultShardCount: rawDefaultProfileShards.count,
        });
      } catch (error) {
        issue(issues, 'EXECUTION_COVERAGE_MISMATCH', workflow.file, error.message);
      }
    }
    for (const fixtureName of workflow.fixtures ?? []) {
      const fixture = Object.hasOwn(fixtures, fixtureName) ? fixtures[fixtureName] : null;
      if (fixture === null) {
        issue(issues, 'UNKNOWN_WORKFLOW_FIXTURE', workflow.file, fixtureName);
        continue;
      }
      const fixtureProfile = workflow.fixtureProfiles?.[fixtureName] ?? null;
      if (fixtureProfile !== null && !Object.hasOwn(executionProfiles, fixtureProfile)) {
        issue(issues, 'UNKNOWN_WORKFLOW_FIXTURE_PROFILE', workflow.file, `${fixtureName}:${fixtureProfile}`);
      }
      const stageContracts = workflow.fixtureStageContracts?.[fixtureName];
      if (!Array.isArray(stageContracts) || stageContracts.length === 0) {
        issue(issues, 'WORKFLOW_FIXTURE_STAGE_CONTRACT_MISSING', workflow.file, fixtureName);
      }
      const uniqueStageContracts = new Set(Array.isArray(stageContracts) ? stageContracts : []);
      if (Array.isArray(stageContracts) && uniqueStageContracts.size !== stageContracts.length) {
        issue(issues, 'DUPLICATE_WORKFLOW_FIXTURE_STAGE_CONTRACT', workflow.file, fixtureName);
      }
      for (const contract of uniqueStageContracts) {
        if (typeof contract !== 'string' || contract.length === 0) {
          issue(issues, 'INVALID_WORKFLOW_FIXTURE_STAGE_CONTRACT', workflow.file, String(contract));
        }
      }
      for (const contract of [
        `repository: ${fixture.repository}`,
        `ref: ${fixture.profileCommit?.[fixtureProfile] ?? fixture.commit}`,
        `path: ${fixture.checkoutPath}`,
        'persist-credentials: false',
        ...[...uniqueStageContracts].filter((entry) => typeof entry === 'string' && entry.length > 0),
      ]) {
        if (!source.includes(contract)) {
          issue(issues, 'WORKFLOW_FIXTURE_CHECKOUT_MISSING', workflow.file, contract);
        }
      }
    }
    const rawFixtureStageContracts = workflow.fixtureStageContracts;
    if (
      rawFixtureStageContracts !== undefined &&
      (!rawFixtureStageContracts ||
        typeof rawFixtureStageContracts !== 'object' ||
        Array.isArray(rawFixtureStageContracts))
    ) {
      issue(issues, 'INVALID_WORKFLOW_FIXTURE_STAGE_CONTRACTS', workflow.file, className);
    }
    for (const fixtureName of Object.keys(
      rawFixtureStageContracts && typeof rawFixtureStageContracts === 'object' && !Array.isArray(rawFixtureStageContracts)
        ? rawFixtureStageContracts
        : {},
    )) {
      if (!(workflow.fixtures ?? []).includes(fixtureName)) {
        issue(issues, 'UNKNOWN_WORKFLOW_FIXTURE_STAGE_CONTRACT', workflow.file, fixtureName);
      }
    }
    const rawFixtureProfiles = workflow.fixtureProfiles;
    if (
      rawFixtureProfiles !== undefined &&
      (!rawFixtureProfiles || typeof rawFixtureProfiles !== 'object' || Array.isArray(rawFixtureProfiles))
    ) {
      issue(issues, 'INVALID_WORKFLOW_FIXTURE_PROFILES', workflow.file, className);
    }
    for (const fixtureName of Object.keys(
      rawFixtureProfiles && typeof rawFixtureProfiles === 'object' && !Array.isArray(rawFixtureProfiles)
        ? rawFixtureProfiles
        : {},
    )) {
      if (!(workflow.fixtures ?? []).includes(fixtureName)) {
        issue(issues, 'UNKNOWN_WORKFLOW_FIXTURE_PROFILE', workflow.file, fixtureName);
      }
    }
    if (
      className === 'required-pr' &&
      !source.includes('ref: ${{ github.event.pull_request.head.sha || github.sha }}')
    ) {
      issue(
        issues,
        'PR_HEAD_CHECKOUT_MISSING',
        workflow.file,
        'required PR workflow must checkout the exact pull request head',
      );
    }
  }

  if (issues.length > 0) throw new OwnershipValidationError(issues);

  const normalized = [...manifestByPath.values()]
    .map(({ path, semanticOwner, classes, durationMs, executionProfile: profile }) => ({
      path,
      semanticOwner,
      classes: [...classes].sort(compareStrings),
      durationMs: durationMs ?? null,
      executionProfile: profile ?? null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const classCounts = {};
  for (const entry of normalized) {
    for (const className of entry.classes) {
      classCounts[className] = (classCounts[className] ?? 0) + 1;
    }
  }
  return {
    total: normalized.length,
    classCounts,
    inventoryDigest: sha256(JSON.stringify(normalized)),
    tests: normalized,
  };
}

function repositoryInputs({
  repoRoot,
  manifestPath,
  requireDurations,
  durationClass,
  requireFixtureStates,
  executionProfile,
  fixtureClass,
}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifestFixtures = manifest.fixtures ?? {};
  const selectedWorkflow =
    fixtureClass !== null && Object.hasOwn(manifest.workflows ?? {}, fixtureClass)
      ? manifest.workflows[fixtureClass]
      : null;
  const requiredFixtureNames =
    fixtureClass === null
      ? null
      : Array.isArray(selectedWorkflow?.fixtures)
        ? selectedWorkflow.fixtures
        : [];
  const fixtureProfiles = selectedWorkflow?.fixtureProfiles ?? {};
  const fixtureEntries = requireFixtureStates
    ? (requiredFixtureNames ?? Object.keys(manifestFixtures))
        .filter((fixtureName) => Object.hasOwn(manifestFixtures, fixtureName))
        .map((fixtureName) => [fixtureName, manifestFixtures[fixtureName]])
    : [];
  const rawIndex = execFileSync(GIT_EXECUTABLE, ['ls-files', '--stage', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const trackedEntries = parseGitIndex(rawIndex);
  const sourcePaths = new Set([
    ...trackedEntries.filter(({ path }) => TEST_PATH_PATTERN.test(path)).map(({ path }) => path),
    ...manifest.tests.map(({ path }) => path),
  ]);
  const sources = {};
  for (const path of sourcePaths) {
    try {
      sources[path] = readFileSync(resolve(repoRoot, path), 'utf8');
    } catch {
      sources[path] = null;
    }
  }
  const workflowSources = {};
  for (const workflow of Object.values(manifest.workflows)) {
    workflowSources[workflow.file] = readFileSync(resolve(repoRoot, workflow.file), 'utf8');
  }
  const fixtureStates = {};
  for (const [fixtureName, fixture] of fixtureEntries) {
    const checkoutRoot = resolve(repoRoot, fixture.checkoutPath);
    const fixtureRoot = resolve(repoRoot, fixture.path);
    try {
      const checkoutStat = lstatSync(checkoutRoot);
      if (!checkoutStat.isDirectory() || checkoutStat.isSymbolicLink()) {
        throw new Error('fixture checkout is not a real directory');
      }
      const stagedStat = lstatSync(fixtureRoot);
      if (!stagedStat.isDirectory() || stagedStat.isSymbolicLink()) {
        throw new Error('staged fixture is not a real directory');
      }
      const headSha = execFileSync(GIT_EXECUTABLE, ['rev-parse', 'HEAD'], {
        cwd: checkoutRoot,
        encoding: 'utf8',
      }).trim();
      const files = {};
      for (const requiredFile of fixture.requiredFiles ?? []) {
        const filePath = resolve(fixtureRoot, requiredFile.path);
        const fileStat = lstatSync(filePath);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
          throw new Error(`fixture file is not a regular file: ${requiredFile.path}`);
        }
        const realFilePath = realpathSync(filePath);
        if (!realFilePath.startsWith(`${realpathSync(fixtureRoot)}/`)) {
          throw new Error(`fixture file escapes root: ${requiredFile.path}`);
        }
        files[requiredFile.path] = sha256(readFileSync(filePath));
      }
      const derived = {};
      for (const requiredFile of fixture.requiredFiles ?? []) {
        for (const [profileName, source] of Object.entries(requiredFile.derivedProfileSha256 ?? {})) {
          let value = JSON.parse(readFileSync(resolve(repoRoot, source.jsonPath), 'utf8'));
          for (const segment of source.pointer) value = value?.[segment];
          if (!/^[a-f0-9]{64}$/.test(value ?? '')) {
            throw new Error(`derived fixture hash is not a sha256: ${source.jsonPath}`);
          }
          derived[requiredFile.path] = { ...derived[requiredFile.path], [profileName]: value };
        }
      }
      fixtureStates[fixtureName] = { headSha, files, derived };
    } catch (error) {
      fixtureStates[fixtureName] = { error: error.message, files: {} };
    }
  }
  return {
    manifest,
    trackedEntries,
    sources,
    workflowSources,
    fixtureStates,
    requireFixtureStates,
    requiredFixtureNames,
    requireDurations,
    durationClass,
    executionProfile,
    fixtureProfiles,
  };
}

export function verifyRepository({
  repoRoot,
  manifestPath,
  requireFixtureStates = true,
  requireDurations = true,
  durationClass = null,
  executionProfile = null,
  fixtureClass = null,
}) {
  const verification = validateOwnership(
    repositoryInputs({
      repoRoot,
      manifestPath,
      requireDurations,
      durationClass,
      requireFixtureStates,
      executionProfile,
      fixtureClass,
    }),
  );
  // 직렬 그룹 목록이 실제 소유 테스트를 가리키지 않으면(이름 변경·삭제) 병렬 충돌 방지가 조용히
  // 사라진다. 저장소 검증에서 닫힌 상태로 실패한다.
  const owned = new Set(verification.tests.map(({ path }) => path));
  const stale = EXCLUSIVE_TESTS.filter((path) => !owned.has(path));
  if (stale.length > 0) {
    throw new OwnershipValidationError(
      stale.map((path) => ({ code: 'EXCLUSIVE_TEST_NOT_OWNED', path, detail: 'serial group entry is not an owned test' })),
    );
  }
  return verification;
}

export function selectExecutionTests(tests, className, executionProfile, defaultProfile) {
  if (executionProfile !== null && defaultProfile) {
    throw new Error('--profile and --default-profile are mutually exclusive');
  }
  return tests.filter(
    ({ classes, executionProfile: entryProfile }) =>
      classes.includes(className) &&
      (executionProfile !== null
        ? entryProfile === executionProfile
        : !defaultProfile || entryProfile === null),
  );
}

function runNodeTest(repoRoot, paths, reporter = 'spec') {
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', `--test-reporter=${reporter}`, ...paths],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    child.once('error', (error) => {
      resolvePromise({ ok: false, durationMs: Date.now() - startedAt, error: error.message });
    });
    child.once('exit', (code, signal) => {
      resolvePromise({
        ok: code === 0 && signal === null,
        code,
        signal,
        durationMs: Math.max(1, Date.now() - startedAt),
      });
    });
  });
}

async function runPool(items, workerCount, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, consume));
  return results;
}


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function runTopLevelUnit(repoRoot, unit) {
  const startedAt = Date.now();
  const reportDir = mkdtempSync(join(tmpdir(), 'data-test-unit-'));
  const reportPath = join(reportDir, 'top-level.jsonl');
  const selection = unit.remainder
    ? unit.remainder.map((name) => `--test-skip-pattern=^${escapeRegExp(name)}$`)
    : (unit.partition?.names ?? []).map((name) => `--test-name-pattern=^${escapeRegExp(name)}$`);
  const args = [
    '--test',
    '--test-concurrency=1',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    `--test-reporter=${TOP_LEVEL_REPORTER}`,
    `--test-reporter-destination=${reportPath}`,
    ...selection,
    unit.path,
  ];
  return new Promise((resolvePromise) => {
    const chunks = [];
    // 이 도구가 node:test 안에서 호출되면 NODE_TEST_CONTEXT가 상속돼 자식 runner가 reporter 대신
    // 부모 프로토콜로 출력한다. 자식은 항상 독립 runner로 띄운다.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    const finish = (result) => {
      let executed = [];
      let reportError = null;
      try {
        executed = readFileSync(reportPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line).name);
      } catch (error) {
        reportError = error.message;
      }
      rmSync(reportDir, { recursive: true, force: true });
      resolvePromise({
        ...result,
        executed,
        reportError,
        log: Buffer.concat(chunks).toString('utf8'),
        durationMs: Math.max(1, Date.now() - startedAt),
      });
    };
    child.once('error', (error) => finish({ ok: false, code: null, signal: null, error: error.message }));
    child.once('close', (code, signal) => finish({ ok: code === 0 && signal === null, code, signal }));
  });
}

function unitLabel(unit) {
  if (unit.remainder) return `${unit.path} [remainder]`;
  if (unit.partition) return `${unit.path} [partition ${unit.partition.index}/${unit.partitionCount}]`;
  return unit.path;
}

// 그룹을 unit(파일 전체 또는 partition, partition 파일마다 remainder 1개)으로 펼쳐 최대
// maxWorkers개 프로세스로 긴 unit부터 실행한다. 각 unit의 출력은 끝난 뒤 한 덩어리로 쓴다.
// partition 파일은 실행된 top-level 이름이 정적 이름 목록과 정확히 같아야 하고 remainder는
// 아무 test도 실행하지 않아야 한다. 하나라도 어긋나거나 프로세스가 실패하면 ok=false다.
export async function runExecutionGroups({
  repoRoot,
  groups,
  maxWorkers,
  exclusivePaths = EXCLUSIVE_TESTS,
  output = process.stdout,
}) {
  const units = planWorkerUnits(groups).map((unit) => ({
    ...unit,
    partitionCount: groups.find(({ path }) => path === unit.path)?.partitions?.length ?? null,
  }));
  const remainders = groups
    .filter(({ partitions }) => partitions !== null)
    .map((group) => ({
      path: group.path,
      partition: null,
      remainder: group.partitions.flatMap(({ names }) => names),
      estimatedDurationMs: 0,
    }));
  const execute = async (unit) => {
    const result = await runTopLevelUnit(repoRoot, unit);
    output.write(`\n===== ${unitLabel(unit)} (${result.durationMs}ms, exit ${result.code}) =====\n${result.log}`);
    return { unit, ...result };
  };
  // 직렬 그룹은 다른 어떤 unit과도 겹치지 않게 pool 앞에서 하나씩 실행한다.
  const exclusive = units.filter(({ path }) => exclusivePaths.includes(path));
  const results = [];
  for (const unit of exclusive) results.push(await execute(unit));
  const queue = [...units.filter((unit) => !exclusive.includes(unit)), ...remainders];
  results.push(...(await runPool(queue, maxWorkers, execute)));
  const errors = [];
  for (const result of results) {
    if (!result.ok) errors.push(`${unitLabel(result.unit)} failed (code ${result.code}, signal ${result.signal})`);
    if (result.reportError) errors.push(`${unitLabel(result.unit)} top-level report unreadable: ${result.reportError}`);
  }
  for (const group of groups.filter(({ partitions }) => partitions !== null)) {
    const own = results.filter(({ unit }) => unit.path === group.path);
    try {
      verifyPartitionCoverage(
        group,
        own.filter(({ unit }) => unit.partition !== null).map(({ executed }) => executed),
        own.filter(({ unit }) => unit.remainder).flatMap(({ executed }) => executed),
      );
    } catch (error) {
      errors.push(error.message);
    }
  }
  const executed = results
    .filter(({ unit }) => !unit.remainder)
    .flatMap(({ unit, executed: names }) => names.map((name) => `${unit.path}\t${name}`))
    .sort(compareStrings);
  return {
    ok: errors.length === 0,
    errors,
    executed,
    units: results
      .filter(({ unit }) => !unit.remainder)
      .map(({ unit, durationMs, ok }) => ({
        path: unit.path,
        partition: unit.partition?.index ?? null,
        estimatedDurationMs: unit.estimatedDurationMs,
        durationMs,
        ok,
      })),
  };
}

async function measureClass({
  repoRoot,
  manifestPath,
  className,
  outputPath,
  maxWorkers,
  expectedHead,
  executionProfile,
  defaultProfile,
}) {
  const verification = verifyRepository({
    repoRoot,
    manifestPath,
    requireDurations: false,
    executionProfile,
    fixtureClass: className,
  });
  const selected = selectExecutionTests(
    verification.tests,
    className,
    executionProfile,
    defaultProfile,
  );
  if (selected.length === 0) throw new Error(`execution class has no tests: ${className}`);
  const headSha = execFileSync(GIT_EXECUTABLE, ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(expectedHead ?? '') || headSha !== expectedHead) {
    throw new Error(`measurement head mismatch: expected=${expectedHead} actual=${headSha}`);
  }
  const startedAt = Date.now();
  const results = await runPool(selected, maxWorkers, async ({ path }) => {
    const result = await runNodeTest(repoRoot, [path], 'dot');
    return { path, ...result };
  });
  const failed = results.filter(({ ok }) => !ok);
  const output = {
    version: 1,
    headSha,
    inventoryDigest: verification.inventoryDigest,
    className,
    executionProfile,
    maxWorkers,
    wallDurationMs: Math.max(1, Date.now() - startedAt),
    tests: results,
  };
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
  if (failed.length > 0) {
    throw new Error(`measurement failed for ${failed.length} test file(s)`);
  }
  return output;
}

async function runOwnedClass({
  repoRoot,
  manifestPath,
  className,
  maxWorkers,
  executionProfile,
  defaultProfile,
  shardCount,
  shardIndex,
}) {
  const verification = verifyRepository({
    repoRoot,
    manifestPath,
    requireDurations: maxWorkers > 1 || shardCount !== null,
    durationClass: className,
    executionProfile,
    fixtureClass: className,
  });
  const selected = selectExecutionTests(
    verification.tests,
    className,
    executionProfile,
    defaultProfile,
  );
  if (selected.length === 0) throw new Error(`execution class has no tests: ${className}`);
  // CI shard는 파일 단위로 기록된 소요 시간에 맞춰 나눈다(분할 계약은 verify가 검사한다).
  const shardPaths =
    shardCount !== null ? new Set(selectDurationShard(selected, shardCount, shardIndex).tests) : null;
  const assigned = selected.filter(({ path }) => shardPaths === null || shardPaths.has(path));
  const sources = Object.fromEntries(
    assigned.map(({ path }) => [path, readFileSync(resolve(repoRoot, path), 'utf8')]),
  );
  const groups = buildExecutionGroups(assigned, { maxWorkers, sources });
  const result = await runExecutionGroups({ repoRoot, groups, maxWorkers });
  process.stdout.write(
    `${JSON.stringify({
      event: 'data-test-owned-run',
      className,
      executionProfile,
      inventoryDigest: verification.inventoryDigest,
      total: selected.length,
      assigned: assigned.length,
      shardCount,
      shardIndex,
      maxWorkers,
      topLevelTests: result.executed.length,
      units: result.units,
      errors: result.errors,
    })}\n`,
  );
  if (!result.ok) throw new Error(`${result.errors.length} owned-test execution error(s)`);
}

export function combineDurationEvidence({ verification, evidence, expectedHead, className }) {
  if (!/^[a-f0-9]{40}$/.test(expectedHead ?? '')) {
    throw new Error('combined duration evidence requires an exact expected head');
  }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error('combined duration evidence requires at least one input');
  }
  const expected = verification.tests.filter(({ classes }) => classes.includes(className));
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const combined = [];
  const seen = new Set();
  for (const document of evidence) {
    if (
      document?.version !== 1 ||
      document.headSha !== expectedHead ||
      document.inventoryDigest !== verification.inventoryDigest ||
      document.className !== className ||
      !Array.isArray(document.tests)
    ) {
      throw new Error('duration evidence identity mismatch');
    }
    const profile = document.executionProfile ?? null;
    for (const result of document.tests) {
      const entry = expectedByPath.get(result?.path);
      if (!entry || entry.executionProfile !== profile) {
        throw new Error(`duration evidence profile mismatch: ${String(result?.path)}`);
      }
      if (seen.has(result.path)) throw new Error(`duplicate duration evidence: ${result.path}`);
      if (
        result.ok !== true ||
        result.code !== 0 ||
        result.signal !== null ||
        !Number.isInteger(result.durationMs) ||
        result.durationMs < 1
      ) {
        throw new Error(`unsuccessful duration evidence: ${result.path}`);
      }
      seen.add(result.path);
      combined.push(result);
    }
  }
  const missing = [...expectedByPath.keys()].filter((path) => !seen.has(path));
  if (missing.length > 0) throw new Error(`missing duration evidence: ${missing.join(',')}`);
  return {
    version: 1,
    headSha: expectedHead,
    inventoryDigest: verification.inventoryDigest,
    className,
    maxWorkers: Math.max(...evidence.map(({ maxWorkers }) => maxWorkers ?? 0)),
    wallDurationMs: evidence.reduce((total, { wallDurationMs }) => total + wallDurationMs, 0),
    tests: combined.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function optionValue(args, option, fallback) {
  const index = args.indexOf(option);
  if (index === -1) return fallback;
  if (index + 1 >= args.length) throw new Error(`missing value for ${option}`);
  return args[index + 1];
}

function optionValues(args, option) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== option) continue;
    if (index + 1 >= args.length) throw new Error(`missing value for ${option}`);
    values.push(args[index + 1]);
  }
  return values;
}

function parseStrictPositiveInteger(value, option) {
  if (!/^\d+$/u.test(value)) throw new Error(`${option} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

export function parseRunShardOptions(args) {
  const shardCounts = optionValues(args, '--shard-count');
  const shardIndexes = optionValues(args, '--shard-index');
  if (shardCounts.length === 0 && shardIndexes.length === 0) {
    return { shardCount: null, shardIndex: null };
  }
  if (shardCounts.length !== 1 || shardIndexes.length !== 1) {
    throw new Error('--shard-count and --shard-index must be provided together exactly once');
  }
  const shardCount = parseStrictPositiveInteger(shardCounts[0], '--shard-count');
  const shardIndex = parseStrictPositiveInteger(shardIndexes[0], '--shard-index');
  if (shardIndex > shardCount) {
    throw new Error(`shard index must be between 1 and ${shardCount}`);
  }
  return { shardCount, shardIndex };
}

async function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(scriptPath), '../..');
  const manifestPath = resolve(repoRoot, 'tools/ci/data-test-ownership.json');
  const [command, ...args] = process.argv.slice(2);
  if (command === 'verify') {
    const className = optionValue(args, '--class', 'required-pr');
    const result = verifyRepository({
      repoRoot,
      manifestPath,
      durationClass: className,
      requireFixtureStates: false,
    });
    process.stdout.write(`${JSON.stringify({ event: 'data-test-owned-verify', ...result })}\n`);
    return;
  }

  const className = optionValue(args, '--class', 'required-pr');
  const executionProfile = optionValue(args, '--profile', null);
  const defaultProfile = args.includes('--default-profile');
  if (executionProfile !== null && defaultProfile) {
    throw new Error('--profile and --default-profile are mutually exclusive');
  }
  const maxWorkers = parseMaxWorkers(optionValue(args, '--max-workers', '2'));
  if (command === 'measure') {
    const outputPath = optionValue(args, '--output');
    if (!outputPath) throw new Error('measure requires --output');
    const expectedHead = optionValue(args, '--expected-head');
    if (!expectedHead) throw new Error('measure requires --expected-head');
    await measureClass({
      repoRoot,
      manifestPath,
      className,
      outputPath,
      maxWorkers,
      expectedHead,
      executionProfile,
      defaultProfile,
    });
    return;
  }
  if (command === 'run') {
    const { shardCount, shardIndex } = parseRunShardOptions(args);
    await runOwnedClass({
      repoRoot,
      manifestPath,
      className,
      maxWorkers,
      executionProfile,
      defaultProfile,
      shardCount,
      shardIndex,
    });
    return;
  }
  if (command === 'combine') {
    const outputPath = optionValue(args, '--output');
    if (!outputPath) throw new Error('combine requires --output');
    const expectedHead = optionValue(args, '--expected-head');
    if (!expectedHead) throw new Error('combine requires --expected-head');
    const inputPaths = optionValues(args, '--input');
    const verification = verifyRepository({
      repoRoot,
      manifestPath,
      requireFixtureStates: false,
      requireDurations: false,
    });
    const evidence = inputPaths.map((inputPath) => JSON.parse(readFileSync(inputPath, 'utf8')));
    const combined = combineDurationEvidence({ verification, evidence, expectedHead, className });
    writeFileSync(outputPath, `${JSON.stringify(combined, null, 2)}\n`, { flag: 'wx' });
    return;
  }
  throw new Error('usage: data-test-discovery.mjs <verify|measure|combine|run> [options]');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    if (Array.isArray(error.issues)) {
      for (const item of error.issues) process.stderr.write(`${JSON.stringify(item)}\n`);
    } else {
      process.stderr.write(`${error.stack ?? error.message}\n`);
    }
    process.exitCode = 1;
  });
}
