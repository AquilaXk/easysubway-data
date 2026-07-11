#!/usr/bin/env node
// #1950 버전 diff 리포트: v(N)↔v(N+1) 추출 JSON을 비교해 역 추가/삭제/이동, 노선
// 라벨 변경을 요약한다. 게이트·QA가 변경분에 집중하게 한다. 결정적 출력.
//
// Usage: node tools/route-map/diff-sma-versions.mjs --old <geomN.json> --new <geomN1.json>
//          [--move-threshold 4] [--out report.json]
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function nodeKey(node) {
  return `${node.dataStation}|${node.dataLine}`;
}

export function diffExtractions(oldGeom, newGeom, { moveThreshold = 4 } = {}) {
  const oldMap = new Map((oldGeom.stationNodes ?? []).map((n) => [nodeKey(n), n]));
  const newMap = new Map((newGeom.stationNodes ?? []).map((n) => [nodeKey(n), n]));

  const added = [];
  const removed = [];
  const moved = [];
  for (const [key, node] of newMap) {
    if (!oldMap.has(key)) added.push({ station: node.dataStation, line: node.dataLine });
  }
  for (const [key, node] of oldMap) {
    if (!newMap.has(key)) removed.push({ station: node.dataStation, line: node.dataLine });
  }
  for (const [key, newNode] of newMap) {
    const oldNode = oldMap.get(key);
    if (!oldNode) continue;
    const dist = Math.hypot(newNode.x - oldNode.x, newNode.y - oldNode.y);
    if (dist > moveThreshold) {
      moved.push({
        station: newNode.dataStation,
        line: newNode.dataLine,
        from: { x: round(oldNode.x), y: round(oldNode.y) },
        to: { x: round(newNode.x), y: round(newNode.y) },
        distance: round(dist),
      });
    }
  }
  // 노선별 노드 수 변화.
  const lineCounts = (geom) => {
    const c = new Map();
    for (const n of geom.stationNodes ?? []) c.set(n.dataLine, (c.get(n.dataLine) ?? 0) + 1);
    return c;
  };
  const oldLines = lineCounts(oldGeom);
  const newLines = lineCounts(newGeom);
  const lineChanges = [];
  for (const line of new Set([...oldLines.keys(), ...newLines.keys()])) {
    const before = oldLines.get(line) ?? 0;
    const after = newLines.get(line) ?? 0;
    if (before !== after) lineChanges.push({ line, before, after });
  }

  const sortByStation = (a, b) => a.station.localeCompare(b.station) || a.line.localeCompare(b.line);
  added.sort(sortByStation);
  removed.sort(sortByStation);
  moved.sort((a, b) => b.distance - a.distance);
  lineChanges.sort((a, b) => a.line.localeCompare(b.line));

  return {
    oldSha256: oldGeom.sourceSvgSha256 ?? null,
    newSha256: newGeom.sourceSvgSha256 ?? null,
    oldNodeCount: (oldGeom.stationNodes ?? []).length,
    newNodeCount: (newGeom.stationNodes ?? []).length,
    addedCount: added.length,
    removedCount: removed.length,
    movedCount: moved.length,
    added,
    removed,
    moved: moved.slice(0, 100),
    lineNodeCountChanges: lineChanges,
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function parseArgs(argv) {
  const o = { old: null, new: null, moveThreshold: 4, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--old": o.old = argv[++i]; break;
      case "--new": o.new = argv[++i]; break;
      case "--move-threshold": {
        const raw = argv[++i];
        const v = Number(raw);
        if (!Number.isFinite(v)) {
          throw new Error(`--move-threshold must be a finite number, got: ${String(raw)}`);
        }
        o.moveThreshold = v;
        break;
      }
      case "--out": o.out = argv[++i]; break;
    }
  }
  if (!o.old || !o.new) throw new Error("--old and --new geometry JSON required");
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const oldGeom = JSON.parse(await readFile(path.resolve(o.old), "utf8"));
  const newGeom = JSON.parse(await readFile(path.resolve(o.new), "utf8"));
  const report = diffExtractions(oldGeom, newGeom, { moveThreshold: o.moveThreshold });
  const json = JSON.stringify(report, null, 2);
  if (o.out) await writeFile(path.resolve(o.out), `${json}\n`);
  else process.stdout.write(`${json}\n`);
  console.error(
    `diff: +${report.addedCount} -${report.removedCount} 이동 ${report.movedCount} · 노선 변화 ${report.lineNodeCountChanges.length}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
