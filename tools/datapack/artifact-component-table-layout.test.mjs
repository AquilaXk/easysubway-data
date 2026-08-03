import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { canonicalJson } from "./lib/manifest-validation.mjs";

const contract = JSON.parse(readFileSync("contracts/datapack/artifact-component-table-layout.json", "utf8"));
const schema = JSON.parse(readFileSync("contracts/datapack/artifact-component-table-layout.schema.json", "utf8"));

const mapPayloadPaths = [
  "payload/metropolitan.svg",
  "payload/stations-layout.json",
  "payload/line-styles.json",
  "payload/interchange-layout.json",
];
const stationReferenceProjection = ["id"];
const lineReferenceProjection = ["id"];
const stationLineReferenceProjection = ["station_id", "line_id", "line_sequence"];

test("exact closed physical layout contract is accepted by its schema", () => {
  assert.equal(validateSchema(contract), true);
  assert.deepEqual(Object.keys(contract), ["schemaVersion", "artifactKind", "stationSet", "payloadInventory", "artifacts", "serverRouteBundle"]);
  assert.deepEqual(contract.artifacts.mapPack.payloadPaths, mapPayloadPaths);
  assert.deepEqual(contract.artifacts.stationCatalogPack.payloadPaths, ["payload/catalog.sqlite"]);
  assert.deepEqual(contract.serverRouteBundle.payloadPaths, [
    "payload/topology.sqlite.zst",
    "payload/timetable.sqlite.zst",
    "payload/accessibility.sqlite.zst",
    "payload/fare.sqlite.zst",
  ]);
});

test("station set and payload inventory digest boundaries exclude metadata self-reference", () => {
  assert.deepEqual(contract.stationSet, {
    source: { table: "stations", column: "id" },
    deduplicate: true,
    sort: "utf8-bytewise",
    canonicalization: "canonicalJson",
    encoding: "utf-8",
    digest: "sha256",
  });
  assert.deepEqual(contract.payloadInventory, {
    root: "payload/",
    fileKind: "regular-file-only",
    pathSort: "utf8-bytewise",
    entryFields: ["path", "sizeBytes", "sha256"],
    canonicalization: "canonicalJson",
    encoding: "utf-8",
    digest: "sha256",
    metadataPaths: ["manifest.json", "manifest.signing-input.json", "provenance.json", "compatibility.json"],
    reject: ["symlink", "unknown-path", "empty-file"],
  });
});

test("station set SHA-256 hashes UTF-8 bytewise sorted unique station IDs", () => {
  const base = stationSetSha256(["역-2", "역-1", "역-2"]);

  assert.equal(base, stationSetSha256(["역-1", "역-2"]));
  assert.notEqual(base, stationSetSha256(["역-1", "역-2", "역-3"]));
  assert.notEqual(base, stationSetSha256(["역-1"]));
});

test("payload inventory SHA-256 hashes path-sorted exact file entries", () => {
  const base = payloadInventorySha256([
    { path: "payload/나.sqlite", sizeBytes: 4, sha256: "a".repeat(64) },
    { path: "payload/가.sqlite", sizeBytes: 3, sha256: "b".repeat(64) },
  ]);

  assert.equal(base, payloadInventorySha256([
    { path: "payload/가.sqlite", sizeBytes: 3, sha256: "b".repeat(64) },
    { path: "payload/나.sqlite", sizeBytes: 4, sha256: "a".repeat(64) },
  ]));
  assert.notEqual(base, payloadInventorySha256([
    { path: "payload/다.sqlite", sizeBytes: 3, sha256: "b".repeat(64) },
    { path: "payload/나.sqlite", sizeBytes: 4, sha256: "a".repeat(64) },
  ]));
  assert.notEqual(base, payloadInventorySha256([
    { path: "payload/가.sqlite", sizeBytes: 3, sha256: "c".repeat(64) },
    { path: "payload/나.sqlite", sizeBytes: 4, sha256: "a".repeat(64) },
  ]));
  assert.notEqual(base, payloadInventorySha256([
    { path: "payload/가.sqlite", sizeBytes: 5, sha256: "b".repeat(64) },
    { path: "payload/나.sqlite", sizeBytes: 4, sha256: "a".repeat(64) },
  ]));
});

