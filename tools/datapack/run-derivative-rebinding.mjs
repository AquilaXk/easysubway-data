#!/usr/bin/env node
// 파생 산출물 재결속 controller(#969 P4, #870 전체 자동화 1단계).
//
// 원천 등록·재확인이 병합되면 원장 head와 수도권 정본 팩이 바뀌고, 그 head에 결속된 파생 산출물(환승 지표·보관 시간표 projection)도
// 다시 만들어야 한다. seq127에서는 에이전트가 아래 도구를 이 순서로 직접 실행했다. 이 controller가 같은 도구를 같은 순서로 실행한다.
//
//   1. retained-gwangju-projection        광주 보관 시간표 projection (원장 head observation을 OCI에서 GET만으로 받아 sha 확인)
//   2. busan-transfer-metrics             부산 공식 환승 지표
//   3. seoul-measured-transfer-metrics    서울 실측 환승 지표
//   4. seoul-transfer-source-admission    서울교통공사 환승 원천 admission을 현재 수도권 정본 팩에 재결속(OCI GET만)
//
// - 도구는 모두 멱등이다. 입력 결속이 이미 맞으면 바이트가 같아 diff가 없고, 바뀌었으면 그 단계 커밋이 생긴다. 커밋이 없으면 갱신할 것이 없다.
// - 단계마다 허용 경로만 바뀔 수 있다. 후보·release request·hash evidence·fan-in은 이 controller가 쓰지 않는다(후보 갱신의 몫이다).
// - 실패는 이후 단계를 막고 BINDING_MISMATCH(또는 단계가 붙인 코드)로 드러난다. 이전 값·추정치로 대체하지 않는다.
//
// 사용(깨끗한 작업 트리에서): node tools/datapack/run-derivative-rebinding.mjs --operation-root <absolute empty directory>
//   환경: EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL (OCI 읽기)
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { preauthenticatedObjectStorageClient, requireCurrentCapitalLiveChainOciParBaseUrl } from "./publish-object-storage.mjs";
import { evaluateLedgerChange, parseLedgerChangePolicy } from "../ci/source-ledger-gate.mjs";
import { runNodeScript } from "./refresh-nationwide-candidate.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const GIT = "/usr/bin/git";
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const LEDGER_PATH = "tools/datapack/release/source-snapshots.json";
const RETAINED_SOURCE_ID = "kric-nationwide-timetable-file";
const POLICY_PATH = "tools/ci/source-ledger-change-policy.json";
const OCI_OBJECT_URI = /^oci:\/\/axvym6vk8g7i\/easysubway-datapacks\/(.+)$/u;
const CODED = /^[A-Z][A-Z0-9_]+: /u;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fail(message) {
  throw new Error(message);
}

/** 원장 head 행의 OCI 객체(observation.json)를 GET만으로 받아 sha256·크기를 확인하고 운영 디렉터리에 쓴다. */
export async function restoreRetainedGwangjuObservation({ row, client, operationRoot }) {
  const fetchFailed = (detail) => fail(`SOURCE_FETCH_FAILED: retained Gwangju observation ${detail}`);
  const key = OCI_OBJECT_URI.exec(row?.rawObjectUri ?? "")?.[1];
  if (!key) fetchFailed("object URI is not an OCI object of the datapack bucket");
  let fetched;
  try {
    fetched = await client.readObject(key, { maxResponseBytes: row.byteSize });
  } catch (error) {
    fetchFailed(`GET failed: ${String(error?.message ?? error)}`);
  }
  if (!fetched?.exists) fetchFailed("object is missing");
  if (!Buffer.isBuffer(fetched.body) || fetched.body.length !== row.byteSize || sha256(fetched.body) !== row.rawObjectSha256) {
    fetchFailed("bytes do not match the ledger sha256 and size");
  }
  await mkdir(operationRoot, { recursive: true });
  const file = path.join(operationRoot, "retained-gwangju-observation.json");
  await writeFile(file, fetched.body, { flag: "w", mode: 0o600 });
  return file;
}

