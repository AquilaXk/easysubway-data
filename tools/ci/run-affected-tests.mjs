#!/usr/bin/env node

/**
 * Git-diff-based Affected Test Runner for EasySubway Data repository.
 *
 * Discovers and executes only the test files affected by changes between
 * the current working tree and a target Git ref (default: origin/main).
 *
 * Usage:
 *   node tools/ci/run-affected-tests.mjs [--base <gitRef>] [--dry-run] [--verbose]
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const GIT_BIN = process.env.GIT_BIN || '/usr/bin/git';

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    base: 'origin/main',
    dryRun: false,
    verbose: false,
    testArgs: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      options.base = argv[++i];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      options.testArgs.push(arg);
    }
  }

  return options;
}

export function getChangedFiles(base = 'origin/main', repoRoot = REPO_ROOT) {
  const changed = new Set();

  // 1. Uncommitted working tree & staged changes
  try {
    const statusOutput = execFileSync(GIT_BIN, ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    for (const line of statusOutput.split('\n')) {
      if (!line.trim()) continue;
      const filePath = line.slice(3).trim();
      if (filePath) changed.add(path.posix.normalize(filePath.replaceAll('\\', '/')));
    }
  } catch {
    // If not a git repo or git fails, ignore
  }

  // 2. Committed changes compared to base ref
  try {
    const diffOutput = execFileSync(GIT_BIN, ['diff', '--name-only', `${base}...HEAD`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    for (const line of diffOutput.split('\n')) {
      if (!line.trim()) continue;
      changed.add(path.posix.normalize(line.trim().replaceAll('\\', '/')));
    }
  } catch {
    // Fall back to direct diff against base
    try {
      const diffOutput2 = execFileSync(GIT_BIN, ['diff', '--name-only', base], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      for (const line of diffOutput2.split('\n')) {
        if (!line.trim()) continue;
        changed.add(path.posix.normalize(line.trim().replaceAll('\\', '/')));
      }
    } catch {
      // Base ref may not exist locally; keep working tree changes only
    }
  }

  return [...changed].sort((a, b) => a.localeCompare(b));
}

function collectAllTests(dir, results = [], repoRoot = REPO_ROOT) {
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      collectAllTests(fullPath, results, repoRoot);
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      const relative = path.relative(repoRoot, fullPath).replaceAll('\\', '/');
      results.push(relative);
    }
  }
  return results;
}

function addDirectTest(changed, repoRoot, affected) {
  if (changed.endsWith('.test.mjs') && existsSync(path.join(repoRoot, changed))) {
    affected.add(changed);
    return true;
  }
  if (changed.endsWith('.mjs') || changed.endsWith('.js')) {
    const directTest = changed.replace(/\.mjs$/, '.test.mjs').replace(/\.js$/, '.test.mjs');
    if (existsSync(path.join(repoRoot, directTest))) {
      affected.add(directTest);
    }
  }
  return false;
}

function addContractTests(changed, allTests, affected) {
  if (!changed.startsWith('contracts/')) return;
  for (const t of allTests) {
    if (t.includes('contract') || t.includes('schema') || t.includes('compatibility')) {
      affected.add(t);
    }
  }
}

function addImportedTests(changed, allTests, repoRoot, affected) {
  const changedBasename = path.basename(changed);
  for (const testFile of allTests) {
    if (affected.has(testFile)) continue;
    try {
      const content = readFileSync(path.join(repoRoot, testFile), 'utf8');
      if (content.includes(changedBasename) || content.includes(changed)) {
        affected.add(testFile);
      }
    } catch {
      // Skip unreadable
    }
  }
}

export function findAffectedTests(changedFiles, repoRoot = REPO_ROOT) {
  const affected = new Set();
  const allTests = collectAllTests(path.join(repoRoot, 'tools'), [], repoRoot);

  for (const changed of changedFiles) {
    const isDirect = addDirectTest(changed, repoRoot, affected);
    if (isDirect) continue;
    addContractTests(changed, allTests, affected);
    addImportedTests(changed, allTests, repoRoot, affected);
  }

  return [...affected].sort((a, b) => a.localeCompare(b));
}

export async function run() {
  const options = parseArgs();
  if (options.help) {
    console.log(`Usage: node tools/ci/run-affected-tests.mjs [options]

Options:
  --base <ref>       Git reference to diff against (default: origin/main)
  --dry-run          List affected tests without executing them
  --verbose, -v      Print extra discovery details
  --help, -h         Show this help message
`);
    return 0;
  }

  const changedFiles = getChangedFiles(options.base);
  if (options.verbose) {
    console.log(`Detected ${changedFiles.length} changed file(s):`);
    for (const f of changedFiles) console.log(`  - ${f}`);
  }

  let tests = findAffectedTests(changedFiles);

  if (tests.length === 0) {
    if (changedFiles.length === 0) {
      console.log(`No local changes detected against ${options.base}. Running CI tests.`);
    } else {
      console.log(`Changes detected in ${changedFiles.length} file(s), but no direct test mappings found. Running CI suite.`);
    }
    tests = collectAllTests(path.join(REPO_ROOT, 'tools/ci'));
  }

  console.log(`Found ${tests.length} affected test file(s):`);
  for (const t of tests) console.log(`  * ${t}`);

  if (options.dryRun) {
    return 0;
  }

  console.log('\nRunning affected tests...\n');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', ...tests, ...options.testArgs], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    child.on('close', (code) => {
      resolve(code ?? 0);
    });
    child.on('error', (err) => {
      console.error('Failed to run tests:', err.message);
      resolve(1);
    });
  });
}

if (process.argv[1] === __filename) {
  process.exitCode = await run();
}
