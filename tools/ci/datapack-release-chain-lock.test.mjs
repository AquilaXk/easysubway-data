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
  assert.ok(rcChain.indexOf(hold) < rcChain.indexOf("      - name: Hand the release candidate run over to the release chain\n"), "the handover follows the hold");
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

// data#1158: GITHUB_TOKEN으로 dispatch한 RC는 workflow_run을 만들지 않으므로 RC chain이 RC 완료 뒤 체인을 직접 dispatch한다.
// 체인 run이 실제로 생긴 것을 확인하고 끝나야 automerge 잠금(두 workflow의 진행 중 run)이 RC에서 체인까지 끊기지 않는다.
const HANDOVER = "Hand the release candidate run over to the release chain";
const FAILURE_REPORT = "Report a release candidate handover failure";

test("RC chain은 RC가 성공하면 체인 workflow를 dispatch하고 rc_run_id로 묶인 그 run이 생긴 것을 확인한 뒤 끝난다 (data#1158)", async () => {
  const handover = stepBody(rcChain, HANDOVER);
  assert.ok(rcChain.indexOf(handover) < rcChain.indexOf(`      - name: ${FAILURE_REPORT}\n`), "the failure report follows the handover");
  assert.match(handover, /if: \$\{\{ steps\.supersede\.outputs\.current == 'true' && vars\.DATAPACK_CROSS_REPO_CHAIN_ENABLED == 'true' \}\}/u);
  assert.match(handover, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(handover, /RC_RUN_ID: \$\{\{ steps\.dispatch\.outputs\.rc_run_id \}\}/u);
  assert.doesNotMatch(runBlock(handover), /\$\{\{/u);
  // dispatch 권한과 실패 이슈 권한: actions write, issues write, contents read.
  assert.match(rcChain, /\npermissions:\n  actions: write\n  contents: read\n  issues: write\n/u);
  const script = runBlock(handover);
  // 체인 run은 시계가 아니라 이름(chain rc=<rc_run_id>)으로 찾는다.
  assert.doesNotMatch(script, /created=|dispatched_after|date -u/u);
  assert.match(script, /--arg title "chain rc=\$\{RC_RUN_ID\}"/u);

  const run = async ({ conclusion, chainRuns = [{ id: 9001, display_title: "chain rc=7001", created_at: "2026-10-11T05:00:00Z" }], runId = "7001", dispatchFails = false }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "chain-handover-"));
    try {
      const log = path.join(directory, "calls");
      const sleeps = path.join(directory, "sleeps");
      await writeFile(log, "");
      await writeFile(sleeps, "");
      await writeFile(path.join(directory, "gh"), `#!/bin/bash
echo "gh $*" >> "${log}"
case "$*" in
  "workflow run "*) ${dispatchFails ? 'echo "HTTP 422" >&2; exit 1' : "exit 0"} ;;
  *"/actions/runs/7001"*) echo "${conclusion}" ;;
  *"datapack-release-cross-repo-chain.yml/runs"*) cat <<'JSON'
${JSON.stringify({ workflow_runs: chainRuns })}
JSON
;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`);
      await writeFile(path.join(directory, "sleep"), `#!/bin/bash\necho "$1" >> "${sleeps}"\n`);
      for (const name of ["gh", "sleep"]) await chmod(path.join(directory, name), 0o755);
      const result = spawnSync("/bin/bash", ["-e", "-c", script], {
        encoding: "utf8", env: { PATH: `${directory}:${process.env.PATH}`, HOME: process.env.HOME, GITHUB_REPOSITORY: "AquilaXk/easysubway-data", RC_RUN_ID: runId },
      });
      const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean);
      const slept = (await readFile(sleeps, "utf8")).split("\n").filter(Boolean).length;
      return { ...result, calls, slept };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  const success = await run({ conclusion: "success" });
  assert.equal(success.status, 0, success.stderr);
  assert.ok(success.calls.includes("gh workflow run datapack-release-cross-repo-chain.yml --repo AquilaXk/easysubway-data --ref main -f rc_run_id=7001"));
  assert.match(success.stdout, /9001/u);
  // 다른 RC나 이름이 다른 dispatch run이 같은 시각에 있어도 확인으로 인정하지 않는다.
  const others = await run({ conclusion: "success", chainRuns: [{ id: 9100, display_title: "chain rc=7002", created_at: "2026-10-11T05:00:00Z" }, { id: 9101, display_title: "Data Pack Release Cross-Repository Chain", created_at: "2026-10-11T05:00:01Z" }] });
  assert.notEqual(others.status, 0);
  assert.match(others.stderr, /release chain run was not found/u);
  assert.equal(others.slept, 20);
  // 이름이 맞는 run이 여럿이면 가장 먼저 만들어진 것을 센다.
  const many = await run({ conclusion: "success", chainRuns: [{ id: 9300, display_title: "chain rc=7001", created_at: "2026-10-11T05:00:09Z" }, { id: 9200, display_title: "chain rc=7001", created_at: "2026-10-11T05:00:01Z" }] });
  assert.match(many.stdout, /9200/u);

  // RC가 성공이 아니면(failure·timed_out·startup_failure·cancelled·빈 값) 체인을 시작하지 않고 실패한다. 보고는 마지막 step이 맡는다.
  for (const conclusion of ["failure", "timed_out", "startup_failure", "cancelled", "skipped", ""]) {
    const stopped = await run({ conclusion });
    assert.notEqual(stopped.status, 0, conclusion);
    assert.equal(stopped.calls.some((call) => call.startsWith("gh workflow run")), false, conclusion);
    assert.match(stopped.stderr, /the release chain is not started/u, conclusion);
  }
  // dispatch 실패와 체인 run 미발견도 성공으로 넘기지 않는다.
  const dispatchFailed = await run({ conclusion: "success", dispatchFails: true });
  assert.notEqual(dispatchFailed.status, 0);
  const missing = await run({ conclusion: "success", chainRuns: [] });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /release chain run was not found/u);
  assert.equal(missing.slept, 20);
  const invalid = await run({ conclusion: "success", runId: "x" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid/u);
  assert.equal(invalid.calls.length, 0);
});

// F1: RC가 dispatch된 뒤 체인이 시작되지 못하는 모든 경우(RC 실패·timed_out·startup_failure·취소, 60분 대기 timeout, dispatch 실패, 체인 run 미발견)를
// 체인 실패 이슈(#926)로 올린다. 취소도 포함한다: 무인 원칙에서 이 RC의 발행이 시작되지 못했다는 사실은 사람이 알아야 하는 상태이고, 다음 후보가 올 때까지
// 아무도 알아채지 못하기 때문이다(사람이 일부러 취소했다면 이슈를 닫으면 된다).
test("RC chain은 RC dispatch 뒤 체인이 시작되지 못한 모든 실패를 체인 실패 이슈로 올린다 (data#1158 F1)", async () => {
  const report = stepBody(rcChain, FAILURE_REPORT);
  assert.ok(rcChain.trimEnd().endsWith(report.trimEnd()), "the failure report is the last step");
  // failure()만으로는 RC를 dispatch하지 못한 경우(main 이동 등 정상 경쟁)까지 올리므로 dispatch가 성공한 뒤의 실패로 한정한다.
  assert.match(report, /if: \$\{\{ failure\(\) && steps\.dispatch\.outcome == 'success' && vars\.DATAPACK_CROSS_REPO_CHAIN_ENABLED == 'true' \}\}/u);
  assert.match(report, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(report, /RC_RUN_ID: \$\{\{ steps\.dispatch\.outputs\.rc_run_id \}\}/u);
  const script = runBlock(report);
  assert.doesNotMatch(script, /\$\{\{/u);
  const directory = await mkdtemp(path.join(os.tmpdir(), "chain-report-"));
  try {
    const log = path.join(directory, "calls");
    await writeFile(log, "");
    await writeFile(path.join(directory, "node"), `#!/bin/bash\necho "node $*" >> "${log}"\n`);
    await chmod(path.join(directory, "node"), 0o755);
    const run = (env) => spawnSync("/bin/bash", ["-e", "-c", script], { encoding: "utf8", env: { PATH: `${directory}:${process.env.PATH}`, HOME: process.env.HOME, GITHUB_REPOSITORY: "AquilaXk/easysubway-data", GITHUB_RUN_ID: "8800", ...env } });
    const ok = run({ RC_RUN_ID: "7001" });
    assert.equal(ok.status, 0, ok.stderr);
    // 실패한 RC run과 이 RC chain run을 모두 기록한다(RC 실패는 RC run, 대기 timeout·dispatch 실패는 RC chain run에 원인이 있다).
    assert.deepEqual((await readFile(log, "utf8")).split("\n").filter(Boolean), [
      "node tools/ci/report-refresh-failure.mjs --workflow datapack-release-cross-repo-chain.yml --repository AquilaXk/easysubway-data --run-id 7001",
      "node tools/ci/report-refresh-failure.mjs --workflow datapack-release-cross-repo-chain.yml --repository AquilaXk/easysubway-data --run-id 8800",
    ]);
    const invalid = run({ RC_RUN_ID: "x" });
    assert.notEqual(invalid.status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
