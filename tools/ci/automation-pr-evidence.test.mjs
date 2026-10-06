import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTOMATION_PR_EVIDENCE_MARKER,
  AUTOMATION_PR_STAGES,
  automationPrEvidenceBlock,
  candidateRefreshEvidenceBlock,
  derivativeRebindingPullRequestBody,
  main,
  parseAutomationPrEvidence,
  registrationPullRequestBody,
} from "./automation-pr-evidence.mjs";

// #969: 2단계(자동 병합 정책)가 읽는 자동화 PR 출력 계약(이슈 §7). PR 본문의 기계 판독 블록은 색인일 뿐이고 정책은 diff와 원장에서 다시 계산해 대조한다.
// 블록은 정확히 하나여야 하고, 알려진 키·값만 받는다(조용히 정규화하지 않는다). base/head 커밋에 결속된다.
const RUN_URL = "https://github.com/AquilaXk/easysubway-data/actions/runs/123";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const POLICY = { schemaVersion: 1, issue: 969, allowContentChange: true, maxRowDeltaRatio: 0.05, allowCoverageDecrease: false, sourceOverrides: {} };
const SOURCE = {
  sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20261006", previousSnapshotId: "capital-route-topology-20261004",
  rawSha256: "c".repeat(64), contentSha256: "d".repeat(64), rowDelta: 0, coverageDelta: 0, diffStatus: "CHANGED",
};
const STEP = { id: "busan-transfer-metrics", changed: true, paths: ["tools/datapack/release/current-busan-transfer-metrics.json"] };
const CANDIDATE = { candidateId: "nationwide-candidate-20261006-seq128", releaseSequence: 128, sourceSnapshotSetHash: "e".repeat(64) };
const registration = (overrides = {}) => ({ stage: "registration", runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: POLICY, sources: [SOURCE], steps: [], candidate: null, ...overrides });
const rebinding = (overrides = {}) => ({ stage: "derivative-rebinding", runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: POLICY, sources: [], steps: [STEP, { id: "seoul-measured-transfer-metrics", changed: false, paths: [] }], candidate: null, ...overrides });
const candidate = (overrides = {}) => ({ stage: "candidate-refresh", runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: null, sources: [], steps: [], candidate: CANDIDATE, ...overrides });

test("단계는 등록·후보 갱신·파생 재결속 셋이다", () => {
  assert.deepEqual([...AUTOMATION_PR_STAGES], ["registration", "candidate-refresh", "derivative-rebinding"]);
});

test("블록은 원천별 sha·snapshot·delta·diff 상태와 적용 정책, base/head 커밋, 실행 run을 JSON 한 줄로 남기고 그대로 읽힌다", () => {
  const block = automationPrEvidenceBlock(registration());
  assert.match(block, new RegExp(`^<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} \\{.*\\} -->$`, "u"));
  assert.doesNotMatch(block, /\n/u);
  assert.deepEqual(parseAutomationPrEvidence(`본문\n\n${block}\n`), {
    schemaVersion: 1, stage: "registration", issue: 969, runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: POLICY, sources: [SOURCE], steps: [], candidate: null,
  });
  assert.equal(parseAutomationPrEvidence(automationPrEvidenceBlock(rebinding())).steps[0].paths[0], STEP.paths[0]);
  assert.deepEqual(parseAutomationPrEvidence(automationPrEvidenceBlock(candidate())).candidate, CANDIDATE);
});

test("블록이 없으면 null, 둘 이상이거나 JSON이 아니면 실패한다", () => {
  assert.equal(parseAutomationPrEvidence("블록 없음"), null);
  assert.equal(parseAutomationPrEvidence(undefined), null);
  const block = automationPrEvidenceBlock(registration());
  assert.throws(() => parseAutomationPrEvidence(`${block}\n${block}`), /AUTOMATION_PR_EVIDENCE_DUPLICATE/u);
  assert.throws(() => parseAutomationPrEvidence(`<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} {not json} -->`), /AUTOMATION_PR_EVIDENCE_INVALID/u);
});

