import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  candidateNetworkEdgeEvidence,
  validateItxCurrentTopologyAdmission,
} from "./build-datapack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

test("networkEdgeEvidence는 migration 전후 exact key set만 수용한다", () => {
  const legacy = networkEdgeEvidenceFixture();
  assert.equal(candidateNetworkEdgeEvidence(legacy).itxCurrentTopologyAdmissionSha256, undefined);

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

  const validated = validateItxCurrentTopologyAdmission(admission, {
    previousArtifactSha256: contract.sourceTimetableArtifact.sha256,
    stationSequences: source.stationSequences,
    now: new Date("2026-08-10T00:00:00.000Z"),
  });
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
  delete pairTampered.evidenceHash;
  pairTampered.evidenceHash = sha256(Buffer.from(JSON.stringify(pairTampered)));
  assert.throws(() => validateItxCurrentTopologyAdmission(pairTampered, {
    previousArtifactSha256: contract.sourceTimetableArtifact.sha256,
    stationSequences: source.stationSequences,
    now: new Date("2026-08-10T00:00:00.000Z"),
  }), /identity mismatch/);

  assert.throws(() => validateItxCurrentTopologyAdmission(admission, {
    previousArtifactSha256: contract.sourceTimetableArtifact.sha256,
    stationSequences: source.stationSequences,
    now: new Date("2026-08-11T00:00:00.000Z"),
  }), /stale/);
});
