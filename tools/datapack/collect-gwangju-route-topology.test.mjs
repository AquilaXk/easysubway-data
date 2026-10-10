import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GWANGJU_ROUTE_TOPOLOGY_ENDPOINT,
  collectGwangjuRouteTopology,
  runGwangjuRouteTopologyCollector,
} from "./collect-gwangju-route-topology.mjs";
import { createTransientRetryBudget } from "./lib/transient-retry.mjs";

// #1099: 일시 오류는 같은 요청을 1·2·4·8·16초 대기로 최대 5번 다시 보낸다. 재시도 대기와 예산은 테스트마다 격리한다.
const retryFast = (waits = []) => ({ sleepImpl: async (milliseconds) => { waits.push(milliseconds); }, retryBudget: createTransientRetryBudget() });

const stationNames = [
  "평동역", "도산역", "광주/송정역", "송정/공원역", "공항역", "김대중컨벤션센터역",
  "상무역", "운천역", "쌍촌역", "화정역", "농성역", "돌고개역", "양동시장역",
  "금남로/5가역", "금남로/4가역", "문화전당역", "남광주역", "학동 · 증심사입구역",
  "소태역", "녹동역",
];
const stationScope = stationNames.map((stationName, index) => ({
  providerStationId: String(index + 1), stationCode: String(120 - (index + 1)), stationName,
}));

test("광주 공식 운행정보 API를 20개 역·38개 방향성 인접 edge로 수집한다", async () => {
  const requests = [];
  const snapshot = await collectGwangjuRouteTopology({
    stationScope,
    now: new Date("2026-07-20T13:10:00.000Z"),
    fetchImpl: async (url) => {
      const stationId = Number(new URL(url).searchParams.get("station_id"));
      requests.push(stationId);
      return Response.json(Array.from({ length: 20 }, (_, index) => index + 1)
        .filter((endStationId) => endStationId !== stationId)
        .map((endStationId) => ({
          start_station_id: stationId,
          start_station_name: stationNames[stationId - 1],
          end_station_id: endStationId,
          end_station_name: stationNames[endStationId - 1],
          station_distance: Math.abs(stationId - endStationId) * 1.25,
          station_time: Math.abs(stationId - endStationId) * 2.5,
        })));
    },
  });

  assert.equal(GWANGJU_ROUTE_TOPOLOGY_ENDPOINT,
    "https://www.grtc.co.kr/subway/openapi/json/stationTimeInfomation");
  assert.deepEqual(requests, Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.requestCount, 20);
  assert.equal(snapshot.stationCount, 20);
  assert.equal(snapshot.odRowCount, 380);
  assert.equal(snapshot.edgeCount, 38);
  assert.deepEqual(snapshot.scope[0], {
    providerStationId: "1", stationCode: "119", stationName: "평동",
  });
  assert.deepEqual(snapshot.edges[0], {
    fromProviderStationId: "1",
    toProviderStationId: "2",
    fromStationCode: "119",
    toStationCode: "118",
    fromStationName: "평동",
    toStationName: "도산",
    distanceMeters: 1250,
    durationSeconds: 150,
    responseSha256: snapshot.edges[0].responseSha256,
  });
  assert.equal(snapshot.contentSha256, createHash("sha256")
    .update(JSON.stringify({ scope: snapshot.scope, edges: snapshot.edges })).digest("hex"));
  assert.equal(snapshot.freshUntil, "2026-07-21T13:10:00.000Z");
});

test("광주 topology는 컷오버(2026-10-03T00:00Z) 이후 수집분에 P7D, 이전 수집분에 P1D freshUntil을 기록한다", async () => {
  const fetchImpl = async (url) => {
    const stationId = Number(new URL(url).searchParams.get("station_id"));
    return Response.json(Array.from({ length: 20 }, (_, index) => index + 1)
      .filter((endStationId) => endStationId !== stationId)
      .map((endStationId) => ({
        start_station_id: stationId,
        start_station_name: stationNames[stationId - 1],
        end_station_id: endStationId,
        end_station_name: stationNames[endStationId - 1],
        station_distance: Math.abs(stationId - endStationId) * 1.25,
        station_time: Math.abs(stationId - endStationId) * 2.5,
      })));
  };
  const day = 86_400_000;
  const cutover = Date.parse("2026-10-03T00:00:00.000Z");
  const current = await collectGwangjuRouteTopology({ stationScope, now: new Date(cutover), fetchImpl });
  assert.equal(current.freshUntil, new Date(cutover + 7 * day).toISOString());
  const legacy = await collectGwangjuRouteTopology({ stationScope, now: new Date(cutover - 1), fetchImpl });
  assert.equal(legacy.freshUntil, new Date(cutover - 1 + day).toISOString());
});

