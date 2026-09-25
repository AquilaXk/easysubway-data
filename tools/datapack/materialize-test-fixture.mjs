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
import { busanTimetableCounts } from "./collect-busan-timetable.mjs";
import { deriveDaejeonTimetableCounts, materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import { materializeGwangjuAccessibility } from "./materialize-gwangju-accessibility.mjs";
import { collectGwangjuAccessibility } from "./collect-gwangju-accessibility.mjs";
import { materializeGwangjuRouteMapPositions } from "./materialize-gwangju-route-map-positions.mjs";
import { materializeRetainedGwangjuTestFixture } from "./gwangju-retained-test-fixture.mjs";
import { materializeDaejeonRouteMapPositions } from "./materialize-daejeon-route-map-positions.mjs";
import { materializeSeoul9Phase1RouteMapPositions } from "./materialize-seoul9-phase1-route-map-positions.mjs";
import { DAEGU_LINES, daeguSourceSnapshotIdentity } from "./collect-daegu-datapack-sources.mjs";
import { daeguMembershipSnapshotIdentity } from "./materialize-daegu-timetable.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const MOLIT_SOURCE_ID = "molit-urban-rail-full-route";
const SHA256 = /^[a-f0-9]{64}$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Projects only Daegu source evidence onto explicitly supplied retained inputs. */
export function projectHistoricalDaeguMaterializeInventory({ inventory, topologySnapshots, timetableSnapshots, mappings }) {
  const projected = structuredClone(inventory);
  const rawMembership = source(projected, MOLIT_SOURCE_ID).admissionEvidence;
  for (const config of DAEGU_LINES) {
    const topology = topologySnapshots[config.lineNumber];
    const timetable = timetableSnapshots[config.lineNumber];
    const topologyId = daeguSourceSnapshotIdentity(topology);
    const timetableId = daeguSourceSnapshotIdentity(timetable);
    const topologySource = source(projected, topology.sourceId);
    const timetableSource = source(projected, timetable.sourceId);
    Object.assign(topologySource.topologyAdmissionEvidence, {
      snapshotId: topologyId, snapshotPath: fixtureSnapshotPath(topologyId), capturedAt: topology.capturedAt,
      freshUntil: topology.freshUntil, stationCount: topology.stationCount, edgeCount: topology.edgeCount,
      depotExcludedCount: topology.depotExcludedCount, rawSha256: topology.rawSha256, contentSha256: topology.contentSha256,
    });
    Object.assign(timetableSource.scheduleAdmissionEvidence, {
      snapshotId: timetableId, snapshotPath: fixtureSnapshotPath(timetableId), capturedAt: timetable.capturedAt,
      freshUntil: timetable.freshUntil, rowCount: timetable.rowCount, departureCount: timetable.stopTimeCount,
      tripCount: timetable.tripCount, stopTimeCount: timetable.stopTimeCount, rawSha256: timetable.rawSha256,
      rowsSha256: timetable.tripsSha256, rawUpSha256: timetable.rawUpSha256, rawDownSha256: timetable.rawDownSha256,
      tripsSha256: timetable.tripsSha256, dayLabelNormalizedCount: timetable.dayLabelNormalizedCount,
      rolloverTripCount: timetable.rolloverTripCount, topologySourceId: topology.sourceId,
      topologySnapshotId: topologyId, topologyContentSha256: topology.contentSha256, contentSha256: timetable.contentSha256,
    });
    const membershipId = `${MOLIT_SOURCE_ID}-daegu-line${config.lineNumber}-membership`;
    const evidence = source(projected, membershipId).membershipAdmissionEvidence;
    const mappingSha256 = sha256(JSON.stringify(mappings[config.lineNumber]));
    const stationCodesSha256 = sha256(JSON.stringify(topology.scope.map(({ stationCode }) => stationCode)));
    Object.assign(evidence, {
      lineIds: [config.lineId], stationCount: topology.stationCount,
      membershipSourceId: MOLIT_SOURCE_ID, membershipSourceRawSha256: rawMembership.rawSha256,
      membershipSourceSnapshotSha256: mappings[config.lineNumber].sourceRawSha256,
      mappingSha256, stationCodesSha256, stationCodeSourceId: topology.sourceId,
      stationCodeSnapshotId: topologyId, stationCodeContentSha256: topology.contentSha256,
      snapshotId: daeguMembershipSnapshotIdentity({
        sourceId: membershipId, molitSnapshotId: rawMembership.snapshotId,
        membershipSourceRawSha256: rawMembership.rawSha256, mappingSha256, stationCodesSha256,
      }),
    });
  }
  return projected;
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
  molitMappings = null,
  molitStationMapCsv = null,
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
    canonicalStationMappings: molitMappings?.daejeon
      ?? (molitStationMapCsv ? parseMolitDaejeonStationMappings(molitStationMapCsv) : null),
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
  molitMappings = null,
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
      const timetableSnapshotId = fixtureSnapshotId(timetable.id, busanTimetable.capturedAt);
      timetable.scheduleAdmissionEvidence = {
        ...timetable.scheduleAdmissionEvidence,
        snapshotId: timetableSnapshotId,
        snapshotPath: fixtureSnapshotPath(timetableSnapshotId),
        capturedAt: busanTimetable.capturedAt,
        freshUntil: busanTimetable.freshUntil,
        rowCount: busanTimetable.rows.length,
        ...busanTimetableCounts(busanTimetable.rows),
        rawSha256: busanTimetable.rawSha256,
        rowsSha256: busanTimetable.rowsSha256,
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
    const mappings = molitMappings?.gwangju
      ?? (molitStationMapCsv ? parseMolitGwangjuStationMappings(molitStationMapCsv, gwangjuTopology) : null);
    if (!mappings) throw new Error("regional Gwangju station mappings are required");
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
    const mappings = molitMappings?.daejeon
      ?? (molitStationMapCsv ? parseMolitDaejeonStationMappings(molitStationMapCsv) : null);
    if (!mappings) throw new Error("regional Daejeon station mappings are required");
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
      const timetableSnapshotId = fixtureSnapshotId(timetable.id, daejeonTimetable.observedAt);
      const freshnessMillis = Date.parse(timetable.scheduleAdmissionEvidence.freshUntil)
        - Date.parse(timetable.scheduleAdmissionEvidence.capturedAt);
      timetable.scheduleAdmissionEvidence = {
        ...timetable.scheduleAdmissionEvidence,
        snapshotId: timetableSnapshotId,
        snapshotPath: fixtureSnapshotPath(timetableSnapshotId),
        capturedAt: daejeonTimetable.observedAt,
        freshUntil: new Date(Date.parse(daejeonTimetable.observedAt) + freshnessMillis).toISOString(),
        rowCount: daejeonTimetable.rowCount,
        rawSha256: daejeonTimetable.rawSha256,
        rowsSha256: daejeonTimetable.rowsSha256,
        ...deriveDaejeonTimetableCounts({
          timetableSnapshot: daejeonTimetable,
          topologySnapshot: daejeonTopology,
          canonicalStationMappings: mappings,
        }),
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
    applyDaejeonAccessibilityFixture({
      projected,
      snapshot: daejeonAccessibilitySnapshot,
      snapshotBytes: daejeonAccessibilitySnapshotBytes,
    });
  }
  return projected;
}

function applyDaejeonAccessibilityFixture({ projected, snapshot, snapshotBytes }) {
  if (!(snapshotBytes instanceof Uint8Array)) {
    throw new Error("regional Daejeon accessibility fixture bytes are required");
  }
  const accessibility = source(projected, snapshot.sourceId);
  const topology = source(projected, snapshot.topologyLineages?.[0]?.sourceId);
  const topologyEvidence = topology.topologyAdmissionEvidence;
  const snapshotId = fixtureSnapshotId(accessibility.id, snapshot.capturedAt);
  accessibility.fieldsProvided = structuredClone(snapshot.fieldsProvided);
  accessibility.accessibilityAdmissionEvidence = {
    ...accessibility.accessibilityAdmissionEvidence,
    snapshotId,
    snapshotPath: fixtureSnapshotPath(snapshotId),
    capturedAt: snapshot.capturedAt,
    freshUntil: snapshot.freshUntil,
    stationCount: snapshot.stationCount,
    rowCount: snapshot.rowCount,
    facilityCount: snapshot.rows.reduce((count, row) => count
      + Number(row.elevator !== null)
      + Number(row.escalator !== null)
      + Number(row.wheelchair_lift !== null), 0),
    rawSha256: snapshot.rawSha256,
    rowsSha256: snapshot.rowsSha256,
    datasetIds: structuredClone(snapshot.datasetIds),
    topologySourceId: topology.id,
    topologySnapshotId: topologyEvidence.snapshotId,
    topologyContentSha256: topologyEvidence.contentSha256,
    topologyLineages: snapshot.topologyLineages.map((lineage) => ({
      ...lineage,
      snapshotId: topologyEvidence.snapshotId,
      contentSha256: topologyEvidence.contentSha256,
    })),
  };
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
    molitMappings,
  ] = await Promise.all([
    baseFixturePromise,
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    inventoryPromise,
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    loadCurrentMolitMembershipMappings({ repositoryRoot: REPOSITORY_ROOT }),
  ]);
  const projectedInventory = projectRegionalFixtureSourceBindings({
    inventory,
    busanTopology,
    busanTimetable,
    stationMapCsv,
    daejeonTopology,
    daejeonTimetable,
    molitMappings,
  });
  return {
    baseFixture,
    busanTopology,
    busanTimetable,
    daejeonTopology,
    daejeonTimetable,
    inventory: projectedInventory,
    stationMapCsv,
    molitMappings,
    ...materializeRegionalBusanTimetablePrefix({
      baseFixture,
      busanTopology,
      busanTimetable,
      daejeonTopology,
      daejeonTimetable,
      inventory: projectedInventory,
      stationMapCsv,
      molitMappings,
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
    molitMappings: regional.molitMappings,
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
      canonicalStationMappings: regional.molitMappings?.gwangju ?? (
        regional.molitStationMapCsv
          ? parseMolitGwangjuStationMappings(regional.molitStationMapCsv, gwangjuTopology)
          : null
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
    molitMappings: regional.molitMappings,
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
    molitMappings: regional.molitMappings,
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
      inventoryPromise: readJson("tools/datapack/source-inventory.json"),
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

function assertMembershipAdmission(inventory, lineId, mappings) {
  const matches = inventory.sources.filter(({ membershipAdmissionEvidence: evidence }) =>
    evidence?.membershipSourceId === MOLIT_SOURCE_ID
      && Array.isArray(evidence.lineIds) && evidence.lineIds.length === 1
      && evidence.lineIds[0] === lineId);
  if (matches.length !== 2) {
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
