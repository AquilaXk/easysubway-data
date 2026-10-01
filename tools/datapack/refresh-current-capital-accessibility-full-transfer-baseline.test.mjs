import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  TRANSFER_SOURCE_ADMISSION_ALLOWED_DESCENDANT_PATHS,
  buildCurrentCapitalAccessibilityRefreshOutputs,
  deriveTransferSourceAdmissionTransitionOutputs,
  refreshCurrentCapitalAccessibilityFull,
} from "./refresh-current-capital-accessibility-full.mjs";
import { NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS } from "./refresh-nationwide-candidate.mjs";
import { currentLiveChainTransferOutputPaths } from "./rebind-current-live-chain-transfer-derived-identities.mjs";

// #862 결정 1(A2): 결정 C의 환승 source-admission-only 재결속(5출력) 뒤 accessibility-full을 다시 만들 때,
// 재결속 직전 커밋(baseline)의 바이트를 prestate로 삼아 기존 TRANSFER 전이 검증 함수에 넘긴다.
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const DESCRIPTOR = "tools/datapack/sources/seoul-metro-transfer-distance-duration-20260815T094038817Z.json";
const TRANSFER_PATHS = currentLiveChainTransferOutputPaths(DESCRIPTOR, { sourceAdmissionOnly: true });
const ALL_PATHS = currentLiveChainTransferOutputPaths(DESCRIPTOR);
const RELEASE_PATHS = ALL_PATHS.filter((relative) => !TRANSFER_PATHS.includes(relative));
const CANONICAL_PACK = "tools/datapack/release/capital-production-canonical-pack.json";

async function git(root, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return stdout.trim();
}

async function write(root, relative, value) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

async function commit(root, message, files) {
  for (const [relative, value] of Object.entries(files)) await write(root, relative, value);
  await git(root, "add", "--", ...Object.keys(files));
  await git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

// baseline → 환승 재결속 커밋(5개) → 후보 재생성 커밋(후보·request·hash)을 가진 합성 저장소.
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-source-admission-baseline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "fixture");
  const inventory = (marker) => ({ sources: [{ id: "seoul-metro-transfer-distance-duration", marker, transferAdmissionEvidence: { snapshotPath: DESCRIPTOR } }] });
  const initial = Object.fromEntries(ALL_PATHS.map((relative) => [relative, `${relative}:v0\n`]));
  const baseline = await commit(root, "baseline", {
    ...initial, "tools/datapack/source-inventory.json": inventory("v0"), [CANONICAL_PACK]: "pack:v0\n",
  });
  const rebind = await commit(root, "transfer rebind", {
    ...Object.fromEntries(TRANSFER_PATHS.filter((relative) => relative !== "tools/datapack/source-inventory.json")
      .map((relative) => [relative, `${relative}:v1\n`])),
    "tools/datapack/source-inventory.json": inventory("v1"),
  });
  const refresh = await commit(root, "candidate refresh", Object.fromEntries(RELEASE_PATHS.map((relative) => [relative, `${relative}:v1\n`])));
  return { root, baseline, rebind, refresh };
}

test("TRANSFER source admission baseline은 재결속 직전 바이트를 prestate로, 작업 트리를 bytes로 8출력을 만든다(#862 A2)", async (t) => {
  const { root, baseline } = await repository(t);
  const outputs = await deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: root, baselineGitSha: baseline });
  assert.deepEqual(outputs.map(({ relative }) => relative), ALL_PATHS);
  for (const output of outputs) {
    assert.deepEqual(Object.keys(output).sort(), ["bytes", "prestate", "relative"]);
    assert.deepEqual(output.prestate, Buffer.from(await git(root, "show", `${baseline}:${output.relative}`) + "\n"));
    assert.deepEqual(output.bytes, await readFile(path.join(root, output.relative)));
  }
});

test("HEAD의 조상이 아닌 baseline은 거부한다(#862 A2)", async (t) => {
  const { root, baseline } = await repository(t);
  const orphan = await git(root, "commit-tree", `${baseline}^{tree}`, "-m", "orphan");
  await assert.rejects(
    deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: root, baselineGitSha: orphan }),
    /TRANSFER source admission baseline is not an ancestor of HEAD/,
  );
  await assert.rejects(
    deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: root, baselineGitSha: "HEAD~2" }),
    /TRANSFER source admission baseline must be a full git SHA/,
  );
});

test("dirty tree에서는 거부한다(#862 A2)", async (t) => {
  const { root, baseline } = await repository(t);
  await write(root, "tools/datapack/release/release-request.json", "uncommitted\n");
  await assert.rejects(
    deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: root, baselineGitSha: baseline }),
    /TRANSFER source admission requires a clean tree/,
  );
});

test("baseline 이후 TRANSFER 5개·후보 재생성 출력 밖의 정본 팩·route 입력이 바뀌면 거부한다(#862 A2)", async (t) => {
  const { root, baseline } = await repository(t);
  await commit(root, "canonical pack drift", { [CANONICAL_PACK]: "pack:v1\n" });
  await assert.rejects(
    deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: root, baselineGitSha: baseline }),
    new RegExp(`TRANSFER source admission baseline changed non-TRANSFER inputs: ${CANONICAL_PACK}`),
  );
  const routeInput = "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json";
  const second = await repository(t);
  await commit(second.root, "route input drift", { [routeInput]: "route:v1\n" });
  await assert.rejects(
    deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: second.root, baselineGitSha: second.baseline }),
    new RegExp(`TRANSFER source admission baseline changed non-TRANSFER inputs: ${routeInput}`),
  );
});

