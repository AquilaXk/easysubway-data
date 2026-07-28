import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

import { buildServerTimetableSnapshot } from "./build-server-timetable-snapshot.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const baselinePath = path.join(
  root,
  "backend/src/main/resources/timetable/line4-subway-timetable-seed.sql.gz",
);
const contractPath = path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json");
const canonicalPackPath = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");
const topologyEvidencePath = path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json");
const subwayRosterPath = path.join(root, "tools/datapack/sources/kric-line4-route-roster-20260706.json");
const reviewedPackPath = path.join(root, "tools/datapack/release/capital-production-reviewed-pack.json");
const sourceSnapshotsPath = path.join(root, "tools/datapack/release/source-snapshots.json");
const buildNow = new Date("2026-07-16T00:00:00.000Z");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function inputs({ withTopologyEvidence = false } = {}) {
  const baselineGzipBytes = await readFile(baselinePath);
  const contractBytes = await readFile(contractPath);
  const contract = JSON.parse(contractBytes);
  const sourceBytes = await readFile(path.join(root, contract.sourceTimetableArtifact.artifactPath));
  const completenessBytes = await readFile(path.join(
    root,
    contract.sourceTimetableArtifact.completenessEvidencePath,
  ));
  const canonicalPackGzipBytes = await readFile(canonicalPackPath);
  const readmissionEvidenceBytes = await readFile(topologyEvidencePath);
  const topologyEvidenceBytes = withTopologyEvidence ? readmissionEvidenceBytes : null;
  const subwayRosterBytes = await readFile(subwayRosterPath);
  const reviewedPackBytes = await readFile(reviewedPackPath);
  const sourceSnapshotsBytes = await readFile(sourceSnapshotsPath);
  return {
    baselineGzipBytes,
    contractBytes,
    sourceBytes,
    completenessBytes,
    canonicalPackGzipBytes,
    topologyEvidenceBytes,
    readmissionEvidenceBytes,
    subwayRosterBytes,
    reviewedPackBytes,
    sourceSnapshotsBytes,
  };
}

test("snapshot builder의 모든 sort는 type-safe comparator를 명시한다", async () => {
  const source = await readFile(
    path.join(root, "tools/datapack/build-server-timetable-snapshot.mjs"),
    "utf8",
  );

  assert.doesNotMatch(source, /\.sort\(\)/);
});

