import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  collectGwangjuAccessibility,
  parseGwangjuAccessibilityCsv,
  runGwangjuAccessibilityCollector,
} from "./collect-gwangju-accessibility.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const ELEVATOR_CSV = path.join(root, "tools/datapack/fixtures/gwangju-accessibility-raw/data-go-15041385.csv");
const ESCALATOR_CSV = path.join(root, "tools/datapack/fixtures/gwangju-accessibility-raw/data-go-15041362.csv");
const LINE_ID = "line-e57a361e8892";

async function loadInputs() {
  const [elevatorBytes, escalatorBytes, topologySnapshot] = await Promise.all([
    readFile(ELEVATOR_CSV),
    readFile(ESCALATOR_CSV),
    readFile(path.join(root, "tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"), "utf8")
      .then(JSON.parse),
  ]);
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const topologySource = inventory.sources.find(({ id }) => id === "gwangju-transportation-route-topology");
  return { elevatorBytes, escalatorBytes, topologySnapshot, topologySource };
}

test("선택된 topology 변경을 파생하고 미관측 시설을 부재로 합성하지 않는다", async () => {
  const inputs = await loadInputs();
  const topologySnapshot = structuredClone(inputs.topologySnapshot);
  const topologySource = structuredClone(inputs.topologySource);
  topologySnapshot.scope.push({ providerStationId: "synthetic-terminal", stationCode: "synthetic-terminal", stationName: "테스트종점" });
  topologySnapshot.stationCount = topologySnapshot.scope.length;
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  topologySnapshot.scopeSha256 = hash(topologySnapshot.scope);
  topologySnapshot.contentSha256 = hash({ scope: topologySnapshot.scope, edges: topologySnapshot.edges });
  Object.assign(topologySource.topologyAdmissionEvidence, {
    stationCount: topologySnapshot.stationCount,
    contentSha256: topologySnapshot.contentSha256,
  });
  const snapshot = collectGwangjuAccessibility({
    ...inputs, topologySnapshot, topologySource,
    now: new Date(topologySnapshot.capturedAt),
  });
  assert.equal(snapshot.stationCount, topologySnapshot.scope.length);
  assert.equal(snapshot.topologyLineages[0].contentSha256, topologySnapshot.contentSha256);
  const terminal = snapshot.rows.find(({ stationCode }) => stationCode === "synthetic-terminal");
  assert.equal(terminal.elevator, null);
  assert.equal(terminal.escalator, null);
  assert.equal(terminal.wheelchair_lift, null);
  assert.ok(snapshot.rows.every(({ wheelchair_lift }) => wheelchair_lift === null));
  assert.throws(() => collectGwangjuAccessibility({
    ...inputs, topologySnapshot, now: new Date(topologySnapshot.capturedAt),
  }), /topology/);
});

