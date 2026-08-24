import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCandidateOciArtifactDescriptor } from "./build-candidate-oci-artifact-descriptor.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("stage 전량과 tuple·inventory·component를 OCI immutable object-set descriptor로 결정론적으로 결속한다", async () => {
  const fixture = await createFixture();
  try {
    const first = await build(fixture);
    const bytes = await readFile(fixture.output);
    assert.equal(first.artifactName, "easysubway-datapack-candidate-42");
    assert.equal(first.objects.length, 6);
    assert.ok(first.objects.every((entry) => entry.objectKey.startsWith("candidates/v1/runs/42/heads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/candidates/candidate-1/objects/")));
    assert.ok(first.objects.every((entry) => entry.ociUri === `oci://namespace/candidate-private/${entry.objectKey}`));
    assert.equal(first.expiresAt, "2026-08-25T00:00:00.000Z");
    await rm(fixture.output);
    const second = await build(fixture);
    assert.deepEqual(await readFile(fixture.output), bytes);
    assert.deepEqual(second, first);
  } finally { await fixture.cleanup(); }
});

test("extra·symlink·traversal·identity drift·expired stage는 descriptor를 남기지 않는다", async () => {
  const cases = [
    ["extra", async (f) => { await writeFile(path.join(f.root, "release-decision.json"), "no\n"); }],
    ["symlink", async (f) => { await symlink(path.join(f.root, "catalog/current.json"), path.join(f.root, "linked.json")); }],
    ["tuple drift", async (f) => { f.tuple.candidateBinding.manifestSha256 = "f".repeat(64); await writeFile(f.tuplePath, json(f.tuple)); }],
    ["component drift", async (f) => { f.component.workflowRunId = "43"; await writeFile(f.componentPath, json(f.component)); }],
    ["expired", async (f) => { f.tuple.freshnessExpiresAt = "2026-08-23T00:00:00.000Z"; await writeFile(f.tuplePath, json(f.tuple)); }],
  ];
  for (const [name, mutate] of cases) {
    const fixture = await createFixture();
    try {
      await mutate(fixture);
      await assert.rejects(build(fixture), undefined, name);
      await assert.rejects(readFile(fixture.output), /ENOENT/, name);
    } finally { await fixture.cleanup(); }
  }
});

async function build(fixture) {
  return buildCandidateOciArtifactDescriptor({ root: fixture.root, tuple: fixture.tuplePath, inventory: fixture.inventoryPath, component: fixture.componentPath, repository: "AquilaXk/easysubway-data", workflowRunId: "42", headSha: "a".repeat(40), namespace: "namespace", bucket: "candidate-private", createdAt: "2026-08-24T00:00:00.000Z", output: fixture.output });
}
async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "candidate-oci-descriptor-"));
  const catalog = path.join(root, "catalog"); await mkdir(catalog);
  const manifestBytes = Buffer.from("{\"manifestVersion\":2}\n");
  const provenanceBytes = Buffer.from("{\"candidateBuild\":true}\n");
  const packBytes = Buffer.from("pack\n");
  await Promise.all([writeFile(path.join(catalog, "current.json"), manifestBytes), writeFile(path.join(root, "current.provenance.json"), provenanceBytes), writeFile(path.join(catalog, "capital.sqlite.gz"), packBytes)]);
  const tuplePath = path.join(root, "datapack-candidate-tuple.json");
  const tuple = { candidateBinding: { candidateId: "candidate-1", buildSpecSha256: "b".repeat(64), manifestSha256: hash(manifestBytes) }, freshnessExpiresAt: "2026-08-25T00:00:00.000Z" };
  await writeFile(tuplePath, json(tuple));
  const inventoryPath = path.join(root, "data-artifact-inventory.json");
  const componentPath = path.join(root, "data-component-manifest.json");
  const inventory = { schemaVersion: 1, artifactKind: "datapack-candidate-inventory", entries: await entries(root, new Set([inventoryPath, componentPath])) };
  const inventoryBytes = json(inventory);
  const component = { schemaVersion: 1, component: "data", repository: "AquilaXk/easysubway-data", gitSha: "a".repeat(40), workflowRunId: "42", dataVersion: "1", releaseSequence: 1, manifestSha256: hash(manifestBytes), provenance: { sourceSnapshotSetHash: "c".repeat(64) }, artifactInventorySha256: hash(inventoryBytes), contractVersion: "datapack-contract-v3", issueRef: "AquilaXk/easysubway-data#529" };
  await Promise.all([writeFile(inventoryPath, inventoryBytes), writeFile(componentPath, json(component))]);
  const output = `${root}.descriptor.json`;
  return { root, tuplePath, inventoryPath, componentPath, output, tuple, component, cleanup: async () => { await rm(output, { force: true }); await rm(root, { recursive: true, force: true }); } };
}
async function entries(root, excluded) { const output = []; async function walk(directory) { for (const entry of await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true })) { const target = path.join(directory, entry.name); if (entry.isDirectory()) await walk(target); else if (entry.isFile() && !excluded.has(target)) { const bytes = await readFile(target); output.push({ path: path.relative(root, target).split(path.sep).join("/"), sizeBytes: bytes.length, sha256: hash(bytes) }); } } } await walk(root); return output.sort((a, b) => a.path.localeCompare(b.path)); }
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
