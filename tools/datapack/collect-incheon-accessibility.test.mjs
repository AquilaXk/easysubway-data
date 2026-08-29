import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectIncheonAccessibility,
  normalizedIncheonStationName,
  parseIncheonAccessibilityCsv,
  runIncheonAccessibilityCollector,
  validateIncheonAccessibilityRawCollection,
  validateIncheonAccessibilitySnapshotIdentity,
} from "./collect-incheon-accessibility.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const ELEVATOR_CSV = path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15083478.csv");
const ESCALATOR_CSV = path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15010199.csv");
const WHEELCHAIR_CSV = path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15146049.csv");
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";
const LINE7 = "line-15b3b8a93259";

async function loadInputs() {
  const [elevatorBytes, escalatorBytes, wheelchairBytes, topologySnapshot, freshnessPolicy] = await Promise.all([
    readFile(ELEVATOR_CSV),
    readFile(ESCALATOR_CSV),
    readFile(WHEELCHAIR_CSV),
    readFile(path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260724.json"), "utf8")
      .then(JSON.parse)
      .then((snapshot) => ({
        ...snapshot,
        snapshotId: snapshot.snapshotId ?? "incheon-transit-station-info-20260724",
      })),
    readFile(path.join(root, "release/product-gates/datapack-freshness-sla.json"), "utf8").then(JSON.parse),
  ]);
  return { elevatorBytes, escalatorBytes, wheelchairBytes, topologySnapshot, freshnessPolicy };
}

test("인천 accessibility collector는 엘리베이터·에스컬레이터·휠체어리프트 CSV를 topology 71 membership에 join한다", async () => {
  const inputs = await loadInputs();
  const snapshot = collectIncheonAccessibility({
    ...inputs,
    now: new Date("2026-07-24T07:00:00.000Z"),
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.artifactKind, "incheon-accessibility-snapshot");
  assert.equal(snapshot.sourceId, "incheon-transit-accessibility");
  assert.deepEqual(snapshot.datasetIds, ["15083478", "15010199", "15146049"]);
  assert.equal(snapshot.detailUrl, "https://www.data.go.kr/data/15083478/fileData.do");
  assert.equal(snapshot.detailUrls.escalator, "https://www.data.go.kr/data/15010199/fileData.do");
  assert.equal(snapshot.detailUrls.wheelchair_lift, "https://www.data.go.kr/data/15146049/fileData.do");
  assert.equal(snapshot.stationCount, 71);
  assert.equal(snapshot.rowCount, 71);
  assert.equal(snapshot.elevatorRowCount, 265);
  assert.equal(snapshot.escalatorRowCount, 653);
  assert.equal(snapshot.wheelchairRowCount, 3);
  assert.equal(snapshot.elevatorCsvRowCount, 269);
  assert.equal(snapshot.escalatorCsvRowCount, 653);
  assert.equal(snapshot.wheelchairCsvRowCount, 3);
  assert.deepEqual(snapshot.skippedNonStationFacilityRows, [
    "9번환기구(1072)",
    "6번환기구(1082)",
    "대피3",
    "대피4",
  ]);
  assert.deepEqual(snapshot.skippedLine7RowCounts, {
    elevator: 0,
    escalator: 0,
    wheelchair_lift: 0,
  });
  assert.equal(snapshot.rows.length, 71);
  assert.deepEqual(snapshot.lineIds, [LINE2, LINE1, LINE7]);
  assert.equal(snapshot.official, true);
  assert.equal(snapshot.fixture, false);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.capturedAt, "2026-07-24T07:00:00.000Z");
  assert.equal(snapshot.freshUntil, "2026-10-22T07:00:00.000Z");
  assert.equal(snapshot.observedAt, snapshot.capturedAt);
  assert.equal(snapshot.contentSha256, snapshot.rowsSha256);
  assert.equal(snapshot.absenceEvidenceMode, "EXHAUSTIVE_LIST");
  assert.equal(snapshot.claimBindings.length, 426);
  const transferFacilityBindings = snapshot.claimBindings.filter(({ lineId }) => lineId === "")
    .reduce((groups, binding) => {
      const key = `${binding.stationId}:${binding.facilityType}`;
      groups.set(key, [...(groups.get(key) ?? []), binding]);
      return groups;
    }, new Map());
  const duplicatedTransfers = [...transferFacilityBindings.values()].filter((bindings) => bindings.length === 2);
  assert.equal(duplicatedTransfers.length, 6);
  for (const bindings of duplicatedTransfers) {
    assert.equal(new Set(bindings.map(({ sourceLineId }) => sourceLineId)).size, 2);
    assert.equal(new Set(bindings.map(({ stationCode }) => stationCode)).size, 2);
    assert.equal(new Set(bindings.map(({ providerRecordHash }) => providerRecordHash)).size, 2);
  }
  assert.equal(
    snapshot.elevatorRawSha256,
    createHash("sha256").update(inputs.elevatorBytes).digest("hex"),
  );
  assert.equal(
    snapshot.escalatorRawSha256,
    createHash("sha256").update(inputs.escalatorBytes).digest("hex"),
  );
  assert.equal(
    snapshot.wheelchairRawSha256,
    createHash("sha256").update(inputs.wheelchairBytes).digest("hex"),
  );
  assert.equal(snapshot.rowsSha256, createHash("sha256").update(JSON.stringify(snapshot.rows)).digest("hex"));
  assert.equal(snapshot.scopeSha256, createHash("sha256").update(JSON.stringify(snapshot.scope)).digest("hex"));
  assert.deepEqual(snapshot.fieldsProvided, [
    "elevator", "escalator", "wheelchair_lift", "status", "verified_at",
  ]);
  assert.equal(snapshot.topologyLineages.length, 2);
  assert.deepEqual(snapshot.topologyLineages, [
    {
      sourceId: "incheon-transit-station-info",
      snapshotId: "incheon-transit-station-info-20260724",
      contentSha256: inputs.topologySnapshot.contentSha256,
      lineId: LINE2,
    },
    {
      sourceId: "incheon-transit-station-info",
      snapshotId: "incheon-transit-station-info-20260724",
      contentSha256: inputs.topologySnapshot.contentSha256,
      lineId: LINE1,
    },
  ]);
  assert.equal(snapshot.membershipLineages.length, 1);
  assert.deepEqual(snapshot.membershipLineages, [
    {
      sourceId: "incheon-transit-station-info",
      snapshotId: "incheon-transit-station-info-20260724",
      contentSha256: inputs.topologySnapshot.contentSha256,
      lineId: LINE7,
    },
  ]);
  assert.equal(snapshot.rows.every((row) => (
    [LINE1, LINE2, LINE7].includes(row.lineId)
      && Number.isInteger(row.elevator) && row.elevator >= 0
      && Number.isInteger(row.escalator) && row.escalator >= 0
      && Number.isInteger(row.wheelchair_lift) && row.wheelchair_lift >= 0
  )), true);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.elevator, 0), 265);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.escalator, 0), 653);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.wheelchair_lift, 0), 3);
  assert.equal(snapshot.rows.filter((row) => row.lineId === LINE1).length, 33);
  assert.equal(snapshot.rows.filter((row) => row.lineId === LINE2).length, 27);
  assert.equal(snapshot.rows.filter((row) => row.lineId === LINE7).length, 11);
  assert.equal(
    snapshot.rows.filter((row) => row.lineId === LINE1).reduce((sum, row) => sum + row.elevator, 0),
    99,
  );
  assert.equal(
    snapshot.rows.filter((row) => row.lineId === LINE2).reduce((sum, row) => sum + row.elevator, 0),
    114,
  );
  assert.equal(
    snapshot.rows.filter((row) => row.lineId === LINE7).reduce((sum, row) => sum + row.elevator, 0),
    52,
  );
  assert.equal(
    snapshot.rows.filter((row) => row.lineId === LINE1).reduce((sum, row) => sum + row.escalator, 0),
    283,
  );
  assert.equal(
    snapshot.rows.filter((row) => row.lineId === LINE2).reduce((sum, row) => sum + row.escalator, 0),
    207,
  );
  assert.equal(
    snapshot.rows.filter((row) => row.lineId === LINE7).reduce((sum, row) => sum + row.escalator, 0),
    163,
  );
  assert.equal(
    snapshot.rows.filter((row) => row.lineId === LINE7).reduce((sum, row) => sum + row.wheelchair_lift, 0),
    0,
  );
  const byCode = Object.fromEntries(snapshot.rows.map((row) => [row.stationCode, row]));
  assert.equal(byCode["3127"].stationName, "문학경기장");
  assert.ok(byCode["3127"].elevator >= 1);
  assert.ok(byCode["3127"].escalator >= 1);
  assert.equal(byCode["3107"].stationName, "검단호수공원");
  assert.ok(byCode["3107"].elevator >= 1);
  assert.equal(byCode["3111"].stationName, "귤현");
  assert.ok(byCode["3111"].elevator >= 1);
  assert.equal(byCode["3111"].escalator, 0);
  assert.equal(byCode["3132"].stationName, "동막");
  assert.ok(byCode["3132"].elevator >= 1);
  assert.equal(byCode["3132"].escalator, 0);
  assert.equal(byCode["3132"].wheelchair_lift, 1);
  assert.equal(byCode["3120"].stationName, "부평");
  assert.equal(byCode["3120"].wheelchair_lift, 2);
  assert.equal(snapshot.rows.filter((row) => row.wheelchair_lift > 0).length, 2);
  assert.equal(byCode["3753"].stationName, "까치울");
  assert.ok(byCode["3753"].elevator >= 1);
  assert.ok(byCode["3753"].escalator >= 1);
  assert.equal(byCode["3763"].stationName, "석남(거북시장)");
  assert.ok(byCode["3763"].elevator >= 1);
  assert.ok(byCode["3763"].escalator >= 1);
  assert.equal(byCode["3763"].wheelchair_lift, 0);
  assert.equal(normalizedIncheonStationName("문학역"), "문학경기장");
  assert.equal(normalizedIncheonStationName("가정(루원시티)"), "가정");
  assert.equal(normalizedIncheonStationName("석남역"), "석남");
  assert.equal(normalizedIncheonStationName("석남(거북시장)"), "석남");
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("인천 accessibility collector는 supplied current topology identity에 lineage를 결속한다", async () => {
  const inputs = await loadInputs();
  const topologySnapshot = structuredClone(inputs.topologySnapshot);
  Object.assign(topologySnapshot.scope.find(({ lineId, stationCode }) => (
    lineId === LINE2 && stationCode === "3210"
  )), { stationName: "서해구청", nameEn: "Seohae-gu Office" });
  topologySnapshot.positions.find(({ lineId, stationCode }) => (
    lineId === LINE2 && stationCode === "3210"
  )).stationName = "서해구청";
  Object.assign(topologySnapshot, {
    capturedAt: "2026-08-28T03:47:35.000Z",
    freshUntil: "2026-08-29T03:47:35.000Z",
    snapshotId: "incheon-transit-station-info-20260828",
    scopeSha256: createHash("sha256").update(JSON.stringify(topologySnapshot.scope)).digest("hex"),
    positionsSha256: createHash("sha256").update(JSON.stringify(topologySnapshot.positions)).digest("hex"),
    contentSha256: createHash("sha256").update(JSON.stringify({
      scope: topologySnapshot.scope,
      edges: topologySnapshot.edges,
      positions: topologySnapshot.positions,
    })).digest("hex"),
  });
  const snapshot = collectIncheonAccessibility({
    ...inputs,
    topologySnapshot,
    now: new Date("2026-08-28T04:00:00.000Z"),
  });
  assert.ok(
    [...snapshot.topologyLineages, ...snapshot.membershipLineages]
      .every(({ snapshotId, contentSha256 }) => snapshotId === topologySnapshot.snapshotId
        && contentSha256 === topologySnapshot.contentSha256),
  );
});

