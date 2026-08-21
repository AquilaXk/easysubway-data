import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { projectCanonicalRouteMapProvenance } from "./project-canonical-route-map-provenance.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const SHA256 = /^[a-f0-9]{64}$/u;
const DORASAN = { stationId: "station-4c48e8115728", lineId: "line-6e39be0cb6e2", x: 1449, y: 763 };
const BUSAN_RECEIPT = {
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
};

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function json(relativePath) { return JSON.parse(await readFile(path.join(root, relativePath), "utf8")); }

async function inputs() {
  const dorasanCsvBytes = await readFile(
    path.join(root, "tools/datapack/sources/seoul-wikimedia-svg-route-map-20260624.csv"),
  );
  return {
    fixture: await json("tools/datapack/release/capital-production-canonical-pack.json"),
    basemapManifest: await json("tools/route-map/basemap-build-manifest.json"),
    dorasanCsvBytes,
    reviewedAmbiguities: await json("tools/route-map/fixtures/reviewed-ambiguities.json"),
  };
}

test("canonical route-map provenance는 tracked five-region source와 Dorasan CSV를 정확히 투영한다", async () => {
  const source = await inputs();
  const projected = projectCanonicalRouteMapProvenance(source);
  const capital = projected.packs.find(({ id }) => id === "capital");
  const dorasan = capital.routeMapPositions.find((row) => row.stationId === DORASAN.stationId && row.lineId === DORASAN.lineId);

  assert.equal(capital.routeMapPositions.length, 1102);
  assert.ok(capital.routeMapPositions.every(({ sourceSha256 }) => SHA256.test(sourceSha256)));
  assert.deepEqual(
    { x: dorasan.x, y: dorasan.y, upPath: dorasan.upPath, labelPolygon: dorasan.labelPolygon, sourceSha256: dorasan.sourceSha256 },
    {
      x: DORASAN.x,
      y: DORASAN.y,
      upPath: "M 836 334 L 1449 763",
      labelPolygon: [{ x: 1439.769, y: 751.693 }, { x: 1490.769, y: 751.693 }, { x: 1490.769, y: 773.693 }, { x: 1439.769, y: 773.693 }],
      sourceSha256: sha256(source.dorasanCsvBytes),
    },
  );
  const busanReceipt = source.reviewedAmbiguities.reviewedAmbiguities.find(
    ({ lineId, x, y }) => lineId === BUSAN_RECEIPT.lineId && x === BUSAN_RECEIPT.x && y === BUSAN_RECEIPT.y,
  );
  assert.deepEqual(
    {
      region: busanReceipt.region,
      lineId: busanReceipt.lineId,
      x: busanReceipt.x,
      y: busanReceipt.y,
      stationIds: busanReceipt.stationIds,
      sourceSha256: busanReceipt.sourceSha256,
      reason: busanReceipt.reason,
      reviewedAt: busanReceipt.reviewedAt,
      reviewedBy: busanReceipt.reviewedBy,
      reviewSource: busanReceipt.reviewSource,
    },
    BUSAN_RECEIPT,
  );

  assert.deepEqual(
    Buffer.from(`${JSON.stringify(projected)}\n`),
    Buffer.from(`${JSON.stringify(projectCanonicalRouteMapProvenance({ ...source, fixture: projected }))}\n`),
  );
});

