#!/usr/bin/env node
// timetable freshness 리프레시 원커맨드 적용 도구.
//
// 이 도구는 current owner-approved source·contract·topology evidence를 함께 담은 patch를 받아
// (0) 클린 트리 확인 → (1) patch 적용 →
// (2) build-server-timetable-snapshot.mjs 재산출 →
// (3) 재산출 evidence 검증(freshUntil 연장·source 갱신)까지 수행한다.
//
// PR 생성·리뷰·automerge·git push·승인 주입은 하지 않는다 — 기존 정규 게이트를 그대로 경유한다.
//
// 실행: node tools/datapack/apply-timetable-refresh.mjs --patch <promotion.patch 경로>
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

// patch·재산출이 건드리는 tracked 경로. 클린 트리 게이트는 이 경로들에만 uncommitted 변경이
// 없음을 요구한다(무관한 worktree 변경까지 볼모로 잡지 않는다).
const GUARDED_PATHS = [
  "tools/datapack/sources",
  "tools/datapack/itx-cheongchun-coverage-contract.json",
  "tools/datapack/itx-cheongchun-topology-evidence.json",
  "backend/src/main/resources/timetable/line4-timetable-seed.sql.gz",
  "tools/datapack/server-timetable-snapshot-evidence.json",
  "backend/src/main/resources/timetable/server-timetable-snapshot-evidence.json",
  "tools/datapack/timetable-refresh-transaction-receipt.json",
];
const CONTRACT_PATH = "tools/datapack/itx-cheongchun-coverage-contract.json";
const TOPOLOGY_EVIDENCE_PATH = "tools/datapack/itx-cheongchun-topology-evidence.json";
const EVIDENCE_PATH = "tools/datapack/server-timetable-snapshot-evidence.json";
const RUNTIME_EVIDENCE_PATH = "backend/src/main/resources/timetable/server-timetable-snapshot-evidence.json";
const SEED_PATH = "backend/src/main/resources/timetable/line4-timetable-seed.sql.gz";
const RECEIPT_PATH = "tools/datapack/timetable-refresh-transaction-receipt.json";
const SNAPSHOT_BUILD_SCRIPT = "tools/datapack/build-server-timetable-snapshot.mjs";
const RECOVERY_HINT = "복구: `git checkout -- <가드 경로>` 또는 `git stash` 로 작업 트리를 되돌린 뒤 재시도하세요.";
// 재산출 빌드가 스테일 admission pin 위에 쌓는 것을 막으려 fail closed 할 때 내는 마커.
const IDENTITY_MISMATCH_MARKER = /(?:station catalog|canonical topology pack) identity mismatch/i;
const ADMISSION_RECOVERY_HINT =
  "current station-catalog 또는 topology pack identity가 일치하지 않습니다. "
  + "같은 current source에서 생성된 contract·topology evidence·pack을 함께 검증한 뒤 재실행하세요.";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const EXTENSION_RESULT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "decision",
  "reasonCode",
  "sourceId",
  "snapshotId",
  "snapshotSha256",
  "rawEvidenceSha256",
  "sourceClassId",
  "policySha256",
  "observationEvidenceSha256",
  "currentFreshUntil",
  "extendedFreshUntil",
  "evaluatedAt",
  "observedAt",
  "resultSha256",
];
const RECEIPT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "status",
  "inputPatchSha256",
  "sourceArtifactIdBefore",
  "sourceArtifactIdAfter",
  "sourceArtifactSha256",
  "completenessEvidenceSha256",
  "policyVersion",
  "freshUntilBefore",
  "freshUntilAfter",
  "freshnessExtensionResultSha256",
  "outputs",
  "transactionSha256",
];

// changedFiles가 전부 GUARDED_PATHS 접두사 안에 있는지 검사한다. 디렉토리 접두사("a/b")와
// 정확한 파일 경로 둘 다를 다루되, "a/b"가 "a/bc"를 잘못 포섭하지 않도록 경계(/)를 요구한다.
function isGuardedPath(file) {
  return GUARDED_PATHS.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
}

