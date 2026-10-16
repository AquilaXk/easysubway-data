import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stageLocalMobileFixture } from "../ci/stage-local-mobile-fixture.mjs";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";
import {
  sourceIngestInput,
  productionSourceIngestInput,
  testOnlyInventoryPath,
} from "./test-fixtures/datapack-tools-source-ingest.mjs";

const root = path.resolve(import.meta.dirname, "../..");
stageLocalMobileFixture({ repositoryRoot: root });

test("공식 source ingest adapter는 전국 마스터 source를 canonical 역·노선 row로 병합한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-nationwide-master-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(nationwideMasterSourceIngestInput(), null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const generated = JSON.parse(await readFile(outputPath, "utf8"));
  const pack = generated.packs[0];
  assert.deepEqual(
    pack.sourceInventory.map((source) => source.id),
    [
      "molit-urban-rail-full-route",
      "molit-tago-subway-info",
      "kric-metropolitan-rail-station-info",
    ],
  );
  assert.deepEqual(
    pack.stations.map((station) => station.id),
    ["station-sangnoksu", "station-busan-station"],
  );
  assert.deepEqual(
    pack.stationLines.map((stationLine) => ({
      stationId: stationLine.stationId,
      lineId: stationLine.lineId,
      stationCode: stationLine.stationCode,
      lineSequence: stationLine.lineSequence,
    })),
    [
      {
        stationId: "station-sangnoksu",
        lineId: "seoul-4",
        stationCode: "448",
        lineSequence: 43,
      },
      {
        stationId: "station-busan-station",
        lineId: "busan-1",
        stationCode: "113",
        lineSequence: 13,
      },
    ],
  );
});

test("공식 source ingest adapter는 production pack의 최소 coverage 기준 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-coverage-missing-${Date.now()}`);
  const input = productionSourceIngestInput();
  delete input.minimumProductionCoverage;
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  const inventoryPath = await testOnlyInventoryPath(outputDir);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /minimumProductionCoverage must be an object for production pack/,
  );
});

test("공식 source ingest adapter는 production pack의 coverage evidence 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-coverage-evidence-missing-${Date.now()}`);
  const input = productionSourceIngestInput();
  delete input.coverageEvidence;
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  const inventoryPath = await testOnlyInventoryPath(outputDir);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /coverageEvidence must be a non-empty array for production pack/,
  );
});

test("공식 source ingest adapter는 source inventory가 뒷받침하지 않는 coverage evidence를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-coverage-evidence-unsupported-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.coverageEvidence[0].operatorId = "busan-transportation";
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  const inventoryPath = await testOnlyInventoryPath(outputDir);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /coverage evidence unsupported by source inventory: capital:busan-transportation:station_line_membership/,
  );
});

test("공식 source ingest adapter는 provenance 전용 source를 production row source로 선택하지 않는다", async () => {
  for (const sourceId of [
    "kric-station-info",
    "kric-station-elevator",
    "kric-station-escalator",
    "kric-wheelchair-lift-location",
  ]) {
    const outputDir = path.join(tmpdir(), `easysubway-source-ingest-provenance-only-${sourceId}-${Date.now()}`);
    const input = JSON.parse(await readFile(
      path.join(root, "tools/datapack/inputs/capital-pilot-production-source-input.json"),
      "utf8",
    ));
    input.sourceIds = input.sourceIds.filter((id) => id !== "kric-station-convenience-standard");
    input.sourceIds.push(sourceId);
    const inputPath = path.join(outputDir, "official-source-input.json");
    const outputPath = path.join(outputDir, "catalog-fixture.json");
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/import-official-sources.mjs",
          "--inventory",
          "tools/datapack/source-inventory.json",
          "--input",
          inputPath,
          "--output",
          outputPath,
        ],
        { cwd: root },
      ),
      new RegExp(`${sourceId} source inventory is provenance-only and cannot be selected for production rows`),
    );
  }
});

test("공식 source ingest adapter는 selected source가 claim한 coverage evidence 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-coverage-evidence-claim-missing-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.coverageEvidence = input.coverageEvidence.filter((entry) => entry.sourceDomain !== "accessibility_facilities");
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  const inventoryPath = await testOnlyInventoryPath(outputDir);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /production coverage evidence missing: capital:seoul-metro:accessibility_facilities/,
  );
});

