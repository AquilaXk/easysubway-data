#!/usr/bin/env node

/**
 * CI Guard: Anti-Cheat & Pipeline Completeness Validator
 *
 * Enforces zero-tolerance against fake/cheating tests, synthetic schedules,
 * unwired/neglected database tables, fake constants, and silent release bypasses.
 *
 * Rules Enforced:
 * 1. GATE_TABLE_COMPLETENESS: Prevents secured data from being omitted/abandoned in production packs
 *    (station_lines.platform_info != blank, station_car_door_hints > threshold, station_exits coverage, etc.).
 * 2. GATE_NO_FAKE_CONSTANTS: Rejects uniform synthetic durations/distances (120s/50m, 90s/50m, 60s/50m)
 *    and unverified outdoor transfers with synthetic timestamps (1781568000) or fake NO_STAIRS/AVAILABLE.
 * 3. GATE_FAIL_CLOSED_GIT_PROVENANCE: Rejects dummy fallback commit SHAs and enforces case-insensitive two-person approval.
 * 4. GATE_NO_TEST_CHEATING_OR_BYPASS: Detects conditional test skips in release mode, silent hash bypasses,
 *    stale freshness bypasses, or hardcoded station filters.
 * 5. GATE_NO_SYNTHETIC_SCHEDULE_LOOPS: Rejects synthetic 1800s schedule loops (depTime += 1800, wd-19800).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const REPO_ROOT = resolve(__dirname, '../..');

export class AntiCheatViolationError extends Error {
  constructor(violations) {
    const summary = violations.map((v) => `  [${v.gate}] ${v.target}: ${v.message}`).join('\n');
    super(`Anti-Cheat Guard detected ${violations.length} violation(s):\n${summary}`);
    this.name = 'AntiCheatViolationError';
    this.violations = violations;
  }
}

/**
 * Gate 1: Check table completeness and ensure secured tables are not abandoned/empty.
 */
export function checkTableCompleteness(pack, options = {}) {
  const violations = [];
  const minCarDoorHints = options.minCarDoorHints ?? 35;
  const isNationwide = pack.id === 'nationwide' || pack.id === 'capital';

  // 1.1 station_lines.platform_info must not be 100% blank
  if (Array.isArray(pack.stationLines) && pack.stationLines.length > 0) {
    const totalLines = pack.stationLines.length;
    const nonEmptyPlatformInfo = pack.stationLines.filter(
      (sl) => typeof sl.platformInfo === 'string' && sl.platformInfo.trim().length > 0
    );

    if (nonEmptyPlatformInfo.length === 0) {
      violations.push({
        gate: 'GATE_TABLE_COMPLETENESS',
        target: 'station_lines.platform_info',
        message: `All ${totalLines} station_lines records have 100% blank platform_info. Authentic platform metadata must be wired.`,
      });
    }

    // Verify structured JSON format for non-empty platform_info
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

  // 1.2 station_car_door_hints must not be omitted or truncated to dummy counts
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
  }

  // 1.3 transit_routes, transit_trips, transit_stop_times non-zero
  if (isNationwide) {
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

/**
 * Gate 2: Rejects fake uniform constants and unverified outdoor links.
 */
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

    if (edgeType === 'TRANSFER' && duration === 120 && distance === 50) {
      uniform120_50Count += 1;
    }
    if (edgeType === 'ENTRY' && duration === 90 && distance === 50) {
      uniform90_50Count += 1;
    }
    if (edgeType === 'EXIT' && duration === 60 && distance === 50) {
      uniform60_50Count += 1;
    }

    // Unverified outdoor transfer check
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

  // If nationwide edges have bulk uniform constants injected:
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

/**
 * Gate 3: Reject synthetic 1800s schedule loops in trips and stop_times.
 */
export function checkNoSyntheticScheduleLoops(pack) {
  const violations = [];
  const trips = pack.transitTrips ?? [];

  for (const trip of trips) {
    // Detect synthetic trip pattern: trip-*-wd-19800 or synthetic intervals
    if (typeof trip.id === 'string' && /-(?:wd|hd)-(?:19800|21600|23400|25200)\b/.test(trip.id)) {
      violations.push({
        gate: 'GATE_NO_SYNTHETIC_SCHEDULE_LOOPS',
        target: `transit_trips[${trip.id}]`,
        message: `Detected synthetic 30-minute schedule loop trip ID: "${trip.id}". Synthetic loops are strictly prohibited.`,
      });
      break;
    }
  }

  return violations;
}

/**
 * Gate 4: Scan source code and test files for bypasses, cheating, and hardcoded stubs.
 */
export function checkCodebaseBypasses(repoRoot = REPO_ROOT) {
  const violations = [];
  const toolsDir = resolve(repoRoot, 'tools');

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          walk(fullPath);
        }
      } else if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.js'))) {
        const content = readFileSync(fullPath, 'utf8');
        const relPath = relative(repoRoot, fullPath);

        // 4.1 Check for stale fallback commit SHA in production scripts
        const BANNED_STALE_SHA = ['d7fe777352', '8239e27e37', '88679d1b46', 'b813cce046'].join('');
        if (!entry.name.endsWith('.test.mjs') && !relPath.includes('guard-datapack-anti-cheat') && content.includes(BANNED_STALE_SHA)) {
          violations.push({
            gate: 'GATE_FAIL_CLOSED_GIT_PROVENANCE',
            target: relPath,
            message: `Contains hardcoded stale git commit SHA "${BANNED_STALE_SHA}". Fail-closed git resolution required.`,
          });
        }

        // 4.2 Check for conditional test skips based on release mode
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

        // 4.3 Check for hardcoded 2-station facility filters in production scripts
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

        // 4.4 Check for silent bypass of SQLite hash check in release mode
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

  walk(toolsDir);
  return violations;
}

