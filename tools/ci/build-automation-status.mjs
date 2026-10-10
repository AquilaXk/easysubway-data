#!/usr/bin/env node
// admin "자동화 상태" 화면에 보낼 snapshot을 만들고 게시한다(data#1084, backend#500, QA 결정 2026-10-09: 사람은 이상이 날 때만 admin에서 확인).
// - 방식: push. 이 도구가 GitHub 상태를 읽어 snapshot JSON을 만들고 backend의 워크플로 서비스 토큰 API로 보낸다.
//   backend가 GitHub를 호출하지 않아 prod에 GitHub 토큰이 생기지 않고, 게시가 멈추면 admin이 "마지막 갱신 N분 전"으로 드러낸다.
// - 읽지 못한 값은 빈 값·옛 값으로 채우지 않는다. 한 곳이라도 조회가 실패하면 전체가 실패한다(게시 안 됨 -> admin이 낡음으로 표시).
// - 시간이 지나며 변하는 판정(만료 임박 등)은 snapshot에 넣지 않고 backend가 렌더 시각으로 계산한다.
// - 곧 만료되는 원천 근거(expiringSources, data#1116, backend#507)는 source-inventory.json의 freshUntil에서 만들고 만료 시각만 싣는다(남은 시간은 backend가 렌더 시각으로 계산).
//   backend가 선택 필드로 받아 배포하기 전에는 보내면 게시가 400으로 실패하므로 AUTOMATION_STATUS_SOURCE_FRESHNESS가 true일 때만 싣는다(workflow 변수 DATAPACK_AUTOMATION_STATUS_FRESHNESS).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REVERIFICATION_RECIPES } from "../datapack/source-reverification-recipes.mjs";
import {
  AUTOMATION_STAGE_PREFIXES,
  AUTOMATION_STAGE_WORKFLOWS,
  automationStageForBranch,
  readPages,
  trustedCommitIdentity,
} from "./automation-pr-policy.mjs";
import { planBehindRecreation } from "./automation-pr-recreate.mjs";
import { parseDeployRunName } from "./datapack-release-chain.mjs";
import { REFRESH_STAGES } from "./refresh-stage-contracts.mjs";

export const SNAPSHOT_MAX_BYTES = 64 * 1024;
const STUCK_PULL_AGE_HOURS = 6;
const STALE_CLAIM_AGE_HOURS = 2;
const FAILURE_ISSUE_LIMIT = 20;
const FAILURE_TITLE = "원천 자동 갱신 실패";
const BOT_LOGINS = new Set(["app/github-actions", "github-actions[bot]"]);
const PULL_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d{0,9}$/u;
const PULL_TITLE_MAX_CHARS = 120;
const IN_FLIGHT_STAGES = new Set(["candidate", "rc", "compat", "promotion", "publish", "deploy"]);

/** snapshot에 싣는 곧 만료되는 원천 근거의 최대 개수(만료가 이른 순서). */
export const EXPIRING_SOURCE_LIMIT = 10;
/** 이미 만료된 근거를 목록에 두는 기간. 만료 순간에 신호가 사라지지 않게 하되 오래전에 만료된 근거가 "다음 만료" 목록을 채우지 않게 한다. */
export const EXPIRED_SOURCE_GRACE_MS = 24 * 3_600_000;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,99}$/u;
const EVIDENCE_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SOURCE_NAME_MAX_CHARS = 200;
const SOURCE_INVENTORY_PATH = "tools/datapack/source-inventory.json";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
function newest(left, right) {
  if (left.created_at === right.created_at) return right.id - left.id;
  return left.created_at < right.created_at ? 1 : -1;
}

function withoutTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

/**
 * 이 저장소의 자동화가 만든 PR만 자동화 PR로 센다. 저장소가 공개라 fork PR도 pulls 목록에 나오고, head 브랜치 이름은 누구나 흉내 낼 수 있다.
 * head 저장소가 이 저장소이고 작성자가 릴리스 체인 App 또는 github-actions[bot](login·id·type 모두 일치)일 때만 인정한다.
 */
export function isOwnAutomationPull(pull, repository) {
  return pull?.head?.repo?.full_name === repository && trustedCommitIdentity(pull.user) && automationStageForBranch(pull.head.ref) !== null;
}