test("map and catalog projections keep only their owned table and field sets", () => {
  assert.deepEqual(contract.artifacts.mapPack.sourceTables, [
    "route_map_positions", "route_map_line_tracks", "stations", "lines", "station_lines",
  ]);
  assert.deepEqual(contract.artifacts.mapPack.projections, {
    stationsLayout: ["stationId", "lineId", "region", "x", "y", "labelDx", "labelDy", "labelPolygon", "upPath", "downPath"],
    lineStyles: ["lineId", "color"],
    interchangeLayout: ["stationId", "lineIds"],
  });
  assert.equal(contract.artifacts.mapPack.interchangeLineIds, "sorted-unique");
  assert.deepEqual(contract.artifacts.stationCatalogPack.projections, {
    stations: ["id", "name_ko", "name_en", "name_sub", "normalized_name", "region"],
    station_aliases: ["station_id", "alias", "normalized_alias"],
    lines: ["id", "name_ko", "name_en", "color"],
    station_lines: ["station_id", "line_id", "station_code", "line_sequence"],
    station_search_index: ["station_id", "token", "normalized_token", "source_kind"],
  });
  assert.deepEqual(contract.artifacts.stationCatalogPack.generatedTables, ["station_search_index"]);
});

test("server components repeat exact references and retain only their assigned tables", () => {
  const components = contract.serverRouteBundle.components;
  assert.deepEqual(contract.serverRouteBundle.componentIdentity, {
    source: {
      table: "artifact_component_identity",
      columns: ["bundleId", "releaseSequence", "stationSetSha256", "serviceTimezone"],
      rowCount: 1,
    },
    exactValues: { serviceTimezone: "Asia/Seoul" },
    equality: "identical-across-all-four-components",
  });
  for (const component of Object.values(components)) {
    assert.deepEqual(component.referenceProjections, {
      stations: stationReferenceProjection,
      lines: lineReferenceProjection,
      station_lines: stationLineReferenceProjection,
    });
    assert.equal(component.referenceRows, "canonical-rows-identical-across-components");
    assert.equal(component.foreignKeys, "within-component-only");
  }
  assert.deepEqual(components.topology.ownedTables, [
    "network_edges", "out_of_station_transfer_links", "transfer_rules", "realtime_provider_line_mappings", "realtime_provider_station_mappings",
  ]);
  assert.deepEqual(components.timetable.ownedTables, [
    "service_calendars", "service_calendar_dates", "transit_routes", "transit_trips", "transit_stop_times", "transit_frequencies", "transit_feed_info", "route_service_artifact_evidence",
  ]);
  assert.deepEqual(components.accessibility.ownedTables, [
    "station_exits", "facilities", "facility_status_snapshots", "station_facility_evidence", "station_accessibility_summaries", "internal_route_nodes", "internal_route_edges", "station_pathway_nodes", "station_pathway_edges", "station_car_door_hints",
  ]);
  assert.deepEqual(components.fare.ownedTables, [
    "fare_zones", "fare_rules", "fare_discounts", "station_fare_zones", "official_od_fare_quotes",
  ]);
  assert.deepEqual(contract.serverRouteBundle.forbiddenProjectionKinds, ["map", "search", "localized-name", "alias", "line-color"]);
});

test("server component identities cannot diverge", () => {
  for (const [field, value] of [
    ["bundleId", "route-2"],
    ["releaseSequence", 8],
    ["stationSetSha256", "b".repeat(64)],
    ["serviceTimezone", "UTC"],
  ]) {
    const components = componentIdentities();
    assertComponentIdentities(components);

    components.fare[field] = value;
    assert.throws(() => assertComponentIdentities(components), /component identity mismatch/);
  }
  const components = componentIdentities();
  for (const component of Object.values(components)) component.serviceTimezone = "UTC";
  assert.throws(() => assertComponentIdentities(components), /component identity exact value mismatch/);
});

