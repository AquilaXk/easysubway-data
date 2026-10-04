import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TRANSFER_STAIR_DURATION_BASIS,
  TRANSFER_STEP_VOCABULARY,
  classifyTransferStep,
  deriveTransferStairAccess,
  loadTransferStairAccessInputs,
} from "./build-transfer-stair-access.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";

// #925 RED 계획. fixture 기대값은 손으로 적는다(도구 출력에서 복사하지 않는다).

// 매핑 표는 커밋된 KRIC 코드 카탈로그 노선만 가리킨다. fixture도 같은 카탈로그를 쓴다.
const PROVIDER_CODE_CATALOG = JSON.parse(await readFile("tools/datapack/sources/kric-provider-code-catalog-20260228.json", "utf8"));
const SNAPSHOT_ID = "molit-railway-transfer-movement-20260811";

function sadangCatalog({ extraStations = [], extraStationLines = [] } = {}) {
  return {
    stations: [
      { id: "station-sadang", nameKo: "사당", nameSub: "" },
      { id: "station-bangbae", nameKo: "방배", nameSub: "" },
      { id: "station-nakseongdae", nameKo: "낙성대", nameSub: "" },
      { id: "station-chongshin", nameKo: "총신대입구", nameSub: "이수" },
      { id: "station-namtaeryeong", nameKo: "남태령", nameSub: "" },
      ...extraStations,
    ],
    lines: [
      { id: "seoul-2", nameKo: "수도권 2호선" },
      { id: "seoul-4", nameKo: "수도권 4호선" },
    ],
    stationLines: [
      ["station-sadang", "seoul-2"], ["station-bangbae", "seoul-2"], ["station-nakseongdae", "seoul-2"],
      ["station-sadang", "seoul-4"], ["station-chongshin", "seoul-4"], ["station-namtaeryeong", "seoul-4"],
      ...extraStationLines,
    ].map(([stationId, lineId]) => ({ stationId, lineId })),
  };
}

function ride(from, to, lineId, servicePattern = "LOCAL") {
  return {
    edgeId: `ride-${from}-${to}-${lineId}-${servicePattern}`,
    edgeType: "RIDE",
    fromNodeId: `${from}:${lineId}`,
    toNodeId: `${to}:${lineId}`,
    servicePattern,
    serviceClass: servicePattern === "LOCAL" ? "SUBWAY" : "ITX_CHEONGCHUN",
  };
}

function transfer(stationId, fromLineId, toLineId) {
  return {
    edgeId: `transfer-${stationId}-${fromLineId}-${toLineId}`,
    edgeType: "IN_STATION_TRANSFER",
    fromNodeId: `${stationId}:${fromLineId}`,
    toNodeId: `${stationId}:${toLineId}`,
    servicePattern: "",
    serviceClass: "SUBWAY",
  };
}

function sadangRouteEdges() {
  const both = (a, b, line) => [ride(a, b, line), ride(b, a, line)];
  return [
    ...both("station-bangbae", "station-sadang", "seoul-2"),
    ...both("station-sadang", "station-nakseongdae", "seoul-2"),
    ...both("station-chongshin", "station-sadang", "seoul-4"),
    ...both("station-sadang", "station-namtaeryeong", "seoul-4"),
    transfer("station-sadang", "seoul-2", "seoul-4"),
    transfer("station-sadang", "seoul-4", "seoul-2"),
  ];
}

// 원천 한 경로(1단계부터 마지막 승차까지)를 원천 행으로 펼친다.
function pathRows({ operator = "S1(서울교통공사)", line, station = "사당", from, to, steps }) {
  const details = [`(B2) ${from} 승강장 하차`, ...steps, "승차 (휠체어칸)"];
  return details.map((detail, index) => ({
    RAIL_OPR_ISTT_CD: operator,
    LN_NM: line,
    STIN_NM: station,
    CHTN_MV_TP_ORDR: String(index + 1),
    MV_CONT_DTL: `${index + 1}) ${detail}`,
    CHTN_MV_CONT: index === 0 ? from : index === details.length - 1 ? to : "",
  }));
}

const ELEVATOR_STEPS = Object.freeze([
  "대합실 방향 엘리베이터 탑승",
  "(B1) 대합실로 이동",
  "승강장 방향 엘리베이터 탑승",
  "(B3) 다음 노선 승강장으로 이동",
]);

