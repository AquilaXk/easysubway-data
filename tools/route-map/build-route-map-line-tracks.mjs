#!/usr/bin/env node
// SVG track geometry(extract-svg-geometry v2의 strokes)를 노선별 실제 track
// polyline으로 변환한다. 핵심 통찰:
//
//   1. route_map_positions.x,y는 라벨 위치라 track 위 마커가 아니다 → 역을 track에
//      직접 snap할 수 없다. 대신 track polyline 자체가 이미 실제 노선 모양이므로
//      그대로 노선 geometry로 쓴다(역별 down_path 재생성 불필요).
//   2. SVG stroke 색은 노선의 실제 식별자다(CSS 클래스 = 노선). 색 종류 수 = 노선
//      수이며, 색↔line_id는 완전 1:1이다. greedy 다수결은 환승 밀집/평행 노선에서
//      중복·오류를 내므로, 색×line_id 근접 표수 행렬 위에서 최대가중 완전매칭
//      (Hungarian)으로 전역 최적 1:1 배정을 구한다.
//
// 렌더 색은 여기서 정하지 않는다 — pack lines.color(apply-route-map-line-colors로
// 반영된 공식 색)를 렌더러가 쓴다. 이 스크립트는 track geometry와 색↔line_id
// 매핑만 산출한다.
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile as writeTemp } from "node:fs/promises";
import { tmpdir } from "node:os";

// 역 라벨을 track에 근접 배정할 때의 반경(root px). 라벨은 track에서 20~35px
// 떨어져 있어(폰트 높이 근처) 이보다 크면 이웃 노선까지 삼킨다.
const SNAP_RADIUS = 35;
// 같은 색 track 조각의 끝점이 이 거리(root px) 이내면 한 조각으로 이어 붙인다.
const STITCH_TOLERANCE = 1.5;
// 색 정제: RGB 거리가 이 값 이내인 두 색은 같은 노선의 변종으로 보고 병합한다.
// (대구 3호선 노랑 #fdc30d/#ffc512 = 거리 ≈ 6.)
const MERGE_COLOR_DISTANCE = 24;
// 색 정제: HSV 채도가 이 값 미만이면 무채색(외곽선·테두리·배경)으로 보고 제외 후보.
// 노선색은 최소 0.43(부산 #7189c5)이라 여유가 있다.
const ACHROMATIC_THRESHOLD = 0.2;

function usage() {
  return `Usage: node tools/route-map/build-route-map-line-tracks.mjs --geometry <geom.json> --pack <capital.sqlite[.gz]> --region <name> [--out <tracks.json>] [--check] [--snap-radius <px>] [--stitch-tolerance <px>] [--merge-color-distance <rgb>] [--achromatic-threshold <0-1>]

extract-svg-geometry v2 결과의 노선 track(polyline/path)을 색↔line_id 최적매칭으로
region 노선별 track geometry로 변환한다. --check는 파일을 쓰지 않고 무결성만 검증한다.
`;
}

function parseArgs(argv) {
  const options = {
    geometry: null, pack: null, region: null, out: null, check: false,
    source: "svg-strokes",
    snapRadius: SNAP_RADIUS,
    stitchTolerance: STITCH_TOLERANCE,
    mergeColorDistance: MERGE_COLOR_DISTANCE,
    achromaticThreshold: ACHROMATIC_THRESHOLD,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        return { help: true };
      case "--geometry": options.geometry = argv[++index] ?? null; break;
      case "--pack": options.pack = argv[++index] ?? null; break;
      case "--region": options.region = argv[++index] ?? null; break;
      case "--out": options.out = argv[++index] ?? null; break;
      case "--check": options.check = true; break;
      case "--source": options.source = argv[++index] ?? ""; break;
      case "--snap-radius": options.snapRadius = Number.parseFloat(argv[++index] ?? ""); break;
      case "--stitch-tolerance": options.stitchTolerance = Number.parseFloat(argv[++index] ?? ""); break;
      case "--merge-color-distance": options.mergeColorDistance = Number.parseFloat(argv[++index] ?? ""); break;
      case "--achromatic-threshold": options.achromaticThreshold = Number.parseFloat(argv[++index] ?? ""); break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!["svg-strokes", "pack-down-path"].includes(options.source)) {
    throw new Error(`--source must be svg-strokes or pack-down-path, got: ${options.source}`);
  }
  // pack-down-path(Route B)는 SVG 없이 pack 실측 down_path만 변환하므로 geometry 불요.
  if (options.source === "svg-strokes" && !options.geometry) throw new Error("--geometry is required (source=svg-strokes).");
  if (!options.pack) throw new Error("--pack is required.");
  if (!options.region) throw new Error("--region is required.");
  if (!Number.isFinite(options.snapRadius) || options.snapRadius <= 0) throw new Error("--snap-radius must be a positive number.");
  if (!Number.isFinite(options.stitchTolerance) || options.stitchTolerance <= 0) throw new Error("--stitch-tolerance must be a positive number.");
  if (!Number.isFinite(options.mergeColorDistance) || options.mergeColorDistance < 0) throw new Error("--merge-color-distance must be a non-negative number.");
  if (!Number.isFinite(options.achromaticThreshold) || options.achromaticThreshold < 0) throw new Error("--achromatic-threshold must be a non-negative number.");
  return options;
}

