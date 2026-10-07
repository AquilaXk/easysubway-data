import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { automationPrEvidenceBlock, itxPromotionAllowedPaths, parseAutomationPrEvidence, refreshEvidenceBlock } from "./automation-pr-evidence.mjs";
import {
  AUTOMATION_PR_APP,
  AUTOMATION_STAGE_WORKFLOWS,
  AUTOMATION_PR_GATES_CONTEXT,
  REGISTRATION_ALLOWED_PATHS,
  REGISTRATION_INVENTORY_FIELDS,
  automationAttestationMarker,
  automationEvidenceDigest,
  automationStageForBranch,
  decideAutomationPullRequest,
  evaluateAutomationPullRequest,
  main,
  recomputeAutomationGates,
} from "./automation-pr-policy.mjs";
import { DERIVATIVE_STEPS } from "../datapack/run-derivative-rebinding.mjs";
import { NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS } from "../datapack/refresh-nationwide-candidate.mjs";
import { evaluateEvidenceChange } from "../datapack/run-source-reverification.mjs";
import * as recorded from "../datapack/test-fixtures/refresh-recorded-runs.mjs";
import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";
import { REFRESH_STAGES, REFRESH_STAGE_IDS, evaluateRefreshStage } from "./refresh-stage-contracts.mjs";

// #985: 데이터 전용 자동화 PR의 자동 병합 정책(#870 전체 자동화 2단계). 정책은 PR 본문 증거 블록을 색인으로만 쓰고,
// 변경 경로·커밋 신원·CI·게이트는 API 데이터와 재계산으로 대조한다. 어느 조건이든 어긋나면 위반으로 막는다(fail closed).
const REPOSITORY = "AquilaXk/easysubway-data";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const OTHER = "c".repeat(40);
const RUN_ID = 123456;
const DIGEST = "a".repeat(64);
const RUN_URL = "https://github.com/AquilaXk/easysubway-data/actions/runs/123456";
const POLICY = { schemaVersion: 1, issue: 969, allowContentChange: true, maxRowDeltaRatio: 0.05, allowCoverageDecrease: false, sourceOverrides: {} };
const ACTIONS_BOT = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
const HUMAN = { login: "AquilaXk", id: 12345, type: "User" };
const LEDGER_SOURCE = {
  sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20261006", previousSnapshotId: "capital-route-topology-20261004",
  rawSha256: "c".repeat(64), contentSha256: "d".repeat(64), rowDelta: 0, coverageDelta: 0, diffStatus: "CHANGED",
};
const ITX_ID = "itx-cheongchun-source-timetable-20261010000000000";
const ITX_PREVIOUS_ID = "itx-cheongchun-source-timetable-20261004151519524";
const ITX_SOURCE = {
  sourceId: "itx-cheongchun-source-timetable", snapshotId: ITX_ID, previousSnapshotId: ITX_PREVIOUS_ID,
  rawSha256: "e".repeat(64), contentSha256: "f".repeat(64), rowDelta: 3, coverageDelta: 0, diffStatus: "PASS",
};
const CANDIDATE = { candidateId: "nationwide-candidate-20261006-seq128", releaseSequence: 128, sourceSnapshotSetHash: "9".repeat(64) };
const BUSAN_STEP = DERIVATIVE_STEPS.find(({ id }) => id === "busan-transfer-metrics");
const BUSAN_PATH = "tools/datapack/release/current-busan-transfer-metrics.json";
const CANDIDATE_PATHS = [...NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS].slice(0, 3).sort();

const REVERIFICATION_SNAPSHOT = `tools/datapack/sources/gwangju-transportation-route-topology-${"a".repeat(64)}.json`;
const REVERIFICATION_PATHS = ["tools/datapack/release/source-snapshots.json", "tools/datapack/source-inventory.json", REVERIFICATION_SNAPSHOT];

const STAGES = {
  "source-reverification": {
    branch: "automation/984-source-reverification-9005",
    paths: REVERIFICATION_PATHS,
    evidence: { stage: "source-reverification", policy: POLICY, sources: [LEDGER_SOURCE], steps: [{ id: "gwangju-topology", changed: true, paths: REVERIFICATION_PATHS }], candidate: null },
  },
  registration: {
    branch: "automation/456-capital-topology-registration-9001",
    paths: [...REGISTRATION_ALLOWED_PATHS],
    evidence: { stage: "registration", policy: POLICY, sources: [LEDGER_SOURCE], steps: [], candidate: null },
  },
  "itx-promotion": {
    branch: "automation/977-itx-promotion-9002",
    paths: itxPromotionAllowedPaths(ITX_ID),
    evidence: { stage: "itx-promotion", policy: null, sources: [ITX_SOURCE], steps: [{ id: "itx-promotion", changed: true, paths: itxPromotionAllowedPaths(ITX_ID) }], candidate: null },
  },
  "derivative-rebinding": {
    branch: "automation/969-derivative-rebinding-9003",
    paths: [BUSAN_PATH],
    evidence: {
      stage: "derivative-rebinding", policy: POLICY, sources: [],
      steps: [{ id: "busan-transfer-metrics", changed: true, paths: [BUSAN_PATH] }, { id: "seoul-measured-transfer-metrics", changed: false, paths: [] }], candidate: null,
    },
  },
  "candidate-refresh": {
    branch: "automation/927-nationwide-candidate-refresh-9004",
    paths: CANDIDATE_PATHS,
    evidence: { stage: "candidate-refresh", policy: null, sources: [], steps: [], candidate: { ...CANDIDATE, paths: CANDIDATE_PATHS } },
  },
};

const file = (filename, extra = {}) => ({ filename, status: "modified", ...extra });
const HEAD_COMMITTED_AT = "2026-10-06T00:00:00Z";
const commit = (sha, { author = ACTIONS_BOT, committer = ACTIONS_BOT, parents = 1, committedAt = HEAD_COMMITTED_AT, verified = false } = {}) => ({ sha, author, committer, commit: { committer: { date: committedAt }, verification: { verified } }, parents: Array.from({ length: parents }, (_, index) => ({ sha: `${index}`.repeat(40) })) });
const run = (name, conclusion = "success", { app = 15368, id = 1, startedAt = "2026-10-06T00:00:00Z" } = {}) => ({ id, name, status: "completed", conclusion, started_at: startedAt, app: { id: app } });

/** 정상 입력. 각 반증 테스트는 여기서 정확히 한 가지만 바꾼다. */
function scenario(stage = "registration") {
  const { branch, paths, evidence } = STAGES[stage];
  const body = `자동화 PR\n\n${automationPrEvidenceBlock({ ...evidence, runUrl: RUN_URL, baseSha: BASE, headSha: HEAD })}\n`;
  return {
    repository: REPOSITORY,
    pull: {
      number: 77, state: "open", merged: false, draft: true, body,
      user: { ...AUTOMATION_PR_APP },
      head: { ref: branch, sha: HEAD, repo: { full_name: REPOSITORY } },
      base: { ref: "main", sha: BASE, repo: { full_name: REPOSITORY } },
    },
    commits: [commit("1".repeat(40)), commit(HEAD)],
    files: paths.map((filename) => file(filename, filename === REVERIFICATION_SNAPSHOT ? { status: "added" } : {})),
    compare: { status: "ahead", ahead_by: 2, behind_by: 0, merge_base_commit: { sha: BASE } },
    checkRuns: [run("Data contracts", "success", { id: 10 }), run(AUTOMATION_PR_GATES_CONTEXT, "success", { id: 11 })],
    requiredContexts: [{ context: "Data contracts", integration_id: null }],
    workflowRun: { conclusion: "success", headSha: HEAD },
    ciEvidence: { schemaVersion: 1, headSha: HEAD, stage, evidenceSha256: automationEvidenceDigest(body) },
  };
}

const codesOf = (input) => evaluateAutomationPullRequest(input).violations.map(({ code }) => code);
const eligible = (input) => evaluateAutomationPullRequest(input).eligible;

test("신뢰 신원은 App easysubway-release-chain[bot]의 login·id·type으로 고정한다", () => {
  assert.deepEqual({ ...AUTOMATION_PR_APP }, { login: "easysubway-release-chain[bot]", id: 337648189, type: "Bot" });
  assert.equal(AUTOMATION_PR_GATES_CONTEXT, "Automation PR gates");
  assert.equal(automationAttestationMarker(HEAD, DIGEST), `<!-- Automation automerge policy: ${HEAD} evidence ${DIGEST} -->`);
  for (const [head, digest] of [["abc", DIGEST], [HEAD, "abc"], [HEAD, "A".repeat(64)], [HEAD, undefined]]) assert.throws(() => automationAttestationMarker(head, digest), /AUTOMATION_PR_INPUT/u);
});

test("claim 접두사는 정책이 아는 단계(기존 다섯과 갱신 4종)에만 대응하고 그 밖의 브랜치는 정책 대상이 아니다", () => {
  for (const [stage, { branch }] of Object.entries(STAGES)) assert.equal(automationStageForBranch(branch), stage);
  for (const branch of [
    "feature/x", "automation/700-unrelated-experiment-1", "automation/456-capital-topology-registration-", "automation/456-capital-topology-registration-0",
    "automation/456-capital-topology-registration-1/x", "xautomation/977-itx-promotion-1", "", undefined, null,
  ]) assert.equal(automationStageForBranch(branch), null, String(branch));
  assert.equal(evaluateAutomationPullRequest({ ...scenario(), pull: { ...scenario().pull, head: { ref: "feature/x", sha: HEAD, repo: { full_name: REPOSITORY } } } }).applicable, false);
});

for (const stage of Object.keys(STAGES)) {
  test(`정상: ${stage} 단계는 모든 조건을 만족하면 적격이다`, () => {
    const result = evaluateAutomationPullRequest(scenario(stage));
    assert.deepEqual(result.violations, []);
    assert.equal(result.applicable, true);
    assert.equal(result.eligible, true);
    assert.equal(result.stage, stage);
    assert.equal(result.headSha, HEAD);
  });
}

// ---------------------------------------------------------------------------
// 반증 1: 사람 커밋이 브랜치에 추가됨
// ---------------------------------------------------------------------------
test("반증: 사람이 쓴 커밋이 하나라도 있으면 막는다(작성자·커미터·누락·merge 커밋)", () => {
  const cases = {
    "human author": [commit("1".repeat(40)), commit("2".repeat(40), { author: HUMAN })],
    "human committer": [commit("1".repeat(40), { committer: HUMAN })],
    "github web-flow committer": [commit("1".repeat(40), { committer: { login: "web-flow", id: 19864447, type: "User" } })],
    "unlinked author": [commit("1".repeat(40), { author: null })],
    "unlinked committer": [commit("1".repeat(40), { committer: null })],
    "right login wrong id": [commit("1".repeat(40), { author: { ...ACTIONS_BOT, id: 7 } })],
    "right id user type": [commit("1".repeat(40), { author: { ...ACTIONS_BOT, type: "User" } })],
    "other bot": [commit("1".repeat(40), { author: { login: "dependabot[bot]", id: 49699333, type: "Bot" } })],
    "merge commit": [commit("1".repeat(40), { parents: 2 })],
    "no commits": [],
  };
  for (const [name, commits] of Object.entries(cases)) {
    const input = { ...scenario(), commits, compare: { ...scenario().compare, ahead_by: commits.length } };
    assert.equal(eligible(input), false, name);
    assert.ok(codesOf(input).includes("COMMITS"), name);
  }
  // App과 github-actions 둘 다 신뢰 신원이다.
  const mixed = { ...scenario(), commits: [commit("1".repeat(40), { author: AUTOMATION_PR_APP, committer: ACTIONS_BOT, verified: true }), commit("2".repeat(40))] };
  assert.equal(eligible(mixed), true);
});

test("반증: PR 커밋 목록이 API 상한에 닿았거나 compare와 개수가 어긋나면 모르는 이력이므로 막는다", () => {
  const many = Array.from({ length: 250 }, (_, index) => commit(String(index).padStart(40, "0")));
  assert.ok(codesOf({ ...scenario(), commits: many, compare: { ...scenario().compare, ahead_by: 250 } }).includes("COMMITS"));
  assert.ok(codesOf({ ...scenario(), compare: { ...scenario().compare, ahead_by: 3 } }).includes("COMMITS"));
});

// ---------------------------------------------------------------------------
// 반증 2: 허용 밖 경로가 바뀜(API diff에서 계산)
// ---------------------------------------------------------------------------
test("반증: 단계 allowlist 밖 경로가 하나라도 바뀌면 막는다", () => {
  for (const stage of Object.keys(STAGES)) {
    for (const extra of [".github/workflows/ci.yml", "tools/ci/automation-pr-policy.mjs", "tools/datapack/release/source-snapshots.json", "README.md"]) {
      if (STAGES[stage].paths.includes(extra)) continue;
      const input = scenario(stage);
      input.files = [...input.files, file(extra)];
      assert.equal(eligible(input), false, `${stage} + ${extra}`);
      assert.ok(codesOf(input).includes("PATHS"), `${stage} + ${extra}`);
    }
  }
});

