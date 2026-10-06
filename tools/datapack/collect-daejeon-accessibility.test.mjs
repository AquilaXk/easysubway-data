import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import {
  collectDaejeonAccessibility,
  parseDaejeonAccessibilityCsv,
  runDaejeonAccessibilityCollector,
} from "./collect-daejeon-accessibility.mjs";
import { createDataGoPortalFetch } from "./lib/data-go-test-portal.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const ELEVATOR_CSV = path.join(root, "tools/datapack/fixtures/daejeon-accessibility-raw/data-go-15041384.csv");
const ESCALATOR_CSV = path.join(root, "tools/datapack/fixtures/daejeon-accessibility-raw/data-go-15041361.csv");
const LINE_ID = "line-7051a9c2525c";

async function loadInputs() {
  const [elevatorBytes, escalatorBytes, topologySnapshot, molitBytes] = await Promise.all([
    readFile(ELEVATOR_CSV),
    readFile(ESCALATOR_CSV),
    readFile(path.join(root, "tools/datapack/sources/daejeon-route-topology-20260720.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  return {
    elevatorBytes,
    escalatorBytes,
    topologySnapshot,
    topologySource: topologySourceFor(topologySnapshot),
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitBytes),
  };
}

function topologySourceFor(topologySnapshot) {
  const snapshotId = "daejeon-station-distance-fare-fixture-accessibility";
  return {
    id: topologySnapshot.sourceId,
    topologyAdmissionEvidence: {
      snapshotId,
      snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
      capturedAt: topologySnapshot.observedAt,
      stationCount: topologySnapshot.stationNumbers.length,
      edgeCount: topologySnapshot.rowCount,
      excludedTransferCount: topologySnapshot.excludedTransferCount,
      rawSha256: topologySnapshot.rawSha256,
      contentSha256: topologySnapshot.contentSha256,
    },
  };
}

test("대전 accessibility collector는 엘리베이터·에스컬레이터 CSV 22역을 topology에 join한다", async () => {
  const inputs = await loadInputs();
  const snapshot = collectDaejeonAccessibility({
    ...inputs,
    now: new Date("2026-07-24T02:00:00.000Z"),
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.artifactKind, "daejeon-accessibility-snapshot");
  assert.equal(snapshot.sourceId, "daejeon-transportation-accessibility");
  assert.deepEqual(snapshot.datasetIds, ["15041384", "15041361"]);
  assert.equal(snapshot.detailUrl, "https://www.data.go.kr/data/15041384/fileData.do");
  assert.equal(snapshot.detailUrls.escalator, "https://www.data.go.kr/data/15041361/fileData.do");
  assert.equal(snapshot.stationCount, 22);
  assert.equal(snapshot.rowCount, 22);
  assert.equal(snapshot.elevatorRowCount, 76);
  assert.equal(snapshot.escalatorRowCount, 168);
  assert.equal(snapshot.rows.length, 22);
  assert.deepEqual(snapshot.lineIds, [LINE_ID]);
  assert.equal(snapshot.official, true);
  assert.equal(snapshot.fixture, false);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.capturedAt, "2026-07-24T02:00:00.000Z");
  assert.equal(snapshot.freshUntil, "2026-07-25T02:00:00.000Z");
  assert.equal(
    snapshot.elevatorRawSha256,
    createHash("sha256").update(inputs.elevatorBytes).digest("hex"),
  );
  assert.equal(
    snapshot.escalatorRawSha256,
    createHash("sha256").update(inputs.escalatorBytes).digest("hex"),
  );
  assert.deepEqual(snapshot.rawSources.map(({ datasetId, rawSha256, bytesBase64 }) => ({
    datasetId,
    rawSha256,
    bytes: Buffer.from(bytesBase64, "base64"),
  })), [
    {
      datasetId: snapshot.datasetIds[0],
      rawSha256: createHash("sha256").update(inputs.elevatorBytes).digest("hex"),
      bytes: inputs.elevatorBytes,
    },
    {
      datasetId: snapshot.datasetIds[1],
      rawSha256: createHash("sha256").update(inputs.escalatorBytes).digest("hex"),
      bytes: inputs.escalatorBytes,
    },
  ]);
  assert.equal(snapshot.rowsSha256, createHash("sha256").update(JSON.stringify(snapshot.rows)).digest("hex"));
  assert.equal(snapshot.scopeSha256, createHash("sha256").update(JSON.stringify(snapshot.scope)).digest("hex"));
  assert.deepEqual(snapshot.fieldsProvided, [
    "elevator", "escalator", "wheelchair_lift", "status", "verified_at",
  ]);
  assert.equal(snapshot.topologyLineages.length, 1);
  assert.deepEqual(snapshot.topologyLineages[0], {
    sourceId: "daejeon-station-distance-fare",
    snapshotId: inputs.topologySource.topologyAdmissionEvidence.snapshotId,
    contentSha256: inputs.topologySnapshot.contentSha256,
    lineId: LINE_ID,
  });
  assert.equal(snapshot.rows.every((row) => (
    row.lineId === LINE_ID
      && Number.isInteger(row.elevator) && row.elevator >= 1
      && Number.isInteger(row.escalator) && row.escalator >= 1
      && row.wheelchair_lift === null
  )), true);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.elevator, 0), 76);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.escalator, 0), 168);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("대전 accessibility collector는 schema·join·count 변조를 fail closed한다", async () => {
  const inputs = await loadInputs();

  assert.throws(() => parseDaejeonAccessibilityCsv({
    ...inputs,
    elevatorBytes: new Uint8Array(),
  }), /elevator CSV bytes/);

  const badHeader = Buffer.from("철도운영기관명,선명,역명\n대전교통공사,1호선,판암(대전대)\n", "utf8");
  assert.throws(() => parseDaejeonAccessibilityCsv({
    ...inputs,
    elevatorBytes: badHeader,
  }), /missing column/);

  const badJoin = Buffer.from(
    "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량\n대전교통공사,1호선,존재하지않는역,1,위치,11,750\n",
    "utf8",
  );
  assert.throws(() => parseDaejeonAccessibilityCsv({
    ...inputs,
    elevatorBytes: badJoin,
  }), /join failed/);

  const truncated = Buffer.from(
    "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량\n대전교통공사,1호선,판암(대전대),1,위치,11,750\n",
    "utf8",
  );
  assert.throws(() => parseDaejeonAccessibilityCsv({
    ...inputs,
    elevatorBytes: truncated,
  }), /row count|station coverage|missing elevator/);

  const badTopology = {
    ...inputs.topologySnapshot,
    contentSha256: "0".repeat(64),
  };
  assert.throws(() => collectDaejeonAccessibility({
    ...inputs,
    topologySnapshot: badTopology,
    now: new Date("2026-07-24T02:00:00.000Z"),
  }), /Daejeon accessibility topology source binding is invalid/);
});

