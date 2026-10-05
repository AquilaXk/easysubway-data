#!/usr/bin/env node
// #925: 국토교통부 철도역 환승 이동경로(molit-railway-transfer-movement) 공식 원천으로 역 안 환승 간선의 계단 상태를 정한다.
// - 계단 없는 공식 경로가 출발 노선의 모든 방면 x 도착 노선의 모든 방면 조합에 있을 때만 STEP_FREE다. 그 밖은 UNKNOWN이다.
// - STAIR_ONLY는 만들지 않는다. 원천이 경로 목록의 완전성을 말하지 않기 때문이다.
// - 단계 문구는 닫힌 어휘 표로만 판정한다. 표에 없는 문구, 방면 형식 불일치, 이름 해석 실패는 모두 UNKNOWN과 사유로 드러낸다.
// - 이름 유사도 매칭, 다른 방면 경로로 대체, 문구로 시설 연결 추정은 하지 않는다.
// - 환승 시간·거리는 기존 환승 간선 값을 그대로 쓴다(D1). 계단 없는 경로의 시간은 따로 검증되지 않았음을 근거 행에 남긴다.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { validateKricProviderCodeCatalogIdentity } from "./build-molit-nationwide-fixture.mjs";
import {
  MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID,
  buildMolitRailwayTransferMovementSnapshot,
  molitRailwayTransferMovementEditionFromSnapshotId,
} from "./collect-molit-railway-transfer-movement.mjs";
import { resolveMolitTransferSnapshot } from "./prepare-nationwide-candidate-run.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import {
  TRANSFER_STAIR_LINE_TABLE,
  directionStation,
  localNeighbors,
  mapProviderTuples,
  parseDirection,
  resolveTableLines,
  splitNode,
  subNamed,
  tupleKey,
} from "./lib/transfer-direction.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

export { TRANSFER_STAIR_LINE_TABLE };
export const TRANSFER_STAIR_DURATION_BASIS = "GENERAL_TRANSFER_EDGE_NOT_STEP_FREE_PATH";
const PROVIDER_CODE_CATALOG_PATH = "tools/datapack/sources/kric-provider-code-catalog-20260228.json";
const FRESHNESS_POLICY_PATH = "release/product-gates/datapack-freshness-sla.json";
const ADMITTED_STATUS = "official_snapshot_admitted";

