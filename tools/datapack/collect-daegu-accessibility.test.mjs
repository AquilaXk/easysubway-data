import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { DAEGU_LINES } from "./collect-daegu-datapack-sources.mjs";
import {
  collectDaeguAccessibility,
  parseDaeguAccessibilityCsv,
  runDaeguAccessibilityCollector,
} from "./collect-daegu-accessibility.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE_CSV = path.join(root, "tools/datapack/fixtures/daegu-accessibility-raw/data-go-15149872.csv");
const LINE_IDS = Object.freeze(DAEGU_LINES.map(({ lineId }) => lineId));

async function loadTopologySnapshots() {
  const entries = await Promise.all(DAEGU_LINES.map(async (line) => {
    const snapshot = JSON.parse(await readFile(
      path.join(root, `tools/datapack/sources/daegu-line${line.lineNumber}-route-topology-20260721.json`),
      "utf8",
    ));
    return [line.lineNumber, snapshot];
  }));
  return Object.fromEntries(entries);
}

test("대구 accessibility collector는 공식 CSV 94역을 topology에 join한다", async () => {
  const facilitiesBytes = await readFile(FIXTURE_CSV);
  const topologySnapshots = await loadTopologySnapshots();
  const snapshot = collectDaeguAccessibility({
    facilitiesBytes,
    topologySnapshots,
    now: new Date("2026-07-24T01:00:00.000Z"),
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.artifactKind, "daegu-accessibility-snapshot");
  assert.equal(snapshot.sourceId, "daegu-transportation-accessibility");
  assert.equal(snapshot.datasetId, "15149872");
  assert.equal(snapshot.detailUrl, "https://www.data.go.kr/data/15149872/fileData.do");
  assert.equal(snapshot.stationCount, 94);
  assert.equal(snapshot.rowCount, 94);
  assert.equal(snapshot.rows.length, 94);
  assert.deepEqual(snapshot.lineIds, [...LINE_IDS]);
  assert.equal(snapshot.official, true);
  assert.equal(snapshot.fixture, false);
  assert.equal(snapshot.credentialRequired, false);
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.capturedAt, "2026-07-24T01:00:00.000Z");
  assert.equal(snapshot.freshUntil, "2026-07-25T01:00:00.000Z");
  assert.equal(snapshot.rawSha256, createHash("sha256").update(facilitiesBytes).digest("hex"));
  assert.equal(snapshot.rowsSha256, createHash("sha256").update(JSON.stringify(snapshot.rows)).digest("hex"));
  assert.equal(snapshot.scopeSha256, createHash("sha256").update(JSON.stringify(snapshot.scope)).digest("hex"));
  assert.deepEqual(snapshot.fieldsProvided, [
    "elevator", "escalator", "wheelchair_lift", "status", "verified_at",
  ]);
  assert.equal(snapshot.topologyLineages.length, 3);
  assert.deepEqual(
    snapshot.topologyLineages.map(({ sourceId, lineId }) => ({ sourceId, lineId })),
    DAEGU_LINES.map(({ lineNumber, lineId }) => ({
      sourceId: `daegu-line${lineNumber}-route-topology`,
      lineId,
    })),
  );
  assert.equal(snapshot.rows.every((row) => (
    LINE_IDS.includes(row.lineId)
      && Number.isInteger(row.elevator) && row.elevator >= 0
      && Number.isInteger(row.escalator) && row.escalator >= 0
      && Number.isInteger(row.wheelchair_lift) && row.wheelchair_lift >= 0
  )), true);
  assert.deepEqual({
    1: snapshot.rows.filter(({ lineId }) => lineId === LINE_IDS[0]).length,
    2: snapshot.rows.filter(({ lineId }) => lineId === LINE_IDS[1]).length,
    3: snapshot.rows.filter(({ lineId }) => lineId === LINE_IDS[2]).length,
  }, { 1: 35, 2: 29, 3: 30 });
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/i);
});

test("대구 accessibility collector는 schema·join·count 변조를 fail closed한다", async () => {
  const facilitiesBytes = await readFile(FIXTURE_CSV);
  const topologySnapshots = await loadTopologySnapshots();

  assert.throws(() => parseDaeguAccessibilityCsv(new Uint8Array(), topologySnapshots), /CSV bytes/);

  const badHeader = Buffer.from("호선,역명,엘리베이터(대)\n01,설화명곡,1\n", "utf8");
  assert.throws(() => parseDaeguAccessibilityCsv(badHeader, topologySnapshots), /missing column/);

  const badJoin = Buffer.from(
    "호선,역명,휠체어리프트(대),엘리베이터(대),에스컬레이터(대)\n01,존재하지않는역,0,1,1\n",
    "utf8",
  );
  assert.throws(() => parseDaeguAccessibilityCsv(badJoin, topologySnapshots), /join failed/);

  const truncated = Buffer.from(
    "호선,역명,휠체어리프트(대),엘리베이터(대),에스컬레이터(대)\n01,설화명곡,0,4,16\n",
    "utf8",
  );
  assert.throws(() => parseDaeguAccessibilityCsv(truncated, topologySnapshots), /station count/);

  const badTopology = {
    ...topologySnapshots,
    1: { ...topologySnapshots[1], contentSha256: "0".repeat(64) },
  };
  assert.throws(() => collectDaeguAccessibility({
    facilitiesBytes,
    topologySnapshots: badTopology,
    now: new Date("2026-07-24T01:00:00.000Z"),
  }), /topology snapshot/);
});

test("대구 accessibility collector CLI는 absolute output 경로를 강제한다", async () => {
  await assert.rejects(runDaeguAccessibilityCollector([
    "--input", FIXTURE_CSV,
    "--sources-dir", path.join(root, "tools/datapack/sources"),
    "--output", "relative.json",
  ]), /usage: collect-daegu-accessibility/);
});
