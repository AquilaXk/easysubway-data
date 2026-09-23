import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAffectedTests, parseArgs } from './run-affected-tests.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

test('parseArgs parses valid flags correctly', () => {
  const options = parseArgs(['--base', 'feature-branch', '--dry-run', '--verbose']);
  assert.equal(options.base, 'feature-branch');
  assert.equal(options.dryRun, true);
  assert.equal(options.verbose, true);
});

test('findAffectedTests directly includes modified test files', () => {
  const changed = ['tools/ci/automerge-queue.test.mjs'];
  const affected = findAffectedTests(changed);
  assert.ok(affected.includes('tools/ci/automerge-queue.test.mjs'));
});

test('findAffectedTests matches direct .mjs source file to .test.mjs', () => {
  const changed = ['tools/ci/data-test-discovery.mjs'];
  const affected = findAffectedTests(changed);
  assert.ok(affected.includes('tools/ci/data-test-discovery.test.mjs'));
});

test('findAffectedTests triggers contract and schema tests when contracts/ files change', () => {
  const changed = ['contracts/datapack/compatibility-matrix.json'];
  const affected = findAffectedTests(changed);
  assert.ok(affected.some((t) => t.includes('contract') || t.includes('schema') || t.includes('compatibility')));
});

test('findAffectedTests works with custom repoRoot', () => {
  const changed = ['tools/ci/run-affected-tests.test.mjs'];
  const affected = findAffectedTests(changed, REPO_ROOT);
  assert.ok(affected.includes('tools/ci/run-affected-tests.test.mjs'));
});

test('findAffectedTests returns empty array when changedFiles is empty', () => {
  const affected = findAffectedTests([]);
  assert.deepEqual(affected, []);
});
