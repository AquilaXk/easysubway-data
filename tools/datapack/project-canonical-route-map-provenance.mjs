import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/u;
const DORASAN = Object.freeze({
  stationId: "station-4c48e8115728",
  lineId: "line-6e39be0cb6e2",
  x: 1449,
  y: 763,
  sourceId: "qa-wikimedia-seoul-svg-coordinate",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Seoul_subway_linemap_ko.svg",
});
const DORASAN_OLD = Object.freeze({
  x: 1492.231,
  y: 753.307,
  upPath: "M 836 334 L 1492.231 753.307",
  labelPolygon: [{ x: 1483, y: 742 }, { x: 1534, y: 742 }, { x: 1534, y: 764 }, { x: 1483, y: 764 }],
});
const DORASAN_PROJECTED = Object.freeze({
  upPath: "M 836 334 L 1449 763",
  labelPolygon: [{ x: 1439.769, y: 751.693 }, { x: 1490.769, y: 751.693 }, { x: 1490.769, y: 773.693 }, { x: 1439.769, y: 773.693 }],
});
const DORASAN_LABEL_DELTA = Object.freeze({ x: -43.231, y: 9.693 });
const OWNER_SOURCES = Object.freeze([
  ["tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v4.svg", "821b636eac0f3b04c5baa995d39ae938d7648d04f7c32802fbef22e60537bf08"],
  ["tools/route-map/route-map-defs/svg-sources/easy-subway-busan-v3.svg", "8bd04aa7e94c8e6cd5c1a2dd83fda605e7d892bc66078db57ba8291cee80cdb0"],
  ["tools/route-map/route-map-defs/svg-sources/easy-subway-daegu-v3.svg", "145804d2c9d1de679d7d63937c942b714af02a6ed58562969b5ace5a0f077874"],
  ["tools/route-map/route-map-defs/svg-sources/easy-subway-daejeon-v3.svg", "f0b1c04e6f5ee390738414702e9a4b60fd6e77ddcc775eb08b66e740af5839b8"],
  ["tools/route-map/route-map-defs/svg-sources/easy-subway-gwangju-v3.svg", "3cb836387f9be56398a9a8d09ea85c3af142140182daddca24a1a7385645d7a7"],
]);
const BUSAN_RECEIPT = Object.freeze({
  region: "부산권",
  lineId: "line-eb7b47920390",
  x: 6597,
  y: 4425,
  stationIds: ["station-080c154ce646", "station-61f6dbfb5d4b"],
  sourceSha256: "8bd04aa7e94c8e6cd5c1a2dd83fda605e7d892bc66078db57ba8291cee80cdb0",
  reason: "동일 tracked Busan v3 SVG source coordinate의 owner-approved two-station overlap",
  reviewedAt: "2026-08-15T00:00:00.000Z",
  reviewedBy: "Owner",
  reviewSource: "https://github.com/AquilaXk/easysubway-data/issues/309",
});

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function ownerSourceShaByUrl(manifest) {
  if (!Array.isArray(manifest?.maps)) throw new Error("route-map basemap manifest identity is invalid");
  const expected = new Map(OWNER_SOURCES);
  const actual = new Map(manifest.maps.map(({ source, sourceSvgSha256 }) => [source, sourceSvgSha256]));
  if (actual.size !== manifest.maps.length || expected.size !== actual.size
    || [...expected].some(([source, sourceSha256]) => actual.get(source) !== sourceSha256)) {
    throw new Error("route-map basemap manifest identity is invalid");
  }
  return new Map(OWNER_SOURCES.map(([source, sourceSha256]) => [`internal:route-map/${source.replace("tools/route-map/", "")}`, sourceSha256]));
}

function parseDorasanCsv(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error("Dorasan CSV identity is invalid");
  const rows = bytes.toString("utf8").trimEnd().split("\n");
  const header = rows.shift();
  if (header !== "station_id,line_id,x,y,station_name_ko,label_dx,label_dy,source_id,source_url") {
    throw new Error("Dorasan CSV identity is invalid");
  }
  const matches = rows.map((row) => row.split(",")).filter(([stationId, lineId]) =>
    stationId === DORASAN.stationId && lineId === DORASAN.lineId,
  );
  if (matches.length !== 1) throw new Error("Dorasan CSV identity is invalid");
  const [stationId, lineId, x, y, stationName, labelDx, labelDy, sourceId, sourceUrl] = matches[0];
  if (stationId !== DORASAN.stationId || lineId !== DORASAN.lineId
    || x !== "1449" || y !== "763" || stationName !== '"도라산"'
    || labelDx !== "0" || labelDy !== "0" || sourceId !== DORASAN.sourceId
    || sourceUrl !== DORASAN.sourceUrl) {
    throw new Error("Dorasan CSV identity is invalid");
  }
  return sha256(bytes);
}

function validateBusanReceipt(reviewedAmbiguities) {
  const entries = reviewedAmbiguities?.reviewedAmbiguities;
  if (!Array.isArray(entries)) throw new Error("Busan duplicate receipt is invalid");
  const candidates = entries.filter(({ lineId }) => lineId === BUSAN_RECEIPT.lineId);
  if (candidates.length !== 1) throw new Error("Busan duplicate receipt is invalid");
  const receipt = candidates[0];
  if (!same({
    region: receipt.region,
    lineId: receipt.lineId,
    x: receipt.x,
    y: receipt.y,
    stationIds: receipt.stationIds,
    sourceSha256: receipt.sourceSha256,
    reason: receipt.reason,
    reviewedAt: receipt.reviewedAt,
    reviewedBy: receipt.reviewedBy,
    reviewSource: receipt.reviewSource,
  }, BUSAN_RECEIPT)) {
    throw new Error("Busan duplicate receipt is invalid");
  }
}

