#!/usr/bin/env node

/**
 * CI Guard: Anti-Cheat & Pipeline Completeness Validator
 * Modeled after EasyConvert Anti-Cheating & Integrity Guard standard.
 *
 * Deterministically scans the entire codebase, canonical datapacks, and test suites to detect:
 * 1. ANTI-CIRCULAR-MOCKING: Test oracles or helpers circularly importing production materializers.
 * 2. ANTI-SILENT-PASS: Tests or adapters bypassing checks with return true / valid: true or silent catch blocks.
 * 3. ANTI-PRODUCTION-CHEAT: Backdoors (NODE_ENV === 'test', release-mode bypasses), dummy placeholders, fake constants.
 * 4. ANTI-HOLLOW-ASSERTION: Meaningless tautological assertions (assert.equal(x, x), assert.ok(true), expect(true).toBe(true)).
 * 5. ANTI-SYNTHETIC-LOOPS: Synthetic 30-minute timetable loops (depTime += 1800, wd-19800) and uniform travel time fallbacks.
 * 6. TABLE-COMPLETENESS: Prevents secured data from being abandoned/omitted (platform_info, station_car_door_hints, station_exits).
 * 7. FAIL-CLOSED-PROVENANCE: Enforces real 40-hex git SHAs and case-insensitive two-person approval.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, relative, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandExternalStopTimes } from '../datapack/lib/external-stop-times.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const REPO_ROOT = resolve(__dirname, '../..');

export class AntiCheatViolationError extends Error {
  constructor(violations) {
    const summary = violations.map((v) => `  [${v.gate}] ${v.target}:${v.line || 1} - ${v.message}`).join('\n');
    super(`Anti-Cheat Guard detected ${violations.length} violation(s):\n${summary}`);
    this.name = 'AntiCheatViolationError';
    this.violations = violations;
  }
}

function getLineAndSnippet(content, index, matchLength = 0) {
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

// ============================================================================
// Gate 1: Circular Mocking (EasyConvert Pattern)
// ============================================================================
export function checkCircularMocking(repoRoot = REPO_ROOT) {
  const violations = [];
  const testHelpersDir = resolve(repoRoot, 'tools/ci/lib');
  if (!existsSync(testHelpersDir)) return violations;

  const files = readdirSync(testHelpersDir)
    .filter((f) => f.endsWith('.mjs') || f.endsWith('.js'))
    .map((f) => join(testHelpersDir, f));

  const circularPatterns = [
    {
      regex: /(?:import\s+[\s\S]*?\s+from|require\s*\(|import\s*\()\s*['"][^'"]*\/materialize-[^'"]*['"]/gs,
      desc: 'Test helper directly imports production materializer module. Oracles and fixtures must be independent.',
    },
  ];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const pattern of circularPatterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(content)) !== null) {
        const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
        violations.push({
          gate: 'ANTI-CIRCULAR-MOCKING',
          target: relative(repoRoot, file),
          line,
          snippet,
          message: pattern.desc,
        });
      }
    }
  }

  return violations;
}

// ============================================================================
// Gate 2: Silent Pass & Tool Absence Bypasses (EasyConvert Pattern)
// ============================================================================
export function checkSilentPassBypasses(repoRoot = REPO_ROOT) {
  const violations = [];
  const scanDirs = [resolve(repoRoot, 'tools')];

  const bypassPatterns = [
    {
      regex: /if\s*\(\s*!(?:toolPath|tool|binPath|binary|executable|ffmpeg|sox|hasTool|isAvailable)\b[\s\S]{0,80}?\)\s*(?:\{\s*return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?\s*\}|return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\}|true\s*;)\s*;?)/gis,
      desc: 'Bypassing verification with "return true" or "valid: true" when tool is missing. Use explicit test.skip() or fail closed.',
    },
    {
      regex: /catch\s*(?:\([^)]*\))?\s*\{\s*return\s+(?:true|1|\{\s*valid\s*:\s*true\s*\})\s*;?\s*\}/gis,
      desc: 'Silent pass catch block returning true or { valid: true } without error handling or assertions.',
    },
  ];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') walk(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.test.mjs') || entry.name.endsWith('.mjs'))) {
        const rel = relative(repoRoot, fullPath);
        if (rel.includes('guard-datapack-anti-cheat')) continue;

        const content = readFileSync(fullPath, 'utf8');
        for (const pattern of bypassPatterns) {
          pattern.regex.lastIndex = 0;
          let match;
          while ((match = pattern.regex.exec(content)) !== null) {
            const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
            violations.push({
              gate: 'ANTI-SILENT-PASS',
              target: rel,
              line,
              snippet,
              message: pattern.desc,
            });
          }
        }
      }
    }
  }

  scanDirs.forEach((d) => existsSync(d) && walk(d));
  return violations;
}

// ============================================================================
// Gate 3: Hollow Assertions (EasyConvert Pattern)
// ============================================================================
export function checkHollowAssertions(repoRoot = REPO_ROOT) {
  const violations = [];
  const scanDirs = [resolve(repoRoot, 'tools')];

  const hollowPatterns = [
    {
      regex: /assert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*|\d+|true|false)\s*,\s*\1\s*\)/gs,
      desc: 'Hollow assertion tautology detected (e.g., assert.equal(x, x) or assert.equal(true, true)).',
    },
    {
      regex: /expect\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*|\d+|true|false)\s*\)[\s\S]{0,30}?\.(?:toBe|toEqual)\s*\(\s*\1\s*\)/gs,
      desc: 'Hollow assertion tautology detected (e.g., expect(true).toBe(true)).',
    },
    {
      regex: /assert\s*\.\s*(?:ok|equal|strictEqual)\s*\(\s*true\s*(?:,\s*true\s*)?\)/gs,
      desc: 'Hollow assertion assert.ok(true) detected. Must verify concrete domain properties.',
    },
  ];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        const rel = relative(repoRoot, fullPath);
        if (rel.includes('guard-datapack-anti-cheat')) continue;

        const content = readFileSync(fullPath, 'utf8');
        for (const pattern of hollowPatterns) {
          pattern.regex.lastIndex = 0;
          let match;
          while ((match = pattern.regex.exec(content)) !== null) {
            const { line, snippet } = getLineAndSnippet(content, match.index, match[0].length);
            violations.push({
              gate: 'ANTI-HOLLOW-ASSERTION',
              target: rel,
              line,
              snippet,
              message: pattern.desc,
            });
          }
        }
      }
    }
  }

  scanDirs.forEach((d) => existsSync(d) && walk(d));
  return violations;
}

// ============================================================================
// Gate: Circular Oracle (Anti-Cheat Modeled after EasyConvert)
// ============================================================================

// 범용 공용 helper(검증 대상 production 함수가 아닌 입력 변환 도구)만 이름 단위로 허용한다.
// 테스트가 이 helper로 기대값을 만들어도 검증 대상 출력과 순환하지 않는다.
// 모듈 전체가 아니라 export 이름을 고정하므로 같은 모듈의 다른 export는 계속 순환 검사 대상이다.
const SHARED_HELPER_EXPORTS = new Map([
  ['tools/lib/hash.mjs', new Set(['sha256'])],
  ['tools/lib/is-object.mjs', new Set(['isObject'])],
]);

/** `foo.test.mjs`의 검증 대상 모듈 경로(`foo.mjs`)를 repo 상대 posix 경로로 돌려준다. */
function testSubjectModule(testRel) {
  return testRel.replace(/\.test\.mjs$/, '.mjs');
}

