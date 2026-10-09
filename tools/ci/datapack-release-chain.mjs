#!/usr/bin/env node
// 데이터팩 RC 이후 체인(호환성 → 승격 → 발행 → 배포 → 검증 → 롤백)의 판정과 실행(data#1084, #870).
// - 판정(run-name 해석, 활성 release 선택, backend 단조성, artifact digest 검증)은 순수 함수다.
// - GitHub 호출은 주입 가능한 gh 객체({ api, dispatch, cancel })로만 한다. 테스트는 가짜 GitHub로 모든 분기를 고정한다.
// - 모든 단계는 fail-closed다: 알 수 없거나 어긋나면 추정하지 않고 ChainError(코드)로 멈춘다. 실패를 성공·옛 값으로 덮지 않는다.
// - 토큰은 호출마다 명시적으로 넘기고(저장소별 최소 권한), 로그·상태 파일에 남기지 않는다.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { readProductionPublishModeArgs } from "./plan-datapack-release-chain.mjs";

export const RELEASE_CHAIN_APP = "easysubway-release-chain[bot]";
export const REPOSITORIES = Object.freeze({
  hub: "AquilaXk/easysubway",
  data: "AquilaXk/easysubway-data",
  platform: "AquilaXk/easysubway-platform",
  backend: "AquilaXk/easysubway-backend",
});
export const PROMOTION_ISSUE_REF = "AquilaXk/easysubway#2705";
export const RC_RUN_NAME = "Data Pack Release (release-candidate)";
export const PUBLISH_RUN_NAME = "Data Pack Release (production-publish)";
export const MIN_MANIFEST_REMAINING_SECONDS = 12 * 3600;
const MAX_HUB_ATTEMPTS = 3;
const DEPLOY_WORKFLOW = "source-free-journey-k3s-deploy.yml";
const BACKEND_WORKFLOW_PATH = ".github/workflows/release-artifacts.yml";

export class ChainError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ChainError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new ChainError(code, detail);
}

const NOT_STARTED = new Set(["queued", "waiting", "pending", "requested"]);
const SHA = /^[0-9a-f]{40}$/u;
const DECIMAL = /^[1-9]\d{0,19}$/u;
const DIGEST = /^sha256:([0-9a-f]{64})$/u;
const DEPLOY_RUN_NAME = /^(PREVIEW|DEPLOY) backend=([1-9]\d*)\/([1-9]\d*) data=([1-9]\d*)\/([1-9]\d*)$/u;

// ---------- 순수 판정 ----------

export function parseDeployRunName(title) {
  if (typeof title !== "string") return null;
  const match = DEPLOY_RUN_NAME.exec(title);
  if (!match) return null;
  return { mode: match[1], backendRunId: match[2], backendArtifactId: match[3], dataRunId: match[4], dataArtifactId: match[5] };
}

export function formatDeployRunName(mode, ids) {
  if (!["PREVIEW", "DEPLOY"].includes(mode)) fail("DEPLOY_INPUT_INVALID", `invalid deploy mode ${String(mode)}`);
  for (const key of ["backendRunId", "backendArtifactId", "dataRunId", "dataArtifactId"]) {
    if (typeof ids?.[key] !== "string" || !DECIMAL.test(ids[key])) fail("DEPLOY_INPUT_INVALID", `invalid deploy id ${key}`);
  }
  return `${mode} backend=${ids.backendRunId}/${ids.backendArtifactId} data=${ids.dataRunId}/${ids.dataArtifactId}`;
}

function idsOf(inputs) {
  return {
    backendRunId: inputs.backend_run_id, backendArtifactId: inputs.backend_artifact_id,
    dataRunId: inputs.data_run_id, dataArtifactId: inputs.data_artifact_id,
  };
}

const byNewest = (left, right) => {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1;
  return right.id - left.id;
};