function validateBusanCanonicalRows(positions) {
  const rows = positions.filter(({ region, lineId, x, y }) =>
    region === BUSAN_RECEIPT.region && lineId === BUSAN_RECEIPT.lineId
      && x === BUSAN_RECEIPT.x && y === BUSAN_RECEIPT.y,
  );
  if (rows.length !== BUSAN_RECEIPT.stationIds.length
    || !same(rows.map(({ stationId }) => stationId).sort(), BUSAN_RECEIPT.stationIds)
    || rows.some(({ sourceUrl, sourceSha256 }) =>
      sourceUrl !== "internal:route-map/route-map-defs/svg-sources/easy-subway-busan-v3.svg"
      || sourceSha256 !== BUSAN_RECEIPT.sourceSha256,
    )) {
    throw new Error("Busan canonical duplicate identity is invalid");
  }
}

function routeMapPositionSource(fixture) {
  const capital = fixture?.packs?.filter(({ id }) => id === "capital");
  if (capital?.length !== 1 || !Array.isArray(capital[0].sourceInventory)) {
    throw new Error("canonical route-map fixture identity is invalid");
  }
  const sources = capital[0].sourceInventory.filter(({ id }) => id === "seoul-metro-route-map-positions");
  if (sources.length !== 1) throw new Error("route-map position source identity is invalid");
  const source = sources[0];
  if (typeof source.url !== "string" || source.url.trim() === ""
    || !SHA256.test(source.sourceSha256 ?? "")
    || JSON.stringify(source.coverageScope?.sourceDomains) !== JSON.stringify(["route_map_positions"])) {
    throw new Error("route-map position source identity is invalid");
  }
  return source;
}

function projectDorasanGeometry(position) {
  const oldGeometry = same({ x: position.x, y: position.y, upPath: position.upPath, labelPolygon: position.labelPolygon }, DORASAN_OLD);
  const partialGeometry = position.x === DORASAN.x && position.y === DORASAN.y
    && same({ upPath: position.upPath, labelPolygon: position.labelPolygon }, {
      upPath: DORASAN_OLD.upPath,
      labelPolygon: DORASAN_OLD.labelPolygon,
    });
  const projectedGeometry = position.x === DORASAN.x && position.y === DORASAN.y
    && same({ upPath: position.upPath, labelPolygon: position.labelPolygon }, DORASAN_PROJECTED);
  if (!oldGeometry && !partialGeometry && !projectedGeometry || position.downPath !== "") {
    throw new Error("Dorasan geometry identity is invalid");
  }
  position.x = DORASAN.x;
  position.y = DORASAN.y;
  position.upPath = DORASAN_PROJECTED.upPath;
  position.labelPolygon = DORASAN_OLD.labelPolygon.map(({ x, y }) => ({
    x: Number((x + DORASAN_LABEL_DELTA.x).toFixed(3)),
    y: Number((y + DORASAN_LABEL_DELTA.y).toFixed(3)),
  }));
}

export function projectCanonicalRouteMapProvenance({
  fixture,
  basemapManifest,
  dorasanCsvBytes,
  reviewedAmbiguities,
}) {
  const ownerSources = ownerSourceShaByUrl(basemapManifest);
  const dorasanSha256 = parseDorasanCsv(dorasanCsvBytes);
  validateBusanReceipt(reviewedAmbiguities);
  if (!Array.isArray(fixture?.packs)) throw new Error("canonical route-map fixture identity is invalid");
  const capitals = fixture.packs.filter(({ id }) => id === "capital");
  if (capitals.length !== 1 || !Array.isArray(capitals[0].routeMapPositions)) {
    throw new Error("canonical route-map fixture identity is invalid");
  }
  const positionSource = routeMapPositionSource(fixture);

  const next = structuredClone(fixture);
  const positions = next.packs.find(({ id }) => id === "capital").routeMapPositions;
  let dorasanCount = 0;
  for (const position of positions) {
    const isDorasan = position.stationId === DORASAN.stationId && position.lineId === DORASAN.lineId;
    if (isDorasan) {
      dorasanCount += 1;
      if (position.sourceId !== DORASAN.sourceId || position.sourceUrl !== DORASAN.sourceUrl) {
        throw new Error("Dorasan position source identity is invalid");
      }
      projectDorasanGeometry(position);
      position.sourceSha256 = dorasanSha256;
      continue;
    }
    if (position.sourceId === positionSource.id) {
      if (position.sourceUrl !== positionSource.url) {
        throw new Error("route-map position source identity is invalid");
      }
      position.sourceSha256 = positionSource.sourceSha256;
      continue;
    }
    const sourceSha256 = ownerSources.get(position.sourceUrl);
    if (!SHA256.test(sourceSha256 ?? "")) throw new Error("route-map source identity is invalid");
    position.sourceSha256 = sourceSha256;
  }
  if (dorasanCount !== 1) throw new Error("Dorasan position identity is invalid");
  validateBusanCanonicalRows(positions);
  return next;
}
