import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = ".github/workflows/ci.yml";
const ownership = JSON.parse(
  readFileSync(path.join(root, "tools/ci/data-test-ownership.json"), "utf8"),
);
const mobileRepository = "AquilaXk/easysubway-mobile";
// #979: fixture 커밋은 ITX topology 적용 전 입력 팩을 담고, 출력 팩은 staging 뒤 커밋된 증거에서 파생한다.
const ciMobileRevision = "573aefdbbf2e639d28de18697eb449da85415353";
const ciCapitalGzipSha256 = "609a74095859b5bf7602c25e142caa47cc212170a72d6240e2d01b39f874047a";
const releaseMobileRevision = "573aefdbbf2e639d28de18697eb449da85415353";
const releaseCapitalGzipSha256 = "609a74095859b5bf7602c25e142caa47cc212170a72d6240e2d01b39f874047a";
const releaseIndexSha256 = "a39031e0e588508b1d111c830ef19441740ca15de6cad62ef9e9e8f5654468bf";
const releaseSourceInventorySha256 = "69cdbd88a169d77ef4941d197c5bae5a0ab26999418ce513778903abbe7d70d2";

function namedWorkflowStep(yml, name) {
  const marker = `      - name: ${name}\n`;
  const start = yml.indexOf(marker);
  assert.notEqual(start, -1, `${name} step을 찾지 못함`);
  const next = yml.indexOf("\n      - name:", start + marker.length);
  return yml.slice(start, next === -1 ? yml.length : next);
}

function namedJob(yml, id) {
  const marker = `  ${id}:\n`;
  const start = yml.indexOf(marker);
  assert.notEqual(start, -1, `${id} job을 찾지 못함`);
  const remainder = yml.slice(start + marker.length);
  const next = remainder.match(/\n  [a-z][\w_]*:\n/);
  return yml.slice(start, next == null ? yml.length : start + marker.length + next.index);
}

function assertRequiredOwned(paths) {
  for (const expectedPath of paths) {
    const entry = ownership.tests.find(({ path: testPath }) => testPath === expectedPath);
    assert.ok(entry, `${expectedPath} ownership entry를 찾지 못함`);
    assert.ok(entry.classes.includes("required-pr"), `${expectedPath} required-pr class가 필요함`);
  }
}

function assertWorkflowStepOrder(yml, names) {
  const positions = names.map((name) => {
    const position = yml.indexOf(name);
    assert.ok(position >= 0, `${name} 단계를 찾지 못함`);
    return position;
  });
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(
      positions[index - 1] < positions[index],
      `${names[index - 1]}는 ${names[index]}보다 앞서야 함`,
    );
  }
}