// 직전 활성 release = 가장 최근 DEPLOY run의 run-name. 기억이나 추정이 아니라 이 조회가 정본이다.
export function selectActiveRelease(runs) {
  if (!Array.isArray(runs)) fail("ACTIVE_RELEASE_UNKNOWN", "deploy run list is not an array");
  if (runs.some((run) => run?.status !== "completed")) fail("DEPLOY_IN_FLIGHT", "a deploy run is queued or running");
  for (const run of [...runs].sort(byNewest)) {
    if (run.event !== "workflow_dispatch" || run.head_branch !== "main") {
      fail("ACTIVE_RELEASE_UNCERTAIN", `deploy run ${run.id} is not a main workflow_dispatch run`);
    }
    const parsed = parseDeployRunName(run.display_title);
    if (parsed === null) fail("ACTIVE_RELEASE_UNCERTAIN", `deploy run ${run.id} has no machine-readable run name`);
    if (parsed.mode !== "DEPLOY") continue;
    if (run.conclusion !== "success") fail("ACTIVE_RELEASE_UNCERTAIN", `the latest deploy run ${run.id} concluded ${String(run.conclusion)}`);
    const { mode, ...ids } = parsed;
    return { runId: run.id, ...ids };
  }
  return fail("ACTIVE_RELEASE_UNKNOWN", "no completed deploy run records its inputs");
}

export function selectBackendProducerRun(runs) {
  const eligible = (Array.isArray(runs) ? runs : []).filter((run) => run?.status === "completed"
    && run.conclusion === "success" && run.head_branch === "main"
    && (run.event === "push" || run.event === "workflow_dispatch")
    && String(run.path ?? "").split("@")[0] === BACKEND_WORKFLOW_PATH
    && SHA.test(run.head_sha ?? "") && Number.isSafeInteger(run.run_attempt));
  if (eligible.length === 0) fail("BACKEND_PRODUCER_NOT_FOUND", "no successful backend main producer run");
  return [...eligible].sort(byNewest)[0];
}

export function requireReleaseArtifact(listing, { name, runId }) {
  const invalid = (detail) => fail("ARTIFACT_INVALID", `${name}: ${detail}`);
  if (!listing || !Number.isSafeInteger(listing.total_count) || !Array.isArray(listing.artifacts)
    || listing.total_count !== listing.artifacts.length || listing.artifacts.length !== 1) invalid("exactly one artifact is required");
  const [item] = listing.artifacts;
  if (item.name !== name) invalid("name mismatch");
  if (!Number.isSafeInteger(item.id) || item.id < 1) invalid("id is invalid");
  if (item.expired !== false) invalid("artifact is expired");
  if (Number(item.workflow_run?.id) !== Number(runId)) invalid("belongs to another run");
  const match = DIGEST.exec(typeof item.digest === "string" ? item.digest : "");
  if (!match) invalid("digest is missing or malformed");
  return { id: item.id, name: item.name, digest: item.digest, sha256: match[1] };
}

export function assertBackendNotOlder({ activeSha, candidateSha, compareStatus }) {
  if (!SHA.test(activeSha ?? "") || !SHA.test(candidateSha ?? "")) fail("BACKEND_OLDER_THAN_ACTIVE", "backend commit identity is invalid");
  if (compareStatus !== "ahead" && compareStatus !== "identical") {
    fail("BACKEND_OLDER_THAN_ACTIVE", `candidate ${candidateSha} is ${String(compareStatus)} relative to the active ${activeSha}`);
  }
}

function requireState(state, ...paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((node, key) => (node === null || typeof node !== "object" ? undefined : node[key]), state);
    if (value === undefined || value === null) fail("CHAIN_STATE_INVALID", `missing ${path}`);
  }
}

function requirePositive(value, label) {
  if (typeof value !== "string" && typeof value !== "number") fail("CHAIN_STATE_INVALID", label);
  if (!DECIMAL.test(String(value))) fail("CHAIN_STATE_INVALID", label);
  return String(value);
}

// ---------- GitHub 호출 ----------

// gh는 고정 경로의 실행 파일만 쓴다(PATH 탐색 없음). 토큰은 호출마다 명시적으로 넘기고 환경에는 HOME 외에 아무것도 상속하지 않는다.
const GH_EXECUTABLES = Object.freeze(["/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh"]);

function ghExecutable() {
  const found = GH_EXECUTABLES.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new ChainError("GH_NOT_FOUND", GH_EXECUTABLES.join(", "));
  return found;
}

function withoutTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

function execGh(args, token) {
  if (typeof token !== "string" || token === "") return Promise.reject(new ChainError("TOKEN_MISSING", "a repository token is required"));
  return new Promise((resolve, reject) => {
    const child = spawn(ghExecutable(), args, {
      env: { HOME: process.env.HOME, GH_TOKEN: token, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new ChainError("GITHUB_CALL_FAILED", `gh ${args[0]} exited ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 300)}`));
    });
  });
}

export function createGh() {
  return {
    async api(endpoint, { token }) {
      return JSON.parse(await execGh(["api", "--method", "GET", endpoint], token));
    },
    async dispatch({ repo, workflow, ref, inputs, token }) {
      const fields = Object.entries(inputs).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
      await execGh(["workflow", "run", workflow, "--repo", repo, "--ref", ref, ...fields], token);
    },
    async cancel({ repo, runId, token }) {
      await execGh(["api", "--method", "POST", `repos/${repo}/actions/runs/${runId}/cancel`], token);
    },
  };
}

async function mainSha(ctx, repo, token) {
  const ref = await ctx.gh.api(`repos/${repo}/git/ref/heads/main`, { token });
  const sha = ref?.object?.sha;
  if (!SHA.test(sha ?? "")) fail("GITHUB_RESPONSE_INVALID", `main ref of ${repo}`);
  return sha;
}

function clockOf(ctx) {
  return { now: ctx.now, sleep: ctx.sleep };
}

// 같은 workflow의 기존 run id를 기준선으로 잡고, dispatch 뒤에 새로 생긴 run 중 조건에 맞는 것이 정확히 하나일 때만 그 run으로 본다.
async function dispatchAndFind(ctx, { repo, workflow, inputs, token, match }) {
  const listPath = `repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=main&per_page=50`;
  const before = new Set(((await ctx.gh.api(listPath, { token })).workflow_runs ?? []).map((run) => run.id));
  await ctx.gh.dispatch({ repo, workflow, ref: "main", inputs, token });
  const clock = clockOf(ctx);
  const deadline = clock.now() + ctx.timeouts.discover;
  for (;;) {
    const created = ((await ctx.gh.api(listPath, { token })).workflow_runs ?? [])
      .filter((run) => !before.has(run.id) && run.event === "workflow_dispatch" && run.head_branch === "main" && match(run));
    if (created.length === 1) return created[0];
    if (created.length > 1) fail("RUN_AMBIGUOUS", `${workflow}: ${created.map((run) => run.id).join(",")}`);
    if (clock.now() >= deadline) fail("RUN_NOT_FOUND", `${repo} ${workflow}`);
    await clock.sleep(ctx.pollMs);
  }
}

async function waitForRun(ctx, { repo, runId, token, timeoutMs }) {
  const clock = clockOf(ctx);
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const run = await ctx.gh.api(`repos/${repo}/actions/runs/${runId}`, { token });
    if (run?.status === "completed") return run;
    if (clock.now() >= deadline) {
      const detail = `${repo} run ${runId} did not finish in ${Math.round(timeoutMs / 1000)}s`;
      // 시작하지 못한 run(러너 없음 등)은 나중에 갑자기 실행되지 않도록 취소한다. 이미 실행 중인 run(트래픽 전환 중인 DEPLOY 등)은 건드리지 않는다.
      if (NOT_STARTED.has(run?.status)) {
        await ctx.gh.cancel({ repo, runId, token });
        fail("RUN_TIMEOUT", `${detail}; it never started (${run.status}) and was cancelled`);
      }
      fail("RUN_TIMEOUT", `${detail}; it is still running and was left as is`);
    }
    await clock.sleep(ctx.pollMs);
  }
}

const dispatchedByChain = (run) => run.triggering_actor?.login === RELEASE_CHAIN_APP;

// ---------- 단계: hub 호환성 → 승격 ----------

