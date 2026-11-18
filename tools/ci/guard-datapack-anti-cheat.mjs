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

function createTokenizerState(code) {
  return {
    code,
    len: code.length,
    i: 0,
    line: 1,
    braceDepth: 0,
    templateBraceStack: [],
    tokens: [],
  };
}

function countNewlinesInRange(code, start, end) {
  let count = 0;
  for (let p = start; p < end; p++) {
    if (code[p] === '\n') count += 1;
  }
  return count;
}

function skipLineComment(state) {
  const nlIdx = state.code.indexOf('\n', state.i + 2);
  state.i = nlIdx === -1 ? state.len : nlIdx;
}

function skipBlockComment(state) {
  const closeIdx = state.code.indexOf('*/', state.i + 2);
  const endIdx = closeIdx === -1 ? state.len : closeIdx + 2;
  state.line += countNewlinesInRange(state.code, state.i + 2, endIdx);
  state.i = endIdx;
}

function scanTemplateBody(state) {
  const { code, len, tokens } = state;
  const start = state.i;
  let pos = start;
  while (pos < len) {
    const ch = code[pos];
    if (ch === '\\') {
      pos += 2;
      continue;
    }
    if (ch === '$' && code[pos + 1] === '{') {
      state.line += countNewlinesInRange(code, start, pos);
      tokens.push(
        { type: 'string', value: code.slice(start, pos), start, end: pos, line: state.line },
        { type: 'punct', value: '(', start: pos, end: pos + 2, line: state.line },
      );
      state.i = pos + 2;
      state.templateBraceStack.push(state.braceDepth);
      return;
    }
    if (ch === '`') {
      const endPos = pos + 1;
      state.line += countNewlinesInRange(code, start, endPos);
      tokens.push(
        { type: 'string', value: code.slice(start, endPos), start, end: endPos, line: state.line },
        { type: 'punct', value: ')', start: pos, end: endPos, line: state.line },
      );
      state.i = endPos;
      return;
    }
    pos += 1;
  }
  state.line += countNewlinesInRange(code, start, len);
  state.i = len;
  tokens.push({ type: 'punct', value: ')', start: len, end: len, line: state.line });
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'throw', 'case', 'typeof', 'void', 'delete',
  'await', 'yield', 'in', 'of', 'instanceof', 'new', 'else', 'do',
]);
const REGEX_DISALLOWED_PREV_PUNCTS = new Set([')', ']', '++', '--']);

function canStartRegex(tokens) {
  const prev = tokens.at(-1);
  if (!prev) return true;
  if (prev.type === 'punct') {
    return !REGEX_DISALLOWED_PREV_PUNCTS.has(prev.value);
  }
  return prev.type === 'id' && REGEX_PRECEDING_KEYWORDS.has(prev.value);
}

function readQuotedString(state) {
  const { code, len } = state;
  const start = state.i;
  const startLine = state.line;
  const quote = code[start];
  let pos = start + 1;
  while (pos < len) {
    const c = code[pos];
    if (c === '\\') {
      pos += 2;
      continue;
    }
    pos += 1;
    if (c === quote) break;
  }
  const endPos = Math.min(pos, len);
  state.line += countNewlinesInRange(code, start, endPos);
  state.i = endPos;
  state.tokens.push({ type: 'string', value: code.slice(start, endPos), start, end: endPos, line: startLine });
}

function findRegexBodyEnd(code, startPos, len) {
  let pos = startPos;
  let inClass = false;
  while (pos < len) {
    const c = code[pos];
    if (c === '\n') break;
    pos += 1;
    if (c === '\\') {
      if (code[pos] !== '\n') pos = Math.min(len, pos + 1);
    } else if (c === '/' && !inClass) {
      return pos;
    } else if (c === '[') {
      inClass = true;
    } else if (c === ']') {
      inClass = false;
    }
  }
  return pos;
}

function readRegexLiteral(state) {
  const { code, len } = state;
  const start = state.i;
  const startLine = state.line;
  let pos = findRegexBodyEnd(code, start + 1, len);
  if (pos <= len && code[pos - 1] === '/') {
    while (pos < len && /[a-z]/i.test(code[pos])) pos += 1;
  }
  state.i = pos;
  state.tokens.push({ type: 'literal', value: code.slice(start, pos), start, end: pos, line: startLine });
}