test("반증: 이름을 바꾼 파일은 원래 경로까지 바뀐 경로로 센다", () => {
  const input = scenario("registration");
  input.files = [...input.files.slice(1), file(STAGES.registration.paths[0], { status: "renamed", previous_filename: ".github/workflows/ci.yml" })];
  assert.ok(codesOf(input).includes("PATHS"));
});

test("반증: 정확히 같아야 하는 단계(등록·ITX)는 allowlist 경로가 하나라도 빠지면 막는다", () => {
  for (const stage of ["registration", "itx-promotion"]) {
    const input = scenario(stage);
    input.files = input.files.slice(1);
    assert.ok(codesOf(input).includes("PATHS"), stage);
  }
});

test("반증: 변경 경로가 비었거나 API 파일 목록이 상한에 닿아 잘렸을 수 있으면 막는다", () => {
  for (const stage of Object.keys(STAGES)) assert.ok(codesOf({ ...scenario(stage), files: [] }).includes("PATHS"), stage);
  const truncated = scenario("candidate-refresh");
  truncated.files = Array.from({ length: 3000 }, (_, index) => file(CANDIDATE_PATHS[index % CANDIDATE_PATHS.length]));
  assert.ok(codesOf(truncated).includes("PATHS"));
});

// #987 F6: 원천 재확인 단계는 증거가 주장한 경로와 API diff가 정확히 같고, 재확인이 허용한 경로(원장·inventory·새 snapshot 파일)여야 한다.
// governance 정책은 재확인 PR이 바꾸지 않는다(등록 단계와 같은 이유로 사람 경로로 보낸다).
test("원천 재확인 단계: 증거의 경로 주장과 API diff가 정확히 같고 허용 경로 안일 때만 통과한다", () => {
  const governance = "tools/datapack/source-governance-policy.json";
  assert.deepEqual(codesOf(scenario("source-reverification")), []);
  const extra = scenario("source-reverification");
  extra.files = [...extra.files, file("tools/datapack/release/candidate-build-spec.json")];
  assert.ok(codesOf(extra).includes("PATHS"));
  const missing = scenario("source-reverification");
  missing.files = missing.files.slice(1);
  assert.ok(codesOf(missing).includes("PATHS"));
  const withGovernance = scenario("source-reverification");
  withGovernance.pull.body = withGovernance.pull.body.replace(/<!-- easysubway-automation-pr:v1 (.*?) -->/u, (_, json) => {
    const value = JSON.parse(json);
    value.steps[0].paths = [...value.steps[0].paths, governance].sort();
    return `<!-- easysubway-automation-pr:v1 ${JSON.stringify(value)} -->`;
  });
  withGovernance.ciEvidence = { ...withGovernance.ciEvidence, evidenceSha256: automationEvidenceDigest(withGovernance.pull.body) };
  withGovernance.files = [...withGovernance.files, file(governance)];
  assert.ok(codesOf(withGovernance).includes("PATHS"), "governance policy changes are not auto-mergeable");
});

// #987 N2: 재확인이 쓰는 snapshot 파일은 새 파일(added)이어야 한다. 이미 있는 snapshot의 수정·삭제·이름 변경은 불변 계약 위반이다.
test("반증: 원천 재확인의 snapshot 경로는 API diff의 status가 added일 때만 허용하고 수정·삭제·이름 변경은 막는다", () => {
  for (const status of ["modified", "removed", "renamed", "changed", "copied", "unchanged"]) {
    const input = scenario("source-reverification");
    input.files = input.files.map((entry) => (entry.filename === REVERIFICATION_SNAPSHOT ? { ...entry, status } : entry));
    assert.ok(codesOf(input).includes("PATHS"), status);
  }
  // 원장·inventory는 제자리에서 바뀌는 파일이라 modified여야 한다(새 파일이나 삭제는 이상이다).
  for (const status of ["added", "removed"]) {
    const input = scenario("source-reverification");
    input.files = input.files.map((entry) => (entry.filename === "tools/datapack/source-inventory.json" ? { ...entry, status } : entry));
    assert.ok(codesOf(input).includes("PATHS"), `inventory ${status}`);
  }
});

test("재결속 단계는 증거의 변경 단계 경로와 정확히 같아야 하고 각 경로는 그 단계가 허용한 경로여야 한다", () => {
  const unknownStep = scenario("derivative-rebinding");
  unknownStep.pull.body = `${automationPrEvidenceBlock({
    ...STAGES["derivative-rebinding"].evidence, steps: [{ id: "not-a-step", changed: true, paths: [BUSAN_PATH] }], runUrl: RUN_URL, baseSha: BASE, headSha: HEAD,
  })}`;
  assert.ok(codesOf(unknownStep).includes("PATHS"));

  const foreignPath = scenario("derivative-rebinding");
  foreignPath.pull.body = automationPrEvidenceBlock({
    ...STAGES["derivative-rebinding"].evidence, steps: [{ id: "busan-transfer-metrics", changed: true, paths: ["tools/datapack/release/current-seoul-measured-transfer-metrics.json"] }], runUrl: RUN_URL, baseSha: BASE, headSha: HEAD,
  });
  foreignPath.files = [file("tools/datapack/release/current-seoul-measured-transfer-metrics.json")];
  assert.ok(codesOf(foreignPath).includes("PATHS"));

  const noChange = scenario("derivative-rebinding");
  noChange.pull.body = automationPrEvidenceBlock({
    ...STAGES["derivative-rebinding"].evidence, steps: [{ id: "busan-transfer-metrics", changed: false, paths: [] }], runUrl: RUN_URL, baseSha: BASE, headSha: HEAD,
  });
  assert.ok(codesOf(noChange).includes("PATHS"));
  assert.equal(BUSAN_STEP.isAllowedPath(BUSAN_PATH), true);
});

test("후보 갱신 단계는 증거가 주장한 경로와 API diff가 정확히 같고 그 경로가 후보 갱신 도구의 출력 목록 안일 때만 통과한다(#986 F4)", () => {
  const input = scenario("candidate-refresh");
  // API diff가 증거의 경로보다 적어도(빠져도) 막는다. 부분집합은 통과하지 않는다.
  input.files = [file(CANDIDATE_PATHS[0])];
  assert.ok(codesOf(input).includes("PATHS"), "subset of the claimed paths");
  input.files = [...CANDIDATE_PATHS.map((entry) => file(entry)), file("tools/datapack/source-inventory.json")];
  assert.ok(codesOf(input).includes("PATHS"), "extra path");
  input.files = CANDIDATE_PATHS.map((entry) => file(entry));
  assert.equal(eligible(input), true);
  // 증거가 출력 목록 밖 경로를 주장하면 diff와 같아도 막는다.
  const outside = scenario("candidate-refresh");
  const claimed = [...CANDIDATE_PATHS, "tools/datapack/source-inventory.json"].sort();
  outside.pull.body = automationPrEvidenceBlock({ ...STAGES["candidate-refresh"].evidence, candidate: { ...CANDIDATE, paths: claimed }, runUrl: RUN_URL, baseSha: BASE, headSha: HEAD });
  outside.ciEvidence = { ...outside.ciEvidence, evidenceSha256: automationEvidenceDigest(outside.pull.body) };
  outside.files = claimed.map((entry) => file(entry));
  assert.ok(codesOf(outside).includes("PATHS"), "claimed path outside the tool outputs");
});

// ---------------------------------------------------------------------------
// 반증 3: 위조된 증거 블록
// ---------------------------------------------------------------------------
test("반증: 증거 블록의 head sha가 PR head와 다르면 막는다(위조·낡은 블록)", () => {
  const input = scenario();
  input.pull.body = `${automationPrEvidenceBlock({ ...STAGES.registration.evidence, runUrl: RUN_URL, baseSha: BASE, headSha: OTHER })}`;
  assert.ok(codesOf(input).includes("HEAD_MISMATCH"));
  assert.equal(eligible(input), false);
});

test("반증: 블록이 없거나 둘 이상이거나 형식이 어긋나면 막는다", () => {
  const block = automationPrEvidenceBlock({ ...STAGES.registration.evidence, runUrl: RUN_URL, baseSha: BASE, headSha: HEAD });
  for (const [name, body] of Object.entries({
    missing: "블록 없음", empty: "", nullBody: null, duplicate: `${block}\n${block}`,
    "unknown key": block.replace('"schemaVersion":1', '"schemaVersion":1,"extra":true'),
    "not json": "<!-- easysubway-automation-pr:v1 {nope} -->",
  })) {
    const input = scenario();
    input.pull.body = body;
    assert.ok(codesOf(input).includes("EVIDENCE"), name);
    assert.equal(eligible(input), false, name);
  }
});

test("반증: 블록의 base sha가 실제 분기점과 다르면 막는다", () => {
  const input = scenario();
  input.compare = { ...input.compare, merge_base_commit: { sha: OTHER } };
  assert.ok(codesOf(input).includes("BASE"));
});

test("반증: 블록의 단계와 브랜치 접두사가 서로 다른 단계를 가리키면 막는다", () => {
  const input = scenario("registration");
  input.pull.head.ref = STAGES["itx-promotion"].branch;
  assert.ok(codesOf(input).includes("BRANCH"));
});

// ---------------------------------------------------------------------------
// 반증 4: App이 아닌 작성자
// ---------------------------------------------------------------------------
test("반증: PR 작성자가 신뢰 App이 아니면 막는다(사람·다른 봇·login만 같은 위조·type)", () => {
  const authors = {
    human: HUMAN,
    "github-actions": ACTIONS_BOT,
    "other app": { login: "dependabot[bot]", id: 49699333, type: "Bot" },
    "same login wrong id": { ...AUTOMATION_PR_APP, id: 1 },
    "same id wrong login": { ...AUTOMATION_PR_APP, login: "someone" },
    "same login user type": { ...AUTOMATION_PR_APP, type: "User" },
    null: null,
  };
  for (const [name, user] of Object.entries(authors)) {
    const input = scenario();
    input.pull.user = user;
    assert.ok(codesOf(input).includes("AUTHOR"), name);
    assert.equal(eligible(input), false, name);
  }
});