export async function hubGatesStage(ctx, state) {
  requireState(state, "rc.runId", "rc.sha");
  const candidateRunId = requirePositive(state.rc.runId, "rc.runId");
  const token = ctx.tokens.hub;
  for (let attempt = 1; attempt <= MAX_HUB_ATTEMPTS; attempt += 1) {
    const compatRun = await dispatchAndFind(ctx, {
      repo: REPOSITORIES.hub, workflow: "release-artifacts.yml", token,
      inputs: { android_rc_signing_mode: "ci-self-signed", play_upload: "none", datapack_candidate_run_id: candidateRunId },
      match: dispatchedByChain,
    });
    const compat = await waitForRun(ctx, { repo: REPOSITORIES.hub, runId: compatRun.id, token, timeoutMs: ctx.timeouts.compat });
    // 취소(다른 dispatch·수동 취소)는 재시도하고, 실제 실패는 재시도하지 않는다.
    if (compat.conclusion === "cancelled") continue;
    if (compat.conclusion !== "success") fail("COMPAT_FAILED", `hub compatibility run ${compat.id} concluded ${String(compat.conclusion)}`);
    const compatName = `easysubway-datapack-compatibility-${compat.id}`;
    requireReleaseArtifact(
      await ctx.gh.api(`repos/${REPOSITORIES.hub}/actions/runs/${compat.id}/artifacts?name=${compatName}&per_page=100`, { token }),
      { name: compatName, runId: compat.id },
    );
    // 승격 run의 GITHUB_SHA는 dispatch 시점의 hub main이다. 호환성 증거와 같은 SHA여야 하므로 이동했으면 처음부터 다시 한다.
    if (compat.head_sha !== await mainSha(ctx, REPOSITORIES.hub, token)) continue;
    const promotionRun = await dispatchAndFind(ctx, {
      repo: REPOSITORIES.hub, workflow: "datapack-promotion.yml", token,
      inputs: {
        candidateRunId,
        compatibilityEvidenceRunId: String(compat.id),
        compatibilityEvidenceArtifactName: compatName,
        issueRef: PROMOTION_ISSUE_REF,
      },
      match: dispatchedByChain,
    });
    const promotion = await waitForRun(ctx, { repo: REPOSITORIES.hub, runId: promotionRun.id, token, timeoutMs: ctx.timeouts.promotion });
    if (promotion.conclusion === "success") {
      const promotionName = `easysubway-datapack-promotion-${promotion.id}`;
      requireReleaseArtifact(
        await ctx.gh.api(`repos/${REPOSITORIES.hub}/actions/runs/${promotion.id}/artifacts?name=${promotionName}&per_page=100`, { token }),
        { name: promotionName, runId: promotion.id },
      );
      return {
        ...state,
        hub: { compatRunId: compat.id, promotionRunId: promotion.id, hubSha: compat.head_sha, attempts: attempt },
      };
    }
    if (promotion.head_sha !== compat.head_sha) continue;
    fail("PROMOTION_FAILED", `hub promotion run ${promotion.id} concluded ${String(promotion.conclusion)}`);
  }
  return fail("HUB_GATES_RETRY_EXHAUSTED", `hub gates did not settle in ${MAX_HUB_ATTEMPTS} attempts`);
}

// ---------- 단계: data production 발행 ----------

