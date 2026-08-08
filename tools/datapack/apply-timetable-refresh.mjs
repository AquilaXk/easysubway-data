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
import { access, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

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
];
const CONTRACT_PATH = "tools/datapack/itx-cheongchun-coverage-contract.json";
const TOPOLOGY_EVIDENCE_PATH = "tools/datapack/itx-cheongchun-topology-evidence.json";
const EVIDENCE_PATH = "tools/datapack/server-timetable-snapshot-evidence.json";
const RUNTIME_EVIDENCE_PATH = "backend/src/main/resources/timetable/server-timetable-snapshot-evidence.json";
const SNAPSHOT_BUILD_SCRIPT = "tools/datapack/build-server-timetable-snapshot.mjs";
const RECOVERY_HINT = "복구: `git checkout -- <가드 경로>` 또는 `git stash` 로 작업 트리를 되돌린 뒤 재시도하세요.";
// 재산출 빌드가 스테일 admission pin 위에 쌓는 것을 막으려 fail closed 할 때 내는 마커.
const IDENTITY_MISMATCH_MARKER = /(?:station catalog|canonical topology pack) identity mismatch/i;
const ADMISSION_RECOVERY_HINT =
  "current station-catalog 또는 topology pack identity가 일치하지 않습니다. "
  + "같은 current source에서 생성된 contract·topology evidence·pack을 함께 검증한 뒤 재실행하세요.";

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
  repoRoot = path.resolve(import.meta.dirname, "../.."),
  runGit = createGitRunner(repoRoot),
  runSnapshotBuild = createSnapshotBuildRunner(),
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
    "backend/src/main/resources/timetable/line4-timetable-seed.sql.gz",
  ]);
  let patchApplied = false;

  try {
    // (1) patch 적용.
    await runGit(["apply", resolvedPatch]);
    patchApplied = true;

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

    return {
      patchPath: resolvedPatch,
      changedFiles,
      freshUntilBefore: before.freshUntil,
      freshUntilAfter: after.freshUntil,
      sourceArtifactId: after.sourceArtifactId,
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
  const summary = await applyTimetableRefresh({ patchPath: args.patch });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    changedFiles: summary.changedFiles,
    freshUntilBefore: summary.freshUntilBefore,
    freshUntilAfter: summary.freshUntilAfter,
    sourceArtifactId: summary.sourceArtifactId,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
