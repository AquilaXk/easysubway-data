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
    "Derive current ITX admission identity",
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
  assert.doesNotMatch(derive, /\$\{TOPOLOGY_INCHEON_ACCESSIBILITY_PATH\}|\$\{TOPOLOGY_ITX_EVIDENCE_PATH\}/);
  assert.match(validate, /\[\[ -f "\$\{TOPOLOGY_INCHEON_ACCESSIBILITY_PATH\}" && -f "\$\{TOPOLOGY_ITX_EVIDENCE_PATH\}" && ! -e "\$\{TOPOLOGY_REVERIFICATION_PATH\}" \]\]/);
  assert.ok(yml.indexOf("Derive current activation dependencies") < yml.indexOf("Validate current activation dependencies"));
  assert.ok(yml.indexOf("Validate current activation dependencies") < yml.indexOf("Activate current topology inputs exactly once"));
});
test("topology buildNow preserves its post-collection millisecond instant", () => {
  const derive = stepBody("Derive immutable input identities from collector output");
  assert.ok(yml.indexOf("Collect each official current topology input once") < yml.indexOf("Derive immutable input identities from collector output"));
  assert.match(derive, /console\.log\("TOPOLOGY_BUILD_NOW=" \+ new Date\(\)\.toISOString\(\)\);/);
  assert.doesNotMatch(derive, /new Date\(\)\.toISOString\(\)\.replace\(/);
});
test("an exact empty claim is reused without creating another claim", () => {
  const preflight = stepBody("Preflight immutable current topology identities");
  const create = stepBody("Create durable claim before provider access");
  const reuse = stepBody("Reuse an exact empty claim after provider failure");
  const collect = stepBody("Collect each official current topology input once");
  assert.match(preflight, /steps\.decision\.outputs\.state == 'REUSE_CLAIM'/);
  assert.doesNotMatch(create, /REUSE_CLAIM/);
  assert.match(reuse, /steps\.decision\.outputs\.state == 'REUSE_CLAIM'/);
  assert.match(reuse, /git rev-list --count HEAD\.\."origin\/\$\{branch\}"\)" == "1"/);
  assert.match(reuse, /git rev-parse "origin\/\$\{branch\}\^"\)" == "\$\(git rev-parse HEAD\)"/);
  assert.match(reuse, /Claim current topology refresh/);
  assert.match(reuse, /gh auth setup-git/);
  assert.match(reuse, /TOPOLOGY_BRANCH/);
  assert.match(reuse, /TOPOLOGY_MAIN_SHA/);
  assert.match(collect, /steps\.decision\.outputs\.state == 'REUSE_CLAIM'/);
});
test("topology refresh workflow is a pinned, main-only, durable claim automation", () => {
  assert.match(yml, /cron: "47 \*\/2 \* \* \*"/); assert.match(yml, /github\.ref == 'refs\/heads\/main'/);
  assert.match(yml, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/); assert.match(yml, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/); assert.match(yml, /node-version: "24\.19\.0"/);
  assert.match(yml, /actions: read/); assert.match(yml, /contents: write/); assert.match(yml, /pull-requests: write/); assert.match(yml, /cancel-in-progress: false/); assert.match(yml, /persist-credentials: false/);
  assert.match(yml, /automation\/636-current-topology-refresh-\$\{GITHUB_RUN_ID\}/); assert.match(yml, /git config user\.name "github-actions\[bot\]"[\s\S]*git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"[\s\S]*git commit --allow-empty -m "Claim current topology refresh"[\s\S]*git push origin "\$\{branch\}"[\s\S]*git switch --detach/);
  assert.match(yml, /git rev-list --count HEAD\.\."origin\/\$\{branch\}"\)" == "3"/); assert.match(yml, /Claim current topology refresh/); assert.match(yml, /Register current topology inputs/); assert.match(yml, /Activate current topology inputs/);
  assert.match(yml, /currentCapitalTopologyPreflight/); assert.match(yml, /git fetch --no-tags origin main[\s\S]*git rev-parse origin\/main/); assert.match(yml, /--candidate tools\/datapack\/release\/candidate-build-spec\.json/); assert.match(yml, /--current-main-sha/);
  assert.match(yml, /collect-capital-route-topology\.mjs --download/); assert.match(yml, /collect-incheon-station-info\.mjs --download/); assert.match(yml, /collect-incheon-timetable\.mjs --download[\s\S]*incheon-transit-station-info-\$\{station_stamp\}\.json/);
  const collectTopology = stepBody("Collect each official current topology input once");
  assert.match(collectTopology, /mkdir -p "\$\{TOPOLOGY_OPERATION_ROOT\}\/timetables"\n\s+node tools\/datapack\/collect-incheon-timetable\.mjs --download --topology-snapshot "\$\{TOPOLOGY_OPERATION_ROOT\}\/incheon-transit-station-info-\$\{station_stamp\}\.json" --output-dir "\$\{TOPOLOGY_OPERATION_ROOT\}\/timetables"/);
  assert.equal((collectTopology.match(/collect-incheon-timetable\.mjs --download/g) ?? []).length, 1);
  assert.match(yml, /environment: itx-current-collection/);
  assert.equal((yml.match(/run-current-itx-collection\.mjs/g) ?? []).length, 1);
  assert.match(yml, /guard-itx-current-collection-budget\.mjs/);
  const prepareItx = stepBody("Prepare current ITX collection");
  const collectItx = stepBody("Collect current ITX timetable once");
  assert.ok(yml.indexOf("Prepare current ITX collection") < yml.indexOf("Collect current ITX timetable once"));
  assert.match(prepareItx, /DATA_GO_KR_SERVICE_KEY must be a nonempty single line/);
  assert.match(prepareItx, /emit-station-catalog-pack\.mjs/);
  assert.match(prepareItx, /guard-itx-current-collection-budget\.mjs --output "\$\{TOPOLOGY_OPERATION_ROOT\}\/freshness\.json"/);
  assert.doesNotMatch(collectItx, /DATA_GO_KR_SERVICE_KEY must be a nonempty single line|emit-station-catalog-pack\.mjs|guard-itx-current-collection-budget\.mjs/);
  assert.match(prepareItx, /steps\.decision\.outputs\.itx_refresh_required == 'true'/);
  assert.match(collectItx, /steps\.decision\.outputs\.itx_refresh_required == 'true'[\s\S]*set \+e[\s\S]*collector_status=\$\?[\s\S]*\[\[ "\$\{collector_status\}" == "0" \|\| "\$\{collector_status\}" == "1" \]\][\s\S]*build-itx-current-topology-admission\.mjs/);
  assert.match(collectItx, /collection_input="\$\{TOPOLOGY_OPERATION_ROOT\}\/itx-completeness\.json"[\s\S]*if \[\[ "\$\{collector_status\}" == "1" \]\]; then collection_input="\$\{TOPOLOGY_OPERATION_ROOT\}\/itx-result\.json"; fi[\s\S]*--collection "\$\{collection_input\}"/);
  assert.match(collectItx, /run-current-itx-collection\.mjs[\s\S]*--freshness-output "\$\{TOPOLOGY_OPERATION_ROOT\}\/freshness\.json"/);
  assert.match(yml, /build-itx-current-topology-admission\.mjs[\s\S]*--collection[\s\S]*--coverage-contract tools\/datapack\/itx-cheongchun-coverage-contract\.json[\s\S]*--output/);
  assert.match(yml, /TOPOLOGY_BUILD_NOW/); assert.equal((yml.match(/activate-current-source-set\.mjs --topology-only/g) ?? []).length, 2); assert.match(yml, /--check/);
  assert.match(yml, /registrationEvidence\.snapshotId/); assert.match(yml, /itxTopologyEvidencePath/); assert.match(yml, /source_key="\$\{key\}_SOURCE"; source="\$\{!source_key\}"/); assert.match(yml, /itxRefreshRequired: process\.env\.ITX_REFRESH_REQUIRED === "true"/); assert.match(yml, /four-input topology claim must not select an ITX admission/); assert.match(yml, /five-input topology claim ITX admission binding is invalid/); assert.match(yml, /exactly four or five immutable current topology inputs/);
  const recovery = stepBody("Recover a completed claimed refresh");
  assert.match(recovery, /git diff --quiet HEAD "origin\/\$\{branch\}\^\^"/);
  assert.match(recovery, /git diff --name-only --diff-filter=ACMR "origin\/\$\{branch\}\^\^" "origin\/\$\{branch\}\^"/);
  assert.match(recovery, /git diff --name-only --diff-filter=ACMR "origin\/\$\{branch\}\^" "origin\/\$\{branch\}"/);
  assert.match(recovery, /topology input commit must change exactly four or five paths/);
  assert.match(recovery, /topology activation commit must change a nonempty subset of the seven activation paths/);
  assert.match(recovery, /capital-topology-reverification-\[0-9\]\{8\}/);
  assert.doesNotMatch(recovery, /exactly eleven or twelve paths/);
  const activate = stepBody("Activate current topology inputs exactly once");
  assert.match(activate, /topology activation must change a nonempty subset of the seven activation paths/);
  assert.match(activate, /grep -Fqx "\$\{TOPOLOGY_REVERIFICATION_PATH\}"/);
  assert.match(activate, /topology activation changed an unsupported path/);
  assert.ok(activate.indexOf("--topology-only --check") < activate.indexOf('git commit -m "Activate current topology inputs"'));
  assert.doesNotMatch(activate, /exactly seven activation paths/);
  assert.doesNotMatch(yml, /- name: Verify current topology activation exactly once/);
  assert.equal((yml.match(/itx_args=\(\)/g) ?? []).length, 1);
  assert.match(yml, /if \[\[ "\$\{\{ steps\.decision\.outputs\.itx_refresh_required \}\}" == "true" \]\]; then itx_args=\(--itx-current-admission "\$\{TOPOLOGY_ITX_ADMISSION_PATH\}"\); fi/);
  assert.match(stepBody("Activate current topology inputs exactly once"), /env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}/);
  const uploadItx = stepBody("Upload sanitized ITX review evidence");
  assert.match(uploadItx, /steps\.decision\.outputs\.itx_refresh_required == 'true'/);
  assert.match(uploadItx, /current-capital-topology-refresh-itx-review-\$\{\{ github\.run_id \}\}/);
  assert.match(uploadItx, /itx-result\.json[\s\S]*itx-completeness\.json[\s\S]*retention-days: 14/);
  assert.doesNotMatch(uploadItx, /provider-response|credential|secret|raw-response/i);
  assert.match(yml, /secrets\.DATA_GO_KR_SERVICE_KEY/);
  assert.match(yml, /Refs #636, #625/); assert.doesNotMatch(yml, /oci:|aws|retry|fallback|automerge|git push origin main/i);
});
