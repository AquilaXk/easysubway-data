import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  NATIONWIDE_CANDIDATE_REBIND_ALLOWED_DESCENDANT_PATHS,
  TRANSFER_SOURCE_ADMISSION_ALLOWED_DESCENDANT_PATHS,
  assertNationwideCandidateRebindBaseline,
  buildCurrentCapitalAccessibilityRefreshOutputs,
  nationwideCandidateRebindViolations,
  refreshCurrentCapitalAccessibilityFull,
} from "./refresh-current-capital-accessibility-full.mjs";
import { NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS } from "./refresh-nationwide-candidate.mjs";
import { CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH } from "./build-current-capital-live-chain-boundary.mjs";

// #872 결정 1(메인 2026-10-01): 전국 후보 재생성(refresh-nationwide-candidate) 뒤 live-chain fan-in의
// candidateBuildSpec 결속만 공식 함수로 다시 쓰는 좁은 모드. #866에서 전국 경로로 대체한 뒤 삭제한다.
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const STATION_INPUT = "tools/datapack/release/current-capital-accessibility-full/station-line-input.json";
const ROUTE_INPUT = "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json";
const NATIONWIDE_PACK = "tools/datapack/release/nationwide-production-canonical-pack.json";
const SPEC = "tools/datapack/release/candidate-build-spec.json";

async function git(root, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return stdout.trim();
}

async function write(root, relative, value) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

async function commit(root, message, files) {
  for (const [relative, value] of Object.entries(files)) await write(root, relative, value);
  await git(root, "add", "--", ...Object.keys(files));
  await git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

// baseline → 전국 후보 재생성 커밋(정본 팩·spec)을 가진 합성 저장소.
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nationwide-candidate-rebind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "fixture");
  const baseline = await commit(root, "baseline", {
    [SPEC]: "spec:v0\n", [NATIONWIDE_PACK]: "pack:v0\n", [CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH]: "fan-in:v0\n",
    [STATION_INPUT]: "station:v0\n", "tools/datapack/source-inventory.json": "inventory:v0\n",
  });
  await commit(root, "nationwide candidate refresh", { [SPEC]: "spec:v1\n", [NATIONWIDE_PACK]: "pack:v1\n" });
  return { root, baseline };
}

function boundary(overrides = {}) {
  const components = Object.fromEntries(["candidateBuildSpec", "facilityAdmission", "sourceInventory", "transferMetrics"]
    .map((name, index) => [name, { path: `${name}.json`, sha256: String(index).repeat(64) }]));
  return {
    components: { ...components, ...(overrides.components ?? {}) },
    currentCandidateSourceSetSha256: overrides.currentCandidateSourceSetSha256 ?? "a".repeat(64),
    evidenceSourceSetSha256: overrides.evidenceSourceSetSha256 ?? "b".repeat(64),
  };
}

function decision(overrides = {}) {
  const committed = boundary();
  return {
    alreadyCurrent: true,
    stationPrestate: Buffer.from("station\n"),
    stationBytes: Buffer.from("station\n"),
    routePrestate: Buffer.from("route\n"),
    routeBytes: Buffer.from("route\n"),
    committedFanIn: committed,
    recomputedFanIn: boundary({ components: { candidateBuildSpec: { path: "candidateBuildSpec.json", sha256: "f".repeat(64) } } }),
    ...overrides,
  };
}

test("전국 후보 재결속은 candidateBuildSpec 결속만 바뀌고 수도권 출력·후보 식별이 같을 때만 허용한다(#872 결정 1)", () => {
  assert.deepEqual(nationwideCandidateRebindViolations(decision()), []);
});

test("candidateBuildSpec 외 fan-in component가 바뀌면 거부한다(#872 결정 1)", () => {
  const recomputed = boundary({ components: {
    candidateBuildSpec: { path: "candidateBuildSpec.json", sha256: "f".repeat(64) },
    transferMetrics: { path: "transferMetrics.json", sha256: "e".repeat(64) },
  } });
  assert.deepEqual(nationwideCandidateRebindViolations(decision({ recomputedFanIn: recomputed })),
    ["fan-in component changed outside candidateBuildSpec: transferMetrics"]);
  const sourceSetDrift = boundary({
    components: { candidateBuildSpec: { path: "candidateBuildSpec.json", sha256: "f".repeat(64) } },
    evidenceSourceSetSha256: "c".repeat(64),
  });
  assert.deepEqual(nationwideCandidateRebindViolations(decision({ recomputedFanIn: sourceSetDrift })),
    ["fan-in source set changed"]);
});

