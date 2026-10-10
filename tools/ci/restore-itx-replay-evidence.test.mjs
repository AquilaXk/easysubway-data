import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ITX_REPLAY_EVIDENCE_FILES, main, verifyItxReplaySource } from "./restore-itx-replay-evidence.mjs";

// #1127: 하루 한 번만 받을 수 있는 ITX 수집분을 이전 run의 artifact에서 되살릴 때의 거부 사례를 고정한다.
// 이 도구는 공급자를 부르지 않는다. 이전 run이 실제로 수집·게이트 통과한 증거만 되살리고, 하나라도 어긋나면 추정하지 않고 실패한다.
const REPOSITORY = "AquilaXk/easysubway-data";
const SOURCE_RUN_ID = "38062621511";
const ARTIFACT_ID = "itx-cheongchun-source-timetable-20261010151222895";
const ADMITTED_ID = "itx-cheongchun-source-timetable-20261004151519524";
const FRESH_UNTIL = "2026-10-18T00:00:00+09:00";
const NOW = new Date("2026-10-10T17:30:00Z");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function evidence(overrides = {}) {
  const capture = Buffer.from(overrides.captureText ?? '{"capture":"retained provider bytes"}\n');
  const completeness = bytes({ artifactKind: "itx-completeness", sourceTimetableArtifact: { artifactId: ARTIFACT_ID } });
  const result = {
    artifactKind: "itx-cheongchun-source-timetable",
    artifactId: ARTIFACT_ID,
    observedAt: "2026-10-10T15:12:22.895Z",
    freshUntil: FRESH_UNTIL,
    validationStatus: "SUPPORTED",
    completenessEvidenceSha256: sha256(completeness),
    ...overrides.result,
  };
  const resultBytes = bytes(result);
  const receipt = {
    artifactKind: "itx-promotion-gate-receipt",
    policyId: "itx-promotion-gate-v1",
    status: "PASS",
    candidate: { artifactId: result.artifactId, sha256: sha256(resultBytes), observedAt: result.observedAt, freshUntil: result.freshUntil },
    source: { rawCaptureSha256: sha256(capture) },
    ...overrides.receipt,
  };
  return {
    "freshness.json": bytes({ artifactKind: "itx-admission-service-dates" }),
    "itx-completeness.json": completeness,
    "itx-promotion-gate.json": bytes(receipt),
    "itx-replay.json": bytes({ artifactKind: "itx-replay" }),
    "itx-result.json": resultBytes,
    "provider-response-capture.json": capture,
    ...overrides.files,
  };
}

const run = (overrides = {}) => ({
  id: Number(SOURCE_RUN_ID),
  path: ".github/workflows/itx-current-promotion.yml",
  head_branch: "main",
  event: "workflow_dispatch",
  repository: { full_name: REPOSITORY },
  ...overrides,
});
const step = (name, conclusion = "success") => ({ name, status: "completed", conclusion });
const jobs = (steps = [step("Collect current ITX timetable"), step("Evaluate promotion gate")]) => ({
  total_count: 1,
  jobs: [{ id: 1, run_id: Number(SOURCE_RUN_ID), name: "ITX current promotion", steps }],
});
const contract = (artifactId = ADMITTED_ID) => ({ sourceTimetableArtifact: { status: "ADMITTED", artifactId, freshUntil: "2026-10-12T00:00:00+09:00" } });
const verify = (overrides = {}) => verifyItxReplaySource({
  sourceRunId: SOURCE_RUN_ID, repository: REPOSITORY, run: run(), jobs: jobs(), files: evidence(), contract: contract(), now: NOW, ...overrides,
});

test("수집기가 성공하고 게이트가 통과한 이전 run의 증거는 되살린다", () => {
  const result = verify();
  assert.equal(result.artifactId, ARTIFACT_ID);
  assert.equal(result.freshUntil, FRESH_UNTIL);
  assert.deepEqual(Object.keys(result.outputs).sort(), ["freshness.json", "itx-completeness.json", "itx-result.json", "provider-response-capture.json"]);
  // 재생·게이트는 되살리지 않는다. 이어지는 step이 보관 capture에서 다시 계산한다.
  assert.equal(result.outputs["itx-replay.json"], undefined);
  assert.equal(result.outputs["itx-promotion-gate.json"], undefined);
  assert.equal(Buffer.compare(result.outputs["provider-response-capture.json"], evidence()["provider-response-capture.json"]), 0);
});

