import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { resolveLineMap } from "./apply-sma-svg-positions.mjs";
import {
  LINE_OVERLAY_INDEX_FILE,
  buildBasemapLineOverlays,
  buildLineOverlayIndex,
  lineOverlayVectorFileName,
  normalizeSvgForCompile,
} from "./compile-basemap-vec.mjs";
import { cleanupPackDir, openPack } from "./pack-io.mjs";
import { REGION_CONFIGS } from "./sma-region-configs.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "basemap-build-manifest.json"), "utf8"),
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function normalizedBasemapOf(regionId) {
  const map = manifest.maps.find((entry) => entry.id === regionId);
  return normalizeSvgForCompile(readFileSync(path.join(root, map.source), "utf8"));
}

const normalizedByRegion = new Map(
  Object.keys(REGION_CONFIGS).map((id) => [id, normalizedBasemapOf(id)]),
);
const overlaysByRegion = new Map(
  Object.entries(REGION_CONFIGS).map(([id, config]) => [
    id,
    buildBasemapLineOverlays(normalizedByRegion.get(id), config),
  ]),
);

function overlayOf(regionId, slug) {
  const lineId = REGION_CONFIGS[regionId].slugToLineId[slug];
  const overlay = overlaysByRegion.get(regionId).find((entry) => entry.lineId === lineId);
  assert.ok(overlay, `${regionId}/${slug}: 강조 레이어가 없다`);
  return overlay.svg;
}

const hasElement = (svg, id) => svg.includes(`id="${id}"`);

// 마크업 토큰(태그 하나 또는 공백 아닌 글자 덩어리) 열. 강조 레이어가 바탕
// 입력에서 요소를 지우기만 했다면 레이어 토큰 열은 바탕 토큰 열의 부분 수열이다.
// 지운 요소 양옆 공백은 합쳐지므로 공백 덩어리는 비교하지 않는다.
function markupTokens(svg) {
  return (svg.match(/<[^>]*>|[^<]+/g) ?? []).filter((token) => token.trim() !== "");
}

function isTokenSubsequence(sub, full) {
  let cursor = 0;
  for (const token of sub) {
    while (cursor < full.length && full[cursor] !== token) cursor += 1;
    if (cursor === full.length) return false;
    cursor += 1;
  }
  return true;
}

const SYNTHETIC_CONFIG = {
  id: "synthetic",
  slugToSuffix: { a: "A", b: "B" },
  slugToLineId: { a: "line-a", b: "line-b" },
  missingLineHint: {},
  basemapElementRules: [],
};

function syntheticSvg(body) {
  return `<svg viewBox="0 0 10 10"><defs><clipPath id="c"><rect width="1" height="1"/></clipPath></defs>${body}</svg>`;
}

test("슬러그→lines.id 등록부는 기존 이름 규칙(접두+접미)으로 찾은 픽스처 팩 노선 id와 같다", () => {
  const { db, dir } = openPack(
    "apps/mobile/assets/datapacks/capital.sqlite.gz",
    "basemap-line-overlays-",
  );
  try {
    for (const config of Object.values(REGION_CONFIGS)) {
      assert.deepEqual(
        Object.keys(config.slugToLineId).sort(),
        Object.keys(config.slugToSuffix).sort(),
        `${config.id}: 등록부 슬러그가 slugToSuffix와 다르다`,
      );
      assert.deepEqual(
        Object.fromEntries(resolveLineMap(db, config)),
        config.slugToLineId,
        `${config.id}: 등록부가 이름 규칙 결과와 다르다`,
      );
    }
  } finally {
    db.close();
    cleanupPackDir(dir);
  }
});

test("슬러그→lines.id 등록부는 전국 정본 팩의 노선도 트랙 노선과 일대일이다", () => {
  const canonical = JSON.parse(
    readFileSync(
      path.join(root, "tools/datapack/release/nationwide-production-canonical-pack.json"),
      "utf8",
    ),
  );
  const pack = canonical.packs.find(({ id }) => id === canonical.manifest.activePack.id);
  const packLineIds = new Set(pack.lines.map(({ id }) => id));
  for (const config of Object.values(REGION_CONFIGS)) {
    const registered = Object.values(config.slugToLineId);
    assert.equal(new Set(registered).size, registered.length, `${config.id}: 한 노선 id에 슬러그가 둘 이상이다`);
    for (const lineId of registered) {
      assert.ok(packLineIds.has(lineId), `${config.id}: ${lineId}가 전국 팩 lines에 없다`);
    }
    const trackLineIds = new Set(
      pack.routeMapLineTracks
        .filter(({ region }) => region === config.regionKey)
        .map(({ lineId }) => lineId),
    );
    assert.deepEqual(
      [...registered].sort(),
      [...trackLineIds].sort(),
      `${config.id}: 등록부와 노선도 트랙 노선이 다르다`,
    );
  }
});

