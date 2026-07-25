#!/usr/bin/env node
// #1950: 오너 자작 8선형 수도권 도식(easy-subway-sma-v*)의 역 노드를 canonical
// (station_id, line_id)로 정합하고, route_map_positions.x/y를 그 도식 좌표로 교체한다.
//
// 입력: extract-svg-geometry.mjs --region 수도권 의 JSON(stationNodes 포함).
// 처리:
//   1) SVG data-line 슬러그 → canonical line_id (lines.name_ko 접미 매핑).
//   2) SVG data-station(한글) → canonical station_id (직접 일치 + 규칙 8건).
//   3) SVG root 좌표(2400×1800 viewBox)를 균일 스케일+평행이동으로 정수 좌표계로
//      정규화(8선형 각도·간격비 보존). route_map_positions.x/y를 교체.
//   4) provenance를 self-drawn(오너 자작)으로 교체.
// 게이트: 현행 팩 capital route_map_positions 전 행이 매핑돼야 하고(미매핑 0),
//   SVG 노드도 전부 소비돼야 한다. 도라산 1역(카탈로그에는 있으나 도식 미수록)은
//   명시 예외로 통과시킨다(#1950 canonical 대조표).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openPack, writePack, cleanupPackDir } from "./pack-io.mjs";
import { assertReferentialIntegrity } from "./station-surgery.mjs";
import { getRegionConfig, SEOUL } from "./sma-region-configs.mjs";

// #2011 2단계: 권역 파라미터화. 아래 상수들은 수도권(seoul) 기본값을 재노출해
// 기존 sma-pipeline.test.mjs·소비자의 하위호환을 보장한다. 실제 처리 함수는
// region config를 인자로 받아 여러 권역을 공통 코드로 처리한다.
export const REGION = SEOUL.regionKey;
export const SVG_SOURCE = SEOUL.svgSource;
export const LINE_SLUG_TO_SUFFIX = SEOUL.slugToSuffix;
export const MISSING_LINE_STATION_HINT = SEOUL.missingLineHint;

// canonical 정합 규칙(수도권 기본). region config의 canonicalRules로 위임.
export function canonicalStationName(svgName) {
  return SEOUL.canonicalRules(svgName);
}

function suffixFromLineName(nameKo, prefix) {
  return nameKo.startsWith(`${prefix} `) ? nameKo.slice(prefix.length + 1) : nameKo;
}

export function resolveLineMap(db, config = SEOUL) {
  const rows = db.prepare("SELECT id, name_ko FROM lines WHERE name_ko LIKE ?").all(`${config.lineNamePrefix}%`);
  const bySuffix = new Map();
  for (const row of rows) bySuffix.set(suffixFromLineName(row.name_ko, config.lineNamePrefix), row.id);
  const slugToId = new Map();
  for (const [slug, suffix] of Object.entries(config.slugToSuffix)) {
    const id = bySuffix.get(suffix);
    if (!id) throw new Error(`슬러그 ${slug} → "${config.lineNamePrefix} ${suffix}" 노선을 카탈로그에서 못 찾음`);
    slugToId.set(slug, id);
  }
  return slugToId;
}

// 이름으로 station_id 후보를 확정한다. 반환은 배열(대개 1개).
//  - 유일 → [id]
//  - 노선 힌트(콜론 동명이역)로 유일 해소 → [id]
//  - 힌트 없이 수도권 후보가 여럿 → 전부 반환(오분리된 한 물리역의 여러 id).
//    도식은 이런 역을 단일 dot으로 그리므로 모든 id에 같은 좌표를 준다.
export function resolveStationIds(db, name, lineId, { disambiguateByLine = false, config = SEOUL } = {}) {
  const rows = db.prepare("SELECT id FROM stations WHERE name_ko = ?").all(name);
  if (rows.length === 0) return [];
  if (rows.length === 1) return [rows[0].id];
  // 콜론 동명이역(신촌·양평): 반드시 노선으로 유일 해소 — broadcast 금지(진짜 별개 역).
  if (disambiguateByLine && lineId) {
    const byLine = rows.find((r) =>
      db.prepare("SELECT 1 FROM station_lines WHERE station_id=? AND line_id=?").get(r.id, lineId),
    );
    return byLine ? [byLine.id] : [];
  }
  // 그 외 동명(콜론 아님): 오분리된 한 물리역이므로 해당 권역 노선 멤버 후보 전부에
  // 같은 좌표를 broadcast한다(수도권 상봉·석남·이매, 부산 벡스코·부전).
  const regional = rows.filter((r) =>
    db
      .prepare(
        `SELECT 1 FROM station_lines sl JOIN lines l ON l.id=sl.line_id
         WHERE sl.station_id=? AND l.name_ko LIKE ? LIMIT 1`,
      )
      .get(r.id, `${config.lineNamePrefix} %`),
  );
  return regional.map((r) => r.id);
}