function fixtureStep(workflow) {
  const yml = readFileSync(path.join(root, workflow), "utf8");
  const block = yml.match(/- name: [^\n]*Checkout pinned Mobile fixture[\s\S]*?\n\s+- name:/)?.[0];
  const stage = yml.match(/- name: [^\n]*Stage pinned Mobile fixture[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(block, `${workflow}: pinned Mobile fixture checkout block을 찾지 못함`);
  assert.ok(stage, `${workflow}: pinned Mobile fixture stage step을 찾지 못함`);
  return { yml, block, stage };
}

{
  test(`${workflow}: pinned Mobile fixture는 immutable checkout을 credentials 없이 수행한다`, () => {
    const { yml, block, stage } = fixtureStep(workflow);
    assert.match(block, new RegExp(`repository:\\s*${mobileRepository}`));
    assert.match(block, /ref:\s*data-fixture\/itx-979\n/); // 커밋 고정은 아래 stage의 rev-parse가, 커밋이 사라지지 않게 붙드는 것은 태그가 맡는다(#980 F6)
    assert.match(block, /path:\s*\.external\/mobile/);
    assert.match(block, /persist-credentials:\s*false/);
    assert.match(block, /fetch-depth:\s*0/);
    assert.match(stage, /git -C \.external\/mobile rev-parse HEAD/);
    assert.match(stage, new RegExp(ciMobileRevision));
    assert.ok(
      yml.indexOf("Checkout repository") < yml.indexOf("Checkout pinned Mobile fixture")
        && yml.indexOf("Checkout pinned Mobile fixture") < yml.indexOf("Stage pinned Mobile fixture"),
      `${workflow}: fixture checkout은 Data checkout 뒤여야 함`,
    );
  });

  test(`${workflow}: pinned Mobile fixture는 validation 완료 뒤에만 빈 destination으로 stage한다`, () => {
    const { stage } = fixtureStep(workflow);
    assert.match(stage, /\.external\/mobile\/apps\/mobile/);
    assert.match(stage, /-d "\$\{source\}"/);
    assert.match(stage, /-L "\$\{source\}"/);
    assert.match(stage, /find "\$\{source\}" -type l/);
    assert.match(stage, /assets\/datapacks\/capital\.sqlite\.gz/);
    assert.match(stage, /-f "\$\{capital_gzip\}"/);
    assert.match(stage, /-L "\$\{capital_gzip\}"/);
    assert.match(stage, new RegExp(ciCapitalGzipSha256));
    assert.match(stage, /test ! -e apps\/mobile/);
    assert.match(stage, /test ! -L apps\/mobile/);
    assert.match(stage, /\[\[ "\$\{actual_sha256\}" == "\$\{expected_sha256\}" \]\]/);
    assert.match(stage, /if \[\[ -e apps \|\| -L apps \]\]; then/);
    assert.match(stage, /\[\[ -d apps && ! -L apps \]\]/);
    assert.match(stage, /else\s+mkdir apps\s+fi/);
    assert.match(stage, /cp -a "\$\{source\}" apps\/mobile/);
    assert.ok(
      stage.indexOf('[[ "${actual_sha256}" == "${expected_sha256}" ]]') < stage.indexOf("cp -a "),
      `${workflow}: digest 검증은 destination stage보다 앞서야 함`,
    );
    assert.ok(
      stage.indexOf("mkdir apps") < stage.indexOf("cp -a "),
      `${workflow}: 검증된 parent 생성은 fixture stage보다 앞서야 함`,
    );
  });
}

test("CI는 pinned Mobile fixture workflow 계약을 owned required runner에서 실행한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /node tools\/ci\/data-test-discovery\.mjs run --class required-pr/);
  assertRequiredOwned(["tools/ci/mobile-fixture-staging-workflow.test.mjs"]);
});

test("Data contracts discovery는 current Mobile v19 fixture identity만 요구한다", () => {
  const requiredOwnership = ownership.workflows["required-pr"];
  const fixture = ownership.fixtures.mobile;
  assert.deepEqual(requiredOwnership.fixtureProfiles, { mobile: "mobile-v19" });
  assert.equal(fixture.profileCommit["mobile-v19"], ciMobileRevision);
  assert.equal(
    fixture.requiredFiles.find(({ path: file }) => file === "assets/datapacks/capital.sqlite.gz")
      .profileSha256["mobile-v19"],
    ciCapitalGzipSha256,
  );
  assert.deepEqual(requiredOwnership.fixtureStageContracts.mobile, [
    'source=".external/mobile/apps/mobile"',
    `expected_revision="${ciMobileRevision}"`,
    `expected_sha256="${ciCapitalGzipSha256}"`,
    "fetch-depth: 0",
    'cp -a "${source}" apps/mobile',
  ]);
});

test("CI는 TRANSFER topology admission과 current source revalidation contract를 owned required runner에서 실행한다", () => {
  assertRequiredOwned([
    "tools/datapack/build-transfer-topology-admission.test.mjs",
    "tools/datapack/revalidate-current-molit-transfer-source.test.mjs",
    "tools/datapack/build-current-transfer-source-admission.test.mjs",
  ]);
});

test("CI는 EXIT path admission contract를 owned required runner에서 실행한다", () => {
  assertRequiredOwned([
    "tools/datapack/plan-kric-exit-path-collection.test.mjs",
    "tools/datapack/build-current-kric-exit-collection-plan.test.mjs",
    "tools/datapack/collect-kric-exit-path-provider-snapshot.test.mjs",
    "tools/datapack/build-exit-path-admission.test.mjs",
  ]);
});

test("CI는 current source-separated topology contracts를 owned required runner에서 실행한다", () => {
  assertRequiredOwned([
    "tools/datapack/collect-capital-route-topology.test.mjs",
    "tools/datapack/collect-incheon-station-info.test.mjs",
    "tools/datapack/activate-current-source-set.test.mjs",
    "tools/datapack/build-datapack-current-admission.test.mjs",
  ]);
});

test("CI는 병합된 current v19 pack을 ITX current evidence와 직접 검증한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const verification = ci.match(/- name: Verify current Mobile v19 ITX topology evidence[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(verification, "current v19 ITX topology evidence 검증 스텝을 찾지 못함");
  assert.match(verification, /node --test tools\/datapack\/verify-production-pack-artifact-identity\.test\.mjs/);
  assert.match(verification, /node --test --test-name-pattern='bundled 공식 OD quote\|bundled 차량·출입문 힌트' tools\/datapack\/datapack-tools\.test\.mjs/);
  assert.match(verification, /git diff --exit-code -- tools\/datapack\/itx-cheongchun-topology-evidence\.json/);
  assert.ok(
    ci.indexOf("Stage pinned Mobile fixture") < ci.indexOf("Verify current Mobile v19 ITX topology evidence"),
    "current v19 evidence는 immutable fixture stage 뒤에 검증해야 함",
  );
});

