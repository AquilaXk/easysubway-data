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
import { parseDirection } from "./lib/transfer-direction.mjs";

// #925 RED 계획. fixture 기대값은 손으로 적는다(도구 출력에서 복사하지 않는다).

// 매핑 표는 커밋된 KRIC 코드 카탈로그 노선만 가리킨다. fixture도 같은 카탈로그를 쓴다.
const PROVIDER_CODE_CATALOG = JSON.parse(await readFile("tools/datapack/sources/kric-provider-code-catalog-20260228.json", "utf8"));
const SNAPSHOT_ID = "molit-railway-transfer-movement-20260811";
// 어휘 표 예시가 쓰는 역 이름. 운영 판정에서는 번들 정본 역 이름이 이 자리에 들어간다.
const EXAMPLE_STATION_NAMES = Object.freeze(["방배", "서강대", "총신대입구", "월드컵경기장", "사평", "상봉", "연신내", "효창공원앞"]);

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
  "(B3) 승강장으로 이동",
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
    if (row.LN_NM === "2호선" && row.CHTN_MV_CONT === "4호선 남태령 방면") return { ...row, CHTN_MV_CONT: "4호선 남태령(종착역)" };
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

test("방면 표기의 서식 차이(끝의 승강장 접미, 역명에 붙은 방면, 공백이 든 역명)는 같은 방면으로 읽는다 (#1025)", () => {
  // 실제 원천 서식: '4호선 고잔 방면 승강장', '경의중앙선 양원방면', '3호선 을지로 3가 방면'. 방면 역은 그대로 이웃 역 이름과 정확히 하나가 맞아야 한다.
  const withSuffix = sadangRows().map((row) => (row.CHTN_MV_CONT === "" ? row : { ...row, CHTN_MV_CONT: `${row.CHTN_MV_CONT} 승강장 ` }));
  const suffixed = derive({ rows: withSuffix });
  assert.deepEqual(suffixed.excludedPaths, []);
  assert.equal(edgeState(suffixed, EDGE_2_4).state, "STEP_FREE");
  assert.equal(edgeState(suffixed, EDGE_4_2).state, "STEP_FREE");

  const attached = derive({ rows: sadangRows().map((row) => (row.CHTN_MV_CONT === "" ? row : { ...row, CHTN_MV_CONT: row.CHTN_MV_CONT.replace(" 방면", "방면") })) });
  assert.deepEqual(attached.excludedPaths, []);
  assert.equal(edgeState(attached, EDGE_2_4).state, "STEP_FREE");
  assert.equal(edgeState(attached, EDGE_4_2).state, "STEP_FREE");

  // 공백이 든 역명은 공백만 지웠을 때 정본 역 이름과 정확히 같아야 한다. 정본 '을지로3가', 원천 '을지로 3가'.
  const spacedRows = sadangRows().map((row) => ({
    ...row,
    MV_CONT_DTL: row.MV_CONT_DTL.replaceAll("방배", "을지로 3가"),
    CHTN_MV_CONT: row.CHTN_MV_CONT.replaceAll("방배", "을지로 3가"),
  }));
  const spacedCatalog = sadangCatalog();
  spacedCatalog.stations = spacedCatalog.stations.map((station) => (station.id === "station-bangbae" ? { ...station, nameKo: "을지로3가" } : station));
  const spaced = derive({ rows: spacedRows, catalog: spacedCatalog });
  assert.deepEqual(spaced.excludedPaths, []);
  assert.equal(edgeState(spaced, EDGE_2_4).state, "STEP_FREE");
  assert.equal(edgeState(spaced, EDGE_4_2).state, "STEP_FREE");
});

test("서식을 완화해도 방면 역이 이웃 역과 정확히 하나로 맞지 않으면 제외하고, 읽지 못하는 서식은 계속 제외한다 (#1025)", () => {
  // 붙은 방면 표기라도 이름이 이웃 역과 다르면(유사 이름) 풀지 않는다.
  const fuzzy = derive({ rows: sadangRows().map((row) => (row.CHTN_MV_CONT === "4호선 총신대입구 방면"
    ? { ...row, CHTN_MV_CONT: "4호선 총신대방면 승강장" } : row)) });
  assert.equal(edgeState(fuzzy, EDGE_2_4).state, "UNKNOWN");
  // '4호선 총신대입구 방면'은 4호선 출발 경로 2개의 첫 단계와 2호선 출발 경로 2개의 마지막 단계에 나온다.
  assert.equal(fuzzy.summary.excludedPathsByReason.DIRECTION_NAME_UNRESOLVED, 4);
  // 방면 표기가 아닌 문구, 노선 표기가 없는 방면, 종착역 표기는 이 이슈 범위 밖이라 계속 서식 미지원이다.
  for (const unsupported of ["4호선 남태령", "남태령 방면 승강장", "4호선 방면", "4호선 남태령(종착역)", "4호선 남태령 종착", "4호선 금정 도착"]) {
    const result = derive({ rows: sadangRows().map((row) => (row.CHTN_MV_CONT === "4호선 남태령 방면"
      ? { ...row, CHTN_MV_CONT: unsupported } : row)) });
    assert.equal(result.summary.excludedPathsByReason.DIRECTION_FORMAT_UNSUPPORTED, 4, unsupported);
    assert.equal(edgeState(result, EDGE_2_4).reason, "DIRECTION_COMBO_MISSING", unsupported);
  }
});

