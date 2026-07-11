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

export const REGION = "수도권";
export const SVG_SOURCE = {
  sourceId: "owner-self-drawn-sma-schematic",
  sourceName: "오너 자작 수도권 8선형 정본 도식",
  // 앱 렌더 정본은 SVG 원본이 아니라 이 도식에서 파생한 구조화 좌표다(#1635 유지).
  sourceUrl: "internal:route-map/route-map-defs/svg-sources/easy-subway-sma-v1.svg",
  license: "self-drawn",
  licenseStatus: "confirmed",
  commercialUseAllowed: true,
  attributionRequired: false,
};

// SVG data-line 슬러그 → canonical lines.name_ko 접미(수도권 <접미>).
export const LINE_SLUG_TO_SUFFIX = {
  "1": "1호선", "2": "2호선", "3": "3호선", "4": "4호선", "5": "5호선",
  "6": "6호선", "7": "7호선", "8": "8호선", "9": "9호선",
  "airport-railroad": "공항",
  "gyeongui-jungang": "경의중앙",
  "gyeongchun": "경춘",
  "suin-bundang": "수인분당",
  "shinbundang": "신분당",
  "gyeonggang": "경강",
  "seohae": "서해선",
  "incheon-1": "인천1호선",
  "incheon-2": "인천2호선",
  "uijeongbu-lrt": "의정부",
  "everline": "에버라인",
  "ui-sinseol": "우이신설",
  "gimpo-goldline": "김포골드라인",
  "sillim": "신림선",
  "gtx-a": "GTX-A",
};

// data-line 없는 노드(SVG 소스 누락)의 노선 보정 — station→line 멤버십으로 확정 가능.
// 영종·운서·청라국제도시는 공항철도 전용역이다.
export const MISSING_LINE_STATION_HINT = {
  "영종": "airport-railroad",
  "운서": "airport-railroad",
  "청라국제도시": "airport-railroad",
};

// canonical 정합 규칙 8건(#1950 대조표). 반환: {name, byLineSuffix?} — byLineSuffix가
// 있으면 동명이역을 노선으로 disambiguate.
export function canonicalStationName(svgName) {
  // 콜론 동명이역: "신촌:2호선"/"양평:경의중앙선" → 이름은 콜론 앞, 노선으로 구분.
  const colon = svgName.indexOf(":");
  if (colon >= 0) {
    return { name: svgName.slice(0, colon), disambiguateByLine: true };
  }
  if (svgName === "하남검단산") return { name: "하남검단산역" };
  if (svgName === "이수") return { name: "총신대입구" }; // 이수↔총신대입구 별칭
  return { name: svgName };
}

function suffixFromLineName(nameKo) {
  return nameKo.startsWith(`${REGION} `) ? nameKo.slice(REGION.length + 1) : nameKo;
}

export function resolveLineMap(db) {
  const rows = db.prepare("SELECT id, name_ko FROM lines WHERE name_ko LIKE ?").all(`${REGION}%`);
  const bySuffix = new Map();
  for (const row of rows) bySuffix.set(suffixFromLineName(row.name_ko), row.id);
  const slugToId = new Map();
  for (const [slug, suffix] of Object.entries(LINE_SLUG_TO_SUFFIX)) {
    const id = bySuffix.get(suffix);
    if (!id) throw new Error(`슬러그 ${slug} → "${REGION} ${suffix}" 노선을 카탈로그에서 못 찾음`);
    slugToId.set(slug, id);
  }
  return slugToId;
}

