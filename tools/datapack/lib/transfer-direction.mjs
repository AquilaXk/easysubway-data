// 환승 방면 해석 공용 모듈(#957): #944 build-transfer-stair-access와 #957 build-transfer-guide-steps가 같은 규칙을 쓰도록 한 곳에 둔다.
// 순수 이동이다. 노선명 매핑 표, 원천 (운영기관·노선·역) 묶음의 정본 역-노선 매핑, 완행 이웃 역, 방면 표기 해석을 담는다.
import { partitionMolitTransferTuples } from "../build-accessibility-source-coverage-report.mjs";

// 고정 노선명 매핑 표: 번들 정본 노선 이름 -> KRIC 코드 카탈로그 노선(운영기관 코드·노선 코드)과 원천 방면 표기의 노선 이름.
// 원천 노선은 이 표와 기존 partitionMolitTransferTuples(운영기관 코드·KRIC 카탈로그·정확한 역명)로만 정본 역-노선에 잇는다.
export const TRANSFER_STAIR_LINE_TABLE = Object.freeze([
  line("수도권 1호선", [["S1", "1"], ["KR", "1"]], ["1호선"]),
  line("수도권 2호선", [["S1", "2"]], ["2호선"]),
  line("수도권 3호선", [["S1", "3"], ["KR", "3"]], ["3호선"]),
  line("수도권 4호선", [["S1", "4"], ["KR", "4"], ["NU", "4"]], ["4호선"]),
  line("수도권 5호선", [["S1", "5"]], ["5호선"]),
  line("수도권 6호선", [["S1", "6"]], ["6호선"]),
  line("수도권 7호선", [["S1", "7"], ["IC", "7"]], ["7호선"]),
  line("수도권 8호선", [["S1", "8"], ["GU", "8"], ["NU", "8"]], ["8호선"]),
  line("수도권 9호선", [["S9", "9"]], ["9호선"]),
  line("수도권 수인분당", [["KR", "K1"]], ["수인분당선", "분당선", "수인선"]),
  line("수도권 경춘", [["KR", "K2"]], ["경춘선"]),
  line("수도권 경의중앙", [["KR", "K4"]], ["경의중앙선"]),
  line("수도권 경강", [["KR", "K5"]], ["경강선"]),
  line("수도권 서해선", [["KR", "WS"], ["SW", "WS"]], ["서해선"]),
  line("수도권 신분당", [["DX", "D1"]], ["신분당선"]),
  line("수도권 공항", [["AR", "A1"]], ["공항철도"]),
  line("수도권 GTX-A", [["GX", "A"]], ["GTXA", "GTX-A"]),
  line("수도권 우이신설", [["UI", "UI"]], ["우이신설선"]),
  line("수도권 신림선", [["SL", "L1"]], ["신림선"]),
  line("수도권 에버라인", [["EV", "E1"]], ["에버라인", "에버라인(용인경전철)"]),
  line("수도권 의정부", [["UL", "U1"]], ["의정부경전철"]),
  line("수도권 김포골드라인", [["GM", "G1"]], ["김포골드라인"]),
  line("인천 1호선", [["IC", "I1"]], ["인천1호선"]),
  line("인천 2호선", [["IC", "I2"]], ["인천2호선"]),
  line("부산 1호선", [["BS", "1"]], ["1호선"]),
  line("부산 2호선", [["BS", "2"]], ["2호선"]),
  line("부산 3호선", [["BS", "3"]], ["3호선"]),
  line("부산 4호선", [["BS", "4"]], ["4호선"]),
  line("부산 부산김해경전철", [["BG", "B1"]], ["부산김해경전철"]),
  line("부산 동해", [["KR", "K6"]], ["동해선"]),
  line("대구 1호선", [["DG", "1"]], ["1호선"]),
  line("대구 2호선", [["DG", "2"]], ["2호선"]),
  line("대구 3호선", [["DG", "3"]], ["3호선"]),
  line("대구 대경선", [["KR", "K7"]], ["대경선"]),
  line("대전 1호선", [["DJ", "1"]], ["1호선"]),
  line("광주 1호선", [["GJ", "1"]], ["1호선"]),
]);


function line(lineName, providerLines, directionTokens) {
  return Object.freeze({
    lineName,
    providerLines: Object.freeze(providerLines.map(([railOprIsttCd, lnCd]) => Object.freeze({ railOprIsttCd, lnCd }))),
    directionTokens: Object.freeze(directionTokens),
  });
}


export function resolveTableLines(lines) {
  const byName = new Map();
  for (const entry of TRANSFER_STAIR_LINE_TABLE) {
    const matches = lines.filter(({ nameKo }) => nameKo === entry.lineName);
    if (matches.length > 1) throw new Error(`transfer stair line table name is ambiguous: ${entry.lineName}`);
    if (matches.length === 1) byName.set(entry.lineName, { ...entry, lineId: matches[0].id });
  }
  return [...byName.values()];
}

