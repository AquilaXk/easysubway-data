import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseArgs, runCurrentCapitalRouteTopologyRegistration } from "./run-current-capital-route-topology-registration.mjs";

const TARGETS = ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json"];
const SHA = "a".repeat(40);

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
    publish: async ({ operationRoot, rawRelativePath }) => { calls.push("publish"); assert.deepEqual(await readFile(path.join(operationRoot, rawRelativePath)), bytes); return { receipt: "sanitized" }; },
    register: async ({ receiptPath }) => { calls.push("register"); assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), { receipt: "sanitized" }); return { targets: TARGETS }; },
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
  await assert.rejects(() => runCurrentCapitalRouteTopologyRegistration({ repositoryRoot: f.repositoryRoot, operationRoot: f.operationRoot, expectedMainSha: SHA, readAdmission: async () => ({ topologyBytes: Buffer.from("{}") }), publish: async () => { throw new Error("publication failed"); }, register: async () => { registered = true; } }), /publication failed/);
  assert.equal(registered, false);
});
test("accepts only the closed CLI contract", () => {
  assert.deepEqual(parseArgs(["--repository-root", "/repo", "--operation-root", "/tmp/op", "--expected-main-sha", SHA]), { repositoryRoot: "/repo", operationRoot: "/tmp/op", expectedMainSha: SHA });
  assert.throws(() => parseArgs(["--repository-root", "/repo", "--repository-root", "/tmp/op", "--expected-main-sha", SHA]));
  assert.throws(() => parseArgs(["--repository-root", "/repo", "--operation-root", "/tmp/op", "--expected-main-sha", "A".repeat(40)]));
});
