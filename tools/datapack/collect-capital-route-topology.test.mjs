import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildCapitalTopologyReverificationEvidence,
  collectMolitFullRouteCsv,
  compareCapitalRouteTopologies,
  parseSeohaeMerged,
} from "./collect-capital-route-topology.mjs";

const execFileAsync = promisify(execFile);

function topologyLine(lineId, scope, edges) {
  return {
    lineId,
    scope,
    edges,
    contentSha256: createHash("sha256").update(JSON.stringify({ scope, edges })).digest("hex"),
  };
}

test("MOLIT 전체노선 collector는 공개 FILE 링크의 CSV만 수집한다", async () => {
  const requests = [];
  const body = "권역,권역명,철도운영기관명,노선명,순번,역명\n01,수도권,운영사,신림선,1,샛강\n";
  const csv = await collectMolitFullRouteCsv({
    fetchImpl: async (url, init) => {
      const request = new URL(url);
      requests.push(request);
      if (requests.length === 1) {
        assert.equal(init.headers["User-Agent"], "easysubway-datapack-collector/1.0");
        return new Response('<a href="/cmm/cmm/fileDownload.do?atchFileId=FILE_123&amp;fileDetailSn=1&amp;insertDataPrcus=N">다운로드</a>');
      }
      assert.equal(init.headers.Referer, "https://www.data.go.kr/data/15122916/fileData.do");
      return new Response(body);
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].pathname, "/cmm/cmm/fileDownload.do");
  assert.deepEqual([...requests[1].searchParams], [
    ["atchFileId", "FILE_123"], ["fileDetailSn", "1"], ["insertDataPrcus", "N"],
  ]);
  assert.equal(csv.toString("utf8"), body);
});

test("서해선 병합기는 코레일 전체 파일에서 서해선 행만 사용한다", () => {
  const korail = Buffer.from([
    "철도운영기관명,선명,역명,역간거리(km)",
    "코레일,경춘선,상봉,1.7",
    "코레일,경춘선,망우,2.1",
    "코레일,서해선,일산,1.0",
    "코레일,서해선,부천종합운동장,1.0",
  ].join("\n"));
  const molit = Buffer.from([
    "권역,권역명,철도운영기관명,노선명,순번,역명",
    "01,수도권,서해철도,서해선,10,소사",
    "01,수도권,서해철도,서해선,11,원시",
  ].join("\n"));

  const parsed = parseSeohaeMerged(korail, molit, {
    slug: "seohae",
    molitRouteName: "서해선",
    molitMinSequence: 10,
  });

  assert.deepEqual(parsed.branchNames, ["서해선"]);
  assert.equal(parsed.rows.every(({ branchName, routeName }) => (branchName ?? routeName) === "서해선"), true);
});

test("capital topology 비교는 같은 edge에 변경을 보고하지 않는다", () => {
  const edge = { fromStationName: "가", toStationName: "나", distanceMeters: 100 };
  const comparison = compareCapitalRouteTopologies(
    { contentSha256: "before", lines: [topologyLine("line-1", ["가", "나"], [edge])] },
    { contentSha256: "after", lines: [topologyLine("line-1", ["가", "나"], [{ ...edge }])] },
  );
  assert.deepEqual(comparison.changes, []);
});

test("capital topology 비교는 유효한 line hash에서 edge 추가 삭제 수정을 감지한다", () => {
  const baselineEdges = [
    { fromStationName: "가", toStationName: "나", distanceMeters: 100 },
    { fromStationName: "나", toStationName: "다", distanceMeters: 100 },
    { fromStationName: "다", toStationName: "라", distanceMeters: 100 },
  ];
  const candidateEdges = [
    { fromStationName: "가", toStationName: "나", distanceMeters: 200 },
    { fromStationName: "다", toStationName: "라", distanceMeters: 100 },
    { fromStationName: "라", toStationName: "마", distanceMeters: 100 },
  ];
  const baseline = { contentSha256: "before", lines: [topologyLine("line-1", ["가", "나", "다", "라"], baselineEdges)] };
  const candidate = { contentSha256: "after", lines: [topologyLine("line-1", ["가", "나", "다", "라", "마"], candidateEdges)] };
  const comparison = compareCapitalRouteTopologies(baseline, candidate);
  assert.deepEqual(comparison.changes, [{
    lineId: "line-1",
    added: [candidateEdges[2]],
    removed: [baselineEdges[1]],
    modified: [{ before: baselineEdges[0], after: candidateEdges[0] }],
  }]);
  assert.throws(() => buildCapitalTopologyReverificationEvidence(baseline, candidate), /re-admission required/);
});

test("capital topology 비교는 scope 또는 edge의 stale stored hash를 거부한다", () => {
  const scope = ["가", "나"];
  const edges = [{ fromStationName: "가", toStationName: "나", distanceMeters: 100 }];
  const valid = topologyLine("line-1", scope, edges);
  assert.throws(() => compareCapitalRouteTopologies(
    { lines: [valid] },
    { lines: [{ ...valid, scope: [...scope, "다"] }] },
  ), /contentSha256 mismatch/);
  assert.throws(() => compareCapitalRouteTopologies(
    { lines: [valid] },
    { lines: [{ ...valid, edges: [{ ...edges[0], distanceMeters: 200 }] }] },
  ), /contentSha256 mismatch/);
});

test("capital topology evidence는 candidate 최상위 contentSha256 변조를 거부한다", () => {
  const line = {
    ...topologyLine(
      "line-1",
      ["가", "나"],
      [{ fromStationName: "가", toStationName: "나", distanceMeters: 100 }],
    ),
    datasetId: "dataset-1",
    rawSha256: "a".repeat(64),
    edgeCount: 1,
    stationCount: 2,
  };
  const baseline = { contentSha256: "b".repeat(64), lines: [line] };
  const candidate = {
    contentSha256: "f".repeat(64),
    capturedAt: "2026-08-04T17:30:34.901Z",
    freshUntil: "2026-08-05T17:30:34.901Z",
    lineCount: 1,
    totalEdgeCount: 1,
    topologyGaps: [],
    lines: [line],
  };

  assert.throws(
    () => buildCapitalTopologyReverificationEvidence(baseline, candidate),
    /candidate contentSha256 mismatch/,
  );
});

test("local CLI 기본 실행은 tracked baseline을 건드리지 않고 고정 freshness를 기록한다", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const baselinePath = path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json");
  const baselineBytes = await readFile(baselinePath);
  const outputDir = await mkdtemp(path.join(tmpdir(), "capital-topology-test-"));
  const outputPath = path.join(outputDir, "snapshot.json");
  try {
    await execFileAsync(process.execPath, [
      "tools/datapack/collect-capital-route-topology.mjs", "--output", outputPath,
    ], { cwd: root });
    const snapshot = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(snapshot.capturedAt, "2026-07-24T08:20:00.000Z");
    assert.equal(snapshot.freshUntil, "2026-07-25T08:20:00.000Z");
    assert.deepEqual(await readFile(baselinePath), baselineBytes);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
