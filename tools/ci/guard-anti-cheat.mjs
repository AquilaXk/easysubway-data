import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EasySubway Data Anti-Cheating & Test Integrity Guard
 * (Standardized on EasyConvert Multi-Gate Architecture)
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

export const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'coverage',
  '.cache',
  'build',
  'dist',
  '.external',
]);

const SUPPORTED_EXTENSIONS = /\.(mjs|cjs|js|ts|json)$/;

export function scanDirectory(dir, extension = SUPPORTED_EXTENSIONS, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        scanDirectory(path.join(dir, entry.name), extension, fileList);
      }
    } else if (entry.isFile() && extension.test(entry.name)) {
      fileList.push(path.join(dir, entry.name));
    }
  }
  return fileList;
}

export function getLineAndSnippet(content, index, matchLength = 0) {
  const upToMatch = content.slice(0, index);
  const line = upToMatch.split('\n').length;
  const lineStart = content.lastIndexOf('\n', index) + 1;
  let lineEnd = content.indexOf('\n', index + Math.max(matchLength, 1));
  if (lineEnd === -1) lineEnd = content.length;
  const snippet = content.slice(lineStart, lineEnd).replace(/\s+/g, ' ').trim();
  return {
    line,
    snippet: snippet.length > 120 ? snippet.slice(0, 117) + '...' : snippet,
  };
}

export function checkCircularMocking(repoRoot = ROOT_DIR) {
  const violations = [];
  const testHelperDirs = [
    path.join(repoRoot, 'tools/ci/fixtures'),
    path.join(repoRoot, 'tools/ci/lib'),
  ];
  const files = testHelperDirs
    .flatMap((d) => scanDirectory(d, /\.(mjs|cjs|js)$/))
    .filter((f) => !f.endsWith('guard-anti-cheat.mjs'));

  const circularPatterns = [
    {
      regex: /(?:import\s+[\s\S]*?\s+from|require\s*\(|import\s*\()\s*['"](\.\.?\/[^'"]*(?:\/tools\/datapack|\/contracts\/builders))['"]/gs,
      desc: 'Test helper circularly imports builder/production scripts. Helpers must verify independently.',
    },
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of circularPatterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          file: path.relative(repoRoot, file),
          line,
          rule: 'ANTI-CIRCULAR-MOCKING',
          snippet,
          message: pattern.desc,
        });
      }
    }
  }
  return violations;
}

export function checkSilentPassBypasses(repoRoot = ROOT_DIR) {
  const violations = [];
  const testFiles = scanDirectory(path.join(repoRoot, 'tools'), /\.(test\.mjs|spec\.mjs)$/)
    .filter((f) => !f.endsWith('guard-anti-cheat.test.mjs'));

  const bypassPatterns = [
    {
      regex: /if\s*\(\s*!(?:toolPath|tool|binPath|binary|executable|gitBin|hasTool|isAvailable)\b[\s\S]{0,80}?\)\s*(?:\{\s*return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?\s*\}|return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?)/gis,
      desc: 'Bypassing test with "return true" when tool or dependency is missing. Must use skip or fail closed.',
    },
    {
      regex: /catch\s*(?:\([^)]*\))?\s*\{[\s\S]{0,60}?return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\})\s*;?[\s\S]{0,20}?\}/gis,
      desc: 'Catch block silently returning true or { valid: true }.',
    },
  ];

  for (const file of testFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of bypassPatterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          file: path.relative(repoRoot, file),
          line,
          rule: 'ANTI-SILENT-PASS',
          snippet,
          message: pattern.desc,
        });
      }
    }
  }
  return violations;
}

export function checkProductionCheats(repoRoot = ROOT_DIR) {
  const violations = [];
  const prodDirs = [
    path.join(repoRoot, 'tools/ci'),
    path.join(repoRoot, 'tools/repo'),
  ];
  const files = prodDirs
    .flatMap((d) => scanDirectory(d, /\.(mjs|cjs|js)$/))
    .filter((f) => !f.includes('.test.') && !f.endsWith('guard-anti-cheat.mjs'));

  const cheatPatterns = [
    {
      regex: /process\.env\.NODE_ENV\s*===?\s*['"]test['"]/gs,
      desc: 'Test-specific backdoor branching (process.env.NODE_ENV === "test") in production tooling.',
    },
    {
      regex: /\[(?:Dummy|Placeholder|Fake)\s*(?:token|hash|secret|value)?\s*:\s*\$\{/gis,
      desc: 'Dummy placeholder value detected in production tooling.',
    },
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of cheatPatterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          file: path.relative(repoRoot, file),
          line,
          rule: 'ANTI-PRODUCTION-CHEAT',
          snippet,
          message: pattern.desc,
        });
      }
    }
  }
  return violations;
}

