import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contract = JSON.parse(
  readFileSync("contracts/datapack/bundle-component-contract.json", "utf8"),
);

const ARTIFACTS = {
  "map-pack": {
    identityField: "mapPackId",
    allowedCategories: ["geometry", "hashes", "layout", "line-style", "map-contract-version", "symbols"],
    deniedCategories: ["accessibility-routing-state", "eta", "route-edges", "timetable", "transfer-cost"],
  },
  "station-catalog-pack": {
    identityField: "catalogPackId",
    allowedCategories: ["aliases", "line-ids", "localized-names", "search-index", "station-ids"],
    deniedCategories: ["accessibility-path-calculation", "route-graph", "routing-cost", "stop-times", "transfer-graph", "trips"],
  },
  "server-route-bundle": {
    identityField: "bundleId",
    allowedCategories: ["accessibility", "compatibility", "fare", "provenance", "signed-manifest", "timetable", "topology"],
    deniedCategories: ["aliases", "geometry", "layout", "line-style", "localized-names", "search-index", "symbols"],
  },
};

const COMPONENTS = ["topology", "timetable", "accessibility", "fare"];
const ATOMIC_IDENTITY_FIELDS = ["bundleId", "releaseSequence", "stationSetSha256"];
const STATION_SET_SHA256 = "a".repeat(64);

function assertExactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value), expected, `${label} keys`);
}

function assertSortedUnique(values, label) {
  assert.ok(Array.isArray(values), `${label} must be an array`);
  assert.deepEqual(values, [...new Set(values)].sort(), `${label} must be sorted and unique`);
}

function validateContract(document) {
  assertExactKeys(document, ["schemaVersion", "artifactKind", "artifacts", "sharedCompatibility", "serverRouteBundle"], "contract");
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.artifactKind, "bundle-component-contract");

  assertExactKeys(document.artifacts, Object.keys(ARTIFACTS), "artifacts");
  for (const [artifactName, expected] of Object.entries(ARTIFACTS)) {
    const artifact = document.artifacts[artifactName];
    assertExactKeys(artifact, ["identityField", "allowedCategories", "deniedCategories"], artifactName);
    assert.equal(artifact.identityField, expected.identityField, `${artifactName} identityField`);
    assert.deepEqual(artifact.allowedCategories, expected.allowedCategories, `${artifactName} allowedCategories`);
    assert.deepEqual(artifact.deniedCategories, expected.deniedCategories, `${artifactName} deniedCategories`);
    assertSortedUnique(artifact.allowedCategories, `${artifactName}.allowedCategories`);
    assertSortedUnique(artifact.deniedCategories, `${artifactName}.deniedCategories`);
    assert.equal(
      artifact.allowedCategories.some((category) => artifact.deniedCategories.includes(category)),
      false,
      `${artifactName} categories must be disjoint`,
    );
  }

  assertExactKeys(document.sharedCompatibility, ["field", "pattern", "mustMatchAcrossArtifacts"], "sharedCompatibility");
  assert.equal(document.sharedCompatibility.field, "stationSetSha256");
  assert.equal(document.sharedCompatibility.pattern, "^[0-9a-f]{64}$");
  assert.equal(document.sharedCompatibility.mustMatchAcrossArtifacts, true);

  assertExactKeys(document.serverRouteBundle, ["components", "atomicIdentityFields", "releaseSequence"], "serverRouteBundle");
  assert.deepEqual(document.serverRouteBundle.components, COMPONENTS);
  assert.deepEqual(document.serverRouteBundle.atomicIdentityFields, ATOMIC_IDENTITY_FIELDS);
  assertExactKeys(document.serverRouteBundle.releaseSequence, ["type", "minimum"], "serverRouteBundle.releaseSequence");
  assert.deepEqual(document.serverRouteBundle.releaseSequence, { type: "integer", minimum: 1 });
}

function validateArtifactIdentities(identities, document = contract) {
  assertExactKeys(identities, Object.keys(ARTIFACTS), "artifact identities");
  const [firstArtifactName] = Object.keys(document.artifacts);
  const firstCompatibilityValue = identities[firstArtifactName][document.sharedCompatibility.field];
  for (const [artifactName, artifact] of Object.entries(document.artifacts)) {
    const identity = identities[artifactName];
    assertExactKeys(identity, [artifact.identityField, document.sharedCompatibility.field], `${artifactName} identity`);
    assert.equal(typeof identity[artifact.identityField], "string", `${artifactName} identity must be a string`);
    assert.notEqual(identity[artifact.identityField], "", `${artifactName} identity must not be empty`);
    assert.match(identity[document.sharedCompatibility.field], new RegExp(document.sharedCompatibility.pattern));
    assert.equal(
      identity[document.sharedCompatibility.field],
      firstCompatibilityValue,
      `${artifactName}.${document.sharedCompatibility.field} must equal ${firstArtifactName}.${document.sharedCompatibility.field}`,
    );
  }
}

function validateServerComponents(components, document = contract) {
  assertExactKeys(components, document.serverRouteBundle.components, "server-route-bundle components");
  const [firstName] = document.serverRouteBundle.components;
  const first = components[firstName];
  for (const componentName of document.serverRouteBundle.components) {
    const component = components[componentName];
    assertExactKeys(component, document.serverRouteBundle.atomicIdentityFields, `${componentName} identity`);
    assert.equal(typeof component.bundleId, "string", `${componentName}.bundleId must be a string`);
    assert.notEqual(component.bundleId, "", `${componentName}.bundleId must not be empty`);
    assert.equal(Number.isInteger(component.releaseSequence), true, `${componentName}.releaseSequence must be an integer`);
    assert.ok(component.releaseSequence >= document.serverRouteBundle.releaseSequence.minimum, `${componentName}.releaseSequence must be positive`);
    assert.match(component.stationSetSha256, new RegExp(document.sharedCompatibility.pattern));
    for (const field of document.serverRouteBundle.atomicIdentityFields) {
      assert.equal(component[field], first[field], `${componentName}.${field} must equal ${firstName}.${field}`);
    }
  }
}

