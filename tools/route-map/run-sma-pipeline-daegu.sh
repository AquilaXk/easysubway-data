#!/usr/bin/env bash
# #2011 3단계: 대구 오너 자작 도식(easy-subway-daegu-v*) 반복 파이프라인 — 한 줄 재실행.
#
# 부산 run-sma-pipeline-busan.sh와 동일 골격. 대구는 서해선(fill-only) 특례·지선(branch)
# spur가 없으므로 그 단계를 생략한다(1·2·3호선·대경선 모두 단일 본선). 권역 인자
# (--region daegu)로 파라미터화된 공통 추출→canonical 정합→track→투영→enrich 체인을 재사용.
#
# #2068 완주 라운드(오너 직접 제작본 전환, 2026-07-20): busan(e2d2b68a)·seoul(9afd026a)이
# 확립한 P-65 정합(팩=SVG 고정 — 역은 옮기지 않는다)으로 개정. project-nodes-to-tracks는
# --check로 보고만 하고, respace가 --pin-stations로 역 좌표를 SVG 배정에 고정한 채 트랙만
# 정리한다. 구방식(project-nodes가 역을 트랙 위로 이동 + respace 좌표 이동)은 제거 —
# 오너 손배치 좌표를 파이프라인이 재이동시키는 것을 금지한다.
#
# 사용: tools/route-map/run-sma-pipeline-daegu.sh [svg경로] [이전버전추출JSON]
#   svg 경로 미지정 시 반입된 정본 easy-subway-daegu-v3.svg를 쓴다.
#   [이전버전추출JSON]은 선택 인자다. 구버전 추출 JSON은 저장소에 상주하지 않으므로
#   (#2571 보관 조항 폐기) 필요하면 git 히스토리에서 꺼내 경로로 넘긴다. 생략하면
#   diff 단계를 건너뛴다.
# 환경: Chrome/Chromium 필요(추출기). CHROME_PATH로 지정 가능.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SVG="${1:-$ROOT/tools/route-map/route-map-defs/svg-sources/easy-subway-daegu-v3.svg}"
PREV_GEOM="${2:-}"
PACK="apps/mobile/assets/datapacks/capital.sqlite.gz"
INDEX="apps/mobile/assets/datapacks/index.json"
REGION_ID="daegu"
REGION_KEY="대구권"
WORK="${SMA_WORK:-$(mktemp -d)}"
GEOM="$WORK/daegu-geom.json"
TRACKS="$WORK/daegu-tracks.json"

cd "$ROOT"

echo "[1/7] geometry 추출(결정적: 역 노드 + 8선형 path vertex)"
node tools/route-map/extract-svg-geometry.mjs "$SVG" --region "$REGION_KEY" > "$GEOM"

echo "[2/7] canonical 정합 + route_map_positions 좌표 교체(미매핑 0 게이트) + self-drawn provenance"
node tools/route-map/apply-sma-svg-positions.mjs --extraction "$GEOM" --region "$REGION_ID" --pack "$PACK" --index "$INDEX"

echo "[3/7] 노선 track 생성(SVG 색→슬러그→line_id 결정적 배정 + 8선형 stitch)"
node tools/route-map/build-sma-tracks.mjs --geometry "$GEOM" --pack "$PACK" --region "$REGION_ID" --out "$TRACKS" --stitch-tolerance 40

echo "[4/7] track 팩 반영 + 역-트랙 이탈 진단(#2068 P-65: 팩=SVG 고정 — 역은 옮기지 않는다,"
echo "      --check로 보고만; project-nodes-to-tracks가 하던 이동은 respace --pin-stations로 대체)"
node tools/route-map/apply-route-map-line-tracks.mjs --pack "$PACK" --index "$INDEX" --tracks "$TRACKS"
node tools/route-map/project-nodes-to-tracks.mjs --region "$REGION_KEY" --pack "$PACK" --index "$INDEX" --check

echo "[5/7] 재간격(역 좌표 고정, 트랙만 정리) → 8선형 잔차 스냅"
respace_out="$(node tools/route-map/respace-route-map.mjs --region "$REGION_KEY" --pack "$PACK" --index "$INDEX" --pin-stations)"
printf '%s\n' "$respace_out" | head -1
node tools/route-map/snap-tracks-octolinear.mjs --region "$REGION_KEY" --pack "$PACK" --index "$INDEX"

echo "[6/7] enrich(팩 재빌드)"
node tools/route-map/enrich-capital-route-map-layer.mjs --pack "$PACK" --index "$INDEX" --region "$REGION_KEY" >/dev/null

echo "[7/7] 게이트 실측"
spacing_out="$(node tools/route-map/audit-station-spacing.mjs --region "$REGION_KEY")"
printf '%s\n' "$spacing_out" | head -2
transfer_out="$(node tools/route-map/audit-transfer-groups.mjs --region "$REGION_KEY")"
printf '%s\n' "$transfer_out" | head -2

if [[ -n "$PREV_GEOM" ]]; then
  echo "[diff] v(N)↔v(N+1) 변경 리포트"
  node tools/route-map/diff-sma-versions.mjs --old "$PREV_GEOM" --new "$GEOM"
fi

echo "완료. GEOM=$GEOM (다음 버전 diff 기준으로 보관)"