function sadangRows({ steps = () => ELEVATOR_STEPS, skip = () => false } = {}) {
  const rows = [];
  for (const [line, fromDirections, toLine, toDirections] of [
    ["2호선", ["방배", "낙성대"], "4호선", ["총신대입구", "남태령"]],
    ["4호선", ["총신대입구", "남태령"], "2호선", ["방배", "낙성대"]],
  ]) {
    for (const fromDirection of fromDirections) {
      for (const toDirection of toDirections) {
        const combo = { line, fromDirection, toLine, toDirection };
        if (skip(combo)) continue;
        rows.push(...pathRows({
          line,
          from: `${line} ${fromDirection} 방면`,
          to: `${toLine} ${toDirection} 방면`,
          steps: steps(combo),
        }));
      }
    }
  }
  return rows;
}

function derive({ rows, catalog = sadangCatalog(), routeEdges = sadangRouteEdges() } = {}) {
  return deriveTransferStairAccess({
    snapshot: { sourceId: "molit-railway-transfer-movement", snapshotId: SNAPSHOT_ID, rows },
    providerCodeCatalog: PROVIDER_CODE_CATALOG,
    catalog,
    routeEdges,
  });
}

function edgeState(result, edgeId) {
  const matches = result.edges.filter((edge) => edge.edgeId === edgeId);
  assert.equal(matches.length, 1, edgeId);
  return matches[0];
}

const EDGE_2_4 = "transfer-station-sadang-seoul-2-seoul-4";
const EDGE_4_2 = "transfer-station-sadang-seoul-4-seoul-2";

test("RED1 사당형: 두 노선 x 두 방면 4개 조합 모두 엘리베이터 경로면 두 방향 간선 모두 STEP_FREE다", () => {
  const result = derive({ rows: sadangRows() });
  for (const edgeId of [EDGE_2_4, EDGE_4_2]) {
    const edge = edgeState(result, edgeId);
    assert.equal(edge.state, "STEP_FREE", edgeId);
    assert.equal(edge.reason, "ALL_DIRECTION_COMBOS_STEP_FREE");
    assert.equal(edge.combos.length, 4);
  }
  // 근거 표: 간선 x 방면 조합 x 계단 없는 경로마다 한 행. 조합의 방면은 인접 역 id다.
  assert.equal(result.evidenceRows.length, 8);
  assert.deepEqual(
    result.evidenceRows.filter(({ edgeId }) => edgeId === EDGE_2_4)
      .map(({ fromDirectionStationId, toDirectionStationId }) => `${fromDirectionStationId}>${toDirectionStationId}`),
    [
      "station-bangbae>station-chongshin",
      "station-bangbae>station-namtaeryeong",
      "station-nakseongdae>station-chongshin",
      "station-nakseongdae>station-namtaeryeong",
    ],
  );
  for (const row of result.evidenceRows) {
    assert.equal(row.sourceSnapshotId, SNAPSHOT_ID);
    assert.match(row.pathSha256, /^[0-9a-f]{64}$/);
    assert.equal(row.durationBasis, TRANSFER_STAIR_DURATION_BASIS);
  }
  assert.equal(TRANSFER_STAIR_DURATION_BASIS, "GENERAL_TRANSFER_EDGE_NOT_STEP_FREE_PATH");
});

test("RED2 방면 조합 4개 중 1개 경로가 없으면 UNKNOWN(DIRECTION_COMBO_MISSING)이다", () => {
  const result = derive({ rows: sadangRows({
    skip: ({ line, fromDirection, toDirection }) => line === "2호선" && fromDirection === "낙성대" && toDirection === "남태령",
  }) });
  const edge = edgeState(result, EDGE_2_4);
  assert.equal(edge.state, "UNKNOWN");
  assert.equal(edge.reason, "DIRECTION_COMBO_MISSING");
  assert.equal(result.evidenceRows.some(({ edgeId }) => edgeId === EDGE_2_4), false);
  assert.equal(edgeState(result, EDGE_4_2).state, "STEP_FREE");
});