// 편집 가능한 PR 본문을 정규화해 받아들이지 않는다. 모르는 키·잘못된 이슈·잘못된 값은 파싱 오류다(#975 리뷰 F3).
function stored(value) { return `<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} ${JSON.stringify(value)} -->`; }
const good = () => JSON.parse(automationPrEvidenceBlock(registration()).slice(`<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} `.length, -" -->".length));

test("저장된 블록에 모르는 키·잘못된 이슈·잘못된 단계·잘못된 커밋이 있으면 정규화하지 않고 파싱 오류로 실패한다", () => {
  const mutations = {
    "unknown top key": (value) => ({ ...value, extra: 1 }),
    "missing key": ({ policy, ...value }) => value,
    "schemaVersion": (value) => ({ ...value, schemaVersion: 2 }),
    "issue 1": (value) => ({ ...value, issue: 1 }),
    "issue string": (value) => ({ ...value, issue: "969" }),
    "unknown stage": (value) => ({ ...value, stage: "unknown" }),
    "runUrl http": (value) => ({ ...value, runUrl: "http://github.com/a/b/actions/runs/1" }),
    "runUrl other host": (value) => ({ ...value, runUrl: "https://example.com/a/b/actions/runs/1" }),
    "runUrl with suffix": (value) => ({ ...value, runUrl: `${RUN_URL}/jobs/1` }),
    "baseSha short": (value) => ({ ...value, baseSha: "abc" }),
    "headSha upper": (value) => ({ ...value, headSha: "B".repeat(40) }),
    "headSha number": (value) => ({ ...value, headSha: 1 }),
    "policy extra key": (value) => ({ ...value, policy: { ...value.policy, extra: true } }),
    "policy ratio": (value) => ({ ...value, policy: { ...value.policy, maxRowDeltaRatio: 7 } }),
    "source extra key": (value) => ({ ...value, sources: [{ ...value.sources[0], extra: 1 }] }),
    "source missing key": (value) => ({ ...value, sources: [{ ...value.sources[0], diffStatus: undefined }] }),
    "source sha": (value) => ({ ...value, sources: [{ ...value.sources[0], rawSha256: "xyz" }] }),
    "source contentSha": (value) => ({ ...value, sources: [{ ...value.sources[0], contentSha256: 5 }] }),
    "source sourceId empty": (value) => ({ ...value, sources: [{ ...value.sources[0], sourceId: "" }] }),
    "source snapshotId number": (value) => ({ ...value, sources: [{ ...value.sources[0], snapshotId: 3 }] }),
    "source previous number": (value) => ({ ...value, sources: [{ ...value.sources[0], previousSnapshotId: 3 }] }),
    "source rowDelta fraction": (value) => ({ ...value, sources: [{ ...value.sources[0], rowDelta: 1.5 }] }),
    "source coverageDelta string": (value) => ({ ...value, sources: [{ ...value.sources[0], coverageDelta: "0" }] }),
    "source diffStatus empty": (value) => ({ ...value, sources: [{ ...value.sources[0], diffStatus: "" }] }),
    "sources not array": (value) => ({ ...value, sources: {} }),
    "registration without sources": (value) => ({ ...value, sources: [] }),
    "registration with steps": (value) => ({ ...value, steps: [STEP] }),
    "registration with candidate": (value) => ({ ...value, candidate: CANDIDATE }),
    "registration without policy": (value) => ({ ...value, policy: null }),
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    assert.throws(() => parseAutomationPrEvidence(stored(mutate(good()))), /AUTOMATION_PR_EVIDENCE_INVALID/u, label);
  }
});