test("baseline 바이트가 마지막 TRANSFER 재결속 커밋의 prestate와 다르면 거부한다(#862 A2)", async (t) => {
  const { root, baseline, rebind } = await repository(t);
  // baseline 이후 TRANSFER 경로를 바꾼 커밋이 하나 더 있으면, 마지막 재결속 커밋의 prestate는 baseline이 아니다.
  await commit(root, "second transfer rebind", { "tools/datapack/release/current-transfer-topology-metrics.json": "metrics:v2\n" });
  await assert.rejects(
    deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: root, baselineGitSha: baseline }),
    /TRANSFER source admission baseline bytes differ from the rebind commit prestate: tools\/datapack\/release\/current-transfer-topology-metrics\.json/,
  );
  // 재결속 커밋 자체를 baseline으로 쓰면 그 뒤 변경만 남으므로 같은 규칙으로 판정된다.
  await assert.doesNotReject(deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: root, baselineGitSha: rebind }));
});

test("기존 TRANSFER 전이 검증 함수가 거부하는 출력은 그대로 거부된다(#862 A2)", async () => {
  const inventory = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/source-inventory.json"), "utf8"));
  const descriptor = inventory.sources.find(({ id }) => id === "seoul-metro-transfer-distance-duration").transferAdmissionEvidence.snapshotPath;
  const outputs = await Promise.all(currentLiveChainTransferOutputPaths(descriptor).map(async (relative) => {
    const bytes = await readFile(path.join(ROOT, relative));
    return { relative, bytes, prestate: bytes };
  }));
  const drifted = outputs.map((output) => output.relative.endsWith("current-transfer-topology-metrics.json")
    ? { ...output, bytes: Buffer.concat([output.bytes, Buffer.from("\n")]) } : output);
  await assert.rejects(
    buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: ROOT, transferSourceAdmissionOutputs: drifted }),
    /current-capital refresh TRANSFER rebind output drift/,
  );
  await assert.rejects(
    buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: ROOT, transferSourceAdmissionOutputs: outputs.slice(0, 5) }),
    /current-capital refresh TRANSFER rebind outputs mismatch/,
  );
});

test("TRANSFER source admission 허용 경로는 후보 재생성 출력(전국 정본 팩 제외)과 문서 파편뿐이다(#862 A2)", () => {
  assert.deepEqual(
    [...TRANSFER_SOURCE_ADMISSION_ALLOWED_DESCENDANT_PATHS].sort(),
    [
      ...NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.filter((relative) => relative !== "tools/datapack/release/nationwide-production-canonical-pack.json"),
      "contracts/documentation/documentation-fragment.json",
    ].sort(),
  );
});

test("CLI 경로는 refresh 잠금을 만들기 전에 baseline·clean tree를 검사한다(#862 A2)", async (t) => {
  const { root, baseline } = await repository(t);
  // 잠금 디렉터리는 untracked라서, 잠금 뒤에 검사하면 clean tree가 항상 dirty로 보인다.
  // 합성 저장소에는 refresh 입력이 없으므로 baseline 검사를 통과한 뒤 다음 단계에서 멈춰야 한다.
  await assert.rejects(
    refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root, transferSourceAdmissionBaselineGitSha: baseline }),
    (error) => !/TRANSFER source admission/.test(error.message),
  );
  await write(root, "tools/datapack/release/release-request.json", "uncommitted\n");
  await assert.rejects(
    refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root, transferSourceAdmissionBaselineGitSha: baseline }),
    /TRANSFER source admission requires a clean tree/,
  );
  await assert.rejects(readFile(path.join(root, "tools/datapack/.current-capital-accessibility-refresh.lock/owner.json")), /ENOENT/);
});

test("baseline 이후 코드(*.mjs)·테스트 등록 변경은 데이터 입력이 아니므로 허용하고, 데이터 경로는 계속 거부한다(#862 A2)", async (t) => {
  const { root, baseline } = await repository(t);
  await commit(root, "tool change", {
    "tools/datapack/refresh-current-capital-accessibility-full.mjs": "export {};\n",
    "tools/datapack/refresh-current-capital-accessibility-full-transfer-baseline.test.mjs": "export {};\n",
    "tools/ci/data-test-ownership.json": { tests: [] },
  });
  const outputs = await deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: root, baselineGitSha: baseline });
  assert.equal(outputs.length, 8);
  await commit(root, "data json drift", { "tools/datapack/release/current-capital-live-chain-fan-in.json": "fan-in:v1\n" });
  await assert.rejects(
    deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: root, baselineGitSha: baseline }),
    /TRANSFER source admission baseline changed non-TRANSFER inputs: tools\/datapack\/release\/current-capital-live-chain-fan-in\.json/,
  );
});
