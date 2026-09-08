import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BUSAN_LINES, admitBusanRouteTopology, collectBusanRouteTopology } from "./collect-busan-route-topology.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { canonicalStationMappingHash, parseCanonicalBusanStationMappings } from "./materialize-busan-route-topology.mjs";

import { SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import * as registration from "./register-busan-route-topology.mjs";
import {
  buildBusanTopologyRegistrationOutputs,
  prepareBusanTopologyRegistration,
} from "./register-busan-route-topology.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const sourceId = "busan-transportation-route-topology";
const now = new Date("2025-01-02T00:00:00.000Z");

test("register retained Busan topology through source transaction", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "busan-topology-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = BUSAN_LINES.flatMap(({ lineNumber, lineId }) => [1, 2].map((stop) => ({
    stationCode: `${lineNumber}0${stop}`, stationName: `역${lineNumber}${stop}`, lineId,
    neighborCodes: [`${lineNumber}0${3 - stop}`],
  })));
  const collectedSnapshot = await collectBusanRouteTopology({ serviceKey: "test-key", stationScopes: scope, now,
    fetchImpl: async (url) => {
      const from = scope.find(({ stationCode }) => stationCode === new URL(url).searchParams.get("scode"));
      const to = scope.find(({ stationCode }) => stationCode === from.neighborCodes[0]);
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><item>`
        + `<startSn>${from.stationName}</startSn><startSc>${from.stationCode}</startSc>`
        + `<endSn>${to.stationName}</endSn><endSc>${to.stationCode}</endSc>`
        + `<dist>10</dist><time>90</time><stoppingTime>20</stoppingTime><exchange>N</exchange>`
        + `</item></body><numOfRows>1</numOfRows><pageNo>1</pageNo><totalCount>1</totalCount></response>`,
      { headers: { "content-type": "application/xml" } });
    } });
  const snapshot = {
    ...collectedSnapshot,
    admission: admitBusanRouteTopology(collectedSnapshot, { now }),
  };
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  const snapshotPath = path.join(root, "retained-busan.json");
  await writeFile(snapshotPath, snapshotBytes);
  const stationMapPath = path.join(root, "busan-station-map.csv");
  const stationMapCsv = scope.map(({ lineId, stationName }, index) =>
    `"부산권",station-${(index + 1).toString(16).padStart(12, "0")},${lineId},"${stationName}"`).join("\n");
  await writeFile(stationMapPath, stationMapCsv);

  const source = { id: sourceId, provider: "Test operator", datasetUrl: "https://example.org/dataset",
    productionUseAllowed: true, requiredForProductionPack: false,
    license: { redistributionAllowed: true, evidenceUrl: "https://example.org/license" },
    membershipAdmissionEvidence: {
      issue: 1,
      materializer: "fixture-membership-materializer",
      verificationTest: "fixture-membership-test",
    } };
  const termsHash = sha(canonicalJson(source.license));
  const governanceEntry = {
    sourceId,
    sourceClassId: "route_graph_topology",
    retentionClassId: "standard-90d",
    ownerRole: "data-owner",
    stewardRole: "data-steward",
    approvalRole: "data-owner",
    escalationHours: 24,
    alertRoute: "data-owner",
    licenseReview: {
      status: "APPROVED",
      termsHash,
      termsUrl: source.license.evidenceUrl,
      reviewedProvider: source.provider,
      reviewedDatasetUrl: source.datasetUrl,
      reviewedAt: new Date(now.valueOf() - 86_400_000).toISOString(),
      nextReviewAt: new Date(now.valueOf() + 86_400_000).toISOString(),
      redistributionScopes: ["DERIVED_DATAPACK"],
      approvedByRole: "data-owner",
    },
  };
  // 승인된 source 정책과 아직 없는 snapshot ledger를 독립 입력으로 둔다.
  // 정책의 최초 승인 계보는 기존 append-only policy 검증이 소유한다.
  const governance = governanceFixture(governanceEntry);
  const freshness = { sourceClasses: [{
    id: governanceEntry.sourceClassId,
    sourceIds: [],
    basisField: "retrievedAt",
    reverificationCadence: "P1D",
  }] };
  const inventory = { sources: [source] };
  const candidate = { candidates: [{ id: sourceId, domain: "route_graph_topology", registrationMetadata: { governance: governanceEntry } }] };
  for (const [index, relative] of SOURCE_REGISTRATION_OUTPUTS.entries()) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), `${JSON.stringify([inventory, [], governance, freshness][index], null, 2)}\n`);
  }
  await mkdir(path.join(root, "tools/datapack/sources"), { recursive: true });
  await writeFile(path.join(root, "tools/datapack/source-candidates.json"), `${JSON.stringify(candidate)}\n`);

  const env = { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/" };
  let receiptPath = path.join(root, "receipt.json");
  const options = { repositoryRoot: root, snapshotPath, stationMapPath, receiptPath, now, env };
  const prepared = await prepareBusanTopologyRegistration(options);
  const receipt = receiptFor(prepared);
  await writeFile(receiptPath, `${JSON.stringify({ ...receipt, rawObjectSha256: "0".repeat(64) })}\n`);
  await assert.rejects(buildBusanTopologyRegistrationOutputs(options), /OCI receipt binding/);

  assert.equal(typeof registration.publishAndRegisterBusanTopology, "function");
  receiptPath = path.join(root, "published-receipt.json");
  const calls = [];
  let storedBytes;
  await registration.publishAndRegisterBusanTopology({ ...options, receiptPath,
    expectedHeadSha: "a".repeat(40), gitRunner: async () => "a".repeat(40),
    client: {
      putObjectIfAbsent: async (_key, bytes) => { calls.push("PUT"); storedBytes = Buffer.from(bytes); return true; },
      readObject: async () => { calls.push("GET"); return { exists: true, body: storedBytes }; },
    },
  });
  assert.deepEqual(calls, ["PUT", "GET"]);
  assert.deepEqual(storedBytes, snapshotBytes);
  const [registeredInventory, registeredLedger, registeredGovernance, registeredFreshness] = await Promise.all(SOURCE_REGISTRATION_OUTPUTS
    .map(async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"))));
  assert.equal(registeredInventory.sources[0].topologyAdmissionEvidence.snapshotId, prepared.snapshotId);
  assert.deepEqual(registeredInventory.sources[0].membershipAdmissionEvidence, {
    issue: source.membershipAdmissionEvidence.issue,
    materializer: source.membershipAdmissionEvidence.materializer,
    verificationTest: source.membershipAdmissionEvidence.verificationTest,
    snapshotId: prepared.snapshotId,
    verifiedAt: snapshot.capturedAt,
    stationCount: snapshot.stationCount,
    lineIds: snapshot.lineIds,
    membershipSourceId: sourceId,
    membershipSourceRawSha256: snapshot.rawSha256,
    membershipSourceSnapshotSha256: snapshot.scopeSha256,
    mappingSha256: canonicalStationMappingHash(parseCanonicalBusanStationMappings(stationMapCsv), snapshot.scope),
    stationCodesSha256: sha(JSON.stringify(snapshot.scope.map(({ stationCode }) => stationCode))),
    stationCodeSourceId: sourceId,
    stationCodeSnapshotId: prepared.snapshotId,
    stationCodeContentSha256: snapshot.contentSha256,
  });
  assert.equal(registeredInventory.sources[0].requiredForProductionPack, true);
  assert.equal(registeredLedger[0].rawObjectSha256, prepared.snapshotSha256);
  assert.equal(registeredLedger[0].rawReceiptSha256, sha(await readFile(receiptPath)));
  assert.deepEqual(registeredGovernance.sources, [governanceEntry]);
  assert.deepEqual(registeredFreshness.sourceClasses[0].sourceIds, [sourceId]);
  assert.deepEqual(await readFile(path.join(root, registeredInventory.sources[0].topologyAdmissionEvidence.snapshotPath)), snapshotBytes);
});

function governanceFixture(entry) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-source-governance-policy",
    policyVersion: now.toISOString().slice(0, 10),
    sources: [entry],
    retentionClasses: [{ id: "standard-90d", retentionDays: 90 }],
    reasonCodeEscalations: [{
      responsibleRole: "data-owner",
      alertRoute: "data-owner",
      escalationHours: 24,
      reasonCodes: [
        "SOURCE_LINEAGE_BROKEN", "SOURCE_DIFF_MISSING", "SOURCE_FRESHNESS_POLICY_MISSING",
        "SOURCE_SNAPSHOT_EXPIRED", "RAW_RETENTION_OVERDUE", "LEGAL_HOLD_INVALID",
        "LICENSE_REVIEW_REQUIRED", "REDISTRIBUTION_NOT_APPROVED", "SOURCE_GOVERNANCE_OWNER_MISSING",
      ],
    }],
  };
}

function receiptFor(prepared) {
  const date = prepared.snapshot.capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${sourceId}/${date}/${prepared.snapshotSha256}.json`;
  return {
    schemaVersion: 1,
    artifactKind: "static-network-source-raw-object-receipt",
    sourceId,
    snapshotId: prepared.snapshotId,
    capturedAt: prepared.snapshot.capturedAt,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`,
    rawObjectSha256: prepared.snapshotSha256,
    byteSize: prepared.snapshotBytes.length,
    storedAt: now.toISOString(),
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    ociNamespace: "axvym6vk8g7i",
    bucket: "easysubway-datapacks",
    objectKey,
    contentType: "application/json",
  };
}
