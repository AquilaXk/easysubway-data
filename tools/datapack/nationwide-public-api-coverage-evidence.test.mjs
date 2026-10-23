import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BUILTIN_KNOWN_PROVIDER_CANDIDATES } from "./collect-nationwide-public-api-coverage.mjs";
import { RETIRED_KRIC_ACCESSIBILITY_SOURCE_IDS } from "./lib/retired-sources.mjs";
import { COVERAGE_REVIEW_NOW } from "./test-fixtures/coverage-review-clock.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const planPath = "tools/datapack/release/nationwide-public-api-coverage-search-plan-20260725.json";
const resolutionsPath = "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json";
const ledgerPath = "tools/datapack/reports/nationwide-coverage-tally.json";

const requirementKey = ({ regionId, operatorId, lineId, sourceDomain }) =>
  `${regionId}:${operatorId}:${lineId}:${sourceDomain}`;

function assertTrackedFollowup(requirement, ownerRules) {
  const keys = ["regionId", "operatorId", "lineId", "sourceDomain"];
  const candidates = ownerRules.filter((rule) => keys.every((key) =>
    rule[key] === undefined || rule[key] === requirement[key]));
  const specificity = (rule) => keys.filter((key) => rule[key] !== undefined).length;
  const maximum = Math.max(...candidates.map(specificity));
  const owners = candidates.filter((rule) => specificity(rule) === maximum);
  assert.equal(owners.length, 1, `${requirementKey(requirement)}: missing or ambiguous owner`);
  assert.ok(Number.isInteger(owners[0].issue) && owners[0].issue > 0, "invalid owner issue");
}