test("CI는 current v19 contract 검증 뒤 fixture identity가 변경되지 않았음을 다시 확인한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const reverify = namedWorkflowStep(ci, "Re-verify current Mobile fixture for owned tests");
  assert.match(reverify, new RegExp(ciMobileRevision));
  assert.match(reverify, new RegExp(ciCapitalGzipSha256));
  assert.match(reverify, /git -C \.external\/mobile rev-parse HEAD/);
  assert.match(reverify, /sha256sum "\$\{target_capital_gzip\}"/);
  const evidenceIndex = ci.indexOf("Verify current Mobile v19 ITX topology evidence");
  const ownedTestsIndex = ci.indexOf("Verify and run current Mobile v19 owned required tests");
  const reverifyIndex = ci.indexOf("Re-verify current Mobile fixture for owned tests");
  assert.ok(
    evidenceIndex < ownedTestsIndex,
    "current artifact 검증은 v19 소유 테스트보다 앞서야 함",
  );
  assert.ok(
    ownedTestsIndex < reverifyIndex,
    "fixture identity 재확인은 v19 소유 테스트 뒤에 실행해야 함",
  );
});

test("CI는 migration 없이 current v19 profile 소유 테스트를 실행한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const runner = namedWorkflowStep(ci, "Verify and run current Mobile v19 owned required tests");
  // #934: 러너(16GB)에서 병렬 4는 node 합계 RSS가 12~13.5GB까지 올라 OOM 종료(exit 143)가 반복됐다. 병렬도만 2로 낮춘다.
  assert.match(runner, /node tools\/ci\/data-test-discovery\.mjs run --class required-pr --profile mobile-v19 --max-workers 2/);
  assert.deepEqual(ownership.workflows["required-pr"].profileInvocations,
    ["node tools/ci/data-test-discovery.mjs run --class required-pr --profile mobile-v19 --max-workers 2"]);
  // 실행 중 메모리 사용을 같은 step 로그에 남긴다(러너가 종료돼도 직전 관측이 남도록 주기 출력).
  assert.match(runner, /free -m/);
  assert.match(runner, /mobile-v19 memory/);
  assert.doesNotMatch(runner, /continue-on-error|^\s*if:/m);
  // 관측 루프가 테스트 실패를 가리면 안 된다: 첫 줄 fail-fast, EXIT trap이 관측 루프를 끄고,
  // node 실행 줄은 종료 코드를 바꾸는 꼬리(`|| true`, `|| :`, `;` 등) 없이 그 줄로 끝난다.
  assert.match(runner, /\n        run: \|\n          set -euo pipefail\n/);
  assert.match(runner, /^          trap '[^'\n]*\bkill "\$\{monitor\}"[^'\n]*' EXIT$/m);
  assert.match(
    runner,
    /^          node tools\/ci\/data-test-discovery\.mjs run --class required-pr --profile mobile-v19 --max-workers 2$/m,
  );
  assertWorkflowStepOrder(ci, [
    "Verify current Mobile v19 ITX topology evidence",
    "Verify and run current Mobile v19 owned required tests",
    "Re-verify current Mobile fixture for owned tests",
  ]);
});

const mobileV19Invocation =
  "node tools/ci/data-test-discovery.mjs run --class required-pr --profile mobile-v19 --max-workers 2";