test("#2135 ADMITTED source와 subway seed를 deterministic complete server snapshot으로 만든다", async () => {
  const value = await inputs();
  const first = buildServerTimetableSnapshot({ ...value, buildNow });
  const second = buildServerTimetableSnapshot({ ...value, buildNow });
  const contract = JSON.parse(value.contractBytes);
  const source = JSON.parse(value.sourceBytes);

  assert.deepEqual(second, first);
  assert.equal(gunzipSync(first.gzipBytes).toString("utf8"), first.sql);
  assert.equal(first.evidence.snapshotSha256, sha256(Buffer.from(first.sql)));
  assert.equal(first.evidence.sourceArtifact.id, contract.sourceTimetableArtifact.artifactId);
  assert.equal(first.evidence.sourceArtifact.sha256, sha256(value.sourceBytes));
  assert.equal(first.evidence.sourceArtifact.completenessEvidenceSha256, sha256(value.completenessBytes));
  assert.equal(first.evidence.freshUntil, source.freshUntil);
  assert.deepEqual(first.evidence.canonicalPackIdentity, {
    id: "capital",
    sha256: sha256(value.canonicalPackGzipBytes),
    sqliteSha256: sha256(gunzipSync(value.canonicalPackGzipBytes)),
  });
  assert.deepEqual(first.evidence.canonicalPackLineage, {
    provenance: "tracked-readmission-chain",
    admittedInputSha256: contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sha256,
    admittedInputSqliteSha256:
      contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256,
    readmissionCount: 14,
  });
  assert.deepEqual(first.evidence.serviceIdentity, {
    serviceId: "ITX_CHEONGCHUN",
    canonicalLineId: contract.canonicalLineId,
    servicePattern: "EXPRESS",
    timezone: "Asia/Seoul",
  });
  assert.equal(first.evidence.rowCounts.itxTrips, source.transitTrips.length);
  assert.equal(first.evidence.rowCounts.itxStopTimes, source.transitStopTimes.length);
  assert.ok(first.evidence.rowCounts.officialFares > 0);
  assert.match(
    first.sql,
    /UPDATE transit_trips SET train_no = '2002' WHERE id = 'route-line-54a7b980b7c3-down-2002-8';/,
  );
  assert.match(
    first.sql,
    /UPDATE transit_trips SET train_no = '4227' WHERE id = 'route-seoul-4-up-4227-8';/,
  );
  assert.match(
    first.sql,
    /UPDATE transit_trips SET train_no = '4123' WHERE id = 'route-seoul-4-up-S4123-8';/,
  );
  assert.match(
    first.sql,
    /INSERT INTO transit_trip_official_fares \([^\n]+\) VALUES \('route-line-54a7b980b7c3-[^']+-\d+-8', '[^']+', '[^']+', \d+, 'KRW', 'tago-train-schedule-fares', 'itx-cheongchun-source-timetable-[^']+'\);/,
  );
  assert.match(
    first.sql,
    /INSERT INTO transit_trip_official_fares \([^\n]+\) VALUES \('[^']+', 'station-sangnoksu', 'station-sadang', \d+, 'KRW', 'seoul-metro-official-od-fares', '[^']+'\);/,
  );
  assert.ok(first.evidence.rowCounts.subwayTrips > 0);
  assert.ok(first.evidence.rowCounts.subwayStopTimes > first.evidence.rowCounts.subwayTrips);
  assert.equal(first.evidence.rowCounts.stationPathwayNodes, 4);
  assert.equal(first.evidence.rowCounts.stationPathwayEdges, 4);
  assert.equal(first.evidence.rowCounts.transferRules, 0);
  assert.equal(first.evidence.rowCounts.routeEdgeEvidence, 4);
  assert.equal((first.sql.match(/INSERT INTO station_pathway_nodes/g) ?? []).length, 4);
  assert.equal((first.sql.match(/INSERT INTO station_pathway_edges/g) ?? []).length, 4);
  assert.equal((first.sql.match(/INSERT INTO transfer_rules/g) ?? []).length, 0);
  assert.equal((first.sql.match(/INSERT INTO route_edge_evidence/g) ?? []).length, 4);
  assert.match(first.sql, /'ITX_CHEONGCHUN'/);
  assert.match(first.sql, /, 2135\);/);
  assert.equal((first.sql.match(/INSERT INTO transit_feed_info/g) ?? []).length, 1);
  assert.equal((first.sql.match(/VALUES \('weekday-kric'/g) ?? []).length, 1);
  assert.equal((first.sql.match(/VALUES \('holiday-kric'/g) ?? []).length, 1);
  assert.match(first.sql, /VALUES \('itx-cheongchun-weekday-kric', '20260727', '20260802', 'Asia\/Seoul', TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE\)/);
  assert.match(first.sql, /VALUES \('itx-cheongchun-saturday-kric', '20260727', '20260802', 'Asia\/Seoul', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, FALSE\)/);
  assert.match(first.sql, /VALUES \('itx-cheongchun-holiday-kric', '20260727', '20260802', 'Asia\/Seoul', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE\)/);
  for (const [sourceServiceId, namespacedServiceId] of [
    ["weekday-kric", "itx-cheongchun-weekday-kric"],
    ["saturday-kric", "itx-cheongchun-saturday-kric"],
    ["holiday-kric", "itx-cheongchun-holiday-kric"],
  ]) {
    const expectedTrips = source.transitTrips.filter(({ serviceId }) => serviceId === sourceServiceId).length;
    assert.equal(
      (first.sql.match(new RegExp(`INSERT INTO transit_trips \\([^\\n]+, '${namespacedServiceId}',`, "g")) ?? []).length,
      expectedTrips,
    );
  }
  assert.doesNotMatch(first.sql, /'station-seoul-4-/);
  assert.match(first.sql, /'station-sadang'/);
  assert.match(first.sql, /'station-sangnoksu'/);
  const localPattern = first.evidence.servicePatternEvidence.representativeLocal;
  const expressPattern = first.evidence.servicePatternEvidence.representativeExpress;
  assert.ok(localPattern.stopStationIds.length > 1);
  assert.deepEqual(localPattern.passThroughStationIds, []);
  assert.ok(expressPattern.stopStationIds.length > 1);
  assert.ok(expressPattern.passThroughStationIds.length > 0);
  assert.ok(expressPattern.passThroughStationIds.every(
    (stationId) => !expressPattern.stopStationIds.includes(stationId),
  ));
  assert.ok(first.evidence.servicePatternEvidence.localTripCount > 0);
  assert.ok(first.evidence.servicePatternEvidence.expressTripCount > 0);
});

test("접근성 source snapshot의 lineage와 governance 값을 그대로 materialize한다", async () => {
  const value = await inputs();
  const reviewedPack = JSON.parse(value.reviewedPackBytes);
  const snapshots = JSON.parse(value.sourceSnapshotsBytes);
  const parent = snapshots.find(
    ({ snapshotId }) => snapshotId === "seoul-metro-accessibility-capital-admission-20260712",
  );
  const child = {
    ...parent,
    snapshotId: "seoul-metro-accessibility-capital-admission-20260713",
    retrievedAt: "2026-07-13T00:00:00Z",
    sourceUpdatedAt: null,
    rowCount: 9,
    coverageCount: 2,
    previousSnapshotId: parent.snapshotId,
    diffSummary: { status: "CHANGED", rowDelta: 8, coverageDelta: 1 },
    governancePolicyVersion: "2026-07-15",
    governancePolicySha256: "a".repeat(64),
  };
  for (const pack of reviewedPack.packs) {
    for (const edge of pack.networkEdges ?? []) {
      if (["ENTRY", "EXIT"].includes(edge.edgeType) && edge.sourceSnapshotId === parent.snapshotId) {
        edge.sourceSnapshotId = child.snapshotId;
      }
    }
  }

  const result = buildServerTimetableSnapshot({
    ...value,
    reviewedPackBytes: Buffer.from(JSON.stringify(reviewedPack)),
    sourceSnapshotsBytes: Buffer.from(JSON.stringify([...snapshots, child])),
    buildNow,
  });
  const parentOffset = result.sql.indexOf(`SELECT '${parent.snapshotId}'`);
  const childStatement = result.sql.split("\n")
    .find((line) => line.includes(`SELECT '${child.snapshotId}'`));

  assert.ok(parentOffset >= 0);
  assert.ok(childStatement);
  assert.ok(parentOffset < result.sql.indexOf(childStatement));
  assert.match(childStatement, /, NULL, NULL, NULL, 9, 2, /);
  assert.match(childStatement, new RegExp(`, '${parent.snapshotId}', 'CHANGED', `));
  assert.match(childStatement, /'\{"status":"CHANGED","rowDelta":8,"coverageDelta":1\}'/);
  assert.match(childStatement, /, '2026-07-15', 'a{64}' WHERE/);
  const parentStatement = result.sql.split("\n")
    .find((line) => line.includes(`SELECT '${parent.snapshotId}'`));
  assert.match(parentStatement, /, '2026-07-15', '[a-f0-9]{64}' WHERE/);
});

test("접근성 evidence identity는 실제 materialization 입력에만 결합한다", async () => {
  const value = await inputs();
  const baseline = buildServerTimetableSnapshot({ ...value, buildNow });
  const reviewedPack = JSON.parse(value.reviewedPackBytes);
  reviewedPack.unrelatedMetadata = "changed";
  const snapshots = JSON.parse(value.sourceSnapshotsBytes);
  snapshots.push({ snapshotId: "unrelated-snapshot" });

  const unrelatedChange = buildServerTimetableSnapshot({
    ...value,
    reviewedPackBytes: Buffer.from(JSON.stringify(reviewedPack)),
    sourceSnapshotsBytes: Buffer.from(JSON.stringify(snapshots)),
    buildNow,
  });

  assert.equal(unrelatedChange.sql, baseline.sql);
  assert.deepEqual(unrelatedChange.evidence, baseline.evidence);
  const accessSql = baseline.sql.slice(baseline.sql.indexOf("INSERT INTO data_source_snapshots"));
  assert.equal(
    baseline.evidence.accessibilitySource.materializedSqlSha256,
    sha256(Buffer.from(accessSql)),
  );
});

test("접근성 edge의 계단 여부가 boolean이 아니면 strict materialization을 거부한다", async () => {
  const value = await inputs();
  const reviewedPack = JSON.parse(value.reviewedPackBytes);
  reviewedPack.packs[0].networkEdges[0].includesStairs = "true";

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      reviewedPackBytes: Buffer.from(JSON.stringify(reviewedPack)),
      buildNow,
    }),
    /canonical accessibility edge includesStairs is invalid/,
  );
});

