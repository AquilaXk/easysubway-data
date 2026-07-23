#!/usr/bin/env node
// #1789 Phase 1 (P1.1): capital 팩의 역 인접 위상 그래프를 LOOM octi 입력 GeoJSON으로
// 내보낸다. LOOM 입력 = Point(node: id, deg) + LineString(edge: from/to node id, lines[]).
// 역=node(환승은 centroid로 1개 병합), 인접역(line_sequence 연속)=edge. octi가 이 그래프를
// octilinear 그리드에 재배치 → 간선 길이 정규화(지리밀도 → 균일 간격).
//
// ⚠️ 입력 좌표는 위상 정합용 준지리형 근사면 충분하다(octi가 재배치하므로 좌표 자체는
// 버려짐 — 사용자 CSV 아님, 라이선스 무관). P0에서 정비된 환승 멤버십(분리/병합)이 그대로
// 반영된다(route_map_positions·station_lines 현재 상태를 읽음).
//
// 사용: node tools/route-map/export-loom-geojson.mjs [--pack …] [--region 수도권] [--out capital.geojson]
import { isMainModule } from "../lib/is-main-module.mjs";
import { writeFileSync } from "node:fs";
import { cleanupPackDir, openPack } from "./pack-io.mjs";

export const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * design(픽셀) ↔ LOOM 지리창(lat/lon) 정확 왕복 변환 팩토리(T1).
 * LOOM은 입력을 WGS84 lat/lon으로 간주해 web-mercator 투영한다(Geo.tpp R=6378137,
 * lon 111319.49 m/°). design↔webmerc를 **상사변환**(k m/px, y 뒤집기)으로 두고 lat/lon은
 * LOOM 공식으로만 통과시키면, octi가 webmerc 공간에서 만든 45°가 design 공간에서도
 * **정확히 8선형**으로 되돌아온다(선형 lat/lon 매핑의 위도 왜곡 6.5°를 교정). octi 출력은
 * 항상 lat/lon이므로 역변환은 lat/lon → webmerc → design.
 */
