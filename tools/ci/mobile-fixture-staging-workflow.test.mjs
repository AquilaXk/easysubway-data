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
const mobileRevision = "39d2c4723d0ff855041c6162825930c7d12ffad3";
const capitalGzipSha256 = "f328fbedff014be18a0e8341e0bdbfe9b0dd774fa7e9ae7692aa869e831707b3";

function namedWorkflowStep(yml, name) {
  const marker = `      - name: ${name}\n`;
  const start = yml.indexOf(marker);
  assert.notEqual(start, -1, `${name} step을 찾지 못함`);
  const next = yml.indexOf("\n      - name:", start + marker.length);
  return yml.slice(start, next === -1 ? yml.length : next);
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
    assert.match(block, new RegExp(`ref:\\s*${mobileRevision}`));
    assert.match(block, /path:\s*\.external\/mobile/);
    assert.match(block, /persist-credentials:\s*false/);
    assert.match(block, /fetch-depth:\s*0/);
    assert.match(stage, /git -C \.external\/mobile rev-parse HEAD/);
    assert.match(stage, new RegExp(mobileRevision));
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
    assert.match(stage, new RegExp(capitalGzipSha256));
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

test("CI는 TRANSFER topology admission contract를 owned required runner에서 실행한다", () => {
  assertRequiredOwned(["tools/datapack/build-transfer-topology-admission.test.mjs"]);
});

test("CI는 EXIT path admission contract를 owned required runner에서 실행한다", () => {
  assertRequiredOwned([
    "tools/datapack/plan-kric-exit-path-collection.test.mjs",
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

test("CI는 fixture stage 뒤에 #108 bundled-pack 회귀 검증을 직렬 실행한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const verification = ci.match(/- name: Verify Data issue 108 bundled-pack regression[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(verification, "#108 bundled-pack 회귀 검증 스텝을 찾지 못함");
  assert.match(verification, /set -euo pipefail/);
  assert.match(verification, /node --test tools\/datapack\/readmit-bundled-pack-identity\.test\.mjs/);
  assert.match(verification, /node --test --test-name-pattern='bundled 공식 OD quote\|bundled 차량·출입문 힌트' tools\/datapack\/datapack-tools\.test\.mjs/);
  assert.ok(
    ci.indexOf("Stage pinned Mobile fixture") < ci.indexOf("Emit pinned Mobile station catalog artifact")
      && ci.indexOf("Emit pinned Mobile station catalog artifact") < ci.indexOf("Migrate pinned Mobile v18 pack to v19")
      && ci.indexOf("Migrate pinned Mobile v18 pack to v19") < ci.indexOf("Verify Data issue 108 bundled-pack regression"),
    "#108 회귀 검증은 fixture stage→catalog artifact→v19 migration 뒤여야 함",
  );
  assert.ok(
    ci.indexOf("Set up Node.js") < ci.indexOf("Emit pinned Mobile station catalog artifact"),
    "pinned Node runtime은 station catalog generator보다 앞서야 함",
  );
});

test("CI는 exact staged v18에서만 station catalog를 emit하고 explicit migration을 수행한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const emit = ci.match(/- name: Emit pinned Mobile station catalog artifact[\s\S]*?\n\s+- name:/)?.[0];
  const migrate = ci.match(/- name: Migrate pinned Mobile v18 pack to v19[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(emit && migrate, "station catalog와 migration step을 찾지 못함");
  assert.match(emit, /emit-station-catalog-from-bundled-pack\.mjs/);
  assert.match(emit, /--input apps\/mobile\/assets\/datapacks\/capital\.sqlite\.gz/);
  assert.match(emit, /--output \.external\/mobile-station-catalog/);
  assert.match(migrate, /apply-itx-topology-to-bundled-pack\.mjs/);
  assert.match(migrate, /--migrate-current-v18/);
  assert.match(migrate, /--station-catalog-pack \.external\/mobile-station-catalog/);
  const node = ci.match(/- name: Set up Node\.js[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(node, "pinned Node setup step을 찾지 못함");
  assert.match(node, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(node, /node-version:\s*"24\.19\.0"/);
});

test("CI는 migration이 쓰는 tracked topology evidence를 #108 regression 뒤 즉시 원복한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const backup = ci.match(/- name: Backup tracked topology evidence[\s\S]*?\n\s+- name:/)?.[0];
  const restore = ci.match(/- name: Restore tracked topology evidence[\s\S]*?\n\s+- name:/)?.[0];
  assert.ok(backup && restore, "topology evidence backup/restore step을 찾지 못함");
  assert.match(backup, /tools\/datapack\/itx-cheongchun-topology-evidence\.json/);
  assert.match(backup, /\.external\/itx-cheongchun-topology-evidence\.json/);
  assert.match(restore, /\.external\/itx-cheongchun-topology-evidence\.json/);
  assert.match(restore, /tools\/datapack\/itx-cheongchun-topology-evidence\.json/);
  assertWorkflowStepOrder(ci, [
    "Backup tracked topology evidence",
    "Migrate pinned Mobile v18 pack to v19",
    "Verify Data issue 108 bundled-pack regression",
    "Restore tracked topology evidence",
    "Verify and run migrated Mobile owned required tests",
  ]);
  assertWorkflowStepOrder(ci, ["Restore tracked topology evidence", "Lint workflows"]);
});

test("CI는 #108 derived pack을 버리고 pristine Mobile fixture를 owned runner 전에 복원한다", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const restore = namedWorkflowStep(ci, "Restore pinned Mobile fixture for owned tests");
  assert.match(restore, /source="\.external\/mobile\/apps\/mobile"/);
  assert.match(restore, /target="apps\/mobile"/);
  assert.match(restore, new RegExp(mobileRevision));
  assert.match(restore, new RegExp(capitalGzipSha256));
  assert.match(restore, /rm -r -- "\$\{target\}"/);
  assert.match(restore, /cp -a "\$\{source\}" "\$\{target\}"/);
  assert.match(restore, /find "\$\{target\}" -type l/);
  assert.match(restore, /sha256sum "\$\{target_capital_gzip\}"/);
  const withoutIssue108 = ci.replace(
    "Verify Data issue 108 bundled-pack regression",
    "Removed Data issue 108 bundled-pack regression",
  );
  const executionOrder = [
    "Verify Data issue 108 bundled-pack regression",
    "Verify and run migrated Mobile owned required tests",
    "Restore pinned Mobile fixture for owned tests",
    "Verify and run pristine Mobile owned required tests",
  ];
  assert.throws(() => assertWorkflowStepOrder(withoutIssue108, executionOrder), /단계를 찾지 못함/);
  assertWorkflowStepOrder(ci, executionOrder);
});

test("Data Pack Release는 Mobile fixture checkout 또는 stage를 포함하지 않는다", () => {
  const release = readFileSync(path.join(root, ".github/workflows/datapack-release.yml"), "utf8");
  assert.doesNotMatch(release, /apps\/mobile|Checkout pinned Mobile fixture|Stage pinned Mobile fixture/);
});
