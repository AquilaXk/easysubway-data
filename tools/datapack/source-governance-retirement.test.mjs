import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { sha256 } from "../lib/hash.mjs";
import { RETIRED_KRIC_ACCESSIBILITY_SOURCE_IDS } from "./lib/retired-sources.mjs";
import {
  approvedGovernanceBindingTransition,
  buildAppendOnlyGovernancePolicyRegistration,
  buildGovernancePolicyRetirement,
  isApprovedCurrentOrPriorGovernanceBinding,
  validateSourceGovernancePolicy,
} from "./source-governance-policy.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const [ELEVATOR, , ESCALATOR, LIFT_LOCATION, LIFT_MOVEMENT] = RETIRED_KRIC_ACCESSIBILITY_SOURCE_IDS;
const RETIRED_IDS = [ELEVATOR, ESCALATOR, LIFT_MOVEMENT];
const KEPT_ID = "kric-station-convenience-standard";
const ADDED_ID = "synthetic-registered-source";
const BINDING_ERROR = /governance policy binding/;
// 닫힌 epoch 루트의 current-or-prior 호환 sha(2026-07-15 정책)
const LEGACY_COMPATIBLE_BINDING = { governancePolicyVersion: "2026-07-15", governancePolicySha256: "e6e607e0711bebafbc25843996a0d6ff1dce6e6e82b4cadb425e78ccd284d9f3" };

// 닫힌 epoch 루트(승인 원문)에서 출발해 등록 한 번, 퇴역 한 번을 쌓은 독립 사슬이다.
const rootBytes = await readFile(path.join(root, "tools/datapack/test-fixtures/source-governance-registration-root.json"));
const rootPolicy = JSON.parse(rootBytes);
const syntheticSource = (sourceId) => ({ ...structuredClone(rootPolicy.sources.at(-1)), sourceId });
const registered = buildAppendOnlyGovernancePolicyRegistration({
  predecessorPolicyBytes: rootBytes,
  addedSources: [syntheticSource(ADDED_ID)],
});
const retired = buildGovernancePolicyRetirement({
  predecessorPolicyBytes: registered.bytes,
  retiredSourceIds: [...RETIRED_IDS].reverse(),
});
// 퇴역 대상이 직전 정책의 마지막 항목이라 위치 인코딩의 별칭(초과·내림차순)을 만들 수 있는 사슬이다.
const retiredTail = buildGovernancePolicyRetirement({
  predecessorPolicyBytes: registered.bytes,
  retiredSourceIds: [ELEVATOR, ADDED_ID],
});

const prettyBytes = (policy) => Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
const transition = ({ policy, bytes = prettyBytes(policy) }, sourceId, bindingSha256) => approvedGovernanceBindingTransition({
  snapshot: { sourceId, governancePolicyVersion: policy.policyVersion, governancePolicySha256: bindingSha256 },
  currentPolicyVersion: policy.policyVersion,
  currentPolicySha256: sha256(bytes),
  currentPolicyBytes: bytes,
});
// 정책을 자기 자신의 sha에 묶는다. 위조 정책이면 거부는 사슬 재구성에서만 나올 수 있다.
const bindToOwnSha = (policy, sourceId = KEPT_ID) => {
  const bytes = prettyBytes(policy);
  return transition({ policy, bytes }, sourceId, sha256(bytes));
};
const assertRejectedAtOwnSha = (mutate, base = retired) => {
  const policy = structuredClone(base.policy);
  mutate(policy);
  assert.throws(() => bindToOwnSha(policy), BINDING_ERROR);
};
const isApproved = ({ policy, bytes }, sourceId, binding) => isApprovedCurrentOrPriorGovernanceBinding({
  binding,
  currentPolicyVersion: policy.policyVersion,
  currentPolicySha256: sha256(bytes),
  currentPolicyBytes: bytes,
  sourceId,
});
const bindingTo = (bytes, policyVersion = "2026-08-29") => ({ governancePolicyVersion: policyVersion, governancePolicySha256: sha256(bytes) });

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
  assert.doesNotThrow(() => bindToOwnSha(structuredClone(policy)), "위조하지 않은 사슬은 자기 sha에 묶어도 통과한다");
});

