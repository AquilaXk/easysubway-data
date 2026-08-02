import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  validateArtifactComponentManifest,
  withoutSignature,
} from "./lib/manifest-validation.mjs";

const stationSetSha256 = "a".repeat(64);
const payloadSha256 = "b".repeat(64);

function mapPackManifest() {
  return {
    manifestVersion: 1,
    artifactKind: "map-pack",
    mapPackId: "map-2026-08-03",
    stationSetSha256,
    payloadSha256,
  };
}

function catalogPackManifest() {
  return {
    manifestVersion: 1,
    artifactKind: "station-catalog-pack",
    catalogPackId: "catalog-2026-08-03",
    stationSetSha256,
    payloadSha256,
  };
}

function serverRouteBundleManifest() {
  return {
    manifestVersion: 1,
    artifactKind: "server-route-bundle",
    bundleId: "route-2026-08-03",
    releaseSequence: 1,
    stationSetSha256,
    payloadSha256,
    topologySha256: "c".repeat(64),
    timetableSha256: "d".repeat(64),
    accessibilitySha256: "e".repeat(64),
    fareSha256: "f".repeat(64),
    keyId: "production-v1",
    signature: {
      algorithm: "rsa-sha256-server-route-bundle-v1",
      value: "AA-_09",
    },
  };
}

test("세 artifact v1 envelope를 검증하고 station set hash를 반환한다", () => {
  const mapStationSet = validateArtifactComponentManifest(mapPackManifest());
  const catalogStationSet = validateArtifactComponentManifest(catalogPackManifest(), mapStationSet);
  const serverStationSet = validateArtifactComponentManifest(serverRouteBundleManifest(), mapStationSet);

  assert.equal(mapStationSet, stationSetSha256);
  assert.equal(catalogStationSet, stationSetSha256);
  assert.equal(serverStationSet, stationSetSha256);
});

test("서로 다른 형식상 유효 station set hash를 expected compatibility 값으로 거부한다", () => {
  assert.throws(
    () => validateArtifactComponentManifest(catalogPackManifest(), "0".repeat(64)),
    /stationSetSha256 must match expectedStationSetSha256/,
  );
});

test("unknown 또는 missing top-level field를 거부한다", () => {
  const unknown = mapPackManifest();
  unknown.unknown = true;
  assert.throws(() => validateArtifactComponentManifest(unknown), /additional field is unsupported/);

  const missing = catalogPackManifest();
  delete missing.catalogPackId;
  assert.throws(() => validateArtifactComponentManifest(missing), /required field missing/);
});

test("server component digest 누락·추가와 비정상 hash를 거부한다", () => {
  const missing = serverRouteBundleManifest();
  delete missing.fareSha256;
  assert.throws(() => validateArtifactComponentManifest(missing), /required field missing/);

  const extra = serverRouteBundleManifest();
  extra.extraSha256 = "0".repeat(64);
  assert.throws(() => validateArtifactComponentManifest(extra), /additional field is unsupported/);

  const uppercase = serverRouteBundleManifest();
  uppercase.topologySha256 = "C".repeat(64);
  assert.throws(() => validateArtifactComponentManifest(uppercase), /lowercase sha256 hex string/);
});

test("server signature의 algorithm, value shape, nested field를 거부한다", () => {
  const wrongAlgorithm = serverRouteBundleManifest();
  wrongAlgorithm.signature.algorithm = "rsa-sha256-manifest-v2";
  assert.throws(() => validateArtifactComponentManifest(wrongAlgorithm), /algorithm is unsupported/);

  const paddedValue = serverRouteBundleManifest();
  paddedValue.signature.value = "AA==";
  assert.throws(() => validateArtifactComponentManifest(paddedValue), /base64url string/);

  const nestedUnknown = serverRouteBundleManifest();
  nestedUnknown.signature.extra = true;
  assert.throws(() => validateArtifactComponentManifest(nestedUnknown), /additional field is unsupported/);
});

test("unsafe release sequence을 canonicalization 전에 거부한다", () => {
  const manifest = serverRouteBundleManifest();
  manifest.releaseSequence = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => validateArtifactComponentManifest(manifest), /safe positive integer/);
});

test("server envelope의 signature 제외 canonical signing input을 고정한다", () => {
  const manifest = serverRouteBundleManifest();
  assert.equal(
    canonicalJson(withoutSignature(manifest)),
    `{"accessibilitySha256":"${"e".repeat(64)}","artifactKind":"server-route-bundle","bundleId":"route-2026-08-03","fareSha256":"${"f".repeat(64)}","keyId":"production-v1","manifestVersion":1,"payloadSha256":"${"b".repeat(64)}","releaseSequence":1,"stationSetSha256":"${"a".repeat(64)}","timetableSha256":"${"d".repeat(64)}","topologySha256":"${"c".repeat(64)}"}`,
  );
  assert.equal(validateArtifactComponentManifest(manifest), stationSetSha256);
});
