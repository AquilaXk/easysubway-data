import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { sha256 } from "../lib/hash.mjs";
import {
  approvedGovernanceBindingTransition,
  buildAppendOnlyGovernancePolicyRegistration,
  buildGovernancePolicyRetirement,
  validateSourceGovernancePolicy,
} from "./source-governance-policy.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const RETIRED_IDS = ["kric-station-elevator", "kric-station-escalator", "kric-wheelchair-lift-movement"];
const ADDED_ID = "synthetic-registered-source";
const BINDING_ERROR = /governance policy binding/;

// 닫힌 epoch 루트(승인 원문)에서 출발해 등록 한 번, 퇴역 한 번을 쌓은 독립 사슬이다.
const rootBytes = await readFile(path.join(root, "tools/datapack/test-fixtures/source-governance-registration-root.json"));
const rootPolicy = JSON.parse(rootBytes);
const registered = buildAppendOnlyGovernancePolicyRegistration({
  predecessorPolicyBytes: rootBytes,
  addedSources: [{ ...structuredClone(rootPolicy.sources.at(-1)), sourceId: ADDED_ID }],
});
const retired = buildGovernancePolicyRetirement({
  predecessorPolicyBytes: registered.bytes,
  retiredSourceIds: [...RETIRED_IDS].reverse(),
});

const prettyBytes = (policy) => Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
const transition = ({ policy, bytes = prettyBytes(policy) }, sourceId, bindingSha256) => approvedGovernanceBindingTransition({
  snapshot: { sourceId, governancePolicyVersion: policy.policyVersion, governancePolicySha256: bindingSha256 },
  currentPolicyVersion: policy.policyVersion,
  currentPolicySha256: sha256(bytes),
  currentPolicyBytes: bytes,
});
const forged = (mutate) => {
  const policy = structuredClone(retired.policy);
  mutate(policy);
  return { policy };
};

test("퇴역은 원천을 현재 sources에서 빼고 원문과 위치를 lineage에 남긴다", () => {
  const { policy, registrationLineage } = retired;
  assert.deepEqual(policy.sources.map(({ sourceId }) => sourceId).filter((id) => RETIRED_IDS.includes(id)), []);
  assert.equal(policy.sources.length, registered.policy.sources.length - RETIRED_IDS.length);
  assert.deepEqual(registrationLineage.retiredSourceIds, RETIRED_IDS);
  assert.deepEqual(registrationLineage.retiredSources.map(({ position }) => position), [3, 5, 8]);
  for (const [index, id] of RETIRED_IDS.entries()) {
    assert.deepEqual(registrationLineage.retiredSources[index].source, rootPolicy.sources.find(({ sourceId }) => sourceId === id));
  }
  assert.equal(registrationLineage.predecessorPolicySha256, sha256(registered.bytes));
  assert.deepEqual(registrationLineage.predecessorLineage, registered.registrationLineage);
  assert.equal(registrationLineage.predecessorPolicyText, null);
  assert.deepEqual(Buffer.from(retired.bytes), prettyBytes(policy));
});

test("퇴역한 원천의 과거 snapshot은 퇴역 전 정책 sha로만 인정하고 현재 sha로는 거부한다", () => {
  const before = sha256(registered.bytes);
  const root = sha256(rootBytes);
  const current = sha256(retired.bytes);
  for (const sourceId of RETIRED_IDS) {
    assert.equal(transition(retired, sourceId, before).governancePolicySha256, before);
    assert.equal(transition(retired, sourceId, root).governancePolicySha256, root);
    assert.throws(() => transition(retired, sourceId, current), BINDING_ERROR);
  }
  assert.equal(transition(retired, "kric-station-convenience-standard", before).governancePolicySha256, before);
  assert.equal(transition(retired, "kric-station-convenience-standard", current).governancePolicySha256, current);
  assert.throws(() => transition(retired, ADDED_ID, root), BINDING_ERROR);
  assert.equal(transition(retired, ADDED_ID, before).governancePolicySha256, before);
});

test("퇴역 사슬 위에 등록과 두 번째 퇴역을 다시 쌓아도 모든 단계가 재구성된다", () => {
  const added = buildAppendOnlyGovernancePolicyRegistration({
    predecessorPolicyBytes: retired.bytes,
    addedSources: [{ ...structuredClone(rootPolicy.sources.at(-1)), sourceId: `${ADDED_ID}-later` }],
  });
  const secondRetirement = buildGovernancePolicyRetirement({
    predecessorPolicyBytes: added.bytes,
    retiredSourceIds: ["kric-wheelchair-lift-location", ADDED_ID],
  });
  const second = { policy: secondRetirement.policy, bytes: secondRetirement.bytes };
  const rootSha = sha256(rootBytes);
  const registeredSha = sha256(registered.bytes);
  assert.equal(transition(second, "kric-station-elevator", rootSha).governancePolicySha256, rootSha);
  assert.equal(transition(second, ADDED_ID, registeredSha).governancePolicySha256, registeredSha);
  assert.throws(() => transition(second, ADDED_ID, sha256(second.bytes)), BINDING_ERROR);
  assert.equal(transition(second, `${ADDED_ID}-later`, sha256(added.bytes)).governancePolicySha256, sha256(added.bytes));
});

