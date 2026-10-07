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
  itxPromotionPullRequestBody,
  itxPromotionSourceRow,
  main,
  parseAutomationPrEvidence,
  registrationPullRequestBody,
  sourceReverificationPullRequestBody,
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
const CANDIDATE = { candidateId: "nationwide-candidate-20261006-seq128", releaseSequence: 128, sourceSnapshotSetHash: "e".repeat(64), paths: ["tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/release-request.json"] };
const registration = (overrides = {}) => ({ stage: "registration", runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: POLICY, sources: [SOURCE], steps: [], candidate: null, ...overrides });
const rebinding = (overrides = {}) => ({ stage: "derivative-rebinding", runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: POLICY, sources: [], steps: [STEP, { id: "seoul-measured-transfer-metrics", changed: false, paths: [] }], candidate: null, ...overrides });
const candidate = (overrides = {}) => ({ stage: "candidate-refresh", runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: null, sources: [], steps: [], candidate: CANDIDATE, ...overrides });

test("단계는 등록·후보 갱신·파생 재결속·ITX 승격·원천 재확인 다섯 뒤에 정기 갱신 4종이 더해진다", () => {
  assert.deepEqual([...AUTOMATION_PR_STAGES].slice(0, 5), ["registration", "candidate-refresh", "derivative-rebinding", "itx-promotion", "source-reverification"]);
  assert.deepEqual([...AUTOMATION_PR_STAGES].slice(5), ["gwangju-timetable-refresh", "capital-topology-refresh", "kric-facility-refresh", "seoul-accessibility-refresh"]);
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
    ["paths missing", { candidate: { candidateId: CANDIDATE.candidateId, releaseSequence: 128, sourceSnapshotSetHash: CANDIDATE.sourceSnapshotSetHash } }],
    ["paths empty", { candidate: { ...CANDIDATE, paths: [] } }], ["paths unsorted", { candidate: { ...CANDIDATE, paths: [...CANDIDATE.paths].reverse() } }],
    ["paths duplicate", { candidate: { ...CANDIDATE, paths: [CANDIDATE.paths[0], CANDIDATE.paths[0]] } }], ["paths blank", { candidate: { ...CANDIDATE, paths: [""] } }],
    ["paths not array", { candidate: { ...CANDIDATE, paths: "a" } }],
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
  await writeFile(file("paths.txt"), `${CANDIDATE.paths.join("\n")}\n`);
  await main(["candidate-refresh-block", "--build-spec", file("spec.json"), "--changed-paths", file("paths.txt"), ...common], { write: (text) => lines.push(text) });
  assert.deepEqual(parseAutomationPrEvidence(lines.join("")).candidate, CANDIDATE);
  await assert.rejects(main(["registration-body", "--gate", file("gate.json"), ...common, "--output", file("registration.md")]), /EEXIST/u);
  await assert.rejects(main(["other", "--result", file("result.json")]), /AUTOMATION_PR_EVIDENCE_ARGUMENTS/u);
  await assert.rejects(main(["registration-body", "--gate", file("gate.json"), "--base-sha", "x", "--head-sha", HEAD, "--run-url", RUN_URL, "--output", file("again.md")]), /AUTOMATION_PR_EVIDENCE_INVALID/u);
});