// 원천 단계 문구 어휘 표. 앞 번호("3) ")·층 표기("(B2)")·휠체어칸 표기를 걷어 낸 문구에 위에서부터 적용하고 처음 맞는 규칙을 쓴다.
// - 막는 규칙(BLOCKING)은 문구 어디에 키워드가 나와도 걸린다. 사유를 붙이는 보조 장치다.
// - 계단 없음 규칙(STEP_FREE)은 닫힌 어휘다. 문구를 띄어쓰기 단위 낱말로 나눠, 끝부분이 규칙의 핵심 낱말과 정확히 같고
//   나머지 낱말이 모두 한정어 허용 목록(장소·관계어·층·칸, 고정 노선 표기, 번들 정본 역 이름)에 있을 때만 맞는다.
// - 어느 규칙에도 맞지 않으면 UNRECOGNIZED이고 계단 없음 근거가 아니다(#944 리뷰 F1).
const ELEVATOR_WORDS = Object.freeze(["엘리베이터", "엘레베이터"]);
const PLACE_ROOT = "(?:환승대합실|대합실|승강장|환승통로|연결통로|환승홀|맞이방|통로)";
const QUALIFIER_WORDS = new Set([
  "환승대합실", "대합실", "승강장", "환승통로", "연결통로", "환승홀", "맞이방", "통로", "환승", "지하", "지상",
  "방면", "방향", "내", "근처", "맞은편", "앞", "옆", ...ELEVATOR_WORDS,
]);
const FLOOR_WORD = /^(?:지하|지상)?\d+층$/u;
const CAR_WORD = /^\d+번칸$/u;
const LINE_LIST_SEPARATOR = /[/·ㆍ,]/u;
const MAX_SPACED_NAME_TOKENS = 4;
const DESTINATION_WORD = new RegExp(`^(?:${PLACE_ROOT}|(?:지하|지상)?\\d+층)(?:으로|로|에서)?$`, "u");
const ELEVATOR_MOVE_CONNECTORS = Object.freeze([[], ["이용하여"], ["이용해"], ["이용", "후"], ["이용후"], ["탑승", "후"], ["하차", "후"]]);
const FARE_GATE_PHRASES = Object.freeze([["표", "내는", "곳"], ["표", "내는곳"], ["개집표기"], ["개표구"], ["환승", "게이트"], ["환승게이트"], ["게이트"]]);
export const TRANSFER_STEP_VOCABULARY = Object.freeze([
  blocking("STAIRS_KEYWORD", "STAIRS", /계단/u, ["계단으로 이동", "계단옆 엘리베이터 이용 후 지하2층 이동", "상봉방면 지하1층 계단"]),
  blocking("ESCALATOR_KEYWORD", "ESCALATOR", /에스컬레이[터타]/u, ["에스컬레이터 탑승", "대합실 방향 에스컬레이터로 이동"]),
  blocking("LIFT_KEYWORD", "LIFT", /리프트/u, ["대합실 방향 휠체어리프트 탑승", "6호선 월드컵경기장 방면 장애인용리프트 탑승"]),
  blocking("OUTSIDE_KEYWORD", "OUTSIDE", /출구|출입구|외부|인도|횡단보도|밖|바깥/u, [
    "13번 출구로 이동", "2호선 6번 출입구 옆 엘리베이터 이동", "1F 외부로 이동", "횡단보도이용", "개집표기 밖으로 이동", "세연정앞 인도",
  ]),
  blocking("UNAVAILABLE_OR_ASSISTED_WORDING", "UNAVAILABLE", /고장|중지|미운영|공사|불가|중단|없음|없는|직원|호출|요청|동행/u, [
    "엘리베이터 고장 시 직원 호출", "장애인 게이트에서 콜 버튼 눌러 4호선 환승을 위한 게이트 통과 요청",
  ]),
  stepFree("ALIGHT_AT_PLATFORM", "ALIGHT", (tokens, context) => endsWithAny(tokens, context, [["승강장", "하차"], ["승강장에서", "하차"]]), [
    "2호선 방배 방면 승강장 하차", "경의중앙선 서강대 방면 승강장 하차",
  ]),
  stepFree("ELEVATOR_RIDE", "ELEVATOR", (tokens, context) => endsWithAny(tokens, context, ELEVATOR_WORDS.flatMap((word) => [
    ...["탑승", "이용", "승차"].map((verb) => [word, verb]), [`${word}를`, "이용"],
  ])), [
    "대합실 방향 엘리베이터 탑승", "승강장 내 엘리베이터 탑승", "3번칸 근처 엘리베이터 이용", "맞은편 엘리베이터 승차", "4호선 승강장 엘레베이터 탑승",
  ]),
  stepFree("ELEVATOR_EXIT", "ELEVATOR", (tokens, context) => endsWithAny(tokens, context, ELEVATOR_WORDS.map((word) => [word, "하차"])), [
    "엘리베이터 하차", "연결통로 엘리베이터 하차",
  ]),
  stepFree("ELEVATOR_AT_PLACE", "ELEVATOR", (tokens, context) => endsWithAny(tokens, context, ELEVATOR_WORDS.map((word) => [word])), [
    "환승 지하1층 엘리베이터", "상봉방면 지상2층 엘리베이터", "상봉방면 지상1층 승강장 엘리베이터",
  ]),
  stepFree("ELEVATOR_MOVE", "ELEVATOR", matchesElevatorMove, [
    "엘리베이터 2층으로 이동", "승강장 엘리베이터를 이용하여 지하3층 환승홀로 이동", "신분당선 방면 엘리베이터로 이동", "엘리베이터 이용 후 지하2층 대합실로 이동",
  ]),
  // 승하차 지점 표기("사평 방면 승강장"): 경로의 처음·끝 단계에서만 인정한다(evaluatePathSteps).
  stepFree("PLATFORM_ENDPOINT", "PLATFORM_ENDPOINT", (tokens, context) => tokens.length >= 2 && tokens.at(-1) === "승강장"
    && tokens.at(-2).endsWith("방면") && qualifiers(tokens.slice(0, -1), context), ["사평 방면 승강장", "상봉방면 승강장", "GTX-A 연신내 방면 승강장"]),
  stepFree("BOARD", "BOARD", (tokens, context) => (tokens.length === 1 && tokens[0] === "승차")
    || endsWithAny(tokens, context, [["승강장", "승차"]]), ["승차", "6호선 승강장 승차"]),
  stepFree("FARE_GATE_PASS", "FARE_GATE", (tokens, context) => endsWithAny(tokens, context, FARE_GATE_PHRASES.map((phrase) => [...phrase, "통과"])), [
    "표 내는 곳 통과", "표 내는곳 통과", "개집표기 통과", "환승 게이트 통과", "1호선 방향 환승게이트 통과", "엘리베이터 앞 표 내는 곳 통과",
  ]),
  stepFree("LEVEL_MOVE_TO_PLACE", "LEVEL_MOVE", (tokens, context) => tokens.length >= 2 && ["이동", "이용"].includes(tokens.at(-1))
    && DESTINATION_WORD.test(tokens.at(-2)) && qualifiers(tokens.slice(0, -2), context), [
    "대합실로 이동", "환승통로로 이동", "4호선 총신대입구 방면 승강장으로 이동", "지하 2층으로 이동", "환승통로 이용", "승강장 이동", "지하1층 이동",
  ]),
]);
const LEVEL_DEVICE_KINDS = new Set(["ELEVATOR", "LIFT", "ESCALATOR", "STAIRS"]);
// 층 표기가 내리는 층인 승강 설비 규칙.
const DESTINATION_LABEL_RULES = new Set(["ELEVATOR_EXIT", "ELEVATOR_MOVE"]);
const STEP_PREFIX = /^\s*(\d+)\)\s*/u;
const FLOOR_TOKEN = /\((B\d+|BM|\d+F|F\d+)\)|(지하|지상)? ?(\d+)층/gu;