test("bundle references, metadata digests, topology node grammar, raw component digests, and manifest-output signing input are closed", () => {
  const metadataPaths = ["manifest.json", "manifest.signing-input.json", "provenance.json", "compatibility.json"];
  assert.deepEqual(contract.serverRouteBundle.metadataPaths, metadataPaths);
  assert.deepEqual(contract.serverRouteBundle.crossComponentReferences, [
    { source: "topology.network_edges.facility_id", target: "accessibility.facilities.id", nullable: true },
    { source: "topology.transfer_rules.pathway_edge_id", target: "accessibility.station_pathway_edges.id", nullable: true },
    { source: "topology.transfer_rules.strict_step_free_pathway_edge_id", target: "accessibility.station_pathway_edges.id", nullable: true },
    { source: "topology.out_of_station_transfer_links.from_exit_id", target: "accessibility.station_exits.id", nullable: true },
    { source: "topology.out_of_station_transfer_links.to_exit_id", target: "accessibility.station_exits.id", nullable: true },
  ]);
  assert.deepEqual(contract.serverRouteBundle.networkEdgeEndpoints, {
    station: "stations.id",
    stationLine: "<stationId>:<lineId>[:<non-empty-suffix>...]",
    stationLinePair: "station_lines(station_id,line_id)",
    delimiter: ":",
    stationIdSegmentPattern: "^[^:]+$",
    lineIdSegmentPattern: "^[^:]+$",
    forbidEmptySegment: true,
    stationEndpointTypes: ["ENTRY", "EXIT"],
    stationEndpointConnectsTo: "same-station-station-line-endpoint",
    forbidden: ["accessibility.internal_route_nodes", "accessibility.station_pathway_nodes"],
  });
  assertStationLineSegments("station-a", "line-1");
  assert.throws(() => assertStationLineSegments("", "line-1"), /invalid station ID segment/);
  assert.throws(() => assertStationLineSegments("station:a", "line-1"), /invalid station ID segment/);
  assert.throws(() => assertStationLineSegments("station-a", ""), /invalid line ID segment/);
  assert.throws(() => assertStationLineSegments("station-a", "line:1"), /invalid line ID segment/);
  assert.deepEqual(contract.serverRouteBundle.componentDigest, {
    input: "raw-file-bytes",
    algorithm: "sha256",
    fields: ["topologySha256", "timetableSha256", "accessibilitySha256", "fareSha256"],
  });
  assert.deepEqual(contract.serverRouteBundle.metadataDigest, {
    input: "raw-file-bytes",
    algorithm: "sha256",
    bindings: {
      "provenance.json": "provenanceSha256",
      "compatibility.json": "compatibilitySha256",
    },
  });
  assert.deepEqual(contract.serverRouteBundle.unsignedSigningInput, {
    allowedPath: "manifest.signing-input.json",
    value: "canonicalJson(withoutSignature(serverManifest))",
    forbidden: ["manifest.json", "signature", "placeholder-signature"],
  });
  const serverManifest = { bundleId: "route-1", releaseSequence: 7, signature: "signed-value" };
  const correctSigningInput = canonicalJson({ bundleId: "route-1", releaseSequence: 7 });
  assertManifestOutputSigningInput({ "manifest.signing-input.json": correctSigningInput }, serverManifest);
  assert.throws(() => assertManifestOutputSigningInput({ "manifest.json": correctSigningInput }, serverManifest), /manifest.json is forbidden/);
  assert.throws(() => assertManifestOutputSigningInput({ signature: "placeholder" }, serverManifest), /signature is forbidden/);
  assert.throws(() => assertManifestOutputSigningInput({ "placeholder-signature": "value" }, serverManifest), /placeholder-signature is forbidden/);
  assert.throws(() => assertManifestOutputSigningInput({}, serverManifest), /must contain only manifest.signing-input.json/);
  assert.throws(() => assertManifestOutputSigningInput({ "manifest.signing-input.json": correctSigningInput, "unknown.json": "{}" }, serverManifest), /must contain only manifest.signing-input.json/);
  assert.throws(() => assertManifestOutputSigningInput({ "manifest.signing-input.json": canonicalJson(serverManifest) }, serverManifest), /must equal canonical signing input/);
  assert.throws(() => assertManifestOutputSigningInput({ "manifest.signing-input.json": "placeholder" }, serverManifest), /must equal canonical signing input/);
  assert.throws(() => assertManifestOutputSigningInput({ "manifest.signing-input.json": '{\n  "releaseSequence": 7,\n  "bundleId": "route-1"\n}' }, serverManifest), /must equal canonical signing input/);
  assert.throws(() => assertManifestOutputSigningInput({ "manifest.signing-input.json": correctSigningInput }, { bundleId: "route-1" }), /must have own signature/);
});