export async function publishStage(ctx, state) {
  requireState(state, "rc.runId", "rc.sha", "hub.promotionRunId");
  const token = ctx.tokens.data;
  const candidateRunId = requirePositive(state.rc.runId, "rc.runId");
  const promotionRunId = requirePositive(state.hub.promotionRunId, "hub.promotionRunId");
  if (await mainSha(ctx, REPOSITORIES.data, token) !== state.rc.sha) {
    fail("CHAIN_MAIN_MOVED", `data main is no longer the release candidate commit ${state.rc.sha}`);
  }
  const modeArgs = await ctx.readModeArgs({ candidateRunId, promotionRunId });
  if (modeArgs?.candidateRunId !== candidateRunId || modeArgs?.promotionRunId !== promotionRunId) {
    fail("CHAIN_STATE_INVALID", "modeArgs do not carry the candidate and promotion run ids");
  }
  const publishRun = await dispatchAndFind(ctx, {
    repo: REPOSITORIES.data, workflow: "datapack-release.yml", token,
    inputs: { mode: "production-publish", targetChannel: "production", modeArgs: JSON.stringify(modeArgs) },
    match: (run) => run.display_title === PUBLISH_RUN_NAME,
  });
  if (publishRun.head_sha !== state.rc.sha) {
    // 검증한 커밋이 아닌 main으로 발행되려는 run은 즉시 취소한다(RC chain과 같은 규칙).
    await ctx.gh.cancel({ repo: REPOSITORIES.data, runId: publishRun.id, token });
    fail("CHAIN_MAIN_MOVED", `publish run ${publishRun.id} built ${publishRun.head_sha}, not the verified ${state.rc.sha}; the run was cancelled`);
  }
  const done = await waitForRun(ctx, { repo: REPOSITORIES.data, runId: publishRun.id, token, timeoutMs: ctx.timeouts.publish });
  if (done.conclusion !== "success") fail("PUBLISH_FAILED", `production-publish run ${done.id} concluded ${String(done.conclusion)}`);
  const finalName = `easysubway-datapacks-${done.head_sha}`;
  const finalArtifact = requireReleaseArtifact(
    await ctx.gh.api(`repos/${REPOSITORIES.data}/actions/runs/${done.id}/artifacts?name=${finalName}&per_page=100`, { token }),
    { name: finalName, runId: done.id },
  );
  const manifest = await checkPublishedManifest(ctx, ctx.expectedSequence);
  return {
    ...state,
    publish: { runId: done.id, sha: done.head_sha, releaseSequence: manifest.releaseSequence, expiresAt: manifest.expiresAt, finalArtifact },
  };
}

async function checkPublishedManifest(ctx, expectedSequence) {
  let manifest;
  try {
    manifest = await ctx.fetchJson(ctx.manifestUrl);
  } catch (error) {
    fail("PUBLISH_MANIFEST_MISMATCH", `the public manifest could not be read: ${error.message}`);
  }
  if (!Number.isSafeInteger(manifest?.releaseSequence) || manifest.releaseSequence !== expectedSequence) {
    fail("PUBLISH_MANIFEST_MISMATCH", `public releaseSequence ${String(manifest?.releaseSequence)} is not the published ${String(expectedSequence)}`);
  }
  const expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expiresAt)) fail("PUBLISH_MANIFEST_MISMATCH", "public manifest has no valid expiresAt");
  const minimum = (ctx.minManifestRemainingSeconds ?? MIN_MANIFEST_REMAINING_SECONDS) * 1000;
  if (expiresAt - ctx.now() < minimum) {
    fail("PUBLISH_MANIFEST_EXPIRING", `public manifest expires at ${manifest.expiresAt}, less than ${minimum / 3_600_000}h from now`);
  }
  return { releaseSequence: manifest.releaseSequence, expiresAt: manifest.expiresAt };
}

// ---------- 단계: 배포 입력 선택 ----------

async function previousArtifact(ctx, { repo, token, artifactId, runId, namePattern }) {
  const found = await ctx.gh.api(`repos/${repo}/actions/artifacts/${artifactId}`, { token });
  const match = DIGEST.exec(typeof found?.digest === "string" ? found.digest : "");
  if (found?.expired !== false || !match || Number(found?.workflow_run?.id) !== Number(runId)
    || !namePattern.test(found?.name ?? "") || Number(found?.id) !== Number(artifactId)) {
    fail("ROLLBACK_PATH_UNAVAILABLE", `the previous release artifact ${artifactId} of ${repo} is expired or no longer verifiable`);
  }
  return { name: found.name, sha256: match[1] };
}