// ---------------------------------------------------------------------------
// #977: ITX-청춘 원천 승격 단계(itx-promotion)
// ---------------------------------------------------------------------------
const ITX_ID = "itx-cheongchun-source-timetable-20261010181500000";
const ITX_PREVIOUS_ID = "itx-cheongchun-source-timetable-20261004151519524";
const ITX_PATHS = [
  "tools/datapack/itx-cheongchun-coverage-contract.json",
  `tools/datapack/sources/${ITX_ID}-completeness-evidence.json`,
  `tools/datapack/sources/${ITX_ID}-promotion-gate.json`,
  `tools/datapack/sources/${ITX_ID}.json`,
  // #979: 같은 run의 파생 재결속 산출물
  "tools/datapack/itx-cheongchun-topology-evidence.json",
  "tools/datapack/itx-cheongchun-topology-evidence-20261010181500000.json",
  ...["busan", "daegu", "daejeon", "gwangju", "seoul"].map((name) => `tools/route-map/route-map-defs/${name}-alignment-fixture.json`),
].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
const ITX_SOURCE = {
  sourceId: "itx-cheongchun-source-timetable", snapshotId: ITX_ID, previousSnapshotId: ITX_PREVIOUS_ID,
  rawSha256: "1".repeat(64), contentSha256: "2".repeat(64), rowDelta: 0, coverageDelta: 0, diffStatus: "PASS",
};
const ITX_STEP = { id: "itx-promotion", changed: true, paths: ITX_PATHS };
const itx = (overrides = {}) => ({ stage: "itx-promotion", runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: null, sources: [ITX_SOURCE], steps: [ITX_STEP], candidate: null, ...overrides });
const ITX_RECEIPT = {
  schemaVersion: 1,
  artifactKind: "itx-promotion-gate-receipt",
  policyId: "itx-promotion-gate-v1",
  anomalyPolicyVersion: "itx-snapshot-anomaly-v1",
  status: "PASS",
  candidate: { artifactId: ITX_ID, sha256: ITX_SOURCE.contentSha256, observedAt: "2026-10-10T18:15:00.000Z", freshUntil: "2026-10-18T00:00:00+09:00" },
  previous: { artifactId: ITX_PREVIOUS_ID, sha256: "3".repeat(64) },
  baseline: { artifactId: ITX_PREVIOUS_ID, sha256: "3".repeat(64) },
  source: { rawCaptureSha256: ITX_SOURCE.rawSha256, captureContentSha256: "4".repeat(64), replayEvidenceHash: "5".repeat(64), providerRecordCount: 1500 },
  policy: JSON.parse(await readFile(new URL("../datapack/itx-promotion-gate-policy.json", import.meta.url), "utf8")),
  checks: [
    { id: "STATION_COVERAGE", dayCd: "8", status: "PASS", observed: { added: 0, removed: 0 }, limit: { delta: 0 } },
    { id: "OD_COVERAGE", dayCd: "8", status: "PASS", observed: { added: 0, removed: 0 }, limit: { delta: 0 } },
    { id: "TUPLE_REMOVED", dayCd: "8", status: "PASS", observed: { previous: 280, count: 4 }, limit: { count: 14 } },
    { id: "TUPLE_ADDED", dayCd: "8", status: "PASS", observed: { previous: 280, count: 6 }, limit: { count: 14 } },
    { id: "TUPLE_REMOVED", dayCd: "7", status: "PASS", observed: { previous: 364, count: 0 }, limit: { count: 18 } },
    { id: "TUPLE_ADDED", dayCd: "7", status: "PASS", observed: { previous: 364, count: 1 }, limit: { count: 18 } },
    { id: "SOURCE_BINDING", status: "PASS", observed: { failures: [] }, limit: {} },
    { id: "FETCH_ERRORS", status: "PASS", observed: { failures: [], providerErrorRecords: 0 }, limit: { providerErrorRecords: 0 } },
  ],
  blockedCheckIds: [],
};

test("ITX 승격 블록은 원천 행 하나·변경 경로 단계 하나를 담고 정책·후보 식별이 없다", () => {
  const block = automationPrEvidenceBlock(itx());
  const parsed = parseAutomationPrEvidence(block, { headSha: HEAD });
  assert.deepEqual({ stage: parsed.stage, policy: parsed.policy, candidate: parsed.candidate }, { stage: "itx-promotion", policy: null, candidate: null });
  assert.deepEqual(parsed.sources, [ITX_SOURCE]);
  assert.deepEqual(parsed.steps, [ITX_STEP]);
  for (const [label, overrides] of [
    ["policy present", { policy: POLICY }], ["candidate present", { candidate: CANDIDATE }], ["no source", { sources: [] }],
    ["two sources", { sources: [ITX_SOURCE, ITX_SOURCE] }], ["no step", { steps: [] }], ["two steps", { steps: [ITX_STEP, STEP] }],
    ["foreign source id", { sources: [{ ...ITX_SOURCE, sourceId: "capital-route-topology" }] }],
    ["snapshot id shape", { sources: [{ ...ITX_SOURCE, snapshotId: "itx-cheongchun-source-timetable-2026" }] }],
    ["no previous", { sources: [{ ...ITX_SOURCE, previousSnapshotId: null }] }],
    ["diff status", { sources: [{ ...ITX_SOURCE, diffStatus: "BLOCK" }] }],
    ["foreign step id", { steps: [{ ...ITX_STEP, id: "busan-transfer-metrics" }] }],
    ["missing path", { steps: [{ ...ITX_STEP, paths: ITX_PATHS.slice(1) }] }],
    ["extra path", { steps: [{ ...ITX_STEP, paths: [...ITX_PATHS, "tools/datapack/source-inventory.json"] }] }],
    ["other snapshot path", { steps: [{ ...ITX_STEP, paths: [...ITX_PATHS.slice(0, 3), "tools/datapack/sources/itx-cheongchun-source-timetable-20260930163854026.json"] }] }],
    ["unchanged step", { steps: [{ id: "itx-promotion", changed: false, paths: [] }] }],
  ]) {
    assert.throws(() => automationPrEvidenceBlock(itx(overrides)), /AUTOMATION_PR_EVIDENCE_INVALID/u, label);
  }
});

