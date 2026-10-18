#!/usr/bin/env node
// 만든 run이 끝났는데 PR 없이 남은 claim 브랜치(stale)를 대기 판정 전에 회수한다(#1326).
//
// 원장을 쓰는 갱신 workflow는 provider에 접근하기 전에 claim 브랜치를 push한다. 그 run이 실패하거나 runner가 죽어 claim이 남으면
// 등록·재확인·파생 재결속·후보 갱신이 모두 "원장 writer가 진행 중"으로 보고 기다린다(ledger-writers-idle). 소유 workflow의 다음 정기 실행까지 최대 2시간이다.
// 실패한 run이 스스로 해제하는 경로(release-own-claim)가 1차 방어이고, 이 도구는 그 경로가 실패했을 때를 위한 2차 방어다.
//
// 회수 기준은 새로 만들지 않는다. claim-orphans.mjs의 공유 판정(classifyUnboundClaim)이 ABANDONED로 본 claim만 지운다.
//   - 만든 run이 completed(failure·cancelled)이고 claim에 묶인 PR이 어떤 상태로도 없으며, 빈 claim 하나뿐이고 게시 step이 시작되지 않았다.
//   - 진행 중인 run(ACTIVE), PR이 있는 claim(성공 후 PR 대기·닫힘), 출력 커밋이나 보존 증거가 있는 claim(RECOVERABLE)은 지우지 않는다.
//   - 게시 step이 시작됐는데 증거가 없는 claim(CLAIM_ORPHAN_PUBLISHED_UNREGISTERED)처럼 판정을 던지는 상태와 API 오류는 fail closed다: claim을 남겨 차단을 유지한다.
//   - 등록·재확인 workflow(publicationSteps 미정의)는 자기 판정과 자기 정리 step이 있어 여기서 판정하지 않는다(OWNER_DECIDES).
// 지울 때는 remove-orphan-claims를 그대로 쓴다: 소유 workflow의 실패 이슈에 보고(#926)한 뒤 지우고, push 직전에 run 상태·claim 모양·PR을 다시 확인하고 lease로 지운다.
// claim마다 독립이다. 하나가 판정 불가여도 다른 stale claim은 회수한다. 판정 근거를 모으는 목록 조회(PR)가 실패하면 실패한다(collect-automation-prs와 같다).
//
// 사용: node tools/ci/reclaim-stale-claims.mjs --repository <owner/repo>
// git push 인증은 이 도구가 `gh auth setup-git`으로 준비한다. gh run view에는 actions: read, 삭제 push에는 contents: write 권한이 필요하다.
import { pathToFileURL } from "node:url";

import { parseAutomationBranches, validRepository } from "./automation-pr-state.mjs";
import { CLAIM_OWNERS, classifyUnboundClaim, collectClaimEvidence } from "./claim-orphans.mjs";
import { collectAutomationPullRequests } from "./collect-automation-prs.mjs";
import { defaultRunGh } from "./report-refresh-failure.mjs";
import { defaultRunGit, removeOrphanClaims, setupGitAuth } from "./remove-orphan-claims.mjs";

const AUTOMATION_REFS = "refs/heads/automation/*";
// 열린 PR 목록 상한. 판정 step들과 같다(--pr-limit 1000).
const OPEN_PR_LIMIT = 1000;

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

// 판정에 쓰는 claim: 소유 workflow(CLAIM_OWNERS)의 접두어인 것. 다른 소유자의 claim은 여기서 다루지 않는다.
function ownedClaims(branches) {
  return Object.entries(CLAIM_OWNERS)
    .flatMap(([workflowFile, { prefix }]) => branches.filter((branch) => branch.startsWith(prefix)).map((branch) => ({ workflowFile, branch })));
}

// 이 claim이 stale인지 정한다. 회수 가능하면 null, 아니면 남기는 이유를 돌려준다. 판정 불가는 던진다(호출한 쪽이 fail closed로 남긴다).
async function keptReason({ workflowFile, branch, repository, pullRequests, runGh }) {
  if (CLAIM_OWNERS[workflowFile].publicationSteps === undefined) return "OWNER_DECIDES: this workflow's own decision and cleanup step handle its claim";
  const evidence = (await collectClaimEvidence({ workflowFile, repository, claimBranches: [branch], pullRequests, runGh })).find((item) => item.bound !== true);
  if (evidence === undefined) return "HAS_PULL_REQUEST: a pull request is attached to the claim";
  const { kind, reason } = classifyUnboundClaim(workflowFile, evidence);
  return kind === "ABANDONED" ? null : `${kind}: ${reason}`;
}

/**
 * PR 없이 남은 stale claim을 회수한다.
 * @returns {{ reclaimed: string[], kept: { branch: string, reason: string }[] }} 지운 claim과, 판정 결과 차단을 유지한 claim(이유 포함)
 */
export async function reclaimStaleClaims({ repository, runGh = defaultRunGh, runGit = defaultRunGit, log = console.log, ...removeDependencies } = {}) {
  if (!validRepository(repository)) fail("CLAIM_ORPHAN_INPUT_INVALID", "repository");
  const refsText = await runGit(["ls-remote", "--heads", "origin", AUTOMATION_REFS]);
  const claims = ownedClaims(parseAutomationBranches(refsText));
  const result = { reclaimed: [], kept: [] };
  if (claims.length === 0) return result;
  const refLines = new Map(refsText.split("\n").filter(Boolean).map((line) => [line.split("\trefs/heads/")[1], `${line}\n`]));
  const { pullRequests } = await collectAutomationPullRequests({ repository, refsText: claims.map(({ branch }) => refLines.get(branch)).join(""), limit: OPEN_PR_LIMIT, runGh });
  const keep = (branch, reason, undecidable) => {
    result.kept.push({ branch, reason });
    log(`::${undecidable ? "warning" : "notice"} title=Stale ledger claim kept::branch=${branch} reason=${reason}`);
  };
  for (const { workflowFile, branch } of claims) {
    try {
      // claim마다 gh를 부르므로 일부러 순차다(claim 50개 상한).
      const reason = await keptReason({ workflowFile, branch, repository, pullRequests, runGh }); // NOSONAR
      if (reason !== null) {
        keep(branch, reason, false);
        continue;
      }
      await removeOrphanClaims({ workflowFile, repository, claims: [branch], refsText: refLines.get(branch), runGh, runGit, log, ...removeDependencies }); // NOSONAR
      result.reclaimed.push(branch);
      log(`::notice title=Stale ledger claim reclaimed::branch=${branch} workflow=${workflowFile}`);
    } catch (error) {
      keep(branch, errorMessage(error), true);
    }
  }
  return result;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] !== "--repository" || Object.hasOwn(values, "repository") || typeof argv[index + 1] !== "string") fail("CLAIM_ORPHAN_INPUT_INVALID", `argument ${String(argv[index])}`);
    values.repository = argv[index + 1];
  }
  if (!Object.hasOwn(values, "repository")) fail("CLAIM_ORPHAN_INPUT_INVALID", "missing --repository");
  return values;
}

export async function main(argv, dependencies = {}) {
  const input = parseArgs(argv);
  await setupGitAuth(dependencies.runGh);
  const result = await reclaimStaleClaims({ ...input, ...dependencies });
  (dependencies.log ?? console.log)(`stale claims: reclaimed=${result.reclaimed.length} kept=${result.kept.length}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
