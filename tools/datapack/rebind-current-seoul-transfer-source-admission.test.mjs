import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";
import {
  parseSeoulTransferRebindArgs,
  rebindCurrentSeoulTransferSourceAdmission,
  SEOUL_TRANSFER_REBIND_OUTPUTS,
} from "./rebind-current-seoul-transfer-source-admission.mjs";
import {
  deriveSeoulTransferFixtureEvidence,
  rewriteSeoulTransferFixtureCanonicalPack,
  SEOUL_TRANSFER_REBIND_PAR_BASE_URL,
  SEOUL_TRANSFER_REBIND_PATHS as PATHS,
  SEOUL_TRANSFER_SOURCE_ID,
  seoulTransferFixtureLineId,
  writeSeoulTransferRebindRepository,
} from "./test-fixtures/seoul-transfer-rebind-repository.mjs";
import { validateProductionTransferArtifacts, validateTransferAdmissionEvidence } from "./validate-source-inventory.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const env = { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: SEOUL_TRANSFER_REBIND_PAR_BASE_URL };
const NOW = new Date("2026-10-02T09:00:00.000Z");

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "seoul-transfer-rebind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, fixture: await writeSeoulTransferRebindRepository(root) };
}
function lockedRawClient(body, calls = []) {
  return {
    calls,
    async readObject(key, options) { calls.push({ method: "GET", key, options }); return body === null ? { exists: false } : { exists: true, body }; },
    async putObject() { calls.push({ method: "PUT" }); throw new Error("PUT is not allowed"); },
    async putObjectIfAbsent() { calls.push({ method: "PUT" }); throw new Error("PUT is not allowed"); },
  };
}
async function snapshot(root, relatives) {
  return new Map(await Promise.all(relatives.map(async (relative) => [relative, await readFile(path.join(root, relative))])));
}
function outputPaths(fixture) {
  return [PATHS.metrics, PATHS.applicability, fixture.descriptorPath, PATHS.inventory, PATHS.ledger];
}
// 일일 activate 단계처럼 환승 분모와 무관한 정본 팩 내용(서명 키 id)만 바꾼다.
const rotateKeyId = (pack) => { pack.manifest.keyId = "fixture-key-rotated"; };

test("CLI는 절대 경로 --repository-root 하나만 받는다", () => {
  assert.deepEqual(parseSeoulTransferRebindArgs(["--repository-root", "/tmp/repository"]), { repositoryRoot: "/tmp/repository" });
  for (const argv of [[], ["--repository-root", "relative"], ["--repository-root", "/tmp/repository", "--force"], ["--root", "/tmp/repository"]]) {
    assert.throws(() => parseSeoulTransferRebindArgs(argv), /arguments must be --repository-root <absolute>/);
  }
});

test("재결속 출력은 환승 원천 admission 5개 경로뿐이다(후보·request·hash는 refresh-nationwide-candidate가 만든다)", () => {
  assert.deepEqual(SEOUL_TRANSFER_REBIND_OUTPUTS("tools/datapack/sources/seoul-metro-transfer-distance-duration-20260815T094038817Z.json"), [
    "tools/datapack/release/current-transfer-topology-metrics.json",
    "tools/datapack/release/current-capital-transfer-topology-applicability.json",
    "tools/datapack/sources/seoul-metro-transfer-distance-duration-20260815T094038817Z.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
  ]);
  assert.throws(() => SEOUL_TRANSFER_REBIND_OUTPUTS("tools/datapack/sources/other.json"), /TRANSFER descriptor path mismatch/);
});

