import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { resolveLineMap } from "./apply-sma-svg-positions.mjs";
import { basemapVariant, basemapVectorFileName, BASEMAP_VARIANTS, parseBasemapVectorFileName } from "./basemap-variants.mjs";
import {
  LINE_OVERLAY_INDEX_FILE,
  basemapCompileJobs,
  buildBasemapLineOverlays,
  buildLineOverlayIndex,
  mergeVariantDraws,
  normalizeSvgForCompile,
  variantManifestEntry,
} from "./compile-basemap-vec.mjs";
import { cleanupPackDir, openPack } from "./pack-io.mjs";
import { REGION_CONFIGS } from "./sma-region-configs.mjs";
import { decodeVec, encodeVec, VERB } from "./vec-codec.mjs";

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

test("data-transfer-lines는 같은 이름 역 심벌의 노선보다 먼저 쓴다", () => {
  const svg = syntheticSvg(
    '<g data-line="b"><path d="M0 0L1 2"/></g>' +
      '<circle id="sym" data-node-role="ordinary" data-station="X" data-line="a" r="1"/>' +
      '<g id="capsule" data-station="X" data-transfer-lines="a b"><circle r="1"/></g>',
  );
  const overlays = buildBasemapLineOverlays(svg, SYNTHETIC_CONFIG);
  const lineB = overlays.find(({ svgLineSlug }) => svgLineSlug === "b");
  assert.ok(hasElement(lineB.svg, "capsule"), "b 레이어에 a·b 환승 심벌이 없다");
  assert.ok(!hasElement(lineB.svg, "sym"), "b 레이어에 a 전용 심벌이 있다");
});

// 한 역을 심벌 둘로 그린 경우(김포공항: 5개 노선 캡슐 + 공항철도만 든 픽토그램)다.
// 심벌이 둘이어도 역은 하나라, 역명은 두 심벌의 노선 합집합 레이어에 모두 있어야 한다.
// 라벨이 단일 노선 심벌 쪽으로 옮겨져도 다른 노선 레이어에서 사라지면 안 된다.
function oneStationTwoSymbolsSvg(labelX) {
  return syntheticSvg(
    '<g data-line="a"><path d="M0 0L1 1"/></g><g data-line="b"><path d="M0 0L1 2"/></g>' +
      '<g id="capsule" data-node-role="transfer" data-station="X" data-transfer-lines="a b"><circle cx="0" cy="0" r="1"/></g>' +
      '<g id="pictogram" data-node-role="transfer" data-station="X" data-transfer-lines="a"><circle cx="8" cy="0" r="1"/></g>' +
      `<text id="label-X" data-station="X" x="${labelX}" y="0">X</text>`,
  );
}

function layerOf(overlays, slug) {
  return overlays.find(({ svgLineSlug }) => svgLineSlug === slug).svg;
}

test("등록되지 않은 같은 이름 심벌은 한 역이라 역명이 라벨 위치와 상관없이 두 심벌 노선의 합집합 레이어에 있다", () => {
  for (const labelX of [0.5, 7.5]) {
    const overlays = buildBasemapLineOverlays(oneStationTwoSymbolsSvg(labelX), SYNTHETIC_CONFIG);
    for (const slug of ["a", "b"]) {
      assert.ok(hasElement(layerOf(overlays, slug), "label-X"), `라벨 x=${labelX}: ${slug} 레이어에 역명이 없다`);
    }
  }
});

test("동명 별개역으로 등록된 이름은 가장 가까운 심벌의 노선 레이어에만 역명이 들어간다", () => {
  const config = { ...SYNTHETIC_CONFIG, distinctSameNameStations: new Set(["X"]) };
  const nearPictogram = buildBasemapLineOverlays(oneStationTwoSymbolsSvg(7.5), config);
  assert.ok(hasElement(layerOf(nearPictogram, "a"), "label-X"));
  assert.ok(!hasElement(layerOf(nearPictogram, "b"), "label-X"));
  const nearCapsule = buildBasemapLineOverlays(oneStationTwoSymbolsSvg(0.5), config);
  assert.ok(hasElement(layerOf(nearCapsule, "a"), "label-X"));
  assert.ok(hasElement(layerOf(nearCapsule, "b"), "label-X"));
});

