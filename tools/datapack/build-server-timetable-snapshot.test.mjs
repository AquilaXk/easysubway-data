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
const buildNow = new Date("2026-07-16T00:00:00.000Z");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function inputs() {
  const baselineGzipBytes = await readFile(baselinePath);
  const contractBytes = await readFile(contractPath);
  const contract = JSON.parse(contractBytes);
  const sourceBytes = await readFile(path.join(root, contract.sourceTimetableArtifact.artifactPath));
  const completenessBytes = await readFile(path.join(
    root,
    contract.sourceTimetableArtifact.completenessEvidencePath,
  ));
  const canonicalPackGzipBytes = await readFile(canonicalPackPath);
  const topologyEvidenceBytes = await readFile(topologyEvidencePath);
  const subwayRosterBytes = await readFile(subwayRosterPath);
  return {
    baselineGzipBytes,
    contractBytes,
    sourceBytes,
    completenessBytes,
    canonicalPackGzipBytes,
    topologyEvidenceBytes,
    subwayRosterBytes,
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
  assert.equal(
    first.evidence.canonicalPackLineage.topologyEvidenceSha256,
    sha256(value.topologyEvidenceBytes),
  );
  assert.deepEqual(first.evidence.serviceIdentity, {
    serviceId: "ITX_CHEONGCHUN",
    canonicalLineId: contract.canonicalLineId,
    servicePattern: "EXPRESS",
    timezone: "Asia/Seoul",
  });
  assert.equal(first.evidence.rowCounts.itxTrips, source.transitTrips.length);
  assert.equal(first.evidence.rowCounts.itxStopTimes, source.transitStopTimes.length);
  assert.ok(first.evidence.rowCounts.subwayTrips > 0);
  assert.ok(first.evidence.rowCounts.subwayStopTimes > first.evidence.rowCounts.subwayTrips);
  assert.match(first.sql, /'ITX_CHEONGCHUN'/);
  assert.match(first.sql, /, 2135\);/);
  assert.equal((first.sql.match(/INSERT INTO transit_feed_info/g) ?? []).length, 1);
  assert.equal((first.sql.match(/VALUES \('weekday-kric'/g) ?? []).length, 1);
  assert.equal((first.sql.match(/VALUES \('holiday-kric'/g) ?? []).length, 1);
  assert.match(first.sql, /VALUES \('itx-cheongchun-weekday-kric', '20260716', '20260719', 'Asia\/Seoul', TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE\)/);
  assert.match(first.sql, /VALUES \('itx-cheongchun-saturday-kric', '20260716', '20260719', 'Asia\/Seoul', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, FALSE\)/);
  assert.match(first.sql, /VALUES \('itx-cheongchun-holiday-kric', '20260716', '20260719', 'Asia\/Seoul', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE\)/);
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
      buildNow: new Date("2026-07-19T15:00:00.000Z"),
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
  const topologyEvidence = JSON.parse(value.topologyEvidenceBytes);
  topologyEvidence.pack.outputSha256 = "0".repeat(64);
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
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
    "--check",
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_TIMETABLE_SNAPSHOT_BUILD_NOW: buildNow.toISOString() },
  });
});
