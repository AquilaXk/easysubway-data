import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { buildNationwideCoverageTally, LEDGER_PATH } from "./build-nationwide-coverage-tally.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const TOOL_PATH = "tools/datapack/build-nationwide-coverage-tally.mjs";
const TARGETS_PATH = "tools/datapack/nationwide-coverage-targets.json";
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const RESOLUTIONS_PATH = "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json";
const INPUT_PATHS = [TARGETS_PATH, INVENTORY_PATH, RESOLUTIONS_PATH];
const EXPECTED_LAUNCH_REQUIRED_TOTAL = "270";

const FIXTURE_INPUTS = {
  targets: { path: TARGETS_PATH, sha256: "a".repeat(64) },
  inventory: { path: INVENTORY_PATH, sha256: "b".repeat(64) },
  resolutions: { path: RESOLUTIONS_PATH, sha256: "c".repeat(64) },
};

function fixtureTargets(overrides = {}) {
  return {
    schemaVersion: 2,
    artifactKind: "nationwide-datapack-coverage-targets",
    targetVersion: "2026-07-13",
    requiredSourceDomains: [
      {
        id: "station_line_membership",
        releaseTier: "LAUNCH_REQUIRED",
        requiredFields: ["line", "station_name"],
        blockingThreshold: { minimumOfficialFieldCoverageRatio: 1 },
      },
      {
        id: "demand_reference",
        releaseTier: "ENHANCEMENT",
        requiredFields: ["hourly_boarding_count"],
        blockingThreshold: { minimumOfficialFieldCoverageRatio: 1 },
      },
    ],
    activeLineScopes: [
      { lineId: "line-a", regionId: "capital", operatorId: "operator-a" },
      { lineId: "line-a", regionId: "capital", operatorId: "operator-b" },
    ],
    regions: [{ id: "capital", displayName: "수도권", operatorIds: ["operator-a", "operator-b"] }],
    ...overrides,
  };
}

function fixtureInventory(sources) {
  return { schemaVersion: 1, retrievedAt: "2026-06-22", sources };
}

function fixtureResolutions(entries = []) {
  return {
    schemaVersion: 1,
    artifactKind: "nationwide-coverage-resolutions",
    targetVersion: "2026-07-13",
    generatedAt: "2026-07-21T02:43:09.257Z",
    entries,
  };
}

function fixtureResolutionEntry(overrides = {}) {
  return {
    regionId: "capital",
    operatorId: "operator-b",
    lineId: "line-a",
    sourceDomain: "station_line_membership",
    state: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
    reasonCode: "PUBLIC_API_NO_DATA",
    fallback: "UNSUPPORTED_REGION",
    reviewedAt: "2026-07-21T02:43:09.257Z",
    nextReviewAt: "2026-10-19T02:43:09.257Z",
    evidenceHash: "d".repeat(64),
    ...overrides,
  };
}

// operator-a만 커버하는 노선 소스 — operator-b는 dual-operator 미매칭이 된다.
function operatorAMembershipSource() {
  return {
    id: "operator-a-membership",
    coverageScope: {
      regionIds: ["capital"],
      operatorIds: ["operator-a"],
      lineIds: ["line-a"],
      sourceDomains: ["station_line_membership"],
    },
    fieldsProvided: ["line", "station_name"],
  };
}

test("MOLIT coverage selects only observed operator-line pairs and the parent source", () => {
  const parent = {
    ...operatorAMembershipSource(), id: "molit-urban-rail-full-route",
    fieldsProvided: ["line_name", "station_name"],
    admissionEvidence: { sourceId: "molit-urban-rail-full-route", decision: "APPROVED",
      snapshotId: "test-current", rawSha256: "a".repeat(64) },
    membershipCoverageEvidence: { snapshotId: "test-current", rawSha256: "a".repeat(64),
      normalizedObservationSha256: "b".repeat(64), lineOperatorScopes: [
        { regionId: "capital", operatorId: "operator-a", lineId: "line-a" },
        { regionId: "capital", operatorId: "operator-b", lineId: "line-b" },
      ] },
  };
  const slice = { ...operatorAMembershipSource(), id: "test-dependent-membership",
    datasetKind: "reviewed-admission-slice", requiredForProductionPack: false,
    membershipAdmissionEvidence: { membershipSourceId: parent.id } };
  const targets = fixtureTargets({ activeLineScopes: [
    ...fixtureTargets().activeLineScopes,
    { regionId: "capital", operatorId: "operator-b", lineId: "line-b" },
  ] });
  const build = () => buildFixtureLedger({ targets,
    inventory: fixtureInventory([parent, slice]), resolutions: fixtureResolutions() });
  const rows = build().launchRequired.requirements;
  assert.deepEqual(rows.find((row) => row.operatorId === "operator-a").admittedSourceIds, [parent.id]);
  assert.equal(rows.find((row) => row.operatorId === "operator-b" && row.lineId === "line-a").status, "MISSING");
  assert.deepEqual(rows.find((row) => row.lineId === "line-b").admittedSourceIds, [parent.id]);
  parent.membershipCoverageEvidence.snapshotId = "foreign";
  assert.throws(build, /MOLIT membership coverage binding/);
});

