import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// data#1084: admin 자동화 상태 snapshot 게시 workflow의 구조 계약. 쓰기 권한이 없고, 새 장기 비밀이 없고, run 스크립트에 expression이 없다.
const yml = readFileSync(new URL("../../.github/workflows/automation-status-publish.yml", import.meta.url), "utf8");

function stepBody(name) {
  const begin = yml.indexOf(`      - name: ${name}\n`);
  assert.notEqual(begin, -1, `missing workflow step: ${name}`);
  const end = yml.indexOf("\n      - name: ", begin + 1);
  return yml.slice(begin, end === -1 ? yml.length : end);
}

test("게시는 15분 정기 실행과 발행·RC 체인 완료, 사람 dispatch에서만 시작한다", () => {
  assert.match(yml, /^on:\n  schedule:\n    - cron: "7,22,37,52 \* \* \* \*"\n  workflow_run:\n    workflows: \["Data Pack Release Cross-Repository Chain", "Data Pack Release Candidate Chain"\]\n    types: \[completed\]\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(yml, /\n  (push|pull_request|pull_request_target):/u);
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.deepEqual(yml.split("\n").filter((line) => line.startsWith("    if: ")), [
    "    if: ${{ github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || vars.DATAPACK_AUTOMATION_STATUS_PUBLISH == 'true') }}",
  ]);
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
  assert.match(publish, /EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN: \$\{\{ secrets\.EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN \}\}/u);
  assert.equal(yml.split("secrets.EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN").length - 1, 1);
  assert.match(publish, /DEPLOY_PUBLIC_API_BASE_URL: \$\{\{ vars\.DEPLOY_PUBLIC_API_BASE_URL \}\}/u);
  assert.match(publish, /CHAIN_DATAPACK_BASE_URL: \$\{\{ vars\.OCI_SERVER_ROUTE_PUBLIC_BASE_URL \}\}/u);
  assert.match(publish, /APP_READ_TOKEN: \$\{\{ steps\.read-token\.outputs\.token \}\}/u);
  const run = publish.split("\n        run: ")[1];
  assert.equal(run.trim(), 'node tools/ci/build-automation-status.mjs --output "${RUNNER_TEMP}/automation-status.json"');
  assert.ok(yml.trimEnd().endsWith(publish.trimEnd()), "publishing is the last step");
});
