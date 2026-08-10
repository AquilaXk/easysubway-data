import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  candidateNetworkEdgeEvidence,
  validateCapitalTopologyReverification,
  validateItxCurrentTopologyAdmission,
} from "./build-datapack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const currentNow = new Date("2026-08-10T00:00:00.000Z");

function rehashAdmission(admission) {
  delete admission.evidenceHash;
  admission.evidenceHash = sha256(Buffer.from(JSON.stringify(admission)));
  return admission;
}

function validateAdmission(admission, contract, source, now = currentNow) {
  return validateItxCurrentTopologyAdmission(admission, {
    previousArtifactSha256: contract.sourceTimetableArtifact.sha256,
    stationSequences: source.stationSequences,
    now,
  });
}

function networkEdgeEvidenceFixture() {
  return {
    sourceInventory: { path: "source-inventory.json", sha256: "1".repeat(64) },
    capitalTopology: {
      path: "capital-topology.json",
      sha256: "2".repeat(64),
      snapshotId: "capital-route-topology-20260809",
    },
    capitalTopologyAdmission: {
      schemaVersion: 1,
      artifactKind: "capital-network-edge-admission",
      issue: 2649,
      status: "ADMITTED",
      snapshotId: "capital-route-topology-20260809",
      contentSha256: "3".repeat(64),
      reviewedAt: "2026-08-09T12:04:20.479Z",
      reverifiedAt: "2026-08-09T12:04:20.479Z",
      freshUntil: "2026-08-20T00:00:00.000Z",
    },
    capitalTopologyCandidate: {
      path: "capital-topology-candidate.json",
      sha256: "4".repeat(64),
      snapshotId: "capital-route-topology-20260809",
    },
    capitalTopologyReverification: {
      path: "capital-topology-reverification.json",
      sha256: "5".repeat(64),
    },
    itxCoverageContract: { path: "itx-coverage.json", sha256: "6".repeat(64) },
  };
}

test("networkEdgeEvidence는 activation 뒤 current ITX admission을 필수로 수용한다", () => {
  const legacy = networkEdgeEvidenceFixture();
  assert.throws(
    () => candidateNetworkEdgeEvidence(legacy),
    /itxCurrentTopologyAdmission is required/,
  );

  const current = {
    ...legacy,
    itxCurrentTopologyAdmission: {
      path: "tools/datapack/itx-current-network-edge-admission-20260810.json",
      sha256: "7".repeat(64),
    },
  };
  assert.equal(
    candidateNetworkEdgeEvidence(current).itxCurrentTopologyAdmissionSha256,
    "7".repeat(64),
  );
  assert.throws(
    () => candidateNetworkEdgeEvidence({ ...current, unknown: true }),
    /unknown is not allowed/,
  );
});

test("capital topology reverification은 historical baseline과 current admitted candidate를 독립 검증한다", async () => {
  const [baseline, candidate, reverification] = await Promise.all([
    readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260804.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/capital-topology-reverification-20260804.json"), "utf8").then(JSON.parse),
  ]);
  const admission = {
    schemaVersion: 1,
    artifactKind: "capital-network-edge-admission",
    issue: 2649,
    status: "ADMITTED",
    snapshotId: "capital-route-topology-20260804",
    contentSha256: candidate.contentSha256,
    reviewedAt: candidate.capturedAt,
    reverifiedAt: candidate.capturedAt,
    freshUntil: candidate.freshUntil,
  };

  assert.doesNotThrow(() => validateCapitalTopologyReverification(
    reverification,
    baseline,
    candidate,
    admission,
    admission.snapshotId,
    "capital-route-topology-20260724",
  ));
});

test("tracked current ITX admission은 admitted pair와 fresh evidence identity에 결속된다", async () => {
  const admission = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-current-network-edge-admission-20260810.json"),
    "utf8",
  ));
  const contract = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"),
    "utf8",
  ));
  const source = JSON.parse(await readFile(path.join(root, contract.sourceTimetableArtifact.artifactPath), "utf8"));

  const validated = validateAdmission(admission, contract, source);
  assert.equal(validated.sourceId, "itx-current-network-edge-admission");
  assert.equal(validated.sourceSnapshotId, "itx-current-network-edge-admission-20260810");
  assert.equal(validated.freshUntil, "2026-08-11T00:00:00+09:00");
  assert.equal(validated.pairHashes.size, 48);

  assert.throws(() => validateItxCurrentTopologyAdmission(admission, {
    previousArtifactSha256: "0".repeat(64),
    stationSequences: source.stationSequences,
    now: new Date("2026-08-10T00:00:00.000Z"),
  }), /identity mismatch/);

  const pairTampered = structuredClone(admission);
  pairTampered.pairHashes[0] = "0".repeat(64);
  rehashAdmission(pairTampered);
  assert.throws(() => validateAdmission(pairTampered, contract, source), /identity mismatch/);

  assert.throws(() => validateAdmission(
    admission,
    contract,
    source,
    new Date("2026-08-11T00:00:00.000Z"),
  ), /stale/);

  const extended = structuredClone(admission);
  extended.freshUntil = "2027-08-11T00:00:00+09:00";
  rehashAdmission(extended);
  assert.throws(() => validateAdmission(extended, contract, source), /freshUntil.*serviceDate/);

  const invalidDate = structuredClone(admission);
  invalidDate.serviceDate = "20260230";
  invalidDate.artifactId = "itx-current-network-edge-admission-20260230";
  invalidDate.observedAt = "2026-02-28T00:00:00.000Z";
  invalidDate.freshUntil = "2026-03-01T00:00:00+09:00";
  rehashAdmission(invalidDate);
  assert.throws(() => validateAdmission(
    invalidDate,
    contract,
    source,
    new Date("2026-02-28T01:00:00.000Z"),
  ), /serviceDate is invalid/);
});
