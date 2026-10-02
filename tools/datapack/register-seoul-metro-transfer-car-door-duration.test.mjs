import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SOURCE_ID, buildSeoulMetroTransferSnapshot } from "./collect-seoul-metro-transfer-car-door-duration.mjs";
import { SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import { publishAndRegisterSeoulMetroTransfer } from "./register-seoul-metro-transfer-car-door-duration.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";

// #876: 15098252 원문 snapshot을 OCI source-raw에 한 번 발행하고 inventory·원장·governance·신선도 정책을 원자 등록한다.
const ROOT = path.resolve(import.meta.dirname, "../..");
const SAMPLE = Buffer.from("IrDtwK+5+MijIiwiyK+9wr3DwNu/qiIsIsivvcK9w8Dbv6ogxNq15SIsIsivvcK9w8DbIMijvLEiLCLHz8L3IL+twvcguea46SIsIsfPwvfAp8ShKMijwvcpIiwix8/C98CnxKEoua4pIiwiyK+9wsG+t+G/qiIsIsivvcIgv63C9yC55rjpIiwiyK+9wiC9wsL3wKfEoSjIo8L3KSIsIsivvcIgvcLC98CnxKEoua4pIiwivNK/5L3DsKMiDQoxLLytv++/qiwiMDE1MCIsIjEiLL3Dw7sguea46SwiMTAiLCI0IiwiMDQyNyIsvPe068DUsbgguea46SwiMSIsIjEiLCIwMzozNCINCjIsvK2/77+qLCIwMTUwIiwiMSIss7K/tSC55rjpLCIxIiwiMiIsIjA0MjUiLMi4x/Yguea46SwiMTAiLCI0IiwiMDM6NDAiDQozLLytv++/qiwiMDE1MCIsIjEiLLOyv7Uguea46SwiMSIsIjIiLCIwNDI3Iiy897TrwNSxuCC55rjpLCIxIiwiMSIsIjAzOjM0Ig0KNCy8rb/vv6osIjAxNTAiLCIxIiy9w8O7ILnmuOksIjEwIiwiNCIsIjA0MjUiLMi4x/Yguea46SwiMTAiLCI0IiwiMDM6NDAiDQo3Nyyx3cO1sbjDuywiMTcwMyIsIjEiLLyuvPYguea46SwiNyIsIjEiLCIxNzUwIiyxpLjtILnmuOksIjciLCIxIiwiMDA6MDAiDQoxNDQsvLq89iwiMDIxMSIsIjIiLLDHtOvA1LG4ILnmuOksIjEwIiwiNCIsIjAyNDQiLL/rtOQguea46SwiMSIsIjEiLCIwMzozMiINCjE0NSy8urz2LCIwMjExIiwiMiIsttK8tiC55rjpLEFsbCxBbGwsIjAyNDQiLL/rtOQguea46SxBbGwsQWxsLCIwMDowNSINCjU1NyzAzLz2LCIyNzM4IiwiNyIss7u55iC55rjpLCIyIiwiMiIsIjA0MzEiLLW/wNsguea46SwiMSIsIjEiLCIwNToxNyINCjcxMizB37b7LCIxMjAxIiyw5sDHvLEsyLix4iC55rjpLCI1IiwiMSIsIjEzMDkiLLvzusAguea46SwiMSIsIjIiLA0KNzEzLMHftvssIjEyMDEiLLDmwMe8sSy787rAILnmuOksIjgiLCIyIiwiMTMwOSIsu/O6wCC55rjpLCIzIiwiMyIsIjAxOjAwIg0KNzE0LMHftvssIjEyMDEiLLDmwMe8sSzIuLHiILnmuOksIjEiLCIyIiwiMTMwNyIsyLix4iC55rjpLCI1IiwiMiIsIjAwOjAwIg0KNzE2LMHftvssIjEyMDEiLLDmwMe8sSzIuLHiILnmuOksIjEiLCIyIiwiMTMwNyIsyLix4iC55rjpLCI0IiwiNCIsIjAwOjAwIg0KOTk5LLyus7IsIjMyMTMiLMDOw7UyLLChwaTB377TvcPA5SC55rjpLCIyIiwiMyIsIjM3NjIiLLvqsO4guea46SwiMSIsIjQiLCIwNTo0NSINCg==", "base64");
const HEAD = "a".repeat(40);
const ENV = { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/fixture-token/n/axvym6vk8g7i/b/easysubway-datapacks/o/" };
const NOW = new Date("2026-10-02T03:00:00.000Z");
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function workspace(t, mutateCandidates = (value) => value) {
  const root = await mkdtemp(path.join(os.tmpdir(), "seoul-transfer-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of [...SOURCE_REGISTRATION_OUTPUTS, "tools/datapack/source-candidates.json"]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    let bytes = await readFile(path.join(ROOT, relative));
    if (relative === "tools/datapack/source-candidates.json") bytes = Buffer.from(JSON.stringify(mutateCandidates(JSON.parse(bytes)), null, 2));
    await writeFile(path.join(root, relative), bytes);
  }
  await mkdir(path.join(root, "tools/datapack/sources"), { recursive: true });
  const snapshot = buildSeoulMetroTransferSnapshot({ rawBytes: SAMPLE, capturedAt: "2026-10-02T02:00:00.000Z", sourceFileName: "서울교통공사_서울 도시철도 환승정보_20260902.csv" });
  const snapshotPath = path.join(root, "input-snapshot.json");
  await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
  return { root, snapshotPath, snapshotBytes: await readFile(snapshotPath), receiptPath: path.join(root, "receipt.json") };
}

function memoryClient() {
  const objects = new Map();
  return {
    objects,
    putObjectIfAbsent: async (key, bytes) => { if (objects.has(key)) return false; objects.set(key, Buffer.from(bytes)); return true; },
    readObject: async (key) => (objects.has(key) ? { exists: true, body: objects.get(key) } : { exists: false }),
  };
}

test("원문 snapshot을 한 번 발행하고 inventory admission·원장 행·governance·신선도를 함께 등록한다", async (t) => {
  const { root, snapshotPath, snapshotBytes, receiptPath } = await workspace(t);
  const client = memoryClient();
  await publishAndRegisterSeoulMetroTransfer({
    repositoryRoot: root, snapshotPath, receiptPath, expectedHeadSha: HEAD, gitRunner: async () => `${HEAD}\n`, env: ENV, client, now: NOW,
  });
  const snapshotId = `${SOURCE_ID}-${sha(snapshotBytes)}`;
  const objectKey = `source-raw/${SOURCE_ID}/20261002/${sha(snapshotBytes)}.json`;
  assert.deepEqual([...client.objects.keys()], [objectKey]);
  assert.ok(client.objects.get(objectKey).equals(snapshotBytes));
  assert.ok((await readFile(path.join(root, `tools/datapack/sources/${snapshotId}.json`))).equals(snapshotBytes));
  // #879 F1: OCI 영수증은 원장 영수증 hash와 같은 바이트로 저장소에 보존된다(후보 시계 ≥ 저장 시각 검사용).
  const keptReceipt = await readFile(path.join(root, `tools/datapack/sources/${snapshotId}.receipt.json`));
  assert.ok(keptReceipt.equals(await readFile(receiptPath)));
  assert.equal(JSON.parse(keptReceipt).storedAt, NOW.toISOString());

  const read = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const inventory = await read("tools/datapack/source-inventory.json");
  const source = inventory.sources.find(({ id }) => id === SOURCE_ID);
  assert.equal(inventory.sources.at(-1).id, SOURCE_ID, "새 원천은 inventory 끝에 하나만 붙는다");
  assert.equal(source.requiredForProductionPack, false, "후보 선택 집합 밖 원천이다");
  assert.equal(source.admissionEvidence.snapshotId, snapshotId);
  assert.equal(source.admissionEvidence.decision, "APPROVED");
  assert.equal(source.admissionEvidence.approvedBy, "AquilaXk");
  assert.equal(source.admissionEvidence.issue, 876);
  assert.equal(source.admissionEvidence.rawObjectUri, `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`);
  assert.equal(source.observedDataUpdatedAt, "2026-09-02");

  const ledger = await read("tools/datapack/release/source-snapshots.json");
  const row = ledger.at(-1);
  assert.equal(row.sourceId, SOURCE_ID);
  assert.equal(row.snapshotId, snapshotId);
  assert.equal(row.freshnessExpiresAt, "2027-10-02T02:00:00.000Z", "annual_official_file(P1Y, observedAt 기준)");
  assert.equal(row.rawObjectSha256, sha(snapshotBytes));
  assert.equal(row.rawReceiptSha256, sha(keptReceipt));
  assert.equal(validateLineage(ledger).headsBySource[SOURCE_ID], snapshotId);

  const governance = await read("tools/datapack/source-governance-policy.json");
  assert.equal(governance.sources.at(-1).sourceId, SOURCE_ID);
  assert.deepEqual(governance.registrationLineage.addedSourceIds, [SOURCE_ID]);
  const freshness = await read("release/product-gates/datapack-freshness-sla.json");
  assert.ok(freshness.sourceClasses.find(({ id }) => id === "annual_official_file").sourceIds.includes(SOURCE_ID));
});

test("후보에 QA 승인 기록이 없거나 실행 HEAD가 다르면 발행 전에 실패한다", async (t) => {
  const withoutApproval = await workspace(t, (value) => {
    delete value.candidates.find(({ id }) => id === SOURCE_ID).registrationMetadata.approval;
    return value;
  });
  const client = memoryClient();
  await assert.rejects(publishAndRegisterSeoulMetroTransfer({
    repositoryRoot: withoutApproval.root, snapshotPath: withoutApproval.snapshotPath, receiptPath: withoutApproval.receiptPath,
    expectedHeadSha: HEAD, gitRunner: async () => HEAD, env: ENV, client, now: NOW,
  }), /recorded approval, governance and freshness binding is required/u);
  const other = await workspace(t);
  await assert.rejects(publishAndRegisterSeoulMetroTransfer({
    repositoryRoot: other.root, snapshotPath: other.snapshotPath, receiptPath: other.receiptPath,
    expectedHeadSha: HEAD, gitRunner: async () => "b".repeat(40), env: ENV, client, now: NOW,
  }), /execution HEAD mismatch/u);
  assert.equal(client.objects.size, 0);
});