// SVG root 좌표(2400×1800 viewBox, 전부 양수)를 그대로 정수로 반올림한다. 이 프레임을
// 역 좌표·노선 track(build-route-map-line-tracks가 같은 SVG stroke 좌표에서 생성)에
// 공통으로 써 프레임 정합을 보장한다. 균일 변환(반올림)은 8선형 각도·간격비를 보존하며,
// 렌더러는 중앙값 간격으로 자동 스케일하므로 절대 배율은 무관하다(#1789 design space).
export function computeNormalizer(_nodes) {
  return (x, y) => ({ x: Math.round(x), y: Math.round(y) });
}

// 역 단위 배정. 도식은 환승역을 단일 노드(dot)로 그리므로 SVG는 한 역에 한 좌표를
// 준다. 그 좌표를 그 역의 모든 노선 route_map_positions 행에 적용한다(수렴).
// 노선 슬러그는 동명이역 disambiguation 힌트로만 쓴다(고촌처럼 그룹이 노선을 오기해도
// 역 이름·수도권 멤버십으로 유일 해소되면 통과).
// 도식이 노드 마커를 빠뜨린 역(라벨만 존재)의 이름 → 라벨을 좌표 대체값으로 쓴다.
// v1에서 4호선 안산선 꼬리 4역이 라벨만 있고 dot이 없다(오너 도식 누락). 라벨 중심을
// 노드 좌표 대체값으로 쓴다(같은 8선형 라인에 놓임).
// 4호선/수인분당 안산선 꼬리 역들 — v1 도식이 라벨만 두고 dot을 뺐다(수도권 기본값).
export const MARKERLESS_STATION_FALLBACK = SEOUL.markerlessFallback;