function validArtifactIdentities() {
  return {
    "map-pack": { mapPackId: "map-2026-08-03", stationSetSha256: STATION_SET_SHA256 },
    "station-catalog-pack": { catalogPackId: "catalog-2026-08-03", stationSetSha256: STATION_SET_SHA256 },
    "server-route-bundle": { bundleId: "route-2026-08-03", stationSetSha256: STATION_SET_SHA256 },
  };
}

function validServerComponents() {
  return Object.fromEntries(COMPONENTS.map((name) => [name, {
    bundleId: "route-2026-08-03",
    releaseSequence: 1,
    stationSetSha256: STATION_SET_SHA256,
  }]));
}

test("bundle component contract has the fixed exact shape and category boundaries", () => {
  validateContract(contract);
});

test("artifact identities are independent and share only station-set compatibility", () => {
  const identities = validArtifactIdentities();
  validateArtifactIdentities(identities);
  assert.notEqual(identities["map-pack"].mapPackId, identities["server-route-bundle"].bundleId);
  assert.notEqual(identities["station-catalog-pack"].catalogPackId, identities["server-route-bundle"].bundleId);
});

test("server-route-bundle components share one atomic identity", () => {
  validateServerComponents(validServerComponents());
});

test("contract mutations fail closed", () => {
  const unknownTopLevelKey = structuredClone(contract);
  unknownTopLevelKey.unknown = true;
  assert.throws(() => validateContract(unknownTopLevelKey), /contract keys/);

  const missingArtifact = structuredClone(contract);
  delete missingArtifact.artifacts["map-pack"];
  assert.throws(() => validateContract(missingArtifact), /artifacts keys/);

  const unknownArtifact = structuredClone(contract);
  unknownArtifact.artifacts.unknown = {};
  assert.throws(() => validateContract(unknownArtifact), /artifacts keys/);

  const unsortedCategories = structuredClone(contract);
  unsortedCategories.artifacts["map-pack"].allowedCategories.reverse();
  assert.throws(() => validateContract(unsortedCategories), /allowedCategories/);

  const duplicateCategories = structuredClone(contract);
  duplicateCategories.artifacts["map-pack"].allowedCategories.push("geometry");
  assert.throws(() => validateContract(duplicateCategories), /allowedCategories/);

  const overlappingCategories = structuredClone(contract);
  overlappingCategories.artifacts["map-pack"].deniedCategories.push("geometry");
  overlappingCategories.artifacts["map-pack"].deniedCategories.sort();
  assert.throws(() => validateContract(overlappingCategories), /deniedCategories|disjoint/);

  const missingServerComponent = structuredClone(contract);
  missingServerComponent.serverRouteBundle.components.pop();
  assert.throws(() => validateContract(missingServerComponent), /fare/);

  const unknownServerComponent = structuredClone(contract);
  unknownServerComponent.serverRouteBundle.components.push("unknown");
  assert.throws(() => validateContract(unknownServerComponent), /unknown/);
});

test("identity mutations reject missing or extra fields and invalid compatibility values", () => {
  const missingIdentityField = validArtifactIdentities();
  delete missingIdentityField["map-pack"].mapPackId;
  assert.throws(() => validateArtifactIdentities(missingIdentityField), /map-pack identity keys/);

  const extraIdentityField = validArtifactIdentities();
  extraIdentityField["map-pack"].bundleId = "route-2026-08-03";
  assert.throws(() => validateArtifactIdentities(extraIdentityField), /map-pack identity keys/);

  const uppercaseHash = validArtifactIdentities();
  uppercaseHash["map-pack"].stationSetSha256 = "A".repeat(64);
  assert.throws(() => validateArtifactIdentities(uppercaseHash), /\^\[0-9a-f\]\{64\}\$/);

  const shortHash = validArtifactIdentities();
  shortHash["map-pack"].stationSetSha256 = "a".repeat(63);
  assert.throws(() => validateArtifactIdentities(shortHash), /\^\[0-9a-f\]\{64\}\$/);

  const incompatibleStationSet = validArtifactIdentities();
  incompatibleStationSet["station-catalog-pack"].stationSetSha256 = "b".repeat(64);
  assert.throws(() => validateArtifactIdentities(incompatibleStationSet), /must equal map-pack.stationSetSha256/);
});

test("server component mutations reject missing or extra fields and non-atomic identities", () => {
  const missingIdentityField = validServerComponents();
  delete missingIdentityField.topology.bundleId;
  assert.throws(() => validateServerComponents(missingIdentityField), /topology identity keys/);

  const extraIdentityField = validServerComponents();
  extraIdentityField.topology.mapPackId = "map-2026-08-03";
  assert.throws(() => validateServerComponents(extraIdentityField), /topology identity keys/);

  const nonPositiveSequence = validServerComponents();
  nonPositiveSequence.fare.releaseSequence = 0;
  assert.throws(() => validateServerComponents(nonPositiveSequence), /releaseSequence must be positive/);

  const nonAtomicIdentity = validServerComponents();
  nonAtomicIdentity.accessibility.stationSetSha256 = "b".repeat(64);
  assert.throws(() => validateServerComponents(nonAtomicIdentity), /must equal topology/);
});
