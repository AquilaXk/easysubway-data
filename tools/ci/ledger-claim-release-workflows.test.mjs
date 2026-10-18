import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CLAIM_OWNERS } from "./claim-orphans.mjs";
import { ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #1326: 원장 writer가 claim 브랜치를 남기고 끝나면 다른 writer가 소유 workflow의 다음 정기 실행까지 기다린다.
// 방어는 두 겹이다. (1) 실패한 소유 run이 자기 claim을 같은 run에서 푼다. (2) 기다리는 workflow가 대기 판정 전에 stale claim을 회수한다.
// workflow마다 따로 적으면 하나가 빠지기 쉬우므로 claim을 만드는 workflow와 claim을 기다리는 workflow를 전수로 대조한다.
const ROOT = path.resolve(import.meta.dirname, "../..");
const WORKFLOWS_DIR = path.join(ROOT, ".github/workflows");
const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((file) => file.endsWith(".yml")).sort();

// 소유 workflow: claim을 만드는 step 이름, 환경변수 접두어, 게시 step이 있으면 그 step의 id.
// 등록·재확인은 자기 판정과 자기 정리 step(게시 receipt를 남긴 claim은 복구용으로 남겨야 한다)이 있어 이 표에 없고 아래에서 따로 확인한다.
const SELF_RELEASE = Object.freeze([
  { file: "retained-gwangju-timetable-refresh.yml", envPrefix: "RETAINED_GWANGJU", releaseStep: "Release this failed run's claim", publishId: "publish" },
  { file: "seoul-current-accessibility-refresh.yml", envPrefix: "SEOUL_REFRESH", releaseStep: "Release this failed run's claim", publishId: "publish" },
  { file: "kric-current-facility-refresh.yml", envPrefix: "KRIC_REFRESH", releaseStep: "KRIC current facility refresh / Release this failed run's claim", publishId: "publish" },
  { file: "current-capital-topology-refresh.yml", envPrefix: "TOPOLOGY", releaseStep: "Remove this failed run's empty topology claim", publishId: null },
]);
const INLINE_RELEASE = Object.freeze(["current-capital-topology-registration.yml", "source-reverification.yml"]);

test("CLAIM_OWNERS의 workflow는 모두 자기 claim 해제 경로가 있다(전수)", () => {
  const covered = new Set([...SELF_RELEASE.map(({ file }) => file), ...INLINE_RELEASE]);
  assert.deepEqual(Object.keys(CLAIM_OWNERS).filter((file) => !covered.has(file)), [], "해제 경로가 없는 claim 소유 workflow");
});

for (const { file, envPrefix, releaseStep, publishId } of SELF_RELEASE) {
  test(`${file}: 실패한 run이 자기 claim을 마지막 실패 보고 전에 release-own-claim으로 푼다`, () => {
    const { yml, steps, step } = loadWorkflow(ROOT, file);
    const release = step(releaseStep);
    assert.equal(ifCondition(release.block), `\${{ failure() && env.${envPrefix}_BRANCH != '' && env.${envPrefix}_CLAIM_SHA != '' }}`);
    assert.match(release.block, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
    assert.match(release.block, /\n          gh auth setup-git\n/u);
    assert.ok(release.block.includes(`node tools/ci/release-own-claim.mjs --workflow ${file} --repository "\${GITHUB_REPOSITORY}" --run-id "\${GITHUB_RUN_ID}" --branch "\${${envPrefix}_BRANCH}" --claim-sha "\${${envPrefix}_CLAIM_SHA}"`));
    assert.doesNotMatch(release.block, /--force|git push|git branch -D|gh api -X DELETE|continue-on-error/u, "삭제 규칙은 도구가 정한다");
    // 실패 보고가 마지막 step이라 이 step의 실패도 보고된다.
    const names = steps().map(({ name }) => name);
    assert.equal(names.at(-1).endsWith("Report refresh failure as an issue"), true);
    assert.equal(names.indexOf(releaseStep), names.length - 2, "해제 step은 실패 보고 바로 앞이다");
    // claim을 만드는 step이 해제가 비교할 sha를 기록한다.
    assert.match(yml, new RegExp(String.raw`printf '${envPrefix}_CLAIM_SHA=%s\\n' "\$\{claim_(?:head|sha)\}"`, "u"));
    if (publishId === null) {
      // OCI에 게시하지 않는 workflow: 빈 claim 하나가 전체 증거라 게시 step 결과를 받지 않는다.
      assert.equal(CLAIM_OWNERS[file].publicationSteps, null);
      assert.doesNotMatch(release.block, /--publication-outcome/u);
      return;
    }
    // OCI에 게시하는 workflow: 같은 job의 게시 step이 건너뛰어졌을 때만 푼다. 결과는 env로 받아 셸에는 변수로만 넣는다.
    const publish = CLAIM_OWNERS[file].publicationSteps[0];
    const publishBlock = step(publish).block;
    assert.match(publishBlock, new RegExp(String.raw`\n        id: ${publishId}\n`, "u"));
    assert.match(release.block, new RegExp(String.raw`\n          PUBLICATION_OUTCOME: \$\{\{ steps\.${publishId}\.outcome \}\}\n`, "u"));
    assert.match(release.block, /--publication-outcome "\$\{PUBLICATION_OUTCOME\}"/u);
    assert.doesNotMatch(release.block.split("\n        run: ")[1], /\$\{\{/u);
  });
}

test("등록·재확인 workflow는 자기 정리 step으로 자기 claim을 푼다(게시 receipt가 있으면 복구용으로 남긴다)", () => {
  assert.match(loadWorkflow(ROOT, "current-capital-topology-registration.yml").step("Remove this run's claim after a failed or cancelled run").block, /kept \$\{branch\} with its publication receipt for recovery/u);
  assert.match(loadWorkflow(ROOT, "source-reverification.yml").step("Remove this run's claim unless it became a pull request").block, /git push origin --delete/u);
});

// 원장 writer를 기다리는 workflow(ledger-writers-idle이나 pending 판정을 쓰는 것)는 대기 판정 전에 stale claim을 회수한다.
const WAITERS = Object.freeze([
  { file: "current-capital-topology-registration.yml", except: "current-capital-topology-registration.yml", anchors: ["Recheck that no source-ledger automation is pending before pushing"] },
  { file: "source-reverification.yml", except: "source-reverification.yml", anchors: ["Decide which P7D sources are due", "Recheck that no source-ledger automation is pending before pushing"] },
  { file: "source-derivative-rebinding.yml", except: "source-derivative-rebinding.yml", anchors: ["Decide whether derivative rebinding may run", "Recheck that no source-ledger automation is pending before pushing"] },
  { file: "nationwide-candidate-refresh.yml", except: null, anchors: ["Decide whether the nationwide candidate must be refreshed", "Recheck that no source-ledger automation is pending before pushing"] },
]);

for (const { file, except, anchors } of WAITERS) {
  test(`${file}: 대기 판정 전에 stale claim을 회수하고 run 조회 권한(actions: read)이 있다`, () => {
    const { yml, steps } = loadWorkflow(ROOT, file);
    assert.match(yml, /\n    permissions:\n(?:      [a-z-]+: (?:read|write)\n)*      actions: read\n/u, "gh run view로 만든 run을 조회한다");
    const command = `node tools/ci/reclaim-stale-claims.mjs --repository "\${GITHUB_REPOSITORY}"${except ? ` --except-workflow ${except}` : ""}`;
    for (const anchor of anchors) {
      const { block } = steps().find(({ name }) => name === anchor) ?? assert.fail(`step ${anchor}`);
      const script = block.split("\n        run: ")[1];
      const reclaim = script.indexOf(command);
      assert.ok(reclaim !== -1, `${anchor}: 회수 호출`);
      assert.ok(script.lastIndexOf("gh auth setup-git", reclaim) !== -1, `${anchor}: 삭제 push 인증을 먼저 준비한다`);
      assert.ok(reclaim < script.indexOf('git ls-remote --heads origin "refs/heads/automation/'), `${anchor}: 회수가 claim 목록 조회보다 먼저다`);
      assert.match(block, /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n/u);
    }
  });
}

test("ledger-writers-idle을 쓰는 workflow는 모두 stale 회수를 호출한다(전수)", () => {
  const callers = workflowFiles.filter((file) => readFileSync(path.join(WORKFLOWS_DIR, file), "utf8").includes("tools/ci/ledger-writers-idle.mjs"));
  assert.deepEqual(callers.filter((file) => !WAITERS.some((waiter) => waiter.file === file)), [], "WAITERS에 없는 대기 workflow");
  for (const file of callers) assert.ok(readFileSync(path.join(WORKFLOWS_DIR, file), "utf8").includes("tools/ci/reclaim-stale-claims.mjs"), file);
});