// ---------------------------------------------------------------------------
// 반증 5: 게이트·CI 실패
// ---------------------------------------------------------------------------
test("반증: 게이트 재계산 check가 없거나 성공이 아니거나 github-actions가 만든 것이 아니면 막는다", () => {
  const mutations = {
    missing: (input) => { input.checkRuns = input.checkRuns.filter(({ name }) => name !== AUTOMATION_PR_GATES_CONTEXT); },
    failure: (input) => { input.checkRuns = [run("Data contracts"), run(AUTOMATION_PR_GATES_CONTEXT, "failure")]; },
    skipped: (input) => { input.checkRuns = [run("Data contracts"), run(AUTOMATION_PR_GATES_CONTEXT, "skipped")]; },
    pending: (input) => { input.checkRuns = [run("Data contracts"), { ...run(AUTOMATION_PR_GATES_CONTEXT), conclusion: null, status: "in_progress" }]; },
    "foreign app": (input) => { input.checkRuns = [run("Data contracts"), run(AUTOMATION_PR_GATES_CONTEXT, "success", { app: 99999 })]; },
    "latest failed": (input) => {
      // 배열 순서가 아니라 시작 시각으로 최신을 고른다(최신 실패가 배열 앞에 있어도 막아야 한다).
      input.checkRuns = [run("Data contracts"), run(AUTOMATION_PR_GATES_CONTEXT, "failure", { id: 2, startedAt: "2026-10-06T01:00:00Z" }), run(AUTOMATION_PR_GATES_CONTEXT, "success", { id: 1, startedAt: "2026-10-06T00:00:00Z" })];
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const input = scenario();
    mutate(input);
    assert.ok(codesOf(input).includes("GATES"), name);
    assert.equal(eligible(input), false, name);
  }
});

test("반증: required context가 성공이 아니거나 CI workflow가 성공으로 끝나지 않았으면 막는다", () => {
  const mutations = {
    "required failure": (input) => { input.checkRuns = [run("Data contracts", "failure"), run(AUTOMATION_PR_GATES_CONTEXT)]; },
    "required missing": (input) => { input.checkRuns = [run(AUTOMATION_PR_GATES_CONTEXT)]; },
    "required cancelled": (input) => { input.checkRuns = [run("Data contracts", "cancelled"), run(AUTOMATION_PR_GATES_CONTEXT)]; },
    "required pending": (input) => { input.checkRuns = [{ ...run("Data contracts"), conclusion: null, status: "queued" }, run(AUTOMATION_PR_GATES_CONTEXT)]; },
    "required integration": (input) => { input.requiredContexts = [{ context: "Data contracts", integration_id: 15368 }]; input.checkRuns = [run("Data contracts", "success", { app: 1 }), run(AUTOMATION_PR_GATES_CONTEXT)]; },
    "workflow failure": (input) => { input.workflowRun = { conclusion: "failure", headSha: HEAD }; },
    "workflow cancelled": (input) => { input.workflowRun = { conclusion: "cancelled", headSha: HEAD }; },
    "workflow head": (input) => { input.workflowRun = { conclusion: "success", headSha: OTHER }; },
    "no required contexts": (input) => { input.requiredContexts = []; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const input = scenario();
    mutate(input);
    assert.ok(codesOf(input).includes("CI"), name);
    assert.equal(eligible(input), false, name);
  }
});

// ---------------------------------------------------------------------------
// PR 상태와 입력 형식
// ---------------------------------------------------------------------------
test("PR이 열려 있지 않거나 main이 base가 아니거나 같은 저장소 브랜치가 아니거나 main보다 뒤처졌으면 막는다", () => {
  const mutations = {
    closed: (input) => { input.pull.state = "closed"; },
    merged: (input) => { input.pull.merged = true; },
    "other base": (input) => { input.pull.base.ref = "release"; },
    fork: (input) => { input.pull.head.repo = { full_name: "someone/easysubway-data" }; },
    "deleted fork": (input) => { input.pull.head.repo = null; },
    behind: (input) => { input.compare = { ...input.compare, behind_by: 1 }; },
    diverged: (input) => { input.compare = { ...input.compare, status: "diverged" }; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const input = scenario();
    mutate(input);
    assert.equal(eligible(input), false, name);
    assert.ok(codesOf(input).length > 0, name);
  }
  // draft는 정상이다. 정책이 통과하면 라벨러가 ready로 바꾼다.
  assert.equal(scenario().pull.draft, true);
  assert.equal(eligible(scenario()), true);
});

test("입력이 비었거나 모양이 다르면 예외 없이 위반으로 막는다", () => {
  for (const input of [{}, { ...scenario(), pull: null }, { ...scenario(), commits: null }, { ...scenario(), files: "x" }, { ...scenario(), compare: null }, { ...scenario(), checkRuns: undefined }]) {
    const result = evaluateAutomationPullRequest(input);
    assert.equal(result.eligible, false);
  }
});

test("위반은 하나라도 있으면 적격이 아니고 모든 위반이 코드와 함께 남는다", () => {
  const input = scenario();
  input.pull.user = HUMAN;
  input.commits = [commit("1".repeat(40), { author: HUMAN })];
  input.compare = { ...input.compare, ahead_by: 1 };
  input.files = [...input.files, file("README.md")];
  const result = evaluateAutomationPullRequest(input);
  assert.equal(result.eligible, false);
  for (const code of ["AUTHOR", "COMMITS", "PATHS"]) assert.ok(result.violations.some((item) => item.code === code), code);
  assert.ok(result.violations.every(({ detail }) => typeof detail === "string" && detail !== ""));
});

// ---------------------------------------------------------------------------
// 게이트 재계산(CI가 PR head에서 한다)
// ---------------------------------------------------------------------------
const row = (overrides) => ({
  sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20261004", previousSnapshotId: null,
  rawSha256: "1".repeat(64), contentSha256: "2".repeat(64), rowCount: 100, coverageCount: 50, ...overrides,
});
const BASE_LEDGER = [row()];
const HEAD_LEDGER = [row(), row({ snapshotId: "capital-route-topology-20261006", previousSnapshotId: "capital-route-topology-20261004", rawSha256: "3".repeat(64), contentSha256: "d".repeat(64), rowCount: 100, coverageCount: 50, diffSummary: { status: "CHANGED", rowDelta: 0, coverageDelta: 0 } })];
const EXPECTED_SOURCE = { ...LEDGER_SOURCE, previousSnapshotId: "capital-route-topology-20261004", rawSha256: "3".repeat(64), contentSha256: "d".repeat(64) };

const CAPITAL_ENTRY = { id: "capital-route-topology", productionUseAllowed: true, datasetUrl: "https://example.test/capital", retrievedAt: "2026-10-04", capitalTopologyAdmissionEvidence: { snapshotId: "a" } };
const INVENTORY_BASE = { schemaVersion: 1, region: "nationwide", sources: [{ id: "other-source", value: 1 }, CAPITAL_ENTRY] };
const INVENTORY_HEAD = { schemaVersion: 1, region: "nationwide", sources: [{ id: "other-source", value: 1 }, { ...CAPITAL_ENTRY, retrievedAt: "2026-10-06", capitalTopologyAdmissionEvidence: { snapshotId: "b" } }] };
const INVENTORY_PATH = "tools/datapack/source-inventory.json";

function gateInput(stage, { ledger = HEAD_LEDGER, evidenceOverrides = {}, contract, receipt, verifyItx, candidate, policy = POLICY, extraTree = {}, inventory = INVENTORY_HEAD, inventoryBase = INVENTORY_BASE } = {}) {
  const evidence = {
    schemaVersion: 1, issue: 969, runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, ...STAGES[stage].evidence,
    ...(["registration", "source-reverification"].includes(stage) ? { sources: [EXPECTED_SOURCE] } : {}), ...evidenceOverrides,
  };
  const tree = {
    "tools/datapack/release/source-snapshots.json": JSON.stringify(ledger),
    "tools/ci/source-ledger-change-policy.json": JSON.stringify(policy),
    [INVENTORY_PATH]: JSON.stringify(inventory),
    ...(contract === undefined ? {} : { "tools/datapack/itx-cheongchun-coverage-contract.json": JSON.stringify(contract) }),
    ...(receipt === undefined ? {} : { [`tools/datapack/sources/${ITX_ID}-promotion-gate.json`]: JSON.stringify(receipt) }),
    ...extraTree,
  };
  return {
    evidence,
    repositoryRoot: "/repo",
    files: {
      readTree: async (relative) => { if (!Object.hasOwn(tree, relative)) throw new Error(`missing ${relative}`); return tree[relative]; },
      readBase: async (sha, relative) => {
        assert.equal(sha, BASE);
        if (relative === INVENTORY_PATH) return JSON.stringify(inventoryBase);
        assert.equal(relative, "tools/datapack/release/source-snapshots.json");
        return JSON.stringify(BASE_LEDGER);
      },
    },
    verifyItx: verifyItx ?? (() => ({})),
    readCandidateState: candidate?.state ? async () => candidate.state : async () => { throw new Error("candidate state must not be read"); },
    candidateViolations: candidate?.violations ?? (() => []),
  };
}

const gateCodes = async (input) => (await recomputeAutomationGates(input)).violations.map(({ code }) => code);

test("게이트 재계산: 등록 단계는 원장 게이트를 원장 두 판본에서 다시 계산하고 증거 블록과 같아야 통과한다", async () => {
  const result = await recomputeAutomationGates(gateInput("registration"));
  assert.deepEqual(result.violations, []);
});

test("반증: 원장 게이트가 위반이면 증거 블록이 PASS를 주장해도 막는다", async () => {
  // contentSha256이 바뀌었는데 정책이 내용 변경을 막는 경우, 행 수가 한도를 넘는 경우, 기존 행이 바뀐 경우, 행이 사라진 경우
  const drift = { ...POLICY, allowContentChange: false };
  assert.ok((await gateCodes(gateInput("registration", { policy: drift }))).includes("LEDGER_GATE"));
  const bigDelta = [row(), { ...HEAD_LEDGER[1], rowCount: 400, diffSummary: { status: "CHANGED", rowDelta: 300, coverageDelta: 0 } }];
  assert.ok((await gateCodes(gateInput("registration", { ledger: bigDelta }))).includes("LEDGER_GATE"));
  const rewritten = [row({ rawSha256: "9".repeat(64) }), HEAD_LEDGER[1]];
  assert.ok((await gateCodes(gateInput("registration", { ledger: rewritten }))).includes("LEDGER_GATE"));
  assert.ok((await gateCodes(gateInput("registration", { ledger: [HEAD_LEDGER[1]] }))).includes("LEDGER_GATE"));
});

test("반증: 증거 블록의 원천 행·정책이 재계산한 값과 다르면 막는다", async () => {
  assert.ok((await gateCodes(gateInput("registration", { evidenceOverrides: { sources: [{ ...EXPECTED_SOURCE, contentSha256: "0".repeat(64) }] } }))).includes("EVIDENCE_DRIFT"));
  assert.ok((await gateCodes(gateInput("registration", { evidenceOverrides: { sources: [] } }))).includes("EVIDENCE_DRIFT"));
  assert.ok((await gateCodes(gateInput("registration", { evidenceOverrides: { policy: { ...POLICY, maxRowDeltaRatio: 1 } } }))).includes("EVIDENCE_DRIFT"));
});

test("재결속 단계의 원천 행은 재계산한 원장 변화와 같아야 한다(원장이 안 바뀌었으면 비어 있어야 한다)", async () => {
  assert.deepEqual((await recomputeAutomationGates(gateInput("derivative-rebinding", { ledger: BASE_LEDGER }))).violations, []);
  assert.ok((await gateCodes(gateInput("derivative-rebinding", { ledger: BASE_LEDGER, evidenceOverrides: { sources: [EXPECTED_SOURCE] } }))).includes("EVIDENCE_DRIFT"));
  assert.ok((await gateCodes(gateInput("derivative-rebinding", { ledger: HEAD_LEDGER }))).includes("EVIDENCE_DRIFT"));
});

const ITX_CONTRACT = {
  sourceTimetableArtifact: { artifactId: ITX_ID, sha256: "f".repeat(64), promotion: { mode: "CURRENT_CANDIDATE_GATE_PASSED" } },
};
const itxReceipt = (overrides = {}) => ({
  artifactKind: "itx-promotion-gate-receipt", schemaVersion: 1, policyId: "itx-promotion-gate-v1", status: "PASS", blockedCheckIds: [],
  candidate: { artifactId: ITX_ID, sha256: ITX_SOURCE.contentSha256 }, previous: { artifactId: ITX_PREVIOUS_ID }, source: { rawCaptureSha256: ITX_SOURCE.rawSha256 },
  checks: [
    { id: "STATION_COVERAGE", status: "PASS", observed: { added: 0, removed: 0 } },
    { id: "OD_COVERAGE", status: "PASS", observed: { added: 0, removed: 0 } },
    { id: "TUPLE_REMOVED", status: "PASS", observed: { count: 0 } },
    { id: "TUPLE_ADDED", status: "PASS", observed: { count: 3 } },
  ],
  ...overrides,
});

test("게이트 재계산: ITX 승격 단계는 커밋된 coverage contract의 승격 근거를 승격 권한 검증기로 다시 검증한다", async () => {
  const calls = [];
  const input = gateInput("itx-promotion", { ledger: BASE_LEDGER, contract: ITX_CONTRACT, receipt: itxReceipt(), verifyItx: (arguments_) => { calls.push(arguments_); return {}; } });
  assert.deepEqual((await recomputeAutomationGates(input)).violations, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].reference, ITX_CONTRACT.sourceTimetableArtifact);
  assert.equal(calls[0].repositoryRoot, "/repo");
});

test("반증: ITX 게이트가 실패하거나 승인 모드·다른 snapshot이거나 영수증이 증거 행과 다르면 막는다", async () => {
  const failing = () => { throw new Error("ITX_PROMOTION_RECEIPT_METRICS_MISMATCH"); };
  assert.ok((await gateCodes(gateInput("itx-promotion", { ledger: BASE_LEDGER, contract: ITX_CONTRACT, receipt: itxReceipt(), verifyItx: failing }))).includes("ITX_GATE"));
  const owner = { sourceTimetableArtifact: { ...ITX_CONTRACT.sourceTimetableArtifact, promotion: { mode: "CURRENT_CANDIDATE_OWNER_APPROVED" } } };
  assert.ok((await gateCodes(gateInput("itx-promotion", { ledger: BASE_LEDGER, contract: owner, receipt: itxReceipt() }))).includes("ITX_GATE"));
  const other = { sourceTimetableArtifact: { ...ITX_CONTRACT.sourceTimetableArtifact, artifactId: ITX_PREVIOUS_ID } };
  // 다른 snapshot의 영수증이 트리에 있어도 증거의 snapshot과 다른 승격 원천이면 막는다.
  const otherReceipt = { [`tools/datapack/sources/${ITX_PREVIOUS_ID}-promotion-gate.json`]: JSON.stringify(itxReceipt()) };
  assert.ok((await gateCodes(gateInput("itx-promotion", { ledger: BASE_LEDGER, contract: other, receipt: itxReceipt(), extraTree: otherReceipt }))).includes("ITX_GATE"));
  const blocked = itxReceipt({ status: "BLOCKED", blockedCheckIds: ["TRIP_COUNT"] });
  assert.ok((await gateCodes(gateInput("itx-promotion", { ledger: BASE_LEDGER, contract: ITX_CONTRACT, receipt: blocked }))).includes("ITX_GATE"));
  const forgedRow = itxReceipt({ source: { rawCaptureSha256: "0".repeat(64) } });
  assert.ok((await gateCodes(gateInput("itx-promotion", { ledger: BASE_LEDGER, contract: ITX_CONTRACT, receipt: forgedRow }))).some((code) => code === "ITX_GATE" || code === "EVIDENCE_DRIFT"));
  // ITX 승격이 원장 행을 바꾸면 그 자체로 막는다(ITX 단계는 원장을 쓰지 않는다).
  assert.ok((await gateCodes(gateInput("itx-promotion", { ledger: HEAD_LEDGER, contract: ITX_CONTRACT, receipt: itxReceipt() }))).includes("EVIDENCE_DRIFT"));
});

// 원천 재확인 단계의 게이트: 원장 행은 원장 두 판본에서, 원장 행이 없는 KRIC projection 증거 행은 inventory 두 판본에서 다시 계산해 증거 블록과 같아야 한다.
const KRIC_EVIDENCE = (overrides = {}) => ({ snapshotId: "kric-capital-1", rawSha256: "5".repeat(64), recordsSha256: "6".repeat(64), recordCount: 1000, routes: Array.from({ length: 10 }, (_, index) => ({ routeNumber: `R${index}` })), ...overrides });
const kricInventory = (capital, korail) => ({ ...INVENTORY_BASE, sources: [...INVENTORY_BASE.sources, { id: "kric-nationwide-timetable-file", capitalScheduleAdmissionEvidence: capital, korailScheduleAdmissionEvidence: korail }] });
const REV_OWNED = { productionUseAllowed: true, requiredForProductionPack: true, license: { type: "PUBLIC_DATA_FREE_USE" }, datasetUrl: "https://example.test/gwangju", coverage: "Gwangju line 1" };
const REV_BASE = { schemaVersion: 1, region: "nationwide", sources: [
  { id: "other-source", value: 1, productionUseAllowed: false },
  { id: "gwangju-transportation-route-topology", ...REV_OWNED, retrievedAt: "2026-10-05", topologyAdmissionEvidence: { snapshotId: "a" } },
  { id: "gwangju-transportation-accessibility", ...REV_OWNED, accessibilityAdmissionEvidence: { snapshotId: "a" } },
] };
const revHead = (edit) => ({ ...REV_BASE, sources: REV_BASE.sources.map((entry) => edit(entry)) });
const refreshed = (entry) => {
  if (entry.id === "gwangju-transportation-route-topology") return { ...entry, retrievedAt: "2026-10-06", topologyAdmissionEvidence: { snapshotId: "b" } };
  if (entry.id === "gwangju-transportation-accessibility") return { ...entry, accessibilityAdmissionEvidence: { snapshotId: "b" } };
  return entry;
};
const revGate = (edit, overrides = {}) => gateInput("source-reverification", { inventoryBase: REV_BASE, inventory: revHead(edit), ...overrides });
const KRIC_STEP = { id: "kric-capital-timetable", changed: true, paths: ["tools/datapack/source-inventory.json"] };

test("게이트 재계산: 원천 재확인 단계는 원장 행과 inventory 증거 행을 다시 계산해 증거 블록과 같아야 통과한다", async () => {
  assert.deepEqual((await recomputeAutomationGates(revGate(refreshed))).violations, []);
  const before = kricInventory(KRIC_EVIDENCE(), KRIC_EVIDENCE({ snapshotId: "kric-korail-1" }));
  const after = kricInventory(KRIC_EVIDENCE({ reverifiedAt: "2026-10-07T00:00:00.000Z" }), KRIC_EVIDENCE({ snapshotId: "kric-korail-1", recordCount: 1010 }));
  const rows = ["capitalScheduleAdmissionEvidence", "korailScheduleAdmissionEvidence"].flatMap((key) => evaluateEvidenceChange({
    sourceId: "kric-nationwide-timetable-file", before: before.sources.at(-1)[key], after: after.sources.at(-1)[key], policy: POLICY,
  }).row);
  const input = (overrides = {}) => gateInput("source-reverification", { inventoryBase: before, inventory: after, evidenceOverrides: { steps: [KRIC_STEP], sources: [EXPECTED_SOURCE, ...rows], ...overrides } });
  assert.deepEqual((await recomputeAutomationGates(input())).violations, []);
  // 증거 행이 빠지거나 값이 다르면 막는다.
  assert.ok((await gateCodes(input({ sources: [EXPECTED_SOURCE] }))).includes("EVIDENCE_DRIFT"));
  assert.ok((await gateCodes(input({ sources: [EXPECTED_SOURCE, { ...rows[0], contentSha256: "0".repeat(64) }, rows[1]] }))).includes("EVIDENCE_DRIFT"));
  assert.ok((await gateCodes(input({ policy: { ...POLICY, maxRowDeltaRatio: 1 } }))).includes("EVIDENCE_DRIFT"));
});

test("반증: 원천 재확인의 inventory 증거 변화가 정책 한도를 넘으면 증거 블록이 PASS를 주장해도 막는다", async () => {
  const before = kricInventory(KRIC_EVIDENCE(), KRIC_EVIDENCE({ snapshotId: "kric-korail-1" }));
  const grown = kricInventory(KRIC_EVIDENCE({ snapshotId: "kric-capital-2", rawSha256: "7".repeat(64), recordCount: 1400 }), KRIC_EVIDENCE({ snapshotId: "kric-korail-1" }));
  const rows = ["capitalScheduleAdmissionEvidence", "korailScheduleAdmissionEvidence"].flatMap((key) => evaluateEvidenceChange({
    sourceId: "kric-nationwide-timetable-file", before: before.sources.at(-1)[key], after: grown.sources.at(-1)[key], policy: { ...POLICY, maxRowDeltaRatio: 1 },
  }).row);
  const codes = await gateCodes(gateInput("source-reverification", { inventoryBase: before, inventory: grown, evidenceOverrides: { steps: [KRIC_STEP], sources: [EXPECTED_SOURCE, ...rows] } }));
  assert.ok(codes.includes("INVENTORY_GATE"));
});

test("반증: 원천 재확인이 inventory의 원천 항목을 더하거나 지우거나 최상위 필드를 바꾸면 막는다", async () => {
  const head = revHead(refreshed);
  assert.ok((await gateCodes(gateInput("source-reverification", { inventoryBase: REV_BASE, inventory: { ...head, sources: [...head.sources, { id: "new-source" }] } }))).includes("INVENTORY_GATE"));
  assert.ok((await gateCodes(gateInput("source-reverification", { inventoryBase: REV_BASE, inventory: { ...head, sources: head.sources.slice(1) } }))).includes("INVENTORY_GATE"));
  assert.ok((await gateCodes(gateInput("source-reverification", { inventoryBase: REV_BASE, inventory: { ...head, region: "other" } }))).includes("INVENTORY_GATE"));
  assert.ok((await gateCodes(revGate(refreshed, { ledger: [HEAD_LEDGER[1]] }))).includes("LEDGER_GATE"));
});

// #987 N1: recipe가 소유한 항목 밖은 깊은 비교로 같아야 하고, 소유 항목 안에서도 갱신 대상 필드만 바뀔 수 있다.
test("반증: 원천 재확인이 소유하지 않은 inventory 항목의 내용을 바꾸면 막는다", async () => {
  const unrelated = (entry) => (entry.id === "other-source" ? { ...refreshed(entry), productionUseAllowed: true, datasetUrl: "https://evil.test" } : refreshed(entry));
  assert.ok((await gateCodes(revGate(unrelated))).includes("INVENTORY_GATE"));
  const quiet = (entry) => (entry.id === "other-source" ? { ...entry, value: 2 } : refreshed(entry));
  assert.ok((await gateCodes(revGate(quiet))).includes("INVENTORY_GATE"));
});

test("반증: 실제 inventory에서 무관한 항목(kric-station-elevator)의 productionUseAllowed·datasetUrl을 바꿔도 막는다", async () => {
  const real = JSON.parse(await readFile(path.join(import.meta.dirname, "../datapack/source-inventory.json"), "utf8"));
  const tampered = structuredClone(real);
  const entry = tampered.sources.find(({ id }) => id === "kric-station-elevator");
  entry.productionUseAllowed = !entry.productionUseAllowed;
  entry.datasetUrl = "https://evil.test/elevator";
  assert.ok((await gateCodes(gateInput("source-reverification", { inventoryBase: real, inventory: tampered }))).includes("INVENTORY_GATE"));
  assert.ok(!(await gateCodes(gateInput("source-reverification", { inventoryBase: real, inventory: structuredClone(real) }))).includes("INVENTORY_GATE"));
});

test("반증: 원천 재확인이 소유한 항목의 정책성 필드(productionUseAllowed·requiredForProductionPack·license·datasetUrl·coverage)를 바꾸면 막는다", async () => {
  for (const [field, value] of [["productionUseAllowed", false], ["requiredForProductionPack", false], ["license", { type: "OTHER" }], ["datasetUrl", "https://evil.test"], ["coverage", "all lines"]]) {
    const tamper = (entry) => (entry.id === "gwangju-transportation-route-topology" ? { ...refreshed(entry), [field]: value } : refreshed(entry));
    assert.ok((await gateCodes(revGate(tamper))).includes("INVENTORY_GATE"), field);
  }
  // 이 PR의 recipe가 소유하지 않은 항목은 소유 필드여도 바꿀 수 없다(광주 접근성은 gwangju-topology가 의존 항목으로 명시한다).
  const stepsOnlyBusan = { steps: [{ id: "busan-topology", changed: true, paths: REVERIFICATION_PATHS }] };
  assert.ok((await gateCodes(revGate(refreshed, { evidenceOverrides: stepsOnlyBusan }))).includes("INVENTORY_GATE"));
});

const SCHEDULED = { requestedBy: "datapack-scheduled-refresh", approvedBy: "datapack-release-gates" };
const GATE_RUN = { repository: "AquilaXk/easysubway-data", workflowPath: ".github/workflows/nationwide-candidate-refresh.yml", runId: 123456, runAttempt: 1, event: "schedule", headSha: BASE };
const candidateState = (overrides = {}) => ({
  buildSpec: { ...CANDIDATE, publishedAt: "2026-10-06T00:51:18.300Z" },
  fanIn: { evaluatedAt: "2026-10-06T00:51:18.300Z" },
  releaseRequest: { ...SCHEDULED, gateRun: { ...GATE_RUN } },
  ...overrides,
});

test("게이트 재계산: 후보 갱신 단계는 후보 결속 위반이 없고 증거의 후보 식별이 커밋된 build spec과 같아야 한다", async () => {
  const state = candidateState();
  const calls = [];
  const ok = gateInput("candidate-refresh", { ledger: BASE_LEDGER, candidate: { state, violations: (arguments_) => { calls.push(arguments_); return []; } } });
  assert.deepEqual((await recomputeAutomationGates(ok)).violations, []);
  assert.ok((await gateCodes(gateInput("candidate-refresh", { ledger: BASE_LEDGER, candidate: { state, violations: () => ["sourceSnapshotSetHash mismatch"] } }))).includes("CANDIDATE_GATE"));
  const drifted = candidateState({ buildSpec: { ...CANDIDATE, releaseSequence: 129, publishedAt: "2026-10-06T00:51:18.300Z" } });
  assert.ok((await gateCodes(gateInput("candidate-refresh", { ledger: BASE_LEDGER, candidate: { state: drifted, violations: () => [] } }))).includes("EVIDENCE_DRIFT"));
  assert.ok((await gateCodes(gateInput("candidate-refresh", { ledger: HEAD_LEDGER, candidate: { state, violations: () => [] } }))).includes("EVIDENCE_DRIFT"));
});

// #986 F4: 결속 검증기에 넘기는 기대값은 검증 대상 파일 자신이 아니라 독립 원천에서 온다.
test("후보 게이트의 기대값은 build spec(후보 시계)·정기 역할 상수·증거의 run과 base에서 오고 release request 자신에서 오지 않는다", async () => {
  // fan-in의 시계가 달라도 기대 시계는 build spec의 publishedAt이다. release request가 사람 역할을 주장해도 기대 역할은 정기 역할이다.
  const state = candidateState({
    fanIn: { evaluatedAt: "2099-01-01T00:00:00.000Z" },
    releaseRequest: { requestedBy: "someone", approvedBy: "someone-else", gateRun: { ...GATE_RUN, runId: 999, headSha: OTHER } },
  });
  const calls = [];
  const input = gateInput("candidate-refresh", { ledger: BASE_LEDGER, candidate: { state, violations: (arguments_) => { calls.push(arguments_); return []; } } });
  await recomputeAutomationGates(input);
  assert.equal(calls[0].evaluatedAt, "2026-10-06T00:51:18.300Z");
  assert.equal(calls[0].requestedBy, SCHEDULED.requestedBy);
  assert.equal(calls[0].approvedBy, SCHEDULED.approvedBy);
  assert.deepEqual({ runId: calls[0].gateRun.runId, headSha: calls[0].gateRun.headSha }, { runId: 123456, headSha: BASE });
  // 결속 검증기가 기대값과 release request의 불일치를 위반으로 드러내는지 실제 검증기로 확인한다.
  const real = await recomputeAutomationGates({ ...input, candidateViolations: undefined });
  const texts = real.violations.map(({ detail }) => detail).join(" | ");
  for (const expected of ["requestedBy mismatch", "approvedBy mismatch", "gateRun mismatch"]) assert.ok(texts.includes(expected), expected);
});

test("반증: 후보의 gateRun이 증거의 run·base와 다르거나 형식이 틀리거나 없으면 막는다", async () => {
  const run = async (gateRun) => gateCodes(gateInput("candidate-refresh", { ledger: BASE_LEDGER, candidate: { state: candidateState({ releaseRequest: { ...SCHEDULED, gateRun } }), violations: () => [] } }));
  assert.deepEqual(await run({ ...GATE_RUN }), []);
  for (const [name, gateRun] of Object.entries({
    "other run": { ...GATE_RUN, runId: 1 },
    "other base": { ...GATE_RUN, headSha: OTHER },
    "other workflow": { ...GATE_RUN, workflowPath: ".github/workflows/ci.yml" },
    "other repository": { ...GATE_RUN, repository: "other/repo" },
    "extra key": { ...GATE_RUN, extra: 1 },
    missing: undefined,
    "string run id": { ...GATE_RUN, runId: "123456" },
  })) assert.ok((await run(gateRun)).includes("CANDIDATE_GATE"), name);
});

test("게이트 재계산: 읽을 수 없는 입력은 예외 없이 위반으로 막는다(원장·정책·base 읽기 실패)", async () => {
  const input = gateInput("registration");
  input.files.readBase = async () => { throw new Error("fatal: bad object"); };
  assert.ok((await gateCodes(input)).includes("LEDGER_GATE"));
});

// ---------------------------------------------------------------------------
// 라벨러의 판정 흐름(API 읽기만 쓴다)
// ---------------------------------------------------------------------------
function fakeApi(input, { pulls, labels = [], comments = [], artifacts = [{ id: 55, name: "automation-pr-evidence", expired: false }] } = {}) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === `repos/${REPOSITORY}/commits/${HEAD}/pulls`) return pulls ?? [{ number: 77, state: "open", base: { ref: "main" }, head: { sha: HEAD } }];
    if (path === `repos/${REPOSITORY}/pulls/77`) return { ...input.pull, labels };
    if (path.startsWith(`repos/${REPOSITORY}/pulls/77/commits`)) return input.commits;
    if (path.startsWith(`repos/${REPOSITORY}/pulls/77/files`)) return input.files;
    if (path.startsWith(`repos/${REPOSITORY}/compare/main...${HEAD}`)) return input.compare;
    if (path.startsWith(`repos/${REPOSITORY}/commits/${HEAD}/check-runs`)) return { total_count: input.checkRuns.length, check_runs: input.checkRuns };
    if (path === `repos/${REPOSITORY}/rules/branches/main`) return [{ type: "required_status_checks", parameters: { required_status_checks: input.requiredContexts } }];
    if (path.startsWith(`repos/${REPOSITORY}/issues/77/comments`)) return comments;
    if (path === `repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts?name=automation-pr-evidence`) return { total_count: artifacts.length, artifacts };
    if (path === `repos/${REPOSITORY}/actions/artifacts/55/zip#evidence-digest.json`) return input.ciEvidence;
    throw new Error(`unexpected API path ${path}`);
  };
  return { api, calls };
}

