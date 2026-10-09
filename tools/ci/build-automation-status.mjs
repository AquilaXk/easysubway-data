#!/usr/bin/env node
// admin "자동화 상태" 화면에 보낼 snapshot을 만들고 게시한다(data#1084, backend#500, QA 결정 2026-10-09: 사람은 이상이 날 때만 admin에서 확인).
// - 방식: push. 이 도구가 GitHub 상태를 읽어 snapshot JSON을 만들고 backend의 워크플로 서비스 토큰 API로 보낸다.
//   backend가 GitHub를 호출하지 않아 prod에 GitHub 토큰이 생기지 않고, 게시가 멈추면 admin이 "마지막 갱신 N분 전"으로 드러낸다.
// - 읽지 못한 값은 빈 값·옛 값으로 채우지 않는다. 한 곳이라도 조회가 실패하면 전체가 실패한다(게시 안 됨 -> admin이 낡음으로 표시).
// - 시간이 지나며 변하는 판정(만료 임박 등)은 snapshot에 넣지 않고 backend가 렌더 시각으로 계산한다.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AUTOMATION_STAGE_PREFIXES, automationStageForBranch, readPages } from "./automation-pr-policy.mjs";
import { planBehindRecreation } from "./automation-pr-recreate.mjs";
import { parseDeployRunName } from "./datapack-release-chain.mjs";

export const SNAPSHOT_MAX_BYTES = 64 * 1024;
const STUCK_PULL_AGE_HOURS = 6;
const STALE_CLAIM_AGE_HOURS = 2;
const FAILURE_ISSUE_LIMIT = 20;
const FAILURE_TITLE = "원천 자동 갱신 실패";
const BOT_LOGINS = new Set(["app/github-actions", "github-actions[bot]"]);
const IN_FLIGHT_STAGES = new Set(["candidate", "rc", "compat", "promotion", "publish", "deploy"]);

export const STATUS_STAGES = Object.freeze([
  { id: "refresh", label: "원천 갱신", repository: "data", workflow: "current-capital-topology-refresh.yml" },
  { id: "registration", label: "원천 등록", repository: "data", workflow: "current-capital-topology-registration.yml" },
  { id: "reverification", label: "원천 재확인", repository: "data", workflow: "source-reverification.yml" },
  { id: "candidate", label: "후보 갱신", repository: "data", workflow: "nationwide-candidate-refresh.yml" },
  { id: "rc", label: "후보 검증(RC)", repository: "data", workflow: "datapack-release.yml", title: "Data Pack Release (release-candidate)", dispatchOnly: true },
  { id: "compat", label: "앱 호환성 검증", repository: "hub", workflow: "release-artifacts.yml", event: "workflow_dispatch", dispatchOnly: true },
  { id: "promotion", label: "승격", repository: "hub", workflow: "datapack-promotion.yml", dispatchOnly: true },
  { id: "publish", label: "발행", repository: "data", workflow: "datapack-release.yml", title: "Data Pack Release (production-publish)", dispatchOnly: true },
  { id: "deploy", label: "배포", repository: "platform", workflow: "source-free-journey-k3s-deploy.yml", deployMode: "DEPLOY", dispatchOnly: true },
]);

function statusError(code, detail = "") {
  return new Error(detail ? `STATUS_${code}: ${detail}` : `STATUS_${code}`);
}

const instant = (value) => (typeof value === "string" ? Date.parse(value) : Number.NaN);
const newest = (left, right) => (left.created_at !== right.created_at ? (left.created_at < right.created_at ? 1 : -1) : right.id - left.id);

function activeDatapackOf(manifest) {
  const published = instant(manifest?.publishedAt);
  const expires = instant(manifest?.expiresAt);
  if (!Number.isSafeInteger(manifest?.releaseSequence) || manifest.releaseSequence < 1 || !Number.isFinite(published) || !Number.isFinite(expires)) {
    throw statusError("MANIFEST_INVALID", "the public manifest has no valid releaseSequence/publishedAt/expiresAt");
  }
  return { releaseSequence: manifest.releaseSequence, publishedAt: new Date(published).toISOString(), expiresAt: new Date(expires).toISOString() };
}

function runSummary(run) {
  return { runId: run.id, url: run.html_url, status: run.status, conclusion: run.conclusion ?? null, createdAt: run.created_at, updatedAt: run.updated_at };
}