const DIRECTION_LINE_TOKENS = new Set(TRANSFER_STAIR_LINE_TABLE.flatMap(({ directionTokens }) => directionTokens));

// context.stationNames: 한정어로 허용할 번들 정본 역 이름(이름, "이름(부명)"). 없으면 역 이름이 든 문구는 어휘 밖이다.
export function classifyTransferStep(detail, context = {}) {
  if (typeof detail !== "string") throw new Error("transfer step detail must be a string");
  const stationNames = context.stationNames instanceof Set ? context.stationNames : new Set(context.stationNames ?? []);
  const vocabularyContext = { stationNames, lineTokens: DIRECTION_LINE_TOKENS };
  const withoutNumber = detail.replace(STEP_PREFIX, "");
  const floors = [...withoutNumber.matchAll(FLOOR_TOKEN)].map((match) => floorOf(match));
  const text = withoutNumber
    .replace(/\((?:B\d+|BM|\d+F|F\d+)\)/gu, " ")
    .replace(/\([\d\s/-]*휠체어칸\)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const tokens = text === "" ? [] : text.split(" ");
  for (const entry of TRANSFER_STEP_VOCABULARY) {
    const matched = entry.effect === "BLOCKING" ? entry.pattern.test(text) : entry.match(tokens, vocabularyContext);
    if (matched) return { ruleId: entry.id, kind: entry.kind, effect: entry.effect, floors };
  }
  return { ruleId: null, kind: "UNRECOGNIZED", effect: "BLOCKING", floors };
}

export function deriveTransferStairAccess({ snapshot, providerCodeCatalog, catalog, routeEdges }) {
  if (!snapshot || typeof snapshot.snapshotId !== "string" || !Array.isArray(snapshot.rows)) {
    throw new Error("MOLIT transfer snapshot rows are required");
  }
  if (!Array.isArray(providerCodeCatalog?.providerLines)) throw new Error("KRIC provider code catalog is required");
  if (!Array.isArray(catalog?.stations) || !Array.isArray(catalog?.lines) || !Array.isArray(catalog?.stationLines)) {
    throw new Error("transfer stair station catalog is required");
  }
  if (!Array.isArray(routeEdges)) throw new Error("route edges are required");
  const stations = new Map(catalog.stations.map((station) => [station.id, station]));
  const linesAtStation = new Map();
  for (const { stationId, lineId } of catalog.stationLines) {
    linesAtStation.set(stationId, [...(linesAtStation.get(stationId) ?? []), lineId]);
  }
  const tableLines = resolveTableLines(catalog.lines);
  const neighbors = localNeighbors(routeEdges);
  const stepContext = { stationNames: new Set(catalog.stations.flatMap((station) => [station.nameKo, ...subNamed(station)])) };

  const excludedPaths = [];
  const exclude = (pathEntry, reason) => excludedPaths.push({
    providerOperatorCode: pathEntry.operatorCode,
    providerLineName: pathEntry.rows[0].LN_NM,
    providerStationName: pathEntry.rows[0].STIN_NM,
    pathSha256: pathEntry.pathSha256,
    reason,
  });
  const grouped = groupPaths(snapshot.rows);
  const valid = [];
  for (const entry of grouped) {
    if (entry.invalid) exclude(entry, "STEP_SEQUENCE_INVALID");
    else if (entry.operatorCode === null) exclude(entry, "PROVIDER_OPERATOR_UNPARSEABLE");
    else valid.push(entry);
  }
  const tupleMapping = mapProviderTuples({
    rows: valid.flatMap(({ rows }) => rows),
    providerCodeCatalog,
    catalog,
    stations,
    tableLines,
  });

  const mappedPaths = [];
  for (const entry of valid) {
    const mapping = tupleMapping.get(tupleKey(entry.rows[0]));
    if (mapping.reason) {
      exclude(entry, mapping.reason);
      continue;
    }
    const resolved = resolveDirections({ entry, mapping, stations, linesAtStation, tableLines, neighbors });
    if (resolved.reason) {
      exclude(entry, resolved.reason);
      continue;
    }
    mappedPaths.push({ ...resolved, pathSha256: entry.pathSha256, ...evaluatePathSteps(entry.rows, stepContext) });
  }

  const edges = [];
  const evidenceRows = [];
  for (const edge of routeEdges.filter(({ edgeType }) => edgeType === "IN_STATION_TRANSFER")) {
    const result = evaluateTransferEdge({ edge, mappedPaths, neighbors });
    edges.push(result);
    if (result.state !== "STEP_FREE") continue;
    for (const combo of result.combos) {
      for (const pathSha256 of combo.stepFreePathSha256s) {
        evidenceRows.push({
          edgeId: result.edgeId,
          fromDirectionStationId: combo.fromDirectionStationId,
          toDirectionStationId: combo.toDirectionStationId,
          pathSha256,
          sourceSnapshotId: snapshot.snapshotId,
          durationBasis: TRANSFER_STAIR_DURATION_BASIS,
        });
      }
    }
  }
  edges.sort((left, right) => codepointCompare(left.edgeId, right.edgeId));
  evidenceRows.sort((left, right) => compareFields(left, right, ["edgeId", "fromDirectionStationId", "toDirectionStationId", "pathSha256"]));
  excludedPaths.sort((left, right) => compareFields(left, right, ["providerOperatorCode", "providerLineName", "providerStationName", "pathSha256", "reason"]));
  return {
    sourceId: snapshot.sourceId,
    sourceSnapshotId: snapshot.snapshotId,
    edges,
    evidenceRows,
    excludedPaths,
    summary: {
      pathCount: grouped.length,
      mappedPathCount: mappedPaths.length,
      stepFreeMappedPathCount: mappedPaths.filter(({ stepFree }) => stepFree).length,
      excludedPathCount: excludedPaths.length,
      excludedPathsByReason: countBy(excludedPaths, ({ reason }) => reason),
      transferEdgeCount: edges.length,
      edgesByState: countBy(edges, ({ state }) => state),
      unknownEdgesByReason: countBy(edges.filter(({ state }) => state !== "STEP_FREE"), ({ reason }) => reason),
    },
  };
}

// 운영 빌드 입력: inventory가 잠근 MOLIT 스냅샷을 metadata·gzip hash·행 재현·신선도 정책으로 검증해 읽는다.
// 승인 상태가 아니거나, hash가 어긋나거나, 신선도가 지났으면 실패한다.
export async function loadTransferStairAccessInputs({ repositoryRoot, evaluationAt }) {
  if (typeof repositoryRoot !== "string" || repositoryRoot === "") throw new Error("repository root is required");
  const root = path.resolve(repositoryRoot);
  const read = (relative) => readRepositoryFile(root, relative);
  const [inventoryBytes, candidatesBytes, policyBytes, catalogBytes] = await Promise.all([
    read("tools/datapack/source-inventory.json"),
    read("tools/datapack/source-candidates.json"),
    read(FRESHNESS_POLICY_PATH),
    read(PROVIDER_CODE_CATALOG_PATH),
  ]);
  const sourceInventory = JSON.parse(inventoryBytes);
  const freshnessPolicy = JSON.parse(policyBytes);
  const candidates = JSON.parse(candidatesBytes).candidates?.filter(({ id }) => id === MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID) ?? [];
  const inventoryAdmission = sourceInventory.sources?.find(({ id }) => id === MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID)?.rawSnapshotAdmission;
  if (candidates.length !== 1 || candidates[0].admissionStatus !== ADMITTED_STATUS
    || candidates[0].rawSnapshotAdmission?.snapshotId !== inventoryAdmission?.snapshotId) {
    throw new Error(`source is not admitted for transfer stair access: ${MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID}`);
  }
  const resolved = await resolveMolitTransferSnapshot({ sourceInventory, freshnessPolicy, evaluatedAt: evaluationAt, read });
  const edition = molitRailwayTransferMovementEditionFromSnapshotId(resolved.metadata.snapshotId);
  const rebuilt = buildMolitRailwayTransferMovementSnapshot({
    bytes: gunzipSync(resolved.gzipBytes),
    capturedAt: resolved.metadata.capturedAt,
    editionDate: edition,
    freshnessPolicy,
    expectedRowCount: resolved.metadata.rowCount,
    expectedRawSha256: resolved.metadata.rawSha256,
  });
  for (const field of ["snapshotId", "sortedContentSha256", "schemaFingerprint", "freshUntil"]) {
    if (rebuilt[field] !== resolved.metadata[field]) throw new Error(`MOLIT transfer snapshot ${field} mismatch`);
  }
  const providerCodeCatalog = JSON.parse(catalogBytes);
  validateKricProviderCodeCatalogIdentity(providerCodeCatalog);
  return {
    snapshot: {
      sourceId: MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID,
      snapshotId: rebuilt.snapshotId,
      rawSha256: rebuilt.rawSha256,
      rows: rebuilt.rows,
    },
    providerCodeCatalog,
    freshUntil: resolved.freshUntil,
  };
}

// 서버 번들 원천 SQLite(stations·lines·station_lines)를 판정용 역 목록으로 읽는다.
export function transferStairCatalogFromSqlite(database) {
  return {
    stations: database.prepare("SELECT id, name_ko AS nameKo, name_sub AS nameSub, region FROM stations ORDER BY id").all().map((row) => ({ ...row })),
    lines: database.prepare("SELECT id, name_ko AS nameKo FROM lines ORDER BY id").all().map((row) => ({ ...row })),
    stationLines: database.prepare("SELECT station_id AS stationId, line_id AS lineId FROM station_lines ORDER BY station_id, line_id").all().map((row) => ({ ...row })),
  };
}

function blocking(id, kind, pattern, examples) {
  return Object.freeze({ id, kind, effect: "BLOCKING", pattern, examples: Object.freeze(examples) });
}

function stepFree(id, kind, match, examples) {
  return Object.freeze({ id, kind, effect: "STEP_FREE", match, examples: Object.freeze(examples) });
}

// 한정어 허용 목록: 장소·관계어·층·칸 낱말, 고정 노선 표기, 번들 정본 역 이름, 그리고 그 뒤에 "방면"·"방향"을 붙여 쓴 낱말.
// 여러 노선을 함께 적은 낱말("3호선/서해선")은 구분자로 나눈 조각이 모두 고정 노선 표기와 정확히 같을 때만 허용한다.
function isQualifier(token, context) {
  if (QUALIFIER_WORDS.has(token) || FLOOR_WORD.test(token) || CAR_WORD.test(token)
    || context.lineTokens.has(token) || context.stationNames.has(token) || isLineList(token, context)) {
    return true;
  }
  return ["방면", "방향"].some((suffix) => {
    if (!token.endsWith(suffix) || token.length === suffix.length) return false;
    const stem = token.slice(0, -suffix.length);
    return QUALIFIER_WORDS.has(stem) || context.lineTokens.has(stem) || context.stationNames.has(stem) || isLineList(stem, context);
  });
}

function isLineList(token, context) {
  const parts = token.split(LINE_LIST_SEPARATOR);
  return parts.length > 1 && parts.every((part) => context.lineTokens.has(part));
}

// 낱말 열 전체가 한정어인지 본다. 띄어 쓴 역 이름("을지로 3가")은 이어진 낱말의 공백만 지운 결과가
// 번들 정본 역 이름과 정확히 같을 때만 한 한정어로 묶는다(유사도 매칭 없음).
function qualifiers(tokens, context) {
  const reachable = new Array(tokens.length + 1).fill(false);
  reachable[0] = true;
  for (let start = 0; start < tokens.length; start += 1) {
    if (!reachable[start]) continue;
    if (isQualifier(tokens[start], context)) reachable[start + 1] = true;
    for (let end = start + 2; end <= Math.min(tokens.length, start + MAX_SPACED_NAME_TOKENS); end += 1) {
      if (context.stationNames.has(tokens.slice(start, end).join(""))) reachable[end] = true;
    }
  }
  return reachable[tokens.length];
}

function endsWithAny(tokens, context, cores) {
  return cores.some((core) => tokens.length >= core.length
    && core.every((word, index) => tokens[tokens.length - core.length + index] === word)
    && qualifiers(tokens.slice(0, tokens.length - core.length), context));
}

// "<한정어> 엘리베이터[로|를] [이용 후|이용하여|...] <한정어> [목적지] 이동"
function matchesElevatorMove(tokens, context) {
  if (tokens.length < 2 || tokens.at(-1) !== "이동") return false;
  const body = tokens.slice(0, -1);
  return body.some((token, index) => {
    if (!ELEVATOR_WORDS.some((word) => [word, `${word}로`, `${word}를`].includes(token))) return false;
    if (!qualifiers(body.slice(0, index), context)) return false;
    const rest = body.slice(index + 1);
    return ELEVATOR_MOVE_CONNECTORS.some((connector) => {
      if (!connector.every((word, offset) => rest[offset] === word)) return false;
      const tail = rest.slice(connector.length);
      if (tail.length === 0) return true;
      return qualifiers(tail.slice(0, -1), context) && (isQualifier(tail.at(-1), context) || DESTINATION_WORD.test(tail.at(-1)));
    });
  });
}

function floorOf(match) {
  if (match[1]) {
    const marker = match[1];
    if (/^F\d+$/u.test(marker)) return `${marker.slice(1)}F`;
    return marker;
  }
  return match[2] === "지하" ? `B${match[3]}` : `${match[3]}F`;
}

// 원천 행을 경로(1단계부터 다음 1단계 전까지)로 묶는다. 한 경로는 같은 운영기관·노선·역이고 단계 번호가 1..n이어야 한다.
function groupPaths(rows) {
  const groups = [];
  for (const row of rows) {
    if (row.CHTN_MV_TP_ORDR === "1" || groups.length === 0) groups.push([]);
    groups.at(-1).push(row);
  }
  return groups.map((group) => {
    const head = group[0];
    const invalid = group.some((row, index) => tupleKey(row) !== tupleKey(head)
      || row.CHTN_MV_TP_ORDR !== String(index + 1)
      || (STEP_PREFIX.test(row.MV_CONT_DTL) && STEP_PREFIX.exec(row.MV_CONT_DTL)[1] !== String(index + 1)));
    const operator = /^([A-Z0-9]+)\(([^()]+)\)$/u.exec(head.RAIL_OPR_ISTT_CD);
    return {
      rows: group,
      invalid,
      operatorCode: operator ? operator[1] : null,
      pathSha256: sha256(canonicalJson(group.map((row) => ({
        RAIL_OPR_ISTT_CD: row.RAIL_OPR_ISTT_CD,
        LN_NM: row.LN_NM,
        STIN_NM: row.STIN_NM,
        CHTN_MV_TP_ORDR: row.CHTN_MV_TP_ORDR,
        MV_CONT_DTL: row.MV_CONT_DTL,
        CHTN_MV_CONT: row.CHTN_MV_CONT,
      })))),
    };
  });
}

// 방면은 원천의 "<노선> <역> 방면" 표기에서만 읽는다. 역은 같은 노선 완행 인접 역 이름과 정확히 같아야 한다.
function resolveDirections({ entry, mapping, stations, linesAtStation, tableLines, neighbors }) {
  const from = parseDirection(entry.rows[0].CHTN_MV_CONT);
  const to = parseDirection(entry.rows.at(-1).CHTN_MV_CONT);
  if (!from || !to) return { reason: "DIRECTION_FORMAT_UNSUPPORTED" };
  const stationLines = linesAtStation.get(mapping.stationId) ?? [];
  const linesForToken = (token) => tableLines
    .filter(({ directionTokens, lineId }) => directionTokens.includes(token) && stationLines.includes(lineId))
    .map(({ lineId }) => lineId);
  const fromLines = linesForToken(from.lineToken);
  if (fromLines.length !== 1 || fromLines[0] !== mapping.lineId) return { reason: "FROM_LINE_MISMATCH" };
  const toLines = linesForToken(to.lineToken);
  if (toLines.length !== 1 || toLines[0] === mapping.lineId) return { reason: "TO_LINE_UNRESOLVED" };
  const fromDirection = directionStation(mapping.stationId, mapping.lineId, from.stationName, stations, neighbors);
  const toDirection = directionStation(mapping.stationId, toLines[0], to.stationName, stations, neighbors);
  if (!fromDirection || !toDirection) return { reason: "DIRECTION_NAME_UNRESOLVED" };
  return {
    stationId: mapping.stationId,
    fromLineId: mapping.lineId,
    toLineId: toLines[0],
    fromDirectionStationId: fromDirection,
    toDirectionStationId: toDirection,
  };
}

// 경로 단계 판정: 막는 단계·어휘 밖 문구·층 모순이 하나도 없을 때만 계단 없는 경로다(#944 리뷰 F2).
// 계단 여부는 층 숫자가 아니라 층을 바꾸는 수단으로 판정하고, 층 번호는 모순 검사에만 쓴다(#946 메인 결정).
// - 원천 문구는 층이 바뀔 때만 층을 적는다. 층 표기 없는 단계는 직전 층(승강 설비 뒤라면 설비 도착 층)에 그대로 있는 것으로 보고 층을 관찰하지 않는다.
// - 첫 단계에 층이 없으면 이후 처음 나오는 명시 층이 시작 층이다. 승강 설비 뒤에는 처음 나오는 명시 층이 설비 도착 층이다.
// - 승강 설비 단계 한 번은 그 뒤 층 변화 한 번만 덮는다. 층이 바뀌면 덮개를 쓴다.
// - 엘리베이터 탑승·위치 단계의 층 표기는 타는 층이라 덮개보다 먼저 보고, 하차·이동 단계의 층 표기는 내리는 층이라 덮개 뒤에 본다.
// - 두 명시 층이 다른데 사이에 덮개가 없으면 FLOOR_CHANGE_WITHOUT_LIFT다. 계단·에스컬레이터·경사 등 층 변화 단계와 어휘 밖 문구는 층과 무관하게 막힌다.
function evaluatePathSteps(rows, context) {
  const reasons = new Set();
  let floor = null;
  let covered = false;
  const observe = (observed) => {
    if (floor !== null && observed !== floor && !covered) reasons.add("FLOOR_CHANGE_WITHOUT_LIFT");
    // 승강 설비 뒤 처음 나오는 명시 층이 설비 도착 층이다. 같은 층이든 다른 층이든 덮개는 여기서 끝난다(#958 F1).
    covered = false;
    floor = observed;
  };
  for (const [index, row] of rows.entries()) {
    const step = classifyTransferStep(row.MV_CONT_DTL, context);
    if (step.effect === "BLOCKING") reasons.add(step.kind === "UNRECOGNIZED" ? "STEP_WORDING_UNRECOGNIZED" : step.kind);
    if (step.kind === "PLATFORM_ENDPOINT" && index !== 0 && index !== rows.length - 1) reasons.add("STEP_WORDING_UNRECOGNIZED");
    if (!LEVEL_DEVICE_KINDS.has(step.kind)) {
      step.floors.forEach(observe);
    } else if (DESTINATION_LABEL_RULES.has(step.ruleId)) {
      covered = true;
      step.floors.forEach(observe);
    } else {
      step.floors.forEach(observe);
      covered = true;
    }
  }
  return { stepFree: reasons.size === 0, blockingReasons: [...reasons].sort(codepointCompare) };
}

function evaluateTransferEdge({ edge, mappedPaths, neighbors }) {
  const from = splitNode(edge.fromNodeId);
  const to = splitNode(edge.toNodeId);
  if (!from || !to || from.stationId !== to.stationId || from.lineId === to.lineId) {
    throw new Error(`in-station transfer edge endpoint shape is invalid: ${edge.edgeId}`);
  }
  const base = { edgeId: edge.edgeId, stationId: from.stationId, fromLineId: from.lineId, toLineId: to.lineId };
  const fromDirections = [...(neighbors.get(`${from.stationId}\0${from.lineId}`) ?? [])].sort(codepointCompare);
  const toDirections = [...(neighbors.get(`${to.stationId}\0${to.lineId}`) ?? [])].sort(codepointCompare);
  if (fromDirections.length !== 2 || toDirections.length !== 2) {
    return { ...base, state: "UNKNOWN", reason: "DIRECTION_SET_UNDETERMINED", fromDirectionCount: fromDirections.length, toDirectionCount: toDirections.length, combos: [] };
  }
  const paths = mappedPaths.filter((entry) => entry.stationId === from.stationId
    && entry.fromLineId === from.lineId && entry.toLineId === to.lineId);
  const combos = fromDirections.flatMap((fromDirectionStationId) => toDirections.map((toDirectionStationId) => {
    const comboPaths = paths.filter((entry) => entry.fromDirectionStationId === fromDirectionStationId
      && entry.toDirectionStationId === toDirectionStationId);
    const stepFreePathSha256s = [...new Set(comboPaths.filter(({ stepFree }) => stepFree).map(({ pathSha256 }) => pathSha256))].sort(codepointCompare);
    const status = comboPaths.length === 0 ? "MISSING" : stepFreePathSha256s.length > 0 ? "STEP_FREE" : "NOT_STEP_FREE";
    return {
      fromDirectionStationId,
      toDirectionStationId,
      status,
      pathCount: comboPaths.length,
      stepFreePathSha256s,
      blockingReasons: status === "NOT_STEP_FREE"
        ? [...new Set(comboPaths.flatMap(({ blockingReasons }) => blockingReasons))].sort(codepointCompare)
        : [],
    };
  }));
  let state = "UNKNOWN";
  let reason;
  if (combos.every(({ status }) => status === "STEP_FREE")) {
    state = "STEP_FREE";
    reason = "ALL_DIRECTION_COMBOS_STEP_FREE";
  } else if (paths.length === 0) {
    reason = "NO_OFFICIAL_PATH";
  } else if (combos.some(({ status }) => status === "MISSING")) {
    reason = "DIRECTION_COMBO_MISSING";
  } else {
    reason = "DIRECTION_COMBO_NOT_STEP_FREE";
  }
  return { ...base, state, reason, combos };
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) counts[keyOf(value)] = (counts[keyOf(value)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => codepointCompare(left, right)));
}