test("인천 accessibility collector는 schema·join·count 변조를 fail closed한다", async () => {
  const inputs = await loadInputs();

  assert.throws(() => parseIncheonAccessibilityCsv({
    ...inputs,
    elevatorBytes: new Uint8Array(),
  }), /elevator CSV bytes/);

  const badHeader = Buffer.from("호선,역명\n1,계양역\n", "utf8");
  assert.throws(() => parseIncheonAccessibilityCsv({
    ...inputs,
    elevatorBytes: badHeader,
  }), /missing column/);

  const badJoin = Buffer.from(
    "호선,역명,장비종류,호기,승강기번호,운행구간,설치위치\n1,존재하지않는역,EL,1,1,구간,위치\n",
    "utf8",
  );
  assert.throws(() => parseIncheonAccessibilityCsv({
    ...inputs,
    elevatorBytes: badJoin,
  }), /join failed|row count|aggregated facility|CSV row count/);

  const truncated = Buffer.from(
    "호선,역명,장비종류,호기,승강기번호,운행구간,설치위치\n1,계양역,EL,1,1,구간,위치\n",
    "utf8",
  );
  assert.throws(() => parseIncheonAccessibilityCsv({
    ...inputs,
    elevatorBytes: truncated,
  }), /row count|aggregated facility|joined row count/);

  const badTopology = {
    ...inputs.topologySnapshot,
    contentSha256: "0".repeat(64),
  };
  assert.throws(() => collectIncheonAccessibility({
    ...inputs,
    topologySnapshot: badTopology,
    now: new Date("2026-07-24T07:00:00.000Z"),
  }), /topology snapshot|station info snapshot/);

  const wrongSnapshotId = {
    ...inputs.topologySnapshot,
    snapshotId: "incheon-transit-station-info-20990101",
  };
  assert.throws(() => collectIncheonAccessibility({
    ...inputs,
    topologySnapshot: wrongSnapshotId,
    now: new Date("2026-07-24T07:00:00.000Z"),
  }), /invalid Incheon topology snapshot/);
});

