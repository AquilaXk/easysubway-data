import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { automationPrEvidenceBlock, itxPromotionAllowedPaths } from "./automation-pr-evidence.mjs";
import {
  AUTOMATION_PR_APP,
  AUTOMATION_PR_GATES_CONTEXT,
  REGISTRATION_ALLOWED_PATHS,
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

const STAGES = {
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
const commit = (sha, { author = ACTIONS_BOT, committer = ACTIONS_BOT, parents = 1, committedAt = HEAD_COMMITTED_AT } = {}) => ({ sha, author, committer, commit: { committer: { date: committedAt } }, parents: Array.from({ length: parents }, (_, index) => ({ sha: `${index}`.repeat(40) })) });
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
    files: paths.map((filename) => file(filename)),
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

test("claim 접두사는 네 단계에만 대응하고 그 밖의 브랜치는 정책 대상이 아니다", () => {
  for (const [stage, { branch }] of Object.entries(STAGES)) assert.equal(automationStageForBranch(branch), stage);
  for (const branch of [
    "feature/x", "automation/636-current-topology-refresh-1", "automation/456-capital-topology-registration-", "automation/456-capital-topology-registration-0",
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
  const mixed = { ...scenario(), commits: [commit("1".repeat(40), { author: AUTOMATION_PR_APP, committer: ACTIONS_BOT }), commit("2".repeat(40))] };
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

function gateInput(stage, { ledger = HEAD_LEDGER, evidenceOverrides = {}, contract, receipt, verifyItx, candidate, policy = POLICY, extraTree = {} } = {}) {
  const evidence = {
    schemaVersion: 1, issue: 969, runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, ...STAGES[stage].evidence,
    ...(stage === "registration" ? { sources: [EXPECTED_SOURCE] } : {}), ...evidenceOverrides,
  };
  const tree = {
    "tools/datapack/release/source-snapshots.json": JSON.stringify(ledger),
    "tools/ci/source-ledger-change-policy.json": JSON.stringify(policy),
    ...(contract === undefined ? {} : { "tools/datapack/itx-cheongchun-coverage-contract.json": JSON.stringify(contract) }),
    ...(receipt === undefined ? {} : { [`tools/datapack/sources/${ITX_ID}-promotion-gate.json`]: JSON.stringify(receipt) }),
    ...extraTree,
  };
  return {
    evidence,
    repositoryRoot: "/repo",
    files: {
      readTree: async (relative) => { if (!Object.hasOwn(tree, relative)) throw new Error(`missing ${relative}`); return tree[relative]; },
      readBase: async (sha, relative) => { assert.equal(sha, BASE); assert.equal(relative, "tools/datapack/release/source-snapshots.json"); return JSON.stringify(BASE_LEDGER); },
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
  other.pull.head.ref = "automation/636-current-topology-refresh-1";
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

    const other = { ...input.pull, head: { ...input.pull.head, ref: "automation/636-current-topology-refresh-1" } };
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