const ATTESTED_AT = "2026-10-06T00:10:00Z";
const attestationFor = (input, overrides = {}) => ({ user: { ...AUTOMATION_PR_APP }, body: automationAttestationMarker(HEAD, automationEvidenceDigest(input.pull.body)), created_at: ATTESTED_AT, updated_at: ATTESTED_AT, ...overrides });

test("라벨러 판정: 적격이면 ELIGIBLE과 PR 번호·head·단계·이미 한 일을 돌려준다", async () => {
  const input = scenario("itx-promotion");
  const { api } = fakeApi(input);
  const decision = await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api });
  assert.deepEqual(decision, { state: "ELIGIBLE", pullRequest: 77, headSha: HEAD, stage: "itx-promotion", evidenceSha256: input.ciEvidence.evidenceSha256, draft: true, labeled: false, attested: false });
  const done = fakeApi(input, { labels: [{ name: "automerge" }], comments: [attestationFor(input)] });
  const again = await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: done.api });
  assert.equal(again.labeled, true);
  assert.equal(again.attested, true);
  // 같은 head의 기록이라도 신뢰 App이 쓴 것만 센다.
  const forged = fakeApi(input, { comments: [attestationFor(input, { user: HUMAN })] });
  assert.equal((await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: forged.api })).attested, false);
});