/**
 * 테스트가 import한 이름이 공용 helper이며 이 테스트의 검증 대상이 아닌지 판별한다.
 * 공용 helper 자신의 테스트(예: hash.test.mjs)는 순환 검사를 그대로 받는다.
 */
function isSharedHelperImport(testRel, importPath, importedName) {
  const modulePath = posix.join(posix.dirname(testRel), importPath);
  return SHARED_HELPER_EXPORTS.get(modulePath)?.has(importedName) === true && testSubjectModule(testRel) !== modulePath;
}

export function checkCircularOracles(repoRoot = REPO_ROOT) {
  const violations = [];
  const toolsDir = resolve(repoRoot, 'tools');
  if (!existsSync(toolsDir)) return violations;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        const rel = relative(repoRoot, fullPath);
        if (rel.includes('guard-datapack-anti-cheat')) continue;

        const content = readFileSync(fullPath, 'utf8');
        checkFileCircularOracles(content, rel, violations);
      }
    }
  }

  function tokenizeJs(code) {
    const tokens = [];
    const len = code.length;
    let i = 0;
    let line = 1;
    let braceDepth = 0;
    const templateBraceStack = [];

    const advanceChar = () => {
      const ch = code[i++];
      if (ch === '\n') line++;
      return ch;
    };

    const scanTemplateBody = () => {
      let start = i;
      while (i < len) {
        const ch = code[i];
        if (ch === '\\') {
          advanceChar();
          if (i < len) advanceChar();
          continue;
        }
        if (ch === '$' && code[i + 1] === '{') {
          tokens.push({ type: 'string', value: code.slice(start, i), start, end: i, line });
          const exprStart = i;
          advanceChar();
          advanceChar();
          tokens.push({ type: 'punct', value: '(', start: exprStart, end: i, line });
          templateBraceStack.push(braceDepth);
          return;
        }
        if (ch === '`') {
          const endPos = i + 1;
          advanceChar();
          tokens.push({ type: 'string', value: code.slice(start, endPos), start, end: endPos, line });
          tokens.push({ type: 'punct', value: ')', start: endPos - 1, end: endPos, line });
          return;
        }
        advanceChar();
      }
      tokens.push({ type: 'punct', value: ')', start: i, end: i, line });
    };

    const canStartRegex = () => {
      if (tokens.length === 0) return true;
      const prev = tokens[tokens.length - 1];
      if (prev.type === 'punct') {
        return prev.value !== ')' && prev.value !== ']' && prev.value !== '++' && prev.value !== '--';
      }
      if (prev.type === 'id') {
        return [
          'return', 'throw', 'case', 'typeof', 'void', 'delete',
          'await', 'yield', 'in', 'of', 'instanceof', 'new', 'else', 'do',
        ].includes(prev.value);
      }
      return false;
    };

    const multiPuncts = [
      '===', '!==', '>>>', '...', '==', '!=', '<=', '>=', '=>',
      '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>',
    ];

    while (i < len) {
      const ch = code[i];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        advanceChar();
        continue;
      }
      if (ch === '/' && code[i + 1] === '/') {
        while (i < len && code[i] !== '\n') advanceChar();
        continue;
      }
      if (ch === '/' && code[i + 1] === '*') {
        advanceChar();
        advanceChar();
        while (i < len && !(code[i] === '*' && code[i + 1] === '/')) advanceChar();
        if (i < len) {
          advanceChar();
          advanceChar();
        }
        continue;
      }
      if (ch === "'" || ch === '"') {
        const start = i;
        const startLine = line;
        const quote = advanceChar();
        while (i < len) {
          const c = advanceChar();
          if (c === '\\') {
            if (i < len) advanceChar();
          } else if (c === quote) {
            break;
          }
        }
        tokens.push({ type: 'string', value: code.slice(start, i), start, end: i, line: startLine });
        continue;
      }
      if (ch === '`') {
        const start = i;
        const startLine = line;
        advanceChar();
        tokens.push({ type: 'punct', value: '(', start, end: i, line: startLine });
        scanTemplateBody();
        continue;
      }
      if (ch === '/' && canStartRegex()) {
        const start = i;
        const startLine = line;
        advanceChar();
        let inClass = false;
        while (i < len) {
          const c = code[i];
          if (c === '\n') break;
          advanceChar();
          if (c === '\\') {
            if (i < len && code[i] !== '\n') advanceChar();
          } else if (c === '[') {
            inClass = true;
          } else if (c === ']') {
            inClass = false;
          } else if (c === '/' && !inClass) {
            while (i < len && /[a-z]/i.test(code[i])) advanceChar();
            break;
          }
        }
        tokens.push({ type: 'literal', value: code.slice(start, i), start, end: i, line: startLine });
        continue;
      }
      if (/[0-9]/.test(ch)) {
        const start = i;
        const startLine = line;
        while (i < len && /[0-9a-fA-FxXoObBn_.]/.test(code[i])) advanceChar();
        tokens.push({ type: 'literal', value: code.slice(start, i), start, end: i, line: startLine });
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        const start = i;
        const startLine = line;
        while (i < len && /[\w$]/.test(code[i])) advanceChar();
        tokens.push({ type: 'id', value: code.slice(start, i), start, end: i, line: startLine });
        continue;
      }
      if (ch === '{') {
        const start = i;
        advanceChar();
        braceDepth++;
        tokens.push({ type: 'punct', value: '{', start, end: i, line });
        continue;
      }
      if (ch === '}') {
        const start = i;
        advanceChar();
        if (
          templateBraceStack.length > 0 &&
          braceDepth === templateBraceStack[templateBraceStack.length - 1]
        ) {
          templateBraceStack.pop();
          tokens.push({ type: 'punct', value: ')', start, end: i, line });
          tokens.push({ type: 'punct', value: ',', start, end: i, line });
          scanTemplateBody();
          continue;
        }
        braceDepth = Math.max(0, braceDepth - 1);
        tokens.push({ type: 'punct', value: '}', start, end: i, line });
        continue;
      }

      let matchedMulti = false;
      for (const mp of multiPuncts) {
        if (code.startsWith(mp, i)) {
          const start = i;
          const startLine = line;
          for (let k = 0; k < mp.length; k++) advanceChar();
          tokens.push({ type: 'punct', value: mp, start, end: i, line: startLine });
          matchedMulti = true;
          break;
        }
      }
      if (matchedMulti) continue;

      const start = i;
      const startLine = line;
      advanceChar();
      tokens.push({ type: 'punct', value: ch, start, end: i, line: startLine });
    }

    return tokens;
  }

  function findMatchingClose(tokens, openIdx) {
    const openVal = tokens[openIdx]?.value;
    const closeVal = openVal === '(' ? ')' : openVal === '[' ? ']' : openVal === '{' ? '}' : null;
    if (!closeVal) return -1;
    let depth = 1;
    for (let i = openIdx + 1; i < tokens.length; i++) {
      const v = tokens[i].value;
      if (tokens[i].type === 'punct') {
        if (v === openVal) depth++;
        else if (v === closeVal) {
          depth--;
          if (depth === 0) return i;
        }
      }
    }
    return -1;
  }

  function splitTopLevelItems(tokens, startIdx, endIdx, delimiter = ',') {
    const ranges = [];
    let itemStart = startIdx;
    let pDepth = 0;
    let bDepth = 0;
    let cDepth = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const t = tokens[i];
      if (t.type === 'punct') {
        if (t.value === '(') pDepth++;
        else if (t.value === ')') pDepth = Math.max(0, pDepth - 1);
        else if (t.value === '[') bDepth++;
        else if (t.value === ']') bDepth = Math.max(0, bDepth - 1);
        else if (t.value === '{') cDepth++;
        else if (t.value === '}') cDepth = Math.max(0, cDepth - 1);
        else if (t.value === delimiter && pDepth === 0 && bDepth === 0 && cDepth === 0) {
          ranges.push([itemStart, i]);
          itemStart = i + 1;
        }
      }
    }
    ranges.push([itemStart, endIdx]);
    return ranges;
  }

  function extractBoundNamesFromPattern(tokens, startIdx) {
    const first = tokens[startIdx];
    if (!first) return { names: [], nextIdx: startIdx };
    if (first.type === 'id') {
      return { names: [first.value], nextIdx: startIdx + 1 };
    }
    if (first.type === 'punct' && (first.value === '{' || first.value === '[')) {
      const closeIdx = findMatchingClose(tokens, startIdx);
      if (closeIdx === -1) return { names: [], nextIdx: startIdx + 1 };
      const names = [];
      const isObj = first.value === '{';
      const items = splitTopLevelItems(tokens, startIdx + 1, closeIdx, ',');
      for (const [iStart, iEnd] of items) {
        if (iStart >= iEnd) continue;
        const eqParts = splitTopLevelItems(tokens, iStart, iEnd, '=');
        const [lhsStart, lhsEnd] = eqParts[0];
        if (lhsStart >= lhsEnd) continue;
        if (tokens[lhsStart].type === 'punct' && tokens[lhsStart].value === '...') {
          const sub = extractBoundNamesFromPattern(tokens, lhsStart + 1);
          names.push(...sub.names);
          continue;
        }
        if (isObj) {
          const colonParts = splitTopLevelItems(tokens, lhsStart, lhsEnd, ':');
          if (colonParts.length > 1) {
            const [targetStart] = colonParts[1];
            const sub = extractBoundNamesFromPattern(tokens, targetStart);
            names.push(...sub.names);
          } else if (tokens[lhsStart].type === 'id') {
            names.push(tokens[lhsStart].value);
          }
        } else {
          const sub = extractBoundNamesFromPattern(tokens, lhsStart);
          names.push(...sub.names);
        }
      }
      return { names, nextIdx: closeIdx + 1 };
    }
    return { names: [], nextIdx: startIdx + 1 };
  }

  const PREV_CONTINUES_PUNCTS = new Set([
    '=', '+=', '-=', '*=', '/=', '%=', '+', '-', '*', '/', '%', '**',
    '&&', '||', '??', '?', ':', '.', '?.', '=>', '!', '~',
    '==', '===', '!=', '!==', '<', '>', '<=', '>=', '(', '[', '{',
  ]);
  const PREV_CONTINUES_IDS = new Set([
    'await', 'new', 'typeof', 'void', 'delete', 'in', 'instanceof', 'of', 'return', 'throw', 'yield', 'async',
  ]);
  const NEXT_CONTINUES_PUNCTS = new Set([
    '.', '?.', '[', '(', '?', ':', '+', '-', '*', '/', '%', '**',
    '&&', '||', '??', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '=>',
  ]);
  const NEXT_CONTINUES_IDS = new Set(['in', 'instanceof']);

  function findExpressionEnd(tokens, startIdx) {
    let pDepth = 0;
    let bDepth = 0;
    let cDepth = 0;
    for (let k = startIdx; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.type === 'punct') {
        if (t.value === '(') pDepth++;
        else if (t.value === ')') {
          if (pDepth === 0) return k;
          pDepth--;
        } else if (t.value === '[') bDepth++;
        else if (t.value === ']') {
          if (bDepth === 0) return k;
          bDepth--;
        } else if (t.value === '{') cDepth++;
        else if (t.value === '}') {
          if (cDepth === 0) return k;
          cDepth--;
        } else if ((t.value === ';' || t.value === ',') && pDepth === 0 && bDepth === 0 && cDepth === 0) {
          return k;
        }
      }
      if (pDepth === 0 && bDepth === 0 && cDepth === 0 && k + 1 < tokens.length) {
        const next = tokens[k + 1];
        if (next.line > t.line) {
          const prevContinues =
            (t.type === 'punct' && PREV_CONTINUES_PUNCTS.has(t.value)) ||
            (t.type === 'id' && PREV_CONTINUES_IDS.has(t.value));
          const nextContinues =
            (next.type === 'punct' && NEXT_CONTINUES_PUNCTS.has(next.value)) ||
            (next.type === 'id' && NEXT_CONTINUES_IDS.has(next.value));
          if (!prevContinues && !nextContinues) {
            return k + 1;
          }
        }
      }
    }
    return tokens.length;
  }

  function checkFileCircularOracles(content, rel, fileViolations) {
    const testRelPosix = rel.split(sep).join('/');
    const importedProdFns = new Map();
    const importedNamespaces = new Map();

    const importStmtRegex = /(?:^|[\n;])\s*import\s+((?:(?!\bimport\b)[^;])+?)\s+from\s*['"](\.{1,2}\/[^'"]+)['"]/g;
    let importMatch;
    while ((importMatch = importStmtRegex.exec(content)) !== null) {
      const clause = importMatch[1].trim();
      const importPath = importMatch[2];
      if (
        importPath.includes('.test.mjs') ||
        importPath.includes('fixtures') ||
        importPath.includes('test-support')
      ) {
        continue;
      }

      const nsMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (nsMatch) {
        importedNamespaces.set(nsMatch[1], importPath);
      }

      const namedMatch = clause.match(/\{([\s\S]*?)\}/);
      if (namedMatch) {
        const specs = namedMatch[1].split(',');
        for (const spec of specs) {
          const trimmed = spec.trim();
          if (!trimmed) continue;
          const [importedName, localName = importedName] = trimmed
            .split(/\s+as\s+/)
            .map((part) => part.trim());
          if (isSharedHelperImport(testRelPosix, importPath, importedName)) continue;
          importedProdFns.set(localName, importedName);
        }
      }

      const beforeBraceOrStar = clause
        .replace(/\{[\s\S]*?\}/, '')
        .replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '')
        .replace(/,/g, '')
        .trim();
      if (beforeBraceOrStar && /^[A-Za-z_$][\w$]*$/.test(beforeBraceOrStar) && beforeBraceOrStar !== 'type') {
        if (!isSharedHelperImport(testRelPosix, importPath, beforeBraceOrStar)) {
          importedProdFns.set(beforeBraceOrStar, beforeBraceOrStar);
        }
      }
    }

    if (importedProdFns.size === 0 && importedNamespaces.size === 0) return;

    const tokens = tokenizeJs(content);
    const scopeStack = [{ vars: new Map(), fnAliases: new Map(), literalTokens: new Map() }];

    const lookupVar = (name) => {
      for (let s = scopeStack.length - 1; s >= 0; s--) {
        if (scopeStack[s].vars.has(name)) {
          return scopeStack[s].vars.get(name);
        }
      }
      return null;
    };

    const lookupLiteralTokens = (name) => {
      for (let s = scopeStack.length - 1; s >= 0; s--) {
        if (scopeStack[s].literalTokens.has(name)) {
          return scopeStack[s].literalTokens.get(name);
        }
      }
      return null;
    };

    const setExistingOrCurrentVar = (name, sourceMap, litToks = null) => {
      for (let s = scopeStack.length - 1; s >= 0; s--) {
        if (scopeStack[s].vars.has(name)) {
          scopeStack[s].vars.set(name, sourceMap);
          if (litToks) scopeStack[s].literalTokens.set(name, litToks);
          else scopeStack[s].literalTokens.delete(name);
          return;
        }
      }
      const top = scopeStack[scopeStack.length - 1];
      top.vars.set(name, sourceMap);
      if (litToks) top.literalTokens.set(name, litToks);
      else top.literalTokens.delete(name);
    };

    const lookupFnAlias = (name) => {
      for (let s = scopeStack.length - 1; s >= 0; s--) {
        if (scopeStack[s].fnAliases.has(name)) {
          return scopeStack[s].fnAliases.get(name);
        }
      }
      return null;
    };

    const buildCallOrigin = (callTokenIdx, openParenIdx) => {
      const closeParenIdx = findMatchingClose(tokens, openParenIdx);
      if (closeParenIdx === -1) return `${callTokenIdx}:`;
      const parts = [];
      for (let p = openParenIdx + 1; p < closeParenIdx; p++) {
        const t = tokens[p];
        const prev = p > openParenIdx + 1 ? tokens[p - 1] : null;
        const next = p + 1 < closeParenIdx ? tokens[p + 1] : null;
        if (
          t.type === 'id' &&
          !(prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.')) &&
          !(next?.type === 'punct' && next.value === ':' && prev?.type === 'punct' && (prev.value === '{' || prev.value === ','))
        ) {
          const lit = lookupLiteralTokens(t.value);
          if (lit) {
            parts.push(lit);
            continue;
          }
        }
        parts.push(t.value);
      }
      return `${callTokenIdx}:${parts.join(' ')}`;
    };

    const addSourceOrigin = (sources, fnName, origin) => {
      if (!sources.has(fnName)) sources.set(fnName, new Set());
      sources.get(fnName).add(origin);
    };

    const mergeSourceMaps = (target, incoming) => {
      for (const [fnName, origins] of incoming.entries()) {
        for (const origin of origins) {
          addSourceOrigin(target, fnName, origin);
        }
      }
    };

    const evaluateExpressionSources = (startIdx, endIdx) => {
      const sources = new Map();
      const arrowParams = new Set();
      const prodCallArgIntervals = [];
      const fnBodyIntervals = [];

      for (let k = startIdx; k < endIdx; k++) {
        const tok = tokens[k];
        if (tok.type === 'punct' && tok.value === '=>') {
          if (tokens[k + 1]?.type === 'punct' && tokens[k + 1].value === '{') {
            const closeBrace = findMatchingClose(tokens, k + 1);
            if (closeBrace !== -1) {
              fnBodyIntervals.push([k + 1, closeBrace]);
            }
          } else {
            const exprEnd = findExpressionEnd(tokens, k + 1);
            fnBodyIntervals.push([k + 1, exprEnd]);
          }
        }
        if (tok.type === 'id' && tok.value === 'function') {
          let braceIdx = k + 1;
          if (tokens[braceIdx]?.type === 'id') braceIdx++;
          if (tokens[braceIdx]?.type === 'punct' && tokens[braceIdx].value === '(') {
            const closeParen = findMatchingClose(tokens, braceIdx);
            if (closeParen !== -1 && tokens[closeParen + 1]?.type === 'punct' && tokens[closeParen + 1].value === '{') {
              const closeBrace = findMatchingClose(tokens, closeParen + 1);
              if (closeBrace !== -1) {
                fnBodyIntervals.push([closeParen + 1, closeBrace]);
              }
            }
          }
        }
        if (
          tok.type === 'id' &&
          tokens[k + 1]?.type === 'punct' &&
          tokens[k + 1].value === '(' &&
          tokens[k - 1]?.type === 'punct' &&
          (tokens[k - 1].value === '{' || tokens[k - 1].value === ',')
        ) {
          const closeParen = findMatchingClose(tokens, k + 1);
          if (closeParen !== -1 && tokens[closeParen + 1]?.type === 'punct' && tokens[closeParen + 1].value === '{') {
            const closeBrace = findMatchingClose(tokens, closeParen + 1);
            if (closeBrace !== -1) {
              fnBodyIntervals.push([closeParen + 1, closeBrace]);
            }
          }
        }
        if (tok.type === 'id' && tokens[k + 1]?.type === 'punct' && tokens[k + 1].value === '=>') {
          arrowParams.add(tok.value);
          continue;
        }
        if (tok.type === 'punct' && tok.value === '(') {
          const closeParen = findMatchingClose(tokens, k);
          if (closeParen !== -1 && closeParen < endIdx && tokens[closeParen + 1]?.value === '=>') {
            for (let p = k + 1; p < closeParen; p++) {
              if (tokens[p].type === 'id') arrowParams.add(tokens[p].value);
            }
          }
        }
      }

      const isInsideInterval = (pos, intervals) => {
        for (const [s, e] of intervals) {
          if (pos >= s && pos <= e) return true;
        }
        return false;
      };

      for (let k = startIdx; k < endIdx; k++) {
        if (isInsideInterval(k, fnBodyIntervals) || isInsideInterval(k, prodCallArgIntervals)) continue;
        const tok = tokens[k];
        if (tok.type !== 'id') continue;
        const prev = k > startIdx ? tokens[k - 1] : null;
        const next = k + 1 < endIdx ? tokens[k + 1] : null;

        if (prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.')) {
          if (next?.type === 'punct' && next.value === '(') {
            const closeParen = findMatchingClose(tokens, k + 1);
            if (closeParen !== -1) prodCallArgIntervals.push([k + 1, closeParen]);
            const objTok = k - 2 >= startIdx ? tokens[k - 2] : null;
            const beforeObjTok = k - 3 >= startIdx ? tokens[k - 3] : null;
            if (
              objTok?.type === 'id' &&
              !(beforeObjTok?.type === 'punct' && (beforeObjTok.value === '.' || beforeObjTok.value === '?.')) &&
              importedNamespaces.has(objTok.value)
            ) {
              const importPath = importedNamespaces.get(objTok.value);
              if (!isSharedHelperImport(testRelPosix, importPath, tok.value)) {
                addSourceOrigin(sources, tok.value, buildCallOrigin(k, k + 1));
              }
            }
          }
          continue;
        }

        if (
          next?.type === 'punct' &&
          next.value === ':' &&
          prev?.type === 'punct' &&
          (prev.value === '{' || prev.value === ',')
        ) {
          continue;
        }

        if (arrowParams.has(tok.value)) continue;

        if (next?.type === 'punct' && next.value === '(') {
          let matchedProdCall = false;
          const origin = buildCallOrigin(k, k + 1);
          if (importedProdFns.has(tok.value)) {
            addSourceOrigin(sources, importedProdFns.get(tok.value), origin);
            matchedProdCall = true;
          } else {
            const aliased = lookupFnAlias(tok.value);
            if (aliased) {
              for (const fn of aliased) {
                addSourceOrigin(sources, fn, origin);
              }
              matchedProdCall = true;
            }
          }
          if (matchedProdCall) {
            const closeParen = findMatchingClose(tokens, k + 1);
            if (closeParen !== -1) {
              prodCallArgIntervals.push([k + 1, closeParen]);
            }
            continue;
          }
        }

        const boundSources = lookupVar(tok.value);
        if (boundSources && boundSources.size > 0) {
          mergeSourceMaps(sources, boundSources);
        }
      }

      return sources;
    };

    const resolveAliasTargets = (startIdx, endIdx) => {
      if (endIdx - startIdx === 1 && tokens[startIdx].type === 'id') {
        const idName = tokens[startIdx].value;
        if (importedProdFns.has(idName)) {
          return new Set([importedProdFns.get(idName)]);
        }
        const existingAlias = lookupFnAlias(idName);
        if (existingAlias && existingAlias.size > 0) {
          return new Set(existingAlias);
        }
      }
      if (
        endIdx - startIdx === 3 &&
        tokens[startIdx].type === 'id' &&
        importedNamespaces.has(tokens[startIdx].value) &&
        tokens[startIdx + 1].value === '.' &&
        tokens[startIdx + 2].type === 'id'
      ) {
        const importPath = importedNamespaces.get(tokens[startIdx].value);
        const member = tokens[startIdx + 2].value;
        if (!isSharedHelperImport(testRelPosix, importPath, member)) {
          return new Set([member]);
        }
      }
      return null;
    };

    const extractPureLiteralSignature = (startIdx, endIdx, rhsSources) => {
      if (rhsSources.size > 0 || endIdx <= startIdx) return null;
      const parts = [];
      for (let p = startIdx; p < endIdx; p++) {
        parts.push(tokens[p].value);
      }
      return parts.join(' ');
    };

    const verifiedOrigins = new Set();

    const markExpressionOriginsVerified = (sources) => {
      for (const origins of sources.values()) {
        for (const origin of origins) {
          verifiedOrigins.add(origin);
        }
      }
    };

    for (let idx = 0; idx < tokens.length; idx++) {
      const tok = tokens[idx];

      if (tok.type === 'punct' && tok.value === '{') {
        scopeStack.push({ vars: new Map(), fnAliases: new Map(), literalTokens: new Map() });
        continue;
      }
      if (tok.type === 'punct' && tok.value === '}') {
        if (scopeStack.length > 1) scopeStack.pop();
        continue;
      }

      if (tok.type === 'id' && (tok.value === 'const' || tok.value === 'let' || tok.value === 'var')) {
        let declIdx = idx + 1;
        while (declIdx < tokens.length) {
          const { names, nextIdx } = extractBoundNamesFromPattern(tokens, declIdx);
          if (names.length === 0) break;
          const currentScope = scopeStack[scopeStack.length - 1];
          if (tokens[nextIdx]?.type === 'punct' && tokens[nextIdx].value === '=') {
            const rhsStart = nextIdx + 1;
            const rhsEnd = findExpressionEnd(tokens, rhsStart);
            const rhsSources = evaluateExpressionSources(rhsStart, rhsEnd);
            const aliasSet = names.length === 1 ? resolveAliasTargets(rhsStart, rhsEnd) : null;
            const litSig = names.length === 1 ? extractPureLiteralSignature(rhsStart, rhsEnd, rhsSources) : null;
            for (const name of names) {
              currentScope.vars.set(name, rhsSources);
              if (aliasSet) {
                currentScope.fnAliases.set(name, aliasSet);
              } else {
                currentScope.fnAliases.delete(name);
              }
              if (litSig) {
                currentScope.literalTokens.set(name, litSig);
              } else {
                currentScope.literalTokens.delete(name);
              }
            }
            declIdx = rhsEnd;
          } else {
            for (const name of names) {
              currentScope.vars.set(name, new Map());
              currentScope.fnAliases.delete(name);
              currentScope.literalTokens.delete(name);
            }
            declIdx = nextIdx;
          }
          if (tokens[declIdx]?.type === 'punct' && tokens[declIdx].value === ',') {
            declIdx++;
          } else {
            break;
          }
        }
        continue;
      }

      if (
        tok.type === 'id' &&
        tokens[idx + 1]?.type === 'punct' &&
        tokens[idx + 1].value === '=' &&
        !(tokens[idx - 1]?.type === 'punct' && (tokens[idx - 1].value === '.' || tokens[idx - 1].value === '?.'))
      ) {
        const rhsStart = idx + 2;
        const rhsEnd = findExpressionEnd(tokens, rhsStart);
        const rhsSources = evaluateExpressionSources(rhsStart, rhsEnd);
        const litSig = extractPureLiteralSignature(rhsStart, rhsEnd, rhsSources);
        setExistingOrCurrentVar(tok.value, rhsSources, litSig);
        const aliasSet = resolveAliasTargets(rhsStart, rhsEnd);
        if (aliasSet) {
          scopeStack[scopeStack.length - 1].fnAliases.set(tok.value, aliasSet);
        }
        continue;
      }

      if (
        tok.type === 'id' &&
        tok.value === 'assert' &&
        tokens[idx + 1]?.type === 'punct' &&
        tokens[idx + 1].value === '.' &&
        tokens[idx + 2]?.type === 'id' &&
        ['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual'].includes(tokens[idx + 2].value) &&
        tokens[idx + 3]?.type === 'punct' &&
        tokens[idx + 3].value === '('
      ) {
        const openParenIdx = idx + 3;
        const closeParenIdx = findMatchingClose(tokens, openParenIdx);
        if (closeParenIdx === -1) continue;

        const argRanges = splitTopLevelItems(tokens, openParenIdx + 1, closeParenIdx, ',');
        if (argRanges.length < 2) continue;

        const [argAStart, argAEnd] = argRanges[0];
        const [argBStart, argBEnd] = argRanges[1];
        const sourcesA = evaluateExpressionSources(argAStart, argAEnd);
        const sourcesB = evaluateExpressionSources(argBStart, argBEnd);

        const splitOrigin = (origin) => {
          const colonPos = origin.indexOf(':');
          return {
            callId: origin.slice(0, colonPos),
            argSig: origin.slice(colonPos + 1),
          };
        };

        const circularFns = [];
        for (const [fn, sA] of sourcesA.entries()) {
          if (sourcesB.has(fn)) {
            const sB = sourcesB.get(fn);
            let isCircular = false;
            for (const originA of sA) {
              if (verifiedOrigins.has(originA)) continue;
              const parsedA = splitOrigin(originA);
              for (const originB of sB) {
                if (verifiedOrigins.has(originB)) continue;
                const parsedB = splitOrigin(originB);
                if (parsedA.callId !== parsedB.callId && parsedA.argSig === parsedB.argSig) {
                  isCircular = true;
                  break;
                }
              }
              if (isCircular) break;
            }
            if (isCircular) {
              circularFns.push(fn);
            }
          }
        }

        if (circularFns.length > 0) {
          const startIndex = tok.start;
          const endIndex = tokens[closeParenIdx].end;
          const upToAssert = content.slice(0, startIndex);
          const lines = upToAssert.split('\n');
          let prevLine = '';
          for (let l = lines.length - 2; l >= 0; l--) {
            const trimmed = lines[l].trim();
            if (trimmed.length > 0) {
              prevLine = trimmed;
              break;
            }
          }

          const allowMatch = prevLine.match(
            /^\/\/\s*anti-cheat-allow:\s*circular-oracle(?:\s*--\s*(.*))?$/,
          );
          if (allowMatch) {
            const reason = (allowMatch[1] || '').trim();
            if (reason.length > 0) {
              markExpressionOriginsVerified(sourcesA);
              markExpressionOriginsVerified(sourcesB);
              continue;
            }
          }

          const { line, snippet } = getLineAndSnippet(content, startIndex, endIndex - startIndex);
          fileViolations.push({
            gate: 'ANTI-CIRCULAR-ORACLE',
            target: rel,
            line,
            snippet,
            message: `Circular oracle detected: assertion compares results produced by the same production function "${circularFns.join(', ')}". Use independent golden expected values or independent oracles.`,
          });
        } else {
          markExpressionOriginsVerified(sourcesA);
          markExpressionOriginsVerified(sourcesB);
        }
      }
    }
  }

  walk(toolsDir);
  return violations;
}