// snapshot에 실리는 PR 제목은 화면에 그대로 보이므로 제어·서식(양방향 제어 포함) 문자를 지우고 길이를 제한한다.
function displayTitle(value, number) {
  if (typeof value !== "string") throw statusError("PULL_INVALID", `PR ${number} has no title`);
  const cleaned = [...value.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replaceAll(/\s+/gu, " ").trim()].slice(0, PULL_TITLE_MAX_CHARS).join("");
  if (cleaned === "") throw statusError("PULL_INVALID", `PR ${number} title is empty after cleaning`);
  return cleaned;
}

function stuckReason({ behind, ageHours }) {
  if (behind) return "BEHIND";
  return ageHours >= STUCK_PULL_AGE_HOURS ? "OLD" : null;
}

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
    && (stage.deployMode === undefined || parseDeployRunName(run.display_title)?.mode === stage.deployMode));
  matching.sort(newest);
  const success = matching.find((run) => run.status === "completed" && run.conclusion === "success");
  return {
    id: stage.id,
    label: stage.label,
    latest: matching.length === 0 ? null : runSummary(matching[0]),
    lastSuccessAt: success === undefined ? null : success.updated_at,
    inFlight: matching.some((run) => run.status !== "completed"),
  };
}

/** 근거를 갱신하는 자동화 단계: REFRESH_STAGES 소유 표가 먼저이고, 없으면 원천 재확인 recipe가 다룬다. 둘 다 아니면 자동 갱신 경로가 없다. */
export function sourceRefreshStages() {
  const stages = new Map();
  const add = (sourceId, stage) => {
    if (!stages.has(sourceId)) stages.set(sourceId, stage);
  };
  for (const [stage, spec] of Object.entries(REFRESH_STAGES)) {
    for (const sourceId of Object.keys(spec.owned)) add(sourceId, stage);
  }
  for (const recipe of REVERIFICATION_RECIPES) {
    for (const sourceId of recipe.sourceIds) add(sourceId, "source-reverification");
  }
  return stages;
}

function inventoryError(detail) {
  return statusError("INVENTORY_INVALID", detail);
}

function sourceName(value, sourceId) {
  const cleaned = typeof value === "string" ? [...value.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replaceAll(/\s+/gu, " ").trim()].slice(0, SOURCE_NAME_MAX_CHARS).join("") : "";
  if (cleaned === "") throw inventoryError(`source ${sourceId} has no usable displayName`);
  return cleaned;
}

function* freshUntilValues(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* freshUntilValues(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "freshUntil") yield child;
    else yield* freshUntilValues(child);
  }
}

/** 원천 항목 아래 근거 중 가장 이른 freshUntil과 그 근거 종류(원천 항목 아래 최상위 키). 근거가 없으면 null이다. */
function earliestFreshness(source) {
  let best = null;
  for (const [evidence, value] of Object.entries(source)) {
    for (const raw of freshUntilValues(value)) {
      const millis = typeof raw === "string" && UTC_INSTANT.test(raw) ? Date.parse(raw) : Number.NaN;
      if (!Number.isFinite(millis)) throw inventoryError(`source ${source.id} ${evidence} freshUntil is not a UTC instant`);
      if (best === null || millis < best.millis) best = { millis, evidence };
    }
  }
  return best;
}

const FAILED_RUN_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

/**
 * 근거를 갱신하는 작업의 상태. 그 단계 workflow의 가장 최근에 끝난 run이 실패했으면 FAILED, 막힌 PR·주인 없는 claim·재생성 상한이 그 단계이면 BLOCKED, 아니면 OK다.
 * 열린 실패 이슈는 쓰지 않는다: 이슈는 사람이 닫을 때까지 열려 있어 지금 실패 중인지를 말해 주지 못한다.
 */
function refreshStateOf(stage, refreshRuns, stuck) {
  if (stage === undefined) return "NONE";
  const runs = refreshRuns[stage];
  if (!Array.isArray(runs)) throw statusError("RUNS_INVALID", `no run list for refresh stage ${stage}`);
  const [latest] = runs.filter((run) => run?.status === "completed").sort(newest);
  if (latest !== undefined && FAILED_RUN_CONCLUSIONS.has(latest.conclusion)) return "FAILED";
  const prefix = AUTOMATION_STAGE_PREFIXES[stage];
  const blocked = stuck.pulls.some((pull) => pull.stage === stage)
    || stuck.claims.some((claim) => claim.branch.startsWith(prefix))
    || stuck.behindCap.some((cap) => cap.stage === stage);
  return blocked ? "BLOCKED" : "OK";
}

const compareText = (left, right) => (left < right ? -1 : Number(left > right));
const byExpiry = (left, right) => Date.parse(left.freshUntil) - Date.parse(right.freshUntil) || compareText(left.sourceId, right.sourceId);

