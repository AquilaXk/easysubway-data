import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = resolve(import.meta.dirname,
  "../../.github/workflows/journey-profile-predeployment-measurement.yml");

function source() {
  return readFileSync(workflow, "utf8");
}

function requireText(text, pattern, label) {
  assert.match(text, pattern, label);
}

function runBlock(text, name) {
  const step = text.split("\n      - ").find((value) => value.startsWith(`name: ${name}\n`));
  const marker = "\n        run: |\n";
  const start = step?.indexOf(marker) ?? -1;
  assert.ok(start >= 0, `${name} run block`);
  return step.slice(start + marker.length).replace(/^          /gm, "");
}

test("workflow run extraction stays inside the named step", () => {
  const text = "steps:\n      - name: First\n        run: |\n          first\n"
    + "      - name: Second\n        env:\n          VALUE: input\n        run: |\n          second\n";
  assert.equal(runBlock(text, "First"), "first");
  assert.equal(runBlock(text, "Second"), "second\n");
  assert.throws(() => runBlock(text, "Missing"), /Missing run block/);
});

function writeExecutable(path, source) {
  writeFileSync(path, source.replace(/^(#![^\n]+\n)/, "$1set -eu\n"), { mode: 0o755 });
  chmodSync(path, 0o755);
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
  requireText(text, /oras-project\/setup-oras@1d808f7d7f6995cc68b7bf507bfe5c5446e1dc9d/,
    "pinned ORAS setup");
  requireText(text, /version: 1\.3\.3/, "pinned ORAS version");
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
  requireText(text, /typeof releaseEvidence\.buildCandidateId !== "string" \|\| !releaseEvidence\.buildCandidateId/,
    "nonempty release candidate identity");
  requireText(text, /typeof routeEvidence\.candidateId !== "string" \|\| !routeEvidence\.candidateId/,
    "nonempty route evidence candidate identity");
  requireText(text, /typeof routeEvidence\[name\] !== "object" \|\| routeEvidence\[name\] === null/,
    "route evidence artifact object");
  requireText(text, /const inventoryEntry = byPath\.get\(expected\);/,
    "route evidence inventory entry presence");
  requireText(text, /!\/\^\[a-f0-9\]\{64\}\$\/\.test\(routeEvidence\[name\]\.sha256 \?\? ""\)/,
    "route evidence digest shape");
  requireText(text, /!\/\^\[a-f0-9\]\{64\}\$\/\.test\(inventoryEntry\.sha256 \?\? ""\)/,
    "inventory digest shape");
  assert.doesNotMatch(text, /matchingScopes|JSON\.stringify\(value\) === JSON\.stringify\(regions\)/,
    "no inferred fan-in field discovery");
  requireText(text, /JourneyProfilePredeploymentMeasurementTest/, "future JUnit harness");
  requireText(text, /flag: "wx"/, "create-once evidence output");
  assert.doesNotMatch(text, /gh workflow run|--method POST.*\/dispatches/,
    "workflow does not dispatch another workflow");
});

test("predeployment measurement binds the JUnit harness to the validated candidate root", () => {
  const text = source();
  const harness = text.match(/- name: Run future PR-owned JUnit measurement harness\n([\s\S]*?)(?=\n      - name:)/)?.[0] ?? "";
  requireText(harness, /CANDIDATE_ROOT: \$\{\{ runner\.temp \}\}\/data-candidate/,
    "harness receives the downloaded candidate root");
  requireText(harness, /test -d "\$\{CANDIDATE_ROOT\}"\n\s+test ! -L "\$\{CANDIDATE_ROOT\}"/,
    "candidate root is a real directory");
  requireText(harness, /server-route-bundle\/\$\{candidateFile\}/,
    "harness validates the route bundle under the candidate root");
  requireText(harness, /test -f "\$\{candidatePath\}"\n\s+test ! -L "\$\{candidatePath\}"/,
    "required route artifacts are regular non-symlink files");
  requireText(harness, /compatibility\.json manifest\.json manifest\.signing-input\.json/,
    "required top-level route artifacts");
  requireText(harness, /payload\/accessibility\.sqlite\.zst\s+payload\/fare\.sqlite\.zst\s+payload\/timetable\.sqlite\.zst\s+payload\/topology\.sqlite\.zst\s+provenance\.json/,
    "required payload and provenance artifacts");
  requireText(harness, /EASYSUBWAY_CONTRACTS_BUNDLE: \$\{\{ runner\.temp \}\}\/backend-contracts\.json/,
    "Hub bundle is passed to Gradle");
  requireText(harness, /cd "\$\{RUNNER_TEMP\}\/backend-source\/backend"/,
    "Backend-only Gradle working directory");
  requireText(harness, /\.\/gradlew test --tests com\.easysubway\.journey\.application\.JourneyProfilePredeploymentMeasurementTest --no-daemon --max-workers=1/,
    "one bounded JUnit measurement invocation");
});

test("predeployment measurement stages locked contracts before the backend-only harness", () => {
  const text = source();
  const blocks = [
    runBlock(text, "Stage locked Backend Hub contracts"),
    runBlock(text, "Stage locked Backend Journey contracts"),
    runBlock(text, "Run future PR-owned JUnit measurement harness").slice(
      runBlock(text, "Run future PR-owned JUnit measurement harness").indexOf('cd "${RUNNER_TEMP}/backend-source/backend"'),
    ),
  ].join("\n");
  const root = mkdtempSync(join(tmpdir(), "journey-profile-measurement-"));
  const runnerTemp = join(root, "runner");
  const backend = join(runnerTemp, "backend-source", "backend");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  try {
    mkdirSync(join(backend, "tools"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(backend, "contracts.lock.json"), "{}\n");
    writeFileSync(join(backend, "journey-contracts.lock.json"), "{}\n");
    const candidate = join(runnerTemp, "data-candidate", "server-route-bundle");
    mkdirSync(join(candidate, "payload"), { recursive: true });
    for (const path of [
      "compatibility.json", "manifest.json", "manifest.signing-input.json", "provenance.json",
      "payload/accessibility.sqlite.zst", "payload/fare.sqlite.zst",
      "payload/timetable.sqlite.zst", "payload/topology.sqlite.zst",
    ]) writeFileSync(join(candidate, path), "fixture\n");
    writeFileSync(join(runnerTemp, "journey-profile-measurement-input.json"), "{}\n");
    writeExecutable(join(bin, "jq"), `#!/bin/bash\nif [[ "$*" == *journey-contracts.lock.json* ]]; then\n  printf '%s\\n' "ghcr.io/aquilaxk/easysubway-backend-contracts@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"\nelse\n  printf '%s\\n' "https://raw.githubusercontent.com/AquilaXk/easysubway/0123456789abcdef0123456789abcdef01234567/contracts/bundles/backend-contracts-v1.0.0.json"\nfi\n`);
    writeExecutable(join(bin, "curl"), `#!/usr/bin/env bash\necho "curl:$PWD:$*" >> "$CALL_LOG"\nwhile [[ "$1" != --output ]]; do shift; done; mkdir -p "$(dirname "$2")"; printf bundle > "$2"\n`);
    writeExecutable(join(bin, "oras"), `#!/usr/bin/env bash\necho "oras:$PWD:$*" >> "$CALL_LOG"\n[[ "$FAIL_ORAS" == 1 ]] && exit 1\nwhile [[ "$1" != --output ]]; do shift; done; mkdir -p "$2"; printf bundle > "$2/journey-v3-contract-bundle-v2.json"\n`);
    // Node 자체를 가리지 않고 선택한 두 stager 경계만 대체한다.
    for (const name of ["stage-contracts.mjs", "stage-journey-contracts.mjs"]) {
      writeFileSync(join(backend, "tools", name), `
import { appendFileSync, mkdirSync } from "node:fs";
const args = process.argv.slice(2);
const output = args.indexOf("--output");
if (output < 0 || !args[output + 1]) process.exit(2);
appendFileSync(process.env.CALL_LOG, "node:" + process.cwd() + ":" + process.argv.slice(1).join(" ") + "\\n");
mkdirSync(args[output + 1], { recursive: true });
`);
    }
    writeExecutable(join(bin, "find"), `#!/usr/bin/env bash\nprintf '%s\\n' compatibility.json manifest.json manifest.signing-input.json payload payload/accessibility.sqlite.zst payload/fare.sqlite.zst payload/timetable.sqlite.zst payload/topology.sqlite.zst provenance.json\n`);
    writeExecutable(join(backend, "gradlew"), `#!/usr/bin/env bash\necho "gradle:$PWD:$EASYSUBWAY_CONTRACTS_BUNDLE:$*" >> "$CALL_LOG"\nprintf observation > "$MEASUREMENT_OUTPUT"\n`);
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      CANDIDATE_ROOT: join(runnerTemp, "data-candidate"),
      MEASUREMENT_INPUT: join(runnerTemp, "journey-profile-measurement-input.json"),
      MEASUREMENT_OUTPUT: join(runnerTemp, "journey-profile-measurement-observation.json"),
      EASYSUBWAY_CONTRACTS_BUNDLE: join(runnerTemp, "backend-contracts.json"),
      CALL_LOG: log,
      FAIL_ORAS: "0",
    };
    const success = spawnSync("/bin/bash", ["-c", blocks], { env: environment, encoding: "utf8", timeout: 5000 });
    assert.equal(success.status, 0, success.stderr);
    const calls = readFileSync(log, "utf8");
    assert.deepEqual(calls.trim().split("\n").map((line) => line.split(":")[0]),
      ["curl", "node", "oras", "node", "gradle"], "preparation completes before Gradle");
    assert.match(calls, /node:.*stage-contracts\.mjs .*--lock .*contracts\.lock\.json .*--input .*backend-contracts\.json .*--output .*build\/contracts-staging/);
    assert.match(calls, /oras:.*pull ghcr\.io\/aquilaxk\/easysubway-backend-contracts@sha256:[a-f0-9]{64} --output/);
    assert.match(calls, /node:.*stage-journey-contracts\.mjs .*--lock .*journey-contracts\.lock\.json .*--input .*journey-v3-contract-bundle-v2\.json .*--output .*build\/journey-contracts-staging/);
    assert.match(calls, new RegExp(`gradle:${backend.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}:${join(runnerTemp, "backend-contracts.json").replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}:test --tests com\\.easysubway\\.journey\\.application\\.JourneyProfilePredeploymentMeasurementTest --no-daemon --max-workers=1`));
    const stopped = spawnSync("/bin/bash", ["-c", blocks], { env: { ...environment, FAIL_ORAS: "1" }, encoding: "utf8", timeout: 5000 });
    assert.notEqual(stopped.status, 0, "Journey staging failure stops the harness");
    assert.equal((readFileSync(log, "utf8").match(/^gradle:/gm) ?? []).length, 1,
      "a failed preparation does not invoke Gradle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("predeployment measurement derives regions from the canonical fan-in v2 scope", () => {
  const text = source();
  requireText(text, /import \{\s+validateCurrentFiveRegionSourceFanIn,\s+\} from/,
    "shared fan-in validator");
  requireText(text, /const fanIn = validateCurrentFiveRegionSourceFanIn\(/,
    "inventory-bound fan-in v2 validation");
  requireText(text, /fanIn\.regionalMatrixSha256 !== releaseEvidence\.identityLinkageMatrixSha256/,
    "release matrix binding");
  requireText(text, /regionIds: fanIn\.scope\.regionIds/, "measurement input derives regions");
  assert.doesNotMatch(text, /const regions = \["capital", "gwangju", "daejeon", "daegu", "busan"\]/,
    "no duplicate mutable region projection");
});