test("동명 별개역으로 등록된 이름의 심벌이 둘 미만이면 빌드를 실패시킨다", () => {
  const config = { ...SYNTHETIC_CONFIG, distinctSameNameStations: new Set(["X"]) };
  const oneSymbol = syntheticSvg(
    '<g data-line="a"><path d="M0 0L1 1"/></g><g data-line="b"><path d="M0 0L1 2"/></g>' +
      '<g id="capsule" data-node-role="transfer" data-station="X" data-transfer-lines="a b"><circle cx="0" cy="0" r="1"/></g>' +
      '<text id="label-X" data-station="X" x="0.5" y="0">X</text>',
  );
  assert.throws(() => buildBasemapLineOverlays(oneSymbol, config), /"X"/);
});

// 기대값은 오너 SVG 실측이다. 김포공항 캡슐(transfer-station-symbol-김포공항)의
// data-transfer-lines가 역의 노선 정본이고, 신촌은 라벨이 달고 있는 data-station
// ("신촌(경의중앙선)")과 심벌 data-line이 가리키는 노선이 정본이다.
test("수도권 김포공항 역명은 캡슐이 나열한 모든 노선 레이어에 있고 그 밖의 노선에는 없다", () => {
  const source = readFileSync(path.join(root, manifest.maps.find(({ id }) => id === "seoul").source), "utf8");
  const capsule = source.match(/id="transfer-station-symbol-김포공항"[^>]*?data-transfer-lines="([^"]+)"/s);
  assert.ok(capsule, "SVG에 김포공항 캡슐이 없다");
  const capsuleLines = new Set(capsule[1].trim().split(/\s+/));
  assert.equal(capsuleLines.size, 5);
  for (const slug of Object.keys(REGION_CONFIGS.seoul.slugToLineId)) {
    assert.equal(
      hasElement(overlayOf("seoul", slug), "station-label-김포공항"),
      capsuleLines.has(slug),
      `seoul/${slug}: 김포공항 역명 소속`,
    );
  }
});

