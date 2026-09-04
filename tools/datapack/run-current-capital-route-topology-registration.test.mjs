import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHash } from "node:crypto";
import { parseArgs, recoverPublishedCurrentCapitalRouteTopologyRegistration, runCurrentCapitalRouteTopologyRegistration } from "./run-current-capital-route-topology-registration.mjs";

const TARGETS = ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json"];
const SHA = "a".repeat(40);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "capital-topology-registration-"));
  const repositoryRoot = path.join(base, "repository"); const operationRoot = path.join(base, "operation");
  await mkdir(path.join(repositoryRoot, "tools/datapack/release"), { recursive: true });
  await mkdir(path.dirname(operationRoot), { recursive: true });
  return { base, repositoryRoot, operationRoot };
}
test("runs protected admission, create-once publication, and registration in order", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const calls = []; const bytes = Buffer.from('{"sourceId":"capital-route-topology"}\n');
  const result = await runCurrentCapitalRouteTopologyRegistration({ repositoryRoot: f.repositoryRoot, operationRoot: f.operationRoot, expectedMainSha: SHA, now: new Date("2026-09-04T00:00:00.000Z"),
    readAdmission: async () => { calls.push("admission"); return { sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20260904", topologyBytes: bytes }; },
    publish: async ({ operationRoot, rawRelativePath, receiptPath }) => { calls.push("publish"); assert.deepEqual(await readFile(path.join(operationRoot, rawRelativePath)), bytes); await writeFile(receiptPath, JSON.stringify({ sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20260904", rawObjectSha256: digest(bytes) })); },
    register: async ({ receiptPath }) => { calls.push("register"); assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).rawObjectSha256, digest(bytes)); return { targets: TARGETS }; }, exactMain: async () => ({}),
  });
  assert.deepEqual(calls, ["admission", "publish", "register"]); assert.deepEqual(result, { status: "PASS", sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20260904", targets: TARGETS });
});
test("rejects terminal markers before publication", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await writeFile(path.join(f.repositoryRoot, "tools/datapack/release/current-capital-accessibility-transition.json"), "{}\n");
  let published = false;
  await assert.rejects(() => runCurrentCapitalRouteTopologyRegistration({ repositoryRoot: f.repositoryRoot, operationRoot: f.operationRoot, expectedMainSha: SHA, readAdmission: async () => { throw new Error("must not read"); }, publish: async () => { published = true; } }), /terminal marker/);
  assert.equal(published, false);
});
test("does not register after publication failure", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  let registered = false;
  await assert.rejects(() => runCurrentCapitalRouteTopologyRegistration({ repositoryRoot: f.repositoryRoot, operationRoot: f.operationRoot, expectedMainSha: SHA, readAdmission: async () => ({ sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20260904", topologyBytes: Buffer.from("{}") }), publish: async () => { throw new Error("https://secret.invalid/raw"); }, register: async () => { registered = true; }, exactMain: async () => ({}) }), (error) => {
    assert.match(error.message, /OCI publication failed/); assert.doesNotMatch(error.message, /secret\.invalid/); return true;
  });
  assert.equal(registered, false);
});
test("retains a published receipt and recovers every deliverable journal phase without a second publish", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const bytes = Buffer.from("{}\n"); let publishes = 0;
  await assert.rejects(() => runCurrentCapitalRouteTopologyRegistration({ repositoryRoot: f.repositoryRoot, operationRoot: f.operationRoot, expectedMainSha: SHA,
    readAdmission: async () => ({ sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20260904", topologyBytes: bytes }),
    publish: async ({ receiptPath }) => { publishes += 1; await writeFile(receiptPath, JSON.stringify({ sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20260904", rawObjectSha256: digest(bytes) })); },
    register: async () => { throw new Error("registrar failed"); }, exactMain: async () => ({}),
  }), /registrar failed/);
  assert.equal(publishes, 1);
  const journalPath = path.join(f.operationRoot, "capital-route-topology-registration.json"); const journal = JSON.parse(await readFile(journalPath, "utf8"));
  for (const phase of ["PUBLISHING", "PUBLISHED", "FINALIZED"]) {
    await writeFile(journalPath, `${JSON.stringify({ ...journal, phase }, null, 2)}\n`);
    const result = await recoverPublishedCurrentCapitalRouteTopologyRegistration({ repositoryRoot: f.repositoryRoot, sourceOperationRoot: f.operationRoot, targetOperationRoot: path.join(f.base, `recovery-${phase.toLowerCase()}`), expectedMainSha: SHA,
      expectedPublicationOperationId: path.basename(f.operationRoot), readAdmission: async () => ({ sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20260904", topologyBytes: bytes }), register: async () => ({ targets: TARGETS }), exactMain: async () => ({}) });
    assert.equal(publishes, 1); assert.equal(result.status, "PASS");
  }
});
test("accepts only the closed CLI contract", () => {
  assert.deepEqual(parseArgs(["--repository-root", "/repo", "--operation-root", "/tmp/op", "--expected-main-sha", SHA]), { phase: "run", repositoryRoot: "/repo", operationRoot: "/tmp/op", expectedMainSha: SHA });
  assert.throws(() => parseArgs(["--repository-root", "/repo", "--repository-root", "/tmp/op", "--expected-main-sha", SHA]));
  assert.throws(() => parseArgs(["--repository-root", "/repo", "--operation-root", "/tmp/op", "--expected-main-sha", "A".repeat(40)]));
  assert.deepEqual(parseArgs(["recover-published", "--repository-root", "/repo", "--source-operation-root", "/tmp/source", "--target-operation-root", "/tmp/target", "--expected-main-sha", SHA, "--expected-publication-operation-id", "123"]).phase, "recover-published");
});
test("workflow fails closed on claim reads and retains only recovery metadata", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/current-capital-topology-registration.yml", import.meta.url), "utf8");
  assert.match(workflow, /environment: datapack-release-check/u);
  assert.match(workflow, /git ls-remote --heads origin[^\n]+ > "\$\{claims\}"/u);
  assert.match(workflow, /source_root=[^\n]+[\s\S]*mkdir -p "\$\{source_root\}"[\s\S]*chmod 700 "\$\{source_root\}"[\s\S]*gh run download[^\n]+--dir "\$\{source_root\}"/u);
  assert.doesNotMatch(workflow, /mkdir -m 700 -p "\$\{REGISTRATION_OPERATION_ROOT\}"/u);
  assert.match(workflow, /Recover published registration without OCI/u);
  assert.match(workflow, /capital-route-topology-registration\.json/u);
  assert.match(workflow, /capital-route-topology\.raw-receipt\.json/u);
  assert.doesNotMatch(workflow, /capital-route-topology\.raw\.json/u);
});
