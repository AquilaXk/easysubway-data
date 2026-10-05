import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildSqlitePack } from "./build-datapack.mjs";
import {
  TRANSFER_GUIDE_PRODUCTION_USE_SCOPE,
  TRANSFER_GUIDE_SOURCE_ID,
  deriveTransferGuideSteps,
  loadTransferGuideInputs,
  transferGuideReport,
  transferGuideSourceRow,
} from "./build-transfer-guide-steps.mjs";
import { candidatePinnedWorkspace } from "./test-fixtures/candidate-pinned-inputs.mjs";

// #957 RED 계획. 기대 문장은 원천 CSV(molit-railway-transfer-movement-20260811)에서 손으로 옮겨 적는다(도구 출력에서 복사하지 않는다).
// 문장은 앞 번호("1) ")·층 표기·공백까지 원천 그대로이고, 바꿀 수 있는 것은 앞뒤 공백 정리뿐이다.

const PROVIDER_CODE_CATALOG = JSON.parse(await readFile("tools/datapack/sources/kric-provider-code-catalog-20260228.json", "utf8"));
const SNAPSHOT_ID = "molit-railway-transfer-movement-20260811";
const SEOUL_METRO = "S1(서울교통공사)";
const SEOUL_METRO_9 = "S9(서울시메트로9호선주식회사)";

function sourceRows({ operator = SEOUL_METRO, line, station, details, from, to }) {
  return details.map((detail, index) => ({
    RAIL_OPR_ISTT_CD: operator,
    LN_NM: line,
    STIN_NM: station,
    CHTN_MV_TP_ORDR: String(index + 1),
    MV_CONT_DTL: detail,
    CHTN_MV_CONT: index === 0 ? from : index === details.length - 1 ? to : "",
  }));
}

function ride(from, to, lineId) {
  return { edgeId: `ride-${from}-${to}-${lineId}`, edgeType: "RIDE", fromNodeId: `${from}:${lineId}`, toNodeId: `${to}:${lineId}`, servicePattern: "LOCAL", serviceClass: "SUBWAY" };
}

function both(a, b, lineId) {
  return [ride(a, b, lineId), ride(b, a, lineId)];
}

function catalogOf({ stations, lines, memberships }) {
  return {
    stations: stations.map(([id, nameKo, nameSub = ""]) => ({ id, nameKo, nameSub })),
    lines: lines.map(([id, nameKo]) => ({ id, nameKo })),
    stationLines: memberships.map(([stationId, lineId]) => ({ stationId, lineId })),
  };
}

function derive({ rows, catalog, routeEdges }) {
  return deriveTransferGuideSteps({
    snapshot: { sourceId: TRANSFER_GUIDE_SOURCE_ID, snapshotId: SNAPSHOT_ID, rows },
    providerCodeCatalog: PROVIDER_CODE_CATALOG,
    catalog,
    routeEdges,
  });
}

const textsOf = (rows) => rows.map(({ detail }) => detail);

// 사당: 2호선(낙성대-사당-방배), 4호선(남태령-사당-총신대입구)
const SADANG_CATALOG = catalogOf({
  stations: [["s-sadang", "사당"], ["s-bangbae", "방배"], ["s-nakseongdae", "낙성대"], ["s-chongshin", "총신대입구", "이수"], ["s-namtaeryeong", "남태령"]],
  lines: [["l-2", "수도권 2호선"], ["l-4", "수도권 4호선"]],
  memberships: [["s-sadang", "l-2"], ["s-bangbae", "l-2"], ["s-nakseongdae", "l-2"], ["s-sadang", "l-4"], ["s-chongshin", "l-4"], ["s-namtaeryeong", "l-4"]],
});
const SADANG_EDGES = [
  ...both("s-bangbae", "s-sadang", "l-2"), ...both("s-sadang", "s-nakseongdae", "l-2"),
  ...both("s-chongshin", "s-sadang", "l-4"), ...both("s-sadang", "s-namtaeryeong", "l-4"),
];
const SADANG_2_TO_4 = sourceRows({
  line: "2호선", station: "사당", from: "2호선 방배 방면", to: "4호선 총신대입구 방면",
  details: [
    "1) (B2) 2호선 방배 방면 승강장 하차", "2) 대합실 방향 엘리베이터 탑승", "3) (B1) 대합실로 이동",
    "4) 4호선 승강장 방향 엘리베이터 탑승", "5) (B3) 4호선 총신대입구 방면 승강장으로 이동", "6) 승차 (휠체어칸)",
  ],
});
const SADANG_4_TO_2 = sourceRows({
  line: "4호선", station: "사당", from: "4호선 총신대입구 방면", to: "2호선 낙성대 방면",
  details: ["1) (B3) 4호선 총신대입구 방면 승강장 하차", "2) 대합실 방향 엘리베이터 탑승", "3) (B2) 2호선 낙성대 방면 승강장으로 이동", "4) 승차 (휠체어칸)"],
});