function createGitRunner(repoRoot) {
  return async (args) => {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: MAX_BUFFER });
    return stdout;
  };
}

// 기본 재산출 러너: 저장소의 snapshot 빌드 CLI가 current topology evidence를 필수 소비한다.
// shell 문자열 조립 없이 execFile로 node를 직접 호출한다.
function createSnapshotBuildRunner() {
  return async ({ repoRoot }) => {
    await execFileAsync(
      process.execPath,
      [path.join(repoRoot, SNAPSHOT_BUILD_SCRIPT)],
      { cwd: repoRoot, maxBuffer: MAX_BUFFER },
    );
  };
}

async function readEvidence(repoRoot) {
  const evidence = JSON.parse(await readFile(path.join(repoRoot, EVIDENCE_PATH), "utf8"));
  const freshUntil = evidence?.freshUntil;
  const sourceArtifactId = evidence?.sourceArtifact?.id;
  if (typeof freshUntil !== "string" || typeof sourceArtifactId !== "string") {
    throw new Error(`snapshot evidence(${EVIDENCE_PATH})에 freshUntil/sourceArtifact.id가 없습니다.`);
  }
  return { freshUntil, sourceArtifactId };
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase sha256`);
  }
  return value;
}

function requiredRepositoryRelativePath(value, label) {
  requiredString(value, label);
  if (path.posix.isAbsolute(value)
    || value.includes("\\")
    || path.posix.normalize(value) !== value
    || value === "."
    || value === ".."
    || value.startsWith("../")) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return value;
}

async function readJsonFile(absolutePath, label) {
  let bytes;
  try {
    const stat = await lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${label} must be a regular file`);
    }
    bytes = await readFile(absolutePath);
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error.message}`);
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new Error(`${label} must contain JSON`);
  }
}

function validateFreshnessExtensionResult(value, { sourceId, currentFreshUntil, extendedFreshUntil }) {
  if (!hasExactKeys(value, EXTENSION_RESULT_KEYS)
    || value.schemaVersion !== 1
    || value.artifactKind !== "source-freshness-extension-result"
    || value.decision !== "EXTENDED"
    || value.reasonCode !== "POSITIVE_OBSERVATION_EXTENDED") {
    throw new Error("freshness extension result must be an exact EXTENDED result");
  }
  const unsigned = { ...value };
  delete unsigned.resultSha256;
  const expectedResultSha256 = sha256(Buffer.from(canonicalJson(unsigned), "utf8"));
  if (value.resultSha256 !== expectedResultSha256
    || value.sourceId !== sourceId
    || value.currentFreshUntil !== currentFreshUntil
    || value.extendedFreshUntil !== extendedFreshUntil) {
    throw new Error("freshness extension result identity mismatch");
  }
  for (const key of [
    "snapshotSha256",
    "rawEvidenceSha256",
    "policySha256",
    "observationEvidenceSha256",
    "resultSha256",
  ]) {
    requiredSha256(value[key], `freshness extension result.${key}`);
  }
  for (const key of ["snapshotId", "sourceClassId", "evaluatedAt", "observedAt"]) {
    requiredString(value[key], `freshness extension result.${key}`);
  }
  return value.resultSha256;
}

async function readExtensionResult(extensionResultPath, repoRoot) {
  if (extensionResultPath == null) return null;
  if (typeof extensionResultPath !== "string" || extensionResultPath.length === 0) {
    throw new Error("freshness extension result path is invalid");
  }
  return (await readJsonFile(
    path.resolve(repoRoot, extensionResultPath),
    "freshness extension result",
  )).value;
}

async function validateCurrentTransactionOutputs(repoRoot) {
  const contract = (await readJsonFile(
    path.join(repoRoot, CONTRACT_PATH),
    "coverage contract",
  )).value;
  const sourceArtifact = contract?.sourceTimetableArtifact;
  if (!isRecord(sourceArtifact)) {
    throw new Error("coverage contract sourceTimetableArtifact is invalid");
  }
  const sourceArtifactId = requiredString(sourceArtifact.artifactId, "source artifact id");
  const sourcePath = requiredRepositoryRelativePath(
    sourceArtifact.artifactPath,
    "source artifact path",
  );
  const sourceSha256 = requiredSha256(sourceArtifact.sha256, "source artifact sha256");
  const completenessPath = requiredRepositoryRelativePath(
    sourceArtifact.completenessEvidencePath,
    "completeness evidence path",
  );
  const completenessSha256 = requiredSha256(
    sourceArtifact.completenessEvidenceSha256,
    "completeness evidence sha256",
  );
  const freshUntil = requiredString(sourceArtifact.freshUntil, "source freshUntil");
  const policyVersion = requiredString(sourceArtifact.policyVersion, "source policyVersion");
  const sourceBytes = await readFile(path.join(repoRoot, sourcePath));
  const completenessBytes = await readFile(path.join(repoRoot, completenessPath));
  if (sha256(sourceBytes) !== sourceSha256) {
    throw new Error("source artifact raw identity mismatch");
  }
  if (sha256(completenessBytes) !== completenessSha256) {
    throw new Error("completeness evidence raw identity mismatch");
  }

  const topologyEvidence = (await readJsonFile(
    path.join(repoRoot, TOPOLOGY_EVIDENCE_PATH),
    "topology evidence",
  )).value;
  const topologySource = topologyEvidence?.sourceArtifact;
  if (!isRecord(topologySource)
    || topologySource.id !== sourceArtifactId
    || topologySource.sha256 !== sourceSha256
    || topologySource.completenessEvidenceSha256 !== completenessSha256
    || topologySource.freshUntil !== freshUntil) {
    throw new Error("topology evidence source identity mismatch");
  }

  const outputPaths = [
    sourcePath,
    completenessPath,
    CONTRACT_PATH,
    TOPOLOGY_EVIDENCE_PATH,
    SEED_PATH,
    EVIDENCE_PATH,
    RUNTIME_EVIDENCE_PATH,
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (new Set(outputPaths).size !== outputPaths.length) {
    throw new Error("transaction output inventory contains duplicate paths");
  }
  const outputs = [];
  for (const outputPath of outputPaths) {
    const absolutePath = path.join(repoRoot, outputPath);
    const stat = await lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`transaction output must be a regular file: ${outputPath}`);
    }
    const bytes = await readFile(absolutePath);
    outputs.push({ path: outputPath, sha256: sha256(bytes), byteSize: bytes.length });
  }
  return {
    sourceArtifactId,
    sourceSha256,
    completenessSha256,
    freshUntil,
    policyVersion,
    outputs,
  };
}

function buildTransactionReceipt({
  inputPatchSha256,
  before,
  after,
  freshnessExtensionResultSha256,
}) {
  const unsigned = {
    schemaVersion: 1,
    artifactKind: "timetable-refresh-transaction-receipt",
    status: "APPLIED",
    inputPatchSha256,
    sourceArtifactIdBefore: before.sourceArtifactId,
    sourceArtifactIdAfter: after.sourceArtifactId,
    sourceArtifactSha256: after.sourceSha256,
    completenessEvidenceSha256: after.completenessSha256,
    policyVersion: after.policyVersion,
    freshUntilBefore: before.freshUntil,
    freshUntilAfter: after.freshUntil,
    freshnessExtensionResultSha256,
    outputs: after.outputs,
  };
  return {
    ...unsigned,
    transactionSha256: sha256(Buffer.from(canonicalJson(unsigned), "utf8")),
  };
}

async function writeReceiptAtomically(receiptPath, receipt) {
  const temporaryPath = `${receiptPath}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(receiptPath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    await rename(temporaryPath, receiptPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readExistingReceipt(repoRoot) {
  const receiptPath = path.join(repoRoot, RECEIPT_PATH);
  try {
    return (await readJsonFile(receiptPath, "transaction receipt")).value;
  } catch (error) {
    if (error.cause?.code === "ENOENT" || /ENOENT/u.test(error.message)) return null;
    throw error;
  }
}

function validateReceiptShape(receipt) {
  if (!hasExactKeys(receipt, RECEIPT_KEYS)
    || receipt.schemaVersion !== 1
    || receipt.artifactKind !== "timetable-refresh-transaction-receipt"
    || receipt.status !== "APPLIED"
    || !Array.isArray(receipt.outputs)) {
    throw new Error("transaction receipt shape is invalid");
  }
  const unsigned = { ...receipt };
  delete unsigned.transactionSha256;
  if (receipt.transactionSha256 !== sha256(Buffer.from(canonicalJson(unsigned), "utf8"))) {
    throw new Error("transaction receipt digest mismatch");
  }
  requiredSha256(receipt.inputPatchSha256, "transaction receipt input patch sha256");
  requiredString(receipt.sourceArtifactIdBefore, "transaction receipt source before");
  requiredString(receipt.sourceArtifactIdAfter, "transaction receipt source after");
  requiredSha256(receipt.sourceArtifactSha256, "transaction receipt source sha256");
  requiredSha256(
    receipt.completenessEvidenceSha256,
    "transaction receipt completeness sha256",
  );
  requiredString(receipt.policyVersion, "transaction receipt policyVersion");
  requiredString(receipt.freshUntilBefore, "transaction receipt freshUntil before");
  requiredString(receipt.freshUntilAfter, "transaction receipt freshUntil after");
  if (receipt.freshnessExtensionResultSha256 !== null) {
    requiredSha256(
      receipt.freshnessExtensionResultSha256,
      "transaction receipt freshness extension result sha256",
    );
  }
  requiredSha256(receipt.transactionSha256, "transaction receipt transaction sha256");
}

async function verifyReceiptOutputs(repoRoot, receipt) {
  validateReceiptShape(receipt);
  for (const entry of receipt.outputs) {
    if (!hasExactKeys(entry, ["path", "sha256", "byteSize"])
      || typeof entry.path !== "string"
      || !Number.isSafeInteger(entry.byteSize)
      || entry.byteSize < 0
      || !SHA256_PATTERN.test(entry.sha256)) {
      throw new Error("transaction receipt output inventory is invalid");
    }
    requiredRepositoryRelativePath(entry.path, "transaction receipt output path");
  }
  const current = await validateCurrentTransactionOutputs(repoRoot);
  if (receipt.outputs.length !== current.outputs.length
    || receipt.outputs.some((entry, index) => entry.path !== current.outputs[index].path)) {
    throw new Error("transaction receipt output inventory mismatch");
  }
  if (receipt.sourceArtifactIdAfter !== current.sourceArtifactId
    || receipt.sourceArtifactSha256 !== current.sourceSha256
    || receipt.completenessEvidenceSha256 !== current.completenessSha256
    || receipt.policyVersion !== current.policyVersion
    || receipt.freshUntilAfter !== current.freshUntil) {
    throw new Error("transaction receipt output identity mismatch");
  }
  if (receipt.outputs.some((entry, index) => entry.sha256 !== current.outputs[index].sha256
    || entry.byteSize !== current.outputs[index].byteSize)) {
    throw new Error("transaction receipt output drift");
  }
}

// git apply --numstat 출력("added\tdeleted\tpath")에서 patch가 건드리는 경로 목록을 뽑는다.
function parseNumstatPaths(numstat) {
  return numstat
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t").at(-1))
    .filter(Boolean);
}

async function captureMutationBoundary(repoRoot, files) {
  return Promise.all([...new Set(files)].map(async (file) => {
    const absolutePath = path.join(repoRoot, file);
    try {
      const stat = await lstat(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`mutation boundary path must be a regular file: ${file}`);
      }
      return { file, exists: true, bytes: await readFile(absolutePath), mode: stat.mode };
    } catch (error) {
      if (error?.code === "ENOENT") return { file, exists: false, bytes: null, mode: null };
      throw error;
    }
  }));
}

async function restoreMutationBoundary(repoRoot, snapshots) {
  for (const snapshot of snapshots) {
    const absolutePath = path.join(repoRoot, snapshot.file);
    await rm(absolutePath, { recursive: true, force: true });
    if (!snapshot.exists) continue;
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, snapshot.bytes, { mode: snapshot.mode });
  }
}

