import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkTableCompleteness,
  checkNoFakeConstants,
  checkNoSyntheticScheduleLoops,
  checkCodebaseBypasses,
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

  const violations = checkTableCompleteness(fakePack);
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

test('runAntiCheatAudit passes cleanly on the updated repository', () => {
  const violations = runAntiCheatAudit();
  assert.deepEqual(violations, [], `Expected 0 anti-cheat violations, got:\n${JSON.stringify(violations, null, 2)}`);
});