function buildFixtureLedger({ targets, inventory, resolutions, expectedLaunchRequiredTotal = null }) {
  return buildNationwideCoverageTally({
    targets,
    inventory,
    resolutions,
    inputs: FIXTURE_INPUTS,
    expectedLaunchRequiredTotal,
  });
}

function requirementFor(ledger, operatorId, sourceDomain = "station_line_membership") {
  const tier = sourceDomain === "demand_reference" ? ledger.enhancement : ledger.launchRequired;
  return tier.requirements.find(
    (entry) => entry.operatorId === operatorId && entry.sourceDomain === sourceDomain,
  );
}

// tracked 입력 3종을 임시 workspace에 repo 상대 경로 그대로 복제한다. 도구를 그 workspace를 cwd로
// 실행하면 ledger가 기록하는 입력 경로는 tracked 산출물과 같으므로, 바이트 차이는 입력 내용 차이만 남는다.
async function stageWorkspace(mutate) {
  const workspace = await mkdtemp(path.join(tmpdir(), "coverage-tally-"));
  for (const relativePath of [...INPUT_PATHS, LEDGER_PATH]) {
    await mkdir(path.join(workspace, path.dirname(relativePath)), { recursive: true });
    await copyFile(path.join(root, relativePath), path.join(workspace, relativePath));
  }
  if (mutate) await mutate(workspace);
  return workspace;
}

async function regenerateLedger(
  workspace,
  {
    expectedLaunchRequiredTotal = EXPECTED_LAUNCH_REQUIRED_TOTAL,
    output = path.join(workspace, "ledger.json"),
  } = {},
) {
  await execFileAsync(process.execPath, [
    path.join(root, TOOL_PATH),
    "--targets", TARGETS_PATH,
    "--inventory", INVENTORY_PATH,
    "--resolutions", RESOLUTIONS_PATH,
    "--expected-launch-required-total", expectedLaunchRequiredTotal,
    "--output", output,
  ], { cwd: workspace });
  return readFile(output, "utf8");
}

async function assertNoLedgerTempResidue(output) {
  const prefix = `.${path.basename(output)}.`;
  const entries = await readdir(path.dirname(output));
  assert.deepEqual(entries.filter((entry) => entry.startsWith(prefix)), []);
}