test("RED3 경로에 장애인용리프트가 있으면 그 조합은 계단 없음 근거가 아니다(D2 UNKNOWN)", () => {
  const result = derive({ rows: sadangRows({
    steps: ({ line, fromDirection, toDirection }) => (line === "2호선" && fromDirection === "방배" && toDirection === "총신대입구"
      ? ["대합실 방향 장애인용리프트 탑승", "(B1) 대합실로 이동"]
      : ELEVATOR_STEPS),
  }) });
  const edge = edgeState(result, EDGE_2_4);
  assert.equal(edge.state, "UNKNOWN");
  assert.equal(edge.reason, "DIRECTION_COMBO_NOT_STEP_FREE");
  const combo = edge.combos.find(({ fromDirectionStationId, toDirectionStationId }) =>
    fromDirectionStationId === "station-bangbae" && toDirectionStationId === "station-chongshin");
  assert.deepEqual(combo.blockingReasons, ["LIFT"]);
  assert.equal(classifyTransferStep("휠체어리프트 탑승").kind, "LIFT");
});

test("RED4 계단옆 엘리베이터처럼 계단이 위치 설명으로만 나와도 계단 키워드가 먼저 걸러 UNKNOWN이 된다", () => {
  assert.equal(classifyTransferStep("계단옆 엘리베이터 이용 후 지하2층 이동").kind, "STAIRS");
  assert.equal(classifyTransferStep("계단옆 엘리베이터 이용 후 지하2층 이동").effect, "BLOCKING");
  const result = derive({ rows: sadangRows({
    steps: ({ line }) => (line === "4호선" ? ["계단옆 엘리베이터 탑승", "(B2) 대합실로 이동"] : ELEVATOR_STEPS),
  }) });
  assert.equal(edgeState(result, EDGE_4_2).state, "UNKNOWN");
  assert.equal(edgeState(result, EDGE_4_2).reason, "DIRECTION_COMBO_NOT_STEP_FREE");
  assert.equal(edgeState(result, EDGE_2_4).state, "STEP_FREE");
});

test("RED5 어휘 표에 없는 문구가 하나라도 있으면 UNKNOWN이다", () => {
  assert.equal(classifyTransferStep("지상에서 경의중앙선 역사로 이동").kind, "UNRECOGNIZED");
  assert.equal(classifyTransferStep("환승통로").kind, "UNRECOGNIZED");
  const result = derive({ rows: sadangRows({
    steps: ({ line, toDirection }) => (line === "2호선" && toDirection === "남태령"
      ? [...ELEVATOR_STEPS.slice(0, 3), "무빙워크 탑승", ELEVATOR_STEPS[3]]
      : ELEVATOR_STEPS),
  }) });
  const edge = edgeState(result, EDGE_2_4);
  assert.equal(edge.state, "UNKNOWN");
  assert.ok(edge.combos.some(({ blockingReasons }) => blockingReasons.includes("STEP_WORDING_UNRECOGNIZED")));
});

test("RED6 층 표기가 B2에서 B1로 바뀌는데 사이에 승강 설비 단계가 없으면 UNKNOWN이다", () => {
  const result = derive({ rows: sadangRows({
    steps: ({ line }) => (line === "2호선" ? ["(B1) 대합실로 이동", "승강장 방향 엘리베이터 탑승", "(B3) 승강장으로 이동"] : ELEVATOR_STEPS),
  }) });
  const edge = edgeState(result, EDGE_2_4);
  assert.equal(edge.state, "UNKNOWN");
  assert.ok(edge.combos.every(({ blockingReasons }) => blockingReasons.includes("FLOOR_CHANGE_WITHOUT_LIFT")));
  // 같은 층 안의 평면 이동은 승강 설비가 없어도 된다.
  const sameFloor = derive({ rows: sadangRows({ steps: () => ["(B2) 환승통로로 이동", "(B2) 승강장으로 이동"] }) });
  assert.equal(edgeState(sameFloor, EDGE_2_4).state, "STEP_FREE");
  // 문장 안의 층(지하 N층)도 층 표기다.
  const textual = derive({ rows: sadangRows({ steps: () => ["지하 1층으로 이동"] }) });
  assert.equal(edgeState(textual, EDGE_2_4).state, "UNKNOWN");
});

