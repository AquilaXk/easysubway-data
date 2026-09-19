import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { after } from "node:test";
import os from "node:os";
import path from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function createCurrentMolitObservationFixture(normalizedProjection = [
  { region_code: "01", region_name: "수도권", operator_name: "운영사", line_name: "1호선", station_name: "가역", station_sequence: 1 },
  { region_code: "01", region_name: "수도권", operator_name: "운영사", line_name: "1호선", station_name: "나역", station_sequence: 2 },
]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-molit-observation-"));
  after(() => rm(root, { recursive: true, force: true }));
  const snapshotId = "molit-urban-rail-full-route-current-test";
  const rawSha256 = sha256("raw");
  const contentSha256 = sha256(Buffer.from(`${JSON.stringify(normalizedProjection)}\n`));
  const schemaFingerprint = sha256("schema");
  const providerRecordHashes = normalizedProjection.map((record) => sha256(JSON.stringify(record)));
  const observation = {
    artifactKind: "public-static-network-v2-observation",
    sourceId: "molit-urban-rail-full-route", snapshotId, capturedAt: "2026-08-27T00:00:00.000Z",
    rawSha256, contentSha256, schemaFingerprint, rowCount: normalizedProjection.length,
    providerRecordHashes, normalizedProjection,
  };
  const observationBytes = Buffer.from(JSON.stringify(observation));
  const current = {
    snapshotId, sourceId: observation.sourceId, retrievedAt: observation.capturedAt, sourceUpdatedAt: null,
    rawSha256, contentSha256, normalizedObservationSha256: sha256(observationBytes), schemaFingerprint,
    redactedRequestFingerprint: sha256("request"), rowCount: normalizedProjection.length,
    coverageCount: normalizedProjection.length, previousSnapshotId: null, diffSummary: null,
    snapshotStatus: "LOCKED", fetchStatus: "SUCCESS", schemaStatus: "PASS", licenseStatus: "PASS",
    redistributionAllowed: true, credentialRedacted: true, providerRecordHashes,
  };
  const inventory = { sources: [{ id: observation.sourceId, admissionEvidence: { sourceId: observation.sourceId, decision: "APPROVED", snapshotId, rawSha256 } }] };
  await mkdir(path.join(root, "tools/datapack/sources"), { recursive: true });
  await mkdir(path.join(root, "tools/datapack/release"), { recursive: true });
  await writeFile(path.join(root, "tools/datapack/source-inventory.json"), JSON.stringify(inventory));
  await writeFile(path.join(root, "tools/datapack/release/source-snapshots.json"), JSON.stringify([current]));
  await writeFile(path.join(root, `tools/datapack/sources/${snapshotId}.json`), observationBytes);
  return { root, observation, current, inventory };
}
