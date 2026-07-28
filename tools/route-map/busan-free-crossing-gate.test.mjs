// #2068 부산 마감 라운드: 파이프라인 실측 자유 교차(비환승 노선-노선 교차) 하드
// 게이트. capital.sqlite.gz의 실제 부산권 팩(run-sma-pipeline-busan.sh 산출물)에
// audit-station-spacing.mjs와 동일한 classifyCrossings를 돌려 자유 교차 수를
// 감시한다 — 회귀(재배치·재간격·스냅 조정이 새 자유 교차를 만드는 것)를 막는다.
//
// 재설계(#2068) 전 자유 교차 6(오너 지적 "환승 아닌데 노선 겹침") → line1·line2·
// bgl corridor 분리 + 벡스코 진입부 8선형 코너 재설계로 소스 SVG 자유 교차는 0.
// 파이프라인(재간격→8선형 스냅) 통과 후 1건 잔존했었다 — 원인 실측: 벡스코(시립
// 미술관)는 SVG에 환승 캡슐(2호선×동해선)이 그려지지만, 카탈로그에는 두 노선이
// 별개 station_id로 남아 있어 graph.clusters에 벡스코가 knot로 등록되지 않았다.
// classifyCrossings는 knot 반경 안의 교차만 "매듭"으로 걸러내므로, 두 노선이
// 벡스코에서 만나는 한 이 교차는 "자유"로 분류됐다 — 스냅 파라미터가 아니라
// 카탈로그의 station_id 병합 여부에 달린 데이터 모델 문제였다.
//
// #2068 마감(오너 확정 "실제로 환승역임, 이 이슈에서 처리"): merge-busan-transfers.mjs
// 로 2호선 벡스코(station-fbcc387e1db9, 부역명 시립미술관)와 동해선 벡스코
// (station-6820d21cea02)를 단일 환승 station_id로 병합했다. 이제 벡스코가 2노선
// 멤버 = graph.clusters의 knot로 등록돼(cluster members 2) 그 교차가 매듭으로
// 분류된다 → 자유 교차 1→0. 좌천 분리(split-mismerged-stations)와 대칭인 카탈로그
// 수술이며, 병합 후 apply-sma-svg-positions 미매핑 0 게이트도 통과함을 실측했다.
// 하드 게이트는 자유 교차 0을 못 박고, 재배치·재간격·스냅 회귀가 새 자유 교차를
// 만들면 즉시 실패시킨다.
//
// #2068 완주 라운드(오너 v2 재배치, 2026-07-20): 오너가 부전에 1호선·동해선
// 심벌을 각각 그려 넣으면서 그 교차가 새로 드러났다. 벡스코와 겉보기엔 같은
// "자유 교차" 형태지만 원인이 다르다 — 오너 확정: "별개 역인데? 내가 환승역으로
// 그렸다고?" — 1호선 부전과 동해선 부전은 서로 다른 물리역이고(병합 대상 아님,
// merge-busan-transfers.mjs 절대 적용 금지), 두 노선이 그 지점에서 그냥
// 지나가며 교차하는 실제 무환승 교차다(오너가 그린 실제 지리, 데이터 결함
// 아님). 그래서 knot 등록(벡스코식 병합)이 아니라 좌표·노선쌍으로 정밀
// 특정한 allowlist로 처리한다 — free 카운트 자체의 임계 완화가 아니라, 이
// 특정 교차 1건만 "알려진 무환승 교차"로 분리해 여전히 0을 하드 고정한다.
// 좌표는 파이프라인 실측(부전 위치, line1×동해선 트랙 교차 검출분을 모두
// 포괄하는 중심점·반경)에서 가져왔다 — 새로운 자유 교차가 다른 곳에 생기면
// 이 allowlist에 안 걸려 즉시 실패한다(포괄 완화 아님).
const BUSAN_FREE_CROSSING_ALLOWLIST = [
  {
    lineIds: ["line-ab1a041f6266", "line-f52eb59d8497"], // 부산 1호선 × 부산 동해선
    point: { x: 5817, y: 3985 },
    toleranceRadius: 80,
    note:
      "오너 확정 2026-07-20 — 부전 1호선·동해선 별개 역, 무환승 교차(병합 금지). " +
      "각 station_id는 노선별 마커 좌표를 유지하며, allowlist 중심 인근에서는 " +
      "두 노선이 실제로 교차만 하고 환승은 없다.",
  },
];

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCrossings, clusterCentroids } from "./audit-station-spacing.mjs";
import { loadRegionRespaceGraph, medianStationChainLength } from "./respace-route-map.mjs";
import { cleanupPackDir, openPack } from "./pack-io.mjs";

const KNOWN_FREE_CROSSING_BASELINE = 0; // 벡스코 병합 + 부전 allowlist — 자유 교차 0(위 note 참고).

test("부산권 실팩: 자유 교차 0(벡스코 병합 + 부전 allowlist, #2068 완주)", () => {
  const { db, dir } = openPack("apps/mobile/assets/datapacks/capital.sqlite.gz", "busan-free-crossing-gate-");
  try {
    const graph = loadRegionRespaceGraph(db, "부산권");
    const activeTracks = graph.tracks.filter((t) => t.nodeIds.length);
    const tracksPoints = activeTracks.map((t) => t.nodeIds.map((id) => graph.nodes[id]));
    const trackLineIds = activeTracks.map((t) => t.lineId);
    const unit = medianStationChainLength(graph);
    const byClass = classifyCrossings(tracksPoints, clusterCentroids(graph, graph.nodes), {
      knotRadius: unit * 0.75,
      trackLineIds,
      freeAllowlist: BUSAN_FREE_CROSSING_ALLOWLIST,
    });
    assert.ok(
      byClass.free <= KNOWN_FREE_CROSSING_BASELINE,
      `부산권 자유 교차 ${byClass.free}건(allowlist 제외분 ${byClass.freeAllowlisted}건) — ` +
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