test("RED1 사당 2호선 방배 방면 -> 4호선 총신대입구 방면: 단계 문장이 원문 그대로 순서대로 담긴다", () => {
  const result = derive({ rows: SADANG_2_TO_4, catalog: SADANG_CATALOG, routeEdges: SADANG_EDGES });
  // 2호선 방배 방면 열차를 탔다면 사당 직전 역은 낙성대다. 4호선 총신대입구 방면 열차를 타면 사당 다음 역은 총신대입구다.
  assert.deepEqual(result.rows.map((row) => ({ ...row, detail: undefined })), [1, 2, 3, 4, 5, 6].map((stepOrder) => ({
    stationId: "s-sadang",
    fromLineId: "l-2",
    fromPrevStationId: "s-nakseongdae",
    toLineId: "l-4",
    toNextStationId: "s-chongshin",
    stepOrder,
    detail: undefined,
    sourceSnapshotId: SNAPSHOT_ID,
  })));
  assert.deepEqual(textsOf(result.rows), [
    "1) (B2) 2호선 방배 방면 승강장 하차",
    "2) 대합실 방향 엘리베이터 탑승",
    "3) (B1) 대합실로 이동",
    "4) 4호선 승강장 방향 엘리베이터 탑승",
    "5) (B3) 4호선 총신대입구 방면 승강장으로 이동",
    "6) 승차 (휠체어칸)",
  ]);
  assert.deepEqual(result.summary, {
    sequenceCount: 1, mappedSequenceCount: 1, excludedSequenceCount: 0, duplicateSequenceCount: 0, rowCount: 6, excludedByReason: {},
  });
});

test("RED2 사당 4호선 -> 2호선도 같은 규칙으로 담긴다(왕복 방향)", () => {
  const result = derive({ rows: [...SADANG_2_TO_4, ...SADANG_4_TO_2], catalog: SADANG_CATALOG, routeEdges: SADANG_EDGES });
  const reverse = result.rows.filter(({ fromLineId }) => fromLineId === "l-4");
  // 4호선 총신대입구 방면 열차를 탔다면 직전 역은 남태령, 2호선 낙성대 방면 열차를 타면 다음 역은 낙성대다.
  assert.deepEqual([...new Set(reverse.map((row) => [row.fromPrevStationId, row.toNextStationId].join(">")))], ["s-namtaeryeong>s-nakseongdae"]);
  assert.deepEqual(textsOf(reverse), [
    "1) (B3) 4호선 총신대입구 방면 승강장 하차",
    "2) 대합실 방향 엘리베이터 탑승",
    "3) (B2) 2호선 낙성대 방면 승강장으로 이동",
    "4) 승차 (휠체어칸)",
  ]);
  assert.equal(result.summary.mappedSequenceCount, 2);
});

test("RED3 고속터미널 9호선 사평 방면 -> 3호선 잠원 방면: 노선·운영기관이 달라도 원문 그대로다", () => {
  const catalog = catalogOf({
    stations: [["s-gotermi", "고속터미널"], ["s-sinbanpo", "신반포"], ["s-sapyeong", "사평"], ["s-jamwon", "잠원"], ["s-gyodae", "교대"]],
    lines: [["l-9", "수도권 9호선"], ["l-3", "수도권 3호선"]],
    memberships: [["s-gotermi", "l-9"], ["s-sinbanpo", "l-9"], ["s-sapyeong", "l-9"], ["s-gotermi", "l-3"], ["s-jamwon", "l-3"], ["s-gyodae", "l-3"]],
  });
  const routeEdges = [...both("s-sinbanpo", "s-gotermi", "l-9"), ...both("s-gotermi", "s-sapyeong", "l-9"), ...both("s-jamwon", "s-gotermi", "l-3"), ...both("s-gotermi", "s-gyodae", "l-3")];
  const rows = sourceRows({
    operator: SEOUL_METRO_9, line: "9호선", station: "고속터미널", from: "9호선 사평 방면", to: "3호선 잠원 방면",
    details: [
      "1) 사평 방면 승강장", "2) 엘리베이터 이용", "3) 지하 2층으로 이동", "4) 7호선 환승통로 이동",
      "5) 3호선 잠원 방면 엘리베이터 이용", "6) 지하 3층으로 이동", "7) 3호선 잠원 방면 승강장",
    ],
  });
  const result = derive({ rows, catalog, routeEdges });
  assert.deepEqual(result.rows.map(({ stationId, fromLineId, fromPrevStationId, toLineId, toNextStationId }) => [stationId, fromLineId, fromPrevStationId, toLineId, toNextStationId].join(" ")),
    Array(7).fill("s-gotermi l-9 s-sinbanpo l-3 s-jamwon"));
  assert.deepEqual(textsOf(result.rows), [
    "1) 사평 방면 승강장", "2) 엘리베이터 이용", "3) 지하 2층으로 이동", "4) 7호선 환승통로 이동",
    "5) 3호선 잠원 방면 엘리베이터 이용", "6) 지하 3층으로 이동", "7) 3호선 잠원 방면 승강장",
  ]);
});

