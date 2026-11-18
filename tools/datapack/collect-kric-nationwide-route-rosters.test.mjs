import assert from "node:assert/strict";
import test from "node:test";

import {
  collectKricNationwideRouteRosters,
  main,
  parseArgs,
} from "./collect-kric-nationwide-route-rosters.mjs";

const targets = {
  targetVersion: "2026-07-13",
  activeLineScopes: [
    { regionId: "capital", operatorId: "seoul-metro", lineId: "line-4" },
    { regionId: "capital", operatorId: "korail", lineId: "line-4" },
    { regionId: "busan", operatorId: "busan-transportation", lineId: "busan-1" },
  ],
};
const fixture = {
  providerLineScopes: [
    { regionId: "capital", operatorId: "seoul-metro", lineId: "line-4", mreaWideCd: "01", lnCd: "4", railOprIsttCd: "S1" },
    { regionId: "capital", operatorId: "korail", lineId: "line-4", mreaWideCd: "01", lnCd: "4", railOprIsttCd: "KR" },
    { regionId: "busan", operatorId: "busan-transportation", lineId: "busan-1", mreaWideCd: "02", lnCd: "1", railOprIsttCd: "BS" },
  ],
};

test("전국 KRIC roster CLI 인자와 파일 orchestration을 검증한다", async () => {
  assert.deepEqual(parseArgs([
    "--targets", "targets.json",
    "--fixture", "fixture.json",
    "--output", "/tmp/rosters.json",
  ]), { targets: "targets.json", fixture: "fixture.json", output: "/tmp/rosters.json" });
  assert.throws(() => parseArgs(["--targets", "targets.json"]), /usage/);
  assert.throws(() => parseArgs([
    "--fixture", "fixture.json",
    "--targets", "targets.json",
    "--output", "/tmp/rosters.json",
  ]), /usage/);
  assert.throws(() => parseArgs([
    "--targets", "targets.json",
    "--fixture", "fixture.json",
    "--output", "rosters.json",
  ]), /absolute/);

  const writes = [];
  const logs = [];
  let collected;
  await main([
    "--targets", "targets.json",
    "--fixture", "fixture.json",
    "--output", "/tmp/rosters.json",
  ], {
    serviceKey: "secret",
    readFileImpl: async (file) => JSON.stringify(file === "targets.json" ? targets : fixture),
    collectRostersImpl: async (input) => {
      collected = input;
      return { providerScopeCount: 3, requestCount: 2 };
    },
    writeFileImpl: async (...args) => writes.push(args),
    log: (message) => logs.push(message),
  });
  assert.deepEqual(collected, { targets, fixture, serviceKey: "secret" });
  assert.deepEqual(writes, [[
    "/tmp/rosters.json",
    `${JSON.stringify({ providerScopeCount: 3, requestCount: 2 }, null, 2)}\n`,
    { mode: 0o600 },
  ]]);
  assert.deepEqual(logs, ["sanitized KRIC nationwide rosters ready: scopes=3 requests=2"]);
});

test("전국 KRIC roster 수집은 shared line 요청을 합치고 모든 operator row를 검증한다", async () => {
  const requests = [];
  const result = await collectKricNationwideRouteRosters({
    targets,
    fixture,
    serviceKey: "secret",
    now: new Date("2026-07-19T00:00:00.000Z"),
    collectImpl: async ({ mreaWideCd, lnCd, serviceKey }) => {
      requests.push(`${mreaWideCd}:${lnCd}:${serviceKey}`);
      const operators = mreaWideCd === "01" ? ["S1", "KR"] : ["BS"];
      return {
        schemaVersion: 1,
        artifactKind: "kric-route-roster",
        mreaWideCd,
        lnCd,
        resultCode: "00",
        stations: operators.map((railOprIsttCd, index) => ({
          railOprIsttCd,
          lnCd,
          mreaWideCd,
          stinCd: `${index + 1}`,
          stinNm: `역${index + 1}`,
          stinConsOrdr: index + 1,
        })),
      };
    },
  });

  assert.equal(result.providerScopeCount, 3);
  assert.equal(result.requestCount, 2);
  assert.deepEqual(requests.sort(), ["01:4:secret", "02:1:secret"]);
  assert.equal(result.capturedAt, "2026-07-19T00:00:00.000Z");
});