function compareFields(left, right, fields) {
  for (const field of fields) {
    const result = codepointCompare(left[field], right[field]);
    if (result) return result;
  }
  return 0;
}

async function readRepositoryFile(root, relative) {
  if (typeof relative !== "string" || relative === "" || path.posix.isAbsolute(relative)
    || relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`transfer stair input path is invalid: ${relative}`);
  }
  return readFile(path.join(root, relative));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// 커버리지 리포트 CLI: 번들 원천 SQLite와 route-edge 입력으로 간선별 판정·제외 경로를 JSON으로 출력한다.
async function main(argv) {
  const args = Object.fromEntries(argv.reduce((pairs, value, index) => (index % 2 === 0 ? [...pairs, [value, argv[index + 1]]] : pairs), []));
  const repositoryRoot = args["--repository-root"];
  const sourceSqlite = args["--source-sqlite"];
  const routeEdgeInput = args["--route-edge-input"];
  const evaluationAt = args["--evaluation-at"];
  if (argv.length !== 8 || !repositoryRoot || !sourceSqlite || !routeEdgeInput || !evaluationAt) {
    throw new Error("usage: build-transfer-stair-access.mjs --repository-root <path> --source-sqlite <path> --route-edge-input <path> --evaluation-at <iso>");
  }
  const inputs = await loadTransferStairAccessInputs({ repositoryRoot, evaluationAt });
  const database = new DatabaseSync(path.resolve(sourceSqlite), { open: true, readOnly: true });
  let catalog;
  try {
    catalog = transferStairCatalogFromSqlite(database);
  } finally {
    database.close();
  }
  const { routeEdges } = JSON.parse(await readFile(path.resolve(routeEdgeInput), "utf8"));
  const result = deriveTransferStairAccess({ ...inputs, catalog, routeEdges });
  const regionOf = new Map(catalog.stations.map(({ id, region }) => [id, region]));
  const byRegion = {};
  for (const edge of result.edges) {
    const region = regionOf.get(edge.stationId) ?? "";
    byRegion[region] ??= {};
    byRegion[region][edge.state] = (byRegion[region][edge.state] ?? 0) + 1;
  }
  process.stdout.write(`${JSON.stringify({ ...result, summary: { ...result.summary, edgesByRegionAndState: byRegion } }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-transfer-stair-access: ${error.message}\n`);
    process.exitCode = 1;
  });
}