function labelCenterByName(extraction) {
  const byName = new Map();
  for (const label of extraction.labels ?? []) {
    const name = label.sourceText;
    if (byName.has(name)) continue;
    const b = label.bounds;
    byName.set(name, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  }
  return byName;
}

// #2068 신원 사고 구조적 방어. 한 station_id에 서로 멀리 떨어진 노드가 여러 개
// 배정 후보로 잡히면, "첫 배정 채택"이 어느 노드를 고르느냐에 따라 그 역 좌표가
// 통째로 엉뚱한 자리로 간다 — 그런데 그 사고는 미매핑·미해소 게이트를 전부
// 통과한다(개수는 맞기 때문). 실제로 v4 김포공항이 이 경로로 캡슐(763,1055)
// 대신 공항 픽토그램 중심(870,1033)에 배정됐다. 도식이 한 역을 한 자리에 그린다는
// 전제가 깨진 것이므로 **경고가 아니라 실패**로 막는다(fail-closed).
// 임계는 역 심벌 지름·환승 캡슐 길이보다 넉넉히 크고(정상 중복 노드는 수 px 이내)
// 오배정은 훨씬 멀다는 실측에 맞춘 값이다.
export const MAX_STATION_CANDIDATE_SPREAD_PX = 100;

// 권역 config의 명시 예외를 station_id → 허용 spread 상한으로 해소한다.
//
// 두 가지를 지킨다.
//  1) **권역 한정**: 이름 대조를 전역으로 하면 다른 권역의 동명 역까지 면제된다
//     (resolveStationIds가 lineNamePrefix LIKE로 권역을 한정하는 것과 같은 이유).
//  2) **사유별 상한 pin**: 면제를 "그 역 무제한"으로 두면, reason에 적힌 알려진
//     결함과 무관한 새 산발(김포공항형 오배정)이 그 역에서 재발해도 게이트가
//     침묵한다. 각 예외가 실측값 기준 상한을 들고, 그 위는 다시 실패한다.
// 이름이 그 권역에서 하나도 해소되지 않는 예외는 오타·이관 잔재이므로 fail-closed
// (조용히 무효가 된 면제가 남아 있는 편이 더 위험하다).
function resolveScatteredCandidateExemptions(db, config) {
  const limitByStationId = new Map();
  for (const exception of config.scatteredCandidateExceptions ?? []) {
    const rows = db
      .prepare(
        `SELECT DISTINCT s.id AS id
         FROM stations s
         JOIN station_lines sl ON sl.station_id = s.id
         JOIN lines l ON l.id = sl.line_id
         WHERE s.name_ko = ? AND l.name_ko LIKE ?`,
      )
      .all(exception.name, `${config.lineNamePrefix} %`);
    if (rows.length === 0) {
      throw new Error(
        `산발 후보 예외 "${exception.name}"이(가) ${config.regionKey} 카탈로그에서 해소되지 않습니다 ` +
          "— 이름이 바뀌었거나 예외가 낡았습니다(무효 면제 방지 fail-closed).",
      );
    }
    const limit = Number(exception.maxSpreadPx);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(
        `산발 후보 예외 "${exception.name}"에 maxSpreadPx(실측 근거 상한)가 없습니다.`,
      );
    }
    for (const row of rows) limitByStationId.set(row.id, limit);
  }
  return limitByStationId;
}

function assertNoScatteredStationCandidates(candidatesByStation, exemptLimitByStationId) {
  const conflicts = [];
  for (const [stationId, candidates] of candidatesByStation) {
    if (candidates.length < 2) continue;
    let worst = null;
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const distance = Math.hypot(
          candidates[i].x - candidates[j].x,
          candidates[i].y - candidates[j].y,
        );
        if (!worst || distance > worst.distance) {
          worst = { distance, a: candidates[i], b: candidates[j] };
        }
      }
    }
    const limit =
      exemptLimitByStationId.get(stationId) ?? MAX_STATION_CANDIDATE_SPREAD_PX;
    if (worst && worst.distance > limit) {
      conflicts.push(
        `${stationId}: ${worst.distance.toFixed(1)}px (허용 ${limit}px) ` +
          `[${worst.a.svgName}/${worst.a.svgLine || "-"} (${worst.a.x},${worst.a.y})] vs ` +
          `[${worst.b.svgName}/${worst.b.svgLine || "-"} (${worst.b.x},${worst.b.y})]`,
      );
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      "한 역에 허용 상한을 넘게 떨어진 노드가 복수 배정 후보로 잡혔습니다 " +
        `(${conflicts.length}건, 기본 상한 ${MAX_STATION_CANDIDATE_SPREAD_PX}px) ` +
        "— 도식의 역 마커 중복/장식 노드를 확인하세요:\n  " +
        conflicts.join("\n  "),
    );
  }
}

