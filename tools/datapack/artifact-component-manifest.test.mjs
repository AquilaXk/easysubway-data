import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canonicalJson,
  validateArtifactComponentManifest,
  withoutSignature,
} from "./lib/manifest-validation.mjs";

const stationSetSha256 = "a".repeat(64);
const payloadSha256 = "b".repeat(64);
const schema = JSON.parse(readFileSync("contracts/datapack/artifact-component-manifest.schema.json", "utf8"));

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
    provenanceSha256: "0".repeat(64),
    compatibilitySha256: "1".repeat(64),
    serviceTimezone: "Asia/Seoul",
    activeFrom: "2026-08-03T00:00:00.000+09:00",
    freshUntil: "2026-08-04T00:00:00.000+09:00",
    schemaCompatibility: { backendMin: 3, backendMax: 3 },
    keyId: "production-v1",
    signature: {
      algorithm: "rsa-sha256-server-route-bundle-v1",
      value: "AA-_09",
    },
  };
}

test("세 artifact v1 envelope를 검증하고 station set hash를 반환한다", () => {
  const mapStationSet = assertValidByBoth(mapPackManifest());
  const catalogStationSet = assertValidByBoth(catalogPackManifest(), mapStationSet);
  const serverStationSet = assertValidByBoth(serverRouteBundleManifest(), mapStationSet);

  assert.equal(mapStationSet, stationSetSha256);
  assert.equal(catalogStationSet, stationSetSha256);
  assert.equal(serverStationSet, stationSetSha256);
});

test("서로 다른 형식상 유효 station set hash를 expected compatibility 값으로 거부한다", () => {
  assert.equal(validateSchema(catalogPackManifest()), true);
  assert.throws(() => validateArtifactComponentManifest(catalogPackManifest(), "0".repeat(64)),
    /stationSetSha256 must match expectedStationSetSha256/,
  );
});

test("unknown 또는 missing top-level field를 거부한다", () => {
  const unknown = mapPackManifest();
  unknown.unknown = true;
  assertRejectedByBoth(unknown, /additional field is unsupported/);

  const missing = catalogPackManifest();
  delete missing.catalogPackId;
  assertRejectedByBoth(missing, /required field missing/);
});

test("server component와 metadata digest 누락·추가와 비정상 hash를 거부한다", () => {
  const missing = serverRouteBundleManifest();
  delete missing.fareSha256;
  assertRejectedByBoth(missing, /required field missing/);

  for (const field of ["provenanceSha256", "compatibilitySha256"]) {
    const manifest = serverRouteBundleManifest();
    delete manifest[field];
    assertRejectedByBoth(manifest, /required field missing/);
  }

  const extra = serverRouteBundleManifest();
  extra.extraSha256 = "0".repeat(64);
  assertRejectedByBoth(extra, /additional field is unsupported/);

  const uppercase = serverRouteBundleManifest();
  uppercase.topologySha256 = "C".repeat(64);
  assertRejectedByBoth(uppercase, /lowercase sha256 hex string/);

  for (const [field, value] of [
    ["provenanceSha256", "0".repeat(63)],
    ["compatibilitySha256", "1".repeat(63)],
    ["provenanceSha256", "A".repeat(64)],
    ["compatibilitySha256", `${"1".repeat(64)} `],
    ["provenanceSha256", `${"0".repeat(64)}\n`],
  ]) {
    const manifest = serverRouteBundleManifest();
    manifest[field] = value;
    assertRejectedByBoth(manifest, /lowercase sha256 hex string|must be a non-empty raw string/);
  }
});

test("server service timezone의 exact value와 own field를 강제한다", () => {
  const missing = serverRouteBundleManifest();
  delete missing.serviceTimezone;
  assertRejectedByBoth(missing, /required field missing/);

  for (const serviceTimezone of ["UTC", "+09:00", "ROK", "Asia/Seoul ", "Asia/Seoul\n"]) {
    const manifest = serverRouteBundleManifest();
    manifest.serviceTimezone = serviceTimezone;
    assertRejectedByBoth(manifest, /serviceTimezone must be Asia\/Seoul/);
  }
});

