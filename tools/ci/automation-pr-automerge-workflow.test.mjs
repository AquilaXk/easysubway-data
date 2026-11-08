import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  AUTOMATION_AUTOMERGE_LABEL,
  AUTOMATION_AUTOMERGE_VARIABLE,
  AUTOMATION_PR_GATES_CONTEXT,
  AUTOMATION_STAGE_PREFIXES,
  AUTOMATION_STAGE_WORKFLOWS,
  REGISTRATION_ALLOWED_PATHS,
  automationAttestationMarker,
} from "./automation-pr-policy.mjs";
import { REFRESH_WORKFLOWS } from "./report-refresh-failure.mjs";
import { assertFailureReportLast, assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #985: 자동화 PR 자동 병합 라벨러 workflow와 CI의 게이트 재계산 job 계약(#870 전체 자동화 2단계).
// 신뢰 모델: 게이트 재계산은 읽기 전용 토큰의 pull_request CI가 PR head에서 하고, 라벨러(workflow_run, 기본 브랜치 코드)는
// PR 코드를 실행하지 않고 API 데이터와 CI 결과만 읽는다. 쓰기 토큰(App 설치 토큰)은 승인 step 하나에서만 쓴다.
const root = path.resolve(import.meta.dirname, "../..");
const FILE = "automation-pr-automerge.yml";
const { yml, workflow, job, steps, step } = loadWorkflow(root, FILE);
const code = yml.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const { yml: ciYml, workflow: ciWorkflow } = loadWorkflow(root, "ci.yml");
const ciCode = ciYml.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const APP_TOKEN_ACTION = "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510";
const ELIGIBLE = "${{ steps.decision.outputs.state == 'ELIGIBLE' }}";

test("변수는 코드가 켜지지 않고 QA 보고 뒤 별도 설정 변경으로만 켠다고 workflow가 스스로 밝힌다", () => {
  const header = yml.split("\n").filter((line) => line.startsWith("#")).join("\n");
  assert.match(header, /DATAPACK_AUTOMATION_AUTOMERGE[^\n]*(?:기본 꺼짐|꺼진)/u);
  assert.match(header, /QA 보고 뒤[^\n]*설정 변경/u);
  assert.equal(AUTOMATION_AUTOMERGE_VARIABLE, "DATAPACK_AUTOMATION_AUTOMERGE");
  assert.doesNotMatch(code, /gh variable|gh api[^\n]*actions\/variables/u);
});

test("트리거는 CI 완료(workflow_run) 하나다. pull_request_target·push·schedule·dispatch가 없다", () => {
  assert.deepEqual(workflow.on, {
    workflow_run: {
      workflows: ["CI"],
      types: ["completed"],
    },
  });
  assert.doesNotMatch(code, /pull_request_target/u);
});

test("job은 변수가 true이고 같은 저장소의 automation/ 브랜치 PR CI 완료일 때만 돌고(재실행될 첫 시도 실패는 제외, #1115) 권한은 job에만 있다", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.equal(Object.keys(workflow.jobs).length, 1);
  assert.deepEqual(job.permissions, {
    actions: "read",
    checks: "read",
    contents: "read",
    issues: "write",
    "pull-requests": "read",
  });
  assert.equal(
    job.if,
    "${{ vars.DATAPACK_AUTOMATION_AUTOMERGE == 'true' && github.event.workflow_run.event == 'pull_request' && startsWith(github.event.workflow_run.head_branch, 'automation/') && github.event.workflow_run.head_repository.full_name == github.repository && !(vars.DATAPACK_AUTOMATION_CI_RERUN == 'true' && github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.run_attempt == 1) }}",
  );
  assert.equal(job.name, "Automation PR automerge");
  assert.deepEqual(workflow.concurrency, {
    group: "automation-pr-automerge-${{ github.event.workflow_run.head_branch }}",
    "cancel-in-progress": false,
  });
});