test("대전 accessibility collector CLI는 absolute output 경로를 강제한다", async () => {
  await assert.rejects(runDaejeonAccessibilityCollector([
    "--elevator-input", ELEVATOR_CSV,
    "--escalator-input", ESCALATOR_CSV,
    "--topology-snapshot", path.join(root, "tools/datapack/sources/daejeon-route-topology-20260720.json"),
    "--inventory", path.join(root, "tools/datapack/source-inventory.json"),
    "--molit-csv", path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"),
    "--output", "relative.json",
  ]), /usage: collect-daejeon-accessibility/);
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function downloadCliArgs(output) {
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const topology = inventory.sources.find(({ id }) => id === "daejeon-station-distance-fare");
  return [
    "--topology-snapshot", path.join(root, topology.topologyAdmissionEvidence.snapshotPath),
    "--inventory", path.join(root, "tools/datapack/source-inventory.json"),
    "--molit-csv", path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"),
    "--output", output,
  ];
}

test("대전 accessibility collector --download는 공식 FILE 두 개를 받아 원본 sha provenance와 함께 snapshot을 쓴다", async () => {
  const [elevatorBytes, escalatorBytes] = await Promise.all([readFile(ELEVATOR_CSV), readFile(ESCALATOR_CSV)]);
  const dir = await mkdtemp(path.join(tmpdir(), "daejeon-accessibility-download-"));
  try {
    const output = path.join(dir, "daejeon-accessibility.json");
    const now = new Date("2026-10-06T03:00:00.000Z");
    const snapshot = await runDaejeonAccessibilityCollector(
      ["--download", ...await downloadCliArgs(output)],
      { fetchImpl: createDataGoPortalFetch({ 15041384: elevatorBytes, 15041361: escalatorBytes }), now: () => now },
    );
    assert.equal(snapshot.capturedAt, now.toISOString());
    assert.deepEqual(snapshot.downloadProvenance, [
      {
        datasetId: "15041384",
        detailUrl: "https://www.data.go.kr/data/15041384/fileData.do",
        downloadUrl: "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000015041384&fileDetailSn=1&insertDataPrcus=N",
        rawSha256: sha256(elevatorBytes),
      },
      {
        datasetId: "15041361",
        detailUrl: "https://www.data.go.kr/data/15041361/fileData.do",
        downloadUrl: "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000015041361&fileDetailSn=1&insertDataPrcus=N",
        rawSha256: sha256(escalatorBytes),
      },
    ]);
    assert.equal(snapshot.elevatorRawSha256, sha256(elevatorBytes));
    assert.equal(snapshot.escalatorRawSha256, sha256(escalatorBytes));
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), JSON.parse(JSON.stringify(snapshot)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("대전 accessibility collector 파일 입력 모드는 downloadProvenance를 기록하지 않는다", async () => {
  const snapshot = collectDaejeonAccessibility({
    ...await loadInputs(),
    now: new Date("2026-07-24T02:00:00.000Z"),
  });
  assert.equal(Object.hasOwn(snapshot, "downloadProvenance"), false);
});

test("대전 accessibility collector --download 실패·인자 오류·provenance 변조는 snapshot을 남기지 않는다", async () => {
  const inputs = await loadInputs();
  const files = { 15041384: inputs.elevatorBytes, 15041361: inputs.escalatorBytes };
  const dir = await mkdtemp(path.join(tmpdir(), "daejeon-accessibility-download-fail-"));
  const common = await downloadCliArgs(path.join(dir, "out.json"));
  try {
    await assert.rejects(runDaejeonAccessibilityCollector(["--download", ...common], {
      fetchImpl: createDataGoPortalFetch(files, { failFile: new Set(["15041361"]) }),
    }), /15041361 file HTTP 503/);
    await assert.rejects(runDaejeonAccessibilityCollector(["--download", ...common], {
      fetchImpl: createDataGoPortalFetch({ 15041384: inputs.elevatorBytes }),
    }), /15041361 detail HTTP 404/);
    for (const extra of [
      ["--elevator-input", ELEVATOR_CSV],
      ["--escalator-input", ESCALATOR_CSV],
      ["--captured-at", "2026-10-06T00:00:00.000Z"],
      ["--download"],
    ]) {
      await assert.rejects(runDaejeonAccessibilityCollector(["--download", ...extra, ...common]),
        /usage: collect-daejeon-accessibility/);
    }
    await assert.rejects(runDaejeonAccessibilityCollector(["--download", ...common.slice(0, -2), "--output", "relative.json"]),
      /usage: collect-daejeon-accessibility/);
    await assert.rejects(runDaejeonAccessibilityCollector(["--download", ...common.slice(0, 2), ...common.slice(4)]),
      /usage: collect-daejeon-accessibility/);
    assert.deepEqual(await readdir(dir), []);
    const good = [
      {
        datasetId: "15041384",
        detailUrl: "https://www.data.go.kr/data/15041384/fileData.do",
        downloadUrl: "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000015041384&fileDetailSn=1&insertDataPrcus=N",
        rawSha256: sha256(inputs.elevatorBytes),
      },
      {
        datasetId: "15041361",
        detailUrl: "https://www.data.go.kr/data/15041361/fileData.do",
        downloadUrl: "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000015041361&fileDetailSn=1&insertDataPrcus=N",
        rawSha256: sha256(inputs.escalatorBytes),
      },
    ];
    const now = new Date("2026-07-24T02:00:00.000Z");
    assert.deepEqual(collectDaejeonAccessibility({ ...inputs, now, downloadProvenance: good }).downloadProvenance, good);
    assert.throws(() => collectDaejeonAccessibility({ ...inputs, now, downloadProvenance: [good[1], good[0]] }),
      /download provenance is invalid/);
    assert.throws(() => collectDaejeonAccessibility({
      ...inputs, now, downloadProvenance: [good[0], { ...good[1], rawSha256: "0".repeat(64) }],
    }), /15041361 download provenance sha256 mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
