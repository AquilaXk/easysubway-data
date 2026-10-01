#!/usr/bin/env node
// 전국 후보 갱신 (#862 결정 C)
//
// 원천별 갱신 workflow(topology·FACILITY·서울 접근성·지역 시간표)는 수집 → 원본 게시 → 원장 등록까지만 한다.
// 후보 spec·release request·hash evidence는 이 명령 하나로만 다시 만든다. 이 명령은 QA 승인 체크포인트다.
//
// 사용:
//   node tools/datapack/refresh-nationwide-candidate.mjs \
//     --evaluated-at <후보 시계, ISO-8601 UTC ms> --release-sequence <양의 정수> \
//     --requested-by <요청자> --approved-by <승인자>
//
// 순서: 5권역 fan-in(--evaluated-at) → 소유권 원장 → prepare-nationwide-candidate-run → build-nationwide-candidate(spec·scope·request·hash) → 결속 검증.
// - 승인 역할은 명시 인자로만 받는다. 환경 변수나 이전 후보의 승인으로 채우지 않는다. 요청자와 승인자는 달라야 한다.
// - 깨끗한 worktree에서만 실행한다. builder git SHA가 실제 코드를 가리켜야 하기 때문이다.
// - 어느 단계든 실패하거나 결속 검증이 어긋나면 모든 출력을 실행 전 바이트로 되돌리고 실패로 끝낸다.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { CURRENT_FIVE_REGION_SOURCE_FAN_IN_PATH } from "./build-current-five-region-source-fan-in.mjs";
import { LEDGER_PATH as OWNERSHIP_LEDGER_PATH } from "./build-nationwide-requirement-ownership-ledger.mjs";
import { exportLedgerHash } from "./export-ledger-hashes.mjs";
import {
  CAR_DOOR_HINT_QUARANTINE_PATH,
  REGIONAL_TIMETABLE_QUARANTINE_PATH,
} from "./prepare-nationwide-candidate-run.mjs";
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";
import { CANDIDATE_RELEASE_OUTPUTS } from "./lib/source-registration-transaction.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SPEC_PATH = "tools/datapack/release/candidate-build-spec.json";
const REQUEST_PATH = "tools/datapack/release/release-request.json";
const HASH_EVIDENCE_PATH = "tools/datapack/release/hash-evidence.json";
const SOURCE_SNAPSHOTS_PATH = "tools/datapack/release/source-snapshots.json";
const OVERRIDES_PATH = "tools/datapack/fixtures/admin-review-overrides.json";
const LEDGER_FIELDS = Object.freeze([
  ["approvedAliasLedgerHash", "alias"],
  ["facilityEvidenceLedgerHash", "facility-evidence"],
  ["routeEvidenceLedgerHash", "route-evidence"],
  ["approvedOverrideSetHash", "override"],
]);

export const NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS = Object.freeze([
  CURRENT_FIVE_REGION_SOURCE_FAN_IN_PATH,
  OWNERSHIP_LEDGER_PATH,
  "tools/datapack/release/nationwide-production-canonical-pack.json",
  "tools/datapack/release/nationwide-route-edge-input.json",
  "tools/datapack/release/nationwide-station-line-input.json",
  "tools/datapack/release/nationwide-candidate-preparation.json",
  CAR_DOOR_HINT_QUARANTINE_PATH,
  REGIONAL_TIMETABLE_QUARANTINE_PATH,
  ...CANDIDATE_RELEASE_OUTPUTS,
]);
const PREPARATION_PATH = "tools/datapack/release/nationwide-candidate-preparation.json";
const STEPS = Object.freeze([
  "five-region fan-in", "ownership ledger", "nationwide candidate preparation", "nationwide candidate build",
]);

export function parseRefreshNationwideCandidateArgs(argv) {
  const flags = new Map([
    ["--evaluated-at", "evaluatedAt"],
    ["--release-sequence", "releaseSequence"],
    ["--requested-by", "requestedBy"],
    ["--approved-by", "approvedBy"],
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = flags.get(flag);
    if (!key) throw new Error(`unknown nationwide candidate refresh argument: ${flag ?? ""}`);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate nationwide candidate refresh argument: ${flag}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.trim() === "" || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values[key] = value;
  }
  for (const [flag, key] of flags) {
    if (!Object.hasOwn(values, key)) throw new Error(`${flag} is required`);
  }
  const instant = Date.parse(values.evaluatedAt);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== values.evaluatedAt) {
    throw new Error("--evaluated-at must be an exact ISO-8601 UTC instant with milliseconds");
  }
  if (!/^[1-9][0-9]*$/u.test(values.releaseSequence) || !Number.isSafeInteger(Number(values.releaseSequence))) {
    throw new Error("--release-sequence must be a positive integer");
  }
  const requestedBy = values.requestedBy.trim();
  const approvedBy = values.approvedBy.trim();
  if (requestedBy.toLowerCase() === approvedBy.toLowerCase()) {
    throw new Error(`two-person rule violation: requester and approver must differ (${requestedBy})`);
  }
  return { evaluatedAt: values.evaluatedAt, releaseSequence: Number(values.releaseSequence), requestedBy, approvedBy };
}