// ============================================================================
// Gate 4: Production Cheats & Backdoors (EasyConvert + EasySubway)
// ============================================================================
export function checkProductionCheats(repoRoot = REPO_ROOT) {
  const violations = [];
  const toolsDir = resolve(repoRoot, 'tools');
  const BANNED_STALE_SHA = ['d7fe777352', '8239e27e37', '88679d1b46', 'b813cce046'].join('');

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') walk(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.js'))) {
        const relPath = relative(repoRoot, fullPath);
        if (relPath.includes('guard-datapack-anti-cheat')) continue;

        const content = readFileSync(fullPath, 'utf8');

        // 4.1 Banned commit SHA in production scripts
        if (!entry.name.endsWith('.test.mjs') && content.includes(BANNED_STALE_SHA)) {
          violations.push({
            gate: 'GATE_FAIL_CLOSED_GIT_PROVENANCE',
            target: relPath,
            message: `Contains hardcoded stale git commit SHA "${BANNED_STALE_SHA}". Fail-closed git resolution required.`,
          });
        }

        // 4.2 Conditional test skips based on release mode
        if (
          entry.name.endsWith('.test.mjs') &&
          /process\.env\.EASYSUBWAY_DATAPACK_RELEASE_MODE.*?\b(?:skip|only)\b/s.test(content)
        ) {
          violations.push({
            gate: 'GATE_NO_TEST_CHEATING_OR_BYPASS',
            target: relPath,
            message: 'Detected test.skip conditioned on EASYSUBWAY_DATAPACK_RELEASE_MODE. CI bypasses are strictly forbidden.',
          });
        }

        // 4.3 Hardcoded 2-station facility filters
        if (
          !entry.name.endsWith('.test.mjs') &&
          content.includes('["station-sadang", "station-sangnoksu"]') &&
          !content.includes('// anti-cheat allow')
        ) {
          violations.push({
            gate: 'GATE_NO_TEST_CHEATING_OR_BYPASS',
            target: relPath,
            message: 'Detected hardcoded stationIds = ["station-sadang", "station-sangnoksu"] restricting accessibility updates.',
          });
        }

        // 4.4 Silent bypass of SQLite hash check in release mode
        if (
          !entry.name.endsWith('.test.mjs') &&
          /if\s*\(\s*process\.env\.EASYSUBWAY_DATAPACK_RELEASE_MODE\s*===.*?\)\s*{\s*return;?\s*}/.test(content)
        ) {
          violations.push({
            gate: 'GATE_NO_TEST_CHEATING_OR_BYPASS',
            target: relPath,
            message: 'Detected silent early return on release mode bypassing validation checks.',
          });
        }
      }
    }
  }

  if (existsSync(toolsDir)) walk(toolsDir);
  return violations;
}

