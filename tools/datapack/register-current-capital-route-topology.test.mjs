import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishCapitalRouteTopologyRaw } from "./publish-capital-route-topology-raw.mjs";
import {
  buildCurrentCapitalRouteTopologyRegistrationOutputs,
  commitCurrentCapitalRouteTopologyRegistrationOutputs,
  readCurrentCapitalRouteTopologyAdmission,
  recoverCurrentCapitalRouteTopologyRegistration,
} from "./register-current-capital-route-topology.mjs";
import { recoverKorailRouteTopologyRegistration } from "./register-korail-route-topology.mjs";
import {
  SOURCE_REGISTRATION_JOURNAL_PATH,
  SOURCE_REGISTRATION_LOCK_PATH,
} from "./lib/source-registration-transaction.mjs";
import { createFixtureCapitalTopologyReceipt } from "./test-fixtures/current-capital-topology-registration.mjs";
import { evaluateSourceGovernance } from "./source-governance-policy.mjs";
import { REGISTRATION_INVENTORY_FIELDS } from "../ci/automation-pr-policy.mjs";
import { recoverPublishedCurrentCapitalRouteTopologyRegistration, runCurrentCapitalRouteTopologyRegistration } from "./run-current-capital-route-topology-registration.mjs";
import { TOPOLOGY_FRESHNESS_CUTOVER_AT, topologySnapshotFreshUntil } from "./lib/topology-freshness-cutover.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n");

async function copy(relative, root) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await readFile(path.join(ROOT, relative)));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "capital-topology-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/source-inventory.json")));
  const protectedAdmission = inventory.sources.find((source) => source.id === "seoul-metro-route-map-positions")
    .routeMapAdmissionEvidence.currentTopologyAdmission;
  const topologyRelative = "tools/datapack/sources/" + protectedAdmission.topologySnapshotId + ".json";
  for (const relative of [
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-candidates.json",
    "tools/datapack/source-governance-policy.json",
    "release/product-gates/datapack-freshness-sla.json",
    topologyRelative,
  ]) await copy(relative, root);
  const topology = JSON.parse(await readFile(path.join(root, topologyRelative)));
  const candidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json")));
  const reviewedAt = candidates.candidates.find((candidate) => candidate.id === "capital-route-topology")
    .registrationMetadata.governance.licenseReview.reviewedAt;
  const now = await advanceProtectedTopology(root, new Date(Date.parse(topology.capturedAt) + 1_000), new Date(Date.parse(reviewedAt) + 1_000));
  const currentInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json")));
  const currentSnapshotId = currentInventory.sources.find((source) => source.id === "seoul-metro-route-map-positions")
    .routeMapAdmissionEvidence.currentTopologyAdmission.topologySnapshotId;
  return { root, topologyRelative: "tools/datapack/sources/" + currentSnapshotId + ".json", now };
}

async function receiptFixture(root, now) {
  const receiptPath = path.join(root, "receipt.json");
  return createFixtureCapitalTopologyReceipt({ repositoryRoot: root, now, receiptPath });
}

async function registrationInputBytes(root) {
  return {
    inventoryBytes: await readFile(path.join(root, "tools/datapack/source-inventory.json")),
    candidateBytes: await readFile(path.join(root, "tools/datapack/source-candidates.json")),
    governanceBytes: await readFile(path.join(root, "tools/datapack/source-governance-policy.json")),
    freshnessBytes: await readFile(path.join(root, "release/product-gates/datapack-freshness-sla.json")),
  };
}