test("공식 source ingest adapter는 production pack의 최소 coverage 미달을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-coverage-small-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.minimumProductionCoverage.stations = 100;
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  const inventoryPath = await testOnlyInventoryPath(outputDir);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /production coverage stations 2 is below required minimum 100/,
  );
});

test("공식 source ingest adapter는 mapping 없는 source row를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-missing-mapping-${Date.now()}`);
  const input = sourceIngestInput();
  input.stationLineRows[0].sourceStationCode = "missing-code";
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /source mapping missing: seoulmetro-station-line-info:missing-code:seoul-4/,
  );
});

test("공식 source ingest adapter는 retired station id 재사용을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-retired-id-${Date.now()}`);
  const input = sourceIngestInput();
  input.stationMappings[0].stationId = "station-retired-demo";
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /station id reuse is forbidden: station-retired-demo/,
  );
});

test("공식 source ingest adapter는 같은 stable station-line의 상충 row를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-station-line-conflict-${Date.now()}`);
  const input = sourceIngestInput();
  input.stationLineRows[1].platformInfo = "충돌 승강장";
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /station line mapping conflict: station-sangnoksu:seoul-4.platformInfo/,
  );
});

test("공식 source ingest adapter는 inventory header가 input과 다르면 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-inventory-header-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  inventory.region = "busan";
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /inventory\.region must match input\.region: busan !== capital/,
  );
});

test("공식 source ingest adapter는 facility row의 mapping 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-facility-mapping-${Date.now()}`);
  const input = sourceIngestInput();
  input.facilityRows[0].station.sourceStationCode = "missing-code";
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /source mapping missing: seoulmetro-station-line-info:missing-code:seoul-4/,
  );
});

test("공식 source ingest adapter는 KRIC 접근성 facility row를 stable station에 연결한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-facility-ingest-${Date.now()}`);
  const input = kricAccessibilityFacilitySourceIngestInput();
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(
    fixture.packs[0].sourceInventory.map((source) => source.id).sort(),
    [
      "kric-disabled-toilet",
      "kric-station-elevator",
      "kric-station-escalator",
      "kric-wheelchair-lift-location",
      "molit-urban-rail-full-route",
    ],
  );
  assert.deepEqual(
    fixture.packs[0].facilities.map(({ id, stationId, type, status }) => ({ id, stationId, type, status })),
    [
      {
        id: "facility-sangnoksu-elevator-kric-1",
        stationId: "station-sangnoksu",
        type: "ELEVATOR",
        status: "UNKNOWN",
      },
      {
        id: "facility-sangnoksu-escalator-kric-1",
        stationId: "station-sangnoksu",
        type: "ESCALATOR",
        status: "UNKNOWN",
      },
      {
        id: "facility-sangnoksu-wheelchair-lift-kric-1",
        stationId: "station-sangnoksu",
        type: "WHEELCHAIR_LIFT",
        status: "UNKNOWN",
      },
      {
        id: "facility-sangnoksu-accessible-toilet-kric-1",
        stationId: "station-sangnoksu",
        type: "ACCESSIBLE_TOILET",
        status: "UNKNOWN",
      },
    ],
  );
  assert.equal(fixture.packs[0].networkEdges.length, 0);
});

test("공식 source ingest adapter는 KRIC 이동동선을 확정 edge가 아닌 검수 후보로 보존한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-movement-candidate-ingest-${Date.now()}`);
  const input = kricMovementCandidateSourceIngestInput();
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(
    fixture.packs[0].sourceInventory.map((source) => source.id).sort(),
    ["kric-station-elevator-movement", "kric-wheelchair-lift-movement", "molit-urban-rail-full-route"],
  );
  assert.deepEqual(
    fixture.packs[0].movementPathCandidates.map(({ id, sourceId, stationId, reviewStatus }) => ({
      id,
      sourceId,
      stationId,
      reviewStatus,
    })),
    [
      {
        id: "movement-sangnoksu-elevator-kric-1",
        sourceId: "kric-station-elevator-movement",
        stationId: "station-sangnoksu",
        reviewStatus: "PENDING_ADMIN_REVIEW",
      },
      {
        id: "movement-sangnoksu-wheelchair-lift-kric-1",
        sourceId: "kric-wheelchair-lift-movement",
        stationId: "station-sangnoksu",
        reviewStatus: "PENDING_ADMIN_REVIEW",
      },
    ],
  );
  assert.equal(fixture.packs[0].networkEdges.length, 0);
  assert.equal((fixture.packs[0].internalRouteEdges ?? []).length, 0);
});