function summarizeStage(stage, runs) {
  if (!Array.isArray(runs)) throw statusError("RUNS_INVALID", stage.id);
  const matching = runs.filter((run) => (stage.title === undefined || run.display_title === stage.title)
    && (stage.event === undefined || run.event === stage.event)
    && (stage.deployMode === undefined || parseDeployRunName(run.display_title)?.mode === stage.deployMode)).sort(newest);
  const success = matching.find((run) => run.status === "completed" && run.conclusion === "success");
  return {
    id: stage.id,
    label: stage.label,
    latest: matching.length === 0 ? null : runSummary(matching[0]),
    lastSuccessAt: success === undefined ? null : success.updated_at,
    inFlight: matching.some((run) => run.status !== "completed"),
  };
}

export function buildAutomationStatus({ now, manifest, stageRuns = {}, issues = [], openPulls = [], claimRefs = [], behind = { actions: [], anomalies: [] } }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw statusError("CLOCK");
  const activeDatapack = activeDatapackOf(manifest);
  const stages = STATUS_STAGES.map((stage) => summarizeStage(stage, stageRuns[stage.id] ?? []));

  const failureIssues = issues
    .filter((issue) => typeof issue?.title === "string" && issue.title.includes(FAILURE_TITLE) && BOT_LOGINS.has(issue.author?.login))
    .sort((left, right) => right.number - left.number)
    .slice(0, FAILURE_ISSUE_LIMIT)
    .map((issue) => ({ number: issue.number, title: issue.title, url: issue.url, createdAt: issue.createdAt }));

  const behindNumbers = new Set([...behind.actions, ...behind.anomalies].map((item) => item.number));
  const automationPulls = openPulls.filter((pull) => automationStageForBranch(pull?.head?.ref) !== null);
  const pulls = [];
  for (const pull of automationPulls.sort((left, right) => left.number - right.number)) {
    const ageHours = (now.getTime() - instant(pull.created_at)) / 3_600_000;
    const reason = behindNumbers.has(pull.number) ? "BEHIND" : ageHours >= STUCK_PULL_AGE_HOURS ? "OLD" : null;
    if (reason !== null) {
      pulls.push({ number: pull.number, title: pull.title, url: pull.html_url, branch: pull.head.ref, stage: automationStageForBranch(pull.head.ref), createdAt: pull.created_at, reason });
    }
  }
  const openBranches = new Set(openPulls.map((pull) => pull?.head?.ref));
  const claims = claimRefs
    .filter((claim) => !openBranches.has(claim.branch) && (now.getTime() - instant(claim.committedAt)) / 3_600_000 >= STALE_CLAIM_AGE_HOURS)
    .map((claim) => ({ branch: claim.branch, committedAt: claim.committedAt }));
  const behindCap = behind.anomalies.map(({ stage, number, closures }) => ({ stage, number, closures }));

  const candidateInFlight = stages.some((stage) => IN_FLIGHT_STAGES.has(stage.id) && stage.inFlight)
    || automationPulls.some((pull) => automationStageForBranch(pull.head.ref) === "candidate-refresh");

  return {
    schemaVersion: 1,
    artifactKind: "automation-status-snapshot",
    generatedAt: now.toISOString(),
    activeDatapack,
    stages,
    failureIssues,
    stuck: { pulls, claims, behindCap },
    candidateInFlight,
  };
}

// ---------- 수집 ----------

function runsEndpoint(repository, stage) {
  const filter = stage.dispatchOnly ? "&event=workflow_dispatch&branch=main" : "";
  return `repos/${repository}/actions/workflows/${stage.workflow}/runs?per_page=50${filter}`;
}