async function advanceProtectedTopology(root, previousNow, minimumCapturedAt = null, { sameDay = false } = {}) {
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath));
  const holder = inventory.sources.find((source) => source.id === "seoul-metro-route-map-positions");
  const previous = holder.routeMapAdmissionEvidence.currentTopologyAdmission;
  const previousTopology = JSON.parse(await readFile(path.join(root, "tools/datapack/sources/" + previous.topologySnapshotId + ".json")));
  const capturedMillis = Math.max(
    Date.parse(previousTopology.capturedAt) + (sameDay ? 1_000 : 86_400_000),
    minimumCapturedAt?.valueOf() ?? Number.NEGATIVE_INFINITY,
  );
  const captured = new Date(capturedMillis).toISOString();
  // #862: 같은 날 재수집은 수집 시각(ms)까지 넣은 id를 쓴다. 날짜형 id는 기존 행으로만 남는다.
  const snapshotId = "capital-route-topology-" + (sameDay
    ? captured.replace(/[-:.]/gu, "")
    : captured.slice(0, 10).replaceAll("-", ""));
  // 수집기와 같은 규칙: 컷오버 이후 수집분은 P7D, 이전 수집분은 P1D 창이다.
  const topology = { ...previousTopology, capturedAt: captured, freshUntil: topologySnapshotFreshUntil(captured) };
  const admission = {
    ...previous,
    topologySnapshotId: snapshotId,
    topologyContentSha256: topology.contentSha256,
    reviewedAt: captured,
    freshUntil: topology.freshUntil,
    topologyLineages: previous.topologyLineages.map((lineage) => ({ ...lineage, snapshotId, contentSha256: topology.contentSha256 })),
  };
  holder.routeMapAdmissionEvidence.currentTopologyAdmission = admission;
  const relative = "tools/datapack/sources/" + snapshotId + ".json";
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeJson(path.join(root, relative), topology);
  await writeJson(inventoryPath, inventory);
  return new Date(Math.max(Date.parse(captured) + 1_000, previousNow.valueOf() + 1));
}

test("shared freshness membership preserves Capital semantics without extending freshness", async (t) => {
  const { root, now } = await fixture(t);
  const policyPath = path.join(root, "release/product-gates/datapack-freshness-sla.json");
  const policy = JSON.parse(await readFile(policyPath));
  const sourceClass = policy.sourceClasses.find((entry) => entry.sourceIds.includes("capital-route-topology"));
  const before = await readCurrentCapitalRouteTopologyAdmission({ repositoryRoot: root, now });
  // 운영 source 등록 여부와 무관한 예제로 class 확장 계약을 검증한다.
  const additionalSourceId = "fixture-additional-topology-source";
  assert.equal(sourceClass.sourceIds.includes(additionalSourceId), false);
  sourceClass.sourceIds.push(additionalSourceId);
  await writeJson(policyPath, policy);
  const after = await readCurrentCapitalRouteTopologyAdmission({ repositoryRoot: root, now });
  // anti-cheat-allow: circular-oracle -- 무관한 필드 변경 또는 비변경 상황에서 기존 식별자/바이트 불변성(invariance) 검증
  assert.equal(after.topology.freshUntil, before.topology.freshUntil);
  // anti-cheat-allow: circular-oracle -- 무관한 필드 변경 또는 비변경 상황에서 기존 식별자/바이트 불변성(invariance) 검증
  assert.equal(after.freshnessClassSha256, before.freshnessClassSha256);
  assert.deepEqual(after.freshnessPolicy, policy);
  sourceClass.sourceIds.push(additionalSourceId);
  await writeJson(policyPath, policy);
  await assert.rejects(readCurrentCapitalRouteTopologyAdmission({ repositoryRoot: root, now }), /policy binding/);
  sourceClass.sourceIds.pop();
  sourceClass.reverificationCadence = "P2D";
  await writeJson(policyPath, policy);
  await assert.rejects(readCurrentCapitalRouteTopologyAdmission({ repositoryRoot: root, now }), /policy binding/);
});