export async function readNationwideCandidateRefreshState(repositoryRoot = ROOT) {
  const read = (relative) => readFile(path.join(repositoryRoot, relative));
  const [fanInBytes, snapshotsBytes, buildSpecBytes, requestBytes, hashEvidenceBytes] = await Promise.all([
    read(CURRENT_FIVE_REGION_SOURCE_FAN_IN_PATH), read(SOURCE_SNAPSHOTS_PATH), read(SPEC_PATH), read(REQUEST_PATH), read(HASH_EVIDENCE_PATH),
  ]);
  const buildSpec = JSON.parse(buildSpecBytes);
  if (typeof buildSpec.fixturePath !== "string" || !/^tools\/datapack\/release\/[^/]+\.json$/u.test(buildSpec.fixturePath)) {
    throw new Error("candidate build spec fixturePath is invalid");
  }
  const fixture = path.join(repositoryRoot, buildSpec.fixturePath);
  const ledgerHashes = {};
  for (const [field, kind] of LEDGER_FIELDS) {
    ledgerHashes[field] = (await exportLedgerHash(kind, {
      fixture,
      ...(kind === "override" ? { overrides: path.join(repositoryRoot, OVERRIDES_PATH) } : {}),
    })).ledgerHash;
  }
  return {
    fanIn: JSON.parse(fanInBytes),
    sourceSnapshots: JSON.parse(snapshotsBytes),
    buildSpec,
    buildSpecBytes,
    releaseRequest: JSON.parse(requestBytes),
    hashEvidence: JSON.parse(hashEvidenceBytes),
    fixtureSha256: sha256(await readFile(fixture)),
    ledgerHashes,
  };
}

// 생성된 후보가 이번 fan-in head·시계·전국 팩·2인 승인에 결속됐는지 본다. 어긋남 목록을 돌려준다.
export function nationwideCandidateRefreshViolations({
  evaluatedAt, requestedBy, approvedBy, fanIn, sourceSnapshots, buildSpec, buildSpecBytes,
  releaseRequest, hashEvidence, fixtureSha256, ledgerHashes,
}) {
  const violations = [];
  const mismatch = (label, actual, expected, names = ["actual", "expected"]) => {
    if (actual !== expected) violations.push(`${label} mismatch (${names[0]}: ${actual}, ${names[1]}: ${expected})`);
  };
  mismatch("fan-in evaluatedAt", fanIn?.evaluatedAt, evaluatedAt, ["fan-in", "requested"]);
  mismatch("publishedAt", buildSpec?.publishedAt, fanIn?.evaluatedAt, ["build spec", "fan-in"]);
  const selectedIds = (fanIn?.selectedSources ?? []).map(({ snapshotId }) => snapshotId);
  const sorted = (values) => JSON.stringify([...values].sort());
  if (!Array.isArray(buildSpec?.sourceSnapshotIds) || sorted(buildSpec.sourceSnapshotIds) !== sorted(selectedIds)) {
    violations.push("sourceSnapshotIds do not match fan-in heads");
  }
  const selected = new Set(selectedIds);
  const selectedRows = (Array.isArray(sourceSnapshots) ? sourceSnapshots : []).filter(({ snapshotId }) => selected.has(snapshotId));
  mismatch("sourceSnapshotSetHash", buildSpec?.sourceSnapshotSetHash, sha256(JSON.stringify(selectedRows)), ["build spec", "ledger heads"]);
  mismatch("fixtureSha256", buildSpec?.fixtureSha256, fixtureSha256, ["build spec", "fixture"]);
  for (const [field] of LEDGER_FIELDS) {
    mismatch(field, buildSpec?.[field], ledgerHashes?.[field], ["build spec", "recomputed"]);
  }
  mismatch("hash evidence sourceSnapshotSetHash", hashEvidence?.sourceSnapshotSetHash?.value, buildSpec?.sourceSnapshotSetHash, ["hash evidence", "build spec"]);
  mismatch("hash evidence fixture", hashEvidence?.fixturePath?.sha256, buildSpec?.fixtureSha256, ["hash evidence", "build spec"]);
  mismatch("hash evidence candidateId", hashEvidence?.identifiers?.candidateId?.value, buildSpec?.candidateId, ["hash evidence", "build spec"]);
  for (const [field] of LEDGER_FIELDS) {
    mismatch(`hash evidence ${field}`, hashEvidence?.ledgerHashes?.[field]?.value, buildSpec?.[field], ["hash evidence", "build spec"]);
  }
  violations.push(...releaseRequestBindingViolations({
    buildSpec,
    buildSpecSha256: Buffer.isBuffer(buildSpecBytes) ? sha256(buildSpecBytes) : null,
    releaseRequest,
    expectedApprovalId: `release-request-${buildSpec?.candidateId}`,
  }));
  mismatch("requestedBy", releaseRequest?.requestedBy, requestedBy, ["release request", "requested"]);
  mismatch("approvedBy", releaseRequest?.approvedBy, approvedBy, ["release request", "requested"]);
  return violations;
}