test("parseDirection은 '<노선> <역> 방면' 표기의 서식 차이만 읽고 그 밖은 null이다 (#1025)", () => {
  for (const [value, expected] of [
    ["4호선 남태령 방면", { lineToken: "4호선", stationName: "남태령" }],
    ["4호선 남태령 방면 승강장", { lineToken: "4호선", stationName: "남태령" }],
    ["  4호선 고잔 방면 승강장  ", { lineToken: "4호선", stationName: "고잔" }],
    ["경의중앙선 양원방면", { lineToken: "경의중앙선", stationName: "양원" }],
    ["4호선 범계방면 승강장", { lineToken: "4호선", stationName: "범계" }],
    ["3호선 을지로 3가 방면", { lineToken: "3호선", stationName: "을지로 3가" }],
  ]) {
    assert.deepEqual(parseDirection(value), expected, value);
  }
  for (const value of ["", null, undefined, "4호선 남태령", "남태령 방면", "방면", "4호선 방면", "4호선 남태령(종착역)", "4호선 금정 도착", "서울역 종착역 승강장"]) {
    assert.equal(parseDirection(value), null, String(value));
  }
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
      const classified = classifyTransferStep(example, { stationNames: EXAMPLE_STATION_NAMES });
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
  const ninthRows = (arrivalLabel) => sadangRows({ steps: ninthStyle }).map((row, index, all) => {
    const last = index === all.length - 1 || all[index + 1].CHTN_MV_TP_ORDR === "1";
    if (row.CHTN_MV_TP_ORDR === "1") return { ...row, MV_CONT_DTL: `1) ${row.CHTN_MV_CONT.split(" ").slice(1).join(" ")} 승강장` };
    if (last) return { ...row, MV_CONT_DTL: `${row.CHTN_MV_TP_ORDR}) ${arrivalLabel}${row.CHTN_MV_CONT} 승강장` };
    return row;
  });
  assert.equal(classifyTransferStep("1) 방배 방면 승강장", { stationNames: ["방배"] }).kind, "PLATFORM_ENDPOINT");
  const result = derive({ rows: ninthRows("(B3) ") });
  assert.equal(edgeState(result, EDGE_2_4).state, "STEP_FREE");
  assert.equal(edgeState(result, EDGE_4_2).state, "STEP_FREE");
  // #946: 도착 승강장에 층 표기가 없으면 직전 단계(지하 3층으로 이동)의 층을 이어받는다.
  const unlabeledArrival = derive({ rows: ninthRows("") });
  assert.equal(edgeState(unlabeledArrival, EDGE_2_4).state, "STEP_FREE");
  assert.equal(edgeState(unlabeledArrival, EDGE_4_2).state, "STEP_FREE");
  // 경로 중간의 승강장 위치 표기는 승하차 지점이 아니므로 어휘 밖 문구로 다룬다.
  const middle = derive({ rows: sadangRows({ steps: () => [...ELEVATOR_STEPS.slice(0, 2), "환승 방면 승강장", ...ELEVATOR_STEPS.slice(2)] }) });
  assert.equal(edgeState(middle, EDGE_2_4).state, "UNKNOWN");
  assert.ok(edgeState(middle, EDGE_2_4).combos.every(({ blockingReasons }) => blockingReasons.includes("STEP_WORDING_UNRECOGNIZED")));
});

// #944 리뷰 F1: 계단 없음 규칙은 닫힌 어휘다. 문구의 모든 낱말이 허용 목록(장소·관계어·노선 표기·번들 역 이름·층·칸)에 있고
// 문구 전체가 규칙 형식과 정확히 맞을 때만 인정한다. 금지 키워드는 사유를 붙이는 보조 장치다.
test("F1 금지 키워드를 비껴간 오타·띄어쓰기·영어·부정·미설치 문구는 어휘 밖(UNRECOGNIZED)이다", () => {
  const context = { stationNames: ["방배", "총신대입구"] };
  for (const probe of [
    "에스카레이터 이용 후 대합실로 이동",
    "에스컬 레이터 이용 후 대합실로 이동",
    "stairs 이용 후 대합실로 이동",
    "엘리베이터 이용 안하고 대합실로 이동",
    "엘리베이터 미설치 구간 대합실로 이동",
    "어딘가 대합실로 이동",
    "가상역명 방면 엘리베이터 탑승",
    "에스카레이터 앞 표 내는 곳 통과",
    "무빙 엘리베이터",
  ]) {
    const classified = classifyTransferStep(probe, context);
    assert.equal(classified.kind, "UNRECOGNIZED", probe);
    assert.equal(classified.effect, "BLOCKING", probe);
    const result = derive({ rows: sadangRows({
      steps: ({ line }) => (line === "2호선" ? ["대합실 방향 엘리베이터 탑승", `(B1) ${probe}`, "승강장 방향 엘리베이터 탑승", "(B3) 승강장으로 이동"] : ELEVATOR_STEPS),
    }) });
    assert.equal(edgeState(result, EDGE_2_4).state, "UNKNOWN", probe);
    assert.ok(edgeState(result, EDGE_2_4).combos.every(({ blockingReasons }) => blockingReasons.includes("STEP_WORDING_UNRECOGNIZED")), probe);
  }
  // 번들 역 이름은 판정 문맥으로만 허용된다. 같은 문구도 역 이름이 없으면 어휘 밖이다.
  assert.equal(classifyTransferStep("4호선 총신대입구 방면 승강장으로 이동", context).kind, "LEVEL_MOVE");
  assert.equal(classifyTransferStep("4호선 총신대입구 방면 승강장으로 이동").kind, "UNRECOGNIZED");
});

