// #2068 대구 마감 라운드(오너 직접 제작본 전환, 2026-07-20): 파이프라인 실측
// 자유 교차(비환승 노선-노선 교차) 하드 게이트. capital.sqlite.gz의 실제 대구권
// 팩(run-sma-pipeline-daegu.sh 산출물)에 audit-station-spacing.mjs와 동일한
// classifyCrossings를 돌려 자유 교차 수를 감시한다 — 재배치·재간격·스냅 조정이
// 새 자유 교차를 만드는 회귀를 막는다. busan-free-crossing-gate.test.mjs 미러.
//
// 오너 직접 제작본에는 자유 교차 1건이 있다: 대구 3호선(line-0ffaa95b1b5d, 세로)이
// 대구 대경선(line-8f7ed01f290a, 가로)을 북구청↔달성공원 사이(달성공원 인근,
// 서문시장 위)에서 가로지른다. 교차점(≈1798.5,1255.5)에는 환승역이 없다 — 두
// 노선이 실제로 그 지점에서 환승 없이 교차만 하는 오너가 그린 실제 지리다(데이터
// 결함 아님, 실물 대구 지하철 3호선과 대경선은 이 지점에 공용 환승역이 없다).
// 크롭 육안 확인: docs/2068-qa/daegu-owner-v1/03_line3_x_daegyeong_crossing.png
// — 두 15px 스트로크가 직교로 깔끔히 교차(가림·엉킴 없음). 부산 부전(1호선×동해선)
// 무환승 교차와 같은 성격이라, 병합(knot 등록)이 아니라 좌표·노선쌍으로 정밀
// 특정한 allowlist로 처리한다 — free 카운트 임계 완화가 아니라, 이 특정 교차
// 1건만 "알려진 무환승 교차"로 분리해 여전히 0을 하드 고정한다. 다른 곳에 새
// 자유 교차가 생기면 이 allowlist에 안 걸려 즉시 실패한다(포괄 완화 아님).
const DAEGU_FREE_CROSSING_ALLOWLIST = [
  {
    lineIds: ["line-0ffaa95b1b5d", "line-8f7ed01f290a"], // 대구 3호선 × 대구 대경선
    point: { x: 1798.5, y: 1255.5 },
    toleranceRadius: 80,
    note:
      "오너 직접 제작본 2026-07-20 — 3호선(달성공원·서문시장 회랑)이 대경선(서대구↔대구역 " +
      "구간)을 무환승으로 가로지른다. 교차점에 환승역 없음(오너가 그린 실제 지리).",
  },
];

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCrossings, clusterCentroids } from "./audit-station-spacing.mjs";
import { loadRegionRespaceGraph, medianStationChainLength } from "./respace-route-map.mjs";
import { cleanupPackDir, openPack } from "./pack-io.mjs";

const KNOWN_FREE_CROSSING_BASELINE = 0; // 3호선×대경선 allowlist — 자유 교차 0(위 note 참고).

test("대구권 실팩: 자유 교차 0(3호선×대경선 allowlist, #2068 완주)", () => {
  const { db, dir } = openPack("apps/mobile/assets/datapacks/capital.sqlite.gz", "daegu-free-crossing-gate-");
  try {
    const graph = loadRegionRespaceGraph(db, "대구권");
    const activeTracks = graph.tracks.filter((t) => t.nodeIds.length);
    const tracksPoints = activeTracks.map((t) => t.nodeIds.map((id) => graph.nodes[id]));
    const trackLineIds = activeTracks.map((t) => t.lineId);
    const unit = medianStationChainLength(graph);
    const byClass = classifyCrossings(tracksPoints, clusterCentroids(graph, graph.nodes), {
      knotRadius: unit * 0.75,
      trackLineIds,
      freeAllowlist: DAEGU_FREE_CROSSING_ALLOWLIST,
    });
    assert.ok(
      byClass.free <= KNOWN_FREE_CROSSING_BASELINE,
      `대구권 자유 교차 ${byClass.free}건(allowlist 제외분 ${byClass.freeAllowlisted}건) — ` +
        `baseline ${KNOWN_FREE_CROSSING_BASELINE} 악화 금지. 새 자유 교차가 생겼으면 재배치로 ` +
        `제거를 먼저 시도하라(#2068 오너 지적: 비환승 교차 최소화). allowlist에 없는 좌표/노선쌍이면 ` +
        `임의로 allowlist를 넓히지 말고 오너 확인부터 받아라.`,
    );
  } finally {
    try {
      db.close();
    } catch {
      /* 이미 닫힘 */
    }
    cleanupPackDir(dir);
  }
});