test("퇴역한 원천의 과거 snapshot은 퇴역 전 정책 sha로만 인정하고 현재 sha로는 거부한다", () => {
  const before = sha256(registered.bytes);
  const rootSha = sha256(rootBytes);
  const current = sha256(retired.bytes);
  for (const sourceId of RETIRED_IDS) {
    assert.equal(transition(retired, sourceId, before).governancePolicySha256, before);
    assert.equal(transition(retired, sourceId, rootSha).governancePolicySha256, rootSha);
    assert.throws(() => transition(retired, sourceId, current), BINDING_ERROR);
  }
  assert.equal(transition(retired, KEPT_ID, before).governancePolicySha256, before);
  assert.equal(transition(retired, KEPT_ID, current).governancePolicySha256, current);
  assert.throws(() => transition(retired, ADDED_ID, rootSha), BINDING_ERROR);
  assert.equal(transition(retired, ADDED_ID, before).governancePolicySha256, before);
  // 루트 이전 정책이 승인한 결속은 그 시점에 있던 원천(퇴역 원천 포함)에만 인정한다.
  const legacyTransition = (sourceId) => approvedGovernanceBindingTransition({
    snapshot: { sourceId, ...LEGACY_COMPATIBLE_BINDING },
    currentPolicyVersion: retired.policy.policyVersion,
    currentPolicySha256: current,
    currentPolicyBytes: retired.bytes,
  });
  assert.deepEqual(legacyTransition(ELEVATOR), LEGACY_COMPATIBLE_BINDING);
  assert.throws(() => legacyTransition(ADDED_ID), BINDING_ERROR);
});

test("current-or-prior 판정은 퇴역 사슬에서 과거 정책에 있던 원천만 인정한다", () => {
  const beforeBinding = bindingTo(registered.bytes);
  const rootBinding = bindingTo(rootBytes);
  const currentBinding = bindingTo(retired.bytes);
  for (const sourceId of RETIRED_IDS) {
    assert.equal(isApproved(retired, sourceId, beforeBinding), true, `${sourceId}: 퇴역 전 정책`);
    assert.equal(isApproved(retired, sourceId, rootBinding), true, `${sourceId}: 루트 정책`);
    assert.equal(isApproved(retired, sourceId, currentBinding), false, `${sourceId}: 현재 정책`);
    assert.equal(isApproved(retired, sourceId, LEGACY_COMPATIBLE_BINDING), true, `${sourceId}: 루트 이전 정책이 승인한 과거 결속`);
  }
  assert.equal(isApproved(retired, KEPT_ID, beforeBinding), true);
  assert.equal(isApproved(retired, KEPT_ID, currentBinding), true);
  assert.equal(isApproved(retired, KEPT_ID, LEGACY_COMPATIBLE_BINDING), true);
  assert.equal(isApproved(retired, KEPT_ID, bindingTo(Buffer.from("다른 정책"))), false);
  assert.equal(isApproved(retired, KEPT_ID, { ...LEGACY_COMPATIBLE_BINDING, governancePolicySha256: "0".repeat(64) }), false, "호환 경로도 sha가 맞아야 한다");
  assert.equal(isApproved(retired, KEPT_ID, { ...LEGACY_COMPATIBLE_BINDING, governancePolicyVersion: "2026-08-29" }), false, "호환 경로는 버전도 맞아야 한다");
  assert.equal(isApproved(retired, KEPT_ID, { ...currentBinding, governancePolicyVersion: "2099-01-01" }), false);
  assert.equal(isApproved(retired, ADDED_ID, rootBinding), false, "등록 전 정책에는 인정하지 않는다");
  assert.equal(isApproved(retired, ADDED_ID, beforeBinding), true);
  assert.equal(isApproved(retired, ADDED_ID, LEGACY_COMPATIBLE_BINDING), false, "루트에 없던 원천에는 루트 이전 결속을 인정하지 않는다");
  assert.equal(isApproved(retiredTail, ADDED_ID, LEGACY_COMPATIBLE_BINDING), false, "퇴역한 뒤에도 마찬가지다");
  for (const sourceId of [undefined, null, 7]) {
    assert.equal(isApproved(retired, sourceId, currentBinding), false, `sourceId ${String(sourceId)}`);
  }
});