test("전국 KRIC roster 수집은 target mapping이나 provider operator row 누락을 거부한다", async () => {
  await assert.rejects(collectKricNationwideRouteRosters({
    targets,
    fixture: { providerLineScopes: fixture.providerLineScopes.slice(1) },
    serviceKey: "secret",
    collectImpl: async () => assert.fail("must not collect"),
  }), /provider scope set/);

  await assert.rejects(collectKricNationwideRouteRosters({
    targets,
    fixture,
    serviceKey: "secret",
    collectImpl: async ({ mreaWideCd, lnCd }) => ({
      schemaVersion: 1,
      artifactKind: "kric-route-roster",
      mreaWideCd,
      lnCd,
      resultCode: "00",
      stations: [{ railOprIsttCd: "S1", lnCd, mreaWideCd, stinCd: "1", stinNm: "역", stinConsOrdr: 1 }],
    }),
  }), /provider operator row is missing/);
});

test("전국 KRIC roster 수집은 target과 fixture의 중복 provider scope를 거부한다", async () => {
  await assert.rejects(collectKricNationwideRouteRosters({
    targets: { ...targets, activeLineScopes: [...targets.activeLineScopes, targets.activeLineScopes[0]] },
    fixture,
    serviceKey: "secret",
    collectImpl: async () => assert.fail("must not collect"),
  }), /duplicate target active line scope/);

  await assert.rejects(collectKricNationwideRouteRosters({
    targets,
    fixture: { providerLineScopes: [...fixture.providerLineScopes, fixture.providerLineScopes[0]] },
    serviceKey: "secret",
    collectImpl: async () => assert.fail("must not collect"),
  }), /duplicate fixture provider scope/);
});

test("전국 KRIC roster 수집은 targetVersion을 provider 호출 전에 검증한다", async () => {
  await assert.rejects(collectKricNationwideRouteRosters({
    targets: { ...targets, targetVersion: "" },
    fixture,
    serviceKey: "secret",
    collectImpl: async () => assert.fail("must not collect"),
  }), /targets.targetVersion is required/);
});

test("전국 KRIC roster worker는 첫 실패 뒤 신규 provider 호출을 시작하지 않고 모두 settle한다", async () => {
  const extendedTargets = {
    ...targets,
    activeLineScopes: [
      ...targets.activeLineScopes,
      { regionId: "daegu", operatorId: "daegu-transportation", lineId: "daegu-1" },
      { regionId: "gwangju", operatorId: "gwangju-transit", lineId: "gwangju-1" },
    ],
  };
  const extendedFixture = {
    providerLineScopes: [
      ...fixture.providerLineScopes,
      { regionId: "daegu", operatorId: "daegu-transportation", lineId: "daegu-1", mreaWideCd: "03", lnCd: "1", railOprIsttCd: "DG" },
      { regionId: "gwangju", operatorId: "gwangju-transit", lineId: "gwangju-1", mreaWideCd: "04", lnCd: "1", railOprIsttCd: "GJ" },
    ],
  };
  let calls = 0;
  const failures = [new Error("provider failed 1"), new Error("provider failed 2")];
  await assert.rejects(collectKricNationwideRouteRosters({
    targets: extendedTargets,
    fixture: extendedFixture,
    serviceKey: "secret",
    concurrency: 2,
    collectImpl: async ({ mreaWideCd, lnCd }) => {
      calls += 1;
      const callIndex = calls - 1;
      await new Promise((resolve) => setImmediate(resolve));
      throw failures[callIndex];
    },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "KRIC nationwide roster collection failed");
    assert.deepEqual(error.errors, failures);
    return true;
  });
  assert.equal(calls, 2);
});

test("전국 KRIC roster 수집은 각 provider roster schema 오류를 거부한다", async (context) => {
  const validRoster = ({ mreaWideCd, lnCd }) => ({
    schemaVersion: 1,
    artifactKind: "kric-route-roster",
    mreaWideCd,
    lnCd,
    resultCode: "00",
    stations: ["S1", "KR", "BS"].map((railOprIsttCd, index) => ({
      railOprIsttCd,
      lnCd,
      mreaWideCd,
      stinCd: `${index + 1}`,
      stinNm: `역${index + 1}`,
      stinConsOrdr: index + 1,
    })),
  });
  for (const [label, mutate] of [
    ["artifactKind", (roster) => { roster.artifactKind = "wrong"; }],
    ["resultCode", (roster) => { roster.resultCode = "30"; }],
    ["stations", (roster) => { roster.stations = null; }],
  ]) {
    await context.test(label, async () => {
      await assert.rejects(collectKricNationwideRouteRosters({
        targets,
        fixture,
        serviceKey: "secret",
        collectImpl: async (request) => {
          const roster = validRoster(request);
          mutate(roster);
          return roster;
        },
      }), /nationwide roster schema is invalid/);
    });
  }
});