test("광주 topology collector는 HTTP·schema·OD 완결성 오류를 fail closed한다", async () => {
  await assert.rejects(collectGwangjuRouteTopology({
    stationScope, ...retryFast(),
    fetchImpl: async () => new Response("down", { status: 503 }),
  }), /HTTP 503/);
  await assert.rejects(collectGwangjuRouteTopology({
    stationScope,
    fetchImpl: async () => Response.json(Array.from({ length: 19 }, () => ({ unexpected: true }))),
  }), /schema mismatch/);
  await assert.rejects(collectGwangjuRouteTopology({
    stationScope,
    fetchImpl: async () => Response.json([]),
  }), /OD row count/);
});

test("광주 topology collector는 같은 역 ID의 괄호 부역명을 canonical 역명으로 정규화한다", async () => {
  const snapshot = await collectGwangjuRouteTopology({
    stationScope,
    fetchImpl: async (url) => {
      const stationId = Number(new URL(url).searchParams.get("station_id"));
      return Response.json(Array.from({ length: 20 }, (_, index) => index + 1)
        .filter((endStationId) => endStationId !== stationId)
        .map((endStationId) => ({
          start_station_id: stationId,
          start_station_name: stationId === 6 ? "김대중컨벤션센터(마륵)역"
            : stationId === 18 ? "학동.증심사역" : stationNames[stationId - 1],
          end_station_id: endStationId,
          end_station_name: endStationId === 6 ? "김대중컨벤션센터역" : stationNames[endStationId - 1],
          station_distance: Math.abs(stationId - endStationId),
          station_time: Math.abs(stationId - endStationId) * 2,
        })));
    },
  });
  assert.equal(snapshot.scope.find(({ providerStationId }) => providerStationId === "6").stationName,
    "김대중컨벤션센터");
  assert.equal(snapshot.scope.find(({ providerStationId }) => providerStationId === "18").stationName,
    "학동증심사입구");
});

test("dynamic station scope derives noncontiguous provider roster and adjacent edges", async () => {
  const scope = [
    { providerStationId: "101", stationCode: "A", stationName: "가역" },
    { providerStationId: "305", stationCode: "B", stationName: "나역" },
    { providerStationId: "901", stationCode: "C", stationName: "다역" },
  ];
  const requests = [];
  const snapshot = await collectGwangjuRouteTopology({
    stationScope: scope,
    fetchImpl: async (url) => {
      const start = new URL(url).searchParams.get("station_id"); requests.push(start);
      return Response.json(scope.filter(({ providerStationId }) => providerStationId !== start).map((end, index) => ({
        start_station_id: start, start_station_name: scope.find(({ providerStationId }) => providerStationId === start).stationName,
        end_station_id: end.providerStationId, end_station_name: `${end.stationName}역`, station_distance: index + 1, station_time: index + 1,
      })));
    },
  });
  assert.deepEqual(requests, scope.map(({ providerStationId }) => providerStationId));
  assert.equal(snapshot.odRowCount, scope.length * (scope.length - 1));
  assert.equal(snapshot.edgeCount, 2 * (scope.length - 1));
  assert.deepEqual(snapshot.scope, scope.map((row, index) => ({ ...row, stationName: ["가", "나", "다"][index] })));
  await assert.rejects(collectGwangjuRouteTopology({ stationScope: scope, fetchImpl: async () => Response.json([]) }), /OD row count/);
});