test("접근성 source snapshot의 정책 값이 boolean이 아니면 materialization을 거부한다", async () => {
  const value = await inputs();

  for (const field of ["redistributionAllowed", "credentialRedacted"]) {
    const snapshots = JSON.parse(value.sourceSnapshotsBytes);
    const snapshot = snapshots.find(
      ({ snapshotId }) => snapshotId === "seoul-metro-accessibility-capital-admission-20260712",
    );
    snapshot[field] = "false";

    assert.throws(
      () => buildServerTimetableSnapshot({
        ...value,
        sourceSnapshotsBytes: Buffer.from(JSON.stringify(snapshots)),
        buildNow,
      }),
      /canonical accessibility source snapshot policy boolean is invalid/,
    );
  }
});

test("접근성 source와 edge의 숫자 값이 유효한 정수가 아니면 materialization을 거부한다", async () => {
  const value = await inputs();
  const snapshots = JSON.parse(value.sourceSnapshotsBytes);
  const snapshot = snapshots.find(
    ({ snapshotId }) => snapshotId === "seoul-metro-accessibility-capital-admission-20260712",
  );
  snapshot.rowCount = "1";
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      sourceSnapshotsBytes: Buffer.from(JSON.stringify(snapshots)),
      buildNow,
    }),
    /snapshot rowCount is invalid/,
  );

  for (const [field, invalidValue, message] of [
    ["durationSeconds", 1.5, "pathway duration"],
    ["distanceMeters", -1, "pathway distance"],
    ["reliabilityScore", 101, "pathway reliability"],
  ]) {
    const reviewedPack = JSON.parse(value.reviewedPackBytes);
    reviewedPack.packs[0].networkEdges[0][field] = invalidValue;
    assert.throws(
      () => buildServerTimetableSnapshot({
        ...value,
        reviewedPackBytes: Buffer.from(JSON.stringify(reviewedPack)),
        buildNow,
      }),
      new RegExp(`${message} is invalid`),
    );
  }
});

