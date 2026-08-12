#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_PATH_PATTERN = /\.test\.[^/]+$/;
const SUPPORTED_TEST_PATTERN = /\.test\.mjs$/;

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

function executableJavaScript(source) {
  let output = '';
  let state = 'code';
  let escaped = false;
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

  for (const shard of shards) shard.tests.sort();
  return shards;
}

export function validateOwnership({
  manifest,
  trackedEntries,
  sources,
  workflowSources,
  fixtureStates = {},
  requireFixtureStates = true,
  requireDurations = true,
  durationClass = null,
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
  const manifestTests = Array.isArray(manifest?.tests) ? manifest.tests : [];
  const tracked = Array.isArray(trackedEntries) ? trackedEntries : [];

  if (!owners[manifest?.executionOwner]) {
    issue(issues, 'UNKNOWN_EXECUTION_OWNER', 'manifest', String(manifest?.executionOwner));
  }
  if (workflows['required-pr']?.required !== true) {
    issue(
      issues,
      'REQUIRED_WORKFLOW_ADVISORY',
      workflows['required-pr']?.file ?? 'required-pr',
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

    if (!owners[entry.semanticOwner]) {
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
        if (!workflows[className]) {
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
    }
    if (requireFixtureStates) {
      const state = fixtureStates[fixtureName];
      if (!state || state.error) {
        issue(issues, 'EXTERNAL_FIXTURE_MISSING', fixtureName, fixture.path);
        continue;
      }
      if (state.headSha !== fixture.commit) {
        issue(issues, 'FIXTURE_HEAD_MISMATCH', fixtureName, String(state.headSha));
      }
      for (const requiredFile of fixture.requiredFiles ?? []) {
        const actualHash = state.files?.[requiredFile.path];
        if (actualHash !== requiredFile.sha256) {
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
    if (countOccurrences(source, workflow.invocation) !== 1) {
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
    if (/continue-on-error:\s*true/.test(workflowStepContaining(source, workflow.invocation))) {
      issue(issues, 'WORKFLOW_WARNING_ONLY', workflow.file, 'owned-test invocation cannot continue on error');
    }
    for (const fixtureName of workflow.fixtures ?? []) {
      const fixture = fixtures[fixtureName];
      if (!fixture) {
        issue(issues, 'UNKNOWN_WORKFLOW_FIXTURE', workflow.file, fixtureName);
        continue;
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
        `ref: ${fixture.commit}`,
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
    .map(({ path, semanticOwner, classes, durationMs }) => ({
      path,
      semanticOwner,
      classes: [...classes].sort(),
      durationMs: durationMs ?? null,
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

function repositoryInputs(repoRoot, manifestPath, requireDurations, durationClass, requireFixtureStates) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rawIndex = execFileSync('git', ['ls-files', '--stage', '-z'], {
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
  for (const [fixtureName, fixture] of requireFixtureStates ? Object.entries(manifest.fixtures ?? {}) : []) {
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
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
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
    requireDurations,
    durationClass,
  };
}

export function verifyRepository({
  repoRoot,
  manifestPath,
  requireFixtureStates = true,
  requireDurations = true,
  durationClass = null,
}) {
  return validateOwnership(
    repositoryInputs(repoRoot, manifestPath, requireDurations, durationClass, requireFixtureStates),
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
}) {
  const verification = verifyRepository({ repoRoot, manifestPath, requireDurations: false });
  const selected = verification.tests.filter(({ classes }) => classes.includes(className));
  if (selected.length === 0) throw new Error(`execution class has no tests: ${className}`);
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
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

async function runOwnedClass({ repoRoot, manifestPath, className, maxWorkers }) {
  const verification = verifyRepository({
    repoRoot,
    manifestPath,
    requireDurations: maxWorkers > 1,
    durationClass: className,
  });
  const selected = verification.tests.filter(({ classes }) => classes.includes(className));
  if (selected.length === 0) throw new Error(`execution class has no tests: ${className}`);
  const shardCount = Math.min(maxWorkers, selected.length);
  const shards =
    shardCount === 1
      ? [
          {
            index: 1,
            estimatedDurationMs: null,
            tests: selected.map(({ path }) => path).sort(),
          },
        ]
      : buildDurationShards(selected, shardCount);
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
      inventoryDigest: verification.inventoryDigest,
      total: selected.length,
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

function optionValue(args, option, fallback) {
  const index = args.indexOf(option);
  if (index === -1) return fallback;
  if (index + 1 >= args.length) throw new Error(`missing value for ${option}`);
  return args[index + 1];
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
    });
    return;
  }
  if (command === 'run') {
    await runOwnedClass({ repoRoot, manifestPath, className, maxWorkers });
    return;
  }
  throw new Error('usage: data-test-discovery.mjs <verify|measure|run> [options]');
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