// 검색 계획과 결과가 이름 붙이는 후보 provider는 지금 존재하는 후보여야 한다. 퇴역한 원천이 근거처럼 읽히면 안 된다.
test("검색 계획과 결과의 provider 후보 id는 현행 source candidate이거나 내장 후보다", async () => {
  const [plan, resolutions, candidates] = await Promise.all([
    readFile(path.join(root, planPath), "utf8").then(JSON.parse),
    readFile(path.join(root, resolutionsPath), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
  ]);
  const known = new Set([
    ...candidates.candidates.map(({ id }) => id),
    ...Object.values(BUILTIN_KNOWN_PROVIDER_CANDIDATES).flat().map(({ id }) => id),
  ]);
  const named = [
    ...plan.entries.flatMap(({ knownProviderCandidateIds }) => knownProviderCandidateIds),
    ...resolutions.unresolved.flatMap(({ providerCandidateIds = [] }) => providerCandidateIds),
  ];
  assert.ok(named.length > 0);
  assert.deepEqual([...new Set(named)].filter((id) => !known.has(id)), []);
  assert.deepEqual(named.filter((id) => RETIRED_KRIC_ACCESSIBILITY_SOURCE_IDS.includes(id)), []);
});

test("과거 검색 밖의 결측은 유일한 현행 담당 이슈가 있어야 한다", () => {
  const row = { regionId: "region", operatorId: "operator", lineId: "line", sourceDomain: "map" };
  const generic = { sourceDomain: "map", issue: 1 };
  const specific = { regionId: "region", sourceDomain: "map", issue: 2 };
  assert.doesNotThrow(() => assertTrackedFollowup(row, [generic, specific]));
  assert.throws(() => assertTrackedFollowup(row, []), /missing or ambiguous owner/);
  assert.throws(() => assertTrackedFollowup(row, [{ sourceDomain: "other", issue: 1 }]), /missing or ambiguous owner/);
  assert.throws(() => assertTrackedFollowup(row, [specific, { ...specific, issue: 3 }]), /missing or ambiguous owner/);
  assert.throws(() => assertTrackedFollowup(row, [{ ...specific, issue: 0 }]), /invalid owner issue/);
});

test("전국 공공데이터 재감사는 4건만 공식 미지원으로 닫고 183건은 MISSING으로 재개방한다", async () => {
  const plan = JSON.parse(await readFile(path.join(root, planPath), "utf8"));
  const resolutionsText = await readFile(path.join(root, resolutionsPath), "utf8");
  const resolutions = JSON.parse(resolutionsText);

  assert.equal(plan.entries.length, 187);
  const korailEntries = plan.entries.filter(({ operatorId }) => operatorId === "korail");
  assert.equal(korailEntries.length, 55);
  assert.ok(korailEntries.every(({ queries }) => queries.every(
    ({ query }) => query.organizations[0] === "한국철도공사",
  )));
  assert.equal(resolutions.entries.length, 4);
  assert.equal(resolutions.unresolved.length, 183);
  assert.deepEqual(
    Object.fromEntries(Object.entries(Object.groupBy(resolutions.entries, ({ sourceDomain }) => sourceDomain))
      .map(([domain, entries]) => [domain, entries.length])),
    { realtime_arrivals: 4 },
  );
  assert.doesNotMatch(resolutionsText, /"(?:serviceKey|secret|token)"\s*:/i);
  assert.doesNotMatch(resolutionsText, /Infuser\s+/i);

  // 과거 검색과 그 결과의 hash 결속은 보존한다. 이후 발생한 결측은 현행 담당 이슈로
  // 추적하며, 이 배정은 admission이나 검색 완료의 증거가 아니다.
  const ledger = JSON.parse(await readFile(path.join(root, ledgerPath), "utf8"));
  const planKeys = new Set(plan.entries.map(requirementKey));
  const admittedKeys = new Set(
    ledger.launchRequired.requirements
      .filter(({ status }) => status === "INVENTORY_ADMITTED")
      .map(requirementKey),
  );
  assert.equal(admittedKeys.size, ledger.launchRequired.inventoryAdmittedCount);
  const ownership = JSON.parse(await readFile(path.join(root,
    "tools/datapack/release/nationwide-requirement-ownership.json"), "utf8"));
  assert.equal(ownership.targetVersion, ledger.targetVersion);
  for (const requirement of ledger.launchRequired.requirements) {
    if (requirement.status === "INVENTORY_ADMITTED" || planKeys.has(requirementKey(requirement))) continue;
    assert.equal(requirement.status, "MISSING", "official unsupported evidence must remain in the historical plan");
    assertTrackedFollowup(requirement, ownership.ownerRules);
  }
  // 공식 미지원 판정과 admission은 서로 반대 주장이므로 한 requirement에 겹치면 fail closed다.
  assert.deepEqual(
    resolutions.entries.map(requirementKey).filter((key) => admittedKeys.has(key)),
    [],
  );

  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-2138-coverage-"));
  const outputPath = path.join(outputDir, "report.json");
  try {
    await execFileAsync(process.execPath, [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets", "tools/datapack/nationwide-coverage-targets.json",
      "--inventory", "tools/datapack/source-inventory.json",
      "--resolution-plan", planPath,
      "--resolutions", resolutionsPath,
      "--now", COVERAGE_REVIEW_NOW,
      "--output", outputPath,
      "--allow-gaps",
    ], { cwd: root });

    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.summary.launchRequired.totalCount, 270);
    assert.equal(report.summary.launchRequired.explicitlyUnsupportedCount, 4);
    assert.equal(report.summary.launchRequired.missingCount, 266);
    assert.equal(report.summary.launchRequired.terminalResolutionRatio, 0.0148);

    const workflow = await readFile(path.join(root, ".github/workflows/datapack-release.yml"), "utf8");
    assert.match(workflow, /--resolution-plan tools\/datapack\/release\/nationwide-public-api-coverage-search-plan-20260725\.json/);
    assert.match(workflow, /--resolutions tools\/datapack\/release\/nationwide-public-api-coverage-resolutions-20260725\.json/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

async function coverageReportAt(now) {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-2138-review-clock-"));
  const outputPath = path.join(outputDir, "report.json");
  try {
    await execFileAsync(process.execPath, [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets", "tools/datapack/nationwide-coverage-targets.json",
      "--inventory", "tools/datapack/source-inventory.json",
      "--resolution-plan", planPath,
      "--resolutions", resolutionsPath,
      "--now", now,
      "--output", outputPath,
      "--allow-gaps",
    ], { cwd: root });
    return JSON.parse(await readFile(outputPath, "utf8"));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

// 실제 resolutions 문서의 만료 경계를 고정한다. 평가 시각을 문서의 nextReviewAt에서 유도하므로 재검토로 문서가 갱신돼도 같은 성질을 검증한다.
test("실제 공식 미지원 resolutions는 모든 nextReviewAt 직전까지 terminal이고 만료 시각부터 전부 MISSING이다", async () => {
  const { entries } = JSON.parse(await readFile(path.join(root, resolutionsPath), "utf8"));
  const dueAt = entries.map(({ nextReviewAt }) => Date.parse(nextReviewAt));
  const earliest = Math.min(...dueAt);
  const latest = Math.max(...dueAt);

  const beforeAnyDue = await coverageReportAt(new Date(earliest - 1).toISOString());
  assert.equal(beforeAnyDue.summary.launchRequired.explicitlyUnsupportedCount, entries.length);
  assert.equal(beforeAnyDue.requirements.filter(({ resolutionReviewStatus }) => resolutionReviewStatus === "EXPIRED").length, 0);

  const afterAllDue = await coverageReportAt(new Date(latest).toISOString());
  assert.equal(afterAllDue.summary.launchRequired.explicitlyUnsupportedCount, 0);
  assert.deepEqual(
    afterAllDue.requirements.filter(({ resolutionReviewStatus }) => resolutionReviewStatus === "EXPIRED")
      .map(requirementKey).sort(),
    entries.map(requirementKey).sort(),
  );
});

// 실제 resolutions 문서를 쓰는 테스트가 실행 시각을 읽으면 문서의 nextReviewAt이 지나는 순간 기준선이 깨진다(2026-10-23 main CI 실패).
test("실제 resolutions 문서로 coverage gate를 실행하는 테스트는 평가 시각을 고정한다", async () => {
  const names = (await readdir(path.join(root, "tools/datapack"))).filter((name) => name.endsWith(".test.mjs"));
  const unpinned = [];
  for (const name of names) {
    const text = await readFile(path.join(root, "tools/datapack", name), "utf8");
    if (text.includes("nationwide-public-api-coverage-resolutions-") && text.includes('"tools/datapack/report-coverage-gaps.mjs"')
      && !text.includes('"--now"')) {
      unpinned.push(name);
    }
  }
  assert.deepEqual(unpinned, []);
});
