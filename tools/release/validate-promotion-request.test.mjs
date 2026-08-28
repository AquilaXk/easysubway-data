import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("tools/release/validate-promotion-request.mjs");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("raw evidence와 서로 다른 candidate/promotion run identity를 검증한다", () => {
  const fixture = createFixture();
  try {
    const valid = run(fixture);
    assert.equal(valid.status, 0, valid.stderr);
    fixture.request.candidate.dataVersion = "other";
    writeFileSync(fixture.requestPath, JSON.stringify(fixture.request));
    assert.notEqual(run(fixture).status, 0);
  } finally {
    fixture.cleanup();
  }
});

test("candidate execution evidence를 현재 candidate run/head/manifest/source identity에 결속한다", () => {
  const fixture = createFixture();
  try {
    const valid = run(fixture);
    assert.equal(valid.status, 0, valid.stderr);
    for (const mutate of [
      (value) => { value.builderGitSha = "f".repeat(40); },
      (value) => { value.workflowRunUrl = "https://github.com/AquilaXk/easysubway-data/actions/runs/999"; },
      (value) => { value.manifestSha256 = "f".repeat(64); },
      (value) => { value.candidateServerRouteEvidence.buildSpecSha256 = "f".repeat(64); },
    ]) {
      const broken = createFixture();
      try {
        const bundle = JSON.parse(readFileSync(broken.releaseEvidenceBundlePath, "utf8"));
        mutate(bundle);
        writeFileSync(broken.releaseEvidenceBundlePath, JSON.stringify(bundle));
        assert.notEqual(run(broken).status, 0);
      } finally {
        broken.cleanup();
      }
    }
  } finally {
    fixture.cleanup();
  }
});

test("request key, evidence hash, approval run/reviewer mismatch를 거부한다", () => {
  for (const mutate of [
    (fixture) => { fixture.request.extra = true; writeRequest(fixture); },
    (fixture) => writeFileSync(fixture.compatibilityPath, "changed"),
    (fixture) => writeFileSync(fixture.executionEvidenceRoot + "/release-decision.json", "changed"),
    (fixture) => { fixture.workflowRunId = "789"; },
    (fixture) => { fixture.request.approval.reviewer = "other"; writeRequest(fixture); },
    (fixture) => writeFileSync(fixture.approvalPath, JSON.stringify([approvedReview(), approvedReview()])),
    (fixture) => replaceCompatibility(fixture, { ...fixture.compatibility, decision: "NO_GO" }),
    (fixture) => replaceCompatibility(fixture, {
      ...fixture.compatibility,
      candidate: { ...fixture.compatibility.candidate, dataVersion: "other" },
    }),
  ]) {
    const fixture = createFixture();
    try {
      mutate(fixture);
      assert.notEqual(run(fixture).status, 0);
    } finally {
      fixture.cleanup();
    }
  }
});

test("validator도 inventory 구조를 독립적으로 fail closed한다", () => {
  for (const entries of [
    [],
    [entry("b.bin"), entry("a.bin")],
    [entry("a.bin"), entry("a.bin")],
    [entry("/absolute.bin")],
    [entry("nested\\windows.bin")],
    [entry("nested/./dot.bin")],
  ]) {
    const fixture = createFixture();
    try {
      replaceInventory(fixture, entries);
      assert.notEqual(run(fixture).status, 0);
    } finally {
      fixture.cleanup();
    }
  }
});

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "promotion-validate-"));
  const inventoryBytes = Buffer.from(JSON.stringify(inventoryValue()));
  const component = componentValue(sha256(inventoryBytes));
  const compatibility = compatibilityValue(component);
  const compatibilityBytes = Buffer.from(JSON.stringify(compatibility));
  const approvalBytes = Buffer.from(JSON.stringify([approvedReview()]));
  const executionEvidenceRoot = path.join(root, "candidate-execution-evidence");
  mkdirSync(executionEvidenceRoot);
  const releaseEvidenceBundleBytes = Buffer.from(JSON.stringify(releaseEvidenceBundleValue(component)));
  const releaseDecisionBytes = Buffer.from(JSON.stringify(releaseDecisionValue(component)));
  const releaseEvidenceBundlePath = file(executionEvidenceRoot, "release-evidence-bundle.json", releaseEvidenceBundleBytes);
  file(executionEvidenceRoot, "release-decision.json", releaseDecisionBytes);
  const request = requestValue(component, compatibilityBytes, approvalBytes, releaseEvidenceBundleBytes, releaseDecisionBytes);
  return {
    root,
    request,
    requestPath: file(root, "request.json", JSON.stringify(request)),
    component,
    componentPath: file(root, "component.json", JSON.stringify(component)),
    inventoryPath: file(root, "inventory.json", inventoryBytes),
    compatibility,
    compatibilityPath: file(root, "compatibility.json", compatibilityBytes),
    approvalPath: file(root, "approval.json", approvalBytes),
    executionEvidenceRoot,
    releaseEvidenceBundlePath,
    workflowRunId: "456",
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function replaceInventory(fixture, entries) {
  const bytes = Buffer.from(JSON.stringify(inventoryValue(entries)));
  writeFileSync(fixture.inventoryPath, bytes);
  fixture.component.artifactInventorySha256 = sha256(bytes);
  writeFileSync(fixture.componentPath, JSON.stringify(fixture.component));
  fixture.request.candidate.artifactInventorySha256 = sha256(bytes);
  writeRequest(fixture);
}

function writeRequest(fixture) {
  writeFileSync(fixture.requestPath, JSON.stringify(fixture.request));
}

function replaceCompatibility(fixture, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(fixture.compatibilityPath, bytes);
  fixture.request.compatibilityEvidenceSha256 = sha256(bytes);
  writeRequest(fixture);
}

function requestValue(component, compatibilityBytes, approvalBytes, releaseEvidenceBundleBytes, releaseDecisionBytes) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-promotion-request",
    candidate: structuredClone(component),
    compatibilityEvidenceSha256: sha256(compatibilityBytes),
    candidateExecutionEvidence: {
      releaseEvidenceBundleSha256: sha256(releaseEvidenceBundleBytes),
      releaseDecisionSha256: sha256(releaseDecisionBytes),
    },
    requestedBy: "AquilaXk",
    approval: {
      workflowRunId: "456",
      environment: "datapack-promotion",
      reviewer: "AquilaXk",
      approvalEvidenceSha256: sha256(approvalBytes),
    },
    contractVersion: "datapack-promotion-v2",
    issueRef: "AquilaXk/easysubway#2705",
  };
}

