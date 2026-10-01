import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishStaticNetworkSourceRaw } from "./publish-static-network-source-raw.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const HEAD = "a".repeat(40);
const PAR = "https://objectstorage.ap-seoul-1.oraclecloud.com/p/token/n/axvym6vk8g7i/b/easysubway-datapacks/o";

test("publisher uses OCI immutable PUT/full GET and exact raw MIME receipts", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-publish-")); t.after(() => rm(operationRoot, { recursive: true, force: true }));
  const objects = new Map(); const client = { putObjectIfAbsent: async (key, value) => { if (objects.has(key)) return false; objects.set(key, Buffer.from(value)); return true; }, readObject: async (key) => objects.has(key) ? { exists: true, body: objects.get(key) } : { exists: false } };
  const gitRunner = async (args) => args[0] === "status" ? "" : HEAD;
  await writeFile(path.join(operationRoot, "positions.raw.json"), "{\"data\":[]}\n");
  const positions = await publishStaticNetworkSourceRaw({ repositoryRoot: ROOT, expectedMainSha: HEAD, expectedHeadSha: HEAD, gitRunner, operationRoot, sourceId: "seoul-metro-route-map-positions", snapshotId: "positions-next", capturedAt: "2026-08-22T00:00:00.000Z", rawRelativePath: "positions.raw.json", env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: PAR }, client, now: new Date("2026-08-22T00:00:01.000Z") });
  await writeFile(path.join(operationRoot, "molit.raw.csv"), "csv\n");
  const csv = await publishStaticNetworkSourceRaw({ repositoryRoot: ROOT, expectedMainSha: HEAD, expectedHeadSha: HEAD, gitRunner, operationRoot, sourceId: "molit-urban-rail-full-route", snapshotId: "molit-next", capturedAt: "2026-08-22T00:00:00.000Z", rawRelativePath: "molit.raw.csv", env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: PAR }, client, now: new Date("2026-08-22T00:00:01.000Z") });
  assert.deepEqual([positions.contentType, csv.contentType], ["application/json", "text/csv; charset=euc-kr"]);
  assert.ok([...objects.keys()].every((key) => key.startsWith("source-raw/")));
});

// #862: 전국 후보 복구 묶음은 PR 브랜치(origin/main의 clean 후손)에서 원천을 갱신한다. FACILITY와 같은
// 가드로 명시한 main·HEAD SHA를 확인하고, 후손이 아닌 HEAD·dirty tree·SHA 불일치는 PUT 전에 막는다.
test("publisher accepts an explicit clean descendant HEAD of origin/main and rejects every other tuple before PUT", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-publish-head-")); t.after(() => rm(operationRoot, { recursive: true, force: true }));
  await writeFile(path.join(operationRoot, "molit.raw.csv"), "csv\n");
  const MAIN = "a".repeat(40); const SELECTED = "b".repeat(40);
  let puts = 0;
  const client = { putObjectIfAbsent: async () => { puts += 1; return true; }, readObject: async () => ({ exists: true, body: Buffer.from("csv\n") }) };
  const runner = ({ head = SELECTED, main = MAIN, status = "", ancestor = true } = {}) => async (args) => {
    if (args[0] === "status") return status;
    if (args[0] === "merge-base") { assert.deepEqual(args, ["merge-base", "--is-ancestor", MAIN, SELECTED]); if (!ancestor) throw new Error("not ancestor"); return ""; }
    return args[1] === "HEAD" ? head : main;
  };
  const publish = (gitRunner, overrides = {}) => publishStaticNetworkSourceRaw({ repositoryRoot: ROOT, expectedMainSha: MAIN, expectedHeadSha: SELECTED, gitRunner, operationRoot, sourceId: "molit-urban-rail-full-route", snapshotId: "molit-next", capturedAt: "2026-08-22T00:00:00.000Z", rawRelativePath: "molit.raw.csv", env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: PAR }, client, now: new Date("2026-08-22T00:00:01.000Z"), ...overrides });
  for (const [gitRunner, overrides] of [
    [runner({ ancestor: false }), {}],
    [runner({ status: " M tools/datapack/source-inventory.json\n" }), {}],
    [runner({ head: "c".repeat(40) }), {}],
    [runner({ main: "c".repeat(40) }), {}],
    [runner(), { expectedHeadSha: undefined }],
  ]) {
    await assert.rejects(publish(gitRunner, overrides), /preflight failed|arguments are invalid/);
  }
  assert.equal(puts, 0);
  const receipt = await publish(runner());
  assert.equal(puts, 1);
  assert.equal(receipt.sourceId, "molit-urban-rail-full-route");
});
