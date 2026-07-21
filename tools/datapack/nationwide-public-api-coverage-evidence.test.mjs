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
const planPath = "tools/datapack/release/nationwide-public-api-coverage-search-plan-20260720.json";
const resolutionsPath = "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260720.json";

test("전국 공공데이터 audit은 73건만 공식 미지원으로 닫고 194건은 MISSING으로 유지한다", async () => {
  const plan = JSON.parse(await readFile(path.join(root, planPath), "utf8"));
  const resolutionsText = await readFile(path.join(root, resolutionsPath), "utf8");
  const resolutions = JSON.parse(resolutionsText);

  assert.equal(plan.entries.length, 270);
  const korailEntries = plan.entries.filter(({ operatorId }) => operatorId === "korail");
  assert.equal(korailEntries.length, 60);
  assert.ok(korailEntries.every(({ queries }) => queries.every(
    ({ query }) => query.organizations[0] === "한국철도공사",
  )));
  assert.equal(resolutions.entries.length, 73);
  assert.equal(resolutions.unresolved.length, 194);
  assert.deepEqual(
    Object.fromEntries(Object.entries(Object.groupBy(resolutions.entries, ({ sourceDomain }) => sourceDomain))
      .map(([domain, entries]) => [domain, entries.length])),
    { realtime_arrivals: 6, route_graph_topology: 28, route_map_positions: 39 },
  );
  assert.doesNotMatch(resolutionsText, /"(?:serviceKey|secret|token)"\s*:/i);
  assert.doesNotMatch(resolutionsText, /Infuser\s+/i);

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
    assert.equal(report.summary.launchRequired.explicitlyUnsupportedCount, 73);
    assert.equal(report.summary.launchRequired.missingCount, 197);
    assert.equal(report.summary.launchRequired.terminalResolutionRatio, 0.2704);

    const workflow = await readFile(path.join(root, ".github/workflows/datapack-release.yml"), "utf8");
    assert.match(workflow, /--resolution-plan tools\/datapack\/release\/nationwide-public-api-coverage-search-plan-20260720\.json/);
    assert.match(workflow, /--resolutions tools\/datapack\/release\/nationwide-public-api-coverage-resolutions-20260720\.json/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
