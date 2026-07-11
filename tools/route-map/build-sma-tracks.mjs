#!/usr/bin/env node
// #1950: 오너 자작 도식 stroke → 노선 track(결정적). build-route-map-line-tracks의
// 색-근접 Hungarian 매칭은 이 SVG의 파편화된 저채도 노선(#a49d87 9호선·#5eac41
// 서해선)을 오배정한다. 대신 SVG 메타데이터의 색→슬러그(1:1) + 슬러그→canonical
// line_id로 확정 배정한다. 장식(범례) stroke는 콘텐츠 y 밴드 밖·비노선색으로 배제.
//
// stitch 규칙은 앱 _assemblePolylines(structured_route_map.dart)와 동일 —
// 조각 끝점이 다음 조각 시작점과 근접하면 잇고, 아니면 별도 track으로 끊는다.
//
// Usage: node tools/route-map/build-sma-tracks.mjs --geometry <geom.json>
//          --pack <capital.sqlite.gz> --region 수도권 --out tracks.json
//          [--stitch-tolerance 6] [--content-min-y 340] [--content-max-y 1720]
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { LINE_SLUG_TO_SUFFIX, REGION } from "./apply-sma-svg-positions.mjs";

// SVG line_colors 메타데이터(대문자 hex, 소문자로 비교). 색 → 슬러그(1:1).
export const SVG_COLOR_TO_SLUG = {
  "#004a85": "1", "#00a23f": "2", "#ed6c00": "3", "#009bce": "4", "#794698": "5",
  "#7c4932": "6", "#6e7e31": "7", "#d11d70": "8", "#a49d87": "9",
  "#6ac2b3": "gyeongui-jungang", "#eca300": "suin-bundang", "#b81b30": "shinbundang",
  "#b4c7e7": "incheon-1", "#0079ac": "airport-railroad", "#bacc50": "ui-sinseol",
  "#5e7dbb": "sillim", "#f0831e": "uijeongbu-lrt", "#44a436": "everline",
  "#f4a462": "incheon-2", "#957326": "gimpo-goldline", "#007a62": "gyeongchun",
  "#0b318f": "gyeonggang", "#5eac41": "seohae", "#9a6292": "gtx-a",
};

function suffixFromLineName(nameKo) {
  return nameKo.startsWith(`${REGION} `) ? nameKo.slice(REGION.length + 1) : nameKo;
}

export function resolveSlugToLineId(db) {
  const rows = db.prepare("SELECT id, name_ko FROM lines WHERE name_ko LIKE ?").all(`${REGION}%`);
  const bySuffix = new Map(rows.map((r) => [suffixFromLineName(r.name_ko), r.id]));
  const map = new Map();
  for (const [slug, suffix] of Object.entries(LINE_SLUG_TO_SUFFIX)) {
    const id = bySuffix.get(suffix);
    if (id) map.set(slug, id);
  }
  return map;
}

// 한 노선의 stroke 조각들을 끝점 근접 기준으로 그리디 체이닝해 최소 개수의
// 연속 polyline으로 잇는다. 방향(정/역)도 뒤집어 맞춘다. 남은 조각은 새 chain.
export function stitchToPaths(pointLists, tolerance) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const segs = pointLists.filter((p) => p.length >= 2).map((p) => p.slice());
  const used = new Array(segs.length).fill(false);
  const chains = [];
  // 결정적 시작: 가장 위(y 작은)·왼쪽 조각부터.
  const order = segs
    .map((_, i) => i)
    .sort((a, b) => segs[a][0].y - segs[b][0].y || segs[a][0].x - segs[b][0].x);
  for (const start of order) {
    if (used[start]) continue;
    used[start] = true;
    const chain = segs[start].slice();
    let extended = true;
    while (extended) {
      extended = false;
      let best = -1;
      let bestFlip = false;
      let bestAtEnd = true;
      let bestD = tolerance;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      for (let i = 0; i < segs.length; i += 1) {
        if (used[i]) continue;
        const s = segs[i];
        const cand = [
          { d: dist(tail, s[0]), flip: false, atEnd: true },
          { d: dist(tail, s[s.length - 1]), flip: true, atEnd: true },
          { d: dist(head, s[s.length - 1]), flip: false, atEnd: false },
          { d: dist(head, s[0]), flip: true, atEnd: false },
        ];
        for (const c of cand) {
          if (c.d <= bestD) { bestD = c.d; best = i; bestFlip = c.flip; bestAtEnd = c.atEnd; }
        }
      }
      if (best >= 0) {
        used[best] = true;
        let piece = segs[best].slice();
        if (bestFlip) piece.reverse();
        if (bestAtEnd) chain.push(...piece.slice(1));
        else chain.unshift(...piece.slice(0, -1));
        extended = true;
      }
    }
    chains.push(chain);
  }
  return chains.map(
    (chain) => `M ${octolinearizeChain(chain).map((p) => `${round(p.x)} ${round(p.y)}`).join(" L ")}`,
  );
}

