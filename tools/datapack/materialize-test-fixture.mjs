import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256 as manifestSha256, withoutSignature } from "./lib/manifest-validation.mjs";
import { rsaSha256Signature } from "./lib/manifest-signing.mjs";

import {
  parseCurrentMolitDaeguStationMappings,
  parseCurrentMolitDaejeonStationMappings,
  parseCurrentMolitGwangjuStationMappings,
  parseMolitDaejeonStationMappings,
  parseMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { loadCurrentMolitObservation } from "./current-molit-observation.mjs";
import {
  canonicalStationMappingHash,
  materializeBusanRouteTopology,
  parseCanonicalBusanStationMappings,
} from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import { materializeGwangjuAccessibility } from "./materialize-gwangju-accessibility.mjs";
import { collectGwangjuAccessibility } from "./collect-gwangju-accessibility.mjs";
import { materializeGwangjuRouteMapPositions } from "./materialize-gwangju-route-map-positions.mjs";
import { materializeRetainedGwangjuTestFixture } from "./gwangju-retained-test-fixture.mjs";
import { materializeDaejeonRouteMapPositions } from "./materialize-daejeon-route-map-positions.mjs";
import { materializeSeoul9Phase1RouteMapPositions } from "./materialize-seoul9-phase1-route-map-positions.mjs";

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

/** 하위 materializer 테스트가 공유하는 부산 topology·대전 timetable·부산 timetable prefix. */
export function materializeRegionalBusanTimetablePrefix({
  baseFixture,
  busanTopology,
  busanTimetable,
  daejeonTopology,
  daejeonTimetable,
  inventory,
  stationMapCsv,
  molitStationMapCsv,
  topologyNow,
  timetableNow,
}) {
  const busanTopologyFixture = materializeBusanRouteTopology({
    baseFixture,
    snapshot: busanTopology,
    inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(stationMapCsv),
    now: topologyNow,
  });
  const daejeonFixture = materializeDaejeonTimetable({
    baseFixture: busanTopologyFixture,
    timetableSnapshot: daejeonTimetable,
    topologySnapshot: daejeonTopology,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitStationMapCsv),
    now: timetableNow,
  });
  const busanTimetableFixture = materializeBusanTimetable({
    baseFixture: daejeonFixture,
    timetableSnapshot: busanTimetable,
    topologySnapshot: busanTopology,
    inventory,
    now: timetableNow,
  });
  return { busanTopologyFixture, daejeonFixture, busanTimetableFixture };
}

/**
 * TEST-only projection: keep the caller's inventory metadata, but bind its
 * snapshot-sensitive fields to the retained inputs that this fixture actually
 * materializes. Production inventory and source artifacts stay unchanged.
 */