/** 원천 하나의 목록 항목. 대상이 아니면(사용 불가, 근거 없음, 오래전 만료) null이고, 값이 어긋나면 채우지 않고 실패한다. */
function expiringSourceOf(source, { now, refreshStages, refreshRuns, stuck }) {
  if (source.productionUseAllowed !== true) return null;
  const freshness = earliestFreshness(source);
  if (freshness === null) return null;
  if (!SOURCE_ID.test(source.id)) throw inventoryError(`source id ${source.id} does not match the snapshot contract`);
  if (!EVIDENCE_KEY.test(freshness.evidence)) throw inventoryError(`source ${source.id} evidence key ${freshness.evidence} does not match the snapshot contract`);
  if (freshness.millis <= now.getTime() - EXPIRED_SOURCE_GRACE_MS) return null;
  const refreshStage = refreshStages.get(source.id);
  return {
    sourceId: source.id,
    name: sourceName(source.displayName, source.id),
    evidence: freshness.evidence,
    freshUntil: new Date(freshness.millis).toISOString(),
    refreshStage: refreshStage ?? null,
    refreshState: refreshStateOf(refreshStage, refreshRuns, stuck),
  };
}

/**
 * 곧 만료되는 원천 근거를 만료가 이른 순서(같은 시각이면 sourceId 순)로 최대 EXPIRING_SOURCE_LIMIT개 만든다.
 * 사용 가능한(productionUseAllowed) 원천만 대상이고, 만료된 지 EXPIRED_SOURCE_GRACE_MS가 지난 근거는 뺀다. 값이 어긋나면 채우지 않고 실패한다.
 */