test("RED4 왕십리 2호선 상왕십리 방면 -> 5호선 행당 방면: 순환선 직전 역은 한양대다", () => {
  const catalog = catalogOf({
    stations: [["s-wangsimni", "왕십리"], ["s-sangwang", "상왕십리"], ["s-hanyang", "한양대"], ["s-haengdang", "행당"], ["s-majang", "마장"]],
    lines: [["l-2", "수도권 2호선"], ["l-5", "수도권 5호선"]],
    memberships: [["s-wangsimni", "l-2"], ["s-sangwang", "l-2"], ["s-hanyang", "l-2"], ["s-wangsimni", "l-5"], ["s-haengdang", "l-5"], ["s-majang", "l-5"]],
  });
  const routeEdges = [...both("s-sangwang", "s-wangsimni", "l-2"), ...both("s-wangsimni", "s-hanyang", "l-2"), ...both("s-haengdang", "s-wangsimni", "l-5"), ...both("s-wangsimni", "s-majang", "l-5")];
  const rows = sourceRows({
    line: "2호선", station: "왕십리", from: "2호선 상왕십리 방면", to: "5호선 행당 방면",
    details: [
      "1) (B2) 2호선 상왕십리 방면 승강장 하차", "2) 환승대합실로 이동", "3) 5호선 방향 엘리베이터 탑승", "4) (B4) 5호선 대합실로 이동",
      "5) 5호선 행당 방면 엘리베이터 탑승", "6) (B5) 5호선 행당 방면 승강장으로 이동", "7) 승차 (휠체어칸)",
    ],
  });
  const result = derive({ rows, catalog, routeEdges });
  assert.deepEqual([...new Set(result.rows.map((row) => [row.stationId, row.fromLineId, row.fromPrevStationId, row.toLineId, row.toNextStationId].join(" ")))],
    ["s-wangsimni l-2 s-hanyang l-5 s-haengdang"]);
  assert.deepEqual(textsOf(result.rows), [
    "1) (B2) 2호선 상왕십리 방면 승강장 하차", "2) 환승대합실로 이동", "3) 5호선 방향 엘리베이터 탑승", "4) (B4) 5호선 대합실로 이동",
    "5) 5호선 행당 방면 엘리베이터 탑승", "6) (B5) 5호선 행당 방면 승강장으로 이동", "7) 승차 (휠체어칸)",
  ]);
});

test("RED5 앞뒤 공백만 걷고 문장 안의 공백·표기는 그대로 둔다", () => {
  const rows = sourceRows({
    line: "2호선", station: "사당", from: "2호선 방배 방면", to: "4호선 총신대입구 방면",
    details: ["  1) (B2) 2호선 방배 방면 승강장 하차 ", "2) 4호선  환승 엘리베이터 탑승\t", "3) 4호선 총신대입구 방면 승강장으로  이동", "4) 승차 (휠체어칸)\n"],
  });
  const result = derive({ rows, catalog: SADANG_CATALOG, routeEdges: SADANG_EDGES });
  assert.deepEqual(textsOf(result.rows), [
    "1) (B2) 2호선 방배 방면 승강장 하차", "2) 4호선  환승 엘리베이터 탑승", "3) 4호선 총신대입구 방면 승강장으로  이동", "4) 승차 (휠체어칸)",
  ]);
});

test("RED6 매핑하지 못한 시퀀스는 담지 않고 사유와 목록으로 드러낸다(추정 매핑 없음)", () => {
  const unknownStation = sourceRows({
    line: "2호선", station: "없는역", from: "2호선 방배 방면", to: "4호선 총신대입구 방면",
    details: ["1) 2호선 방배 방면 승강장 하차", "2) 승차"],
  });
  const unknownDirection = sourceRows({
    line: "2호선", station: "사당", from: "2호선 서초 방면", to: "4호선 총신대입구 방면",
    details: ["1) 2호선 서초 방면 승강장 하차", "2) 승차"],
  });
  const brokenOrder = SADANG_4_TO_2.map((row, index) => (index === 2 ? { ...row, CHTN_MV_TP_ORDR: "5" } : row));
  const blankStep = sourceRows({
    line: "4호선", station: "사당", from: "4호선 남태령 방면", to: "2호선 방배 방면",
    details: ["1) 4호선 남태령 방면 승강장 하차", "   ", "3) 승차"],
  });
  const result = derive({ rows: [...SADANG_2_TO_4, ...unknownStation, ...unknownDirection, ...brokenOrder, ...blankStep], catalog: SADANG_CATALOG, routeEdges: SADANG_EDGES });
  assert.equal(result.rows.length, 6);
  assert.deepEqual(result.summary, {
    sequenceCount: 5, mappedSequenceCount: 1, excludedSequenceCount: 4, duplicateSequenceCount: 0, rowCount: 6,
    excludedByReason: { DIRECTION_NAME_UNRESOLVED: 1, STEP_SEQUENCE_INVALID: 2, CANONICAL_STATION_UNMATCHED: 1 },
  });
  assert.deepEqual(result.excludedSequences.map(({ providerStationName, reason }) => `${providerStationName}:${reason}`).sort(), [
    "사당:DIRECTION_NAME_UNRESOLVED", "사당:STEP_SEQUENCE_INVALID", "사당:STEP_SEQUENCE_INVALID", "없는역:CANONICAL_STATION_UNMATCHED",
  ].sort());
  for (const entry of result.excludedSequences) {
    assert.match(entry.pathSha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof entry.providerOperatorCode, "string");
    assert.equal(typeof entry.providerLineName, "string");
  }
});

