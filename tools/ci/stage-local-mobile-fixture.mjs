#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const PINNED_MOBILE_REVISION = "23f4262087af99ff49e120707f7de317666679ef";
export const EXPECTED_CAPITAL_GZIP_SHA256 = "6339daf6de99f9eb69b3940d3eab41302d55cf4c47270625a771d1bc99568cd1";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function stageLocalMobileFixture({ repositoryRoot = ROOT, candidatePaths = null } = {}) {
  const root = path.resolve(repositoryRoot);
  const targetPack = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");
  const targetIndex = path.join(root, "apps/mobile/assets/datapacks/index.json");

  if (existsSync(targetPack) && existsSync(targetIndex)) {
    const actualSha = sha256(readFileSync(targetPack));
    if (actualSha === EXPECTED_CAPITAL_GZIP_SHA256) {
      return { staged: false, alreadyPresent: true };
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

  mkdirSync(root, { recursive: true });
  const archiveTar = execFileSync(gitBin, ["-C", chosenCandidate, "archive", PINNED_MOBILE_REVISION, "apps/mobile"], {
    maxBuffer: 100 * 1024 * 1024,
  });

  execFileSync("tar", ["-x", "-C", root], {
    input: archiveTar,
  });

  if (!existsSync(targetPack)) {
    throw new Error(`Extraction failed: ${targetPack} not found after git archive`);
  }

  const actualSha = sha256(readFileSync(targetPack));
  if (actualSha !== EXPECTED_CAPITAL_GZIP_SHA256) {
    throw new Error(
      `Extracted capital.sqlite.gz sha256 mismatch: expected ${EXPECTED_CAPITAL_GZIP_SHA256}, got ${actualSha}`
    );
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