test("PR 코드를 checkout하거나 실행하지 않는다. checkout은 기본 브랜치 코드뿐이다", () => {
  const checkouts = steps().filter(({ uses }) => uses?.startsWith("actions/checkout@"));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.deepEqual(checkouts[0].with, { "persist-credentials": "false" });
  for (const forbidden of [/head_sha[^\n]*checkout/u, /refs\/pull/u, /pull_request\.head/u, /head\.ref/u, /\n\s+ref: /u, /actions\/download-artifact/u, /npm (?:ci|install)/u, /\bpnpm\b|\byarn\b/u]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  // 실행하는 코드는 이 저장소 기본 브랜치의 판정 모듈 하나다.
  const nodes = [...code.matchAll(/node (\S+)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(nodes)], ["tools/ci/automation-pr-policy.mjs", "tools/ci/report-refresh-failure.mjs"]);
});

test("run 스크립트에는 표현식을 펼치지 않는다. 값은 env로 받아 셸 변수로만 쓴다", () => {
  assertNoExpressionInRunScripts({ steps, file: FILE });
  const decision = step("Decide whether the pull request may enter the merge queue");
  assert.equal(decision.id, "decision");
  assert.deepEqual(decision.env, {
    GH_TOKEN: "${{ github.token }}",
    HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
    RUN_CONCLUSION: "${{ github.event.workflow_run.conclusion }}",
    RUN_ID: "${{ github.event.workflow_run.id }}",
  });
  assert.ok(decision.run.includes('node tools/ci/automation-pr-policy.mjs decide --repository "${GITHUB_REPOSITORY}" --head-sha "${HEAD_SHA}" --run-conclusion "${RUN_CONCLUSION}" --run-id "${RUN_ID}" --github-output "${GITHUB_OUTPUT}"'));
});

test("쓰기 토큰은 App 설치 토큰 하나이고 pull_requests: write로만 받아 승인 step에서만 쓴다", () => {
  const all = steps();
  const mint = all.filter(({ uses }) => uses === APP_TOKEN_ACTION);
  assert.equal(mint.length, 1);
  assert.equal(ifCondition(mint[0]), ELIGIBLE);
  assert.equal(mint[0].id, "app-token");
  assert.deepEqual(mint[0].with, {
    "client-id": "${{ secrets.EASYSUBWAY_RELEASE_APP_CLIENT_ID }}",
    "private-key": "${{ secrets.EASYSUBWAY_RELEASE_APP_PRIVATE_KEY }}",
    owner: "AquilaXk",
    repositories: "easysubway-data",
    "permission-pull-requests": "write",
  });
  // secrets는 App 자격 둘뿐이고 그 step에서만 읽는다.
  assert.deepEqual([...new Set([...code.matchAll(/secrets\.(\w+)/gu)].map((match) => match[1]))].sort(), ["EASYSUBWAY_RELEASE_APP_CLIENT_ID", "EASYSUBWAY_RELEASE_APP_PRIVATE_KEY"]);
  assert.equal(code.split("secrets.").length - 1, 2);
  // 설치 토큰은 승인 step의 GH_TOKEN으로만 흐른다.
  const uses = all.filter(({ block }) => block.includes("steps.app-token.outputs.token"));
  assert.deepEqual(uses.map(({ name }) => name), ["Record the policy attestation, mark ready and apply the automerge label"]);
  assert.equal(code.split("steps.app-token.outputs.token").length - 1, 1);
  // 나머지 step의 GH_TOKEN은 github.token이다.
  for (const { name, env } of all) {
    if (uses.some((item) => item.name === name)) continue;
    if (env.GH_TOKEN !== undefined) {
      assert.equal(env.GH_TOKEN, "${{ github.token }}", name);
    }
  }
});

test("승인 step은 판정이 ELIGIBLE일 때만 기록 -> ready -> 라벨 순서로 쓰고 병합·base 갱신·PR 생성은 하지 않는다", () => {
  const all = steps();
  const names = all.map(({ name }) => name);
  assert.ok(names.indexOf("Decide whether the pull request may enter the merge queue") < names.indexOf("Mint App token for the automerge approval"));
  const apply = step("Record the policy attestation, mark ready and apply the automerge label");
  assert.equal(ifCondition(apply), ELIGIBLE);
  assert.ok(names.indexOf("Mint App token for the automerge approval") < names.indexOf(apply.name));
  assert.deepEqual(apply.env, {
    PULL_REQUEST: "${{ steps.decision.outputs.pull_request }}",
    HEAD_SHA: "${{ steps.decision.outputs.head_sha }}",
    EVIDENCE_SHA256: "${{ steps.decision.outputs.evidence_sha256 }}",
    DRAFT: "${{ steps.decision.outputs.draft }}",
    ATTESTED: "${{ steps.decision.outputs.attested }}",
    LABELED: "${{ steps.decision.outputs.labeled }}",
    GH_TOKEN: "${{ steps.app-token.outputs.token }}",
  });
  const script = apply.run;
  assert.match(script, /\[\[ "\$\{PULL_REQUEST\}" =~ \^\[1-9\]\[0-9\]\*\$ && "\$\{HEAD_SHA\}" =~ \^\[0-9a-f\]\{40\}\$ && "\$\{EVIDENCE_SHA256\}" =~ \^\[0-9a-f\]\{64\}\$ \]\]/u);
  const record = script.indexOf('gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${PULL_REQUEST}/comments" -f body="${marker}"');
  const ready = script.indexOf('gh pr ready "${PULL_REQUEST}" --repo "${GITHUB_REPOSITORY}"');
  const label = script.indexOf('gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${PULL_REQUEST}/labels" -f "labels[]=automerge"');
  assert.ok(record !== -1 && ready !== -1 && label !== -1 && record < ready && ready < label, "attestation, ready, label in that order");
  assert.ok(script.includes(`marker="${automationAttestationMarker("0".repeat(40), "1".repeat(64)).replace("0".repeat(40), "${HEAD_SHA}").replace("1".repeat(64), "${EVIDENCE_SHA256}")}"`));
  assert.equal(AUTOMATION_AUTOMERGE_LABEL, "automerge");
  for (const forbidden of [/gh pr merge/u, /update-branch/u, /gh pr create/u, /--admin/u, /--add-label/u, /gh workflow run/u, /gh pr close|gh pr reopen/u]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  // 이미 한 일은 다시 하지 않는다(멱등).
  assert.match(script, /if \[\[ "\$\{ATTESTED\}" != "true" \]\]; then/u);
  assert.match(script, /if \[\[ "\$\{DRAFT\}" == "true" \]\]; then/u);
  assert.match(script, /if \[\[ "\$\{LABELED\}" != "true" \]\]; then/u);
});

test("조건이 어긋나면 job이 실패하고 마지막 step이 #926 경로(report-refresh-failure)로 이슈를 연다", () => {
  assertFailureReportLast({ yml, step, file: FILE });
  assert.ok(Object.hasOwn(REFRESH_WORKFLOWS, FILE));
  // 판정 step은 위반을 종료 코드로 드러낸다. 실패를 덮는 옵션이 없다.
  assert.doesNotMatch(code, /continue-on-error|\|\| true|\|\| exit 0/u);
});

// ---------------------------------------------------------------------------
// CI의 게이트 재계산 job
// ---------------------------------------------------------------------------
const gatesJob = ciWorkflow.jobs.automation_pr_gates;
const gatesJobRaw = /\n  automation_pr_gates:\n([\s\S]*?)(?=\n  [a-z_0-9]+:\n|\s*$)/u.exec(ciCode)?.[0] ?? "";

test("CI는 automation/ 브랜치 PR에서만 게이트 재계산 job을 돌리고 이름이 라벨러가 읽는 context와 같다", () => {
  assert.ok(gatesJob, "automation_pr_gates job");
  assert.equal(gatesJob.name, AUTOMATION_PR_GATES_CONTEXT);
  assert.equal(
    gatesJob.if,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.event.pull_request.head.ref, 'automation/') }}",
  );
  assert.deepEqual(gatesJob.permissions, {
    contents: "read",
    "pull-requests": "read",
  });
  assert.equal(gatesJob.runsOn, "ubuntu-latest");
  assert.doesNotMatch(gatesJobRaw, /secrets\.|id-token|\bwrite\b/u);
});