test("RED7 같은 키에 문장이 다른 시퀀스가 둘이면 어느 쪽도 고르지 않고 둘 다 제외한다", () => {
  const variant = SADANG_2_TO_4.map((row, index) => (index === 1 ? { ...row, MV_CONT_DTL: "2) 승강장 내 엘리베이터 탑승" } : row));
  const result = derive({ rows: [...SADANG_2_TO_4, ...variant], catalog: SADANG_CATALOG, routeEdges: SADANG_EDGES });
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.summary.excludedByReason, { DUPLICATE_KEY_CONFLICT: 2 });
});

test("RED8 문장까지 똑같은 중복 시퀀스는 한 번만 담고 중복 수를 센다", () => {
  const result = derive({ rows: [...SADANG_2_TO_4, ...SADANG_2_TO_4], catalog: SADANG_CATALOG, routeEdges: SADANG_EDGES });
  assert.equal(result.rows.length, 6);
  assert.equal(result.summary.duplicateSequenceCount, 1);
  assert.equal(result.summary.sequenceCount, 2);
  assert.equal(result.summary.mappedSequenceCount, 1);
});

test("RED9 직전 역이 하나로 정해지지 않는 분기역은 담지 않는다(방면 역이 아닌 이웃을 고르지 않는다)", () => {
  const branchCatalog = catalogOf({
    stations: [...SADANG_CATALOG.stations.map(({ id, nameKo, nameSub }) => [id, nameKo, nameSub]), ["s-extra", "신규"]],
    lines: SADANG_CATALOG.lines.map(({ id, nameKo }) => [id, nameKo]),
    memberships: [...SADANG_CATALOG.stationLines.map(({ stationId, lineId }) => [stationId, lineId]), ["s-extra", "l-2"]],
  });
  const result = derive({ rows: SADANG_2_TO_4, catalog: branchCatalog, routeEdges: [...SADANG_EDGES, ...both("s-sadang", "s-extra", "l-2")] });
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.summary.excludedByReason, { FROM_ARRIVAL_AMBIGUOUS: 1 });
});

test("RED10 결과는 키·단계 순서로 결정적이다", () => {
  const forward = derive({ rows: [...SADANG_2_TO_4, ...SADANG_4_TO_2], catalog: SADANG_CATALOG, routeEdges: SADANG_EDGES });
  const reversed = derive({ rows: [...SADANG_4_TO_2, ...SADANG_2_TO_4], catalog: SADANG_CATALOG, routeEdges: [...SADANG_EDGES].reverse() });
  assert.deepEqual(forward.rows, reversed.rows);
  assert.deepEqual(forward.rows.map(({ fromLineId }) => fromLineId), [...forward.rows.map(({ fromLineId }) => fromLineId)].sort());
});

test("RED11 입력 계약: 스냅샷 정체성·원천 id가 다르면 실패한다", () => {
  assert.throws(() => deriveTransferGuideSteps({ snapshot: { sourceId: "other", snapshotId: SNAPSHOT_ID, rows: [] }, providerCodeCatalog: PROVIDER_CODE_CATALOG, catalog: SADANG_CATALOG, routeEdges: [] }),
    /MOLIT transfer snapshot rows are required/);
  assert.throws(() => deriveTransferGuideSteps({ snapshot: { sourceId: TRANSFER_GUIDE_SOURCE_ID, snapshotId: SNAPSHOT_ID, rows: [] }, providerCodeCatalog: PROVIDER_CODE_CATALOG, catalog: SADANG_CATALOG }),
    /route edges are required/);
});

// 노선 토큰 가드(F1): 실데이터 사례를 fixture로 고정한다.
// 4호선 고잔은 첫 단계 방면 표기가 수인분당선으로 나온다(후보 실측 FROM_LINE_MISMATCH 4건).
const GOJAN_CATALOG = catalogOf({
  stations: [["s-gojan", "고잔"], ["s-choji", "초지"], ["s-jungang", "중앙"]],
  lines: [["l-4", "수도권 4호선"], ["l-su", "수도권 수인분당"]],
  memberships: [["s-gojan", "l-4"], ["s-choji", "l-4"], ["s-jungang", "l-4"], ["s-gojan", "l-su"], ["s-choji", "l-su"], ["s-jungang", "l-su"]],
});
const GOJAN_EDGES = [
  ...both("s-choji", "s-gojan", "l-4"), ...both("s-gojan", "s-jungang", "l-4"),
  ...both("s-choji", "s-gojan", "l-su"), ...both("s-gojan", "s-jungang", "l-su"),
];
const KORAIL = "KR(한국철도공사)";