test("접근성 edge endpoint 형식이 잘못되면 명시적인 build error로 거부한다", async () => {
  const value = await inputs();
  const reviewedPack = JSON.parse(value.reviewedPackBytes);
  reviewedPack.packs[0].networkEdges[0].toNodeId = null;

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      reviewedPackBytes: Buffer.from(JSON.stringify(reviewedPack)),
      buildNow,
    }),
    /canonical accessibility edge endpoints are invalid/,
  );
});

test("complete snapshot은 source·completeness identity와 freshness를 fail closed한다", async () => {
  const value = await inputs();
  const source = JSON.parse(value.sourceBytes);
  source.transitStopTimes[0].arrivalSeconds += 1;
  const tamperedSourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);

  assert.throws(
    () => buildServerTimetableSnapshot({ ...value, sourceBytes: tamperedSourceBytes, buildNow }),
    /source artifact SHA-256 mismatch/,
  );
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      buildNow: new Date("2026-08-02T15:00:00.000Z"),
    }),
    /source artifact is stale/,
  );
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      canonicalPackGzipBytes: Buffer.concat([value.canonicalPackGzipBytes, Buffer.from("tampered")]),
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
  const brokenReadmission = JSON.parse(value.readmissionEvidenceBytes);
  brokenReadmission.readmissions[0].previousPack.sha256 = "0".repeat(64);
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      readmissionEvidenceBytes: Buffer.from(JSON.stringify(brokenReadmission)),
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
  const missingNewPack = JSON.parse(value.readmissionEvidenceBytes);
  delete missingNewPack.readmissions[0].newPack;
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      readmissionEvidenceBytes: Buffer.from(JSON.stringify(missingNewPack)),
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
  const topologyValue = await inputs({ withTopologyEvidence: true });
  const consistentTopology = consistentFreshnessInputs(topologyValue);
  const topologyEvidence = JSON.parse(consistentTopology.topologyEvidenceBytes);
  topologyEvidence.pack.outputSha256 = "0".repeat(64);
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...topologyValue,
      contractBytes: consistentTopology.contractBytes,
      sourceBytes: consistentTopology.sourceBytes,
      topologyEvidenceBytes: Buffer.from(`${JSON.stringify(topologyEvidence, null, 2)}\n`),
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
});

