import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkCircularMocking,
  checkCircularOracles,
  checkSilentPassBypasses,
  checkHollowAssertions,
  checkProductionCheats,
  checkTableCompleteness,
  checkNoFakeConstants,
  checkNoSyntheticScheduleLoops,
  OFFICIAL_UNIFORM_INTERVAL_TRIPS,
  runAntiCheatAudit,
} from './guard-datapack-anti-cheat.mjs';

test('checkTableCompleteness rejects 100% blank platform_info across station_lines', () => {
  const fakePack = {
    id: 'nationwide',
    stationLines: [
      { stationId: 'st-1', lineId: 'line-1', platformInfo: '' },
      { stationId: 'st-2', lineId: 'line-1', platformInfo: '   ' },
    ],
    stationCarDoorHints: Array.from({ length: 40 }, (_, i) => ({
      stationId: `st-${i}`,
      lineId: 'line-1',
      direction: 'UP',
      carNumber: 1,
      doorNumber: 1,
      hintType: 'FAST_TRANSFER',
      sourceSnapshotId: 'snap-1',
    })),
    transitRoutes: [{ id: 'route-1' }],
    transitTrips: [{ id: 'trip-1' }],
    transitStopTimes: [{ tripId: 'trip-1', stopSequence: 1 }],
  };

  const violations = checkTableCompleteness(fakePack, { requirePlatformInfo: true });
  assert.ok(violations.some((v) => v.gate === 'GATE_TABLE_COMPLETENESS' && v.target === 'station_lines.platform_info'));
});

test('checkTableCompleteness accepts populated valid JSON platform_info', () => {
  const validPack = {
    id: 'nationwide',
    stationLines: [
      {
        stationId: 'st-1',
        lineId: 'line-1',
        platformInfo: JSON.stringify({ doorSide: 'RIGHT', platformType: 'SIDE', canCrossToOpposite: true }),
      },
    ],
    stationCarDoorHints: Array.from({ length: 40 }, (_, i) => ({
      stationId: `st-${i}`,
      lineId: 'line-1',
      direction: 'UP',
      carNumber: 1,
      doorNumber: 1,
      hintType: 'FAST_TRANSFER',
      sourceSnapshotId: 'snap-1',
    })),
    transitRoutes: [{ id: 'route-1' }],
    transitTrips: [{ id: 'trip-1' }],
    transitStopTimes: [{ tripId: 'trip-1', stopSequence: 1 }],
  };

  const violations = checkTableCompleteness(validPack);
  assert.equal(violations.length, 0);
});

test('checkTableCompleteness rejects truncated or empty station_car_door_hints', () => {
  const packWithEmptyHints = {
    id: 'nationwide',
    stationLines: [
      {
        stationId: 'st-1',
        lineId: 'line-1',
        platformInfo: JSON.stringify({ doorSide: 'LEFT' }),
      },
    ],
    stationCarDoorHints: [],
    transitRoutes: [{ id: 'route-1' }],
    transitTrips: [{ id: 'trip-1' }],
    transitStopTimes: [{ tripId: 'trip-1', stopSequence: 1 }],
  };

  const violations = checkTableCompleteness(packWithEmptyHints, { minCarDoorHints: 35 });
  assert.ok(violations.some((v) => v.gate === 'GATE_TABLE_COMPLETENESS' && v.target === 'station_car_door_hints'));
});

test('checkNoFakeConstants rejects bulk uniform 120s/50m transfers and unverified outdoor links', () => {
  const fakeEdges = [
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `edge-${i}`,
      edgeType: 'TRANSFER',
      durationSeconds: 120,
      distanceMeters: 50,
    })),
    {
      id: 'outdoor-edge-shinchon',
      transferType: 'OUTDOOR_WALK',
      surveyedAt: 1781568000,
      stairsStatus: 'NO_STAIRS',
      accessibilityStatus: 'AVAILABLE',
    },
  ];

  const violations = checkNoFakeConstants(fakeEdges);
  assert.ok(violations.some((v) => v.gate === 'GATE_NO_FAKE_CONSTANTS' && v.message.includes('120s, 50m')));
  assert.ok(violations.some((v) => v.gate === 'GATE_NO_FAKE_CONSTANTS' && v.target.includes('outdoor')));
});

test('checkNoSyntheticScheduleLoops catches synthetic 1800s loop trip IDs', () => {
  const fakePack = {
    transitTrips: [
      { id: 'trip-route-daejeon-1-up-wd-19800' },
      { id: 'trip-route-daejeon-1-up-hd-21600' },
    ],
  };

  const violations = checkNoSyntheticScheduleLoops(fakePack);
  assert.ok(violations.some((v) => v.gate === 'GATE_NO_SYNTHETIC_SCHEDULE_LOOPS'));
});