// ============================================================================
// Gate 5: Table Completeness (EasySubway Datapack Domain)
// ============================================================================
export function checkTableCompleteness(packInput, options = {}) {
  const pack = packInput?.packs?.[0] ?? packInput ?? {};
  const violations = [];
  const minCarDoorHints = options.minCarDoorHints ?? 35;
  const isNationwide = pack.id === 'nationwide' || pack.id === 'capital';

  if (Array.isArray(pack.stationLines) && pack.stationLines.length > 0) {
    const totalLines = pack.stationLines.length;
    const nonEmptyPlatformInfo = pack.stationLines.filter(
      (sl) => typeof sl.platformInfo === 'string' && sl.platformInfo.trim().length > 0
    );

    if (options.requirePlatformInfo && nonEmptyPlatformInfo.length === 0) {
      violations.push({
        gate: 'GATE_TABLE_COMPLETENESS',
        target: 'station_lines.platform_info',
        message: `All ${totalLines} station_lines records have 100% blank platform_info. Authentic platform metadata must be wired.`,
      });
    }

    for (const sl of nonEmptyPlatformInfo) {
      try {
        const parsed = JSON.parse(sl.platformInfo);
        if (typeof parsed !== 'object' || parsed === null) {
          violations.push({
            gate: 'GATE_TABLE_COMPLETENESS',
            target: `station_lines[${sl.stationId}:${sl.lineId}].platform_info`,
            message: `platform_info must be a valid JSON object, got: "${sl.platformInfo}"`,
          });
          break;
        }
      } catch (err) {
        violations.push({
          gate: 'GATE_TABLE_COMPLETENESS',
          target: `station_lines[${sl.stationId}:${sl.lineId}].platform_info`,
          message: `platform_info is not valid JSON: ${err.message}`,
        });
        break;
      }
    }
  }

  if (isNationwide) {
    const carDoorHints = pack.stationCarDoorHints ?? [];
    if (carDoorHints.length < minCarDoorHints) {
      violations.push({
        gate: 'GATE_TABLE_COMPLETENESS',
        target: 'station_car_door_hints',
        message: `station_car_door_hints has ${carDoorHints.length} rows, below minimum required threshold of ${minCarDoorHints}. Fast exit/transfer hints must not be abandoned.`,
      });
    }

    for (const hint of carDoorHints.slice(0, 50)) {
      if (typeof hint.carNumber !== 'number' || hint.carNumber < 1) {
        violations.push({
          gate: 'GATE_TABLE_COMPLETENESS',
          target: 'station_car_door_hints',
          message: `Invalid carNumber in hint ${JSON.stringify(hint)}: carNumber must be >= 1`,
        });
        break;
      }
      if (typeof hint.doorNumber !== 'number' || hint.doorNumber < 1) {
        violations.push({
          gate: 'GATE_TABLE_COMPLETENESS',
          target: 'station_car_door_hints',
          message: `Invalid doorNumber in hint ${JSON.stringify(hint)}: doorNumber must be >= 1`,
        });
        break;
      }
    }

    if (!Array.isArray(pack.transitRoutes) || pack.transitRoutes.length === 0) {
      violations.push({
        gate: 'GATE_TABLE_COMPLETENESS',
        target: 'transit_routes',
        message: 'transit_routes table is empty. Authentic timetable routes must be present.',
      });
    }
    if (!Array.isArray(pack.transitTrips) || pack.transitTrips.length === 0) {
      violations.push({
        gate: 'GATE_TABLE_COMPLETENESS',
        target: 'transit_trips',
        message: 'transit_trips table is empty. Authentic timetable trips must be present.',
      });
    }
    if (!Array.isArray(pack.transitStopTimes) || pack.transitStopTimes.length === 0) {
      violations.push({
        gate: 'GATE_TABLE_COMPLETENESS',
        target: 'transit_stop_times',
        message: 'transit_stop_times table is empty. Authentic timetable stop times must be present.',
      });
    }
  }

  return violations;
}