test("registered topology license identity satisfies the downstream governance evaluator", async (t) => {
  const { root, now } = await fixture(t);
  const { receiptPath } = await receiptFixture(root, now);
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now });
  const source = JSON.parse(outputs[0].bytes).sources.find(({ id }) => id === "capital-route-topology");
  const snapshot = JSON.parse(outputs[1].bytes).at(-1);
  const result = evaluateSourceGovernance({
    source,
    snapshot,
    policy: JSON.parse(outputs[2].bytes),
    freshnessPolicy: JSON.parse(outputs[3].bytes),
    evaluationAt: now.toISOString(),
  });
  assert.equal(result.reasonCodes.includes("LICENSE_REVIEW_REQUIRED"), false);
  // 커밋된 최신 수집분 다음 날 수집은 컷오버 이후이므로 원장·inventory가 P7D 창을 기록하고 governance가 그대로 인정한다.
  assert.ok(Date.parse(snapshot.retrievedAt) >= Date.parse(TOPOLOGY_FRESHNESS_CUTOVER_AT));
  assert.equal(snapshot.freshnessExpiresAt, new Date(Date.parse(snapshot.retrievedAt) + 7 * 86_400_000).toISOString());
  assert.equal(source.updateFrequency, "P7D");
  assert.equal(result.reasonCodes.includes("SOURCE_FRESHNESS_POLICY_MISSING"), false);
  const mismatchedPolicy = JSON.parse(outputs[2].bytes);
  mismatchedPolicy.sources.find(({ sourceId }) => sourceId === source.id)
    .licenseReview.reviewedProvider = source.owner;
  assert.notEqual(source.owner, source.provider);
  assert.equal(evaluateSourceGovernance({
    source, snapshot, policy: mismatchedPolicy,
    freshnessPolicy: JSON.parse(outputs[3].bytes), evaluationAt: now.toISOString(),
  }).reasonCodes.includes("LICENSE_REVIEW_REQUIRED"), true);
});

test("publishes exactly the protected topology bytes and builds an initial registration", async (t) => {
  const { root, now } = await fixture(t);
  const { admission } = await receiptFixture(root, now);
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "capital-topology-publish-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  await writeFile(path.join(operationRoot, "capital-route-topology.raw.json"), admission.topologyBytes);
  const objects = new Map();
  const client = {
    putObjectIfAbsent: async (key, body) => { if (objects.has(key)) return false; objects.set(key, Buffer.from(body)); return true; },
    readObject: async (key) => objects.has(key) ? { exists: true, body: objects.get(key) } : { exists: false },
  };
  const receipt = await publishCapitalRouteTopologyRaw({
    repositoryRoot: root, operationRoot, expectedMainSha: "a".repeat(40),
    gitRunner: async (args) => args[0] === "status" ? "" : "a".repeat(40),
    env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.example.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
    client, now, receiptPath: path.join(operationRoot, "capital-route-topology.raw-receipt.json"),
  });
  assert.equal(receipt.rawObjectSha256, sha(admission.topologyBytes));
  assert.equal(receipt.byteSize, admission.topologyBytes.length);
  assert.deepEqual(objects.get(receipt.objectKey), admission.topologyBytes);
  const receiptPath = path.join(root, "published-receipt.json");
  await writeJson(receiptPath, receipt);
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now });
  assert.deepEqual(outputs.map(({ relative }) => relative), [
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-governance-policy.json",
    "release/product-gates/datapack-freshness-sla.json",
  ]);
  const source = JSON.parse(outputs[0].bytes).sources.find(({ id }) => id === "capital-route-topology");
  const snapshot = JSON.parse(outputs[1].bytes).at(-1);
  for (const key of ["id", "displayName", "owner", "provider", "providerDepartment", "sourceSystem", "datasetUrl", "datasetKind", "coverage"]) {
    assert.equal(typeof source[key], "string", `generated inventory ${key}`);
    assert.notEqual(source[key], "", `generated inventory ${key}`);
  }
  assert.equal(source.requiredForProductionPack, true);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.license.name, "공공누리 제1유형");
  assert.equal(snapshot.rawSha256, sha(admission.topologyBytes));
  assert.equal(snapshot.byteSize, admission.topologyBytes.length);
});