test("RED12 첫 단계 방면 노선 표기가 행의 노선과 다르면 FROM_LINE_MISMATCH로 제외한다(4호선 고잔의 수인분당선 표기)", () => {
  const rows = sourceRows({
    operator: KORAIL, line: "4호선", station: "고잔", from: "수인분당선 중앙 방면", to: "4호선 중앙 방면",
    details: ["1) 수인분당선 중앙 방면 승강장 하차", "2) 4호선 중앙 방면 승강장으로 이동", "3) 승차"],
  });
  const result = derive({ rows, catalog: GOJAN_CATALOG, routeEdges: GOJAN_EDGES });
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.summary.excludedByReason, { FROM_LINE_MISMATCH: 1 });
  assert.deepEqual(result.excludedSequences.map(({ providerStationName, reason }) => `${providerStationName}:${reason}`), ["고잔:FROM_LINE_MISMATCH"]);
});

test("RED13 마지막 단계 방면 노선 표기가 출발 노선과 같거나 표에 없으면 TO_LINE_UNRESOLVED로 제외한다", () => {
  const sameLine = sourceRows({
    line: "2호선", station: "사당", from: "2호선 방배 방면", to: "2호선 낙성대 방면",
    details: ["1) 2호선 방배 방면 승강장 하차", "2) 2호선 낙성대 방면 승강장으로 이동", "3) 승차"],
  });
  const unknownToken = sourceRows({
    line: "2호선", station: "사당", from: "2호선 방배 방면", to: "없는선 총신대입구 방면",
    details: ["1) 2호선 방배 방면 승강장 하차", "2) 없는선 총신대입구 방면 승강장으로 이동", "3) 승차"],
  });
  for (const rows of [sameLine, unknownToken]) {
    const result = derive({ rows, catalog: SADANG_CATALOG, routeEdges: SADANG_EDGES });
    assert.equal(result.rows.length, 0);
    assert.deepEqual(result.summary.excludedByReason, { TO_LINE_UNRESOLVED: 1 });
  }
});

const EVALUATION_AT = "2026-10-06T00:00:00.000Z";

// F4: 모바일 데이터팩에 싣는 원천은 QA 승인 기록(productionUseAdmission)이 있어야 한다. 기록이 없으면 소비자가 실패한다.
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const GUIDE_INPUT_FILES = [
  "tools/datapack/source-inventory.json",
  "tools/datapack/source-candidates.json",
  "release/product-gates/datapack-freshness-sla.json",
  "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
  "tools/datapack/sources/molit-railway-transfer-movement-20260811.csv.gz",
  "tools/datapack/sources/molit-railway-transfer-movement-20260811.csv.gz.json",
];

async function guideInputRoot(mutateCandidates) {
  const root = await mkdtemp(path.join(tmpdir(), "transfer-guide-admission-"));
  for (const relative of GUIDE_INPUT_FILES) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await cp(path.join(REPO_ROOT, relative), path.join(root, relative));
  }
  if (mutateCandidates) {
    const candidatesPath = path.join(root, "tools/datapack/source-candidates.json");
    const document = JSON.parse(await readFile(candidatesPath, "utf8"));
    mutateCandidates(document.candidates.find(({ id }) => id === TRANSFER_GUIDE_SOURCE_ID));
    await writeFile(candidatesPath, JSON.stringify(document));
  }
  return root;
}

test("RED14 MOLIT 후보에 환승 안내 단계의 QA 승인 기록이 있고 mobileEmbeddingAllowed는 그대로다", async () => {
  const candidates = JSON.parse(await readFile(path.join(REPO_ROOT, "tools/datapack/source-candidates.json"), "utf8")).candidates
    .filter(({ id }) => id === TRANSFER_GUIDE_SOURCE_ID);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].mobileEmbeddingAllowed, false);
  const admission = candidates[0].evidence.productionUseAdmission;
  assert.equal(admission.artifactKind, "source-production-use-admission");
  assert.equal(admission.issue, 957);
  assert.equal(admission.decisionRef, "https://github.com/AquilaXk/easysubway-data/issues/957");
  assert.equal(admission.decision, "APPROVED");
  assert.equal(admission.approvedBy, "QA");
  assert.equal(admission.approvedAt, "2026-10-05");
  assert.equal(admission.scope, "MOBILE_DATAPACK_TRANSFER_GUIDE_STEPS");
  assert.equal(admission.scope, TRANSFER_GUIDE_PRODUCTION_USE_SCOPE);
  assert.equal(admission.productionUseAllowed, true);
  assert.equal(admission.consumer, "tools/datapack/build-transfer-guide-steps.mjs");
  assert.match(admission.rationale, /국토부·KRIC 환승 단계 문장을 최대한 그대로 사용자에게 보여 준다/u);
});