test("ITX 원천 행은 게이트 영수증에서만 만들고 raw capture sha·후보 sha·직전 snapshot에 결속된다", () => {
  assert.deepEqual(itxPromotionSourceRow(ITX_RECEIPT), { ...ITX_SOURCE, rowDelta: 3, coverageDelta: 0 });
  // rowDelta는 시각 tuple 순증감(추가-제거), coverageDelta는 역·OD 변화 합이다.
  const changed = structuredClone(ITX_RECEIPT);
  changed.checks.find(({ id, dayCd }) => id === "STATION_COVERAGE" && dayCd === "8").observed = { added: 1, removed: 2 };
  assert.equal(itxPromotionSourceRow(changed).coverageDelta, 3);
  for (const mutate of [
    (receipt) => { receipt.status = "BLOCK"; },
    (receipt) => { receipt.blockedCheckIds = ["TRIP_COUNT:8"]; },
    (receipt) => { receipt.previous = null; },
    (receipt) => { receipt.source.rawCaptureSha256 = "short"; },
    (receipt) => { receipt.policyId = "other"; },
    (receipt) => { receipt.checks = receipt.checks.filter(({ id }) => id !== "STATION_COVERAGE"); },
  ]) {
    const broken = structuredClone(ITX_RECEIPT);
    mutate(broken);
    assert.throws(() => itxPromotionSourceRow(broken), /AUTOMATION_PR_EVIDENCE_INVALID/u);
  }
});

test("ITX 승격 본문: 원천 행·적용 한도·요일별 지표·변경 경로를 표로 남기고 Refs와 증거 블록을 단다", () => {
  const body = itxPromotionPullRequestBody({ runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, receipt: ITX_RECEIPT, changedPaths: ITX_PATHS });
  assert.match(body, new RegExp(`\\| itx-cheongchun-source-timetable \\| ${ITX_ID} \\| ${ITX_PREVIOUS_ID} \\|`, "u"));
  assert.match(body, /itx-promotion-gate-v1/u);
  assert.match(body, /누적 drift 기준선\(마지막 owner 승인 원천\): `itx-cheongchun-source-timetable-20261004151519524`/u);
  assert.match(body, /\| TUPLE_REMOVED \| 8 \| 4 \/ 14 \|/u);
  assert.match(body, /\| 첫차 이동 한도 \| 0초 \|/u);
  for (const path of ITX_PATHS) assert.ok(body.includes(path), path);
  assert.match(body, /Refs #977\nRefs #979\nRefs #870\nRefs #969\nRefs #636/u);
  assert.match(body, /재결속이 topology 증거와 alignment fixture를 새 원천에 맞췄다/u);
  assert.doesNotMatch(body, /Closes/u);
  assert.match(body, /승인 코멘트/u);
  const parsed = parseAutomationPrEvidence(body, { headSha: HEAD });
  assert.equal(parsed.stage, "itx-promotion");
  assert.deepEqual(parsed.sources[0], itxPromotionSourceRow(ITX_RECEIPT));
  assert.deepEqual(parsed.steps[0].paths, ITX_PATHS);
  // 경로 목록이 허용 경로와 다르면 본문도 만들지 않는다(재결속 산출물이 빠져도, 처음 4개만 있어도).
  assert.throws(() => itxPromotionPullRequestBody({ runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, receipt: ITX_RECEIPT, changedPaths: ITX_PATHS.filter((entry) => !entry.includes("alignment-fixture")) }), /AUTOMATION_PR_EVIDENCE_INVALID/u);
  assert.throws(() => itxPromotionPullRequestBody({ runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, receipt: ITX_RECEIPT, changedPaths: ITX_PATHS.filter((entry) => entry.startsWith("tools/datapack/sources/") || entry.endsWith("coverage-contract.json")) }), /AUTOMATION_PR_EVIDENCE_INVALID/u);
  assert.throws(() => itxPromotionPullRequestBody({ runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, receipt: ITX_RECEIPT, changedPaths: ITX_PATHS.slice(1) }), /AUTOMATION_PR_EVIDENCE_INVALID/u);
});

test("CLI itx-promotion-body는 영수증·변경 경로 목록·커밋에서 본문을 만든다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "automation-pr-evidence-itx-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = (name) => path.join(directory, name);
  await writeFile(file("receipt.json"), JSON.stringify(ITX_RECEIPT));
  await writeFile(file("paths.txt"), `${ITX_PATHS.join("\n")}\n`);
  const args = ["itx-promotion-body", "--receipt", file("receipt.json"), "--changed-paths", file("paths.txt"), "--base-sha", BASE, "--head-sha", HEAD, "--run-url", RUN_URL, "--output", file("body.md")];
  await main(args);
  assert.equal(parseAutomationPrEvidence(await readFile(file("body.md"), "utf8"), { headSha: HEAD }).sources[0].sourceId, "itx-cheongchun-source-timetable");
  await assert.rejects(main(args), /EEXIST/u);
  await writeFile(file("paths.txt"), `${ITX_PATHS.slice(1).join("\n")}\n`);
  await assert.rejects(main(args.map((value) => (value === file("body.md") ? file("other.md") : value))), /AUTOMATION_PR_EVIDENCE_INVALID/u);
});

