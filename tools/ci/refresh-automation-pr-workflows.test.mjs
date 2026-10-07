import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { REFRESH_STAGES } from "./refresh-stage-contracts.mjs";
import { loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #1012: 정기 갱신 4종 workflow가 PR을 열기 전에 증거 블록이 든 본문을 만든다.
// 새 PR(DUE 경로)은 결과를 커밋한 직후 push 전에, 복구 경로(RECOVER_CLAIM)는 PR 생성 직전에 emitter(refresh-automation-pr)를 부른다.
// 증거가 어긋나면 push·PR 생성 전에 실패해 #926 실패 보고로 드러난다. 증거 없이 PR을 여는 경로는 남기지 않는다.
const root = path.resolve(import.meta.dirname, "../..");
const RUN_URL = '--run-url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"';

const WORKFLOWS = {
  "retained-gwangju-timetable-refresh.yml": {
    finalize: "Finalize retained timetable claim", recover: "Recover completed retained timetable claim", create: "Create retained timetable draft pull request",
    refs: "Refs #504", mainSha: "${RETAINED_GWANGJU_MAIN_SHA}", branch: "${RETAINED_GWANGJU_BRANCH}", bodyFile: "${RETAINED_GWANGJU_STATE_ROOT}/pull-request-body.md",
    commit: 'git commit -m "Refresh retained Gwangju timetable"', stage: "gwangju-timetable-refresh",
  },
  "current-capital-topology-refresh.yml": {
    finalize: "Activate current topology inputs exactly once", recover: "Recover a completed claimed refresh", create: "Create draft pull request",
    refs: "Refs #636, #625", mainSha: "${TOPOLOGY_MAIN_SHA}", branch: "${TOPOLOGY_BRANCH}", bodyFile: "${TOPOLOGY_OPERATION_ROOT}/pull-request-body.md",
    commit: 'git commit -m "Activate current topology inputs"', stage: "capital-topology-refresh",
  },
  "kric-current-facility-refresh.yml": {
    finalize: "KRIC current facility refresh / Finalize claimed refresh branch", recover: "KRIC current facility refresh / Recover claimed refresh", create: "KRIC current facility refresh / Create draft pull request",
    refs: "Refs #629, #39, #29", mainSha: "${KRIC_REFRESH_MAIN_SHA}", branch: "${KRIC_REFRESH_BRANCH}", bodyFile: "${RUNNER_TEMP}/kric-current-facility-refresh/pull-request-body-${GITHUB_RUN_ID}.md",
    commit: 'git commit -m "Refresh KRIC facility snapshot"', stage: "kric-facility-refresh",
  },
  "seoul-current-accessibility-refresh.yml": {
    finalize: "Finalize claimed refresh branch", recover: "Recover completed claimed refresh", create: "Create draft pull request",
    refs: "Refs #639", mainSha: "${SEOUL_REFRESH_MAIN_SHA}", branch: "${SEOUL_REFRESH_BRANCH}", bodyFile: "${RUNNER_TEMP}/seoul-current-accessibility-refresh/pull-request-body-${GITHUB_RUN_ID}.md",
    commit: 'git commit -m "Refresh Seoul accessibility snapshot"', stage: "seoul-accessibility-refresh",
  },
};

const escapeRegex = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
/** gh pr create 명령 전체(줄 이음 \\ 포함). */
const createCommand = (block) => {
  const lines = block.split("\n");
  const start = lines.findIndex((entry) => entry.includes("gh pr create"));
  assert.notEqual(start, -1, "gh pr create");
  const command = [lines[start]];
  while (command.at(-1).trimEnd().endsWith("\\")) command.push(lines[start + command.length]);
  return command.join("\n");
};
const emitters = (block) => [...block.matchAll(/node tools\/ci\/refresh-automation-pr\.mjs body[^\n]*/gu)].map(([line]) => line);

test("갱신 4종 표가 단계 계약과 같은 workflow·단계를 가리킨다", () => {
  assert.deepEqual(Object.entries(WORKFLOWS).map(([file, { stage }]) => [file, stage]).sort(), Object.values(REFRESH_STAGES).map(({ workflow, stepId }) => [workflow, stepId]).sort());
});

for (const [file, spec] of Object.entries(WORKFLOWS)) {
  const { yml, steps, step } = loadWorkflow(root, file);

  test(`${file}: 결과를 커밋한 직후 push 전에 증거 본문을 만든다. 증거가 어긋나면 push·PR 전에 실패한다`, () => {
    const { block } = step(spec.finalize);
    const lines = emitters(block);
    assert.equal(lines.length, 1, "finalize 경로의 emitter 호출");
    const [line] = lines;
    const commit = block.indexOf(spec.commit);
    const emit = block.indexOf(line);
    const push = block.indexOf(`git push origin "${spec.branch}"`);
    assert.ok(commit !== -1 && emit > commit && push > emit, "commit -> emitter -> push 순서");
    assert.ok(line.includes(`--stage ${spec.stage}`), line);
    assert.ok(line.includes(`--base-sha "${spec.mainSha}"`), "기준은 claim이 묶은 main 커밋");
    assert.ok(line.includes('--head-sha "$(git rev-parse HEAD)"'), "head는 방금 만든 결과 커밋");
    assert.ok(line.includes(RUN_URL), line);
    assert.ok(line.includes(`--refs "${spec.refs}"`), line);
    assert.ok(line.includes(`--output "${spec.bodyFile}"`), line);
    assert.match(line, /--summary "[^"\n$]+"/u, "요약은 고정 문구");
    assert.match(block, /set -euo pipefail/u);
    // 증거 본문은 GITHUB_TOKEN 외의 토큰 없이 git 객체만 읽는다.
    assert.doesNotMatch(block, /APP_PR_TOKEN|create-github-app-token/u);
  });

  test(`${file}: 복구 경로도 PR 생성 직전에 증거 본문을 만든다. 기준은 main과의 실제 분기점이다`, () => {
    const { block } = step(spec.recover);
    const lines = emitters(block);
    assert.equal(lines.length, 1, "recover 경로의 emitter 호출");
    const [line] = lines;
    assert.ok(block.indexOf(line) < block.indexOf("gh pr create"), "emitter -> gh pr create");
    assert.ok(line.includes(`--stage ${spec.stage}`), line);
    assert.ok(line.includes('--base-sha "$(git merge-base origin/main "origin/${branch}")"'), "복구한 branch의 base는 main과의 분기점(정책이 대조하는 compare merge base)");
    assert.ok(line.includes('--head-sha "$(git rev-parse "origin/${branch}")"'), line);
    assert.ok(line.includes(RUN_URL), line);
    assert.ok(line.includes(`--refs "${spec.refs}"`), line);
    const create = createCommand(block);
    assert.match(create, /^\s*(?:pr_url="\$\()?GH_TOKEN="\$\{APP_PR_TOKEN\}" gh pr create /u);
    assert.match(create, /--body-file "[^"]+"/u);
    assert.ok(create.includes(line.match(/--output "([^"]+)"/u)[1]), "만든 본문 파일로 PR을 연다");
  });

  test(`${file}: PR 생성은 만든 본문 파일만 쓰고 증거 없는 본문 문자열은 남기지 않는다`, () => {
    const { block } = step(spec.create);
    const create = createCommand(block);
    assert.match(create, new RegExp(`--body-file "${escapeRegex(spec.bodyFile)}"`, "u"));
    assert.doesNotMatch(yml, /--body\s+["$]/u, "인라인 --body는 없다");
    assert.doesNotMatch(yml, /\\n\\nRefs #/u, "리터럴 \\n이 든 이전 형식의 본문이 없다");
    // finalize가 만든 본문 파일과 PR 생성 step이 읽는 파일이 같다.
    assert.ok(emitters(step(spec.finalize).block)[0].includes(`--output "${spec.bodyFile}"`));
    assert.match(create, /--draft/u);
  });

  test(`${file}: 본문 생성기 호출은 두 곳뿐이고 표현식을 펼치지 않는다`, () => {
    assert.equal([...yml.matchAll(/refresh-automation-pr\.mjs body/gu)].length, 2);
    // 새로 더한 호출에는 ${{ }} 표현식을 넣지 않는다. 값은 셸 변수로만 넘긴다(셸 주입 방지).
    for (const line of steps().flatMap(({ block }) => emitters(block))) assert.doesNotMatch(line, /\$\{\{/u, line);
    assert.doesNotMatch(yml, /refresh-automation-pr\.mjs (?!body)/u);
  });
}
