#!/usr/bin/env node
// #1789 P2.1: 밀집 역(26px 미만)을 union-find 연결 성분(회랑 그룹)으로 묶는다. (1차 시도의
// expandHub 축-펼침은 8선형 벽으로 폐기 — densify-corridors.mjs가 splice 기반으로 대체.)
/** threshold 미만 쌍을 연결 성분으로. 2+ 역 성분만. */
export function denseHubs(stations, threshold = 26) {
  const parent = new Map(stations.map((s) => [s.stationId, s.stationId]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (let i = 0; i < stations.length; i += 1)
    for (let j = i + 1; j < stations.length; j += 1)
      if (Math.hypot(stations[i].x - stations[j].x, stations[i].y - stations[j].y) < threshold)
        parent.set(find(stations[i].stationId), find(stations[j].stationId));
  const comp = new Map();
  for (const s of stations) { const r = find(s.stationId); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(s.stationId); }
  return [...comp.values()].filter((c) => c.length >= 2);
}