function readNumberLiteral(state) {
  const { code, len } = state;
  const start = state.i;
  let pos = start + 1;
  while (pos < len && /[\da-fA-FxXoOn_.]/.test(code[pos])) pos += 1;
  state.i = pos;
  state.tokens.push({ type: 'literal', value: code.slice(start, pos), start, end: pos, line: state.line });
}

function readIdentifier(state) {
  const { code, len } = state;
  const start = state.i;
  let pos = start + 1;
  while (pos < len && /[\w$]/.test(code[pos])) pos += 1;
  state.i = pos;
  state.tokens.push({ type: 'id', value: code.slice(start, pos), start, end: pos, line: state.line });
}

const MULTI_PUNCTS = [
  '===', '!==', '>>>', '...', '==', '!=', '<=', '>=', '=>',
  '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>',
];

function handleCloseBrace(state) {
  const start = state.i;
  state.i += 1;
  if (state.templateBraceStack.length > 0 && state.braceDepth === state.templateBraceStack.at(-1)) {
    state.templateBraceStack.pop();
    state.tokens.push(
      { type: 'punct', value: ')', start, end: state.i, line: state.line },
      { type: 'punct', value: ',', start, end: state.i, line: state.line },
    );
    scanTemplateBody(state);
    return;
  }
  state.braceDepth = Math.max(0, state.braceDepth - 1);
  state.tokens.push({ type: 'punct', value: '}', start, end: state.i, line: state.line });
}

function readPunctuation(state) {
  const { code, i: start, line } = state;
  if (code[start] === '{') {
    state.i += 1;
    state.braceDepth += 1;
    state.tokens.push({ type: 'punct', value: '{', start, end: state.i, line });
    return;
  }
  if (code[start] === '}') {
    handleCloseBrace(state);
    return;
  }
  for (const mp of MULTI_PUNCTS) {
    if (code.startsWith(mp, start)) {
      state.i += mp.length;
      state.tokens.push({ type: 'punct', value: mp, start, end: state.i, line });
      return;
    }
  }
  state.i += 1;
  state.tokens.push({ type: 'punct', value: code[start], start, end: state.i, line });
}

function isWhitespaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function skipWhitespace(state, ch) {
  if (ch === '\n') state.line += 1;
  state.i += 1;
}

function tokenizeSlash(state) {
  const nextCh = state.code[state.i + 1];
  if (nextCh === '/') {
    skipLineComment(state);
  } else if (nextCh === '*') {
    skipBlockComment(state);
  } else if (canStartRegex(state.tokens)) {
    readRegexLiteral(state);
  } else {
    readPunctuation(state);
  }
}

function tokenizeJs(code) {
  const state = createTokenizerState(code);
  while (state.i < state.len) {
    const ch = code[state.i];
    if (isWhitespaceChar(ch)) {
      skipWhitespace(state, ch);
    } else if (ch === '/') {
      tokenizeSlash(state);
    } else if (ch === "'" || ch === '"') {
      readQuotedString(state);
    } else if (ch === '`') {
      const start = state.i;
      state.i += 1;
      state.tokens.push({ type: 'punct', value: '(', start, end: state.i, line: state.line });
      scanTemplateBody(state);
    } else if (/\d/.test(ch)) {
      readNumberLiteral(state);
    } else if (/[A-Za-z_$]/.test(ch)) {
      readIdentifier(state);
    } else {
      readPunctuation(state);
    }
  }
  return state.tokens;
}

const MATCHING_CLOSE_PUNCT = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);

function findMatchingClose(tokens, openIdx) {
  const openVal = tokens[openIdx]?.value;
  const closeVal = MATCHING_CLOSE_PUNCT.get(openVal);
  if (!closeVal) return -1;
  let depth = 1;
  for (let i = openIdx + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== 'punct') continue;
    if (tok.value === openVal) {
      depth += 1;
    } else if (tok.value === closeVal) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const OPEN_BRACKETS = new Set(['(', '[', '{']);
const CLOSE_BRACKETS = new Set([')', ']', '}']);

function updateBracketDepth(tok, depth) {
  if (tok.type !== 'punct') return depth;
  if (OPEN_BRACKETS.has(tok.value)) return depth + 1;
  if (CLOSE_BRACKETS.has(tok.value)) return Math.max(0, depth - 1);
  return depth;
}

function splitTopLevelItems(tokens, startIdx, endIdx, delimiter = ',') {
  const ranges = [];
  let itemStart = startIdx;
  let depth = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const t = tokens[i];
    if (depth === 0 && t.type === 'punct' && t.value === delimiter) {
      ranges.push([itemStart, i]);
      itemStart = i + 1;
    } else {
      depth = updateBracketDepth(t, depth);
    }
  }
  ranges.push([itemStart, endIdx]);
  return ranges;
}