export function buildAssignments(db, extraction, config = SEOUL) {
  const slugToLineId = resolveLineMap(db, config);
  const normalize = computeNormalizer(extraction.stationNodes);
  const labelCenters = labelCenterByName(extraction);
  const excluded = new Set(config.excludedStations ?? []);

  const byStation = new Map(); // stationId -> {stationId,x,y,svgName,svgLine}
  const unresolvedNodes = [];
  // stationId -> 그 역에 배정 후보로 잡힌 모든 노드(채택 여부 무관).
  const candidatesByStation = new Map();

  const assignOne = (stationIds, x, y, svgName, svgLine) => {
    const p = normalize(x, y);
    for (const stationId of stationIds) {
      let candidates = candidatesByStation.get(stationId);
      if (!candidates) {
        candidates = [];
        candidatesByStation.set(stationId, candidates);
      }
      candidates.push({ x: p.x, y: p.y, svgName, svgLine });
      if (byStation.has(stationId)) continue; // 첫 배정 채택(결정적)
      byStation.set(stationId, { stationId, x: p.x, y: p.y, svgName, svgLine });
    }
  };

  // 1) 노드 마커: 결정적 순서(추출기 안정 정렬)로 순회.
  for (const node of extraction.stationNodes) {
    if (excluded.has(node.dataStation)) continue; // 범례 등 비역 노드
    // 권역 nodeFilter(선택): 도식이 카탈로그 밖 노선/미개통 노드까지 그리는 경우
    // (대전 2호선·충청권 광역철도·미개통 라벨) 그 노드를 정합 대상에서 배제한다.
    // 정의되지 않은 권역(수도권·부산·대구)에는 영향이 없다.
    if (config.nodeFilter && !config.nodeFilter(node)) continue;
    const slug = node.dataLine || config.missingLineHint[node.dataStation] || "";
    const lineId = slug ? slugToLineId.get(slug) : null;
    const canon = config.canonicalRules(node.dataStation);
    const ids = resolveStationIds(db, canon.name, lineId, {
      disambiguateByLine: canon.disambiguateByLine === true,
      config,
    });
    if (ids.length === 0) {
      unresolvedNodes.push({ ...node, reason: `역 "${canon.name}"(노선 ${slug || "빈값"}) 미해소` });
      continue;
    }
    assignOne(ids, node.x, node.y, node.dataStation, slug);
  }

  // 2) 라벨 대체: 마커 없는 역을 라벨 중심으로 배정(도식 누락 보정).
  for (const name of config.markerlessFallback) {
    const center = labelCenters.get(name);
    if (!center) continue;
    const ids = resolveStationIds(db, name, null, { config });
    if (ids.length === 0) continue;
    assignOne(ids, center.x, center.y, name, "label-fallback");
  }

  // 명시 예외(권역 config): 도식이 각자 그린 두 노드가 같은 station_id로 몰리는
  // **알려진 선재 결함만** 면제한다. 예외는 이름으로 선언하고 여기서 권역 한정으로
  // id를 해소하며, 각 예외가 pin한 실측 상한을 넘으면 그 역도 다시 실패한다.
  assertNoScatteredStationCandidates(
    candidatesByStation,
    resolveScatteredCandidateExemptions(db, config),
  );
  return { assignments: [...byStation.values()], unresolvedNodes };
}

// 도식 미수록이지만 카탈로그에는 유지되는 명시 예외(수도권 기본값 — 도라산).
export const TOPOLOGY_EXCEPTIONS = SEOUL.topologyExceptions;