test("현재 8컬럼 subway trip INSERT에서도 direction과 terminal evidence를 보존한다", async () => {
  const value = await inputs();
  const currentSchemaSql = gunzipSync(value.baselineGzipBytes).toString("utf8")
    .replaceAll(
      "service_pattern, service_day_start_seconds",
      "service_pattern, service_class, service_day_start_seconds",
    )
    .replace(
      /^(INSERT INTO transit_trips .*?'(?:LOCAL|EXPRESS)')(?=, )/gm,
      "$1, 'SUBWAY'",
    );

  const result = buildServerTimetableSnapshot({
    ...value,
    baselineGzipBytes: gzipSync(Buffer.from(currentSchemaSql), { level: 9, mtime: 0 }),
    buildNow,
  });
  const local = result.evidence.servicePatternEvidence.representativeLocal;

  assert.equal(local.directionId, "down");
  assert.equal(local.terminalStationId, local.stopStationIds.at(-1));
});

test("canonical gzip transport는 zlib encoder가 달라도 normalized SQL identity에 결합한다", async () => {
  const value = await inputs();
  const generated = buildServerTimetableSnapshot({ ...value, buildNow });
  const canonicalGzipBytes = gzipSync(Buffer.from(generated.sql), { level: 0, mtime: 0 });

  const canonical = buildServerTimetableSnapshot({
    ...value,
    buildNow,
    canonicalGzipBytes,
  });

  assert.equal(sha256(canonical.gzipBytes), sha256(canonicalGzipBytes));
  assert.equal(canonical.evidence.snapshotSha256, generated.evidence.snapshotSha256);
  assert.equal(canonical.evidence.snapshotGzipSha256, sha256(canonicalGzipBytes));
  assert.equal(canonical.evidence.snapshotGzipByteSize, canonicalGzipBytes.length);
});

test("CLI는 tracked snapshot/evidence를 생성하고 --check에서 byte identity를 검증한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "server-timetable-snapshot-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "snapshot.sql.gz");
  const evidencePath = path.join(directory, "evidence.json");
  const runtimeEvidencePath = path.join(directory, "runtime-evidence.json");
  const args = [
    "tools/datapack/build-server-timetable-snapshot.mjs",
    "--without-topology-evidence",
    "--baseline", baselinePath,
    "--contract", contractPath,
    "--output", outputPath,
    "--evidence", evidencePath,
    "--runtime-evidence", runtimeEvidencePath,
  ];
  const env = { ...process.env, EASYSUBWAY_TIMETABLE_SNAPSHOT_BUILD_NOW: buildNow.toISOString() };

  await execFileAsync(process.execPath, args, { cwd: root, env });
  const before = await Promise.all([
    readFile(outputPath),
    readFile(evidencePath),
    readFile(runtimeEvidencePath),
  ]);
  assert.deepEqual(before[2], before[1]);
  await execFileAsync(process.execPath, [...args, "--check"], { cwd: root, env });
  assert.deepEqual(await Promise.all([
    readFile(outputPath),
    readFile(evidencePath),
    readFile(runtimeEvidencePath),
  ]), before);

  const value = await inputs();
  const canonicalGzipBytes = gzipSync(gunzipSync(before[0]), { level: 0, mtime: 0 });
  const canonical = buildServerTimetableSnapshot({
    ...value,
    buildNow,
    canonicalGzipBytes,
  });
  await Promise.all([
    writeFile(outputPath, canonicalGzipBytes),
    writeFile(evidencePath, canonical.evidenceBytes),
    writeFile(runtimeEvidencePath, canonical.evidenceBytes),
  ]);
  await execFileAsync(process.execPath, [...args, "--check"], { cwd: root, env });

  await writeFile(outputPath, Buffer.concat([before[0], Buffer.from("tampered")]));
  await assert.rejects(
    execFileAsync(process.execPath, [...args, "--check"], { cwd: root, env }),
    /canonical gzip transport does not match normalized SQL/,
  );
});

