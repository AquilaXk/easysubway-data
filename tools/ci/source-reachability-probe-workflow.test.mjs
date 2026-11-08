import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// hub easysubway#3036: 미국 호스티드 러너 도달성 측정 workflow는 읽기 전용이고 한시적이다.
// 서울 k3s와 같은 스크립트를 platform의 고정 커밋에서 받아 쓰고, 비밀·환경·쓰기 권한이 없다.
const root = path.resolve(import.meta.dirname, "../..");
const PLATFORM_PROBE_SCRIPT_REL_PATH = "tools/ops/source-reachability-probe.mjs";
const PINNED_PLATFORM_PROBE_REF = "e158262aa37608b1014bc1689c67ec7fa9fff36c";
const PINNED_PLATFORM_PROBE_SHA256 = "7d51e0cf8540a3e0919a8515e7336d502cdba13862f44fe1e0791002b045198a";
const { yml, workflow, job, steps, step } = loadWorkflow(root, "source-reachability-probe.yml");

function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

function parseWorkflowProbePins() {
  const ref = step("Checkout the shared probe script").with.ref;
  const expectedSha256 = step("Verify the shared probe script digest").env.EXPECTED_SHA256;
  assert.match(ref, /^[0-9a-f]{40}$/u, "Checkout step declares 40-char commit ref");
  assert.match(expectedSha256, /^[0-9a-f]{64}$/u, "Verify step declares 64-char EXPECTED_SHA256");
  return { ref, expectedSha256 };
}

test("정기(매시)와 사람 dispatch로만 시작하고 push·PR 트리거가 없다", () => {
  assert.deepEqual(workflow.on, {
    schedule: [{ cron: "7 * * * *" }],
    workflow_dispatch: {},
  });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(job.if, "${{ github.event_name == 'workflow_dispatch' || vars.SOURCE_REACHABILITY_PROBE == 'true' }}");
});

test("GitHub 호스티드 ubuntu-latest에서 서울 이미지와 같은 Node 24.19.0 빌드로 돈다", () => {
  assert.equal(job.runsOn, "ubuntu-latest");
  assert.deepEqual(Object.keys(workflow.jobs), ["probe"]);
  assert.doesNotMatch(yml, /self-hosted/u);
  // 서울 CronJob 이미지(platform deploy 도구의 node:24.19.0-alpine)와 같은 Node 빌드여야 TLS·DNS 스택이 같다.
  assert.deepEqual(step("actions/setup-node").with, { "node-version": "24.19.0" });
});

test("권한은 job의 contents: read뿐이고 비밀·환경·쓰기 도구가 없다", () => {
  assert.deepEqual(job.permissions, {
    contents: "read",
  });
  assert.equal(job.environment, null);
  assert.doesNotMatch(yml, /secrets\.|environment:|GH_TOKEN|GITHUB_TOKEN|gh pr|gh issue|gh api|git push|git commit|persist-credentials: true/u);
  for (const item of job.steps.filter(({ uses }) => uses !== null)) {
    assert.match(item.uses, /@[0-9a-f]{40}$/u, item.uses);
  }
});

test("측정 스크립트는 platform의 고정 커밋에서 그 파일 하나만 받는다", () => {
  const checkout = step("Checkout the shared probe script");
  assert.equal(checkout.with.repository, "AquilaXk/easysubway-platform");
  assert.match(checkout.with.ref, /^[0-9a-f]{40}$/u);
  assert.equal(checkout.with.path, "platform-probe");
  assert.equal(checkout.with["sparse-checkout"], "tools/ops/source-reachability-probe.mjs");
  assert.equal(checkout.with["sparse-checkout-cone-mode"], "false");
  assert.equal(checkout.with["persist-credentials"], "false");
});

