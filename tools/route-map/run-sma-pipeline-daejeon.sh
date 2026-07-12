#!/usr/bin/env bash
# #2011 3단계: 대전 오너 자작 도식(easy-subway-daejeon-v*) 반복 파이프라인 — 한 줄 재실행.
#
# 부산 run-sma-pipeline-busan.sh와 동일 골격. 대전은 서해선(fill-only) 특례·지선(branch)
# spur가 없으므로 그 단계를 생략한다(1호선 단일 본선). 권역 인자
# (--region daejeon)로 파라미터화된 공통 추출→canonical 정합→track→투영→enrich 체인을 재사용.
#
# 사용: tools/route-map/run-sma-pipeline-daejeon.sh [svg경로] [이전버전추출JSON]
#   svg 경로 미지정 시 반입된 정본 easy-subway-daejeon-v1.svg를 쓴다.
# 환경: Chrome/Chromium 필요(추출기). CHROME_PATH로 지정 가능.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SVG="${1:-$ROOT/tools/route-map/route-map-defs/svg-sources/easy-subway-daejeon-v1.svg}"
PREV_GEOM="${2:-}"
PACK="apps/mobile/assets/datapacks/capital.sqlite.gz"
INDEX="apps/mobile/assets/datapacks/index.json"
REGION_ID="daejeon"
REGION_KEY="대전권"
WORK="${SMA_WORK:-$(mktemp -d)}"
GEOM="$WORK/daejeon-geom.json"
TRACKS="$WORK/daejeon-tracks.json"

cd "$ROOT"

echo "[1/7] geometry 추출(결정적: 역 노드 + 8선형 path vertex)"
node tools/route-map/extract-svg-geometry.mjs "$SVG" --region "$REGION_KEY" > "$GEOM"

echo "[2/7] canonical 정합 + route_map_positions 좌표 교체(미매핑 0 게이트) + self-drawn provenance"
node tools/route-map/apply-sma-svg-positions.mjs --extraction "$GEOM" --region "$REGION_ID" --pack "$PACK" --index "$INDEX"

echo "[3/7] 노선 track 생성(SVG 색→슬러그→line_id 결정적 배정 + 8선형 stitch)"
node tools/route-map/build-sma-tracks.mjs --geometry "$GEOM" --pack "$PACK" --region "$REGION_ID" --out "$TRACKS" --stitch-tolerance 40

echo "[4/7] track 팩 반영 + 역 노드 track 투영(투영 게이트)"
node tools/route-map/apply-route-map-line-tracks.mjs --pack "$PACK" --index "$INDEX" --tracks "$TRACKS"
node tools/route-map/project-nodes-to-tracks.mjs --region "$REGION_KEY" --pack "$PACK" --index "$INDEX"

echo "[5/7] 재간격 → 8선형 잔차 스냅"
respace_out="$(node tools/route-map/respace-route-map.mjs --region "$REGION_KEY" --pack "$PACK" --index "$INDEX")"
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
