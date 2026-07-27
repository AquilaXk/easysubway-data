#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";
import { usesLocalPlaceholderHost } from "./production-url-policy.mjs";
import { requiredCredentialFreeObjectUri } from "./source-snapshot-policy.mjs";
import {
  canonicalJson,
  stagedPackPath,
  validatePackIdentity,
  validatePackUrl,
  validatePackUrlMatchesStagedPath,
  withoutSignature,
} from "./lib/manifest-validation.mjs";
import { rsaSha256Signature, signingPrivateKey } from "./lib/manifest-signing.mjs";
import {
  officialOdFareAdmissionsBySource,
  officialOdFareQuoteSetHash,
} from "./lib/official-od-fare-evidence.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const canonicalSqliteHeaderVersion = 3_053_000;
const validatedItxAdmissionPacks = new WeakSet();
const validatedItxAdmissionOutputs = new WeakMap();
const originalItxAdmissionOutput = Object.freeze({
  sha256: "dfe8420b2f26d2ca2948575098e0a6a5e278c3b203f7cd9c1f1b588a07e74b02",
  sqliteSha256: "c39f23cd6b8b20f88672d0456b72a4efbd3697b81035cfb49ded289e50f3a4aa",
  byteSize: 359388,
});
const originalItxAdmissionProjection = Object.freeze({
  edgeCount: 48,
  edgesSha256: "e09f9ece35f261b0690753b9c88749d2e460c79e889bea045fb44a46bae78709",
  evidenceSha256: "a4834c3638dd45500292f67bd39e5a8ff9660162e1ffa2a78359c5d645b74996",
});
const productionMinimumTableRowNames = [
  "stations",
  "station_lines",
  "network_edges",
  "facilities",
  "station_facility_evidence",
];
const candidateBuildSpecArtifactKind = "datapack-candidate-build-spec";
const candidateBuildSpecHashFields = [
  "sourceSnapshotSetHash",
  "approvedAliasLedgerHash",
  "facilityEvidenceLedgerHash",
  "routeEvidenceLedgerHash",
  "approvedOverrideSetHash",
  "sourceInventorySha256",
];
const sourceSnapshotStatuses = new Set(["LOCKED"]);
const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(root, requireArg(args, "output"));
  const schema = await readFile(path.join(root, "tools/datapack/schema/catalog-schema.sql"), "utf8");
  const officialOdFareAdmissionBytes = await readFile(path.join(root, "tools/datapack/official-od-fare-admission.json"));
  const officialOdFareAdmissionBundle = JSON.parse(officialOdFareAdmissionBytes);
  const officialOdFareAdmissions = officialOdFareAdmissionsBySource(officialOdFareAdmissionBundle);
  const { fixture, candidateBuild } = await loadBuildInput(
    args,
    officialOdFareAdmissions,
    officialOdFareAdmissionBytes,
  );

  validateFixture(fixture);
  await mkdir(outputDir, { recursive: true });

  const manifestPacks = [];
  const provenancePacks = [];
  for (const pack of fixture.packs) {
    const artifactKind = pack.artifactKind ?? "fixture";
    const packUrl = pack.url ?? `catalog/${pack.id}-v${pack.version}.sqlite.gz`;
    // requiredString은 non-empty 문자열을 강제하고, 검증·경로 파생·매니페스트는 모두 raw packUrl을
    // 대상으로 한다(추출 전 로컬 validatePackUrl과 동일 — 검증 대상과 실사용 문자열 일치).
    requiredString(packUrl, "pack.url");
    validatePackUrl(packUrl, "pack.url");
    validatePackUrlMatchesStagedPath(packUrl, pack, "pack.url");
    const outputPackPath = outputPathForPack(outputDir, packUrl, pack);
    const sqlitePath = outputPackPath.replace(/\.gz$/, "");
    const compressedPath = outputPackPath;

    await mkdir(path.dirname(sqlitePath), { recursive: true });
    await rm(sqlitePath, { force: true });
    await rm(compressedPath, { force: true });

    buildSqlitePack(sqlitePath, schema, pack, officialOdFareAdmissions);

    const sqliteBytes = await readFile(sqlitePath);
    // ponytail: offset 96 is informational and otherwise records the platform SQLite patch version.
    sqliteBytes.writeUInt32BE(canonicalSqliteHeaderVersion, 96);
    await writeFile(sqlitePath, sqliteBytes);
    // ponytail: Z_RLE is stable across supported zlib versions; byte 9 removes the platform OS marker.
    const compressedBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0, strategy: zlibConstants.Z_RLE });
    compressedBytes[9] = 255;
    await writeFile(compressedPath, compressedBytes);
    const compressedSha256 = sha256(compressedBytes);
    const sqliteSha256 = sha256(sqliteBytes);
    const sizeBytes = compressedBytes.length;
    const admittedOutput = validatedItxAdmissionOutputs.get(pack);
    if (admittedOutput && !samePackIdentity(admittedOutput, {
      sha256: compressedSha256,
      sqliteSha256,
      byteSize: sizeBytes,
    })) {
      throw new Error(`built ITX pack identity does not match tracked readmission output: ${JSON.stringify({
        expected: admittedOutput,
        actual: { sha256: compressedSha256, sqliteSha256, byteSize: sizeBytes },
      })}`);
    }
    const representativeRouteRegressions = canonicalRepresentativeRouteRegressions(
      pack.representativeRouteRegressions,
    );

    const manifestPack = {
      id: pack.id,
      version: pack.version,
      artifactKind,
      url: packUrl,
      sha256: compressedSha256,
      sqliteSha256,
      sizeBytes,
      signature: packSignature({
        id: pack.id,
        version: pack.version,
        manifestVersion: fixture.manifest.manifestVersion ?? 1,
        artifactKind,
        url: packUrl,
        sha256: compressedSha256,
        sqliteSha256,
        sizeBytes,
      }),
      schemaVersion: pack.schemaVersion,
      sourceInventory: pack.sourceInventory,
      regionalQualityMetrics: regionalQualityMetrics(pack),
      ...(pack.routeRegressionScope ? { routeRegressionScope: canonicalRouteRegressionScope(pack.routeRegressionScope) } : {}),
      representativeRouteRegressions,
      representativeRouteRegressionSignature: representativeRouteRegressionSignature({
        id: pack.id,
        version: pack.version,
        artifactKind,
        url: packUrl,
        sha256: compressedSha256,
        sqliteSha256,
        sizeBytes,
        representativeRouteRegressions,
      }),
      requiredTables: pack.requiredTables,
      minimumTableRows: pack.minimumTableRows ?? {},
    };
    manifestPacks.push(manifestPack);
    provenancePacks.push(packFieldProvenance(pack, {
      artifactKind,
      sqliteSha256,
    }));
  }

  const manifest = {
    ...(fixture.manifest.manifestVersion === 2
      ? {
          manifestVersion: 2,
          channel: requiredString(fixture.manifest.channel, "manifest.channel"),
          releaseSequence: optionalPositiveInteger(fixture.manifest.releaseSequence, "manifest.releaseSequence")
            ?? defaultReleaseSequence(),
          publishedAt: optionalUtcDateString(fixture.manifest.publishedAt, "manifest.publishedAt") ?? buildPublishedAt(),
          expiresAt: optionalUtcDateString(fixture.manifest.expiresAt, "manifest.expiresAt")
            ?? buildExpiresAt(fixture.manifest.publishedAt),
          keyId: requiredString(fixture.manifest.keyId, "manifest.keyId"),
        }
      : {}),
    ttlSeconds: fixture.manifest.ttlSeconds,
    packs: manifestPacks,
  };
  if (fixture.manifest.activePack !== undefined) {
    manifest.activePack = fixture.manifest.activePack;
  }
  if (fixture.manifest.emergencyOverride !== undefined) {
    manifest.emergencyOverride = fixture.manifest.emergencyOverride;
  }
  if (fixture.manifest.manifestVersion === 2) {
    manifest.signature = manifestSignature(manifest, manifestPacks);
  }

  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(outputDir, "current.json"), manifestJson);
  await writeFile(
    path.join(outputDir, "current.provenance.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      artifactKind: "datapack-field-provenance",
      manifestSha256: sha256(Buffer.from(manifestJson)),
      ...(candidateBuild ? { candidateBuild } : {}),
      packs: provenancePacks,
    }, null, 2)}\n`,
  );
}

async function loadBuildInput(args, officialOdFareAdmissions, officialOdFareAdmissionBytes) {
  const fixtureArg = args.fixture;
  const buildSpecArg = args["build-spec"];
  if ((fixtureArg == null) === (buildSpecArg == null)) {
    throw new Error("exactly one of --fixture or --build-spec is required");
  }
  if (fixtureArg != null) {
    const fixture = JSON.parse(await readFile(path.resolve(root, fixtureArg), "utf8"));
    rejectTestOnlyBuildInput(fixture);
    if (args["test-only-itx-admission"] != null) {
      const admissionPath = await resolveBuildInputPath(
        args["test-only-itx-admission"],
        "testOnlyItxAdmission",
      );
      const admissionBytes = await readFile(admissionPath);
      await materializeTestOnlyItxAdmission(fixture, JSON.parse(admissionBytes), admissionBytes);
    }
    return {
      fixture,
      candidateBuild: null,
    };
  }
  if (args["test-only-itx-admission"] != null) {
    throw new Error("--test-only-itx-admission cannot be used with --build-spec");
  }

  const buildSpecPath = await resolveBuildInputPath(buildSpecArg, "buildSpec");
  const buildSpecBytes = await readFile(buildSpecPath);
  const buildSpec = JSON.parse(buildSpecBytes);
  const fixture = JSON.parse(await readFile(await resolveBuildInputPath(buildSpec.fixturePath, "buildSpec.fixturePath"), "utf8"));
  rejectTestOnlyBuildInput(fixture);
  const officialOdFareEvidence = await validateCandidateBuildSpec(
    buildSpec,
    fixture,
    officialOdFareAdmissions,
    officialOdFareAdmissionBytes,
  );
  return {
    fixture,
    candidateBuild: candidateBuildProvenance(buildSpec, sha256(buildSpecBytes), officialOdFareEvidence),
  };
}

async function materializeTestOnlyItxAdmission(fixture, admission, admissionBytes) {
  const freshUntil = validateTestOnlyItxAdmission(admission);
  const canonicalIdentity = await validateTestOnlyItxCanonicalIdentity(admission);
  const pack = testOnlyItxTargetPack(fixture, canonicalIdentity);
  const lineId = requiredString(admission.canonicalLineId, "testOnlyItxAdmission.canonicalLineId");
  const admittedStationIds = validateTestOnlyItxStations(pack, admission, lineId);
  const timetableHash = sha256(admissionBytes);
  const { trips, stopTimes, edges } = deriveTestOnlyItxRows(
    admission,
    lineId,
    admittedStationIds,
    timetableHash,
  );

  pack.serviceCalendars = [...(pack.serviceCalendars ?? []), ...(admission.serviceCalendars ?? [])];
  pack.transitRoutes = [...(pack.transitRoutes ?? []), ...(admission.transitRoutes ?? [])];
  pack.transitTrips = [...(pack.transitTrips ?? []), ...trips];
  pack.transitStopTimes = [...(pack.transitStopTimes ?? []), ...stopTimes];
  pack.networkEdges = [...(pack.networkEdges ?? []), ...edges];
  pack.routeServiceArtifactEvidence = [{
    serviceClass: "ITX_CHEONGCHUN",
    timetableArtifactId: requiredString(
      admission.timetableArtifactIdentity?.id,
      "testOnlyItxAdmission.timetableArtifactIdentity.id",
    ),
    timetableArtifactSha256: timetableHash,
    canonicalPackId: canonicalIdentity.id,
    canonicalPackSha256: canonicalIdentity.sha256,
    canonicalPackSqliteSha256: canonicalIdentity.sqliteSha256,
    admissionStatus: "ADMITTED",
    admissionEligible: true,
    freshUntil,
    sourceIssue: 2116,
  }];
  validatedItxAdmissionPacks.add(pack);
}

function validateTestOnlyItxAdmission(admission) {
  if (
    admission?.fixtureClass !== "TEST_ONLY"
    || admission?.artifactKind !== "deterministic-itx-cheongchun-admission-fixture"
  ) {
    throw new Error("--test-only-itx-admission requires the deterministic TEST_ONLY fixture");
  }
  if (
    admission.serviceClass !== "ITX_CHEONGCHUN"
    || admission.sourceIssue !== 2116
    || admission.admissionStatus !== "ADMITTED"
    || admission.admissionEligible !== true
    || admission.freshness?.status !== "FRESH"
  ) {
    throw new Error("test-only ITX admission must be FRESH and ADMITTED by #2116");
  }
  const freshUntil = requiredUtcDateString(
    admission.freshness.freshUntil,
    "testOnlyItxAdmission.freshness.freshUntil",
  );
  if (Date.parse(freshUntil) <= candidateBuildNow().getTime()) {
    throw new Error("test-only ITX admission freshness must be in the future");
  }
  return freshUntil;
}

async function validateTestOnlyItxCanonicalIdentity(admission) {
  const canonicalIdentity = admission.canonicalPackIdentity;
  const canonicalGzipBytes = await readFile(
    path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"),
  );
  if (
    canonicalIdentity?.id !== "capital"
    || canonicalIdentity.sha256 !== sha256(canonicalGzipBytes)
    || canonicalIdentity.sqliteSha256 !== sha256(gunzipSync(canonicalGzipBytes))
  ) {
    throw new Error("test-only ITX admission canonical pack identity is stale");
  }
  if (admission.timetableArtifactIdentity?.sha256Source !== "FIXTURE_FILE_BYTES") {
    throw new Error("test-only ITX timetable identity must hash fixture file bytes");
  }
  return canonicalIdentity;
}

function testOnlyItxTargetPack(fixture, canonicalIdentity) {
  const pack = fixture.packs?.find(({ id }) => id === canonicalIdentity.id);
  if (!pack || (pack.artifactKind ?? "fixture") !== "fixture") {
    throw new Error("test-only ITX admission can materialize only into a fixture pack");
  }
  return pack;
}

function validateTestOnlyItxStations(pack, admission, lineId) {
  const stationIds = new Set((pack.stations ?? []).map(({ id }) => id));
  const routeMapMembers = new Set((pack.routeMapPositions ?? [])
    .filter(({ lineId: memberLineId, region }) => memberLineId === lineId && region === "수도권")
    .map(({ stationId }) => stationId));
  const admittedStationIds = new Set((admission.canonicalStations ?? []).map((station) => {
    if (station.capitalRouteMapMember !== true) {
      throw new Error(`test-only ITX station is not a capital route-map member: ${station.canonicalStationId}`);
    }
    return requiredString(station.canonicalStationId, "testOnlyItxAdmission.canonicalStations[].canonicalStationId");
  }));
  for (const stationId of admittedStationIds) {
    if (!stationIds.has(stationId) || !routeMapMembers.has(stationId)) {
      throw new Error(`test-only ITX canonical station membership is missing: ${stationId}`);
    }
  }
  return admittedStationIds;
}

function deriveTestOnlyItxRows(admission, lineId, admittedStationIds, timetableHash) {
  const trips = admission.transitTrips ?? [];
  const stopTimes = admission.transitStopTimes ?? [];
  const edges = [];
  for (const trip of trips) {
    if (trip.serviceClass !== "ITX_CHEONGCHUN" || trip.servicePattern !== "EXPRESS") {
      throw new Error(`test-only ITX trip must be EXPRESS: ${trip.id}`);
    }
    const tripStops = stopTimes
      .filter(({ tripId }) => tripId === trip.id)
      .sort((left, right) => left.stopSequence - right.stopSequence);
    if (tripStops.length < 2) {
      throw new Error(`test-only ITX trip must have at least two stops: ${trip.id}`);
    }
    for (const stop of tripStops) {
      if (stop.lineId !== lineId || !admittedStationIds.has(stop.stationId)) {
        throw new Error(`test-only ITX stop is outside admitted canonical scope: ${trip.id}`);
      }
    }
    for (let index = 1; index < tripStops.length; index += 1) {
      const from = tripStops[index - 1];
      const to = tripStops[index];
      const durationSeconds = to.arrivalSeconds - from.departureSeconds;
      if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
        throw new Error(`test-only ITX stop times are not increasing: ${trip.id}`);
      }
      edges.push({
        id: `itx-cheongchun:${trip.id}:${from.stopSequence}-${to.stopSequence}`,
        fromNodeId: `${from.stationId}:${lineId}:EXPRESS`,
        toNodeId: `${to.stationId}:${lineId}:EXPRESS`,
        durationSeconds,
        distanceMeters: 0,
        edgeType: "RIDE",
        servicePattern: "EXPRESS",
        serviceClass: "ITX_CHEONGCHUN",
        evidenceHash: timetableHash,
        lastVerifiedAt: admission.freshness.observedAt,
      });
    }
  }
  return { trips, stopTimes, edges };
}

function rejectTestOnlyBuildInput(fixture) {
  if (fixture?.fixtureClass === "TEST_ONLY") {
    throw new Error("TEST_ONLY artifact cannot be used as datapack build input");
  }
}

async function validateCandidateBuildSpec(buildSpec, fixture, admissions, admissionBytes) {
  if (!buildSpec || typeof buildSpec !== "object" || Array.isArray(buildSpec)) {
    throw new Error("buildSpec must be an object");
  }
  if (buildSpec.schemaVersion !== 1) {
    throw new Error("buildSpec.schemaVersion must be 1");
  }
  if (requiredString(buildSpec.artifactKind, "buildSpec.artifactKind") !== candidateBuildSpecArtifactKind) {
    throw new Error(`buildSpec.artifactKind must be ${candidateBuildSpecArtifactKind}`);
  }
  requiredString(buildSpec.candidateId, "buildSpec.candidateId");
  requiredString(buildSpec.productionScopeId, "buildSpec.productionScopeId");
  await resolveBuildInputPath(buildSpec.fixturePath, "buildSpec.fixturePath");
  requiredStringArray(buildSpec.sourceSnapshotIds, "buildSpec.sourceSnapshotIds");
  const sourceSnapshots = requiredSourceSnapshots(buildSpec.sourceSnapshots, "buildSpec.sourceSnapshots");
  assertSourceSnapshotSet(buildSpec.sourceSnapshotIds, sourceSnapshots);
  for (const field of candidateBuildSpecHashFields) {
    sha256HexString(buildSpec[field], `buildSpec.${field}`);
  }
  const builderGitSha = requiredString(buildSpec.builderGitSha, "buildSpec.builderGitSha");
  if (!/^[a-f0-9]{7,40}$/i.test(builderGitSha)) {
    throw new Error("buildSpec.builderGitSha must be a git sha");
  }
  requiredString(buildSpec.builderVersion, "buildSpec.builderVersion");
  await validateTrackedItxTopologyEvidence(buildSpec, fixture);
  return validateOfficialOdFareEvidence(buildSpec.officialOdFareEvidence, fixture, admissions, admissionBytes);
}

function candidateBuildProvenance(buildSpec, buildSpecSha256, officialOdFareEvidence) {
  const normalizedHashes = Object.fromEntries(candidateBuildSpecHashFields.map((field) => [
    field,
    sha256HexString(buildSpec[field], `buildSpec.${field}`),
  ]));
  return {
    schemaVersion: buildSpec.schemaVersion,
    artifactKind: requiredString(buildSpec.artifactKind, "buildSpec.artifactKind"),
    candidateId: requiredString(buildSpec.candidateId, "buildSpec.candidateId"),
    productionScopeId: requiredString(buildSpec.productionScopeId, "buildSpec.productionScopeId"),
    buildSpecSha256,
    sourceSnapshotIds: requiredStringArray(buildSpec.sourceSnapshotIds, "buildSpec.sourceSnapshotIds"),
    sourceSnapshots: requiredSourceSnapshots(buildSpec.sourceSnapshots, "buildSpec.sourceSnapshots"),
    sourceSnapshotSetHash: normalizedHashes.sourceSnapshotSetHash,
    approvedAliasLedgerHash: normalizedHashes.approvedAliasLedgerHash,
    facilityEvidenceLedgerHash: normalizedHashes.facilityEvidenceLedgerHash,
    routeEvidenceLedgerHash: normalizedHashes.routeEvidenceLedgerHash,
    approvedOverrideSetHash: normalizedHashes.approvedOverrideSetHash,
    sourceInventorySha256: normalizedHashes.sourceInventorySha256,
    builderGitSha: requiredString(buildSpec.builderGitSha, "buildSpec.builderGitSha"),
    builderVersion: requiredString(buildSpec.builderVersion, "buildSpec.builderVersion"),
    ...(buildSpec.itxTopologyEvidenceSha256
      ? { itxTopologyEvidenceSha256: sha256HexString(
          buildSpec.itxTopologyEvidenceSha256,
          "buildSpec.itxTopologyEvidenceSha256",
        ) }
      : {}),
    ...(officialOdFareEvidence ? { officialOdFareEvidence } : {}),
  };
}

async function validateTrackedItxTopologyEvidence(buildSpec, fixture) {
  if (fixture.packs?.some((pack) => (pack.transitTrips ?? [])
    .some(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN"))) {
    throw new Error("production ITX timetable rows require explicit admission");
  }
  const packs = fixture.packs?.filter((pack) => [
    ...(pack.transitTrips ?? []),
    ...(pack.networkEdges ?? []),
  ].some(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN")) ?? [];
  if (packs.length === 0) return;
  const evidencePath = await resolveBuildInputPath(
    buildSpec.itxTopologyEvidencePath,
    "buildSpec.itxTopologyEvidencePath",
  );
  const evidenceBytes = await readFile(evidencePath);
  if (sha256HexString(buildSpec.itxTopologyEvidenceSha256, "buildSpec.itxTopologyEvidenceSha256")
    !== sha256(evidenceBytes)) {
    throw new Error("buildSpec.itxTopologyEvidenceSha256 must match tracked evidence bytes");
  }
  const evidence = JSON.parse(evidenceBytes);
  if (evidence?.artifactKind !== "itx-cheongchun-mobile-topology-evidence"
    || evidence.serviceId !== "ITX_CHEONGCHUN"
    || evidence.sourceIssue !== 2135) {
    throw new Error("buildSpec ITX topology evidence must be the #2135 admission artifact");
  }
  const { output, projection: admission } = validateTrackedItxReadmissionChain(evidence);
  for (const pack of packs) {
    const edges = (pack.networkEdges ?? [])
      .filter(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN")
      .map((row) => ({
        id: row.id,
        from_node_id: row.fromNodeId,
        to_node_id: row.toNodeId,
        duration_seconds: row.durationSeconds,
        distance_meters: row.distanceMeters,
        edge_type: row.edgeType,
        service_pattern: row.servicePattern,
        service_class: row.serviceClass,
      }))
      .sort((left, right) => codepointCompare(left.id, right.id));
    const routeEvidence = (pack.routeServiceArtifactEvidence ?? [])
      .filter(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN")
      .map((row) => ({
        service_class: row.serviceClass,
        timetable_artifact_id: row.timetableArtifactId,
        timetable_artifact_sha256: row.timetableArtifactSha256,
        canonical_pack_id: row.canonicalPackId,
        canonical_pack_sha256: row.canonicalPackSha256,
        canonical_pack_sqlite_sha256: row.canonicalPackSqliteSha256,
        admission_status: row.admissionStatus,
        admission_eligible: row.admissionEligible ? 1 : 0,
        fresh_until: row.freshUntil,
        source_issue: row.sourceIssue,
      }));
    if (edges.length !== admission.edgeCount
      || sha256(Buffer.from(JSON.stringify(edges))) !== admission.edgesSha256) {
      throw new Error("ITX_CHEONGCHUN edge projection does not match tracked topology evidence");
    }
    if (sha256(Buffer.from(JSON.stringify(routeEvidence))) !== admission.evidenceSha256) {
      throw new Error("ITX_CHEONGCHUN route evidence projection does not match tracked topology evidence");
    }
    validatedItxAdmissionPacks.add(pack);
    validatedItxAdmissionOutputs.set(pack, output);
  }
}

function validateTrackedItxReadmissionChain(evidence) {
  if (!Array.isArray(evidence.readmissions) || evidence.readmissions.length === 0) {
    throw new Error("tracked ITX readmission chain is invalid");
  }
  let previous = originalItxAdmissionOutput;
  let projection;
  for (const entry of evidence.readmissions) {
    const candidateProjection = entry.itxSubgraph;
    if (!samePackIdentity(entry.previousPack, previous)
      || candidateProjection?.unchanged !== true
      || !Number.isSafeInteger(candidateProjection.edgeCount)
      || candidateProjection.edgeCount <= 0
      || !/^[a-f0-9]{64}$/.test(candidateProjection.edgesSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(candidateProjection.evidenceSha256 ?? "")
      || (projection && (candidateProjection.edgeCount !== projection.edgeCount
        || candidateProjection.edgesSha256 !== projection.edgesSha256
        || candidateProjection.evidenceSha256 !== projection.evidenceSha256))) {
      throw new Error("tracked ITX readmission chain is invalid");
    }
    if (projection == null
      && (candidateProjection.edgeCount !== originalItxAdmissionProjection.edgeCount
        || candidateProjection.edgesSha256 !== originalItxAdmissionProjection.edgesSha256
        || candidateProjection.evidenceSha256 !== originalItxAdmissionProjection.evidenceSha256)) {
      throw new Error("tracked ITX readmission projection does not match original admission");
    }
    projection ??= candidateProjection;
    previous = requiredPackIdentity(entry.newPack);
  }
  const output = requiredPackIdentity({
    sha256: evidence.pack?.outputSha256,
    sqliteSha256: evidence.pack?.outputSqliteSha256,
    byteSize: evidence.pack?.byteSize,
  });
  if (evidence.pack?.id !== "capital" || !samePackIdentity(previous, output)) {
    throw new Error("tracked ITX readmission chain is invalid");
  }
  return { output, projection };
}

function requiredPackIdentity(identity) {
  if (!/^[a-f0-9]{64}$/.test(identity?.sha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(identity?.sqliteSha256 ?? "")
    || !Number.isSafeInteger(identity?.byteSize)
    || identity.byteSize <= 0) {
    throw new Error("tracked ITX readmission chain is invalid");
  }
  return identity;
}

function samePackIdentity(left, right) {
  return left?.sha256 === right.sha256
    && left?.sqliteSha256 === right.sqliteSha256
    && left?.byteSize === right.byteSize;
}

function validateOfficialOdFareEvidence(evidence, fixture, admissions, admissionBytes) {
  const allCandidateQuotes = fixture?.packs?.flatMap((pack) => pack.officialOdFareQuotes ?? []) ?? [];
  const candidateQuotes = evidence == null
    ? allCandidateQuotes
    : allCandidateQuotes.filter((quote) => quote.sourceId === evidence.sourceId);
  if (evidence == null && candidateQuotes.length === 0) return null;
  const label = "officialOdFareEvidence";
  const keys = ["sourceId", "snapshotId", "evidenceHash", "admissionHash", "quoteSetHash", "mappingLedgerHash", "quotes"];
  assertExactKeys(evidence, keys, label);
  const admission = admissions.get(requiredString(evidence.sourceId, `${label}.sourceId`));
  if (admission?.decision !== "APPROVED") throw new Error(`${label} requires an approved admission`);
  if (requiredString(evidence.snapshotId, `${label}.snapshotId`) !== admission.snapshotId) {
    throw new Error(`${label}.snapshotId must match admission`);
  }
  if (sha256HexString(evidence.evidenceHash, `${label}.evidenceHash`) !== admission.evidenceHash) {
    throw new Error(`${label}.evidenceHash must match admission`);
  }
  if (sha256HexString(evidence.admissionHash, `${label}.admissionHash`) !== sha256(admissionBytes)) {
    throw new Error(`${label}.admissionHash must match tracked admission bytes`);
  }
  if (sha256HexString(evidence.quoteSetHash, `${label}.quoteSetHash`) !== admission.quoteSetHash) {
    throw new Error(`${label}.quoteSetHash must match admission`);
  }
  if (sha256HexString(evidence.mappingLedgerHash, `${label}.mappingLedgerHash`) !== admission.fareStationLineMappingLedgerHash) {
    throw new Error(`${label}.mappingLedgerHash must match admission`);
  }
  if (!Array.isArray(evidence.quotes) || evidence.quotes.length !== admission.quoteCount) {
    throw new Error(`${label}.quotes count must match admission`);
  }
  for (const quote of evidence.quotes) officialOdFareQuoteValues(quote, admission);
  if (officialOdFareQuoteSetHash(evidence.quotes) !== admission.quoteSetHash) {
    throw new Error(`${label}.quotes must match admission quote set`);
  }
  if (officialOdFareQuoteSetHash(candidateQuotes) !== officialOdFareQuoteSetHash(evidence.quotes)) {
    throw new Error(`${label}.quotes must match candidate fixture quote set`);
  }
  return evidence;
}

function requiredSourceSnapshots(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((snapshot, index) => {
    const prefix = `${label}[${index}]`;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error(`${prefix} must be an object`);
    }
    const normalized = {
      snapshotId: requiredString(snapshot.snapshotId, `${prefix}.snapshotId`),
      sourceId: requiredString(snapshot.sourceId, `${prefix}.sourceId`),
      rawObjectUri: requiredCredentialFreeObjectUri(snapshot.rawObjectUri, `${prefix}.rawObjectUri`),
      rawSha256: sha256HexString(snapshot.rawSha256, `${prefix}.rawSha256`),
      redactedRequestFingerprint: sha256HexString(
        snapshot.redactedRequestFingerprint,
        `${prefix}.redactedRequestFingerprint`,
      ),
      schemaFingerprint: sha256HexString(snapshot.schemaFingerprint, `${prefix}.schemaFingerprint`),
      licenseStatus: requiredString(snapshot.licenseStatus, `${prefix}.licenseStatus`),
      redistributionAllowed: snapshot.redistributionAllowed,
      adminReviewRecordHash: sha256HexString(snapshot.adminReviewRecordHash, `${prefix}.adminReviewRecordHash`),
      snapshotStatus: requiredString(snapshot.snapshotStatus, `${prefix}.snapshotStatus`),
      credentialRedacted: snapshot.credentialRedacted,
      freshnessExpiresAt: requiredUtcDateString(snapshot.freshnessExpiresAt, `${prefix}.freshnessExpiresAt`),
    };
    if (normalized.licenseStatus !== "PASS") {
      throw new Error(`${prefix}.licenseStatus must be PASS`);
    }
    if (snapshot.redistributionAllowed !== true) {
      throw new Error(`${prefix}.redistributionAllowed must be true`);
    }
    if (!sourceSnapshotStatuses.has(normalized.snapshotStatus)) {
      throw new Error(`${prefix}.snapshotStatus must be LOCKED`);
    }
    if (snapshot.credentialRedacted !== true) {
      throw new Error(`${prefix}.credentialRedacted must be true`);
    }
    if (Date.parse(normalized.freshnessExpiresAt) <= candidateBuildNow().getTime()) {
      throw new Error(`${prefix}.freshnessExpiresAt must be in the future`);
    }
    return normalized;
  });
}

function assertSourceSnapshotSet(sourceSnapshotIds, sourceSnapshots) {
  const ids = requiredStringArray(sourceSnapshotIds, "buildSpec.sourceSnapshotIds")
    .sort((left, right) => codepointCompare(left, right));
  const snapshotIds = sourceSnapshots
    .map((snapshot) => snapshot.snapshotId)
    .sort((left, right) => codepointCompare(left, right));
  if (JSON.stringify(ids) !== JSON.stringify(snapshotIds)) {
    throw new Error("buildSpec.sourceSnapshotIds must match buildSpec.sourceSnapshots[].snapshotId");
  }
}

function candidateBuildNow() {
  const value = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  return value ? new Date(requiredUtcDateString(value, "EASYSUBWAY_DATAPACK_BUILD_NOW")) : new Date();
}

async function resolveBuildInputPath(value, label) {
  const resolved = path.resolve(root, requiredString(value, label));
  const canonicalPath = await realpath(resolved);
  if (!(await isWithinAllowedBuildInputRoot(canonicalPath))) {
    throw new Error(`${label} must stay inside repository or temp directory`);
  }
  return canonicalPath;
}

async function isWithinAllowedBuildInputRoot(resolvedPath) {
  const allowedRoots = await allowedBuildInputRoots();
  return allowedRoots.some((allowedRoot) => {
    const relative = path.relative(allowedRoot, resolvedPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

async function allowedBuildInputRoots() {
  const candidateRoots = [root, tmpdir(), process.env.RUNNER_TEMP]
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => path.resolve(value));
  const canonicalRoots = [];
  for (const candidateRoot of candidateRoots) {
    try {
      canonicalRoots.push(await realpath(candidateRoot));
    } catch {
      // Optional CI temp roots may be absent in local runs.
    }
  }
  return canonicalRoots;
}

function packFieldProvenance(pack, { artifactKind, sqliteSha256 }) {
  const sourceUpdatedAt = new Map((pack.sourceInventory ?? []).map((source) => [source.id, source.updatedAt]));
  const sourceFields = new Map((pack.sourceInventory ?? []).map((source) => [source.id, new Set(source.fields ?? [])]));
  const sourceScopes = sourceCoverageScopeMap(pack.sourceInventory ?? []);
  const defaultSourceId = pack.sourceInventory?.length === 1 ? pack.sourceInventory[0].id : "";
  const lineOperatorIds = new Map((pack.lines ?? []).map((line) => [line.id, line.operatorId]).filter(([, operatorId]) => operatorId));
  const coverageOperatorIdsByLine = coverageOperatorIdsForLines(lineOperatorIds, pack.coverageLineOperatorScopes);
  const stationLineOperatorIds = new Map();
  const stationOperatorIds = new Map();
  const stationLineIds = new Map();
  for (const stationLine of pack.stationLines ?? []) {
    const operatorId = lineOperatorIds.get(stationLine.lineId);
    if (!operatorId) {
      continue;
    }
    stationLineOperatorIds.set(`${stationLine.stationId}:${stationLine.lineId}`, operatorId);
    const operators = stationOperatorIds.get(stationLine.stationId) ?? new Set();
    operators.add(operatorId);
    stationOperatorIds.set(stationLine.stationId, operators);
    const lineIds = stationLineIds.get(stationLine.stationId) ?? new Set();
    lineIds.add(stationLine.lineId);
    stationLineIds.set(stationLine.stationId, lineIds);
  }
  const records = [];
  const addRecord = (row, entityType, entityId, field, operatorIds = [], lineIds = []) => {
    const fieldProvenance = row.fieldProvenance?.[field];
    if (fieldProvenance !== undefined
      && (!fieldProvenance || typeof fieldProvenance !== "object" || Array.isArray(fieldProvenance))) {
      throw new Error(`${entityType}.${field} fieldProvenance must be an object`);
    }
    if (fieldProvenance?.sourceId !== undefined) {
      requiredString(fieldProvenance.sourceId, `${entityType}.${field} fieldProvenance sourceId`);
    }
    const rowSourceId = row.sourceId ?? defaultSourceId;
    if (fieldProvenance?.sourceId !== undefined && fieldProvenance.sourceId !== rowSourceId) {
      for (const linkageField of ["sourceSnapshotId", "providerRecordHash", "evidenceHash", "verifiedAt"]) {
        if (typeof fieldProvenance[linkageField] !== "string" || fieldProvenance[linkageField].trim() === "") {
          throw new Error(`${entityType}.${field} fieldProvenance source change requires explicit ${linkageField}`);
        }
      }
    }
    const provenanceRow = fieldProvenance ? { ...row, ...fieldProvenance } : row;
    const sourceId = provenanceRow.sourceId ?? defaultSourceId;
    if (!sourceId) {
      return;
    }
    if (fieldProvenance && !sourceScopes.has(sourceId)) {
      throw new Error(`${entityType}.${field} fieldProvenance source is missing from sourceInventory: ${sourceId}`);
    }
    if (fieldProvenance && !sourceFields.get(sourceId)?.has(field)) {
      throw new Error(`${entityType}.${field} fieldProvenance source does not provide ${field}: ${sourceId}`);
    }
    const coverageScopes = recordCoverageScopes(
      sourceScopes.get(sourceId),
      operatorIds,
      lineIds,
      coverageOperatorIdsByLine,
    );
    const recordDerivationKind =
      entityType === "facility" && field === "status" && !sourceFields.get(sourceId)?.has("status")
        ? "GENERATED"
        : derivationKind(provenanceRow, artifactKind);
    for (const coverageScope of coverageScopes) {
      records.push({
        entityType,
        entityId,
        field,
        sourceId,
        ...(provenanceRow.sourceSnapshotId ? { sourceSnapshotId: provenanceRow.sourceSnapshotId } : {}),
        ...(provenanceRow.providerRecordHash ? { providerRecordHash: provenanceRow.providerRecordHash } : {}),
        ...(provenanceRow.evidenceHash ? { evidenceHash: provenanceRow.evidenceHash } : {}),
        ...(coverageScope ? { coverageScope } : {}),
        derivationKind: recordDerivationKind,
        verifiedAt: provenanceRow.verifiedAt ?? provenanceRow.lastVerifiedAt ?? provenanceRow.reviewedAt
          ?? provenanceRow.updatedAt ?? sourceUpdatedAt.get(sourceId) ?? "",
      });
    }
  };

  for (const station of pack.stations ?? []) {
    addRecord(
      station,
      "station",
      station.id,
      "station_name",
      [...(stationOperatorIds.get(station.id) ?? [])],
      [...(stationLineIds.get(station.id) ?? [])],
    );
  }
  for (const stationLine of pack.stationLines ?? []) {
    const entityId = `${stationLine.stationId}:${stationLine.lineId}`;
    const operatorIds = [lineOperatorIds.get(stationLine.lineId)].filter(Boolean);
    addRecord(stationLine, "station_line", entityId, "line", operatorIds, [stationLine.lineId]);
    addRecord(stationLine, "station_line", entityId, "station_code", operatorIds, [stationLine.lineId]);
  }
  for (const edge of routeGraphNetworkEdges(pack)) {
    const operatorIds = operatorIdsForNodes([edge.fromNodeId, edge.toNodeId], stationLineOperatorIds);
    const lineIds = lineIdsForNodes([edge.fromNodeId, edge.toNodeId]);
    addRecord(edge, "network_edge", edge.id, "network_edges", operatorIds, lineIds);
    addRecord(edge, "network_edge", edge.id, "duration_seconds", operatorIds, lineIds);
    addRecord(edge, "network_edge", edge.id, "distance_meters", operatorIds, lineIds);
  }
  for (const position of pack.routeMapPositions ?? []) {
    const entityId = `${position.stationId}:${position.lineId}:${position.region ?? ""}`;
    const operatorIds = [lineOperatorIds.get(position.lineId)].filter(Boolean);
    addRecord(position, "route_map_position", entityId, "route_map_position", operatorIds, [position.lineId]);
    if (Array.isArray(position.labelPolygon) && position.labelPolygon.length > 0) {
      addRecord(position, "route_map_position", entityId, "route_map_label_polygon", operatorIds, [position.lineId]);
    }
  }
  for (const track of pack.routeMapLineTracks ?? []) {
    const entityId = `${track.lineId}:${track.trackIndex}:${track.region ?? ""}`;
    const operatorIds = [lineOperatorIds.get(track.lineId)].filter(Boolean);
    addRecord(track, "route_map_line_track", entityId, "route_map_line_track", operatorIds, [track.lineId]);
  }
  const transitRouteLineIds = new Map((pack.transitRoutes ?? []).map((route) => [route.id, route.lineId]));
  const transitRouteOperatorIds = new Map();
  for (const route of pack.transitRoutes ?? []) {
    const operatorIds = [lineOperatorIds.get(route.lineId)].filter(Boolean);
    transitRouteOperatorIds.set(route.id, operatorIds);
    addRecord(route, "transit_route", route.id, "route", operatorIds, [route.lineId]);
  }
  const serviceOperatorIds = new Map();
  const serviceLineIds = new Map();
  const tripOperatorIds = new Map();
  const tripLineIds = new Map();
  for (const trip of pack.transitTrips ?? []) {
    const lineId = transitRouteLineIds.get(trip.routeId);
    const operatorId = lineOperatorIds.get(lineId);
    if (operatorId) {
      tripOperatorIds.set(trip.id, [operatorId]);
      tripLineIds.set(trip.id, [lineId]);
      const operatorIds = serviceOperatorIds.get(trip.serviceId) ?? new Set();
      operatorIds.add(operatorId);
      serviceOperatorIds.set(trip.serviceId, operatorIds);
      const lineIds = serviceLineIds.get(trip.serviceId) ?? new Set();
      lineIds.add(lineId);
      serviceLineIds.set(trip.serviceId, lineIds);
    }
  }
  for (const calendar of pack.serviceCalendars ?? []) {
    addRecord(
      calendar,
      "service_calendar",
      calendar.serviceId,
      "service_calendar",
      [...(serviceOperatorIds.get(calendar.serviceId) ?? [])],
      [...(serviceLineIds.get(calendar.serviceId) ?? [])],
    );
  }
  for (const calendarDate of pack.serviceCalendarDates ?? []) {
    addRecord(
      calendarDate,
      "service_calendar_date",
      `${calendarDate.serviceId}:${calendarDate.date}`,
      "calendar_date",
      [...(serviceOperatorIds.get(calendarDate.serviceId) ?? [])],
      [...(serviceLineIds.get(calendarDate.serviceId) ?? [])],
    );
  }
  for (const trip of pack.transitTrips ?? []) {
    addRecord(
      trip,
      "transit_trip",
      trip.id,
      "trip",
      tripOperatorIds.get(trip.id) ?? [],
      tripLineIds.get(trip.id) ?? [],
    );
  }
  for (const stopTime of pack.transitStopTimes ?? []) {
    const operatorIds = [lineOperatorIds.get(stopTime.lineId)].filter(Boolean);
    addRecord(
      stopTime,
      "transit_stop_time",
      `${stopTime.tripId}:${stopTime.stopSequence}`,
      "stop_time",
      operatorIds,
      [stopTime.lineId],
    );
  }
  for (const frequency of pack.transitFrequencies ?? []) {
    addRecord(
      frequency,
      "transit_frequency",
      `${frequency.tripId}:${frequency.startTimeSeconds}:${frequency.endTimeSeconds}`,
      "frequency",
      tripOperatorIds.get(frequency.tripId) ?? [],
      tripLineIds.get(frequency.tripId) ?? [],
    );
  }
  const scheduleOperatorIds = [...new Set([...transitRouteOperatorIds.values()].flat())].sort((left, right) =>
    codepointCompare(left, right),
  );
  const scheduleLineIds = [...new Set(transitRouteLineIds.values())].sort((left, right) => codepointCompare(left, right));
  for (const feedInfo of pack.transitFeedInfo ?? []) {
    addRecord(feedInfo, "transit_feed_info", "feed_info", "feed_info", scheduleOperatorIds, scheduleLineIds);
  }
  for (const facility of pack.facilities ?? []) {
    const operatorIds = [...(stationOperatorIds.get(facility.stationId) ?? [])];
    const lineIds = facility.lineId ? [facility.lineId] : [...(stationLineIds.get(facility.stationId) ?? [])];
    const field = facilityField(facility.type);
    if (field) {
      addRecord(facility, "facility", facility.id, field, operatorIds, lineIds);
    }
    addRecord(facility, "facility", facility.id, "status", operatorIds, lineIds);
    if (facility.verifiedAt || facility.lastVerifiedAt) {
      addRecord(facility, "facility", facility.id, "verified_at", operatorIds, lineIds);
    }
  }
  for (const mapping of pack.realtimeProviderStationMappings ?? []) {
    if (mapping.supportsArrivals === true) {
      const operatorIds = [lineOperatorIds.get(mapping.lineId)].filter(Boolean);
      addRecord(
        mapping,
        "realtime_provider_station_mapping",
        `${mapping.providerId}:${mapping.providerStationId}`,
        "realtime_arrival_reference",
        operatorIds,
        [mapping.lineId],
      );
    }
  }

  return {
    id: pack.id,
    version: pack.version,
    artifactKind,
    sqliteSha256,
    normalizedSourceInventorySha256: sha256(Buffer.from(JSON.stringify(pack.sourceInventory ?? []))),
    records: records.sort((left, right) =>
      codepointCompare(`${left.entityType}:${left.entityId}:${left.field}:${left.sourceId}`, `${right.entityType}:${right.entityId}:${right.field}:${right.sourceId}`),
    ),
  };
}

function sourceCoverageScopeMap(sourceInventory) {
  const scopes = new Map();
  for (const source of sourceInventory) {
    if (!source.coverageScope || typeof source.coverageScope !== "object" || Array.isArray(source.coverageScope)) {
      continue;
    }
    scopes.set(source.id, {
      regionIds: Array.isArray(source.coverageScope.regionIds) ? [...source.coverageScope.regionIds] : [],
      operatorIds: Array.isArray(source.coverageScope.operatorIds) ? [...source.coverageScope.operatorIds] : [],
      lineIds: Array.isArray(source.coverageScope.lineIds) ? [...source.coverageScope.lineIds] : [],
      sourceDomains: Array.isArray(source.coverageScope.sourceDomains) ? [...source.coverageScope.sourceDomains] : [],
    });
  }
  return scopes;
}

function coverageOperatorIdsForLines(lineOperatorIds, coverageLineOperatorScopes) {
  const result = new Map();
  for (const scope of coverageLineOperatorScopes ?? []) {
    if (!lineOperatorIds.has(scope.lineId)) {
      continue;
    }
    const operatorIds = result.get(scope.lineId) ?? new Set();
    operatorIds.add(scope.operatorId);
    result.set(scope.lineId, operatorIds);
  }
  for (const [lineId, operatorId] of lineOperatorIds.entries()) {
    if (!result.has(lineId)) {
      result.set(lineId, new Set([operatorId]));
    }
  }
  return result;
}

function recordCoverageScopes(sourceScope, operatorIds, lineIds, coverageOperatorIdsByLine) {
  if (!sourceScope) {
    return [null];
  }
  const scopedOperatorIds = sourceScope.operatorIds.filter((operatorId) => operatorIds.includes(operatorId));
  const scopedLineIds = sourceScope.lineIds.filter((lineId) => lineIds.includes(lineId)).sort();
  if (sourceScope.lineIds.length > 0 && lineIds.length > 0 && scopedLineIds.length === 0) {
    throw new Error("source coverageScope lineIds do not include record lineIds");
  }
  if (scopedLineIds.length === 0) {
    return [{
      regionIds: sourceScope.regionIds,
      operatorIds: scopedOperatorIds.length > 0 ? scopedOperatorIds : sourceScope.operatorIds,
      sourceDomains: sourceScope.sourceDomains,
    }];
  }
  return scopedLineIds.flatMap((lineId) => {
    const scopedLineOperatorIds = [...(coverageOperatorIdsByLine.get(lineId) ?? [])]
      .filter((operatorId) => sourceScope.operatorIds.includes(operatorId))
      .sort(compareStrings);
    if (scopedLineOperatorIds.length === 0) {
      throw new Error(`source coverageScope does not include operator for record line: ${lineId}`);
    }
    return scopedLineOperatorIds.map((operatorId) => ({
      regionIds: sourceScope.regionIds,
      operatorIds: [operatorId],
      lineIds: [lineId],
      sourceDomains: sourceScope.sourceDomains,
    }));
  });
}

function lineIdsForNodes(nodeIds) {
  return [...new Set(nodeIds.map((nodeId) => String(nodeId).split(":")[1]).filter(Boolean))].sort(compareStrings);
}

function operatorIdsForNodes(nodeIds, stationLineOperatorIds) {
  return [
    ...new Set(
      nodeIds.map((nodeId) => stationLineOperatorIds.get(canonicalStationLineNodeId(nodeId))).filter(Boolean),
    ),
  ].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function canonicalStationLineNodeId(nodeId) {
  const parts = String(nodeId).split(":");
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : nodeId;
}

function derivationKind(row, artifactKind) {
  if (["OFFICIAL", "FIELD_VERIFIED", "MANUAL_OVERRIDE", "GENERATED", "FIXTURE"].includes(row.derivationKind)) {
    return row.derivationKind;
  }
  if (artifactKind === "fixture") {
    return "FIXTURE";
  }
  if (row.provenanceKind === "OFFICIAL_SOURCE") {
    return "OFFICIAL";
  }
  if (row.provenanceKind === "OPERATOR_CONFIRMED" || row.provenanceKind === "FIELD_SURVEY") {
    return "FIELD_VERIFIED";
  }
  return "GENERATED";
}

function facilityField(type) {
  return {
    ELEVATOR: "elevator",
    ESCALATOR: "escalator",
    WHEELCHAIR_LIFT: "wheelchair_lift",
  }[type];
}

function outputPathForPack(outputDir, packUrl, pack) {
  if (/^https:\/\//.test(packUrl)) {
    return path.join(outputDir, stagedPackPath(pack));
  }
  return path.join(outputDir, packUrl);
}

function packSignature(pack) {
  if (pack.artifactKind === "production") {
    const canonical = productionSignaturePayload(pack);
    return {
      algorithm: pack.manifestVersion === 2 ? "rsa-sha256-pack-manifest-v2" : "rsa-sha256-pack-manifest-v1",
      value: rsaSha256Signature(signingPrivateKey(), canonical),
    };
  }
  return {
    algorithm: pack.manifestVersion === 2 ? "sha256-pack-manifest-v2" : "sha256-pack-manifest-v1",
    value: sha256(Buffer.from(fixtureSignaturePayload(pack))),
  };
}

function manifestSignature(manifest, packs) {
  const hasProductionPack = packs.some((pack) => pack.artifactKind === "production");
  const canonical = canonicalJson(withoutSignature(manifest));
  if (hasProductionPack) {
    return {
      algorithm: "rsa-sha256-manifest-v2",
      value: rsaSha256Signature(signingPrivateKey(), canonical),
    };
  }
  return {
    algorithm: "sha256-manifest-v2",
    value: sha256(Buffer.from(canonical)),
  };
}

function fixtureSignaturePayload(pack) {
  return `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
}

