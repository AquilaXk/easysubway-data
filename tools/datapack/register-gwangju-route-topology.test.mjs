import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectGwangjuRouteTopology } from "./collect-gwangju-route-topology.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import { prepareGwangjuTopologyRegistration, publishAndRegisterGwangjuTopology, registerGwangjuTopology } from "./register-gwangju-route-topology.mjs";

test("register retained Gwangju response bytes through the existing source transaction", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gwangju-register-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceId = "gwangju-transportation-route-topology";
  const now = new Date("2025-01-02T00:00:00.000Z");
  const license = { redistributionAllowed: true, evidenceUrl: "https://example.org/license" };
  const termsHash = createHash("sha256").update(canonicalJson(license)).digest("hex");
  const source = { id: sourceId, provider: "GRTC", datasetUrl: "https://example.org/dataset",
    productionUseAllowed: true, requiredForProductionPack: false, license,
    topologyAdmissionEvidence: { snapshotId: "previous", snapshotPath: "previous.json" } };
  const entry = { sourceId, sourceClassId: "route_graph_topology", retentionClassId: "standard-90d",
    ownerRole: "data-owner", stewardRole: "data-steward", approvalRole: "data-owner", escalationHours: 24, alertRoute: "data-owner",
    licenseReview: { status: "APPROVED", termsHash, termsUrl: license.evidenceUrl, reviewedProvider: source.provider,
      reviewedDatasetUrl: source.datasetUrl, reviewedAt: "2025-01-01T00:00:00.000Z", nextReviewAt: "2025-02-01T00:00:00.000Z",
      redistributionScopes: ["DERIVED_DATAPACK"], approvedByRole: "data-owner" } };
  const governance = { schemaVersion: 1, artifactKind: "datapack-source-governance-policy", policyVersion: "2025-01-01",
    sources: [entry], retentionClasses: [{ id: "standard-90d", retentionDays: 90 }],
    reasonCodeEscalations: [{ responsibleRole: "data-owner", alertRoute: "data-owner", escalationHours: 24,
      reasonCodes: ["SOURCE_LINEAGE_BROKEN", "SOURCE_DIFF_MISSING", "SOURCE_FRESHNESS_POLICY_MISSING", "SOURCE_SNAPSHOT_EXPIRED",
        "RAW_RETENTION_OVERDUE", "LEGAL_HOLD_INVALID", "LICENSE_REVIEW_REQUIRED", "REDISTRIBUTION_NOT_APPROVED", "SOURCE_GOVERNANCE_OWNER_MISSING"] }] };
  const freshness = { sourceClasses: [{ id: "route_graph_topology", sourceIds: [sourceId], basisField: "retrievedAt", reverificationCadence: "P1D" }] };
  const initial = [{ sources: [source] }, [], governance, freshness];
  for (const [index, relative] of SOURCE_REGISTRATION_OUTPUTS.entries()) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), `${JSON.stringify(initial[index], null, 2)}\n`);
  }
  await mkdir(path.join(root, "tools/datapack/sources"), { recursive: true });
  const scope = [{ providerStationId: "1", stationCode: "100", stationName: "가" }, { providerStationId: "3", stationCode: "105", stationName: "나" }];
  const snapshot = await collectGwangjuRouteTopology({ stationScope: scope, now,
    fetchImpl: async (url) => {
      const start = scope.find((row) => row.providerStationId === new URL(url).searchParams.get("station_id"));
      const end = scope.find((row) => row !== start);
      return Response.json([{ start_station_id: start.providerStationId, start_station_name: start.stationName,
        end_station_id: end.providerStationId, end_station_name: end.stationName, station_distance: 1, station_time: 2 }]);
    },
  });
  const snapshotPath = path.join(root, "collected.json"), receiptPath = path.join(root, "receipt.json");
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  const options = { repositoryRoot: root, snapshotPath, receiptPath, now };
  const prepared = await prepareGwangjuTopologyRegistration(options);
  const receipt = { sourceId, snapshotId: prepared.snapshotId, rawObjectSha256: prepared.snapshotSha256,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${prepared.objectKey}`, byteSize: prepared.snapshotBytes.length,
    storedAt: now.toISOString(), rawRetentionExpiresAt: prepared.rawRetentionExpiresAt };
  await writeFile(receiptPath, JSON.stringify({ ...receipt, rawObjectSha256: "0".repeat(64) }));
  await assert.rejects(registerGwangjuTopology(options), /OCI receipt binding/);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, SOURCE_REGISTRATION_OUTPUTS[1]), "utf8")), []);
  let storedBytes;
  const calls = [];
  const expectedHeadSha = "a".repeat(40);
  const verifiedReceiptPath = path.join(root, "verified-receipt.json");
  await publishAndRegisterGwangjuTopology({ ...options, receiptPath: verifiedReceiptPath, expectedHeadSha,
    gitRunner: async () => expectedHeadSha,
    env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test-only/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
    client: {
      putObjectIfAbsent: async (_key, bytes) => { calls.push("PUT"); storedBytes = Buffer.from(bytes); return true; },
      readObject: async () => { calls.push("GET"); return { exists: true, body: storedBytes }; },
    },
  });
  assert.deepEqual(calls, ["PUT", "GET"]);
  assert.equal(JSON.parse(await readFile(verifiedReceiptPath, "utf8")).rawObjectSha256, prepared.snapshotSha256);
  const [inventory, ledger] = await Promise.all(SOURCE_REGISTRATION_OUTPUTS.slice(0, 2).map(async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"))));
  assert.equal(inventory.sources[0].topologyAdmissionEvidence.snapshotId, prepared.snapshotId);
  assert.equal(ledger[0].rawObjectSha256, prepared.snapshotSha256);
  assert.equal(ledger[0].rawSha256, snapshot.rawSha256);
  assert.equal(ledger[0].freshUntil, snapshot.freshUntil);
  assert.deepEqual(await readFile(path.join(root, inventory.sources[0].topologyAdmissionEvidence.snapshotPath)), prepared.snapshotBytes);
});
