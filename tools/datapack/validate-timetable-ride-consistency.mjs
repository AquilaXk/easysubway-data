#!/usr/bin/env node
// stop_times ↔ RIDE edge 정합 검증 (#1415 마지막 항목 · #1400 상호검증).
// 재구성 artifact(transitStopTimes)에서 인접역 구간 소요를 파생해, routing graph 의
// RIDE network_edge durationSeconds 와 정합하는지 검사한다. provider 중립: 입력은
// 재구성 산출물(collect-*/reconstruct-transit-trips)과 network_edges JS 행이다.
//
// 실행(CLI): node validate-timetable-ride-consistency.mjs \
//   --reconstruction <artifact.json> --edges <edges.json> [--abs 60] [--rel 0.25]
//   edges.json 은 배열 또는 { networkEdges: [...] } (fromNodeId/toNodeId/edgeType/durationSeconds).
// 위반이 있으면 exit 1.
import { isMainModule } from "../lib/is-main-module.mjs";
import { readFile } from "node:fs/promises";

const DEFAULT_ABSOLUTE_TOLERANCE_SECONDS = 60;
const DEFAULT_RELATIVE_TOLERANCE = 0.25;

// node id 규약(build-datapack canonicalStationLineNodeId): `stationId:lineId[:방향/승강장…]`.
function stationLineOf(nodeId) {
  const parts = String(nodeId).split(":");
  return { stationId: parts[0], lineId: parts.length >= 2 ? parts[1] : "" };
}

function segmentKey(fromStationId, toStationId, lineId) {
  return `${fromStationId}|${toStationId}|${lineId}`;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// 재구성 stop_times → 인접역 구간 소요(초) 표본. 구간 = 다음 역 도착 − 현재 역 출발.
function timetableSegments(reconstruction) {
  const stopTimes = reconstruction?.transitStopTimes ?? [];
  const byTrip = new Map();
  for (const stopTime of stopTimes) {
    if (!byTrip.has(stopTime.tripId)) {
      byTrip.set(stopTime.tripId, []);
    }
    byTrip.get(stopTime.tripId).push(stopTime);
  }

  const samples = new Map(); // key → { fromStationId, toStationId, lineId, durations: [] }
  for (const stops of byTrip.values()) {
    const ordered = [...stops].sort((a, b) => a.stopSequence - b.stopSequence);
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const current = ordered[index];
      const next = ordered[index + 1];
      const duration = next.arrivalSeconds - current.departureSeconds;
      if (!(duration > 0)) {
        continue; // 음수·0(데이터 오류)은 표본 제외
      }
      const lineId = current.lineId ?? "";
      const key = segmentKey(current.stationId, next.stationId, lineId);
      if (!samples.has(key)) {
        samples.set(key, { fromStationId: current.stationId, toStationId: next.stationId, lineId, durations: [] });
      }
      samples.get(key).durations.push(duration);
    }
  }

  const representatives = new Map();
  for (const [key, sample] of samples) {
    representatives.set(key, {
      fromStationId: sample.fromStationId,
      toStationId: sample.toStationId,
      lineId: sample.lineId,
      timetableSeconds: Math.round(median(sample.durations)),
      sampleSize: sample.durations.length,
    });
  }
  return representatives;
}

export function checkTimetableRideConsistency({
  reconstruction,
  rideEdges = [],
  absoluteToleranceSeconds = DEFAULT_ABSOLUTE_TOLERANCE_SECONDS,
  relativeTolerance = DEFAULT_RELATIVE_TOLERANCE,
} = {}) {
  const segments = timetableSegments(reconstruction);
  const rideOnly = rideEdges.filter((edge) => edge.edgeType === "RIDE");

  const matched = [];
  const violations = [];
  const rideEdgesWithoutTimetable = [];
  const coveredSegmentKeys = new Set();

  for (const edge of rideOnly) {
    const from = stationLineOf(edge.fromNodeId);
    const to = stationLineOf(edge.toNodeId);
    const key = segmentKey(from.stationId, to.stationId, from.lineId);
    const segment = segments.get(key);
    const edgeSeconds = edge.durationSeconds ?? 0;
    if (!segment) {
      rideEdgesWithoutTimetable.push({
        fromStationId: from.stationId,
        toStationId: to.stationId,
        lineId: from.lineId,
        edgeSeconds,
      });
      continue;
    }
    coveredSegmentKeys.add(key);
    const deltaSeconds = Math.abs(edgeSeconds - segment.timetableSeconds);
    const withinTolerance =
      deltaSeconds <= absoluteToleranceSeconds ||
      deltaSeconds <= segment.timetableSeconds * relativeTolerance;
    const row = {
      fromStationId: from.stationId,
      toStationId: to.stationId,
      lineId: from.lineId,
      edgeSeconds,
      timetableSeconds: segment.timetableSeconds,
      deltaSeconds,
      sampleSize: segment.sampleSize,
      withinTolerance,
    };
    (withinTolerance ? matched : violations).push(row);
  }

  const timetableSegmentsWithoutEdge = [];
  for (const [key, segment] of segments) {
    if (!coveredSegmentKeys.has(key)) {
      timetableSegmentsWithoutEdge.push({
        fromStationId: segment.fromStationId,
        toStationId: segment.toStationId,
        lineId: segment.lineId,
        timetableSeconds: segment.timetableSeconds,
      });
    }
  }

  return {
    matched,
    violations,
    rideEdgesWithoutTimetable,
    timetableSegmentsWithoutEdge,
    summary: {
      rideEdgeCount: rideOnly.length,
      timetableSegmentCount: segments.size,
      matchedCount: matched.length,
      violationCount: violations.length,
      consistent: violations.length === 0,
      absoluteToleranceSeconds,
      relativeTolerance,
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      args[token.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.reconstruction || !args.edges) {
    console.error("usage: --reconstruction <artifact.json> --edges <edges.json> [--abs 60] [--rel 0.25]");
    process.exit(2);
  }
  const reconstruction = JSON.parse(await readFile(args.reconstruction, "utf8"));
  const edgesRaw = JSON.parse(await readFile(args.edges, "utf8"));
  const rideEdges = Array.isArray(edgesRaw) ? edgesRaw : edgesRaw.networkEdges ?? [];
  const result = checkTimetableRideConsistency({
    reconstruction,
    rideEdges,
    absoluteToleranceSeconds: args.abs ? Number(args.abs) : DEFAULT_ABSOLUTE_TOLERANCE_SECONDS,
    relativeTolerance: args.rel ? Number(args.rel) : DEFAULT_RELATIVE_TOLERANCE,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.summary.consistent) {
    console.error(`stop_times↔RIDE 정합 위반 ${result.summary.violationCount}건`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