test("정본 팩이 바뀌면 잠긴 OCI raw 한 번 GET으로 지표·applicability·descriptor·inventory·원장을 새 팩에 재결속하고 값은 같다", async (t) => {
  const { root, fixture } = await repository(t);
  const nextPackBytes = await rewriteSeoulTransferFixtureCanonicalPack(root, rotateKeyId);
  // RED 재현: 커밋된 지표는 이전 팩 sha에 묶여 있어 현재 팩으로 applicability를 다시 만들 수 없다.
  assert.throws(() => buildApplicability({
    canonicalPack: JSON.parse(nextPackBytes), canonicalPackBytes: nextPackBytes,
    transferTopologyMetrics: fixture.metrics, metricsBytes: fixture.metricsBytes,
  }), /NO_GO canonical identity mismatch/);
  const untouched = await snapshot(root, [PATHS.canonicalPack, PATHS.sourceCandidates, PATHS.kricCatalog]);

  const calls = [];
  const result = await rebindCurrentSeoulTransferSourceAdmission({ repositoryRoot: root, env, now: NOW, client: lockedRawClient(fixture.rawBytes, calls) });

  assert.deepEqual(calls, [{ method: "GET", key: fixture.receipt.objectKey, options: { maxResponseBytes: fixture.receipt.byteSize } }]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.targets, outputPaths(fixture));
  assert.equal(result.previousCanonicalPackSha256, sha256(lineBytesOf(fixture.canonicalPack)));
  assert.equal(result.canonicalPackSha256, sha256(nextPackBytes));
  for (const [relative, bytes] of untouched) assert.ok((await readFile(path.join(root, relative))).equals(bytes), relative);

  // 현재 생성기로 새 팩에서 다시 만든 기대값과 바이트가 같다.
  const expected = deriveSeoulTransferFixtureEvidence({ ...fixture, canonicalPackBytes: nextPackBytes });
  const [metricsBytes, applicabilityBytes, descriptorBytes, inventoryBytes, ledgerBytes] = await Promise.all(outputPaths(fixture).map((relative) => readFile(path.join(root, relative))));
  assert.ok(metricsBytes.equals(expected.metricsBytes));
  assert.ok(applicabilityBytes.equals(expected.applicabilityBytes));
  assert.ok(descriptorBytes.equals(expected.descriptorBytes));

  // 실패하던 두 계약(현재 팩으로 applicability 재생성, inventory 산출물 결속)이 통과한다.
  const metrics = JSON.parse(metricsBytes);
  assert.deepEqual(buildApplicability({ canonicalPack: JSON.parse(nextPackBytes), canonicalPackBytes: nextPackBytes, transferTopologyMetrics: metrics, metricsBytes }), JSON.parse(applicabilityBytes));
  const inventory = JSON.parse(inventoryBytes);
  const source = inventory.sources.find(({ id }) => id === SEOUL_TRANSFER_SOURCE_ID);
  assert.doesNotThrow(() => validateTransferAdmissionEvidence(source));
  await assert.doesNotReject(validateProductionTransferArtifacts(inventory, { repositoryRoot: root }));

  // 값은 그대로다: 지표 행·쌍·개수는 같고 정본 팩 결속 hash만 바뀐다.
  assert.deepEqual(metrics.metrics, fixture.metrics.metrics);
  assert.deepEqual(metrics.physicalPairs, fixture.metrics.physicalPairs);
  assert.deepEqual({ ...metrics.canonicalIdentity, canonicalPackSha256: null }, { ...fixture.metrics.canonicalIdentity, canonicalPackSha256: null });
  assert.equal(metrics.canonicalIdentity.canonicalPackSha256, sha256(nextPackBytes));
  const before = fixture.descriptor.transferTopology;
  const after = JSON.parse(descriptorBytes).transferTopology;
  assert.deepEqual(
    { ...after, canonicalPackSha256: null, metricsArtifactSha256: null, applicabilityArtifactSha256: null },
    { ...before, canonicalPackSha256: null, metricsArtifactSha256: null, applicabilityArtifactSha256: null },
  );
  assert.equal(source.transferAdmissionEvidence.snapshotFileSha256, sha256(descriptorBytes));
  assert.equal(source.transferAdmissionEvidence.metricsArtifactSha256, metrics.artifactSha256);
  const ledger = JSON.parse(ledgerBytes);
  const row = ledger.find(({ sourceId }) => sourceId === SEOUL_TRANSFER_SOURCE_ID);
  assert.deepEqual(row.transferTopology, after);
  assert.deepEqual(row.rawReceipt, fixture.receipt);
  assert.deepEqual(ledger.filter(({ sourceId }) => sourceId !== SEOUL_TRANSFER_SOURCE_ID), [{ sourceId: "unrelated-source", snapshotId: "unrelated-source-20261002", snapshotStatus: "LOCKED", fetchStatus: "SUCCESS", rawSha256: "2".repeat(64) }]);

  // 같은 팩에서 다시 실행하면 쓰지 않는다.
  const repeated = await rebindCurrentSeoulTransferSourceAdmission({ repositoryRoot: root, env, now: NOW, client: lockedRawClient(fixture.rawBytes) });
  assert.equal(repeated.changed, false);
});