test("경로 항목은 비어 있지 않은 문자열이어야 하고 changed와 경로 유무가 일치해야 한다", () => {
  const withSteps = (steps) => rebinding({ steps });
  for (const [label, steps] of [
    ["empty path", [{ ...STEP, paths: [""] }]], ["numeric path", [{ ...STEP, paths: [3] }]], ["null path", [{ ...STEP, paths: [null] }]],
    ["mixed paths", [{ ...STEP, paths: [STEP.paths[0], ""] }]], ["paths not array", [{ ...STEP, paths: "tools/x.json" }]], ["no paths key", [{ id: STEP.id, changed: true }]],
    ["changed without paths", [{ ...STEP, paths: [] }]], ["unchanged with paths", [{ id: "a", changed: false, paths: ["x"] }]], ["changed not boolean", [{ ...STEP, changed: "true" }]],
    ["empty id", [{ ...STEP, id: "" }]], ["numeric id", [{ ...STEP, id: 5 }]], ["extra key", [{ ...STEP, extra: 1 }]], ["no steps", []], ["not array", {}],
  ]) {
    assert.throws(() => automationPrEvidenceBlock(withSteps(steps)), /AUTOMATION_PR_EVIDENCE_INVALID/u, `build ${label}`);
    const value = JSON.parse(automationPrEvidenceBlock(rebinding()).slice(`<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} `.length, -" -->".length));
    assert.throws(() => parseAutomationPrEvidence(stored({ ...value, steps })), /AUTOMATION_PR_EVIDENCE_INVALID/u, `parse ${label}`);
  }
  assert.doesNotThrow(() => automationPrEvidenceBlock(withSteps([{ id: "a", changed: false, paths: [] }, STEP])));
  assert.doesNotThrow(() => automationPrEvidenceBlock(rebinding({ sources: [SOURCE] })));
});

test("블록을 만들 때도 같은 검증을 한다(알 수 없는 단계·run URL·커밋·원천 필드)", () => {
  for (const [label, input] of [
    ["unknown stage", registration({ stage: "unknown" })], ["run url", registration({ runUrl: "http://x" })], ["base sha", registration({ baseSha: "x" })],
    ["head sha", registration({ headSha: BASE.toUpperCase() })], ["source field", registration({ sources: [{ ...SOURCE, rowDelta: "0" }] })],
    ["no sources", registration({ sources: [] })], ["policy", registration({ policy: { ...POLICY, extra: 1 } })],
  ]) assert.throws(() => automationPrEvidenceBlock(input), /AUTOMATION_PR_EVIDENCE_INVALID/u, label);
});

test("후보 갱신 블록은 후보 식별을 담고 원천·단계·정책이 없어야 한다", () => {
  for (const [label, overrides] of [
    ["no candidate", { candidate: null }], ["sources present", { sources: [SOURCE] }], ["steps present", { steps: [STEP] }], ["policy present", { policy: POLICY }],
    ["candidate extra", { candidate: { ...CANDIDATE, extra: 1 } }], ["candidate id empty", { candidate: { ...CANDIDATE, candidateId: "" } }],
    ["sequence zero", { candidate: { ...CANDIDATE, releaseSequence: 0 } }], ["sequence fraction", { candidate: { ...CANDIDATE, releaseSequence: 1.5 } }],
    ["set hash", { candidate: { ...CANDIDATE, sourceSnapshotSetHash: "short" } }],
  ]) assert.throws(() => automationPrEvidenceBlock(candidate(overrides)), /AUTOMATION_PR_EVIDENCE_INVALID/u, label);
});

test("재결속 블록은 단계가 하나 이상이어야 하고 후보 식별이 없어야 한다", () => {
  assert.throws(() => automationPrEvidenceBlock(rebinding({ candidate: CANDIDATE })), /AUTOMATION_PR_EVIDENCE_INVALID/u);
  assert.throws(() => automationPrEvidenceBlock(rebinding({ policy: null })), /AUTOMATION_PR_EVIDENCE_INVALID/u);
});