test("라벨러 판정: 위반이면 예외로 끝나고 코드가 메시지에 남는다. 쓰기 호출은 없다", async () => {
  const input = scenario();
  input.pull.user = HUMAN;
  const { api, calls } = fakeApi(input);
  await assert.rejects(decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api }), /AUTOMATION_PR_AUTHOR/u);
  assert.ok(calls.every((path) => typeof path === "string"));
});

test("라벨러 판정: 정책 대상이 아닌 PR·닫힌 PR·head가 이미 바뀐 실행은 아무것도 하지 않는다", async () => {
  const base = scenario();
  const other = scenario();
  other.pull.head.ref = "automation/700-unrelated-experiment-1";
  const otherApi = fakeApi(other);
  assert.equal((await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: otherApi.api })).state, "NOT_APPLICABLE");
  // 대상이 아닌 PR은 커밋·파일·check 같은 무거운 읽기를 하지 않는다.
  assert.deepEqual(otherApi.calls, [`repos/${REPOSITORY}/commits/${HEAD}/pulls`, `repos/${REPOSITORY}/pulls/77`]);
  assert.equal((await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(base, { pulls: [] }).api })).state, "NOT_APPLICABLE");
  const moved = scenario();
  moved.pull.head.sha = OTHER;
  assert.equal((await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(moved).api })).state, "STALE");
  // 취소된 CI 실행은 새 head의 실행이 이어받는다.
  assert.equal((await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "cancelled", runId: RUN_ID, api: fakeApi(base).api })).state, "STALE");
});

test("라벨러 판정: 같은 head를 가진 열린 PR이 둘 이상이면 모호하므로 막고 API 실패는 그대로 실패한다", async () => {
  const input = scenario();
  const two = [{ number: 77, state: "open", base: { ref: "main" }, head: { sha: HEAD } }, { number: 78, state: "open", base: { ref: "main" }, head: { sha: HEAD } }];
  await assert.rejects(decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(input, { pulls: two }).api }), /AUTOMATION_PR_INPUT/u);
  await assert.rejects(decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: async () => { throw new Error("HTTP 502"); } }), /HTTP 502/u);
  await assert.rejects(decideAutomationPullRequest({ repository: "bad repo", headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(input).api }), /AUTOMATION_PR_INPUT/u);
  await assert.rejects(decideAutomationPullRequest({ repository: REPOSITORY, headSha: "abc", runConclusion: "success", runId: RUN_ID, api: fakeApi(input).api }), /AUTOMATION_PR_INPUT/u);
});

test("CLI: 알 수 없는 명령·인자는 실패한다", async () => {
  await assert.rejects(main(["unknown"]), /AUTOMATION_PR_INPUT/u);
  await assert.rejects(main(["decide", "--repository", REPOSITORY]), /AUTOMATION_PR_INPUT/u);
  await assert.rejects(main(["decide", "--repository", REPOSITORY, "--repository", REPOSITORY]), /AUTOMATION_PR_INPUT/u);
});

// ---------------------------------------------------------------------------
// CLI 명령(CI job과 라벨러가 부른다)
// ---------------------------------------------------------------------------
async function withTemp(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "automation-pr-policy-"));
  try { return await callback(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("CLI prepare: 정책 대상 PR이면 증거의 base sha를 내보내고, 대상이 아니면 applicable=false다", async () => {
  await withTemp(async (dir) => {
    const input = scenario("derivative-rebinding");
    const pullFile = path.join(dir, "pull.json");
    const output = path.join(dir, "output.txt");
    await writeFile(pullFile, JSON.stringify(input.pull));
    const lines = [];
    await main(["prepare", "--pull-request", pullFile, "--github-output", output], { log: (line) => lines.push(line) });
    assert.equal(await readFile(output, "utf8"), `applicable=true\nbase_sha=${BASE}\n`);

    const other = { ...input.pull, head: { ...input.pull.head, ref: "automation/700-unrelated-experiment-1" } };
    await writeFile(pullFile, JSON.stringify(other));
    const outputOther = path.join(dir, "output-other.txt");
    await main(["prepare", "--pull-request", pullFile, "--github-output", outputOther], { log: () => {} });
    assert.equal(await readFile(outputOther, "utf8"), "applicable=false\nbase_sha=\n");
  });
});

test("CLI prepare·gates: 증거가 없거나 단계가 브랜치와 다르거나 작업 트리 head가 PR head와 다르면 실패한다", async () => {
  await withTemp(async (dir) => {
    const pullFile = path.join(dir, "pull.json");
    const input = scenario("registration");
    await writeFile(pullFile, JSON.stringify({ ...input.pull, body: "증거 없음" }));
    await assert.rejects(main(["prepare", "--pull-request", pullFile]), /AUTOMATION_PR_EVIDENCE_MISSING/u);
    await writeFile(pullFile, JSON.stringify({ ...input.pull, head: { ...input.pull.head, ref: STAGES["itx-promotion"].branch } }));
    await assert.rejects(main(["prepare", "--pull-request", pullFile]), /AUTOMATION_PR_BRANCH/u);
    // 작업 트리(이 저장소)의 head는 PR의 가짜 head(bbbb...)와 다르다. 재계산 전에 막힌다.
    await writeFile(pullFile, JSON.stringify(input.pull));
    await assert.rejects(main(["gates", "--pull-request", pullFile, "--repository-root", path.resolve(import.meta.dirname, "../..")]), /AUTOMATION_PR_HEAD_MISMATCH/u);
    await writeFile(pullFile, JSON.stringify({ head: { ref: "x" } }));
    await assert.rejects(main(["prepare", "--pull-request", pullFile]), /AUTOMATION_PR_INPUT/u);
  });
});

test("CLI decide: 판정을 GITHUB_OUTPUT에 쓰고, 값이 출력 형식에 맞지 않으면 쓰지 않고 실패한다", async () => {
  await withTemp(async (dir) => {
    const input = scenario("itx-promotion");
    const output = path.join(dir, "output.txt");
    const { api } = fakeApi(input);
    await main(["decide", "--repository", REPOSITORY, "--head-sha", HEAD, "--run-conclusion", "success", "--run-id", String(RUN_ID), "--github-output", output], { api, log: () => {} });
    assert.equal(await readFile(output, "utf8"), `state=ELIGIBLE\npull_request=77\nhead_sha=${HEAD}\nstage=itx-promotion\nevidence_sha256=${input.ciEvidence.evidenceSha256}\ndraft=true\nlabeled=false\nattested=false\n`);

    const stale = path.join(dir, "stale.txt");
    await main(["decide", "--repository", REPOSITORY, "--head-sha", HEAD, "--run-conclusion", "cancelled", "--run-id", String(RUN_ID), "--github-output", stale], { api, log: () => {} });
    assert.equal(await readFile(stale, "utf8"), "state=STALE\npull_request=\nhead_sha=\nstage=\nevidence_sha256=\ndraft=false\nlabeled=false\nattested=false\n");
  });
});

// #986 리뷰 F1: 이미 한 일(attested)로 세는 기록도 코디네이터와 같은 기준이다. 편집된 기록·head 커밋보다 먼저 만든 기록은 없는 것으로 본다.
test("반증: 편집됐거나 head 커밋보다 먼저 만들어진 기록은 attested로 세지 않아 라벨러가 새 기록을 남긴다", async () => {
  const input = scenario();
  const attestedOf = async (comments) => (await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(input, { comments }).api })).attested;
  assert.equal(await attestedOf([attestationFor(input)]), true);
  assert.equal(await attestedOf([attestationFor(input, { updated_at: "2026-10-06T00:20:00Z" })]), false, "edited");
  assert.equal(await attestedOf([attestationFor(input, { created_at: "2026-10-05T23:59:59Z", updated_at: "2026-10-05T23:59:59Z" })]), false, "created before the head commit");
  assert.equal(await attestedOf([attestationFor(input, { created_at: HEAD_COMMITTED_AT, updated_at: HEAD_COMMITTED_AT })]), true, "same second");
  assert.equal(await attestedOf([attestationFor(input, { created_at: undefined, updated_at: undefined })]), false, "no timestamps");
  assert.equal(await attestedOf([attestationFor(input, { created_at: "garbage", updated_at: "garbage" })]), false, "bad timestamps");
  // 편집된 기록 옆에 올바른 기록이 있으면 인정한다.
  assert.equal(await attestedOf([attestationFor(input, { updated_at: "2026-10-06T00:20:00Z" }), attestationFor(input)]), true);
  // head 커밋을 PR 커밋 목록에서 찾지 못하면 기록 시각을 비교할 수 없으므로 없는 것으로 본다.
  const noHead = scenario();
  noHead.commits = [commit("1".repeat(40))];
  noHead.compare = { ...noHead.compare, ahead_by: 1 };
  const decision = await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(noHead, { comments: [attestationFor(noHead)] }).api });
  assert.equal(decision.attested, false);
});

