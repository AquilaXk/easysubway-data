import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = ".github/workflows/ci.yml";
const ownership = JSON.parse(
  readFileSync(path.join(root, "tools/ci/data-test-ownership.json"), "utf8"),
);
const mobileRepository = "AquilaXk/easysubway-mobile";
const ciMobileRevision = "5b58d426258f536070137737c3f19a8dbeda44c1";
const ciCapitalGzipSha256 = "609a74095859b5bf7602c25e142caa47cc212170a72d6240e2d01b39f874047a";
const releaseMobileRevision = "39d2c4723d0ff855041c6162825930c7d12ffad3";
const releaseCapitalGzipSha256 = "f328fbedff014be18a0e8341e0bdbfe9b0dd774fa7e9ae7692aa869e831707b3";
const releaseIndexSha256 = "ad801ec865d385e86cf4094e3c007af9cbfbe1d4a8c42bab8f9b2682b229026e";
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
    assert.match(block, new RegExp(`ref:\\s*${ciMobileRevision}`));
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
    "tools/datapack/collect-current-kric-exit-path-provider-snapshot.test.mjs",
    "tools/datapack/diagnose-current-kric-exit-path-query.test.mjs",
    "tools/datapack/build-exit-path-admission.test.mjs",
    "tools/datapack/build-current-exit-path-source-admission.test.mjs",
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
  assert.match(verification, /apply-itx-topology-to-bundled-pack\.mjs/);
  assert.match(verification, /--check/);
  assert.match(verification, /apps\/mobile\/assets\/datapacks\/capital\.sqlite\.gz/);
  assert.match(verification, /node --test tools\/datapack\/readmit-bundled-pack-identity\.test\.mjs/);
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
  assert.match(runner, /node tools\/ci\/data-test-discovery\.mjs run --class required-pr --profile mobile-v19 --max-workers 1/);
  assertWorkflowStepOrder(ci, [
    "Verify current Mobile v19 ITX topology evidence",
    "Verify and run current Mobile v19 owned required tests",
    "Re-verify current Mobile fixture for owned tests",
  ]);
});

test("CI는 direct current v19 검증 안에서 #108 bundled-pack 회귀를 실행한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const verification = namedWorkflowStep(ci, "Verify current Mobile v19 ITX topology evidence");
  assert.match(verification, /set -euo pipefail/);
  assert.match(verification, /node --test tools\/datapack\/readmit-bundled-pack-identity\.test\.mjs/);
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

test("CI는 browser-dependent required tests 전에 pinned Chrome runtime을 제공한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const shardOne = namedJob(ci, "contracts_shard_1");
  const shardTwo = namedJob(ci, "contracts_shard_2");
  const shardThree = namedJob(ci, "contracts_shard_3");
  const contracts = namedJob(ci, "contracts");
  const jobPairs = [
    [shardOne, "Verify and run pristine Mobile owned required tests (shard 1/3)"],
    [shardTwo, "Verify and run pristine Mobile owned required tests (shard 2/3)"],
    [shardThree, "Verify and run pristine Mobile owned required tests (shard 3/3)"],
  ];

  assert.match(shardOne, /^    name: Data contracts \(shard 1\/3\)$/m);
  assert.match(shardTwo, /^    name: Data contracts \(shard 2\/3\)$/m);
  assert.match(shardThree, /^    name: Data contracts \(shard 3\/3\)$/m);
  assert.doesNotMatch(shardOne, /\n    needs:/);
  assert.doesNotMatch(shardTwo, /\n    needs:/);
  assert.doesNotMatch(shardThree, /\n    needs:/);
  assert.match(contracts, /^    name: Data contracts$/m);
  assert.match(contracts, /needs:\s*\[contracts_shard_1, contracts_shard_2, contracts_shard_3\]/);
  assert.match(contracts, /if:\s*\$\{\{ always\(\) \}\}/);
  assert.match(contracts, /SHARD_1_RESULT:\s*\$\{\{ needs\.contracts_shard_1\.result \}\}/);
  assert.match(contracts, /SHARD_2_RESULT:\s*\$\{\{ needs\.contracts_shard_2\.result \}\}/);
  assert.match(contracts, /SHARD_3_RESULT:\s*\$\{\{ needs\.contracts_shard_3\.result \}\}/);
  assert.match(contracts, /\[\[ "\$\{SHARD_1_RESULT\}" == "success" \]\]/);
  assert.match(contracts, /\[\[ "\$\{SHARD_2_RESULT\}" == "success" \]\]/);
  assert.match(contracts, /\[\[ "\$\{SHARD_3_RESULT\}" == "success" \]\]/);
  for (const [job, runnerName] of jobPairs) {
    const repository = namedWorkflowStep(job, "Checkout repository");
    const fixture = namedWorkflowStep(job, "Checkout pinned Mobile fixture");
    const stage = namedWorkflowStep(job, "Stage pinned Mobile fixture");
    const node = namedWorkflowStep(job, "Set up Node.js");
    const setup = namedWorkflowStep(job, "Set up Chrome for browser-dependent required tests");
    const runner = namedWorkflowStep(job, runnerName);
    assert.match(repository, /uses:\s*actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
    assert.match(repository, /ref:\s*\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
    assert.match(repository, /persist-credentials:\s*false/);
    assert.match(fixture, new RegExp(`repository:\\s*${mobileRepository}`));
    assert.match(fixture, new RegExp(`ref:\\s*${ciMobileRevision}`));
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
      "각 shard job은 fixture 검증 뒤에만 stage해야 함",
    );
    assert.match(node, /uses:\s*actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
    assert.match(node, /node-version:\s*"24\.19\.0"/);
    assert.match(setup, /id:\s*setup-chrome/);
    assert.match(
      setup,
      /uses:\s*browser-actions\/setup-chrome@086160e580d6e8c142ad5ba29009dcde677c6321/,
    );
    assert.match(setup, /chrome-version:\s*"152\.0\.7977\.54"/);
    assert.match(setup, /install-dependencies:\s*true/);
    assert.match(runner, /CHROME_PATH:\s*\$\{\{ steps\.setup-chrome\.outputs\.chrome-path \}\}/);
    assert.match(runner, /ROUTE_MAP_CHROME_NO_SANDBOX:\s*"1"/);
    assert.ok(
      job.indexOf("Set up Chrome for browser-dependent required tests") < job.indexOf(runnerName),
      "각 shard job은 자체 Chrome setup 뒤에 runner를 실행해야 함",
    );
  }
  assert.match(shardOne, /--default-profile --max-workers 1 --shard-count 3 --shard-index 1/);
  assert.match(shardTwo, /--default-profile --max-workers 1 --shard-count 3 --shard-index 2/);
  assert.match(shardThree, /--default-profile --max-workers 1 --shard-count 3 --shard-index 3/);
});

test("CI는 Data contracts 각 job에만 최소 contents read 권한을 둔다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(ci, /^permissions:/m);
  for (const id of ["contracts_shard_1", "contracts_shard_2", "contracts_shard_3", "contracts"]) {
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
  const releaseGate = "if: ${{ steps.release-mode.outputs.is-pointer-only != 'true' && steps.release-mode.outputs.mode != 'production-publish' }}";

  assert.match(block, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(block, new RegExp(`repository:\\s*${mobileRepository}`));
  assert.match(block, new RegExp(`ref:\\s*${releaseMobileRevision}`));
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