test("unknown source, mismatched Dorasan, 또는 Busan receipt drift는 fail closed한다", async () => {
  const source = await inputs();
  const unknownSource = structuredClone(source);
  unknownSource.dorasanCsvBytes = source.dorasanCsvBytes;
  unknownSource.fixture.packs[0].routeMapPositions[0].sourceUrl = "internal:unknown.svg";
  assert.throws(() => projectCanonicalRouteMapProvenance(unknownSource), /route-map source identity is invalid/);

  const unknownSha = structuredClone(source);
  unknownSha.basemapManifest.maps.find(({ id }) => id === "busan").sourceSvgSha256 = "a".repeat(64);
  assert.throws(() => projectCanonicalRouteMapProvenance(unknownSha), /route-map basemap manifest identity is invalid/);

  const wrongDorasan = structuredClone(source);
  wrongDorasan.dorasanCsvBytes = Buffer.from(
    (await readFile(path.join(root, "tools/datapack/sources/seoul-wikimedia-svg-route-map-20260624.csv"), "utf8"))
      .replace(",1449,763,\"도라산\"", ",1449.1,763,\"도라산\""),
  );
  assert.throws(() => projectCanonicalRouteMapProvenance(wrongDorasan), /Dorasan CSV identity is invalid/);

  const staleDorasanGeometry = structuredClone(source);
  staleDorasanGeometry.dorasanCsvBytes = source.dorasanCsvBytes;
  staleDorasanGeometry.fixture.packs[0].routeMapPositions.find(({ stationId, lineId }) =>
    stationId === DORASAN.stationId && lineId === DORASAN.lineId,
  ).upPath = "M 836 334 L 1450 763";
  assert.throws(() => projectCanonicalRouteMapProvenance(staleDorasanGeometry), /Dorasan geometry identity is invalid/);

  const missingReceipt = structuredClone(source);
  missingReceipt.dorasanCsvBytes = source.dorasanCsvBytes;
  missingReceipt.reviewedAmbiguities.reviewedAmbiguities = [];
  assert.throws(() => projectCanonicalRouteMapProvenance(missingReceipt), /Busan duplicate receipt is invalid/);

  const extraReceipt = structuredClone(source);
  extraReceipt.dorasanCsvBytes = source.dorasanCsvBytes;
  extraReceipt.reviewedAmbiguities.reviewedAmbiguities.push({
    ...BUSAN_RECEIPT,
    sourceSha256: "a".repeat(64),
    reason: "extra",
    reviewedAt: "2026-08-15T00:00:00.000Z",
    reviewedBy: "QA",
    reviewSource: "https://github.com/AquilaXk/easysubway-data/issues/309",
  });
  assert.throws(() => projectCanonicalRouteMapProvenance(extraReceipt), /Busan duplicate receipt is invalid/);

  const receiptMetadataDrift = structuredClone(source);
  receiptMetadataDrift.dorasanCsvBytes = source.dorasanCsvBytes;
  receiptMetadataDrift.reviewedAmbiguities.reviewedAmbiguities.find(
    ({ lineId }) => lineId === BUSAN_RECEIPT.lineId,
  ).reviewedBy = "QA";
  assert.throws(() => projectCanonicalRouteMapProvenance(receiptMetadataDrift), /Busan duplicate receipt is invalid/);

  const missingBusanRow = structuredClone(source);
  missingBusanRow.dorasanCsvBytes = source.dorasanCsvBytes;
  missingBusanRow.fixture.packs[0].routeMapPositions = missingBusanRow.fixture.packs[0].routeMapPositions
    .filter(({ stationId, lineId }) => !(stationId === BUSAN_RECEIPT.stationIds[0] && lineId === BUSAN_RECEIPT.lineId));
  assert.throws(() => projectCanonicalRouteMapProvenance(missingBusanRow), /Busan canonical duplicate identity is invalid/);

  const extraBusanRow = structuredClone(source);
  extraBusanRow.dorasanCsvBytes = source.dorasanCsvBytes;
  extraBusanRow.fixture.packs[0].routeMapPositions.push({
    ...extraBusanRow.fixture.packs[0].routeMapPositions.find(({ stationId, lineId }) =>
      stationId === BUSAN_RECEIPT.stationIds[0] && lineId === BUSAN_RECEIPT.lineId,
    ),
    stationId: "station-extra-busan-duplicate",
  });
  assert.throws(() => projectCanonicalRouteMapProvenance(extraBusanRow), /Busan canonical duplicate identity is invalid/);

  const wrongBusanSource = structuredClone(source);
  wrongBusanSource.dorasanCsvBytes = source.dorasanCsvBytes;
  wrongBusanSource.fixture.packs[0].routeMapPositions.find(({ stationId, lineId }) =>
    stationId === BUSAN_RECEIPT.stationIds[0] && lineId === BUSAN_RECEIPT.lineId,
  ).sourceUrl = "internal:route-map/route-map-defs/svg-sources/easy-subway-daegu-v3.svg";
  assert.throws(() => projectCanonicalRouteMapProvenance(wrongBusanSource), /Busan canonical duplicate identity is invalid/);
});