// 점 p에서 선분 ab까지 최단거리.
function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// 역 p에서 track(정점열들의 묶음)까지 최단거리.
function distanceToTracks(p, tracks) {
  let best = Infinity;
  for (const track of tracks) {
    for (let index = 1; index < track.points.length; index += 1) {
      const distance = distanceToSegment(p, track.points[index - 1], track.points[index]);
      if (distance < best) best = distance;
    }
  }
  return best;
}

// 최대가중 완전 이분매칭 (Hungarian, O(n^3)). weight[i][j] 최대화. 정사각 확장.
function maximumWeightMatching(weight, rowCount, columnCount) {
  const n = Math.max(rowCount, columnCount);
  const cost = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => -(weight[i]?.[j] ?? 0)));
  const INF = Number.POSITIVE_INFINITY;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= n; j += 1) {
        if (used[j]) continue;
        const current = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (current < minv[j]) { minv[j] = current; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j += 1) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  // p[j]는 열 j에 매칭된 행. 호출부는 행(색)→열(노선)을 원하므로 뒤집어 반환한다.
  const columnForRow = new Array(rowCount).fill(-1);
  for (let j = 1; j <= n; j += 1) {
    const row = p[j] - 1;
    const column = j - 1;
    if (row >= 0 && row < rowCount && column < columnCount) columnForRow[row] = column;
  }
  return columnForRow;
}

async function openPack(packPath) {
  const resolved = path.resolve(packPath);
  const raw = await readFile(resolved);
  if (resolved.endsWith(".gz")) {
    const tempDir = await mkdtemp(path.join(tmpdir(), "easysubway-line-tracks-"));
    const tempFile = path.join(tempDir, "pack.sqlite");
    await writeTemp(tempFile, gunzipSync(raw));
    return { db: new DatabaseSync(tempFile), tempDir };
  }
  return { db: new DatabaseSync(resolved), tempDir: null };
}

// 0표 노선 down_path 완충에 필요한 station_lines 테이블 + route_map_positions.down_path
// 컬럼이 있는지 확인한다(최소 스키마 테스트 팩에는 없을 수 있다).
function hasDownPathSource(db) {
  const hasStationLines = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'station_lines'")
    .get() != null;
  if (!hasStationLines) return false;
  return db
    .prepare("PRAGMA table_info(route_map_positions)")
    .all()
    .some((column) => column.name === "down_path");
}

function number(value) {
  return Math.round(value * 1000) / 1000;
}

