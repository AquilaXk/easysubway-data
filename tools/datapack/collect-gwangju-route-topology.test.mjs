import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GWANGJU_ROUTE_TOPOLOGY_ENDPOINT,
  collectGwangjuRouteTopology,
} from "./collect-gwangju-route-topology.mjs";

const stationNames = [
  "평동역", "도산역", "광주/송정역", "송정/공원역", "공항역", "김대중컨벤션센터역",
  "상무역", "운천역", "쌍촌역", "화정역", "농성역", "돌고개역", "양동시장역",
  "금남로/5가역", "금남로/4가역", "문화전당역", "남광주역", "학동 · 증심사입구역",
  "소태역", "녹동역",
];

test("광주 공식 운행정보 API를 20개 역·38개 방향성 인접 edge로 수집한다", async () => {
  const requests = [];
  const snapshot = await collectGwangjuRouteTopology({
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
    providerStationId: "20", stationCode: "100", stationName: "녹동",
  });
  assert.deepEqual(snapshot.edges[0], {
    fromProviderStationId: "20",
    toProviderStationId: "19",
    fromStationCode: "100",
    toStationCode: "101",
    fromStationName: "녹동",
    toStationName: "소태",
    distanceMeters: 1250,
    durationSeconds: 150,
    responseSha256: snapshot.edges[0].responseSha256,
  });
  assert.equal(snapshot.contentSha256, createHash("sha256")
    .update(JSON.stringify({ scope: snapshot.scope, edges: snapshot.edges })).digest("hex"));
  assert.equal(snapshot.freshUntil, "2026-07-21T13:10:00.000Z");
});

test("광주 topology collector는 HTTP·schema·OD 완결성 오류를 fail closed한다", async () => {
  await assert.rejects(collectGwangjuRouteTopology({
    fetchImpl: async () => new Response("down", { status: 503 }),
  }), /HTTP 503/);
  await assert.rejects(collectGwangjuRouteTopology({
    fetchImpl: async () => Response.json(Array.from({ length: 19 }, () => ({ unexpected: true }))),
  }), /schema mismatch/);
  await assert.rejects(collectGwangjuRouteTopology({
    fetchImpl: async () => Response.json([]),
  }), /OD row count/);
});

test("광주 topology collector는 같은 역 ID의 괄호 부역명을 canonical 역명으로 정규화한다", async () => {
  const snapshot = await collectGwangjuRouteTopology({
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