// 이 도구들은 출력 파일이 없어야 하므로 운영 디렉터리에 만든 뒤 바이트가 다를 때만 저장소 파일을 바꾼다.
function metricsStep({ id, script, relative, message }) {
  return {
    id,
    message,
    isAllowedPath: (candidate) => candidate === relative,
    async run({ repositoryRoot, operationRoot, execute }) {
      const output = path.join(operationRoot, `${id}.json`);
      await execute(script, ["--output", output]);
      const next = await readFile(output);
      const target = path.join(repositoryRoot, relative);
      const current = await readFile(target).catch(() => null);
      if (!current || !current.equals(next)) await copyFile(output, target);
    },
  };
}

export const DERIVATIVE_STEPS = Object.freeze([
  {
    id: "retained-gwangju-projection",
    message: "[Data] 광주 보관 시간표 projection을 현재 원장 head로 다시 만들기",
    isAllowedPath: (relative) => relative === INVENTORY_PATH || /^tools\/datapack\/sources\/kric-nationwide-timetable-file-gwangju-[0-9a-f]{64}\.json$/u.test(relative),
    async run({ repositoryRoot, operationRoot, env, execute, ociClient }) {
      const [inventory, ledger] = await Promise.all([INVENTORY_PATH, LEDGER_PATH].map(async (relative) => JSON.parse(await readFile(path.join(repositoryRoot, relative), "utf8"))));
      const source = inventory.sources.find(({ id }) => id === RETAINED_SOURCE_ID);
      const retained = source?.retainedScheduleAdmissionEvidence;
      const row = ledger.find((entry) => entry.sourceId === RETAINED_SOURCE_ID && entry.snapshotId === retained?.snapshotId);
      if (!row) fail("retained Gwangju ledger head is missing for the admitted evidence");
      // 이미 현재 head에 결속된 projection이면 231MB 관측을 다시 받지 않는다.
      if (source.retainedGwangjuProjectionEvidence?.retainedSnapshotId === row.snapshotId
        && source.retainedGwangjuProjectionEvidence.observationRawObjectSha256 === row.rawObjectSha256) return;
      const client = ociClient ?? preauthenticatedObjectStorageClient(requireCurrentCapitalLiveChainOciParBaseUrl(env), { includeErrorBody: false });
      const observation = await restoreRetainedGwangjuObservation({ row, client, operationRoot });
      await execute("project-retained-gwangju-timetable.mjs", ["--observation", observation]);
    },
  },
  metricsStep({
    id: "busan-transfer-metrics", script: "build-busan-transfer-metrics.mjs", relative: "tools/datapack/release/current-busan-transfer-metrics.json",
    message: "[Data] 부산 공식 환승 지표를 현재 부산 topology head로 다시 만들기",
  }),
  metricsStep({
    id: "seoul-measured-transfer-metrics", script: "build-seoul-measured-transfer-metrics.mjs", relative: "tools/datapack/release/current-seoul-measured-transfer-metrics.json",
    message: "[Data] 서울 실측 환승 지표를 현재 수도권 정본 팩에 맞춰 다시 만들기",
  }),
  {
    id: "seoul-transfer-source-admission",
    message: "[Data] 서울교통공사 환승 원천 admission을 현재 수도권 정본 팩에 다시 결속",
    isAllowedPath: (relative) => [
      "tools/datapack/release/current-transfer-topology-metrics.json", "tools/datapack/release/current-capital-transfer-topology-applicability.json", INVENTORY_PATH, LEDGER_PATH,
    ].includes(relative) || /^tools\/datapack\/sources\/seoul-metro-transfer-distance-duration-[0-9]{8}T[0-9]{9}Z\.json$/u.test(relative),
    async run({ repositoryRoot, execute }) {
      await execute("rebind-current-seoul-transfer-source-admission.mjs", ["--repository-root", repositoryRoot]);
    },
  },
]);