test("원천 후보 계약 파일의 다른 항목만 바뀌었으면 그 파일 sha도 새로 결속하고 값은 같다", async (t) => {
  const { root, fixture } = await repository(t);
  const nextPackBytes = await rewriteSeoulTransferFixtureCanonicalPack(root, rotateKeyId);
  const candidatesPath = path.join(root, PATHS.sourceCandidates);
  const candidates = JSON.parse(fixture.sourceCandidatesBytes);
  candidates.candidates = candidates.candidates.filter(({ id }) => id !== "unrelated-candidate-removed-by-cleanup");
  candidates.candidates.push({ id: "unrelated-candidate-added", requestUrl: "https://example.invalid/unrelated" });
  const nextCandidatesBytes = Buffer.from(`${JSON.stringify(candidates, null, 2)}\n`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(candidatesPath, nextCandidatesBytes);

  await rebindCurrentSeoulTransferSourceAdmission({ repositoryRoot: root, env, now: NOW, client: lockedRawClient(fixture.rawBytes) });
  const metrics = JSON.parse(await readFile(path.join(root, PATHS.metrics)));
  const descriptor = JSON.parse(await readFile(path.join(root, fixture.descriptorPath)));
  assert.equal(metrics.sourceIdentity.sourceCandidateSha256, sha256(nextCandidatesBytes));
  assert.equal(descriptor.observationIdentity.sourceCandidateSha256, sha256(nextCandidatesBytes));
  assert.notEqual(fixture.metrics.sourceIdentity.sourceCandidateSha256, sha256(nextCandidatesBytes));
  assert.deepEqual(metrics.metrics, fixture.metrics.metrics);
  const expected = deriveSeoulTransferFixtureEvidence({ ...fixture, canonicalPackBytes: nextPackBytes, sourceCandidatesBytes: nextCandidatesBytes });
  assert.ok((await readFile(path.join(root, PATHS.metrics))).equals(expected.metricsBytes));

  // 환승 원천 endpoint 자체가 바뀌면 잠긴 관측(manifest sha)과 맞지 않아 쓰지 않고 실패한다.
  const before = await snapshot(root, outputPaths(fixture));
  candidates.candidates.find(({ id }) => id === SEOUL_TRANSFER_SOURCE_ID).requestUrl = "https://api.odcloud.kr/api/15044419/v1/uddi:changed";
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await rewriteSeoulTransferFixtureCanonicalPack(root, (pack) => { pack.manifest.keyId = "fixture-key-rotated-again"; });
  await assert.rejects(rebindCurrentSeoulTransferSourceAdmission({ repositoryRoot: root, env, now: NOW, client: lockedRawClient(fixture.rawBytes) }), /tracked Seoul transfer endpoint contract mismatch/);
  for (const [relative, bytes] of before) assert.ok((await readFile(path.join(root, relative))).equals(bytes), relative);
});

test("정본 팩 변경이 환승 값(분모·쌍)을 바꾸면 쓰지 않고 실패한다", async (t) => {
  const { root, fixture } = await repository(t);
  await rewriteSeoulTransferFixtureCanonicalPack(root, (pack) => {
    pack.packs[0].stations.push({ id: "station-new-transfer-line", nameKo: "신규역" });
    pack.packs[0].stationLines.push({ stationId: "station-new-transfer-line", lineId: seoulTransferFixtureLineId(3) });
  });
  const before = await snapshot(root, outputPaths(fixture));
  await assert.rejects(
    rebindCurrentSeoulTransferSourceAdmission({ repositoryRoot: root, env, now: NOW, client: lockedRawClient(fixture.rawBytes) }),
    /TRANSFER metrics values changed under canonical pack re-binding/,
  );
  for (const [relative, bytes] of before) assert.ok((await readFile(path.join(root, relative))).equals(bytes), relative);
});

test("OCI raw가 없거나 바이트가 원장과 다르면 출력 없이 명시적으로 실패한다", async (t) => {
  const { root, fixture } = await repository(t);
  await rewriteSeoulTransferFixtureCanonicalPack(root, rotateKeyId);
  const before = await snapshot(root, outputPaths(fixture));
  const tampered = Buffer.from(fixture.rawBytes);
  tampered[tampered.length - 2] ^= 1;
  for (const [body, pattern] of [
    [null, /locked TRANSFER raw object is missing/],
    [tampered, /locked TRANSFER raw bytes mismatch/],
    [fixture.rawBytes.subarray(1), /locked TRANSFER raw bytes mismatch/],
  ]) {
    const calls = [];
    await assert.rejects(rebindCurrentSeoulTransferSourceAdmission({ repositoryRoot: root, env, now: NOW, client: lockedRawClient(body, calls) }), pattern);
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
  }
  for (const [relative, bytes] of before) assert.ok((await readFile(path.join(root, relative))).equals(bytes), relative);
});

test("원장 receipt·inventory 결속 불일치, 보존 만료, PAR 누락은 GET 전에 실패한다", async (t) => {
  const { root, fixture } = await repository(t);
  await rewriteSeoulTransferFixtureCanonicalPack(root, rotateKeyId);
  const ledgerPath = path.join(root, PATHS.ledger);
  const inventoryPath = path.join(root, PATHS.inventory);
  const [ledgerBytes, inventoryBytes] = await Promise.all([readFile(ledgerPath), readFile(inventoryPath)]);
  const { writeFile } = await import("node:fs/promises");
  const cases = [
    ["ledger raw sha", async () => {
      const ledger = JSON.parse(ledgerBytes);
      ledger.find(({ sourceId }) => sourceId === SEOUL_TRANSFER_SOURCE_ID).rawSha256 = "9".repeat(64);
      await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    }, /TRANSFER ledger receipt identity mismatch/, { now: NOW, env }],
    ["inventory snapshot", async () => {
      const inventory = JSON.parse(inventoryBytes);
      inventory.sources.find(({ id }) => id === SEOUL_TRANSFER_SOURCE_ID).transferAdmissionEvidence.rawSha256 = "9".repeat(64);
      await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
    }, /TRANSFER admission identity mismatch/, { now: NOW, env }],
    ["retention", async () => {}, /TRANSFER raw retention has expired/, { now: new Date(fixture.receipt.rawRetentionExpiresAt), env }],
    ["PAR", async () => {}, /exact Oracle Object Storage PAR base URL/, { now: NOW, env: {} }],
  ];
  for (const [label, mutate, pattern, options] of cases) {
    await writeFile(ledgerPath, ledgerBytes);
    await writeFile(inventoryPath, inventoryBytes);
    await mutate();
    const calls = [];
    await assert.rejects(rebindCurrentSeoulTransferSourceAdmission({ repositoryRoot: root, ...options, client: lockedRawClient(fixture.rawBytes, calls) }), pattern, label);
    assert.deepEqual(calls, [], label);
  }
});

function lineBytesOf(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
