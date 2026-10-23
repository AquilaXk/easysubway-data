// 재생 원본 run의 신뢰 경계(#1127, #3036). 이전 run의 artifact를 받기 전에, 그 run이 이 저장소 main에서 정기 실행이나 dispatch로 돈
// 해당 workflow의 run인지와 그 job의 step 결론을 읽는다. ITX 승격(restore-itx-replay-evidence)과 P7D 원천 재확인 재생이 같은 규칙을 쓴다.
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { isObject } from "../lib/is-object.mjs";

const RUN_ID = /^[1-9][0-9]{0,15}$/u;
const SOURCE_EVENTS = Object.freeze(["workflow_dispatch", "schedule"]);
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

/** gh api runs/{id} 응답이 repository main에서 돈 workflowPath의 run이 아니면 `${code}_RUN_INVALID`로 실패한다. */
export function verifyReplaySourceRun({ sourceRunId, repository, run, workflowPath, code }) {
  if (typeof sourceRunId !== "string" || !RUN_ID.test(sourceRunId)) fail(`${code}_RUN_INVALID`, "source run id");
  if (!isObject(run) || run.id !== Number(sourceRunId) || run.path !== workflowPath || run.head_branch !== "main"
    || !SOURCE_EVENTS.includes(run.event) || run.repository?.full_name !== repository) {
    fail(`${code}_RUN_INVALID`, `run ${sourceRunId} is not a main run of ${path.basename(workflowPath)} in ${repository}`);
  }
}

/** gh api runs/{id}/jobs 응답에서 그 run의 jobName job이 정확히 하나일 때 step 목록을 돌려준다. 아니면 `${code}_STEP_NOT_SUCCESS`로 실패한다. */
export function replaySourceJobSteps({ sourceRunId, jobs, jobName, code }) {
  const matches = (Array.isArray(jobs?.jobs) ? jobs.jobs : []).filter((job) => job?.name === jobName && job.run_id === Number(sourceRunId));
  if (matches.length !== 1 || !Array.isArray(matches[0].steps)) fail(`${code}_STEP_NOT_SUCCESS`, `run ${sourceRunId} has no single ${jobName} job`);
  return matches[0].steps;
}

/** 이름이 name인 step이 하나뿐이고 끝났으면 그 결론을, 아니면 null을 돌려준다. */
export function stepConclusion(steps, name) {
  const matches = steps.filter((item) => item?.name === name);
  return matches.length === 1 && matches[0].status === "completed" ? matches[0].conclusion : null;
}

/** 심볼릭 링크가 아닌 일반 파일이고 크기 상한 안일 때만 읽는다. 아니면 code로 실패한다. */
export async function readReplaySourceFile(file, code) {
  const stat = await lstat(file).catch(() => null);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) fail(code, `${path.basename(file)} is not a regular file within the size limit`);
  return readFile(file);
}
