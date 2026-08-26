#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_PATH_PATTERN = /\.test\.[^/]+$/;
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
  while (end < lines.length && !/^\s+-\s+(?:name|run|uses):/.test(lines[end])) end += 1;
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
        const expectedHash = requiredFile.profileSha256?.[fixtureProfile] ?? requiredFile.sha256;
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
      rawDefaultProfileShards.maxWorkers === 1;
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
      fixtureStates[fixtureName] = { headSha, files };
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
  return validateOwnership(
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
  const localShardCount = Math.min(maxWorkers, selected.length);
  const shards =
    shardCount !== null
      ? [selectDurationShard(selected, shardCount, shardIndex)]
      : localShardCount === 1
        ? [
            {
              index: 1,
              estimatedDurationMs: null,
              tests: selected.map(({ path }) => path).sort(compareStrings),
            },
          ]
        : buildDurationShards(selected, localShardCount);
  const results = await Promise.all(
    shards.map(async (shard) => ({
      ...shard,
      ...(await runNodeTest(repoRoot, shard.tests)),
    })),
  );
  const failed = results.filter(({ ok }) => !ok);
  process.stdout.write(
    `${JSON.stringify({
      event: 'data-test-owned-run',
      className,
      executionProfile,
      inventoryDigest: verification.inventoryDigest,
      total: selected.length,
      shardCount,
      shardIndex,
      shards: results.map(({ index, tests, estimatedDurationMs, durationMs, ok, code, signal }) => ({
        index,
        count: tests.length,
        estimatedDurationMs,
        durationMs,
        ok,
        code,
        signal,
      })),
    })}\n`,
  );
  if (failed.length > 0) throw new Error(`${failed.length} owned-test shard(s) failed`);
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
  const maxWorkers = Number.parseInt(optionValue(args, '--max-workers', '2'), 10);
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 2) {
    throw new Error('--max-workers must be 1 or 2');
  }
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
