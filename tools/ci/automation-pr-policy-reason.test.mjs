import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// 2026-10-22 automation-pr-automerge.yml의 판정 step이 실패했을 때 로그에서 실패 이유를 한눈에 찾을 수 없었다.
// 판정 CLI를 실제 프로세스로 띄우고, GitHub API는 PATH 앞에 둔 가짜 `gh`로 대신해 stderr의 마지막 줄(reason=...)을 확인한다.
const POLICY = path.resolve(import.meta.dirname, "automation-pr-policy.mjs");
const REPOSITORY = "AquilaXk/easysubway-data";
const HEAD = "b".repeat(40);
const DECIDE = ["decide", "--repository", REPOSITORY, "--head-sha", HEAD, "--run-conclusion", "success", "--run-id", "39799412785"];
const TOKEN = "synthetic-github-token-that-must-not-leak";

async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "automation-pr-policy-reason-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runPolicy(directory, args, ghScript = "exit 99") {
  const bin = path.join(directory, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "gh"), `#!/bin/sh\n${ghScript}\n`);
  await chmod(path.join(bin, "gh"), 0o755);
  const result = spawnSync(process.execPath, [POLICY, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, GH_TOKEN: TOKEN },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout, lines: result.stderr.split("\n").filter((line) => line !== "") };
}

const lastLine = ({ lines }) => lines.at(-1);

// gh가 실패하거나 이상한 본문을 돌려주는 방식마다 마지막 줄의 사유: [이름, 가짜 gh 스크립트, 기대하는 마지막 줄]
const GH_FAILURES = [
  ["HTTP 5xx로 실패하면 상태 숫자를 함께 남긴다", `echo "gh: HTTP 502: Bad Gateway (https://api.github.com/repos/${REPOSITORY}/commits/${HEAD}/pulls)" >&2\nexit 1`, "reason=GITHUB_API_STATUS status=502"],
  ["응답을 받지 못하면(연결 실패·timeout) 요청 실패다", 'echo "error connecting to api.github.com" >&2\nexit 1', "reason=GITHUB_API_REQUEST_FAILED"],
  ["성공으로 끝났지만 본문이 JSON이 아니면 본문 이상이다", 'echo "<html>Bad gateway</html>"', "reason=GITHUB_API_BODY_INVALID"],
];

for (const [name, ghScript, reasonLine] of GH_FAILURES) {
  test(`gh api ${name}`, async () => {
    await withDirectory(async (directory) => {
      const result = await runPolicy(directory, DECIDE, ghScript);
      assert.equal(result.status, 1);
      assert.equal(lastLine(result), reasonLine);
    });
  });
}

test("판정 인자 이상은 reason=AUTOMATION_PR_INPUT이다", async () => {
  await withDirectory(async (directory) => {
    const result = await runPolicy(directory, ["decide", "--repository", REPOSITORY]);
    assert.equal(result.status, 1);
    assert.match(result.lines[0], /^AUTOMATION_PR_INPUT: /u);
    assert.equal(lastLine(result), "reason=AUTOMATION_PR_INPUT");
  });
});

test("증거 블록이 없는 PR은 reason=AUTOMATION_PR_EVIDENCE_MISSING이다", async () => {
  await withDirectory(async (directory) => {
    const pull = path.join(directory, "pull.json");
    await writeFile(pull, JSON.stringify({ body: "증거 없음", head: { ref: "automation/456-capital-topology-registration-9001", sha: HEAD } }));
    const result = await runPolicy(directory, ["prepare", "--pull-request", pull]);
    assert.equal(result.status, 1);
    assert.equal(lastLine(result), "reason=AUTOMATION_PR_EVIDENCE_MISSING");
  });
});

test("코드가 붙지 않은 예외는 reason=INTERNAL_ERROR로 드러난다", async () => {
  await withDirectory(async (directory) => {
    const result = await runPolicy(directory, ["prepare", "--pull-request", path.join(directory, "missing.json")]);
    assert.equal(result.status, 1);
    assert.equal(lastLine(result), "reason=INTERNAL_ERROR");
  });
});

test("성공 판정(대상 아님)은 stderr 없이 stdout에 판정을 쓰고 0으로 끝난다", async () => {
  await withDirectory(async (directory) => {
    const result = await runPolicy(directory, DECIDE, "echo '[]'");
    assert.equal(result.status, 0);
    assert.deepEqual(result.lines, []);
    assert.match(result.stdout, /자동화 PR 판정: NOT_APPLICABLE/u);
  });
});