test("인천 accessibility collector CLI는 absolute output 경로를 강제한다", async () => {
  await assert.rejects(runIncheonAccessibilityCollector([
    "--elevator-input", ELEVATOR_CSV,
    "--escalator-input", ESCALATOR_CSV,
    "--wheelchair-input", WHEELCHAIR_CSV,
    "--topology-snapshot", path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260828.json"),
    "--output", "relative.json",
  ]), /usage: collect-incheon-accessibility/);
});

test("인천 accessibility observation output은 정확한 3 CSV raw identity를 create-once으로 결속한다", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "incheon-accessibility-observation-"));
  const output = path.join(outputRoot, "observation");
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  await runIncheonAccessibilityCollector([
    "--elevator-input", ELEVATOR_CSV, "--escalator-input", ESCALATOR_CSV, "--wheelchair-input", WHEELCHAIR_CSV,
    "--topology-snapshot", path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260828.json"),
    "--observation-output", output, "--captured-at", "2026-08-28T04:33:56.000Z",
  ]);
  const manifest = JSON.parse(await readFile(path.join(output, "observation.json"), "utf8"));
  const snapshot = validateIncheonAccessibilitySnapshotIdentity(JSON.parse(await readFile(path.join(output, manifest.snapshotFile), "utf8")));
  const raw = validateIncheonAccessibilityRawCollection(JSON.parse(await readFile(path.join(output, manifest.rawArtifactFile), "utf8")), snapshot);
  assert.equal(snapshot.rawSha256, "3f29b437f2c6f4145dea67535839684223f8458d610b241580ed0a6a499ba67c");
  assert.deepEqual(raw.payloads.map(({ datasetId, fileName }) => [datasetId, fileName]), [
    ["15083478", "data-go-15083478.csv"], ["15010199", "data-go-15010199.csv"], ["15146049", "data-go-15146049.csv"],
  ]);
  await assert.rejects(runIncheonAccessibilityCollector([
    "--elevator-input", ELEVATOR_CSV, "--escalator-input", ESCALATOR_CSV, "--wheelchair-input", WHEELCHAIR_CSV,
    "--topology-snapshot", path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260828.json"),
    "--observation-output", output, "--captured-at", "2026-08-28T04:33:56.000Z",
  ]), /observation output already exists/);
  raw.payloads[0].bodyBase64 = Buffer.from("mutated").toString("base64");
  assert.throws(() => validateIncheonAccessibilityRawCollection(raw, snapshot), /identity mismatch/);
  const tamperedBinding = structuredClone(snapshot);
  tamperedBinding.claimBindings[0].sourceLineId = "wrong";
  tamperedBinding.claimBindingsSha256 = createHash("sha256").update(JSON.stringify(tamperedBinding.claimBindings)).digest("hex");
  assert.throws(() => validateIncheonAccessibilitySnapshotIdentity(tamperedBinding), /identity is invalid/);
  const tamperedTopology = structuredClone(JSON.parse(await readFile(path.join(output, manifest.rawArtifactFile), "utf8")));
  tamperedTopology.topologySnapshot.extra = true;
  assert.throws(() => validateIncheonAccessibilityRawCollection(tamperedTopology, snapshot), /unexpected fields|topology mismatch/);
  const tamperedFreshness = structuredClone(JSON.parse(await readFile(path.join(output, manifest.rawArtifactFile), "utf8")));
  tamperedFreshness.freshnessPolicy.sourceClasses[0].reverificationCadence = "P1D";
  assert.throws(() => validateIncheonAccessibilityRawCollection(tamperedFreshness, snapshot), /freshness policy mismatch/);
  assert.equal(manifest.credentialRedacted, true);
});

