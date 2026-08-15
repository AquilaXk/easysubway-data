import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildApplicability, main } from "./build-current-capital-transfer-topology-applicability.mjs";

const execFileAsync = promisify(execFile);

test("current canonical 213-cell transfer applicability matrix is closed and non-production", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-applicability-"));
  const canonical = canonicalPack();
  const metrics = topologyMetrics(canonical);
  const canonicalPath = path.join(root, "canonical.json");
  const metricsPath = path.join(root, "metrics.json");
  const output = path.join(root, "applicability.json");
  await writeFile(canonicalPath, canonicalBytes(canonical));
  await writeFile(metricsPath, canonicalBytes(metrics));

  const result = await main([
    "--canonical-pack", canonicalPath,
    "--transfer-topology-metrics", metricsPath,
    "--output", output,
  ], { log: () => {} });

  assert.equal(result.artifactKind, "current-capital-transfer-topology-applicability-pre-candidate");
  assert.equal(result.productionUseAllowed, false);
  assert.equal(result.candidateBinding, null);
  assert.deepEqual(result.stateSummary, {
    APPLICABLE_TRANSFER_ENDPOINT: 27,
    NOT_APPLICABLE_IN_CANONICAL_PAIR_SET: 186,
  });
  assert.equal(result.cells.length, 213);
  assert.equal(result.cells.filter(({ state }) => state === "APPLICABLE_TRANSFER_ENDPOINT").length, 27);
  assert.equal(result.physicalPairCount, 15);
  assert.equal(result.directedMetricCount, 30);
  assert.deepEqual(result.metricProvenanceSummary, { DERIVED_RECIPROCAL: 2, OFFICIAL_SOURCE: 28 });
  assert.equal(result.canonicalIdentity.canonicalPackSha256, sha256(canonicalBytes(canonical)));
  assert.equal(result.transferTopologyMetricsIdentity.artifactSha256, metrics.artifactSha256);
  assert.equal(result.artifactSha256, sha256(canonicalBytes(without(result, "artifactSha256"))));
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
});

test("rehashed source and derived provenance drift fail closed without creating output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-applicability-invalid-"));
  const canonical = canonicalPack();
  const canonicalPath = path.join(root, "canonical.json");
  const metricsPath = path.join(root, "metrics.json");
  await writeFile(canonicalPath, canonicalBytes(canonical));
  const cases = [
    (metrics) => { metrics.sourceIdentity.sourceId = "alternate-source"; },
    (metrics) => { metrics.metrics.find(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL").derivedFrom.fromLineId = "line-a"; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const metrics = topologyMetrics(canonical);
    mutate(metrics);
    rehashMetrics(metrics);
    const output = path.join(root, `applicability-${index}.json`);
    await writeFile(metricsPath, canonicalBytes(metrics));
    await assert.rejects(main(["--canonical-pack", canonicalPath, "--transfer-topology-metrics", metricsPath, "--output", output], { log: () => {} }), /NO_GO/);
    await assert.rejects(readFile(output));
  }
});

test("parsed inputs must bind exactly to their canonical bytes", () => {
  const canonical = canonicalPack();
  const otherCanonical = canonicalPack();
  otherCanonical.packs[0].stations[0].nameKo = "다른 역";
  const metrics = topologyMetrics(otherCanonical);

  assert.throws(() => buildApplicability({
    canonicalPack: canonical,
    canonicalPackBytes: canonicalBytes(otherCanonical),
    transferTopologyMetrics: metrics,
    metricsBytes: canonicalBytes(metrics),
  }), /NO_GO parsed input binding mismatch/);
});

test("direct CLI invocation writes success JSON and malformed arguments leave no output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-applicability-cli-"));
  const canonical = canonicalPack();
  const metrics = topologyMetrics(canonical);
  const canonicalPath = path.join(root, "canonical.json");
  const metricsPath = path.join(root, "metrics.json");
  const output = path.join(root, "applicability.json");
  const script = fileURLToPath(new URL("./build-current-capital-transfer-topology-applicability.mjs", import.meta.url));
  await writeFile(canonicalPath, canonicalBytes(canonical));
  await writeFile(metricsPath, canonicalBytes(metrics));

  const { stdout } = await execFileAsync(process.execPath, [script,
    "--canonical-pack", canonicalPath,
    "--transfer-topology-metrics", metricsPath,
    "--output", output,
  ]);
  assert.deepEqual(JSON.parse(stdout), {
    cellCount: 213,
    stateSummary: { APPLICABLE_TRANSFER_ENDPOINT: 27, NOT_APPLICABLE_IN_CANONICAL_PAIR_SET: 186 },
    artifactSha256: JSON.parse(await readFile(output, "utf8")).artifactSha256,
  });

  const malformedOutput = path.join(root, "malformed.json");
  await assert.rejects(execFileAsync(process.execPath, [script, "--output", malformedOutput]), (error) => {
    assert.notEqual(error.code, 0);
    assert.equal(error.stdout, "");
    return true;
  });
  await assert.rejects(readFile(malformedOutput));
});

