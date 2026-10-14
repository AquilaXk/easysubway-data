import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OWNERSHIP_RELATIVE_PATH = "tools/ci/data-test-ownership.json";
const MANIFEST_RELATIVE_PATH = "tools/datapack/release/nationwide-candidate-input-manifest.json";
const ALLOWLIST_RELATIVE_PATH = "tools/ci/candidate-pinned-input-read-allowlist.json";

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");
}

function resolvePinnedLiteral(testFile, rawLiteral, pinnedSet, isFileRelative = false) {
  if (typeof rawLiteral !== "string" || rawLiteral.length === 0) return null;
  if (!isFileRelative) {
    const cleaned = rawLiteral.replace(/^\.\//u, "");
    if (pinnedSet.has(cleaned)) return cleaned;
  }
  const fromFileDir = path.posix.normalize(path.posix.join(path.posix.dirname(testFile), rawLiteral));
  if (pinnedSet.has(fromFileDir)) return fromFileDir;
  return null;
}

export function detectDirectPinnedInputReadsInSource({ testFile, source, pinnedPaths }) {
  const pinnedSet = pinnedPaths instanceof Set ? pinnedPaths : new Set(pinnedPaths);
  const clean = stripComments(source);

  const topLevelRootVars = new Set(["process.cwd()"]);
  for (const match of clean.matchAll(/^\s*(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*([^\n;]+)/gmu)) {
    const [, name, rhs] = match;
    if (/mkdtemp|tmpdir|candidatePinnedWorkspace|currentCandidateRoot/u.test(rhs)) continue;
    if (/import\.meta\.(?:dirname|url)|process\.cwd\s*\(/u.test(rhs)) {
      topLevelRootVars.add(name);
    }
  }
  const isRepoRootExpr = (expr) => {
    const trimmed = expr.trim();
    return topLevelRootVars.has(trimmed) || trimmed === "process.cwd()" || trimmed === "import.meta.dirname";
  };

  const stringConsts = new Map();
  const worktreePathConsts = new Map();
  for (const match of clean.matchAll(/\bconst\s+([A-Za-z0-9_$]+)\s*=\s*["']([^"']+)["']/gu)) {
    stringConsts.set(match[1], match[2]);
  }
  for (const match of clean.matchAll(
    /\bconst\s+([A-Za-z0-9_$]+)\s*=\s*path\.(?:join|resolve)\s*\(\s*([^,]+),\s*["']([^"']+)["']\s*\)/gu,
  )) {
    if (isRepoRootExpr(match[2])) {
      const resolved = resolvePinnedLiteral(testFile, match[3], pinnedSet, false);
      if (resolved) worktreePathConsts.set(match[1], resolved);
    }
  }
  for (const match of clean.matchAll(
    /\bconst\s+([A-Za-z0-9_$]+)\s*=\s*new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/gu,
  )) {
    const resolved = resolvePinnedLiteral(testFile, match[2], pinnedSet, true);
    if (resolved) worktreePathConsts.set(match[1], resolved);
  }

  const fileRelativeHelperFns = new Set();
  const rootRelativeHelperFns = new Set();
  for (const match of clean.matchAll(
    /\b(?:const|function)\s+([A-Za-z0-9_$]+)\s*=?\s*(?:async\s*)?\(\s*([A-Za-z0-9_$]+)\s*\)[\s\S]{0,160}?\breadFile(?:Sync)?\s*\(\s*new\s+URL\s*\(\s*\2\s*,\s*import\.meta\.url\s*\)/gu,
  )) {
    fileRelativeHelperFns.add(match[1]);
  }
  for (const match of clean.matchAll(
    /\b(?:const|function)\s+([A-Za-z0-9_$]+)\s*=?\s*(?:async\s*)?\(\s*([A-Za-z0-9_$]+)\s*\)[\s\S]{0,160}?\breadFile(?:Sync)?\s*\(\s*path\.(?:join|resolve)\s*\(\s*([A-Za-z0-9_$.()]+)\s*,\s*\2\s*\)/gu,
  )) {
    if (isRepoRootExpr(match[3])) rootRelativeHelperFns.add(match[1]);
  }

  const detected = new Set();

  for (const match of clean.matchAll(/\breadFile(?:Sync)?\s*\(((?:\([^()]*\)|[^()])+)\)/gu)) {
    const arg = match[1].trim();
    const urlMatch = arg.match(/^new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/u);
    if (urlMatch) {
      const resolved = resolvePinnedLiteral(testFile, urlMatch[1], pinnedSet, true);
      if (resolved) detected.add(resolved);
      continue;
    }
    const joinMatch = arg.match(/^path\.(?:join|resolve)\s*\(\s*([^,]+),\s*([^,)]+)\s*\)/u);
    if (joinMatch) {
      const [, base, targetExpr] = joinMatch;
      if (!isRepoRootExpr(base)) continue;
      const lit = targetExpr.trim().match(/^["']([^"']+)["']$/u);
      if (lit) {
        const resolved = resolvePinnedLiteral(testFile, lit[1], pinnedSet, false);
        if (resolved) detected.add(resolved);
      } else if (stringConsts.has(targetExpr.trim())) {
        const resolved = resolvePinnedLiteral(testFile, stringConsts.get(targetExpr.trim()), pinnedSet, false);
        if (resolved) detected.add(resolved);
      }
      continue;
    }
    const directLit = arg.match(/^["']([^"']+)["']/u);
    if (directLit) {
      const resolved = resolvePinnedLiteral(testFile, directLit[1], pinnedSet, false);
      if (resolved) detected.add(resolved);
      continue;
    }
    const idMatch = arg.match(/^([A-Za-z0-9_$]+)\b/u);
    if (idMatch) {
      const id = idMatch[1];
      if (worktreePathConsts.has(id)) {
        detected.add(worktreePathConsts.get(id));
      } else if (stringConsts.has(id)) {
        const resolved = resolvePinnedLiteral(testFile, stringConsts.get(id), pinnedSet, false);
        if (resolved) detected.add(resolved);
      }
    }
  }

  for (const fn of fileRelativeHelperFns) {
    for (const match of clean.matchAll(new RegExp(`\\b${fn}\\s*\\(\\s*["']([^"']+)["']`, "gu"))) {
      const resolved = resolvePinnedLiteral(testFile, match[1], pinnedSet, true);
      if (resolved) detected.add(resolved);
    }
  }
  for (const fn of rootRelativeHelperFns) {
    for (const match of clean.matchAll(new RegExp(`\\b${fn}\\s*\\(\\s*["']([^"']+)["']`, "gu"))) {
      const resolved = resolvePinnedLiteral(testFile, match[1], pinnedSet, false);
      if (resolved) detected.add(resolved);
    }
  }

  return [...detected].sort();
}

export function auditCandidatePinnedInputReads({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  ownershipPath = path.join(repositoryRoot, OWNERSHIP_RELATIVE_PATH),
  manifestPath = path.join(repositoryRoot, MANIFEST_RELATIVE_PATH),
  allowlistPath = path.join(repositoryRoot, ALLOWLIST_RELATIVE_PATH),
} = {}) {
  const ownership = JSON.parse(readFileSync(ownershipPath, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));

  const pinnedSet = new Set((manifest.files ?? []).map((entry) => entry.path));
  const requiredPrTests = (ownership.tests ?? [])
    .filter((entry) => Array.isArray(entry.classes) && entry.classes.includes("required-pr"))
    .map((entry) => entry.path);
  const requiredPrSet = new Set(requiredPrTests);

  const violations = [];
  const allowlistByFile = new Map();

  for (const entry of allowlist.entries ?? []) {
    const testFile = entry?.testFile;
    if (typeof testFile !== "string" || testFile.trim().length === 0) {
      violations.push({
        code: "ALLOWLIST_TEST_FILE_INVALID",
        testFile: String(testFile ?? ""),
        message: "allowlist entry must declare a non-empty testFile",
      });
      continue;
    }
    if (allowlistByFile.has(testFile)) {
      violations.push({
        code: "ALLOWLIST_DUPLICATE_TEST_FILE",
        testFile,
        message: `duplicate allowlist entry for ${testFile}`,
      });
      continue;
    }
    if (!requiredPrSet.has(testFile)) {
      violations.push({
        code: "ALLOWLIST_TEST_NOT_REQUIRED_PR",
        testFile,
        message: `allowlisted testFile is not registered in required-pr: ${testFile}`,
      });
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      violations.push({
        code: "ALLOWLIST_REASON_REQUIRED",
        testFile,
        message: `allowlist entry for ${testFile} must have a non-empty reason`,
      });
    }
    const paths = Array.isArray(entry.paths) ? entry.paths : [];
    if (paths.length === 0) {
      violations.push({
        code: "ALLOWLIST_PATHS_EMPTY",
        testFile,
        message: `allowlist entry for ${testFile} must list at least one pinned path`,
      });
    }
    for (const pinnedPath of paths) {
      if (!pinnedSet.has(pinnedPath)) {
        violations.push({
          code: "ALLOWLIST_PATH_NOT_PINNED",
          testFile,
          path: pinnedPath,
          message: `allowlist path ${pinnedPath} in ${testFile} is not in nationwide-candidate-input-manifest.json`,
        });
      }
    }
    allowlistByFile.set(testFile, new Set(paths));
  }

  for (const testFile of requiredPrTests) {
    if (testFile === "tools/ci/guard-candidate-pinned-input-reads.test.mjs") continue;
    const source = readFileSync(path.join(repositoryRoot, testFile), "utf8");
    const detectedPaths = detectDirectPinnedInputReadsInSource({
      testFile,
      source,
      pinnedPaths: pinnedSet,
    });
    const allowedPaths = allowlistByFile.get(testFile) ?? new Set();

    for (const detectedPath of detectedPaths) {
      if (!allowedPaths.has(detectedPath)) {
        violations.push({
          code: "UNALLOWLISTED_PINNED_INPUT_READ",
          testFile,
          path: detectedPath,
          message: `${testFile} directly reads candidate-pinned input ${detectedPath} from worktree; use candidate-pinned-inputs.mjs or record an explicit reason in ${ALLOWLIST_RELATIVE_PATH}`,
        });
      }
    }

    const detectedSet = new Set(detectedPaths);
    for (const allowedPath of allowedPaths) {
      if (!detectedSet.has(allowedPath)) {
        violations.push({
          code: "STALE_ALLOWLIST_PATH",
          testFile,
          path: allowedPath,
          message: `${testFile} no longer directly reads ${allowedPath}; remove stale allowlist entry`,
        });
      }
    }
  }

  return violations;
}

export function main() {
  const violations = auditCandidatePinnedInputReads();
  if (violations.length > 0) {
    console.error(JSON.stringify({ status: "FAIL", violationCount: violations.length, violations }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ status: "PASS", violationCount: 0 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