test("인천 accessibility observation output은 동시 collector에서 정확히 한 번만 생성된다", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "incheon-accessibility-observation-concurrent-"));
  const output = path.join(outputRoot, "observation");
  const topologyPath = path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260828.json");
  const args = [
    "--elevator-input", ELEVATOR_CSV, "--escalator-input", ESCALATOR_CSV, "--wheelchair-input", WHEELCHAIR_CSV,
    "--topology-snapshot", topologyPath, "--observation-output", output,
    "--captured-at", "2026-08-28T04:33:56.000Z",
  ];
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const results = await Promise.allSettled([runIncheonAccessibilityCollector(args), runIncheonAccessibilityCollector(args)]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.ok(rejected);
  assert.match(rejected.reason.message, /observation output already exists/);
  const manifest = JSON.parse(await readFile(path.join(output, "observation.json"), "utf8"));
  const topologySnapshot = {
    ...JSON.parse(await readFile(topologyPath, "utf8")),
    snapshotId: "incheon-transit-station-info-20260828",
  };
  const snapshot = validateIncheonAccessibilitySnapshotIdentity(
    JSON.parse(await readFile(path.join(output, manifest.snapshotFile), "utf8")),
    undefined,
    topologySnapshot,
  );
  validateIncheonAccessibilityRawCollection(
    JSON.parse(await readFile(path.join(output, manifest.rawArtifactFile), "utf8")),
    snapshot,
  );
});