test('checkNoSyntheticScheduleLoops catches synthetic uniform stop interval loops', () => {
  const uniformStops = Array.from({ length: 15 }, (_, i) => ({
    tripId: 'trip-fake-loop',
    stopSequence: i + 1,
    arrivalTimeSeconds: 1000 + i * 120,
    departureTimeSeconds: 1020 + i * 120,
  }));

  const fakePack = {
    transitTrips: [{ id: 'trip-fake-loop' }],
    transitStopTimes: uniformStops,
  };

  const violations = checkNoSyntheticScheduleLoops(fakePack);
  assert.ok(violations.some((v) => v.gate === 'GATE_NO_SYNTHETIC_SCHEDULE_LOOPS' && v.message.includes('synthetic uniform schedule interval')));
});

test('checkNoSyntheticScheduleLoops exempts a uniform official trip only when source id and source row hash both match (#899)', () => {
  const official = OFFICIAL_UNIFORM_INTERVAL_TRIPS[0];
  const uniformStops = (tripId) => Array.from({ length: 10 }, (_, i) => ({
    tripId, stopSequence: i + 1, arrivalSeconds: 88_920 + i * 120, departureSeconds: 88_920 + i * 120,
  }));
  const exempt = { id: 'kc-s1101-w-000000000001', sourceId: official.sourceId, providerRecordHash: official.providerRecordHash };
  assert.deepEqual(checkNoSyntheticScheduleLoops({ transitTrips: [exempt], transitStopTimes: uniformStops(exempt.id) }), []);

  for (const trip of [
    { ...exempt, providerRecordHash: '0'.repeat(64) },
    { ...exempt, sourceId: 'other-source' },
  ]) {
    const violations = checkNoSyntheticScheduleLoops({ transitTrips: [trip], transitStopTimes: uniformStops(trip.id) });
    assert.ok(violations.some((v) => v.gate === 'GATE_NO_SYNTHETIC_SCHEDULE_LOOPS'), JSON.stringify(trip));
  }
});

test('checkHollowAssertions catches tautological assertions in test sources', () => {
  const violations = checkHollowAssertions();
  // Valid codebase must have zero hollow assertions
  assert.deepEqual(violations, []);
});

test('checkCircularMocking verifies test helpers are decoupled from production materializers', () => {
  const violations = checkCircularMocking();
  assert.deepEqual(violations, []);
});

test('checkSilentPassBypasses verifies no silent catch blocks or missing tool passes', () => {
  const violations = checkSilentPassBypasses();
  assert.deepEqual(violations, []);
});

test('runAntiCheatAudit passes cleanly on the updated repository', () => {
  const violations = runAntiCheatAudit();
  assert.deepEqual(violations, [], `Expected 0 anti-cheat violations, got:\n${JSON.stringify(violations, null, 2)}`);
});

test('checkCircularOracles detects direct and indirect circular test assertions', async (t) => {
  const mod = await import('./guard-datapack-anti-cheat.mjs');
  assert.equal(typeof mod.checkCircularOracles, 'function', 'checkCircularOracles must be exported as a function');

  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');

  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anti-cheat-circular-')));
  if (t && typeof t.after === 'function') {
    t.after(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
  }

  const toolsX = path.join(tmpRoot, 'tools', 'x');
  fs.mkdirSync(toolsX, { recursive: true });

  fs.writeFileSync(path.join(tmpRoot, 'tools', 'f.mjs'), 'export function f(x) { return x + 1; }\n');

  // direct circular oracle
  fs.writeFileSync(
    path.join(toolsX, 'direct.test.mjs'),
    'import { f } from "../f.mjs";\nimport assert from "node:assert/strict";\nassert.deepStrictEqual(f(1), f(1));\n'
  );

  // indirect circular oracle
  fs.writeFileSync(
    path.join(toolsX, 'indirect.test.mjs'),
    'import { f } from "../f.mjs";\nimport assert from "node:assert/strict";\nconst expected = f(1);\nassert.equal(f(1), expected);\n'
  );

  // ok test (fixed expected value)
  fs.writeFileSync(
    path.join(toolsX, 'ok.test.mjs'),
    'import { f } from "../f.mjs";\nimport assert from "node:assert/strict";\nassert.equal(f(1), 2);\n'
  );

  // allowed with reason (excluded from violations)
  fs.writeFileSync(
    path.join(toolsX, 'allowed.test.mjs'),
    'import { f } from "../f.mjs";\nimport assert from "node:assert/strict";\n// anti-cheat-allow: circular-oracle -- idempotency test\nassert.equal(f(1), f(1));\n'
  );

  // allowed without reason (still a violation)
  fs.writeFileSync(
    path.join(toolsX, 'disallowed-empty-reason.test.mjs'),
    'import { f } from "../f.mjs";\nimport assert from "node:assert/strict";\n// anti-cheat-allow: circular-oracle --\nassert.equal(f(1), f(1));\n'
  );

  const violations = mod.checkCircularOracles(tmpRoot);
  const targets = violations.map((v) => v.target.replace(/\\/g, '/')).sort();

  assert.deepEqual(targets, [
    'tools/x/direct.test.mjs',
    'tools/x/disallowed-empty-reason.test.mjs',
    'tools/x/indirect.test.mjs',
  ]);
  assert.ok(violations.every((v) => v.gate === 'ANTI-CIRCULAR-ORACLE'));
});


const ASSERT_IMPORT = 'import assert from "node:assert/strict";\n';

/** 임시 repo 루트에 tools/ 아래 테스트 파일들을 만들고 순환 오라클 가드 결과를 돌려준다. */
function circularOracleViolationsFor(t, testFiles) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'anti-cheat-shared-helper-'));
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
  for (const [rel, source] of Object.entries(testFiles)) {
    const fullPath = join(tmpRoot, rel);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, source);
  }
  return checkCircularOracles(tmpRoot);
}