test("schema rejects physical-layout mutations that would widen or corrupt the contract", () => {
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.artifacts.mapPack.payloadPaths.push("payload/route.sqlite"); },
    (value) => { value.artifacts.mapPack.payloadPaths.push("payload/metropolitan.svg"); },
    (value) => { value.artifacts.mapPack.sourceTables.push("route_graph"); },
    (value) => { value.artifacts.mapPack.sourceTables.push("stations"); },
    (value) => { value.artifacts.mapPack.projections.lineStyles.push("nameKo"); },
    (value) => { value.artifacts.mapPack.projections.lineStyles.push("nameEn"); },
    (value) => { value.artifacts.stationCatalogPack.projections.stations.push("latitude"); },
    (value) => { value.serverRouteBundle.components.topology.ownedTables = value.serverRouteBundle.components.topology.ownedTables.filter((table) => table !== "realtime_provider_station_mappings"); },
    (value) => { value.serverRouteBundle.components.timetable.ownedTables = value.serverRouteBundle.components.timetable.ownedTables.filter((table) => table !== "route_service_artifact_evidence"); },
    (value) => { value.serverRouteBundle.components.topology.ownedTables.push("route_service_artifact_evidence"); },
    (value) => { value.serverRouteBundle.components.timetable.ownedTables.push("realtime_provider_line_mappings"); },
    (value) => { value.serverRouteBundle.componentIdentity.equality = "component-specific"; },
    (value) => { value.serverRouteBundle.componentIdentity.source.table = "component_identity"; },
    (value) => { value.serverRouteBundle.componentIdentity.source.columns.pop(); },
    (value) => { value.serverRouteBundle.componentIdentity.source.columns.push("extra"); },
    (value) => { value.serverRouteBundle.componentIdentity.source.rowCount = 2; },
    (value) => { value.serverRouteBundle.componentIdentity.exactValues.serviceTimezone = "UTC"; },
    (value) => { value.serverRouteBundle.crossComponentReferences[0].target = "accessibility.station_exits.id"; },
    (value) => { value.serverRouteBundle.networkEdgeEndpoints.delimiter = "-"; },
    (value) => { value.serverRouteBundle.networkEdgeEndpoints.stationIdSegmentPattern = ".+"; },
    (value) => { value.serverRouteBundle.networkEdgeEndpoints.lineIdSegmentPattern = "^[^;]+$"; },
    (value) => { value.stationSet.sort = "locale"; },
    (value) => { value.payloadInventory.metadataPaths.push("payload/manifest.json"); },
    (value) => { value.payloadInventory.metadataPaths.pop(); },
    (value) => { value.payloadInventory.metadataPaths[3] = "unknown.json"; },
    (value) => { value.payloadInventory.metadataPaths[3] = "provenance.json"; },
    (value) => { value.serverRouteBundle.metadataPaths[2] = "compatibility.json"; },
    (value) => { value.serverRouteBundle.metadataPaths.push("unknown.json"); },
    (value) => { value.serverRouteBundle.metadataDigest.bindings["provenance.json"] = "compatibilitySha256"; },
    (value) => { delete value.serverRouteBundle.metadataDigest.bindings["compatibility.json"]; },
    (value) => { value.serverRouteBundle.unsignedSigningInput.forbidden = ["manifest.json", "placeholder-signature"]; },
    (value) => { value.serverRouteBundle.unsignedSigningInput.forbidden = ["manifest.json", "signature"]; },
  ]) {
    const mutated = structuredClone(contract);
    mutate(mutated);
    assert.equal(validateSchema(mutated), false);
  }
});