test("광주 accessibility collector는 엘리베이터·에스컬레이터 CSV를 topology 20역에 join한다", async () => {
  const inputs = await loadInputs();
  const snapshot = collectGwangjuAccessibility({
    ...inputs,
    now: new Date("2026-07-24T03:00:00.000Z"),
  });

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.artifactKind, "gwangju-accessibility-snapshot");
  assert.equal(snapshot.sourceId, "gwangju-transportation-accessibility");
  assert.deepEqual(snapshot.datasetIds, ["15041385", "15041362"]);
  assert.equal(snapshot.detailUrl, "https://www.data.go.kr/data/15041385/fileData.do");
  assert.equal(snapshot.detailUrls.escalator, "https://www.data.go.kr/data/15041362/fileData.do");
  assert.equal(snapshot.stationCount, 20);
  assert.equal(snapshot.rowCount, 20);
  assert.equal(snapshot.elevatorRowCount, 62);
  assert.equal(snapshot.escalatorRowCount, 99);
  assert.equal(snapshot.rows.length, 20);
  assert.deepEqual(snapshot.lineIds, [LINE_ID]);
  assert.equal(snapshot.official, true);
  assert.equal(snapshot.fixture, false);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.capturedAt, "2026-07-24T03:00:00.000Z");
  assert.equal(snapshot.freshUntil, "2026-07-25T03:00:00.000Z");
  assert.equal(
    snapshot.elevatorRawSha256,
    createHash("sha256").update(inputs.elevatorBytes).digest("hex"),
  );
  assert.equal(
    snapshot.escalatorRawSha256,
    createHash("sha256").update(inputs.escalatorBytes).digest("hex"),
  );
  assert.equal(snapshot.rowsSha256, createHash("sha256").update(JSON.stringify(snapshot.rows)).digest("hex"));
  assert.equal(snapshot.scopeSha256, createHash("sha256").update(JSON.stringify(snapshot.scope)).digest("hex"));
  assert.deepEqual(snapshot.fieldsProvided, [
    "elevator", "escalator", "status", "verified_at",
  ]);
  assert.equal(snapshot.topologyLineages.length, 1);
  assert.deepEqual(snapshot.topologyLineages[0], {
    sourceId: "gwangju-transportation-route-topology",
    snapshotId: "gwangju-transportation-route-topology-20260720",
    contentSha256: inputs.topologySnapshot.contentSha256,
    lineId: LINE_ID,
  });
  assert.equal(snapshot.rows.every((row) => (
    row.lineId === LINE_ID
      && (row.elevator == null || Number.isInteger(row.elevator) && row.elevator >= 0)
      && (row.escalator == null || Number.isInteger(row.escalator) && row.escalator >= 0)
      && row.wheelchair_lift === null
  )), true);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.elevator, 0), 62);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.escalator, 0), 99);
  const byCode = Object.fromEntries(snapshot.rows.map((row) => [row.stationCode, row]));
  assert.equal(byCode["100"].stationName, "녹동");
  assert.equal(byCode["100"].elevator, null);
  assert.equal(byCode["100"].escalator, null);
  assert.equal(byCode["111"].stationName, "쌍촌");
  assert.ok(byCode["111"].elevator >= 1);
  assert.equal(byCode["111"].escalator, null);
  assert.equal(byCode["112"].stationName, "운천");
  assert.ok(byCode["112"].elevator >= 1);
  assert.equal(byCode["112"].escalator, null);
  assert.equal(byCode["117"].stationName, "광주송정");
  assert.ok(byCode["117"].elevator >= 1);
  assert.ok(byCode["117"].escalator >= 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("광주 accessibility collector는 schema·join·count 변조를 fail closed한다", async () => {
  const inputs = await loadInputs();

  assert.throws(() => parseGwangjuAccessibilityCsv({
    ...inputs,
    elevatorBytes: new Uint8Array(),
  }), /elevator CSV bytes/);

  const badHeader = Buffer.from("철도운영기관명,선명,역명\n광주교통공사,1호선,소태\n", "utf8");
  assert.throws(() => parseGwangjuAccessibilityCsv({
    ...inputs,
    elevatorBytes: badHeader,
  }), /missing column/);

  const badJoin = Buffer.from(
    "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량\n광주교통공사,1호선,존재하지않는역,1,위치,15,1000\n",
    "utf8",
  );
  assert.throws(() => parseGwangjuAccessibilityCsv({
    ...inputs,
    elevatorBytes: badJoin,
  }), /join failed/);

  // 원문 무결성은 materializer의 admission SHA 결속으로 검증한다.
  // parser는 선택된 topology의 실제 관측 행을 집계한다.
  const changedRows = Buffer.from(
    "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량\n광주교통공사,1호선,소태,1,위치,15,1000\n",
    "utf8",
  );
  const parsed = parseGwangjuAccessibilityCsv({
    ...inputs,
    elevatorBytes: changedRows,
  });
  assert.equal(parsed.reduce((sum, row) => sum + (row.elevator ?? 0), 0), 1);
  assert.equal(parsed.filter(({ elevator }) => elevator !== null).length, 1);
  assert.equal(parsed.length, inputs.topologySnapshot.scope.length);

  const badTopology = {
    ...inputs.topologySnapshot,
    contentSha256: "0".repeat(64),
  };
  assert.throws(() => collectGwangjuAccessibility({
    ...inputs,
    topologySnapshot: badTopology,
    now: new Date("2026-07-24T03:00:00.000Z"),
  }), /topology snapshot/);
});

test("광주 accessibility collector CLI는 absolute output 경로를 강제한다", async () => {
  await assert.rejects(runGwangjuAccessibilityCollector([
    "--elevator-input", ELEVATOR_CSV,
    "--escalator-input", ESCALATOR_CSV,
    "--inventory", path.join(root, "tools/datapack/source-inventory.json"),
    "--output", "relative.json",
    "--captured-at", "2026-07-24T03:00:00.000Z",
  ]), /collector arguments mismatch/);
});