function productionSignaturePayload(pack) {
  return `${fixtureSignaturePayload(pack)}:${canonicalProductionPackUrl(pack.url)}`;
}

function representativeRouteRegressionSignature(pack) {
  if (pack.artifactKind === "production") {
    return {
      algorithm: "rsa-sha256-route-regression-v1",
      value: rsaSha256Signature(signingPrivateKey(), representativeRouteRegressionSignaturePayload(pack)),
    };
  }
  return {
    algorithm: "sha256-route-regression-v1",
    value: sha256(Buffer.from(representativeRouteRegressionSignaturePayload(pack))),
  };
}

function representativeRouteRegressionSignaturePayload(pack) {
  const basePayload = `${fixtureSignaturePayload(pack)}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}`;
  if (pack.artifactKind === "production") {
    return `${basePayload}:${canonicalProductionPackUrl(pack.url)}`;
  }
  return basePayload;
}

function representativeRouteRegressionPayload(routes) {
  return JSON.stringify(canonicalRepresentativeRouteRegressions(routes));
}

function canonicalRepresentativeRouteRegressions(routes) {
  return routes.map((route) => ({
    id: requiredString(route.id, "representativeRouteRegressions.id"),
    pattern: requiredString(route.pattern, "representativeRouteRegressions.pattern"),
    fromNodeId: requiredString(route.fromNodeId, "representativeRouteRegressions.fromNodeId"),
    toNodeId: requiredString(route.toNodeId, "representativeRouteRegressions.toNodeId"),
    requiredEdgeIds: route.requiredEdgeIds.map((edgeId) =>
      requiredString(edgeId, "representativeRouteRegressions.requiredEdgeIds"),
    ),
  }));
}