test("CLI --check는 admitted input과 tracked snapshot/evidence의 최신성을 검증한다", async () => {
  await execFileAsync(process.execPath, [
    "tools/datapack/build-server-timetable-snapshot.mjs",
    "--without-topology-evidence",
    "--check",
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_TIMETABLE_SNAPSHOT_BUILD_NOW: buildNow.toISOString() },
  });
});

// topology 불변 순수 freshness 리프레시: 재수집한 source가 현행 출하 pack을 대상으로 수집되어
// admit된 pack identity가 번들 pack과 일치하는 상태. apply-itx 산출물(topology evidence) 없이도
// admit된 identity를 재사용해 완주해야 한다.
function consistentFreshnessInputs(value) {
  const measuredGzipSha = sha256(value.canonicalPackGzipBytes);
  const measuredSqliteSha = sha256(gunzipSync(value.canonicalPackGzipBytes));
  const source = JSON.parse(value.sourceBytes);
  source.canonicalPackIdentity.sha256 = measuredGzipSha;
  const { evidenceHash: _drop, ...sourceWithoutHash } = source;
  source.evidenceHash = sha256(Buffer.from(JSON.stringify(sourceWithoutHash)));
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  const contract = JSON.parse(value.contractBytes);
  contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sha256 = measuredGzipSha;
  contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256 = measuredSqliteSha;
  contract.sourceTimetableArtifact.sha256 = sha256(sourceBytes);
  const contractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);
  const topology = JSON.parse(value.topologyEvidenceBytes);
  topology.sourceArtifact = {
    id: source.artifactId,
    sha256: sha256(sourceBytes),
    completenessEvidenceSha256: source.completenessEvidenceSha256,
    freshUntil: source.freshUntil,
  };
  topology.pack.inputSha256 = measuredGzipSha;
  topology.pack.inputSqliteSha256 = measuredSqliteSha;
  const topologyEvidenceBytes = Buffer.from(`${JSON.stringify(topology, null, 2)}\n`);
  return {
    contractBytes, sourceBytes, topologyEvidenceBytes, measuredGzipSha, measuredSqliteSha,
  };
}

function staleCanonicalInputs(value) {
  const source = JSON.parse(value.sourceBytes);
  source.canonicalPackIdentity.sha256 = "0".repeat(64);
  const { evidenceHash: _drop, ...sourceWithoutHash } = source;
  source.evidenceHash = sha256(Buffer.from(JSON.stringify(sourceWithoutHash)));
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  const contract = JSON.parse(value.contractBytes);
  contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sha256 = "0".repeat(64);
  contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256 = "1".repeat(64);
  contract.sourceTimetableArtifact.sha256 = sha256(sourceBytes);
  return { contract, sourceBytes };
}

test("pack 미입력 순수 freshness 경로는 admit된 pack identity를 evidence에 기록한다", async () => {
  const value = await inputs({ withTopologyEvidence: true });
  const { contractBytes, sourceBytes, measuredGzipSha, measuredSqliteSha } = consistentFreshnessInputs(value);

  const result = buildServerTimetableSnapshot({
    ...value, contractBytes, sourceBytes, topologyEvidenceBytes: null, buildNow,
  });

  assert.deepEqual(result.evidence.canonicalPackIdentity, {
    id: "capital", sha256: measuredGzipSha, sqliteSha256: measuredSqliteSha,
  });
  assert.deepEqual(result.evidence.canonicalPackLineage, {
    provenance: "coverage-contract-admission",
    admittedInputSha256: measuredGzipSha,
    admittedInputSqliteSha256: measuredSqliteSha,
  });
  assert.match(
    result.sql,
    new RegExp(`'ITX_CHEONGCHUN', '[^']+', '[^']+', 'capital', '${measuredGzipSha}', '${measuredSqliteSha}', 'ADMITTED'`),
  );
});