test("RED7 계단 경로만 있는 역(광운대 경춘형)은 UNKNOWN이고 STAIR_ONLY를 만들지 않는다", () => {
  const catalog = {
    stations: [
      { id: "station-kwangwoon", nameKo: "광운대", nameSub: "" },
      { id: "station-wolgye", nameKo: "월계", nameSub: "" },
      { id: "station-seokgye", nameKo: "석계", nameSub: "" },
      { id: "station-sangbong", nameKo: "상봉", nameSub: "" },
      { id: "station-dummy", nameKo: "가상역", nameSub: "" },
    ],
    lines: [{ id: "capital-1", nameKo: "수도권 1호선" }, { id: "gyeongchun", nameKo: "수도권 경춘" }],
    stationLines: [
      ["station-kwangwoon", "capital-1"], ["station-wolgye", "capital-1"], ["station-seokgye", "capital-1"],
      ["station-kwangwoon", "gyeongchun"], ["station-sangbong", "gyeongchun"], ["station-dummy", "gyeongchun"],
    ].map(([stationId, lineId]) => ({ stationId, lineId })),
  };
  const routeEdges = [
    ride("station-wolgye", "station-kwangwoon", "capital-1"), ride("station-kwangwoon", "station-seokgye", "capital-1"),
    ride("station-sangbong", "station-kwangwoon", "gyeongchun"), ride("station-kwangwoon", "station-dummy", "gyeongchun"),
    transfer("station-kwangwoon", "gyeongchun", "capital-1"),
  ];
  const rows = [];
  for (const from of ["상봉", "가상역"]) {
    for (const to of ["월계", "석계"]) {
      rows.push(...pathRows({
        operator: "KR(한국철도공사)", line: "경춘", station: "광운대",
        from: `경춘선 ${from} 방면`, to: `1호선 ${to} 방면`,
        steps: ["(B1) 계단으로 이동", "(B2) 1호선 승강장으로 이동"],
      }));
    }
  }
  const result = derive({ rows, catalog, routeEdges });
  const edge = edgeState(result, "transfer-station-kwangwoon-gyeongchun-capital-1");
  assert.equal(edge.state, "UNKNOWN");
  assert.equal(edge.reason, "DIRECTION_COMBO_NOT_STEP_FREE");
  assert.equal(result.edges.some(({ state }) => state === "STAIR_ONLY"), false);
  assert.deepEqual(result.evidenceRows, []);
});

test("RED8 역명이 둘 이상의 정본 역에 매핑되면 그 경로는 CANONICAL_STATION_AMBIGUOUS로 제외된다", () => {
  const catalog = sadangCatalog({
    extraStations: [{ id: "station-sadang-twin", nameKo: "사당", nameSub: "" }],
    extraStationLines: [{ stationId: "station-sadang-twin", lineId: "seoul-2" }].map(({ stationId, lineId }) => [stationId, lineId]),
  });
  const result = derive({ rows: sadangRows(), catalog });
  assert.equal(edgeState(result, EDGE_2_4).state, "UNKNOWN");
  assert.equal(edgeState(result, EDGE_2_4).reason, "NO_OFFICIAL_PATH");
  assert.ok(result.excludedPaths.length >= 4);
  assert.ok(result.excludedPaths.filter(({ providerLineName }) => providerLineName === "2호선")
    .every(({ reason }) => reason === "CANONICAL_STATION_AMBIGUOUS"));
  assert.equal(result.summary.excludedPathsByReason.CANONICAL_STATION_AMBIGUOUS, 4);
});

