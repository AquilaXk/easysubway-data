#!/usr/bin/env node
// #1950: 재간격(respace) 후 track 세그먼트에 남는 미세 비축 잔차를 최근접 8방향으로
// 스냅해 8선형 위반 0을 회복한다. 역 노드는 건드리지 않는다(투영·간격 게이트 보존).
// respace가 라벨 겹침을 낮추면서 남긴 폴리싱 잔차(≈10 세그먼트)를 정리하는 마무리 단계.
//
// Usage: node tools/route-map/snap-tracks-octolinear.mjs --region 수도권 [--pack ..] [--index ..]
import { pathToFileURL } from "node:url";
import { mutatePack, parsePackArgs } from "./station-surgery.mjs";
import { octolinearizeChain } from "./build-sma-tracks.mjs";

function parsePathPoints(path) {
  return path
    .trim()
    .split(/(?=[ML])/)
    .map((t) => t.trim().replace(/^[ML]\s*/, ""))
    .filter(Boolean)
    .map((seg) => {
      const [x, y] = seg.split(/[ ,]+/).map(Number);
      return { x, y };
    })
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function pointsToPath(points) {
  return `M ${points.map((p) => `${round(p.x)} ${round(p.y)}`).join(" L ")}`;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function main() {
  const o = { ...parsePackArgs(process.argv.slice(2)), region: "수도권" };
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--region") o.region = process.argv[i + 1];
  }
  mutatePack({ ...o, tmpPrefix: "snap-tracks-octo-", run: (db) => {
    const rows = db
      .prepare("SELECT line_id, track_index, path FROM route_map_line_tracks WHERE region = ?")
      .all(o.region);
    if (o.check) {
      console.log(`[${o.region}] track ${rows.length}개 8선형 스냅 예정(--check)`);
      return;
    }
    const update = db.prepare(
      "UPDATE route_map_line_tracks SET path = ? WHERE region = ? AND line_id = ? AND track_index = ?",
    );
    db.exec("BEGIN");
    let changed = 0;
    for (const row of rows) {
      const points = parsePathPoints(row.path);
      if (points.length < 2) continue;
      const snapped = octolinearizeChain(points);
      const nextPath = pointsToPath(snapped);
      if (nextPath !== row.path) changed += 1;
      update.run(nextPath, o.region, row.line_id, row.track_index);
    }
    db.exec("COMMIT");
    console.log(`[${o.region}] track ${rows.length}개 중 ${changed}개 8선형 스냅`);
  } });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