// ============================================================================
// Gate 6: Anti-Fake Constants & Unverified Outdoor Links
// ============================================================================
export function checkNoFakeConstants(routeEdges) {
  const violations = [];
  if (!Array.isArray(routeEdges)) return violations;

  let uniform120_50Count = 0;
  let uniform90_50Count = 0;
  let uniform60_50Count = 0;

  for (const edge of routeEdges) {
    const duration = edge.durationSeconds ?? edge.duration_seconds;
    const distance = edge.distanceMeters ?? edge.distance_meters;
    const edgeType = edge.edgeType ?? edge.edge_type;

    if (edgeType === 'TRANSFER' && duration === 120 && distance === 50) uniform120_50Count += 1;
    if (edgeType === 'ENTRY' && duration === 90 && distance === 50) uniform90_50Count += 1;
    if (edgeType === 'EXIT' && duration === 60 && distance === 50) uniform60_50Count += 1;

    if (
      edge.transferType === 'OUTDOOR_WALK' ||
      edge.transfer_type === 'OUTDOOR_WALK' ||
      (edge.id && edge.id.includes('outdoor'))
    ) {
      const surveyedAt = edge.surveyedAt ?? edge.surveyed_at;
      if (typeof surveyedAt === 'number' && surveyedAt > 1750000000) {
        violations.push({
          gate: 'GATE_NO_FAKE_CONSTANTS',
          target: `route_edge[${edge.id || 'outdoor'}]`,
          message: `Outdoor transfer has fabricated future survey timestamp ${surveyedAt}. Must have authentic field verification.`,
        });
      }
      if (
        (edge.stairsStatus === 'NO_STAIRS' || edge.stairs_status === 'NO_STAIRS') &&
        (edge.accessibilityStatus === 'AVAILABLE' || edge.accessibility_status === 'AVAILABLE') &&
        !edge.surveyEvidenceId && !edge.survey_evidence_id
      ) {
        violations.push({
          gate: 'GATE_NO_FAKE_CONSTANTS',
          target: `route_edge[${edge.id || 'outdoor'}]`,
          message: `Outdoor transfer claims NO_STAIRS and AVAILABLE without authentic survey evidence.`,
        });
      }
    }
  }

  if (uniform120_50Count > 10) {
    violations.push({
      gate: 'GATE_NO_FAKE_CONSTANTS',
      target: 'route_edges',
      message: `Detected ${uniform120_50Count} route edges with uniform fake constant (120s, 50m). Authentic walking/transfer measurements required.`,
    });
  }
  if (uniform90_50Count > 10) {
    violations.push({
      gate: 'GATE_NO_FAKE_CONSTANTS',
      target: 'route_edges',
      message: `Detected ${uniform90_50Count} ENTRY edges with uniform fake constant (90s, 50m). Authentic station pathway measurements required.`,
    });
  }
  if (uniform60_50Count > 10) {
    violations.push({
      gate: 'GATE_NO_FAKE_CONSTANTS',
      target: 'route_edges',
      message: `Detected ${uniform60_50Count} EXIT edges with uniform fake constant (60s, 50m). Authentic station pathway measurements required.`,
    });
  }

  return violations;
}