function releaseEvidenceBundleValue(component) {
  return {
    schemaVersion: 1, artifactKind: "datapack-release-evidence-bundle", releaseMode: "release-candidate",
    candidateId: "capital@1", buildCandidateId: "candidate-1", candidateBuilderGitSha: "9".repeat(40),
    builderGitSha: component.gitSha, buildSpecSha256: "8".repeat(64), manifestSha256: component.manifestSha256,
    releaseSequence: component.releaseSequence, sourceSnapshotSetHash: component.provenance.sourceSnapshotSetHash,
    validatorStatus: "PASS", manifestSignatureStatus: "PASS", createdAt: "2026-08-28T00:00:00.000Z",
    workflowRunUrl: `https://github.com/AquilaXk/easysubway-data/actions/runs/${component.workflowRunId}`,
    candidateServerRouteEvidence: { candidateId: "candidate-1", sourceSnapshotSetHash: component.provenance.sourceSnapshotSetHash, buildSpecSha256: "8".repeat(64), manifestSha256: component.manifestSha256, eligibility: { path: "server-route-bundle-evidence/route-accessibility-eligibility.json", sha256: "7".repeat(64) }, final: { path: "server-route-bundle-evidence/server-route-bundle-final.json", sha256: "6".repeat(64) } },
  };
}

function releaseDecisionValue(component) {
  return { schemaVersion: 1, artifactKind: "datapack-release-decision", outcome: "CHANGE_BLOCKED", productionWriteAllowed: false, materialChange: true, approvalValid: false, strictValidationPassed: true, publishRequired: true, publishAttempted: false, remoteValidationPassed: false, sourceSnapshotSetHash: component.provenance.sourceSnapshotSetHash, selectedManifestSha256: null, selectedReleaseSequence: null, reasonCodes: ["MATERIAL_CHANGE_UNAPPROVED"], evaluationAt: "2026-08-28T00:00:00.000Z" };
}

function inventoryValue(entries = [entry("artifact.bin")]) {
  return { schemaVersion: 1, artifactKind: "datapack-candidate-inventory", entries };
}

function entry(artifactPath) {
  return { path: artifactPath, sizeBytes: 1, sha256: "d".repeat(64) };
}

function approvedReview() {
  return { state: "approved", environments: [{ name: "datapack-promotion" }], user: { login: "AquilaXk" } };
}

function componentValue(inventorySha256) {
  return {
    schemaVersion: 1,
    component: "data",
    repository: "AquilaXk/easysubway-data",
    gitSha: "a".repeat(40),
    workflowRunId: "123",
    dataVersion: "1",
    releaseSequence: 1,
    manifestSha256: "b".repeat(64),
    provenance: { sourceSnapshotSetHash: "c".repeat(64) },
    artifactInventorySha256: inventorySha256,
    contractVersion: "datapack-contract-v3",
    issueRef: "AquilaXk/easysubway#2705",
  };
}

function compatibilityValue(component) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-mobile-compatibility-evidence",
    decision: "PASS",
    candidate: structuredClone(component),
  };
}

function file(root, name, value) {
  const target = path.join(root, name);
  writeFileSync(target, value);
  return target;
}

function run(fixture) {
  return spawnSync(process.execPath, [
    script,
    "--request", fixture.requestPath,
    "--component", fixture.componentPath,
    "--inventory", fixture.inventoryPath,
    "--compatibility-evidence", fixture.compatibilityPath,
    "--candidate-execution-evidence-root", fixture.executionEvidenceRoot,
    "--approval-evidence", fixture.approvalPath,
    "--workflow-run-id", fixture.workflowRunId,
  ], { encoding: "utf8" });
}