export async function selectDeployInputsStage(ctx, state) {
  requireState(state, "publish.runId", "publish.finalArtifact.id", "publish.finalArtifact.name", "publish.finalArtifact.sha256");
  const platformToken = ctx.tokens.platform;
  const backendToken = ctx.tokens.backend;
  const deployRuns = await ctx.gh.api(`repos/${REPOSITORIES.platform}/actions/workflows/${DEPLOY_WORKFLOW}/runs?branch=main&per_page=100`, { token: platformToken });
  const active = selectActiveRelease(deployRuns.workflow_runs);

  const activeBackendRun = await ctx.gh.api(`repos/${REPOSITORIES.backend}/actions/runs/${active.backendRunId}`, { token: backendToken });
  if (activeBackendRun?.conclusion !== "success" || activeBackendRun.head_branch !== "main" || !SHA.test(activeBackendRun.head_sha ?? "")) {
    fail("ACTIVE_RELEASE_UNCERTAIN", `the active backend run ${active.backendRunId} is not a successful main run`);
  }
  const previousBackend = await previousArtifact(ctx, {
    repo: REPOSITORIES.backend, token: backendToken, artifactId: active.backendArtifactId, runId: active.backendRunId,
    namePattern: /^easysubway-backend-release-[0-9a-f]{40}-[1-9]\d*$/u,
  });
  const previousData = await previousArtifact(ctx, {
    repo: REPOSITORIES.data, token: ctx.tokens.data, artifactId: active.dataArtifactId, runId: active.dataRunId,
    namePattern: /^easysubway-datapacks-[0-9a-f]{40}$/u,
  });

  const producers = await ctx.gh.api(`repos/${REPOSITORIES.backend}/actions/workflows/release-artifacts.yml/runs?branch=main&status=success&per_page=30`, { token: backendToken });
  const producer = selectBackendProducerRun(producers.workflow_runs);
  const backendName = `easysubway-backend-release-${producer.head_sha}-${producer.run_attempt}`;
  const backendArtifact = requireReleaseArtifact(
    await ctx.gh.api(`repos/${REPOSITORIES.backend}/actions/runs/${producer.id}/artifacts?name=${backendName}&per_page=100`, { token: backendToken }),
    { name: backendName, runId: producer.id },
  );
  let compareStatus = "identical";
  if (producer.head_sha !== activeBackendRun.head_sha) {
    compareStatus = (await ctx.gh.api(`repos/${REPOSITORIES.backend}/compare/${activeBackendRun.head_sha}...${producer.head_sha}`, { token: backendToken })).status;
  }
  assertBackendNotOlder({ activeSha: activeBackendRun.head_sha, candidateSha: producer.head_sha, compareStatus });

  const inputs = (backendRunId, backendArtifactId, backend, dataRunId, dataArtifactId, data) => ({
    backend_run_id: String(backendRunId), backend_artifact_id: String(backendArtifactId),
    backend_artifact_name: backend.name, backend_archive_sha256: backend.sha256,
    data_run_id: String(dataRunId), data_artifact_id: String(dataArtifactId),
    data_artifact_name: data.name, data_archive_sha256: data.sha256,
  });
  return {
    ...state,
    deploy: {
      activeRunId: active.runId,
      activeBackendSha: activeBackendRun.head_sha,
      nextBackendSha: producer.head_sha,
      previous: inputs(active.backendRunId, active.backendArtifactId, previousBackend, active.dataRunId, active.dataArtifactId, previousData),
      next: inputs(producer.id, backendArtifact.id, backendArtifact, state.publish.runId, state.publish.finalArtifact.id, state.publish.finalArtifact),
    },
  };
}

// ---------- 단계: 배포 ----------

async function runDeployPair(ctx, inputs, failureCode) {
  const token = ctx.tokens.platform;
  const done = {};
  for (const mode of ["PREVIEW", "DEPLOY"]) {
    const title = formatDeployRunName(mode, idsOf(inputs));
    const run = await dispatchAndFind(ctx, {
      repo: REPOSITORIES.platform, workflow: DEPLOY_WORKFLOW, token,
      inputs: { mode, ...inputs },
      match: (candidate) => candidate.display_title === title && dispatchedByChain(candidate),
    });
    const finished = await waitForRun(ctx, {
      repo: REPOSITORIES.platform, runId: run.id, token, timeoutMs: mode === "PREVIEW" ? ctx.timeouts.preview : ctx.timeouts.deploy,
    });
    if (finished.conclusion !== "success") {
      const code = failureCode ?? `${mode}_FAILED`;
      fail(code, `${mode} run ${finished.id} concluded ${String(finished.conclusion)}`);
    }
    done[mode] = finished.id;
  }
  return done;
}