test("읽을 때 PR head 커밋을 넘기면 블록의 headSha와 같아야 한다(본문을 다른 커밋에 붙여 넣을 수 없다)", () => {
  const block = automationPrEvidenceBlock(registration());
  assert.equal(parseAutomationPrEvidence(block, { headSha: HEAD }).headSha, HEAD);
  assert.throws(() => parseAutomationPrEvidence(block, { headSha: "c".repeat(40) }), /AUTOMATION_PR_EVIDENCE_HEAD_MISMATCH/u);
  assert.throws(() => parseAutomationPrEvidence("블록 없음", { headSha: HEAD }), /AUTOMATION_PR_EVIDENCE_MISSING/u);
});

test("본문 생성: 등록·재결속은 원천 표와 Refs를, 후보 갱신은 블록만 만든다", () => {
  const registrationBody = registrationPullRequestBody({ runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: POLICY, sources: [SOURCE] });
  assert.match(registrationBody, /\| capital-route-topology \| capital-route-topology-20261006 \|/u);
  assert.match(registrationBody, /Refs #456\nRefs #969/u);
  assert.doesNotMatch(registrationBody, /Closes/u);
  assert.equal(parseAutomationPrEvidence(registrationBody, { headSha: HEAD }).stage, "registration");
  const body = derivativeRebindingPullRequestBody({ runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: POLICY, sources: [], steps: rebinding().steps });
  assert.match(body, /\| busan-transfer-metrics \| 갱신 \|/u);
  assert.match(body, /\| seoul-measured-transfer-metrics \| 변경 없음 \|/u);
  assert.match(body, /Refs #969\nRefs #870/u);
  assert.equal(parseAutomationPrEvidence(body).stage, "derivative-rebinding");
  assert.equal(parseAutomationPrEvidence(candidateRefreshEvidenceBlock({ runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, candidate: CANDIDATE })).stage, "candidate-refresh");
});

test("CLI는 게이트 출력·결과 JSON·후보 build spec에서 본문과 블록을 만든다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "automation-pr-evidence-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = (name) => path.join(directory, name);
  await writeFile(file("gate.json"), JSON.stringify({ policy: POLICY, sources: [SOURCE] }));
  await writeFile(file("result.json"), JSON.stringify({ steps: rebinding().steps }));
  await writeFile(file("spec.json"), JSON.stringify({ candidateId: CANDIDATE.candidateId, releaseSequence: CANDIDATE.releaseSequence, sourceSnapshotSetHash: CANDIDATE.sourceSnapshotSetHash, extra: "ignored" }));
  const common = ["--base-sha", BASE, "--head-sha", HEAD, "--run-url", RUN_URL];
  await main(["registration-body", "--gate", file("gate.json"), ...common, "--output", file("registration.md")]);
  assert.equal(parseAutomationPrEvidence(await readFile(file("registration.md"), "utf8"), { headSha: HEAD }).sources[0].sourceId, "capital-route-topology");
  await main(["derivative-rebinding-body", "--gate", file("gate.json"), "--result", file("result.json"), ...common, "--output", file("rebinding.md")]);
  assert.equal(parseAutomationPrEvidence(await readFile(file("rebinding.md"), "utf8")).steps.length, 2);
  const lines = [];
  await main(["candidate-refresh-block", "--build-spec", file("spec.json"), ...common], { write: (text) => lines.push(text) });
  assert.deepEqual(parseAutomationPrEvidence(lines.join("")).candidate, CANDIDATE);
  await assert.rejects(main(["registration-body", "--gate", file("gate.json"), ...common, "--output", file("registration.md")]), /EEXIST/u);
  await assert.rejects(main(["other", "--result", file("result.json")]), /AUTOMATION_PR_EVIDENCE_ARGUMENTS/u);
  await assert.rejects(main(["registration-body", "--gate", file("gate.json"), "--base-sha", "x", "--head-sha", HEAD, "--run-url", RUN_URL, "--output", file("again.md")]), /AUTOMATION_PR_EVIDENCE_INVALID/u);
});