function extractNamesFromPatternItem(tokens, iStart, iEnd, isObj) {
  if (iStart >= iEnd) return [];
  const [lhsStart, lhsEnd] = splitTopLevelItems(tokens, iStart, iEnd, '=')[0];
  if (lhsStart >= lhsEnd) return [];
  if (tokens[lhsStart].type === 'punct' && tokens[lhsStart].value === '...') {
    return extractBoundNamesFromPattern(tokens, lhsStart + 1).names;
  }
  if (!isObj) {
    return extractBoundNamesFromPattern(tokens, lhsStart).names;
  }
  const colonParts = splitTopLevelItems(tokens, lhsStart, lhsEnd, ':');
  if (colonParts.length > 1) {
    return extractBoundNamesFromPattern(tokens, colonParts[1][0]).names;
  }
  return tokens[lhsStart].type === 'id' ? [tokens[lhsStart].value] : [];
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
    const isObj = first.value === '{';
    const items = splitTopLevelItems(tokens, startIdx + 1, closeIdx, ',');
    const names = items.flatMap(([iStart, iEnd]) => extractNamesFromPatternItem(tokens, iStart, iEnd, isObj));
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

function isContinuationToken(tok, punctSet, idSet) {
  if (tok.type === 'punct') return punctSet.has(tok.value);
  if (tok.type === 'id') return idSet.has(tok.value);
  return false;
}

function isNewlineStatementBoundary(currTok, nextTok) {
  if (!nextTok || nextTok.line <= currTok.line) return false;
  return (
    !isContinuationToken(currTok, PREV_CONTINUES_PUNCTS, PREV_CONTINUES_IDS) &&
    !isContinuationToken(nextTok, NEXT_CONTINUES_PUNCTS, NEXT_CONTINUES_IDS)
  );
}

function stepExpressionToken(tok, depth) {
  if (tok.type !== 'punct') return { depth, stop: false };
  if (OPEN_BRACKETS.has(tok.value)) return { depth: depth + 1, stop: false };
  if (CLOSE_BRACKETS.has(tok.value)) {
    return depth === 0 ? { depth: 0, stop: true } : { depth: depth - 1, stop: false };
  }
  if (depth === 0 && (tok.value === ';' || tok.value === ',')) {
    return { depth: 0, stop: true };
  }
  return { depth, stop: false };
}

function findExpressionEnd(tokens, startIdx) {
  let depth = 0;
  for (let k = startIdx; k < tokens.length; k++) {
    const step = stepExpressionToken(tokens[k], depth);
    if (step.stop) return k;
    depth = step.depth;
    if (depth === 0 && isNewlineStatementBoundary(tokens[k], tokens[k + 1])) {
      return k + 1;
    }
  }
  return tokens.length;
}

function isIgnoredImportPath(importPath) {
  if (!importPath.startsWith('./') && !importPath.startsWith('../')) return true;
  return (
    importPath.includes('.test.mjs') ||
    importPath.includes('fixtures') ||
    importPath.includes('test-support')
  );
}

function findImportFromIndex(tokens, startIdx) {
  let k = startIdx;
  while (k < tokens.length) {
    const tok = tokens[k];
    if (tok.type === 'punct' && tok.value === '{') {
      const closeBrace = findMatchingClose(tokens, k);
      if (closeBrace === -1) return -1;
      k = closeBrace + 1;
      continue;
    }
    if (tok.value === ';') return -1;
    if (tok.type === 'id' && tok.value === 'from' && tokens[k + 1]?.type === 'string') {
      return k;
    }
    k += 1;
  }
  return -1;
}

function collectNamedImportSpecs(tokens, openBraceIdx, closeBraceIdx, testRelPosix, importPath, importedProdFns) {
  const items = splitTopLevelItems(tokens, openBraceIdx + 1, closeBraceIdx, ',');
  for (const [s, e] of items) {
    if (s >= e || tokens[s].type !== 'id') continue;
    const importedName = tokens[s].value;
    if (isSharedHelperImport(testRelPosix, importPath, importedName)) continue;
    const hasAlias = s + 2 < e && tokens[s + 1].value === 'as' && tokens[s + 2].type === 'id';
    const localName = hasAlias ? tokens[s + 2].value : importedName;
    importedProdFns.set(localName, importedName);
  }
}

function parseImportClauseTokens(tokens, clauseStart, fromIdx, testRelPosix, importPath, importedProdFns, importedNamespaces) {
  const first = tokens[clauseStart];
  if (first?.type === 'id' && first.value !== 'type' && !isSharedHelperImport(testRelPosix, importPath, first.value)) {
    importedProdFns.set(first.value, first.value);
  }
  let k = clauseStart;
  while (k < fromIdx) {
    if (tokens[k].value === '*' && tokens[k + 1]?.value === 'as' && tokens[k + 2]?.type === 'id') {
      importedNamespaces.set(tokens[k + 2].value, importPath);
    } else if (tokens[k].type === 'punct' && tokens[k].value === '{') {
      const closeBrace = findMatchingClose(tokens, k);
      if (closeBrace !== -1) {
        collectNamedImportSpecs(tokens, k, closeBrace, testRelPosix, importPath, importedProdFns);
        k = closeBrace;
      }
    }
    k += 1;
  }
}

function isStaticImportStart(tokens, idx) {
  if (tokens[idx].type !== 'id' || tokens[idx].value !== 'import') return false;
  const prevVal = tokens[idx - 1]?.value;
  const nextVal = tokens[idx + 1]?.value;
  return prevVal !== '.' && prevVal !== '?.' && nextVal !== '(' && nextVal !== '.';
}

function collectImportedBindings(tokens, testRelPosix) {
  const importedProdFns = new Map();
  const importedNamespaces = new Map();
  let idx = 0;
  while (idx < tokens.length) {
    if (!isStaticImportStart(tokens, idx)) {
      idx += 1;
      continue;
    }
    const fromIdx = findImportFromIndex(tokens, idx + 1);
    if (fromIdx === -1) {
      idx += 1;
      continue;
    }
    const importPath = tokens[fromIdx + 1].value.slice(1, -1);
    if (!isIgnoredImportPath(importPath)) {
      parseImportClauseTokens(tokens, idx + 1, fromIdx, testRelPosix, importPath, importedProdFns, importedNamespaces);
    }
    idx = fromIdx + 2;
  }
  return { importedProdFns, importedNamespaces };
}

function lookupScopeEntry(scopeStack, mapKey, name) {
  for (let s = scopeStack.length - 1; s >= 0; s--) {
    const map = scopeStack[s][mapKey];
    if (map.has(name)) return map.get(name);
  }
  return null;
}

function applyScopeBinding(scope, name, sourceMap, aliasSet, litSig) {
  scope.vars.set(name, sourceMap);
  if (aliasSet) scope.fnAliases.set(name, aliasSet);
  else scope.fnAliases.delete(name);
  if (litSig) scope.literalTokens.set(name, litSig);
  else scope.literalTokens.delete(name);
}

function setExistingOrCurrentVar(scopeStack, name, sourceMap, litSig = null) {
  for (let s = scopeStack.length - 1; s >= 0; s--) {
    if (scopeStack[s].vars.has(name)) {
      applyScopeBinding(scopeStack[s], name, sourceMap, scopeStack[s].fnAliases.get(name) ?? null, litSig);
      return;
    }
  }
  const top = scopeStack.at(-1);
  applyScopeBinding(top, name, sourceMap, top.fnAliases.get(name) ?? null, litSig);
}

function isPropertyAccessToken(prevTok) {
  return prevTok?.type === 'punct' && (prevTok.value === '.' || prevTok.value === '?.');
}

function isObjectPropertyKeyToken(prevTok, nextTok) {
  if (nextTok?.type !== 'punct' || nextTok.value !== ':') return false;
  return prevTok?.type === 'punct' && (prevTok.value === '{' || prevTok.value === ',');
}

function resolveCallArgTokenValue(ctx, tok, prevTok, nextTok) {
  if (tok.type === 'id' && !isPropertyAccessToken(prevTok) && !isObjectPropertyKeyToken(prevTok, nextTok)) {
    const lit = lookupScopeEntry(ctx.scopeStack, 'literalTokens', tok.value);
    if (lit) return lit;
  }
  return tok.value;
}

function buildCallOrigin(ctx, callTokenIdx, openParenIdx) {
  const { tokens } = ctx;
  const closeParenIdx = findMatchingClose(tokens, openParenIdx);
  if (closeParenIdx === -1) return `${callTokenIdx}:`;
  const parts = [];
  for (let p = openParenIdx + 1; p < closeParenIdx; p++) {
    const prev = p > openParenIdx + 1 ? tokens[p - 1] : null;
    const next = p + 1 < closeParenIdx ? tokens[p + 1] : null;
    parts.push(resolveCallArgTokenValue(ctx, tokens[p], prev, next));
  }
  return `${callTokenIdx}:${parts.join(' ')}`;
}

function addSourceOrigin(sources, fnName, origin) {
  if (!sources.has(fnName)) sources.set(fnName, new Set());
  sources.get(fnName).add(origin);
}

function mergeSourceMaps(target, incoming) {
  for (const [fnName, origins] of incoming.entries()) {
    for (const origin of origins) {
      addSourceOrigin(target, fnName, origin);
    }
  }
}

function findBraceBodyAfterParen(tokens, openParenIdx) {
  if (tokens[openParenIdx]?.type !== 'punct' || tokens[openParenIdx].value !== '(') return null;
  const closeParen = findMatchingClose(tokens, openParenIdx);
  if (closeParen === -1 || tokens[closeParen + 1]?.type !== 'punct' || tokens[closeParen + 1].value !== '{') {
    return null;
  }
  const closeBrace = findMatchingClose(tokens, closeParen + 1);
  return closeBrace === -1 ? null : [closeParen + 1, closeBrace];
}

function detectNestedFunctionInterval(tokens, k) {
  const tok = tokens[k];
  if (tok.type === 'punct' && tok.value === '=>') {
    if (tokens[k + 1]?.type === 'punct' && tokens[k + 1].value === '{') {
      const closeBrace = findMatchingClose(tokens, k + 1);
      return closeBrace === -1 ? null : [k + 1, closeBrace];
    }
    return [k + 1, findExpressionEnd(tokens, k + 1)];
  }
  if (tok.type === 'id' && tok.value === 'function') {
    const parenIdx = tokens[k + 1]?.type === 'id' ? k + 2 : k + 1;
    return findBraceBodyAfterParen(tokens, parenIdx);
  }
  const prevVal = tokens[k - 1]?.value;
  if (tok.type === 'id' && (prevVal === '{' || prevVal === ',')) {
    return findBraceBodyAfterParen(tokens, k + 1);
  }
  return null;
}

function collectArrowParamsAt(tokens, k, endIdx, arrowParams) {
  const tok = tokens[k];
  if (tok.type === 'id' && tokens[k + 1]?.type === 'punct' && tokens[k + 1].value === '=>') {
    arrowParams.add(tok.value);
    return;
  }
  if (tok.type !== 'punct' || tok.value !== '(') return;
  const closeParen = findMatchingClose(tokens, k);
  if (closeParen === -1 || closeParen >= endIdx || tokens[closeParen + 1]?.value !== '=>') return;
  for (let p = k + 1; p < closeParen; p++) {
    if (tokens[p].type === 'id') arrowParams.add(tokens[p].value);
  }
}

function scanExpressionFunctionsAndParams(tokens, startIdx, endIdx) {
  const arrowParams = new Set();
  const fnBodyIntervals = [];
  for (let k = startIdx; k < endIdx; k++) {
    const interval = detectNestedFunctionInterval(tokens, k);
    if (interval) fnBodyIntervals.push(interval);
    collectArrowParamsAt(tokens, k, endIdx, arrowParams);
  }
  return { arrowParams, fnBodyIntervals };
}

function isPositionInIntervals(pos, intervals) {
  for (const [s, e] of intervals) {
    if (pos >= s && pos <= e) return true;
  }
  return false;
}

function handlePropertyAccessCall(ctx, k, startIdx, sources, prodCallArgIntervals) {
  const { tokens, importedNamespaces, testRelPosix } = ctx;
  const closeParen = findMatchingClose(tokens, k + 1);
  if (closeParen !== -1) prodCallArgIntervals.push([k + 1, closeParen]);
  const objTok = k - 2 >= startIdx ? tokens[k - 2] : null;
  const beforeObjTok = k - 3 >= startIdx ? tokens[k - 3] : null;
  if (objTok?.type === 'id' && !isPropertyAccessToken(beforeObjTok) && importedNamespaces.has(objTok.value)) {
    const importPath = importedNamespaces.get(objTok.value);
    const fnName = tokens[k].value;
    if (!isSharedHelperImport(testRelPosix, importPath, fnName)) {
      addSourceOrigin(sources, fnName, buildCallOrigin(ctx, k, k + 1));
    }
  }
}

function resolveDirectCallTargets(ctx, fnIdent) {
  if (ctx.importedProdFns.has(fnIdent)) {
    return [ctx.importedProdFns.get(fnIdent)];
  }
  const aliased = lookupScopeEntry(ctx.scopeStack, 'fnAliases', fnIdent);
  return aliased ? [...aliased] : [];
}

function tryRecordDirectProdCall(ctx, k, sources, prodCallArgIntervals) {
  const targets = resolveDirectCallTargets(ctx, ctx.tokens[k].value);
  if (targets.length === 0) return false;
  const origin = buildCallOrigin(ctx, k, k + 1);
  for (const fn of targets) {
    addSourceOrigin(sources, fn, origin);
  }
  const closeParen = findMatchingClose(ctx.tokens, k + 1);
  if (closeParen !== -1) prodCallArgIntervals.push([k + 1, closeParen]);
  return true;
}

function evaluateTokenSourceAt(ctx, k, startIdx, endIdx, arrowParams, sources, prodCallArgIntervals) {
  const { tokens } = ctx;
  const tok = tokens[k];
  if (tok.type !== 'id' || arrowParams.has(tok.value)) return;
  const prev = k > startIdx ? tokens[k - 1] : null;
  const next = k + 1 < endIdx ? tokens[k + 1] : null;

  if (isPropertyAccessToken(prev)) {
    if (next?.type === 'punct' && next.value === '(') {
      handlePropertyAccessCall(ctx, k, startIdx, sources, prodCallArgIntervals);
    }
    return;
  }
  if (isObjectPropertyKeyToken(prev, next)) return;
  if (next?.type === 'punct' && next.value === '(' && tryRecordDirectProdCall(ctx, k, sources, prodCallArgIntervals)) {
    return;
  }
  const boundSources = lookupScopeEntry(ctx.scopeStack, 'vars', tok.value);
  if (boundSources?.size > 0) {
    mergeSourceMaps(sources, boundSources);
  }
}

function evaluateExpressionSources(ctx, startIdx, endIdx) {
  const sources = new Map();
  const prodCallArgIntervals = [];
  const { arrowParams, fnBodyIntervals } = scanExpressionFunctionsAndParams(ctx.tokens, startIdx, endIdx);

  for (let k = startIdx; k < endIdx; k++) {
    if (isPositionInIntervals(k, fnBodyIntervals) || isPositionInIntervals(k, prodCallArgIntervals)) continue;
    evaluateTokenSourceAt(ctx, k, startIdx, endIdx, arrowParams, sources, prodCallArgIntervals);
  }
  return sources;
}

function resolveAliasTargets(ctx, startIdx, endIdx) {
  const { tokens, importedProdFns, importedNamespaces, testRelPosix, scopeStack } = ctx;
  if (endIdx - startIdx === 1 && tokens[startIdx].type === 'id') {
    const idName = tokens[startIdx].value;
    if (importedProdFns.has(idName)) return new Set([importedProdFns.get(idName)]);
    const existingAlias = lookupScopeEntry(scopeStack, 'fnAliases', idName);
    return existingAlias?.size > 0 ? new Set(existingAlias) : null;
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
}

function extractPureLiteralSignature(tokens, startIdx, endIdx, rhsSources) {
  if (rhsSources.size > 0 || endIdx <= startIdx) return null;
  const parts = [];
  for (let p = startIdx; p < endIdx; p++) {
    parts.push(tokens[p].value);
  }
  return parts.join(' ');
}

function bindDeclaratorClause(ctx, currentScope, names, nextIdx) {
  const { tokens } = ctx;
  if (tokens[nextIdx]?.type !== 'punct' || tokens[nextIdx].value !== '=') {
    for (const name of names) {
      applyScopeBinding(currentScope, name, new Map(), null, null);
    }
    return nextIdx;
  }
  const rhsStart = nextIdx + 1;
  const rhsEnd = findExpressionEnd(tokens, rhsStart);
  const rhsSources = evaluateExpressionSources(ctx, rhsStart, rhsEnd);
  const aliasSet = names.length === 1 ? resolveAliasTargets(ctx, rhsStart, rhsEnd) : null;
  const litSig = names.length === 1 ? extractPureLiteralSignature(tokens, rhsStart, rhsEnd, rhsSources) : null;
  for (const name of names) {
    applyScopeBinding(currentScope, name, rhsSources, aliasSet, litSig);
  }
  return rhsEnd;
}

function processDeclarationList(ctx, startDeclIdx) {
  const { tokens } = ctx;
  const currentScope = ctx.scopeStack.at(-1);
  let declIdx = startDeclIdx;
  while (declIdx < tokens.length) {
    const { names, nextIdx } = extractBoundNamesFromPattern(tokens, declIdx);
    if (names.length === 0) break;
    declIdx = bindDeclaratorClause(ctx, currentScope, names, nextIdx);
    if (tokens[declIdx]?.type !== 'punct' || tokens[declIdx].value !== ',') break;
    declIdx += 1;
  }
}

function isSimpleVariableAssignment(tokens, idx) {
  if (tokens[idx].type !== 'id') return false;
  if (tokens[idx + 1]?.type !== 'punct' || tokens[idx + 1].value !== '=') return false;
  return !isPropertyAccessToken(tokens[idx - 1]);
}

function processVariableAssignment(ctx, idx) {
  const { tokens } = ctx;
  const varName = tokens[idx].value;
  const rhsStart = idx + 2;
  const rhsEnd = findExpressionEnd(tokens, rhsStart);
  const rhsSources = evaluateExpressionSources(ctx, rhsStart, rhsEnd);
  const litSig = extractPureLiteralSignature(tokens, rhsStart, rhsEnd, rhsSources);
  setExistingOrCurrentVar(ctx.scopeStack, varName, rhsSources, litSig);
  const aliasSet = resolveAliasTargets(ctx, rhsStart, rhsEnd);
  if (aliasSet) {
    ctx.scopeStack.at(-1).fnAliases.set(varName, aliasSet);
  }
}

const ASSERT_EQUALITY_METHODS = new Set(['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual']);

function isAssertEqualityCall(tokens, idx) {
  return (
    tokens[idx].type === 'id' &&
    tokens[idx].value === 'assert' &&
    tokens[idx + 1]?.type === 'punct' &&
    tokens[idx + 1].value === '.' &&
    tokens[idx + 2]?.type === 'id' &&
    ASSERT_EQUALITY_METHODS.has(tokens[idx + 2].value) &&
    tokens[idx + 3]?.type === 'punct' &&
    tokens[idx + 3].value === '('
  );
}

function splitOrigin(origin) {
  const colonPos = origin.indexOf(':');
  return {
    callId: origin.slice(0, colonPos),
    argSig: origin.slice(colonPos + 1),
  };
}

function hasUnverifiedMatchingCallOrigin(originsA, originsB, verifiedOrigins) {
  for (const originA of originsA) {
    if (verifiedOrigins.has(originA)) continue;
    const parsedA = splitOrigin(originA);
    for (const originB of originsB) {
      if (verifiedOrigins.has(originB)) continue;
      const parsedB = splitOrigin(originB);
      if (parsedA.callId !== parsedB.callId && parsedA.argSig === parsedB.argSig) {
        return true;
      }
    }
  }
  return false;
}

function findCircularFunctions(sourcesA, sourcesB, verifiedOrigins) {
  const circularFns = [];
  for (const [fn, originsA] of sourcesA.entries()) {
    const originsB = sourcesB.get(fn);
    if (originsB && hasUnverifiedMatchingCallOrigin(originsA, originsB, verifiedOrigins)) {
      circularFns.push(fn);
    }
  }
  return circularFns;
}

function findPreviousNonEmptyLine(content, startIndex) {
  const lines = content.slice(0, startIndex).split('\n');
  for (let l = lines.length - 2; l >= 0; l--) {
    const trimmed = lines[l].trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

function hasCircularOracleAllowComment(content, startIndex) {
  const prevLine = findPreviousNonEmptyLine(content, startIndex);
  if (!prevLine.startsWith('//')) return false;
  const commentBody = prevLine.slice(2).trimStart();
  if (!commentBody.startsWith('anti-cheat-allow:')) return false;
  const afterColon = commentBody.slice('anti-cheat-allow:'.length).trimStart();
  if (!afterColon.startsWith('circular-oracle')) return false;
  const rest = afterColon.slice('circular-oracle'.length).trim();
  if (!rest.startsWith('--')) return false;
  return rest.slice(2).trim().length > 0;
}

function markExpressionOriginsVerified(verifiedOrigins, sources) {
  for (const origins of sources.values()) {
    for (const origin of origins) {
      verifiedOrigins.add(origin);
    }
  }
}

function processAssertEqualityCall(ctx, idx, fileViolations) {
  const { tokens, content, rel, verifiedOrigins } = ctx;
  const openParenIdx = idx + 3;
  const closeParenIdx = findMatchingClose(tokens, openParenIdx);
  if (closeParenIdx === -1) return;

  const argRanges = splitTopLevelItems(tokens, openParenIdx + 1, closeParenIdx, ',');
  if (argRanges.length < 2) return;

  const [argAStart, argAEnd] = argRanges[0];
  const [argBStart, argBEnd] = argRanges[1];
  const sourcesA = evaluateExpressionSources(ctx, argAStart, argAEnd);
  const sourcesB = evaluateExpressionSources(ctx, argBStart, argBEnd);
  const circularFns = findCircularFunctions(sourcesA, sourcesB, verifiedOrigins);

  if (circularFns.length === 0 || hasCircularOracleAllowComment(content, tokens[idx].start)) {
    markExpressionOriginsVerified(verifiedOrigins, sourcesA);
    markExpressionOriginsVerified(verifiedOrigins, sourcesB);
    return;
  }

  const startIndex = tokens[idx].start;
  const endIndex = tokens[closeParenIdx].end;
  const { line, snippet } = getLineAndSnippet(content, startIndex, endIndex - startIndex);
  fileViolations.push({
    gate: 'ANTI-CIRCULAR-ORACLE',
    target: rel,
    line,
    snippet,
    message: `Circular oracle detected: assertion compares results produced by the same production function "${circularFns.join(', ')}". Use independent golden expected values or independent oracles.`,
  });
}

const VAR_DECL_KEYWORDS = new Set(['const', 'let', 'var']);

function createOracleAnalysisContext(content, rel, tokens, testRelPosix, importedProdFns, importedNamespaces) {
  return {
    content,
    rel,
    tokens,
    testRelPosix,
    importedProdFns,
    importedNamespaces,
    scopeStack: [{ vars: new Map(), fnAliases: new Map(), literalTokens: new Map() }],
    verifiedOrigins: new Set(),
  };
}

function stepOracleScopeBrace(scopeStack, tok) {
  if (tok.value === '{') {
    scopeStack.push({ vars: new Map(), fnAliases: new Map(), literalTokens: new Map() });
    return true;
  }
  if (tok.value === '}') {
    if (scopeStack.length > 1) scopeStack.pop();
    return true;
  }
  return false;
}

function checkFileCircularOracles(content, rel, fileViolations) {
  if (!content.includes('import')) return;
  const testRelPosix = rel.replaceAll(sep, '/');
  const tokens = tokenizeJs(content);
  const { importedProdFns, importedNamespaces } = collectImportedBindings(tokens, testRelPosix);
  if (importedProdFns.size === 0 && importedNamespaces.size === 0) return;

  const ctx = createOracleAnalysisContext(content, rel, tokens, testRelPosix, importedProdFns, importedNamespaces);

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok.type === 'punct' && stepOracleScopeBrace(ctx.scopeStack, tok)) {
      continue;
    }
    if (tok.type === 'id' && VAR_DECL_KEYWORDS.has(tok.value)) {
      processDeclarationList(ctx, idx + 1);
    } else if (isSimpleVariableAssignment(tokens, idx)) {
      processVariableAssignment(ctx, idx);
    } else if (isAssertEqualityCall(tokens, idx)) {
      processAssertEqualityCall(ctx, idx, fileViolations);
    }
  }
}

function collectTestFilesForCircularOracle(dir, repoRoot, violations) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') {
        collectTestFilesForCircularOracle(fullPath, repoRoot, violations);
      }
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      const rel = relative(repoRoot, fullPath);
      if (!rel.includes('guard-datapack-anti-cheat')) {
        checkFileCircularOracles(readFileSync(fullPath, 'utf8'), rel, violations);
      }
    }
  }
}

export function checkCircularOracles(repoRoot = REPO_ROOT) {
  const violations = [];
  const toolsDir = resolve(repoRoot, 'tools');
  if (!existsSync(toolsDir)) return violations;
  collectTestFilesForCircularOracle(toolsDir, repoRoot, violations);
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