// 조각 stitch 브리지가 비축 세그먼트를 만들면 8선형이 깨진다. 각 세그먼트 방향을
// 최근접 8방향으로 양자화해 축 정렬한다(오너 stroke의 직선 run은 이미 8선형이라
// 그대로 유지되고, 브리지만 정렬된다).
export function octolinearizeChain(points) {
  if (points.length < 2) return points;
  const DIRS = [
    { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
    { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
  ].map((d) => ({ x: d.x / Math.hypot(d.x, d.y), y: d.y / Math.hypot(d.x, d.y) }));
  const out = [{ x: points[0].x, y: points[0].y }];
  for (let i = 1; i < points.length; i += 1) {
    const prev = out[out.length - 1];
    const dx = points[i].x - prev.x;
    const dy = points[i].y - prev.y;
    if (Math.hypot(dx, dy) < 1e-6) continue;
    let best = DIRS[0];
    let bestDot = -Infinity;
    for (const d of DIRS) {
      const dot = dx * d.x + dy * d.y;
      if (dot > bestDot) { bestDot = dot; best = d; }
    }
    const t = dx * best.x + dy * best.y;
    out.push({ x: prev.x + best.x * t, y: prev.y + best.y * t });
  }
  return out;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

export function buildTracksDoc(geom, db, { stitchTolerance, contentMinY, contentMaxY }) {
  const slugToLineId = resolveSlugToLineId(db);
  const byLineId = new Map();
  for (const stroke of geom.strokes ?? []) {
    if (stroke.tag === "line" || stroke.dashed) continue;
    const slug = SVG_COLOR_TO_SLUG[(stroke.stroke || "").toLowerCase()];
    if (!slug) continue; // 비노선색(장식·환승 캡슐·무채색)
    const ys = stroke.points.map((p) => p.y).sort((a, b) => a - b);
    const medY = ys[Math.floor(ys.length / 2)];
    if (medY < contentMinY || medY > contentMaxY) continue; // 범례 밖
    const lineId = slugToLineId.get(slug);
    if (!lineId) continue;
    byLineId.set(lineId, [...(byLineId.get(lineId) ?? []), stroke]);
  }
  const lines = [];
  const warnings = [];
  for (const [lineId, strokes] of byLineId) {
    // arc-length 안정 정렬 후 stitch(결정적). 정렬 키: 첫 점 (y,x).
    strokes.sort(
      (a, b) => a.points[0].y - b.points[0].y || a.points[0].x - b.points[0].x,
    );
    const paths = stitchToPaths(strokes.map((s) => s.points), stitchTolerance);
    lines.push({ lineId, svgColor: strokes[0].stroke, trackCount: paths.length, paths });
  }
  const allLineIds = new Set(slugToLineId.values());
  for (const id of allLineIds) {
    if (!byLineId.has(id)) warnings.push(`노선 ${id}: SVG stroke 없음`);
  }
  return {
    schemaVersion: 1,
    region: geom.region ?? REGION,
    source: "sma-svg-color-slug",
    stitchTolerance,
    sourceExtractorVersion: geom.extractorVersion ?? null,
    lineCount: lines.length,
    lines,
    warnings,
  };
}

function parseArgs(argv) {
  const o = {
    geometry: null, pack: null, region: REGION, out: null,
    stitchTolerance: 6, contentMinY: 340, contentMaxY: 1720,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--geometry": o.geometry = argv[++i]; break;
      case "--pack": o.pack = argv[++i]; break;
      case "--region": o.region = argv[++i]; break;
      case "--out": o.out = argv[++i]; break;
      case "--stitch-tolerance": o.stitchTolerance = Number(argv[++i]); break;
      case "--content-min-y": o.contentMinY = Number(argv[++i]); break;
      case "--content-max-y": o.contentMaxY = Number(argv[++i]); break;
    }
  }
  if (!o.geometry || !o.pack) throw new Error("--geometry and --pack are required");
  return o;
}

async function loadPack(packPath) {
  const bytes = await readFile(path.resolve(packPath));
  const dir = await mkdtemp(path.join(tmpdir(), "sma-tracks-"));
  const sqlitePath = path.join(dir, "pack.sqlite");
  await writeFile(sqlitePath, packPath.endsWith(".gz") ? gunzipSync(bytes) : bytes);
  return { db: new DatabaseSync(sqlitePath), dir };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const geom = JSON.parse(await readFile(path.resolve(o.geometry), "utf8"));
  const { db, dir } = await loadPack(o.pack);
  try {
    const doc = buildTracksDoc(geom, db, o);
    const json = JSON.stringify(doc, null, 2);
    if (o.out) await writeFile(path.resolve(o.out), `${json}\n`);
    else process.stdout.write(`${json}\n`);
    console.error(`[${o.region}] 노선 track ${doc.lineCount} · 경고 ${doc.warnings.length}`);
    for (const w of doc.warnings) console.error(`  ⚠ ${w}`);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
