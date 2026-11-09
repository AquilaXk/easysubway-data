import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stageLocalMobileFixture } from "../ci/stage-local-mobile-fixture.mjs";
import { buildCarDoorHints } from "./import-car-door-hints.mjs";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";
import {
  sourceIngestInput,
  productionSourceIngestInput,
  testOnlyInventoryPath,
} from "./test-fixtures/datapack-tools-source-ingest.mjs";

const root = path.resolve(import.meta.dirname, "../..");
stageLocalMobileFixture({ repositoryRoot: root });

const DEFAULT_INVENTORY_PATH = "tools/datapack/source-inventory.json";

async function withImportWorkspace(prefix, input, fn, { useTestOnlyInventory = false } = {}) {
  const outputDir = path.join(tmpdir(), `easysubway-${prefix}-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  const defaultInventory = useTestOnlyInventory
    ? await testOnlyInventoryPath(outputDir)
    : DEFAULT_INVENTORY_PATH;

  const runImport = (inventoryPath = defaultInventory, extraArgs = []) =>
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        ...extraArgs,
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    );

  const importAndReadFixture = async (inventoryPath = defaultInventory) => {
    await runImport(inventoryPath);
    return JSON.parse(await readFile(outputPath, "utf8"));
  };

  try {
    await fn({ outputDir, runImport, importAndReadFixture });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

function mutateInput(factory, mutator) {
  const input = factory();
  mutator(input);
  return input;
}

test("공식 source ingest adapter는 전국 마스터 source를 canonical 역·노선 row로 병합한다", async () => {
  await withImportWorkspace(
    "source-ingest-nationwide-master",
    nationwideMasterSourceIngestInput(),
    async ({ importAndReadFixture }) => {
      const generated = await importAndReadFixture();
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
    },
  );
});

test("공식 source ingest adapter는 production pack의 최소 coverage 기준 누락을 거부한다", async () => {
  const input = mutateInput(productionSourceIngestInput, (doc) => {
    delete doc.minimumProductionCoverage;
  });
  await withImportWorkspace(
    "source-ingest-production-coverage-missing",
    input,
    async ({ runImport }) => {
      await assert.rejects(
        runImport(),
        /minimumProductionCoverage must be an object for production pack/,
      );
    },
    { useTestOnlyInventory: true },
  );
});

test("공식 source ingest adapter는 production pack의 coverage evidence 누락을 거부한다", async () => {
  const input = mutateInput(productionSourceIngestInput, (doc) => {
    delete doc.coverageEvidence;
  });
  await withImportWorkspace(
    "source-ingest-production-coverage-evidence-missing",
    input,
    async ({ runImport }) => {
      await assert.rejects(
        runImport(),
        /coverageEvidence must be a non-empty array for production pack/,
      );
    },
    { useTestOnlyInventory: true },
  );
});

test("공식 source ingest adapter는 source inventory가 뒷받침하지 않는 coverage evidence를 거부한다", async () => {
  const input = mutateInput(productionSourceIngestInput, (doc) => {
    doc.coverageEvidence[0].operatorId = "busan-transportation";
  });
  await withImportWorkspace(
    "source-ingest-production-coverage-evidence-unsupported",
    input,
    async ({ runImport }) => {
      await assert.rejects(
        runImport(),
        /coverage evidence unsupported by source inventory: capital:busan-transportation:station_line_membership/,
      );
    },
    { useTestOnlyInventory: true },
  );
});

test("공식 source ingest adapter는 provenance 전용 source를 production row source로 선택하지 않는다", async () => {
  for (const sourceId of ["kric-station-info"]) {
    const input = JSON.parse(await readFile(
      path.join(root, "tools/datapack/inputs/capital-pilot-production-source-input.json"),
      "utf8",
    ));
    input.sourceIds = input.sourceIds.filter((id) => id !== "kric-station-convenience-standard");
    input.sourceIds.push(sourceId);

    await withImportWorkspace(
      `source-ingest-provenance-only-${sourceId}`,
      input,
      async ({ runImport }) => {
        await assert.rejects(
          runImport(),
          new RegExp(`${sourceId} source inventory is provenance-only and cannot be selected for production rows`),
        );
      },
    );
  }
});

test("공식 source ingest adapter는 selected source가 claim한 coverage evidence 누락을 거부한다", async () => {
  const input = mutateInput(productionSourceIngestInput, (doc) => {
    doc.coverageEvidence = doc.coverageEvidence.filter((entry) => entry.sourceDomain !== "accessibility_facilities");
  });
  await withImportWorkspace(
    "source-ingest-production-coverage-evidence-claim-missing",
    input,
    async ({ runImport }) => {
      await assert.rejects(
        runImport(),
        /production coverage evidence missing: capital:seoul-metro:accessibility_facilities/,
      );
    },
    { useTestOnlyInventory: true },
  );
});

test("공식 source ingest adapter는 production pack의 최소 coverage 미달을 거부한다", async () => {
  const input = mutateInput(productionSourceIngestInput, (doc) => {
    doc.minimumProductionCoverage.stations = 100;
  });
  await withImportWorkspace(
    "source-ingest-production-coverage-small",
    input,
    async ({ runImport }) => {
      await assert.rejects(
        runImport(),
        /production coverage stations 2 is below required minimum 100/,
      );
    },
    { useTestOnlyInventory: true },
  );
});

test("공식 source ingest adapter는 mapping 없는 source row를 거부한다", async () => {
  const input = mutateInput(sourceIngestInput, (doc) => {
    doc.stationLineRows[0].sourceStationCode = "missing-code";
  });
  await withImportWorkspace(
    "source-ingest-missing-mapping",
    input,
    async ({ runImport }) => {
      await assert.rejects(
        runImport(),
        /source mapping missing: seoulmetro-station-line-info:missing-code:seoul-4/,
      );
    },
  );
});

test("공식 source ingest adapter는 retired station id 재사용을 거부한다", async () => {
  const input = mutateInput(sourceIngestInput, (doc) => {
    doc.stationMappings[0].stationId = "station-retired-demo";
  });
  await withImportWorkspace(
    "source-ingest-retired-id",
    input,
    async ({ runImport }) => {
      await assert.rejects(
        runImport(),
        /station id reuse is forbidden: station-retired-demo/,
      );
    },
  );
});

test("공식 source ingest adapter는 같은 stable station-line의 상충 row를 거부한다", async () => {
  const input = mutateInput(sourceIngestInput, (doc) => {
    doc.stationLineRows[1].platformInfo = "충돌 승강장";
  });
  await withImportWorkspace(
    "source-ingest-station-line-conflict",
    input,
    async ({ runImport }) => {
      await assert.rejects(
        runImport(),
        /station line mapping conflict: station-sangnoksu:seoul-4.platformInfo/,
      );
    },
  );
});

test("공식 source ingest adapter는 inventory header가 input과 다르면 거부한다", async () => {
  await withImportWorkspace(
    "source-ingest-inventory-header",
    sourceIngestInput(),
    async ({ outputDir, runImport }) => {
      const inventoryPath = path.join(outputDir, "source-inventory.json");
      const inventory = JSON.parse(await readFile(path.join(root, DEFAULT_INVENTORY_PATH), "utf8"));
      inventory.region = "busan";
      await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

      await assert.rejects(
        runImport(inventoryPath),
        /inventory\.region must match input\.region: busan !== capital/,
      );
    },
  );
});

test("공식 source ingest adapter는 facility row의 mapping 누락을 거부한다", async () => {
  const input = mutateInput(sourceIngestInput, (doc) => {
    doc.facilityRows[0].station.sourceStationCode = "missing-code";
  });
  await withImportWorkspace(
    "source-ingest-facility-mapping",
    input,
    async ({ runImport }) => {
      await assert.rejects(
        runImport(),
        /source mapping missing: seoulmetro-station-line-info:missing-code:seoul-4/,
      );
    },
  );
});

test("공식 source ingest adapter는 KRIC 접근성 facility row를 stable station에 연결한다", async () => {
  await withImportWorkspace(
    "kric-facility-ingest",
    kricAccessibilityFacilitySourceIngestInput(),
    async ({ importAndReadFixture }) => {
      const fixture = await importAndReadFixture();
      assert.deepEqual(
        fixture.packs[0].sourceInventory.map((source) => source.id).sort(),
        [
          "kric-disabled-toilet",
          "kric-station-convenience-standard",
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
    },
  );
});

test("공식 source ingest adapter는 KRIC 이동동선을 확정 edge가 아닌 검수 후보로 보존한다", async () => {
  await withImportWorkspace(
    "kric-movement-candidate-ingest",
    kricMovementCandidateSourceIngestInput(),
    async ({ importAndReadFixture }) => {
      const fixture = await importAndReadFixture();
      assert.deepEqual(
        fixture.packs[0].sourceInventory.map((source) => source.id).sort(),
        ["kric-station-movement-detailed", "kric-station-movement-standard", "molit-urban-rail-full-route"],
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
            sourceId: "kric-station-movement-standard",
            stationId: "station-sangnoksu",
            reviewStatus: "PENDING_ADMIN_REVIEW",
          },
          {
            id: "movement-sangnoksu-wheelchair-lift-kric-1",
            sourceId: "kric-station-movement-detailed",
            stationId: "station-sangnoksu",
            reviewStatus: "PENDING_ADMIN_REVIEW",
          },
        ],
      );
      assert.equal(fixture.packs[0].networkEdges.length, 0);
      assert.equal((fixture.packs[0].internalRouteEdges ?? []).length, 0);
    },
  );
});

test("공식 source ingest adapter는 중복 CLI 인자를 거부한다", async () => {
  await withImportWorkspace(
    "source-ingest-duplicate-arg",
    sourceIngestInput(),
    async ({ runImport }) => {
      await assert.rejects(
        runImport(DEFAULT_INVENTORY_PATH, ["--inventory", DEFAULT_INVENTORY_PATH]),
        /duplicate argument: --inventory/,
      );
    },
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

const SANGNOKSU_MOLIT_STATION_REF = {
  sourceId: "molit-urban-rail-full-route",
  sourceStationCode: "MOLIT-SEOUL-4-448",
  lineId: "seoul-4",
};

function singleSangnoksuNationwideInput(sourceIds, extraFields) {
  return {
    ...nationwideMasterSourceIngestInput(),
    sourceIds,
    stationMappings: [
      {
        ...SANGNOKSU_MOLIT_STATION_REF,
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
    routeEdges: [],
    representativeRouteRegressions: [],
    ...extraFields,
  };
}

function kricAccessibilityFacilitySourceIngestInput() {
  return singleSangnoksuNationwideInput(
    [
      "molit-urban-rail-full-route",
      "kric-station-convenience-standard",
      "kric-disabled-toilet",
    ],
    {
      facilityRows: [
        ["kric-station-convenience-standard", "facility-sangnoksu-elevator-kric-1", "ELEVATOR", "상록수역 1번 엘리베이터"],
        ["kric-station-convenience-standard", "facility-sangnoksu-escalator-kric-1", "ESCALATOR", "상록수역 1번 에스컬레이터"],
        [
          "kric-station-convenience-standard",
          "facility-sangnoksu-wheelchair-lift-kric-1",
          "WHEELCHAIR_LIFT",
          "상록수역 휠체어리프트",
        ],
        ["kric-disabled-toilet", "facility-sangnoksu-accessible-toilet-kric-1", "ACCESSIBLE_TOILET", "상록수역 장애인 화장실"],
      ].map(([sourceId, id, type, name]) => ({
        sourceId,
        id,
        station: SANGNOKSU_MOLIT_STATION_REF,
        type,
        name,
        status: "UNKNOWN",
        description: "KRIC 접근성 시설 source ingest 검증용",
      })),
    },
  );
}

function kricMovementCandidateSourceIngestInput() {
  return singleSangnoksuNationwideInput(
    ["molit-urban-rail-full-route", "kric-station-movement-standard", "kric-station-movement-detailed"],
    {
      movementPathCandidates: [
        {
          sourceId: "kric-station-movement-standard",
          id: "movement-sangnoksu-elevator-kric-1",
          station: SANGNOKSU_MOLIT_STATION_REF,
          facilityType: "ELEVATOR",
          fromLabel: "1번 출입구",
          toLabel: "승강장",
          movementOrder: 1,
          instruction: "1번 출입구에서 엘리베이터를 이용해 승강장으로 이동",
          sourceImageUrl: "https://www.data.go.kr/kric/elevator-movement/example.png",
        },
        {
          sourceId: "kric-station-movement-detailed",
          id: "movement-sangnoksu-wheelchair-lift-kric-1",
          station: SANGNOKSU_MOLIT_STATION_REF,
          facilityType: "WHEELCHAIR_LIFT",
          fromLabel: "대합실",
          toLabel: "승강장",
          movementOrder: 2,
          instruction: "대합실에서 휠체어리프트 위치까지 이동 후 승강장으로 이동",
          sourceImageUrl: "https://www.data.go.kr/kric/wheelchair-lift-movement/example.png",
        },
      ],
      internalRouteEdges: [],
    },
  );
}

test("빠른하차 importer는 휠체어리프트 키워드를 WHEELCHAIR_LIFT로 정규화한다", () => {
  const roster = [
    {
      stationId: "station-sangnoksu",
      lineId: "seoul-4",
      nameKo: "상록수",
      normalizedName: "상록수",
      lineNameKo: "4호선",
      aliases: [],
    },
  ];
  const result = buildCarDoorHints({
    roster,
    rows: [
      {
        crtrYmd: "20260101",
        lineNm: "4호선",
        stnCd: "0448",
        stnNm: "상록수",
        stnNo: "448",
        qckgffVhclDoorNo: "4-1",
        upbdnbSe: "상행",
        plfmCmgFac: "휠체어리프트",
        facPstnNm: "승강장 휠체어 리프트",
      },
    ],
    sourceId: "seoul-metro-fast-exit-car-door",
    snapshotId: "snapshot-1",
    verificationStatus: "OFFICIAL",
  });
  assert.equal(result.quarantine.length, 0);
  assert.equal(result.stationCarDoorHints.length, 1);
  assert.equal(result.stationCarDoorHints[0].targetFacilityType, "WHEELCHAIR_LIFT");
});
