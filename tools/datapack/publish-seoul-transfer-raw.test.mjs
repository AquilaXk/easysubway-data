import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishSeoulTransferRawArtifact } from "./publish-seoul-transfer-raw.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const expectedMainSha = "a".repeat(40);
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
  const manifest = { artifactKind: "seoul-transfer-distance-duration-snapshot-manifest", sourceId: "seoul-metro-transfer-distance-duration", endpointSha256: sha("https://api.odcloud.kr"), capturedAt, freshnessDate: "2025-12-31", rowCount: 145, rawSha256: sha(rawBytes), contentSha256: sha(bytes(rows)), schemaSha256: sha(bytes({ fields: ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"] })), credentialRedacted: true };
  const observation = { artifactKind: "seoul-transfer-distance-duration-observation", sourceId: manifest.sourceId, capturedAt, rowCount: 145, rawSha256: manifest.rawSha256, contentSha256: manifest.contentSha256, rows, credentialRedacted: true };
  await Promise.all([["manifest.json", bytes(manifest)], ["observation.json", bytes(observation)], ["raw-snapshot.json", rawBytes]].map(([name, body]) => writeFile(path.join(observationDirectory, name), body)));
  const sourceCandidatesBytes = bytes({ candidates: [{ id: "seoul-metro-transfer-distance-duration", requestUrl: "https://api.odcloud.kr", operation: { endpoint: "https://api.odcloud.kr", method: "GET" }, evidence: { outputFields: ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"] } }] });
  return { root, observationDirectory, receiptPath: path.join(root, "receipt.json"), sourceCandidatesBytes };
}
test("transfer publisher publishes the exact private raw snapshot with a credential-free OCI receipt", async (t) => {
  const value = await fixture(t); const calls = []; let stored;
  const receipt = await publishSeoulTransferRawArtifact({ ...value, expectedMainSha, gitRunner, now: new Date("2026-07-12T15:00:01.000Z"), env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o" }, client: { async putObjectIfAbsent(key, value) { calls.push("put"); stored = value; return true; }, async readObject() { calls.push("get"); return { exists: true, body: stored }; } } });
  assert.match(receipt.rawObjectUri, /^oci:\/\/axvym6vk8g7i\/easysubway-datapacks\/source-raw\/seoul-metro-transfer-distance-duration\/20260712\/[a-f0-9]{64}\.json$/u);
  assert.deepEqual(calls, ["put", "get"]); assert.deepEqual(JSON.parse(await readFile(value.receiptPath, "utf8")), receipt);
});

test("wrong HEAD or dirty worktree stops OCI calls and receipt writes", async (t) => {
  for (const response of ["b".repeat(40), "?? untracked"]) {
    const value = await fixture(t); let calls = 0;
    const runner = async (args) => args[0] === "status" ? response : expectedMainSha;
    await assert.rejects(publishSeoulTransferRawArtifact({ ...value, expectedMainSha, gitRunner: runner, env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o" }, client: { async putObjectIfAbsent() { calls += 1; } } }), /exact-main preflight failed/);
    assert.equal(calls, 0);
    await assert.rejects(readFile(value.receiptPath), { code: "ENOENT" });
  }
});

test("preflight rejects a non-git-object expected SHA before OCI calls", async (t) => {
  const value = await fixture(t); let calls = 0;
  await assert.rejects(publishSeoulTransferRawArtifact({ ...value, expectedMainSha: "a".repeat(64), gitRunner, env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o" }, client: { async putObjectIfAbsent() { calls += 1; } } }), /exact-main preflight arguments are invalid/);
  assert.equal(calls, 0);
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

test("resealed duplicate/missing serial observation is rejected before OCI", async (t) => {
  const value = await fixture(t); const rawPath = path.join(value.observationDirectory, "raw-snapshot.json"); const observationPath = path.join(value.observationDirectory, "observation.json"); const manifestPath = path.join(value.observationDirectory, "manifest.json");
  const raw = JSON.parse(await readFile(rawPath, "utf8")); const first = JSON.parse(Buffer.from(raw.pages[0].base64, "base64"));
  first.data[0]["연번"] = 2; const pageBytes = Buffer.from(JSON.stringify(first)); raw.pages[0].base64 = pageBytes.toString("base64"); raw.pages[0].sha256 = sha(pageBytes);
  const rawBytes = bytes(raw); const observation = JSON.parse(await readFile(observationPath, "utf8")); observation.rows.find((row) => row["연번"] === 1)["연번"] = 2; observation.rawSha256 = sha(rawBytes); observation.contentSha256 = sha(bytes(observation.rows));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.rawSha256 = observation.rawSha256; manifest.contentSha256 = observation.contentSha256;
  await Promise.all([[rawPath, rawBytes], [observationPath, bytes(observation)], [manifestPath, bytes(manifest)]].map(([file, body]) => writeFile(file, body)));
  let calls = 0;
  await assert.rejects(publishSeoulTransferRawArtifact({ ...value, expectedMainSha, gitRunner, env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o" }, client: { async putObjectIfAbsent() { calls += 1; } } }), /transfer observation rows mismatch/);
  assert.equal(calls, 0);
});

test("resealed raw wrapper fields and endpoint hash are rejected before OCI", async (t) => {
  const invoke = async (value) => publishSeoulTransferRawArtifact({ ...value, expectedMainSha, gitRunner, env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o" }, client: { async putObjectIfAbsent() { throw new Error("must not publish"); } } });
  const extra = await fixture(t); const rawPath = path.join(extra.observationDirectory, "raw-snapshot.json"); const manifestPath = path.join(extra.observationDirectory, "manifest.json");
  const raw = JSON.parse(await readFile(rawPath, "utf8")); raw.pages[0].unexpected = true; const rawBytes = bytes(raw);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.rawSha256 = sha(rawBytes);
  const observationPath = path.join(extra.observationDirectory, "observation.json"); const observation = JSON.parse(await readFile(observationPath, "utf8")); observation.rawSha256 = manifest.rawSha256;
  await Promise.all([[rawPath, rawBytes], [observationPath, bytes(observation)], [manifestPath, bytes(manifest)]].map(([file, body]) => writeFile(file, body)));
  await assert.rejects(invoke(extra), /raw page keys mismatch/);

  const endpoint = await fixture(t); const endpointManifestPath = path.join(endpoint.observationDirectory, "manifest.json");
  const endpointManifest = JSON.parse(await readFile(endpointManifestPath, "utf8")); endpointManifest.endpointSha256 = sha("https://alternate.example"); await writeFile(endpointManifestPath, bytes(endpointManifest));
  await assert.rejects(invoke(endpoint), /NO_GO observation identity mismatch/);
});
