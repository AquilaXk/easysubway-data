#!/usr/bin/env node
// P7D 원천 재확인 재생(#3036)이 artifact를 받기 전에 원본 run을 확인한다. 공급자를 부르지 않고 아무것도 쓰지 않는다.
// 원본은 이 저장소 main에서 정기 실행이나 dispatch로 돈 source-reverification.yml run이고, 재확인 step과 재생 묶음 업로드 step이 성공한 run이어야 한다.
// 다른 workflow·브랜치·저장소의 같은 이름 artifact나, 수집이 실패한 run의 artifact는 받지 않는다. 규칙은 ITX 재생(restore-itx-replay-evidence)과 같은 replay-source-run이다.
//
// 사용: node tools/ci/verify-source-reverification-replay-run.mjs --source-run-id <run id> --repository <owner/repo> --run <gh api run json> --jobs <gh api jobs json>
import { pathToFileURL } from "node:url";

import { readReplaySourceFile, replaySourceJobSteps, stepConclusion, verifyReplaySourceRun } from "./replay-source-run.mjs";

export const SOURCE_REVERIFICATION_WORKFLOW_PATH = ".github/workflows/source-reverification.yml";
export const SOURCE_REVERIFICATION_JOB = "Source reverification";
export const SOURCE_REVERIFICATION_REPLAY_SOURCE_STEPS = Object.freeze(["Reverify due P7D sources", "Upload the retained collection for a later replay"]);
const CODE = "REVERIFICATION_REPLAY_SOURCE";

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

/** 원본 run 메타데이터와 job 목록을 확인한다. 어긋나면 REVERIFICATION_REPLAY_SOURCE_* 코드로 실패한다. */
export function verifySourceReverificationReplayRun({ sourceRunId, repository, run, jobs }) {
  verifyReplaySourceRun({ sourceRunId, repository, run, workflowPath: SOURCE_REVERIFICATION_WORKFLOW_PATH, code: CODE });
  const steps = replaySourceJobSteps({ sourceRunId, jobs, jobName: SOURCE_REVERIFICATION_JOB, code: CODE });
  const unfinished = SOURCE_REVERIFICATION_REPLAY_SOURCE_STEPS.filter((name) => stepConclusion(steps, name) !== "success");
  const listed = unfinished.map((name) => JSON.stringify(name)).join(", ");
  if (unfinished.length > 0) fail(`${CODE}_STEP_NOT_SUCCESS`, `run ${sourceRunId} did not pass ${listed}`);
}

function parseArgs(argv) {
  const keys = new Map([["--source-run-id", "sourceRunId"], ["--repository", "repository"], ["--run", "run"], ["--jobs", "jobs"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string" || argv[index + 1] === "") fail(`${CODE}_INPUT_INVALID`, `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of keys.values()) if (!Object.hasOwn(values, key)) fail(`${CODE}_INPUT_INVALID`, `missing ${key}`);
  return values;
}

export async function main(argv, { log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const values = parseArgs(argv);
  const readJson = async (file) => {
    const bytes = await readReplaySourceFile(file, `${CODE}_INPUT_INVALID`);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      return fail(`${CODE}_INPUT_INVALID`, `${file} is not JSON: ${error.message}`);
    }
  };
  verifySourceReverificationReplayRun({ sourceRunId: values.sourceRunId, repository: values.repository, run: await readJson(values.run), jobs: await readJson(values.jobs) });
  const summary = { sourceRunId: values.sourceRunId, workflow: SOURCE_REVERIFICATION_WORKFLOW_PATH, verified: true };
  log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