// #944 리뷰 F2: 승강 설비 한 번은 층 변화 한 번만 덮는다. 층 표기가 없는 이동·승강장 도착은 층을 판단할 수 없으므로
// 같은 경로의 승강 설비가 덮지 않으면 근거가 아니다(#946 전: FLOOR_UNDETERMINED, 지금은 이어받기).
test("F2 층 표기가 붙은 승강 설비 단계 뒤 두 번째 층 변화는 새 승강 설비 없이는 근거가 아니다", () => {
  const verdict = (steps) => {
    const result = derive({ rows: sadangRows({ steps: ({ line }) => (line === "2호선" ? steps : ELEVATOR_STEPS) }) });
    const edge = edgeState(result, EDGE_2_4);
    return { state: edge.state, reasons: [...new Set(edge.combos.flatMap(({ blockingReasons }) => blockingReasons))].sort() };
  };
  // 엘리베이터 탑승(B2)·하차(B1) 한 번 뒤에 B3로 또 바뀐다.
  assert.deepEqual(verdict(["(B2) 대합실 방향 엘리베이터 탑승", "(B1) 엘리베이터 하차", "(B3) 승강장으로 이동"]),
    { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"] });
  // 층 표기 없는 엘리베이터 한 번 뒤에 층이 두 번 바뀐다(층 표기 없는 단계 뒤 초기화가 지워지면 통과해 버리는 경우).
  assert.deepEqual(verdict(["대합실 방향 엘리베이터 탑승", "(B1) 대합실로 이동", "(B3) 승강장으로 이동"]),
    { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"] });
  // 탑승 층 표기가 지금 층과 다르면 엘리베이터에 타기 전에 이미 층이 바뀐 것이다.
  assert.deepEqual(verdict(["(B1) 대합실 방향 엘리베이터 탑승", "(B3) 승강장으로 이동"]),
    { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"] });
  // #946: 층 표기 없는 장소 이동은 직전 단계의 층을 이어받는다(출발 하차 단계가 B2였으므로 B2 평면 이동).
  assert.deepEqual(verdict(["대합실로 이동", "승강장으로 이동"]), { state: "STEP_FREE", reasons: [] });
  // 층 표기 없는 승강장 도착은 직전 단계(B1)의 층을 이어받는다.
  assert.deepEqual(verdict(["대합실 방향 엘리베이터 탑승", "(B1) 대합실로 이동", "승강장으로 이동"]), { state: "STEP_FREE", reasons: [] });
  // #946 메인 결정: 승강 설비 뒤 층 표기 없는 단계는 설비 도착 층을 이어받는다. 층 표기가 끝내 나오지 않아도 층을 바꾸는 수단은 엘리베이터뿐이다.
  assert.deepEqual(verdict(["대합실 방향 엘리베이터 탑승", "대합실로 이동", "승강장으로 이동"]), { state: "STEP_FREE", reasons: [] });
  // 탑승 층 표기는 타기 전 위치다. B2에서 B1 탑승까지는 승강 설비가 없다.
  assert.deepEqual(verdict(["(B1) 대합실 방향 엘리베이터 탑승", "(B1) 대합실로 이동"]),
    { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"] });
  // 층이 바뀔 때마다 승강 설비가 있으면 근거다. 층 표기 없는 엘리베이터 이동의 도착 층은 다음 층 표기다.
  assert.deepEqual(verdict(["대합실 방향 엘리베이터 탑승", "(B1) 대합실로 이동", "승강장 방향 엘리베이터 탑승", "(B3) 승강장으로 이동"]),
    { state: "STEP_FREE", reasons: [] });
  assert.deepEqual(verdict(["(B2) 대합실 방향 엘리베이터 탑승", "(B1) 엘리베이터 하차", "승강장 방향 엘리베이터 탑승", "(B3) 승강장으로 이동"]),
    { state: "STEP_FREE", reasons: [] });
  assert.deepEqual(verdict(["승강장 방향 엘리베이터로 이동", "(B3) 승강장으로 이동"]), { state: "STEP_FREE", reasons: [] });
  // 같은 층 평면 환승은 양 끝 층 표기가 같을 때만 근거다.
  assert.deepEqual(verdict(["(B2) 승강장으로 이동"]), { state: "STEP_FREE", reasons: [] });
});

// #946 QA 결정(2026-10-05): 원천은 층이 바뀔 때만 층을 적는다. 층 표기 없는 이동·승강장 단계는 직전 단계의 층을 이어받는다.
// 9호선형 경로(층 표기 없는 "… 방면 승강장"으로 시작·끝)를 손으로 적은 단계로 만든다.
function ninthRows(middle, { first = true, arrival = "" } = {}) {
  const rows = sadangRows({ steps: ({ toLine, toDirection }) => middle({ toLine, toDirection }) });
  return rows.map((row, index, all) => {
    const last = index === all.length - 1 || all[index + 1].CHTN_MV_TP_ORDR === "1";
    if (row.CHTN_MV_TP_ORDR === "1" && first) return { ...row, MV_CONT_DTL: `1) ${row.CHTN_MV_CONT.split(" ").slice(1).join(" ")} 승강장` };
    if (last) return { ...row, MV_CONT_DTL: `${row.CHTN_MV_TP_ORDR}) ${arrival}${row.CHTN_MV_CONT} 승강장` };
    return row;
  });
}

function ninthVerdict(middle, options) {
  const result = derive({ rows: ninthRows(middle, options) });
  const edge = edgeState(result, EDGE_2_4);
  return { state: edge.state, reasons: [...new Set(edge.combos.flatMap(({ blockingReasons }) => blockingReasons))].sort() };
}

test("#946 고속터미널 9→3형: 층 표기 없는 환승통로 이동과 도착 승강장은 직전 층(지하 2층·지하 3층)을 이어받아 STEP_FREE다", () => {
  const ninthSteps = ({ toLine, toDirection }) => [
    "엘리베이터 이용", "지하 2층으로 이동", "7호선 환승통로 이동",
    `${toLine} ${toDirection} 방면 엘리베이터 이용`, "지하 3층으로 이동",
  ];
  const result = derive({ rows: ninthRows(ninthSteps) });
  for (const edgeId of [EDGE_2_4, EDGE_4_2]) {
    assert.equal(edgeState(result, edgeId).state, "STEP_FREE", edgeId);
    assert.equal(edgeState(result, edgeId).reason, "ALL_DIRECTION_COMBOS_STEP_FREE", edgeId);
  }
  assert.equal(result.evidenceRows.length, 8);
});

test("#946 첫 단계에 층이 없어도 막지 않고, 이후 처음 나오는 명시 층을 시작 층으로 본다", () => {
  // 층 표기가 끝내 없으면 층 변화 표기도 없다. 층 변화 어휘가 없으므로 평면 이동이다.
  assert.deepEqual(ninthVerdict(() => ["대합실로 이동", "승강장으로 이동"]), { state: "STEP_FREE", reasons: [] });
  // 첫 명시 층(B2)이 시작 층이다. 그 뒤 같은 층 표기는 일관된다.
  assert.deepEqual(ninthVerdict(() => ["지하 2층으로 이동", "환승통로 이동", "지하 2층으로 이동"]), { state: "STEP_FREE", reasons: [] });
  // 시작 층이 정해진 뒤 설비 없이 다른 층이 표기되면 막는다.
  assert.deepEqual(ninthVerdict(() => ["지하 2층으로 이동", "환승통로 이동", "지하 3층으로 이동"]),
    { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"] });
  // 첫 단계 층이 없어도 층 변화 어휘가 사이에 있으면 막는다.
  assert.deepEqual(ninthVerdict(() => ["계단으로 이동", "지하 2층으로 이동"]), { state: "UNKNOWN", reasons: ["STAIRS"] });
});

test("#946 승강 설비 뒤 층 표기 없는 단계는 설비 도착 층을 이어받고, 처음 나오는 명시 층이 도착 층이 된다", () => {
  const verdict = (steps) => {
    const result = derive({ rows: sadangRows({ steps: ({ line }) => (line === "2호선" ? steps : ELEVATOR_STEPS) }) });
    const edge = edgeState(result, EDGE_2_4);
    return { state: edge.state, reasons: [...new Set(edge.combos.flatMap(({ blockingReasons }) => blockingReasons))].sort() };
  };
  // 설비 뒤 층 표기 없는 단계가 이어져도 그 뒤 처음 나오는 명시 층이 설비 도착 층이다(층 변화 한 번을 설비 한 번이 덮는다).
  assert.deepEqual(verdict(["대합실 방향 엘리베이터 탑승", "환승통로로 이동", "대합실로 이동", "(B1) 승강장으로 이동"]), { state: "STEP_FREE", reasons: [] });
  // 도착 층이 확정된 뒤 설비 없이 또 다른 층이 표기되면 막는다.
  assert.deepEqual(verdict(["대합실 방향 엘리베이터 탑승", "환승통로로 이동", "(B1) 대합실로 이동", "(B3) 승강장으로 이동"]),
    { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"] });
  // 설비 뒤 층 표기 없는 단계 다음에 계단 어휘가 나오면 막는다.
  assert.deepEqual(verdict(["대합실 방향 엘리베이터 탑승", "환승통로로 이동", "계단으로 이동", "(B1) 승강장으로 이동"]),
    { state: "UNKNOWN", reasons: ["STAIRS"] });
});

test("#946 리뷰 F1·F2 승강 설비는 뒤에 처음 나오는 명시 층에서 덮개를 항상 쓰고, 그다음 설비 없는 층 변화는 막는다", () => {
  const verdict = (steps) => {
    const rows = sadangRows({ steps: ({ line }) => (line === "2호선" ? steps : ELEVATOR_STEPS) });
    const edge = edgeState(derive({ rows }), EDGE_2_4);
    return { state: edge.state, reasons: [...new Set(edge.combos.flatMap(({ blockingReasons }) => blockingReasons))].sort() };
  };
  const changeWithoutLift = { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"] };
  // 리뷰 probe 1: 층 표기 없는 설비(앞에 명시 층 없음) 뒤 첫 명시 층 B2, 이어서 설비 없이 B1.
  assert.deepEqual(ninthVerdict(() => ["엘리베이터 탑승", "(B2) 대합실로 이동", "(B1) 승강장으로 이동"]), changeWithoutLift);
  // 같은 경로를 출발 층 B2가 적힌 하차 단계로 시작해도 같다(설비가 같은 층 B2에 도착).
  assert.deepEqual(verdict(["엘리베이터 탑승", "(B2) 대합실로 이동", "(B1) 승강장으로 이동"]), changeWithoutLift);
  // 리뷰 probe 2: 같은 층(B2)에 도착하는 설비 뒤 B3로 설비 없이 바뀐다.
  assert.deepEqual(verdict(["엘리베이터 탑승", "(B2) 대합실로 이동", "(B3) 승강장으로 이동"]), changeWithoutLift);
  // 첫 단계에 층이 없는 경로: 설비, 첫 명시 층(B2), 설비 없이 B1.
  assert.deepEqual(ninthVerdict(() => ["엘리베이터 이용", "지하 2층으로 이동", "지하 1층으로 이동"]), changeWithoutLift);
  // 도착 층 표기 있는 하차형 설비도 같다: 하차(B2)가 도착 층이고 그 뒤 층 변화는 새 설비가 필요하다.
  assert.deepEqual(verdict(["승강장 방향 엘리베이터로 이동", "(B2) 엘리베이터 하차", "(B1) 승강장으로 이동"]), changeWithoutLift);
  // 설비를 한 번 더 타면 다음 층 변화를 덮는다(정상 경로는 그대로 STEP_FREE).
  assert.deepEqual(verdict(["엘리베이터 탑승", "(B2) 대합실로 이동", "엘리베이터 탑승", "(B1) 승강장으로 이동"]), { state: "STEP_FREE", reasons: [] });
});

test("#946 이어받은 층과 다른 층이 뒤에서 명시되는데 사이에 무단차 수단이 없으면 FLOOR_CHANGE_WITHOUT_LIFT다", () => {
  const verdict = (steps) => {
    const result = derive({ rows: sadangRows({ steps: ({ line }) => (line === "2호선" ? steps : ELEVATOR_STEPS) }) });
    const edge = edgeState(result, EDGE_2_4);
    return { state: edge.state, reasons: [...new Set(edge.combos.flatMap(({ blockingReasons }) => blockingReasons))].sort() };
  };
  // 출발 B2, 층 표기 없는 환승통로 이동(B2 이어받음), 엘리베이터 없이 B3 명시.
  assert.deepEqual(verdict(["환승통로로 이동", "(B3) 승강장으로 이동"]), { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"] });
  // 이어받은 층과 같은 층을 뒤에서 명시하면 일관된 경로다.
  assert.deepEqual(verdict(["환승통로로 이동", "(B2) 승강장으로 이동"]), { state: "STEP_FREE", reasons: [] });
  assert.deepEqual(verdict(["(B2) 대합실로 이동", "환승통로로 이동", "(B2) 승강장으로 이동"]), { state: "STEP_FREE", reasons: [] });
  // 사이에 엘리베이터가 있으면 층이 바뀌는 것이 설명된다.
  assert.deepEqual(verdict(["환승통로로 이동", "승강장 방향 엘리베이터 탑승", "(B3) 승강장으로 이동"]), { state: "STEP_FREE", reasons: [] });
});

test("#946 계단·에스컬레이터·경사·오르막·내리막 단계가 있으면 층을 이어받아도 STEP_FREE가 아니다", () => {
  const verdict = (steps) => {
    const result = derive({ rows: sadangRows({ steps: ({ line }) => (line === "2호선" ? steps : ELEVATOR_STEPS) }) });
    const edge = edgeState(result, EDGE_2_4);
    return { state: edge.state, reasons: [...new Set(edge.combos.flatMap(({ blockingReasons }) => blockingReasons))].sort() };
  };
  const probes = [
    ["계단으로 이동", "STAIRS"],
    ["에스컬레이터로 이동", "ESCALATOR"],
    ["경사로 이동", "STEP_WORDING_UNRECOGNIZED"],
    ["오르막 이동", "STEP_WORDING_UNRECOGNIZED"],
    ["내리막 이동", "STEP_WORDING_UNRECOGNIZED"],
    ["경사 엘리베이터 탑승", "STEP_WORDING_UNRECOGNIZED"],
  ];
  for (const [probe, reason] of probes) {
    // 앞뒤 단계는 층 표기가 없어 이어받기 대상이다. 문제 단계 하나만으로 UNKNOWN이어야 한다.
    assert.deepEqual(verdict(["대합실로 이동", probe, "승강장으로 이동"]), { state: "UNKNOWN", reasons: [reason] }, probe);
  }
});

// #946 메인 결정: 실제 MOLIT 스냅샷(20260811)의 경로 문구 그대로 고정한 4개 사례. 원천 문구는 손대지 않는다.
const REAL_FLOOR_CASES = Object.freeze({
  원인재: {
    station: "원인재", lineName: "수인분당", operator: "KR(한국철도공사)",
    fromTable: "수도권 수인분당", toTable: "인천 1호선",
    fromNeighbors: ["남동인더스파크", "연수"], toNeighbors: ["동춘", "신연수"],
    paths: [
      {"from": "수인선 남동인더스파크 방면", "to": "인천1호선 동춘 방면", "steps": ["남동인더스파크 방면 승강장", "남동인더스파크 방면 지상2층 승강장 엘리베이터", "남동인더스파크 방면 지상1층 엘리베이터", "환승 지상1층 엘리베이터", "환승 지하1층 엘리베이터", "동춘 방면 지하1층 엘리베이터", "동춘 방면 지하2층 승강장 엘리베이터", "승차(휠체어칸)"]},
      {"from": "수인선 남동인더스파크 방면", "to": "인천1호선 신연수 방면", "steps": ["남동인더스파크 방면 승강장", "남동인더스파크 방면 지상2층 승강장 엘리베이터", "남동인더스파크 방면 지상1층 엘리베이터", "환승 지상1층 엘리베이터", "환승 지하1층 엘리베이터", "신연수 방면 지하1층 엘리베이터", "신연수 방면 지하2층 승강장 엘리베이터", "승차(휠체어칸)"]},
      {"from": "수인선 연수 방면", "to": "인천1호선 동춘 방면", "steps": ["연수방면 승강장", "연수방면 지상2층 승강장 엘리베이터", "연수 방면 지상1층 엘리베이터", "환승 지상1층 엘리베이터", "환승 지하1층 엘리베이터", "동춘 방면 지하1층 엘리베이터", "동춘 방면 지하2층 승강장 엘리베이터", "승차(휠체어칸)"]},
      {"from": "수인선 연수 방면", "to": "인천1호선 신연수 방면", "steps": ["연수 방면 승강장", "연수 방면 지상2층 승강장 엘리베이터", "연수 방면 지상1층 엘리베이터", "환승 지상1층 엘리베이터", "환승 지하1층 엘리베이터", "신연수 방면 지하1층 엘리베이터", "신연수 방면 지하2층 승강장 엘리베이터", "승차(휠체어칸)"]},
    ],
  },
  가락시장: {
    station: "가락시장", lineName: "8호선", operator: "S1(서울교통공사)",
    fromTable: "수도권 8호선", toTable: "수도권 3호선",
    fromNeighbors: ["송파", "문정"], toNeighbors: ["수서", "경찰병원"],
    paths: [
      {"from": "8호선 송파 방면", "to": "3호선 수서 방면", "steps": ["(B2) 8호선 송파 방면 승강장 하차", "3호선 방향 환승 엘리베이터 탑승", "환승통로로 이동", "3호선 대합실로 이동", "3호선 수서 방면 엘리베이터 탑승", "(B4) 3호선 수서 방면 승강장으로 이동", "승차 (휠체어칸)"]},
      {"from": "8호선 송파 방면", "to": "3호선 경찰병원 방면", "steps": ["(B2) 8호선 송파 방면 승강장 하차", "3호선 방향 환승 엘리베이터 탑승", "환승통로로 이동", "3호선 대합실로 이동", "3호선 경찰병원 방면 엘리베이터 탑승", "(B4) 3호선 경찰병원 방면 승강장으로 이동", "승차 (휠체어칸)"]},
      {"from": "8호선 문정 방면", "to": "3호선 수서 방면", "steps": ["(B2) 8호선 문정 방면 승강장 하차", "3호선 방향 환승 엘리베이터 탑승", "환승통로로 이동", "3호선 대합실로 이동", "3호선 수서 방면 엘리베이터 탑승", "(B4) 3호선 수서 방면 승강장으로 이동", "승차 (휠체어칸)"]},
      {"from": "8호선 문정 방면", "to": "3호선 경찰병원 방면", "steps": ["(B2) 8호선 문정 방면 승강장 하차", "3호선 방향 환승 엘리베이터 탑승", "환승통로로 이동", "3호선 대합실로 이동", "3호선 경찰병원 방면 엘리베이터 탑승", "(B4) 3호선 경찰병원 방면 승강장으로 이동", "승차 (휠체어칸)"]},
    ],
  },
  마곡나루: {
    station: "마곡나루", lineName: "9호선", operator: "S9(서울시메트로9호선주식회사)",
    fromTable: "수도권 9호선", toTable: "수도권 공항",
    fromNeighbors: ["신방화", "양천향교"], toNeighbors: ["디지털미디어시티", "김포공항"],
    paths: [
      {"from": "9호선 신방화 방면", "to": "공항철도 디지털미디어시티 방면", "steps": ["(B2) 9호선 신방화 방면 승강장 하차", "대합실 방향 엘리베이터 탑승", "(B1) 대합실로 이동", "공항철도 방향 환승 엘리베이터 탑승", "공항철도 방향 환승통로로 이동", "공항철도 대합실로 이동", "공항철도 디지털미디어시티 방면 엘리베이터 탑승", "(B3) 공항철도 디지털미디어시티 방면 승강장으로 이동", "승차 (휠체어칸)"]},
      {"from": "9호선 신방화 방면", "to": "공항철도 김포공항 방면", "steps": ["(B2) 9호선 신방화 방면 승강장 하차", "대합실 방향 엘리베이터 탑승", "(B1) 대합실로 이동", "공항철도 방향 환승 엘리베이터 탑승", "공항철도 방향 환승통로로 이동", "공항철도 대합실로 이동", "공항철도 김포공항 방면 엘리베이터 탑승", "(B3) 공항철도 김포공항 방면 승강장으로 이동", "승차 (휠체어칸)"]},
      {"from": "9호선 양천향교 방면", "to": "공항철도 디지털미디어시티 방면", "steps": ["(B2) 9호선 양천향교 방면 승강장 하차", "대합실 방향 엘리베이터 탑승", "(B1) 대합실로 이동", "공항철도 방향 환승 엘리베이터 탑승", "공항철도 방향 환승통로로 이동", "공항철도 대합실로 이동", "공항철도 디지털미디어시티 방면 엘리베이터 탑승", "(B3) 공항철도 디지털미디어시티 방면 승강장으로 이동", "승차 (휠체어칸)"]},
      {"from": "9호선 양천향교 방면", "to": "공항철도 김포공항 방면", "steps": ["(B2) 9호선 양천향교 방면 승강장 하차", "대합실 방향 엘리베이터 탑승", "(B1) 대합실로 이동", "공항철도 방향 환승 엘리베이터 탑승", "공항철도 방향 환승통로로 이동", "공항철도 대합실로 이동", "공항철도 김포공항 방면 엘리베이터 탑승", "(B3) 공항철도 김포공항 방면 승강장으로 이동", "승차 (휠체어칸)"]},
    ],
  },
  서면: {
    station: "서면", lineName: "1호선", operator: "BS(부산교통공사)",
    fromTable: "부산 1호선", toTable: "부산 2호선",
    fromNeighbors: ["범내골", "부전"], toNeighbors: ["전포", "부암"],
    paths: [
      {"from": "1호선 범내골 방면", "to": "2호선 전포 방면", "steps": ["(B2) 1호선 범내골 방면 승강장 하차", "2호선 방향 환승 엘리베이터 탑승", "(B3) 2호선 승강장으로 이동", "(B3) 2호선 전포 방면 승강장으로 이동", "승차 (휠체어칸)"]},
      {"from": "1호선 범내골 방면", "to": "2호선 부암 방면", "steps": ["(B2) 1호선 범내골 방면 승강장 하차", "2호선 방향 환승 엘리베이터 탑승", "(B3) 2호선 승강장으로 이동", "(B3) 2호선 부암 방면 승강장으로 이동", "승차 (휠체어칸)"]},
      {"from": "1호선 부전 방면", "to": "2호선 전포 방면", "steps": ["(B2) 1호선 부전 방면 승강장 하차", "2호선 방향 환승 엘리베이터 탑승", "(B2) 2호선 방향 환승 대합실로 이동", "2호선 승강장 방향 엘리베이터 탑승", "2호선 승강장으로 이동", "(B3) 2호선 전포 방면 승강장으로 이동", "승차 (휠체어칸)"]},
      {"from": "1호선 부전 방면", "to": "2호선 부암 방면", "steps": ["(B2) 1호선 부전 방면 승강장 하차", "2호선 방향 환승 엘리베이터 탑승", "(B2) 2호선 방향 환승 대합실로 이동", "2호선 승강장 방향 엘리베이터 탑승", "2호선 승강장으로 이동", "(B3) 2호선 부암 방면 승강장으로 이동", "승차 (휠체어칸)"]},
    ],
  },
});

// 실제 경로 문구 그대로 한 쌍의 노선(양쪽 방면 2개씩)을 만들어 간선 판정을 본다. edit은 경로 단계를 바꿔 반례를 만든다.
function realCaseVerdict(name, edit = (steps) => steps) {
  const { station, lineName, operator, fromTable, toTable, fromNeighbors, toNeighbors, paths } = REAL_FLOOR_CASES[name];
  const names = [station, ...fromNeighbors, ...toNeighbors];
  const catalog = {
    stations: names.map((nameKo, index) => ({ id: `s${index}`, nameKo, nameSub: "" })),
    lines: [{ id: "line-from", nameKo: fromTable }, { id: "line-to", nameKo: toTable }],
    stationLines: [
      { stationId: "s0", lineId: "line-from" }, { stationId: "s0", lineId: "line-to" },
      { stationId: "s1", lineId: "line-from" }, { stationId: "s2", lineId: "line-from" },
      { stationId: "s3", lineId: "line-to" }, { stationId: "s4", lineId: "line-to" },
    ],
  };
  const routeEdges = [
    ...["s1", "s2"].flatMap((id) => [ride("s0", id, "line-from"), ride(id, "s0", "line-from")]),
    ...["s3", "s4"].flatMap((id) => [ride("s0", id, "line-to"), ride(id, "s0", "line-to")]),
    transfer("s0", "line-from", "line-to"),
  ];
  const rows = paths.flatMap(({ from, to, steps }, pathIndex) => edit(steps, pathIndex).map((text, index, all) => ({
    RAIL_OPR_ISTT_CD: operator,
    LN_NM: lineName,
    STIN_NM: station,
    CHTN_MV_TP_ORDR: String(index + 1),
    MV_CONT_DTL: `${index + 1}) ${text}`,
    CHTN_MV_CONT: index === 0 ? from : index === all.length - 1 ? to : "",
  })));
  const edge = edgeState(derive({ rows, catalog, routeEdges }), "transfer-s0-line-from-line-to");
  return {
    state: edge.state,
    reasons: [...new Set(edge.combos.flatMap(({ blockingReasons }) => blockingReasons))].sort(),
    pathCounts: edge.combos.map(({ pathCount }) => pathCount),
  };
}

test("#946 실제 원천 문구 4개 사례(원인재·가락시장·마곡나루·서면)는 설비·이어받은 층 규칙으로 STEP_FREE다", () => {
  for (const name of Object.keys(REAL_FLOOR_CASES)) {
    assert.deepEqual(realCaseVerdict(name), { state: "STEP_FREE", reasons: [], pathCounts: [1, 1, 1, 1] }, name);
  }
});

test("#946 실제 사례 반례: 설비 없이 두 명시 층이 다르면 FLOOR_CHANGE_WITHOUT_LIFT다", () => {
  const withoutLift = (steps) => steps.filter((step) => !/엘리베이터 탑승$/u.test(step));
  // 가락시장: 엘리베이터 탑승 단계를 모두 빼면 (B2) 하차 뒤 (B4) 승강장이 설비 없이 나온다.
  assert.deepEqual(realCaseVerdict("가락시장", withoutLift), { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"], pathCounts: [1, 1, 1, 1] });
  // 서면: (B2) 하차 뒤 (B3) 승강장.
  assert.deepEqual(realCaseVerdict("서면", withoutLift), { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"], pathCounts: [1, 1, 1, 1] });
  // 마곡나루: (B2) → (B1) → (B3).
  assert.deepEqual(realCaseVerdict("마곡나루", withoutLift), { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"], pathCounts: [1, 1, 1, 1] });
  // 원인재: 승강장 엘리베이터 위치 표기를 층 이동 문구로 바꾸되 설비 없이 지상2층 → 지상1층 → 지하1층.
  assert.deepEqual(realCaseVerdict("원인재", (steps) => steps.map((step) => (step.endsWith("엘리베이터") ? step.replace(/ ?엘리베이터$/u, " 이동") : step))),
    { state: "UNKNOWN", reasons: ["FLOOR_CHANGE_WITHOUT_LIFT"], pathCounts: [1, 1, 1, 1] });
});

test("#946 실제 사례 반례: 설비 뒤(또는 첫 단계 층이 없는 경로 사이)에 계단·에스컬레이터 어휘가 나오면 막힌다", () => {
  const replace = (from, to) => (steps) => steps.map((step) => (step === from || step.endsWith(from) ? step.replace(from, to) : step));
  assert.deepEqual(realCaseVerdict("가락시장", replace("3호선 대합실로 이동", "3호선 대합실 계단으로 이동")),
    { state: "UNKNOWN", reasons: ["STAIRS"], pathCounts: [1, 1, 1, 1] });
  assert.deepEqual(realCaseVerdict("마곡나루", replace("공항철도 대합실로 이동", "공항철도 대합실 에스컬레이터 이동")),
    { state: "UNKNOWN", reasons: ["ESCALATOR"], pathCounts: [1, 1, 1, 1] });
  assert.deepEqual(realCaseVerdict("서면", replace("2호선 승강장으로 이동", "2호선 승강장 계단으로 이동")),
    { state: "UNKNOWN", reasons: ["STAIRS"], pathCounts: [1, 1, 1, 1] });
  // 원인재: 첫 단계에 층이 없는 경로. 환승 사이에 계단이 끼면 시작 층을 정해도 막힌다.
  assert.deepEqual(realCaseVerdict("원인재", replace("환승 지상1층 엘리베이터", "환승 지상1층 계단")),
    { state: "UNKNOWN", reasons: ["STAIRS"], pathCounts: [1, 1, 1, 1] });
});

// #944 QA 결정(F1 후속): 추정 없이 되살릴 수 있는 표기만 허용한다.
// - 여러 노선을 함께 적은 표기는 구분자(/ · ㆍ ,)로 나눈 각 노선이 고정 노선 표기와 정확히 같을 때만 한정어다.
// - 띄어 쓴 역 이름은 공백만 지웠을 때 번들 정본 역 이름과 정확히 같을 때만 한정어다(유사도 매칭 없음).
test("F1 후속 여러 노선 함께 적기와 띄어 쓴 역 이름은 정확히 일치할 때만 한정어로 인정하고 반례는 어휘 밖이다", () => {
  const context = { stationNames: ["을지로3가", "총신대입구"] };
  const kind = (text) => classifyTransferStep(text, context).kind;
  assert.equal(kind("3호선/서해선/경의중앙선 연결통로로 이동"), "LEVEL_MOVE");
  assert.equal(kind("5호선·6호선 방향 환승통로로 이동"), "LEVEL_MOVE");
  assert.equal(kind("(B4) 3호선 을지로 3가 방면 승강장 하차"), "ALIGHT");
  assert.equal(kind("을지로 3가 방면 승강장"), "PLATFORM_ENDPOINT");
  // 반례: 고정 노선 표기가 아닌 조각, 빈 조각, 공백 외 차이, 이름 일부만 일치
  assert.equal(kind("5  6호선 방향 환승통로로 이동"), "UNRECOGNIZED");
  assert.equal(kind("5·6호선 방향 환승통로로 이동"), "UNRECOGNIZED");
  assert.equal(kind("3호선/공항선 연결통로로 이동"), "UNRECOGNIZED");
  assert.equal(kind("3호선/ 연결통로로 이동"), "UNRECOGNIZED");
  assert.equal(kind("(B4) 3호선 을지로 4가 방면 승강장 하차"), "UNRECOGNIZED");
  assert.equal(kind("(B4) 3호선 을지로 방면 승강장 하차"), "UNRECOGNIZED");
  assert.equal(kind("(B4) 3호선 을지로 3가역 방면 승강장 하차"), "UNRECOGNIZED");
  assert.equal(kind("(B4) 3호선 총신대 입구역 방면 승강장 하차"), "UNRECOGNIZED");
  assert.equal(classifyTransferStep("(B4) 3호선 을지로 3가 방면 승강장 하차").kind, "UNRECOGNIZED");
});