function mobileV19RunScript() {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const step = namedWorkflowStep(ci, "Verify and run current Mobile v19 owned required tests");
  const body = step.split("\n        run: |\n")[1];
  assert.ok(body, "mobile-v19 runner step의 run 블록을 찾지 못함");
  return body
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

// 관측 step을 실제 bash로 돌린다. free는 러너 출력 형식의 stub, node 실행은 대역 명령으로 바꾼다.
// 새 프로세스 그룹에서 실행해, 끝난 뒤 그 그룹에 남은 프로세스(관측 루프·sleep)가 없는지 본다.
async function runMobileV19Step(replacement) {
  const script = mobileV19RunScript();
  assert.equal(script.split(mobileV19Invocation).length, 2, "node 실행 줄은 정확히 한 번 있어야 함");
  const stubbed = `free() { echo "Mem: 15989 1329 11224"; }\n${script.replace(mobileV19Invocation, replacement)}`;
  const child = spawn("bash", ["-c", stubbed], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const [code] = await once(child, "exit");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const leftovers = execFileSync("ps", ["-axo", "pgid=,pid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([pgid, pid]) => Number(pgid) === child.pid && Number(pid) !== child.pid)
    .map((fields) => fields.slice(2).join(" "));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // 남은 프로세스가 없으면 그룹이 이미 사라졌다.
  }
  return { code, stdout, leftovers };
}

test("mobile-v19 관측 step은 node 종료 코드를 그대로 내고 관측 프로세스를 남기지 않는다", async () => {
  const failing = await runMobileV19Step("sleep 1; (exit 7)");
  assert.equal(failing.code, 7, "node 실패 종료 코드가 관측 루프·trap에 가려지면 안 됨");
  assert.deepEqual(failing.leftovers, [], "step이 끝난 뒤 관측 루프나 그 sleep 자식이 남으면 안 됨");
  assert.match(failing.stdout, /^mobile-v19 memory used=1329MB sampled peak=1329MB$/m);

  const passing = await runMobileV19Step("sleep 1");
  assert.equal(passing.code, 0);
  assert.deepEqual(passing.leftovers, []);
});

test("CI는 direct current v19 검증 안에서 deployed verifier 회귀를 실행한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const verification = namedWorkflowStep(ci, "Verify current Mobile v19 ITX topology evidence");
  assert.match(verification, /set -euo pipefail/);
  assert.match(verification, /node --test tools\/datapack\/verify-production-pack-artifact-identity\.test\.mjs/);
  assert.match(verification, /node --test --test-name-pattern='bundled 공식 OD quote\|bundled 차량·출입문 힌트' tools\/datapack\/datapack-tools\.test\.mjs/);
  assertWorkflowStepOrder(ci, ["Stage pinned Mobile fixture", "Verify current Mobile v19 ITX topology evidence"]);
});

test("CI는 구형 v18 migration 또는 station-catalog bootstrap을 실행하지 않는다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(ci, /Migrate pinned Mobile v18 pack to v19/);
  assert.doesNotMatch(ci, /--migrate-current-v18/);
  assert.doesNotMatch(ci, /Emit pinned Mobile station catalog artifact/);
  assert.doesNotMatch(ci, /emit-station-catalog-from-bundled-pack\.mjs/);
});

const shardIds = ["contracts_shard_1", "contracts_shard_2", "contracts_shard_3", "contracts_shard_4"];
const contractJobIds = ["contracts_mobile_v19", ...shardIds];

function assertPinnedFixtureJob(job, timeoutMinutes = 30) {
  assert.match(job, new RegExp(`^    timeout-minutes: ${timeoutMinutes}$`, "m"));
  assert.doesNotMatch(job, /\n    needs:/);
  const repository = namedWorkflowStep(job, "Checkout repository");
  const fixture = namedWorkflowStep(job, "Checkout pinned Mobile fixture");
  const stage = namedWorkflowStep(job, "Stage pinned Mobile fixture");
  const node = namedWorkflowStep(job, "Set up Node.js");
  assert.match(repository, /uses:\s*actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(repository, /ref:\s*\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(repository, /persist-credentials:\s*false/);
  assert.match(fixture, new RegExp(`repository:\\s*${mobileRepository}`));
  assert.match(fixture, /ref:\s*data-fixture\/itx-979\n/);
  assert.match(fixture, /path:\s*\.external\/mobile/);
  assert.match(fixture, /persist-credentials:\s*false/);
  assert.match(fixture, /fetch-depth:\s*0/);
  assert.match(stage, new RegExp(ciMobileRevision));
  assert.match(stage, new RegExp(ciCapitalGzipSha256));
  assert.match(stage, /\[\[ -d "\$\{source\}" && ! -L "\$\{source\}" \]\]/);
  assert.match(stage, /\[\[ -f "\$\{capital_gzip\}" && ! -L "\$\{capital_gzip\}" \]\]/);
  assert.match(stage, /test ! -e apps\/mobile/);
  assert.match(stage, /test ! -L apps\/mobile/);
  assert.match(stage, /cp -a "\$\{source\}" apps\/mobile/);
  assert.ok(
    stage.indexOf('[[ "${actual_sha256}" == "${expected_sha256}" ]]') < stage.indexOf("cp -a "),
    "각 job은 fixture 검증 뒤에만 stage해야 함",
  );
  assert.match(node, /uses:\s*actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(node, /node-version:\s*"24\.19\.0"/);
}

test("CI는 browser-dependent required tests 전에 pinned Chrome runtime을 제공한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const contracts = namedJob(ci, "contracts");
  for (const [index, id] of shardIds.entries()) {
    const shard = index + 1;
    const job = namedJob(ci, id);
    const runnerName = `Verify and run pristine Mobile owned required tests (shard ${shard}/4)`;
    assert.match(job, new RegExp(`^    name: Data contracts \\(shard ${shard}\\/4\\)$`, "m"));
    assertPinnedFixtureJob(job);
    const setup = namedWorkflowStep(job, "Set up Chrome for browser-dependent required tests");
    const runner = namedWorkflowStep(job, runnerName);
    assert.match(setup, /id:\s*setup-chrome/);
    assert.match(
      setup,
      /uses:\s*browser-actions\/setup-chrome@086160e580d6e8c142ad5ba29009dcde677c6321/,
    );
    assert.match(setup, /chrome-version:\s*"152\.0\.7977\.54"/);
    assert.match(setup, /install-dependencies:\s*true/);
    assert.match(runner, /CHROME_PATH:\s*\$\{\{ steps\.setup-chrome\.outputs\.chrome-path \}\}/);
    assert.match(runner, /ROUTE_MAP_CHROME_NO_SANDBOX:\s*"1"/);
    assert.match(runner, new RegExp(`--default-profile --max-workers 4 --shard-count 4 --shard-index ${shard}$`, "m"));
    assert.ok(
      job.indexOf("Set up Chrome for browser-dependent required tests") < job.indexOf(runnerName),
      "각 shard job은 자체 Chrome setup 뒤에 runner를 실행해야 함",
    );
  }
  // mobile-v19 profile도 pinned fixture를 stage한 독립 job이다.
  const mobile = namedJob(ci, "contracts_mobile_v19");
  assert.match(mobile, /^    name: Data contracts \(mobile-v19\)$/m);
  // #934: 병렬 2로 낮춘 실측(로컬 4→2 실행시간 1.26배, CI 4-worker 최대 18m51s)에 여유를 둔 40분이다.
  assertPinnedFixtureJob(mobile, 40);
  // #866 PR-C: 수도권 live chain 전용 job은 없다. 집계 job의 needs는 실제 Data contracts 하위 job 전체와 정확히 같다.
  const jobIds = [...ci.matchAll(/^  ([a-z0-9_]+):$/gmu)].map(([, id]) => id);
  assert.deepEqual(jobIds.filter((id) => id.startsWith("contracts_")).sort(), [...contractJobIds].sort());
  assert.ok(jobIds.includes("contracts"), "aggregate Data contracts job is required");
  // required check는 집계 job 이름 "Data contracts" 하나이고 모든 job 성공을 요구한다.
  assert.match(contracts, /^    name: Data contracts$/m);
  assert.match(contracts, new RegExp(`needs:\\s*\\[${contractJobIds.join(", ")}\\]`));
  assert.match(contracts, /if:\s*\$\{\{ always\(\) \}\}/);
  for (const [variable, id] of [
    ["MOBILE_V19_RESULT", "contracts_mobile_v19"],
    ...shardIds.map((id, index) => [`SHARD_${index + 1}_RESULT`, id]),
  ]) {
    assert.match(contracts, new RegExp(`${variable}:\\s*\\$\\{\\{ needs\\.${id}\\.result \\}\\}`));
    assert.ok(contracts.includes(`[[ "\${${variable}}" == "success" ]]`), `${variable} must be required`);
  }
  // 집계 step은 needs에 있는 job 결과만 읽고, 모두 success여야 한다(빠지거나 남는 결과 변수가 없다).
  assert.equal([...contracts.matchAll(/_RESULT: \$\{\{ needs\.([a-z0-9_]+)\.result \}\}/gu)].length, contractJobIds.length);
  assert.equal([...contracts.matchAll(/== "success" \]\]/gu)].length, contractJobIds.length);
});

test("CI는 PR 실행만 새 head에서 취소하고 main push·dispatch는 취소하지 않는다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(
    ci,
    /^concurrency:\n  group: ci-\$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| github\.run_id \}\}\n  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m,
  );
});