export function checkHollowAssertions(repoRoot = ROOT_DIR) {
  const violations = [];
  const testFiles = scanDirectory(path.join(repoRoot, 'tools'), /\.(test\.mjs|spec\.mjs)$/)
    .filter((f) => !f.endsWith('guard-anti-cheat.test.mjs'));

  const hollowPatterns = [
    {
      regex: /assert\.(?:strictEqual|equal|deepStrictEqual|deepEqual)\s*\(\s*([a-zA-Z0-9_$]+)\s*,\s*\1\s*\)/g,
      desc: 'Tautological assertion comparing variable with itself (e.g. assert.equal(x, x)).',
    },
    {
      regex: /assert\.(?:strictEqual|equal)\s*\(\s*(['"][^'"]*['"]|\d+|true|false)\s*,\s*\1\s*\)/g,
      desc: 'Tautological assertion comparing identical literals.',
    },
    {
      regex: /assert\.(?:ok|isTrue)\s*\(\s*true\s*\)/g,
      desc: 'Hollow assertion assert.ok(true) or assert.isTrue(true).',
    },
    {
      regex: /expect\s*\(\s*true\s*\)\.toBe\s*\(\s*true\s*\)/g,
      desc: 'Hollow assertion expect(true).toBe(true).',
    },
  ];

  for (const file of testFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of hollowPatterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          file: path.relative(repoRoot, file),
          line,
          rule: 'ANTI-HOLLOW-ASSERTION',
          snippet,
          message: pattern.desc,
        });
      }
    }
  }
  return violations;
}

export function checkSchemaIntegrity(repoRoot = ROOT_DIR) {
  const violations = [];
  const contractsDir = path.join(repoRoot, 'contracts');
  const schemaFiles = scanDirectory(contractsDir, /\.schema\.json$/);

  for (const file of schemaFiles) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed.$schema && !parsed.type && !parsed.properties) {
        violations.push({
          file: path.relative(repoRoot, file),
          line: 1,
          rule: 'GATE_SCHEMA_INTEGRITY',
          snippet: raw.slice(0, 80),
          message: 'Contract schema missing standard JSON Schema definitions.',
        });
      }
    } catch (err) {
      violations.push({
        file: path.relative(repoRoot, file),
        line: 1,
        rule: 'GATE_SCHEMA_INTEGRITY',
        snippet: err.message,
        message: 'Invalid JSON syntax in contract schema.',
      });
    }
  }
  return violations;
}

export function runAntiCheatAudit(repoRoot = ROOT_DIR) {
  return [
    ...checkCircularMocking(repoRoot),
    ...checkSilentPassBypasses(repoRoot),
    ...checkProductionCheats(repoRoot),
    ...checkHollowAssertions(repoRoot),
    ...checkSchemaIntegrity(repoRoot),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('\n🔒 Running EasySubway Data Anti-Cheat & Test Integrity Guard (EasyConvert Standard)...\n');
  const violations = runAntiCheatAudit();

  if (violations.length > 0) {
    console.error(`\x1b[31m❌ [REJECTED] Found ${violations.length} Anti-Cheat violation(s):\x1b[0m\n`);
    for (const v of violations) {
      console.error(`  \x1b[33m${v.file}:${v.line}\x1b[0m [\x1b[31m${v.rule}\x1b[0m]`);
      console.error(`    Snippet : "${v.snippet}"`);
      console.error(`    Reason  : ${v.message}\n`);
    }
    process.exit(1);
  } else {
    console.log('\x1b[32m✅ [PASS] Zero shortcuts, zero circular mocks, zero silent passes, zero hollow assertions detected.\x1b[0m\n');
    process.exit(0);
  }
}