test("5권역 모든 노선이 강조 레이어를 갖고, 레이어는 바탕 컴파일 입력에서 요소를 지우기만 한다", () => {
  for (const [regionId, config] of Object.entries(REGION_CONFIGS)) {
    const overlays = overlaysByRegion.get(regionId);
    assert.deepEqual(
      overlays.map(({ lineId }) => lineId),
      Object.values(config.slugToLineId).sort(),
      `${regionId}: 강조 레이어 노선 id 목록`,
    );
    const baseTokens = markupTokens(normalizedByRegion.get(regionId));
    for (const overlay of overlays) {
      assert.equal(config.slugToLineId[overlay.svgLineSlug], overlay.lineId);
      assert.ok(
        overlay.svg.length < normalizedByRegion.get(regionId).length,
        `${regionId}/${overlay.lineId}: 레이어가 바탕보다 작아야 한다`,
      );
      assert.ok(
        isTokenSubsequence(markupTokens(overlay.svg), baseTokens),
        `${regionId}/${overlay.lineId}: 바탕 입력에 없는 마크업이 생겼다`,
      );
    }
  }
});

test("수도권 2호선 레이어에는 2호선 노선·환승역·역명만 있고 다른 노선 전용 요소와 캔버스는 없다", () => {
  const line2 = overlayOf("seoul", "2");
  for (const id of ["route-line-2", "transfer-station-symbol-시청", "station-label-시청", "station-label-강남", "station-label-신도림"]) {
    assert.ok(hasElement(line2, id), `2호선 레이어에 ${id}가 없다`);
  }
  for (const id of ["route-line-1", "route-line-9", "station-label-소요산", "page-background", "background-grid-overlay"]) {
    assert.ok(!hasElement(line2, id), `2호선 레이어에 ${id}가 있다`);
  }
  assert.ok(!/id="logo-(?:ktx|srt)-[^"]*path/.test(line2), "2호선 레이어에 KTX·SRT 표장 도형이 있다");
});

// 기대값은 오너 SVG 실측이다. 역명 id의 노선 접미(_DH 등)는 복사 흔적이라 믿지
// 않는다. 부산 부전은 id와 반대다: `station-label-ubd80-uc804`(x 5690, 왼쪽 정렬)는
// 동해선 부전 심벌(파란 테, 중심 ≈ 5817,3938) 바로 왼쪽에, `station-label-부전-DH`
// (x 6361, 오른쪽 정렬)는 1호선 부전 심벌(주황 테, 중심 ≈ 6233,4157) 바로 오른쪽에 있다.
test("같은 이름의 별개 역 역명은 가장 가까운 같은 이름 역 심벌의 노선 레이어에만 들어간다", () => {
  const cases = [
    ["seoul", "5", "station-label-양평-5호선", "station-label-양평-경의중앙선"],
    ["seoul", "gyeongui-jungang", "station-label-양평-경의중앙선", "station-label-양평-5호선"],
    ["busan", "line1", "station-label-uc88c-ucc9c_1", "station-label-uc88c-ucc9c_DH"],
    ["busan", "donghae", "station-label-uc88c-ucc9c_DH", "station-label-uc88c-ucc9c_1"],
    ["busan", "line1", "station-label-부전-DH", "station-label-ubd80-uc804"],
    ["busan", "donghae", "station-label-ubd80-uc804", "station-label-부전-DH"],
    ["busan", "line4", "station-label-ub3d9-ub798_M", "station-label-ub3d9-ub798_DH"],
    ["busan", "donghae", "station-label-ub3d9-ub798_DH", "station-label-ub3d9-ub798_M"],
  ];
  for (const [regionId, slug, present, absent] of cases) {
    const overlay = overlayOf(regionId, slug);
    assert.ok(hasElement(overlay, present), `${regionId}/${slug}: ${present}가 없다`);
    assert.ok(!hasElement(overlay, absent), `${regionId}/${slug}: ${absent}가 있다`);
  }
});

test("노선 소속을 정할 수 없는 그려지는 요소는 빌드를 실패시킨다", () => {
  const svg = syntheticSvg(
    '<g data-line="a"><path d="M0 0L1 1"/></g><g data-line="b"><path d="M0 0L1 2"/></g><path id="stray" d="M0 0L2 2"/>',
  );
  assert.throws(() => buildBasemapLineOverlays(svg, SYNTHETIC_CONFIG), /stray/);
});

test("data-line·data-transfer-lines의 등록되지 않은 슬러그는 빌드를 실패시킨다", () => {
  const unknownTransfer = syntheticSvg(
    '<g data-line="a"><path d="M0 0L1 1"/></g><g data-line="b"><path d="M0 0L1 2"/></g><g id="cap" data-transfer-lines="a zz"><circle r="1"/></g>',
  );
  assert.throws(() => buildBasemapLineOverlays(unknownTransfer, SYNTHETIC_CONFIG), /zz/);
  const unknownLine = syntheticSvg(
    '<g data-line="a"><path d="M0 0L1 1"/></g><g data-line="b"><path d="M0 0L1 2"/></g><path id="ghost" data-line="zz" d="M0 0L2 2"/>',
  );
  assert.throws(() => buildBasemapLineOverlays(unknownLine, SYNTHETIC_CONFIG), /zz/);
});

