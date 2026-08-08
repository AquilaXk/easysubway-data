import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("tools/release/validate-promotion-request.mjs");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("raw evidence와 서로 다른 candidate/promotion run identity를 검증한다", () => {
  const fixture = createFixture();
  try {
    assert.equal(run(fixture).status, 0);
    fixture.request.candidate.dataVersion = "other";
    writeFileSync(fixture.requestPath, JSON.stringify(fixture.request));
    assert.notEqual(run(fixture).status, 0);
  } finally {
    fixture.cleanup();
  }
});

test("세 번의 data candidate raw parity evidence를 현재 candidate에 정확히 결속한다", () => {
  const fixture = createFixture();
  try {
    assert.equal(run(fixture).status, 0);
    for (const mutate of [
      (value) => { value.candidates.reverse(); },
      (value) => { value.candidates[1].workflowRunId = value.candidates[0].workflowRunId; },
      (value) => { value.candidates[1].gitSha = "f".repeat(40); },
      (value) => { value.selectedCandidateWorkflowRunId = "999"; },
      (value) => { value.artifactInventorySha256 = "e".repeat(64); },
      (value) => { value.issueRef = "AquilaXk/easysubway-data#54"; },
    ]) {
      const broken = createFixture();
      try {
        mutate(broken.parity);
        replaceParity(broken, broken.parity);
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
    (fixture) => writeFileSync(fixture.parityPath, "changed"),
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
  const parity = parityValue(component);
  const parityBytes = Buffer.from(JSON.stringify(parity));
  const request = requestValue(component, compatibilityBytes, approvalBytes, parityBytes);
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
    parity,
    parityPath: file(root, "parity.json", parityBytes),
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

function replaceParity(fixture, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(fixture.parityPath, bytes);
  fixture.request.rebuildParityEvidenceSha256 = sha256(bytes);
  writeRequest(fixture);
}

function requestValue(component, compatibilityBytes, approvalBytes, parityBytes) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-promotion-request",
    candidate: structuredClone(component),
    compatibilityEvidenceSha256: sha256(compatibilityBytes),
    rebuildParityEvidenceSha256: sha256(parityBytes),
    requestedBy: "AquilaXk",
    approval: {
      workflowRunId: "456",
      environment: "datapack-promotion",
      reviewer: "AquilaXk",
      approvalEvidenceSha256: sha256(approvalBytes),
    },
    contractVersion: "datapack-promotion-v1",
    issueRef: "AquilaXk/easysubway#2705",
  };
}

function parityValue(component) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-rebuild-parity-evidence",
    selectedCandidateWorkflowRunId: component.workflowRunId,
    candidates: [
      structuredClone(component),
      { ...component, workflowRunId: "234" },
      { ...component, workflowRunId: "345" },
    ],
    artifactInventorySha256: component.artifactInventorySha256,
    contractVersion: "datapack-rebuild-parity-v1",
    issueRef: "AquilaXk/easysubway#2705",
  };
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
    "--rebuild-parity-evidence", fixture.parityPath,
    "--approval-evidence", fixture.approvalPath,
    "--workflow-run-id", fixture.workflowRunId,
  ], { encoding: "utf8" });
}