// ---------------------------------------------------------------------------
// #984: P7D 원천 재확인 단계(source-reverification). 등록과 같은 원천 행(원장 게이트 + 증거 게이트)과 recipe별 변경 경로를 담는다.
// ---------------------------------------------------------------------------
const RV_LEDGER = "tools/datapack/release/source-snapshots.json";
const RV_INVENTORY = "tools/datapack/source-inventory.json";
const RV_SNAPSHOT = `tools/datapack/sources/gwangju-transportation-route-topology-${"a".repeat(64)}.json`;
const RV_STEP = { id: "gwangju-topology", changed: true, paths: [RV_INVENTORY, RV_LEDGER, RV_SNAPSHOT] };
const RV_SOURCE = { ...SOURCE, sourceId: "gwangju-transportation-route-topology", snapshotId: "gwangju-transportation-route-topology-1", previousSnapshotId: "gwangju-transportation-route-topology-0" };
const reverification = (overrides = {}) => ({ stage: "source-reverification", runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: POLICY, sources: [RV_SOURCE], steps: [RV_STEP], candidate: null, ...overrides });

test("원천 재확인 블록은 정책·원천 행·recipe 단계를 담고 후보 식별이 없다", () => {
  const parsed = parseAutomationPrEvidence(automationPrEvidenceBlock(reverification()), { headSha: HEAD });
  assert.equal(parsed.stage, "source-reverification");
  assert.deepEqual(parsed.policy, POLICY);
  assert.deepEqual(parsed.sources, [RV_SOURCE]);
  assert.deepEqual(parsed.steps, [RV_STEP]);
  assert.equal(parsed.candidate, null);
  assert.doesNotThrow(() => automationPrEvidenceBlock(reverification({ steps: [RV_STEP, { id: "gwangju-accessibility", changed: true, paths: [RV_INVENTORY, RV_LEDGER] }] })));
});

