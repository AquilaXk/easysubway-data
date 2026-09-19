import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectGwangjuAccessibility } from "./collect-gwangju-accessibility.mjs";
import { collectGwangjuRouteTopology } from "./collect-gwangju-route-topology.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import {
  buildRegionalAccessibilityRegistrationOutputs,
  prepareRegionalAccessibilityRegistration,
  registerRegionalAccessibility,
} from "./register-regional-accessibility.mjs";

const SOURCE_ID = "gwangju-transportation-accessibility";
const TOPOLOGY_ID = "gwangju-transportation-route-topology";
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("regional accessibility registrar replays retained raw input and commits four source outputs", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "regional-accessibility-register-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  // 신뢰 루트는 변경하지 않는 기존 정책 fixture이고, 새 source만 작은 독립 입력이다.
  const governanceBytes = await readFile(new URL("./test-fixtures/source-governance-registration-root.json", import.meta.url));
  const predecessorPolicy = JSON.parse(governanceBytes);
  const now = new Date(Date.parse(`${predecessorPolicy.policyVersion}T00:00:00.000Z`) + 86_400_000);
  const { inventory, topologySource, topologySnapshot, elevatorBytes, escalatorBytes } = await independentFixture(now);
  const topologyBytes = Buffer.from(JSON.stringify(topologySnapshot));
  const ledgerBytes = Buffer.from(JSON.stringify([{
    sourceId: TOPOLOGY_ID, snapshotId: topologySource.topologyAdmissionEvidence.snapshotId,
    previousSnapshotId: null, retrievedAt: topologySnapshot.capturedAt, sourceUpdatedAt: null,
    rawSha256: topologySnapshot.rawSha256, contentSha256: topologySnapshot.contentSha256,
    schemaFingerprint: sha("test topology schema"), redactedRequestFingerprint: sha("test topology request"),
    rowCount: topologySnapshot.edgeCount, coverageCount: topologySnapshot.stationCount, diffSummary: null,
  }]));
  inventory.sources.push(...predecessorPolicy.sources.map((entry) => ({
    id: entry.sourceId, requiredForProductionPack: false,
    admissionEvidence: { licenseEvidenceHash: entry.licenseReview.termsHash },
  })));
  const sourceClasses = [...new Set(predecessorPolicy.sources.map((entry) => entry.sourceClassId))]
    .map((id) => ({ id, sourceIds: predecessorPolicy.sources.filter((entry) => entry.sourceClassId === id)
      .map((entry) => entry.sourceId), basisField: "retrievedAt", reverificationCadence: "P90D" }));
  const freshnessBytes = Buffer.from(JSON.stringify({ sourceClasses }));
  const snapshot = collectGwangjuAccessibility({ elevatorBytes, escalatorBytes, topologySnapshot, topologySource, now });
  const source = inventory.sources.find(({ id }) => id === SOURCE_ID);
  const termsHash = sha(canonicalJson(source.license));
  const governance = {
    sourceId: SOURCE_ID, sourceClassId: "static_accessibility_facility", retentionClassId: "standard-90d",
    ownerRole: "data-owner", stewardRole: "data-steward", approvalRole: "data-owner", escalationHours: 24, alertRoute: "data-owner",
    licenseReview: { status: "APPROVED", termsHash, termsUrl: source.license.evidenceUrl, reviewedProvider: source.provider,
      reviewedDatasetUrl: source.datasetUrl, reviewedAt: new Date(now.valueOf() - 86_400_000).toISOString(),
      nextReviewAt: new Date(now.valueOf() + 30 * 86_400_000).toISOString(),
      redistributionScopes: ["DERIVED_DATAPACK"], approvedByRole: "data-owner" },
  };
  const candidates = { candidates: [{ id: SOURCE_ID, domain: "accessibility_facilities" }] };
  const snapshotPath = path.join(fixtureRoot, "collected.json");
  const receiptPath = path.join(fixtureRoot, "receipt.json");
  await Promise.all(SOURCE_REGISTRATION_OUTPUTS.map(async (relative, index) => {
    const target = path.join(fixtureRoot, relative); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, [JSON.stringify(inventory, null, 2), ledgerBytes, governanceBytes, freshnessBytes][index]);
  }));
  const topologyPath = path.join(fixtureRoot, topologySource.topologyAdmissionEvidence.snapshotPath);
  await mkdir(path.dirname(topologyPath), { recursive: true }); await writeFile(topologyPath, topologyBytes);
  await mkdir(path.join(fixtureRoot, "tools/datapack"), { recursive: true });
  await writeFile(path.join(fixtureRoot, "tools/datapack/source-candidates.json"), JSON.stringify(candidates));
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  await assert.rejects(prepareRegionalAccessibilityRegistration({ repositoryRoot: fixtureRoot, snapshotPath, now }), /recorded governance/);
  candidates.candidates[0].registrationMetadata = { governance };
  await writeFile(path.join(fixtureRoot, "tools/datapack/source-candidates.json"), JSON.stringify(candidates));
  const prepared = await prepareRegionalAccessibilityRegistration({ repositoryRoot: fixtureRoot, snapshotPath, now });
  const observationDate = snapshot.capturedAt.slice(0, 10).replaceAll("-", "");
  // 기존 OCI 계약의 공개 namespace/bucket을 사용하며 PAR token은 테스트 문자열이다.
  const target = { ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey: `source-raw/${SOURCE_ID}/${observationDate}/${prepared.snapshotSha256}.json` };
  const receipt = { schemaVersion: 1, artifactKind: "static-network-source-raw-object-receipt", sourceId: SOURCE_ID, snapshotId: prepared.snapshotId,
    capturedAt: snapshot.capturedAt, rawObjectUri: `oci://${target.ociNamespace}/${target.bucket}/${target.objectKey}`,
    rawObjectSha256: prepared.snapshotSha256, byteSize: prepared.snapshotBytes.length, storedAt: now.toISOString(),
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt, ...target, contentType: "application/json" };
  await writeFile(receiptPath, JSON.stringify(receipt));
  const outputs = await buildRegionalAccessibilityRegistrationOutputs({ repositoryRoot: fixtureRoot, snapshotPath, receiptPath, now,
    env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/" } });
  await registerRegionalAccessibility({ repositoryRoot: fixtureRoot, snapshotPath, receiptPath, now,
    env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/" } });
  assert.equal(outputs.length, 4);
  const registered = JSON.parse(await readFile(path.join(fixtureRoot, SOURCE_REGISTRATION_OUTPUTS[0])));
  const admitted = registered.sources.find(({ id }) => id === SOURCE_ID);
  assert.equal(admitted.requiredForProductionPack, true);
  assert.equal(admitted.accessibilityAdmissionEvidence.rawSha256, snapshot.rawSha256);
  assert.equal(admitted.accessibilityAdmissionEvidence.rowsSha256, snapshot.rowsSha256);
  assert.equal(admitted.accessibilityAdmissionEvidence.topologySnapshotId, topologySource.topologyAdmissionEvidence.snapshotId);
  assert.equal(admitted.accessibilityAdmissionEvidence.freshUntil, snapshot.freshUntil);
  assert.deepEqual(registered.sources.find(({ id }) => id === TOPOLOGY_ID), topologySource);
  const registeredPolicy = JSON.parse(await readFile(path.join(fixtureRoot, SOURCE_REGISTRATION_OUTPUTS[2])));
  assert.equal(registeredPolicy.registrationLineage.predecessorPolicySha256, sha(governanceBytes));
  assert.deepEqual(registeredPolicy.registrationLineage.addedSourceIds, [SOURCE_ID]);
  assert.deepEqual(registeredPolicy.sources.slice(0, -1), predecessorPolicy.sources);
});

// 실제 카탈로그·ledger·파일 날짜와 무관한 두 역짜리 TEST_ONLY 등록 입력이다.
async function independentFixture(now) {
  const scope = [
    { providerStationId: "1", stationCode: "100", stationName: "가" },
    { providerStationId: "3", stationCode: "105", stationName: "나" },
  ];
  const topologySnapshot = await collectGwangjuRouteTopology({ stationScope: scope, now,
    fetchImpl: async (url) => {
      const start = scope.find((row) => row.providerStationId === new URL(url).searchParams.get("station_id"));
      const end = scope.find((row) => row !== start);
      return Response.json([{ start_station_id: start.providerStationId, start_station_name: start.stationName,
        end_station_id: end.providerStationId, end_station_name: end.stationName, station_distance: 1, station_time: 2 }]);
    },
  });
  const topologySource = {
    id: TOPOLOGY_ID, requiredForProductionPack: false, coverageScope: { lineIds: ["line-e57a361e8892"] },
    topologyAdmissionEvidence: {
      snapshotId: "test-topology", snapshotPath: "tools/datapack/sources/test-topology.json",
      ...Object.fromEntries(["capturedAt", "freshUntil", "stationCount", "edgeCount", "rawSha256", "contentSha256"]
        .map((key) => [key, topologySnapshot[key]])),
    },
  };
  const source = {
    id: SOURCE_ID, provider: "test-provider", datasetUrl: "https://example.org/test-dataset",
    productionUseAllowed: true, requiredForProductionPack: false,
    capabilities: { facility: { productionUseAllowed: true } },
    license: { redistributionAllowed: true, evidenceUrl: "https://example.org/test-license" },
    accessibilityAdmissionEvidence: { issue: 6, materializer: "test-materializer", verificationTest: "test-verifier" },
  };
  const elevatorBytes = Buffer.from([
    "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량",
    "광주교통공사,1호선,가,1,,,",
  ].join("\n"));
  const escalatorBytes = Buffer.from([
    "철도운영기관명,선명,역명,상하행구분,출입구번호,상세위치,시작층,종료층",
    "광주교통공사,1호선,나,상,1,,,",
  ].join("\n"));
  return { inventory: { sources: [topologySource, source] }, topologySource, topologySnapshot, elevatorBytes, escalatorBytes };
}