test("수도권 신촌 두 역의 역명은 각자 노선 레이어에만 있다", () => {
  const cases = [
    ["2", "station-label-신촌-2호선", "station-label-신촌-경의중앙선"],
    ["gyeongui-jungang", "station-label-신촌-경의중앙선", "station-label-신촌-2호선"],
  ];
  for (const [slug, present, absent] of cases) {
    const overlay = overlayOf("seoul", slug);
    assert.ok(hasElement(overlay, present), `seoul/${slug}: ${present}가 없다`);
    assert.ok(!hasElement(overlay, absent), `seoul/${slug}: ${absent}가 있다`);
  }
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

const fakeDigest = (fileName) => sha256(`vec:${fileName}`);

function digestsOf(regions) {
  return new Map(
    BASEMAP_VARIANTS.flatMap(({ id: variantId }) =>
      regions.flatMap(({ id, overlays }) =>
        [null, ...overlays.map(({ lineId }) => lineId)].map((lineId) => {
          const fileName = basemapVectorFileName(variantId, id, lineId);
          return [fileName, fakeDigest(fileName)];
        }),
      ),
    ),
  );
}

// 앱은 렌더러에 맞는 변형을 고르고, 그 변형 아래는 변형을 나누기 전 색인(schemaVersion 1의 regions)과
// 같은 모양에 파일 sha256을 더한 것이다. outlined 파일 이름은 나누기 전 그대로다.
test("색인은 변형마다 권역 바탕과 데이터팩 노선 id를 강조 레이어 파일과 sha256에 잇는다", () => {
  const regions = [...overlaysByRegion].map(([id, overlays]) => ({ id, overlays }));
  const index = JSON.parse(buildLineOverlayIndex(regions, digestsOf(regions)));
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.artifactKind, "route-map-basemap-line-overlays");
  assert.deepEqual(Object.keys(index), ["schemaVersion", "artifactKind", "variants"]);
  assert.deepEqual(
    Object.entries(index.variants).map(([id, { labels }]) => [id, labels]),
    [["outlined", "outlined-into-vec"], ["text", "text-into-vec"]],
  );
  for (const [variantId, { regions: byRegion }] of Object.entries(index.variants)) {
    assert.deepEqual(Object.keys(byRegion), Object.keys(REGION_CONFIGS).sort());
    for (const [regionId, config] of Object.entries(REGION_CONFIGS)) {
      const region = byRegion[regionId];
      const baseVector = variantId === "outlined" ? `${regionId}.vec` : `${regionId}.text.vec`;
      assert.deepEqual([region.baseVector, region.baseVectorSha256], [baseVector, fakeDigest(baseVector)]);
      assert.deepEqual(Object.keys(region.lines), Object.values(config.slugToLineId).sort());
      for (const [slug, lineId] of Object.entries(config.slugToLineId)) {
        const vector = variantId === "outlined" ? `${regionId}.${lineId}.vec` : `${regionId}.${lineId}.text.vec`;
        assert.deepEqual(region.lines[lineId], { svgLineSlug: slug, vector, sha256: fakeDigest(vector) });
        assert.deepEqual(parseBasemapVectorFileName(vector), { variantId, regionId, lineId });
      }
      assert.deepEqual(parseBasemapVectorFileName(baseVector), { variantId, regionId, lineId: null });
    }
  }
});

test("색인은 컴파일 산출 sha256이 없는 파일을 빈 값으로 두지 않고 실패한다", () => {
  const regions = [...overlaysByRegion].map(([id, overlays]) => ({ id, overlays }));
  const digests = digestsOf(regions);
  digests.delete("busan.text.vec");
  assert.throws(() => buildLineOverlayIndex(regions, digests), /busan\.text\.vec: 컴파일 산출 sha256이 없습니다/);
});

// 노선 id가 변형 접미와 같으면 텍스트 변형 바탕과 윤곽선 변형 강조 레이어가 같은 파일 이름을 쓴다.
// 한쪽이 다른 쪽을 조용히 덮어쓰지 않게 컴파일 작업을 만들 때 실패한다.
test("변형과 노선을 합친 컴파일 파일 이름이 겹치면 작업을 만들지 않고 실패한다", () => {
  const prepared = (lineId) => ({
    region: { id: "seoul" },
    normalizedSvg: "<svg/>",
    lineOverlays: [{ lineId, svgLineSlug: "x", svg: "<svg/>" }],
  });
  const outline = (svg) => ({ svg: `${svg}<!--outlined-->` });
  const jobs = basemapCompileJobs([prepared("line-a")], outline);
  assert.deepEqual(
    jobs.map(({ variantId, fileName, compileInputSvg }) => [variantId, fileName, compileInputSvg]),
    [
      ["outlined", "seoul.vec", "<svg/><!--outlined-->"],
      ["outlined", "seoul.line-a.vec", "<svg/><!--outlined-->"],
      ["text", "seoul.text.vec", "<svg/>"],
      ["text", "seoul.line-a.text.vec", "<svg/>"],
    ],
  );
  assert.throws(() => basemapCompileJobs([prepared("text")], outline), /seoul\.text\.vec/);
});

// 파일 이름 `<권역>.<노선>.text.vec`는 점으로 나뉘고 `.text`로 변형을 가린다. 점이나 변형 접미가 든 id는
// 되읽을 때 다른 권역·노선·변형으로 읽히므로 작업을 만들 때 실패한다.
test("권역·노선 id에 점이 있으면 되읽을 때 틀리게 읽히므로 컴파일 작업을 만들지 않고 실패한다", () => {
  const outline = (svg) => ({ svg });
  const prepared = (regionId, lineId) => ({
    region: { id: regionId },
    normalizedSvg: "<svg/>",
    lineOverlays: lineId === null ? [] : [{ lineId, svgLineSlug: "x", svg: "<svg/>" }],
  });
  for (const lineId of ["line.a", "line-a.text", "", "Line-A", "-a"]) {
    assert.throws(() => basemapCompileJobs([prepared("seoul", lineId)], outline), /노선 id/, `노선 id ${JSON.stringify(lineId)}`);
  }
  for (const regionId of ["seoul.text", "se.oul", ""]) {
    assert.throws(() => basemapCompileJobs([prepared(regionId, null)], outline), /권역 id/, `권역 id ${JSON.stringify(regionId)}`);
  }
  let jobs;
  assert.doesNotThrow(() => {
    jobs = basemapCompileJobs([prepared("seoul", "seoul-2"), prepared("busan", "line-ab1a041f6266")], outline);
  });
  assert.equal(jobs.length, 8, "정상 id는 변형 2 × 권역 2 × (바탕 1 + 노선 1)만큼 작업이 된다");
});

// 그리기 합치기는 렌더러에 따라 이득이 갈린다. Impeller(윤곽선 변형)는 명령 수가 줄어 빨라지지만
// Skia OpenGL(텍스트 변형)은 이은 다중 윤곽선 path를 매 프레임 다시 처리해 느려졌다(Galaxy A17 실측).
// 변형 등록부의 mergeDraws 하나가 컴파일 파이프라인의 합치기 여부를 정한다.
const FILL = { style: "fill", color: 0xff112233, blendMode: 3, shaderId: null };
const square = (x) => ({
  fillType: 0,
  verbs: Uint8Array.of(VERB.moveTo, VERB.lineTo, VERB.lineTo, VERB.lineTo, VERB.close),
  points: Float32Array.of(x, 0, x + 10, 0, x + 10, 10, x, 10),
});
const disjointSquares = () =>
  decodeVec(
    encodeVec({
      width: 100,
      height: 100,
      paints: [FILL],
      paths: [square(0), square(20), square(40)],
      commands: [0, 1, 2].map((pathId) => ({ op: "drawPath", pathId, paintId: 0, patternId: null })),
    }),
  );

test("변형 등록부의 mergeDraws가 합치기 여부를 정한다(윤곽선은 합치고 텍스트는 합치지 않는다)", () => {
  assert.deepEqual(
    BASEMAP_VARIANTS.map(({ id, mergeDraws }) => [id, mergeDraws]),
    [["outlined", true], ["text", false]],
  );
  for (const { id, mergeDraws } of BASEMAP_VARIANTS) {
    const { base, layers } = mergeVariantDraws(id, disjointSquares(), [{ name: "line", doc: disjointSquares() }]);
    const expected = mergeDraws ? 1 : 3;
    assert.equal(base.commands.length, expected, `${id} 바탕 그리기 수`);
    assert.equal(layers[0].doc.commands.length, expected, `${id} 강조 레이어 그리기 수`);
  }
});

test("모든 변형의 mergeDraws는 불리언이고, 알 수 없는 변형은 실패한다", () => {
  for (const { id, mergeDraws } of BASEMAP_VARIANTS) assert.equal(typeof mergeDraws, "boolean", id);
  assert.throws(() => mergeVariantDraws("unknown", disjointSquares(), []), /알 수 없는 바탕층 변형/);
});

// 텍스트 변형은 .vec 텍스트 설정이 서체 이름 하나만 담으므로 CSS 서체 목록을 첫 서체로 줄인다.
// 윤곽선 단계(outline-basemap-text.mjs)가 쓰는 규칙과 같다. 속성과 style 선언을 모두 줄이고
// 서체 목록이 아닌 마크업은 그대로 둔다.
test("텍스트 변형은 컴파일 입력의 CSS 서체 목록을 첫 서체 하나로 줄이고 나머지 마크업은 그대로 둔다", () => {
  const { compileInput } = basemapVariant("text");
  const reduced = compileInput(
    '<svg><g font-family="Pretendard, &quot;Noto Sans CJK KR&quot;, sans-serif">' +
      '<text x="1" font-family="\'Pretendard\', sans-serif">a</text>' +
      '<text style="fill:#000;font-family:Pretendard, \'Noto Sans\', sans-serif;font-size:9px">b</text>' +
      '<text font-family="Pretendard">c</text></g></svg>',
  );
  assert.equal(
    reduced,
    '<svg><g font-family="Pretendard">' +
      '<text x="1" font-family="Pretendard">a</text>' +
      '<text style="fill:#000;font-family:Pretendard;font-size:9px">b</text>' +
      '<text font-family="Pretendard">c</text></g></svg>',
  );
});

test("텍스트 변형은 첫 서체 이름에 XML 특수문자가 있으면 이스케이프하고, 서체 선언이 없으면 입력을 그대로 둔다", () => {
  const { compileInput } = basemapVariant("text");
  assert.equal(compileInput("<svg><text>a</text></svg>"), "<svg><text>a</text></svg>");
  assert.equal(
    compileInput('<svg><text font-family="&quot;A &amp; B&quot;, serif">a</text></svg>'),
    '<svg><text font-family="A &amp; B">a</text></svg>',
  );
});

// manifest 항목은 변형·파일 이름으로 sha를 조회한다. 조회가 비면 undefined가 JSON에서 사라져
// 항목이 조용히 불완전해지므로 색인(buildLineOverlayIndex)처럼 실패한다.
test("변형 manifest 항목은 컴파일 입력·산출 sha256이 없는 파일이 있으면 빈 값으로 두지 않고 실패한다", () => {
  const region = { id: "seoul" };
  const overlays = [{ lineId: "seoul-2" }];
  const names = ["seoul.text.vec", "seoul.seoul-2.text.vec"];
  const full = (extra) => new Map(names.map((name) => [name, `${name}-${extra}`]));
  const entry = variantManifestEntry("text", region, overlays, full("input"), full("vec"));
  assert.equal(entry.compileInputSvgSha256, "seoul.text.vec-input");
  assert.equal(entry.lineOverlays[0].compiledVectorSha256, "seoul.seoul-2.text.vec-vec");

  const noInput = full("input");
  noInput.delete("seoul.seoul-2.text.vec");
  assert.throws(
    () => variantManifestEntry("text", region, overlays, noInput, full("vec")),
    /seoul\.seoul-2\.text\.vec: 컴파일 입력 sha256이 없습니다/,
  );
  const noVec = full("vec");
  noVec.delete("seoul.text.vec");
  assert.throws(
    () => variantManifestEntry("text", region, overlays, full("input"), noVec),
    /seoul\.text\.vec: 컴파일 산출 sha256이 없습니다/,
  );
});

// 커밋된 manifest sha는 이전 컴파일 실행이 고정한 값이라, 다시 만든 레이어 입력과
// 색인이 바이트 단위로 같다는 결정성 검사도 겸한다.
test("build manifest가 기록한 변형별 강조 레이어 파일·색인 sha와 다시 만든 결과가 같다", () => {
  assert.equal(manifest.pipelineRevision, 8);
  assert.equal(manifest.content.lineOverlays, "per-line-vec-over-faded-basemap");
  const basemapDir = "apps/mobile/assets/datapacks/metro_map_pack/basemap";
  const digests = new Map();
  for (const map of manifest.maps) {
    const overlays = overlaysByRegion.get(map.id);
    assert.deepEqual(
      map.lineOverlays,
      overlays.map(({ lineId, svgLineSlug, svg }) => ({ lineId, svgLineSlug, normalizedSvgSha256: sha256(svg) })),
      `${map.id}: manifest 강조 레이어 목록`,
    );
    assert.deepEqual(Object.keys(map.variants), BASEMAP_VARIANTS.map(({ id }) => id));
    for (const [variantId, variant] of Object.entries(map.variants)) {
      assert.equal(variant.compiledVector, `${basemapDir}/${basemapVectorFileName(variantId, map.id)}`);
      digests.set(path.basename(variant.compiledVector), variant.compiledVectorSha256);
      assert.deepEqual(
        variant.lineOverlays.map(({ lineId }) => lineId),
        overlays.map(({ lineId }) => lineId),
        `${map.id}/${variantId}: 강조 레이어 목록`,
      );
      for (const entry of variant.lineOverlays) {
        assert.equal(entry.compiledVector, `${basemapDir}/${basemapVectorFileName(variantId, map.id, entry.lineId)}`);
        assert.match(entry.compiledVectorSha256, /^[0-9a-f]{64}$/);
        digests.set(path.basename(entry.compiledVector), entry.compiledVectorSha256);
      }
    }
  }
  const regions = [...overlaysByRegion].map(([id, overlays]) => ({ id, overlays }));
  const index = buildLineOverlayIndex(regions, digests);
  assert.deepEqual(manifest.lineOverlaysSidecar, {
    path: `${basemapDir}/${LINE_OVERLAY_INDEX_FILE}`,
    sha256: sha256(index),
  });
  assert.equal(readFileSync(path.join(root, basemapDir, LINE_OVERLAY_INDEX_FILE), "utf8"), index);
  for (const [fileName, digest] of digests) {
    assert.equal(sha256(readFileSync(path.join(root, basemapDir, fileName))), digest, fileName);
  }
});