async function runNodeScript(repositoryRoot, script, args) {
  const env = { ...process.env };
  // prepare는 승인 역할을 환경 변수에서도 읽는다. 명시 인자만 쓰도록 비운다.
  delete env.DATAPACK_REQUESTED_BY;
  delete env.DATAPACK_APPROVED_BY;
  try {
    await execFileAsync(process.execPath, [path.join(TOOLS, script), ...args], {
      cwd: repositoryRoot, env, maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error.stderr ?? "").trim().split("\n").filter(Boolean).at(-1);
    throw new Error(detail || error.message);
  }
}

async function defaultRunStep({ name, repositoryRoot, evaluatedAt, releaseSequence, requestedBy, approvedBy }) {
  if (name === "five-region fan-in") {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "nationwide-fan-in-"));
    try {
      const output = path.join(temporary, "current-five-region-source-fan-in.json");
      await runNodeScript(repositoryRoot, "build-current-five-region-source-fan-in.mjs", [
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--tally", "tools/datapack/reports/nationwide-coverage-tally.json",
        "--ownership", "tools/datapack/release/nationwide-requirement-ownership.json",
        "--inventory", "tools/datapack/source-inventory.json",
        "--source-snapshots", SOURCE_SNAPSHOTS_PATH,
        "--evaluated-at", evaluatedAt,
        "--output", output,
      ]);
      await writeFile(path.join(repositoryRoot, CURRENT_FIVE_REGION_SOURCE_FAN_IN_PATH), await readFile(output));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return;
  }
  if (name === "ownership ledger") {
    await runNodeScript(repositoryRoot, "build-nationwide-requirement-ownership-ledger.mjs", []);
    return;
  }
  if (name === "nationwide candidate preparation") {
    await runNodeScript(repositoryRoot, "prepare-nationwide-candidate-run.mjs", [
      `--requested-by=${requestedBy}`, `--approved-by=${approvedBy}`, `--sequence=${releaseSequence}`,
    ]);
    return;
  }
  if (name === "nationwide candidate build") {
    // spec·scope·request·hash evidence는 이 단일 생성기가 fan-in head 기준으로 전부 다시 계산한다.
    await runNodeScript(repositoryRoot, "build-nationwide-candidate.mjs", ["--preparation", PREPARATION_PATH]);
    return;
  }
  throw new Error(`unknown nationwide candidate refresh step: ${name}`);
}

async function assertGitCleanWorktree(repositoryRoot) {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repositoryRoot });
  if (stdout.trim() !== "") throw new Error("nationwide candidate refresh requires a clean worktree");
}

async function readOptional(file) {
  try { return await readFile(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export async function refreshNationwideCandidate({
  repositoryRoot = ROOT,
  evaluatedAt,
  releaseSequence,
  requestedBy,
  approvedBy,
  runStep = defaultRunStep,
  assertCleanWorktree = assertGitCleanWorktree,
} = {}) {
  const repository = path.resolve(repositoryRoot);
  await assertCleanWorktree(repository);
  const prestate = await Promise.all(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.map(async (relative) =>
    ({ relative, bytes: await readOptional(path.join(repository, relative)) })));
  let step = "five-region fan-in";
  try {
    for (const name of STEPS) {
      step = name;
      await runStep({ name, repositoryRoot: repository, evaluatedAt, releaseSequence, requestedBy, approvedBy });
    }
    step = "binding verification";
    const violations = nationwideCandidateRefreshViolations({
      ...(await readNationwideCandidateRefreshState(repository)), evaluatedAt, requestedBy, approvedBy,
    });
    if (violations.length > 0) throw new Error(violations.join("; "));
  } catch (error) {
    for (const { relative, bytes } of prestate) {
      const target = path.join(repository, relative);
      if (bytes == null) await rm(target, { force: true });
      else await writeFile(target, bytes);
    }
    throw new Error(`전국 후보 갱신 실패 (${step}): ${error.message}`, { cause: error });
  }
  const buildSpec = JSON.parse(await readFile(path.join(repository, SPEC_PATH)));
  return {
    candidateId: buildSpec.candidateId,
    publishedAt: buildSpec.publishedAt,
    releaseSequence: buildSpec.releaseSequence,
    sourceSnapshotSetHash: buildSpec.sourceSnapshotSetHash,
    outputs: [...NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await refreshNationwideCandidate(parseRefreshNationwideCandidateArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