// ---------------------------------------------------------------------------
// #986 리뷰 F3: CI가 본 증거 블록과 지금 본문의 블록이 같아야 한다(블록 digest 결속)
// ---------------------------------------------------------------------------
test("증거 digest는 본문 블록의 JSON 페이로드 텍스트의 sha256이고 블록이 없거나 둘 이상이면 실패한다", () => {
  const body = scenario().pull.body;
  const payload = /<!-- easysubway-automation-pr:v1 (.*?) -->/u.exec(body)[1];
  assert.equal(automationEvidenceDigest(body), createHash("sha256").update(payload).digest("hex"));
  assert.notEqual(automationEvidenceDigest(scenario("itx-promotion").pull.body), automationEvidenceDigest(body));
  for (const bad of ["", null, "블록 없음", `${body}\n${body}`]) assert.throws(() => automationEvidenceDigest(bad), /AUTOMATION_PR_EVIDENCE/u);
});

test("반증: CI가 기록한 digest가 없거나 현재 본문 블록과 다르면 막는다(CI 뒤 본문 편집)", () => {
  const mutations = {
    missing: (input) => { delete input.ciEvidence; },
    null: (input) => { input.ciEvidence = null; },
    "digest of another block": (input) => { input.ciEvidence = { ...input.ciEvidence, evidenceSha256: automationEvidenceDigest(scenario("itx-promotion").pull.body) }; },
    "body edited after CI": (input) => { input.pull.body = input.pull.body.replace("registration", "registration ").replace('"rowDelta":0', '"rowDelta":1'); },
    "other head": (input) => { input.ciEvidence = { ...input.ciEvidence, headSha: OTHER }; },
    "other stage": (input) => { input.ciEvidence = { ...input.ciEvidence, stage: "candidate-refresh" }; },
    "extra key": (input) => { input.ciEvidence = { ...input.ciEvidence, extra: true }; },
    "wrong schema": (input) => { input.ciEvidence = { ...input.ciEvidence, schemaVersion: 2 }; },
    "bad digest format": (input) => { input.ciEvidence = { ...input.ciEvidence, evidenceSha256: "ABC" }; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const input = scenario();
    mutate(input);
    assert.ok(codesOf(input).includes("DIGEST") || codesOf(input).includes("EVIDENCE"), name);
    assert.equal(eligible(input), false, name);
  }
  assert.equal(eligible(scenario()), true);
});

test("라벨러 판정: CI가 남긴 digest artifact를 읽어 대조하고 없거나 만료됐거나 둘 이상이면 막는다", async () => {
  const input = scenario();
  const decision = await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(input).api });
  assert.equal(decision.evidenceSha256, input.ciEvidence.evidenceSha256);
  for (const [name, artifacts] of Object.entries({
    none: [],
    expired: [{ id: 55, name: "automation-pr-evidence", expired: true }],
    duplicate: [{ id: 55, name: "automation-pr-evidence", expired: false }, { id: 56, name: "automation-pr-evidence", expired: false }],
    "other name": [{ id: 55, name: "other", expired: false }],
  })) {
    await assert.rejects(decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(input, { artifacts }).api }), /AUTOMATION_PR_DIGEST/u, name);
  }
  const edited = scenario();
  edited.pull.body = edited.pull.body.replace('"rowDelta":0', '"rowDelta":1');
  const stale = fakeApi(edited);
  const original = scenario();
  await assert.rejects(decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: async (path) => (path.endsWith("#evidence-digest.json") ? original.ciEvidence : stale.api(path)) }), /AUTOMATION_PR_DIGEST/u);
  await assert.rejects(decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: "x", api: fakeApi(input).api }), /AUTOMATION_PR_INPUT/u);
});

test("반증: 기록은 증거 digest까지 같아야 인정한다(다른 블록에 대한 기록 재사용)", async () => {
  const input = scenario();
  const withDigest = (digest) => ({ ...attestationFor(input), body: automationAttestationMarker(HEAD, digest) });
  const attestedOf = async (comments) => (await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(input, { comments }).api })).attested;
  assert.equal(await attestedOf([attestationFor(input)]), true);
  assert.equal(await attestedOf([withDigest("0".repeat(64))]), false);
  assert.equal(await attestedOf([{ ...attestationFor(input), body: `<!-- Automation automerge policy: ${HEAD} -->` }]), false, "old format without digest");
});

test("CLI gates: --digest-output으로 CI가 본 블록의 digest 기록을 남긴다", async () => {
  await withTemp(async (dir) => {
    const { writeEvidenceDigest } = await import("./automation-pr-policy.mjs");
    const input = scenario("itx-promotion");
    const file = path.join(dir, "evidence-digest.json");
    await writeEvidenceDigest({ file, pull: input.pull, evidence: { stage: "itx-promotion" } });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), input.ciEvidence);
  });
});

// #986 리뷰 F5: App이 만든 커밋은 GitHub 서명(verification.verified)을 요구한다. github-actions의 git push 커밋은 서명되지 않아 이 검사는 advisory다.
test("반증: App 신원의 커밋은 GitHub 서명이 검증돼야 하고, 서명되지 않은 App 신원은 위조로 보고 막는다", () => {
  const unsignedApp = { ...scenario(), commits: [commit("1".repeat(40), { author: AUTOMATION_PR_APP, committer: AUTOMATION_PR_APP }), commit(HEAD)] };
  assert.ok(codesOf(unsignedApp).includes("COMMITS"));
  const unsignedAppAuthor = { ...scenario(), commits: [commit("1".repeat(40), { author: AUTOMATION_PR_APP }), commit(HEAD)] };
  assert.ok(codesOf(unsignedAppAuthor).includes("COMMITS"));
  const unsignedAppCommitter = { ...scenario(), commits: [commit("1".repeat(40), { committer: AUTOMATION_PR_APP }), commit(HEAD)] };
  assert.ok(codesOf(unsignedAppCommitter).includes("COMMITS"));
  const signedApp = { ...scenario(), commits: [commit("1".repeat(40), { author: AUTOMATION_PR_APP, committer: AUTOMATION_PR_APP, verified: true }), commit(HEAD)] };
  assert.equal(eligible(signedApp), true);
  // github-actions 신원 커밋은 서명이 없다(실측: git push 커밋의 verification.verified가 false). 이 신원은 서명으로 검증할 수 없어 advisory로 둔다.
  assert.equal(eligible({ ...scenario(), commits: [commit("1".repeat(40)), commit(HEAD)] }), true);
  assert.equal(eligible({ ...scenario(), commits: [commit("1".repeat(40), { verified: true }), commit(HEAD)] }), true);
  for (const verification of [undefined, null, { verified: "true" }, { verified: 1 }]) {
    const odd = commit("1".repeat(40), { author: AUTOMATION_PR_APP, committer: AUTOMATION_PR_APP, verified: true });
    odd.commit.verification = verification;
    assert.ok(codesOf({ ...scenario(), commits: [odd, commit(HEAD)] }).includes("COMMITS"), String(JSON.stringify(verification)));
  }
});

// ---------------------------------------------------------------------------
// #986 리뷰 F6: 등록 단계의 원장 밖 파일
// ---------------------------------------------------------------------------
test("등록 단계 allowlist는 원장과 inventory 둘뿐이다. governance·신선도 SLA(product gate)는 사람 경로로 보낸다", () => {
  assert.deepEqual([...REGISTRATION_ALLOWED_PATHS].sort(), ["tools/datapack/release/source-snapshots.json", "tools/datapack/source-inventory.json"]);
  const input = scenario("registration");
  input.files = [...REGISTRATION_ALLOWED_PATHS, "tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json"].map((entry) => file(entry));
  assert.ok(codesOf(input).includes("PATHS"));
  for (const only of ["tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json"]) {
    input.files = [...REGISTRATION_ALLOWED_PATHS, only].map((entry) => file(entry));
    assert.ok(codesOf(input).includes("PATHS"), only);
  }
  // 어느 단계의 allowlist에도 product gate 경로는 없다(자동 병합이 product gate를 바꾸지 못한다).
  for (const stage of Object.keys(STAGES)) assert.ok(STAGES[stage].paths.every((entry) => !entry.startsWith("release/product-gates/")), stage);
});

test("등록 inventory는 등록한 원천의 항목만 바뀔 수 있다(원장 밖 파일의 범위 재계산)", async () => {
  assert.deepEqual((await recomputeAutomationGates(gateInput("registration"))).violations, []);
  const rewrite = (mutate) => { const head = structuredClone(INVENTORY_HEAD); mutate(head); return head; };
  const cases = {
    "other source changed": rewrite((head) => { head.sources[0].value = 9; }),
    "other source removed": rewrite((head) => { head.sources.shift(); }),
    "other source added": rewrite((head) => { head.sources.push({ id: "new-source", value: 1 }); }),
    "registered source missing": rewrite((head) => { head.sources.pop(); }),
    "registered source duplicated": rewrite((head) => { head.sources.push({ ...CAPITAL_ENTRY, retrievedAt: "2026-10-07" }); }),
    "top-level key changed": rewrite((head) => { head.region = "other"; }),
    "top-level key added": rewrite((head) => { head.extra = true; }),
  };
  for (const [name, inventory] of Object.entries(cases)) assert.ok((await gateCodes(gateInput("registration", { inventory }))).includes("INVENTORY_GATE"), name);
  // 등록 단계는 이미 등록된 원천의 재등록이다. 항목이 새로 생기는 첫 등록은 정책 파일도 바뀌므로 자동 병합 대상이 아니다(#989, #987 N1과 같은 규칙).
  const first = { ...INVENTORY_BASE, sources: [INVENTORY_BASE.sources[0]] };
  assert.ok((await gateCodes(gateInput("registration", { inventoryBase: first }))).includes("INVENTORY_GATE"));
  const broken = gateInput("registration");
  broken.files.readTree = async (relative) => { if (relative === INVENTORY_PATH) throw new Error("ENOENT"); return JSON.stringify(relative.endsWith("source-snapshots.json") ? HEAD_LEDGER : POLICY); };
  assert.ok((await recomputeAutomationGates(broken)).violations.some(({ code }) => code === "INVENTORY_GATE"));
  // 다른 단계는 inventory를 읽지 않는다(재결속 단계의 inventory 변경은 단계 allowlist와 원장 게이트가 본다).
  const noInventory = gateInput("derivative-rebinding", { ledger: BASE_LEDGER });
  noInventory.files.readTree = async (relative) => { assert.notEqual(relative, INVENTORY_PATH); return JSON.stringify(relative.endsWith("source-snapshots.json") ? BASE_LEDGER : POLICY); };
  assert.deepEqual((await recomputeAutomationGates(noInventory)).violations, []);
});

// #989: 등록 단계도 원천 재확인(#987 N1)처럼 소유 항목 안에서 등록기가 갱신하는 필드만 바뀔 수 있다.
test("등록 inventory는 등록한 원천 항목 안에서도 등록기가 갱신하는 필드만 바뀔 수 있다(정책성 필드는 고정)", async () => {
  assert.deepEqual([...REGISTRATION_INVENTORY_FIELDS["capital-route-topology"]].sort(), ["capitalTopologyAdmissionEvidence", "observedDataUpdatedAt", "retrievedAt"]);
  const tamper = (mutate) => { const head = structuredClone(INVENTORY_HEAD); mutate(head.sources[1]); return head; };
  const cases = {
    "productionUseAllowed flipped": tamper((entry) => { entry.productionUseAllowed = false; }),
    "datasetUrl changed": tamper((entry) => { entry.datasetUrl = "https://evil.test"; }),
    "license added": tamper((entry) => { entry.license = { type: "OTHER" }; }),
    "field removed": tamper((entry) => { delete entry.datasetUrl; }),
  };
  for (const [name, inventory] of Object.entries(cases)) {
    const codes = await gateCodes(gateInput("registration", { inventory }));
    assert.ok(codes.includes("INVENTORY_GATE"), name);
  }
  // 갱신 필드만 바뀐 정상 diff는 통과한다.
  assert.deepEqual((await recomputeAutomationGates(gateInput("registration"))).violations, []);
});