test("first registration binds the exact policy prestate without changing prior approvals", async (t) => {
  const { root, now } = await fixture(t);
  const policyPath = path.join(root, "tools/datapack/source-governance-policy.json");
  let policy = JSON.parse(await readFile(policyPath));
  const sourceIds = new Set();
  let previousPolicyBytes;
  let registrationSourceIds;
  // 이후 source 등록 수에 의존하지 않고 대상 등록 직전의 검증된 원문까지 되감는다.
  do {
    const lineage = policy.registrationLineage;
    assert.ok(lineage, "capital topology registration must exist in policy lineage");
    registrationSourceIds = lineage.addedSourceIds;
    assert.deepEqual(policy.sources.slice(-registrationSourceIds.length).map(({ sourceId }) => sourceId), registrationSourceIds);
    registrationSourceIds.forEach((id) => sourceIds.add(id));
    const predecessor = { ...policy, sources: policy.sources.slice(0, -registrationSourceIds.length) };
    if (lineage.predecessorLineage === null) delete predecessor.registrationLineage;
    else predecessor.registrationLineage = lineage.predecessorLineage;
    previousPolicyBytes = lineage.predecessorPolicyText === null
      ? Buffer.from(`${JSON.stringify(predecessor, null, 2)}\n`)
      : Buffer.from(lineage.predecessorPolicyText);
    assert.equal(sha(previousPolicyBytes), lineage.predecessorPolicySha256);
    assert.deepEqual(JSON.parse(previousPolicyBytes), predecessor);
    policy = predecessor;
  } while (!registrationSourceIds.includes("capital-route-topology"));
  await writeFile(policyPath, previousPolicyBytes);
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath));
  inventory.sources = inventory.sources.filter(({ id }) => !sourceIds.has(id));
  await writeJson(inventoryPath, inventory);
  const ledgerPath = path.join(root, "tools/datapack/release/source-snapshots.json");
  await writeJson(ledgerPath, JSON.parse(await readFile(ledgerPath))
    .filter(({ sourceId }) => !sourceIds.has(sourceId)));
  const freshnessPath = path.join(root, "release/product-gates/datapack-freshness-sla.json");
  const freshness = JSON.parse(await readFile(freshnessPath));
  // 거버넌스에 없는 원천(#862 인천 후보 입력의 클래스 매핑)도 등록 이후에 붙은 구성원이므로 함께 되감는다.
  const governedSourceIds = new Set(JSON.parse(await readFile(path.join(ROOT, "tools/datapack/source-governance-policy.json")))
    .sources.map(({ sourceId }) => sourceId));
  freshness.sourceClasses = freshness.sourceClasses.filter((entry) =>
    !entry.sourceIds.every((id) => sourceIds.has(id) || !governedSourceIds.has(id)));
  await writeJson(freshnessPath, freshness);
  const { receiptPath } = await receiptFixture(root, now);
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now });
  const output = outputs.find(({ relative }) => relative === "tools/datapack/source-governance-policy.json");
  assert.deepEqual(output.prestateBytes, previousPolicyBytes);
  assert.equal(JSON.parse(output.bytes).registrationLineage.predecessorPolicySha256, sha(previousPolicyBytes));
  assert.deepEqual(JSON.parse(output.bytes).sources.slice(0, -registrationSourceIds.length), JSON.parse(previousPolicyBytes).sources);
});

// #989: 재등록은 정책 파일을 쓰지 않는다. 자동 병합 정책의 등록 단계가 원장·inventory 둘만 허용하므로, 등록기는 이미 등록된 원천의 재등록에서
// governance·신선도 SLA를 바이트까지 그대로 두고 inventory는 정해진 갱신 필드만 바꿔야 한다. 정책 변경이 필요하면 게시 전에 실패한다.
const GOVERNANCE_RELATIVE = "tools/datapack/source-governance-policy.json";
const FRESHNESS_RELATIVE = "release/product-gates/datapack-freshness-sla.json";

test("재등록(forbidPolicyChange)은 governance·신선도 SLA 출력이 사전 바이트와 같고 inventory 항목은 정해진 갱신 필드만 바꾼다(#989)", async (t) => {
  const { root, now } = await fixture(t);
  const { receiptPath } = await receiptFixture(root, now);
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now, forbidPolicyChange: true });
  for (const relative of [GOVERNANCE_RELATIVE, FRESHNESS_RELATIVE]) {
    const output = outputs.find((entry) => entry.relative === relative);
    assert.deepEqual(output.bytes, output.prestateBytes, `${relative} is byte-identical`);
  }
  const inventory = outputs.find(({ relative }) => relative === "tools/datapack/source-inventory.json");
  const before = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json")));
  const after = JSON.parse(inventory.bytes);
  // 인덱스로 짝지어 비교하므로 항목이 더해지거나 순서가 바뀌면 바뀐 항목 id 목록에 드러난다.
  const changedEntries = after.sources.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(before.sources[index]));
  assert.deepEqual(changedEntries.map(({ id }) => id), ["capital-route-topology"]);
  const [was] = before.sources.filter(({ id }) => id === "capital-route-topology");
  const [entryAfter] = changedEntries;
  const fields = [...new Set([...Object.keys(was), ...Object.keys(entryAfter)])].filter((key) => JSON.stringify(was[key]) !== JSON.stringify(entryAfter[key]));
  assert.deepEqual(fields.sort(), [...REGISTRATION_INVENTORY_FIELDS["capital-route-topology"]].sort());
});