test("CI는 Data contracts 각 job에만 최소 contents read 권한을 둔다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(ci, /^permissions:/m);
  for (const id of [...contractJobIds, "contracts"]) {
    assert.match(namedJob(ci, id), /^    permissions:\n      contents: read$/m);
  }
});

test("CI는 current v19 검증을 tracked topology evidence 변경 없이 수행한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const verification = namedWorkflowStep(ci, "Verify current Mobile v19 ITX topology evidence");
  assert.match(verification, /git diff --exit-code -- tools\/datapack\/itx-cheongchun-topology-evidence\.json/);
  assert.doesNotMatch(ci, /Backup tracked topology evidence/);
  assert.doesNotMatch(ci, /Restore tracked topology evidence/);
  assertWorkflowStepOrder(ci, [
    "Verify current Mobile v19 ITX topology evidence",
    "Verify and run current Mobile v19 owned required tests",
    "Re-verify current Mobile fixture for owned tests",
    "Verify and run pristine Mobile owned required tests",
  ]);
});

test("CI는 direct current v19 fixture를 owned runner 전에 재검증한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const reverify = namedWorkflowStep(ci, "Re-verify current Mobile fixture for owned tests");
  assert.match(reverify, /source="\.external\/mobile\/apps\/mobile"/);
  assert.match(reverify, /target="apps\/mobile"/);
  assert.match(reverify, new RegExp(ciMobileRevision));
  assert.match(reverify, new RegExp(ciCapitalGzipSha256));
  assert.match(reverify, /sha256sum "\$\{target_capital_gzip\}"/);
  assert.doesNotMatch(reverify, /rm -r/);
  assert.doesNotMatch(reverify, /cp -a/);
});