// #989 리뷰 F2: 필드표에 없는 원천은 모든 필드가 고정이다(빈 기본값). 표에 이름이 없는 원천을 등록 증거가 주장해도 그 항목의 어떤 필드도 바뀔 수 없다.
test("반증: 등록 필드표에 없는 원천은 어떤 필드도 바뀔 수 없다(기본값은 빈 집합)", async () => {
  assert.equal(Object.hasOwn(REGISTRATION_INVENTORY_FIELDS, "other-source"), false);
  const unlistedRow = { ...EXPECTED_SOURCE, sourceId: "other-source" };
  const inputWith = (mutate) => {
    const head = structuredClone(INVENTORY_HEAD);
    mutate(head.sources[0]);
    return gateInput("registration", { inventory: head, evidenceOverrides: { sources: [unlistedRow] } });
  };
  // 표에 있는 다른 원천의 갱신 필드와 정책성 필드를 모두 시험해 어떤 비어 있지 않은 기본값도 걸리게 한다.
  const mutations = {
    retrievedAt: (entry) => { entry.retrievedAt = "2026-10-06"; },
    observedDataUpdatedAt: (entry) => { entry.observedDataUpdatedAt = "2026-10-06"; },
    capitalTopologyAdmissionEvidence: (entry) => { entry.capitalTopologyAdmissionEvidence = { snapshotId: "b" }; },
    datasetUrl: (entry) => { entry.datasetUrl = "https://evil.test"; },
    productionUseAllowed: (entry) => { entry.productionUseAllowed = false; },
    value: (entry) => { entry.value = 2; },
  };
  for (const [field, mutate] of Object.entries(mutations)) {
    const violations = (await recomputeAutomationGates(inputWith(mutate))).violations.filter(({ code }) => code === "INVENTORY_GATE");
    assert.equal(violations.length, 1, field);
    assert.match(violations[0].detail, new RegExp(`other-source: .*${field}`, "u"), field);
  }
});

// #989: 기록된 실제 등록 커밋(seq127 #940의 6741d1b89, seq128 #976의 8a7b4c1ba)이 ground truth다. fixture는 git show로 읽은 base·head의
// 원장 행과 inventory 항목, 변경 파일 목록이고, 두 커밋 모두 원장·inventory 두 파일만 바꿨다(governance·SLA는 바뀌지 않았다).
const RECORDED = JSON.parse(await readFile(new URL("../datapack/test-fixtures/registration-recorded-commits.json", import.meta.url), "utf8")).commits;
const LEDGER_PATH_RECORDED = "tools/datapack/release/source-snapshots.json";

function recordedEntries(commit) {
  const after = commit.inventory.ownedEntryAfter;
  const before = { ...after, ...commit.inventory.changedFieldsBefore };
  const stubs = commit.inventory.unownedEntryIds.map((id) => ({ id }));
  return { before, after, stubs };
}

function recordedGateInput(commit, { mutateHead = (entry) => entry, files: extraFiles = {} } = {}) {
  const { before, after, stubs } = recordedEntries(commit);
  const inventory = (entry) => ({ ...commit.inventory.top, sources: [...stubs, entry] });
  const realPolicy = readFile(new URL("./source-ledger-change-policy.json", import.meta.url), "utf8");
  const evidence = {
    schemaVersion: 1, issue: 969, runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, ...STAGES.registration.evidence, sources: commit.gateSources,
  };
  return {
    evidence,
    repositoryRoot: "/repo",
    files: {
      readTree: async (relative) => {
        if (relative === LEDGER_PATH_RECORDED) return JSON.stringify(commit.ledger.head);
        if (relative === INVENTORY_PATH) return JSON.stringify(inventory(mutateHead(structuredClone(after))));
        if (relative === "tools/ci/source-ledger-change-policy.json") return realPolicy;
        throw new Error(`missing ${relative}`);
      },
      readBase: async (sha, relative) => {
        assert.equal(sha, BASE);
        if (relative === LEDGER_PATH_RECORDED) return JSON.stringify(commit.ledger.base);
        assert.equal(relative, INVENTORY_PATH);
        return JSON.stringify(inventory(before));
      },
      ...extraFiles,
    },
  };
}

function recordedScenario(commit, { extraFiles = [] } = {}) {
  const base = scenario("registration");
  const body = `자동화 PR\n\n${automationPrEvidenceBlock({ ...STAGES.registration.evidence, sources: commit.gateSources, runUrl: RUN_URL, baseSha: BASE, headSha: HEAD })}\n`;
  return {
    ...base,
    pull: { ...base.pull, body },
    files: [...commit.files, ...extraFiles].map(({ filename, status }) => file(filename, { status })),
    ciEvidence: { ...base.ciEvidence, evidenceSha256: automationEvidenceDigest(body) },
  };
}

test("기록된 실제 등록 커밋(seq127·seq128)은 경로 검사와 게이트 재계산을 모두 통과해 적격이다", async () => {
  assert.deepEqual(RECORDED.map(({ label }) => label), ["seq127", "seq128"]);
  for (const commit of RECORDED) {
    assert.deepEqual(commit.files.map(({ filename }) => filename).sort(), [...REGISTRATION_ALLOWED_PATHS].sort(), `${commit.label} changed only the ledger and inventory`);
    assert.deepEqual(Object.keys(commit.inventory.changedFieldsBefore).sort(), [...REGISTRATION_INVENTORY_FIELDS["capital-route-topology"]].sort(), `${commit.label} changed exactly the registrar's refresh fields`);
    const result = evaluateAutomationPullRequest(recordedScenario(commit));
    assert.deepEqual(result.violations, [], commit.label);
    assert.equal(result.eligible, true, commit.label);
    assert.deepEqual((await recomputeAutomationGates(recordedGateInput(commit))).violations, [], commit.label);
  }
});

test("반증: 기록된 등록 diff에 governance·신선도 SLA 변경이 더해지면 PATHS로 막는다(허용 목록은 넓히지 않는다)", () => {
  for (const commit of RECORDED) {
    for (const extra of ["tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json"]) {
      const input = recordedScenario(commit, { extraFiles: [{ filename: extra, status: "modified" }] });
      assert.equal(eligible(input), false, `${commit.label} + ${extra}`);
      assert.ok(codesOf(input).includes("PATHS"), `${commit.label} + ${extra}`);
    }
  }
});

test("반증: 기록된 등록 diff에서 정책성 inventory 필드를 바꾸거나 소유 밖 항목을 바꾸면 게이트가 막는다", async () => {
  for (const commit of RECORDED) {
    const policyField = recordedGateInput(commit, { mutateHead: (entry) => ({ ...entry, productionUseAllowed: !entry.productionUseAllowed }) });
    assert.ok((await gateCodes(policyField)).includes("INVENTORY_GATE"), `${commit.label} productionUseAllowed`);
    const license = recordedGateInput(commit, { mutateHead: (entry) => ({ ...entry, license: { ...entry.license, type: "OTHER" } }) });
    assert.ok((await gateCodes(license)).includes("INVENTORY_GATE"), `${commit.label} license`);
    const unowned = recordedGateInput(commit);
    const readTree = unowned.files.readTree;
    unowned.files.readTree = async (relative) => {
      const text = await readTree(relative);
      if (relative !== INVENTORY_PATH) return text;
      const head = JSON.parse(text);
      head.sources[0].datasetUrl = "https://evil.test";
      return JSON.stringify(head);
    };
    assert.ok((await gateCodes(unowned)).includes("INVENTORY_GATE"), `${commit.label} unowned entry`);
  }
});

// #986 리뷰 F2: 뒤처진 자동화 PR은 라벨러가 이상으로 세지 않는다. 닫고 다시 만드는 일은 recreate workflow의 몫이고 라벨러는 아무것도 쓰지 않는다.
test("라벨러 판정: 뒤처진 것만이 위반이면 BEHIND 상태로 물러나고, 다른 위반이 함께 있으면 여전히 실패한다", async () => {
  const input = scenario();
  input.compare = { ...input.compare, behind_by: 2 };
  const decision = await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(input).api });
  assert.deepEqual(decision, { state: "BEHIND" });
  input.pull.user = HUMAN;
  await assert.rejects(decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(input).api }), /AUTOMATION_PR_AUTHOR[\s\S]*AUTOMATION_PR_BEHIND/u);
  const diverged = scenario();
  diverged.compare = { ...diverged.compare, status: "diverged", behind_by: 1 };
  assert.deepEqual(await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(diverged).api }), { state: "BEHIND" });
});

// ---------------------------------------------------------------------------
// #1012: 정기 갱신 4종 단계(광주 보관 시간표·수도권 topology·KRIC 시설·서울 접근성).
// 기록된 실제 갱신 PR(#937·#965·#1003·#1009·#1010·#1011)의 변경 파일·원장·inventory로 정책을 시험한다.
// ---------------------------------------------------------------------------
const refreshBranch = (stage) => `${REFRESH_CLAIM_PREFIXES[REFRESH_STAGES[stage].workflow]}9100`;
const REFRESH_POLICY_PATH = "tools/ci/source-ledger-change-policy.json";

const refreshFilesOf = (trees, { policy = POLICY } = {}) => ({
  readTree: async (relative) => {
    if (relative === REFRESH_POLICY_PATH) return JSON.stringify(policy);
    if (!trees.head.has(relative)) throw new Error(`missing ${relative}`);
    return trees.head.get(relative);
  },
  readBase: async (_sha, relative) => {
    if (!trees.base.has(relative)) throw new Error(`missing base ${relative}`);
    return trees.base.get(relative);
  },
});

/** 기록된 실행 하나의 정상 입력. 반증은 여기서 정확히 한 가지만 바꾼다. */
async function refreshScenario(run, { mutateTrees = {}, mutateValue = (value) => value, extraFiles = [], files, body } = {}) {
  const trees = recorded.recordedTrees(run, mutateTrees);
  const paths = recorded.filenames(run);
  const { rows, violations } = await evaluateRefreshStage({ stage: run.stage, paths, baseSha: run.baseSha, policy: POLICY, files: refreshFilesOf(trees) });
  assert.deepEqual(violations, [], run.label);
  const generated = refreshEvidenceBlock({ stage: run.stage, runUrl: RUN_URL, baseSha: run.baseSha, headSha: HEAD, policy: POLICY, sources: rows, paths });
  const value = JSON.parse(generated.slice("<!-- easysubway-automation-pr:v1 ".length, -" -->".length));
  const text = body ?? `갱신 PR\n\n<!-- easysubway-automation-pr:v1 ${JSON.stringify(mutateValue(value))} -->\n`;
  const base = scenario("registration");
  return {
    ...base,
    trees,
    pull: { ...base.pull, body: text, head: { ...base.pull.head, ref: refreshBranch(run.stage) } },
    files: [...(files ?? run.files).map(({ filename, status, ...rest }) => file(filename, { status, ...rest })), ...extraFiles],
    compare: { ...base.compare, merge_base_commit: { sha: run.baseSha } },
    ciEvidence: { ...base.ciEvidence, stage: run.stage, evidenceSha256: body === undefined ? automationEvidenceDigest(text) : DIGEST },
  };
}

const refreshGateInput = (input, options) => {
  const evidence = parseAutomationPrEvidence(input.pull.body, { headSha: HEAD });
  return { evidence, repositoryRoot: "/repo", files: refreshFilesOf(input.trees, options) };
};

test("갱신 4종 브랜치는 각자 단계로 분류되고 workflow 표에 단계마다 있다. 기존 다섯 단계의 매핑은 그대로다", () => {
  assert.deepEqual(Object.keys(AUTOMATION_STAGE_WORKFLOWS).slice(0, 5), ["registration", "derivative-rebinding", "candidate-refresh", "itx-promotion", "source-reverification"]);
  assert.deepEqual(Object.values(AUTOMATION_STAGE_WORKFLOWS).slice(0, 5), [
    "current-capital-topology-registration.yml", "source-derivative-rebinding.yml", "nationwide-candidate-refresh.yml", "itx-current-promotion.yml", "source-reverification.yml",
  ]);
  assert.deepEqual(Object.keys(AUTOMATION_STAGE_WORKFLOWS).slice(5), [...REFRESH_STAGE_IDS]);
  for (const stage of REFRESH_STAGE_IDS) {
    assert.equal(AUTOMATION_STAGE_WORKFLOWS[stage], REFRESH_STAGES[stage].workflow, stage);
    assert.equal(automationStageForBranch(refreshBranch(stage)), stage, stage);
    const prefix = refreshBranch(stage).slice(0, -"9100".length);
    for (const bad of [`${prefix}`, `${prefix}0`, `${prefix}12a`, `${prefix}-1`, `${prefix}1/2`, `${prefix.slice(0, -1)}9100`]) assert.equal(automationStageForBranch(bad), null, bad);
  }
  assert.equal(new Set(Object.values(AUTOMATION_STAGE_WORKFLOWS)).size, 9, "workflow가 단계마다 하나씩이다");
});

test("기록된 실제 갱신 PR 여섯 건은 경로·게이트 재계산·라벨러 판정을 모두 통과해 적격이다", async () => {
  for (const run of recorded.RECORDED) {
    const input = await refreshScenario(run);
    const result = evaluateAutomationPullRequest(input);
    assert.deepEqual(result.violations, [], run.label);
    assert.equal(result.eligible, true, run.label);
    assert.equal(result.stage, run.stage, run.label);
    assert.deepEqual((await recomputeAutomationGates(refreshGateInput(input))).violations, [], run.label);
    const decision = await decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(input).api });
    assert.equal(decision.state, "ELIGIBLE", run.label);
    assert.equal(decision.stage, run.stage, run.label);
  }
});

