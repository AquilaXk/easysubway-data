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

const DEFERRED_CANDIDATE_ARTIFACT_REQUIREMENT_KEYS = Object.freeze([
  "line-472a81add377", "seoul-2", "line-41a8c75ec9d8", "seoul-4",
  "line-80fc4d5350d4", "line-3f41718e0833", "line-15b3b8a93259", "line-2b2d9eaa53d0",
].map((lineId) => `capital:seoul-metro:${lineId}:route_map_positions`));

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

  // 재크롤 계획은 tally ledger의 미admission requirement를 전부 덮어야 한다(포함 관계). 덮지 못한
  // requirement는 재크롤 대상에서 사라져 우선순위 산정에서 누락되므로 fail closed다. 반대로 이미
  // 입고된 requirement가 계획에 남는 것은 허용한다 — 정확일치를 요구하면 admission 배치마다 계획
  // 재생성이 강제되고, 계획이 바뀌면 searchPlanSha256 때문에 resolutions까지 live probe로 재발행해야 한다.
  // 잔존 admitted entry는 다음 정기 재생성에서 정리한다(ledger regeneration.pairedUpdateKo 참조).
  const ledger = JSON.parse(await readFile(path.join(root, ledgerPath), "utf8"));
  const planKeys = new Set(plan.entries.map(requirementKey));
  const admittedKeys = new Set(
    ledger.launchRequired.requirements
      .filter(({ status }) => status === "INVENTORY_ADMITTED")
      .map(requirementKey),
  );
  assert.equal(admittedKeys.size, ledger.launchRequired.inventoryAdmittedCount);
  // 서울 1~8호선 public coordinate source는 current inventory scope에는 있으나 public v2 candidate
  // artifact가 아직 없어 MISSING으로 남는다. public API 재크롤 plan 누락은 이 exact deferred set만
  // 허용하며, 그 밖의 미admission requirement 누락은 계속 fail closed한다.
  assert.deepEqual(
    ledger.launchRequired.requirements
      .filter(({ status }) => status !== "INVENTORY_ADMITTED")
      .filter((requirement) => !planKeys.has(requirementKey(requirement)))
      .map(requirementKey)
      .sort(),
    [...DEFERRED_CANDIDATE_ARTIFACT_REQUIREMENT_KEYS].sort(),
  );
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
