import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { bindKorailCanonicalStations, projectKorailTopologyDurations } from "./parse-korail-metropolitan-timetable.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";

const SOURCE_ID = "korail-metropolitan-timetable-file";
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function materializeKorailRouteTopology({ pack, snapshot, inventory, ledger, now = new Date() } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf()) || !pack || !Array.isArray(pack.stations) || !Array.isArray(pack.stationLines) || !Array.isArray(pack.networkEdges)) fail("PACK");
  const source = requiredSource(inventory, snapshot);
  validateSnapshot(snapshot, ledger, now);
  const result = structuredClone(pack), lineId = snapshot.observation.selection.lineId;
  const line = result.lines?.filter((entry) => entry?.id === lineId) ?? [];
  if (!source.coverageScope?.lineIds?.includes(lineId) || line.length !== 1 || !source.coverageScope.operatorIds?.includes(line[0].operatorId)) fail("SCOPE");
  const bindings = bindKorailCanonicalStations({ stations: result.stations, stationLines: result.stationLines, lineId, orders: snapshot.observation.topology.orders });
  if (!isDeepStrictEqual(bindings, snapshot.observation.stationBindings)) fail("BINDINGS");
  const rows = projectKorailTopologyDurations(snapshot.observation);
  if (!isDeepStrictEqual(rows, snapshot.observation.topologyDurations) || rows.length !== snapshot.edgeCount || bindings.length !== snapshot.stationCount) fail("PROJECTION");
  // 폐지된 역을 가리키는 옛 RIDE도 선택 노선에 속하면 함께 교체한다.
  const selectedNode = (nodeId) => typeof nodeId === "string" && nodeId.endsWith(`:${lineId}`);
  const retained = result.networkEdges.filter((edge) => edge.edgeType !== "RIDE"
    || !selectedNode(edge.fromNodeId) || !selectedNode(edge.toNodeId));
  const generated = rows.map((row) => edge(row, snapshot, lineId));
  const ids = new Set(retained.map(({ id }) => id));
  for (const value of generated) { if (ids.has(value.id)) fail("EDGE_COLLISION"); ids.add(value.id); }
  result.networkEdges = [...retained, ...generated];
  const existing = result.sourceInventory?.filter(({ id }) => id === SOURCE_ID) ?? [];
  if (existing.length > 1) fail("PACK_SOURCE");
  const packSource = {
    id: source.id, owner: source.owner, url: source.datasetUrl, license: source.license.name,
    licenseStatus: "redistributable", redistributionAllowed: true, updateFrequency: source.updateFrequency,
    updatedAt: snapshot.capturedAt, fields: [...source.fieldsProvided], coverageScope: structuredClone(source.coverageScope),
  };
  result.sourceInventory = existing.length === 1 ? result.sourceInventory.map((item) => item.id === SOURCE_ID ? packSource : item) : [...(result.sourceInventory ?? []), packSource];
  if (result.minimumTableRows != null) result.minimumTableRows = { ...result.minimumTableRows, network_edges: result.networkEdges.length };
  return result;
}

function requiredSource(inventory, snapshot) {
  const sources = inventory?.sources?.filter((entry) => entry?.id === SOURCE_ID) ?? [];
  const evidence = sources[0]?.topologyAdmissionEvidence;
  if (sources.length !== 1 || sources[0].productionUseAllowed !== true || sources[0].requiredForProductionPack !== true
    || sources[0].license?.redistributionAllowed !== true
    || !["network_edges", "duration_seconds"].every((field) => sources[0].fieldsProvided?.includes(field))
    || evidence?.snapshotId !== snapshot?.snapshotId || evidence.snapshotPath !== `tools/datapack/sources/${snapshot.snapshotId}.json`
    || evidence.contentSha256 !== snapshot.contentSha256 || evidence.rawSha256 !== snapshot.rawSha256 || evidence.capturedAt !== snapshot.capturedAt || evidence.freshUntil !== snapshot.freshUntil
    || evidence.stationCount !== snapshot.stationCount || evidence.edgeCount !== snapshot.edgeCount || evidence.excludedTransferCount !== 0) fail("SOURCE");
  return sources[0];
}

function validateSnapshot(snapshot, ledger, now) {
  let capturedAt, freshUntil;
  try {
    capturedAt = requiredUtcInstant(snapshot?.capturedAt, "snapshot.capturedAt");
    freshUntil = requiredUtcInstant(snapshot?.freshUntil, "snapshot.freshUntil");
  } catch { fail("SNAPSHOT"); }
  const content = structuredClone(snapshot); delete content.contentSha256; delete content.snapshotId;
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "korail-metropolitan-topology-snapshot" || snapshot.sourceId !== SOURCE_ID || snapshot.status !== "PENDING" || snapshot.releaseEligible !== false
    || snapshot.snapshotId !== `${SOURCE_ID}-${snapshot.contentSha256}` || sha(canonicalJson(content)) !== snapshot.contentSha256
    || capturedAt > now.valueOf() || freshUntil <= now.valueOf()) fail("SNAPSHOT");
  const rows = ledger?.filter((entry) => entry?.sourceId === SOURCE_ID);
  let head;
  try { head = validateLineage(rows).headsBySource[SOURCE_ID]; } catch { fail("LINEAGE"); }
  const entry = rows.find(({ snapshotId }) => snapshotId === head);
  let retentionUntil;
  try { retentionUntil = requiredUtcInstant(entry?.rawRetentionExpiresAt, "ledger.rawRetentionExpiresAt"); }
  catch { fail("LEDGER"); }
  if (head !== snapshot.snapshotId || entry?.snapshotStatus !== "LOCKED" || entry.schemaStatus !== "PASS" || entry.licenseStatus !== "PASS" || entry.fetchStatus !== "SUCCESS" || entry.redistributionAllowed !== true
    || entry.contentSha256 !== snapshot.contentSha256 || entry.rawSha256 !== snapshot.rawSha256
    || entry.capturedAt !== snapshot.capturedAt || entry.retrievedAt !== snapshot.capturedAt
    || entry.freshnessExpiresAt !== snapshot.freshUntil || now.valueOf() >= retentionUntil
    || !/^oci:\/\//u.test(entry.rawObjectUri ?? "") || !/^[a-f0-9]{64}$/u.test(entry.rawReceiptSha256 ?? "")) fail("LEDGER");
}

function edge(row, snapshot, lineId) {
  return {
    id: `edge-${lineId}-${row.fromStationId}-${row.toStationId}`,
    fromNodeId: `${row.fromStationId}:${lineId}`,
    toNodeId: `${row.toStationId}:${lineId}`,
    durationSeconds: row.durationSeconds,
    edgeType: "RIDE",
    servicePattern: "LOCAL",
    serviceClass: "SUBWAY",
    includesStairs: false,
    stairAccessState: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    sourceId: SOURCE_ID,
    sourceSnapshotId: snapshot.snapshotId,
    providerRecordHash: sha(canonicalJson(row.witness)),
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus: "VERIFIED",
    lastVerifiedAt: snapshot.capturedAt,
    evidenceHash: snapshot.contentSha256,
    derivationPolicy: row.derivationPolicy,
    witness: structuredClone(row.witness),
    derivationKind: "OFFICIAL",
    fieldProvenance: { duration_seconds: { derivationKind: "GENERATED" } },
  };
}
function fail(code) { throw new Error(`KORAIL_ROUTE_TOPOLOGY_${code}`); }