test("server lifecycle의 exact KST instant, ordering, backend schema compatibility를 강제한다", () => {
  const yearZeroLeapDay = serverRouteBundleManifest();
  yearZeroLeapDay.activeFrom = "0000-02-29T00:00:00.000+09:00";
  yearZeroLeapDay.freshUntil = "0000-03-01T00:00:00.000+09:00";
  assert.equal(assertValidByBoth(yearZeroLeapDay), stationSetSha256);

  for (const [field, value] of [
    ["activeFrom", "2026-08-03T00:00:00.00+09:00"],
    ["activeFrom", "2026-08-03T00:00:00.000Z"],
    ["activeFrom", "2026-02-30T00:00:00.000+09:00"],
  ]) {
    const manifest = serverRouteBundleManifest();
    manifest[field] = value;
    assertRejectedByBoth(manifest, /activeFrom|freshUntil/);
  }

  for (const mutate of [
    (manifest) => { manifest.schemaCompatibility.backendMax = 4; },
    (manifest) => { delete manifest.schemaCompatibility.backendMin; },
    (manifest) => { manifest.schemaCompatibility.unknown = true; },
  ]) {
    const manifest = serverRouteBundleManifest();
    mutate(manifest);
    assertRejectedByBoth(manifest, /schemaCompatibility/);
  }

  for (const field of ["activeFrom", "freshUntil", "schemaCompatibility"]) {
    const manifest = serverRouteBundleManifest();
    delete manifest[field];
    assertRejectedByBoth(manifest, /required field missing/);
  }

  for (const freshUntil of [
    "2026-08-03T00:00:00.000+09:00",
    "2026-08-02T23:59:59.999+09:00",
  ]) {
    const manifest = serverRouteBundleManifest();
    manifest.freshUntil = freshUntil;
    assert.equal(validateSchema(manifest), true, "schema only validates the structural instant shape");
    assert.throws(() => validateArtifactComponentManifest(manifest), /activeFrom must be before freshUntil/);
  }
});

test("server signature의 algorithm, value shape, nested field를 거부한다", () => {
  const wrongAlgorithm = serverRouteBundleManifest();
  wrongAlgorithm.signature.algorithm = "rsa-sha256-manifest-v2";
  assertRejectedByBoth(wrongAlgorithm, /algorithm is unsupported/);

  const paddedValue = serverRouteBundleManifest();
  paddedValue.signature.value = "AA==";
  assertRejectedByBoth(paddedValue, /base64url string/);

  const nestedUnknown = serverRouteBundleManifest();
  nestedUnknown.signature.extra = true;
  assertRejectedByBoth(nestedUnknown, /additional field is unsupported/);
});

test("unsafe release sequence을 canonicalization 전에 거부한다", () => {
  for (const releaseSequence of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const manifest = serverRouteBundleManifest();
    manifest.releaseSequence = releaseSequence;
    assertRejectedByBoth(manifest, /safe positive integer/);
  }
});