export function reconcile(db, assignments, config = SEOUL) {
  const packRows = db
    .prepare(
      `SELECT rmp.station_id AS stationId, rmp.line_id AS lineId, s.name_ko AS nameKo
       FROM route_map_positions rmp JOIN stations s ON s.id = rmp.station_id
       WHERE rmp.region = ?`,
    )
    .all(config.regionKey);
  const assignedStations = new Set(assignments.map((a) => a.stationId));
  const exceptionNames = new Set(config.topologyExceptions.map((e) => e.name));

  const unmappedPackRows = [];
  for (const row of packRows) {
    if (assignedStations.has(row.stationId)) continue;
    if (exceptionNames.has(row.nameKo)) continue; // 명시 예외(수도권 도라산)
    unmappedPackRows.push(row);
  }
  // 권역 카탈로그 역 수(배정과 별도 축): 권역 노선(lines.name_ko LIKE '<prefix> %')에
  // 걸린 distinct 역에서 명시 예외·제외역을 뺀 수. nodeFilter가 (버그 등으로) 전 노드를
  // 배제하면 assignments가 비고 unresolvedNodes도 0이라 미매핑 게이트를 공허 통과할 수
  // 있다. 이 카탈로그 대비 배정 게이트가 그 축을 별도로 막는다.
  const excluded = new Set(config.excludedStations ?? []);
  const catalogStationIds = new Set(
    db
      .prepare(
        `SELECT DISTINCT sl.station_id AS stationId, s.name_ko AS nameKo
         FROM station_lines sl
         JOIN lines l ON l.id = sl.line_id
         JOIN stations s ON s.id = sl.station_id
         WHERE l.name_ko LIKE ?`,
      )
      .all(`${config.lineNamePrefix} %`)
      .filter((r) => !exceptionNames.has(r.nameKo) && !excluded.has(r.nameKo))
      .map((r) => r.stationId),
  );
  const catalogStationCount = catalogStationIds.size;

  const packStations = new Set(packRows.map((r) => r.stationId));
  // 팩 rmp에 없는 배정 = 카탈로그에는 있으나 좌표행이 없는 역. 권역 station_lines가
  // 있으면 신규 rmp 행 대상(#1954 검단연장·원종). 그 외는 정합 오류.
  const insertable = [];
  const trulyOrphan = [];
  for (const a of assignments) {
    if (packStations.has(a.stationId)) continue;
    const regionalLines = db
      .prepare(
        `SELECT sl.line_id AS lineId FROM station_lines sl JOIN lines l ON l.id=sl.line_id
         WHERE sl.station_id=? AND l.name_ko LIKE ?`,
      )
      .all(a.stationId, `${config.lineNamePrefix} %`);
    if (regionalLines.length > 0) {
      insertable.push({ ...a, lineIds: regionalLines.map((r) => r.lineId) });
    } else {
      trulyOrphan.push(a);
    }
  }
  // 카탈로그 역 중 배정 안 된 역(nodeFilter 공허 통과·과잉 배제 탐지용).
  const unassignedCatalogStations = [...catalogStationIds].filter(
    (id) => !assignedStations.has(id),
  );
  return {
    packRowCount: packRows.length,
    assignedStationCount: assignments.length,
    catalogStationCount,
    unassignedCatalogCount: unassignedCatalogStations.length,
    unmappedPackRows,
    insertableAssignments: insertable,
    orphanAssignments: trulyOrphan,
    exceptions: config.topologyExceptions,
  };
}

const APPLY_NOW = "2026-07-11T00:00:00.000Z";