test("반증: API diff에 추가 경로(.github·tools 코드·governance·SLA·후보 산출물)가 있으면 PATHS로 막는다", async () => {
  const extras = [
    ".github/workflows/ci.yml", "tools/ci/automation-pr-policy.mjs", "tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json",
    "tools/ci/source-ledger-change-policy.json", "tools/datapack/release/release-request.json",
  ];
  for (const run of recorded.RECORDED) {
    for (const extra of extras) {
      for (const status of ["modified", "added"]) {
        const input = await refreshScenario(run, { extraFiles: [file(extra, { status })] });
        assert.equal(eligible(input), false, `${run.label} + ${extra}`);
        assert.ok(codesOf(input).includes("PATHS"), `${run.label} + ${extra}`);
      }
    }
  }
});

test("반증: 주장한 경로와 API diff가 정확히 같지 않거나 경로 종류(added·modified)가 규칙과 다르면 PATHS", async () => {
  for (const run of recorded.RECORDED) {
    const missing = await refreshScenario(run, { files: run.files.slice(1) });
    assert.ok(codesOf(missing).includes("PATHS"), `${run.label}: API diff에 빠진 경로`);
    for (const [index, entry] of run.files.entries()) {
      const flipped = run.files.map((item, at) => (at === index ? { ...item, status: entry.status === "added" ? "modified" : "added" } : item));
      const input = await refreshScenario(run, { files: flipped });
      assert.ok(codesOf(input).includes("PATHS"), `${run.label} ${entry.filename}: 변경 종류`);
      const renamed = await refreshScenario(run, { files: run.files.map((item, at) => (at === index ? { ...item, status: "renamed", previous_filename: "tools/datapack/sources/old.json" } : item)) });
      assert.ok(codesOf(renamed).includes("PATHS"), `${run.label} ${entry.filename}: 이름 변경`);
    }
    const wide = await refreshScenario(run, { files: [...run.files, { filename: "tools/datapack/sources/another-20261007.json", status: "added" }] });
    assert.ok(codesOf(wide).includes("PATHS"), `${run.label}: API diff가 주장보다 넓다`);
    // 규칙에는 맞지만 증거가 주장한 경로와 다른 새 파일(날짜·snapshot id가 다르다)은 정확 대조에서 막힌다.
    const swapped = run.files.find(({ status, filename }) => status === "added" && !filename.includes("capital-"));
    if (swapped !== undefined) {
      const renamedTo = swapped.filename.replace(/(\d{8})(T\d{9}Z)?\.json$/u, (_, day, rest = "") => `${day === "20990101" ? "20990102" : "20990101"}${rest}.json`);
      const diverged = await refreshScenario(run, { files: run.files.map((item) => (item === swapped ? { ...item, filename: renamedTo } : item)) });
      assert.ok(codesOf(diverged).includes("PATHS"), `${run.label}: 같은 규칙의 다른 경로`);
      assert.match(evaluateAutomationPullRequest(diverged).violations.find(({ code }) => code === "PATHS").detail, /허용 밖 경로|빠진 경로/u, run.label);
    }
    // 5000개 같은 상한에 닿은 목록은 전체를 알 수 없어 막는다(기존 단계와 같은 규칙).
    const capped = await refreshScenario(run, { extraFiles: Array.from({ length: 3000 }, (_, index) => file(`tools/datapack/sources/x-${index}.json`, { status: "added" })) });
    assert.ok(codesOf(capped).includes("PATHS"), `${run.label}: 목록 상한`);
  }
});

test("반증: 정책성 inventory 필드를 바꾸거나 소유하지 않은 항목을 바꾸면 게이트 재계산이 INVENTORY_GATE로 막는다", async () => {
  for (const run of recorded.RECORDED) {
    const owned = run.inventory.changed[0].id;
    const unowned = run.inventory.unownedEntryIds[0];
    const policyField = await refreshScenario(run, { mutateTrees: { mutateInventory: (inventory) => { inventory.sources.find(({ id }) => id === owned).productionUseAllowed = false; } } }).catch((error) => error);
    // 정상 입력 생성(refreshScenario)은 재계산을 통과해야 하므로, 변조는 증거 생성 뒤 트리에만 가한다.
    assert.ok(policyField instanceof Error, `${run.label}: 변조된 트리로는 증거를 만들 수 없다`);
    const input = await refreshScenario(run);
    const gates = refreshGateInput(input);
    const mutateHead = (edit) => {
      const original = input.trees.head.get(recorded.INVENTORY_PATH);
      const inventory = JSON.parse(original);
      edit(inventory);
      input.trees.head.set(recorded.INVENTORY_PATH, JSON.stringify(inventory));
      return () => input.trees.head.set(recorded.INVENTORY_PATH, original);
    };
    const restore = mutateHead((inventory) => { inventory.sources.find(({ id }) => id === owned).productionUseAllowed = false; });
    const policy = await recomputeAutomationGates(gates);
    restore();
    assert.ok(policy.violations.some(({ code }) => code === "INVENTORY_GATE"), `${run.label}: 소유 항목의 정책성 필드`);
    const restoreUnowned = mutateHead((inventory) => { inventory.sources.find(({ id }) => id === unowned).datasetUrl = "https://evil.test/x"; });
    const unownedResult = await recomputeAutomationGates(gates);
    restoreUnowned();
    assert.ok(unownedResult.violations.some(({ code, detail }) => code === "INVENTORY_GATE" && /not owned/u.test(detail)), `${run.label}: 소유하지 않은 항목`);
    assert.deepEqual((await recomputeAutomationGates(gates)).violations, [], `${run.label}: 복원 뒤 대조군`);
  }
});

test("반증: 증거 블록의 원천 행·정책이 재계산한 값과 다르면 EVIDENCE_DRIFT, 트리의 정책 파일이 다르면 막는다", async () => {
  for (const run of recorded.RECORDED) {
    const forgedRow = await refreshScenario(run, { mutateValue: (value) => ({ ...value, sources: value.sources.map((entry, index) => (index === 0 ? { ...entry, rawSha256: "0".repeat(64) } : entry)) }) });
    assert.ok((await recomputeAutomationGates(refreshGateInput(forgedRow))).violations.some(({ code }) => code === "EVIDENCE_DRIFT"), `${run.label}: 위조된 행`);
    const forgedDelta = await refreshScenario(run, { mutateValue: (value) => ({ ...value, sources: value.sources.map((entry) => ({ ...entry, rowDelta: entry.rowDelta + 1 })) }) });
    assert.ok((await recomputeAutomationGates(refreshGateInput(forgedDelta))).violations.some(({ code }) => code === "EVIDENCE_DRIFT"), `${run.label}: 위조된 delta`);
    const loosePolicy = await refreshScenario(run, { mutateValue: (value) => ({ ...value, policy: { ...value.policy, maxRowDeltaRatio: 1 } }) });
    assert.ok((await recomputeAutomationGates(refreshGateInput(loosePolicy))).violations.some(({ code }) => code === "EVIDENCE_DRIFT"), `${run.label}: 느슨해진 정책 주장`);
    const input = await refreshScenario(run);
    const tighter = await recomputeAutomationGates(refreshGateInput(input, { policy: { ...POLICY, maxRowDeltaRatio: 0.5 } }));
    assert.ok(tighter.violations.some(({ code }) => code === "EVIDENCE_DRIFT"), `${run.label}: 트리의 정책 파일이 증거와 다르다`);
    const broken = await recomputeAutomationGates(refreshGateInput(input, { policy: { schemaVersion: 1 } }));
    assert.ok(broken.violations.length > 0, `${run.label}: 정책 파일이 잘못됐다`);
  }
});

test("반증: 위조된 head·digest·base·단계·증거 블록은 각자의 위반 코드로 막힌다", async () => {
  for (const run of recorded.RECORDED) {
    const good = await refreshScenario(run);
    const other = recorded.RECORDED.find(({ stage }) => stage !== run.stage);
    // 위조된 head: 블록의 head가 PR head와 다르다.
    const forgedHead = structuredClone(good);
    forgedHead.pull.head.sha = OTHER;
    assert.ok(codesOf(forgedHead).includes("HEAD_MISMATCH"), `${run.label}: 위조된 head`);
    // 위조된 base: 블록의 base가 실제 분기점과 다르다.
    const forgedBase = structuredClone(good);
    forgedBase.compare.merge_base_commit.sha = OTHER;
    assert.ok(codesOf(forgedBase).includes("BASE"), `${run.label}: 위조된 base`);
    // 증거 블록을 CI 뒤에 고쳐 쓰면 digest가 어긋난다(블록 밖 본문 편집은 정책이 보지 않는다).
    const edited = structuredClone(good);
    edited.pull.body = edited.pull.body.replace("actions/runs/123456", "actions/runs/123457");
    assert.notEqual(edited.pull.body, good.pull.body);
    assert.ok(codesOf(edited).includes("DIGEST"), `${run.label}: 증거 블록 편집`);
    // 다른 단계의 증거를 이 단계 브랜치에 붙였다.
    const crossed = await refreshScenario(other);
    const wrongBranch = structuredClone(good);
    wrongBranch.pull.body = crossed.pull.body.replace(new RegExp(`"headSha":"${HEAD}"`, "u"), `"headSha":"${HEAD}"`);
    wrongBranch.ciEvidence = { ...wrongBranch.ciEvidence, stage: other.stage, evidenceSha256: automationEvidenceDigest(wrongBranch.pull.body) };
    assert.ok(codesOf(wrongBranch).includes("BRANCH"), `${run.label}: 다른 단계의 증거`);
    // 증거 블록이 없거나(이 변경 이전 형식의 본문) 둘이다.
    const legacy = await refreshScenario(run, { body: "Refresh the due snapshot through the current OCI operation.\n\nRefs #629, #39, #29" });
    assert.deepEqual(codesOf(legacy).filter((code) => code === "EVIDENCE"), ["EVIDENCE"], `${run.label}: 증거 없는 본문`);
    assert.equal(eligible(legacy), false, `${run.label}: 증거 없는 본문`);
    const block = good.pull.body.match(/<!-- easysubway-automation-pr:v1 .* -->/u)[0];
    const doubled = await refreshScenario(run, { body: `${block}\n${block}` });
    assert.equal(eligible(doubled), false, `${run.label}: 블록 둘`);
    // 작성자·커밋·CI 규칙은 기존 단계와 같다.
    const human = structuredClone(good);
    human.pull.user = HUMAN;
    assert.ok(codesOf(human).includes("AUTHOR"), `${run.label}: 사람 작성 PR`);
    const behind = structuredClone(good);
    behind.compare = { ...behind.compare, behind_by: 1 };
    assert.ok(codesOf(behind).includes("BEHIND"), `${run.label}: 뒤처짐`);
    const gatesFailed = structuredClone(good);
    gatesFailed.checkRuns = gatesFailed.checkRuns.filter(({ name }) => name !== AUTOMATION_PR_GATES_CONTEXT);
    assert.ok(codesOf(gatesFailed).includes("GATES"), `${run.label}: 게이트 check 없음`);
  }
});

test("라벨러 판정: 증거 없는 이전 형식의 갱신 PR은 이상으로 막고(예외) 아무것도 쓰지 않는다", async () => {
  const run = recorded.RECORDED.find(({ stage }) => stage === "kric-facility-refresh");
  const legacy = await refreshScenario(run, { body: "Refresh the due KRIC facility snapshot through the current OCI operation.\n\nRefs #629, #39, #29" });
  await assert.rejects(decideAutomationPullRequest({ repository: REPOSITORY, headSha: HEAD, runConclusion: "success", runId: RUN_ID, api: fakeApi(legacy).api }), /AUTOMATION_PR_EVIDENCE/u);
});

test("CLI prepare: 갱신 PR은 대상이고 증거의 base sha를 내보낸다. 증거 단계와 브랜치 단계가 다르면 실패한다", async () => {
  const run = recorded.RECORDED.find(({ stage }) => stage === "capital-topology-refresh");
  const input = await refreshScenario(run);
  await withTemp(async (dir) => {
    const pullFile = path.join(dir, "pull.json");
    const output = path.join(dir, "out.txt");
    await writeFile(pullFile, JSON.stringify(input.pull));
    await main(["prepare", "--pull-request", pullFile, "--github-output", output]);
    assert.equal(await readFile(output, "utf8"), `applicable=true\nbase_sha=${run.baseSha}\n`);
    const crossed = { ...input.pull, head: { ...input.pull.head, ref: refreshBranch("seoul-accessibility-refresh") } };
    await writeFile(pullFile, JSON.stringify(crossed));
    await assert.rejects(main(["prepare", "--pull-request", pullFile, "--github-output", path.join(dir, "out2.txt")]), /AUTOMATION_PR_BRANCH/u);
  });
});