function canonicalPack() {
  const lines = ["line-a", "line-b", "line-c"];
  const stations = Array.from({ length: 199 }, (_, index) => ({ id: `station-${String(index).padStart(3, "0")}`, nameKo: `역${index}` }));
  const stationLines = [
    ...lines.map((lineId) => ({ stationId: stations[0].id, lineId })),
    ...Array.from({ length: 12 }, (_, index) => ([
      { stationId: stations[index + 1].id, lineId: "line-a" },
      { stationId: stations[index + 1].id, lineId: "line-b" },
    ])).flat(),
    ...stations.slice(13).map((station) => ({ stationId: station.id, lineId: "line-c" })),
  ];
  return {
    manifest: { channel: "production", activePack: { id: "capital", version: "1" } },
    packs: [{ id: "capital", version: "1", artifactKind: "production", schemaVersion: "1", stations, stationLines }],
  };
}

function topologyMetrics(canonical) {
  const pairs = [
    { stationId: "station-000", lineIds: ["line-a", "line-b"] },
    { stationId: "station-000", lineIds: ["line-a", "line-c"] },
    { stationId: "station-000", lineIds: ["line-b", "line-c"] },
    ...Array.from({ length: 12 }, (_, index) => ({ stationId: `station-${String(index + 1).padStart(3, "0")}`, lineIds: ["line-a", "line-b"] })),
  ];
  const metrics = pairs.flatMap(({ stationId, lineIds: [a, b] }, index) => [
    { stationId, fromLineId: a, toLineId: b, distanceMeters: index + 1, officialDurationSecondsReference: index + 1, durationRole: "REFERENCE_ONLY", sourceRecordSha256: "a".repeat(64), metricProvenance: index < 2 ? "DERIVED_RECIPROCAL" : "OFFICIAL_SOURCE", ...(index < 2 ? { derivedFrom: { stationId, fromLineId: b, toLineId: a, sourceRecordSha256: "a".repeat(64) } } : {}) },
    { stationId, fromLineId: b, toLineId: a, distanceMeters: index + 1, officialDurationSecondsReference: index + 1, durationRole: "REFERENCE_ONLY", sourceRecordSha256: "a".repeat(64), metricProvenance: "OFFICIAL_SOURCE" },
  ]).sort(compareMetric);
  const canonicalIdentity = { canonicalPackSha256: sha256(canonicalBytes(canonical)), stationLineCount: 213, stationCount: 199, physicalPairCount: 15 };
  const payload = { schemaVersion: 1, artifactKind: "current-transfer-topology-metrics", canonicalIdentity, sourceIdentity: sourceIdentity(), physicalPairs: pairs, metrics };
  return { ...payload, artifactSha256: sha256(canonicalJson(payload)) };
}

function sourceIdentity() { return { sourceId: "seoul-metro-transfer-distance-duration", endpointSha256: "a".repeat(64), capturedAt: "2026-08-15T00:00:00.000Z", freshnessDate: "2025-12-31", manifestSha256: "b".repeat(64), observationSha256: "c".repeat(64), rawSnapshotSha256: "d".repeat(64), rawSha256: "d".repeat(64), contentSha256: "e".repeat(64), schemaSha256: "f".repeat(64), rowCount: 145, sourceCandidateSha256: "1".repeat(64), kricProviderCatalogSha256: "2".repeat(64) }; }
function rehashMetrics(metrics) { metrics.artifactSha256 = sha256(canonicalJson(without(metrics, "artifactSha256"))); }

function compareMetric(left, right) { return [left.stationId, left.fromLineId, left.toLineId].join("\0").localeCompare([right.stationId, right.fromLineId, right.toLineId].join("\0")); }
function without(value, key) { const { [key]: _ignored, ...result } = value; return result; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(sortValue(value))}\n`); }
function canonicalJson(value) { return JSON.stringify(sortValue(value)); }
function sortValue(value) { if (Array.isArray(value)) return value.map(sortValue); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])); return value; }