test("아무 요소에도 맞지 않는 명시 분류 규칙은 빌드를 실패시킨다", () => {
  const svg = syntheticSvg('<g data-line="a"><path d="M0 0L1 1"/></g><g data-line="b"><path d="M0 0L1 2"/></g>');
  const config = {
    ...SYNTHETIC_CONFIG,
    basemapElementRules: [{ match: { id: "retired-layer" }, lines: [], reason: "없어진 레이어" }],
  };
  assert.throws(() => buildBasemapLineOverlays(svg, config), /retired-layer/);
});

test("그려지는 요소가 하나도 없는 노선은 빈 레이어 대신 빌드를 실패시킨다", () => {
  const svg = syntheticSvg('<g data-line="a"><path d="M0 0L1 1"/></g>');
  assert.throws(() => buildBasemapLineOverlays(svg, SYNTHETIC_CONFIG), /\bb\b/);
});

test("명시 분류 규칙은 노선 없는 요소를 레이어에서 빼고, 노선 지정 요소를 그 노선 레이어에 넣는다", () => {
  const svg = syntheticSvg(
    '<rect id="canvas" width="10" height="10"/><g data-line="a"><path d="M0 0L1 1"/></g><g class="terminal-badge" id="badge"><circle r="1"/></g>',
  );
  const config = {
    ...SYNTHETIC_CONFIG,
    slugToSuffix: { a: "A" },
    slugToLineId: { a: "line-a" },
    basemapElementRules: [
      { match: { id: "canvas" }, lines: [], reason: "캔버스" },
      { match: { className: "terminal-badge" }, lines: ["a"], reason: "a 종점 배지" },
    ],
  };
  const [overlay] = buildBasemapLineOverlays(svg, config);
  assert.ok(!hasElement(overlay.svg, "canvas"));
  assert.ok(hasElement(overlay.svg, "badge"));
  assert.ok(overlay.svg.includes('<clipPath id="c">'), "그리지 않는 정의(defs)는 남는다");
});

test("색인은 권역별 데이터팩 노선 id를 강조 레이어 파일에 잇는다", () => {
  const regions = [...overlaysByRegion].map(([id, overlays]) => ({ id, overlays }));
  const index = JSON.parse(buildLineOverlayIndex(regions));
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.artifactKind, "route-map-basemap-line-overlays");
  assert.deepEqual(Object.keys(index.regions).sort(), Object.keys(REGION_CONFIGS).sort());
  for (const [regionId, config] of Object.entries(REGION_CONFIGS)) {
    const region = index.regions[regionId];
    assert.equal(region.baseVector, `${regionId}.vec`);
    assert.deepEqual(Object.keys(region.lines), Object.values(config.slugToLineId).sort());
    for (const [slug, lineId] of Object.entries(config.slugToLineId)) {
      assert.deepEqual(region.lines[lineId], {
        svgLineSlug: slug,
        vector: lineOverlayVectorFileName(regionId, lineId),
      });
    }
  }
  assert.equal(lineOverlayVectorFileName("seoul", "seoul-2"), "seoul.seoul-2.vec");
});

// 커밋된 manifest sha는 이전 컴파일 실행이 고정한 값이라, 다시 만든 레이어 입력과
// 색인이 바이트 단위로 같다는 결정성 검사도 겸한다.
test("build manifest가 기록한 강조 레이어 컴파일 입력 sha·색인 sha와 다시 만든 결과가 같다", () => {
  assert.equal(manifest.pipelineRevision, 3);
  assert.equal(manifest.content.lineOverlays, "per-line-vec-over-faded-basemap");
  const basemapDir = "apps/mobile/assets/datapacks/metro_map_pack/basemap";
  for (const map of manifest.maps) {
    const overlays = overlaysByRegion.get(map.id);
    assert.deepEqual(
      map.lineOverlays.map(({ lineId, svgLineSlug }) => ({ lineId, svgLineSlug })),
      overlays.map(({ lineId, svgLineSlug }) => ({ lineId, svgLineSlug })),
      `${map.id}: manifest 강조 레이어 목록`,
    );
    for (const [index, entry] of map.lineOverlays.entries()) {
      assert.equal(entry.compiledVector, `${basemapDir}/${lineOverlayVectorFileName(map.id, entry.lineId)}`);
      assert.equal(entry.normalizedSvgSha256, sha256(overlays[index].svg), `${map.id}/${entry.lineId}`);
      assert.match(entry.compiledVectorSha256, /^[0-9a-f]{64}$/);
    }
  }
  const regions = [...overlaysByRegion].map(([id, overlays]) => ({ id, overlays }));
  assert.deepEqual(manifest.lineOverlaysSidecar, {
    path: `${basemapDir}/${LINE_OVERLAY_INDEX_FILE}`,
    sha256: sha256(buildLineOverlayIndex(regions)),
  });
});