test("원천 재확인 블록은 알려진 recipe·허용 경로·바뀐 단계만 받는다", () => {
  for (const [label, overrides] of [
    ["no policy", { policy: null }], ["no sources", { sources: [] }], ["no steps", { steps: [] }], ["candidate", { candidate: CANDIDATE }],
    ["unknown recipe", { steps: [{ ...RV_STEP, id: "busan-transfer-metrics" }] }],
    ["duplicate recipe", { steps: [RV_STEP, RV_STEP] }],
    ["unchanged step", { steps: [{ id: "gwangju-topology", changed: false, paths: [] }] }],
    ["candidate path", { steps: [{ ...RV_STEP, paths: [...RV_STEP.paths, "tools/datapack/release/candidate-build-spec.json"] }] }],
    ["nested snapshot path", { steps: [{ ...RV_STEP, paths: [RV_INVENTORY, "tools/datapack/sources/nested/x.json"] }] }],
    ["workflow path", { steps: [{ ...RV_STEP, paths: [".github/workflows/ci.yml"] }] }],
    ["freshness policy path", { steps: [{ ...RV_STEP, paths: [...RV_STEP.paths, "release/product-gates/datapack-freshness-sla.json"] }] }],
    ["parent path", { steps: [{ ...RV_STEP, paths: ["tools/datapack/sources/../source-inventory.json"] }] }],
  ]) assert.throws(() => automationPrEvidenceBlock(reverification(overrides)), /AUTOMATION_PR_EVIDENCE_INVALID/u, label);
  // 저장된 블록도 같은 검증을 한다(본문은 PR 생성 뒤에도 고칠 수 있다).
  const value = JSON.parse(automationPrEvidenceBlock(reverification()).slice(`<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} `.length, -" -->".length));
  assert.throws(() => parseAutomationPrEvidence(stored({ ...value, steps: [{ ...RV_STEP, paths: [...RV_STEP.paths, "tools/datapack/release/hash-evidence.json"] }] })), /AUTOMATION_PR_EVIDENCE_INVALID/u);
});

test("원천 재확인 본문: recipe 표·원천 표·Refs와 증거 블록을 만든다", () => {
  const body = sourceReverificationPullRequestBody({ runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: POLICY, sources: [RV_SOURCE], steps: [RV_STEP] });
  assert.match(body, /\| gwangju-topology \| 갱신 \|/u);
  assert.match(body, /\| gwangju-transportation-route-topology \| gwangju-transportation-route-topology-1 \| gwangju-transportation-route-topology-0 \|/u);
  assert.match(body, /Refs #984\nRefs #969\nRefs #870/u);
  assert.doesNotMatch(body, /Closes/u);
  assert.equal(parseAutomationPrEvidence(body, { headSha: HEAD }).stage, "source-reverification");
});

test("CLI source-reverification-body는 원장 게이트 출력과 controller 결과(증거 행 포함)에서 본문을 만든다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "automation-pr-evidence-reverification-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = (name) => path.join(directory, name);
  const evidenceRow = { ...SOURCE, sourceId: "kric-nationwide-timetable-file", snapshotId: "kric-capital-1", previousSnapshotId: "kric-capital-1", diffStatus: "NO_CHANGE" };
  await writeFile(file("gate.json"), JSON.stringify({ policy: POLICY, sources: [RV_SOURCE] }));
  await writeFile(file("result.json"), JSON.stringify({ steps: [RV_STEP, { id: "kric-capital-timetable", changed: true, paths: [RV_INVENTORY] }], evidenceSources: [evidenceRow] }));
  const args = ["source-reverification-body", "--gate", file("gate.json"), "--result", file("result.json"), "--base-sha", BASE, "--head-sha", HEAD, "--run-url", RUN_URL, "--output", file("body.md")];
  await main(args);
  const parsed = parseAutomationPrEvidence(await readFile(file("body.md"), "utf8"), { headSha: HEAD });
  assert.deepEqual(parsed.sources.map(({ snapshotId }) => snapshotId), [RV_SOURCE.snapshotId, "kric-capital-1"]);
  assert.deepEqual(parsed.steps.map(({ id }) => id), ["gwangju-topology", "kric-capital-timetable"]);
  await assert.rejects(main(args), /EEXIST/u);
  await writeFile(file("result.json"), JSON.stringify({ steps: [{ id: "unknown", changed: true, paths: [RV_INVENTORY] }], evidenceSources: [] }));
  await assert.rejects(main(args.map((value) => (value === file("body.md") ? file("other.md") : value))), /AUTOMATION_PR_EVIDENCE_INVALID/u);
  // controller 결과에 증거 행 목록이 없으면 빈 목록으로 보지 않고 실패한다.
  await writeFile(file("result.json"), JSON.stringify({ steps: [RV_STEP] }));
  await assert.rejects(main(args.map((value) => (value === file("body.md") ? file("third.md") : value))), /AUTOMATION_PR_EVIDENCE_INVALID: source-reverification: the controller result lacks/u);
});