// 출력이나 production 판정 함수를 사용하지 않는 입력 기반 참조 판정이다.
// 운영 합계 대신 정확한 PK별 상태까지 비교하여 합계가 같은 오분류도 검출한다.
function expectedLaunchRequirements({ targets, inventory, resolutions }) {
  const sources = inventory.sources.filter(({ rawSnapshotAdmission }) => rawSnapshotAdmission == null);
  const domains = targets.requiredSourceDomains.filter(({ releaseTier }) => releaseTier === "LAUNCH_REQUIRED");
  return targets.activeLineScopes.flatMap((scope) => domains.map((domain) => {
    const pk = [scope.regionId, scope.operatorId, scope.lineId, domain.id].join(":");
    const resolution = resolutions.entries.find((entry) =>
      [entry.regionId, entry.operatorId, entry.lineId, entry.sourceDomain].join(":") === pk);
    const covered = (ignoreOperator) => domain.requiredFields.filter((field) => sources.some((source) => {
      const coverage = source.coverageScope;
      return coverage.regionIds.includes(scope.regionId)
        && (ignoreOperator || coverage.operatorIds.includes(scope.operatorId))
        && (coverage.lineIds ?? []).includes(scope.lineId)
        && coverage.sourceDomains.includes(domain.id)
        && (source.fieldsProvided ?? source.fields).includes(field);
    })).length;
    const meetsThreshold = (count) => Number((count / domain.requiredFields.length).toFixed(4))
      >= (domain.blockingThreshold?.minimumOfficialFieldCoverageRatio ?? 1);
    if (meetsThreshold(covered(false))) {
      assert.equal(resolution, undefined, `admitted PK has resolution: ${pk}`);
      return { pk, status: "INVENTORY_ADMITTED", missingKind: null };
    }
    if (resolution && !resolution.supportStartedAt) {
      return { pk, status: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE", missingKind: null };
    }
    return { pk, status: "MISSING", missingKind: meetsThreshold(covered(true))
      ? "DUAL_OPERATOR_UNMATCHED" : "NO_ADMITTED_SOURCE" };
  }));
}

test("입력 기반 참조 판정은 독립적인 네 상태와 support-started 전이를 보존한다", () => {
  const targets = fixtureTargets();
  targets.activeLineScopes.push(
    { regionId: "capital", operatorId: "operator-c", lineId: "line-b" },
    { regionId: "capital", operatorId: "operator-d", lineId: "line-a" },
  );
  const inventory = fixtureInventory([operatorAMembershipSource()]);
  const resolutions = fixtureResolutions([fixtureResolutionEntry()]);
  const states = () => expectedLaunchRequirements({ targets, inventory, resolutions })
    .map(({ status, missingKind }) => [status, missingKind]);
  assert.deepEqual(states(), [
    ["INVENTORY_ADMITTED", null],
    ["EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE", null],
    ["MISSING", "NO_ADMITTED_SOURCE"],
    ["MISSING", "DUAL_OPERATOR_UNMATCHED"],
  ]);
  resolutions.entries[0].supportStartedAt = "2026-07-24T00:00:00.000Z";
  assert.deepEqual(states()[1], ["MISSING", "DUAL_OPERATOR_UNMATCHED"]);
  inventory.sources[0].rawSnapshotAdmission = {};
  assert.deepEqual(states(), Array.from({ length: 4 }, () => ["MISSING", "NO_ADMITTED_SOURCE"]));
});

test("CLI derives an omitted denominator from current target dimensions", async (context) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "coverage-tally-default-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const targets = fixtureTargets();
  await writeFile(path.join(workspace, "inventory.json"), JSON.stringify(fixtureInventory([operatorAMembershipSource()])));
  await writeFile(path.join(workspace, "resolutions.json"), JSON.stringify(fixtureResolutions()));
  const run = async (expected) => {
    await execFileAsync(process.execPath, [path.join(root, TOOL_PATH),
      "--targets", "targets.json", "--inventory", "inventory.json",
      "--resolutions", "resolutions.json", "--output", "ledger.json",
      ...(expected === undefined ? [] : ["--expected-launch-required-total", String(expected)]),
    ], { cwd: workspace });
    return readFile(path.join(workspace, "ledger.json"), "utf8");
  };
  for (const expected of [2, 3]) {
    if (expected === 3) targets.activeLineScopes.push({ lineId: "line-b", regionId: "capital", operatorId: "operator-a" });
    await writeFile(path.join(workspace, "targets.json"), JSON.stringify(targets));
    const derived = await run();
    assert.equal(JSON.parse(derived).denominator.expectedLaunchRequiredTotal, expected);
    assert.equal(derived, await run(expected));
  }
  await assert.rejects(run(2), /launch-required denominator drift/);
});

