import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const RESOLUTIONS_PATH = "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260721.json";
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
  for (const relativePath of INPUT_PATHS) {
    await mkdir(path.join(workspace, path.dirname(relativePath)), { recursive: true });
    await copyFile(path.join(root, relativePath), path.join(workspace, relativePath));
  }
  if (mutate) await mutate(workspace);
  return workspace;
}

async function regenerateLedger(workspace, expectedLaunchRequiredTotal = EXPECTED_LAUNCH_REQUIRED_TOTAL) {
  const output = path.join(workspace, "ledger.json");
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

test("커밋된 전국 coverage tally ledger는 현행 입력에서 바이트 단위로 재생성된다", async () => {
  const workspace = await stageWorkspace();
  try {
    const regenerated = await regenerateLedger(workspace);
    const tracked = await readFile(path.join(root, LEDGER_PATH), "utf8");
    assert.equal(regenerated, tracked, "ledger는 재생성 결과와 바이트 단위로 같아야 한다");

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

    // 기록된 입력 해시는 tracked 입력 파일의 실제 해시여야 한다(입력 drift 감지축).
    for (const [name, relativePath] of [
      ["targets", TARGETS_PATH],
      ["inventory", INVENTORY_PATH],
      ["resolutions", RESOLUTIONS_PATH],
    ]) {
      assert.equal(ledger.inputs[name].path, relativePath);
      assert.equal(
        ledger.inputs[name].sha256,
        createHash("sha256").update(await readFile(path.join(root, relativePath))).digest("hex"),
      );
    }

    assert.deepEqual(ledger.denominator, {
      activeLineScopeCount: 45,
      activeLineCount: 36,
      launchRequiredDomainCount: 6,
      launchRequiredTotal: 270,
      enhancementDomainCount: 1,
      enhancementTotal: 45,
      expectedLaunchRequiredTotal: 270,
    });
    // 아래 집계 상수는 tracked ledger와 짝을 이루는 이중 장부다. targets·inventory·resolutions를 바꾸는
    // 후속 #2138 admission PR은 (1) ledger.regeneration.command로 ledger를 재생성하고 (2) 이 상수를
    // 같은 커밋에서 함께 갱신해야 한다. 둘 중 하나만 하면 이 테스트가 fail closed 된다.
    assert.equal(ledger.launchRequired.totalCount, 270);
    assert.equal(ledger.launchRequired.inventoryAdmittedCount, 83);
    assert.equal(ledger.launchRequired.explicitlyUnsupportedWithEvidenceCount, 4);
    assert.equal(ledger.launchRequired.missingCount, 183);
    assert.deepEqual(ledger.launchRequired.missingByKind, {
      DUAL_OPERATOR_UNMATCHED: 9,
      NO_ADMITTED_SOURCE: 174,
    });
    assert.equal(ledger.launchRequired.terminalCount, 87);
    assert.equal(ledger.launchRequired.supportStartedResolutionCount, 0);
    assert.equal(ledger.launchRequired.earliestResolutionNextReviewAt, "2026-10-19T02:43:09.257Z");
    assert.equal(ledger.launchRequired.requirements.length, 270);
    assert.equal(ledger.enhancement.totalCount, 45);
    assert.equal(ledger.enhancement.earliestResolutionNextReviewAt, null);
    assert.equal(ledger.enhancement.requirements.length, 45);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("입력 3종이 바뀌면 ledger 재생성 없이는 tracked 바이트와 어긋난다", async (context) => {
  const tracked = await readFile(path.join(root, LEDGER_PATH), "utf8");
  for (const relativePath of INPUT_PATHS) {
    await context.test(relativePath, async () => {
      // 의미가 같은 공백 한 바이트만 바꿔도 입력 해시가 달라져 ledger 재생성이 강제돼야 한다.
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
        regenerateLedger(workspace, "269"),
        (error) => /launch-required denominator drift: expected 269, computed 270/.test(error.stderr),
      );
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