test("재등록이 정책을 새로 써야 하면(정책 binding 없음) REGISTRATION_POLICY_CHANGE_REQUIRED로 실패한다(#989)", async (t) => {
  const { root, now } = await fixture(t);
  const { receiptPath } = await receiptFixture(root, now);
  const governancePath = path.join(root, GOVERNANCE_RELATIVE);
  const freshnessPath = path.join(root, FRESHNESS_RELATIVE);
  const governance = JSON.parse(await readFile(governancePath));
  governance.sources = governance.sources.filter(({ sourceId }) => sourceId !== "capital-route-topology");
  await writeJson(governancePath, governance);
  const freshness = JSON.parse(await readFile(freshnessPath));
  freshness.sourceClasses = freshness.sourceClasses.filter(({ sourceIds }) => !sourceIds.includes("capital-route-topology"));
  await writeJson(freshnessPath, freshness);
  const inputBytes = await registrationInputBytes(root);
  await assert.rejects(() => readCurrentCapitalRouteTopologyAdmission({ repositoryRoot: root, now, inputBytes, forbidPolicyChange: true }), /^Error: REGISTRATION_POLICY_CHANGE_REQUIRED: /u);
  await assert.rejects(() => buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now, forbidPolicyChange: true }), /REGISTRATION_POLICY_CHANGE_REQUIRED/u);
});

test("정책 파일 바이트가 재직렬화와 다르면 재등록은 정책 파일 쓰기가 생기므로 REGISTRATION_POLICY_CHANGE_REQUIRED로 실패한다(#989)", async (t) => {
  const { root, now } = await fixture(t);
  const { receiptPath } = await receiptFixture(root, now);
  const governancePath = path.join(root, GOVERNANCE_RELATIVE);
  await writeFile(governancePath, JSON.stringify(JSON.parse(await readFile(governancePath))));
  await assert.rejects(() => buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now, forbidPolicyChange: true }), /REGISTRATION_POLICY_CHANGE_REQUIRED/u);
  // 옵션이 없으면(첫 등록·수동 도구) 기존 동작 그대로다.
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now });
  assert.equal(outputs.length, 4);
});

// 정책 바이트 변화는 OCI 게시 전(admission 읽기)에 잡혀야 한다. 게시 뒤에 잡히면 고아 raw object가 남고 복구도 같은 곳에서 다시 실패한다(#989 리뷰 F1).
const POLICY_FILES = [GOVERNANCE_RELATIVE, FRESHNESS_RELATIVE];

test("admission 읽기가 정책 파일 바이트 변화를 게시 전에 REGISTRATION_POLICY_CHANGE_REQUIRED로 막는다(#989 F1)", async (t) => {
  for (const relative of POLICY_FILES) {
    const { root, now } = await fixture(t);
    const file = path.join(root, relative);
    await writeFile(file, JSON.stringify(JSON.parse(await readFile(file))));
    await assert.rejects(() => readCurrentCapitalRouteTopologyAdmission({ repositoryRoot: root, now, forbidPolicyChange: true }), /^Error: REGISTRATION_POLICY_CHANGE_REQUIRED: /u, relative);
    // 옵션이 없으면(첫 등록·수동 도구) 기존 동작 그대로 읽힌다.
    await readCurrentCapitalRouteTopologyAdmission({ repositoryRoot: root, now });
  }
});

async function operationParent(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "capital-topology-operation-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return parent;
}

