import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