export function applyAssignments(db, assignments, insertableAssignments = [], config = SEOUL) {
  // 한 역의 모든 노선 행에 그 역의 도식 좌표를 적용(환승역 단일 dot 수렴).
  const update = db.prepare(
    `UPDATE route_map_positions
     SET x = ?, y = ?,
         label_dx = 0, label_dy = 0, label_polygon = '', up_path = '', down_path = '',
         source_id = ?, source_name = ?, source_url = ?, license = ?,
         license_status = ?, commercial_use_allowed = ?, attribution_required = ?,
         updated_at = ?
     WHERE region = ? AND station_id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO route_map_positions
       (station_id, line_id, region, x, y, label_dx, label_dy, label_polygon,
        up_path, down_path, source_id, source_name, source_url, license,
        license_status, commercial_use_allowed, attribution_required, reviewed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, '', '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const src = config.svgSource;
  db.exec("BEGIN");
  try {
    for (const a of assignments) {
      update.run(
        a.x, a.y,
        src.sourceId, src.sourceName, src.sourceUrl, src.license,
        src.licenseStatus, src.commercialUseAllowed ? 1 : 0,
        src.attributionRequired ? 1 : 0, APPLY_NOW,
        config.regionKey, a.stationId,
      );
    }
    for (const a of insertableAssignments) {
      for (const lineId of a.lineIds) {
        insert.run(
          a.stationId, lineId, config.regionKey, a.x, a.y,
          src.sourceId, src.sourceName, src.sourceUrl, src.license,
          src.licenseStatus, src.commercialUseAllowed ? 1 : 0,
          src.attributionRequired ? 1 : 0, APPLY_NOW, APPLY_NOW,
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parseArgs(argv) {
  const o = {
    extraction: null,
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    index: "apps/mobile/assets/datapacks/index.json",
    region: "seoul",
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--extraction": o.extraction = argv[++i]; break;
      case "--pack": o.pack = argv[++i]; break;
      case "--index": o.index = argv[++i]; break;
      case "--region": o.region = argv[++i]; break;
      case "--check": o.check = true; break;
      case "--help": case "-h":
        console.log("Usage: apply-sma-svg-positions.mjs --extraction <json> [--region seoul|busan|<regionKey>] [--pack ..] [--index ..] [--check]");
        process.exit(0);
    }
  }
  if (!o.extraction) throw new Error("--extraction <geometry json> is required");
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const config = getRegionConfig(o.region);
  const extraction = JSON.parse(await readFile(path.resolve(o.extraction), "utf8"));
  if (!Array.isArray(extraction.stationNodes) || extraction.stationNodes.length === 0) {
    throw new Error("extraction JSON에 stationNodes가 없음 — extractor v3 출력을 쓰세요");
  }
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "apply-sma-");
  try {
    const { assignments, unresolvedNodes } = buildAssignments(db, extraction, config);
    const summary = reconcile(db, assignments, config);
    const report = {
      region: config.regionKey,
      svgNodeCount: extraction.stationNodes.length,
      assignedStationCount: assignments.length,
      catalogStationCount: summary.catalogStationCount,
      unassignedCatalogCount: summary.unassignedCatalogCount,
      unresolvedNodeCount: unresolvedNodes.length,
      unresolvedNodes: unresolvedNodes.slice(0, 20),
      packRowCount: summary.packRowCount,
      unmappedPackRowCount: summary.unmappedPackRows.length,
      unmappedPackRows: summary.unmappedPackRows.slice(0, 20),
      insertableStationCount: summary.insertableAssignments.length,
      insertableStations: summary.insertableAssignments.map((a) => ({ svgName: a.svgName, lineCount: a.lineIds.length })),
      orphanAssignmentCount: summary.orphanAssignments.length,
      orphanAssignments: summary.orphanAssignments.slice(0, 20).map((a) => ({ svgName: a.svgName, svgLine: a.svgLine })),
      topologyExceptions: summary.exceptions,
    };
    console.log(JSON.stringify(report, null, 2));

    // nodeFilter 공허 통과 방지(미매핑 0 게이트와 별도 축): nodeFilter를 쓰는 권역
    // (대전·광주)은 필터가 (버그 등으로) 전 노드를 배제해도 unresolved 0으로 통과할 수
    // 있다 — 배정이 비면 미매핑 게이트가 잡지만, 이 카탈로그 대조 게이트가 그 축을
    // 독립적으로 막는다. 카탈로그 역(명시 예외·제외역 제외)이 하나라도 미배정이면 실패.
    if (config.nodeFilter && summary.catalogStationCount > 0 && summary.unassignedCatalogCount > 0) {
      throw new Error(
        `카탈로그 역 ${summary.unassignedCatalogCount}/${summary.catalogStationCount}건 미배정(예외·제외 제외) — nodeFilter 공허/과잉 배제 의심`,
      );
    }
    if (unresolvedNodes.length > 0) {
      throw new Error(`미해소 SVG 노드 ${unresolvedNodes.length}건 — 매핑 규칙 확인`);
    }
    if (summary.unmappedPackRows.length > 0) {
      throw new Error(`미매핑 팩 행 ${summary.unmappedPackRows.length}건(위상 예외 제외) — 미매핑 0 실패`);
    }
    if (summary.orphanAssignments.length > 0) {
      throw new Error(`카탈로그에 ${config.lineNamePrefix} 노선 없는 SVG 배정 ${summary.orphanAssignments.length}건 — 정합 확인`);
    }

    if (o.check) {
      console.log("(--check) 검증만 수행, 팩 미기록");
      return;
    }
    applyAssignments(db, assignments, summary.insertableAssignments, config);
    assertReferentialIntegrity(db);
    db.close();
    const { byteSize } = writePack({ sqlitePath, packPath, packRelPath: o.pack, indexRelPath: o.index });
    console.log(`팩 갱신: route_map_positions ${assignments.length}행 좌표 교체 (byteSize ${byteSize})`);
  } finally {
    cleanupPackDir(dir);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
