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
  collectCapitalRouteTopology,
  collectMolitFullRouteCsv,
  compareCapitalRouteTopologies,
  LINE_SOURCES,
  mergeOfficialDistanceEvidence,
  MOLIT_FULL_ROUTE_DETAIL_URL,
  parseLineSource,
  parseSeohaeMerged,
  projectCapitalTopologyOwnership,
  resolveDataGoDownloadUrl,
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

test("current capital topology ownership projection은 Incheon 1/2만 별도 source로 분리한다", async () => {
  const snapshot = JSON.parse(await readFile(
    "tools/datapack/sources/capital-route-topology-20260724.json",
    "utf8",
  ));
  const projected = projectCapitalTopologyOwnership(snapshot);
  const separated = new Set(["line-42b5805f3b5a", "line-98718184f016"]);

  assert.equal(projected.lineCount, snapshot.lineCount - separated.size);
  assert.equal(projected.lines.some(({ lineId }) => separated.has(lineId)), false);
  assert.equal(
    projected.totalEdgeCount,
    projected.lines.reduce((sum, { edgeCount }) => sum + edgeCount, 0),
  );
  assert.notEqual(projected.contentSha256, snapshot.contentSha256);
  assert.equal(snapshot.lines.some(({ lineId }) => separated.has(lineId)), true);

  const missing = structuredClone(snapshot);
  missing.lines = missing.lines.filter(({ lineId }) => lineId !== "line-42b5805f3b5a");
  assert.throws(() => projectCapitalTopologyOwnership(missing), /Incheon topology ownership input/);
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

test("capital topology evidence는 topologyGaps 변경을 거부한다", () => {
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
  const baseline = { contentSha256: "b".repeat(64), topologyGaps: [], lines: [line] };
  const candidate = {
    capturedAt: "2026-08-04T17:30:34.901Z",
    freshUntil: "2026-08-05T17:30:34.901Z",
    lineCount: 1,
    totalEdgeCount: 1,
    topologyGaps: ["line-1"],
    lines: [line],
  };
  candidate.contentSha256 = createHash("sha256").update(JSON.stringify({
    lines: [{
      lineId: line.lineId,
      edgeCount: line.edgeCount,
      stationCount: line.stationCount,
      contentSha256: line.contentSha256,
      rawSha256: line.rawSha256,
      datasetId: line.datasetId,
    }],
    topologyGaps: candidate.topologyGaps,
  })).digest("hex");

  assert.throws(
    () => buildCapitalTopologyReverificationEvidence(baseline, candidate),
    /re-admission required/,
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

test("data.go.kr 상세 페이지는 단일 canonical FILE download만 허용한다", () => {
  const detail = "https://www.data.go.kr/data/15122916/fileData.do";
  const resolved = resolveDataGoDownloadUrl(`
    <a href="/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700001&amp;fileDetailSn=1&amp;insertDataPrcus=N">CSV</a>
  `, detail);
  assert.equal(
    resolved,
    "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700001&fileDetailSn=1&insertDataPrcus=N",
  );
  assert.equal(
    resolveDataGoDownloadUrl(
      `<button onclick="fn_fileDown('FILE_000000003700001', '1')">CSV</button>`,
      detail,
    ),
    "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700001&fileDetailSn=1&insertDataPrcus=N",
  );
  assert.equal(resolveDataGoDownloadUrl(`
    <a href="/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700001&amp;fileDetailSn=1">CSV</a>
    <button onclick="fn_fileDown('FILE_000000003700001', '1')">CSV</button>
  `, detail), resolved);
  assert.throws(() => resolveDataGoDownloadUrl("<html>none</html>", detail), /exactly one/);
  assert.throws(
    () => resolveDataGoDownloadUrl(`
      /cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700001&amp;fileDetailSn=1
      /cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700002&amp;fileDetailSn=1
    `, detail),
    /exactly one/,
  );
  assert.throws(
    () => resolveDataGoDownloadUrl(
      "https://evil.example/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700001&fileDetailSn=1",
      detail,
    ),
    /canonical data.go.kr/,
  );
});

test("한 topology snapshot은 shared MOLIT bytes와 resolved URL을 한 번만 수집한다", async () => {
  const sources = ["gimpo", "sillim", "seohae"]
    .map((slug) => LINE_SOURCES.find((source) => source.slug === slug));
  const seohae = sources.find(({ slug }) => slug === "seohae");
  const sharedDownloadUrl = "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700001&fileDetailSn=1&insertDataPrcus=N";
  const molitCsv = `권역,권역명,철도운영기관명,노선명,순번,역명
1,수도권,김포골드라인운영,김포골드라인,1,양촌
1,수도권,김포골드라인운영,김포골드라인,2,구래
1,수도권,남서울경전철,신림선,1,샛강
1,수도권,남서울경전철,신림선,2,대방
1,수도권,서해철도,서해선,10,소사
1,수도권,서해철도,서해선,11,원시`;
  const seohaeCsv = `철도운영기관명,선명,역명,역간거리(km)
코레일,서해선,일산,1.9
코레일,서해선,부천종합운동장역,1.4`;
  const responses = new Map([
    [MOLIT_FULL_ROUTE_DETAIL_URL, `<a href="${sharedDownloadUrl}">CSV</a>`],
    [sharedDownloadUrl, molitCsv],
    [seohae.downloadUrl, seohaeCsv],
  ]);
  const requestCounts = new Map();

  const snapshot = await collectCapitalRouteTopology({
    useLocalFiles: false,
    sources,
    now: new Date("2026-08-09T12:04:20.479Z"),
    fetchImpl: async (url) => {
      const value = String(url);
      if (!responses.has(value)) throw new Error(`unexpected URL: ${value}`);
      requestCounts.set(value, (requestCounts.get(value) ?? 0) + 1);
      return new Response(responses.get(value));
    },
  });

  assert.deepEqual([...requestCounts.values()], [1, 1, 1]);
  const bySlug = new Map(snapshot.lines.map((line) => [line.slug, line]));
  assert.equal(bySlug.get("gimpo").rawSha256, bySlug.get("sillim").rawSha256);
  assert.equal(
    bySlug.get("gimpo").rawSha256,
    bySlug.get("seohae").inputProvenance[1].rawSha256,
  );
  assert.equal(bySlug.get("gimpo").endpoint, sharedDownloadUrl);
  assert.equal(bySlug.get("seohae").inputProvenance[1].downloadUrl, sharedDownloadUrl);
});

test("data.go.kr detail source는 실제 resolved download URL을 line provenance에 보존한다", async () => {
  const source = LINE_SOURCES.find(({ slug }) => slug === "gimpo");
  const downloadUrl = "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700001&fileDetailSn=1";
  const csv = Buffer.from([
    "권역,권역명,철도운영기관명,노선명,순번,역명",
    "1,수도권,김포골드라인운영,김포골드라인,1,양촌",
    "1,수도권,김포골드라인운영,김포골드라인,2,구래",
  ].join("\n"));
  const fetchImpl = async (url) => {
    if (url === source.detailUrl) {
      return {
        ok: true,
        text: async () => `<a href="${downloadUrl}">CSV</a>`,
      };
    }
    assert.equal(url, downloadUrl);
    return { ok: true, arrayBuffer: async () => csv };
  };

  const snapshot = await collectCapitalRouteTopology({
    fetchImpl,
    now: new Date("2026-08-09T12:04:20.479Z"),
    useLocalFiles: false,
    sources: [source],
  });

  assert.equal(snapshot.lines[0].endpoint, downloadUrl);
});

test("상충하는 official 거리는 선택하지 않고 conflict evidence를 보존한다", () => {
  assert.deepEqual(
    mergeOfficialDistanceEvidence({ distanceMeters: 1700 }, 2100),
    { distanceMeters: 0, distanceConflictMeters: [1700, 2100] },
  );
  assert.deepEqual(
    mergeOfficialDistanceEvidence({ distanceMeters: 0, distanceConflictMeters: [1700, 2100] }, 1700),
    { distanceMeters: 0, distanceConflictMeters: [1700, 2100] },
  );
  assert.deepEqual(mergeOfficialDistanceEvidence({ distanceMeters: 0 }, 600), { distanceMeters: 600 });
});

test("서해선 official file이 다른 노선을 함께 반환해도 서해선 branch만 수용한다", () => {
  const source = LINE_SOURCES.find(({ slug }) => slug === "seohae");
  const korailBytes = Buffer.from([
    "철도운영기관명,선명,역명,역간거리(km)",
    "코레일,1호선(경부선),가능,1.0",
    "코레일,1호선(경부선),의정부,1.4",
    "코레일,서해선,일산,1.9",
    "코레일,서해선,풍산,1.7",
    "코레일,서해선,백마,1.6",
    "코레일,서해선,부천종합운동장역,1.4",
  ].join("\n"));
  const molitBytes = Buffer.from([
    "권역,권역명,철도운영기관명,노선명,순번,역명",
    "1,수도권,서해철도,서해선,10,소사",
    "1,수도권,서해철도,서해선,11,소새울",
  ].join("\n"));

  const result = parseLineSource(source, korailBytes, {
    capturedAt: new Date("2026-08-09T12:04:20.479Z"),
    resolvedDownloadUrl: source.downloadUrl,
    secondaryBytes: molitBytes,
    secondaryProvenance: {
      datasetId: "15122916",
      detailUrl: source.molitDownloadUrl,
      downloadUrl: "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700001&fileDetailSn=1",
    },
  });

  assert.deepEqual(result.branchNames, ["서해선"]);
  assert.equal(result.scope.some(({ stationName }) => stationName === "가능"), false);
  assert.equal(result.scope.some(({ stationName }) => stationName === "일산"), true);
  assert.deepEqual(result.inputProvenance.map(({ datasetId, detailUrl, downloadUrl }) => ({
    datasetId,
    detailUrl,
    downloadUrl,
  })), [
    {
      datasetId: source.datasetId,
      detailUrl: source.detailUrl,
      downloadUrl: source.downloadUrl,
    },
    {
      datasetId: "15122916",
      detailUrl: source.molitDownloadUrl,
      downloadUrl: "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003700001&fileDetailSn=1",
    },
  ]);
  assert.equal(result.inputProvenance.every(({ rawSha256 }) => /^[a-f0-9]{64}$/.test(rawSha256)), true);
});

test("서해선 splice endpoint가 각 공식 입력에 없으면 거부한다", () => {
  const source = LINE_SOURCES.find(({ slug }) => slug === "seohae");
  const korailBytes = Buffer.from([
    "철도운영기관명,선명,역명,역간거리(km)",
    "코레일,서해선,일산,1.9",
    "코레일,서해선,풍산,1.7",
  ].join("\n"));
  const molitBytes = Buffer.from([
    "권역,권역명,철도운영기관명,노선명,순번,역명",
    "1,수도권,서해철도,서해선,10,소사",
    "1,수도권,서해철도,서해선,11,소새울",
  ].join("\n"));

  assert.throws(
    () => parseLineSource(source, korailBytes, {
      capturedAt: new Date("2026-08-09T12:04:20.479Z"),
      resolvedDownloadUrl: source.downloadUrl,
      secondaryBytes: molitBytes,
      secondaryProvenance: {
        datasetId: "15122916",
        detailUrl: source.molitDownloadUrl,
        downloadUrl: source.molitDownloadUrl,
      },
    }),
    /서해선 splice endpoint missing: 부천종합운동장-소사/,
  );
});