export async function deployStage(ctx, state) {
  requireState(state, "deploy.next");
  const done = await runDeployPair(ctx, state.deploy.next, null);
  return { ...state, deploy: { ...state.deploy, previewRunId: done.PREVIEW, deployRunId: done.DEPLOY, deployed: true } };
}

// ---------- 단계: 검증 ----------

async function checkReadiness(ctx, { code }) {
  const url = `${ctx.apiBaseUrl}/actuator/health/readiness`;
  for (let check = 1; check <= ctx.readinessChecks; check += 1) {
    let status;
    try {
      status = (await ctx.fetchStatus(url)).status;
    } catch (error) {
      fail(code, `readiness request ${check} failed: ${error.message}`);
    }
    if (status !== 200) fail(code, `readiness request ${check} returned ${String(status)}`);
    if (check < ctx.readinessChecks) await ctx.sleep(ctx.readinessIntervalMs);
  }
}

export async function verifyStage(ctx, state) {
  requireState(state, "publish.releaseSequence");
  await checkReadiness(ctx, { code: "VERIFY_READINESS_FAILED" });
  let manifest;
  try {
    manifest = await ctx.fetchJson(ctx.manifestUrl);
  } catch (error) {
    fail("VERIFY_MANIFEST_MISMATCH", `the public manifest could not be read: ${error.message}`);
  }
  if (!Number.isSafeInteger(manifest?.releaseSequence) || manifest.releaseSequence !== state.publish.releaseSequence) {
    fail("VERIFY_MANIFEST_MISMATCH", `public releaseSequence ${String(manifest?.releaseSequence)} is not the published ${state.publish.releaseSequence}`);
  }
  const expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expiresAt)) fail("VERIFY_MANIFEST_MISMATCH", "public manifest has no valid expiresAt");
  const minimum = (ctx.minManifestRemainingSeconds ?? MIN_MANIFEST_REMAINING_SECONDS) * 1000;
  if (expiresAt - ctx.now() < minimum) fail("VERIFY_MANIFEST_EXPIRING", `public manifest expires at ${manifest.expiresAt}`);
  return {
    ...state,
    verify: { ok: true, releaseSequence: manifest.releaseSequence, expiresAt: manifest.expiresAt, checkedAt: new Date(ctx.now()).toISOString() },
  };
}

// ---------- 단계: 롤백 (직전 활성 release의 전진 재활성화) ----------

export async function rollbackStage(ctx, state) {
  if (state?.deploy?.deployed !== true) fail("ROLLBACK_NOT_APPLICABLE", "no completed deploy to roll back");
  requireState(state, "deploy.previous");
  try {
    const done = await runDeployPair(ctx, state.deploy.previous, null);
    await checkReadiness(ctx, { code: "ROLLBACK_READINESS_FAILED" });
    return { ...state, rollback: { ok: true, previewRunId: done.PREVIEW, deployRunId: done.DEPLOY } };
  } catch (error) {
    if (error instanceof ChainError) fail("ROLLBACK_FAILED", `${error.code}: ${error.detail}`);
    throw error;
  }
}

// ---------- CLI ----------

function requiredEnv(env, name, pattern) {
  const value = env[name];
  if (typeof value !== "string" || (pattern && !pattern.test(value))) fail("CHAIN_ENV_INVALID", name);
  return value;
}