test("퇴역 사슬 위에 등록과 두 번째 퇴역을 다시 쌓아도 모든 단계가 재구성된다", () => {
  const added = buildAppendOnlyGovernancePolicyRegistration({
    predecessorPolicyBytes: retired.bytes,
    addedSources: [syntheticSource(`${ADDED_ID}-later`)],
  });
  const secondRetirement = buildGovernancePolicyRetirement({
    predecessorPolicyBytes: added.bytes,
    retiredSourceIds: [LIFT_LOCATION, ADDED_ID],
  });
  const second = { policy: secondRetirement.policy, bytes: secondRetirement.bytes };
  const rootSha = sha256(rootBytes);
  const registeredSha = sha256(registered.bytes);
  assert.equal(transition(second, ELEVATOR, rootSha).governancePolicySha256, rootSha);
  assert.equal(transition(second, ADDED_ID, registeredSha).governancePolicySha256, registeredSha);
  assert.throws(() => transition(second, ADDED_ID, sha256(second.bytes)), BINDING_ERROR);
  assert.equal(transition(second, `${ADDED_ID}-later`, sha256(added.bytes)).governancePolicySha256, sha256(added.bytes));
});

test("변이: 퇴역 기록의 원문을 위조하면 위조 정책 자기 sha에 묶어도 실패한다", () => {
  for (const mutate of [
    (policy) => { policy.registrationLineage.retiredSources[0].source.escalationHours += 1; },
    (policy) => { policy.registrationLineage.retiredSources[1].source.licenseReview.status = "BLOCKED"; },
    (policy) => { policy.registrationLineage.retiredSources[2].position += 1; },
    (policy) => { policy.registrationLineage.retiredSources.reverse(); },
    (policy) => { policy.registrationLineage.retiredSources[0].source.sourceId = "kric-forged-source"; },
  ]) {
    assertRejectedAtOwnSha(mutate);
  }
});

test("변이: 퇴역 원문이 누락되면 위조 정책 자기 sha에 묶어도 실패한다", () => {
  for (const mutate of [
    (policy) => { delete policy.registrationLineage.retiredSources; },
    (policy) => { policy.registrationLineage.retiredSources = []; },
    (policy) => { policy.registrationLineage.retiredSources.pop(); },
    (policy) => { delete policy.registrationLineage.retiredSourceIds; },
    (policy) => { policy.registrationLineage.retiredSourceIds = []; },
    (policy) => { policy.registrationLineage.retiredSources[0] = { position: 3 }; },
    (policy) => { policy.registrationLineage.addedSourceIds = [ESCALATOR]; },
  ]) {
    assertRejectedAtOwnSha(mutate);
  }
});

test("변이: 퇴역으로 기록하지 않은 원천을 몰래 빼면 위조 정책 자기 sha에 묶어도 실패한다", () => {
  for (const hidden of [KEPT_ID, ADDED_ID, "seoul-metro-accessibility"]) {
    assertRejectedAtOwnSha((policy) => { policy.sources = policy.sources.filter(({ sourceId }) => sourceId !== hidden); });
  }
  assertRejectedAtOwnSha((policy) => { policy.sources.push(structuredClone(policy.registrationLineage.retiredSources[0].source)); });
});

