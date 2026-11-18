#!/usr/bin/env bash
# LOOM 툴체인 빌드 + octi/loom 파이프라인 (#1789 Phase 1 octi base).
#
# 노선도 스키매틱 base를 위상에서 생성하는 데 ad-freiburg/LOOM octi(octilinearization)
# + loom(line-ordering)을 오프라인 도구로 쓴다. 출력 좌표만 사용하고 GPL 소스는 vendoring
# 하지 않는다(오프라인 도구라 라이선스 무관, repo 오염 방지 — 계획서 "LOOM 재현성").
# 빌드 산출 바이너리도 repo에 넣지 않는다(scratchpad 보관). ILP 솔버 불필요.
#
# 사용:
#   tools/route-map/build-loom.sh build              # LOOM 빌드
#   tools/route-map/build-loom.sh run <octi-bin-dir> # export→octi→loom 파이프라인
set -euo pipefail

LOOM_REPO="https://github.com/ad-freiburg/loom"
# 재현성: upstream을 고정 커밋에 핀한다(계획서 "LOOM 재현성"). HEAD 클론은 upstream이
# 움직이면 게이트 수치가 바뀌는 구멍 — #1789 게이트 실측을 이 커밋에서 산출했다.
LOOM_COMMIT="${LOOM_COMMIT:-9d0a87a096abd8fd49d233dbc7df312c0438ad11}"
WORK="${LOOM_WORK:-/tmp/loom-work}"

build() {
  mkdir -p "$WORK" && cd "$WORK"
  # full clone 후 고정 커밋을 checkout해 재현성을 확보한다. shallow --depth 1(HEAD)만 받으면
  # 핀 커밋이 없어 checkout이 실패하므로 금지 — 전체 이력을 받아 임의 커밋 checkout을 보장.
  if [[ ! -d loom ]]; then
    git clone --recursive "$LOOM_REPO"
    cd loom && git checkout "$LOOM_COMMIT" && git submodule update --init --recursive
  else
    cd loom && git checkout "$LOOM_COMMIT" && git submodule update --init --recursive
  fi
  mkdir -p build && cd build
  cmake -DCMAKE_BUILD_TYPE=Release .. && make -j4
  echo "산출: $WORK/loom/build/{octi,loom,topo}"
}

run() {
  local bin="${1:?사용: $0 run <octi-bin-dir> [out-dir]}" out="${2:-/tmp}"
  # P1.1 export: 팩 위상 → LOOM GeoJSON (mercator 정확 왕복, degree>8 분할)
  node tools/route-map/export-loom-geojson.mjs --out "$out/capital-geo.geojson"
  # P1.2a octi: 8선형 그리드 재배치 (~41s, 657역 id 보존). Hanan 그리드 2회 = 도심 인접 여유.
  time "$bin/octi" -b octihanan --hanan-iters 2 --skip-on-error \
    < "$out/capital-geo.geojson" > "$out/capital-octi.geojson"
  # P1.2b loom: 번들 내 노선 순서 (comb-no-ilp = ILP 불필요 조합 근사, ~0.1s).
  time "$bin/loom" --optim-method comb-no-ilp \
    < "$out/capital-octi.geojson" > "$out/capital-loom.geojson"
  echo "완료: $out/capital-loom.geojson (역변환·track 생성은 octi-to-pack.mjs = P1.3)"
}

case "${1:-}" in
  build) build ;;
  run) shift; run "$@" ;;
  *) echo "사용: $0 {build|run <octi-bin-dir> [out-dir]}"; exit 1 ;;
esac
