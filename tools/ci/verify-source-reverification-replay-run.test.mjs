import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main, verifySourceReverificationReplayRun } from "./verify-source-reverification-replay-run.mjs";

const REPOSITORY = "AquilaXk/easysubway-data";
const SOURCE_RUN_ID = "39369279984";
const REVERIFY = "Reverify due P7D sources";
const UPLOAD = "Upload the retained collection for a later replay";

const run = (overrides = {}) => ({
  id: Number(SOURCE_RUN_ID),
  path: ".github/workflows/source-reverification.yml",
  head_branch: "main",
  event: "schedule",
  repository: { full_name: REPOSITORY },
  ...overrides,
});
const step = (name, conclusion = "success", status = "completed") => ({ name, status, conclusion });
const job = (steps, overrides = {}) => ({ id: 1, run_id: Number(SOURCE_RUN_ID), name: "Source reverification", steps, ...overrides });
const jobs = (list = [job([step(REVERIFY), step(UPLOAD)])]) => ({ total_count: list.length, jobs: list });
const verify = (overrides = {}) => verifySourceReverificationReplayRun({ sourceRunId: SOURCE_RUN_ID, repository: REPOSITORY, run: run(), jobs: jobs(), ...overrides });

test("main에서 정기 실행이나 dispatch로 돈 이 workflow의 run이고 재확인과 재생 묶음 업로드가 성공했으면 받는다", () => {
  for (const event of ["schedule", "workflow_dispatch"]) assert.doesNotThrow(() => verify({ run: run({ event }) }), event);
});

test("다른 저장소(fork)·다른 브랜치·다른 workflow·다른 이벤트·다른 id의 run은 REVERIFICATION_REPLAY_SOURCE_RUN_INVALID로 거부한다", () => {
  for (const override of [
    { repository: { full_name: "someone/easysubway-data" } },
    { repository: undefined },
    { head_branch: "automation/984-source-reverification-1" },
    { path: ".github/workflows/itx-current-promotion.yml" },
    { event: "pull_request" },
    { event: "push" },
    { id: Number(SOURCE_RUN_ID) + 1 },
  ]) {
    assert.throws(() => verify({ run: run(override) }), /^Error: REVERIFICATION_REPLAY_SOURCE_RUN_INVALID: run 39369279984 is not a main run of source-reverification\.yml/u, JSON.stringify(override));
  }
  assert.throws(() => verify({ run: null }), /REVERIFICATION_REPLAY_SOURCE_RUN_INVALID/u);
});

test("숫자가 아닌 run id는 run을 보기 전에 거부한다", () => {
  for (const sourceRunId of ["abc", "0", "", "-1", "1e3", "12345678901234567", 39369279984, undefined]) {
    assert.throws(() => verify({ sourceRunId }), /^Error: REVERIFICATION_REPLAY_SOURCE_RUN_INVALID: source run id$/u, String(sourceRunId));
  }
});

test("재확인이나 묶음 업로드가 성공하지 않은 원본 run은 REVERIFICATION_REPLAY_SOURCE_STEP_NOT_SUCCESS로 거부한다", () => {
  for (const [label, steps] of [
    ["재확인 실패", [step(REVERIFY, "failure"), step(UPLOAD, "skipped")]],
    ["업로드 건너뜀(push 안 됨)", [step(REVERIFY), step(UPLOAD, "skipped")]],
    ["업로드 실패", [step(REVERIFY), step(UPLOAD, "failure")]],
    ["재확인이 아직 도는 중", [step(REVERIFY, null, "in_progress"), step(UPLOAD)]],
    ["업로드 step 없음", [step(REVERIFY)]],
    ["같은 이름 step 둘", [step(REVERIFY), step(UPLOAD), step(UPLOAD)]],
  ]) {
    assert.throws(() => verify({ jobs: jobs([job(steps)]) }), /^Error: REVERIFICATION_REPLAY_SOURCE_STEP_NOT_SUCCESS: run 39369279984 did not pass /u, label);
  }
});

test("그 run의 Source reverification job이 정확히 하나가 아니면 거부한다", () => {
  const good = [step(REVERIFY), step(UPLOAD)];
  for (const [label, list] of [
    ["job 없음", []],
    ["다시 실행해 job이 둘", [job(good), job(good, { id: 2 })]],
    ["다른 run의 job", [job(good, { run_id: 1 })]],
    ["다른 이름의 job", [job(good, { name: "ITX current promotion" })]],
    ["step 목록 없음", [job(undefined)]],
  ]) {
    assert.throws(() => verify({ jobs: jobs(list) }), /^Error: REVERIFICATION_REPLAY_SOURCE_STEP_NOT_SUCCESS: run 39369279984 has no single Source reverification job$/u, label);
  }
});

test("CLI는 gh api 응답 파일을 읽어 확인하고, 일반 파일이 아니거나 JSON이 아니거나 인자가 빠지면 REVERIFICATION_REPLAY_SOURCE_INPUT_INVALID로 실패한다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "verify-reverification-replay-run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runFile = path.join(directory, "run.json");
  const jobsFile = path.join(directory, "jobs.json");
  await writeFile(runFile, JSON.stringify(run()));
  await writeFile(jobsFile, JSON.stringify(jobs()));
  const args = (overrides = {}) => Object.entries({ "--source-run-id": SOURCE_RUN_ID, "--repository": REPOSITORY, "--run": runFile, "--jobs": jobsFile, ...overrides }).flat();
  const logs = [];
  assert.deepEqual(await main(args(), { log: (line) => logs.push(line) }), { sourceRunId: SOURCE_RUN_ID, workflow: ".github/workflows/source-reverification.yml", verified: true });
  assert.equal(logs.length, 1);

  await assert.rejects(main(args({ "--repository": "someone/easysubway-data" }), { log: () => {} }), /REVERIFICATION_REPLAY_SOURCE_RUN_INVALID/u);
  const linked = path.join(directory, "linked.json");
  await symlink(runFile, linked);
  await assert.rejects(main(args({ "--run": linked }), { log: () => {} }), /^Error: REVERIFICATION_REPLAY_SOURCE_INPUT_INVALID: linked\.json is not a regular file/u);
  const text = path.join(directory, "text.json");
  await writeFile(text, "not json");
  await assert.rejects(main(args({ "--jobs": text }), { log: () => {} }), /^Error: REVERIFICATION_REPLAY_SOURCE_INPUT_INVALID: .*is not JSON/u);
  await assert.rejects(main(args().slice(0, 6), { log: () => {} }), /^Error: REVERIFICATION_REPLAY_SOURCE_INPUT_INVALID: missing jobs$/u);
  await assert.rejects(main([...args(), "--extra", "x"], { log: () => {} }), /^Error: REVERIFICATION_REPLAY_SOURCE_INPUT_INVALID: argument --extra$/u);
});
