#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const bundleUrl = "https://raw.githubusercontent.com/AquilaXk/easysubway/8b09a017adca69fb76a68205835dfea6586ddf80/contracts/bundles/data-contracts-v1.0.0.json";
const annualOfficialFileSourceIds = [
  "molit-railway-transfer-movement",
  "seoul-metro-transfer-distance-duration",
];
const staticAccessibilitySourceIds = [
  "kric-station-convenience-standard",
  "kric-station-elevator",
  "kric-station-elevator-movement",
  "kric-station-escalator",
  "kric-wheelchair-lift-location",
  "kric-wheelchair-lift-movement",
  "seoul-metro-accessibility",
  "incheon-transit-accessibility",
];
const routeMapPositionSourceIds = ["seoul-metro-route-map-positions"];
const historicalRouteMapSourceIds = ["seoulmetro-cyberstation-route-map"];
const routeMapGovernanceMappings = [
  { sourceId: "seoul-metro-route-map-positions", sourceClassId: "route_map_positions" },
  { sourceId: "seoulmetro-cyberstation-route-map", sourceClassId: "route_map_asset_historical" },
];
const productionRequiredSourceIds = [
  "incheon-transit-accessibility",
  "molit-urban-rail-full-route",
  "seoulmetro-station-line-info",
  "seoul-metro-accessibility",
  "seoul-metro-route-map-positions",
  "kric-station-convenience-standard",
  "kric-subway-timetable",
  "seoul-metro-transfer-distance-duration",
];
const resourceNames = [
  "datapack/mobility-profile-policy.json",
  "datapack/datapack-freshness-sla.json",
  "datapack/source-governance-policy.json",
  "datapack/datapack-manifest-acceptance-policy.json",
  "datapack/production-datapack-scope.json",
  "datapack/train-search-itx-exclusion-gate.json",
];

export async function stageContracts({ root = process.cwd(), fetchBundle = download } = {}) {
  root = path.resolve(root);
  await requireDirectory(root, "repository root");
  const lock = JSON.parse(await readFile(path.join(root, "contracts.lock.json"), "utf8"));
  exactKeys(lock, ["schemaVersion", "bundleVersion", "url", "sha256"], "contracts.lock.json");
  if (lock.schemaVersion !== 1 || lock.bundleVersion !== "1.0.0" || lock.url !== bundleUrl
      || !/^[a-f0-9]{64}$/.test(lock.sha256)) {
    throw new Error("contracts.lock.json is invalid");
  }

  const bytes = Buffer.from(await fetchBundle(lock.url));
  if (createHash("sha256").update(bytes).digest("hex") !== lock.sha256) {
    throw new Error("contract bundle sha256 does not match contracts.lock.json");
  }
  const bundle = JSON.parse(bytes.toString("utf8"));
  exactKeys(bundle, ["schemaVersion", "bundleVersion", "resources"], "contract bundle");
  if (bundle.schemaVersion !== 1 || bundle.bundleVersion !== lock.bundleVersion) {
    throw new Error("contract bundle version is invalid");
  }
  exactKeys(bundle.resources, resourceNames, "contract bundle resources");
  for (const name of resourceNames) JSON.parse(bundle.resources[name]);
  const freshnessPolicy = JSON.parse(bundle.resources["datapack/datapack-freshness-sla.json"]);
  const annualOfficialFile = freshnessPolicy.sourceClasses?.find(({ id }) => id === "annual_official_file");
  if (JSON.stringify(annualOfficialFile?.sourceIds) !== JSON.stringify(annualOfficialFileSourceIds)) {
    throw new Error("contract bundle annual_official_file sourceIds are invalid");
  }
  const staticAccessibility = freshnessPolicy.sourceClasses
    ?.find(({ id }) => id === "static_accessibility_facility");
  if (JSON.stringify(staticAccessibility?.sourceIds) !== JSON.stringify(staticAccessibilitySourceIds)) {
    throw new Error("contract bundle static_accessibility_facility sourceIds are invalid");
  }
  const routeMapPositions = freshnessPolicy.sourceClasses?.find(({ id }) => id === "route_map_positions");
  const historicalRouteMap = freshnessPolicy.sourceClasses?.find(({ id }) => id === "route_map_asset_historical");
  if (JSON.stringify(routeMapPositions?.sourceIds) !== JSON.stringify(routeMapPositionSourceIds)
      || routeMapPositions?.reverificationCadence !== "P90D" || routeMapPositions?.offlinePackEligible !== true
      || JSON.stringify(historicalRouteMap?.sourceIds) !== JSON.stringify(historicalRouteMapSourceIds)
      || historicalRouteMap?.reverificationCadence !== "P1Y" || historicalRouteMap?.offlinePackEligible !== false
      || freshnessPolicy.sourceClasses.some(({ id }) => id === "route_map_asset")) {
    throw new Error("contract bundle route-map freshness classes are invalid");
  }
  const sourceGovernancePolicy = JSON.parse(bundle.resources["datapack/source-governance-policy.json"]);
  const routeMapGovernance = sourceGovernancePolicy.sources?.filter(({ sourceId }) =>
    routeMapGovernanceMappings.some((mapping) => mapping.sourceId === sourceId))
    .map(({ sourceId, sourceClassId }) => ({ sourceId, sourceClassId }));
  if (JSON.stringify(routeMapGovernance) !== JSON.stringify(routeMapGovernanceMappings)) {
    throw new Error("contract bundle route-map source governance mappings are invalid");
  }
  const productionScope = JSON.parse(bundle.resources["datapack/production-datapack-scope.json"]);
  if (JSON.stringify(productionScope.productionSourceSet?.requiredSourceIds)
      !== JSON.stringify(productionRequiredSourceIds)) {
    throw new Error("contract bundle production requiredSourceIds are invalid");
  }

  const build = path.join(root, "build");
  await mkdir(build, { recursive: true });
  await requireDirectory(build, "build directory");
  const output = path.join(build, "contracts");
  await requireAbsent(output);
  const temporary = await mkdtemp(path.join(build, ".contracts-"));
  try {
    for (const name of resourceNames) {
      const target = path.join(temporary, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bundle.resources[name], { flag: "wx" });
    }
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function download(url) {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`contract bundle download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has unexpected keys`);
  }
}

async function requireDirectory(target, label) {
  const stats = await lstat(target);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function requireAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("build/contracts already exists");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  stageContracts().catch((error) => {
    process.stderr.write(`stage-contracts: ${error.message}\n`);
    process.exitCode = 1;
  });
}
