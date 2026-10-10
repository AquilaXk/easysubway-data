#!/usr/bin/env node
// main보다 뒤처진 자동화 PR을 닫고 최신 main에서 다시 만들게 한다(#986 리뷰 F2, #870 전체 자동화 2단계).
//
// 자동화 PR의 증거 블록과 정책 통과 기록은 head에 묶여 있다. 뒤처진 PR을 update-branch로 갱신하면 사람(PAT 소유자) 작성 병합 커밋이 생겨
// "사람 커밋 없음"과 head 결속이 함께 깨진다. 그래서 갱신하지 않고 닫는다: PR 닫기(App 토큰) -> 브랜치 삭제 -> 해당 단계 workflow 재실행.
// 닫힌 PR의 브랜치가 남으면 다음 실행의 직렬화 판정이 진행 중인 일로 오인하므로 브랜치를 지운다.
// - 대상: App이 작성한 같은 저장소의 단계 claim 브랜치 PR만. 사람이 같은 접두사로 연 PR은 건드리지 않는다(정책이 이상으로 드러낸다).
// - 후보 갱신 단계는 dispatch하지 않는다. 정기 역할은 schedule 이벤트와 스케줄러 App(easysubway-release-chain[bot])의 dispatch에서만 쓸 수 있고
//   이 도구의 dispatch 행위자(github-actions[bot])는 사람 경로로 판정돼 입력 없이는 실패하므로, 정기 실행과 스케줄러가 다시 만든다.
// - 루프 상한: 같은 단계의 PR이 24시간 안에 RECREATE_DAILY_LIMIT회 닫혔으면 더 닫지 않고 이상으로 보고한다(job 실패 -> #926).
// - 하루 한 번만 받을 수 있는 수집분을 들고 있는 단계는 그냥 닫으면 그날 수집분을 잃는다(#1127). ITX 공급자 호출은 KST 하루 한 번이라, 닫은 뒤 다시 dispatch해도
//   ITX_COLLECTED_TODAY로 막혀 다음 수집 가능 시각까지 운영 데이터팩 신선도가 끊길 수 있다. 그래서 단계마다 방식이 정해져 있다(STAGE_RECREATE_MODE).
//   close   다시 실행하면 같은 값을 얻는다(main에서 결정되거나 호출 횟수 제한이 없는 원천). 닫고 지우고 재실행한다.
//   replay  ITX 승격: 닫기 전에 원본 run의 artifact(itx-current-promotion-<run id>)가 살아 있는지 읽고, 닫은 뒤 replay_run_id로 재실행해 같은 수집분을 최신 main 위에 다시 승격한다.
//           원본이 없으면 닫지 않고 이상으로 보고한다. 재생 run도 같은 artifact를 올리므로 다시 뒤처져도 그 PR의 branch 접미사(run id)가 다음 재생의 원본이다.
//   hold    수도권 topology 갱신: 같은 KST 날 만들어진 PR은 그날 ITX 수집분을 들고 있을 수 있어 닫지 않고 기다린다. 다음 KST 날부터는 수집 예산이 되살아나므로 닫고 다시 만든다.
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

export const RECREATE_MODE = Object.freeze({ CLOSE: "close", REPLAY: "replay", HOLD_SAME_KST_DAY: "hold-same-kst-day" });

