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
  assert.match(collectItx, /run-current-itx-collection\.mjs[\s\S]*--freshness-output "\$\{TOPOLOGY_OPERATION_ROOT\}\/freshness\.json"/);
  assert.match(yml, /build-itx-current-topology-admission\.mjs[\s\S]*--collection[\s\S]*--coverage-contract tools\/datapack\/itx-cheongchun-coverage-contract\.json[\s\S]*--output/);
  assert.match(yml, /TOPOLOGY_BUILD_NOW/); assert.equal((yml.match(/activate-current-source-set\.mjs --topology-only/g) ?? []).length, 2); assert.match(yml, /--check/);
  assert.match(yml, /registrationEvidence\.snapshotId/); assert.match(yml, /itxTopologyEvidencePath/); assert.match(yml, /source_key="\$\{key\}_SOURCE"; source="\$\{!source_key\}"/); assert.match(yml, /exactly twelve paths/); assert.match(yml, /exactly five immutable current topology inputs/); assert.match(yml, /exactly seven activation paths/);
  assert.equal((yml.match(/--itx-current-admission "\$\{TOPOLOGY_ITX_ADMISSION_PATH\}"/g) ?? []).length, 2);
  assert.match(stepBody("Activate current topology inputs exactly once"), /env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(yml, /secrets\.DATA_GO_KR_SERVICE_KEY/);
  assert.match(yml, /Refs #636, #625/); assert.doesNotMatch(yml, /oci:|aws|retry|fallback|automerge|git push origin main/i);
});