test("게이트 재계산은 PR head 작업 트리에서 읽기 전용으로 돌고 Data contracts의 판정을 바꾸지 않는다", () => {
  const jobSteps = gatesJob.steps;
  assert.equal(jobSteps[0].uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.deepEqual(jobSteps[0].with, {
    ref: "${{ github.event.pull_request.head.sha }}",
    "persist-credentials": "false",
  });
  assertNoExpressionInRunScripts({ steps: () => jobSteps, file: "ci.yml automation_pr_gates" });
  const names = jobSteps.map(({ name }) => name);
  assert.deepEqual(names, [
    "Checkout repository",
    "Set up Node.js",
    "Classify the automation pull request",
    "Fetch the evidence base commit",
    "Recompute the ledger, ITX promotion and candidate gates on the pull request head",
    "Upload the evidence digest the gates saw",
  ]);
  const classify = jobSteps[2];
  assert.ok(classify.run.includes('node tools/ci/automation-pr-policy.mjs prepare --pull-request "${pull_file}" --github-output "${GITHUB_OUTPUT}"'));
  const fetch = jobSteps[3];
  assert.equal(fetch.if, "${{ steps.classify.outputs.applicable == 'true' }}");
  assert.ok(fetch.run.includes('[[ "${BASE_SHA}" =~ ^[0-9a-f]{40}$ ]]'));
  assert.ok(fetch.run.includes('git fetch --no-tags --depth=1 origin "${BASE_SHA}"'));
  const gates = jobSteps[4];
  assert.equal(gates.if, "${{ steps.classify.outputs.applicable == 'true' }}");
  assert.ok(gates.run.includes('node tools/ci/automation-pr-policy.mjs gates --pull-request "${PULL_FILE}" --repository-root "${GITHUB_WORKSPACE}" --digest-output "${RUNNER_TEMP}/evidence-digest.json"'));
  // #986 F3: 게이트가 본 증거 블록의 digest를 artifact로 남긴다(읽기 전용 토큰으로 올린다). 라벨러가 현재 본문과 대조한다.
  const upload = jobSteps[5];
  assert.equal(upload.if, "${{ steps.classify.outputs.applicable == 'true' }}");
  assert.equal(upload.uses, "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
  assert.deepEqual(upload.with, {
    name: "automation-pr-evidence",
    path: "${{ runner.temp }}/evidence-digest.json",
    overwrite: "true",
    "if-no-files-found": "error",
    "retention-days": "7",
  });
  // 이 check는 ruleset의 required가 아니다. required 집계(Data contracts)가 이 job을 기다리지 않는다.
  assert.deepEqual(ciWorkflow.jobs.contracts.needs, [
    "contracts_mobile_v19",
    "contracts_shard_1",
    "contracts_shard_2",
    "contracts_shard_3",
    "contracts_shard_4",
  ]);
});

// ---------------------------------------------------------------------------
// 단계 상수와 자동화 workflow의 일치
// ---------------------------------------------------------------------------
test("등록 단계 allowlist 상수는 등록 workflow가 커밋하는 두 경로(원장·inventory)와 같고 governance·SLA는 커밋하지 않는다(#989)", () => {
  const registration = readFileSync(path.join(root, ".github/workflows/current-capital-topology-registration.yml"), "utf8");
  const expected = /\n\s+expected=\(([^)]*)\)\n/u.exec(registration)?.[1].trim().split(/\s+/u);
  assert.ok(expected && expected.length === 2);
  assert.deepEqual([...REGISTRATION_ALLOWED_PATHS].sort(), [...expected].sort());
  // governance·SLA는 재등록이 바꾸지 않는다. 바뀌어 있으면 workflow가 REGISTRATION_POLICY_CHANGED로 실패한다(사람 경로).
  for (const policy of ["release/product-gates/datapack-freshness-sla.json", "tools/datapack/source-governance-policy.json"]) {
    assert.ok(!expected.includes(policy), policy);
    assert.ok(registration.includes(policy), `${policy} is checked`);
  }
  assert.match(registration, /REGISTRATION_POLICY_CHANGED/u);
});

test("단계별 claim 접두사는 각 workflow가 실제로 push하는 브랜치와 같고 정책은 그 접두사만 인정한다", () => {
  assert.deepEqual(Object.keys(AUTOMATION_STAGE_WORKFLOWS).sort(), [
    "candidate-refresh", "capital-topology-refresh", "derivative-rebinding", "gwangju-timetable-refresh", "itx-promotion", "kric-facility-refresh", "registration", "seoul-accessibility-refresh", "source-reverification",
  ]);
  for (const [stage, workflow] of Object.entries(AUTOMATION_STAGE_WORKFLOWS)) {
    const text = readFileSync(path.join(root, ".github/workflows", workflow), "utf8");
    assert.ok(text.includes(`${AUTOMATION_STAGE_PREFIXES[stage]}\${GITHUB_RUN_ID}`), `${workflow} pushes ${AUTOMATION_STAGE_PREFIXES[stage]}<run id>`);
    // 이 단계 workflow가 PR 본문에 증거 블록을 싣는다.
    // 정기 갱신 4종(#1012)은 emitter(refresh-automation-pr)가 같은 일을 한다.
    assert.match(text, new RegExp(String.raw`automation-pr-evidence\.mjs (?:registration-body|derivative-rebinding-body|itx-promotion-body|candidate-refresh-block|source-reverification-body)|refresh-automation-pr\.mjs body --stage ${stage}\b`, "u"), workflow);
  }
});

test("자동화 PR을 만드는 단계 workflow는 PR을 draft로 열고 라벨러가 ready로 바꾼다", () => {
  for (const workflow of Object.values(AUTOMATION_STAGE_WORKFLOWS)) {
    const text = readFileSync(path.join(root, ".github/workflows", workflow), "utf8");
    assert.match(text, /gh pr create --repo "\$\{GITHUB_REPOSITORY\}" --draft /u, workflow);
  }
});
