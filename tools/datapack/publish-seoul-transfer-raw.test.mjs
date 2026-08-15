import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishSeoulTransferRawArtifact } from "./publish-seoul-transfer-raw.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const expectedMainSha = "a".repeat(64);
const gitRunner = async (args) => {
  if (args[0] === "rev-parse") return expectedMainSha;
  if (args[0] === "status") return "";
  throw new Error("unexpected git command");
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-publisher-")); t.after(() => rm(root, { recursive: true, force: true }));
  const observationDirectory = path.join(root, "observation"); await mkdir(observationDirectory);
  const collectedRows = Array.from({ length: 145 }, (_, index) => ({ "연번": index + 1, "호선": 1, "환승역명": `역-${String(index + 1).padStart(3, "0")}`, "환승노선": "1호선", "환승거리": index, "환승소요시간": "00:01" }));
  const rowKey = (row) => ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"].map((key) => row[key]).join("\0");
  const rows = [...collectedRows].sort((left, right) => rowKey(left) < rowKey(right) ? -1 : rowKey(left) > rowKey(right) ? 1 : 0);
  const page = (number, data) => ({ currentCount: data.length, data, matchCount: 145, page: number, perPage: 100, totalCount: 145 });
  const raw = { artifactKind: "seoul-transfer-distance-duration-raw-snapshot", sourceId: "seoul-metro-transfer-distance-duration", pages: [1, 2].map((number) => {
    const body = Buffer.from(JSON.stringify(page(number, number === 1 ? collectedRows.slice(0, 100) : collectedRows.slice(100))));
    return { page: number, perPage: 100, sha256: sha(body), base64: body.toString("base64") };
  }) };
  const rawBytes = bytes(raw); const capturedAt = "2026-07-12T15:00:00.000Z";
  const manifest = { artifactKind: "seoul-transfer-distance-duration-snapshot-manifest", sourceId: "seoul-metro-transfer-distance-duration", capturedAt, freshnessDate: "2025-12-31", rowCount: 145, rawSha256: sha(rawBytes), contentSha256: sha(bytes(rows)), schemaSha256: "a".repeat(64), credentialRedacted: true };
  const observation = { artifactKind: "seoul-transfer-distance-duration-observation", sourceId: manifest.sourceId, capturedAt, rowCount: 145, rawSha256: manifest.rawSha256, contentSha256: manifest.contentSha256, rows, credentialRedacted: true };
  await Promise.all([["manifest.json", bytes(manifest)], ["observation.json", bytes(observation)], ["raw-snapshot.json", rawBytes]].map(([name, body]) => writeFile(path.join(observationDirectory, name), body)));
  return { root, observationDirectory, receiptPath: path.join(root, "receipt.json") };
}
test("transfer publisher publishes the exact private raw snapshot with a credential-free OCI receipt", async (t) => {
  const value = await fixture(t); const calls = []; let stored;
  const receipt = await publishSeoulTransferRawArtifact({ ...value, expectedMainSha, gitRunner, now: new Date("2026-07-12T15:00:01.000Z"), env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o" }, client: { async putObjectIfAbsent(key, value) { calls.push("put"); stored = value; return true; }, async readObject() { calls.push("get"); return { exists: true, body: stored }; } } });
  assert.match(receipt.rawObjectUri, /^oci:\/\/axvym6vk8g7i\/easysubway-datapacks\/source-raw\/seoul-metro-transfer-distance-duration\/20260712\/[a-f0-9]{64}\.json$/u);
  assert.deepEqual(calls, ["put", "get"]); assert.deepEqual(JSON.parse(await readFile(value.receiptPath, "utf8")), receipt);
});

test("wrong HEAD or dirty worktree stops OCI calls and receipt writes", async (t) => {
  for (const response of ["b".repeat(64), "?? untracked"]) {
    const value = await fixture(t); let calls = 0;
    const runner = async (args) => args[0] === "status" ? response : expectedMainSha;
    await assert.rejects(publishSeoulTransferRawArtifact({ ...value, expectedMainSha, gitRunner: runner, env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o" }, client: { async putObjectIfAbsent() { calls += 1; } } }), /exact-main preflight failed/);
    assert.equal(calls, 0);
    await assert.rejects(readFile(value.receiptPath), { code: "ENOENT" });
  }
});

test("three-file reader rejects extra entries and symlinked observation before OCI calls", async (t) => {
  for (const setup of [
    async ({ observationDirectory }) => writeFile(path.join(observationDirectory, "extra.json"), "{}"),
    async ({ observationDirectory }) => { await rm(path.join(observationDirectory, "manifest.json")); await symlink("observation.json", path.join(observationDirectory, "manifest.json")); },
  ]) {
    const value = await fixture(t); await setup(value); let calls = 0;
    await assert.rejects(publishSeoulTransferRawArtifact({ ...value, expectedMainSha, gitRunner, env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o" }, client: { async putObjectIfAbsent() { calls += 1; } } }));
    assert.equal(calls, 0);
  }
});