test("커밋된 전국 coverage tally ledger는 현행 입력에서 바이트 단위로 재생성된다", async () => {
  const workspace = await stageWorkspace();
  try {
    const stagedLedgerPath = path.join(workspace, LEDGER_PATH);
    const regenerated = await regenerateLedger(workspace, { output: stagedLedgerPath });
    const tracked = await readFile(path.join(root, LEDGER_PATH), "utf8");
    assert.equal(regenerated, tracked, "ledger는 재생성 결과와 바이트 단위로 같아야 한다");
    await assertNoLedgerTempResidue(stagedLedgerPath);

    const ledger = JSON.parse(tracked);
    assert.equal(ledger.artifactKind, "nationwide-coverage-tally-ledger");
    assert.equal(ledger.issue, 2507);
    assert.equal(ledger.regeneration.ledgerPath, LEDGER_PATH);
    assert.equal(
      ledger.regeneration.command,
      `node ${TOOL_PATH} --targets ${TARGETS_PATH} --inventory ${INVENTORY_PATH}`
        + ` --resolutions ${RESOLUTIONS_PATH}`
        + ` --expected-launch-required-total ${EXPECTED_LAUNCH_REQUIRED_TOTAL} --output ${LEDGER_PATH}`,
    );

    // targets/resolutions는 raw bytes, inventory는 consumed normalized projection이 drift 감지축이다.
    for (const [name, relativePath] of [
      ["targets", TARGETS_PATH],
      ["resolutions", RESOLUTIONS_PATH],
    ]) {
      assert.equal(ledger.inputs[name].path, relativePath);
      assert.equal(
        ledger.inputs[name].sha256,
        createHash("sha256").update(await readFile(path.join(root, relativePath))).digest("hex"),
      );
    }
    assert.equal(ledger.inputs.inventory.path, INVENTORY_PATH);
    assert.match(ledger.inputs.inventory.sha256, /^[a-f0-9]{64}$/u);
    assert.notEqual(
      ledger.inputs.inventory.sha256,
      createHash("sha256").update(await readFile(path.join(root, INVENTORY_PATH))).digest("hex"),
    );

    assert.deepEqual(ledger.denominator, {
      activeLineScopeCount: 45,
      activeLineCount: 36,
      launchRequiredDomainCount: 6,
      launchRequiredTotal: 270,
      enhancementDomainCount: 1,
      enhancementTotal: 45,
      expectedLaunchRequiredTotal: 270,
    });
    const [targets, inventory, resolutions] = await Promise.all(INPUT_PATHS.map(async (relativePath) =>
      JSON.parse(await readFile(path.join(root, relativePath), "utf8"))));
    const expected = expectedLaunchRequirements({ targets, inventory, resolutions });
    const actual = ledger.launchRequired.requirements.map((row) => ({
      pk: [row.regionId, row.operatorId, row.lineId, row.sourceDomain].join(":"),
      status: row.status, missingKind: row.missingKind,
    }));
    const byPk = (a, b) => a.pk < b.pk ? -1 : a.pk > b.pk ? 1 : 0;
    assert.deepEqual(actual.sort(byPk), expected.sort(byPk));
    const admittedCount = expected.filter(({ status }) => status === "INVENTORY_ADMITTED").length;
    const missing = expected.filter(({ status }) => status === "MISSING");
    assert.equal(ledger.launchRequired.totalCount, 270);
    assert.equal(ledger.launchRequired.inventoryAdmittedCount, admittedCount);
    assert.equal(ledger.launchRequired.explicitlyUnsupportedWithEvidenceCount, 4);
    assert.equal(ledger.launchRequired.missingCount, missing.length);
    assert.deepEqual(ledger.launchRequired.missingByKind, {
      DUAL_OPERATOR_UNMATCHED: missing.filter(({ missingKind }) => missingKind === "DUAL_OPERATOR_UNMATCHED").length,
      NO_ADMITTED_SOURCE: missing.filter(({ missingKind }) => missingKind === "NO_ADMITTED_SOURCE").length,
    });
    assert.equal(ledger.launchRequired.terminalCount, expected.length - missing.length);
    assert.equal(ledger.launchRequired.supportStartedResolutionCount, 0);
    assert.equal(ledger.launchRequired.earliestResolutionNextReviewAt, "2026-10-23T09:12:39.105Z");
    assert.equal(ledger.launchRequired.requirements.length, 270);
    assert.equal(ledger.enhancement.totalCount, 45);
    assert.equal(ledger.enhancement.earliestResolutionNextReviewAt, null);
    assert.equal(ledger.enhancement.requirements.length, 45);

    // 서울 1~8호선은 v2 admission 전 inventory tally에서도 MISSING이다. historical diagnostic 행은
    // line scope를 claim하지 않으며, 이 상태를 candidate gate와 같은 방향으로 고정한다.
    const pilot = ledger.launchRequired.requirements.find((entry) =>
      entry.regionId === "capital"
      && entry.operatorId === "seoul-metro"
      && entry.lineId === "seoul-4"
      && entry.sourceDomain === "route_map_positions");
    assert.equal(pilot.status, "MISSING");
    assert.deepEqual(pilot.admittedSourceIds, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("targets와 resolutions raw bytes가 바뀌면 ledger 재생성 없이는 tracked 바이트와 어긋난다", async (context) => {
  const tracked = await readFile(path.join(root, LEDGER_PATH), "utf8");
  for (const relativePath of [TARGETS_PATH, RESOLUTIONS_PATH]) {
    await context.test(relativePath, async () => {
      const workspace = await stageWorkspace(async (dir) => {
        await appendFile(path.join(dir, relativePath), "\n");
      });
      try {
        assert.notEqual(await regenerateLedger(workspace), tracked);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }
});

test("inventory digest는 tally가 소비하는 normalized coverage projection에만 결속한다", async () => {
  const tracked = await readFile(path.join(root, LEDGER_PATH), "utf8");
  const metadataOnly = await stageWorkspace(async (dir) => {
    const target = path.join(dir, INVENTORY_PATH);
    const inventory = JSON.parse(await readFile(target, "utf8"));
    const source = inventory.sources.find(({ coverageScope }) =>
      coverageScope?.sourceDomains?.includes("station_line_membership")
      && Array.isArray(coverageScope.lineIds)
      && coverageScope.lineIds.length > 0);
    assert.ok(source);
    source.displayName = `${source.displayName} `;
    source.fieldsProvided.reverse();
    for (const key of ["regionIds", "operatorIds", "lineIds", "sourceDomains"]) {
      source.coverageScope[key]?.reverse();
    }
    await writeFile(target, `${JSON.stringify(inventory, null, 2)}\n\n`);
  });
  try {
    assert.equal(await regenerateLedger(metadataOnly), tracked);
  } finally {
    await rm(metadataOnly, { recursive: true, force: true });
  }

  const consumedCoverage = await stageWorkspace(async (dir) => {
    const target = path.join(dir, INVENTORY_PATH);
    const inventory = JSON.parse(await readFile(target, "utf8"));
    const source = inventory.sources.find(({ coverageScope }) =>
      coverageScope?.sourceDomains?.includes("station_line_membership")
      && Array.isArray(coverageScope.lineIds)
      && coverageScope.lineIds.length > 0);
    assert.ok(source);
    source.fieldsProvided = source.fieldsProvided.filter((field) => field !== "station_code");
    await writeFile(target, `${JSON.stringify(inventory, null, 2)}\n`);
  });
  try {
    assert.notEqual(await regenerateLedger(consumedCoverage), tracked);
  } finally {
    await rm(consumedCoverage, { recursive: true, force: true });
  }
});

test("분모 drift는 fail closed다", async (context) => {
  await context.test("활성 노선 scope 중복", () => {
    const targets = fixtureTargets({
      activeLineScopes: [
        { lineId: "line-a", regionId: "capital", operatorId: "operator-a" },
        { lineId: "line-a", regionId: "capital", operatorId: "operator-a" },
      ],
    });
    assert.throws(
      () => buildFixtureLedger({
        targets,
        inventory: fixtureInventory([operatorAMembershipSource()]),
        resolutions: fixtureResolutions(),
      }),
      /duplicate active line scope: capital:operator-a:line-a/,
    );
  });

  await context.test("기대 분모 불일치", () => {
    assert.throws(
      () => buildFixtureLedger({
        targets: fixtureTargets(),
        inventory: fixtureInventory([operatorAMembershipSource()]),
        resolutions: fixtureResolutions(),
        expectedLaunchRequiredTotal: 3,
      }),
      /launch-required denominator drift: expected 3, computed 2/,
    );
  });

  await context.test("실제 입력에서 270이 아닌 기대값은 CLI가 거부한다", async () => {
    const workspace = await stageWorkspace();
    try {
      await assert.rejects(
        regenerateLedger(workspace, { expectedLaunchRequiredTotal: "269" }),
        (error) => /launch-required denominator drift: expected 269, computed 270/.test(error.stderr),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

test("generator 또는 분모 실패는 tracked ledger를 변경하지 않는다", async (context) => {
  await context.test("잘못된 입력으로 generator가 실패해도", async () => {
    const workspace = await stageWorkspace(async (dir) => {
      await writeFile(path.join(dir, INVENTORY_PATH), "{");
    });
    try {
      const stagedLedgerPath = path.join(workspace, LEDGER_PATH);
      const before = await readFile(stagedLedgerPath, "utf8");
      await assert.rejects(regenerateLedger(workspace, { output: stagedLedgerPath }));
      assert.equal(await readFile(stagedLedgerPath, "utf8"), before);
      await assertNoLedgerTempResidue(stagedLedgerPath);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await context.test("분모가 일치하지 않아 generator가 실패해도", async () => {
    const workspace = await stageWorkspace();
    try {
      const stagedLedgerPath = path.join(workspace, LEDGER_PATH);
      const before = await readFile(stagedLedgerPath, "utf8");
      await assert.rejects(
        regenerateLedger(workspace, {
          expectedLaunchRequiredTotal: "269",
          output: stagedLedgerPath,
        }),
        (error) => /launch-required denominator drift: expected 269, computed 270/.test(error.stderr),
      );
      assert.equal(await readFile(stagedLedgerPath, "utf8"), before);
      await assertNoLedgerTempResidue(stagedLedgerPath);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await context.test("temp write 후 rename이 실패해도 residue를 남기지 않는다", async () => {
    const workspace = await stageWorkspace();
    const blockedOutput = path.join(workspace, "protected-ledger");
    const sentinel = path.join(blockedOutput, "keep.txt");
    await mkdir(blockedOutput);
    await writeFile(sentinel, "keep\n");
    try {
      await assert.rejects(regenerateLedger(workspace, { output: blockedOutput }));
      assert.equal(await readFile(sentinel, "utf8"), "keep\n");
      assert.deepEqual(await readdir(blockedOutput), ["keep.txt"]);
      await assertNoLedgerTempResidue(blockedOutput);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

test("dual-operator 미매칭은 MISSING 하위 구분으로 가시화된다", () => {
  const ledger = buildFixtureLedger({
    targets: fixtureTargets(),
    inventory: fixtureInventory([operatorAMembershipSource()]),
    resolutions: fixtureResolutions(),
  });

  const admitted = requirementFor(ledger, "operator-a");
  assert.equal(admitted.status, "INVENTORY_ADMITTED");
  assert.deepEqual(admitted.admittedSourceIds, ["operator-a-membership"]);
  assert.equal(admitted.dualOperator, null);

  const unmatched = requirementFor(ledger, "operator-b");
  assert.equal(unmatched.status, "MISSING");
  assert.equal(unmatched.missingKind, "DUAL_OPERATOR_UNMATCHED");
  assert.deepEqual(unmatched.dualOperator, {
    coveringOperatorIds: ["operator-a"],
    coveringSourceIds: ["operator-a-membership"],
  });
  assert.deepEqual(ledger.launchRequired.missingByKind, {
    DUAL_OPERATOR_UNMATCHED: 1,
    NO_ADMITTED_SOURCE: 0,
  });
});

test("route_graph_topology는 distance 없이 edge와 time을 제공하는 scoped source를 admit한다", async () => {
  const canonicalTargets = JSON.parse(await readFile(path.join(root, TARGETS_PATH), "utf8"));
  const topologyDomain = canonicalTargets.requiredSourceDomains.find(
    ({ id }) => id === "route_graph_topology",
  );
  assert.ok(topologyDomain, "canonical targets must define route_graph_topology");

  const targets = fixtureTargets({ requiredSourceDomains: [topologyDomain] });
  const topologySource = {
    id: "topology-edge-time",
    coverageScope: {
      regionIds: ["capital"],
      operatorIds: ["operator-a"],
      lineIds: ["line-a"],
      sourceDomains: ["route_graph_topology"],
    },
    fieldsProvided: ["network_edges", "duration_seconds"],
  };

  const admitted = requirementFor(
    buildFixtureLedger({
      targets,
      inventory: fixtureInventory([topologySource]),
      resolutions: fixtureResolutions(),
    }),
    "operator-a",
    "route_graph_topology",
  );
  assert.equal(admitted.status, "INVENTORY_ADMITTED");
  assert.deepEqual(admitted.admittedSourceIds, ["topology-edge-time"]);

  for (const missingField of ["network_edges", "duration_seconds"]) {
    const requirement = requirementFor(
      buildFixtureLedger({
        targets,
        inventory: fixtureInventory([{
          ...topologySource,
          fieldsProvided: topologySource.fieldsProvided.filter((field) => field !== missingField),
        }]),
        resolutions: fixtureResolutions(),
      }),
      "operator-a",
      "route_graph_topology",
    );
    assert.equal(requirement.status, "MISSING", `missing ${missingField} must not be admitted`);
    assert.equal(requirement.missingKind, "NO_ADMITTED_SOURCE");
  }
});

test("admitted Seoul derived route-map coverage", () => {
  const routeMapFields = ["route_map_position", "route_map_label_polygon"];
  const seoulLineIds = [
    "line-472a81add377", "seoul-2", "line-41a8c75ec9d8", "seoul-4",
    "line-80fc4d5350d4", "line-3f41718e0833", "line-15b3b8a93259", "line-2b2d9eaa53d0",
  ];
  const targets = fixtureTargets({
    requiredSourceDomains: [{
      id: "route_map_positions",
      releaseTier: "LAUNCH_REQUIRED",
      requiredFields: routeMapFields,
      blockingThreshold: { minimumOfficialFieldCoverageRatio: 1 },
    }],
    activeLineScopes: seoulLineIds.map((lineId) => ({
      lineId, regionId: "capital", operatorId: "seoul-metro",
    })),
    regions: [{ id: "capital", displayName: "수도권", operatorIds: ["seoul-metro"] }],
  });
  const admittedSource = {
    id: "seoul-metro-route-map-positions",
    coverageScope: {
      regionIds: ["capital"],
      operatorIds: ["seoul-metro"],
      lineIds: seoulLineIds,
      sourceDomains: ["route_map_positions"],
    },
    fieldsProvided: ["line", "station_code", "station_name", "latitude", "longitude", "basis_date"],
    productDerivedFields: ["route_map_position", "route_map_label_polygon", "route_map_line_track"],
    routeMapAdmissionEvidence: {
      currentLayoutAdmission: {
        schemaVersion: 2,
        artifactKind: "seoul-public-route-map-layout-admission",
        status: "ADMITTED",
        positionSnapshotId: "admitted-layout-snapshot",
        layoutArtifactSha256: "a".repeat(64),
      },
    },
  };

  const admitted = buildFixtureLedger({
    targets,
    inventory: fixtureInventory([admittedSource]),
    resolutions: fixtureResolutions(),
  });
  assert.ok(admitted.launchRequired.requirements.every(({ status }) => status === "INVENTORY_ADMITTED"));

  const missing = buildFixtureLedger({
    targets,
    inventory: fixtureInventory([{
      ...admittedSource,
      routeMapAdmissionEvidence: {
        currentLayoutAdmission: {
          ...admittedSource.routeMapAdmissionEvidence.currentLayoutAdmission,
          status: "REJECTED",
        },
      },
    }]),
    resolutions: fixtureResolutions(),
  });
  assert.ok(missing.launchRequired.requirements.every(({ status, missingKind }) =>
    status === "MISSING" && missingKind === "NO_ADMITTED_SOURCE"));
});

test("빈 lineIds coverageScope는 와일드카드가 아니다", () => {
  const source = operatorAMembershipSource();
  delete source.coverageScope.lineIds;
  const ledger = buildFixtureLedger({
    targets: fixtureTargets(),
    inventory: fixtureInventory([source]),
    resolutions: fixtureResolutions(),
  });

  assert.equal(ledger.launchRequired.inventoryAdmittedCount, 0);
  assert.deepEqual(ledger.launchRequired.missingByKind, {
    DUAL_OPERATOR_UNMATCHED: 0,
    NO_ADMITTED_SOURCE: 2,
  });
});

test("coverageScope의 unknown id는 조용한 미매칭이 아니라 fail closed다", async (context) => {
  const unknownScopes = [
    ["region", { regionIds: ["capitol"] }, /coverageScope.regionIds contains undefined region: capitol/],
    ["operator", { operatorIds: ["operator-zz"] }, /coverageScope.operatorIds contains undefined operator: operator-zz/],
    ["line", { lineIds: ["line-zz"] }, /coverageScope.lineIds contains undefined line: line-zz/],
    [
      "source domain",
      { sourceDomains: ["station_line_membershop"] },
      /coverageScope.sourceDomains contains undefined source domain: station_line_membershop/,
    ],
  ];
  for (const [name, override, expected] of unknownScopes) {
    await context.test(name, () => {
      const source = operatorAMembershipSource();
      Object.assign(source.coverageScope, override);
      assert.throws(
        () => buildFixtureLedger({
          targets: fixtureTargets(),
          inventory: fixtureInventory([source]),
          resolutions: fixtureResolutions(),
        }),
        expected,
      );
    });
  }

  await context.test("targets가 아는 id는 통과한다", () => {
    const source = operatorAMembershipSource();
    source.coverageScope.regionIds = ["capital"];
    const ledger = buildFixtureLedger({
      targets: fixtureTargets(),
      inventory: fixtureInventory([source]),
      resolutions: fixtureResolutions(),
    });
    assert.equal(ledger.launchRequired.inventoryAdmittedCount, 1);
  });
});

test("resolutions는 EXPLICITLY_UNSUPPORTED 정본이며 계약 위반은 fail closed다", async (context) => {
  const inventory = fixtureInventory([operatorAMembershipSource()]);

  await context.test("정본 entry는 MISSING을 terminal 상태로 바꾼다", () => {
    const ledger = buildFixtureLedger({
      targets: fixtureTargets(),
      inventory,
      resolutions: fixtureResolutions([fixtureResolutionEntry()]),
    });
    const resolved = requirementFor(ledger, "operator-b");
    assert.equal(resolved.status, "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE");
    assert.equal(resolved.resolution.reasonCode, "PUBLIC_API_NO_DATA");
    assert.equal(resolved.resolutionReviewStatus, "CURRENT");
    assert.equal(resolved.missingKind, null);
    assert.equal(ledger.launchRequired.terminalCount, 2);
    assert.equal(ledger.launchRequired.missingCount, 0);
    assert.equal(ledger.launchRequired.earliestResolutionNextReviewAt, "2026-10-19T02:43:09.257Z");
  });

  // 게이트(report-coverage-gaps.mjs)는 supportStartedAt이 있으면 EU 전이를 취소한다. 같은 판정을 유지한다.
  await context.test("supportStartedAt entry는 terminal에서 제외된다", () => {
    const ledger = buildFixtureLedger({
      targets: fixtureTargets(),
      inventory,
      resolutions: fixtureResolutions([
        fixtureResolutionEntry({ supportStartedAt: "2026-07-24T00:00:00.000Z" }),
      ]),
    });
    const entry = requirementFor(ledger, "operator-b");
    assert.equal(entry.status, "MISSING");
    assert.equal(entry.resolutionReviewStatus, "SUPPORT_STARTED");
    assert.equal(entry.missingKind, "DUAL_OPERATOR_UNMATCHED");
    assert.equal(entry.resolution.supportStartedAt, "2026-07-24T00:00:00.000Z");
    assert.equal(ledger.launchRequired.explicitlyUnsupportedWithEvidenceCount, 0);
    assert.equal(ledger.launchRequired.supportStartedResolutionCount, 1);
    assert.equal(ledger.launchRequired.terminalCount, 1);
    assert.equal(ledger.launchRequired.earliestResolutionNextReviewAt, null);
  });

  const rejections = [
    [
      "admitted requirement 충돌",
      fixtureResolutions([fixtureResolutionEntry({ operatorId: "operator-a" })]),
      /inventory-admitted requirement must not have an unsupported resolution/,
    ],
    [
      "requirement 공간 밖 entry",
      fixtureResolutions([fixtureResolutionEntry({ operatorId: "operator-z" })]),
      /unknown coverage resolution requirement/,
    ],
    [
      "중복 entry",
      fixtureResolutions([fixtureResolutionEntry(), fixtureResolutionEntry()]),
      /duplicate coverage resolution/,
    ],
    [
      "targetVersion 불일치",
      { ...fixtureResolutions(), targetVersion: "2026-01-01" },
      /coverage resolutions targetVersion must match coverage targets/,
    ],
    [
      "state 위반",
      fixtureResolutions([fixtureResolutionEntry({ state: "SUPPORTED" })]),
      /state is invalid: SUPPORTED/,
    ],
    [
      "reasonCode allowlist 위반",
      fixtureResolutions([fixtureResolutionEntry({ reasonCode: "WHATEVER" })]),
      /reasonCode must be PUBLIC_API_NO_DATA: WHATEVER/,
    ],
    [
      "fallback allowlist 위반",
      fixtureResolutions([fixtureResolutionEntry({ fallback: "SOMETHING_ELSE" })]),
      /fallback is invalid: SOMETHING_ELSE/,
    ],
    [
      "evidenceHash 형식 위반",
      fixtureResolutions([fixtureResolutionEntry({ evidenceHash: "zz" })]),
      /evidenceHash must be sha256 hex/,
    ],
    [
      "nextReviewAt ISO instant 위반",
      fixtureResolutions([fixtureResolutionEntry({ nextReviewAt: "2026-10-19" })]),
      /nextReviewAt must be a canonical UTC instant/,
    ],
  ];
  for (const [name, resolutions, expected] of rejections) {
    await context.test(name, () => {
      assert.throws(
        () => buildFixtureLedger({ targets: fixtureTargets(), inventory, resolutions }),
        expected,
      );
    });
  }
});

test("ENHANCEMENT tier는 LAUNCH_REQUIRED 집계와 분리 보고된다", () => {
  const demandSource = {
    id: "operator-a-demand",
    coverageScope: {
      regionIds: ["capital"],
      operatorIds: ["operator-a"],
      lineIds: ["line-a"],
      sourceDomains: ["demand_reference"],
    },
    fieldsProvided: ["hourly_boarding_count"],
  };
  const ledger = buildFixtureLedger({
    targets: fixtureTargets(),
    inventory: fixtureInventory([operatorAMembershipSource(), demandSource]),
    resolutions: fixtureResolutions(),
  });

  assert.equal(ledger.denominator.launchRequiredTotal, 2);
  assert.equal(ledger.denominator.enhancementTotal, 2);
  assert.equal(ledger.launchRequired.totalCount, 2);
  assert.equal(ledger.launchRequired.inventoryAdmittedCount, 1);
  assert.ok(ledger.launchRequired.requirements.every((entry) => entry.releaseTier === "LAUNCH_REQUIRED"));
  assert.equal(ledger.enhancement.totalCount, 2);
  assert.equal(ledger.enhancement.inventoryAdmittedCount, 1);
  assert.ok(ledger.enhancement.requirements.every((entry) => entry.releaseTier === "ENHANCEMENT"));
  assert.equal(requirementFor(ledger, "operator-a", "demand_reference").status, "INVENTORY_ADMITTED");
});

test("tally 산출물은 wall-clock을 쓰지 않고 결정적이다", async () => {
  const source = await readFile(path.join(root, TOOL_PATH), "utf8");
  const code = source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  assert.doesNotMatch(
    code,
    /Date\.now\(|Date\.UTC\(|new Date\(|performance\.now\(|process\.hrtime|Math\.random\(/,
    "산출물 값은 입력에서만 유도해야 한다",
  );

  const build = () => buildFixtureLedger({
    targets: fixtureTargets(),
    inventory: fixtureInventory([operatorAMembershipSource()]),
    resolutions: fixtureResolutions([fixtureResolutionEntry()]),
  });
  assert.equal(JSON.stringify(build()), JSON.stringify(build()));

  // 알 수 없는 인자는 조용히 기본값으로 흐르지 않고 거부돼야 한다(오타로 다른 resolutions를 읽는 사고 방지).
  const workspace = await mkdtemp(path.join(tmpdir(), "coverage-tally-args-"));
  try {
    await writeFile(path.join(workspace, "targets.json"), JSON.stringify(fixtureTargets()));
    await assert.rejects(
      execFileAsync(process.execPath, [
        path.join(root, TOOL_PATH),
        "--targets", path.join(workspace, "targets.json"),
        "--inventory", path.join(root, INVENTORY_PATH),
        "--resolution", path.join(root, RESOLUTIONS_PATH),
        "--output", path.join(workspace, "ledger.json"),
      ], { cwd: root }),
      (error) => /unexpected argument: --resolution/.test(error.stderr),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