test('checkCircularOracles does not treat the shared tools/lib sha256 helper as the function under test', (t) => {
  const violations = circularOracleViolationsFor(t, {
    'tools/datapack/build-thing.test.mjs':
      'import { sha256 } from "../lib/hash.mjs";\n' +
      'import { buildThing } from "./build-thing.mjs";\n' +
      ASSERT_IMPORT +
      'const bytes = Buffer.from("abc");\n' +
      'const expected = sha256(bytes);\n' +
      'assert.equal(buildThing(bytes).sha256, 42);\n' +
      'assert.equal(sha256(bytes), expected);\n' +
      'assert.equal(buildThing(bytes).sha256, sha256(bytes));\n',
  });
  assert.deepEqual(violations, []);
});

test('checkCircularOracles does not treat the shared tools/lib isObject helper as the function under test', (t) => {
  const violations = circularOracleViolationsFor(t, {
    'tools/datapack/shape.test.mjs':
      'import { isObject } from "../lib/is-object.mjs";\n' +
      ASSERT_IMPORT +
      'const value = {};\n' +
      'const expected = isObject(value);\n' +
      'assert.equal(isObject(value), expected);\n',
  });
  assert.deepEqual(violations, []);
});

test('checkCircularOracles still flags a circular oracle built from the shared helper own test subject', (t) => {
  const violations = circularOracleViolationsFor(t, {
    'tools/lib/hash.test.mjs':
      'import { sha256 } from "./hash.mjs";\n' + ASSERT_IMPORT + 'assert.equal(sha256("a"), sha256("a"));\n',
    'tools/lib/is-object.test.mjs':
      'import { isObject } from "./is-object.mjs";\n' + ASSERT_IMPORT + 'assert.equal(isObject({}), isObject({}));\n',
  });
  assert.deepEqual(
    violations.map((violation) => violation.target.replace(/\\/g, '/')).sort(),
    ['tools/lib/hash.test.mjs', 'tools/lib/is-object.test.mjs'],
  );
});

test('checkCircularOracles keeps flagging production functions next to the shared helper and same-named non-lib exports', (t) => {
  const violations = circularOracleViolationsFor(t, {
    'tools/datapack/mixed.test.mjs':
      'import { sha256 } from "../lib/hash.mjs";\n' +
      'import { buildThing } from "./build-thing.mjs";\n' +
      ASSERT_IMPORT +
      'const built = buildThing(1);\n' +
      'assert.equal(buildThing(1), built);\n' +
      'assert.equal(sha256("a"), sha256("a"));\n',
    'tools/datapack/local-sha.test.mjs':
      'import { sha256 } from "./lib/manifest-validation.mjs";\n' +
      ASSERT_IMPORT +
      'const expected = sha256("a");\n' +
      'assert.equal(sha256("a"), expected);\n',
    'tools/datapack/other-lib.test.mjs':
      'import { normalize } from "../lib/hash.mjs";\n' +
      ASSERT_IMPORT +
      'const expected = normalize("a");\n' +
      'assert.equal(normalize("a"), expected);\n',
  });
  assert.deepEqual(
    violations.map((violation) => [violation.target.replace(/\\/g, '/'), violation.message.match(/function "([^"]+)"/)[1]]).sort(),
    [
      ['tools/datapack/local-sha.test.mjs', 'sha256'],
      ['tools/datapack/mixed.test.mjs', 'buildThing'],
      ['tools/datapack/other-lib.test.mjs', 'normalize'],
    ],
  );
});