function canonicalRouteRegressionScope(scope) {
  return {
    mode: requiredString(scope.mode, "routeRegressionScope.mode"),
    excludedPatterns: Array.isArray(scope.excludedPatterns)
      ? scope.excludedPatterns.map((pattern) => requiredString(pattern, "routeRegressionScope.excludedPatterns"))
      : [],
    claim: requiredString(scope.claim, "routeRegressionScope.claim"),
  };
}

function canonicalProductionPackUrl(packUrl) {
  return new URL(packUrl).toString();
}

function regionalQualityMetrics(pack) {
  const stationIds = new Set((pack.stations ?? []).map((station) => station.id));
  const stationCount = stationIds.size;
  const stationLineKeys = new Set((pack.stationLines ?? []).map((row) => `${row.stationId}:${row.lineId}`));
  const coveredStationIds = new Set(
    (pack.facilities ?? [])
      .map((facility) => facility.stationId)
      .filter((stationId) => stationIds.has(stationId)),
  );
  const facilityEvidence = pack.stationFacilityEvidence ?? [];
  const facilityRows = pack.facilities ?? [];
  const facilityTypes = new Set([
    ...facilityEvidence.map((row) => row.facilityType),
    ...facilityRows.map((row) => row.type),
  ].filter(Boolean));
  const facilityDenominator = stationLineKeys.size * facilityTypes.size;
  const facilityEvidenceKeys = facilityEvidence.length > 0
    ? new Set(facilityEvidence.map((row) => `${row.stationId}:${row.lineId}:${row.facilityType}`))
    : facilityKeysFromRows(facilityRows, pack.stationLines ?? []);
  const facilityFreshnessRows = facilityEvidence.length > 0 ? facilityEvidence : facilityRows;
  const strictEligibleCount = facilityEvidence.filter((row) => row.strictRouteEligible === true).length;
  const operationalKnownCount = facilityFreshnessRows.filter((row) =>
    knownOperationalStatus(row.operationalStatus ?? row.status)
  ).length;
  const freshnessValidCount = facilityFreshnessRows.filter((row) => hasVerificationTimestamp(row)).length;
  const pathwayEdges = pack.stationPathwayEdges ?? [];
  const fieldVerifiedPathwayCount = pathwayEdges.filter((row) =>
    ["FIELD_SURVEY", "OPERATOR_CONFIRMED"].includes(String(row.provenanceKind ?? "").toUpperCase())
  ).length;
  const networkEdges = routeGraphNetworkEdges(pack);
  const edgeCount = networkEdges.length;
  const unknownAccessibilityCount = networkEdges.filter(
    (edge) => normalizedAccessibilityStatus(edge.accessibilityStatus, "networkEdges.accessibilityStatus") === "UNKNOWN",
  ).length;
  const unknownAccessibilityRatio = ratio(unknownAccessibilityCount, edgeCount);
  return {
    stationCount,
    facilityCoverageRatio: ratio(coveredStationIds.size, stationCount),
    requiredFacilityEvidenceCoverageRatio: ratio(facilityEvidenceKeys.size, facilityDenominator),
    strictRouteEligibleFacilityRatio: ratio(strictEligibleCount, facilityEvidence.length),
    operationalKnownRatio: ratio(operationalKnownCount, facilityFreshnessRows.length),
    freshnessValidRatio: ratio(freshnessValidCount, facilityFreshnessRows.length),
    fieldVerifiedPathwayRatio: ratio(fieldVerifiedPathwayCount, pathwayEdges.length),
    edgeCount,
    unknownAccessibilityRatio,
    unknownEdgeRatioByProfile: {
      wheelchair: unknownAccessibilityRatio,
      stroller: unknownAccessibilityRatio,
      lowMobility: unknownAccessibilityRatio,
    },
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function facilityKeysFromRows(facilities, stationLines) {
  const lineIdsByStationId = new Map();
  for (const row of stationLines) {
    const lineIds = lineIdsByStationId.get(row.stationId) ?? [];
    lineIds.push(row.lineId);
    lineIdsByStationId.set(row.stationId, lineIds);
  }
  const keys = new Set();
  for (const facility of facilities) {
    for (const lineId of lineIdsByStationId.get(facility.stationId) ?? []) {
      keys.add(`${facility.stationId}:${lineId}:${facility.type}`);
    }
  }
  return keys;
}

function knownOperationalStatus(value) {
  const status = String(value ?? "").toUpperCase();
  return status !== "" && status !== "UNKNOWN";
}

function hasVerificationTimestamp(row) {
  return Boolean(row.verifiedAt ?? row.lastVerifiedAt ?? row.reviewedAt ?? row.updatedAt);
}

function routeGraphNetworkEdges(pack) {
  return [
    ...(pack.networkEdges ?? []),
    ...outOfStationTransferNetworkEdges(pack),
  ];
}

function outOfStationTransferNetworkEdges(pack) {
  const edges = [];
  for (const link of pack.outOfStationTransferLinks ?? []) {
    edges.push(outOfStationTransferNetworkEdge(link));
    if (link.bidirectional === true) {
      edges.push(
        outOfStationTransferNetworkEdge({
          ...link,
          id: `${link.id}-reverse`,
          fromStationId: link.toStationId,
          fromLineId: link.toLineId,
          toStationId: link.fromStationId,
          toLineId: link.fromLineId,
          fromExitId: link.toExitId,
          toExitId: link.fromExitId,
        }),
      );
    }
  }
  return edges;
}

function outOfStationTransferNetworkEdge(link) {
  return {
    id: requiredString(link.id, "outOfStationTransferLinks.id"),
    fromNodeId: `${requiredString(link.fromStationId, "outOfStationTransferLinks.fromStationId")}:${requiredString(
      link.fromLineId,
      "outOfStationTransferLinks.fromLineId",
    )}`,
    toNodeId: `${requiredString(link.toStationId, "outOfStationTransferLinks.toStationId")}:${requiredString(
      link.toLineId,
      "outOfStationTransferLinks.toLineId",
    )}`,
    durationSeconds: link.durationSeconds ?? 0,
    distanceMeters: link.distanceMeters ?? 0,
    edgeType: "OUT_OF_STATION_TRANSFER",
    stairAccessState: link.stairAccessState ?? "UNKNOWN",
    accessibilityStatus: link.accessibilityStatus ?? "UNKNOWN",
    reliabilityScore: link.reliabilityScore ?? 100,
    sourceId: link.sourceId ?? "",
    sourceSnapshotId: link.sourceSnapshotId ?? "",
    providerRecordHash: link.providerRecordHash ?? "",
    provenanceKind: link.provenanceKind ?? "UNKNOWN",
    verificationStatus: link.verificationStatus ?? "UNKNOWN",
    lastVerifiedAt: link.lastFieldVerifiedAt ?? link.lastVerifiedAt,
    evidenceHash: link.evidenceHash ?? "",
  };
}

function buildSqlitePack(sqlitePath, schema, pack, officialOdFareAdmissions) {
  const database = new DatabaseSync(sqlitePath);
  const isProductionPack = pack.artifactKind === "production";
  const networkEdges = routeGraphNetworkEdges(pack);
  try {
    database.exec(schema);
    database.exec("BEGIN IMMEDIATE");
    try {
      insertCatalogMetadata(database, pack);
      insertRows(database, "operators", ["id", "name_ko", "name_en"], pack.operators, (row) => [
        requiredString(row.id, "operators.id"),
        requiredString(row.nameKo, "operators.nameKo"),
        row.nameEn ?? "",
      ]);
      insertRows(database, "lines", ["id", "operator_id", "name_ko", "name_en", "color"], pack.lines, (row) => [
        requiredString(row.id, "lines.id"),
        requiredString(row.operatorId, "lines.operatorId"),
        requiredString(row.nameKo, "lines.nameKo"),
        row.nameEn ?? "",
        row.color ?? "",
      ]);
      insertRows(
        database,
        "stations",
        [
          "id",
          "name_ko",
          "name_en",
          "name_sub",
          "normalized_name",
          "region",
          "latitude",
          "longitude",
          "data_quality_level",
          "data_source_type",
          "last_verified_at",
        ],
        pack.stations,
        (row) => [
          requiredString(row.id, "stations.id"),
          requiredString(row.nameKo, "stations.nameKo"),
          row.nameEn ?? "",
          row.nameSub ?? "",
          requiredString(row.normalizedName, "stations.normalizedName"),
          row.region ?? "",
          row.latitude ?? null,
          row.longitude ?? null,
          row.dataQualityLevel ?? "LEVEL_1",
          row.dataSourceType ?? "OFFICIAL_FILE",
          timestamp(row.lastVerifiedAt),
        ],
      );
      insertRows(database, "station_aliases", ["station_id", "alias", "normalized_alias"], pack.stationAliases ?? [], (row) => [
        requiredString(row.stationId, "stationAliases.stationId"),
        requiredString(row.alias, "stationAliases.alias"),
        requiredString(row.normalizedAlias, "stationAliases.normalizedAlias"),
      ]);
      insertRows(
        database,
        "station_lines",
        ["station_id", "line_id", "station_code", "line_sequence", "platform_info"],
        pack.stationLines,
        (row) => [
          requiredString(row.stationId, "stationLines.stationId"),
          requiredString(row.lineId, "stationLines.lineId"),
          row.stationCode ?? "",
          requiredInteger(row.lineSequence, "stationLines.lineSequence"),
          row.platformInfo ?? "",
        ],
      );
      insertRows(
        database,
        "fare_zones",
        ["id", "name_ko", "region", "currency_code", "source_id"],
        pack.fareZones ?? [],
        (row) => [
          requiredString(row.id, "fareZones.id"),
          requiredString(row.nameKo, "fareZones.nameKo"),
          requiredString(row.region, "fareZones.region"),
          row.currencyCode ?? "KRW",
          row.sourceId ?? "",
        ],
      );
      insertRows(
        database,
        "fare_rules",
        ["id", "zone_id", "base_card_fare", "base_cash_fare", "base_distance_meters", "additional_steps_json"],
        pack.fareRules ?? [],
        (row) => [
          requiredString(row.id, "fareRules.id"),
          requiredString(row.zoneId, "fareRules.zoneId"),
          requiredNonNegativeInteger(row.baseCardFare, "fareRules.baseCardFare"),
          requiredNonNegativeInteger(row.baseCashFare, "fareRules.baseCashFare"),
          requiredNonNegativeInteger(row.baseDistanceMeters, "fareRules.baseDistanceMeters"),
          canonicalFareAdditionalSteps(row.additionalSteps ?? [], "fareRules.additionalSteps"),
        ],
      );
      insertRows(
        database,
        "fare_discounts",
        ["id", "zone_id", "rider_type", "card_fare", "cash_fare", "free_ride", "description_ko"],
        pack.fareDiscounts ?? [],
        (row) => [
          requiredString(row.id, "fareDiscounts.id"),
          requiredString(row.zoneId, "fareDiscounts.zoneId"),
          requiredString(row.riderType, "fareDiscounts.riderType"),
          optionalNonNegativeInteger(row.cardFare, "fareDiscounts.cardFare"),
          optionalNonNegativeInteger(row.cashFare, "fareDiscounts.cashFare"),
          boolFlag(row.freeRide ?? false, "fareDiscounts.freeRide"),
          row.descriptionKo ?? "",
        ],
      );
      insertRows(
        database,
        "station_fare_zones",
        ["station_id", "line_id", "zone_id"],
        pack.stationFareZones ?? [],
        (row) => [
          requiredString(row.stationId, "stationFareZones.stationId"),
          requiredString(row.lineId, "stationFareZones.lineId"),
          requiredString(row.zoneId, "stationFareZones.zoneId"),
        ],
      );
      const officialOdFareQuotes = (pack.officialOdFareQuotes ?? [])
        .map((row) => {
          const admission = officialOdFareAdmissions.get(row.sourceId);
          return { admission, row, values: officialOdFareQuoteValues(row, admission) };
        })
        .sort((left, right) => codepointCompare(left.values[0], right.values[0])
          || codepointCompare(left.values[1], right.values[1]));
      for (const admission of new Set(officialOdFareQuotes.map(({ admission }) => admission))) {
        const sourceQuotes = officialOdFareQuotes.filter(({ admission: rowAdmission }) => rowAdmission === admission);
        if (sourceQuotes.length !== admission.quoteCount) {
          throw new Error("officialOdFareQuotes count must match admission");
        }
        if (officialOdFareQuoteSetHash(sourceQuotes.map(({ row }) => row)) !== admission.quoteSetHash) {
          throw new Error("officialOdFareQuotes quote set hash must match admission");
        }
      }
      insertRows(
        database,
        "official_od_fare_quotes",
        [
          "origin_station_id",
          "destination_station_id",
          "source_id",
          "snapshot_id",
          "mapping_ledger_hash",
          "gnrl_card_fare",
          "gnrl_cash_fare",
          "yung_card_fare",
          "yung_cash_fare",
          "child_card_fare",
          "child_cash_fare",
        ],
        officialOdFareQuotes,
        ({ values }) => values,
      );
      insertRows(
        database,
        "service_calendars",
        [
          "service_id",
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
          "sunday",
          "start_date",
          "end_date",
          "timezone",
        ],
        pack.serviceCalendars ?? [],
        (row) => [
          requiredString(row.serviceId, "serviceCalendars.serviceId"),
          boolFlag(row.monday, "serviceCalendars.monday"),
          boolFlag(row.tuesday, "serviceCalendars.tuesday"),
          boolFlag(row.wednesday, "serviceCalendars.wednesday"),
          boolFlag(row.thursday, "serviceCalendars.thursday"),
          boolFlag(row.friday, "serviceCalendars.friday"),
          boolFlag(row.saturday, "serviceCalendars.saturday"),
          boolFlag(row.sunday, "serviceCalendars.sunday"),
          serviceDate(row.startDate, "serviceCalendars.startDate"),
          serviceDate(row.endDate, "serviceCalendars.endDate"),
          row.timezone ?? "Asia/Seoul",
        ],
      );
      insertRows(
        database,
        "service_calendar_dates",
        ["service_id", "date", "exception_type"],
        pack.serviceCalendarDates ?? [],
        (row) => [
          requiredString(row.serviceId, "serviceCalendarDates.serviceId"),
          serviceDate(row.date, "serviceCalendarDates.date"),
          requiredInteger(row.exceptionType, "serviceCalendarDates.exceptionType"),
        ],
      );
      insertRows(
        database,
        "transit_routes",
        ["id", "line_id", "route_short_name", "route_long_name", "direction_name", "timezone"],
        pack.transitRoutes ?? [],
        (row) => [
          requiredString(row.id, "transitRoutes.id"),
          requiredString(row.lineId, "transitRoutes.lineId"),
          row.routeShortName ?? "",
          row.routeLongName ?? "",
          row.directionName ?? "",
          row.timezone ?? "Asia/Seoul",
        ],
      );
      insertRows(
        database,
        "transit_trips",
        [
          "id",
          "route_id",
          "service_id",
          "trip_headsign",
          "direction_id",
          "service_pattern",
          "service_class",
          "service_day_start_seconds",
        ],
        pack.transitTrips ?? [],
        (row) => [
          requiredString(row.id, "transitTrips.id"),
          requiredString(row.routeId, "transitTrips.routeId"),
          requiredString(row.serviceId, "transitTrips.serviceId"),
          row.tripHeadsign ?? "",
          row.directionId ?? "",
          row.servicePattern ?? "LOCAL",
          row.serviceClass ?? "SUBWAY",
          row.serviceDayStartSeconds ?? 0,
        ],
      );
      insertRows(
        database,
        "transit_stop_times",
        [
          "trip_id",
          "stop_sequence",
          "station_id",
          "line_id",
          "arrival_seconds",
          "departure_seconds",
          "pickup_type",
          "drop_off_type",
        ],
        pack.transitStopTimes ?? [],
        (row) => [
          requiredString(row.tripId, "transitStopTimes.tripId"),
          requiredPositiveInteger(row.stopSequence, "transitStopTimes.stopSequence"),
          requiredString(row.stationId, "transitStopTimes.stationId"),
          requiredString(row.lineId, "transitStopTimes.lineId"),
          requiredNonNegativeInteger(row.arrivalSeconds, "transitStopTimes.arrivalSeconds"),
          requiredNonNegativeInteger(row.departureSeconds, "transitStopTimes.departureSeconds"),
          row.pickupType ?? 0,
          row.dropOffType ?? 0,
        ],
      );
      insertRows(
        database,
        "transit_frequencies",
        ["trip_id", "start_time_seconds", "end_time_seconds", "headway_seconds", "exact_times"],
        pack.transitFrequencies ?? [],
        (row) => [
          requiredString(row.tripId, "transitFrequencies.tripId"),
          requiredNonNegativeInteger(row.startTimeSeconds, "transitFrequencies.startTimeSeconds"),
          requiredPositiveInteger(row.endTimeSeconds, "transitFrequencies.endTimeSeconds"),
          requiredPositiveInteger(row.headwaySeconds, "transitFrequencies.headwaySeconds"),
          boolFlag(row.exactTimes ?? false, "transitFrequencies.exactTimes"),
        ],
      );
      insertRows(
        database,
        "transit_feed_info",
        ["id", "feed_end_date"],
        pack.transitFeedInfo ?? [],
        (row) => [1, serviceDate(row.feedEndDate, "transitFeedInfo.feedEndDate")],
      );
      insertRows(
        database,
        "route_service_artifact_evidence",
        [
          "service_class",
          "timetable_artifact_id",
          "timetable_artifact_sha256",
          "canonical_pack_id",
          "canonical_pack_sha256",
          "canonical_pack_sqlite_sha256",
          "admission_status",
          "admission_eligible",
          "fresh_until",
          "source_issue",
        ],
        pack.routeServiceArtifactEvidence ?? [],
        (row) => [
          requiredString(row.serviceClass, "routeServiceArtifactEvidence.serviceClass"),
          requiredString(row.timetableArtifactId, "routeServiceArtifactEvidence.timetableArtifactId"),
          requiredString(row.timetableArtifactSha256, "routeServiceArtifactEvidence.timetableArtifactSha256"),
          requiredString(row.canonicalPackId, "routeServiceArtifactEvidence.canonicalPackId"),
          requiredString(row.canonicalPackSha256, "routeServiceArtifactEvidence.canonicalPackSha256"),
          requiredString(row.canonicalPackSqliteSha256, "routeServiceArtifactEvidence.canonicalPackSqliteSha256"),
          requiredString(row.admissionStatus, "routeServiceArtifactEvidence.admissionStatus"),
          boolFlag(row.admissionEligible, "routeServiceArtifactEvidence.admissionEligible"),
          row.freshUntil ?? null,
          requiredInteger(row.sourceIssue, "routeServiceArtifactEvidence.sourceIssue"),
        ],
      );
      insertRows(
        database,
        "realtime_provider_line_mappings",
        [
          "provider_id",
          "provider_line_id",
          "line_id",
          "source_id",
          "supports_arrivals",
          "supports_train_positions",
          "mapping_confidence",
          "updated_at",
        ],
        pack.realtimeProviderLineMappings ?? [],
        (row) => [
          requiredString(row.providerId, "realtimeProviderLineMappings.providerId"),
          requiredString(row.providerLineId, "realtimeProviderLineMappings.providerLineId"),
          requiredString(row.lineId, "realtimeProviderLineMappings.lineId"),
          requiredString(row.sourceId, "realtimeProviderLineMappings.sourceId"),
          boolFlag(row.supportsArrivals, "realtimeProviderLineMappings.supportsArrivals"),
          boolFlag(row.supportsTrainPositions, "realtimeProviderLineMappings.supportsTrainPositions"),
          row.mappingConfidence ?? "UNKNOWN",
          timestamp(row.updatedAt),
        ],
      );
      insertRows(
        database,
        "realtime_provider_station_mappings",
        [
          "provider_id",
          "provider_line_id",
          "provider_station_id",
          "station_id",
          "line_id",
          "source_id",
          "query_name",
          "supports_arrivals",
          "supports_train_positions",
          "mapping_confidence",
          "updated_at",
        ],
        pack.realtimeProviderStationMappings ?? [],
        (row) => [
          requiredString(row.providerId, "realtimeProviderStationMappings.providerId"),
          requiredString(row.providerLineId, "realtimeProviderStationMappings.providerLineId"),
          requiredString(row.providerStationId, "realtimeProviderStationMappings.providerStationId"),
          requiredString(row.stationId, "realtimeProviderStationMappings.stationId"),
          requiredString(row.lineId, "realtimeProviderStationMappings.lineId"),
          requiredString(row.sourceId, "realtimeProviderStationMappings.sourceId"),
          row.queryName ?? "",
          boolFlag(row.supportsArrivals, "realtimeProviderStationMappings.supportsArrivals"),
          boolFlag(row.supportsTrainPositions, "realtimeProviderStationMappings.supportsTrainPositions"),
          row.mappingConfidence ?? "UNKNOWN",
          timestamp(row.updatedAt),
        ],
      );
      insertRows(
        database,
        "out_of_station_transfer_links",
        [
          "id",
          "from_station_id",
          "from_line_id",
          "to_station_id",
          "to_line_id",
          "from_exit_id",
          "to_exit_id",
          "duration_seconds",
          "distance_meters",
          "bidirectional",
          "requires_fare_exit",
          "requires_reentry",
          "covered_route",
          "crossing_risk",
          "slope_level",
          "curb_cut_status",
          "sidewalk_status",
          "accessibility_status",
          "stair_access_state",
          "reliability_score",
          "source_id",
          "source_snapshot_id",
          "provider_record_hash",
          "provenance_kind",
          "verification_status",
          "last_field_verified_at",
          "evidence_hash",
        ],
        pack.outOfStationTransferLinks ?? [],
        (row) => [
          requiredString(row.id, "outOfStationTransferLinks.id"),
          requiredString(row.fromStationId, "outOfStationTransferLinks.fromStationId"),
          requiredString(row.fromLineId, "outOfStationTransferLinks.fromLineId"),
          requiredString(row.toStationId, "outOfStationTransferLinks.toStationId"),
          requiredString(row.toLineId, "outOfStationTransferLinks.toLineId"),
          row.fromExitId ?? null,
          row.toExitId ?? null,
          row.durationSeconds ?? 0,
          row.distanceMeters ?? 0,
          boolFlag(row.bidirectional, "outOfStationTransferLinks.bidirectional"),
          boolFlag(row.requiresFareExit ?? true, "outOfStationTransferLinks.requiresFareExit"),
          boolFlag(row.requiresReentry ?? true, "outOfStationTransferLinks.requiresReentry"),
          row.coveredRoute ?? "UNKNOWN",
          row.crossingRisk ?? "UNKNOWN",
          row.slopeLevel ?? 1,
          row.curbCutStatus ?? "UNKNOWN",
          row.sidewalkStatus ?? "UNKNOWN",
          normalizedAccessibilityStatus(row.accessibilityStatus, "outOfStationTransferLinks.accessibilityStatus"),
          row.stairAccessState ?? "UNKNOWN",
          row.reliabilityScore ?? 100,
          row.sourceId ?? "",
          row.sourceSnapshotId ?? "",
          row.providerRecordHash ?? "",
          row.provenanceKind ?? "UNKNOWN",
          row.verificationStatus ?? "UNKNOWN",
          timestamp(row.lastFieldVerifiedAt ?? row.lastVerifiedAt),
          row.evidenceHash ?? "",
        ],
      );
      insertRows(
        database,
        "network_edges",
        [
          "id",
          "from_node_id",
          "to_node_id",
          "duration_seconds",
          "distance_meters",
          "edge_type",
          "service_pattern",
          "service_class",
          "includes_stairs",
          "stair_access_state",
          "accessibility_status",
          "reliability_score",
          "source_id",
          "source_snapshot_id",
          "provider_record_hash",
          "provenance_kind",
          "verification_status",
          "facility_id",
          "last_verified_at",
          "evidence_hash",
        ],
        networkEdges,
        (row) => {
          const stairAccessState = row.stairAccessState ?? (row.includesStairs ? "STAIR_ONLY" : "UNKNOWN");
          const accessibilityStatus = normalizedAccessibilityStatus(
            row.accessibilityStatus,
            "networkEdges.accessibilityStatus",
          );

          return [
            requiredString(row.id, "networkEdges.id"),
            requiredString(row.fromNodeId, "networkEdges.fromNodeId"),
            requiredString(row.toNodeId, "networkEdges.toNodeId"),
            row.durationSeconds ?? 0,
            row.distanceMeters ?? 0,
            row.edgeType ?? "WALKWAY",
            row.servicePattern ?? "",
            row.serviceClass ?? "SUBWAY",
            stairAccessState === "STAIR_ONLY" ? 1 : 0,
            stairAccessState,
            accessibilityStatus,
            row.reliabilityScore ?? 100,
            row.sourceId ?? "",
            row.sourceSnapshotId ?? "",
            row.providerRecordHash ?? "",
            row.provenanceKind ?? "UNKNOWN",
            row.verificationStatus ?? "UNKNOWN",
            row.facilityId ?? null,
            timestamp(row.verifiedAt ?? row.lastVerifiedAt),
            row.evidenceHash ?? "",
          ];
        },
      );
      insertRows(
        database,
        "route_map_positions",
        [
          "station_id",
          "line_id",
          "region",
          "x",
          "y",
          "label_dx",
          "label_dy",
          "label_polygon",
          "up_path",
          "down_path",
          "source_id",
          "source_name",
          "source_url",
          "license",
          "license_status",
          "commercial_use_allowed",
          "attribution_required",
          "reviewed_at",
          "updated_at",
        ],
        pack.routeMapPositions ?? [],
        (row) => [
          requiredString(row.stationId, "routeMapPositions.stationId"),
          requiredString(row.lineId, "routeMapPositions.lineId"),
          requiredString(row.region, "routeMapPositions.region"),
          requiredNonNegativeFiniteNumber(row.x, "routeMapPositions.x"),
          requiredNonNegativeFiniteNumber(row.y, "routeMapPositions.y"),
          row.labelDx ?? 0,
          row.labelDy ?? 0,
          canonicalLabelPolygon(row.labelPolygon, "routeMapPositions.labelPolygon"),
          row.upPath ?? "",
          row.downPath ?? "",
          requiredString(row.sourceId, "routeMapPositions.sourceId"),
          requiredString(row.sourceName, "routeMapPositions.sourceName"),
          requiredString(row.sourceUrl, "routeMapPositions.sourceUrl"),
          requiredString(row.license, "routeMapPositions.license"),
          requiredString(row.licenseStatus, "routeMapPositions.licenseStatus"),
          boolFlag(row.commercialUseAllowed, "routeMapPositions.commercialUseAllowed"),
          boolFlag(row.attributionRequired, "routeMapPositions.attributionRequired"),
          timestamp(row.reviewedAt),
          timestamp(row.updatedAt),
        ],
      );
      insertRows(
        database,
        "route_map_line_tracks",
        [
          "region",
          "line_id",
          "track_index",
          "path",
          "svg_color",
          "source_id",
          "source_name",
          "source_url",
          "license",
          "license_status",
          "commercial_use_allowed",
          "attribution_required",
          "updated_at",
        ],
        pack.routeMapLineTracks ?? [],
        (row) => [
          requiredString(row.region, "routeMapLineTracks.region"),
          requiredString(row.lineId, "routeMapLineTracks.lineId"),
          requiredNonNegativeInteger(row.trackIndex, "routeMapLineTracks.trackIndex"),
          requiredString(row.path, "routeMapLineTracks.path"),
          row.svgColor ?? "",
          requiredString(row.sourceId, "routeMapLineTracks.sourceId"),
          requiredString(row.sourceName, "routeMapLineTracks.sourceName"),
          requiredString(row.sourceUrl, "routeMapLineTracks.sourceUrl"),
          requiredString(row.license, "routeMapLineTracks.license"),
          requiredString(row.licenseStatus, "routeMapLineTracks.licenseStatus"),
          boolFlag(row.commercialUseAllowed, "routeMapLineTracks.commercialUseAllowed"),
          boolFlag(row.attributionRequired, "routeMapLineTracks.attributionRequired"),
          timestamp(row.updatedAt),
        ],
      );
      insertRows(
        database,
        "station_exits",
        [
          "id",
          "station_id",
          "exit_number",
          "description",
          "latitude",
          "longitude",
          "has_elevator_connection",
          "source_id",
          "source_snapshot_id",
          "data_source_type",
          "last_verified_at",
        ],
        pack.stationExits ?? [],
        (row) => [
          requiredString(row.id, "stationExits.id"),
          requiredString(row.stationId, "stationExits.stationId"),
          requiredString(row.exitNumber, "stationExits.exitNumber"),
          row.description ?? "",
          optionalLatitude(row.latitude, "stationExits.latitude"),
          optionalLongitude(row.longitude, "stationExits.longitude"),
          boolFlag(row.hasElevatorConnection, "stationExits.hasElevatorConnection"),
          row.sourceId ?? "",
          row.sourceSnapshotId ?? "",
          row.dataSourceType ?? "OFFICIAL_FILE",
          timestamp(row.lastVerifiedAt),
        ],
      );
      insertRows(
        database,
        "facilities",
        [
          "id",
          "station_id",
          "exit_id",
          "type",
          "name",
          "status",
          "floor_from",
          "floor_to",
          "description",
          "source_id",
          "source_snapshot_id",
          "provider_facility_ref",
          "provider_record_hash",
          "provenance_kind",
          "verified_at",
          "retrieved_at",
          "evidence_hash",
          "status_meaning",
          "operational_status",
          "installation_status",
          "confidence",
        ],
        pack.facilities ?? [],
        (row) => {
          const id = requiredString(row.id, "facilities.id");
          return [
            id,
            requiredString(row.stationId, "facilities.stationId"),
            row.exitId ?? null,
            requiredString(row.type, "facilities.type"),
            requiredString(row.name, "facilities.name"),
            row.status ?? "UNKNOWN",
            row.floorFrom ?? "",
            row.floorTo ?? "",
            row.description ?? "",
            productionFacilityString(row.sourceId, isProductionPack, "sourceId"),
            productionFacilityString(row.sourceSnapshotId, isProductionPack, "sourceSnapshotId"),
            productionFacilityString(row.providerFacilityRef, isProductionPack, "providerFacilityRef") || id,
            productionFacilityString(row.providerRecordHash, isProductionPack, "providerRecordHash"),
            productionFacilityString(row.provenanceKind, isProductionPack, "provenanceKind") || "UNKNOWN",
            productionFacilityTimestamp(row.verifiedAt ?? row.lastVerifiedAt, isProductionPack, "verifiedAt") ?? 0,
            productionFacilityTimestamp(row.retrievedAt, isProductionPack, "retrievedAt") ?? 0,
            productionFacilityString(row.evidenceHash, isProductionPack, "evidenceHash"),
            productionFacilityString(row.statusMeaning, isProductionPack, "statusMeaning"),
            facilityOperationalStatus(row, isProductionPack),
            facilityInstallationStatus(row, isProductionPack),
            row.confidence ?? 0,
          ];
        },
      );
      insertRows(
        database,
        "station_facility_evidence",
        [
          "station_id",
          "line_id",
          "facility_type",
          "evidence_kind",
          "source_id",
          "source_snapshot_id",
          "provider_record_hash",
          "evidence_hash",
          "provenance_kind",
          "installation_status",
          "operational_status",
          "status_meaning",
          "confidence",
          "verified_at",
          "retrieved_at",
          "strict_route_eligible",
          "strict_route_eligible_reason",
        ],
        pack.stationFacilityEvidence ?? [],
        (row) => [
          requiredString(row.stationId, "stationFacilityEvidence.stationId"),
          requiredString(row.lineId, "stationFacilityEvidence.lineId"),
          requiredString(row.facilityType, "stationFacilityEvidence.facilityType"),
          requiredString(row.evidenceKind, "stationFacilityEvidence.evidenceKind"),
          requiredString(row.sourceId, "stationFacilityEvidence.sourceId"),
          requiredString(row.sourceSnapshotId, "stationFacilityEvidence.sourceSnapshotId"),
          requiredString(row.providerRecordHash, "stationFacilityEvidence.providerRecordHash"),
          requiredString(row.evidenceHash, "stationFacilityEvidence.evidenceHash"),
          requiredString(row.provenanceKind, "stationFacilityEvidence.provenanceKind"),
          row.installationStatus ?? "UNKNOWN",
          row.operationalStatus ?? "UNKNOWN",
          row.statusMeaning ?? "",
          row.confidence ?? 0,
          timestamp(row.verifiedAt) ?? 0,
          timestamp(row.retrievedAt) ?? 0,
          boolFlag(row.strictRouteEligible, "stationFacilityEvidence.strictRouteEligible"),
          row.strictRouteEligibleReason ?? "",
        ],
      );
      insertRows(
        database,
        "station_accessibility_summaries",
        ["station_id", "summary", "warning"],
        pack.stationAccessibilitySummaries ?? [],
        (row) => [
          requiredString(row.stationId, "stationAccessibilitySummaries.stationId"),
          requiredString(row.summary, "stationAccessibilitySummaries.summary"),
          row.warning ?? "",
        ],
      );
      insertRows(database, "internal_route_nodes", ["id", "station_id", "label", "node_type"], pack.internalRouteNodes ?? [], (row) => [
        requiredString(row.id, "internalRouteNodes.id"),
        requiredString(row.stationId, "internalRouteNodes.stationId"),
        requiredString(row.label, "internalRouteNodes.label"),
        requiredString(row.nodeType, "internalRouteNodes.nodeType"),
      ]);
      insertRows(
        database,
        "internal_route_edges",
        [
          "id",
          "from_node_id",
          "to_node_id",
          "edge_type",
          "distance_meters",
          "duration_seconds",
          "includes_stairs",
          "requires_elevator",
          "requires_escalator",
          "slope_level",
          "width_level",
          "reliability_score",
          "accessibility_status",
          "source_id",
          "source_snapshot_id",
          "provider_record_hash",
          "provenance_kind",
          "verification_status",
          "facility_id",
          "last_verified_at",
          "evidence_hash",
          "instruction",
        ],
        pack.internalRouteEdges ?? [],
        (row) => [
          requiredString(row.id, "internalRouteEdges.id"),
          requiredString(row.fromNodeId, "internalRouteEdges.fromNodeId"),
          requiredString(row.toNodeId, "internalRouteEdges.toNodeId"),
          row.edgeType ?? "WALK",
          row.distanceMeters ?? 0,
          row.durationSeconds ?? 0,
          row.includesStairs ? 1 : 0,
          row.requiresElevator ? 1 : 0,
          row.requiresEscalator ? 1 : 0,
          row.slopeLevel ?? 1,
          row.widthLevel ?? 2,
          row.reliabilityScore ?? 100,
          normalizedAccessibilityStatus(row.accessibilityStatus, "internalRouteEdges.accessibilityStatus"),
          row.sourceId ?? "",
          row.sourceSnapshotId ?? "",
          row.providerRecordHash ?? "",
          row.provenanceKind ?? "UNKNOWN",
          row.verificationStatus ?? "UNKNOWN",
          row.facilityId ?? null,
          timestamp(row.verifiedAt ?? row.lastVerifiedAt) ?? 0,
          row.evidenceHash ?? "",
          row.instruction ?? "",
        ],
      );
      insertRows(
        database,
        "station_pathway_nodes",
        ["id", "station_id", "line_id", "node_type", "label", "level", "legacy_internal_route_node_id"],
        pack.stationPathwayNodes ?? [],
        (row) => [
          requiredString(row.id, "stationPathwayNodes.id"),
          requiredString(row.stationId, "stationPathwayNodes.stationId"),
          row.lineId ?? null,
          requiredString(row.nodeType, "stationPathwayNodes.nodeType"),
          requiredString(row.label, "stationPathwayNodes.label"),
          row.level ?? "",
          row.legacyInternalRouteNodeId ?? "",
        ],
      );
      insertRows(
        database,
        "station_pathway_edges",
        [
          "id",
          "from_node_id",
          "to_node_id",
          "edge_type",
          "duration_seconds",
          "distance_meters",
          "bidirectional",
          "includes_stairs",
          "requires_elevator",
          "requires_escalator",
          "level_from",
          "level_to",
          "requires_facility_id",
          "min_width_cm",
          "slope_percent",
          "vertical_meters",
          "reliability_score",
          "accessibility_status",
          "source_id",
          "source_snapshot_id",
          "provider_record_hash",
          "provenance_kind",
          "verification_status",
          "last_verified_at",
          "evidence_hash",
          "instruction",
          "legacy_internal_route_edge_id",
        ],
        pack.stationPathwayEdges ?? [],
        (row) => [
          requiredString(row.id, "stationPathwayEdges.id"),
          requiredString(row.fromNodeId, "stationPathwayEdges.fromNodeId"),
          requiredString(row.toNodeId, "stationPathwayEdges.toNodeId"),
          row.edgeType ?? "WALK",
          row.durationSeconds ?? 0,
          row.distanceMeters ?? 0,
          boolFlag(row.bidirectional, "stationPathwayEdges.bidirectional"),
          boolFlag(row.includesStairs, "stationPathwayEdges.includesStairs"),
          boolFlag(row.requiresElevator, "stationPathwayEdges.requiresElevator"),
          boolFlag(row.requiresEscalator, "stationPathwayEdges.requiresEscalator"),
          row.levelFrom ?? "",
          row.levelTo ?? "",
          row.requiresFacilityId ?? null,
          row.minWidthCm ?? null,
          row.slopePercent ?? null,
          row.verticalMeters ?? null,
          row.reliabilityScore ?? 100,
          normalizedAccessibilityStatus(row.accessibilityStatus, "stationPathwayEdges.accessibilityStatus"),
          row.sourceId ?? "",
          row.sourceSnapshotId ?? "",
          row.providerRecordHash ?? "",
          row.provenanceKind ?? "UNKNOWN",
          row.verificationStatus ?? "UNKNOWN",
          timestamp(row.verifiedAt ?? row.lastVerifiedAt) ?? 0,
          row.evidenceHash ?? "",
          row.instruction ?? "",
          row.legacyInternalRouteEdgeId ?? "",
        ],
      );
      insertRows(
        database,
        "transfer_rules",
        [
          "id",
          "from_station_id",
          "from_line_id",
          "to_station_id",
          "to_line_id",
          "transfer_type",
          "min_transfer_seconds",
          "pathway_edge_id",
          "strict_step_free_pathway_edge_id",
          "source_id",
          "verification_status",
        ],
        pack.transferRules ?? [],
        (row) => [
          requiredString(row.id, "transferRules.id"),
          requiredString(row.fromStationId, "transferRules.fromStationId"),
          requiredString(row.fromLineId, "transferRules.fromLineId"),
          requiredString(row.toStationId, "transferRules.toStationId"),
          requiredString(row.toLineId, "transferRules.toLineId"),
          row.transferType ?? "IN_STATION",
          row.minTransferSeconds ?? 0,
          row.pathwayEdgeId ?? null,
          row.strictStepFreePathwayEdgeId ?? null,
          row.sourceId ?? "",
          row.verificationStatus ?? "UNKNOWN",
        ],
      );
      insertRows(
        database,
        "station_car_door_hints",
        [
          "id",
          "station_id",
          "line_id",
          "direction",
          "target_facility_type",
          "car_number",
          "door_number",
          "source_id",
          "source_snapshot_id",
          "provider_record_hash",
          "provenance_kind",
          "verification_status",
          "last_verified_at",
          "evidence_hash",
        ],
        pack.stationCarDoorHints ?? [],
        (row) => {
          const provenanceKind =
            row.provenanceKind == null
              ? "UNKNOWN"
              : requiredString(row.provenanceKind, "stationCarDoorHints.provenanceKind");
          const isOfficial = provenanceKind === "OFFICIAL";
          return [
            requiredString(row.id, "stationCarDoorHints.id"),
            requiredString(row.stationId, "stationCarDoorHints.stationId"),
            requiredString(row.lineId, "stationCarDoorHints.lineId"),
            row.direction ?? "",
            requiredString(row.targetFacilityType, "stationCarDoorHints.targetFacilityType"),
            requiredInteger(row.carNumber, "stationCarDoorHints.carNumber"),
            requiredInteger(row.doorNumber, "stationCarDoorHints.doorNumber"),
            isOfficial ? requiredString(row.sourceId, "stationCarDoorHints.sourceId") : row.sourceId ?? "",
            isOfficial
              ? requiredString(row.sourceSnapshotId, "stationCarDoorHints.sourceSnapshotId")
              : row.sourceSnapshotId ?? "",
            isOfficial
              ? requiredString(row.providerRecordHash, "stationCarDoorHints.providerRecordHash")
              : row.providerRecordHash ?? "",
            provenanceKind,
            row.verificationStatus ?? "UNKNOWN",
            timestamp(row.verifiedAt ?? row.lastVerifiedAt) ?? 0,
            row.evidenceHash ?? "",
          ];
        },
      );
      insertRows(
        database,
        "data_quality_records",
        ["id", "target_type", "target_id", "quality_level", "checked_at"],
        pack.dataQualityRecords ?? [],
        (row) => [
          requiredString(row.id, "dataQualityRecords.id"),
          requiredString(row.targetType, "dataQualityRecords.targetType"),
          requiredString(row.targetId, "dataQualityRecords.targetId"),
          requiredString(row.qualityLevel, "dataQualityRecords.qualityLevel"),
          timestamp(row.checkedAt),
        ],
      );
      database.exec("COMMIT");
      // ponytail: ANALYZE/optimize statistics differ across SQLite builds; the release artifact must not embed them.
      database.exec("VACUUM");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function productionFacilityString(value, isProductionPack, field) {
  if (!isProductionPack) {
    return value ?? "";
  }
  return requiredString(value, `production facilities.${field}`);
}

function productionFacilityTimestamp(value, isProductionPack, field) {
  if (!isProductionPack) {
    return timestamp(value);
  }
  return timestamp(requiredString(value, `production facilities.${field}`));
}

function facilityOperationalStatus(row, isProductionPack) {
  if (isProductionPack) {
    return productionFacilityString(row.operationalStatus, isProductionPack, "operationalStatus");
  }
  if (row.operationalStatus) {
    return row.operationalStatus;
  }
  const status = String(row.status ?? "").toUpperCase();
  if (["NORMAL", "AVAILABLE", "IN_SERVICE", "OPERATING", "OPEN", "ADMIN_VERIFIED"].includes(status)) {
    return "AVAILABLE";
  }
  if (["BROKEN", "UNDER_CONSTRUCTION", "CLOSED", "UNAVAILABLE", "OUT_OF_SERVICE"].includes(status)) {
    return "UNAVAILABLE";
  }
  return "";
}

function facilityInstallationStatus(row, isProductionPack) {
  if (isProductionPack) {
    return productionFacilityString(row.installationStatus, isProductionPack, "installationStatus");
  }
  return row.installationStatus ?? "UNKNOWN";
}

function insertCatalogMetadata(database, pack) {
  const rows = [
    ["schemaVersion", pack.schemaVersion],
    ...Object.entries(pack.metadata ?? {}),
  ];
  const statement = database.prepare("INSERT INTO catalog_metadata (key, value, updated_at) VALUES (?, ?, ?)");
  const updatedAt = Date.UTC(2026, 5, 19) / 1000;
  for (const [key, value] of rows) {
    statement.run(key, String(value), updatedAt);
  }
}

function insertRows(database, table, columns, rows, mapRow) {
  const statement = database.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of rows ?? []) {
    statement.run(...mapRow(row));
  }
}

function validateFixture(fixture) {
  if (!fixture || typeof fixture !== "object") {
    throw new Error("fixture must be an object");
  }
  if (!fixture.manifest || typeof fixture.manifest !== "object" || Array.isArray(fixture.manifest)) {
    throw new Error("fixture manifest must be an object");
  }
  if (
    fixture.manifest.manifestVersion !== undefined &&
    fixture.manifest.manifestVersion !== 1 &&
    fixture.manifest.manifestVersion !== 2
  ) {
    throw new Error("manifest.manifestVersion must be 1 or 2");
  }
  if (!Number.isInteger(fixture.manifest?.ttlSeconds) || fixture.manifest.ttlSeconds <= 0) {
    throw new Error("manifest ttlSeconds must be a positive integer");
  }
  if (!Array.isArray(fixture.packs) || fixture.packs.length === 0) {
    throw new Error("fixture packs must be a non-empty array");
  }
  validateCoverageLineOperatorScopes(fixture.coverageLineOperatorScopes, fixture.packs);
  for (const pack of fixture.packs) {
    validateCoverageLineOperatorScopes(pack.coverageLineOperatorScopes, [pack]);
  }
  validateCoverageLineOperatorScopeAlignment(fixture);
  const packIdentities = new Set(
    fixture.packs.map((pack) => `${pack.id ?? ""}@${pack.version ?? ""}`),
  );
  if (fixture.manifest.activePack !== undefined) {
    validatePackIdentity(fixture.manifest.activePack, "manifest.activePack");
    const activePackIdentity = `${fixture.manifest.activePack.id}@${fixture.manifest.activePack.version}`;
    if (!packIdentities.has(activePackIdentity)) {
      throw new Error("manifest.activePack must match one of fixture packs");
    }
  }
  if (fixture.manifest.emergencyOverride !== undefined) {
    validatePackIdentity(fixture.manifest.emergencyOverride, "manifest.emergencyOverride");
    requiredString(fixture.manifest.emergencyOverride.reason, "manifest.emergencyOverride.reason");
  }
  for (const pack of fixture.packs) {
    validatePackIdentity(pack, "pack");
    validateRouteServiceAdmission(pack);
    const artifactKind = pack.artifactKind ?? "fixture";
    if (artifactKind !== "fixture" && artifactKind !== "production") {
      throw new Error("pack.artifactKind must be fixture or production");
    }
    schemaVersionNumber(pack.schemaVersion, "pack.schemaVersion");
    const validatedPackUrl = pack.url ?? stagedPackPath(pack);
    requiredString(validatedPackUrl, "pack.url");
    validatePackUrl(validatedPackUrl, "pack.url");
    validatePackUrlMatchesStagedPath(validatedPackUrl, pack, "pack.url");
    if (artifactKind === "production" && !isAbsoluteHttpsWithHost(pack.url)) {
      throw new Error("production pack url must be an absolute HTTPS URL");
    }
    if (artifactKind === "production" && usesLocalPlaceholderHost(pack.url)) {
      throw new Error("production pack url must not use a local placeholder host");
    }
    validateSourceInventory(pack.sourceInventory, artifactKind);
    if (pack.routeRegressionScope !== undefined) {
      validateRouteRegressionScope(pack.routeRegressionScope);
    }
    validateRepresentativeRouteRegressions(pack.representativeRouteRegressions, pack.routeRegressionScope);
    if (!Array.isArray(pack.requiredTables) || pack.requiredTables.length === 0) {
      throw new Error(`${pack.id} requiredTables must be a non-empty array`);
    }
    validateMinimumTableRows(pack, artifactKind);
  }
}

function validateRouteServiceAdmission(pack) {
  const evidenceRows = (pack.routeServiceArtifactEvidence ?? [])
    .filter(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN");
  if (evidenceRows.length > 1) {
    throw new Error("pack must contain exactly one ITX_CHEONGCHUN evidence row");
  }
  const evidence = evidenceRows[0];
  const itxRowCount = [
    ...(pack.transitTrips ?? []),
    ...(pack.networkEdges ?? []),
  ].filter(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN").length;
  if (evidence?.admissionStatus === "ADMITTED" && itxRowCount === 0) {
    throw new Error("ADMITTED evidence requires ITX_CHEONGCHUN rows");
  }
  if (itxRowCount > 0 && (evidence?.admissionStatus !== "ADMITTED" || evidence?.admissionEligible !== true)) {
    throw new Error("ITX_CHEONGCHUN rows require ADMITTED evidence");
  }
  if (itxRowCount > 0 && !validatedItxAdmissionPacks.has(pack)) {
    throw new Error("ITX_CHEONGCHUN rows require a validated admission artifact materializer");
  }
}

function validateCoverageLineOperatorScopes(scopes, packs) {
  if (scopes === undefined) {
    return;
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("coverageLineOperatorScopes must be a non-empty array");
  }
  const lineIds = new Set(packs.flatMap((pack) => (pack.lines ?? []).map((line) => line.id)));
  const operatorIds = new Set(packs.flatMap((pack) => (pack.operators ?? []).map((operator) => operator.id)));
  const keys = new Set();
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      throw new Error("coverageLineOperatorScopes[] must be an object");
    }
    const regionId = requiredString(scope.regionId, "coverageLineOperatorScopes[].regionId");
    const operatorId = requiredString(scope.operatorId, "coverageLineOperatorScopes[].operatorId");
    const lineId = requiredString(scope.lineId, "coverageLineOperatorScopes[].lineId");
    if (!operatorIds.has(operatorId)) {
      throw new Error(`coverageLineOperatorScopes contains undefined operator: ${operatorId}`);
    }
    if (!lineIds.has(lineId)) {
      throw new Error(`coverageLineOperatorScopes contains undefined line: ${lineId}`);
    }
    const key = `${regionId}:${operatorId}:${lineId}`;
    if (keys.has(key)) {
      throw new Error(`duplicate coverageLineOperatorScope: ${key}`);
    }
    keys.add(key);
  }
}

function validateCoverageLineOperatorScopeAlignment(fixture) {
  if (fixture.coverageLineOperatorScopes === undefined) {
    if (fixture.coverageLineOperatorScopeSemantics !== undefined) {
      throw new Error("coverageLineOperatorScopeSemantics requires top-level coverageLineOperatorScopes");
    }
    return;
  }
  if (fixture.coverageLineOperatorScopeSemantics !== "UNION_OF_PACK_SCOPES") {
    throw new Error("top-level coverageLineOperatorScopes must declare UNION_OF_PACK_SCOPES semantics");
  }
  const fixtureKeys = [...new Set(
    fixture.coverageLineOperatorScopes
      .map(({ regionId, operatorId, lineId }) => `${regionId}:${operatorId}:${lineId}`),
  )].sort(compareStrings);
  const packKeys = [...new Set(
    fixture.packs
      .flatMap((pack) => pack.coverageLineOperatorScopes ?? [])
      .map(({ regionId, operatorId, lineId }) => `${regionId}:${operatorId}:${lineId}`),
  )].sort(compareStrings);
  if (JSON.stringify(fixtureKeys) !== JSON.stringify(packKeys)) {
    throw new Error("fixture coverageLineOperatorScopes must equal the union of pack coverageLineOperatorScopes");
  }
}

function validateMinimumTableRows(pack, artifactKind) {
  if (pack.minimumTableRows !== undefined) {
    if (!pack.minimumTableRows || typeof pack.minimumTableRows !== "object" || Array.isArray(pack.minimumTableRows)) {
      throw new Error(`${pack.id} minimumTableRows must be an object`);
    }
    for (const [tableName, minimumRows] of Object.entries(pack.minimumTableRows)) {
      validateTableName(tableName);
      if (!Number.isInteger(minimumRows) || minimumRows < 0) {
        throw new Error(`${pack.id} minimumTableRows entry must be a non-negative integer`);
      }
    }
  }
  if (artifactKind !== "production") {
    return;
  }
  if (!hasProductionMinimumTableRows(pack.minimumTableRows)) {
    throw new Error(
      "production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence",
    );
  }
  const actualRowsByTable = {
    stations: pack.stations?.length ?? 0,
    station_lines: pack.stationLines?.length ?? 0,
    network_edges: routeGraphNetworkEdges(pack).length,
    facilities: pack.facilities?.length ?? 0,
    station_facility_evidence: pack.stationFacilityEvidence?.length ?? 0,
  };
  for (const tableName of productionMinimumTableRowNames) {
    if (actualRowsByTable[tableName] < pack.minimumTableRows[tableName]) {
      throw new Error(
        `production ${tableName} rows ${actualRowsByTable[tableName]} are below minimumTableRows ${pack.minimumTableRows[tableName]}`,
      );
    }
  }
}

function hasProductionMinimumTableRows(minimumTableRows) {
  return (
    minimumTableRows &&
    typeof minimumTableRows === "object" &&
    !Array.isArray(minimumTableRows) &&
    productionMinimumTableRowNames.every((tableName) => Number.isInteger(minimumTableRows[tableName]) && minimumTableRows[tableName] > 0)
  );
}

function validateTableName(value) {
  const tableName = requiredString(value, "tableName");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`invalid table name: ${tableName}`);
  }
}

function validateRepresentativeRouteRegressions(routes, scope = null) {
  const requiredPatterns =
    !scope && Array.isArray(routes) && routes.length === 0
      ? new Set()
      : requiredRepresentativeRoutePatterns(scope);
  if (!Array.isArray(routes) || (requiredPatterns.size > 0 && routes.length === 0)) {
    throw new Error("pack.representativeRouteRegressions must be a non-empty array");
  }
  const seenPatterns = new Set();
  for (const route of routes) {
    requiredString(route.id, "representativeRouteRegressions.id");
    const pattern = requiredString(route.pattern, "representativeRouteRegressions.pattern");
    if (!requiredPatterns.has(pattern)) {
      throw new Error("representativeRouteRegressions.pattern is invalid");
    }
    seenPatterns.add(pattern);
    requiredString(route.fromNodeId, "representativeRouteRegressions.fromNodeId");
    requiredString(route.toNodeId, "representativeRouteRegressions.toNodeId");
    if (!Array.isArray(route.requiredEdgeIds) || route.requiredEdgeIds.length === 0) {
      throw new Error("representativeRouteRegressions.requiredEdgeIds must be a non-empty array");
    }
    for (const edgeId of route.requiredEdgeIds) {
      requiredString(edgeId, "representativeRouteRegressions.requiredEdgeIds");
    }
  }
  for (const pattern of requiredPatterns) {
    if (!seenPatterns.has(pattern)) {
      throw new Error(`representativeRouteRegressions missing required pattern: ${pattern}`);
    }
  }
}

function validateRouteRegressionScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("routeRegressionScope must be an object");
  }
  const mode = requiredString(scope.mode, "routeRegressionScope.mode");
  if (mode !== "DIRECT_ONLY") {
    throw new Error("routeRegressionScope.mode is invalid");
  }
  if (!Array.isArray(scope.excludedPatterns)) {
    throw new Error("routeRegressionScope.excludedPatterns must be an array");
  }
  for (const pattern of scope.excludedPatterns) {
    requiredString(pattern, "routeRegressionScope.excludedPatterns");
  }
  requiredString(scope.claim, "routeRegressionScope.claim");
}

