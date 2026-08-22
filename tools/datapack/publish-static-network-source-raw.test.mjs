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
  await writeFile(path.join(operationRoot, "raw.js"), "var lines = {};\n");
  const js = await publishStaticNetworkSourceRaw({ repositoryRoot: ROOT, expectedMainSha: HEAD, gitRunner, operationRoot, sourceId: "seoulmetro-cyberstation-route-map", snapshotId: "route-next", capturedAt: "2026-08-22T00:00:00.000Z", rawRelativePath: "raw.js", env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: PAR }, client, now: new Date("2026-08-22T00:00:01.000Z") });
  await writeFile(path.join(operationRoot, "raw.csv"), "csv\n");
  const csv = await publishStaticNetworkSourceRaw({ repositoryRoot: ROOT, expectedMainSha: HEAD, gitRunner, operationRoot, sourceId: "molit-urban-rail-full-route", snapshotId: "molit-next", capturedAt: "2026-08-22T00:00:00.000Z", rawRelativePath: "raw.csv", env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: PAR }, client, now: new Date("2026-08-22T00:00:01.000Z") });
  assert.deepEqual([js.contentType, csv.contentType], ["application/javascript", "text/csv; charset=euc-kr"]);
  assert.ok([...objects.keys()].every((key) => key.startsWith("source-raw/")));
});