test("pack 미입력 경로는 admit된 identity와 번들 pack이 불일치하면 fail closed 한다", async () => {
  const value = await inputs();
  const { contract, sourceBytes } = staleCanonicalInputs(value);

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      contractBytes: Buffer.from(`${JSON.stringify(contract, null, 2)}\n`),
      sourceBytes,
      topologyEvidenceBytes: null,
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
});

test("pack 미입력 경로는 sqliteSha256만 어긋나도 fail closed 한다", async () => {
  const value = await inputs({ withTopologyEvidence: true });
  const { contractBytes, sourceBytes } = consistentFreshnessInputs(value);
  // gzip sha256은 실측 pack과 일치시키되 sqliteSha256만 다른 값으로 어긋나게 한다.
  const contract = JSON.parse(contractBytes);
  contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256 = "9".repeat(64);
  const tamperedContractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value, contractBytes: tamperedContractBytes, sourceBytes, topologyEvidenceBytes: null, buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
});

test("pack 미입력 경로는 손상된 ITX projection hash를 거부한다", async () => {
  const value = await inputs();
  const evidence = JSON.parse(value.readmissionEvidenceBytes);
  evidence.readmissions.at(-1).itxSubgraph.edgesSha256 = "0".repeat(64);

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      readmissionEvidenceBytes: Buffer.from(`${JSON.stringify(evidence)}\n`),
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
});

test("pack 미입력 경로는 gzip이 파손되면 fail closed 한다", async () => {
  const value = await inputs({ withTopologyEvidence: true });
  const { contractBytes, sourceBytes } = consistentFreshnessInputs(value);

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      contractBytes,
      sourceBytes,
      canonicalPackGzipBytes: Buffer.from("corrupt-not-a-gzip"),
      topologyEvidenceBytes: null,
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
});

test("pack 미입력 경로와 topology evidence 경로는 동일 입력에서 byte-identical snapshot을 낸다", async () => {
  const value = await inputs({ withTopologyEvidence: true });
  const { contractBytes, sourceBytes, topologyEvidenceBytes } = consistentFreshnessInputs(value);

  const packMissing = buildServerTimetableSnapshot({
    ...value, contractBytes, sourceBytes, topologyEvidenceBytes: null, buildNow,
  });
  const packProvided = buildServerTimetableSnapshot({
    ...value, contractBytes, sourceBytes, topologyEvidenceBytes, buildNow,
  });

  assert.equal(packMissing.sql, packProvided.sql);
  assert.equal(packMissing.evidence.snapshotSha256, packProvided.evidence.snapshotSha256);
  assert.deepEqual(packMissing.evidence.canonicalPackIdentity, packProvided.evidence.canonicalPackIdentity);
  // lineage provenance만 설계상 갈린다(admission 재사용 vs topology evidence 결합).
  assert.equal(packMissing.evidence.canonicalPackLineage.provenance, "coverage-contract-admission");
  assert.ok(packProvided.evidence.canonicalPackLineage.topologyEvidenceSha256);
});

test("CLI --without-topology-evidence는 admit된 pack identity와 번들 pack 불일치를 fail closed 한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "server-timetable-snapshot-freshness-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const value = await inputs();
  const { contract, sourceBytes } = staleCanonicalInputs(value);
  const staleContractPath = path.join(directory, "contract.json");
  const staleSourcePath = path.join(directory, "source.json");
  contract.sourceTimetableArtifact.artifactPath = staleSourcePath;
  await Promise.all([
    writeFile(staleContractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(staleSourcePath, sourceBytes),
  ]);

  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/build-server-timetable-snapshot.mjs",
      "--without-topology-evidence",
      "--contract", staleContractPath,
      "--output", path.join(directory, "snapshot.sql.gz"),
      "--evidence", path.join(directory, "evidence.json"),
      "--runtime-evidence", path.join(directory, "runtime-evidence.json"),
    ], {
      cwd: root,
      env: { ...process.env, EASYSUBWAY_TIMETABLE_SNAPSHOT_BUILD_NOW: buildNow.toISOString() },
    }),
    /canonical topology pack identity mismatch/,
  );
});