test("raw string contract와 inherited required field를 fail closed한다", () => {
  for (const [factory, field, mutate] of [
    [mapPackManifest, "artifactKind", (manifest) => { manifest.artifactKind = " map-pack"; }],
    [mapPackManifest, "mapPackId", (manifest) => { manifest.mapPackId = " map-2026-08-03"; }],
    [mapPackManifest, "mapPackId final newline", (manifest) => { manifest.mapPackId = "map-2026-08-03\n"; }],
    [mapPackManifest, "stationSetSha256", (manifest) => { manifest.stationSetSha256 = ` ${stationSetSha256}`; }],
    [mapPackManifest, "stationSetSha256 final newline", (manifest) => { manifest.stationSetSha256 = `${stationSetSha256}\n`; }],
    [mapPackManifest, "payloadSha256", (manifest) => { manifest.payloadSha256 = `${payloadSha256} `; }],
    [serverRouteBundleManifest, "bundleId", (manifest) => { manifest.bundleId = " route-2026-08-03"; }],
    [serverRouteBundleManifest, "keyId", (manifest) => { manifest.keyId = "production-v1 "; }],
    [serverRouteBundleManifest, "signature.algorithm", (manifest) => { manifest.signature.algorithm = " rsa-sha256-server-route-bundle-v1"; }],
    [serverRouteBundleManifest, "signature.value", (manifest) => { manifest.signature.value = "AA-_09 "; }],
    [serverRouteBundleManifest, "signature.value final newline", (manifest) => { manifest.signature.value = "AA-_09\n"; }],
  ]) {
    const manifest = factory();
    mutate(manifest);
    assertRejectedByBoth(manifest, /must be a non-empty raw string|artifactKind is unsupported|base64url string|algorithm is unsupported/);
  }

  const inheritedTopLevel = Object.create({ mapPackId: "map-2026-08-03" });
  Object.assign(inheritedTopLevel, mapPackManifest());
  delete inheritedTopLevel.mapPackId;
  assertRejectedByBoth(inheritedTopLevel, /required field missing/);

  const inheritedSignature = serverRouteBundleManifest();
  inheritedSignature.signature = Object.create({ value: "AA-_09" });
  inheritedSignature.signature.algorithm = "rsa-sha256-server-route-bundle-v1";
  assertRejectedByBoth(inheritedSignature, /required field missing/);
});

test("server envelope의 signature 제외 canonical signing input을 고정한다", () => {
  const manifest = serverRouteBundleManifest();
  assert.equal(
    canonicalJson(withoutSignature(manifest)),
    `{"accessibilitySha256":"${"e".repeat(64)}","activeFrom":"2026-08-03T00:00:00.000+09:00","artifactKind":"server-route-bundle","bundleId":"route-2026-08-03","compatibilitySha256":"${"1".repeat(64)}","fareSha256":"${"f".repeat(64)}","freshUntil":"2026-08-04T00:00:00.000+09:00","keyId":"production-v1","manifestVersion":1,"payloadSha256":"${"b".repeat(64)}","provenanceSha256":"${"0".repeat(64)}","releaseSequence":1,"schemaCompatibility":{"backendMax":3,"backendMin":3},"serviceTimezone":"Asia/Seoul","stationSetSha256":"${"a".repeat(64)}","timetableSha256":"${"d".repeat(64)}","topologySha256":"${"c".repeat(64)}"}`,
  );
  assert.equal(assertValidByBoth(manifest), stationSetSha256);
});

function assertValidByBoth(manifest, expectedStationSetSha256 = undefined) {
  assert.equal(validateSchema(manifest), true, "schema must accept valid manifest");
  return validateArtifactComponentManifest(manifest, expectedStationSetSha256);
}

function assertRejectedByBoth(manifest, error) {
  assert.equal(validateSchema(manifest), false, "schema must reject invalid manifest");
  assert.throws(() => validateArtifactComponentManifest(manifest), error);
}

function validateSchema(value) {
  return schema.oneOf.filter((branch) => validateSchemaNode(branch, value)).length === 1;
}

function validateSchemaNode(rule, value) {
  if (rule.$ref) return validateSchemaNode(schema.$defs[rule.$ref.split("/").at(-1)], value);
  if (rule.const !== undefined && value !== rule.const) return false;
  if (rule.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if ((rule.required ?? []).some((field) => !Object.hasOwn(value, field))) return false;
    if (rule.additionalProperties === false && Object.keys(value).some((field) => !Object.hasOwn(rule.properties ?? {}, field))) return false;
    return Object.entries(rule.properties ?? {}).every(([field, property]) => (
      !Object.hasOwn(value, field) || validateSchemaNode(property, value[field])
    ));
  }
  if (rule.type === "string" && typeof value !== "string") return false;
  if (rule.type === "integer" && !Number.isInteger(value)) return false;
  if (rule.minLength !== undefined && value.length < rule.minLength) return false;
  if (rule.minimum !== undefined && value < rule.minimum) return false;
  if (rule.maximum !== undefined && value > rule.maximum) return false;
  return rule.pattern === undefined || new RegExp(rule.pattern).test(value);
}
