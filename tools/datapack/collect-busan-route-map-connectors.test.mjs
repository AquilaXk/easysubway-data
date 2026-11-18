import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  connectorAssetPaths,
  connectorCenterline,
  decodePngRgba,
  validateBusanRouteMapConnectorEvidence,
} from "./collect-busan-route-map-connectors.mjs";

test("1호선 두 자리 역번호 connector도 공식 asset 범위에 포함한다", () => {
  assert.deepEqual(
    connectorAssetPaths([
      ".l99-100 {background:url(/homepage/default/img/cyber-station/99-100.png)}",
      ".l901-902 {background:url(/homepage/default/img/cyber-station/901-902.png)}",
    ].join("\n")),
    ["99-100.png"],
  );
});

test("공식 connector alpha mask를 진행 방향 centerline으로 변환한다", () => {
  const rgba = Buffer.alloc(5 * 5 * 4);
  for (const [x, y] of [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [3, 2], [4, 2]]) {
    rgba[(y * 5 + x) * 4 + 3] = 255;
  }

  assert.deepEqual(connectorCenterline({ width: 5, height: 5, rgba }), [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 1 },
    { x: 3, y: 2 },
    { x: 4, y: 2 },
  ]);
});

test("connector evidence는 공식 host·PNG identity·centerline을 fail closed 검증한다", () => {
  const evidence = {
    schemaVersion: 1,
    artifactKind: "busan-route-map-connector-evidence",
    sourceBaseUrl: "https://www2.humetro.busan.kr/homepage/default/img/cyber-station/",
    capturedAt: "2026-07-20T11:13:18.000Z",
    assets: [{
      assetPath: "301-302.png",
      sourceUrl: "https://www2.humetro.busan.kr/homepage/default/img/cyber-station/301-302.png",
      sha256: "a".repeat(64),
      width: 49,
      height: 59,
      centerline: [{ x: 0, y: 0 }, { x: 48, y: 58 }],
    }],
  };
  assert.equal(validateBusanRouteMapConnectorEvidence(evidence), evidence);

  const tampered = structuredClone(evidence);
  tampered.assets[0].sourceUrl = "https://example.com/301-302.png";
  assert.throws(() => validateBusanRouteMapConnectorEvidence(tampered), /invalid connector evidence/);
});

function buildTestPng({ width, height, idatData, ihdrExtraChunks = [] }) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 4, "ascii");
    data.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width >>> 0, 0);
  ihdr.writeUInt32BE(height >>> 0, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([sig, chunk("IHDR", ihdr), ...ihdrExtraChunks, chunk("IDAT", idatData), chunk("IEND", Buffer.alloc(0))]);
}

test("decodePngRgba enforces dimension and maxOutputLength bounds fail-closed before inflating bombs", () => {
  const oversizedHeader = buildTestPng({ width: 100_000, height: 100_000, idatData: deflateSync(Buffer.from([0])) });
  assert.throws(() => decodePngRgba(oversizedHeader), /dimension|budget|limit/i);

  const bombPng = buildTestPng({
    width: 2,
    height: 2,
    idatData: deflateSync(Buffer.alloc(1024 * 1024, 0)),
  });
  assert.throws(
    () => decodePngRgba(bombPng),
    (err) => err?.cause?.code === "ERR_BUFFER_TOO_LARGE",
  );
});