function buildExpiringSources({ inventory, now, refreshRuns, stuck }) {
  if (inventory === null || typeof inventory !== "object" || !Array.isArray(inventory.sources)) throw inventoryError("inventory has no sources array");
  const context = { now, refreshStages: sourceRefreshStages(), refreshRuns, stuck };
  const seen = new Set();
  const candidates = [];
  for (const source of inventory.sources) {
    if (source === null || typeof source !== "object" || typeof source.id !== "string") throw inventoryError("an inventory source has no id");
    if (seen.has(source.id)) throw inventoryError(`duplicate source id ${source.id}`);
    seen.add(source.id);
    const candidate = expiringSourceOf(source, context);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates.toSorted(byExpiry).slice(0, EXPIRING_SOURCE_LIMIT);
}

/**
 * AUTOMATION_STATUS_SOURCE_FRESHNESS가 true일 때만 source-inventory.json을 읽는다. 꺼짐·미설정이면 undefined(필드를 싣지 않는다).
 * 켜졌는데 읽지 못하거나 알 수 없는 값이면 채우지 않고 실패한다.
 */
export async function loadSourceInventory({ env = process.env, root = REPOSITORY_ROOT } = {}) {
  const flag = env.AUTOMATION_STATUS_SOURCE_FRESHNESS;
  if (flag === undefined || flag === "" || flag === "false") return undefined;
  if (flag !== "true") throw statusError("ENV_INVALID", "AUTOMATION_STATUS_SOURCE_FRESHNESS must be true, false or empty");
  const text = await readFile(path.join(root, SOURCE_INVENTORY_PATH), "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw inventoryError("source inventory is not valid JSON");
  }
}

export function buildAutomationStatus({
  now, repository, manifest, stageRuns = {}, issues = [], openPulls = [], claimRefs = [], behind = { actions: [], anomalies: [] }, sourceInventory, refreshRuns = {},
}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw statusError("CLOCK");
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw statusError("ENV_INVALID", "repository");
  const activeDatapack = activeDatapackOf(manifest);
  const stages = STATUS_STAGES.map((stage) => summarizeStage(stage, stageRuns[stage.id] ?? []));

  const failureIssues = issues
    .filter((issue) => typeof issue?.title === "string" && issue.title.includes(FAILURE_TITLE) && BOT_LOGINS.has(issue.author?.login))
    .sort((left, right) => right.number - left.number)
    .slice(0, FAILURE_ISSUE_LIMIT)
    .map((issue) => ({ number: issue.number, title: issue.title, url: issue.url, createdAt: issue.createdAt }));

  const behindNumbers = new Set([...behind.actions, ...behind.anomalies].map((item) => item.number));
  const automationPulls = openPulls.filter((pull) => isOwnAutomationPull(pull, repository));
  const pulls = [];
  const orderedPulls = automationPulls.toSorted((left, right) => left.number - right.number);
  for (const pull of orderedPulls) {
    const ageHours = (now.getTime() - instant(pull.created_at)) / 3_600_000;
    const reason = stuckReason({ behind: behindNumbers.has(pull.number), ageHours });
    if (reason !== null) {
      if (!Number.isSafeInteger(pull.number) || !PULL_URL.test(pull.html_url ?? "")) throw statusError("PULL_INVALID", `PR ${String(pull.number)} has an invalid number or url`);
      pulls.push({ number: pull.number, title: displayTitle(pull.title, pull.number), url: pull.html_url, branch: pull.head.ref, stage: automationStageForBranch(pull.head.ref), createdAt: pull.created_at, reason });
    }
  }
  const openBranches = new Set(automationPulls.map((pull) => pull.head.ref));
  const claims = claimRefs
    .filter((claim) => !openBranches.has(claim.branch) && (now.getTime() - instant(claim.committedAt)) / 3_600_000 >= STALE_CLAIM_AGE_HOURS)
    .map((claim) => ({ branch: claim.branch, committedAt: claim.committedAt }));
  const behindCap = behind.anomalies.map(({ stage, number, closures }) => ({ stage, number, closures }));

  const candidateInFlight = stages.some((stage) => IN_FLIGHT_STAGES.has(stage.id) && stage.inFlight)
    || automationPulls.some((pull) => automationStageForBranch(pull.head.ref) === "candidate-refresh");

  const snapshot = {
    schemaVersion: 1,
    artifactKind: "automation-status-snapshot",
    generatedAt: now.toISOString(),
    activeDatapack,
    stages,
    failureIssues,
    stuck: { pulls, claims, behindCap },
    candidateInFlight,
  };
  // 선택 필드: 인벤토리를 주었을 때만 싣는다(backend가 받기 전에는 주지 않는다).
  if (sourceInventory !== undefined) {
    snapshot.expiringSources = buildExpiringSources({ inventory: sourceInventory, now, refreshRuns, stuck: snapshot.stuck });
  }
  return snapshot;
}

// ---------- 수집 ----------

function runsEndpoint(repository, stage) {
  const filter = stage.dispatchOnly ? "&event=workflow_dispatch&branch=main" : "";
  return `repos/${repository}/actions/workflows/${stage.workflow}/runs?per_page=50${filter}`;
}

/** 근거를 갱신하는 단계 id -> 그 단계 workflow. 곧 만료되는 원천 근거의 갱신 작업 상태를 읽는 데 쓴다. */
export function refreshWorkflowsOf(refreshStages = new Set(sourceRefreshStages().values())) {
  return Object.fromEntries([...refreshStages].toSorted(compareText).map((stage) => [stage, AUTOMATION_STAGE_WORKFLOWS[stage]]));
}

/** 갱신 단계마다 그 workflow의 끝난 run 목록(최근 10개, main)을 읽는다. 응답이 목록이 아니면 채우지 않고 실패한다. */
async function collectRefreshRuns({ refreshWorkflows, api, repository }) {
  const entries = await Promise.all(Object.entries(refreshWorkflows).map(async ([stage, workflow]) => {
    const response = await api(`repos/${repository}/actions/workflows/${workflow}/runs?per_page=10&status=completed&branch=main`);
    if (!Array.isArray(response?.workflow_runs)) throw statusError("RUNS_INVALID", `${stage} refresh response is not a run list`);
    return [stage, response.workflow_runs];
  }));
  return Object.fromEntries(entries);
}

export async function collectAutomationStatus({ now, repositories, apis, listFailureIssues, fetchManifest, planBehind = planBehindRecreation, refreshWorkflows }) {
  const stageRuns = {};
  for (const stage of STATUS_STAGES) {
    const response = await apis[stage.repository](runsEndpoint(repositories[stage.repository], stage));
    if (!Array.isArray(response?.workflow_runs)) throw statusError("RUNS_INVALID", `${stage.id} response is not a run list`);
    stageRuns[stage.id] = response.workflow_runs;
  }
  const refreshRuns = refreshWorkflows === undefined ? undefined : await collectRefreshRuns({ refreshWorkflows, api: apis.data, repository: repositories.data });
  const manifest = await fetchManifest();
  const issues = await listFailureIssues();
  const dataRepository = repositories.data;
  const openPulls = await readPages(apis.data, `repos/${dataRepository}/pulls?state=open&base=main`, { limit: 3, overflow: "return" });
  const behind = await planBehind({ repository: dataRepository, api: apis.data, now });

  const refs = await apis.data(`repos/${dataRepository}/git/matching-refs/heads/automation/`);
  if (!Array.isArray(refs)) throw statusError("REFS_INVALID", "automation refs response is not a list");
  const prefixes = Object.values(AUTOMATION_STAGE_PREFIXES);
  const openBranches = new Set(openPulls.filter((pull) => isOwnAutomationPull(pull, dataRepository)).map((pull) => pull.head.ref));
  const claimRefs = [];
  for (const ref of refs) {
    const branch = typeof ref?.ref === "string" ? ref.ref.replace(/^refs\/heads\//u, "") : "";
    if (!prefixes.some((prefix) => branch.startsWith(prefix)) || openBranches.has(branch)) continue;
    const commit = await apis.data(`repos/${dataRepository}/commits/${ref.object?.sha}`);
    const committedAt = commit?.commit?.committer?.date;
    if (!Number.isFinite(instant(committedAt))) throw statusError("REFS_INVALID", `claim ${branch} has no commit date`);
    claimRefs.push({ branch, committedAt });
  }
  const collected = { now, repository: dataRepository, manifest, stageRuns, issues, openPulls, behind, claimRefs };
  return refreshRuns === undefined ? collected : { ...collected, refreshRuns };
}

// ---------- 게시 ----------

export async function postAutomationStatus({ snapshot, apiBaseUrl, token, fetchImpl = fetch }) {
  if (typeof token !== "string" || token === "" || typeof apiBaseUrl !== "string" || !/^https:\/\/[^\s/]+(\/[^\s?#]*)?$/u.test(apiBaseUrl)) {
    throw statusError("POST_ARGUMENTS", "an https backend address and a service token are required");
  }
  const body = JSON.stringify(snapshot);
  if (Buffer.byteLength(body) >= SNAPSHOT_MAX_BYTES) throw statusError("SNAPSHOT_TOO_LARGE", `${Buffer.byteLength(body)} bytes`);
  const response = await fetchImpl(`${withoutTrailingSlashes(apiBaseUrl)}/admin/api/datapack/automation-status`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw statusError("POST_FAILED", `backend answered ${response.status}`);
}

// ---------- CLI ----------

// gh는 고정 경로의 실행 파일만 쓴다(PATH 탐색 없음). 토큰은 호출마다 명시적으로 넘기고 환경에는 HOME 외에 아무것도 상속하지 않는다.
const GH_EXECUTABLES = Object.freeze(["/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh"]);

function ghExecutable() {
  const found = GH_EXECUTABLES.find((candidate) => existsSync(candidate));
  if (found === undefined) throw statusError("GH_NOT_FOUND", GH_EXECUTABLES.join(", "));
  return found;
}

function execGh(args, token) {
  if (typeof token !== "string" || token === "") return Promise.reject(statusError("TOKEN_MISSING"));
  return new Promise((resolve, reject) => {
    const child = spawn(ghExecutable(), args, { env: { HOME: process.env.HOME, GH_TOKEN: token, GH_PROMPT_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
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
  if (typeof manifestBase !== "string" || !manifestBase.startsWith("https://")) throw statusError("ENV_INVALID", "CHAIN_DATAPACK_BASE_URL");
  const sourceInventory = await loadSourceInventory({ env });
  const collected = await collectAutomationStatus({
    now: new Date(),
    refreshWorkflows: sourceInventory === undefined ? undefined : refreshWorkflowsOf(),
    repositories,
    apis: { data: dataApi, hub: appApi, platform: appApi },
    listFailureIssues: async () => JSON.parse(await execGh([
      "issue", "list", "--repo", repository, "--state", "open", "--limit", "100", "--search", `"${FAILURE_TITLE}" in:title`,
      "--json", "number,title,url,createdAt,author",
    ], env.GH_TOKEN)),
    fetchManifest: async () => {
      const response = await fetch(`${withoutTrailingSlashes(manifestBase)}/catalog/current.json`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw statusError("MANIFEST_INVALID", `manifest request answered ${response.status}`);
      return response.json();
    },
  });
  const snapshot = buildAutomationStatus({ ...collected, sourceInventory });
  // 결과 사본은 러너 임시 디렉터리의 고정 이름 파일에만 쓴다(경로를 입력으로 받지 않는다).
  const tempDirectory = env.RUNNER_TEMP;
  if (typeof tempDirectory === "string" && path.isAbsolute(tempDirectory)) {
    await writeFile(path.join(tempDirectory, "automation-status.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  }
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
