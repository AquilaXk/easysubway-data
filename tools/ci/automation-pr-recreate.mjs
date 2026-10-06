#!/usr/bin/env node
// main보다 뒤처진 자동화 PR을 닫고 최신 main에서 다시 만들게 한다(#986 리뷰 F2, #870 전체 자동화 2단계).
//
// 자동화 PR의 증거 블록과 정책 통과 기록은 head에 묶여 있다. 뒤처진 PR을 update-branch로 갱신하면 사람(PAT 소유자) 작성 병합 커밋이 생겨
// "사람 커밋 없음"과 head 결속이 함께 깨진다. 그래서 갱신하지 않고 닫는다: PR 닫기(App 토큰) -> 브랜치 삭제 -> 해당 단계 workflow 재실행.
// 닫힌 PR의 브랜치가 남으면 다음 실행의 직렬화 판정이 진행 중인 일로 오인하므로 브랜치를 지운다.
// - 대상: App이 작성한 같은 저장소의 단계 claim 브랜치 PR만. 사람이 같은 접두사로 연 PR은 건드리지 않는다(정책이 이상으로 드러낸다).
// - 후보 갱신 단계는 dispatch하지 않는다. dispatch에는 사람 역할 입력이 필수이고 정기 역할은 schedule 이벤트에서만 쓸 수 있으므로
//   2시간 정기 실행이 다시 만든다.
// - 루프 상한: 같은 단계의 PR이 24시간 안에 RECREATE_DAILY_LIMIT회 닫혔으면 더 닫지 않고 이상으로 보고한다(job 실패 -> #926).
// - 읽기는 github.token, PR 닫기만 App 토큰이다. 쓰기가 실패하면 이후 쓰기를 하지 않고 그대로 실패한다.
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  AUTOMATION_STAGE_WORKFLOWS,
  REPOSITORY_PATTERN,
  automationStageForBranch,
  inputError,
  isAutomationApp,
  parseOptions,
  readPages,
  writeOutputs,
} from "./automation-pr-policy.mjs";

const execFileAsync = promisify(execFile);
export const RECREATE_DAILY_LIMIT = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAIN = "main";

/** 닫은 뒤 같은 단계 workflow를 dispatch할 수 있는가. 후보 갱신은 dispatch에 사람 역할이 필수라 정기 실행이 다시 만든다. */
export const STAGE_REDISPATCH = Object.freeze({ registration: true, "derivative-rebinding": true, "candidate-refresh": false, "itx-promotion": true });

const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * 닫을 PR과 상한에 닿은 단계를 계산한다. 읽기만 한다.
 * @returns {Promise<{ actions: { number: number, branch: string, stage: string, workflow: string }[], anomalies: { stage: string, number: number, closures: number }[] }>}
 */
export async function planBehindRecreation({ repository, api, now = new Date() }) {
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) throw inputError("repository");
  const openPulls = await readPages(api, `repos/${repository}/pulls?state=open&base=${MAIN}`, { limit: 3 });
  const closedPulls = await readPages(api, `repos/${repository}/pulls?state=closed&base=${MAIN}&sort=updated&direction=desc`, { limit: 1, overflow: "return" });

  const ours = (pull) => pull?.head?.repo?.full_name === repository && isAutomationApp(pull.user) ? automationStageForBranch(pull.head.ref) : null;
  const closures = new Map();
  for (const pull of closedPulls) {
    const stage = ours(pull);
    const closedAt = Date.parse(pull?.closed_at);
    if (stage !== null && (pull.merged_at ?? null) === null && Number.isFinite(closedAt) && now.getTime() - closedAt < WINDOW_MS) closures.set(stage, (closures.get(stage) ?? 0) + 1);
  }

  const actions = [];
  const anomalies = [];
  for (const pull of openPulls) {
    const stage = ours(pull);
    if (stage === null) continue;
    const compare = await api(`repos/${repository}/compare/${MAIN}...${pull.head.sha}?per_page=1`);
    if (!Number.isSafeInteger(compare?.behind_by) || compare.behind_by < 0) throw inputError(`compare behind_by of #${pull.number}`);
    if (compare.behind_by === 0) continue;
    const used = closures.get(stage) ?? 0;
    if (used >= RECREATE_DAILY_LIMIT) {
      anomalies.push({ stage, number: pull.number, closures: used });
      continue;
    }
    closures.set(stage, used + 1);
    actions.push({ number: pull.number, branch: pull.head.ref, stage, workflow: AUTOMATION_STAGE_WORKFLOWS[stage] });
  }
  return { actions, anomalies };
}

