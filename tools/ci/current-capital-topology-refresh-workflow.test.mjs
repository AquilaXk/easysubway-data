import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const yml = readFileSync(new URL("../../.github/workflows/current-capital-topology-refresh.yml", import.meta.url), "utf8");
function stepBody(name) {
  const start = yml.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = yml.indexOf("\n      - name: ", start + 1);
  return yml.slice(start, end === -1 ? yml.length : end);
}

test("derived GitHub environment values use physical records", () => {
  for (const name of [
    "Derive immutable input identities from collector output",
    "Derive current activation dependencies",
  ]) {
    const body = stepBody(name);
    assert.doesNotMatch(body, /process\.stdout\.write\([\s\S]*?\\\\n/);
    assert.match(body, /console\.log\(/);
  }
});

test("activation dependencies are validated after GitHub environment update", () => {
  const derive = stepBody("Derive current activation dependencies");
  const validate = stepBody("Validate current activation dependencies");
  assert.doesNotMatch(derive, /\$\{TOPOLOGY_INCHEON_ACCESSIBILITY_PATH\}/);
  assert.match(validate, /\[\[ -f "\$\{TOPOLOGY_INCHEON_ACCESSIBILITY_PATH\}" && ! -e "\$\{TOPOLOGY_REVERIFICATION_PATH\}" \]\]/);
  assert.ok(yml.indexOf("Derive current activation dependencies") < yml.indexOf("Validate current activation dependencies"));
  assert.ok(yml.indexOf("Validate current activation dependencies") < yml.indexOf("Activate current topology inputs exactly once"));
});

test("topology buildNow preserves its post-collection millisecond instant", () => {
  const derive = stepBody("Derive immutable input identities from collector output");
  assert.ok(yml.indexOf("Collect each official current topology input once") < yml.indexOf("Derive immutable input identities from collector output"));
  assert.match(derive, /console\.log\("TOPOLOGY_BUILD_NOW=" \+ new Date\(\)\.toISOString\(\)\);/);
  assert.doesNotMatch(derive, /new Date\(\)\.toISOString\(\)\.replace\(/);
});

test("pending full fan-in cannot reach a topology side effect", () => {
  const effectSteps = [
    "Collect each official current topology input once",
    "Commit exactly four immutable current topology inputs",
    "Activate current topology inputs exactly once",
  ];
  for (const name of effectSteps) {
    const body = stepBody(name);
    assert.match(body, /\n\s+if: \$\{\{[^\n]+steps\.decision\.outputs\.state/);
    assert.doesNotMatch(body, /PENDING_FULL_FAN_IN|outputs\.state\s*!=/);
  }
});

test("topology refresh workflow is a pinned, main-only, direct-to-main solo automation", () => {
  assert.match(yml, /permissions:\s*\{\}/);
  assert.match(yml, /cron: "47 \*\/2 \* \* \*"/);
  assert.match(yml, /github\.ref == 'refs\/heads\/main'/);
  assert.match(yml, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(yml, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/);
  assert.match(yml, /node-version: "24\.19\.0"/);
  assert.match(yml, /\n    permissions:\n      actions: read\n      contents: write\n/);
  assert.match(yml, /cancel-in-progress: false/);
  assert.match(yml, /persist-credentials: false/);
  assert.match(yml, /currentCapitalTopologyPreflight/);
  assert.match(yml, /git fetch --no-tags origin main[\s\S]*git rev-parse origin\/main/);
  assert.match(yml, /--candidate tools\/datapack\/release\/candidate-build-spec\.json/);
  assert.match(yml, /--current-main-sha/);
  assert.match(yml, /collect-capital-route-topology\.mjs --download/);
  assert.match(yml, /collect-incheon-station-info\.mjs --download/);
  assert.match(yml, /collect-incheon-timetable\.mjs --download[\s\S]*incheon-transit-station-info-\$\{station_stamp\}\.json/);
  const collectTopology = stepBody("Collect each official current topology input once");
  assert.match(collectTopology, /mkdir -p "\$\{TOPOLOGY_OPERATION_ROOT\}\/timetables"\n\s+node tools\/datapack\/collect-incheon-timetable\.mjs --download --topology-snapshot "\$\{TOPOLOGY_OPERATION_ROOT\}\/incheon-transit-station-info-\$\{station_stamp\}\.json" --output-dir "\$\{TOPOLOGY_OPERATION_ROOT\}\/timetables"/);
  assert.equal((collectTopology.match(/collect-incheon-timetable\.mjs --download/g) ?? []).length, 1);
  assert.doesNotMatch(yml, /environment:|DATA_GO_KR_SERVICE_KEY|run-current-itx-collection|guard-itx-current-collection-budget|build-itx-current-topology-admission|emit-station-catalog-pack/);
  assert.match(yml, /TOPOLOGY_BUILD_NOW/);
  assert.equal((yml.match(/activate-current-source-set\.mjs --topology-source-admission/g) ?? []).length, 2);
  assert.match(yml, /--check/);
  assert.doesNotMatch(yml, /--topology-only|--itx-current-admission|itx_args/);
  assert.match(yml, /registrationEvidence\.snapshotId/);
  assert.match(yml, /source_key="\$\{key\}_SOURCE"; source="\$\{!source_key\}"/);
  assert.doesNotMatch(yml, /ITX_REFRESH_REQUIRED|itx_refresh_required|itx-current-network-edge-admission|ITX_ADMISSION/);
  assert.match(yml, /exactly four immutable current topology inputs/);
  const commit = stepBody("Commit exactly four immutable current topology inputs");
  assert.match(commit, /git add -- "\$\{input_targets\[@\]\}"/);
  assert.match(commit, /git commit -m "Register current topology inputs"/);
  const activate = stepBody("Activate current topology inputs exactly once");
  assert.match(activate, /topology activation must change a nonempty subset of the four source admission paths/);
  assert.match(activate, /grep -Fqx "\$\{TOPOLOGY_REVERIFICATION_PATH\}"/);
  assert.match(activate, /topology activation changed an unsupported path/);
  assert.ok(activate.indexOf('git commit -m "Activate current topology inputs"') < activate.indexOf("--topology-source-admission --check"));
  assert.ok(activate.indexOf("--topology-source-admission --check") < activate.indexOf('[[ -z "$(git diff --name-only)"'));
  assert.ok(activate.indexOf('[[ -z "$(git diff --name-only)"') < activate.indexOf('refresh-automation-pr.mjs body --stage capital-topology-refresh'));
  assert.ok(activate.indexOf('refresh-automation-pr.mjs body --stage capital-topology-refresh') < activate.indexOf('git push origin HEAD:main'));
  assert.match(activate, /env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(yml, /Upload sanitized ITX review evidence|itx-review/);
  assert.doesNotMatch(yml, /oci:|aws|retry|fallback|automerge|pull-requests:\s*write|issues:\s*write|create-github-app-token|gh pr create|automation\/|git push origin main|gh workflow run|git add -A|git add \./i);
});

test("topology refresh는 ITX 공급자를 부르지 않고 WAIT_ITX_PROMOTION이면 안내만 남기고 끝난다", () => {
  const decision = stepBody("Decide whether current topology refresh is due");
  assert.doesNotMatch(decision, /guard-itx-current-collection-budget|itx-collected-today|itx_collected/);
  assert.doesNotMatch(yml, /WAIT_ITX_COLLECTED_TODAY/);
  assert.match(stepBody("Note current topology refresh waiting on ITX promotion"), /\n        if: \$\{\{ steps\.decision\.outputs\.state == 'WAIT_ITX_PROMOTION' \}\}\n[\s\S]*::notice/);
  assert.equal(yml.includes("WAIT_ITX_PROMOTION' &&"), false);
  assert.equal(yml.includes("WAIT_ITX_PROMOTION' ||"), false);
});

test("topology refresh ends at source admission and never commits candidate-side outputs (#862 결정 C)", () => {
  for (const candidateSide of ["release-request.json", "hash-evidence.json"]) {
    assert.equal(yml.includes(candidateSide), false, `${candidateSide} belongs to the nationwide candidate refresh`);
  }
  assert.deepEqual(yml.match(/[^\n]*candidate-build-spec\.json[^\n]*/g)?.map((line) => line.trim().split(" ").slice(0, 3).join(" ")), [
    "node tools/ci/decide-current-capital-topology-refresh.mjs --inventory",
  ]);
  const activate = stepBody("Activate current topology inputs exactly once");
  assert.match(activate, /allowed_activation_paths=\(tools\/datapack\/source-inventory\.json tools\/datapack\/release\/capital-production-reviewed-pack\.json tools\/datapack\/release\/capital-production-canonical-pack\.json "\$\{TOPOLOGY_REVERIFICATION_PATH\}"\)/);
});

test("failure summary step is last", () => {
  assert.equal(yml.trimEnd().lastIndexOf("\n      - name: "), yml.lastIndexOf("\n      - name: Report refresh failure summary"));
  const report = stepBody("Report refresh failure summary");
  assert.match(report, /node tools\/ci\/report-refresh-failure\.mjs --workflow current-capital-topology-refresh\.yml/);
});