/** 뒤처진 PR을 어떻게 다시 만드는가. 하루 한 번만 받을 수 있는 수집분을 들고 있는 단계는 단순히 닫지 않는다(#1127). */
export const STAGE_RECREATE_MODE = Object.freeze({
  registration: RECREATE_MODE.CLOSE,
  "derivative-rebinding": RECREATE_MODE.CLOSE,
  "candidate-refresh": RECREATE_MODE.CLOSE,
  "itx-promotion": RECREATE_MODE.REPLAY,
  "source-reverification": RECREATE_MODE.CLOSE,
  "gwangju-timetable-refresh": RECREATE_MODE.CLOSE,
  "capital-topology-refresh": RECREATE_MODE.HOLD_SAME_KST_DAY,
  "kric-facility-refresh": RECREATE_MODE.CLOSE,
  "seoul-accessibility-refresh": RECREATE_MODE.CLOSE,
});

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const kstDayStart = (now) => Math.floor((now.getTime() + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
const REPLAY_RUN_SUFFIX = /-([1-9][0-9]{0,15})$/u;

/** 닫은 뒤 같은 단계 workflow를 dispatch할 수 있는가. 후보 갱신은 dispatch에 사람 역할이 필수라 정기 실행이 다시 만든다. */
export const STAGE_REDISPATCH = Object.freeze({
  registration: true, "derivative-rebinding": true, "candidate-refresh": false, "itx-promotion": true, "source-reverification": true,
  // #1012: 정기 갱신 4종은 변수 게이트가 없고 dispatch에 필수 입력이 없다. 정기 실행(2시간)을 기다리지 않고 바로 최신 main에서 증거가 든 PR을 다시 만든다.
  "gwangju-timetable-refresh": true, "capital-topology-refresh": true, "kric-facility-refresh": true, "seoul-accessibility-refresh": true,
});

const message = (error) => (error instanceof Error ? error.message : String(error));

const anomalyMessage = ({ stage, number, closures, reason }) => (reason === "ITX_REPLAY_SOURCE_MISSING"
  ? `ITX_REPLAY_SOURCE_MISSING: ${stage} PR #${number}가 뒤처졌지만 재생할 원본 run의 artifact(itx-current-promotion-<run id>)가 없거나 만료돼 닫지 않는다. 닫으면 그날 받은 수집분을 잃는다. 사람이 확인해야 한다.`
  : `AUTOMATION_PR_RECREATE_LOOP: ${stage} PR #${number}가 뒤처졌지만 24시간 안에 이미 ${closures}회 닫혀 더 닫지 않는다. 원인을 사람이 확인해야 한다.`);

async function replaySourceAlive({ repository, api, runId }) {
  const name = `itx-current-promotion-${runId}`;
  const listing = await api(`repos/${repository}/actions/runs/${runId}/artifacts?name=${name}`);
  if (!Array.isArray(listing?.artifacts)) throw inputError(`artifacts of run ${runId}`);
  const live = listing.artifacts.filter((artifact) => artifact?.name === name && artifact.expired === false);
  return live.length === 1;
}

/**
 * 닫을 PR, 상한·원본 부재로 닫지 못하는 단계, 닫지 않고 기다릴 PR을 계산한다. 읽기만 한다.
 * @returns {Promise<{ actions: { number: number, branch: string, stage: string, workflow: string, replayRunId?: string }[], anomalies: { stage: string, number: number, closures: number, reason: string }[], deferred: { stage: string, number: number, reason: string }[] }>}
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
  const deferred = [];
  for (const pull of openPulls) {
    const stage = ours(pull);
    if (stage === null) continue;
    const compare = await api(`repos/${repository}/compare/${MAIN}...${pull.head.sha}?per_page=1`);
    if (!Number.isSafeInteger(compare?.behind_by) || compare.behind_by < 0) throw inputError(`compare behind_by of #${pull.number}`);
    if (compare.behind_by === 0) continue;
    const mode = STAGE_RECREATE_MODE[stage];
    if (mode === RECREATE_MODE.HOLD_SAME_KST_DAY) {
      const createdAt = Date.parse(pull.created_at);
      if (!Number.isFinite(createdAt)) throw inputError(`created_at of #${pull.number}`);
      if (createdAt >= kstDayStart(now)) {
        deferred.push({ stage, number: pull.number, reason: "SAME_KST_DAY_ITX_COLLECTION" });
        continue;
      }
    }
    const used = closures.get(stage) ?? 0;
    if (used >= RECREATE_DAILY_LIMIT) {
      anomalies.push({ stage, number: pull.number, closures: used, reason: "LOOP" });
      continue;
    }
    let replayRunId;
    if (mode === RECREATE_MODE.REPLAY) {
      replayRunId = REPLAY_RUN_SUFFIX.exec(pull.head.ref)?.[1];
      // 닫으면 그날 수집분은 이 artifact에만 남는다. 읽을 수 없으면 닫지 않는다.
      if (replayRunId === undefined || !(await replaySourceAlive({ repository, api, runId: replayRunId }))) {
        anomalies.push({ stage, number: pull.number, closures: used, reason: "ITX_REPLAY_SOURCE_MISSING" });
        continue;
      }
    }
    closures.set(stage, used + 1);
    actions.push({ number: pull.number, branch: pull.head.ref, stage, workflow: AUTOMATION_STAGE_WORKFLOWS[stage], ...(replayRunId === undefined ? {} : { replayRunId }) });
  }
  return { actions, anomalies, deferred };
}

/** 계획대로 닫고, 브랜치를 지우고, 단계 workflow를 다시 실행한다. 상한에 닿은 단계가 있으면 나머지를 마친 뒤 실패로 보고한다. */
export async function recreateBehindPullRequests({ repository, api, closePullRequest, deleteBranch, dispatchWorkflow, now = new Date(), log = () => {} }) {
  const { actions, anomalies, deferred } = await planBehindRecreation({ repository, api, now });
  for (const { stage, number, reason } of deferred) log(`held #${number} (${stage}): ${reason}; not closed so the day's one-time collection is not lost`);
  const dispatched = new Set();
  for (const action of actions) {
    await closePullRequest({
      number: action.number,
      comment: "main보다 뒤처졌습니다. base를 갱신하면 사람 작성 병합 커밋이 생겨 증거 블록의 head 결속이 깨지므로, 이 PR과 브랜치를 닫고 최신 main에서 다시 만듭니다.",
    });
    await deleteBranch(action.branch);
    log(`closed #${action.number} (${action.stage}) and removed ${action.branch}`);
    if (STAGE_REDISPATCH[action.stage] && !dispatched.has(action.workflow)) {
      if (action.replayRunId === undefined) {
        await dispatchWorkflow(action.workflow);
      } else {
        // 수집분은 원본 run의 artifact에 남아 있다. 이 dispatch가 실패해도 같은 입력으로 다시 dispatch하면 복구된다.
        try {
          await dispatchWorkflow(action.workflow, { replay_run_id: action.replayRunId });
        } catch (error) {
          throw new Error(`ITX_REPLAY_DISPATCH_FAILED: replay_run_id=${action.replayRunId} 로 ${action.workflow}을 다시 dispatch하면 복구된다: ${message(error)}`, { cause: error });
        }
      }
      dispatched.add(action.workflow);
      log(`dispatched ${action.workflow} from ${MAIN}${action.replayRunId === undefined ? "" : ` replaying run ${action.replayRunId}`}`);
    }
  }
  if (anomalies.length > 0) {
    throw new Error(anomalies.map(anomalyMessage).join("\n"));
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
    const { actions, anomalies, deferred } = await planBehindRecreation({ repository: values.repository, api, now });
    writeOutputs(values["github-output"], { targets: actions.length + anomalies.length });
    log(`뒤처진 자동화 PR: 닫을 ${actions.length}건, 상한 도달·원본 없음 ${anomalies.length}건, 대기 ${deferred.length}건`);
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
      dispatchWorkflow: (workflow, inputs = {}) => gh(["workflow", "run", workflow, "--repo", repository, "--ref", MAIN, ...Object.entries(inputs).flatMap(([name, value]) => ["-f", `${name}=${value}`])], readToken),
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