function validateSchema(value) {
  return validateSchemaNode(schema, value);
}

function validateSchemaNode(rule, value) {
  if (rule.$ref) return validateSchemaNode(schema.$defs[rule.$ref.split("/").at(-1)], value);
  if (rule.const !== undefined && !isDeepStrictEqual(value, rule.const)) return false;
  if (rule.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if ((rule.required ?? []).some((field) => !Object.hasOwn(value, field))) return false;
    if (rule.additionalProperties === false && Object.keys(value).some((field) => !Object.hasOwn(rule.properties ?? {}, field))) return false;
    return Object.entries(rule.properties ?? {}).every(([field, property]) => !Object.hasOwn(value, field) || validateSchemaNode(property, value[field]));
  }
  if (rule.type === "array") {
    if (!Array.isArray(value)) return false;
    if (rule.minItems !== undefined && value.length < rule.minItems) return false;
    if (rule.maxItems !== undefined && value.length > rule.maxItems) return false;
    if (rule.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    return rule.items === undefined || value.every((item) => validateSchemaNode(rule.items, item));
  }
  if (rule.type === "string") return typeof value === "string";
  if (rule.type === "integer") return Number.isInteger(value);
  if (rule.type === "boolean") return typeof value === "boolean";
  return true;
}

function stationSetSha256(stationIds) {
  return sha256(canonicalJson([...new Set(stationIds)].sort(compareUtf8Bytes)));
}

function payloadInventorySha256(entries) {
  return sha256(canonicalJson([...entries].sort((left, right) => compareUtf8Bytes(left.path, right.path))));
}

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertComponentIdentities(components) {
  const [first, ...remaining] = Object.values(components);
  for (const component of remaining) {
    for (const field of contract.serverRouteBundle.componentIdentity.source.columns) {
      assert.equal(component[field], first[field], `component identity mismatch: ${field}`);
    }
  }
  for (const [field, value] of Object.entries(contract.serverRouteBundle.componentIdentity.exactValues)) {
    assert.equal(first[field], value, `component identity exact value mismatch: ${field}`);
  }
}

function assertStationLineSegments(stationId, lineId) {
  const endpoints = contract.serverRouteBundle.networkEdgeEndpoints;
  assert.match(stationId, new RegExp(endpoints.stationIdSegmentPattern), "invalid station ID segment");
  assert.match(lineId, new RegExp(endpoints.lineIdSegmentPattern), "invalid line ID segment");
}

function componentIdentities() {
  return {
    topology: { bundleId: "route-1", releaseSequence: 7, stationSetSha256: "a".repeat(64), serviceTimezone: "Asia/Seoul" },
    timetable: { bundleId: "route-1", releaseSequence: 7, stationSetSha256: "a".repeat(64), serviceTimezone: "Asia/Seoul" },
    accessibility: { bundleId: "route-1", releaseSequence: 7, stationSetSha256: "a".repeat(64), serviceTimezone: "Asia/Seoul" },
    fare: { bundleId: "route-1", releaseSequence: 7, stationSetSha256: "a".repeat(64), serviceTimezone: "Asia/Seoul" },
  };
}

function assertManifestOutputSigningInput(manifestOutput, serverManifest) {
  assert.equal(Object.hasOwn(serverManifest, "signature"), true, "server manifest must have own signature");
  for (const forbidden of contract.serverRouteBundle.unsignedSigningInput.forbidden) {
    assert.equal(Object.hasOwn(manifestOutput, forbidden), false, `${forbidden} is forbidden`);
  }
  assert.deepEqual(Object.keys(manifestOutput), [contract.serverRouteBundle.unsignedSigningInput.allowedPath],
    `manifest output signing-input subset must contain only ${contract.serverRouteBundle.unsignedSigningInput.allowedPath}`,
  );
  const { signature, ...unsignedServerManifest } = serverManifest;
  assert.equal(manifestOutput[contract.serverRouteBundle.unsignedSigningInput.allowedPath], canonicalJson(unsignedServerManifest),
    "manifest output signing input must equal canonical signing input",
  );
}
