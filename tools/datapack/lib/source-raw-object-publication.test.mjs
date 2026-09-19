import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishSourceRawObject, validateSourceRawObjectReceipt } from "./source-raw-object-publication.mjs";

test("source raw publication performs one immutable PUT and GET without adopting an existing object", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-raw-publication-"));
  try {
    const bytes = Buffer.from('{"fixtureClass":"TEST_ONLY"}\n');
    const sourcePath = path.join(root, "snapshot.json");
    await writeFile(sourcePath, bytes);
    const calls = [];
    const options = {
      sourcePath, sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length, target: { objectKey: "test-only/snapshot.json" },
      label: "Test source", client: {
        putObjectIfAbsent: async () => { calls.push("PUT"); return true; },
        readObject: async () => { calls.push("GET"); return { exists: true, body: bytes }; },
      },
    };
    await publishSourceRawObject(options);
    assert.deepEqual(calls, ["PUT", "GET"]);
    calls.length = 0;
    options.client.putObjectIfAbsent = async () => { calls.push("PUT"); return false; };
    await assert.rejects(publishSourceRawObject(options), /^Error: Test source OCI publication failed$/u);
    assert.deepEqual(calls, ["PUT"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source raw receipt preserves closed identity, content, retention and observation-time binding", () => {
  const capturedAt = "2000-01-01T00:00:00.000Z";
  const expected = {
    sourceId: "test-only-source", snapshotId: "test-only-snapshot", capturedAt,
    rawObjectSha256: "a".repeat(64), byteSize: 31,
    rawRetentionExpiresAt: "2000-04-01T00:00:00.000Z",
  };
  const target = {
    ociNamespace: "test-only", bucket: "test-only", objectKey: "test-only/snapshot.json",
    rawObjectUri: "oci://test-only/test-only/test-only/snapshot.json",
  };
  const receipt = {
    schemaVersion: 1, artifactKind: "static-network-source-raw-object-receipt",
    ...expected, ...target, storedAt: capturedAt, contentType: "application/json",
  };
  const options = { expected, target, now: new Date(capturedAt), label: "Test source" };
  validateSourceRawObjectReceipt({ ...options, receipt });
  for (const key of Object.keys(receipt)) {
    assert.throws(() => validateSourceRawObjectReceipt({
      ...options, receipt: { ...receipt, [key]: "unbound" },
    }), /OCI receipt binding is invalid/u, key);
  }
  assert.throws(() => validateSourceRawObjectReceipt({ ...options, receipt: { ...receipt, extra: true } }), /binding/u);
  for (const storedAt of ["1999-12-31T23:59:59.000Z", "2000-01-01T00:00:01.000Z"]) {
    assert.throws(() => validateSourceRawObjectReceipt({ ...options, receipt: { ...receipt, storedAt } }), /binding/u);
  }
});
