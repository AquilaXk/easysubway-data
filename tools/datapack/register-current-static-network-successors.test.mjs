import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { commitStaticNetworkSuccessorOutputs, registerCurrentStaticNetworkSuccessors } from "./register-current-static-network-successors.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const INPUT_PATHS = [
  "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json", "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
];

async function registrationOutputs(root) {
  const output = (relative, before, after) => ({ relative, prestateBytes: before, bytes: after });
  const inputs = await Promise.all(INPUT_PATHS.map(async (relative) => ({ relative, bytes: await readFile(path.join(root, relative)) })));
  const outputs = [
    output("tools/datapack/sources/seoulmetro-cyberstation-route-map-current-20260822T000000000Z.json", null, Buffer.from("route\n")),
    output("tools/datapack/sources/molit-urban-rail-full-route-current-20260822T000000000Z.json", null, Buffer.from("molit\n")),
    output("tools/datapack/source-inventory.json", inputs[0].bytes, Buffer.from("inventory\n")),
    output("tools/datapack/release/source-snapshots.json", inputs[1].bytes, Buffer.from("ledger\n")),
    output("tools/datapack/release/candidate-build-spec.json", inputs[2].bytes, Buffer.from("candidate\n")),
    output("tools/datapack/release/release-request.json", inputs[3].bytes, Buffer.from("request\n")),
    output("tools/datapack/release/hash-evidence.json", inputs[4].bytes, Buffer.from("hash\n")),
  ];
  return outputs.map((entry) => ({ ...entry, inputs }));
}

async function leasePort(t) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("registrar commits only the exact seven-output allowlist and rolls back an interrupted write", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-registrar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const before = await readFile(path.join(root, "tools/datapack/source-inventory.json"));
  const outputs = await registrationOutputs(root);
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs, failAfter: 2 }), /injected transaction failure/);
  assert.equal(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"), before.toString("utf8"));
  await commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs });
  assert.equal(sha(await readFile(path.join(root, outputs[0].relative))), sha(outputs[0].bytes));
});

test("registrar rejects a recovery journal whose seven records are not the exact output allowlist", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const before = await readFile(path.join(root, "tools/datapack/source-inventory.json"));
  const record = { relative: "tools/datapack/source-inventory.json", before: before.toString("base64"), after: before.toString("base64"), beforeSha256: sha(before), afterSha256: sha(before) };
  await writeFile(path.join(root, "tools/datapack/.static-network-successors-transaction.json"), JSON.stringify({ state: "PREPARED", records: Array.from({ length: 7 }, () => record) }));
  const outputs = await registrationOutputs(root);
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs }), /recovery required/);
});

test("registrar rejects derivation input drift before staging any output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-input-cas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  await writeFile(path.join(root, "tools/datapack/source-governance-policy.json"), "foreign input\n");
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs }), /preserves foreign replacement/);
  await assert.rejects(readFile(path.join(root, outputs[0].relative)), /ENOENT/);
});

test("register API acquires the active owner lease before validating observations or reading inputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-lock-first-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const port = await leasePort(t);
  await writeFile(path.join(root, "tools/datapack/.static-network-successors.lock"), `${JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port, pid: process.pid, token: "00000000-0000-4000-8000-000000000000" }, null, 2)}\n`);
  await assert.rejects(registerCurrentStaticNetworkSuccessors({ repositoryRoot: root, observations: [] }), /lock residue exists/);
});

test("registrar does not overwrite a foreign lock replacement after exclusively reclaiming a stale lease", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-lock-reclaim-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const lock = path.join(root, "tools/datapack/.static-network-successors.lock");
  const stalePort = await freePort();
  const stale = `${JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port: stalePort, pid: 99999999, token: "00000000-0000-4000-8000-000000000000" })}\n`;
  await writeFile(lock, stale);
  const outputs = await registrationOutputs(root);
  const foreign = Buffer.from("foreign lock replacement\n");
  await assert.rejects(commitStaticNetworkSuccessorOutputs({
    repositoryRoot: root,
    outputs,
    afterStaleLockRead: async () => writeFile(lock, foreign),
  }), /lock residue exists/);
  assert.deepEqual(await readFile(lock), foreign);
});

test("registrar preserves a foreign fixed-output replacement that races the final publish", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-output-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  const fixed = path.join(root, "tools/datapack/source-inventory.json");
  const foreign = Buffer.from("foreign replacement\n");
  await assert.rejects(commitStaticNetworkSuccessorOutputs({
    repositoryRoot: root,
    outputs,
    beforeExistingPublish: async ({ file }) => {
      if (file === fixed) await writeFile(file, foreign, { flag: "wx" });
    },
  }), /preserves foreign replacement/);
  assert.deepEqual(await readFile(fixed), foreign);
});