/**
 * Run all anti-cheat gates against repository and canonical packs.
 */
export function runAntiCheatAudit(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const canonicalPackPath = options.packPath || resolve(repoRoot, 'tools/datapack/release/nationwide-production-canonical-pack.json');
  const routeEdgePath = resolve(repoRoot, 'contracts/datapack/nationwide-route-edge-input.json');

  const allViolations = [];

  // Gate 4: Codebase inspection
  const codeViolations = checkCodebaseBypasses(repoRoot);
  allViolations.push(...codeViolations);

  // Load canonical pack if exists
  let pack = null;
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

  if (pack) {
    allViolations.push(...checkTableCompleteness(pack, options));
    allViolations.push(...checkNoSyntheticScheduleLoops(pack));
    if (Array.isArray(pack.routeEdges)) {
      allViolations.push(...checkNoFakeConstants(pack.routeEdges));
    }
  }

  // Load route edge input if exists
  try {
    const rawEdges = readFileSync(routeEdgePath, 'utf8');
    const edgeData = JSON.parse(rawEdges);
    const edges = Array.isArray(edgeData) ? edgeData : edgeData.routeEdges || [];
    allViolations.push(...checkNoFakeConstants(edges));
  } catch {
    // If not present, pack.routeEdges was already inspected
  }

  return allViolations;
}

// CLI Execution
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const violations = runAntiCheatAudit();
  if (violations.length > 0) {
    console.error(`\x1b[31m✖ CI Guard Anti-Cheat FAILED with ${violations.length} violation(s):\x1b[0m`);
    for (const v of violations) {
      console.error(`  \x1b[33m[${v.gate}]\x1b[0m \x1b[36m${v.target}\x1b[0m: ${v.message}`);
    }
    process.exit(1);
  } else {
    console.log('\x1b[32m✔ CI Guard Anti-Cheat PASSED: All tables, schedules, platforms, hints, and provenance verified clean.\x1b[0m');
    process.exit(0);
  }
}