test("수도권 station-line·route-edge 출력 바이트가 바뀌면 거부한다(#872 결정 1)", () => {
  assert.deepEqual(nationwideCandidateRebindViolations(decision({ stationBytes: Buffer.from("station-v2\n") })),
    ["capital station-line input bytes changed"]);
  assert.deepEqual(nationwideCandidateRebindViolations(decision({ routeBytes: Buffer.from("route-v2\n") })),
    ["capital route-edge input bytes changed"]);
});

test("후보 id·source set이 바뀌면(alreadyCurrent 아님) 거부한다(#872 결정 1)", () => {
  assert.deepEqual(nationwideCandidateRebindViolations(decision({ alreadyCurrent: false })),
    ["candidate identity changed"]);
});

test("baseline 검사는 dirty tree·조상 아님·SHA 형식·후보 재생성 출력 밖 데이터 변경을 거부하고 코드 변경은 허용한다(#872 결정 1)", async (t) => {
  const { root, baseline } = await repository(t);
  await assert.doesNotReject(assertNationwideCandidateRebindBaseline({ repositoryRoot: root, baselineGitSha: baseline }));
  await assert.rejects(assertNationwideCandidateRebindBaseline({ repositoryRoot: root, baselineGitSha: "HEAD~1" }),
    /nationwide candidate rebind baseline must be a full git SHA/);
  const orphan = await git(root, "commit-tree", `${baseline}^{tree}`, "-m", "orphan");
  await assert.rejects(assertNationwideCandidateRebindBaseline({ repositoryRoot: root, baselineGitSha: orphan }),
    /nationwide candidate rebind baseline is not an ancestor of HEAD/);

  await write(root, SPEC, "uncommitted\n");
  await assert.rejects(assertNationwideCandidateRebindBaseline({ repositoryRoot: root, baselineGitSha: baseline }),
    /nationwide candidate rebind requires a clean tree/);
  await git(root, "restore", "--", SPEC);

  await commit(root, "tool change", { "tools/datapack/refresh-current-capital-accessibility-full.mjs": "export {};\n" });
  await assert.doesNotReject(assertNationwideCandidateRebindBaseline({ repositoryRoot: root, baselineGitSha: baseline }));
  await commit(root, "station drift", { [STATION_INPUT]: "station:v1\n" });
  await assert.rejects(assertNationwideCandidateRebindBaseline({ repositoryRoot: root, baselineGitSha: baseline }),
    new RegExp(`nationwide candidate rebind baseline changed non-candidate inputs: ${STATION_INPUT}`));
});

test("전국 후보 재결속 허용 경로는 refresh-nationwide-candidate 출력과 문서 파편뿐이다(#872 결정 1)", () => {
  assert.deepEqual(
    [...NATIONWIDE_CANDIDATE_REBIND_ALLOWED_DESCENDANT_PATHS].sort(),
    [...NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS, "contracts/documentation/documentation-fragment.json"].sort(),
  );
  assert.deepEqual(
    NATIONWIDE_CANDIDATE_REBIND_ALLOWED_DESCENDANT_PATHS.filter((relative) => !TRANSFER_SOURCE_ADMISSION_ALLOWED_DESCENDANT_PATHS.includes(relative)),
    [NATIONWIDE_PACK],
  );
});

test("CLI 경로는 refresh 잠금 전에 baseline·clean tree를 검사한다(#872 결정 1)", async (t) => {
  const { root, baseline } = await repository(t);
  await write(root, SPEC, "uncommitted\n");
  await assert.rejects(
    refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root, nationwideCandidateRebindBaselineGitSha: baseline }),
    /nationwide candidate rebind requires a clean tree/,
  );
  await assert.rejects(readFile(path.join(root, "tools/datapack/.current-capital-accessibility-refresh.lock/owner.json")), /ENOENT/);
});

test("커밋된 저장소에서 재결속 모드는 수도권 출력 바이트를 그대로 두고 커밋된 fan-in과 같은 바이트를 만든다(#872 결정 1)", async () => {
  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: ROOT, nationwideCandidateRebind: true });
  assert.deepEqual(outputs.map(({ relative }) => relative), [STATION_INPUT, ROUTE_INPUT]);
  for (const output of outputs) {
    assert.deepEqual(output.bytes, await readFile(path.join(ROOT, output.relative)), `${output.relative} must stay byte-identical`);
  }
  assert.deepEqual(outputs[0].fanIn.bytes, await readFile(path.join(ROOT, CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH)));
});