test("registrar recovers a deterministic displaced fixed output after an interrupted publish", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-output-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  const records = outputs.map(({ relative, prestateBytes: before, bytes: after }) => ({ relative, before: before?.toString("base64") ?? null, after: after.toString("base64"), beforeSha256: before == null ? null : sha(before), afterSha256: sha(after) }));
  await writeFile(path.join(root, "tools/datapack/.static-network-successors-transaction.json"), JSON.stringify({ state: "PREPARED", records }));
  const fixed = path.join(root, "tools/datapack/source-inventory.json");
  const displaced = path.join(root, "tools/datapack/.source-inventory.json.static-network-successors.before");
  const retired = path.join(root, "tools/datapack/sources/.seoulmetro-cyberstation-route-map-current-20260822T000000000Z.json.static-network-successors.retired");
  await rename(fixed, displaced);
  await writeFile(retired, outputs[0].bytes);
  await commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs });
  assert.deepEqual(await readFile(fixed), outputs[2].bytes);
  await assert.rejects(readFile(displaced), /ENOENT/);
  await assert.rejects(readFile(retired), /ENOENT/);
});

test("registrar commits an exact canonical COMMITTED journal and its displaced PREPARED predecessor together", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-journal-transition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  const records = outputs.map(({ relative, prestateBytes: before, bytes: after }) => ({ relative, before: before?.toString("base64") ?? null, after: after.toString("base64"), beforeSha256: before == null ? null : sha(before), afterSha256: sha(after) }));
  for (const { relative, bytes } of outputs) await writeFile(path.join(root, relative), bytes);
  const journal = path.join(root, "tools/datapack/.static-network-successors-transaction.json");
  const displaced = path.join(root, "tools/datapack/..static-network-successors-transaction.json.static-network-successors.before");
  await writeFile(journal, JSON.stringify({ state: "COMMITTED", records }));
  await writeFile(displaced, JSON.stringify({ state: "PREPARED", records }));
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs }), /preserves foreign replacement/);
  await assert.rejects(readFile(journal), /ENOENT/);
  await assert.rejects(readFile(displaced), /ENOENT/);
  assert.deepEqual(await readFile(path.join(root, outputs[2].relative)), outputs[2].bytes);
});

test("registrar resumes predecessor cleanup before consuming its canonical COMMITTED journal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-journal-cleanup-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  const records = outputs.map(({ relative, prestateBytes: before, bytes: after }) => ({ relative, before: before?.toString("base64") ?? null, after: after.toString("base64"), beforeSha256: before == null ? null : sha(before), afterSha256: sha(after) }));
  for (const { relative, bytes } of outputs) await writeFile(path.join(root, relative), bytes);
  const journal = path.join(root, "tools/datapack/.static-network-successors-transaction.json");
  const cleanup = path.join(root, "tools/datapack/...static-network-successors-transaction.json.static-network-successors.before.static-network-successors.retired");
  await writeFile(journal, JSON.stringify({ state: "COMMITTED", records }));
  await writeFile(cleanup, JSON.stringify({ state: "PREPARED", records }));
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs }), /preserves foreign replacement/);
  await assert.rejects(readFile(journal), /ENOENT/);
  await assert.rejects(readFile(cleanup), /ENOENT/);
  assert.deepEqual(await readFile(path.join(root, outputs[2].relative)), outputs[2].bytes);
});

test("registrar recovers the actual journal transition state after COMMITTED publish cleanup fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-journal-publish-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  const journal = path.join(root, "tools/datapack/.static-network-successors-transaction.json");
  const displaced = path.join(root, "tools/datapack/..static-network-successors-transaction.json.static-network-successors.before");
  await assert.rejects(commitStaticNetworkSuccessorOutputs({
    repositoryRoot: root,
    outputs,
    afterExistingPublish: async ({ file, value }) => {
      if (file === journal && JSON.parse(value).state === "COMMITTED") throw new Error("injected journal cleanup failure");
    },
  }), /injected journal cleanup failure/);
  await assert.rejects(readFile(journal), /ENOENT/);
  await assert.rejects(readFile(displaced), /ENOENT/);
  for (const { relative, bytes } of outputs) assert.deepEqual(await readFile(path.join(root, relative)), bytes);
});

test("registrar fails closed before acquiring when a prior lock displacement remains", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-lock-residue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  await writeFile(path.join(root, "tools/datapack/..static-network-successors.lock.static-network-successors.before"), "orphaned lock\n");
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs: await registrationOutputs(root) }), /lock residue exists/);
});