test("측정은 벽시계 10분 경계에 맞춘 6라운드이고 첫 경계 대기까지 포함해 timeout 안에 끝난다(호스트당 요청은 10분에 1회)", () => {
  const probe = step("Probe source reachability from this runner");
  const match = /--vantage gha-us-hosted --rounds (\d+) --interval-seconds (\d+) --align --output "\$\{RUNNER_TEMP\}\/gha-us-hosted-probe\.jsonl"/u.exec(probe.run);
  assert.ok(match, "--align으로 라운드를 실제 시계 경계에 맞춘다");
  const [rounds, intervalSeconds] = [Number(match[1]), Number(match[2])];
  assert.equal(intervalSeconds, 600);
  const timeoutMinutes = job.timeoutMinutes;
  // 최악: 첫 경계까지 한 간격을 기다린 뒤 (rounds-1)번 더 기다린다.
  assert.ok((rounds * intervalSeconds) / 60 <= timeoutMinutes, "첫 경계 대기와 마지막 라운드까지 timeout 안이다");
  assert.ok(timeoutMinutes <= 60, "다음 정기 실행과 겹치지 않는다");
  assert.deepEqual(
    workflow.concurrency,
    {
      group: "source-reachability-probe",
      "cancel-in-progress": false,
    },
    "늦은 실행은 직렬화하고 취소하지 않는다",
  );
});

test("받은 스크립트의 SHA-256을 기대값과 대조하고 다르면 측정 전에 실패한다", () => {
  const names = steps().map(({ name }) => name);
  assert.ok(names.indexOf("Verify the shared probe script digest") > names.indexOf("Checkout the shared probe script"));
  assert.ok(names.indexOf("Verify the shared probe script digest") < names.indexOf("Probe source reachability from this runner"));
  const verify = step("Verify the shared probe script digest");
  assert.match(verify.env.EXPECTED_SHA256, /^[0-9a-f]{64}$/u);
  assert.ok(verify.run.includes('echo "${EXPECTED_SHA256}  platform-probe/tools/ops/source-reachability-probe.mjs" | sha256sum --check --strict'));
  assert.ok(verify.run.includes("set -euo pipefail"));
});

test("workflow의 ref·EXPECTED_SHA256은 고정 계약 핀 및 platform 스크립트·서울 k3s ConfigMap 해시와 정확히 일치한다", async () => {
  const { ref, expectedSha256 } = parseWorkflowProbePins();
  assert.equal(ref, PINNED_PLATFORM_PROBE_REF);
  assert.equal(expectedSha256, PINNED_PLATFORM_PROBE_SHA256);

  const platformRoot = path.resolve(root, "../easysubway-platform");
  const platformProbePath = path.join(platformRoot, PLATFORM_PROBE_SCRIPT_REL_PATH);
  if (!existsSync(platformProbePath)) return;

  const pinnedBlob = execFileSync("git", ["-C", platformRoot, "show", `${ref}:${PLATFORM_PROBE_SCRIPT_REL_PATH}`]);
  assert.equal(sha256Hex(pinnedBlob), expectedSha256, "platform <ref>:tools/ops/source-reachability-probe.mjs matches EXPECTED_SHA256");

  const originMainBlob = execFileSync("git", ["-C", platformRoot, "show", `origin/main:${PLATFORM_PROBE_SCRIPT_REL_PATH}`]);
  assert.equal(sha256Hex(originMainBlob), expectedSha256, "platform origin/main:tools/ops/source-reachability-probe.mjs matches EXPECTED_SHA256");

  const deployModuleUrl = pathToFileURL(path.join(platformRoot, "tools/platform/deploy-source-reachability-probe.mjs")).href;
  const { probeScriptSha256, readProbeScript, renderSourceReachabilityProbe } = await import(deployModuleUrl);
  const scriptBytes = readProbeScript();
  assert.equal(probeScriptSha256(scriptBytes), expectedSha256);
  const { objects } = renderSourceReachabilityProbe({ scriptBytes });
  assert.equal(sha256Hex(objects.configMap.data["source-reachability-probe.mjs"]), expectedSha256);
});

test("run 스크립트에 표현식을 직접 넣지 않고 요약·artifact는 측정이 중간에 끝나도 남긴다", () => {
  for (const { name, run } of steps()) {
    assert.doesNotMatch(run, /\$\{\{/u, name);
  }
  assert.equal(step("Summarize the measurements").if, "${{ always() }}");
  const upload = step("Upload the measurements");
  assert.equal(upload.if, "${{ always() }}");
  assert.equal(upload.with.name, "source-reachability-gha-us-hosted-${{ github.run_id }}");
  assert.equal(upload.with["retention-days"], "30");
  assert.equal(job.steps.at(-1)?.name, upload.name);
});