test("Data Pack Release는 deterministic-release 전에 immutable Mobile fixture를 검증하고 stage한다", () => {
  const releaseWorkflow = ".github/workflows/datapack-release.yml";
  const { yml, block, stage } = fixtureStep(releaseWorkflow);
  const releaseOwnership = ownership.workflows["deterministic-release"];
  const runner = namedWorkflowStep(yml, "Data Pack Release / Validate ITX-청춘 coverage contract");
  const releaseGate = "if: ${{ steps.release-mode.outputs.is-pointer-only != 'true' && steps.release-mode.outputs.mode != 'production-publish' && steps.release-mode.outputs.mode != 'candidate-create' }}";

  assert.match(block, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(block, new RegExp(`repository:\\s*${mobileRepository}`));
  assert.match(block, /ref:\s*data-fixture\/itx-979\n/);
  assert.match(block, /path:\s*\.external\/mobile/);
  assert.match(block, /persist-credentials:\s*false/);
  assert.match(block, /fetch-depth:\s*0/);
  assert.match(stage, /git -C \.external\/mobile rev-parse HEAD/);
  assert.match(stage, /find "\$\{source\}" -type l/);
  assert.match(stage, /assets\/datapacks\/capital\.sqlite\.gz/);
  assert.match(stage, /assets\/datapacks\/index\.json/);
  assert.match(stage, /assets\/datapacks\/source-inventory\.json/);
  assert.match(
    stage,
    /for required_file in "\$\{capital_gzip\}" "\$\{index\}" "\$\{source_inventory\}"; do/,
  );
  assert.match(stage, /\[\[ -f "\$\{required_file\}" && ! -L "\$\{required_file\}" \]\]/);
  assert.match(stage, new RegExp(releaseCapitalGzipSha256));
  assert.match(stage, new RegExp(releaseIndexSha256));
  assert.match(stage, new RegExp(releaseSourceInventorySha256));
  const comparisons = [
    '[[ "${actual_revision}" == "${expected_revision}" ]]',
    '[[ "${actual_capital_gzip_sha256}" == "${expected_capital_gzip_sha256}" ]]',
    '[[ "${actual_index_sha256}" == "${expected_index_sha256}" ]]',
    '[[ "${actual_source_inventory_sha256}" == "${expected_source_inventory_sha256}" ]]',
  ];
  for (const comparison of comparisons) {
    assert.ok(stage.includes(comparison), `release stage에 ${comparison} 검증이 필요함`);
    assert.ok(
      stage.indexOf(comparison) < stage.indexOf('cp -a "${source}" apps/mobile'),
      `${comparison} 검증은 destination stage보다 앞서야 함`,
    );
  }
  assert.match(stage, /test ! -e apps\/mobile/);
  assert.match(stage, /test ! -L apps\/mobile/);
  assert.match(stage, /\[\[ -d apps && ! -L apps \]\]/);
  assert.match(stage, /cp -a "\$\{source\}" apps\/mobile/);
  assert.ok(
    yml.indexOf("Checkout pinned Mobile fixture") < yml.indexOf("Stage pinned Mobile fixture")
      && yml.indexOf("Stage pinned Mobile fixture") < yml.indexOf("Validate ITX-청춘 coverage contract"),
    "release fixture는 deterministic-release 전에 stage되어야 함",
  );
  for (const step of [block, stage, runner]) {
    assert.ok(step.includes(releaseGate), `release fixture와 runner는 동일한 gate가 필요함: ${releaseGate}`);
  }
  assert.deepEqual(releaseOwnership.fixtures, ["mobile"]);
  assert.deepEqual(releaseOwnership.fixtureProfiles, { mobile: "mobile-v19" });
  assert.deepEqual(releaseOwnership.fixtureStageContracts.mobile, [
    'source=".external/mobile/apps/mobile"',
    `expected_revision="${releaseMobileRevision}"`,
    `expected_capital_gzip_sha256="${releaseCapitalGzipSha256}"`,
    `expected_index_sha256="${releaseIndexSha256}"`,
    `expected_source_inventory_sha256="${releaseSourceInventorySha256}"`,
    "fetch-depth: 0",
    'cp -a "${source}" apps/mobile',
  ]);
});

test("#942 required CI 테스트 job은 후보 고정 입력 공개 읽기 경로를 기존 vars.OCI_SERVER_ROUTE_PUBLIC_BASE_URL에서 받고, 값이 없으면 테스트 전에 실패한다", () => {
  const yml = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  for (const id of ["contracts_mobile_v19", "contracts_shard_1", "contracts_shard_2", "contracts_shard_3", "contracts_shard_4"]) {
    const job = namedJob(yml, id);
    // 공개 데이터팩 base URL은 서버 경로 번들과 같은 버킷 공개 읽기 경로라 기존 저장소 변수를 함께 쓴다(새 설정 없음).
    assert.match(job, /\n    env:\n(?:      #[^\n]*\n)*      EASYSUBWAY_DATA_PACK_BASE_URL: \$\{\{ vars\.OCI_SERVER_ROUTE_PUBLIC_BASE_URL \}\}\n/u, id);
    assert.doesNotMatch(job, /EASYSUBWAY_DATA_PACK_BASE_URL: \$\{\{ secrets\./u, id);
    const guard = namedWorkflowStep(job, "Require public candidate input base URL");
    assert.match(guard, /\[\[ "\$\{EASYSUBWAY_DATA_PACK_BASE_URL:-\}" =~ \^https:\/\/\[\^\[:space:\]\]\+\$ \]\] \|\| \{ [^}]*exit 1; \}/u, id);
    assert.ok(job.indexOf("Require public candidate input base URL") < job.indexOf("data-test-discovery.mjs run --class required-pr"), id);
  }
});

// #979: ITX-청춘 승격마다 mobile 커밋·workflow pin을 바꾸지 않는다. fixture는 ITX topology 적용 전 입력 팩으로 고정하고,
// staging 뒤 커밋된 승인 원천에서 같은 팩을 파생해 커밋된 증거와 대조한다.
test("모든 Data contracts job은 Node 설정 뒤 fixture 검증 전에 ITX topology를 입력 팩에서 파생한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  for (const id of contractJobIds) {
    const job = namedJob(ci, id);
    const derive = namedWorkflowStep(job, "Derive ITX-청춘 topology into the staged Mobile fixture");
    assert.match(derive, /\n        run: \|\n          set -euo pipefail\n/);
    assert.match(derive, /^          node tools\/datapack\/apply-itx-topology-to-bundled-pack\.mjs --derive-fixture apps\/mobile$/m);
    assert.doesNotMatch(derive, /continue-on-error|\|\| true/);
    assertWorkflowStepOrder(job, [
      "Stage pinned Mobile fixture",
      "Set up Node.js",
      "Derive ITX-청춘 topology into the staged Mobile fixture",
      "Require public candidate input base URL",
    ]);
  }
  const mobile = namedJob(ci, "contracts_mobile_v19");
  assertWorkflowStepOrder(mobile, [
    "Derive ITX-청춘 topology into the staged Mobile fixture",
    "Verify current Mobile v19 ITX topology evidence",
    "Verify and run current Mobile v19 owned required tests",
    "Re-verify current Mobile fixture for owned tests",
  ]);
});

test("파생된 팩의 기대 sha256은 workflow가 아니라 커밋된 증거가 정한다(승격마다 workflow를 고치지 않는다)", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const reverify = namedWorkflowStep(ci, "Re-verify current Mobile fixture for owned tests");
  assert.match(reverify, /expected_target_sha256="\$\(node -p "JSON\.parse\(require\('node:fs'\)\.readFileSync\('tools\/datapack\/itx-cheongchun-topology-evidence\.json', 'utf8'\)\)\.pack\.outputSha256"\)"/);
  assert.match(reverify, /\[\[ "\$\{target_sha256\}" == "\$\{expected_target_sha256\}" \]\]/);
  assert.match(reverify, /\[\[ "\$\{source_sha256\}" == "\$\{expected_sha256\}" \]\]/);
  const evidence = JSON.parse(readFileSync(path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json"), "utf8"));
  // workflow·manifest·테스트 어디에도 파생 출력 팩 sha256 literal이 없다.
  for (const file of [".github/workflows/ci.yml", ".github/workflows/datapack-release.yml", "tools/ci/data-test-ownership.json", "tools/ci/mobile-fixture-staging-workflow.test.mjs", "tools/ci/stage-local-mobile-fixture.mjs"]) {
    assert.equal(readFileSync(path.join(root, file), "utf8").includes(evidence.pack.outputSha256), false, `${file} must not pin the derived output pack`);
  }
  // 입력 pin은 coverage contract의 입력 팩 식별과 mobile fixture 입력 sha가 같아야 한다.
  const contract = JSON.parse(readFileSync(path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  assert.equal(contract.officialEvidence.korailCompletenessAdmission.topologyInputPackIdentity.sha256, ciCapitalGzipSha256);
  assert.equal(evidence.pack.inputSha256, ciCapitalGzipSha256);
  const fixture = ownership.fixtures.mobile.requiredFiles.find(({ path: file }) => file === "assets/datapacks/capital.sqlite.gz");
  assert.deepEqual(fixture.derivedProfileSha256, {
    "mobile-v19": { jsonPath: "tools/datapack/itx-cheongchun-topology-evidence.json", pointer: ["pack", "outputSha256"] },
  });
});

test("Data Pack Release도 deterministic-release 전에 같은 방식으로 파생하고 CI와 같은 Node 런타임을 쓴다", () => {
  const release = readFileSync(path.join(root, ".github/workflows/datapack-release.yml"), "utf8");
  const derive = namedWorkflowStep(release, "Data Pack Release / Derive ITX-청춘 topology into the staged Mobile fixture");
  assert.match(derive, /^          node tools\/datapack\/apply-itx-topology-to-bundled-pack\.mjs --derive-fixture apps\/mobile$/m);
  assert.ok(derive.includes("if: ${{ steps.release-mode.outputs.is-pointer-only != 'true' && steps.release-mode.outputs.mode != 'production-publish' && steps.release-mode.outputs.mode != 'candidate-create' }}"));
  assertWorkflowStepOrder(release, [
    "Data Pack Release / Stage pinned Mobile fixture",
    "Data Pack Release / Derive ITX-청춘 topology into the staged Mobile fixture",
    "Data Pack Release / Validate ITX-청춘 coverage contract",
  ]);
  const node = namedWorkflowStep(release, "Data Pack Release / Set up Node.js");
  assert.match(node, /node-version: "24\.19\.0"/);
});

// #980 F6: 고정 fixture 커밋은 mobile 레포의 태그가 붙들고 있다. 태그가 지워지거나 옮겨지면 모든 required job의 checkout이 불투명하게 실패하므로,
// checkout 전에 태그가 기대 커밋을 가리키는지 먼저 확인해 원인을 드러낸다. 보호 규칙 대신 CI가 존재를 검사한다.
const fixtureTag = "data-fixture/itx-979";
const verifyRefStep = "Verify pinned Mobile fixture ref exists";

function assertFixtureRefGuard(yml, { verifyName, checkoutName, where }) {
  const verify = namedWorkflowStep(yml, verifyName);
  assert.match(verify, new RegExp(`git ls-remote https://github\\.com/${mobileRepository}\\.git 'refs/tags/${fixtureTag}\\^\\{\\}'`), `${where}: peeled tag를 조회해야 함`);
  assert.ok(verify.includes(`"${ciMobileRevision}"`), `${where}: 기대 커밋`);
  assert.match(verify, /do not delete or move this tag/u);
  assert.match(verify, /set -euo pipefail/u);
  const checkout = namedWorkflowStep(yml, checkoutName);
  assert.match(checkout, new RegExp(`ref:\\s*${fixtureTag}\\n`, "u"), `${where}: checkout은 태그 ref를 쓴다`);
  assert.ok(yml.indexOf(`- name: ${verifyName}`) < yml.indexOf(`- name: ${checkoutName}`), `${where}: 존재 검사는 checkout보다 앞서야 함`);
}

test("모든 Data contracts job은 fixture checkout 전에 고정 태그의 존재와 커밋을 검사하고 태그 ref로 checkout한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  for (const id of contractJobIds) {
    assertFixtureRefGuard(namedJob(ci, id), { verifyName: verifyRefStep, checkoutName: "Checkout pinned Mobile fixture", where: id });
  }
});

test("Data Pack Release와 ITX 승격 workflow도 같은 태그 존재 검사를 checkout 앞에 둔다", () => {
  const release = readFileSync(path.join(root, ".github/workflows/datapack-release.yml"), "utf8");
  assertFixtureRefGuard(release, { verifyName: `Data Pack Release / ${verifyRefStep}`, checkoutName: "Data Pack Release / Checkout pinned Mobile fixture", where: "datapack-release" });
  const releaseVerify = namedWorkflowStep(release, `Data Pack Release / ${verifyRefStep}`);
  assert.ok(releaseVerify.includes("if: ${{ steps.release-mode.outputs.is-pointer-only != 'true' && steps.release-mode.outputs.mode != 'production-publish' && steps.release-mode.outputs.mode != 'candidate-create' }}"));
  const promotion = readFileSync(path.join(root, ".github/workflows/itx-current-promotion.yml"), "utf8");
  assertFixtureRefGuard(promotion, { verifyName: verifyRefStep, checkoutName: "Checkout pinned Mobile input fixture", where: "itx-current-promotion" });
});
