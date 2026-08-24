import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishCandidateOciArtifact } from "./publish-candidate-oci-artifact.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("payload 전량 conditional create·GET readback 뒤 descriptor를 마지막으로 저장한다", async () => {
  const fixture = await createFixture(); const calls = []; const stored = new Map();
  const client = { async putObjectIfAbsent(key, bytes) { calls.push(`put:${key}`); if (stored.has(key)) return false; stored.set(key, Buffer.from(bytes)); return true; }, async readObject(key) { calls.push(`get:${key}`); return stored.has(key) ? { exists: true, body: stored.get(key) } : { exists: false }; } };
  try { const result = await publishCandidateOciArtifact({ root: fixture.root, descriptor: fixture.descriptorPath, client }); assert.equal(result.artifactId, hash(await readFile(fixture.descriptorPath))); assert.equal(calls.at(-2).startsWith("put:candidates/v1/runs/42/"), true); assert.equal(calls.at(-1).startsWith("get:candidates/v1/runs/42/"), true); assert.equal([...stored].length, 3); } finally { await fixture.cleanup(); }
});
test("payload readback failure는 descriptor write와 success를 만들지 않는다", async () => {
  const fixture = await createFixture(); const calls = []; const client = { async putObjectIfAbsent(key) { calls.push(`put:${key}`); return true; }, async readObject(key) { calls.push(`get:${key}`); return { exists: true, body: Buffer.from("wrong") }; } };
  try { await assert.rejects(publishCandidateOciArtifact({ root: fixture.root, descriptor: fixture.descriptorPath, client })); assert.equal(calls.filter((call) => call.startsWith("put:")).length, 1); } finally { await fixture.cleanup(); }
});
async function createFixture() { const root = await mkdtemp(path.join(os.tmpdir(), "candidate-oci-publish-")); const one = Buffer.from("one\n"); const two = Buffer.from("two\n"); await writeFile(path.join(root, "one.json"), one); await writeFile(path.join(root, "two.json"), two); const prefix = "candidates/v1/runs/42/heads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/candidates/candidate-1/"; const descriptor = { schemaVersion: 1, artifactKind: "datapack-candidate-oci-artifact-descriptor", repository: "AquilaXk/easysubway-data", workflowRunId: "42", headSha: "a".repeat(40), artifactName: "easysubway-datapack-candidate-42", candidateBinding: { candidateId: "candidate-1", buildSpecSha256: "b".repeat(64), manifestSha256: "c".repeat(64) }, freshnessExpiresAt: "2026-08-25T00:00:00.000Z", createdAt: "2026-08-24T00:00:00.000Z", expiresAt: "2026-08-25T00:00:00.000Z", inventory: { path: "one.json", sizeBytes: one.length, sha256: hash(one) }, component: { path: "two.json", sizeBytes: two.length, sha256: hash(two) }, tuple: { path: "one.json", sizeBytes: one.length, sha256: hash(one) }, objects: [{ path: "one.json", sizeBytes: one.length, sha256: hash(one), objectKey: `${prefix}objects/${hash(one)}/one.json`, ociUri: `oci://namespace/candidate-private/${prefix}objects/${hash(one)}/one.json` }, { path: "two.json", sizeBytes: two.length, sha256: hash(two), objectKey: `${prefix}objects/${hash(two)}/two.json`, ociUri: `oci://namespace/candidate-private/${prefix}objects/${hash(two)}/two.json` }] }; const descriptorPath = path.join(root, "descriptor.json"); await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`); return { root, descriptorPath, cleanup: () => rm(root, { recursive: true, force: true }) }; }
