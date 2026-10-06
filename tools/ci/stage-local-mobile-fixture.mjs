#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// #979: fixture 커밋은 ITX topology 적용 전 입력 팩을 담는다. 승격마다 mobile 커밋이 바뀌지 않고, 출력 팩은 커밋된 증거에서 결정적으로 파생한다.
export const PINNED_MOBILE_REVISION = "573aefdbbf2e639d28de18697eb449da85415353";
export const INPUT_CAPITAL_GZIP_SHA256 = "609a74095859b5bf7602c25e142caa47cc212170a72d6240e2d01b39f874047a";

/** 파생된 팩의 기대 sha256은 커밋된 증거가 정한다. */
export function expectedDerivedCapitalGzipSha256(root = ROOT) {
  const evidence = JSON.parse(readFileSync(path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json"), "utf8"));
  return evidence.pack.outputSha256;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function stageLocalMobileFixture({ repositoryRoot = ROOT, candidatePaths = null } = {}) {
  const root = path.resolve(repositoryRoot);
  const targetPack = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");
  const targetIndex = path.join(root, "apps/mobile/assets/datapacks/index.json");

  if (existsSync(targetPack) && existsSync(targetIndex)) {
    const actualSha = sha256(readFileSync(targetPack));
    if (actualSha === expectedDerivedCapitalGzipSha256(root)) {
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

  const inputSha = sha256(readFileSync(targetPack));
  if (inputSha !== INPUT_CAPITAL_GZIP_SHA256) {
    throw new Error(
      `Extracted capital.sqlite.gz sha256 mismatch: expected input ${INPUT_CAPITAL_GZIP_SHA256}, got ${inputSha}`
    );
  }
  // 입력 팩에 승인 원천 topology를 적용해 커밋된 증거와 같은 팩을 파생한다. Node 24.19.0·SQLite 3.53.3(CI와 같은 런타임)이 필요하다.
  execFileSync(process.execPath, [
    path.join(root, "tools/datapack/apply-itx-topology-to-bundled-pack.mjs"),
    "--derive-fixture",
    path.join(root, "apps/mobile"),
  ], { stdio: ["ignore", "inherit", "inherit"] });
  const actualSha = sha256(readFileSync(targetPack));
  if (actualSha !== expectedDerivedCapitalGzipSha256(root)) {
    throw new Error(
      `Derived capital.sqlite.gz sha256 mismatch: expected ${expectedDerivedCapitalGzipSha256(root)}, got ${actualSha}`
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
