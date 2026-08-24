import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  parseCurrentMolitDaeguStationMappings,
  parseCurrentMolitDaejeonStationMappings,
  parseCurrentMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";

const ITX_TOKEN = /(?:^|[^A-Z0-9])ITX(?:[_-]|$)/;
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const MOLIT_SOURCE_ID = "molit-urban-rail-full-route";
const SHA256 = /^[a-f0-9]{64}$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const HISTORICAL_MOLIT_ADMISSION = Object.freeze({
  snapshotId: "molit-urban-rail-full-route-revalidated-20260814",
  rawSha256: "178af75ece72b2f6a58226063e05f1e1f45f50c779c7fbf2905f7df1384a9e22",
  schemaFingerprint: "07a90f2fcca80323978aa63eff05b24e8ad431b579a1fad05f989d175114250c",
});
const HISTORICAL_MOLIT_MAPPING_SNAPSHOT_SHA256 = "3f08fb398bcb16e8ff047ec17f094a28590ec8d5aa1b8df2d6e9cec85ed0f6e7";
const HISTORICAL_MEMBERSHIP_BY_LINE = Object.freeze({
  "line-7051a9c2525c": Object.freeze({
    sourceIds: Object.freeze(["daejeon-station-distance-fare", "molit-urban-rail-full-route-daejeon-membership"]),
    verifiedAt: "2026-07-20T03:30:00.000Z", stationCount: 22,
    mappingSha256: "a73ae83fbeb294c293a22bda5a44aef0a9263596fa6ef196f0c06670e918422f",
    stationCodesSha256: "4f9ad3bbf2efbf7dcdac8976eb18b34b4c9e5936ba7bcd1316c03dc516e1dd49",
  }),
  "line-e57a361e8892": Object.freeze({
    sourceIds: Object.freeze(["gwangju-transportation-route-topology", "molit-urban-rail-full-route-gwangju-membership"]),
    verifiedAt: "2026-07-20T13:08:47.161Z", stationCount: 20,
    mappingSha256: "f7515bed1908e7b1aff2674f58b8425d94a8177d1fb5bed1f3fb8545cb347a03",
    stationCodesSha256: "dc831a8f14fd33808b6e17ecbf829eb6d4c199b6c1d75c7673adaa97ad69df83",
  }),
  "line-5b8d9b05e7e6": Object.freeze({
    sourceIds: Object.freeze(["daegu-line1-route-topology", "molit-urban-rail-full-route-daegu-line1-membership"]),
    verifiedAt: "2026-07-20T15:30:00.000Z", stationCount: 35,
    mappingSha256: "50810515863d5566cb968d5d07bbd35f5b2f6434436a21d43e2506da7beb3312",
    stationCodesSha256: "2a9169367a78c7d63b99dbd3a66f95b661f54c984330564a7fa19c2ddddcb17b",
  }),
  "line-e2938a4cc492": Object.freeze({
    sourceIds: Object.freeze(["daegu-line2-route-topology", "molit-urban-rail-full-route-daegu-line2-membership"]),
    verifiedAt: "2026-07-20T15:30:00.000Z", stationCount: 29,
    mappingSha256: "9ce93ff604ead4a3e49ddde6d5300e17b7544fe0924994b3bf45cc791cd76129",
    stationCodesSha256: "b89277686bb18cc3c09b22b967cf21c290fa1c34a975260f401528cd248321ca",
  }),
  "line-0ffaa95b1b5d": Object.freeze({
    sourceIds: Object.freeze(["daegu-line3-route-topology", "molit-urban-rail-full-route-daegu-line3-membership"]),
    verifiedAt: "2026-07-20T15:30:00.000Z", stationCount: 30,
    mappingSha256: "d67b2e8d505fc8202c0b2522118a2254b8a143d4df52f859b281625ddee69c0d",
    stationCodesSha256: "ccbdac20980dd1135646a6dfdc97b0251df0df36af56de76a2fb14f1a0051afe",
  }),
});
const LEGACY_ROUTE_SERVICE_ARTIFACT_EVIDENCE = Object.freeze({
  serviceClass: "ITX_CHEONGCHUN",
  timetableArtifactId: "itx-cheongchun-completeness-admission-20260714T083544292Z",
  timetableArtifactSha256: "347aec507ec951dde65c10a1c4bff9f94454f762d76a5a74064a40662008336c",
  canonicalPackId: "capital",
  canonicalPackSha256: "580814a58ce8d94b174de1ca8753ef7f350ce806dd793f6a7f43e07e7aa155b9",
  canonicalPackSqliteSha256: "72b85f941a8cb3a905218287a3e2ff4ce38561397ed5c22d77816576529ffe03",
  admissionStatus: "MISSING",
  admissionEligible: false,
  freshUntil: "2026-07-20T00:00:00.000Z",
  sourceIssue: 2116,
});

