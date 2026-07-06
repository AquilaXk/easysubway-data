#!/usr/bin/env node
// #1789 재간격 캘리브레이션 스윕: kAnchor × maxRatio frontier에서
// (자유교차, 매듭 노출, 8선형, p95/p5) 트레이드오프를 실측한다.
// 팩은 읽기 전용 — 적용은 respace-route-map.mjs CLI가 한다.
import {
  buildRespaceGraph,
  medianStationChainLength,
  parsePathPoints,
  respaceGraph,
} from "./respace-route-map.mjs";
import {
  chainLengthStats,
  classifyCrossings,
  clusterCentroids,
  octolinearityViolations,
} from "./audit-station-spacing.mjs";
import { cleanupPackDir, openPack } from "./pack-io.mjs";

const PACK = process.argv[2] ?? "apps/mobile/assets/datapacks/capital.sqlite.gz";
const REGION = process.argv[3] ?? "수도권";

const { db, dir } = openPack(PACK, "sweep-");
let graph;
try {
  const trackRows = db
    .prepare(
      "SELECT line_id, track_index, path FROM route_map_line_tracks " +
        "WHERE region = ? ORDER BY line_id, track_index",
    )
    .all(REGION);
  const posRows = db
    .prepare(
      "SELECT station_id, line_id, x, y FROM route_map_positions WHERE region = ?",
    )
    .all(REGION);
  graph = buildRespaceGraph({
    tracks: trackRows.map((r) => ({
      lineId: r.line_id,
      trackIndex: r.track_index,
      points: parsePathPoints(r.path),
    })),
    positions: posRows.map((r) => ({
      stationId: r.station_id,
      lineId: r.line_id,
      x: r.x,
      y: r.y,
    })),
  });
} finally {
  cleanupPackDir(dir);
}

const unit = medianStationChainLength(graph);

function measure(positions) {
  const tracksPoints = graph.tracks
    .filter((t) => t.nodeIds.length)
    .map((t) => t.nodeIds.map((id) => positions[id]));
  const byClass = classifyCrossings(
    tracksPoints,
    clusterCentroids(graph, positions),
    { knotRadius: unit * 0.75 },
  );
  const stats = chainLengthStats({ ...graph, nodes: positions });
  return {
    free: byClass.free,
    knotVisible: byClass.knotVisible,
    knotCovered: byClass.knotCovered,
    octo: octolinearityViolations(tracksPoints).length,
    p95OverP5: stats.p95OverP5,
  };
}

const fmt = (m) =>
  `free=${m.free} 매듭노출=${m.knotVisible} 매듭가림=${m.knotCovered} ` +
  `octo=${m.octo} p95/p5=${m.p95OverP5.toFixed(1)}`;

console.log(`[${REGION}] unit=${unit.toFixed(1)}`);
console.log(`baseline: ${fmt(measure(graph.nodes.map((n) => ({ x: n.x, y: n.y }))))}`);
for (const kAnchor of [0.05, 0.1, 0.15, 0.3, 0.5]) {
  for (const maxRatio of [1.8, 2.2, 2.5]) {
    const { positions, report } = respaceGraph(graph, { unit, kAnchor, maxRatio });
    console.log(
      `kAnchor=${kAnchor} maxRatio=${maxRatio}: ${fmt(measure(positions))} ` +
        `(방향잔차 ${report.maxPerpResidual.toFixed(3)})`,
    );
  }
}
