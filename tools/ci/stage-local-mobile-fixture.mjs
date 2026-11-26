#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../lib/hash.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
// PATH 탐색에 맡기지 않고 고정 경로의 tar를 쓴다(macOS·Ubuntu 공통).
const TAR_EXECUTABLE = "/usr/bin/tar";

// #979: fixture 커밋은 ITX topology 적용 전 입력 팩을 담는다. 승격마다 mobile 커밋이 바뀌지 않고, 출력 팩은 커밋된 증거에서 결정적으로 파생한다.
export const PINNED_MOBILE_REVISION = "d3694c0fe1d15e9ee7854cba14e9120fd8ade9da";
export const INPUT_CAPITAL_GZIP_SHA256 = "609a74095859b5bf7602c25e142caa47cc212170a72d6240e2d01b39f874047a";

function assertNoSymlinksRecursive(dirPath) {
  const rootStat = lstatSync(dirPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Staged mobile directory must be a real directory: ${dirPath}`);
  }
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Pinned mobile fixture contains forbidden symlink: ${fullPath}`);
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
}

function lstatIfExists(targetPath) {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** 파생된 팩의 기대 sha256은 커밋된 증거가 정한다. */
export function expectedDerivedCapitalGzipSha256(root = ROOT) {
  const evidence = JSON.parse(readFileSync(path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json"), "utf8"));
  return evidence.pack.outputSha256;
}


export function stageLocalMobileFixture({ repositoryRoot = ROOT, candidatePaths = null } = {}) {
  const root = path.resolve(repositoryRoot);
  const appsDir = path.join(root, "apps");
  const targetMobileDir = path.join(appsDir, "mobile");
  const targetPack = path.join(targetMobileDir, "assets/datapacks/capital.sqlite.gz");
  const targetIndex = path.join(targetMobileDir, "assets/datapacks/index.json");

  const existingAppsStat = lstatIfExists(appsDir);
  if (existingAppsStat && (!existingAppsStat.isDirectory() || existingAppsStat.isSymbolicLink())) {
    throw new Error(`Target apps directory must be a real directory: ${appsDir}`);
  }
  const existingMobileStat = lstatIfExists(targetMobileDir);
  if (existingMobileStat && (!existingMobileStat.isDirectory() || existingMobileStat.isSymbolicLink())) {
    throw new Error(`Target mobile directory must be a real directory: ${targetMobileDir}`);
  }

  if (existingMobileStat && existsSync(targetPack) && existsSync(targetIndex)) {
    const packStat = lstatSync(targetPack);
    const indexStat = lstatSync(targetIndex);
    if (packStat.isFile() && !packStat.isSymbolicLink() && indexStat.isFile() && !indexStat.isSymbolicLink()) {
      const actualSha = sha256(readFileSync(targetPack));
      if (actualSha === expectedDerivedCapitalGzipSha256(root)) {
        return { staged: false, alreadyPresent: true };
      }
    }
  }

  const gitBin = process.env.GIT_BIN || "git";
  const candidates = Array.isArray(candidatePaths)
    ? candidatePaths
    : [
        path.join(root, ".external/mobile"),
        "/Volumes/MACSSD/Projects/GitProjects/easysubway-mobile",
        path.resolve(root, "../easysubway-mobile"),
        path.resolve(root, "../../easysubway-mobile"),
      ];

  let chosenCandidate = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const rev = execFileSync(gitBin, ["-C", candidate, "rev-parse", "--verify", `${PINNED_MOBILE_REVISION}^{commit}`], {
          stdio: ["ignore", "pipe", "ignore"],
        }).toString().trim();
        if (rev === PINNED_MOBILE_REVISION) {
          chosenCandidate = candidate;
          break;
        }
      } catch {
        // commit not in this candidate, keep trying
      }
    }
  }

  if (!chosenCandidate) {
    throw new Error(
      `Could not locate local mobile repository with pinned revision ${PINNED_MOBILE_REVISION}. Checked candidates: ${candidates.join(", ")}`
    );
  }

  mkdirSync(appsDir, { recursive: true });
  const stagingRoot = mkdtempSync(path.join(appsDir, ".mobile-stage-"));
  let backupDir = null;
  try {
    const archiveTar = execFileSync(gitBin, ["-C", chosenCandidate, "archive", PINNED_MOBILE_REVISION, "apps/mobile"], {
      maxBuffer: 100 * 1024 * 1024,
    });

    execFileSync(TAR_EXECUTABLE, ["-x", "-C", stagingRoot], {
      input: archiveTar,
    });

    const stagedMobileDir = path.join(stagingRoot, "apps/mobile");
    const stagedPack = path.join(stagedMobileDir, "assets/datapacks/capital.sqlite.gz");
    const stagedIndex = path.join(stagedMobileDir, "assets/datapacks/index.json");
    assertNoSymlinksRecursive(stagedMobileDir);
    if (!existsSync(stagedPack) || !existsSync(stagedIndex)) {
      throw new Error(`Extraction failed: ${stagedPack} or ${stagedIndex} not found after git archive`);
    }

    const inputSha = sha256(readFileSync(stagedPack));
    if (inputSha !== INPUT_CAPITAL_GZIP_SHA256) {
      throw new Error(
        `Extracted capital.sqlite.gz sha256 mismatch: expected input ${INPUT_CAPITAL_GZIP_SHA256}, got ${inputSha}`
      );
    }
    // 입력 팩에 승인 원천 topology를 적용해 커밋된 증거와 같은 팩을 파생한다. Node 24.19.0·SQLite 3.53.3(CI와 같은 런타임)이 필요하다.
    execFileSync(process.execPath, [
      path.join(root, "tools/datapack/apply-itx-topology-to-bundled-pack.mjs"),
      "--derive-fixture",
      stagedMobileDir,
    ], { stdio: ["ignore", "inherit", "inherit"] });
    const actualSha = sha256(readFileSync(stagedPack));
    if (actualSha !== expectedDerivedCapitalGzipSha256(root)) {
      throw new Error(
        `Derived capital.sqlite.gz sha256 mismatch: expected ${expectedDerivedCapitalGzipSha256(root)}, got ${actualSha}`
      );
    }

    const currentTargetStat = lstatIfExists(targetMobileDir);
    if (currentTargetStat) {
      if (!currentTargetStat.isDirectory() || currentTargetStat.isSymbolicLink()) {
        throw new Error(`Target mobile directory must be a real directory: ${targetMobileDir}`);
      }
      backupDir = path.join(appsDir, `.mobile-backup-${process.pid}-${randomUUID()}`);
      renameSync(targetMobileDir, backupDir);
    }
    try {
      renameSync(stagedMobileDir, targetMobileDir);
    } catch (renameErr) {
      if (backupDir) {
        try {
          renameSync(backupDir, targetMobileDir);
        } catch {
          // best effort rollback
        }
      }
      throw renameErr;
    }
    if (backupDir) {
      rmSync(backupDir, { recursive: true, force: true });
      backupDir = null;
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  return { staged: true, sourcePath: chosenCandidate, revision: PINNED_MOBILE_REVISION };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = stageLocalMobileFixture();
    console.log(`[OK] Pinned mobile fixture verified (${result.staged ? "staged freshly" : "already present"}).`);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }
}