/** 계획대로 닫고, 브랜치를 지우고, 단계 workflow를 다시 실행한다. 상한에 닿은 단계가 있으면 나머지를 마친 뒤 실패로 보고한다. */
export async function recreateBehindPullRequests({ repository, api, closePullRequest, deleteBranch, dispatchWorkflow, now = new Date(), log = () => {} }) {
  const { actions, anomalies } = await planBehindRecreation({ repository, api, now });
  const dispatched = new Set();
  for (const action of actions) {
    await closePullRequest({
      number: action.number,
      comment: "main보다 뒤처졌습니다. base를 갱신하면 사람 작성 병합 커밋이 생겨 증거 블록의 head 결속이 깨지므로, 이 PR과 브랜치를 닫고 최신 main에서 다시 만듭니다.",
    });
    await deleteBranch(action.branch);
    log(`closed #${action.number} (${action.stage}) and removed ${action.branch}`);
    if (STAGE_REDISPATCH[action.stage] && !dispatched.has(action.workflow)) {
      await dispatchWorkflow(action.workflow);
      dispatched.add(action.workflow);
      log(`dispatched ${action.workflow} from ${MAIN}`);
    }
  }
  if (anomalies.length > 0) {
    throw new Error(anomalies.map(({ stage, number, closures }) => `AUTOMATION_PR_RECREATE_LOOP: ${stage} PR #${number}가 뒤처졌지만 24시간 안에 이미 ${closures}회 닫혀 더 닫지 않는다. 원인을 사람이 확인해야 한다.`).join("\n"));
  }
}

async function gh(args, token) {
  if (typeof token !== "string" || token === "") throw inputError("token");
  await execFileAsync("gh", args, { env: { ...process.env, GH_TOKEN: token }, maxBuffer: 16 * 1024 * 1024 });
}

async function ghApi(endpoint) {
  const { stdout } = await execFileAsync("gh", ["api", "-H", "Accept: application/vnd.github+json", endpoint], { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function main(argv, { api = ghApi, now = new Date(), log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const [command, ...rest] = argv;
  if (command === "plan") {
    const values = parseOptions(rest, ["repository", "github-output"]);
    const { actions, anomalies } = await planBehindRecreation({ repository: values.repository, api, now });
    writeOutputs(values["github-output"], { targets: actions.length + anomalies.length });
    log(`뒤처진 자동화 PR: 닫을 ${actions.length}건, 상한 도달 ${anomalies.length}건`);
  } else if (command === "run") {
    const values = parseOptions(rest, ["repository"]);
    const repository = values.repository;
    const readToken = process.env.GH_TOKEN;
    const closeToken = process.env.APP_TOKEN;
    await recreateBehindPullRequests({
      repository,
      api,
      now,
      log,
      closePullRequest: ({ number, comment }) => gh(["pr", "close", String(number), "--repo", repository, "--comment", comment], closeToken),
      // 브랜치 이름은 plan이 단계 claim 접두사(automationStageForBranch)로 거른 값뿐이다.
      deleteBranch: async (branch) => {
        try {
          await gh(["api", "--method", "DELETE", `repos/${repository}/git/refs/heads/${branch}`], readToken);
        } catch (error) {
          if (!/Reference does not exist/u.test(`${message(error)} ${error?.stderr ?? ""}`)) throw error;
        }
      },
      dispatchWorkflow: (workflow) => gh(["workflow", "run", workflow, "--repo", repository, "--ref", MAIN], readToken),
    });
  } else {
    throw inputError(`unknown command ${String(command)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${message(error)}\n`);
    process.exitCode = 1;
  }
}