export async function collectAutomationStatus({ now, repositories, apis, listFailureIssues, fetchManifest, planBehind = planBehindRecreation }) {
  const stageRuns = {};
  for (const stage of STATUS_STAGES) {
    const response = await apis[stage.repository](runsEndpoint(repositories[stage.repository], stage));
    if (!Array.isArray(response?.workflow_runs)) throw statusError("RUNS_INVALID", `${stage.id} response is not a run list`);
    stageRuns[stage.id] = response.workflow_runs;
  }
  const manifest = await fetchManifest();
  const issues = await listFailureIssues();
  const dataRepository = repositories.data;
  const openPulls = await readPages(apis.data, `repos/${dataRepository}/pulls?state=open&base=main`, { limit: 3, overflow: "return" });
  const behind = await planBehind({ repository: dataRepository, api: apis.data, now });

  const refs = await apis.data(`repos/${dataRepository}/git/matching-refs/heads/automation/`);
  if (!Array.isArray(refs)) throw statusError("REFS_INVALID", "automation refs response is not a list");
  const prefixes = Object.values(AUTOMATION_STAGE_PREFIXES);
  const openBranches = new Set(openPulls.map((pull) => pull?.head?.ref));
  const claimRefs = [];
  for (const ref of refs) {
    const branch = typeof ref?.ref === "string" ? ref.ref.replace(/^refs\/heads\//u, "") : "";
    if (!prefixes.some((prefix) => branch.startsWith(prefix)) || openBranches.has(branch)) continue;
    const commit = await apis.data(`repos/${dataRepository}/commits/${ref.object?.sha}`);
    const committedAt = commit?.commit?.committer?.date;
    if (!Number.isFinite(instant(committedAt))) throw statusError("REFS_INVALID", `claim ${branch} has no commit date`);
    claimRefs.push({ branch, committedAt });
  }
  return { now, manifest, stageRuns, issues, openPulls, behind, claimRefs };
}

// ---------- 게시 ----------

export async function postAutomationStatus({ snapshot, apiBaseUrl, token, fetchImpl = fetch }) {
  if (typeof token !== "string" || token === "" || typeof apiBaseUrl !== "string" || !/^https:\/\/[^\s/]+(\/[^\s?#]*)?$/u.test(apiBaseUrl)) {
    throw statusError("POST_ARGUMENTS", "an https backend address and a service token are required");
  }
  const body = JSON.stringify(snapshot);
  if (Buffer.byteLength(body) >= SNAPSHOT_MAX_BYTES) throw statusError("SNAPSHOT_TOO_LARGE", `${Buffer.byteLength(body)} bytes`);
  const response = await fetchImpl(`${apiBaseUrl.replace(/\/+$/u, "")}/admin/api/datapack/automation-status`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw statusError("POST_FAILED", `backend answered ${response.status}`);
}

// ---------- CLI ----------

function execGh(args, token) {
  if (typeof token !== "string" || token === "") return Promise.reject(statusError("TOKEN_MISSING"));
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: token, GH_PROMPT_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0
      ? resolve(Buffer.concat(out).toString("utf8"))
      : reject(statusError("GITHUB_CALL_FAILED", `gh ${args[0]} exited ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 300)}`))));
  });
}

const ghApi = (token) => async (endpoint) => JSON.parse(await execGh(["api", "--method", "GET", "-H", "Accept: application/vnd.github+json", endpoint], token));

async function main(env = process.env) {
  const repository = env.GITHUB_REPOSITORY;
  const owner = repository?.split("/")[0];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") || owner !== "AquilaXk") throw statusError("ENV_INVALID", "GITHUB_REPOSITORY");
  const repositories = { data: repository, hub: "AquilaXk/easysubway", platform: "AquilaXk/easysubway-platform" };
  const dataApi = ghApi(env.GH_TOKEN);
  const appApi = ghApi(env.APP_READ_TOKEN);
  const manifestBase = env.CHAIN_DATAPACK_BASE_URL;
  if (typeof manifestBase !== "string" || !/^https:\/\//u.test(manifestBase)) throw statusError("ENV_INVALID", "CHAIN_DATAPACK_BASE_URL");
  const collected = await collectAutomationStatus({
    now: new Date(),
    repositories,
    apis: { data: dataApi, hub: appApi, platform: appApi },
    listFailureIssues: async () => JSON.parse(await execGh([
      "issue", "list", "--repo", repository, "--state", "open", "--limit", "100", "--search", `"${FAILURE_TITLE}" in:title`,
      "--json", "number,title,url,createdAt,author",
    ], env.GH_TOKEN)),
    fetchManifest: async () => {
      const response = await fetch(`${manifestBase.replace(/\/+$/u, "")}/catalog/current.json`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw statusError("MANIFEST_INVALID", `manifest request answered ${response.status}`);
      return response.json();
    },
  });
  const snapshot = buildAutomationStatus(collected);
  const output = process.argv[2] === "--output" ? process.argv[3] : undefined;
  if (output !== undefined) await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  if (env.AUTOMATION_STATUS_DRY_RUN === "true") return snapshot;
  await postAutomationStatus({ snapshot, apiBaseUrl: env.DEPLOY_PUBLIC_API_BASE_URL, token: env.EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN });
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
