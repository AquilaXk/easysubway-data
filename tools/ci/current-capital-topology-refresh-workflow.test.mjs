import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const yml = readFileSync(new URL("../../.github/workflows/current-capital-topology-refresh.yml", import.meta.url), "utf8");
test("topology refresh workflow is a pinned, main-only, durable claim automation", () => {
  assert.match(yml, /cron: "47 \*\/2 \* \* \*"/); assert.match(yml, /github\.ref == 'refs\/heads\/main'/);
  assert.match(yml, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/); assert.match(yml, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/); assert.match(yml, /node-version: "24\.19\.0"/);
  assert.match(yml, /contents: write/); assert.match(yml, /pull-requests: write/); assert.match(yml, /cancel-in-progress: false/); assert.match(yml, /persist-credentials: false/);
  assert.match(yml, /automation\/636-current-topology-refresh-\$\{GITHUB_RUN_ID\}/); assert.match(yml, /git config user\.name "github-actions\[bot\]"[\s\S]*git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"[\s\S]*git commit --allow-empty -m "Claim current topology refresh"[\s\S]*git push origin "\$\{branch\}"[\s\S]*git switch --detach/);
  assert.match(yml, /git rev-list --count HEAD\.\."origin\/\$\{branch\}"\)" == "3"/); assert.match(yml, /Claim current topology refresh/); assert.match(yml, /Register current topology inputs/); assert.match(yml, /Activate current topology inputs/);
  assert.match(yml, /currentCapitalTopologyPreflight/); assert.match(yml, /git fetch --no-tags origin main[\s\S]*git rev-parse origin\/main/); assert.match(yml, /--current-main-sha/);
  assert.match(yml, /collect-capital-route-topology\.mjs --download/); assert.match(yml, /collect-incheon-station-info\.mjs --download/); assert.match(yml, /collect-incheon-timetable\.mjs --download[\s\S]*incheon-transit-station-info-\$\{station_stamp\}\.json/);
  assert.match(yml, /TOPOLOGY_BUILD_NOW/); assert.equal((yml.match(/activate-current-source-set\.mjs --topology-only/g) ?? []).length, 2); assert.match(yml, /--check/);
  assert.match(yml, /registrationEvidence\.snapshotId/); assert.match(yml, /itxTopologyEvidencePath/); assert.match(yml, /source_key="\$\{key\}_SOURCE"; source="\$\{!source_key\}"/); assert.match(yml, /exactly eleven paths/); assert.match(yml, /exactly seven activation paths/);
  assert.match(yml, /Refs #636, #625/); assert.doesNotMatch(yml, /secrets\.|oci:|aws|retry|fallback|automerge|git push origin main/i);
});