async function git(repositoryRoot, args) {
  return (await execFileAsync(GIT, args, { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function changedPaths(repositoryRoot) {
  const status = await git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  return status.split("\0").filter(Boolean).map((entry) => entry.slice(3)).sort();
}

// 단계가 원장을 바꿨으면 원장 변화 게이트를 통과해야 커밋된다(#975 리뷰 F5). 경로 allowlist는 변화의 크기를 모르기 때문이다.
// ledgerPath가 null이면 게이트를 끈다(원장이 없는 테스트 저장소용). 정책의 기본값은 저장소의 정책 파일이다.
async function assertLedgerChangeAllowed({ repositoryRoot, ledgerPath, baseCommit, policy, stepId }) {
  const baseLedger = JSON.parse(await git(repositoryRoot, ["show", `${baseCommit}:${ledgerPath}`]));
  const headLedger = JSON.parse(await readFile(path.join(repositoryRoot, ledgerPath), "utf8"));
  const { violations } = evaluateLedgerChange({ baseLedger, headLedger, policy });
  if (violations.length > 0) {
    const [first] = violations;
    fail(`${first.code}: ${stepId}: ${violations.map(({ sourceId, snapshotId, detail }) => `${sourceId} ${snapshotId}: ${detail}`).join(" | ")}`);
  }
}

export async function runDerivativeRebinding({
  repositoryRoot = ROOT, operationRoot, steps = DERIVATIVE_STEPS, env = process.env, ociClient = null,
  ledgerPath = LEDGER_PATH, policy = null,
  execute = (script, args) => runNodeScript(repositoryRoot, script, args),
} = {}) {
  if (!path.isAbsolute(repositoryRoot) || !path.isAbsolute(operationRoot ?? "")) fail("DERIVATIVE_ARGUMENTS: repository and operation roots must be absolute");
  if ((await changedPaths(repositoryRoot)).length > 0) fail("DERIVATIVE_WORKTREE_DIRTY: the rebinding needs a clean worktree");
  await mkdir(operationRoot, { recursive: true });
  const baseCommit = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  const ledgerPolicy = ledgerPath === null ? null : parseLedgerChangePolicy(policy ?? JSON.parse(await readFile(path.join(ROOT, POLICY_PATH), "utf8")));
  const results = [];
  for (const step of steps) {
    try {
      await step.run({ repositoryRoot, operationRoot, env, execute, ociClient });
    } catch (error) {
      const detail = String(error?.message ?? error);
      const coded = CODED.exec(detail);
      fail(coded ? `${coded[0]}${step.id}: ${detail.slice(coded[0].length)}` : `BINDING_MISMATCH: ${step.id}: ${detail}`);
    }
    const changed = await changedPaths(repositoryRoot);
    if (changed.length === 0) { results.push({ id: step.id, changed: false }); continue; }
    const outside = changed.filter((relative) => !step.isAllowedPath(relative));
    if (outside.length > 0) fail(`DERIVATIVE_OUTPUT_SCOPE: ${step.id}: ${outside.join(", ")}`);
    if (ledgerPath !== null && changed.includes(ledgerPath)) {
      await assertLedgerChangeAllowed({ repositoryRoot, ledgerPath, baseCommit, policy: ledgerPolicy, stepId: step.id });
    }
    await git(repositoryRoot, ["add", "--", ...changed]);
    await git(repositoryRoot, ["commit", "-q", "-m", step.message]);
    results.push({ id: step.id, changed: true, paths: changed });
  }
  return { steps: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== "--operation-root") fail("DERIVATIVE_ARGUMENTS: usage: run-derivative-rebinding.mjs --operation-root <absolute directory>");
    process.stdout.write(`${JSON.stringify(await runDerivativeRebinding({ operationRoot: argv[1] }))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
