import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseRecoveryArgs, recoverCurrentLiveChainTransferObservation } from "./recover-current-live-chain-transfer-observation.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const endpoint = "https://api.odcloud.kr/api/15044419/v1/uddi:7008c675-928f-41d6-9a01-b3541f78466b";

test("recovery CLI accepts only the exact two absolute-path arguments", () => {
  assert.deepEqual(parseRecoveryArgs(["--repository-root", "/tmp/repository", "--recovery-root", "/tmp/recovery"]), { repositoryRoot: "/tmp/repository", recoveryRoot: "/tmp/recovery" });
  for (const argv of [[], ["--recovery-root", "/tmp/recovery", "--repository-root", "/tmp/repository"], ["--repository-root", "relative", "--recovery-root", "/tmp/recovery"]]) {
    assert.throws(() => parseRecoveryArgs(argv), /arguments must be|must be absolute/);
  }
});

test("one PAR GET recovers the full locked receipt and invokes TRANSFER rebind once without PUT", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-recovery-root-"));
  const recovery = path.join(root, "recovery");
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = rawSnapshot(); const rawBytes = bytes(raw); const capturedAt = "2026-08-15T09:40:38.817Z";
  const receipt = fullReceipt({ rawBytes, capturedAt });
  await writeRepoInputs(root, receipt);
  const calls = []; let rebound = 0;
  const result = await recoverCurrentLiveChainTransferObservation({
    repositoryRoot: root, recoveryRoot: recovery,
    env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o" },
    client: { async readObject(key) { calls.push(key); return { exists: true, body: rawBytes }; } },
    rebind: async ({ observationDirectory, receiptPath }) => {
      rebound += 1;
      assert.equal((await readFile(path.join(observationDirectory, "raw-snapshot.json"))).equals(rawBytes), true);
      assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), receipt);
      return { targets: ["eight"] };
    },
  });
  assert.deepEqual(calls, [receipt.objectKey]);
  assert.equal(rebound, 1);
  assert.deepEqual(result, { targets: ["eight"] });
});

test("receipt/retention/body drift stops before recovery output or rebind", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-recovery-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rawBytes = bytes(rawSnapshot()); const receipt = fullReceipt({ rawBytes, capturedAt: "2026-08-15T09:40:38.817Z" });
  await writeRepoInputs(root, receipt);
  for (const [name, ledger, body, expectedCalls] of [
    ["receipt", [{ ...ledgerRow(receipt), rawReceipt: { ...receipt, bucket: "wrong" } }], rawBytes, 0],
    ["retention", [{ ...ledgerRow({ ...receipt, rawRetentionExpiresAt: "2026-08-15T09:40:39.000Z" }) }], rawBytes, 0],
    ["body", [ledgerRow(receipt)], Buffer.from("wrong"), 1],
  ]) {
    await writeFile(path.join(root, "tools/datapack/release/source-snapshots.json"), JSON.stringify(ledger));
    let calls = 0; let rebound = 0; const recovery = path.join(root, `recovery-${name}`);
    await assert.rejects(() => recoverCurrentLiveChainTransferObservation({ repositoryRoot: root, recoveryRoot: recovery,
      env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o" },
      client: { async readObject() { calls += 1; return { exists: true, body }; } }, rebind: async () => { rebound += 1; },
    }));
    assert.equal(calls, expectedCalls); assert.equal(rebound, 0);
    await assert.rejects(readFile(path.join(recovery, "raw-snapshot.json")), { code: "ENOENT" });
  }
});

function rawSnapshot() {
  const rows = Array.from({ length: 145 }, (_, index) => ({ "연번": index + 1, "호선": 1, "환승역명": `역${index + 1}`, "환승노선": "2호선", "환승거리": index, "환승소요시간": "00:01" }));
  return { artifactKind: "seoul-transfer-distance-duration-raw-snapshot", sourceId: "seoul-metro-transfer-distance-duration", pages: [rows.slice(0, 100), rows.slice(100)].map((data, index) => {
    const page = { currentCount: data.length, data, matchCount: 145, page: index + 1, perPage: 100, totalCount: 145 }; const body = Buffer.from(JSON.stringify(page));
    return { page: index + 1, perPage: 100, sha256: sha(body), base64: body.toString("base64") };
  }) };
}
function fullReceipt({ rawBytes, capturedAt }) {
  const rawSha = sha(rawBytes); const date = capturedAt.slice(0, 10).replaceAll("-", "");
  const raw = JSON.parse(rawBytes); const fields = ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"];
  const rows = raw.pages.flatMap((page) => JSON.parse(Buffer.from(page.base64, "base64")).data).sort((left, right) => codepointCompare(fields.map((field) => left[field]).join("\0"), fields.map((field) => right[field]).join("\0")));
  const manifest = { artifactKind: "seoul-transfer-distance-duration-snapshot-manifest", sourceId: "seoul-metro-transfer-distance-duration", endpointSha256: sha(endpoint), capturedAt, freshnessDate: "2025-12-31", rowCount: 145, rawSha256: rawSha, contentSha256: sha(bytes(rows)), schemaSha256: sha(bytes({ fields })), credentialRedacted: true };
  const observation = { artifactKind: "seoul-transfer-distance-duration-observation", sourceId: manifest.sourceId, capturedAt, rowCount: 145, rawSha256: rawSha, contentSha256: manifest.contentSha256, rows, credentialRedacted: true };
  return { schemaVersion: 1, artifactKind: "seoul-transfer-raw-object-receipt", sourceId: "seoul-metro-transfer-distance-duration", snapshotId: `seoul-metro-transfer-distance-duration-${capturedAt.replaceAll(/[-:.]/gu, "")}`, snapshotRawSha256: rawSha, capturedAt, manifestSha256: sha(bytes(manifest)), observationSha256: sha(bytes(observation)), rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/seoul-metro-transfer-distance-duration/${date}/${rawSha}.json`, rawObjectSha256: rawSha, ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey: `source-raw/seoul-metro-transfer-distance-duration/${date}/${rawSha}.json`, capturedDate: date, byteSize: rawBytes.length, storedAt: "2026-08-16T00:16:05.177Z", rawRetentionExpiresAt: "2026-11-13T09:40:38.817Z" };
}
function ledgerRow(receipt) { return { sourceId: receipt.sourceId, snapshotId: receipt.snapshotId, snapshotStatus: "LOCKED", fetchStatus: "SUCCESS", rawSha256: receipt.rawObjectSha256, rowCount: 145, contentSha256: "c".repeat(64), schemaFingerprint: "d".repeat(64), rawObjectUri: receipt.rawObjectUri, rawReceipt: receipt }; }
async function writeRepoInputs(root, receipt) {
  await mkdir(path.join(root, "tools/datapack/release"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "tools/datapack/release/source-snapshots.json"), JSON.stringify([ledgerRow(receipt)])),
    writeFile(path.join(root, "tools/datapack/source-candidates.json"), JSON.stringify({ candidates: [{ id: "seoul-metro-transfer-distance-duration", requestUrl: endpoint, operation: { endpoint, method: "GET", auth: { env: "DATA_GO_KR_SERVICE_KEY", parameter: "serviceKey", placement: "query", valueEncoding: "url-search-params-once", loadPolicy: "process-env-no-shell-parsing" }, requiredParameters: ["serviceKey", "page", "perPage", "returnType"] }, evidence: { endpoint, outputFields: ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"], coverageLimitations: ["145개 환승역(2025-12-31 기준) 커버"] } }] })),
  ]);
}