export function buildGeoTransform({ minX, maxX, minY, maxY }) {
  const R = 6378137.0;
  const M_PER_DEG_LON = (R * Math.PI) / 180; // R·π/180 (식으로 — 리터럴 정밀도 손실 회피)
  const mercY = (latDeg) => {
    const s = Math.sin((latDeg * Math.PI) / 180);
    return (R / 2) * Math.log((1 + s) / (1 - s));
  };
  const invMercLat = (my) =>
    ((2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180) / Math.PI;
  const spanPx = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const k = 30000 / spanPx; // design span → ~30km webmerc(서울 크기, mercator 특이점 회피)
  const CLON = 127.0;
  const CLAT = 37.5;
  const CMX = CLON * M_PER_DEG_LON;
  const CMY = mercY(CLAT);
  // design (x,y) → webmerc → lat/lon (export forward)
  const toGeo = (x, y) => {
    const mx = CMX + (x - cx) * k;
    const my = CMY - (y - cy) * k; // y 뒤집기
    return [round6(mx / M_PER_DEG_LON), round6(invMercLat(my))];
  };
  // lat/lon → webmerc → design (octi 출력 역변환 — P1.3이 사용). forward와 동일 수식 1벌
  // 을 공유하도록 makeToDesignFromParams로 위임(octi-to-pack.makeToDesign도 같은 벌 사용).
  const transform = { R, M_PER_DEG_LON, k, cx, cy, CMX, CMY, CLON, CLAT };
  const toDesign = makeToDesignFromParams(transform);
  return { toGeo, toDesign, transform };
}

/**
 * 순수: transform 파라미터(직렬화 가능) → loom(lon,lat) → design 역변환 클로저.
 * buildGeoTransform(같은 프로세스)과 octi-to-pack(transform.json 재로드) 공용 — 역변환
 * 수식을 한 곳에만 둬 forward와의 부호/스케일 불일치를 원천 차단한다.
 */
export function makeToDesignFromParams({ R, M_PER_DEG_LON, k, cx, cy, CMX, CMY }) {
  const mercY = (latDeg) => {
    const s = Math.sin((latDeg * Math.PI) / 180);
    return (R / 2) * Math.log((1 + s) / (1 - s));
  };
  return (lon, lat) => ({
    x: cx + (lon * M_PER_DEG_LON - CMX) / k,
    y: cy - (mercY(lat) - CMY) / k,
  });
}

/** 간선 목록의 노드 차수 맵. */
function degreeOf(edgeList) {
  const d = new Map();
  for (const e of edgeList) {
    d.set(e.from, (d.get(e.from) ?? 0) + 1);
    d.set(e.to, (d.get(e.to) ?? 0) + 1);
  }
  return d;
}

/**
 * 순수: 위상(노드 좌표 맵 + 간선 목록) → octi 8방향 제약을 위해 degree>8 노드를 분할한다.
 * 초과 노드를 두 정점으로 쪼개 incident edge를 반씩 나누고 짧은 연결 edge를 추가한다.
 * 1회 분할은 각 절반을 ceil(d/2)+1로 낮추므로 degree>14 허브는 여전히 >8 — degree≤8이
 * 될 때까지 **반복 분할**한다(유니크 접미 #2,#3,…). 재주입 시 '#' 앞이 station_id.
 * nodeCoord·edgeList를 제자리 변형하고 분할 로그를 반환.
 */
function firstOverDegree(edgeList) {
  for (const [nid, nd] of degreeOf(edgeList)) {
    if (nd > 8) return { id: nid, d: nd };
  }
  return null;
}

export function splitHighDegreeNodes(nodeCoord, edgeList) {
  const splitNodes = [];
  for (;;) {
    const over = firstOverDegree(edgeList);
    if (over === null) break;
    const { id, d } = over;
    splitNodes.push({ id, name: nodeCoord.get(id)?.name, d });
    const c = nodeCoord.get(id);
    let suffix = 2;
    while (nodeCoord.has(`${id}#${suffix}`)) suffix += 1; // 반복 분할 접미 충돌 회피
    const id2 = `${id}#${suffix}`;
    nodeCoord.set(id2, { x: c.x + 1, y: c.y + 1, name: c.name });
    const incident = edgeList.filter((e) => e.from === id || e.to === id);
    for (let k = Math.ceil(incident.length / 2); k < incident.length; k += 1) {
      const e = incident[k];
      if (e.from === id) e.from = id2;
      else e.to = id2;
    }
    edgeList.push({ from: id, to: id2, lines: new Set(incident[0].lines) });
  }
  return splitNodes;
}

function parseArgs(argv) {
  const o = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    region: "수도권",
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack": o.pack = argv[++i]; break;
      case "--region": o.region = argv[++i]; break;
      case "--out": o.out = argv[++i]; break;
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.out) throw new Error("사용: --out <출력.geojson> 필수");
  const { db, dir } = openPack(o.pack, "loom-export-");
  try {
    const posRows = db
      .prepare(
        "SELECT p.station_id, p.line_id, p.x, p.y, s.name_ko " +
          "FROM route_map_positions p JOIN stations s ON s.id = p.station_id " +
          "WHERE p.region = ? ORDER BY p.station_id, p.line_id",
      )
      .all(o.region);
    const seqRows = db
      .prepare(
        "SELECT sl.station_id, sl.line_id, sl.line_sequence AS seq " +
          "FROM station_lines sl JOIN route_map_positions p " +
          "ON p.station_id = sl.station_id AND p.line_id = sl.line_id AND p.region = ? " +
          "GROUP BY sl.station_id, sl.line_id ORDER BY sl.line_id, sl.line_sequence",
      )
      .all(o.region);
    const lineRows = db.prepare("SELECT id, name_ko FROM lines").all();
    const lineName = new Map(lineRows.map((r) => [r.id, r.name_ko]));

    // node: station_id → {x, y(centroid), name}
    const nodeAcc = new Map();
    for (const r of posRows) {
      if (!nodeAcc.has(r.station_id)) {
        nodeAcc.set(r.station_id, { xs: 0, ys: 0, n: 0, name: r.name_ko });
      }
      const a = nodeAcc.get(r.station_id);
      a.xs += r.x; a.ys += r.y; a.n += 1;
    }
    const nodeCoord = new Map();
    for (const [id, a] of nodeAcc) {
      nodeCoord.set(id, { x: a.xs / a.n, y: a.ys / a.n, name: a.name });
    }

    // edge: 노선별 sequence 연속 역쌍. 같은 {from,to}는 lines[] 병합.
    const byLine = new Map();
    for (const r of seqRows) {
      if (!byLine.has(r.line_id)) byLine.set(r.line_id, []);
      byLine.get(r.line_id).push({ station: r.station_id, seq: r.seq });
    }
    const edges = new Map(); // "a\tb"(정렬) → {from,to,lines:Set}
    for (const [lineId, stations] of byLine) {
      stations.sort((p, q) => p.seq - q.seq);
      for (let i = 1; i < stations.length; i += 1) {
        const a = stations[i - 1].station;
        const b = stations[i].station;
        if (a === b || !nodeCoord.has(a) || !nodeCoord.has(b)) continue;
        const key = a < b ? `${a}\t${b}` : `${b}\t${a}`;
        if (!edges.has(key)) edges.set(key, { from: a, to: b, lines: new Set() });
        edges.get(key).lines.add(lineId);
      }
    }

    const edgeList = [...edges.values()];
    const splitNodes = splitHighDegreeNodes(nodeCoord, edgeList);
    const degree = degreeOf(edgeList);
    let maxDeg = 0;
    for (const d of degree.values()) if (d > maxDeg) maxDeg = d;

    // 좌표 변환(T1 정확 왕복)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of nodeCoord.values()) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
    }
    const { toGeo, toDesign, transform } = buildGeoTransform({ minX, maxX, minY, maxY });

    // 왕복 항등 검증(design → geo → design == 원좌표). 임계 0.05px: 왕복 오차는 lat/lon
    // 6자리 반올림(~0.011px)뿐 — 서브픽셀이라 렌더 무영향. 이보다 크면 transform 수학 버그.
    let maxRt = 0;
    for (const c of nodeCoord.values()) {
      const [lon, lat] = toGeo(c.x, c.y);
      const b = toDesign(lon, lat);
      maxRt = Math.max(maxRt, Math.hypot(b.x - c.x, b.y - c.y));
    }
    if (maxRt > 0.05) {
      throw new Error(`왕복 항등 실패: maxRoundTrip=${maxRt} (transform 버그)`);
    }
    writeFileSync(
      o.out.replace(/\.geojson$/, "") + ".transform.json",
      JSON.stringify({ ...transform, maxRoundTrip: maxRt }, null, 2),
    );

    // GeoJSON FeatureCollection
    const features = [];
    for (const [id, c] of nodeCoord) {
      // station_label에 우리 node id(station-xxx, 분할은 …#2)를 실어 재주입 매핑을 보존.
      features.push({
        type: "Feature",
        properties: { id, deg: String(degree.get(id) ?? 0), station_label: id },
        geometry: { type: "Point", coordinates: toGeo(c.x, c.y) },
      });
    }
    let edgeId = 0;
    for (const e of edgeList) {
      const fc = nodeCoord.get(e.from);
      const tc = nodeCoord.get(e.to);
      features.push({
        type: "Feature",
        properties: {
          id: `e${edgeId++}`,
          from: e.from,
          to: e.to,
          lines: [...e.lines].map((lid) => ({
            id: lid,
            label: lineName.get(lid) ?? lid,
            color: "888888",
          })),
        },
        geometry: {
          type: "LineString",
          coordinates: [toGeo(fc.x, fc.y), toGeo(tc.x, tc.y)],
        },
      });
    }
    writeFileSync(o.out, JSON.stringify({ type: "FeatureCollection", features }));
    console.log(
      `[${o.region}] node ${nodeCoord.size} · edge ${edgeList.length} · maxDegree ${maxDeg} · ` +
        `분할 ${splitNodes.length}건 · maxRoundTrip ${maxRt.toFixed(4)}px`,
    );
    for (const e of splitNodes) console.log(`  분할(차수>8): ${e.name} (${e.id}) deg=${e.d}→분할`);
    console.log(`GeoJSON: ${o.out}`);
  } finally {
    cleanupPackDir(dir);
  }
}

if (isMainModule(import.meta.url)) main();