test("CLI resolves admitted schema-1 seed scope before collecting fresh topology", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gwangju-topology-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = [
    { providerStationId: "101", stationCode: "A", stationName: "가역" },
    { providerStationId: "305", stationCode: "B", stationName: "나역" },
    { providerStationId: "901", stationCode: "C", stationName: "다역" },
  ];
  const edges = [{}, {}, {}, {}];
  const seed = { schemaVersion: 1, artifactKind: "gwangju-route-topology-snapshot", sourceId: "gwangju-transportation-route-topology", scope, edges };
  seed.contentSha256 = createHash("sha256").update(JSON.stringify({ scope, edges })).digest("hex");
  const snapshotPath = "tools/datapack/sources/gwangju-seed.json";
  const inventory = { sources: [{ id: "gwangju-transportation-route-topology", topologyAdmissionEvidence: {
    snapshotId: "gwangju-seed", snapshotPath, contentSha256: seed.contentSha256,
  } }] };
  await mkdir(path.join(root, "tools/datapack/sources"), { recursive: true });
  await writeFile(path.join(root, "tools/datapack/source-inventory.json"), JSON.stringify(inventory));
  await writeFile(path.join(root, snapshotPath), JSON.stringify(seed));
  const output = path.join(root, "output.json");
  let calls = 0;
  const fakeFetch = async (url) => {
    calls += 1;
    const start = new URL(url).searchParams.get("station_id");
    return Response.json(scope.filter(({ providerStationId }) => providerStationId !== start).map((end, index) => ({
      start_station_id: start, start_station_name: scope.find(({ providerStationId }) => providerStationId === start).stationName,
      end_station_id: end.providerStationId, end_station_name: end.stationName, station_distance: index + 1, station_time: index + 1,
    })));
  };
  const result = await runGwangjuRouteTopologyCollector(["--inventory", "tools/datapack/source-inventory.json", "--output", output], {
    repositoryRoot: root, fetchImpl: fakeFetch, now: new Date("2026-09-01T00:00:00.000Z"),
  });
  assert.equal(calls, scope.length);
  assert.equal(result.rawResponses.length, scope.length);
  assert.equal(result.rawSha256, createHash("sha256").update(JSON.stringify(result.rawResponses.map(({ bytesBase64 }) => createHash("sha256").update(Buffer.from(bytesBase64, "base64")).digest("hex")))).digest("hex"));
  const expectedScope = scope.map((row, index) => ({ ...row, stationName: ["가", "나", "다"][index] }));
  assert.deepEqual(result.scope, expectedScope);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")).scope, expectedScope);
  calls = 0;
  await assert.rejects(runGwangjuRouteTopologyCollector(["--inventory", "tools/datapack/source-inventory.json", "--output", output], {
    repositoryRoot: root, fetchImpl: fakeFetch,
  }), /EEXIST/);
  assert.equal(calls, 0);

  const altered = { ...seed, contentSha256: "0".repeat(64) };
  await writeFile(path.join(root, snapshotPath), JSON.stringify(altered));
  calls = 0;
  await assert.rejects(runGwangjuRouteTopologyCollector(["--inventory", "tools/datapack/source-inventory.json", "--output", path.join(root, "bad.json")], {
    repositoryRoot: root, fetchImpl: fakeFetch,
  }), /snapshot mismatch/);
  assert.equal(calls, 0);

  await writeFile(path.join(root, snapshotPath), JSON.stringify(seed));
  const failedOutput = path.join(root, "name.json");
  const receivedBytes = Buffer.from(JSON.stringify(scope.slice(1).map((end) => ({
    start_station_id: scope[0].providerStationId, start_station_name: "다른역", end_station_id: end.providerStationId,
    end_station_name: end.stationName, station_distance: 1, station_time: 1,
  }))));
  await assert.rejects(runGwangjuRouteTopologyCollector(["--inventory", "tools/datapack/source-inventory.json", "--output", failedOutput], {
    repositoryRoot: root, fetchImpl: async (url) => {
      const start = new URL(url).searchParams.get("station_id");
      if (start === scope[0].providerStationId) return new Response(receivedBytes, { headers: { "content-type": "application/json" } });
      return Response.json(scope.filter(({ providerStationId }) => providerStationId !== start).map((end) => ({
        start_station_id: start, start_station_name: "다른역", end_station_id: end.providerStationId,
        end_station_name: end.stationName, station_distance: 1, station_time: 1,
      })));
    },
  }), /station name mismatch/);
  const failed = JSON.parse(await readFile(`${failedOutput}.failed.json`, "utf8"));
  assert.equal(failed.status, "FAILED");
  assert.deepEqual(Buffer.from(failed.rawResponses[0].bytesBase64, "base64"), receivedBytes);
  await assert.rejects(readFile(failedOutput), { code: "ENOENT" });
  calls = 0;
  await assert.rejects(runGwangjuRouteTopologyCollector(["--inventory", "tools/datapack/source-inventory.json", "--output", failedOutput], {
    repositoryRoot: root, fetchImpl: async () => { calls += 1; throw new Error("provider must not run"); },
  }), /EEXIST/);
  assert.equal(calls, 0);
});

