import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = resolve(import.meta.dirname,
  "../../.github/workflows/journey-profile-predeployment-measurement.yml");

function source() {
  return readFileSync(workflow, "utf8");
}

function requireText(text, pattern, label) {
  assert.match(text, pattern, label);
}

test("predeployment measurement is a trusted main-only manual workflow", () => {
  const text = source();
  requireText(text, /^name: Journey Profile Predeployment Measurement$/m, "workflow name");
  requireText(text, /^on:\n  workflow_dispatch:/m, "manual trigger");
  assert.doesNotMatch(text, /^  (push|pull_request|schedule):/m, "no automatic trigger");
  requireText(text, /github\.repository == 'AquilaXk\/easysubway-data'/,
    "trusted repository");
  requireText(text, /github\.ref == 'refs\/heads\/main'/, "default branch");
  for (const input of ["backendPullRequestNumber", "expectedBackendHeadSha", "dataRunId", "expectedDataHeadSha"]) {
    requireText(text, new RegExp(`^      ${input}:\\n        description: [^\\n]+\\n        required: true$`, "m"), `${input} input`);
  }
  requireText(text, /^  actions: read$/m, "artifact read permission");
  requireText(text, /^  pull-requests: read$/m, "pull request read permission");
  assert.doesNotMatch(text, /^  (contents|packages): write$/m, "no publication permission");
  requireText(text, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/,
    "pinned checkout");
  requireText(text, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/,
    "pinned node setup");
  requireText(text, /actions\/setup-java@b6effb05e454b25005698d916606bdc6ffcbf961/,
    "pinned Java setup");
  requireText(text, /java-version: "21\.0\.11"/, "pinned Java version");
});

test("predeployment measurement binds one trusted Backend PR and Data #6 release", () => {
  const text = source();
  requireText(text, /repos\/AquilaXk\/easysubway-backend\/pulls\/\$\{BACKEND_PR\}/,
    "Backend pull lookup");
  requireText(text,
    /\.state == "open" and\s+\.base\.ref == "main" and\s+\.head\.repo\.full_name == "AquilaXk\/easysubway-backend" and\s+\.head\.repo\.fork == false and\s+\.head\.sha == \$expected/,
    "same-repository main-base Backend head");
  requireText(text, /repos\/AquilaXk\/easysubway-data\/actions\/runs\/\$\{DATA_RUN_ID\}/,
    "Data run lookup");
  requireText(text,
    /\.status == "completed" and \.conclusion == "success" and\s+\.workflow_id == 323921971 and \.event == "workflow_dispatch" and\s+\.head_branch == "main" and \.run_attempt == 1 and\s+\.head_repository\.full_name == "AquilaXk\/easysubway-data" and\s+\.head_sha == \$expected/,
    "successful Data Pack Release run and head");
  requireText(text, /\.workflow_id == 323921971 and \.event == "workflow_dispatch"/,
    "exact active Data Pack Release workflow");
  requireText(text, /\.head_branch == "main" and \.run_attempt == 1/,
    "single current-main Data release execution");
  requireText(text, /releaseEvidence\.releaseMode !== "release-candidate"/,
    "release-candidate evidence mode");
  requireText(text, /easysubway-datapack-candidate-\$\{\{ inputs\.dataRunId \}\}/,
    "candidate artifact name");
  requireText(text, /easysubway-datapack-candidate-execution-evidence-\$\{\{ inputs\.dataRunId \}\}/,
    "execution-evidence artifact name");
  requireText(text, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/,
    "pinned artifact download action");
  requireText(text, /repository: AquilaXk\/easysubway-data[\s\S]+run-id: \$\{\{ inputs\.dataRunId \}\}[\s\S]+github-token: \$\{\{ github\.token \}\}/,
    "same-repository artifact read authority");
});

test("predeployment measurement rejects incomplete artifact and observation attribution", () => {
  const text = source();
  for (const name of [
    "data-component-manifest.json",
    "data-artifact-inventory.json",
    "tools/datapack/release/current-five-region-source-fan-in.json",
    "release-evidence-bundle.json",
    "release-decision.json",
    "capital", "gwangju", "daejeon", "daegu", "busan",
    "POINT", "DEPARTURE_PROFILE", "ARRIVE_BY", "LAST_CONNECTION", "CUTOFF", "TYPED_FAILURE",
    "routeBundleSha256", "corpusSha256", "regionalMatrixSha256", "algorithmSha256", "frontierSha256",
    "observedWork", "observedStateLabels", "observedDestinationLabels", "observedBreakpoints",
    "durationNanos", "allocatedBytes", "saturatedStates",
    "requiredRepresentativeLoss", "oracleParity",
  ]) requireText(text, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), name);
  for (const path of [
    "compatibility.json", "manifest.json", "manifest.signing-input.json",
    "payload/accessibility.sqlite.zst", "payload/fare.sqlite.zst",
    "payload/timetable.sqlite.zst", "payload/topology.sqlite.zst", "provenance.json",
  ]) requireText(text, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `route ${path}`);
  for (const counter of ["providerCalls", "cacheHits", "staleArtifactUses", "fallbackUses"]) {
    requireText(text, new RegExp(`${counter} !== 0`), `${counter} fails closed`);
  }
  requireText(text, /expectedCells\.length/, "closed region/query coverage matrix");
  requireText(text, /component\.gitSha !== process\.env\.DATA_HEAD/, "component head binding");
  requireText(text, /String\(component\.workflowRunId\) !== process\.env\.DATA_RUN_ID/,
    "component run binding");
  requireText(text, /candidate artifact inventory paths mismatch/, "exact candidate inventory");
  assert.doesNotMatch(text, /matchingScopes|JSON\.stringify\(value\) === JSON\.stringify\(regions\)/,
    "no inferred fan-in field discovery");
  requireText(text, /JourneyProfilePredeploymentMeasurementTest/, "future JUnit harness");
  requireText(text, /flag: "wx"/, "create-once evidence output");
  assert.doesNotMatch(text, /gh workflow run|--method POST.*\/dispatches/,
    "workflow does not dispatch another workflow");
});