export function localNeighbors(routeEdges) {
  const neighbors = new Map();
  const add = (stationId, lineId, other) => {
    const key = `${stationId}\0${lineId}`;
    const set = neighbors.get(key) ?? new Set();
    set.add(other);
    neighbors.set(key, set);
  };
  for (const edge of routeEdges) {
    if (edge.edgeType !== "RIDE" || edge.servicePattern !== "LOCAL") continue;
    const from = splitNode(edge.fromNodeId);
    const to = splitNode(edge.toNodeId);
    if (!from || !to || from.lineId !== to.lineId || from.stationId === to.stationId) continue;
    add(from.stationId, from.lineId, to.stationId);
    add(to.stationId, to.lineId, from.stationId);
  }
  return neighbors;
}

export function splitNode(nodeId) {
  const parts = String(nodeId).split(":");
  return parts.length === 2 && parts.every(Boolean) ? { stationId: parts[0], lineId: parts[1] } : null;
}


export function tupleKey(row) {
  return `${row.RAIL_OPR_ISTT_CD}\0${row.LN_NM}\0${row.STIN_NM}`;
}

// 원천 (운영기관·노선·역) 묶음을 기존 partitionMolitTransferTuples로 정본 역-노선에 잇는다.
export function mapProviderTuples({ rows, providerCodeCatalog, catalog, stations, tableLines }) {
  const stationLines = [];
  for (const entry of tableLines) {
    const catalogLines = entry.providerLines.map(({ railOprIsttCd, lnCd }) => {
      const matches = providerCodeCatalog.providerLines.filter((providerLine) =>
        providerLine.railOprIsttCd === railOprIsttCd && providerLine.lnCd === lnCd);
      if (matches.length !== 1) throw new Error(`transfer stair line table provider line is not in the KRIC catalog: ${railOprIsttCd}/${lnCd}`);
      return matches[0];
    });
    for (const { stationId, lineId } of catalog.stationLines.filter(({ lineId }) => lineId === entry.lineId)) {
      const station = stations.get(stationId);
      if (!station) throw new Error(`transfer stair station is missing: ${stationId}`);
      for (const catalogLine of catalogLines) {
        stationLines.push({
          stationId,
          stationName: station.nameKo,
          stationAliases: subNamed(station),
          lineId,
          lineName: catalogLine.lineName,
          operatorId: catalogLine.railOprIsttCd,
          operatorName: catalogLine.operatorName,
        });
      }
    }
  }
  const partition = partitionMolitTransferTuples({
    artifacts: [{ artifactId: "transfer-stair-access", stationLines }],
    rows,
    providerCodeCatalog,
  });
  const mapping = new Map();
  const keyOf = (entry) => `${entry.providerOperatorCode}(${entry.providerOperatorName})\0${entry.providerLineName}\0${entry.providerStationName}`;
  for (const entry of partition.joined) {
    const [match] = entry.mappings;
    mapping.set(keyOf(entry), { stationId: match.stationId, lineId: match.lineId });
  }
  for (const entry of [...partition.unmatched, ...partition.ambiguous]) mapping.set(keyOf(entry), { reason: entry.reason });
  for (const row of rows) {
    if (!mapping.has(tupleKey(row))) throw new Error("MOLIT transfer tuple partition is incomplete");
  }
  return mapping;
}

export function subNamed(station) {
  return typeof station.nameSub === "string" && station.nameSub !== "" ? [`${station.nameKo}(${station.nameSub})`] : [];
}


export function parseDirection(value) {
  const match = /^(\S+) (\S+) 방면$/u.exec(String(value ?? "").trim());
  return match ? { lineToken: match[1], stationName: match[2] } : null;
}

export function directionStation(stationId, lineId, name, stations, neighbors) {
  const wanted = normalizeStationName(name);
  const matches = [...(neighbors.get(`${stationId}\0${lineId}`) ?? [])].filter((neighborId) => {
    const neighbor = stations.get(neighborId);
    return neighbor && [neighbor.nameKo, ...subNamed(neighbor)].some((candidate) => normalizeStationName(candidate) === wanted);
  });
  return matches.length === 1 ? matches[0] : null;
}

// partitionMolitTransferTuples와 같은 역명 정규화(NFKC, 끝의 "역", 문자·숫자 외 제거)다.
export function normalizeStationName(value) {
  return String(value ?? "").normalize("NFKC").replace(/역$/u, "").replace(/[^\p{L}\p{N}]+/gu, "");
}