function requiredRepresentativeRoutePatterns(scope = null) {
  if (scope?.mode === "DIRECT_ONLY") {
    return new Set(["DIRECT"]);
  }
  return new Set(["DIRECT", "TRANSFER", "MULTI_TRANSFER", "LOOP_BRANCH", "EXPRESS_LOCAL"]);
}

function validateSourceInventory(sourceInventory, artifactKind) {
  if (!Array.isArray(sourceInventory) || sourceInventory.length === 0) {
    throw new Error("pack.sourceInventory must be a non-empty array");
  }
  for (const source of sourceInventory) {
    requiredString(source.id, "sourceInventory.id");
    requiredString(source.owner, "sourceInventory.owner");
    requiredString(source.url, "sourceInventory.url");
    requiredString(source.license, "sourceInventory.license");
    const licenseStatus = requiredString(source.licenseStatus, "sourceInventory.licenseStatus");
    if (typeof source.redistributionAllowed !== "boolean") {
      throw new Error("sourceInventory.redistributionAllowed must be a boolean");
    }
    requiredString(source.updateFrequency, "sourceInventory.updateFrequency");
    requiredString(source.updatedAt, "sourceInventory.updatedAt");
    if (!Array.isArray(source.fields) || source.fields.length === 0) {
      throw new Error("sourceInventory.fields must be a non-empty array");
    }
    for (const field of source.fields) {
      requiredString(field, "sourceInventory.fields");
    }
    if (artifactKind === "production" || source.coverageScope !== undefined) {
      validateSourceInventoryCoverageScope(
        source.coverageScope,
        artifactKind === "production" ? "production sourceInventory.coverageScope" : "sourceInventory.coverageScope",
      );
    }
    if (artifactKind === "production") {
      if (licenseStatus !== "redistributable" || source.redistributionAllowed !== true) {
        throw new Error("production sourceInventory must be redistributable");
      }
      if (!isAbsoluteHttpsWithHost(source.url)) {
        throw new Error("production sourceInventory.url must be HTTPS");
      }
      if (usesLocalPlaceholderHost(source.url)) {
        throw new Error("production sourceInventory.url must not use a local placeholder host");
      }
    }
  }
}

