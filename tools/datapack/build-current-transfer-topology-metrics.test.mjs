import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "./build-current-transfer-topology-metrics.mjs";

test("current observation에서 15 physical pair / 30 directed metric을 deterministic하게 만든다", async () => {
  const fixture = await fixtureRoot();
  const output = path.join(fixture.root, "output.json");
  const result = await main(["--observation-directory", fixture.observationDirectory, "--output", output], {
    repositoryRoot: fixture.root,
    log: () => {},
  });
  assert.equal(result.physicalPairs.length, 15);
  assert.equal(result.metrics.length, 30);
  assert.deepEqual(countBy(result.metrics, "metricProvenance"), { DERIVED_RECIPROCAL: 2, OFFICIAL_SOURCE: 28 });
  const derived = result.metrics.filter(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL");
  assert.deepEqual(derived.map(({ distanceMeters, officialDurationSecondsReference, stationId }) => ({ distanceMeters, officialDurationSecondsReference, stationId })), [
    { distanceMeters: 17, officialDurationSecondsReference: 14, stationId: "station-b35616704ce3" },
    { distanceMeters: 214, officialDurationSecondsReference: 178, stationId: "station-gangnam" },
  ]);
  assert.ok(derived.every(({ derivedFrom }) => derivedFrom && typeof derivedFrom.sourceRecordSha256 === "string"));
  assert.deepEqual(derived.map(({ derivedFrom, fromLineId, stationId, toLineId }) => ({ stationId, fromLineId, toLineId, observedFromLineId: derivedFrom.fromLineId, observedToLineId: derivedFrom.toLineId })), [
    { stationId: "station-b35616704ce3", fromLineId: "seoul-2", toLineId: "line-80fc4d5350d4", observedFromLineId: "line-80fc4d5350d4", observedToLineId: "seoul-2" },
    { stationId: "station-gangnam", fromLineId: "shinbundang", toLineId: "seoul-2", observedFromLineId: "seoul-2", observedToLineId: "shinbundang" },
  ]);
  assert.ok(result.metrics.every(({ durationRole }) => durationRole === "REFERENCE_ONLY"));
  assert.equal(result.runtimeCost, undefined);
  const bytes = await readFile(output, "utf8");
  assert.equal(bytes, `${JSON.stringify(sortValue(result))}\n`);
  assert.equal(sha256(JSON.stringify(sortValue(without(result, "artifactSha256")))), result.artifactSha256);

  const repeated = path.join(fixture.root, "repeat.json");
  await main(["--observation-directory", fixture.observationDirectory, "--output", repeated], { repositoryRoot: fixture.root, log: () => {} });
  assert.equal(await readFile(repeated, "utf8"), bytes);
});

test("frozen F1-F4 drift는 output 없이 NO_GO다", async () => {
  for (const mutate of [
    (fixture) => { fixture.rows.find((row) => row["환승역명"] === "환승01" && row["호선"] === "2호선")["환승거리"] = 121; },
    (fixture) => { const row = fixture.rows.find((entry) => entry["환승역명"] === "까치산"); [row["호선"], row["환승노선"]] = [row["환승노선"], row["호선"]]; },
    (fixture) => { fixture.rows.find((row) => row["환승역명"] === "강남")["환승역명"] = "다른강남"; },
    (fixture) => { fixture.kric.providerLines[0].operatorName = "다른 운영사"; },
    (fixture) => { fixture.kric.providerLines.push({ railOprIsttCd: "DX", operatorName: "네오트랜스주식회사", lnCd: "D1", lineName: "신분당" }); },
    (fixture) => { fixture.manifest.freshnessDate = "2026-12-31"; },
    (fixture) => { fixture.canonical.manifest.channel = "preview"; },
    (fixture) => { fixture.canonical.manifest.activePack.version = "2"; },
  ]) {
    const fixture = await fixtureRoot(mutate);
    const output = path.join(fixture.root, "output.json");
    await assert.rejects(main(["--observation-directory", fixture.observationDirectory, "--output", output], { repositoryRoot: fixture.root, log: () => {} }), /NO_GO|mismatch|identity|alias|observation|reciprocal/i);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
});

test("KRIC provider catalog raw hash는 artifact identity와 self hash에 결속한다", async () => {
  const first = await fixtureRoot();
  const second = await fixtureRoot((fixture) => { fixture.kric.providerLines.push({ railOprIsttCd: "ZZ", operatorName: "다른 운영사", lnCd: "Z1", lineName: "다른 노선" }); });
  const [left, right] = await Promise.all([
    main(["--observation-directory", first.observationDirectory, "--output", path.join(first.root, "output.json")], { repositoryRoot: first.root, log: () => {} }),
    main(["--observation-directory", second.observationDirectory, "--output", path.join(second.root, "output.json")], { repositoryRoot: second.root, log: () => {} }),
  ]);
  assert.notEqual(left.sourceIdentity.kricProviderCatalogSha256, right.sourceIdentity.kricProviderCatalogSha256);
  assert.notEqual(left.artifactSha256, right.artifactSha256);
});

async function fixtureRoot(mutate = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-topology-metrics-"));
  const observationDirectory = path.join(root, "observation");
  const canonical = canonicalPack();
  const sourceCandidates = { candidates: [{ id: "seoul-metro-transfer-distance-duration", requestUrl: "https://api.odcloud.kr/api/15044419/v1/uddi:7008c675-928f-41d6-9a01-b3541f78466b", operation: { method: "GET", endpoint: "https://api.odcloud.kr/api/15044419/v1/uddi:7008c675-928f-41d6-9a01-b3541f78466b" }, evidence: { outputFields: ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"] } }] };
  const kric = { providerLines: [{ railOprIsttCd: "DX", operatorName: "네오트랜스주식회사", lnCd: "D1", lineName: "신분당" }] };
  const providerRows = observationRows();
  const rows = sortRows(providerRows);
  const fixture = { canonical, kric, manifest: {}, rows, sourceCandidates };
  const raw = rawSnapshot(providerRows);
  fixture.manifest = {
    artifactKind: "seoul-transfer-distance-duration-snapshot-manifest", sourceId: "seoul-metro-transfer-distance-duration",
    endpointSha256: sha256(sourceCandidates.candidates[0].requestUrl), capturedAt: "2026-08-15T00:00:00.000Z", freshnessDate: "2025-12-31",
    rowCount: rows.length, rawSha256: sha256(snapshotBytes(raw)), contentSha256: sha256(snapshotBytes(rows)),
    schemaSha256: sha256(snapshotBytes({ fields: ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"] })), credentialRedacted: true,
  };
  mutate(fixture);
  const observation = { artifactKind: "seoul-transfer-distance-duration-observation", sourceId: "seoul-metro-transfer-distance-duration", capturedAt: fixture.manifest.capturedAt, rowCount: rows.length, rawSha256: fixture.manifest.rawSha256, contentSha256: fixture.manifest.contentSha256, rows, credentialRedacted: true };
  await mkdir(path.join(root, "tools/datapack/release"), { recursive: true });
  await mkdir(path.join(root, "tools/datapack/sources"), { recursive: true });
  await writeFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), `${JSON.stringify(canonical)}\n`);
  await writeFile(path.join(root, "tools/datapack/source-candidates.json"), `${JSON.stringify(sourceCandidates)}\n`);
  await writeFile(path.join(root, "tools/datapack/sources/kric-provider-code-catalog-20260228.json"), `${JSON.stringify(kric)}\n`);
  await mkdir(observationDirectory);
  await writeFile(path.join(observationDirectory, "manifest.json"), `${JSON.stringify(fixture.manifest)}\n`);
  await writeFile(path.join(observationDirectory, "observation.json"), `${JSON.stringify(observation)}\n`);
  await writeFile(path.join(observationDirectory, "raw-snapshot.json"), snapshotBytes(raw));
  return { ...fixture, root, observationDirectory };
}

function canonicalPack() {
  const transferStations = ["까치산", "강남", "환승01", "환승02", "환승03", "환승04", "환승05", "환승06", "환승07", "환승08", "환승09", "환승10", "환승11"];
  const stations = [...transferStations, ...Array.from({ length: 186 }, (_, index) => `일반${index}`)].map((name) => ({ id: `station-${name === "까치산" ? "b35616704ce3" : name === "강남" ? "gangnam" : name}`, nameKo: name }));
  const lines = [["seoul-2", "수도권 2호선"], ["seoul-4", "수도권 4호선"], ["line-80fc4d5350d4", "수도권 5호선"], ["line-3f41718e0833", "수도권 6호선"], ["shinbundang", "수도권 신분당"]].map(([id, nameKo]) => ({ id, nameKo, operatorId: "seoul-metro" }));
  const pairLines = [["seoul-2", "line-80fc4d5350d4"], ["seoul-2", "shinbundang"], ["seoul-2", "seoul-4", "line-80fc4d5350d4"], ...Array.from({ length: 10 }, (_, index) => [["seoul-2", "seoul-4"], ["seoul-4", "line-80fc4d5350d4"], ["line-80fc4d5350d4", "line-3f41718e0833"]][index % 3])];
  const stationLines = pairLines.flatMap((lineIds, index) => lineIds.map((lineId) => ({ stationId: stations[index].id, lineId })));
  stationLines.push(...stations.slice(13).map((station, index) => ({ stationId: station.id, lineId: lines[index % lines.length].id })));
  return { manifest: { manifestVersion: 2, channel: "production", keyId: "test", ttlSeconds: 1, activePack: { id: "capital", version: "1" } }, migrationSourceArtifact: { gzipSha256: "a".repeat(64), sqliteSha256: "b".repeat(64) }, packs: [{ id: "capital", version: "1", artifactKind: "production", schemaVersion: "1", metadata: { productionCoverageEvidence: JSON.stringify([{ regionId: "capital", operatorId: "seoul-metro", sourceDomain: "station_line_membership" }]) }, stations, lines, stationLines, networkEdges: [{ id: "edge", edgeType: "RIDE" }], operators: [{ id: "seoul-metro", nameKo: "서울교통공사" }] }] };
}

function observationRows() {
  const pairs = [["까치산", "5호선", "2호선", 17], ["강남", "2호선", "신분당선", 214], ["환승01", "2호선", "4호선", 120], ["환승01", "2호선", "5호선", 120], ["환승01", "4호선", "5호선", 120], ...Array.from({ length: 10 }, (_, index) => [`환승${String(index + 2).padStart(2, "0")}`, ["2호선", "4호선", "5호선"][index % 3], ["4호선", "5호선", "6호선"][index % 3], 120])];
  const rows = [];
  for (const [station, from, to, distance] of pairs) {
    const missing = (station === "까치산" && from === "5호선") || (station === "강남" && to === "신분당선");
    rows.push(row(station, from, to, distance));
    if (!missing) rows.push(row(station, to, from, distance));
  }
  while (rows.length < 145) rows.push(row(`기타${rows.length}`, "9호선", "8호선", 120));
  return rows.map((value, index) => ({ ...value, "연번": index + 1 }));
}
function row(station, from, to, distance) { return { "호선": from, "환승역명": station, "환승노선": to, "환승거리": distance, "환승소요시간": duration(distance) }; }
function rawSnapshot(rows) { const page = (number, data) => { const envelope = { currentCount: data.length, data, matchCount: 145, page: number, perPage: 100, totalCount: 145 }; const bytes = Buffer.from(JSON.stringify(envelope)); return { page: number, perPage: 100, sha256: sha256(bytes), base64: bytes.toString("base64") }; }; return { artifactKind: "seoul-transfer-distance-duration-raw-snapshot", sourceId: "seoul-metro-transfer-distance-duration", pages: [page(1, rows.slice(0, 100)), page(2, rows.slice(100))] }; }
function duration(distance) { const seconds = Math.round(distance / 1.2); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function countBy(values, key) { return Object.fromEntries([...new Set(values.map((value) => value[key]))].sort().map((entry) => [entry, values.filter((value) => value[key] === entry).length])); }
function without(value, key) { const { [key]: _ignored, ...rest } = value; return rest; }
function sortValue(value) { if (Array.isArray(value)) return value.map(sortValue); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])); return value; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(sortValue(value))}\n`); }
function snapshotBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
function sortRows(rows) { return [...rows].sort((left, right) => Buffer.compare(Buffer.from(["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"].map((field) => left[field]).join("\0")), Buffer.from(["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"].map((field) => right[field]).join("\0")))); }
