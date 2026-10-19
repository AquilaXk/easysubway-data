import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// data#1084: admin 자동화 상태 snapshot 게시 workflow의 구조 계약. 쓰기 권한이 없고, 새 장기 비밀이 없고, run 스크립트에 expression이 없다.
const yml = readFileSync(new URL("../../.github/workflows/automation-status-publish.yml", import.meta.url), "utf8");

const jobGuards = () => yml.split("\n").filter((line) => line.startsWith("    if: ")).map((line) => line.slice("    if: ${{ ".length, -" }}".length));
// job 가드 expression을 JS로 옮겨 평가한다(endsWith는 메서드, 비교 연산자는 엄격 비교).
const guardRuns = ({ event, actor, variable }) => {
  const expression = jobGuards()[0].replace(/endsWith\(([^,]+), ([^)]+)\)/gu, "$1.endsWith($2)").replace(/([=!])=/gu, "$1==");
  const github = { ref: "refs/heads/main", event_name: event, triggering_actor: actor };
  return new Function("github", "vars", `return ${expression};`)(github, { DATAPACK_AUTOMATION_STATUS_PUBLISH: variable });
};
const SCHEDULER_BOT = "easysubway-release-chain[bot]";

function stepBody(name) {
  const begin = yml.indexOf(`      - name: ${name}\n`);
  assert.notEqual(begin, -1, `missing workflow step: ${name}`);
  const end = yml.indexOf("\n      - name: ", begin + 1);
  return yml.slice(begin, end === -1 ? yml.length : end);
}

test("게시는 매시 정기 실행과 발행·RC 체인 완료, 사람 dispatch에서만 시작한다(봇 dispatch는 변수를 거친다)", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: "7 \* \* \* \*"\n  workflow_run:\n    workflows: \["Data Pack Release Cross-Repository Chain", "Data Pack Release Candidate Chain"\]\n    types: \[completed\]\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target):/u);
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal(jobGuards().length, 1);
  assert.match(yml, /\nconcurrency:\n  group: automation-status-publish\n  cancel-in-progress: true\n/u);
});

test("job은 읽기 권한만 갖고, 서비스 토큰이 든 production-datapack 환경에서만 돈다", () => {
  assert.match(yml, /\n    environment: production-datapack\n/u);
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: read\n      issues: read\n      pull-requests: read\n/u);
  assert.doesNotMatch(yml, /: write\b/u);
  assert.doesNotMatch(yml, /continue-on-error/u);
  const token = stepBody("Create the hub and platform read token");
  assert.match(token, /uses: actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/u);
  assert.match(token, /repositories: easysubway,easysubway-platform\n/u);
  assert.deepEqual(token.split("\n").filter((line) => /^ {10}permission-/u.test(line)).map((line) => line.trim()), ["permission-actions: read"]);
});

test("서비스 토큰은 게시 step의 env로만 들어가고 run 스크립트에는 expression이 없다", () => {
  const publish = stepBody("Collect and publish the automation status");
  assert.match(publish, /EASYSUBWAY_DATAPACK_AUTOMATION_STATUS_TOKEN: \$\{\{ secrets\.EASYSUBWAY_DATAPACK_AUTOMATION_STATUS_TOKEN \}\}/u);
  assert.equal(yml.split("secrets.EASYSUBWAY_DATAPACK_AUTOMATION_STATUS_TOKEN").length - 1, 1);
  assert.doesNotMatch(yml, /EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN/u);
  assert.match(publish, /DEPLOY_PUBLIC_API_BASE_URL: \$\{\{ vars\.DEPLOY_PUBLIC_API_BASE_URL \}\}/u);
  assert.match(publish, /CHAIN_DATAPACK_BASE_URL: \$\{\{ vars\.OCI_SERVER_ROUTE_PUBLIC_BASE_URL \}\}/u);
  assert.match(publish, /APP_READ_TOKEN: \$\{\{ steps\.read-token\.outputs\.token \}\}/u);
  const run = publish.split("\n        run: ")[1];
  assert.equal(run.trim(), "node tools/ci/build-automation-status.mjs");
  assert.ok(yml.trimEnd().endsWith(publish.trimEnd()), "publishing is the last step");
});

test("곧 만료되는 원천 근거 게시는 변수 DATAPACK_AUTOMATION_STATUS_FRESHNESS를 env로만 받고 기본 꺼짐이다(backend 배포 전에는 필드를 보내지 않는다)", () => {
  const publish = stepBody("Collect and publish the automation status");
  assert.match(publish, /\n          AUTOMATION_STATUS_SOURCE_FRESHNESS: \$\{\{ vars\.DATAPACK_AUTOMATION_STATUS_FRESHNESS \}\}\n/u);
  assert.equal(yml.split("DATAPACK_AUTOMATION_STATUS_FRESHNESS").length - 1, 2, "header 한 줄과 env 한 곳뿐이다");
  const header = yml.split("\n").filter((line) => line.startsWith("#")).join("\n");
  assert.match(header, /DATAPACK_AUTOMATION_STATUS_FRESHNESS[^\n]*기본 꺼짐/u);
  assert.match(header, /backend#507/u);
  assert.match(header, /QA 보고 뒤[^\n]*설정 변경/u);
  const code = yml.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /gh variable|actions\/variables/u);
  assert.equal(publish.split("\n        run: ")[1].trim(), "node tools/ci/build-automation-status.mjs");
});

test("변수가 꺼져 있으면 스케줄러 봇 dispatch는 건너뛰고 사람 dispatch만 돈다", () => {
  assert.equal(guardRuns({ event: "workflow_dispatch", actor: SCHEDULER_BOT, variable: "false" }), false);
  assert.equal(guardRuns({ event: "workflow_dispatch", actor: "other-app[bot]", variable: "" }), false);
  assert.equal(guardRuns({ event: "workflow_dispatch", actor: "AquilaXk", variable: "false" }), true);
  assert.equal(guardRuns({ event: "schedule", actor: "github-actions[bot]", variable: "false" }), false);
});

test("변수가 켜져 있으면 스케줄러 봇 dispatch와 정기 실행이 돈다", () => {
  assert.equal(guardRuns({ event: "workflow_dispatch", actor: SCHEDULER_BOT, variable: "true" }), true);
  assert.equal(guardRuns({ event: "schedule", actor: "github-actions[bot]", variable: "true" }), true);
});
