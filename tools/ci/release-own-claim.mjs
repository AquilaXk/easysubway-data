#!/usr/bin/env node
// 실패한 원장 writer run이 자기가 만든 claim 브랜치를 같은 run에서 해제한다(#1326).
//
// claim을 남기고 끝난 run은 원장을 쓰는 다른 자동화(등록·재확인·파생 재결속·후보 갱신)를 소유 workflow의 다음 정기 실행까지 모두 막는다.
// 소유 workflow가 `failure()` step에서 이 도구를 불러 자기 claim을 바로 푼다. 이 도구는 원격 sha를 읽어 remove-orphan-claims의 자기 run 모드로 넘기는 일만 한다.
// 삭제 규칙은 거기에 있다: 보고(#926) 먼저, 빈 claim 하나(ahead 1, 제목 일치, 변경 파일 0)·PR 없음·원격 sha가 claim을 만들 때 기록한 sha와 같을 때만 지운다.
// OCI에 게시하는 workflow는 같은 job의 게시 step 결과(--publication-outcome)가 skipped일 때만 받는다.
// 이 도구가 실패하거나 runner가 죽어 claim이 남아도 reclaim-stale-claims가 다음 대기 판정에서 회수한다.
//
// 사용: node tools/ci/release-own-claim.mjs --workflow <file> --repository <owner/repo> --run-id <GITHUB_RUN_ID> --branch <claim 브랜치> --claim-sha <claim 커밋 sha> [--publication-outcome <step outcome>]
// git push 인증은 이 도구가 `gh auth setup-git`으로 준비한다.
import { pathToFileURL } from "node:url";

import { defaultRunGit, removeOrphanClaims, setupGitAuth } from "./remove-orphan-claims.mjs";

const REQUIRED = Object.freeze({ "--workflow": "workflowFile", "--repository": "repository", "--run-id": "runId", "--branch": "branch", "--claim-sha": "claimSha" });
const OPTIONAL = Object.freeze({ "--publication-outcome": "publicationOutcome" });

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

/** 자기 claim의 원격 sha를 읽어 자기 run 모드로 지운다. 이미 없으면 지울 것이 없다. */
export async function releaseOwnClaim({ workflowFile, repository, runId, branch, claimSha, publicationOutcome, runGit = defaultRunGit, removeClaims = removeOrphanClaims, log = console.log, ...removeDependencies } = {}) {
  const refsText = await runGit(["ls-remote", "origin", `refs/heads/${branch}`]);
  if (refsText.trim() === "") {
    log(`${branch} is already absent; nothing to release`);
    return [];
  }
  return removeClaims({ workflowFile, repository, claims: [branch], refsText, selfRunId: runId, expectedSha: claimSha, publicationOutcome, runGit, log, ...removeDependencies });
}

function parseArgs(argv) {
  const keys = { ...REQUIRED, ...OPTIONAL };
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys[argv[index]];
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("CLAIM_ORPHAN_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const [flag, key] of Object.entries(REQUIRED)) if (!Object.hasOwn(values, key)) fail("CLAIM_ORPHAN_INPUT_INVALID", `missing ${flag}`);
  return values;
}

export async function main(argv, dependencies = {}) {
  const input = parseArgs(argv);
  await setupGitAuth(dependencies.runGh);
  return releaseOwnClaim({ ...input, ...dependencies });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