test("재생 run이 되살려 올린 증거도 다음 재생의 원본이 된다 (수집기 대신 복원 step이 성공한 run)", () => {
  const chained = jobs([step("Collect current ITX timetable", "skipped"), step("Restore retained ITX collection evidence"), step("Evaluate promotion gate")]);
  assert.equal(verify({ jobs: chained }).artifactId, ARTIFACT_ID);
});

test("이 workflow의 main run이 아니면 거부한다", () => {
  for (const override of [
    { id: 1 },
    { path: ".github/workflows/itx-current-collection.yml" },
    { head_branch: "automation/977-itx-promotion-1" },
    { event: "pull_request" },
    { repository: { full_name: "AquilaXk/other" } },
  ]) {
    assert.throws(() => verify({ run: run(override) }), /ITX_REPLAY_RUN_INVALID/u, JSON.stringify(override));
  }
  assert.throws(() => verify({ sourceRunId: "abc" }), /ITX_REPLAY_RUN_INVALID/u);
});

test("수집기도 복원 step도 성공하지 않았거나 게이트 step이 성공하지 않았으면 거부한다", () => {
  for (const steps of [
    [step("Collect current ITX timetable", "skipped"), step("Evaluate promotion gate")],
    [step("Collect current ITX timetable", "failure"), step("Evaluate promotion gate", "skipped")],
    [step("Collect current ITX timetable"), step("Evaluate promotion gate", "failure")],
    [step("Collect current ITX timetable")],
    [step("Collect current ITX timetable"), step("Restore retained ITX collection evidence"), step("Evaluate promotion gate")],
  ]) {
    assert.throws(() => verify({ jobs: jobs(steps) }), /ITX_REPLAY_STEP_NOT_SUCCESS/u, JSON.stringify(steps.map((item) => item.conclusion)));
  }
  assert.throws(() => verify({ jobs: { total_count: 0, jobs: [] } }), /ITX_REPLAY_STEP_NOT_SUCCESS/u);
});

test("artifact 파일 집합이 정확히 여섯 개가 아니면 거부한다", () => {
  for (const name of ITX_REPLAY_EVIDENCE_FILES) {
    const files = evidence();
    delete files[name];
    assert.throws(() => verify({ files }), /ITX_REPLAY_ARTIFACT_INVALID/u, name);
  }
  assert.throws(() => verify({ files: evidence({ files: { "extra.json": Buffer.from("{}") } }) }), /ITX_REPLAY_ARTIFACT_INVALID/u);
});

test("영수증이 PASS가 아니거나 후보·capture·완전성 해시가 서로 맞지 않으면 거부한다", () => {
  assert.throws(() => verify({ files: evidence({ receipt: { status: "BLOCK" } }) }), /ITX_REPLAY_BINDING_MISMATCH/u);
  assert.throws(() => verify({ files: evidence({ captureText: '{"capture":"retained"}\n', receipt: { source: { rawCaptureSha256: sha256("other") } } }) }), /ITX_REPLAY_BINDING_MISMATCH/u);
  assert.throws(() => verify({ files: evidence({ receipt: { candidate: { artifactId: ARTIFACT_ID, sha256: sha256("other"), observedAt: "2026-10-10T15:12:22.895Z", freshUntil: FRESH_UNTIL } } }) }), /ITX_REPLAY_BINDING_MISMATCH/u);
  assert.throws(() => verify({ files: evidence({ result: { completenessEvidenceSha256: sha256("other") } }) }), /ITX_REPLAY_BINDING_MISMATCH/u);
  assert.throws(() => verify({ files: evidence({ result: { validationStatus: "MISSING" } }) }), /ITX_REPLAY_BINDING_MISMATCH/u);
  // 바이트가 한 글자라도 바뀐 capture는 영수증의 해시와 맞지 않는다.
  const tampered = evidence();
  tampered["provider-response-capture.json"] = Buffer.from('{"capture":"retained provider bytez"}\n');
  assert.throws(() => verify({ files: tampered }), /ITX_REPLAY_BINDING_MISMATCH/u);
  const garbled = evidence();
  garbled["itx-promotion-gate.json"] = Buffer.from("not json");
  assert.throws(() => verify({ files: garbled }), /ITX_REPLAY_ARTIFACT_INVALID/u);
});