test("공식 source ingest adapter는 중복 CLI 인자를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-duplicate-arg-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /duplicate argument: --inventory/,
  );
});

function nationwideMasterSourceIngestInput() {
  const stationSources = [
    ["molit-urban-rail-full-route", "MOLIT-SEOUL-4-448", "seoul-4", "station-sangnoksu", "448", 43, "상록수", "Sangnoksu", "수도권", 37.3028, 126.8666],
    ["molit-tago-subway-info", "448", "seoul-4", "station-sangnoksu", "448", 43, "상록수", "Sangnoksu", "수도권", 37.3028, 126.8666],
    ["kric-metropolitan-rail-station-info", "KRIC-SEOUL-4-448", "seoul-4", "station-sangnoksu", "448", 43, "상록수", "Sangnoksu", "수도권", 37.3028, 126.8666],
    ["molit-urban-rail-full-route", "MOLIT-BUSAN-1-113", "busan-1", "station-busan-station", "113", 13, "부산역", "Busan Station", "부산권", 35.1152, 129.0422],
    ["kric-metropolitan-rail-station-info", "KRIC-BUSAN-1-113", "busan-1", "station-busan-station", "113", 13, "부산역", "Busan Station", "부산권", 35.1152, 129.0422],
  ];
  return {
    schemaVersion: 1,
    region: "nationwide",
    pack: {
      id: "nationwide",
      version: "1",
      schemaVersion: "1",
      artifactKind: "fixture",
      url: "catalog/nationwide-v1.sqlite.gz",
    },
    manifest: {
      ttlSeconds: 3600,
      activePack: {
        id: "nationwide",
        version: "1",
      },
    },
    sourceIds: [
      "molit-urban-rail-full-route",
      "molit-tago-subway-info",
      "kric-metropolitan-rail-station-info",
    ],
    operators: [
      {
        id: "seoul-metro",
        nameKo: "서울교통공사",
        nameEn: "Seoul Metro",
      },
      {
        id: "busan-transportation",
        nameKo: "부산교통공사",
        nameEn: "Busan Transportation Corporation",
      },
    ],
    lines: [
      {
        id: "seoul-4",
        operatorId: "seoul-metro",
        nameKo: "수도권 4호선",
        nameEn: "Seoul Subway Line 4",
        color: "#00A5DE",
      },
      {
        id: "busan-1",
        operatorId: "busan-transportation",
        nameKo: "부산 1호선",
        nameEn: "Busan Metro Line 1",
        color: "#F06A00",
      },
    ],
    stationMappings: stationSources.map(([sourceId, sourceStationCode, lineId, stationId]) => ({
      sourceId,
      sourceStationCode,
      lineId,
      stationId,
      stationLineId: `${stationId}:${lineId}`,
      mappingStatus: "active",
    })),
    stationLineRows: stationSources.map(nationwideMasterStationLineRow),
    representativeRouteRegressions: [],
  };
}

function nationwideMasterStationLineRow([
  sourceId,
  sourceStationCode,
  lineId,
  ,
  stationCode,
  lineSequence,
  stationNameKo,
  stationNameEn,
  region,
  latitude,
  longitude,
]) {
  return {
    sourceId,
    sourceStationCode,
    lineId,
    stationNameKo,
    stationNameEn,
    normalizedName: stationNameKo,
    region,
    latitude,
    longitude,
    stationCode,
    lineSequence,
    platformInfo: "마스터 병합 검증용",
    lastVerifiedAt: "2026-06-22T00:00:00.000Z",
  };
}