function validateSourceInventoryCoverageScope(coverageScope, label) {
  if (!coverageScope || typeof coverageScope !== "object" || Array.isArray(coverageScope)) {
    throw new Error(`${label} must be an object`);
  }
  requiredStringArray(coverageScope.regionIds, `${label}.regionIds`);
  requiredStringArray(coverageScope.operatorIds, `${label}.operatorIds`);
  requiredStringArray(coverageScope.sourceDomains, `${label}.sourceDomains`);
  if (coverageScope.lineIds !== undefined) {
    const lineIds = requiredStringArray(coverageScope.lineIds, `${label}.lineIds`);
    if (new Set(lineIds).size !== lineIds.length) {
      throw new Error(`${label}.lineIds must not contain duplicates`);
    }
  }
}

function isAbsoluteHttpsWithHost(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${key ?? ""}`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function requireArg(args, name) {
  if (!args[name]) {
    throw new Error(`--${name} is required`);
  }
  return args[name];
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function sha256HexString(value, label) {
  const text = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/i.test(text)) {
    throw new Error(`${label} must be a sha256 hex string`);
  }
  return text.toLowerCase();
}

function requiredUtcDateString(value, label) {
  const rawValue = requiredString(value, label);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(rawValue)) {
    throw new Error(`${label} must include timezone offset`);
  }
  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be an ISO date-time`);
  }
  return rawValue;
}