// 이름으로 station_id 후보를 확정한다. 반환은 배열(대개 1개).
//  - 유일 → [id]
//  - 노선 힌트(콜론 동명이역)로 유일 해소 → [id]
//  - 힌트 없이 수도권 후보가 여럿 → 전부 반환(오분리된 한 물리역의 여러 id).
//    도식은 이런 역을 단일 dot으로 그리므로 모든 id에 같은 좌표를 준다.
export function resolveStationIds(db, name, lineId, { disambiguateByLine = false } = {}) {
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
  // 그 외 동명(콜론 아님): 오분리된 한 물리역이므로 수도권 노선 멤버 후보 전부에
  // 같은 좌표를 broadcast한다(상봉·석남·이매: 7호선 id와 타 노선 id가 별개 행).
  const capital = rows.filter((r) =>
    db
      .prepare(
        `SELECT 1 FROM station_lines sl JOIN lines l ON l.id=sl.line_id
         WHERE sl.station_id=? AND l.name_ko LIKE ? LIMIT 1`,
      )
      .get(r.id, `${REGION} %`),
  );
  return capital.map((r) => r.id);
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
// 4호선/수인분당 안산선 꼬리 역들 — v1 도식이 라벨만 두고 dot을 뺐다.
export const MARKERLESS_STATION_FALLBACK = ["안산", "고잔", "신길온천", "오이도", "중앙"];

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

export function buildAssignments(db, extraction) {
  const slugToLineId = resolveLineMap(db);
  const normalize = computeNormalizer(extraction.stationNodes);
  const labelCenters = labelCenterByName(extraction);

  const byStation = new Map(); // stationId -> {stationId,x,y,svgName,svgLine}
  const unresolvedNodes = [];

  const assignOne = (stationIds, x, y, svgName, svgLine) => {
    for (const stationId of stationIds) {
      if (byStation.has(stationId)) continue; // 첫 배정 채택(결정적)
      const p = normalize(x, y);
      byStation.set(stationId, { stationId, x: p.x, y: p.y, svgName, svgLine });
    }
  };

  // 1) 노드 마커: 결정적 순서(추출기 안정 정렬)로 순회.
  for (const node of extraction.stationNodes) {
    const slug = node.dataLine || MISSING_LINE_STATION_HINT[node.dataStation] || "";
    const lineId = slug ? slugToLineId.get(slug) : null;
    const canon = canonicalStationName(node.dataStation);
    const ids = resolveStationIds(db, canon.name, lineId, {
      disambiguateByLine: canon.disambiguateByLine === true,
    });
    if (ids.length === 0) {
      unresolvedNodes.push({ ...node, reason: `역 "${canon.name}"(노선 ${slug || "빈값"}) 미해소` });
      continue;
    }
    assignOne(ids, node.x, node.y, node.dataStation, slug);
  }

  // 2) 라벨 대체: 마커 없는 역을 라벨 중심으로 배정(도식 누락 보정).
  for (const name of MARKERLESS_STATION_FALLBACK) {
    const center = labelCenters.get(name);
    if (!center) continue;
    const ids = resolveStationIds(db, name, null);
    if (ids.length === 0) continue;
    assignOne(ids, center.x, center.y, name, "label-fallback");
  }

  return { assignments: [...byStation.values()], unresolvedNodes };
}

// 도식 미수록이지만 카탈로그에는 유지되는 명시 예외(위상 보존 게이트).
export const TOPOLOGY_EXCEPTIONS = [
  { name: "도라산", reason: "오너 도식이 임진강까지 수록·도라산 제외(설계 결정). 카탈로그 유지(역 검색 가능)." },
];

export function reconcile(db, assignments) {
  const packRows = db
    .prepare(
      `SELECT rmp.station_id AS stationId, rmp.line_id AS lineId, s.name_ko AS nameKo
       FROM route_map_positions rmp JOIN stations s ON s.id = rmp.station_id
       WHERE rmp.region = ?`,
    )
    .all(REGION);
  const assignedStations = new Set(assignments.map((a) => a.stationId));
  const exceptionNames = new Set(TOPOLOGY_EXCEPTIONS.map((e) => e.name));

  const unmappedPackRows = [];
  for (const row of packRows) {
    if (assignedStations.has(row.stationId)) continue;
    if (exceptionNames.has(row.nameKo)) continue; // 명시 예외(도라산)
    unmappedPackRows.push(row);
  }
  const packStations = new Set(packRows.map((r) => r.stationId));
  // 팩 rmp에 없는 배정 = 카탈로그에는 있으나 좌표행이 없는 역. 수도권 station_lines가
  // 있으면 신규 rmp 행 대상(#1954 검단연장·원종). 그 외는 정합 오류.
  const insertable = [];
  const trulyOrphan = [];
  for (const a of assignments) {
    if (packStations.has(a.stationId)) continue;
    const capitalLines = db
      .prepare(
        `SELECT sl.line_id AS lineId FROM station_lines sl JOIN lines l ON l.id=sl.line_id
         WHERE sl.station_id=? AND l.name_ko LIKE ?`,
      )
      .all(a.stationId, `${REGION} %`);
    if (capitalLines.length > 0) {
      insertable.push({ ...a, lineIds: capitalLines.map((r) => r.lineId) });
    } else {
      trulyOrphan.push(a);
    }
  }
  return {
    packRowCount: packRows.length,
    assignedStationCount: assignments.length,
    unmappedPackRows,
    insertableAssignments: insertable,
    orphanAssignments: trulyOrphan,
    exceptions: TOPOLOGY_EXCEPTIONS,
  };
}

const APPLY_NOW = "2026-07-11T00:00:00.000Z";

export function applyAssignments(db, assignments, insertableAssignments = []) {
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
  const src = SVG_SOURCE;
  db.exec("BEGIN");
  try {
    for (const a of assignments) {
      update.run(
        a.x, a.y,
        src.sourceId, src.sourceName, src.sourceUrl, src.license,
        src.licenseStatus, src.commercialUseAllowed ? 1 : 0,
        src.attributionRequired ? 1 : 0, APPLY_NOW,
        REGION, a.stationId,
      );
    }
    for (const a of insertableAssignments) {
      for (const lineId of a.lineIds) {
        insert.run(
          a.stationId, lineId, REGION, a.x, a.y,
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
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--extraction": o.extraction = argv[++i]; break;
      case "--pack": o.pack = argv[++i]; break;
      case "--index": o.index = argv[++i]; break;
      case "--check": o.check = true; break;
      case "--help": case "-h":
        console.log("Usage: apply-sma-svg-positions.mjs --extraction <json> [--pack ..] [--index ..] [--check]");
        process.exit(0);
    }
  }
  if (!o.extraction) throw new Error("--extraction <geometry json> is required");
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const extraction = JSON.parse(await readFile(path.resolve(o.extraction), "utf8"));
  if (!Array.isArray(extraction.stationNodes) || extraction.stationNodes.length === 0) {
    throw new Error("extraction JSON에 stationNodes가 없음 — extractor v3 출력을 쓰세요");
  }
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "apply-sma-");
  try {
    const { assignments, unresolvedNodes } = buildAssignments(db, extraction);
    const summary = reconcile(db, assignments);
    const report = {
      region: REGION,
      svgNodeCount: extraction.stationNodes.length,
      assignedStationCount: assignments.length,
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

    if (unresolvedNodes.length > 0) {
      throw new Error(`미해소 SVG 노드 ${unresolvedNodes.length}건 — 매핑 규칙 확인`);
    }
    if (summary.unmappedPackRows.length > 0) {
      throw new Error(`미매핑 팩 행 ${summary.unmappedPackRows.length}건(도라산 예외 제외) — 미매핑 0 실패`);
    }
    if (summary.orphanAssignments.length > 0) {
      throw new Error(`카탈로그에 수도권 노선 없는 SVG 배정 ${summary.orphanAssignments.length}건 — 정합 확인`);
    }

    if (o.check) {
      console.log("(--check) 검증만 수행, 팩 미기록");
      return;
    }
    applyAssignments(db, assignments, summary.insertableAssignments);
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