// track 정점열 → "M x y L x y ..." (parseRouteMapPolyline 호환).
function pathString(points) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${number(point.x)} ${number(point.y)}`)
    .join(" ");
}

// 정점열 묶음 → stitching 후 유효 조각만 path 문자열로. svg-strokes/pack-down-path
// 두 소스가 같은 규칙으로 path를 만들도록 공유한다(스키마 드리프트 방지).
function toPaths(pointLists, tolerance) {
  return stitchChains(pointLists.filter((points) => points.length >= 2), tolerance)
    .filter((points) => points.length >= 2)
    .map((points) => pathString(points));
}

// tracks.json의 노선 레코드. 두 소스가 동일 shape를 내도록 공유한다.
// source는 노선 단위 원천 표시(예: SVG track 없는 0표 노선의 down_path 완충)로,
// 지정된 경우에만 포함한다.
function makeLine({ lineId, svgColor, matchVotes, stationCount, paths, source }) {
  const line = { lineId, svgColor, trackCount: paths.length, matchVotes, stationCount, paths };
  if (source) line.source = source;
  return line;
}

// sequence 순 down_path 세그먼트를 끝점 연속이면 이어 붙이고 stitching으로 통합해
// path 문자열 배열로 만든다. Route B와 0표 노선 down_path 완충이 공유한다. 체이닝
// 규칙은 앱 _assemblePolylines(structured_route_map.dart)와 동일.
function chainDownPathSegments(segments, stitchTolerance) {
  const polylines = [];
  let current = null;
  for (const segment of segments) {
    const points = parseAbsolutePolyline(segment);
    if (points.length === 0) continue;
    const tail = current?.[current.length - 1];
    if (current && tail.x === points[0].x && tail.y === points[0].y) {
      current.push(...points.slice(1));
    } else {
      current = [...points];
      polylines.push(current);
    }
  }
  return toPaths(polylines, stitchTolerance);
}

// "#rrggbb" → [r, g, b].
function rgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

// HSV 채도(0=무채색). 외곽선·테두리·배경 같은 비노선 색을 가려낸다.
function saturation(hex) {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function colorDistance(a, b) {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

// 두 정점열을 끝점이 tolerance 이내면 (방향 4조합 시도) 이어 붙인다. 아니면 null.
function joinChains(a, b, tolerance) {
  const close = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) <= tolerance;
  if (close(a[a.length - 1], b[0])) return [...a, ...b.slice(1)];
  if (close(b[b.length - 1], a[0])) return [...b, ...a.slice(1)];
  if (close(a[a.length - 1], b[b.length - 1])) return [...a, ...[...b].reverse().slice(1)];
  if (close(a[0], b[0])) return [...[...a].reverse(), ...b.slice(1)];
  return null;
}

// 같은 색 조각들을 끝점 tolerance로 이어 붙인다. 조각 수가 작아 반복 병합 O(n²)로 충분.
function stitchChains(pointLists, tolerance) {
  const chains = pointLists.map((points) => [...points]);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < chains.length; i += 1) {
      for (let j = i + 1; j < chains.length; j += 1) {
        const joined = joinChains(chains[i], chains[j], tolerance);
        if (joined) {
          chains[i] = joined;
          chains.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return chains;
}

// 색 정제: 색 수 > 노선 수일 때만 발동. (1) 유사색 병합 (2) 무채색 최저표 제외
// (3) 최저표 제외. 색 수 = 노선 수면 그대로 둔다(수도권 회색 노선 #797979 보존).
// items: [{ color, tracks: stroke[], weightRow: number[] }], weightRow는 색×line 표.
function refineColors(items, lineCount, { mergeDistance, achromaticThreshold }) {
  const report = { originalColorCount: items.length, merged: [], dropped: [] };
  const rowSum = (item) => item.weightRow.reduce((sum, value) => sum + value, 0);
  let guard = items.length * 2;
  while (items.length > lineCount && guard-- > 0) {
    // 1. 가장 가까운 유사색 쌍 병합 (표 많은 쪽을 대표색으로).
    let bestPair = null;
    let bestDistance = Infinity;
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const distance = colorDistance(items[i].color, items[j].color);
        if (distance <= mergeDistance && distance < bestDistance) {
          bestDistance = distance;
          bestPair = [i, j];
        }
      }
    }
    if (bestPair) {
      const [i, j] = bestPair;
      const keep = rowSum(items[i]) >= rowSum(items[j]) ? i : j;
      const drop = keep === i ? j : i;
      report.merged.push([items[keep].color, items[drop].color]);
      items[keep].tracks.push(...items[drop].tracks);
      items[keep].weightRow = items[keep].weightRow.map((value, index) => value + items[drop].weightRow[index]);
      items.splice(drop, 1);
      continue;
    }
    // 2. 무채색 중 최저표 제외. 없으면 3. 전체 최저표 제외(경고는 호출부에서).
    const achromatic = items.filter((item) => saturation(item.color) < achromaticThreshold);
    const pool = achromatic.length > 0 ? achromatic : items;
    let victim = pool[0];
    for (const item of pool) if (rowSum(item) < rowSum(victim)) victim = item;
    report.dropped.push({ color: victim.color, achromatic: saturation(victim.color) < achromaticThreshold, votes: rowSum(victim) });
    items.splice(items.indexOf(victim), 1);
  }
  return report;
}

async function buildLineTracks({ geometry, pack, region, snapRadius, stitchTolerance, mergeColorDistance, achromaticThreshold }) {
  const geom = JSON.parse(await readFile(path.resolve(geometry), "utf8"));
  const strokes = (geom.strokes ?? []).filter((stroke) => stroke.tag !== "line" && !stroke.dashed);
  if (strokes.length === 0) throw new Error("geometry에 노선 track(polyline/path stroke)이 없다. extract-svg-geometry v2 결과인지 확인.");

  const { db, tempDir } = await openPack(pack);
  let stations;
  const downPathSegmentsByLine = new Map();
  try {
    stations = db
      .prepare("SELECT station_id, line_id, x, y FROM route_map_positions WHERE region = ?")
      .all(region)
      .map((row) => ({ lineId: row.line_id, x: row.x, y: row.y }));
    // SVG track이 없는 0표 노선을 pack 실측 down_path로 완충하기 위한 세그먼트.
    // station_lines(line_sequence)와 down_path 컬럼이 있는 실팩에서만 로드한다.
    if (hasDownPathSource(db)) {
      for (const row of db
        .prepare(
          `SELECT rmp.line_id AS lineId, rmp.down_path AS downPath
           FROM route_map_positions rmp
           JOIN station_lines sl ON sl.station_id = rmp.station_id AND sl.line_id = rmp.line_id
           WHERE rmp.region = ?
           ORDER BY rmp.line_id, sl.line_sequence, rmp.station_id`,
        )
        .all(region)) {
        if (!downPathSegmentsByLine.has(row.lineId)) downPathSegmentsByLine.set(row.lineId, []);
        downPathSegmentsByLine.get(row.lineId).push(row.downPath ?? "");
      }
    }
  } finally {
    db.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
  if (stations.length === 0) throw new Error(`region '${region}'의 route_map_positions가 비어 있다.`);

  // 색별 track 묶음.
  const tracksByColor = new Map();
  for (const stroke of strokes) {
    if (!tracksByColor.has(stroke.stroke)) tracksByColor.set(stroke.stroke, []);
    tracksByColor.get(stroke.stroke).push(stroke);
  }
  const colors = [...tracksByColor.keys()];
  const lineIds = [...new Set(stations.map((station) => station.lineId))];
  const lineIndex = new Map(lineIds.map((id, index) => [id, index]));

  // 색×line_id 근접 표수 + 좌표계 검증용 근접 역 수: 각 역을 "가장 가까운 색"에
  // 투표(snapRadius 이내일 때만). votedStations는 어떤 색에든 배정된 역 = 근접률.
  const weight = colors.map(() => new Array(lineIds.length).fill(0));
  let votedStations = 0;
  for (const station of stations) {
    let bestColor = -1;
    let bestDistance = Infinity;
    colors.forEach((color, colorIndex) => {
      const distance = distanceToTracks(station, tracksByColor.get(color));
      if (distance < bestDistance) { bestDistance = distance; bestColor = colorIndex; }
    });
    if (bestColor >= 0 && bestDistance <= snapRadius) {
      weight[bestColor][lineIndex.get(station.lineId)] += 1;
      votedStations += 1;
    }
  }
  const stationProximityRatio = Math.round((votedStations / stations.length) * 1000) / 1000;

  // 색 정제: 색 수 > 노선 수면 유사색 병합·무채색 제외로 색=노선을 성립시킨다.
  const items = colors.map((color, colorIndex) => ({
    color,
    tracks: tracksByColor.get(color),
    weightRow: weight[colorIndex],
  }));
  const refinement = refineColors(items, lineIds.length, {
    mergeDistance: mergeColorDistance,
    achromaticThreshold,
  });

  // 정제된 색으로 전역 최적 1:1 매칭.
  const refinedColors = items.map((item) => item.color);
  const refinedWeight = items.map((item) => item.weightRow);
  const lineForColor = maximumWeightMatching(refinedWeight, refinedColors.length, lineIds.length);
  const stationCountByLine = new Map();
  for (const station of stations) stationCountByLine.set(station.lineId, (stationCountByLine.get(station.lineId) ?? 0) + 1);

  const lines = [];
  const warnings = [];
  const colorToLineId = {};
  for (const dropped of refinement.dropped) {
    if (!dropped.achromatic) warnings.push(`색 ${dropped.color}: 색>노선 초과분으로 제외(표 ${dropped.votes}, 무채색 아님). 검수 필요.`);
  }
  items.forEach((item, colorIndex) => {
    const matchedLineIndex = lineForColor[colorIndex];
    const lineId = matchedLineIndex >= 0 ? lineIds[matchedLineIndex] : null;
    const votes = matchedLineIndex >= 0 ? item.weightRow[matchedLineIndex] : 0;
    const bestVotes = Math.max(0, ...item.weightRow);
    if (!lineId) {
      warnings.push(`색 ${item.color}: 매칭된 노선 없음(track ${item.tracks.length}개).`);
      return;
    }
    // 0표(소거법 배정)이고 pack 실측 down_path가 있으면, 신뢰할 수 없는 SVG 고아
    // 색 대신 down_path를 track으로 완충한다(Route B 로직 재사용). 고아 색은 방출하지
    // 않으므로 colorToLineId에 남기지 않는다. 예: 수도권 우이신설(SVG에 연결 track 없이
    // 역 틱마크만 존재해 minStrokeLength로 전량 배제됨).
    if (votes === 0) {
      const filledPaths = chainDownPathSegments(
        downPathSegmentsByLine.get(lineId) ?? [],
        stitchTolerance,
      );
      if (filledPaths.length > 0) {
        warnings.push(`색 ${item.color} → ${lineId}: 근접 역 0표 — SVG 고아 색 폐기, down_path 완충 적용.`);
        lines.push(makeLine({
          lineId,
          svgColor: "",
          matchVotes: null,
          stationCount: stationCountByLine.get(lineId) ?? 0,
          paths: filledPaths,
          source: "pack-down-path",
        }));
        return;
      }
      warnings.push(`색 ${item.color} → ${lineId}: 근접 역 0표(소거법 배정). 위치 검수 필요.`);
    } else if (votes !== bestVotes) {
      warnings.push(`색 ${item.color} → ${lineId}: 최적매칭 표(${votes})가 국소 최다표(${bestVotes})와 다름.`);
    }
    colorToLineId[item.color] = lineId;
    const paths = toPaths(item.tracks.map((track) => track.points), stitchTolerance);
    lines.push(makeLine({
      lineId,
      svgColor: item.color,
      matchVotes: votes,
      stationCount: stationCountByLine.get(lineId) ?? 0,
      paths,
    }));
  });

  // 미매칭 노선(track 색이 배정되지 않은 line_id).
  const matchedLineIds = new Set(lines.map((line) => line.lineId));
  const unmatchedLines = lineIds.filter((id) => !matchedLineIds.has(id));
  for (const id of unmatchedLines) warnings.push(`노선 ${id}: 대응 track 색 없음.`);

  return {
    schemaVersion: 1,
    region,
    source: "svg-strokes",
    snapRadius,
    stitchTolerance,
    stationProximityRatio,
    sourceExtractorVersion: geom.extractorVersion ?? null,
    colorCount: refinedColors.length,
    lineCount: lineIds.length,
    refinement,
    colorToLineId,
    lines: lines.sort((a, b) => a.lineId.localeCompare(b.lineId)),
    warnings,
  };
}

// "M x y L x y ..." 절대좌표 path를 정점 목록으로 파싱(parseRouteMapPolyline과 동일 규칙).
function parseAbsolutePolyline(pathText) {
  const numbers = (pathText.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const points = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return points;
}

// Route B: pack 실측 down_path를 sequence 순으로 체이닝해 동일 tracks.json 스키마로
// 변환한다. 렌더러는 SVG track과 구분하지 않고 소비한다(무음 fallback 아님 —
// track 원천이 명시적으로 pack-down-path일 뿐). 체이닝 규칙은 앱
// _assemblePolylines(structured_route_map.dart)와 동일: 끝점=시작점이면 잇고 아니면 끊는다.
async function buildLineTracksFromDownPath({ pack, region, stitchTolerance }) {
  const { db, tempDir } = await openPack(pack);
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT rmp.line_id AS lineId, rmp.down_path AS downPath
         FROM route_map_positions rmp
         JOIN station_lines sl ON sl.station_id = rmp.station_id AND sl.line_id = rmp.line_id
         WHERE rmp.region = ?
         ORDER BY rmp.line_id, sl.line_sequence, rmp.station_id`,
      )
      .all(region);
  } finally {
    db.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
  if (rows.length === 0) throw new Error(`region '${region}'의 route_map_positions가 비어 있다.`);

  const segmentsByLine = new Map();
  const stationCountByLine = new Map();
  for (const row of rows) {
    if (!segmentsByLine.has(row.lineId)) segmentsByLine.set(row.lineId, []);
    segmentsByLine.get(row.lineId).push(row.downPath ?? "");
    stationCountByLine.set(row.lineId, (stationCountByLine.get(row.lineId) ?? 0) + 1);
  }

  const lines = [];
  const warnings = [];
  const orderedLineIds = [...segmentsByLine.keys()].sort((a, b) => a.localeCompare(b));
  for (const lineId of orderedLineIds) {
    const paths = chainDownPathSegments(segmentsByLine.get(lineId), stitchTolerance);
    if (paths.length === 0) warnings.push(`노선 ${lineId}: down_path 세그먼트가 없어 빈 track.`);
    lines.push(makeLine({
      lineId,
      svgColor: "",
      matchVotes: null,
      stationCount: stationCountByLine.get(lineId) ?? 0,
      paths,
    }));
  }

  return {
    schemaVersion: 1,
    region,
    source: "pack-down-path",
    stitchTolerance,
    stationProximityRatio: null,
    colorCount: null,
    lineCount: segmentsByLine.size,
    refinement: null,
    lines,
    warnings,
  };
}