function optionalUtcDateString(value, label) {
  return value === undefined ? null : requiredUtcDateString(value, label);
}

function optionalPositiveInteger(value, label) {
  return value === undefined ? null : requiredPositiveInteger(value, label);
}

function buildPublishedAt() {
  return new Date().toISOString();
}

function buildExpiresAt(rawPublishedAt) {
  const publishedAt = new Date(rawPublishedAt ?? buildPublishedAt());
  return new Date(publishedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

function defaultReleaseSequence() {
  const runNumber = Number(process.env.GITHUB_RUN_NUMBER);
  return Number.isInteger(runNumber) && runNumber > 0 ? runNumber : 1;
}

function requiredStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value.map((entry) => requiredString(entry, `${label}[]`));
}

function normalizedAccessibilityStatus(value, label) {
  return requiredString(value ?? "UNKNOWN", label).toUpperCase();
}

function requiredInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  const integer = requiredInteger(value, label);
  if (integer <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return integer;
}

function requiredNonNegativeInteger(value, label) {
  const integer = requiredInteger(value, label);
  if (integer < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return integer;
}

function officialOdFareQuoteValues(row, admission) {
  const label = "officialOdFareQuotes";
  const keys = [
    "originStationId",
    "destinationStationId",
    "sourceId",
    "snapshotId",
    "mappingLedgerHash",
    "gnrlCardFare",
    "gnrlCashFare",
    "yungCardFare",
    "yungCashFare",
    "childCardFare",
    "childCashFare",
  ];
  assertExactKeys(row, keys, label);
  if (admission?.decision !== "APPROVED") {
    throw new Error(`${label} requires an approved admission`);
  }
  const originStationId = requiredString(row.originStationId, `${label}.originStationId`);
  const destinationStationId = requiredString(row.destinationStationId, `${label}.destinationStationId`);
  if (originStationId === destinationStationId) {
    throw new Error(`${label} endpoints must be distinct`);
  }
  const sourceId = requiredString(row.sourceId, `${label}.sourceId`);
  const snapshotId = requiredString(row.snapshotId, `${label}.snapshotId`);
  const mappingLedgerHash = sha256HexString(row.mappingLedgerHash, `${label}.mappingLedgerHash`);
  if (sourceId !== admission.sourceId) throw new Error(`${label}.sourceId must match admission`);
  if (snapshotId !== admission.snapshotId) throw new Error(`${label}.snapshotId must match admission`);
  if (mappingLedgerHash !== admission.fareStationLineMappingLedgerHash) {
    throw new Error(`${label}.mappingLedgerHash must match admission`);
  }
  return [
    originStationId,
    destinationStationId,
    sourceId,
    snapshotId,
    mappingLedgerHash,
    requiredNonNegativeSafeInteger(row.gnrlCardFare, `${label}.gnrlCardFare`),
    requiredNonNegativeSafeInteger(row.gnrlCashFare, `${label}.gnrlCashFare`),
    requiredNonNegativeSafeInteger(row.yungCardFare, `${label}.yungCardFare`),
    requiredNonNegativeSafeInteger(row.yungCashFare, `${label}.yungCashFare`),
    requiredNonNegativeSafeInteger(row.childCardFare, `${label}.childCardFare`),
    requiredNonNegativeSafeInteger(row.childCashFare, `${label}.childCashFare`),
  ];
}

function requiredNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
  for (const key of expected) {
    if (!(key in value)) throw new Error(`${label}.${key} is required`);
  }
}

function optionalNonNegativeInteger(value, label) {
  return value === undefined || value === null ? null : requiredNonNegativeInteger(value, label);
}

function canonicalFareAdditionalSteps(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return JSON.stringify(
    value.map((step, index) => {
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        throw new Error(`${label}[${index}] must be an object`);
      }
      return {
        distanceMeters: requiredPositiveInteger(step.distanceMeters, `${label}[${index}].distanceMeters`),
        cardFare: requiredNonNegativeInteger(step.cardFare, `${label}[${index}].cardFare`),
        cashFare: requiredNonNegativeInteger(step.cashFare, `${label}[${index}].cashFare`),
      };
    }),
  );
}