// ============================================================================
// Gate 7: Anti-Synthetic Schedule Loops
// ============================================================================
// 공식 원천 행을 직접 확인한 균일 간격 trip(#899). 원천 id와 원천 행 sha256(trip providerRecordHash)이
// 둘 다 같을 때만 균일 간격 검사에서 뺀다. 원천이 바뀌어 행 hash가 달라지면 다시 검사 대상이 된다.
export const OFFICIAL_UNIFORM_INTERVAL_TRIPS = Object.freeze([
  Object.freeze({
    sourceId: 'kric-nationwide-timetable-file',
    providerRecordHash: 'b0b9d73d2ef49217c9b61018f0a292bd1b23eb4907f38900a30625b295dd0bb9',
    reason: 'KRIC 전체_도시철도운행정보 S1101 평일 907열차 청량리→서울역(24:42~25:00) 10정차가 원천에서 2분 간격이다.',
  }),
]);

function isOfficialUniformIntervalTrip(trip) {
  return OFFICIAL_UNIFORM_INTERVAL_TRIPS.some(({ sourceId, providerRecordHash }) =>
    trip?.sourceId === sourceId && trip?.providerRecordHash === providerRecordHash);
}

export function checkNoSyntheticScheduleLoops(packInput) {
  const pack = packInput?.packs?.[0] ?? packInput ?? {};
  const violations = [];
  const trips = pack.transitTrips ?? [];
  const stopTimes = pack.transitStopTimes ?? [];
  const tripsById = new Map(trips.map((trip) => [trip.id, trip]));

  for (const trip of trips) {
    if (typeof trip.id === 'string' && /-(?:wd|hd)-(?:19800|21600|23400|25200)\b/.test(trip.id)) {
      violations.push({
        gate: 'GATE_NO_SYNTHETIC_SCHEDULE_LOOPS',
        target: `transit_trips[${trip.id}]`,
        message: `Detected synthetic 30-minute schedule loop trip ID: "${trip.id}". Synthetic loops are strictly prohibited.`,
      });
      break;
    }
  }

  if (stopTimes.length > 0) {
    const tripStopTimesMap = new Map();
    for (const st of stopTimes) {
      if (!tripStopTimesMap.has(st.tripId)) tripStopTimesMap.set(st.tripId, []);
      tripStopTimesMap.get(st.tripId).push(st);
    }

    for (const [tripId, stops] of tripStopTimesMap) {
      if (isOfficialUniformIntervalTrip(tripsById.get(tripId))) continue;
      if (stops.length >= 10) {
        let allSameDelta = true;
        const firstDelta = (stops[1].departureTimeSeconds ?? stops[1].departureSeconds ?? stops[1].arrivalTimeSeconds) -
                           (stops[0].departureTimeSeconds ?? stops[0].departureSeconds ?? stops[0].arrivalTimeSeconds);
        if (firstDelta > 0) {
          for (let i = 2; i < stops.length; i++) {
            const delta = (stops[i].departureTimeSeconds ?? stops[i].departureSeconds ?? stops[i].arrivalTimeSeconds) -
                          (stops[i - 1].departureTimeSeconds ?? stops[i - 1].departureSeconds ?? stops[i - 1].arrivalTimeSeconds);
            if (delta !== firstDelta) {
              allSameDelta = false;
              break;
            }
          }
          if (allSameDelta) {
            violations.push({
              gate: 'GATE_NO_SYNTHETIC_SCHEDULE_LOOPS',
              target: `transit_stop_times[${tripId}]`,
              message: `Detected synthetic uniform schedule interval (${firstDelta}s) across all ${stops.length} stops in trip "${tripId}". Authentic station timetable data required.`,
            });
            break;
          }
        }
      }
    }
  }

  return violations;
}