test("이미 승격됐거나 더 옛날 후보는 거부한다 (같은 수집분을 두 번 올리지 않는다)", () => {
  assert.throws(() => verify({ contract: contract(ARTIFACT_ID) }), /ITX_REPLAY_ALREADY_ADMITTED/u);
  assert.throws(() => verify({ contract: contract("itx-cheongchun-source-timetable-20261011151222895") }), /ITX_REPLAY_ALREADY_ADMITTED/u);
  assert.throws(() => verify({ files: evidence({ result: { artifactId: "itx-cheongchun-source-timetable-bad" } }) }), /ITX_REPLAY_BINDING_MISMATCH/u);
});

test("후보의 신선도가 이미 지났으면 거부한다", () => {
  assert.throws(() => verify({ now: new Date("2026-10-17T15:00:00Z") }), /ITX_REPLAY_EXPIRED/u);
  assert.equal(verify({ now: new Date("2026-10-17T14:59:59Z") }).artifactId, ARTIFACT_ID);
});

test("CLI는 검증된 네 파일을 출력 위치에 쓰고 이미 있는 파일을 덮어쓰지 않는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "restore-itx-replay-"));
  try {
    const input = path.join(dir, "artifact");
    const output = path.join(dir, "operation");
    await Promise.all([input, output].map((target) => import("node:fs/promises").then(({ mkdir }) => mkdir(target))));
    for (const [name, content] of Object.entries(evidence())) await writeFile(path.join(input, name), content);
    await writeFile(path.join(dir, "run.json"), JSON.stringify(run()));
    await writeFile(path.join(dir, "jobs.json"), JSON.stringify(jobs()));
    await writeFile(path.join(dir, "contract.json"), JSON.stringify(contract()));
    const argv = ["--source-run-id", SOURCE_RUN_ID, "--repository", REPOSITORY, "--run", path.join(dir, "run.json"), "--jobs", path.join(dir, "jobs.json"),
      "--artifact-dir", input, "--contract", path.join(dir, "contract.json"), "--output-root", output];
    const logs = [];
    const result = await main(argv, { now: NOW, log: (line) => logs.push(line) });
    assert.equal(result.artifactId, ARTIFACT_ID);
    assert.deepEqual((await readdir(output)).sort(), ["freshness.json", "itx-completeness.json", "itx-result.json", "provider-response-capture.json"]);
    assert.equal(Buffer.compare(await readFile(path.join(output, "provider-response-capture.json")), evidence()["provider-response-capture.json"]), 0);
    assert.equal(logs.length, 1);
    await assert.rejects(main(argv, { now: NOW, log: () => {} }), /ITX_REPLAY_OUTPUT_EXISTS/u);
    await assert.rejects(main(argv.slice(0, -2), { now: NOW, log: () => {} }), /ITX_REPLAY_INPUT_INVALID/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI는 artifact 디렉터리의 심볼릭 링크와 예상 밖 파일을 거부한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "restore-itx-replay-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    const input = path.join(dir, "artifact");
    const output = path.join(dir, "operation");
    await mkdir(input);
    await mkdir(output);
    for (const [name, content] of Object.entries(evidence())) await writeFile(path.join(input, name), content);
    await rm(path.join(input, "itx-result.json"));
    await writeFile(path.join(dir, "elsewhere.json"), evidence()["itx-result.json"]);
    await symlink(path.join(dir, "elsewhere.json"), path.join(input, "itx-result.json"));
    await writeFile(path.join(dir, "run.json"), JSON.stringify(run()));
    await writeFile(path.join(dir, "jobs.json"), JSON.stringify(jobs()));
    await writeFile(path.join(dir, "contract.json"), JSON.stringify(contract()));
    const argv = ["--source-run-id", SOURCE_RUN_ID, "--repository", REPOSITORY, "--run", path.join(dir, "run.json"), "--jobs", path.join(dir, "jobs.json"),
      "--artifact-dir", input, "--contract", path.join(dir, "contract.json"), "--output-root", output];
    await assert.rejects(main(argv, { now: NOW, log: () => {} }), /ITX_REPLAY_ARTIFACT_INVALID/u);
    assert.deepEqual(await readdir(output), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