test("RED9 원천 경로 순서를 바꿔도 결과 바이트가 같다", () => {
  const rows = sadangRows({
    steps: ({ toDirection }) => (toDirection === "남태령" ? ["휠체어리프트 탑승", "(B1) 대합실로 이동"] : ELEVATOR_STEPS),
  });
  const paths = [];
  for (const row of rows) {
    if (row.CHTN_MV_TP_ORDR === "1") paths.push([]);
    paths.at(-1).push(row);
  }
  const reversed = [...paths].reverse().flat();
  const rotated = [...paths.slice(3), ...paths.slice(0, 3)].flat();
  // 손으로 적은 기대값: 남태령 방면 경로만 리프트라 2->4는 UNKNOWN, 4->2는 STEP_FREE(근거 4행)다.
  for (const permuted of [rows, reversed, rotated]) {
    const result = derive({ rows: permuted });
    assert.deepEqual(result.edges.map(({ edgeId, state, reason }) => [edgeId, state, reason]), [
      [EDGE_2_4, "UNKNOWN", "DIRECTION_COMBO_NOT_STEP_FREE"],
      [EDGE_4_2, "STEP_FREE", "ALL_DIRECTION_COMBOS_STEP_FREE"],
    ]);
    assert.deepEqual(result.evidenceRows.map(({ edgeId, fromDirectionStationId, toDirectionStationId }) => `${edgeId}|${fromDirectionStationId}>${toDirectionStationId}`), [
      `${EDGE_4_2}|station-chongshin>station-bangbae`,
      `${EDGE_4_2}|station-chongshin>station-nakseongdae`,
      `${EDGE_4_2}|station-namtaeryeong>station-bangbae`,
      `${EDGE_4_2}|station-namtaeryeong>station-nakseongdae`,
    ]);
  }
  const expected = canonicalJson(derive({ rows }));
  // anti-cheat-allow: circular-oracle -- 경로 순서만 바꾼 같은 입력의 결과 바이트가 같은지 보는 결정론(순서 무관) 검증
  assert.equal(canonicalJson(derive({ rows: reversed })), expected);
  // anti-cheat-allow: circular-oracle -- 경로 순서만 바꾼 같은 입력의 결과 바이트가 같은지 보는 결정론(순서 무관) 검증
  assert.equal(canonicalJson(derive({ rows: rotated })), expected);
});

test("방면 집합: 급행 간선은 넣지 않고, 인접 역이 둘이 아닌 역(분기·종착)은 DIRECTION_SET_UNDETERMINED다", () => {
  const withExpress = derive({ rows: sadangRows(), routeEdges: [
    ...sadangRouteEdges(),
    ride("station-sadang", "station-far-express", "seoul-4", "EXPRESS"),
  ] });
  assert.equal(edgeState(withExpress, EDGE_2_4).state, "STEP_FREE");
  const branch = derive({
    rows: sadangRows(),
    catalog: sadangCatalog({ extraStations: [{ id: "station-branch", nameKo: "분기역", nameSub: "" }], extraStationLines: [["station-branch", "seoul-2"]] }),
    routeEdges: [...sadangRouteEdges(), ride("station-sadang", "station-branch", "seoul-2")],
  });
  assert.equal(edgeState(branch, EDGE_2_4).state, "UNKNOWN");
  assert.equal(edgeState(branch, EDGE_2_4).reason, "DIRECTION_SET_UNDETERMINED");
});

test("방면 표기가 '<노선> <역> 방면' 형식이 아니거나 인접 역으로 풀리지 않으면 경로를 사유와 함께 제외한다", () => {
  const rows = sadangRows().map((row) => {
    if (row.LN_NM === "2호선" && row.CHTN_MV_CONT === "4호선 남태령 방면") return { ...row, CHTN_MV_CONT: "4호선 남태령 방면 승강장" };
    if (row.LN_NM === "4호선" && row.CHTN_MV_CONT === "2호선 낙성대 방면") return { ...row, CHTN_MV_CONT: "2호선 서울대입구 방면" };
    return row;
  });
  const result = derive({ rows });
  assert.equal(edgeState(result, EDGE_2_4).reason, "DIRECTION_COMBO_MISSING");
  assert.equal(edgeState(result, EDGE_4_2).reason, "DIRECTION_COMBO_MISSING");
  assert.equal(result.summary.excludedPathsByReason.DIRECTION_FORMAT_UNSUPPORTED, 2);
  assert.equal(result.summary.excludedPathsByReason.DIRECTION_NAME_UNRESOLVED, 2);
  // 부명(이수)을 붙인 정본 표기 '총신대입구(이수)'는 정확히 같은 이름이라 풀린다. 유사 이름은 풀지 않는다.
  const subName = derive({ rows: sadangRows().map((row) => (row.CHTN_MV_CONT === "4호선 총신대입구 방면"
    ? { ...row, CHTN_MV_CONT: "4호선 총신대입구(이수) 방면" } : row)) });
  assert.equal(edgeState(subName, EDGE_2_4).state, "STEP_FREE");
  const fuzzy = derive({ rows: sadangRows().map((row) => (row.CHTN_MV_CONT === "4호선 총신대입구 방면"
    ? { ...row, CHTN_MV_CONT: "4호선 총신대 방면" } : row)) });
  assert.equal(edgeState(fuzzy, EDGE_2_4).state, "UNKNOWN");
});

