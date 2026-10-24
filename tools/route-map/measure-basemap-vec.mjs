#!/usr/bin/env node
// 바탕층 `.vec`의 그리기 구성을 잰다(#1495). 기기 래스터 스레드가 매 프레임 다시
// 처리하는 것은 그리기 명령이므로 명령 종류별 수와, 최대 줌 한 화면에 걸리는 명령·
// 좌표 수(엔진이 화면 밖 명령을 건너뛴 뒤 남는 일)를 함께 낸다.
//
//   node tools/route-map/measure-basemap-vec.mjs <dir> [<dir-after>]
//
// 두 번째 디렉터리를 주면 같은 파일 이름끼리 전후를 나란히 적는다.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { isMainModule } from "../lib/is-main-module.mjs";
import { commandBounds, rectsOverlap } from "./merge-basemap-vec-draws.mjs";
import { decodeVec } from "./vec-codec.mjs";

// 앱 최대 줌(mobile network_map_camera_policy.dart `_maxMapScale` 4.8, viewBox 1단위당
// 논리 픽셀)에서 기기 지도 영역(mobile #518 Galaxy A17 실측 1080×1420 px, 1080 px = 411 dp
// 기준 2.625배)이 덮는 viewBox 크기.
const MAX_MAP_SCALE = 4.8;
const DEVICE_PIXEL_RATIO = 1080 / 411;
export const MAX_ZOOM_VIEWPORT = Object.freeze({
  width: 1080 / DEVICE_PIXEL_RATIO / MAX_MAP_SCALE,
  height: 1420 / DEVICE_PIXEL_RATIO / MAX_MAP_SCALE,
});

// 최대 줌 화면 크기의 창을 반 화면씩 옮기며, 창에 걸리는 그리기 명령과 그 path 좌표 수의
// 최댓값을 센다. 래스터 엔진은 화면과 겹치는 명령만 처리하므로 확대 상태의 일이다.
function maxZoomWindowLoad(doc) {
  const draws = doc.commands
    .filter((command) => command.op === "drawPath")
    .map((command) => ({
      bounds: commandBounds(doc, command),
      points: doc.paths[command.pathId].points.length / 2,
    }));
  const { width, height } = MAX_ZOOM_VIEWPORT;
  let worst = { draws: 0, points: 0 };
  for (let y = 0; y < doc.height; y += height / 2) {
    for (let x = 0; x < doc.width; x += width / 2) {
      const window = { minX: x, minY: y, maxX: x + width, maxY: y + height };
      let drawCount = 0;
      let pointCount = 0;
      for (const draw of draws) {
        if (draw.bounds && !rectsOverlap(draw.bounds, window)) continue;
        drawCount += 1;
        pointCount += draw.points;
      }
      if (drawCount > worst.draws) worst = { ...worst, draws: drawCount };
      if (pointCount > worst.points) worst = { ...worst, points: pointCount };
    }
  }
  return worst;
}

/** `.vec` 한 개의 그리기 구성. */
export function measureVec(bytes) {
  const doc = decodeVec(bytes);
  const commands = {};
  for (const command of doc.commands) {
    const key = command.op === "drawPath" && command.patternId !== null ? "drawPath(pattern)" : command.op;
    commands[key] = (commands[key] ?? 0) + 1;
  }
  const draws = doc.commands.filter((command) => command.op === "drawPath");
  const window = maxZoomWindowLoad(doc);
  return {
    commands,
    paths: doc.paths.length,
    controlPoints: doc.paths.reduce((sum, { points }) => sum + points.length / 2, 0),
    // 전체 보기 한 프레임이 그리는 좌표 수. 같은 path를 두 번 그리면 두 번 센다.
    drawnPoints: draws.reduce((sum, { pathId }) => sum + doc.paths[pathId].points.length / 2, 0),
    bytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes).byteLength,
    maxZoomWindowDraws: window.draws,
    maxZoomWindowPoints: window.points,
  };
}

function measureDirectory(dir) {
  return new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith(".vec"))
      .sort()
      .map((name) => [name, measureVec(new Uint8Array(readFileSync(path.join(dir, name))))]),
  );
}

function regionOf(name) {
  return name.slice(0, name.indexOf("."));
}

// 바탕은 파일마다 한 줄, 노선 강조 레이어는 권역마다 합친 한 줄이다. 창 부하는 최댓값이다.
const SUMMED_COLUMNS = ["files", "drawPath", "other", "paths", "controlPoints", "drawnPoints", "bytes", "gzipBytes"];
const MAXED_COLUMNS = ["maxZoomWindowDraws", "maxZoomWindowPoints"];

function summarize(measures) {
  const rows = new Map();
  for (const [name, measure] of measures) {
    const key = name.split(".").length === 2 ? name : `${regionOf(name)} 강조 레이어 합`;
    const drawPath = measure.commands.drawPath ?? 0;
    const values = {
      ...measure,
      files: 1,
      drawPath,
      other: Object.values(measure.commands).reduce((sum, count) => sum + count, 0) - drawPath,
    };
    const row = rows.get(key) ?? Object.fromEntries([...SUMMED_COLUMNS, ...MAXED_COLUMNS].map((column) => [column, 0]));
    for (const column of SUMMED_COLUMNS) row[column] += values[column];
    for (const column of MAXED_COLUMNS) row[column] = Math.max(row[column], values[column]);
    rows.set(key, row);
  }
  return rows;
}

function main([beforeDir, afterDir]) {
  if (!beforeDir) throw new Error("사용법: measure-basemap-vec.mjs <dir> [<dir-after>]");
  const before = summarize(measureDirectory(beforeDir));
  const after = afterDir ? summarize(measureDirectory(afterDir)) : null;
  const columns = [...SUMMED_COLUMNS, ...MAXED_COLUMNS];
  process.stdout.write(`| 대상 | ${columns.join(" | ")} |\n|${"---|".repeat(columns.length + 1)}\n`);
  for (const [key, row] of before) {
    const cells = columns.map((column) => {
      const next = after?.get(key)?.[column];
      return next === undefined ? `${row[column]}` : `${row[column]} → ${next}`;
    });
    process.stdout.write(`| ${key} | ${cells.join(" | ")} |\n`);
  }
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