test("runner는 정책 바이트가 다르면 publish를 한 번도 부르지 않고 실패한다(#989 F1)", async (t) => {
  for (const relative of POLICY_FILES) {
    const { root, now } = await fixture(t);
    const file = path.join(root, relative);
    await writeFile(file, JSON.stringify(JSON.parse(await readFile(file))));
    const parent = await operationParent(t);
    let publishCalls = 0;
    let registerCalls = 0;
    await assert.rejects(() => runCurrentCapitalRouteTopologyRegistration({
      repositoryRoot: root, operationRoot: path.join(parent, "run"), expectedMainSha: "a".repeat(40), now, exactMain: async () => ({}),
      publish: async () => { publishCalls += 1; }, register: async () => { registerCalls += 1; return { targets: [] }; },
    }), /REGISTRATION_POLICY_CHANGE_REQUIRED/u, relative);
    assert.equal(publishCalls, 0, `${relative}: nothing is published`);
    assert.equal(registerCalls, 0, `${relative}: nothing is registered`);
  }
});

test("runner 복구 경로도 정책 바이트가 다르면 등록 전에 REGISTRATION_POLICY_CHANGE_REQUIRED로 실패한다(#989 F1)", async (t) => {
  const { root, now } = await fixture(t);
  const parent = await operationParent(t);
  const source = path.join(parent, "source");
  const { admission } = await receiptFixture(root, now);
  const rawSha256 = sha(admission.topologyBytes);
  await assert.rejects(() => runCurrentCapitalRouteTopologyRegistration({
    repositoryRoot: root, operationRoot: source, expectedMainSha: "a".repeat(40), now, exactMain: async () => ({}),
    publish: async ({ receiptPath }) => { await writeFile(receiptPath, JSON.stringify({ sourceId: admission.sourceId, snapshotId: admission.snapshotId, rawObjectSha256: rawSha256 })); },
    register: async () => { throw new Error("registrar stopped"); },
  }), /registrar stopped/u);
  const file = path.join(root, GOVERNANCE_RELATIVE);
  await writeFile(file, JSON.stringify(JSON.parse(await readFile(file))));
  let registerCalls = 0;
  await assert.rejects(() => recoverPublishedCurrentCapitalRouteTopologyRegistration({
    repositoryRoot: root, sourceOperationRoot: source, targetOperationRoot: path.join(parent, "target"), expectedMainSha: "a".repeat(40),
    expectedPublicationOperationId: "source", now, exactMain: async () => ({}), register: async () => { registerCalls += 1; return { targets: [] }; },
  }), /REGISTRATION_POLICY_CHANGE_REQUIRED/u);
  assert.equal(registerCalls, 0);
});

test("places capital topology evidence on the source schema", async () => {
  const schema = JSON.parse(await readFile(path.join(ROOT, "contracts/datapack/source-inventory.schema.json")));
  const sourceProperties = schema.properties.sources.items.properties;
  assert.ok(sourceProperties.capitalTopologyAdmissionEvidence);
  assert.equal(Object.hasOwn(sourceProperties.routeMapAdmissionEvidence.properties, "capitalTopologyAdmissionEvidence"), false);
});

test("derives admission from one captured repository input snapshot", async (t) => {
  const { root, now } = await fixture(t);
  const inputBytes = await registrationInputBytes(root);
  const governancePath = path.join(root, "tools/datapack/source-governance-policy.json");
  const changedGovernance = JSON.parse(inputBytes.governanceBytes);
  changedGovernance.concurrentSentinel = true;
  await writeJson(governancePath, changedGovernance);

  const admission = await readCurrentCapitalRouteTopologyAdmission({ repositoryRoot: root, now, inputBytes });

  assert.equal(Object.hasOwn(admission.governancePolicy, "concurrentSentinel"), false);
});

test("commits two registrations while preserving existing ledger history and one inventory record", async (t) => {
  const { root, now } = await fixture(t);
  const previousSnapshots = JSON.parse(await readFile(path.join(root, "tools/datapack/release/source-snapshots.json")))
    .filter((snapshot) => snapshot.sourceId === "capital-route-topology");
  let receipt = await receiptFixture(root, now);
  let outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath: receipt.receiptPath, now });
  await commitCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, outputs });
  const initialSnapshot = JSON.parse(outputs[1].bytes).at(-1).snapshotId;
  const successorNow = await advanceProtectedTopology(root, now);
  receipt = await receiptFixture(root, successorNow);
  outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath: receipt.receiptPath, now: successorNow });
  await commitCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, outputs });
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json")));
  const snapshots = JSON.parse(await readFile(path.join(root, "tools/datapack/release/source-snapshots.json")))
    .filter((snapshot) => snapshot.sourceId === "capital-route-topology");
  assert.equal(inventory.sources.filter((source) => source.id === "capital-route-topology").length, 1);
  assert.equal(snapshots.length, previousSnapshots.length + 2);
  assert.deepEqual(snapshots.slice(0, previousSnapshots.length), previousSnapshots);
  assert.equal(snapshots.at(-2).previousSnapshotId, previousSnapshots.at(-1)?.snapshotId ?? null);
  assert.equal(snapshots.at(-1).previousSnapshotId, initialSnapshot);
  assert.deepEqual(snapshots.at(-1).admissionEvidence.predecessorSnapshotIds, [initialSnapshot]);
});