test("원천 경로가 없는 환승 간선은 UNKNOWN(NO_OFFICIAL_PATH)이고 단계 순서가 깨진 경로는 제외한다", () => {
  const none = derive({ rows: [] });
  assert.equal(edgeState(none, EDGE_2_4).reason, "NO_OFFICIAL_PATH");
  const broken = sadangRows().map((row, index) => (index === 2 ? { ...row, CHTN_MV_TP_ORDR: "4" } : row));
  const result = derive({ rows: broken });
  assert.equal(result.summary.excludedPathsByReason.STEP_SEQUENCE_INVALID, 1);
  assert.equal(edgeState(result, EDGE_2_4).reason, "DIRECTION_COMBO_MISSING");
});

test("단계 어휘 표는 닫혀 있고 각 규칙의 예시는 그 규칙으로 분류된다", () => {
  const ids = TRANSFER_STEP_VOCABULARY.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(Object.isFrozen(TRANSFER_STEP_VOCABULARY));
  const stepFreeKinds = new Set(TRANSFER_STEP_VOCABULARY.filter(({ effect }) => effect === "STEP_FREE").map(({ kind }) => kind));
  assert.deepEqual([...stepFreeKinds].sort(), ["ALIGHT", "BOARD", "ELEVATOR", "FARE_GATE", "LEVEL_MOVE", "PLATFORM_ENDPOINT"]);
  const blockingKinds = new Set(TRANSFER_STEP_VOCABULARY.filter(({ effect }) => effect === "BLOCKING").map(({ kind }) => kind));
  assert.deepEqual([...blockingKinds].sort(), ["ESCALATOR", "LIFT", "OUTSIDE", "STAIRS", "UNAVAILABLE"]);
  for (const rule of TRANSFER_STEP_VOCABULARY) {
    assert.ok(rule.examples.length > 0, rule.id);
    for (const example of rule.examples) {
      const classified = classifyTransferStep(example);
      assert.equal(classified.ruleId, rule.id, `${rule.id}: ${example}`);
      assert.equal(classified.kind, rule.kind, `${rule.id}: ${example}`);
    }
  }
  // 개표구 통과(D3)는 계단 없음 단계다.
  assert.equal(classifyTransferStep("4) 표 내는 곳 통과").kind, "FARE_GATE");
  assert.equal(classifyTransferStep("4) 표 내는 곳 통과").effect, "STEP_FREE");
  // 번호·층 표기·휠체어칸 표기를 걷어 내고 판정하며, 층은 따로 돌려준다.
  assert.deepEqual(classifyTransferStep("5) (B3) 4호선 총신대입구 방면 승강장으로 이동").floors, ["B3"]);
  assert.equal(classifyTransferStep("6) 승차 (휠체어칸)").kind, "BOARD");
  assert.equal(classifyTransferStep("승차 (1-4/4-1 휠체어칸)").kind, "BOARD");
  assert.equal(classifyTransferStep("승차 (휠체어칸").kind, "UNRECOGNIZED");
  assert.deepEqual(classifyTransferStep("상봉방면 지상2층 엘리베이터").floors, ["2F"]);
  assert.equal(classifyTransferStep("에스컬레이터 탑승").kind, "ESCALATOR");
  assert.equal(classifyTransferStep("2번 출구로 이동").kind, "OUTSIDE");
  assert.equal(classifyTransferStep("역사 바깥으로 이동").kind, "OUTSIDE");
  assert.equal(classifyTransferStep("엘리베이터 고장 시 직원 호출").kind, "UNAVAILABLE");
});

test("D3 개표구를 통과하는 경로도 계단 없음 경로다", () => {
  const result = derive({ rows: sadangRows({
    steps: () => ["대합실 방향 엘리베이터 탑승", "(B1) 대합실로 이동", "표 내는 곳 통과", "승강장 방향 엘리베이터 탑승", "(B3) 승강장으로 이동"],
  }) });
  assert.equal(edgeState(result, EDGE_2_4).state, "STEP_FREE");
});