export function projectRegionalFixtureSourceBindings({
  inventory,
  busanTopology = null,
  busanTimetable = null,
  stationMapCsv = null,
  gwangjuTopology = null,
  molitStationMapCsv = null,
  gwangjuRouteMapSnapshot = null,
  gwangjuRouteMapSnapshotBytes = null,
  daejeonTopology = null,
  daejeonTimetable = null,
  daejeonRouteMapSnapshot = null,
  daejeonRouteMapSnapshotBytes = null,
  daejeonAccessibilitySnapshot = null,
  daejeonAccessibilitySnapshotBytes = null,
}) {
  const projected = structuredClone(inventory);
  if (busanTopology) {
    const topology = source(projected, busanTopology.sourceId);
    const snapshotId = fixtureSnapshotId(topology.id, busanTopology.capturedAt);
    const topologyEvidence = {
      ...topology.topologyAdmissionEvidence,
      snapshotId,
      snapshotPath: fixtureSnapshotPath(snapshotId),
      capturedAt: busanTopology.capturedAt,
      freshUntil: busanTopology.freshUntil,
      stationCount: busanTopology.stationCount,
      edgeCount: busanTopology.edgeCount,
      excludedTransferCount: busanTopology.excludedTransferCount,
      rawSha256: busanTopology.rawSha256,
      contentSha256: busanTopology.contentSha256,
    };
    const canonicalMappings = parseCanonicalBusanStationMappings(stationMapCsv);
    topology.topologyAdmissionEvidence = topologyEvidence;
    topology.membershipAdmissionEvidence = {
      ...topology.membershipAdmissionEvidence,
      snapshotId,
      verifiedAt: busanTopology.capturedAt,
      stationCount: busanTopology.stationCount,
      lineIds: structuredClone(busanTopology.lineIds),
      membershipSourceId: topology.id,
      membershipSourceRawSha256: busanTopology.rawSha256,
      membershipSourceSnapshotSha256: busanTopology.scopeSha256,
      mappingSha256: canonicalStationMappingHash(canonicalMappings, busanTopology.scope),
      stationCodesSha256: sha256(JSON.stringify(busanTopology.scope.map(({ stationCode }) => stationCode))),
      stationCodeSourceId: topology.id,
      stationCodeSnapshotId: snapshotId,
      stationCodeContentSha256: busanTopology.contentSha256,
    };
    if (busanTimetable) {
      const timetable = source(projected, busanTimetable.sourceId);
      timetable.scheduleAdmissionEvidence = {
        ...timetable.scheduleAdmissionEvidence,
        topologySourceId: topology.id,
        topologySnapshotId: snapshotId,
        topologyContentSha256: busanTopology.contentSha256,
      };
    }
  }
  if (gwangjuTopology) {
    const topology = source(projected, gwangjuTopology.sourceId);
    const membership = source(projected, "molit-urban-rail-full-route-gwangju-membership");
    const snapshotId = fixtureSnapshotId(topology.id, gwangjuTopology.capturedAt);
    const mappings = parseMolitGwangjuStationMappings(molitStationMapCsv, gwangjuTopology);
    const mappingSha256 = sha256(JSON.stringify(mappings));
    const stationCodesSha256 = sha256(JSON.stringify(mappings.map(({ stationNumber }) => stationNumber)));
    topology.topologyAdmissionEvidence = {
      ...topology.topologyAdmissionEvidence,
      snapshotId,
      snapshotPath: fixtureSnapshotPath(snapshotId),
      capturedAt: gwangjuTopology.capturedAt,
      freshUntil: gwangjuTopology.freshUntil,
      stationCount: gwangjuTopology.stationCount,
      edgeCount: gwangjuTopology.edgeCount,
      rawSha256: gwangjuTopology.rawSha256,
      contentSha256: gwangjuTopology.contentSha256,
    };
    const membershipEvidence = {
      ...membership.membershipAdmissionEvidence,
      stationCount: mappings.length,
      membershipSourceSnapshotSha256: mappings.sourceRawSha256,
      mappingSha256,
      stationCodesSha256,
      stationCodeSourceId: topology.id,
      stationCodeSnapshotId: snapshotId,
      stationCodeContentSha256: gwangjuTopology.contentSha256,
    };
    membership.membershipAdmissionEvidence = membershipEvidence;
    topology.membershipAdmissionEvidence = structuredClone(membershipEvidence);
  }
  if (gwangjuRouteMapSnapshot) {
    if (!(gwangjuRouteMapSnapshotBytes instanceof Uint8Array)) {
      throw new Error("regional Gwangju route map fixture bytes are required");
    }
    const routeMap = source(projected, gwangjuRouteMapSnapshot.sourceId);
    const topology = source(projected, gwangjuRouteMapSnapshot.topologyLineages?.[0]?.sourceId);
    const snapshotId = fixtureSnapshotId(routeMap.id, gwangjuRouteMapSnapshot.capturedAt);
    const topologyEvidence = topology.topologyAdmissionEvidence;
    routeMap.routeMapAdmissionEvidence = {
      ...routeMap.routeMapAdmissionEvidence,
      snapshotId,
      snapshotPath: fixtureSnapshotPath(snapshotId),
      snapshotSha256: sha256(gwangjuRouteMapSnapshotBytes),
      capturedAt: gwangjuRouteMapSnapshot.capturedAt,
      stationCount: gwangjuRouteMapSnapshot.stationCount,
      rawStationCount: gwangjuRouteMapSnapshot.rawStationCount,
      quarantinedCount: gwangjuRouteMapSnapshot.quarantinedCount,
      datasetId: gwangjuRouteMapSnapshot.datasetId,
      datasetIds: structuredClone(gwangjuRouteMapSnapshot.datasetIds),
      rawSha256: gwangjuRouteMapSnapshot.rawSha256,
      positionsSha256: gwangjuRouteMapSnapshot.positionsSha256,
      lineIds: structuredClone(gwangjuRouteMapSnapshot.lineIds),
      lineStationCounts: structuredClone(gwangjuRouteMapSnapshot.lineStationCounts),
      observedDataUpdatedAt: gwangjuRouteMapSnapshot.observedDataUpdatedAt,
      topologySourceId: topology.id,
      topologySnapshotId: topologyEvidence.snapshotId,
      topologyContentSha256: gwangjuTopology.contentSha256,
      topologyLineages: gwangjuRouteMapSnapshot.topologyLineages.map((lineage) => ({
        ...lineage,
        snapshotId: topologyEvidence.snapshotId,
        contentSha256: gwangjuTopology.contentSha256,
      })),
    };
  }
  if (daejeonTopology) {
    const topology = source(projected, daejeonTopology.sourceId);
    const membership = source(projected, "molit-urban-rail-full-route-daejeon-membership");
    const dependentLineage = (daejeonRouteMapSnapshot ?? daejeonAccessibilitySnapshot)
      ?.topologyLineages?.find(({ sourceId }) => sourceId === topology.id);
    const snapshotId = dependentLineage?.snapshotId
      ?? fixtureSnapshotId(topology.id, daejeonTopology.observedAt);
    const mappings = parseMolitDaejeonStationMappings(molitStationMapCsv);
    const mappingSha256 = sha256(JSON.stringify(mappings));
    const stationCodesSha256 = sha256(JSON.stringify(mappings.map(({ stationNumber }) => stationNumber)));
    topology.topologyAdmissionEvidence = {
      ...topology.topologyAdmissionEvidence,
      snapshotId,
      snapshotPath: fixtureSnapshotPath(snapshotId),
      capturedAt: daejeonTopology.observedAt,
      freshUntil: new Date(Date.parse(daejeonTopology.observedAt)
        + Date.parse(topology.topologyAdmissionEvidence.freshUntil)
        - Date.parse(topology.topologyAdmissionEvidence.capturedAt)).toISOString(),
      stationCount: daejeonTopology.stationNumbers.length,
      edgeCount: daejeonTopology.rowCount,
      excludedTransferCount: daejeonTopology.excludedTransferCount,
      rawSha256: daejeonTopology.rawSha256,
      contentSha256: daejeonTopology.contentSha256,
    };
    const membershipEvidence = {
      ...membership.membershipAdmissionEvidence,
      stationCount: mappings.length,
      mappingSha256,
      stationCodesSha256,
      stationCodeSourceId: topology.id,
      stationCodeSnapshotId: snapshotId,
      stationCodeContentSha256: daejeonTopology.contentSha256,
    };
    membership.membershipAdmissionEvidence = membershipEvidence;
    topology.membershipAdmissionEvidence = structuredClone(membershipEvidence);
    if (daejeonTimetable) {
      const timetable = source(projected, daejeonTimetable.sourceId);
      timetable.scheduleAdmissionEvidence = {
        ...timetable.scheduleAdmissionEvidence,
        topologySourceId: topology.id,
        topologySnapshotId: snapshotId,
        topologyContentSha256: daejeonTopology.contentSha256,
      };
    }
  }
  if (daejeonRouteMapSnapshot) {
    if (!(daejeonRouteMapSnapshotBytes instanceof Uint8Array)) {
      throw new Error("regional Daejeon route map fixture bytes are required");
    }
    const routeMap = source(projected, daejeonRouteMapSnapshot.sourceId);
    const topology = source(projected, daejeonRouteMapSnapshot.topologySourceId);
    const topologyEvidence = topology.topologyAdmissionEvidence;
    const snapshotId = fixtureSnapshotId(routeMap.id, daejeonRouteMapSnapshot.capturedAt);
    routeMap.routeMapAdmissionEvidence = {
      ...routeMap.routeMapAdmissionEvidence,
      snapshotId,
      snapshotPath: fixtureSnapshotPath(snapshotId),
      snapshotSha256: sha256(daejeonRouteMapSnapshotBytes),
      capturedAt: daejeonRouteMapSnapshot.capturedAt,
      stationCount: daejeonRouteMapSnapshot.stationCount,
      rawStationCount: daejeonRouteMapSnapshot.rawStationCount,
      quarantinedCount: daejeonRouteMapSnapshot.quarantinedCount,
      datasetId: daejeonRouteMapSnapshot.datasetId,
      datasetIds: structuredClone(daejeonRouteMapSnapshot.datasetIds),
      rawSha256: daejeonRouteMapSnapshot.rawSha256,
      positionsSha256: daejeonRouteMapSnapshot.positionsSha256,
      lineIds: structuredClone(daejeonRouteMapSnapshot.lineIds),
      lineStationCounts: structuredClone(daejeonRouteMapSnapshot.lineStationCounts),
      observedDataUpdatedAt: daejeonRouteMapSnapshot.observedDataUpdatedAt,
      topologySourceId: topology.id,
      topologySnapshotId: topologyEvidence.snapshotId,
      topologyContentSha256: topologyEvidence.contentSha256,
      topologyLineages: daejeonRouteMapSnapshot.topologyLineages.map((lineage) => ({
        ...lineage,
        snapshotId: topologyEvidence.snapshotId,
        contentSha256: topologyEvidence.contentSha256,
      })),
    };
  }
  if (daejeonAccessibilitySnapshot) {
    if (!(daejeonAccessibilitySnapshotBytes instanceof Uint8Array)) {
      throw new Error("regional Daejeon accessibility fixture bytes are required");
    }
    const accessibility = source(projected, daejeonAccessibilitySnapshot.sourceId);
    const topology = source(projected, daejeonAccessibilitySnapshot.topologyLineages?.[0]?.sourceId);
    const topologyEvidence = topology.topologyAdmissionEvidence;
    const snapshotId = fixtureSnapshotId(accessibility.id, daejeonAccessibilitySnapshot.capturedAt);
    accessibility.fieldsProvided = structuredClone(daejeonAccessibilitySnapshot.fieldsProvided);
    accessibility.accessibilityAdmissionEvidence = {
      ...accessibility.accessibilityAdmissionEvidence,
      snapshotId,
      snapshotPath: fixtureSnapshotPath(snapshotId),
      capturedAt: daejeonAccessibilitySnapshot.capturedAt,
      freshUntil: daejeonAccessibilitySnapshot.freshUntil,
      stationCount: daejeonAccessibilitySnapshot.stationCount,
      rowCount: daejeonAccessibilitySnapshot.rowCount,
      facilityCount: daejeonAccessibilitySnapshot.rows.reduce((count, row) => count
        + Number(row.elevator !== null)
        + Number(row.escalator !== null)
        + Number(row.wheelchair_lift !== null), 0),
      rawSha256: daejeonAccessibilitySnapshot.rawSha256,
      rowsSha256: daejeonAccessibilitySnapshot.rowsSha256,
      datasetIds: structuredClone(daejeonAccessibilitySnapshot.datasetIds),
      topologySourceId: topology.id,
      topologySnapshotId: topologyEvidence.snapshotId,
      topologyContentSha256: topologyEvidence.contentSha256,
      topologyLineages: daejeonAccessibilitySnapshot.topologyLineages.map((lineage) => ({
        ...lineage,
        snapshotId: topologyEvidence.snapshotId,
        contentSha256: topologyEvidence.contentSha256,
      })),
    };
  }
  return projected;
}

