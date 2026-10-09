import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RELEASE_CANDIDATE_PATHS,
  planNationwideCandidateRefresh,
  readProductionPublishModeArgs,
  readReleaseCandidateModeArgs,
  runPlanDatapackReleaseChain,
} from "./plan-datapack-release-chain.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const committedSpec = { productionScopeId: "nationwide_routing_android_v1", releaseSequence: 126 };
const now = new Date("2026-10-04T04:31:38.280Z");

function workflowText(file) {
  return readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
}

function stepBody(yml, name) {
  const start = yml.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = yml.indexOf("\n      - name: ", start + 1);
  return yml.slice(start, end === -1 ? yml.length : end);
}

// workflow run 블록을 그대로 꺼내 실제 bash로 실행한다(문자열 일치가 아니라 동작을 검증).
function stepScript(yml, name) {
  const body = stepBody(yml, name);
  const marker = "\n        run: |\n";
  const begin = body.indexOf(marker);
  assert.notEqual(begin, -1, `step has no run block: ${name}`);
  return body.slice(begin + marker.length).split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
}

function runStep(yml, name, { cwd, env = {} }) {
  return spawnSync("/bin/bash", ["-e", "-c", stepScript(yml, name)], {
    cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}

function git(cwd, ...args) {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function gitRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-chain-git-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "test");
  git(root, "config", "user.email", "test@example.invalid");
  return root;
}

async function releaseRepository(mutate = (files) => files, { candidateId = "nationwide-candidate-20261004-seq127", releaseSequence = 127 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-chain-"));
  const spec = {
    candidateId,
    productionScopeId: "nationwide_routing_android_v1",
    releaseSequence,
    publishedAt: "2026-10-04T22:23:31.456Z",
    builderGitSha: "a".repeat(40),
    sourceSnapshotSetHash: "a".repeat(64),
    approvedAliasLedgerHash: "b".repeat(64),
  };
  const specBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
  const request = {
    schemaVersion: 1,
    artifactKind: "datapack-release-request",
    candidateId: spec.candidateId,
    scopeId: spec.productionScopeId,
    buildSpecSha256: sha256(specBytes),
    sourceSnapshotSetHash: spec.sourceSnapshotSetHash,
    approvedLedgerHash: spec.approvedAliasLedgerHash,
    requestedBy: "data-operator-lead",
    approvedBy: "data-release-authority",
    approvalId: `release-request-${spec.candidateId}`,
    targetChannel: "production",
  };
  const files = mutate({
    [RELEASE_CANDIDATE_PATHS.buildSpecPath]: specBytes,
    [RELEASE_CANDIDATE_PATHS.releaseRequestPath]: Buffer.from(`${JSON.stringify(request, null, 2)}\n`),
    [RELEASE_CANDIDATE_PATHS.androidEvidencePath]: Buffer.from("{}\n"),
    [RELEASE_CANDIDATE_PATHS.strictRouteRegressionPath]: Buffer.from("{}\n"),
  });
  for (const [relative, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), bytes);
  }
  return { root, spec, request };
}

test("candidate refresh plan uses the run clock and explicit distinct roles (#927)", () => {
  assert.deepEqual(planNationwideCandidateRefresh({
    releaseSequence: "127", requestedBy: "data-operator-lead", approvedBy: "data-release-authority", committedBuildSpec: committedSpec, now, event: "workflow_dispatch",
  }), {
    evaluatedAt: "2026-10-04T04:31:38.280Z",
    releaseSequence: 127,
    requestedBy: "data-operator-lead",
    approvedBy: "data-release-authority",
  });
});

test("candidate refresh plan rejects a sequence that does not advance the committed candidate", () => {
  for (const releaseSequence of ["126", "125", "0", "-1", "127.0", "1e3", "", " 127"]) {
    assert.throws(() => planNationwideCandidateRefresh({
      releaseSequence, requestedBy: "a", approvedBy: "b", committedBuildSpec: committedSpec, now, event: "workflow_dispatch",
    }), /CANDIDATE_REFRESH_RELEASE_SEQUENCE/u, releaseSequence);
  }
});

test("candidate refresh plan keeps the two-person rule and rejects unsafe role tokens", () => {
  assert.throws(() => planNationwideCandidateRefresh({
    releaseSequence: "127", requestedBy: "Data-Lead", approvedBy: "data-lead", committedBuildSpec: committedSpec, now, event: "workflow_dispatch",
  }), /CANDIDATE_REFRESH_TWO_PERSON_RULE/u);
  for (const role of ["", "a b", "a\nb", "$(id)", "-flag", "x".repeat(65)]) {
    assert.throws(() => planNationwideCandidateRefresh({
      releaseSequence: "127", requestedBy: role, approvedBy: "data-release-authority", committedBuildSpec: committedSpec, now, event: "workflow_dispatch",
    }), /CANDIDATE_REFRESH_ROLE/u, JSON.stringify(role));
  }
});

test("candidate refresh plan only advances the nationwide candidate", () => {
  assert.throws(() => planNationwideCandidateRefresh({
    releaseSequence: "127", requestedBy: "a", approvedBy: "b",
    committedBuildSpec: { ...committedSpec, productionScopeId: "capital_pilot_android_v1" }, now, event: "workflow_dispatch",
  }), /CANDIDATE_REFRESH_SCOPE/u);
});

test("release-candidate modeArgs come only from repository files bound to the build spec", async () => {
  const { root, spec } = await releaseRepository();
  try {
    assert.deepEqual(await readReleaseCandidateModeArgs({ repositoryRoot: root }), {
      buildSpecPath: "tools/datapack/release/candidate-build-spec.json",
      releaseRequestId: `release-request-${spec.candidateId}`,
      releaseRequestPath: "tools/datapack/release/release-request.json",
      androidEvidencePath: "tools/datapack/release/android-evidence-summary.json",
      strictRouteRegressionPath: "tools/datapack/release/strict-route-regression-report.json",
      allowGaps: "false",
      sourceGovernanceEvaluationAt: "",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release-candidate dispatch is refused when the release request is not bound to the committed spec", async () => {
  const { root } = await releaseRepository((files) => {
    const request = JSON.parse(files[RELEASE_CANDIDATE_PATHS.releaseRequestPath]);
    request.buildSpecSha256 = "c".repeat(64);
    return { ...files, [RELEASE_CANDIDATE_PATHS.releaseRequestPath]: Buffer.from(JSON.stringify(request)) };
  });
  try {
    await assert.rejects(readReleaseCandidateModeArgs({ repositoryRoot: root }), /RELEASE_CANDIDATE_BINDING[\s\S]*buildSpecSha256/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release-candidate dispatch is refused for a stale approval id, a non-nationwide spec, or missing evidence", async () => {
  const cases = [
    [(files) => {
      const request = JSON.parse(files[RELEASE_CANDIDATE_PATHS.releaseRequestPath]);
      request.approvalId = "release-request-nationwide-candidate-20261003-seq126";
      return { ...files, [RELEASE_CANDIDATE_PATHS.releaseRequestPath]: Buffer.from(JSON.stringify(request)) };
    }, /RELEASE_CANDIDATE_BINDING[\s\S]*approvalId/u],
    [(files) => {
      const spec = JSON.parse(files[RELEASE_CANDIDATE_PATHS.buildSpecPath]);
      spec.productionScopeId = "capital_pilot_android_v1";
      return { ...files, [RELEASE_CANDIDATE_PATHS.buildSpecPath]: Buffer.from(JSON.stringify(spec)) };
    }, /RELEASE_CANDIDATE_SCOPE/u],
    [(files) => {
      const copy = { ...files };
      delete copy[RELEASE_CANDIDATE_PATHS.strictRouteRegressionPath];
      return copy;
    }, /RELEASE_CANDIDATE_EVIDENCE/u],
  ];
  for (const [mutate, expected] of cases) {
    const { root } = await releaseRepository(mutate);
    try {
      await assert.rejects(readReleaseCandidateModeArgs({ repositoryRoot: root }), expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("CLI writes the candidate refresh plan to GitHub output and the modeArgs to an absolute file", async () => {
  const { root, spec } = await releaseRepository();
  try {
    const githubOutput = path.join(root, "github-output.txt");
    await runPlanDatapackReleaseChain({
      argv: ["candidate-refresh", "--release-sequence", "128", "--requested-by", "data-operator-lead",
        "--approved-by", "data-release-authority", "--event", "workflow_dispatch", "--github-output", githubOutput],
      repositoryRoot: root,
      now: () => now,
    });
    assert.equal(await readFile(githubOutput, "utf8"), [
      "evaluated_at=2026-10-04T04:31:38.280Z",
      "release_sequence=128",
      "requested_by=data-operator-lead",
      "approved_by=data-release-authority",
      "",
    ].join("\n"));
    // #1032: 스케줄러 App의 dispatch는 --actor로 행위자를 받아 입력 없이 정기 역할을 쓴다.
    const appOutput = path.join(root, "github-output-app.txt");
    await runPlanDatapackReleaseChain({
      argv: ["candidate-refresh", "--release-sequence", "", "--requested-by", "", "--approved-by", "", "--event", "workflow_dispatch",
        "--actor", "easysubway-release-chain[bot]", "--github-output", appOutput],
      repositoryRoot: root,
      now: () => now,
    });
    assert.match(await readFile(appOutput, "utf8"), /^evaluated_at=2026-10-04T04:31:38\.280Z\nrelease_sequence=128\nrequested_by=datapack-scheduled-refresh\napproved_by=datapack-release-gates\n$/u);
    const modeArgsOutput = path.join(root, "mode-args.json");
    await runPlanDatapackReleaseChain({ argv: ["release-candidate-mode-args", "--output", modeArgsOutput], repositoryRoot: root });
    assert.equal(JSON.parse(await readFile(modeArgsOutput, "utf8")).releaseRequestId, `release-request-${spec.candidateId}`);
    await assert.rejects(runPlanDatapackReleaseChain({ argv: ["release-candidate-mode-args", "--output", "relative.json"], repositoryRoot: root }),
      /PLAN_RELEASE_CHAIN_ARGUMENTS/u);
    await assert.rejects(runPlanDatapackReleaseChain({ argv: ["production-publish"], repositoryRoot: root }),
      /PLAN_RELEASE_CHAIN_ARGUMENTS/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 마지막 수동 RC run 37109648483의 "Parse modeArgs" 로그에 찍힌 MODE_ARGS_INPUT 원문(2026-10-03T08:26:36Z).
const RUN_37109648483_MODE_ARGS = '{"buildSpecPath":"tools/datapack/release/candidate-build-spec.json","releaseRequestId":"release-request-nationwide-candidate-20261003-seq126","releaseRequestPath":"tools/datapack/release/release-request.json","androidEvidencePath":"tools/datapack/release/android-evidence-summary.json","strictRouteRegressionPath":"tools/datapack/release/strict-route-regression-report.json","allowGaps":"false","sourceGovernanceEvaluationAt":""}';

test("the seq126 candidate produces exactly the modeArgs of the manual RC run 37109648483 (F3)", async () => {
  const { root } = await releaseRepository(undefined, { candidateId: "nationwide-candidate-20261003-seq126", releaseSequence: 126 });
  try {
    assert.equal(JSON.stringify(await readReleaseCandidateModeArgs({ repositoryRoot: root })), RUN_37109648483_MODE_ARGS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed release candidate files produce the fixed RC modeArgs with a nationwide approval id (F3)", async () => {
  const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  // #1069: 정기 역할 후보의 release request는 만든 workflow run(gateRun)을 결속하고, RC 계획은 그 run 기록 없이는 시작하지 않는다.
  // 기록은 커밋된 gateRun과 후보 시계에서 유도한다(run 창이 후보 시계를 덮고 gateRun의 모든 필드가 맞는 성공 기록). 사람 역할 후보는 기록이 필요 없다.
  const request = JSON.parse(readFileSync(path.join(repositoryRoot, RELEASE_CANDIDATE_PATHS.releaseRequestPath), "utf8"));
  const { publishedAt } = JSON.parse(readFileSync(path.join(repositoryRoot, RELEASE_CANDIDATE_PATHS.buildSpecPath), "utf8"));
  const { gateRun } = request;
  const gateRunRecord = gateRun === undefined ? undefined : gateRunRecordFor(gateRun, {
    startedAt: new Date(Date.parse(publishedAt) - 60_000).toISOString(), updatedAt: new Date(Date.parse(publishedAt) + 60_000).toISOString(),
  });
  if (gateRunRecord !== undefined) {
    await assert.rejects(readReleaseCandidateModeArgs({ repositoryRoot }), /RELEASE_CANDIDATE_GATE_RUN[\s\S]*record is required/u, "gateRun이 결속된 후보는 기록 없이 시작하지 않는다");
    await assertShiftedGateRunRecordsRejected({ repositoryRoot, gateRun, valid: gateRunRecord });
  }
  const { releaseRequestId, ...fixed } = await readReleaseCandidateModeArgs({ repositoryRoot, ...(gateRunRecord === undefined ? {} : { gateRunRecord }) });
  assert.match(releaseRequestId, /^release-request-nationwide-candidate-\d{8}-seq[1-9]\d*$/u);
  const { releaseRequestId: _manual, ...manualFixed } = JSON.parse(RUN_37109648483_MODE_ARGS);
  assert.deepEqual(fixed, manualFixed);
});

test("nationwide candidate refresh workflow runs in CI on main and opens one automation PR with required CI", () => {
  const yml = workflowText("nationwide-candidate-refresh.yml");
  assert.match(yml, /\n  workflow_dispatch:\n    inputs:\n/u);
  // #1032: 스케줄러 App의 dispatch는 입력 없이 정기 역할을 쓰므로 입력은 선택이다. 사람 dispatch의 입력 검증은 plan 단계가 한다(비면 실패).
  for (const input of ["releaseSequence", "requestedBy", "approvedBy"]) {
    assert.match(yml, new RegExp(`\\n      ${input}:\\n[\\s\\S]*?required: false\\n        type: string\\n`, "u"));
  }
  // #929 D3: 정기 실행은 저장소 변수 DATAPACK_SCHEDULED_CANDIDATE_REFRESH가 true일 때만 돈다(QA 승인 뒤 메인이 켠다).
  assert.match(yml, /^on:\n  schedule:\n    - cron: "[^"]+"\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(yml, /\n  (push|pull_request|workflow_run):/u);
  // #939: 후보 갱신 PR은 App 토큰으로 열고 CI를 dispatch하지 않는다. 그래서 actions 권한이 없다.
  // #969: 권한은 job에만 주고(issues 쓰기는 실패 보고용) workflow dispatch 권한(actions: write)은 여전히 없다.
  assert.match(yml, /\n    permissions:\n      contents: write\n      pull-requests: write\n      issues: write\n/u);
  assert.doesNotMatch(yml, /actions: write/u);
  // #1032: 정기 실행과 스케줄러 App의 dispatch는 저장소 변수가 true일 때만 돈다. 사람 dispatch는 항상 돈다.
  assert.match(yml, /if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(\(github\.event_name == 'workflow_dispatch' && github\.triggering_actor != 'easysubway-release-chain\[bot\]'\) \|\| vars\.DATAPACK_SCHEDULED_CANDIDATE_REFRESH == 'true'\) \}\}/u);
  assert.match(yml, /cancel-in-progress: false/u);
  assert.match(yml, /persist-credentials: false/u);
  // dispatch 입력은 env로만 run에 들어간다(셸 주입 차단).
  for (const block of yml.split("\n      - name: ").slice(1)) {
    const run = block.split("\n        run: ")[1] ?? "";
    assert.doesNotMatch(run, /\$\{\{\s*(inputs|github\.event\.inputs)\./u);
  }
  const plan = stepBody(yml, "Validate candidate refresh inputs");
  assert.match(plan, /node tools\/ci\/plan-datapack-release-chain\.mjs candidate-refresh --release-sequence "\$\{RELEASE_SEQUENCE\}" --requested-by "\$\{REQUESTED_BY\}" --approved-by "\$\{APPROVED_BY\}" --event "\$\{EVENT_NAME\}" --actor "\$\{ACTOR\}" --github-output "\$\{GITHUB_OUTPUT\}"/u);
  assert.match(plan, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  // 행위자는 GitHub 컨텍스트에서만 받는다(입력으로 받지 않는다).
  assert.match(plan, /ACTOR: \$\{\{ github\.triggering_actor \}\}/u);
  const gate = stepBody(yml, "Record the candidate gate run");
  assert.match(gate, /node tools\/ci\/plan-datapack-release-chain\.mjs gate-run --output "\$\{RUNNER_TEMP\}\/candidate-gate-run\.json"/u);
  const refresh = stepBody(yml, "Refresh nationwide candidate");
  assert.match(refresh, /node tools\/datapack\/refresh-nationwide-candidate\.mjs --evaluated-at "\$\{EVALUATED_AT\}" --release-sequence "\$\{RELEASE_SEQUENCE\}" --requested-by "\$\{REQUESTED_BY\}" --approved-by "\$\{APPROVED_BY\}" --gate-run "\$\{RUNNER_TEMP\}\/candidate-gate-run\.json"/u);
  assert.match(refresh, /EVALUATED_AT: \$\{\{ steps\.plan\.outputs\.evaluated_at \}\}/u);
  // #942: 후보 입력 매니페스트 바이트를 OCI에 올리는 PAR은 시크릿에서만 받는다.
  assert.match(refresh, /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: \$\{\{ secrets\.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL \}\}/u);
  const scope = stepBody(yml, "Verify candidate refresh output scope");
  assert.match(scope, /NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS/u);
  assert.match(scope, /git add -- "\$\{outputs\[@\]\}"/u);
  const commit = stepBody(yml, "Commit and push candidate refresh branch");
  assert.match(commit, /automation\/927-nationwide-candidate-refresh-\$\{GITHUB_RUN_ID\}/u);
  for (const body of [scope, commit]) assert.doesNotMatch(body, /git add (-A|--all|\.)(\s|$)/u);
  assert.doesNotMatch(commit, /git add/u);
  const pr = stepBody(yml, "Create candidate refresh pull request");
  // #939: App이 연 PR이라야 pull_request CI가 required check로 붙는다(#948 실험: dispatch CI는 인정되지 않음).
  assert.match(pr, /GH_TOKEN="\$\{APP_PR_TOKEN\}" gh pr create --repo "\$\{GITHUB_REPOSITORY\}" --draft --base main --head "\$\{CANDIDATE_BRANCH\}"/u);
  assert.match(pr, /APP_PR_TOKEN: \$\{\{ steps\.app-token-pr\.outputs\.token \}\}/u);
  assert.doesNotMatch(yml, /gh workflow run|Run required CI on the candidate refresh head/u);
  assert.ok(yml.indexOf("Validate candidate refresh inputs") < yml.indexOf("Refresh nationwide candidate"));
  assert.ok(yml.indexOf("Refresh nationwide candidate") < yml.indexOf("Verify candidate refresh output scope"));
  assert.ok(yml.indexOf("Verify candidate refresh output scope") < yml.indexOf("Commit and push candidate refresh branch"));
  assert.ok(yml.indexOf("Commit and push candidate refresh branch") < yml.indexOf("Mint App token for the candidate refresh pull request"));
  assert.ok(yml.indexOf("Mint App token for the candidate refresh pull request") < yml.indexOf("Create candidate refresh pull request"));
  assert.doesNotMatch(yml, /gh pr merge|automerge|git push origin main|production-publish|datapack-release\.yml/u);
});

test("release candidate chain dispatches RC as workflow_dispatch when a candidate lands on main", () => {
  const yml = workflowText("datapack-release-candidate-chain.yml");
  assert.match(yml, /^on:\n  push:\n    branches: \[main\]\n    paths:\n      - tools\/datapack\/release\/candidate-build-spec\.json\n      - tools\/datapack\/release\/release-request\.json\n/mu);
  assert.doesNotMatch(yml, /\n  (schedule|workflow_dispatch|pull_request|workflow_run):/u);
  assert.match(yml, /\npermissions:\n  actions: write\n  contents: read\n/u);
  assert.match(yml, /if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/u);
  const supersede = stepBody(yml, "Skip a candidate superseded on main");
  assert.match(supersede, /git diff --quiet "\$\{GITHUB_SHA\}" origin\/main -- tools\/datapack\/release\/candidate-build-spec\.json tools\/datapack\/release\/release-request\.json/u);
  const plan = stepBody(yml, "Build release-candidate modeArgs from repository files");
  assert.match(plan, /args=\(release-candidate-mode-args --output "\$\{RUNNER_TEMP\}\/release-candidate-mode-args\.json"\)/u);
  assert.match(plan, /node tools\/ci\/plan-datapack-release-chain\.mjs "\$\{args\[@\]\}"/u);
  assert.match(plan, /steps\.supersede\.outputs\.current == 'true'/u);
  const dispatch = stepBody(yml, "Dispatch release candidate");
  assert.match(dispatch, /steps\.supersede\.outputs\.current == 'true'/u);
  assert.match(dispatch, /gh workflow run datapack-release\.yml --repo "\$\{GITHUB_REPOSITORY\}" --ref main -f mode=release-candidate -f targetChannel=production -f modeArgs="\$\(cat "\$\{RUNNER_TEMP\}\/release-candidate-mode-args\.json"\)"/u);
  assert.doesNotMatch(yml, /production-publish|rollback|rollout-update|candidate-create|gh pr merge|continue-on-error/u);
});

test("candidate chain treats only git diff exit 1 as superseded and fails on any other git error (F1)", async () => {
  const yml = workflowText("datapack-release-candidate-chain.yml");
  const origin = await gitRepository();
  const clone = path.join(origin, "clone");
  try {
    await mkdir(path.join(origin, "tools/datapack/release"), { recursive: true });
    await writeFile(path.join(origin, RELEASE_CANDIDATE_PATHS.buildSpecPath), "{\"seq\":1}\n");
    await writeFile(path.join(origin, RELEASE_CANDIDATE_PATHS.releaseRequestPath), "{}\n");
    git(origin, "add", RELEASE_CANDIDATE_PATHS.buildSpecPath, RELEASE_CANDIDATE_PATHS.releaseRequestPath);
    git(origin, "commit", "-q", "-m", "candidate");
    const pushed = git(origin, "rev-parse", "HEAD");
    git(path.dirname(clone), "clone", "-q", origin, clone);
    const run = async (sha) => {
      const output = path.join(clone, `github-output-${Math.random()}`);
      await writeFile(output, "");
      const result = runStep(yml, "Skip a candidate superseded on main", { cwd: clone, env: { GITHUB_SHA: sha, GITHUB_OUTPUT: output } });
      return { ...result, output: await readFile(output, "utf8") };
    };
    const current = await run(pushed);
    assert.equal(current.status, 0, current.stderr);
    assert.equal(current.output, "current=true\n");
    await writeFile(path.join(origin, RELEASE_CANDIDATE_PATHS.buildSpecPath), "{\"seq\":2}\n");
    git(origin, "commit", "-q", "-am", "newer candidate");
    const superseded = await run(pushed);
    assert.equal(superseded.status, 0, superseded.stderr);
    assert.equal(superseded.output, "current=false\n");
    const broken = await run("0".repeat(40));
    assert.notEqual(broken.status, 0);
    assert.equal(broken.output, "");
    assert.match(broken.stderr, /candidate supersede check failed/u);
  } finally {
    await rm(origin, { recursive: true, force: true });
  }
});

test("a failure after the automation branch is pushed closes its PR and deletes the branch (F2)", async () => {
  const yml = workflowText("nationwide-candidate-refresh.yml");
  const cleanup = stepBody(yml, "Remove the candidate refresh branch after a later failure");
  assert.match(cleanup, /\n        if: \$\{\{ \(failure\(\) \|\| cancelled\(\)\) && env\.CANDIDATE_BRANCH != '' \}\}\n/u);
  // #969: 실패 보고 step만 정리 뒤에 온다(정리가 실패해도 보고가 돈다).
  const report = stepBody(yml, "Report refresh failure as an issue");
  assert.equal(yml.trimEnd().endsWith(report.trimEnd()), true, "the failure report is the last step");
  assert.ok(yml.indexOf(cleanup.trimEnd()) < yml.indexOf("Report refresh failure as an issue"), "cleanup runs after every other step except the failure report");
  const pr = stepBody(yml, "Create candidate refresh pull request");
  assert.match(pr, /printf 'CANDIDATE_PR_URL=%s\\n' "\$\{pr_url\}" >> "\$\{GITHUB_ENV\}"/u);
  assert.match(pr, /set -euo pipefail/u);

  const origin = await gitRepository();
  const clone = path.join(origin, "clone");
  const bin = path.join(origin, "bin");
  try {
    await writeFile(path.join(origin, "README"), "x\n");
    git(origin, "add", "README");
    git(origin, "commit", "-q", "-m", "base");
    git(origin, "branch", "automation/927-nationwide-candidate-refresh-1");
    git(origin, "branch", "automation/927-nationwide-candidate-refresh-2");
    git(path.dirname(clone), "clone", "-q", origin, clone);
    await mkdir(bin);
    const ghLog = path.join(origin, "gh.log");
    await writeFile(path.join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${ghLog}"\nif [ "$1 $2" = "pr close" ]; then git push origin --delete automation/927-nationwide-candidate-refresh-2 >/dev/null 2>&1; fi\n`);
    spawnSync("/bin/chmod", ["755", path.join(bin, "gh")]);
    const env = (extra) => ({ PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "test", GITHUB_REPOSITORY: "AquilaXk/easysubway-data", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "42", ...extra });
    // PR 전에 실패: 브랜치만 지운다.
    const noPr = spawnSync("/bin/bash", ["-e", "-c", stepScript(yml, "Remove the candidate refresh branch after a later failure")], {
      cwd: clone, encoding: "utf8", env: env({ CANDIDATE_BRANCH: "automation/927-nationwide-candidate-refresh-1", CANDIDATE_PR_URL: "" }),
    });
    assert.equal(noPr.status, 0, noPr.stderr);
    assert.equal(git(origin, "branch", "--list", "automation/927-nationwide-candidate-refresh-1"), "");
    // PR 뒤에 실패(예: CI dispatch 실패): PR을 닫으며 브랜치를 지운다.
    const prUrl = "https://github.com/AquilaXk/easysubway-data/pull/9999";
    const withPr = spawnSync("/bin/bash", ["-e", "-c", stepScript(yml, "Remove the candidate refresh branch after a later failure")], {
      cwd: clone, encoding: "utf8", env: env({ CANDIDATE_BRANCH: "automation/927-nationwide-candidate-refresh-2", CANDIDATE_PR_URL: prUrl }),
    });
    assert.equal(withPr.status, 0, withPr.stderr);
    assert.match(await readFile(ghLog, "utf8"), new RegExp(`^pr close ${prUrl} --repo AquilaXk/easysubway-data --delete-branch --comment `, "mu"));
    assert.equal(git(origin, "branch", "--list", "automation/927-nationwide-candidate-refresh-2"), "");
  } finally {
    await rm(origin, { recursive: true, force: true });
  }
});

test("candidate output scope guard runs for real: only declared outputs, something changed, git errors fail (F4)", async () => {
  const yml = workflowText("nationwide-candidate-refresh.yml");
  const scenario = async (mutate) => {
    const root = await gitRepository();
    try {
      await mkdir(path.join(root, "tools/datapack"), { recursive: true });
      await mkdir(path.join(root, "out"));
      await writeFile(path.join(root, "tools/datapack/refresh-nationwide-candidate.mjs"),
        'export const NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS = Object.freeze(["out/a.json", "out/b.json"]);\n');
      for (const name of ["out/a.json", "out/b.json", "other.json"]) await writeFile(path.join(root, name), "{}\n");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "base");
      await mutate(root);
      const result = runStep(yml, "Verify candidate refresh output scope", { cwd: root });
      return { ...result, staged: git(root, "diff", "--cached", "--name-only") };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  const ok = await scenario((root) => writeFile(path.join(root, "out/a.json"), "{\"changed\":true}\n"));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.staged, "out/a.json");
  const extraTracked = await scenario(async (root) => {
    await writeFile(path.join(root, "out/a.json"), "{\"changed\":true}\n");
    await writeFile(path.join(root, "other.json"), "{\"changed\":true}\n");
  });
  assert.notEqual(extraTracked.status, 0);
  assert.match(extraTracked.stderr, /candidate refresh changed a path outside its outputs/u);
  const untracked = await scenario(async (root) => {
    await writeFile(path.join(root, "out/a.json"), "{\"changed\":true}\n");
    await writeFile(path.join(root, "stray.json"), "{}\n");
  });
  assert.notEqual(untracked.status, 0);
  assert.match(untracked.stderr, /candidate refresh changed a path outside its outputs/u);
  const unchanged = await scenario(async () => {});
  assert.notEqual(unchanged.status, 0);
  assert.match(unchanged.stderr, /candidate refresh produced no change/u);
  const missingModule = await scenario((root) => rm(path.join(root, "tools/datapack/refresh-nationwide-candidate.mjs")));
  assert.notEqual(missingModule.status, 0);
});

const GATE_RUN = Object.freeze({
  repository: "AquilaXk/easysubway-data", workflowPath: ".github/workflows/nationwide-candidate-refresh.yml",
  runId: 37200000001, runAttempt: 1, event: "schedule", headSha: "a".repeat(40),
});

// GitHub run 기록(GET /repos/{repo}/actions/runs/{id})을 gateRun에서 만든다. dispatch run은 처음 시작한 행위자와 지금 실행한 행위자를 모두 gateRun의 actor로 담는다.
function gateRunRecordFor(gateRun, { startedAt = "2026-10-04T22:23:10Z", updatedAt = "2026-10-04T22:41:02Z" } = {}) {
  return {
    id: gateRun.runId, run_attempt: gateRun.runAttempt ?? 1, event: gateRun.event, head_sha: gateRun.headSha, head_branch: "main",
    path: `${gateRun.workflowPath}@refs/heads/main`, conclusion: "success", repository: { full_name: gateRun.repository },
    head_repository: { full_name: gateRun.repository }, run_started_at: startedAt, updated_at: updatedAt,
    ...(gateRun.actor === undefined ? {} : { actor: { login: gateRun.actor }, triggering_actor: { login: gateRun.actor } }),
  };
}

// 유효한 기록에서 필드 하나만 어긋나게 한 기록은 모두 거부돼야 한다. 기대값이 gateRun에서 유도한 기록과 같은 근거에서 나오지 않도록, 어긋남은 독립적으로 만든다
// (다른 head_sha, 다른 run id, 후보 시계를 덮지 않는 run 창, dispatch run이면 다른 행위자).
async function assertShiftedGateRunRecordsRejected({ repositoryRoot, gateRun, valid }) {
  const minute = 60_000;
  const shift = (iso, milliseconds) => new Date(Date.parse(iso) + milliseconds).toISOString();
  const cases = [
    ["head_sha", { head_sha: gateRun.headSha.replace(/^./u, (first) => (first === "f" ? "e" : "f")) }, /head_sha/u],
    ["id", { id: valid.id + 1 }, /gate run id mismatch/u],
    ["후보 시계 뒤에 시작한 run 창", { run_started_at: shift(valid.updated_at, minute), updated_at: shift(valid.updated_at, 2 * minute) }, /candidate clock/u],
    ["후보 시계 전에 끝난 run 창", { run_started_at: shift(valid.run_started_at, -120 * minute), updated_at: shift(valid.run_started_at, -60 * minute) }, /candidate clock/u],
    ...(gateRun.event === "workflow_dispatch" ? [
      ["actor", { actor: { login: "someone-else" } }, /actor/u],
      ["triggering_actor", { triggering_actor: { login: "someone-else" } }, /actor/u],
    ] : []),
  ];
  for (const [label, override, expected] of cases) {
    await assert.rejects(readReleaseCandidateModeArgs({ repositoryRoot, gateRunRecord: { ...valid, ...override } }), new RegExp(`RELEASE_CANDIDATE_GATE_RUN[\\s\\S]*${expected.source}`, "u"), label);
  }
}

test("#929 D3 a scheduled run derives the fixed roles and the next sequence and takes no person input", () => {
  assert.throws(() => planNationwideCandidateRefresh({
    releaseSequence: "", requestedBy: "", approvedBy: "", committedBuildSpec: committedSpec, now, event: "workflow_run",
  }), /CANDIDATE_REFRESH_EVENT/u);
  for (const event of ["schedule"]) {
    assert.deepEqual(planNationwideCandidateRefresh({
      releaseSequence: "", requestedBy: "", approvedBy: "", committedBuildSpec: committedSpec, now, event,
    }), {
      evaluatedAt: "2026-10-04T04:31:38.280Z", releaseSequence: 127,
      requestedBy: "datapack-scheduled-refresh", approvedBy: "datapack-release-gates",
    });
    assert.throws(() => planNationwideCandidateRefresh({
      releaseSequence: "127", requestedBy: "", approvedBy: "", committedBuildSpec: committedSpec, now, event,
    }), /CANDIDATE_REFRESH_SCHEDULED_INPUT/u);
    assert.throws(() => planNationwideCandidateRefresh({
      releaseSequence: "", requestedBy: "data-operator-lead", approvedBy: "data-release-authority", committedBuildSpec: committedSpec, now, event,
    }), /CANDIDATE_REFRESH_SCHEDULED_INPUT/u);
  }
});

test("#1032 a dispatch started by the scheduler App derives the scheduled roles and takes no person input", () => {
  const app = { committedBuildSpec: committedSpec, now, event: "workflow_dispatch", actor: "easysubway-release-chain[bot]" };
  assert.deepEqual(planNationwideCandidateRefresh({ releaseSequence: "", requestedBy: "", approvedBy: "", ...app }), {
    evaluatedAt: "2026-10-04T04:31:38.280Z", releaseSequence: 127,
    requestedBy: "datapack-scheduled-refresh", approvedBy: "datapack-release-gates",
  });
  // 입력이 비어 있는 dispatch(GitHub는 선택 입력을 빈 문자열로 넘긴다)와 입력을 아예 주지 않은 경우가 같다.
  assert.equal(planNationwideCandidateRefresh({ ...app }).releaseSequence, 127);
  // App은 사람 승인을 입력으로 가져올 수 없다. 사람 역할도 정기 역할도 입력이 섞이면 실패한다.
  for (const input of [{ releaseSequence: "128" }, { requestedBy: "data-operator-lead", approvedBy: "data-release-authority" }, { requestedBy: "datapack-scheduled-refresh", approvedBy: "datapack-release-gates" }]) {
    assert.throws(() => planNationwideCandidateRefresh({ ...app, ...input }), /CANDIDATE_REFRESH_SCHEDULED_INPUT/u, JSON.stringify(input));
  }
});

test("#1032 a person dispatch (any other actor) keeps the explicit two-person roles and cannot use the scheduled roles", () => {
  for (const actor of ["AquilaXk", "github-actions[bot]", undefined]) {
    assert.throws(() => planNationwideCandidateRefresh({
      releaseSequence: "127", requestedBy: "datapack-scheduled-refresh", approvedBy: "datapack-release-gates",
      committedBuildSpec: committedSpec, now, event: "workflow_dispatch", actor,
    }), /CANDIDATE_REFRESH_ROLE_EVENT[\s\S]*scheduler App/u, String(actor));
    // 입력을 비운 사람 dispatch는 정기 경로로 바뀌지 않고 명시 입력 부족으로 실패한다.
    assert.throws(() => planNationwideCandidateRefresh({
      releaseSequence: "", requestedBy: "", approvedBy: "", committedBuildSpec: committedSpec, now, event: "workflow_dispatch", actor,
    }), /CANDIDATE_REFRESH_RELEASE_SEQUENCE/u, String(actor));
  }
  assert.equal(planNationwideCandidateRefresh({
    releaseSequence: "127", requestedBy: "data-operator-lead", approvedBy: "data-release-authority",
    committedBuildSpec: committedSpec, now, event: "workflow_dispatch", actor: "AquilaXk",
  }).releaseSequence, 127);
});

test("#929 D3 a person dispatch cannot use the scheduled roles, and other events are refused", () => {
  assert.throws(() => planNationwideCandidateRefresh({
    releaseSequence: "127", requestedBy: "datapack-scheduled-refresh", approvedBy: "datapack-release-gates",
    committedBuildSpec: committedSpec, now, event: "workflow_dispatch",
  }), /CANDIDATE_REFRESH_ROLE_EVENT[\s\S]*scheduler App/u);
  assert.throws(() => planNationwideCandidateRefresh({
    releaseSequence: "127", requestedBy: "data-operator-lead", approvedBy: "datapack-release-gates",
    committedBuildSpec: committedSpec, now, event: "workflow_dispatch",
  }), /CANDIDATE_REFRESH_ROLE_EVENT[\s\S]*exact pair/u);
  for (const event of ["push", "pull_request", "", undefined]) {
    assert.throws(() => planNationwideCandidateRefresh({
      releaseSequence: "127", requestedBy: "a", approvedBy: "b", committedBuildSpec: committedSpec, now, event,
    }), /CANDIDATE_REFRESH_EVENT/u, String(event));
  }
});

test("#929 D3 the gate-run subcommand records only the refresh workflow run on main from the Actions environment", async () => {
  const { root } = await releaseRepository();
  try {
    const output = path.join(root, "gate-run.json");
    const env = {
      GITHUB_REPOSITORY: GATE_RUN.repository,
      GITHUB_WORKFLOW_REF: `${GATE_RUN.repository}/${GATE_RUN.workflowPath}@refs/heads/main`,
      GITHUB_RUN_ID: String(GATE_RUN.runId), GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "schedule", GITHUB_SHA: GATE_RUN.headSha,
    };
    await runPlanDatapackReleaseChain({ argv: ["gate-run", "--output", output], repositoryRoot: root, env });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), GATE_RUN);
    // #1032: 스케줄러 App의 dispatch run은 시작한 행위자를 함께 기록한다.
    const dispatched = path.join(root, "gate-run-dispatch.json");
    await runPlanDatapackReleaseChain({
      argv: ["gate-run", "--output", dispatched], repositoryRoot: root,
      env: { ...env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_TRIGGERING_ACTOR: "easysubway-release-chain[bot]" },
    });
    assert.deepEqual(JSON.parse(await readFile(dispatched, "utf8")), { ...GATE_RUN, event: "workflow_dispatch", actor: "easysubway-release-chain[bot]" });
    await assert.rejects(runPlanDatapackReleaseChain({
      argv: ["gate-run", "--output", path.join(root, "other.json")], repositoryRoot: root,
      env: { ...env, GITHUB_WORKFLOW_REF: `${GATE_RUN.repository}/${GATE_RUN.workflowPath}@refs/heads/feature` },
    }), /SCHEDULED_AUTHORITY_GATE_RUN/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#929 D3 a scheduled-role candidate is dispatched to RC only after its gate run record matches", async () => {
  const scheduled = (files) => {
    const request = JSON.parse(files[RELEASE_CANDIDATE_PATHS.releaseRequestPath]);
    Object.assign(request, { requestedBy: "datapack-scheduled-refresh", approvedBy: "datapack-release-gates", gateRun: GATE_RUN });
    return { ...files, [RELEASE_CANDIDATE_PATHS.releaseRequestPath]: Buffer.from(JSON.stringify(request)) };
  };
  const { root } = await releaseRepository(scheduled);
  try {
    const record = gateRunRecordFor(GATE_RUN);
    await assert.rejects(readReleaseCandidateModeArgs({ repositoryRoot: root, gateRunRecord: { ...record, updated_at: "2026-10-04T22:23:20Z" } }),
      /RELEASE_CANDIDATE_GATE_RUN[\s\S]*candidate clock/u);
    await assert.rejects(readReleaseCandidateModeArgs({ repositoryRoot: root }), /RELEASE_CANDIDATE_GATE_RUN[\s\S]*record is required/u);
    await assert.rejects(readReleaseCandidateModeArgs({ repositoryRoot: root, gateRunRecord: { ...record, conclusion: "failure" } }),
      /RELEASE_CANDIDATE_GATE_RUN[\s\S]*conclusion/u);
    assert.equal((await readReleaseCandidateModeArgs({ repositoryRoot: root, gateRunRecord: record })).allowGaps, "false");
    await assertShiftedGateRunRecordsRejected({ repositoryRoot: root, gateRun: GATE_RUN, valid: record });
    const recordPath = path.join(root, "record.json");
    await writeFile(recordPath, JSON.stringify(record));
    const output = path.join(root, "mode-args.json");
    await runPlanDatapackReleaseChain({ argv: ["release-candidate-mode-args", "--output", output, "--gate-run-record", recordPath], repositoryRoot: root });
    assert.equal(JSON.parse(await readFile(output, "utf8")).buildSpecPath, RELEASE_CANDIDATE_PATHS.buildSpecPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const person = await releaseRepository();
  try {
    await assert.rejects(readReleaseCandidateModeArgs({ repositoryRoot: person.root, gateRunRecord: {} }),
      /RELEASE_CANDIDATE_GATE_RUN[\s\S]*no gateRun/u);
  } finally {
    await rm(person.root, { recursive: true, force: true });
  }
});

test("#1032 a candidate made by a scheduler App dispatch is sent to RC only when the run record shows the App as actor", async () => {
  const dispatchedRun = { ...GATE_RUN, event: "workflow_dispatch", actor: "easysubway-release-chain[bot]" };
  const scheduled = (files) => {
    const request = JSON.parse(files[RELEASE_CANDIDATE_PATHS.releaseRequestPath]);
    Object.assign(request, { requestedBy: "datapack-scheduled-refresh", approvedBy: "datapack-release-gates", gateRun: dispatchedRun });
    return { ...files, [RELEASE_CANDIDATE_PATHS.releaseRequestPath]: Buffer.from(JSON.stringify(request)) };
  };
  const { root } = await releaseRepository(scheduled);
  try {
    const record = gateRunRecordFor(dispatchedRun);
    assert.equal((await readReleaseCandidateModeArgs({ repositoryRoot: root, gateRunRecord: record })).allowGaps, "false");
    await assertShiftedGateRunRecordsRejected({ repositoryRoot: root, gateRun: dispatchedRun, valid: record });
    for (const override of [{ triggering_actor: { login: "AquilaXk" } }, { actor: { login: "AquilaXk" } }]) {
      await assert.rejects(readReleaseCandidateModeArgs({ repositoryRoot: root, gateRunRecord: { ...record, ...override } }), /RELEASE_CANDIDATE_GATE_RUN[\s\S]*actor/u, JSON.stringify(override));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#929 D3 the RC chain fetches the gate run record only for a bound request and passes it to the planner", () => {
  const yml = workflowText("datapack-release-candidate-chain.yml");
  const fetch = stepBody(yml, "Fetch the candidate gate run record");
  assert.match(fetch, /steps\.supersede\.outputs\.current == 'true'/u);
  assert.match(fetch, /\[\[ "\$\{run_id\}" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/u);
  assert.match(fetch, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{run_id\}" > "\$\{RUNNER_TEMP\}\/candidate-gate-run-record\.json"/u);
  const plan = stepBody(yml, "Build release-candidate modeArgs from repository files");
  assert.match(plan, /--gate-run-record "\$\{GATE_RUN_RECORD\}"/u);
  assert.ok(yml.indexOf("Fetch the candidate gate run record") < yml.indexOf("Build release-candidate modeArgs from repository files"));
});

test("#931 F1 the chain dispatches RC only for the verified commit and fails when the dispatched run built another commit", async () => {
  const yml = workflowText("datapack-release-candidate-chain.yml");
  const verified = "a".repeat(40);
  const run = async ({ mainSha, runLine }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "rc-dispatch-"));
    try {
      const log = path.join(directory, "gh.log");
      const output = path.join(directory, "github-output");
      await writeFile(log, "");
      await writeFile(output, "");
      await writeFile(path.join(directory, "release-candidate-mode-args.json"), "{}\n");
      await writeFile(path.join(directory, "gh"), [
        "#!/bin/sh",
        'case "$*" in',
        '  *"git/ref/heads/main"*) echo "$MAIN_SHA" ;;',
        '  "workflow run "*) echo "dispatch $*" >> "$LOG" ;;',
        '  *"actions/workflows/datapack-release.yml/runs"*) echo "$RUN_LINE" ;;',
        '  "run cancel "*) echo "cancel $3" >> "$LOG" ;;',
        '  *) echo "unexpected gh $*" >&2; exit 9 ;;',
        "esac",
        "",
      ].join("\n"));
      spawnSync("/bin/chmod", ["755", path.join(directory, "gh")]);
      const result = runStep(yml, "Dispatch release candidate", { cwd: directory, env: {
        PATH: `${directory}:${process.env.PATH}`, GITHUB_SHA: verified, GITHUB_REPOSITORY: "AquilaXk/easysubway-data",
        GH_TOKEN: "test", RUNNER_TEMP: directory, GITHUB_OUTPUT: output, MAIN_SHA: mainSha, RUN_LINE: runLine, LOG: log,
      } });
      return { ...result, log: await readFile(log, "utf8"), output: await readFile(output, "utf8") };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const matched = await run({ mainSha: verified, runLine: `111 ${verified}` });
  assert.equal(matched.status, 0, matched.stderr);
  assert.match(matched.log, /^dispatch workflow run datapack-release\.yml/mu);
  assert.doesNotMatch(matched.log, /cancel/u);
  assert.equal(matched.output, "rc_run_id=111\n");
  const moved = await run({ mainSha: "b".repeat(40), runLine: `111 ${verified}` });
  assert.notEqual(moved.status, 0);
  assert.match(moved.stderr, /main moved/u);
  assert.equal(moved.log, "");
  const otherCommit = await run({ mainSha: verified, runLine: `222 ${"c".repeat(40)}` });
  assert.notEqual(otherCommit.status, 0);
  assert.match(otherCommit.stderr, /not the verified/u);
  assert.match(otherCommit.log, /^cancel 222$/mu);
  assert.doesNotMatch(stepBody(yml, "Dispatch release candidate"), /\|\| true/u);
});

// ---------- data#1084: production-publish modeArgs ----------

test("production-publish modeArgs are the bound release-candidate modeArgs plus the exact candidate and promotion run ids", async () => {
  const { root, spec } = await releaseRepository();
  try {
    assert.deepEqual(await readProductionPublishModeArgs({ repositoryRoot: root, candidateRunId: "7001", promotionRunId: "8002" }), {
      buildSpecPath: "tools/datapack/release/candidate-build-spec.json",
      releaseRequestId: `release-request-${spec.candidateId}`,
      releaseRequestPath: "tools/datapack/release/release-request.json",
      androidEvidencePath: "tools/datapack/release/android-evidence-summary.json",
      strictRouteRegressionPath: "tools/datapack/release/strict-route-regression-report.json",
      allowGaps: "false",
      sourceGovernanceEvaluationAt: "",
      candidateRunId: "7001",
      promotionRunId: "8002",
    });
    for (const [candidateRunId, promotionRunId] of [["0", "1"], ["1", "0"], ["01", "2"], ["1", "-2"], ["1", "2;rm"], [undefined, "2"], ["1", 2], ["", "2"]]) {
      await assert.rejects(readProductionPublishModeArgs({ repositoryRoot: root, candidateRunId, promotionRunId }),
        /PRODUCTION_PUBLISH_RUN_ID/u, JSON.stringify([candidateRunId, promotionRunId]));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production-publish modeArgs are refused when the release request is not bound to the committed spec (same gate as the RC)", async () => {
  const { root } = await releaseRepository((files) => {
    const request = JSON.parse(files[RELEASE_CANDIDATE_PATHS.releaseRequestPath]);
    request.buildSpecSha256 = "0".repeat(64);
    return { ...files, [RELEASE_CANDIDATE_PATHS.releaseRequestPath]: Buffer.from(`${JSON.stringify(request)}\n`) };
  });
  try {
    await assert.rejects(readProductionPublishModeArgs({ repositoryRoot: root, candidateRunId: "7001", promotionRunId: "8002" }),
      /RELEASE_CANDIDATE_BINDING[\s\S]*buildSpecSha256/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI writes the production-publish modeArgs to an absolute file and rejects relative output or missing ids", async () => {
  const { root, spec } = await releaseRepository();
  try {
    const output = path.join(root, "publish-mode-args.json");
    await runPlanDatapackReleaseChain({
      argv: ["production-publish-mode-args", "--output", output, "--candidate-run-id", "7001", "--promotion-run-id", "8002"],
      repositoryRoot: root,
    });
    const written = JSON.parse(await readFile(output, "utf8"));
    assert.equal(written.releaseRequestId, `release-request-${spec.candidateId}`);
    assert.equal(written.candidateRunId, "7001");
    assert.equal(written.promotionRunId, "8002");
    await assert.rejects(runPlanDatapackReleaseChain({
      argv: ["production-publish-mode-args", "--output", "relative.json", "--candidate-run-id", "1", "--promotion-run-id", "2"], repositoryRoot: root,
    }), /PLAN_RELEASE_CHAIN_ARGUMENTS/u);
    await assert.rejects(runPlanDatapackReleaseChain({
      argv: ["production-publish-mode-args", "--output", path.join(root, "other.json"), "--candidate-run-id", "1"], repositoryRoot: root,
    }), /PLAN_RELEASE_CHAIN_ARGUMENTS/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