// ============================================================================
// Run Full Audit Suite
// ============================================================================
export function runAntiCheatAudit(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const canonicalPackPath = options.packPath || resolve(repoRoot, 'tools/datapack/release/nationwide-production-canonical-pack.json');
  const routeEdgePath = resolve(repoRoot, 'contracts/datapack/nationwide-route-edge-input.json');

  const allViolations = [];

  // 1. EasyConvert Core Integrity Gates
  allViolations.push(...checkCircularMocking(repoRoot));
  allViolations.push(...checkSilentPassBypasses(repoRoot));
  allViolations.push(...checkHollowAssertions(repoRoot));
  allViolations.push(...checkProductionCheats(repoRoot));
  allViolations.push(...checkCircularOracles(repoRoot));

  // 2. Datapack Domain Integrity Gates
  let pack = null;
  if (existsSync(canonicalPackPath)) {
    try {
      const raw = readFileSync(canonicalPackPath, 'utf8');
      pack = JSON.parse(raw);
    } catch (err) {
      if (options.requirePack) {
        allViolations.push({
          gate: 'GATE_TABLE_COMPLETENESS',
          target: canonicalPackPath,
          message: `Failed to load canonical pack: ${err.message}`,
        });
      }
    }
  }

  // #899: 팩이 sha로 결속한 외부 공식 stop_times까지 펼쳐 검사한다. 결속이 어긋나면 위반이다.
  if (pack) {
    try {
      pack = expandExternalStopTimes(pack, { repositoryRoot: repoRoot });
    } catch (err) {
      allViolations.push({
        gate: 'GATE_TABLE_COMPLETENESS',
        target: canonicalPackPath,
        message: `Failed to bind external stop times: ${err.message}`,
      });
      pack = null;
    }
  }

  if (pack) {
    allViolations.push(...checkTableCompleteness(pack, options));
    allViolations.push(...checkNoSyntheticScheduleLoops(pack));
    if (Array.isArray(pack.routeEdges)) {
      allViolations.push(...checkNoFakeConstants(pack.routeEdges));
    }
  }

  if (existsSync(routeEdgePath)) {
    try {
      const rawEdges = readFileSync(routeEdgePath, 'utf8');
      const edgeData = JSON.parse(rawEdges);
      const edges = Array.isArray(edgeData) ? edgeData : edgeData.routeEdges || [];
      allViolations.push(...checkNoFakeConstants(edges));
    } catch {
      // Ignored if missing
    }
  }

  return allViolations;
}

// CLI Execution
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  console.log('\n🔒 Running EasySubway Anti-Cheat & Test Integrity Guard (EasyConvert Standard)...\n');
  const violations = runAntiCheatAudit();
  if (violations.length > 0) {
    console.error(`\x1b[31m❌ [REJECTED] Found ${violations.length} Anti-Cheat & Test Integrity violation(s):\x1b[0m\n`);
    for (const v of violations) {
      console.error(`  \x1b[33m${v.target}${v.line ? `:${v.line}` : ''}\x1b[0m [\x1b[31m${v.gate}\x1b[0m]`);
      if (v.snippet) console.error(`    Snippet : "${v.snippet}"`);
      console.error(`    Reason  : ${v.message}\n`);
    }
    console.error('\x1b[31mIntegrity check FAILED. Please resolve all violations according to AGENTS.md.\x1b[0m\n');
    process.exit(1);
  } else {
    console.log('\x1b[32m✅ [PASS] Zero shortcuts, zero circular mocks, zero silent passes, zero hollow assertions, all authentic tables verified.\x1b[0m\n');
    process.exit(0);
  }
}