export async function applyTimetableRefresh({
  patchPath,
  freshnessExtensionResultPath,
  repoRoot = path.resolve(import.meta.dirname, "../.."),
  runGit = createGitRunner(repoRoot),
  runSnapshotBuild = createSnapshotBuildRunner(),
  writeReceipt = writeReceiptAtomically,
} = {}) {
  if (typeof patchPath !== "string" || patchPath.length === 0) {
    throw new Error("--patch <promotion.patch 경로>를 지정해야 합니다.");
  }
  const resolvedPatch = path.resolve(repoRoot, patchPath);
  try {
    await access(resolvedPatch);
  } catch {
    throw new Error(`promotion.patch를 찾을 수 없습니다: ${resolvedPatch}`);
  }
  const inputPatchSha256 = sha256(await readFile(resolvedPatch));
  const extensionResult = await readExtensionResult(freshnessExtensionResultPath, repoRoot);
  const existingReceipt = await readExistingReceipt(repoRoot);
  if (existingReceipt?.inputPatchSha256 === inputPatchSha256) {
    validateReceiptShape(existingReceipt);
    if (existingReceipt.freshnessExtensionResultSha256 == null) {
      if (extensionResult != null) {
        throw new Error("source replacement transaction cannot consume a freshness extension result");
      }
    } else {
      if (extensionResult == null) {
        throw new Error("same-source transaction requires its freshness extension result");
      }
      const resultSha256 = validateFreshnessExtensionResult(extensionResult, {
        sourceId: existingReceipt.sourceArtifactIdAfter,
        currentFreshUntil: existingReceipt.freshUntilBefore,
        extendedFreshUntil: existingReceipt.freshUntilAfter,
      });
      if (resultSha256 !== existingReceipt.freshnessExtensionResultSha256) {
        throw new Error("transaction receipt freshness extension identity mismatch");
      }
    }
    await verifyReceiptOutputs(repoRoot, existingReceipt);
    try {
      await runGit(["apply", "--reverse", "--check", resolvedPatch]);
    } catch {
      throw new Error("transaction receipt cannot prove that the patch is already applied");
    }
    return {
      status: "NO_OP",
      patchPath: resolvedPatch,
      changedFiles: [],
      freshUntilBefore: existingReceipt.freshUntilBefore,
      freshUntilAfter: existingReceipt.freshUntilAfter,
      sourceArtifactId: existingReceipt.sourceArtifactIdAfter,
      transactionSha256: existingReceipt.transactionSha256,
    };
  }

  // (0) 클린 트리 확인: 가드 경로에 uncommitted 변경이 있으면 부분 적용을 막기 위해 fail closed.
  const status = (await runGit(["status", "--porcelain", "--", ...GUARDED_PATHS])).trim();
  if (status.length > 0) {
    throw new Error(
      `클린 트리 게이트 실패: 가드 경로에 uncommitted 변경(더티)이 있어 patch를 적용하지 않습니다.\n${status}\n${RECOVERY_HINT}`,
    );
  }

  // patch가 건드리는 경로 목록(적용 전 numstat) + 적용 가능성 사전 검증.
  let changedFiles;
  try {
    changedFiles = parseNumstatPaths(await runGit(["apply", "--numstat", resolvedPatch]));
  } catch (error) {
    throw new Error(`promotion.patch를 파싱할 수 없습니다: ${error.message}`);
  }

  // guard-scope 게이트: patch가 건드리는 경로가 전부 가드 경로 안에 있어야 한다. 적용 전에
  // 검사해, freshness 리프레시 범위를 벗어난 파일을 조용히 적용하는 것을 fail closed 로 막는다.
  const outOfScope = changedFiles.filter((file) => !isGuardedPath(file));
  if (outOfScope.length > 0) {
    throw new Error(
      "guard-scope 게이트 실패: promotion.patch가 가드 경로 밖의 파일을 건드려 적용하지 않습니다.\n"
      + `가드 경로 밖 파일:\n${outOfScope.map((file) => `  - ${file}`).join("\n")}`,
    );
  }
  if (!changedFiles.includes(CONTRACT_PATH)
    || !changedFiles.includes(TOPOLOGY_EVIDENCE_PATH)
    || !changedFiles.some((file) => file.startsWith("tools/datapack/sources/"))) {
    throw new Error(
      "current admission patch는 source·coverage contract·topology evidence를 함께 변경해야 합니다.",
    );
  }

  try {
    await runGit(["apply", "--check", resolvedPatch]);
  } catch (error) {
    throw new Error(
      `patch 적용 사전 검증(git apply --check) 실패 — 현행 tracked 상태와 patch가 불일치합니다: ${error.message}`,
    );
  }

  const before = await readEvidence(repoRoot);
  const mutationBoundary = await captureMutationBoundary(repoRoot, [
    ...changedFiles,
    EVIDENCE_PATH,
    RUNTIME_EVIDENCE_PATH,
    SEED_PATH,
    RECEIPT_PATH,
  ]);
  let patchApplied = false;

  try {
    // (1) patch 적용.
    await runGit(["apply", resolvedPatch]);
    patchApplied = true;

    const patchedContract = JSON.parse(
      await readFile(path.join(repoRoot, CONTRACT_PATH), "utf8"),
    );
    const patchedSource = patchedContract?.sourceTimetableArtifact;
    const sourceArtifactIdAfter = requiredString(
      patchedSource?.artifactId,
      "patched source artifact id",
    );
    const freshUntilAfter = requiredString(
      patchedSource?.freshUntil,
      "patched source freshUntil",
    );
    const patchedSourcePath = requiredRepositoryRelativePath(
      patchedSource?.artifactPath,
      "patched source artifact path",
    );
    const patchedCompletenessPath = requiredRepositoryRelativePath(
      patchedSource?.completenessEvidencePath,
      "patched completeness evidence path",
    );
    const allowedPatchPaths = new Set([
      patchedSourcePath,
      patchedCompletenessPath,
      CONTRACT_PATH,
      TOPOLOGY_EVIDENCE_PATH,
    ]);
    const unexpectedPatchPaths = changedFiles.filter((file) => !allowedPatchPaths.has(file));
    if (unexpectedPatchPaths.length > 0 || !changedFiles.includes(patchedSourcePath)) {
      throw new Error(
        "patch output inventory is not the exact source/contract/topology transaction set: "
        + unexpectedPatchPaths.join(", "),
      );
    }
    let freshnessExtensionResultSha256 = null;
    if (sourceArtifactIdAfter === before.sourceArtifactId) {
      if (extensionResult == null) {
        throw new Error("same-source freshness patch requires an exact freshness extension EXTENDED result");
      }
      freshnessExtensionResultSha256 = validateFreshnessExtensionResult(extensionResult, {
        sourceId: sourceArtifactIdAfter,
        currentFreshUntil: before.freshUntil,
        extendedFreshUntil: freshUntilAfter,
      });
    } else if (extensionResult != null) {
      throw new Error("source replacement transaction cannot consume a freshness extension result");
    }

    // (2) 재산출. 실패하면 아래 mutation boundary 복원 뒤 fail closed 한다.
    try {
      await runSnapshotBuild({ repoRoot });
    } catch (error) {
      const detail = `${error.stderr ?? ""}\n${error.message ?? ""}`;
      const admissionBranch = IDENTITY_MISMATCH_MARKER.test(detail) ? `\n${ADMISSION_RECOVERY_HINT}` : "";
      throw new Error(
        `재산출(build-server-timetable-snapshot) 실패: ${error.message}\n`
        + "상태: patch와 snapshot 산출물을 적용 전 bytes로 복원합니다."
        + admissionBranch,
      );
    }

  // (3) 검증: evidence 사본 동기 + freshUntil 연장 + sourceArtifact가 patch의 신규 source와 일치.
  // 재산출은 tools/datapack evidence와 backend runtime evidence를 함께 써야 한다. 두 사본이
  // 바이트 동일하지 않으면 런타임이 스테일 freshness를 읽을 수 있으므로 fail closed 한다.
  const [toolEvidenceBytes, runtimeEvidenceBytes] = await Promise.all([
    readFile(path.join(repoRoot, EVIDENCE_PATH)),
    readFile(path.join(repoRoot, RUNTIME_EVIDENCE_PATH)),
  ]);
  if (!toolEvidenceBytes.equals(runtimeEvidenceBytes)) {
    throw new Error(
      `검증 실패: snapshot evidence 사본이 바이트 동일하지 않습니다 `
      + `(${EVIDENCE_PATH} ↔ ${RUNTIME_EVIDENCE_PATH}). 재산출이 두 사본을 함께 갱신하지 못했습니다. ${RECOVERY_HINT}`,
    );
  }
  const after = await readEvidence(repoRoot);
  const beforeMs = Date.parse(before.freshUntil);
  const afterMs = Date.parse(after.freshUntil);
  if (!Number.isFinite(afterMs) || !Number.isFinite(beforeMs) || !(afterMs > beforeMs)) {
    throw new Error(
      `검증 실패: 재산출 evidence의 freshUntil이 연장되지 않았습니다 `
      + `(before=${before.freshUntil}, after=${after.freshUntil}). ${RECOVERY_HINT}`,
    );
  }
  const contract = JSON.parse(await readFile(path.join(repoRoot, CONTRACT_PATH), "utf8"));
  const expectedSourceId = contract?.sourceTimetableArtifact?.artifactId;
  if (after.sourceArtifactId !== expectedSourceId) {
    throw new Error(
      `검증 실패: 재산출 evidence의 sourceArtifact.id(${after.sourceArtifactId})가 `
      + `patch의 신규 source(${expectedSourceId})와 일치하지 않습니다. ${RECOVERY_HINT}`,
    );
  }

    const validatedOutputs = await validateCurrentTransactionOutputs(repoRoot);
    if (validatedOutputs.sourceArtifactId !== after.sourceArtifactId
      || validatedOutputs.freshUntil !== after.freshUntil) {
      throw new Error("transaction output source identity mismatch");
    }
    const receipt = buildTransactionReceipt({
      inputPatchSha256,
      before,
      after: validatedOutputs,
      freshnessExtensionResultSha256,
    });
    await writeReceipt(path.join(repoRoot, RECEIPT_PATH), receipt);

    return {
      status: "APPLIED",
      patchPath: resolvedPatch,
      changedFiles,
      freshUntilBefore: before.freshUntil,
      freshUntilAfter: after.freshUntil,
      sourceArtifactId: after.sourceArtifactId,
      transactionSha256: receipt.transactionSha256,
    };
  } catch (error) {
    const primaryError = error instanceof Error ? error : new Error(String(error));
    if (patchApplied) {
      try {
        await restoreMutationBoundary(repoRoot, mutationBoundary);
      } catch (restoreError) {
        primaryError.message += `\n복원 실패: 작업 트리가 부분 적용 상태로 남았습니다. ${RECOVERY_HINT}`;
        Object.defineProperty(primaryError, "cause", {
          value: restoreError,
          configurable: true,
        });
      }
    }
    throw primaryError;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--") || argv[index + 1] == null || argv[index + 1].startsWith("--")) {
      throw new Error(`invalid argument: ${flag}`);
    }
    args[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await applyTimetableRefresh({
    patchPath: args.patch,
    freshnessExtensionResultPath: args["freshness-extension-result"],
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: summary.status,
    changedFiles: summary.changedFiles,
    freshUntilBefore: summary.freshUntilBefore,
    freshUntilAfter: summary.freshUntilAfter,
    sourceArtifactId: summary.sourceArtifactId,
    transactionSha256: summary.transactionSha256,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