function source(inventory, sourceId) {
  const matches = inventory?.sources?.filter(({ id }) => id === sourceId) ?? [];
  if (matches.length !== 1) throw new Error(`regional fixture source is invalid: ${sourceId}`);
  return matches[0];
}

function fixtureSnapshotId(sourceId, capturedAt) {
  return `${sourceId}-${compactSeoulDate(capturedAt)}`;
}

function fixtureSnapshotPath(snapshotId) {
  return `tools/datapack/sources/${snapshotId}.json`;
}

function compactSeoulDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}${parts.month}${parts.day}`;
}

export async function loadRegionalBusanTimetablePrefix({
  baseFixturePromise,
  inventoryPromise,
  readJson,
  topologyNow,
  timetableNow,
}) {
  const [
    baseFixture,
    busanTopology,
    busanTimetable,
    daejeonTopology,
    daejeonTimetable,
    inventory,
    stationMapCsv,
    molitStationMapCsv,
  ] = await Promise.all([
    baseFixturePromise,
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    inventoryPromise,
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  const projectedInventory = projectRegionalFixtureSourceBindings({
    inventory,
    busanTopology,
    busanTimetable,
    stationMapCsv,
    daejeonTopology,
    daejeonTimetable,
    molitStationMapCsv,
  });
  return {
    baseFixture,
    busanTopology,
    busanTimetable,
    daejeonTopology,
    daejeonTimetable,
    inventory: projectedInventory,
    stationMapCsv,
    molitStationMapCsv,
    ...materializeRegionalBusanTimetablePrefix({
      baseFixture,
      busanTopology,
      busanTimetable,
      daejeonTopology,
      daejeonTimetable,
      inventory: projectedInventory,
      stationMapCsv,
      molitStationMapCsv,
      topologyNow,
      timetableNow,
    }),
  };
}

export async function loadRegionalGwangjuTimetablePrefix(options) {
  const { readJson, timetableNow } = options;
  const [regional, gwangjuTopology] = await Promise.all([
    loadRegionalBusanTimetablePrefix(options),
    readJson("tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
  ]);
  const inventory = projectRegionalFixtureSourceBindings({
    inventory: regional.inventory,
    gwangjuTopology,
    molitStationMapCsv: regional.molitStationMapCsv,
  });
  return {
    ...regional,
    gwangjuTopology,
    inventory,
    gwangjuFixture: materializeRetainedGwangjuTestFixture({
      baseFixture: regional.busanTimetableFixture,
      topologySnapshot: gwangjuTopology,
      inventory,
      canonicalStationMappings: parseMolitGwangjuStationMappings(
        regional.molitStationMapCsv,
        gwangjuTopology,
      ),
      now: timetableNow,
    }),
  };
}

export async function loadRegionalGwangjuAccessibilityPrefix(options) {
  const { gwangjuAccessibilityNow } = options;
  const [regional, elevatorBytes, escalatorBytes] = await Promise.all([
    loadRegionalGwangjuTimetablePrefix(options),
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/fixtures/gwangju-accessibility-raw/data-go-15041385.csv")),
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/fixtures/gwangju-accessibility-raw/data-go-15041362.csv")),
  ]);
  // 테스트 원문과 명시한 fixture 시각만 사용하며 운영 snapshot·승인 기록은 수정하지 않는다.
  const inventory = structuredClone(regional.inventory);
  const topologySource = inventory.sources.find(({ id }) => id === "gwangju-transportation-route-topology");
  const accessibilitySnapshot = collectGwangjuAccessibility({ elevatorBytes, escalatorBytes,
    topologySnapshot: regional.gwangjuTopology, topologySource, now: gwangjuAccessibilityNow });
  const source = inventory.sources.find(({ id }) => id === "gwangju-transportation-accessibility");
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(accessibilitySnapshot.capturedAt)).replaceAll("-", "");
  const snapshotId = `${source.id}-${sha256(JSON.stringify(accessibilitySnapshot))}-${date}`;
  source.fieldsProvided = accessibilitySnapshot.fieldsProvided;
  source.accessibilityAdmissionEvidence = { ...source.accessibilityAdmissionEvidence,
    snapshotId, snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
    capturedAt: accessibilitySnapshot.capturedAt, freshUntil: accessibilitySnapshot.freshUntil,
    stationCount: accessibilitySnapshot.stationCount, rowCount: accessibilitySnapshot.rowCount,
    facilityCount: accessibilitySnapshot.rows.reduce((total, row) => total
      + [row.elevator, row.escalator, row.wheelchair_lift].filter((value) => value !== null).length, 0),
    rawSha256: accessibilitySnapshot.rawSha256, rowsSha256: accessibilitySnapshot.rowsSha256,
    datasetIds: accessibilitySnapshot.datasetIds, topologySourceId: topologySource.id,
    topologySnapshotId: topologySource.topologyAdmissionEvidence.snapshotId,
    topologyContentSha256: regional.gwangjuTopology.contentSha256,
    topologyLineages: accessibilitySnapshot.topologyLineages };
  return {
    ...regional,
    inventory,
    accessibilitySnapshot,
    accessibilityFixture: materializeGwangjuAccessibility({
      baseFixture: regional.gwangjuFixture,
      accessibilitySnapshot,
      topologySnapshot: regional.gwangjuTopology,
      inventory,
      now: gwangjuAccessibilityNow,
    }),
  };
}

export async function loadRegionalGwangjuRouteMapPrefix(options) {
  const { gwangjuRouteMapNow } = options;
  const [regional, gwangjuSnapshotBytes] = await Promise.all([
    loadRegionalGwangjuAccessibilityPrefix(options),
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/sources/gwangju-transportation-route-map-positions-20260725.json")),
  ]);
  const gwangjuSnapshot = JSON.parse(gwangjuSnapshotBytes);
  const gwangjuSnapshotSha256 = sha256(gwangjuSnapshotBytes);
  const inventory = projectRegionalFixtureSourceBindings({
    inventory: regional.inventory,
    gwangjuTopology: regional.gwangjuTopology,
    molitStationMapCsv: regional.molitStationMapCsv,
    gwangjuRouteMapSnapshot: gwangjuSnapshot,
    gwangjuRouteMapSnapshotBytes: gwangjuSnapshotBytes,
  });
  return {
    ...regional,
    gwangjuSnapshot,
    gwangjuSnapshotSha256,
    inventory,
    gwangjuRouteMapFixture: materializeGwangjuRouteMapPositions({
      baseFixture: regional.accessibilityFixture,
      snapshot: gwangjuSnapshot,
      snapshotSha256: gwangjuSnapshotSha256,
      topologySnapshot: regional.gwangjuTopology,
      inventory,
      now: gwangjuRouteMapNow,
    }),
  };
}

export async function loadRegionalDaejeonRouteMapPrefix(options) {
  const { daejeonRouteMapNow } = options;
  const [regional, daejeonSnapshotBytes] = await Promise.all([
    loadRegionalGwangjuRouteMapPrefix(options),
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/sources/daejeon-transportation-route-map-positions-20260725.json")),
  ]);
  const daejeonSnapshot = JSON.parse(daejeonSnapshotBytes);
  const daejeonSnapshotSha256 = sha256(daejeonSnapshotBytes);
  const inventory = projectRegionalFixtureSourceBindings({
    inventory: regional.inventory,
    daejeonTopology: regional.daejeonTopology,
    molitStationMapCsv: regional.molitStationMapCsv,
    daejeonRouteMapSnapshot: daejeonSnapshot,
    daejeonRouteMapSnapshotBytes: daejeonSnapshotBytes,
  });
  return {
    ...regional,
    daejeonSnapshot,
    daejeonSnapshotSha256,
    inventory,
    daejeonRouteMapFixture: materializeDaejeonRouteMapPositions({
      baseFixture: regional.gwangjuRouteMapFixture,
      snapshot: daejeonSnapshot,
      snapshotSha256: daejeonSnapshotSha256,
      topologySnapshot: regional.daejeonTopology,
      inventory,
      now: daejeonRouteMapNow,
    }),
  };
}

export async function loadRegionalSeoul9Phase1RouteMapPrefix(options) {
  const { readJson, seoul9RouteMapNow } = options;
  const [regional, phase1SnapshotBytes, capitalTopology] = await Promise.all([
    loadRegionalDaejeonRouteMapPrefix(options),
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/sources/kric-seoul-metro-line9-1-route-map-positions-20260725.json")),
    readJson("tools/datapack/sources/capital-route-topology-20260724.json"),
  ]);
  const phase1Snapshot = JSON.parse(phase1SnapshotBytes);
  const phase1SnapshotSha256 = sha256(phase1SnapshotBytes);
  return {
    ...regional,
    phase1Snapshot,
    phase1SnapshotSha256,
    capitalTopology,
    seoul9Fixture: materializeSeoul9Phase1RouteMapPositions({
      baseFixture: regional.daejeonRouteMapFixture,
      snapshot: phase1Snapshot,
      snapshotSha256: phase1SnapshotSha256,
      topologySnapshot: capitalTopology,
      inventory: regional.inventory,
      now: seoul9RouteMapNow,
    }),
  };
}

export async function loadRegionalCapitalKricRouteMapPrefix(sampleSnapshotPath) {
  // 보존된 회귀 입력의 시계다. 현재 운영 날짜로 갱신하지 않고 매 호출마다 독립 입력을 만든다.
  const readJson = async (relativePath) =>
    JSON.parse(await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8"));
  const [regional, sampleSnapshotBytes] = await Promise.all([
    loadRegionalSeoul9Phase1RouteMapPrefix({
      baseFixturePromise: readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
      inventoryPromise: readJson("tools/datapack/source-inventory.json").then(projectHistoricalRegionalMaterializeInventory),
      readJson,
      topologyNow: new Date("2026-07-19T18:14:03.004Z"),
      timetableNow: new Date("2026-07-20T13:09:00.000Z"),
      gwangjuAccessibilityNow: new Date("2026-07-24T03:00:00.000Z"),
      gwangjuRouteMapNow: new Date("2026-07-25T02:00:00.000Z"),
      daejeonRouteMapNow: new Date("2026-07-25T03:00:00.000Z"),
      seoul9RouteMapNow: new Date("2026-07-25T05:00:00.000Z"),
    }),
    readFile(sampleSnapshotPath),
  ]);
  const sampleSnapshot = JSON.parse(sampleSnapshotBytes);
  return {
    baseFixture: regional.seoul9Fixture,
    topologySnapshot: regional.capitalTopology,
    inventory: regional.inventory,
    sampleSnapshot,
    sampleSnapshotSha256: sha256(sampleSnapshotBytes),
  };
}

/**
 * The regional materializers start with a canonical production-shaped pack,
 * but `build-datapack --fixture` deliberately labels its output as a fixture.
 * Coverage negative tests need to exercise the production validators after
 * their own mutation, so promote only that disposable output to a signed
 * candidate.  The `.invalid` host makes the test artifact non-publishable
 * while preserving the production URL and staged-path contracts.
 */
export async function materializeRegionalProductionCandidate({ outputDir, privateKey }) {
  const manifestPath = path.join(outputDir, "current.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const [manifestBytes, provenanceBytes] = await Promise.all([
    readFile(manifestPath),
    readFile(provenancePath),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const provenance = JSON.parse(provenanceBytes);
  if (manifest.manifestVersion !== 2 || manifest.packs?.length !== 1
    || provenance.packs?.length !== 1 || manifest.packs[0].artifactKind !== "fixture"
    || provenance.packs[0].artifactKind !== "fixture") {
    throw new Error("regional fixture output is not an isolated fixture pack");
  }

  const [pack] = manifest.packs;
  const candidateUrl = `https://regional-fixture.invalid/catalog/${pack.id}-v${pack.version}.sqlite.gz`;
  pack.artifactKind = "production";
  pack.url = candidateUrl;
  const packPayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}:${new URL(candidateUrl).toString()}`;
  pack.signature = {
    algorithm: "rsa-sha256-pack-manifest-v2",
    value: rsaSha256Signature(privateKey, packPayload),
  };
  const routePayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}:${JSON.stringify(pack.representativeRouteRegressions)}:${new URL(candidateUrl).toString()}`;
  pack.representativeRouteRegressionSignature = {
    algorithm: "rsa-sha256-route-regression-v1",
    value: rsaSha256Signature(privateKey, routePayload),
  };
  manifest.channel = "candidate";
  manifest.keyId = "production-v1";
  manifest.signature = {
    algorithm: "rsa-sha256-manifest-v2",
    value: rsaSha256Signature(privateKey, canonicalJson(withoutSignature(manifest))),
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  provenance.packs[0].artifactKind = "production";
  provenance.manifestSha256 = manifestSha256(Buffer.from(manifestJson));
  await Promise.all([
    writeFile(manifestPath, manifestJson),
    writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`),
  ]);
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
export async function loadCurrentMolitMembershipMappings({
  repositoryRoot = REPOSITORY_ROOT,
  inventory: suppliedInventory = null,
  readTracked = null,
} = {}) {
  const root = path.resolve(repositoryRoot);
  const read = readTracked ?? ((relativePath) => readFile(path.join(root, relativePath)));
  const inventory = suppliedInventory ?? JSON.parse(await read("tools/datapack/source-inventory.json"));
  const { current, observation } = await loadCurrentMolitObservation({
    repositoryRoot: root, inventory, readTracked: read,
  });
  const topology = inventory.sources.find(({ id }) => id === "gwangju-transportation-route-topology");
  const topologyPath = topology?.topologyAdmissionEvidence?.snapshotPath;
  if (typeof topologyPath !== "string" || !topologyPath.startsWith("tools/datapack/sources/")) {
    throw new Error("current MOLIT Gwangju topology selection is invalid");
  }
  const gwangjuTopology = JSON.parse(await read(topologyPath));
  const projection = observation.normalizedProjection;
  const daejeon = parseCurrentMolitDaejeonStationMappings(projection, current.rawSha256);
  const gwangju = parseCurrentMolitGwangjuStationMappings(projection, current.rawSha256, gwangjuTopology, current);
  const daeguLine1 = parseCurrentMolitDaeguStationMappings(projection, current.rawSha256, "1호선");
  const daeguLine2 = parseCurrentMolitDaeguStationMappings(projection, current.rawSha256, "2호선");
  const daeguLine3 = parseCurrentMolitDaeguStationMappings(projection, current.rawSha256, "3호선");
  for (const [lineId, mappings] of [
    ["line-7051a9c2525c", daejeon], ["line-e57a361e8892", gwangju],
    ["line-5b8d9b05e7e6", daeguLine1], ["line-e2938a4cc492", daeguLine2], ["line-0ffaa95b1b5d", daeguLine3],
  ]) assertMembershipAdmission(inventory, lineId, mappings);
  return { daejeon, gwangju, daeguLine1, daeguLine2, daeguLine3 };
}