function rejectItxReference(value, path = "fixture") {
  if (typeof value === "string") {
    const token = value.toUpperCase();
    if (ITX_TOKEN.test(token)) {
      throw new Error(`${path} contains an unexpected ITX reference`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectItxReference(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      rejectItxReference(entry, `${path}.${key}`);
    }
  }
}

/**
 * Produces the sole test-only materializer projection: current capital@1 as-is,
 * or historical capital@1 without its exact legacy route-service evidence.
 * Timetable/topology rows are never filtered.
 */
export function projectRegionalMaterializeFixture(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("fixture root must be an object");
  }
  const rootKeys = Object.keys(input);
  if (rootKeys.length !== 2 || !rootKeys.includes("manifest") || !rootKeys.includes("packs")) {
    throw new Error("fixture root must contain exactly manifest and packs");
  }
  const fixture = structuredClone(input);
  if (fixture.manifest?.activePack?.id !== "capital" || fixture.manifest?.activePack?.version !== "1") {
    throw new Error("fixture must have active capital@1 manifest pack");
  }
  if (!Array.isArray(fixture.packs) || fixture.packs.length !== 1) {
    throw new Error("fixture must contain exactly one capital@1 pack");
  }

  const [pack] = fixture.packs;
  if (pack.id !== "capital" || pack.version !== "1" || pack.artifactKind !== "production") {
    throw new Error("fixture must contain exactly one capital@1 pack");
  }
  if (!Array.isArray(pack.routeServiceArtifactEvidence)
    || pack.routeServiceArtifactEvidence.length > 1) {
    throw new Error("capital@1 must contain zero current or exactly one legacy routeServiceArtifactEvidence");
  }

  if (pack.routeServiceArtifactEvidence.length === 1) {
    const [legacyEvidence] = pack.routeServiceArtifactEvidence;
    if (JSON.stringify(legacyEvidence) !== JSON.stringify(LEGACY_ROUTE_SERVICE_ARTIFACT_EVIDENCE)) {
      throw new Error("capital@1 legacy routeServiceArtifactEvidence must match the exact known contract");
    }
    delete pack.routeServiceArtifactEvidence;
  }
  rejectItxReference(fixture, "fixture");
  return fixture;
}

/**
 * Replays the exact July regional materialization boundary without treating
 * the historical MOLIT tuple as a current source. Current source admission is
 * validated before the clone is projected; production inventory is untouched.
 */
export function projectHistoricalRegionalMaterializeInventory(input) {
  if (input?.schemaVersion !== 1 || input.artifactKind !== "production-source-inventory"
    || !Array.isArray(input.sources)) {
    throw new Error("regional materializer inventory is invalid");
  }
  const inventory = structuredClone(input);
  const rawSources = inventory.sources.filter(({ id }) => id === MOLIT_SOURCE_ID);
  if (rawSources.length !== 1 || rawSources[0].admissionEvidence?.decision !== "APPROVED"
    || !SHA256.test(rawSources[0].admissionEvidence?.rawSha256 ?? "")) {
    throw new Error("current MOLIT admission is invalid");
  }
  const currentRawSha256 = rawSources[0].admissionEvidence.rawSha256;
  for (const [lineId, expected] of Object.entries(HISTORICAL_MEMBERSHIP_BY_LINE)) {
    const matches = inventory.sources.filter(({ membershipAdmissionEvidence: evidence }) =>
      Array.isArray(evidence?.lineIds) && evidence.lineIds.length === 1 && evidence.lineIds[0] === lineId);
    if (matches.length !== 2
      || JSON.stringify(matches.map(({ id }) => id).sort((left, right) => left.localeCompare(right, "en")))
        !== JSON.stringify([...expected.sourceIds].sort((left, right) => left.localeCompare(right, "en")))) {
      throw new Error(`regional materializer ${lineId} membership inventory is incomplete`);
    }
    for (const source of matches) {
      const evidence = source.membershipAdmissionEvidence;
      if (evidence.membershipSourceId !== MOLIT_SOURCE_ID
        || evidence.membershipSourceRawSha256 !== currentRawSha256
        || evidence.membershipSourceSnapshotSha256 !== currentRawSha256
        || evidence.stationCount !== expected.stationCount
        || evidence.mappingSha256 !== expected.mappingSha256
        || evidence.stationCodesSha256 !== expected.stationCodesSha256) {
        throw new Error(`current MOLIT ${lineId} membership inventory is invalid`);
      }
      evidence.verifiedAt = expected.verifiedAt;
      evidence.membershipSourceRawSha256 = HISTORICAL_MOLIT_ADMISSION.rawSha256;
      evidence.membershipSourceSnapshotSha256 = HISTORICAL_MOLIT_MAPPING_SNAPSHOT_SHA256;
    }
  }
  Object.assign(rawSources[0].admissionEvidence, HISTORICAL_MOLIT_ADMISSION);
  return inventory;
}

function assertCurrentMolitObservation({ inventory, snapshots, observation, observationBytes }) {
  const source = inventory?.sources?.find(({ id }) => id === MOLIT_SOURCE_ID);
  const admission = source?.admissionEvidence;
  if (!source || !admission || admission.sourceId !== MOLIT_SOURCE_ID
    || admission.decision !== "APPROVED" || typeof admission.snapshotId !== "string"
    || !SHA256.test(admission.rawSha256 ?? "")) {
    throw new Error("current MOLIT inventory admission is invalid");
  }
  const snapshot = snapshots.filter(({ sourceId, snapshotId }) =>
    sourceId === MOLIT_SOURCE_ID && snapshotId === admission.snapshotId);
  if (snapshot.length !== 1 || snapshot[0].rawSha256 !== admission.rawSha256
    || !SHA256.test(snapshot[0].contentSha256 ?? "")
    || !SHA256.test(snapshot[0].normalizedObservationSha256 ?? "")
    || snapshot[0].snapshotStatus !== "LOCKED" || snapshot[0].fetchStatus !== "SUCCESS"
    || snapshot[0].schemaStatus !== "PASS" || snapshot[0].licenseStatus !== "PASS"
    || snapshot[0].redistributionAllowed !== true || snapshot[0].credentialRedacted !== true) {
    throw new Error("current MOLIT source snapshot binding is invalid");
  }
  const [current] = snapshot;
  if (sha256(observationBytes) !== current.normalizedObservationSha256
    || observation?.sourceId !== MOLIT_SOURCE_ID || observation.snapshotId !== current.snapshotId
    || observation.capturedAt !== current.retrievedAt
    || observation.rawSha256 !== current.rawSha256 || observation.contentSha256 !== current.contentSha256
    || observation.schemaFingerprint !== current.schemaFingerprint
    || observation.rowCount !== current.rowCount || !Array.isArray(observation.normalizedProjection)
    || sha256(Buffer.from(`${JSON.stringify(observation.normalizedProjection)}\n`)) !== current.contentSha256
    || JSON.stringify(observation.providerRecordHashes) !== JSON.stringify(current.providerRecordHashes)
    || JSON.stringify(observation.providerRecordHashes) !== JSON.stringify(
      observation.normalizedProjection.map((record) => sha256(JSON.stringify(record))),
    )) {
    throw new Error("current MOLIT normalized observation binding is invalid");
  }
  return { current, source };
}

function assertMembershipAdmission(inventory, lineId, mappings) {
  const expected = HISTORICAL_MEMBERSHIP_BY_LINE[lineId];
  const matches = inventory.sources.filter(({ membershipAdmissionEvidence: evidence }) =>
    evidence?.membershipSourceId === MOLIT_SOURCE_ID
      && Array.isArray(evidence.lineIds) && evidence.lineIds.length === 1
      && evidence.lineIds[0] === lineId);
  if (!expected || matches.length !== 2
    || JSON.stringify(matches.map(({ id }) => id).sort((left, right) => left.localeCompare(right, "en")))
      !== JSON.stringify([...expected.sourceIds].sort((left, right) => left.localeCompare(right, "en")))) {
    throw new Error(`current MOLIT ${lineId} membership admission is incomplete`);
  }
  const mappingSha256 = sha256(JSON.stringify(mappings));
  const stationCodesSha256 = mappings[0]?.stationNumber == null
    ? null
    : sha256(JSON.stringify(mappings.map(({ stationNumber }) => stationNumber)));
  for (const { membershipAdmissionEvidence: evidence } of matches) {
    if (evidence.stationCount !== mappings.length
      || evidence.membershipSourceRawSha256 !== mappings.sourceRawSha256
      || evidence.membershipSourceSnapshotSha256 !== mappings.sourceRawSha256
      || evidence.mappingSha256 !== mappingSha256
      || stationCodesSha256 != null && evidence.stationCodesSha256 !== stationCodesSha256) {
      throw new Error(`current MOLIT ${lineId} membership admission is invalid`);
    }
  }
}

/**
 * Reads the tracked current MOLIT normalized observation and returns the five
 * regional membership mappings bound to the active inventory and ledger head.
 */
export async function loadCurrentMolitMembershipMappings({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  const root = path.resolve(repositoryRoot);
  const [inventoryBytes, snapshotBytes] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json")),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json")),
  ]);
  const inventory = JSON.parse(inventoryBytes);
  const snapshots = JSON.parse(snapshotBytes);
  const admission = inventory?.sources?.find(({ id }) => id === MOLIT_SOURCE_ID)?.admissionEvidence;
  if (typeof admission?.snapshotId !== "string" || !/^molit-urban-rail-full-route-current-20\d{6}T\d{9}Z$/u.test(admission.snapshotId)) {
    throw new Error("current MOLIT observation snapshot id is invalid");
  }
  const observationBytes = await readFile(path.join(root, "tools/datapack/sources", `${admission.snapshotId}.json`));
  const observation = JSON.parse(observationBytes);
  const { current } = assertCurrentMolitObservation({ inventory, snapshots, observation, observationBytes });
  const projection = observation.normalizedProjection;
  const daejeon = parseCurrentMolitDaejeonStationMappings(projection, current.rawSha256);
  const gwangju = parseCurrentMolitGwangjuStationMappings(projection, current.rawSha256);
  const daeguLine1 = parseCurrentMolitDaeguStationMappings(projection, current.rawSha256, "1호선");
  const daeguLine2 = parseCurrentMolitDaeguStationMappings(projection, current.rawSha256, "2호선");
  const daeguLine3 = parseCurrentMolitDaeguStationMappings(projection, current.rawSha256, "3호선");
  for (const [lineId, mappings] of [
    ["line-7051a9c2525c", daejeon], ["line-e57a361e8892", gwangju],
    ["line-5b8d9b05e7e6", daeguLine1], ["line-e2938a4cc492", daeguLine2], ["line-0ffaa95b1b5d", daeguLine3],
  ]) assertMembershipAdmission(inventory, lineId, mappings);
  return { daejeon, gwangju, daeguLine1, daeguLine2, daeguLine3 };
}