function canonicalLabelPolygon(value, label) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(`${label} must be a polygon with at least three points`);
  }
  const polygon = value.map((point, index) => {
    if (!point || typeof point !== "object" || Array.isArray(point)) {
      throw new Error(`${label}[${index}] must be an object point`);
    }
    return {
      x: requiredNonNegativeFiniteNumber(point.x, `${label}[${index}].x`),
      y: requiredNonNegativeFiniteNumber(point.y, `${label}[${index}].y`),
    };
  });
  return JSON.stringify(polygon);
}

function requiredNonNegativeFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  if (value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return Math.round(value * 1000) / 1000;
}

function optionalLatitude(value, label) {
  return optionalCoordinate(value, label, -90, 90);
}

function optionalLongitude(value, label) {
  return optionalCoordinate(value, label, -180, 180);
}

function optionalCoordinate(value, label, min, max) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return Math.round(value * 1000000) / 1000000;
}

function serviceDate(value, label) {
  const text = requiredString(value, label);
  if (!/^\d{8}$/.test(text)) {
    throw new Error(`${label} must be YYYYMMDD`);
  }
  return text;
}

function schemaVersionNumber(value, label) {
  const version = Number(requiredString(value, label));
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(`${label} must be a positive integer string`);
  }
  return version;
}

function boolFlag(value, label) {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value ? 1 : 0;
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return Math.floor(millis / 1000);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