// #862: 날짜형 id(capital-route-topology-YYYYMMDD)는 같은 날 재수집을 막았다. 수집 시각 id로 같은 날 두 번째 등록이
// 성공하고, 같은 시각 중복 등록은 거부되며, 기존 날짜형 행은 그대로 남아 읽힌다.
test("capital topology는 수집 시각 id로 같은 날 두 번째 등록을 받고 같은 시각 중복은 거부한다(#862)", async (t) => {
  const { root, now } = await fixture(t);
  let receipt = await receiptFixture(root, now);
  let outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath: receipt.receiptPath, now });
  await commitCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, outputs });
  const dayRow = JSON.parse(outputs[1].bytes).at(-1);
  assert.match(dayRow.snapshotId, /^capital-route-topology-[0-9]{8}$/u);

  const sameDayNow = await advanceProtectedTopology(root, now, null, { sameDay: true });
  receipt = await receiptFixture(root, sameDayNow);
  outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath: receipt.receiptPath, now: sameDayNow });
  await commitCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, outputs });
  const snapshots = JSON.parse(await readFile(path.join(root, "tools/datapack/release/source-snapshots.json")))
    .filter((snapshot) => snapshot.sourceId === "capital-route-topology");
  const timedRow = snapshots.at(-1);
  assert.match(timedRow.snapshotId, /^capital-route-topology-[0-9]{8}T[0-9]{9}Z$/u);
  assert.equal(timedRow.snapshotId.slice("capital-route-topology-".length, "capital-route-topology-".length + 8), dayRow.snapshotId.slice(-8));
  assert.equal(timedRow.previousSnapshotId, dayRow.snapshotId);
  assert.deepEqual(snapshots.at(-2), dayRow);

  await assert.rejects(
    buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath: receipt.receiptPath, now: sameDayNow }),
    /capital topology snapshot ID already exists/,
  );
});

test("capital topology 원장 행은 다른 등록기처럼 credentialRedacted: true를 기록한다(#862 결정 #14)", async (t) => {
  const { root, now } = await fixture(t);
  const { receiptPath } = await receiptFixture(root, now);
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now });
  const snapshot = JSON.parse(outputs[1].bytes).at(-1);
  assert.equal(snapshot.sourceId, "capital-route-topology");
  // FACILITY 사전 검사(run-current-capital-facility-operation validateReleasePreflight)는 `=== true`만 통과시킨다.
  assert.equal(snapshot.credentialRedacted, true);
});

// #862: 환승 rebind(currentReleaseSnapshots)는 선택된 원장 행마다 거버넌스 결속을 요구한다.
// 다른 등록기처럼 등록 시점의 거버넌스 정책 버전·sha를 원장 행에 남긴다(기존 행은 소급하지 않음).
test("capital topology 원장 행은 다른 등록기처럼 거버넌스 정책 버전·sha256을 결속한다(#862)", async (t) => {
  const { root, now } = await fixture(t);
  const { receiptPath } = await receiptFixture(root, now);
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now });
  const snapshot = JSON.parse(outputs[1].bytes).at(-1);
  const governance = JSON.parse(outputs[2].bytes);
  assert.equal(snapshot.sourceId, "capital-route-topology");
  assert.equal(snapshot.governancePolicyVersion, governance.policyVersion);
  assert.equal(snapshot.governancePolicySha256, createHash("sha256").update(outputs[2].bytes).digest("hex"));
});