test("커밋된 MOLIT 스냅샷을 inventory 승인·hash·신선도로 검증해 읽고, 어긋나면 실패한다", async (t) => {
  const evaluationAt = "2026-10-04T15:00:00.000Z";
  const inputs = await loadTransferStairAccessInputs({ repositoryRoot: process.cwd(), evaluationAt });
  assert.equal(inputs.snapshot.snapshotId, SNAPSHOT_ID);
  assert.equal(inputs.snapshot.rows.length, 8094);
  assert.equal(inputs.freshUntil, "2027-08-11T00:00:00.000Z");
  assert.ok(Array.isArray(inputs.providerCodeCatalog.providerLines));
  await assert.rejects(
    loadTransferStairAccessInputs({ repositoryRoot: process.cwd(), evaluationAt: "2027-08-11T00:00:00.000Z" }),
    /MOLIT transfer snapshot is expired/,
  );
  const temp = await mkdtemp(path.join(os.tmpdir(), "transfer-stair-inputs-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const relative of [
    "tools/datapack/source-inventory.json", "tools/datapack/source-candidates.json",
    "release/product-gates/datapack-freshness-sla.json",
    "tools/datapack/sources/molit-railway-transfer-movement-20260811.csv.gz",
    "tools/datapack/sources/molit-railway-transfer-movement-20260811.csv.gz.json",
    "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
  ]) await cp(relative, path.join(temp, relative), { recursive: true });
  const gzipPath = path.join(temp, "tools/datapack/sources/molit-railway-transfer-movement-20260811.csv.gz");
  const original = await readFile(gzipPath);
  await writeFile(gzipPath, Buffer.concat([original, Buffer.from([0])]));
  await assert.rejects(loadTransferStairAccessInputs({ repositoryRoot: temp, evaluationAt }), /MOLIT transfer raw binding mismatch/);
  await writeFile(gzipPath, original);
  const candidatesPath = path.join(temp, "tools/datapack/source-candidates.json");
  const candidates = JSON.parse(await readFile(candidatesPath, "utf8"));
  candidates.candidates.find(({ id }) => id === "molit-railway-transfer-movement").admissionStatus = "candidate";
  await writeFile(candidatesPath, JSON.stringify(candidates));
  await assert.rejects(loadTransferStairAccessInputs({ repositoryRoot: temp, evaluationAt }), /source is not admitted for transfer stair access/);
  assert.equal(createHash("sha256").update(original).digest("hex"), "d509b22ec20e770e1e55853feae88721741a91a8d3ee85eaae27b44455ed3ef5");
});

test("승강장 위치 표기(9호선형 '사평 방면 승강장')는 경로의 처음·끝에서만 승하차 지점으로 인정한다", () => {
  const ninthStyle = (combo) => ["엘리베이터 이용", "지하 1층으로 이동", `${combo.toLine} ${combo.toDirection} 방면 엘리베이터 이용`, "지하 3층으로 이동"];
  const rows = sadangRows({ steps: ninthStyle }).map((row, index, all) => {
    const last = index === all.length - 1 || all[index + 1].CHTN_MV_TP_ORDR === "1";
    if (row.CHTN_MV_TP_ORDR === "1") return { ...row, MV_CONT_DTL: `1) ${row.CHTN_MV_CONT.split(" ").slice(1).join(" ")} 승강장` };
    if (last) return { ...row, MV_CONT_DTL: `${row.CHTN_MV_TP_ORDR}) ${row.CHTN_MV_CONT} 승강장` };
    return row;
  });
  assert.equal(classifyTransferStep("1) 방배 방면 승강장").kind, "PLATFORM_ENDPOINT");
  const result = derive({ rows });
  assert.equal(edgeState(result, EDGE_2_4).state, "STEP_FREE");
  assert.equal(edgeState(result, EDGE_4_2).state, "STEP_FREE");
  // 경로 중간의 승강장 위치 표기는 승하차 지점이 아니므로 어휘 밖 문구로 다룬다.
  const middle = derive({ rows: sadangRows({ steps: () => [...ELEVATOR_STEPS.slice(0, 2), "환승 방면 승강장", ...ELEVATOR_STEPS.slice(2)] }) });
  assert.equal(edgeState(middle, EDGE_2_4).state, "UNKNOWN");
  assert.ok(edgeState(middle, EDGE_2_4).combos.every(({ blockingReasons }) => blockingReasons.includes("STEP_WORDING_UNRECOGNIZED")));
});
