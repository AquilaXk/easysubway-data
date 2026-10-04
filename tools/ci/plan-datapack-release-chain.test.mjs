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

async function releaseRepository(mutate = (files) => files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-chain-"));
  const spec = {
    candidateId: "nationwide-candidate-20261004-seq127",
    productionScopeId: "nationwide_routing_android_v1",
    releaseSequence: 127,
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
    releaseSequence: "127", requestedBy: "data-operator-lead", approvedBy: "data-release-authority", committedBuildSpec: committedSpec, now,
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
      releaseSequence, requestedBy: "a", approvedBy: "b", committedBuildSpec: committedSpec, now,
    }), /CANDIDATE_REFRESH_RELEASE_SEQUENCE/u, releaseSequence);
  }
});

test("candidate refresh plan keeps the two-person rule and rejects unsafe role tokens", () => {
  assert.throws(() => planNationwideCandidateRefresh({
    releaseSequence: "127", requestedBy: "Data-Lead", approvedBy: "data-lead", committedBuildSpec: committedSpec, now,
  }), /CANDIDATE_REFRESH_TWO_PERSON_RULE/u);
  for (const role of ["", "a b", "a\nb", "$(id)", "-flag", "x".repeat(65)]) {
    assert.throws(() => planNationwideCandidateRefresh({
      releaseSequence: "127", requestedBy: role, approvedBy: "data-release-authority", committedBuildSpec: committedSpec, now,
    }), /CANDIDATE_REFRESH_ROLE/u, JSON.stringify(role));
  }
});

test("candidate refresh plan only advances the nationwide candidate", () => {
  assert.throws(() => planNationwideCandidateRefresh({
    releaseSequence: "127", requestedBy: "a", approvedBy: "b",
    committedBuildSpec: { ...committedSpec, productionScopeId: "capital_pilot_android_v1" }, now,
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
        "--approved-by", "data-release-authority", "--github-output", githubOutput],
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

test("committed release candidate files produce the modeArgs of the last manual RC dispatch (run 37109648483)", async () => {
  const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const request = JSON.parse(await readFile(path.join(repositoryRoot, RELEASE_CANDIDATE_PATHS.releaseRequestPath), "utf8"));
  const modeArgs = await readReleaseCandidateModeArgs({ repositoryRoot });
  assert.equal(modeArgs.releaseRequestId, request.approvalId);
  assert.deepEqual(Object.keys(modeArgs), [
    "buildSpecPath", "releaseRequestId", "releaseRequestPath", "androidEvidencePath",
    "strictRouteRegressionPath", "allowGaps", "sourceGovernanceEvaluationAt",
  ]);
});

test("nationwide candidate refresh workflow runs in CI on main and opens one automation PR with required CI", () => {
  const yml = workflowText("nationwide-candidate-refresh.yml");
  assert.match(yml, /^on:\n  workflow_dispatch:\n    inputs:\n/mu);
  for (const input of ["releaseSequence", "requestedBy", "approvedBy"]) {
    assert.match(yml, new RegExp(`\\n      ${input}:\\n[\\s\\S]*?required: true\\n        type: string\\n`, "u"));
  }
  assert.doesNotMatch(yml, /\n  (schedule|push|pull_request):/u);
  assert.match(yml, /\npermissions:\n  actions: write\n  contents: write\n  pull-requests: write\n/u);
  assert.match(yml, /if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/u);
  assert.match(yml, /cancel-in-progress: false/u);
  assert.match(yml, /persist-credentials: false/u);
  // dispatch 입력은 env로만 run에 들어간다(셸 주입 차단).
  for (const block of yml.split("\n      - name: ").slice(1)) {
    const run = block.split("\n        run: ")[1] ?? "";
    assert.doesNotMatch(run, /\$\{\{\s*(inputs|github\.event\.inputs)\./u);
  }
  const plan = stepBody(yml, "Validate candidate refresh inputs");
  assert.match(plan, /node tools\/ci\/plan-datapack-release-chain\.mjs candidate-refresh --release-sequence "\$\{RELEASE_SEQUENCE\}" --requested-by "\$\{REQUESTED_BY\}" --approved-by "\$\{APPROVED_BY\}" --github-output "\$\{GITHUB_OUTPUT\}"/u);
  const refresh = stepBody(yml, "Refresh nationwide candidate");
  assert.match(refresh, /node tools\/datapack\/refresh-nationwide-candidate\.mjs --evaluated-at "\$\{EVALUATED_AT\}" --release-sequence "\$\{RELEASE_SEQUENCE\}" --requested-by "\$\{REQUESTED_BY\}" --approved-by "\$\{APPROVED_BY\}"/u);
  assert.match(refresh, /EVALUATED_AT: \$\{\{ steps\.plan\.outputs\.evaluated_at \}\}/u);
  const commit = stepBody(yml, "Commit refreshed candidate outputs");
  assert.match(commit, /NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS/u);
  assert.match(commit, /git add -- "\$\{outputs\[@\]\}"/u);
  assert.match(commit, /candidate refresh changed a path outside its outputs/u);
  assert.match(commit, /candidate refresh produced no change/u);
  assert.match(commit, /automation\/927-nationwide-candidate-refresh-\$\{GITHUB_RUN_ID\}/u);
  assert.doesNotMatch(commit, /git add (-A|--all|\.)(\s|$)/u);
  const pr = stepBody(yml, "Create candidate refresh pull request");
  assert.match(pr, /gh pr create --repo "\$\{GITHUB_REPOSITORY\}" --draft --base main --head "\$\{CANDIDATE_BRANCH\}"/u);
  const ci = stepBody(yml, "Run required CI on the candidate refresh head");
  assert.match(ci, /gh workflow run ci\.yml --repo "\$\{GITHUB_REPOSITORY\}" --ref "\$\{CANDIDATE_BRANCH\}"/u);
  assert.ok(yml.indexOf("Validate candidate refresh inputs") < yml.indexOf("Refresh nationwide candidate"));
  assert.ok(yml.indexOf("Refresh nationwide candidate") < yml.indexOf("Commit refreshed candidate outputs"));
  assert.ok(yml.indexOf("Create candidate refresh pull request") < yml.indexOf("Run required CI on the candidate refresh head"));
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
  assert.match(plan, /node tools\/ci\/plan-datapack-release-chain\.mjs release-candidate-mode-args --output "\$\{RUNNER_TEMP\}\/release-candidate-mode-args\.json"/u);
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