test("변이: 퇴역 기록의 원문을 위조하면 실패한다", () => {
  for (const mutate of [
    (policy) => { policy.registrationLineage.retiredSources[0].source.escalationHours += 1; },
    (policy) => { policy.registrationLineage.retiredSources[1].source.licenseReview.status = "BLOCKED"; },
    (policy) => { policy.registrationLineage.retiredSources[2].position += 1; },
    (policy) => { policy.registrationLineage.predecessorPolicySha256 = "0".repeat(64); },
    (policy) => { policy.registrationLineage.retiredSources.reverse(); },
  ]) {
    assert.throws(() => transition(forged(mutate), "kric-station-convenience-standard", sha256(retired.bytes)), BINDING_ERROR);
  }
});

test("변이: 퇴역 원문이 누락되거나 id 목록과 어긋나면 실패한다", () => {
  for (const mutate of [
    (policy) => { delete policy.registrationLineage.retiredSources; },
    (policy) => { policy.registrationLineage.retiredSources = []; },
    (policy) => { policy.registrationLineage.retiredSources.pop(); },
    (policy) => { delete policy.registrationLineage.retiredSourceIds; },
    (policy) => { policy.registrationLineage.retiredSourceIds = []; },
    (policy) => { policy.registrationLineage.retiredSourceIds[0] = "kric-station-convenience-standard"; },
    (policy) => { policy.registrationLineage.retiredSources[0] = { position: 3 }; },
    (policy) => { policy.registrationLineage.retiredSources[0].extra = true; },
    (policy) => { policy.registrationLineage.addedSourceIds = ["kric-station-escalator"]; },
  ]) {
    assert.throws(() => transition(forged(mutate), "kric-station-convenience-standard", sha256(retired.bytes)), BINDING_ERROR);
  }
});

test("변이: 퇴역으로 기록하지 않은 원천을 몰래 빼면 실패한다", () => {
  for (const hidden of ["kric-station-convenience-standard", ADDED_ID, "seoul-metro-accessibility"]) {
    const tampered = forged((policy) => { policy.sources = policy.sources.filter(({ sourceId }) => sourceId !== hidden); });
    assert.throws(() => transition(tampered, "molit-urban-rail-full-route", sha256(retired.bytes)), BINDING_ERROR);
  }
  const resurrected = forged((policy) => { policy.sources.push(structuredClone(policy.registrationLineage.retiredSources[0].source)); });
  assert.throws(() => transition(resurrected, "molit-urban-rail-full-route", sha256(retired.bytes)), BINDING_ERROR);
});

test("퇴역 builder는 존재하지 않거나 중복이거나 전체를 비우는 요청을 거부하고 퇴역 id 재등록도 거부한다", () => {
  const retire = (retiredSourceIds) => buildGovernancePolicyRetirement({ predecessorPolicyBytes: registered.bytes, retiredSourceIds });
  assert.throws(() => retire([]), BINDING_ERROR);
  assert.throws(() => retire(["unknown-source"]), BINDING_ERROR);
  assert.throws(() => retire(["kric-station-elevator", "kric-station-elevator"]), BINDING_ERROR);
  assert.throws(() => retire(registered.policy.sources.map(({ sourceId }) => sourceId)), BINDING_ERROR);
  assert.throws(() => buildAppendOnlyGovernancePolicyRegistration({
    predecessorPolicyBytes: retired.bytes,
    addedSources: [{ ...structuredClone(rootPolicy.sources.at(-1)), sourceId: "kric-station-elevator" }],
  }), BINDING_ERROR);
});

test("퇴역한 원천은 inventory와 freshness 결합 검증 대상이 아니다", () => {
  const { sources } = retired.policy;
  const inventory = { sources: sources.map(({ sourceId, licenseReview }) => ({ id: sourceId, admissionEvidence: { licenseEvidenceHash: licenseReview.termsHash } })) };
  const freshnessPolicy = { sourceClasses: [...new Set(sources.map(({ sourceClassId }) => sourceClassId))]
    .map((id) => ({ id, sourceIds: sources.filter(({ sourceClassId }) => sourceClassId === id).map(({ sourceId }) => sourceId) })) };
  assert.doesNotThrow(() => validateSourceGovernancePolicy({ policy: retired.policy, inventory, freshnessPolicy }));
});

test("추적 중인 정책은 KRIC 접근성 퇴역 원천 5건을 원문과 함께 퇴역 단계로 기록한다", async () => {
  const bytes = await readFile(path.join(root, "tools/datapack/source-governance-policy.json"));
  const policy = JSON.parse(bytes);
  const ids = ["kric-station-elevator", "kric-station-elevator-movement", "kric-station-escalator", "kric-wheelchair-lift-location", "kric-wheelchair-lift-movement"];
  const lineage = policy.registrationLineage;
  assert.deepEqual(lineage.retiredSourceIds, ids);
  assert.deepEqual(lineage.retiredSources.map(({ source }) => source.sourceId), ids);
  assert.deepEqual(policy.sources.filter(({ sourceId }) => ids.includes(sourceId)), []);
  const bind = (sourceId, sha) => approvedGovernanceBindingTransition({
    snapshot: { sourceId, governancePolicyVersion: policy.policyVersion, governancePolicySha256: sha },
    currentPolicyVersion: policy.policyVersion,
    currentPolicySha256: sha256(bytes),
    currentPolicyBytes: bytes,
  });
  for (const id of ids) {
    assert.equal(bind(id, lineage.predecessorPolicySha256).governancePolicySha256, lineage.predecessorPolicySha256);
    assert.throws(() => bind(id, sha256(bytes)), BINDING_ERROR);
  }
  assert.equal(bind("kric-station-convenience-standard", lineage.predecessorPolicySha256).governancePolicySha256, lineage.predecessorPolicySha256);
});