// 아래 케이스는 승인된 직전 정책을 그대로 재구성하는데도 원장의 선언 메타데이터가 사실과 다른 인코딩이다.
// 닫힌 epoch 루트 대조만으로는 걸러지지 않으므로 각 검사를 하나씩 고정한다.
test("변이: 승인된 직전 정책을 재구성해도 선언이 사실과 다른 인코딩은 실패한다", () => {
  const cases = [
    ["틀린 predecessorPolicySha256", retired, (policy) => { policy.registrationLineage.predecessorPolicySha256 = "0".repeat(64); }],
    ["retiredSourceIds에 id 추가", retired, (policy) => { policy.registrationLineage.retiredSourceIds.push(LIFT_LOCATION); }],
    ["retiredSourceIds 순서 뒤바꿈", retired, (policy) => { policy.registrationLineage.retiredSourceIds.reverse(); }],
    ["직전 정책 길이를 넘는 위치(끝에 붙는 별칭)", retiredTail, (policy) => { policy.registrationLineage.retiredSources[1].position = 999; }],
    ["내림차순 위치(끝 항목을 먼저 붙이는 별칭)", retiredTail, (policy) => {
      const lineage = policy.registrationLineage;
      lineage.retiredSources.reverse();
      lineage.retiredSourceIds.reverse();
      lineage.retiredSources[0].position -= 1;
    }],
    ["record에 키 추가", retired, (policy) => { policy.registrationLineage.retiredSources[0].extra = true; }],
  ];
  for (const [name, base, mutate] of cases) {
    const policy = structuredClone(base.policy);
    mutate(policy);
    assert.throws(() => bindToOwnSha(policy), BINDING_ERROR, name);
  }
});

test("검증기는 한 번 퇴역한 id를 이후 등록 단계에서 다시 추가하는 정책을 거부한다", () => {
  // builder를 거치지 않고 손으로 만든 등록 단계다. 신뢰의 기준점은 builder가 아니라 검증기다.
  const registrationOn = (base, sourceId, tweak = () => {}) => {
    const entry = structuredClone(rootPolicy.sources.find((source) => source.sourceId === sourceId) ?? syntheticSource(sourceId));
    tweak(entry);
    return {
      ...structuredClone(base.policy),
      sources: [...base.policy.sources, entry],
      registrationLineage: {
        predecessorPolicySha256: sha256(base.bytes),
        addedSourceIds: [sourceId],
        predecessorLineage: base.policy.registrationLineage,
        predecessorPolicyText: null,
      },
    };
  };
  assert.doesNotThrow(() => bindToOwnSha(registrationOn(retired, "synthetic-fresh-source")), "손으로 만든 등록 단계 자체는 유효하다");
  const changedTerms = (entry) => { entry.escalationHours = 1; };
  assert.throws(() => bindToOwnSha(registrationOn(retired, ELEVATOR, changedTerms)), BINDING_ERROR);
  assert.throws(() => bindToOwnSha(registrationOn(retired, ELEVATOR)), BINDING_ERROR, "조건이 같아도 거부한다");
  // 퇴역과 재등록 사이에 다른 등록이 끼어 있어도 사슬 전체에서 막는다.
  const between = buildAppendOnlyGovernancePolicyRegistration({
    predecessorPolicyBytes: retired.bytes,
    addedSources: [syntheticSource("synthetic-between-source")],
  });
  assert.doesNotThrow(() => bindToOwnSha(registrationOn(between, "synthetic-fresh-source")));
  assert.throws(() => bindToOwnSha(registrationOn(between, ESCALATOR, changedTerms)), BINDING_ERROR);
});

test("퇴역 builder는 존재하지 않거나 중복이거나 전체를 비우는 요청을 거부하고 퇴역 id 재등록도 거부한다", () => {
  const retire = (retiredSourceIds) => buildGovernancePolicyRetirement({ predecessorPolicyBytes: registered.bytes, retiredSourceIds });
  assert.throws(() => retire([]), BINDING_ERROR);
  assert.throws(() => retire(["unknown-source"]), BINDING_ERROR);
  assert.throws(() => retire([ELEVATOR, ELEVATOR]), BINDING_ERROR);
  assert.throws(() => retire(registered.policy.sources.map(({ sourceId }) => sourceId)), BINDING_ERROR);
  assert.throws(() => buildAppendOnlyGovernancePolicyRegistration({
    predecessorPolicyBytes: retired.bytes,
    addedSources: [syntheticSource(ELEVATOR)],
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
  const ids = RETIRED_KRIC_ACCESSIBILITY_SOURCE_IDS;
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
  assert.equal(bind(KEPT_ID, lineage.predecessorPolicySha256).governancePolicySha256, lineage.predecessorPolicySha256);
});