function assertIntegrity(result) {
  const problems = [];
  // 색↔노선 전제는 SVG stroke 원천에만 적용(Route B는 색이 없다).
  if (result.source === "svg-strokes" && result.colorCount !== result.lineCount) {
    problems.push(`track 색 수(${result.colorCount}) ≠ 노선 수(${result.lineCount}) — 색이 노선 식별자라는 전제 위반.`);
  }
  const emptyPaths = result.lines.filter((line) => line.trackCount === 0);
  if (emptyPaths.length > 0) {
    problems.push(`track path가 비어 있는 노선 ${emptyPaths.length}개: ${emptyPaths.map((line) => line.lineId).join(", ")}`);
  }
  // 0표(소거법 배정) 노선은 track이 존재하므로 무음 fallback이 아니다. BLOCKER가 아닌
  // 수동 검수 대상(audit LINE_TRACKS_ZERO_VOTE=HIGH)이며 warnings로 이미 노출된다.
  // 색≠노선/빈 path만 build --check의 차단 사유로 둔다.
  return problems;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = options.source === "pack-down-path"
    ? await buildLineTracksFromDownPath(options)
    : await buildLineTracks(options);
  const problems = assertIntegrity(result);

  if (result.source === "pack-down-path") {
    process.stderr.write(`[${result.region}] (down_path 변환) 노선 ${result.lineCount} · track 노선 ${result.lines.length} · 경고 ${result.warnings.length}\n`);
  } else {
    process.stderr.write(`[${result.region}] 색 ${result.colorCount}(원본 ${result.refinement.originalColorCount}) / 노선 ${result.lineCount} · track 노선 ${result.lines.length} · 근접률 ${result.stationProximityRatio} · 경고 ${result.warnings.length}\n`);
    if (result.refinement.merged.length > 0) process.stderr.write(`  ↳ 병합 ${result.refinement.merged.map((pair) => pair.join("←")).join(", ")}\n`);
    if (result.refinement.dropped.length > 0) process.stderr.write(`  ↳ 제외 ${result.refinement.dropped.map((drop) => `${drop.color}${drop.achromatic ? "(무채색)" : ""}`).join(", ")}\n`);
  }
  for (const warning of result.warnings) process.stderr.write(`  ⚠ ${warning}\n`);

  if (options.check) {
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write("  ✓ 무결성 통과\n");
    return;
  }

  const output = JSON.stringify(result, null, 2);
  if (options.out) {
    await writeFile(path.resolve(options.out), `${output}\n`);
    process.stderr.write(`  → ${options.out}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