test("RED15 승인 기록이 없거나 범위·소비자·결정이 다르면 입력 읽기가 실패한다", async () => {
  const cases = {
    "기록 없음": (candidate) => { delete candidate.evidence.productionUseAdmission; },
    "결정이 APPROVED가 아님": (candidate) => { candidate.evidence.productionUseAdmission.decision = "PENDING"; },
    "productionUseAllowed가 false": (candidate) => { candidate.evidence.productionUseAdmission.productionUseAllowed = false; },
    "범위 불일치": (candidate) => { candidate.evidence.productionUseAdmission.scope = "SERVER_ROUTE_BUNDLE_STATION_ELEVATOR_PATH"; },
    "소비자 불일치": (candidate) => { candidate.evidence.productionUseAdmission.consumer = "tools/datapack/build-station-contacts.mjs"; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const root = await guideInputRoot(mutate);
    try {
      await assert.rejects(loadTransferGuideInputs({ repositoryRoot: root, evaluationAt: EVALUATION_AT }), /source is not admitted for transfer guide steps: molit-railway-transfer-movement/u, label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const root = await guideInputRoot();
  try {
    const inputs = await loadTransferGuideInputs({ repositoryRoot: root, evaluationAt: EVALUATION_AT });
    assert.equal(inputs.snapshot.snapshotId, SNAPSHOT_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 후보 실데이터: #943 고정 입력 설계를 따른다. MOLIT 스냅샷은 후보가 고정한 바이트(작업 트리와 다르면 공개 경로에서 받아 sha 확인)로 읽고,
// 전국 후보 팩은 커밋된 후보 산출물에서 읽는다.
const candidateRun = (async () => {
  const workspace = await candidatePinnedWorkspace();
  try {
    const inputs = await loadTransferGuideInputs({ repositoryRoot: workspace.root, evaluationAt: EVALUATION_AT });
    const pack = JSON.parse(await readFile(path.join(workspace.root, "tools/datapack/release/nationwide-production-canonical-pack.json"), "utf8")).packs
      .find(({ id }) => id === "nationwide");
    const result = deriveTransferGuideSteps({
      ...inputs,
      catalog: { stations: pack.stations, lines: pack.lines, stationLines: pack.stationLines },
      routeEdges: pack.networkEdges,
    });
    return { inputs, pack, result };
  } finally {
    await workspace.cleanup();
  }
})();

test("후보 실측: 시퀀스 1,152개가 매핑 성공·중복·제외로 빠짐없이 나뉘고 제외는 사유와 목록으로 드러난다", async () => {
  const { inputs, result } = await candidateRun;
  assert.equal(inputs.snapshot.snapshotId, SNAPSHOT_ID);
  assert.equal(result.sourceSnapshotId, SNAPSHOT_ID);
  const { summary } = result;
  assert.equal(summary.sequenceCount, 1152);
  assert.equal(summary.mappedSequenceCount + summary.duplicateSequenceCount + summary.excludedSequenceCount, summary.sequenceCount);
  assert.equal(result.excludedSequences.length, summary.excludedSequenceCount);
  assert.equal(Object.values(summary.excludedByReason).reduce((total, count) => total + count, 0), summary.excludedSequenceCount);
  // 매핑 범위가 크게 줄면(예: 매핑 표·방면 파서 회귀) 알린다. 정확한 수는 원천 갱신마다 달라지므로 하한만 둔다.
  assert.ok(summary.mappedSequenceCount / summary.sequenceCount >= 0.7, `mapped ${summary.mappedSequenceCount}/${summary.sequenceCount}`);
  assert.equal(summary.rowCount, result.rows.length);
  for (const entry of result.excludedSequences) assert.match(entry.pathSha256, /^[0-9a-f]{64}$/);
});

test("후보 실측: 담은 문장은 모두 원천 이동내용상세를 앞뒤 공백만 걷은 값이고 키의 식별자는 팩에 있다", async () => {
  const { inputs, pack, result } = await candidateRun;
  const sourceDetails = new Set(inputs.snapshot.rows.map((row) => row.MV_CONT_DTL.trim()));
  const stationIds = new Set(pack.stations.map(({ id }) => id));
  const lineIds = new Set(pack.lines.map(({ id }) => id));
  for (const row of result.rows) {
    assert.ok(sourceDetails.has(row.detail), row.detail);
    assert.equal(row.detail, row.detail.trim());
    for (const stationId of [row.stationId, row.fromPrevStationId, row.toNextStationId]) assert.ok(stationIds.has(stationId), stationId);
    for (const lineId of [row.fromLineId, row.toLineId]) assert.ok(lineIds.has(lineId), lineId);
    assert.equal(row.sourceSnapshotId, SNAPSHOT_ID);
  }
});

// F5: 문장 단위 집합 포함이 아니라 시퀀스 단위로 비교한다. 키마다 단계 배열이 원천 시퀀스의 trim 결과와 순서까지 정확히 같아야 한다.
// 원천 시퀀스는 테스트가 따로 묶는다(운영 코드의 묶기를 쓰지 않는다): 단계 번호 1이 새 시퀀스를 연다.
test("후보 실측: 키마다 단계 배열이 원천 시퀀스의 이동내용상세를 trim한 결과와 순서까지 정확히 같다", async () => {
  const { inputs, pack, result } = await candidateRun;
  const sourceSequences = [];
  for (const row of inputs.snapshot.rows) {
    if (row.CHTN_MV_TP_ORDR === "1" || sourceSequences.length === 0) sourceSequences.push({ station: row.STIN_NM, raw: [] });
    sourceSequences.at(-1).raw.push(row.MV_CONT_DTL);
  }
  const normalize = (name) => name.normalize("NFKC").replace(/역$/u, "").replace(/[^\p{L}\p{N}]+/gu, "");
  const stations = new Map(pack.stations.map((station) => [station.id, station]));
  const keys = new Map();
  for (const row of result.rows) {
    const key = [row.stationId, row.fromLineId, row.fromPrevStationId, row.toLineId, row.toNextStationId].join("\0");
    keys.set(key, [...(keys.get(key) ?? []), row]);
  }
  assert.equal(keys.size, result.summary.mappedSequenceCount);
  let trimmedSentences = 0;
  for (const rows of keys.values()) {
    assert.deepEqual(rows.map(({ stepOrder }) => stepOrder), rows.map((_, index) => index + 1));
    const station = stations.get(rows[0].stationId);
    const names = new Set([station.nameKo, ...(station.nameSub ? [`${station.nameKo}(${station.nameSub})`] : [])].map(normalize));
    const details = rows.map(({ detail }) => detail);
    const source = sourceSequences.find((sequence) => names.has(normalize(sequence.station))
      && sequence.raw.length === details.length && sequence.raw.every((raw, index) => raw.trim() === details[index]));
    assert.ok(source, `no source sequence equals ${JSON.stringify(details)}`);
    trimmedSentences += source.raw.filter((raw, index) => raw !== details[index]).length;
  }
  // 앞뒤 공백이 있던 원천 문장이 실제로 있어 trim-only 규칙이 이 테스트에서 실행된다.
  assert.ok(trimmedSentences > 0);
});

test("후보 실측: 고속터미널 9->3, 왕십리 2->5, 사당 2<->4 시퀀스가 원문 그대로 담긴다", async () => {
  const { pack, result } = await candidateRun;
  const names = new Map(pack.stations.map(({ id, nameKo }) => [id, nameKo]));
  const lines = new Map(pack.lines.map(({ id, nameKo }) => [id, nameKo]));
  const sequence = ({ station, fromLine, prev, toLine, next }) => result.rows
    .filter((row) => names.get(row.stationId) === station && lines.get(row.fromLineId) === fromLine && names.get(row.fromPrevStationId) === prev
      && lines.get(row.toLineId) === toLine && names.get(row.toNextStationId) === next)
    .map(({ detail }) => detail);
  // 9호선 사평 방면 열차를 탔다면 직전 역은 신반포, 3호선 잠원 방면 열차를 타면 다음 역은 잠원이다.
  assert.deepEqual(sequence({ station: "고속터미널", fromLine: "수도권 9호선", prev: "신반포", toLine: "수도권 3호선", next: "잠원" }), [
    "1) 사평 방면 승강장", "2) 엘리베이터 이용", "3) 지하 2층으로 이동", "4) 7호선 환승통로 이동",
    "5) 3호선 잠원 방면 엘리베이터 이용", "6) 지하 3층으로 이동", "7) 3호선 잠원 방면 승강장",
  ]);
  // 2호선 상왕십리 방면 열차를 탔다면 직전 역은 한양대다.
  assert.deepEqual(sequence({ station: "왕십리", fromLine: "수도권 2호선", prev: "한양대", toLine: "수도권 5호선", next: "행당" }), [
    "1) (B2) 2호선 상왕십리 방면 승강장 하차", "2) 환승대합실로 이동", "3) 5호선 방향 엘리베이터 탑승", "4) (B4) 5호선 대합실로 이동",
    "5) 5호선 행당 방면 엘리베이터 탑승", "6) (B5) 5호선 행당 방면 승강장으로 이동", "7) 승차 (휠체어칸)",
  ]);
  assert.deepEqual(sequence({ station: "사당", fromLine: "수도권 2호선", prev: "낙성대", toLine: "수도권 4호선", next: "총신대입구" }), [
    "1) (B2) 2호선 방배 방면 승강장 하차", "2) 대합실 방향 엘리베이터 탑승", "3) (B1) 대합실로 이동",
    "4) 4호선 승강장 방향 엘리베이터 탑승", "5) (B3) 4호선 총신대입구 방면 승강장으로 이동", "6) 승차 (휠체어칸)",
  ]);
  assert.deepEqual(sequence({ station: "사당", fromLine: "수도권 4호선", prev: "남태령", toLine: "수도권 2호선", next: "방배" }), [
    "1) (B3) 4호선 총신대입구 방면 승강장 하차", "2) 대합실 방향 엘리베이터 탑승", "3) (B1) 2호선 대합실로 이동", "4) 표 내는 곳 통과",
    "5) 2호선 방배 방면 엘리베이터 탑승", "6) (B2) 2호선 방배 방면 승강장으로 이동", "7) 승차 (휠체어칸)",
  ]);
});

test("팩 SQLite: 후보 실데이터가 transfer_guide_steps·transfer_guide_sources에 같은 수로 들어가고 원천 hash로 결속된다", async () => {
  const { inputs, pack, result } = await candidateRun;
  const schema = await readFile(path.resolve(import.meta.dirname, "schema/catalog-schema.sql"), "utf8");
  const sourceRow = transferGuideSourceRow({ result, rawSha256: inputs.snapshot.rawSha256 });
  const tempDir = await mkdtemp(path.join(tmpdir(), "transfer-guide-pack-"));
  try {
    const sqlitePath = path.join(tempDir, "pack.sqlite");
    buildSqlitePack(sqlitePath, schema, {
      id: "nationwide", version: 1, artifactKind: "production",
      operators: pack.operators, lines: pack.lines, stations: pack.stations, stationLines: pack.stationLines,
      transferGuideSteps: result.rows, transferGuideSources: [sourceRow],
    }, new Map(), { repositoryRoot: path.resolve(import.meta.dirname, "../..") });
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transfer_guide_steps").get().count, result.rows.length);
      assert.deepEqual(db.prepare("SELECT source_snapshot_id AS id, raw_sha256 AS sha, dataset_label AS label, attribution FROM transfer_guide_sources").all().map((row) => ({ ...row })), [{
        id: SNAPSHOT_ID, sha: inputs.snapshot.rawSha256, label: "국토교통부 철도역 환승 이동경로", attribution: "국토교통부 철도역 환승 이동경로(공공데이터포털 15130556)",
      }]);
      assert.deepEqual(db.prepare("SELECT DISTINCT source_snapshot_id AS id FROM transfer_guide_steps").all().map(({ id }) => id), [SNAPSHOT_ID]);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check(transfer_guide_steps)").all(), []);
      const first = db.prepare("SELECT detail FROM transfer_guide_steps ORDER BY station_id, from_line_id, from_prev_station_id, to_line_id, to_next_station_id, step_order LIMIT 1").get();
      assert.equal(first.detail, result.rows[0].detail);
    } finally {
      db.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("팩 SQLite: 팩에 없는 역을 가리키거나 문장이 비면 실패한다(대체 값 없음)", async () => {
  const { inputs, pack, result } = await candidateRun;
  const schema = await readFile(path.resolve(import.meta.dirname, "schema/catalog-schema.sql"), "utf8");
  const sourceRow = transferGuideSourceRow({ result, rawSha256: inputs.snapshot.rawSha256 });
  const build = (rows) => {
    const tempDir = path.join(tmpdir(), `transfer-guide-bad-${process.pid}-${Math.random().toString(16).slice(2)}.sqlite`);
    try {
      buildSqlitePack(tempDir, schema, {
        id: "nationwide", version: 1, artifactKind: "production",
        operators: pack.operators, lines: pack.lines, stations: pack.stations, stationLines: pack.stationLines,
        transferGuideSteps: rows, transferGuideSources: [sourceRow],
      }, new Map(), { repositoryRoot: path.resolve(import.meta.dirname, "../..") });
    } finally {
      void rm(tempDir, { force: true });
    }
  };
  assert.throws(() => build([{ ...result.rows[0], toNextStationId: "station-not-in-pack" }]), /FOREIGN KEY/);
  assert.throws(() => build([{ ...result.rows[0], detail: "" }]), /transferGuideSteps\.detail/);
});

test("provenance 보고: 원천 스냅샷·raw hash와 매핑 성공·실패 수, 제외 목록이 한 객체로 묶인다", async () => {
  const { inputs, result } = await candidateRun;
  const report = transferGuideReport({ result, rawSha256: inputs.snapshot.rawSha256 });
  assert.equal(report.table, "transfer_guide_steps");
  assert.equal(report.sourceId, TRANSFER_GUIDE_SOURCE_ID);
  assert.equal(report.sourceSnapshotId, SNAPSHOT_ID);
  assert.equal(report.rawSha256, inputs.snapshot.rawSha256);
  assert.equal(report.sequenceCount, 1152);
  assert.equal(report.excludedSequences.length, report.excludedSequenceCount);
  assert.throws(() => transferGuideReport({ result, rawSha256: "abc" }), /raw sha256 is required/);
});
