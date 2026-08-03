import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { canonicalJson } from "./lib/manifest-validation.mjs";

const contract = JSON.parse(readFileSync("contracts/datapack/server-route-bundle-build-contract.json", "utf8"));
const schema = JSON.parse(readFileSync("contracts/datapack/server-route-bundle-build-contract.schema.json", "utf8"));

test("정본 build contract의 parsed object와 폐쇄 schema가 일치한다", () => {
  assert.deepEqual(schema.const, contract);
  assert.equal(
    sha256(Buffer.from(canonicalJson(contract), "utf8")),
    "d9fa9c0456764c951ccfad6ebdb846970f7bb5d0a32951ac4ad2858a6f1388be",
  );
  assert.deepEqual(Object.keys(contract), [
    "schemaVersion", "artifactKind", "manifestLifecycle", "capitalMap", "compressionProfile", "metadata",
  ]);
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.artifactKind, "server-route-bundle-build-contract");
  assert.deepEqual(contract.manifestLifecycle, {
    activeFromPattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}\\+09:00$",
    freshUntilPattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}\\+09:00$",
    ordering: "activeFrom < freshUntil",
    clockEvaluation: "backend-active-bundle-only",
    schemaCompatibility: { backendMin: 3, backendMax: 3 },
  });
  assert.deepEqual(contract.capitalMap, {
    payloadPath: "payload/metropolitan.svg",
    basemapManifestPath: "tools/route-map/basemap-build-manifest.json",
    mapId: "seoul",
    sourcePath: "tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v4.svg",
    sourceSha256: "821b636eac0f3b04c5baa995d39ae938d7648d04f7c32802fbef22e60537bf08",
  });
  assert.deepEqual(contract.compressionProfile, {
    format: "zstd",
    api: "node:zlib.zstdCompressSync",
    requiredNodeMajor: 24,
    compressionLevel: 10,
    checksumFlag: 1,
    dictionary: null,
    runtimeIdentityFields: ["node", "zstd"],
    rebuildCount: 3,
    reproducibilityScope: "same-input-contract-runtime",
  });
  assert.deepEqual(Object.keys(contract.metadata), ["serialization", "provenance", "compatibility"]);
  assert.deepEqual(contract.metadata.serialization, {
    encoding: "utf-8", canonicalization: "canonicalJson", bom: false, trailingNewline: false,
  });
  assert.deepEqual(contract.metadata.provenance.exactFields, [
    "schemaVersion", "artifactKind", "bundleId", "releaseSequence", "stationSetSha256", "serviceTimezone",
    "activeFrom", "freshUntil", "builtAt", "buildSpecSha256", "sourceSnapshotSetHash",
    "sourceInventorySha256", "sourceSnapshotIds",
  ]);
  assert.deepEqual(contract.metadata.compatibility.exactFields, [
    "schemaVersion", "artifactKind", "bundleId", "releaseSequence", "stationSetSha256", "serviceTimezone",
    "manifestVersion", "tableLayoutSchemaVersion", "sourceSchemaPath", "sourceSqliteUserVersion",
    "sourceSchemaSha256", "schemaCompatibility", "compressionProfile", "encoderRuntime",
  ]);
  assert.deepEqual(contract.metadata.compatibility.bindings.sourceSchemaPath, {
    source: "json-pointer", path: "contracts/datapack/artifact-component-table-layout.json",
    pointer: "/serverRouteBundle/sourceSchema/path",
  });
  assert.deepEqual(contract.metadata.compatibility.bindings.encoderRuntime, {
    source: "process-versions", fields: ["node", "zstd"],
  });
});

test("폐쇄 schema는 unknown 및 nested mutation을 거부한다", () => {
  assert.equal(validateBuildContract(contract), true);
  const unknown = structuredClone(contract);
  unknown.metadata.provenance.bindings.sourceSnapshotIds.unknown = true;
  assert.equal(validateBuildContract(unknown), false);

  const alias = structuredClone(contract);
  alias.capitalMap.sourceSvgSha256 = alias.capitalMap.sourceSha256;
  assert.equal(validateBuildContract(alias), false);

  const changed = structuredClone(contract);
  changed.compressionProfile.compressionLevel = 9;
  assert.equal(validateBuildContract(changed), false);
});

test("capital basemap과 source schema는 raw path와 sha256으로 결속된다", () => {
  const basemap = JSON.parse(readFileSync(contract.capitalMap.basemapManifestPath, "utf8"));
  const seoul = basemap.maps.find((map) => map.id === contract.capitalMap.mapId);
  assert.ok(seoul);
  assert.equal(seoul.source, contract.capitalMap.sourcePath);
  assert.equal(seoul.sourceSvgSha256, contract.capitalMap.sourceSha256);
  assert.equal(sha256(readFileSync(contract.capitalMap.sourcePath)), contract.capitalMap.sourceSha256);

  const layout = JSON.parse(readFileSync("contracts/datapack/artifact-component-table-layout.json", "utf8"));
  const sourceSchema = layout.serverRouteBundle.sourceSchema;
  assert.equal(contract.metadata.compatibility.bindings.sourceSchemaPath.path,
    "contracts/datapack/artifact-component-table-layout.json");
  assert.equal(sourceSchema.path, "tools/datapack/schema/catalog-schema.sql");
  assert.equal(sourceSchema.sqliteUserVersion, 18);
  assert.equal(sourceSchema.sha256, "0a5ded95d48ffb203c58acbf15183972257c8717be97caf3f6db3560718ebb17");
  assert.equal(sha256(readFileSync(sourceSchema.path)), sourceSchema.sha256);
  assert.match(readFileSync(sourceSchema.path, "utf8"),
    new RegExp(`^PRAGMA user_version = ${sourceSchema.sqliteUserVersion};$`, "m"));
});

test("Node 24 Zstd fixed profile은 same runtime에서 roundtrip과 세 번 byte identity를 보장한다", () => {
  assert.equal(Number.parseInt(process.versions.node.split(".", 1)[0], 10), 24);
  assert.match(process.versions.node, /^(?!\s).+\S$/);
  assert.match(process.versions.zstd, /^(?!\s).+\S$/);
  const options = {
    params: {
      [constants.ZSTD_c_compressionLevel]: contract.compressionProfile.compressionLevel,
      [constants.ZSTD_c_checksumFlag]: contract.compressionProfile.checksumFlag,
    },
  };
  const input = Buffer.from("server-route-bundle-v1\\n수도권", "utf8");
  const outputs = Array.from({ length: contract.compressionProfile.rebuildCount }, () => zstdCompressSync(input, options));
  assert.deepEqual(zstdDecompressSync(outputs[0]), input);
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(outputs[1], outputs[2]);
});

function validateBuildContract(value) {
  return deepEqual(value, schema.const);
}

function deepEqual(left, right) {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