function kricAccessibilityFacilitySourceIngestInput() {
  return {
    ...nationwideMasterSourceIngestInput(),
    sourceIds: [
      "molit-urban-rail-full-route",
      "kric-station-elevator",
      "kric-station-escalator",
      "kric-wheelchair-lift-location",
      "kric-disabled-toilet",
    ],
    stationMappings: [
      {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-4-448",
        lineId: "seoul-4",
        stationId: "station-sangnoksu",
        stationLineId: "station-sangnoksu:seoul-4",
        mappingStatus: "active",
      },
    ],
    stationLineRows: [
      nationwideMasterStationLineRow([
        "molit-urban-rail-full-route",
        "MOLIT-SEOUL-4-448",
        "seoul-4",
        "station-sangnoksu",
        "448",
        48,
        "상록수",
        "Sangnoksu",
        "수도권",
        37.3028,
        126.8666,
      ]),
    ],
    facilityRows: [
      ["kric-station-elevator", "facility-sangnoksu-elevator-kric-1", "ELEVATOR", "상록수역 1번 엘리베이터"],
      ["kric-station-escalator", "facility-sangnoksu-escalator-kric-1", "ESCALATOR", "상록수역 1번 에스컬레이터"],
      [
        "kric-wheelchair-lift-location",
        "facility-sangnoksu-wheelchair-lift-kric-1",
        "WHEELCHAIR_LIFT",
        "상록수역 휠체어리프트",
      ],
      ["kric-disabled-toilet", "facility-sangnoksu-accessible-toilet-kric-1", "ACCESSIBLE_TOILET", "상록수역 장애인 화장실"],
    ].map(([sourceId, id, type, name]) => ({
      sourceId,
      id,
      station: {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-4-448",
        lineId: "seoul-4",
      },
      type,
      name,
      status: "UNKNOWN",
      description: "KRIC 접근성 시설 source ingest 검증용",
    })),
    routeEdges: [],
    representativeRouteRegressions: [],
  };
}

function kricMovementCandidateSourceIngestInput() {
  return {
    ...nationwideMasterSourceIngestInput(),
    sourceIds: ["molit-urban-rail-full-route", "kric-station-elevator-movement", "kric-wheelchair-lift-movement"],
    stationMappings: [
      {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-4-448",
        lineId: "seoul-4",
        stationId: "station-sangnoksu",
        stationLineId: "station-sangnoksu:seoul-4",
        mappingStatus: "active",
      },
    ],
    stationLineRows: [
      nationwideMasterStationLineRow([
        "molit-urban-rail-full-route",
        "MOLIT-SEOUL-4-448",
        "seoul-4",
        "station-sangnoksu",
        "448",
        48,
        "상록수",
        "Sangnoksu",
        "수도권",
        37.3028,
        126.8666,
      ]),
    ],
    movementPathCandidates: [
      {
        sourceId: "kric-station-elevator-movement",
        id: "movement-sangnoksu-elevator-kric-1",
        station: {
          sourceId: "molit-urban-rail-full-route",
          sourceStationCode: "MOLIT-SEOUL-4-448",
          lineId: "seoul-4",
        },
        facilityType: "ELEVATOR",
        fromLabel: "1번 출입구",
        toLabel: "승강장",
        movementOrder: 1,
        instruction: "1번 출입구에서 엘리베이터를 이용해 승강장으로 이동",
        sourceImageUrl: "https://www.data.go.kr/kric/elevator-movement/example.png",
      },
      {
        sourceId: "kric-wheelchair-lift-movement",
        id: "movement-sangnoksu-wheelchair-lift-kric-1",
        station: {
          sourceId: "molit-urban-rail-full-route",
          sourceStationCode: "MOLIT-SEOUL-4-448",
          lineId: "seoul-4",
        },
        facilityType: "WHEELCHAIR_LIFT",
        fromLabel: "대합실",
        toLabel: "승강장",
        movementOrder: 2,
        instruction: "대합실에서 휠체어리프트 위치까지 이동 후 승강장으로 이동",
        sourceImageUrl: "https://www.data.go.kr/kric/wheelchair-lift-movement/example.png",
      },
    ],
    routeEdges: [],
    internalRouteEdges: [],
    representativeRouteRegressions: [],
  };
}