async function fetchJsonOrThrow(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchStatusOnly(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  return { status: response.status };
}

export async function buildContext(env, { repositoryRoot, gh = createGh() } = {}) {
  const tokens = {
    data: env.GH_TOKEN, hub: env.HUB_TOKEN, platform: env.PLATFORM_TOKEN, backend: env.BACKEND_TOKEN,
  };
  const publicBase = (name) => withoutTrailingSlashes(requiredEnv(env, name, /^https:\/\/[^\s/]+(\/[^\s?#]*)?$/u));
  const context = {
    gh, tokens, now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollMs: 10_000,
    timeouts: { compat: 8 * 60_000, promotion: 8 * 60_000, publish: 25 * 60_000, preview: 8 * 60_000, deploy: 12 * 60_000, discover: 120_000 },
    readinessChecks: 3, readinessIntervalMs: 30_000,
    fetchJson: fetchJsonOrThrow, fetchStatus: fetchStatusOnly,
    apiBaseUrl: env.CHAIN_API_BASE_URL ? publicBase("CHAIN_API_BASE_URL") : undefined,
    manifestUrl: env.CHAIN_DATAPACK_BASE_URL ? `${publicBase("CHAIN_DATAPACK_BASE_URL")}/catalog/current.json` : undefined,
    repositoryRoot,
  };
  context.readModeArgs = async ({ candidateRunId, promotionRunId }) => {
    const request = JSON.parse(await readFile(`${repositoryRoot}/tools/datapack/release/release-request.json`, "utf8"));
    let gateRunRecord;
    if (request.gateRun !== undefined) {
      const gateRunId = String(request.gateRun?.runId);
      if (!DECIMAL.test(gateRunId)) fail("CHAIN_STATE_INVALID", "release request gateRun runId is invalid");
      gateRunRecord = await gh.api(`repos/${REPOSITORIES.data}/actions/runs/${gateRunId}`, { token: tokens.data });
    }
    return readProductionPublishModeArgs({ repositoryRoot, gateRunRecord, candidateRunId, promotionRunId });
  };
  const buildSpec = JSON.parse(await readFile(`${repositoryRoot}/tools/datapack/release/candidate-build-spec.json`, "utf8"));
  context.expectedSequence = buildSpec.releaseSequence;
  return context;
}

async function summary(env, lines) {
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

const STAGES = Object.freeze({
  "hub-gates": hubGatesStage,
  publish: publishStage,
  "select-deploy": selectDeployInputsStage,
  deploy: deployStage,
  verify: verifyStage,
  rollback: rollbackStage,
});

// 단계별로 꼭 필요한 공개 URL. 비어 있으면 검증을 건너뛰지 않고 환경 오류로 멈춘다.
const REQUIRED_CONTEXT = Object.freeze({ publish: ["manifestUrl"], verify: ["apiBaseUrl", "manifestUrl"], rollback: ["apiBaseUrl"] });

export async function runChainStage({ stage, statePath, env = process.env, repositoryRoot = process.cwd(), gh } = {}) {
  if (stage === "plan") {
    const runId = requiredEnv(env, "RC_RUN_ID", DECIMAL);
    const sha = requiredEnv(env, "RC_RUN_SHA", SHA);
    const context = await buildContext(env, { repositoryRoot, gh });
    // 체크아웃(= workflow_run 시점의 기본 브랜치)과 원격 main이 모두 RC 커밋이어야 한다. 도구와 입력 파일이 RC와 같은 커밋에서 온다.
    if (requiredEnv(env, "GITHUB_SHA", SHA) !== sha || await mainSha(context, REPOSITORIES.data, context.tokens.data) !== sha) {
      fail("CHAIN_MAIN_MOVED", `data main is not the release candidate commit ${sha}`);
    }
    const state = { schemaVersion: 1, rc: { runId, sha }, startedAt: new Date().toISOString() };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await summary(env, [`체인 시작: RC run ${runId} (${sha})`]);
    return state;
  }
  const run = STAGES[stage];
  if (!run) fail("CHAIN_ARGUMENTS", `unknown stage ${String(stage)}`);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  try {
    const context = await buildContext(env, { repositoryRoot, gh });
    for (const key of REQUIRED_CONTEXT[stage] ?? []) {
      if (!context[key]) fail("CHAIN_ENV_INVALID", `${stage} requires ${key}`);
    }
    const next = await run(context, state);
    await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`);
    await summary(env, [`- ${stage}: 통과`]);
    return next;
  } catch (error) {
    if (error instanceof ChainError) {
      await writeFile(statePath, `${JSON.stringify({ ...state, anomaly: { stage, code: error.code, detail: error.detail } }, null, 2)}\n`);
      await summary(env, [`- ${stage}: 실패 \`${error.code}\` ${error.detail}`]);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stage, flag, statePath] = process.argv.slice(2);
  try {
    if (flag !== "--state" || typeof statePath !== "string" || statePath === "") fail("CHAIN_ARGUMENTS", "usage: datapack-release-chain.mjs <stage> --state <file>");
    await runChainStage({ stage, statePath });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
