import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createHash } from "node:crypto";
import {
  buildLegacySampleToFullConsumedFieldsMigration,
  parseSeoulMetroLineData,
  projectSeoulMetroConsumedFields,
} from "./seoulmetro-line-data-parser.mjs";

test("strict parser accepts one lines declaration with trailing commas", () => {
  assert.deepEqual(parseSeoulMetroLineData('var lines = {"4":{"attr":{"data-label":"4호선"},},};'), {
    "4": { attr: { "data-label": "4호선" } },
  });
});

for (const value of [
  'var lines = {}; process.exit(1);',
  'var lines = {}; // comment',
  'var lines = {"x": undefined};',
  'lines = {};',
  'var lines = {"x": [1, 2};',
]) {
  test(`strict parser rejects non-data input: ${value.slice(0, 20)}`, () => {
    assert.throws(() => parseSeoulMetroLineData(value), /SeoulMetro line data/);
  });
}

test("strict parser rejects an oversized payload before parsing", () => {
  assert.throws(() => parseSeoulMetroLineData(`var lines = {"x":"${"a".repeat(1_000_001)}"};`), /size/);
});

test("strict parser applies nested, string, line, and node limits structurally", () => {
  assert.throws(() => parseSeoulMetroLineData(`var lines = ${"[".repeat(65)}${"]".repeat(65)}`), /limits/);
  assert.throws(() => parseSeoulMetroLineData(`var lines = {"x":"${"a".repeat(16_385)}"}`), /string limit/);
  assert.throws(() => parseSeoulMetroLineData(`var lines = {\n${"\n".repeat(50_000)}}`), /line limit/);
  assert.throws(() => parseSeoulMetroLineData(`var lines = [${"null,".repeat(100_000)}null]`), /limits/);
});

test("tracked cyberstation asset is accepted without executing it", async () => {
  const bytes = await readFile(new URL("../sources/seoulmetro-cyberstation-line-data-20260623.js", import.meta.url));
  const lines = parseSeoulMetroLineData(bytes.toString("utf8"));
  assert.equal(typeof lines, "object");
  assert.ok(Object.keys(lines).length > 10);
});

test("full consumed-field migration binds the historical sample without reconstructing it", async () => {
  const baseline = await readFile(new URL("../sources/seoulmetro-cyberstation-line-data-20260623.js", import.meta.url));
  const legacy = {
    sourceId: "seoulmetro-cyberstation-route-map", snapshotId: "legacy-head",
    rawSha256: "c".repeat(64), schemaFingerprint: "3".repeat(64),
    providerRecordHashes: Array.from({ length: 5 }, () => "a".repeat(64)),
  };
  const evidence = buildLegacySampleToFullConsumedFieldsMigration({
    legacyHead: legacy, baselineRawBytes: baseline, freshRawBytes: Buffer.from(baseline), snapshotId: "next-head",
  });
  assert.equal(evidence.migrationKind, "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS");
  assert.equal(evidence.newSnapshotId, "next-head");
  assert.deepEqual(evidence.legacyProviderRecordHashes, legacy.providerRecordHashes);
  assert.equal(evidence.retainedBaselineRawSha256, createHash("sha256").update(baseline).digest("hex"));
  assert.equal(evidence.fullProjectionRowCount, projectSeoulMetroConsumedFields(baseline.toString("utf8")).reduce((n, line) => n + line.stations.length, 0));
  const changed = Buffer.from(baseline.toString("utf8").replace("#9f6181", "#9f6182"));
  assert.throws(() => buildLegacySampleToFullConsumedFieldsMigration({ legacyHead: legacy, baselineRawBytes: baseline, freshRawBytes: changed, snapshotId: "next-head" }), /MATERIAL_CHANGE/);
});