test("rejects receipt, freshness, and protected-scope mismatches without output mutation", async (t) => {
  const { root, topologyRelative, now } = await fixture(t);
  const { receipt, receiptPath } = await receiptFixture(root, now);
  const targets = [
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-governance-policy.json",
    "release/product-gates/datapack-freshness-sla.json",
  ];
  const before = await Promise.all(targets.map((relative) => readFile(path.join(root, relative))));
  receipt.rawObjectUri = "https://example.invalid/not-oci";
  await writeJson(receiptPath, receipt);
  await assert.rejects(buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now }), /receipt binding/);
  const topology = JSON.parse(await readFile(path.join(root, topologyRelative)));
  const protectedFreshUntil = topology.freshUntil;
  topology.freshUntil = topology.capturedAt;
  await writeJson(path.join(root, topologyRelative), topology);
  await assert.rejects(buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now }), /freshness identity is invalid/);
  topology.freshUntil = protectedFreshUntil;
  await writeJson(path.join(root, topologyRelative), topology);
  assert.deepEqual(await Promise.all(targets.map((relative) => readFile(path.join(root, relative)))), before);
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath));
  const protectedAdmission = inventory.sources.find((source) => source.id === "seoul-metro-route-map-positions")
    .routeMapAdmissionEvidence.currentTopologyAdmission;
  protectedAdmission.topologyLineages[0].sourceId = "wrong-source";
  await writeJson(inventoryPath, inventory);
  const beforeProtectedScopeRejection = await Promise.all(targets.map((relative) => readFile(path.join(root, relative))));
  await assert.rejects(buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now }), /topology identity|canonical owner/);
  assert.deepEqual(await Promise.all(targets.map((relative) => readFile(path.join(root, relative)))), beforeProtectedScopeRejection);
});

test("rolls a prepared transaction back across all registration targets", async (t) => {
  const { root, now } = await fixture(t);
  const { receiptPath } = await receiptFixture(root, now);
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now });
  const targets = outputs.map(({ relative }) => path.join(root, relative));
  const before = await Promise.all(targets.map((target) => readFile(target)));
  await assert.rejects(commitCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, outputs, failAfter: 0 }), /injected capital topology transaction failure/);
  assert.deepEqual(await Promise.all(targets.map((target) => readFile(target))), before);
  await assert.rejects(access(path.join(root, "tools/datapack/.capital-route-topology-registration-transaction.json")));
});

test("shared registration lock blocks both recovery entrypoints", async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, SOURCE_REGISTRATION_LOCK_PATH));

  await assert.rejects(
    recoverCurrentCapitalRouteTopologyRegistration({ repositoryRoot: root }),
    /capital topology transaction lock residue exists/,
  );
  await assert.rejects(
    recoverKorailRouteTopologyRegistration({ repositoryRoot: root }),
    /Korail route topology transaction lock residue exists/,
  );
});

test("Korail recovery completes shared Capital journals and preserves output bytes", async (t) => {
  const { root, now } = await fixture(t);
  const { receiptPath } = await receiptFixture(root, now);
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now });
  const journalPath = path.join(root, SOURCE_REGISTRATION_JOURNAL_PATH);
  const targets = outputs.map(({ relative }) => path.join(root, relative));
  const before = outputs.map(({ prestateBytes }) => prestateBytes);
  const after = outputs.map(({ bytes }) => bytes);
  const journal = (state) => Buffer.from(JSON.stringify({
    schemaVersion: 1,
    state,
    records: outputs.map(({ relative, prestateBytes, bytes }) => ({
      relative,
      beforeBase64: prestateBytes.toString("base64"),
      beforeSha256: sha(prestateBytes),
      nextBase64: bytes.toString("base64"),
      nextSha256: sha(bytes),
    })),
  }));

  await Promise.all(targets.map((target, index) => writeFile(target, after[index])));
  await writeFile(journalPath, journal("PREPARED"));
  await recoverKorailRouteTopologyRegistration({ repositoryRoot: root });
  assert.deepEqual(await Promise.all(targets.map((target) => readFile(target))), before);
  await assert.rejects(access(journalPath));

  await writeFile(journalPath, journal("COMMITTED"));
  await recoverKorailRouteTopologyRegistration({ repositoryRoot: root });
  assert.deepEqual(await Promise.all(targets.map((target) => readFile(target))), after);
  await assert.rejects(access(journalPath));
});