test("광주 topology production snapshot identity를 고정한다", async () => {
  const snapshot = JSON.parse(await readFile(new URL(
    "./sources/gwangju-transportation-route-topology-20260720.json",
    import.meta.url,
  ), "utf8"));
  assert.equal(snapshot.capturedAt, "2026-07-20T13:08:47.161Z");
  assert.equal(snapshot.freshUntil, "2026-07-21T13:08:47.161Z");
  assert.equal(snapshot.stationCount, 20);
  assert.equal(snapshot.odRowCount, 380);
  assert.equal(snapshot.edgeCount, 38);
  assert.equal(snapshot.rawSha256, "15e4a6835dff21997d29707b0554580560fd770388156b2ac169508cdfd6636a");
  assert.equal(snapshot.contentSha256, "d8197488bc6dda94e595f7e350cc65c547117da804fb59b7dff85d18b3192e43");
  assert.equal(snapshot.contentSha256, createHash("sha256")
    .update(JSON.stringify({ scope: snapshot.scope, edges: snapshot.edges })).digest("hex"));
});

const odResponse = (stationId) => Response.json(Array.from({ length: 20 }, (_, index) => index + 1)
  .filter((endStationId) => endStationId !== stationId)
  .map((endStationId) => ({
    start_station_id: stationId,
    start_station_name: stationNames[stationId - 1],
    end_station_id: endStationId,
    end_station_name: stationNames[endStationId - 1],
    station_distance: Math.abs(stationId - endStationId) * 1.25,
    station_time: Math.abs(stationId - endStationId) * 2.5,
  })));
const stationIdOf = (url) => Number(new URL(url).searchParams.get("station_id"));

test("광주 topology collector는 HTTP 5xx·연결 timeout·본문 수신 오류 뒤 같은 역 요청이 성공하면 그 응답을 쓴다", async () => {
  const outcomes = [
    () => new Response("down", { status: 503 }),
    () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }); },
    () => ({ ok: true, status: 200, arrayBuffer: async () => { throw Object.assign(new Error("body timeout"), { code: "UND_ERR_BODY_TIMEOUT" }); } }),
  ];
  const calls = [];
  const waits = [];
  const snapshot = await collectGwangjuRouteTopology({
    stationScope, ...retryFast(waits), now: new Date("2026-10-04T00:00:00.000Z"),
    fetchImpl: async (url) => {
      const stationId = stationIdOf(url);
      calls.push(stationId);
      const next = stationId === 3 ? outcomes.shift() : undefined;
      return next === undefined ? odResponse(stationId) : next();
    },
  });
  assert.equal(snapshot.requestCount, 20);
  assert.equal(snapshot.odRowCount, 380);
  assert.deepEqual(calls.filter((id) => id === 3), [3, 3, 3, 3], "역 3은 세 번 실패하고 네 번째에 성공한다");
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
});

test("광주 topology collector는 일시 오류가 한도(5번)를 넘으면 기존 오류로 끝난다", async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(collectGwangjuRouteTopology({
    stationScope, ...retryFast(waits),
    fetchImpl: async () => { calls += 1; throw Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }); },
  }), /Gwangju route topology transport failure; code=UND_ERR_CONNECT_TIMEOUT/);
  assert.equal(calls, 6);
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000]);

  let budgetCalls = 0;
  await assert.rejects(collectGwangjuRouteTopology({
    stationScope, sleepImpl: async () => {}, retryBudget: createTransientRetryBudget(2_500),
    fetchImpl: async () => { budgetCalls += 1; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
  }), /Gwangju route topology transport failure; code=ECONNRESET/);
  assert.equal(budgetCalls, 2);
});

test("광주 topology collector는 429를 기존처럼 한 번만 다시 요청하고 인증·형식 오류는 재시도하지 않는다", async () => {
  let calls = 0;
  const waits = [];
  const snapshot = await collectGwangjuRouteTopology({
    stationScope, ...retryFast(waits), now: new Date("2026-10-04T00:00:00.000Z"),
    fetchImpl: async (url) => { calls += 1; const stationId = stationIdOf(url); return calls === 1 ? new Response("slow", { status: 429 }) : odResponse(stationId); },
  });
  assert.equal(calls, 21);
  assert.deepEqual(waits, [250]);
  assert.equal(snapshot.odRowCount, 380);

  for (const status of [401, 403, 404, 429]) {
    let rejectedCalls = 0;
    await assert.rejects(collectGwangjuRouteTopology({
      stationScope, ...retryFast(),
      fetchImpl: async () => { rejectedCalls += 1; return new Response("denied", { status }); },
    }), new RegExp(`HTTP ${status}`));
    assert.equal(rejectedCalls, status === 429 ? 2 : 1, String(status));
  }
});
