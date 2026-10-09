import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// data#1084: 발행 체인 진행 중에는 data main이 움직이지 않아야 한다(production-publish는 candidate head_sha == main을 요구한다).
// 잠금은 변수·라벨이 아니라 "체인 workflow의 진행 중 run"이다. 체인이 죽어도 run이 끝나면 자동으로 풀린다.
const read = (file) => readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
const queue = read("automerge-queue.yml");
const rcChain = read("datapack-release-candidate-chain.yml");
const release = read("datapack-release.yml");

function stepBody(yml, name) {
  const begin = yml.indexOf(`      - name: ${name}\n`);
  assert.notEqual(begin, -1, `missing workflow step: ${name}`);
  const end = yml.indexOf("\n      - name: ", begin + 1);
  return yml.slice(begin, end === -1 ? yml.length : end);
}

function runBlock(body) {
  const marker = "\n        run: |\n";
  const begin = body.indexOf(marker);
  assert.notEqual(begin, -1);
  return body.slice(begin + marker.length).split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
}

async function runBash(script, { env = {}, ghScript = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chain-lock-"));
  try {
    const output = path.join(directory, "github-output");
    await writeFile(output, "");
    let PATH = process.env.PATH;
    if (ghScript !== null) {
      await writeFile(path.join(directory, "gh"), `#!/bin/bash\n${ghScript}\n`);
      await chmod(path.join(directory, "gh"), 0o755);
      PATH = `${directory}:${PATH}`;
    }
    const result = spawnSync("/bin/bash", ["-e", "-c", script], {
      encoding: "utf8", env: { PATH, HOME: process.env.HOME, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "AquilaXk/easysubway-data", ...env },
    });
    return { ...result, output: await readFile(output, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// gh api repos/.../actions/workflows/<file>/runs?... 호출에 workflow별 진행 중 run 수를 답하는 가짜 gh.
const fakeGh = ({ rc = 0, chain = 0, fail = false, junk = false }) => `
if [[ "$*" == *"datapack-release-candidate-chain.yml/runs"* ]]; then
  ${fail ? "echo boom >&2; exit 1" : junk ? "echo not-a-number" : `echo ${rc}`}
elif [[ "$*" == *"datapack-release-cross-repo-chain.yml/runs"* ]]; then
  echo ${chain}
else
  echo "unexpected gh call: $*" >&2; exit 2
fi`;

test("run-name에 mode가 들어가 RC·발행 run을 API로 구분할 수 있다", () => {
  assert.match(release, /\nrun-name: \$\{\{ github\.workflow \}\} \(\$\{\{ inputs\.mode \|\| github\.event_name \}\}\)\n/u);
  assert.ok(release.indexOf("\nrun-name:") < release.indexOf("\non:\n"));
});

test("RC chain은 RC run이 끝날 때까지 job을 유지해 잠금 구간을 RC 전체로 넓힌다", async () => {
  assert.match(rcChain, /\n    timeout-minutes: 75\n/u);
  assert.match(stepBody(rcChain, "Dispatch release candidate"), /\n        id: dispatch\n/u);
  const hold = stepBody(rcChain, "Hold the merge lock until the release candidate run finishes");
  assert.match(hold, /if: \$\{\{ steps\.supersede\.outputs\.current == 'true' \}\}/u);
  assert.match(hold, /RC_RUN_ID: \$\{\{ steps\.dispatch\.outputs\.rc_run_id \}\}/u);
  assert.ok(rcChain.trimEnd().endsWith(hold.trimEnd()), "hold is the last step");
  assert.doesNotMatch(runBlock(hold), /\$\{\{/u);
  const script = runBlock(hold);
  const finished = await runBash(script, { env: { RC_RUN_ID: "7001" }, ghScript: 'echo completed' });
  assert.equal(finished.status, 0, finished.stderr);
  assert.match(finished.stdout, /merge lock is released/u);
  const invalid = await runBash(script, { env: { RC_RUN_ID: "x" }, ghScript: "echo completed" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid/u);
  const apiFailure = await runBash(script, { env: { RC_RUN_ID: "7001" }, ghScript: "echo boom >&2; exit 1" });
  assert.notEqual(apiFailure.status, 0);
});

// 유지 시간은 계약이다: 반복 횟수 x 대기 시간이 RC 전체(최대 60분)를 덮어야 하고, job 제한(75분) 안이어야 한다. 줄이면(seq 1 1 등) 잠금이 RC 중간에 풀린다.
test("잠금 유지 반복은 10초 간격 360회(60분)이고 RC가 마지막 확인에서 끝나도 풀리며, 끝나지 않으면 360회 확인 뒤 실패한다", async () => {
  const script = runBlock(stepBody(rcChain, "Hold the merge lock until the release candidate run finishes"));
  // 가짜 gh는 호출 횟수를 세어 N번째 호출부터 completed를 답하고, 가짜 sleep은 요청한 초를 기록만 한다(실제로 기다리지 않는다).
  const run = async (completeAt) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "chain-hold-"));
    try {
      const counter = path.join(directory, "polls");
      const sleeps = path.join(directory, "sleeps");
      await writeFile(counter, "0");
      await writeFile(sleeps, "");
      await writeFile(path.join(directory, "gh"), `#!/bin/bash\nn=$(( $(cat "${counter}") + 1 )); echo $n > "${counter}"\nif [ "$n" -ge ${completeAt} ]; then echo completed; else echo in_progress; fi\n`);
      await writeFile(path.join(directory, "sleep"), `#!/bin/bash\necho "$1" >> "${sleeps}"\n`);
      await chmod(path.join(directory, "gh"), 0o755);
      await chmod(path.join(directory, "sleep"), 0o755);
      const result = spawnSync("/bin/bash", ["-e", "-c", script], {
        encoding: "utf8", env: { PATH: `${directory}:${process.env.PATH}`, HOME: process.env.HOME, GITHUB_REPOSITORY: "AquilaXk/easysubway-data", RC_RUN_ID: "7001" },
      });
      const polls = Number(await readFile(counter, "utf8"));
      const slept = (await readFile(sleeps, "utf8")).split("\n").filter(Boolean).map(Number);
      return { ...result, polls, slept };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const lastMoment = await run(360);
  assert.equal(lastMoment.status, 0, lastMoment.stderr);
  assert.equal(lastMoment.polls, 360);
  assert.equal(lastMoment.slept.length, 359);
  assert.ok(lastMoment.slept.every((seconds) => seconds === 10));

  const never = await run(100000);
  assert.notEqual(never.status, 0);
  assert.match(never.stderr, /did not finish within 60 minutes/u);
  assert.equal(never.polls, 360);
  assert.equal(never.slept.length, 360);
  assert.equal(never.slept.reduce((sum, seconds) => sum + seconds, 0), 3600);
  const jobMinutes = Number(/\n    timeout-minutes: (\d+)\n/u.exec(rcChain)?.[1]);
  assert.ok(jobMinutes * 60 > 3600, "job 제한이 잠금 유지 시간보다 길어야 마지막 확인과 실패 메시지까지 실행된다");
});

test("큐는 체인 workflow의 진행 중 run을 잠금으로 읽고, 모르면 잠긴 것으로 본다", async () => {
  const body = stepBody(queue, "Check the data pack release chain lock");
  assert.match(body, /\n        id: chain-lock\n/u);
  assert.match(body, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(runBlock(body), /\$\{\{/u);
  assert.ok(queue.indexOf("Check the data pack release chain lock") < queue.indexOf("Coordinate eligible pull requests"));
  const script = runBlock(body);
  for (const [label, gh, expected] of [
    ["idle", fakeGh({}), "locked=false\n"],
    ["rc chain running", fakeGh({ rc: 1 }), "locked=true\n"],
    ["cross-repo chain running", fakeGh({ chain: 2 }), "locked=true\n"],
    ["lookup failed", fakeGh({ fail: true }), "locked=unknown\n"],
    ["junk answer", fakeGh({ junk: true }), "locked=unknown\n"],
  ]) {
    const result = await runBash(script, { ghScript: gh });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.equal(result.output, expected, label);
  }
  // 진행 중이 아닌 run(completed)은 세지 않는다: jq 필터가 status != completed만 센다.
  assert.match(script, /select\(\.status != "completed"\)/u);
});

test("큐 코디네이터는 잠금이 풀린 것이 확인될 때만 병합 루프에 들어간다", async () => {
  assert.match(stepBody(queue, "Coordinate eligible pull requests"), /CHAIN_LOCKED: \$\{\{ steps\.chain-lock\.outputs\.locked \}\}/u);
  const begin = queue.indexOf("# chain-lock-begin\n");
  const end = queue.indexOf("# chain-lock-end\n");
  assert.ok(begin !== -1 && end > begin);
  assert.ok(end < queue.indexOf("# queue-loop-begin"), "the lock is checked before the merge loop");
  assert.ok(begin > queue.indexOf("label_marker_ids="), "label authorization markers are still written while locked");
  const block = queue.slice(begin, end).split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
  for (const [locked, merges] of [["false", true], ["true", false], ["unknown", false], ["", false]]) {
    const result = await runBash(`${block}\necho PROCEED`, { env: { CHAIN_LOCKED: locked } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes("PROCEED"), merges, `locked=${JSON.stringify(locked)}`);
  }
});

test("체인 workflow가 끝나면 큐가 다시 깨어난다(잠금이 풀린 시점에 병합을 재판정)", () => {
  assert.match(queue, /\n  workflow_run:\n(?:    #.*\n)?    workflows: \[CI, "Data Pack Release Candidate Chain", "Data Pack Release Cross-Repository Chain"\]\n    types: \[completed\]\n/u);
  assert.match(rcChain, /^name: Data Pack Release Candidate Chain\n/u);
  assert.match(read("datapack-release-cross-repo-chain.yml"), /^name: Data Pack Release Cross-Repository Chain\n/u);
});
