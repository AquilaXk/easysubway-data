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
import { resolve, join, relative } from 'node:path';
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

  function checkFileCircularOracles(content, rel, fileViolations) {
    const importedProdFns = new Set();
    const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/gs;
    let importMatch;
    while ((importMatch = importRegex.exec(content)) !== null) {
      const importSpecifiers = importMatch[1];
      const importPath = importMatch[2];
      if (importPath.includes('.test.mjs') || importPath.includes('fixtures') || importPath.includes('test-support')) {
        continue;
      }
      const specs = importSpecifiers.split(',');
      for (const spec of specs) {
        const trimmed = spec.trim();
        if (!trimmed) continue;
        if (trimmed.includes(' as ')) {
          const parts = trimmed.split(/\s+as\s+/);
          importedProdFns.add(parts[1].trim());
        } else {
          importedProdFns.add(trimmed);
        }
      }
    }
    if (importedProdFns.size === 0) return;

    const varToFnMap = new Map();
    const constRegex = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g;
    let constMatch;
    while ((constMatch = constRegex.exec(content)) !== null) {
      const varName = constMatch[1];
      const rightExpr = constMatch[2];
      for (const fnName of importedProdFns) {
        const callRegex = new RegExp(`\\b${fnName}\\s*\\(`);
        if (callRegex.test(rightExpr)) {
          varToFnMap.set(varName, fnName);
          break;
        }
      }
    }

    const assertRegex = /assert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(/g;
    let assertMatch;
    while ((assertMatch = assertRegex.exec(content)) !== null) {
      const startIndex = assertMatch.index;
      const argsStartIndex = assertMatch.index + assertMatch[0].length;

      let depth = 1;
      let i = argsStartIndex;
      let inString = false;
      let stringChar = '';
      let escape = false;

      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (inString) {
          if (ch === stringChar) inString = false;
        } else if (ch === "'" || ch === '"' || ch === '`') {
          inString = true;
          stringChar = ch;
        } else if (ch === '(' || ch === '[' || ch === '{') {
          depth++;
        } else if (ch === ')' || ch === ']' || ch === '}') {
          depth--;
        }
        i++;
      }

      if (depth !== 0) continue;
      const argsContent = content.slice(argsStartIndex, i - 1);

      let splitDepth = 0;
      let inStr = false;
      let strCh = '';
      let esc = false;
      let commaIndex = -1;

      for (let j = 0; j < argsContent.length; j++) {
        const c = argsContent[j];
        if (esc) {
          esc = false;
        } else if (c === '\\') {
          esc = true;
        } else if (inStr) {
          if (c === strCh) inStr = false;
        } else if (c === "'" || c === '"' || c === '`') {
          inStr = true;
          strCh = c;
        } else if (c === '(' || c === '[' || c === '{') {
          splitDepth++;
        } else if (c === ')' || c === ']' || c === '}') {
          splitDepth--;
        } else if (c === ',' && splitDepth === 0) {
          commaIndex = j;
          break;
        }
      }

      if (commaIndex === -1) continue;
      const argA = argsContent.slice(0, commaIndex).trim();

      const remainingArgs = argsContent.slice(commaIndex + 1);
      let secondCommaIndex = -1;
      let bDepth = 0;
      let bInStr = false;
      let bStrCh = '';
      let bEsc = false;

      for (let k = 0; k < remainingArgs.length; k++) {
        const c = remainingArgs[k];
        if (bEsc) {
          bEsc = false;
        } else if (c === '\\') {
          bEsc = true;
        } else if (bInStr) {
          if (c === bStrCh) bInStr = false;
        } else if (c === "'" || c === '"' || c === '`') {
          bInStr = true;
          bStrCh = c;
        } else if (c === '(' || c === '[' || c === '{') {
          bDepth++;
        } else if (c === ')' || c === ']' || c === '}') {
          bDepth--;
        } else if (c === ',' && bDepth === 0) {
          secondCommaIndex = k;
          break;
        }
      }

      const argB = (secondCommaIndex !== -1 ? remainingArgs.slice(0, secondCommaIndex) : remainingArgs).trim();

      function stripStrings(code) {
        let out = '';
        let sInStr = false;
        let sQuote = '';
        let sEsc = false;
        for (let idx = 0; idx < code.length; idx++) {
          const ch = code[idx];
          if (sEsc) { sEsc = false; continue; }
          if (ch === '\\') { sEsc = true; continue; }
          if (sInStr) {
            if (ch === sQuote) sInStr = false;
            continue;
          }
          if (ch === "'" || ch === '"' || ch === '`') {
            sInStr = true;
            sQuote = ch;
            continue;
          }
          out += ch;
        }
        return out;
      }

      const cleanA = stripStrings(argA);
      const cleanB = stripStrings(argB);

      function getSources(cleanText) {
        const sources = new Map();
        for (const fn of importedProdFns) {
          const r = new RegExp(`\\b${fn}\\s*\\(`);
          if (r.test(cleanText)) {
            if (!sources.has(fn)) sources.set(fn, new Set());
            sources.get(fn).add('DIRECT');
          }
        }
        for (const [varName, fn] of varToFnMap.entries()) {
          const r = new RegExp(`(?<![.\\w$?])\\b${varName}\\b`);
          if (r.test(cleanText)) {
            if (!sources.has(fn)) sources.set(fn, new Set());
            sources.get(fn).add(`VAR:${varName}`);
          }
        }
        return sources;
      }

      const sourcesA = getSources(cleanA);
      const sourcesB = getSources(cleanB);

      const circularFns = [];
      for (const [fn, sA] of sourcesA.entries()) {
        if (sourcesB.has(fn)) {
          const sB = sourcesB.get(fn);
          let isCircular = false;
          for (const originA of sA) {
            for (const originB of sB) {
              if (originA === 'DIRECT' || originB === 'DIRECT' || originA !== originB) {
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

        const allowMatch = prevLine.match(/^\/\/\s*anti-cheat-allow:\s*circular-oracle(?:\s*--\s*(.*))?$/);
        if (allowMatch) {
          const reason = (allowMatch[1] || '').trim();
          if (reason.length > 0) {
            continue;
          }
        }

        const { line, snippet } = getLineAndSnippet(content, startIndex, i - startIndex);
        fileViolations.push({
          gate: 'ANTI-CIRCULAR-ORACLE',
          target: rel,
          line,
          snippet,
          message: `Circular oracle detected: assertion compares results produced by the same production function "${circularFns.join(', ')}". Use independent golden expected values or independent oracles.`,
        });
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
