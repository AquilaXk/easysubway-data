import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { materializeAccessibilitySourceInput } from "./materialize-accessibility-source-input.mjs";

const execFileAsync = promisify(execFile);

test("fresh KRIC codes와 Seoul status만 production source input으로 materialize한다", () => {
  const input = {
    sourceIds: [],
    stationMappings: [{ sourceId: "molit-urban-rail-full-route", sourceStationCode: "MOLIT-L-1", lineId: "line-1", stationId: "station-a" }],
    stationLineRows: [{
      sourceId: "molit-urban-rail-full-route", sourceStationCode: "MOLIT-L-1",
      stationCode: "1", lineId: "line-1", stationNameKo: "가",
    }],
    routeEdges: [{
      id: "edge-a", sourceId: "seoul-metro-accessibility", edgeType: "ENTRY",
      to: { sourceId: "official-lines", sourceStationCode: "1", lineId: "line-1" },
    }],
    supportedV1Scope: { includedStationIds: ["station-a"] },
    minimumProductionCoverage: { facilities: 1 },
    coverageEvidence: [{ sourceDomain: "accessibility_facilities", sourceIds: ["old"] }],
  };
  const kricSnapshot = {
    sourceId: "kric-station-convenience-standard", snapshotId: "kric-1", observedAt: "2026-07-28T00:00:00Z", capturedAt: "2026-07-28T00:00:00Z",
    queries: [{ stationId: "station-a", lineId: "line-1", railOprIsttCd: "S1", lnCd: "1", stinCd: "1", providerRecordHash: "a".repeat(64), rows: [{ gubun: "EV", grndDvCd: "2", stinFlor: 3, dtlLoc: "대합실" }, { gubun: "ELEC", stinFlor: 1, dtlLoc: "충전" }] }],
  };
  const seoulSnapshot = {
    sourceId: "seoul-metro-accessibility", snapshotId: "seoul-1", observedAt: "2026-07-28T00:00:00Z", capturedAt: "2026-07-28T00:00:00Z",
    stations: [{ stationName: "가", lineName: "1호선", facilities: [{ operational: true }] }],
  };

  const output = materializeAccessibilitySourceInput({ input, kricSnapshot, seoulSnapshot });

  assert.deepEqual(output.facilityRows.map(({ type }) => type), ["ELEVATOR"]);
  assert.deepEqual(output.facilityRows.map(({ floorFrom, floorTo }) => [floorFrom, floorTo]), [["B3", ""]]);
  assert.deepEqual(output.accessibilityStatusEvidence.map(({ facilityType, evidenceKind }) => [facilityType, evidenceKind]), [
    ["ESCALATOR", "NOT_EXISTS"], ["WHEELCHAIR_LIFT", "NOT_EXISTS"], ["ACCESSIBILITY_STATUS_PROBE", "EXISTS"],
  ]);
  assert.equal(output.accessibilityStatusEvidence.at(-1).operationalStatus, "AVAILABLE");
  assert.deepEqual(output.accessibilityStatusEvidence.map(({ strictRouteEligibleReason }) => strictRouteEligibleReason), [
    "FACILITY_NOT_INSTALLED", "FACILITY_NOT_INSTALLED", "STATUS_PROBE_NOT_ROUTE_EVIDENCE",
  ]);
  assert.equal(output.routeEdges[0].accessibilityStatus, "UNKNOWN");
  assert.equal(output.routeEdges[0].verificationStatus, "NOT_VERIFIED");
  assert.deepEqual(output.sourceIds, ["kric-station-convenience-standard", "seoul-metro-accessibility"]);
  assert.ok(output.coverageEvidence[0].sourceIds.includes("seoul-metro-accessibility"));
  const sameTypeRows = [
    { gubun: "EV", grndDvCd: "1", stinFlor: 1, dtlLoc: "대합실 A" },
    { gubun: "EV", grndDvCd: "2", stinFlor: 2, dtlLoc: "대합실 B" },
  ];
  const facilitiesByDescription = (rows) => Object.fromEntries(materializeAccessibilitySourceInput({
    input,
    kricSnapshot: { ...kricSnapshot, queries: [{ ...kricSnapshot.queries[0], rows }] },
    seoulSnapshot,
  }).facilityRows.map(({ description, id, name, providerFacilityRef }) => [description, { id, name, providerFacilityRef }]));
  assert.deepEqual(facilitiesByDescription(sameTypeRows), facilitiesByDescription(sameTypeRows.toReversed()));
  assert.ok(Object.values(facilitiesByDescription(sameTypeRows))
    .every(({ id }) => /^facility-station-a-elevator-kric-standard-[0-9a-f]{16}$/.test(id)));
  assert.ok(Object.values(facilitiesByDescription(sameTypeRows)).every(({ id }) => id.length <= 120));
  const nextSnapshotIds = materializeAccessibilitySourceInput({
    input,
    kricSnapshot: { ...kricSnapshot, snapshotId: "kric-2", queries: [{ ...kricSnapshot.queries[0], rows: sameTypeRows }] },
    seoulSnapshot,
  }).facilityRows.map(({ id }) => id);
  assert.deepEqual(nextSnapshotIds.sort(), Object.values(facilitiesByDescription(sameTypeRows)).map(({ id }) => id).sort());
  const baseline = materializeAccessibilitySourceInput({
    input,
    kricSnapshot: { ...kricSnapshot, queries: [{ ...kricSnapshot.queries[0], rows: sameTypeRows }] },
    seoulSnapshot,
  });
  const added = materializeAccessibilitySourceInput({
    input: { ...input, facilityRows: baseline.facilityRows },
    kricSnapshot: {
      ...kricSnapshot,
      queries: [{ ...kricSnapshot.queries[0], rows: [...sameTypeRows, { gubun: "EV", grndDvCd: "1", stinFlor: 0, dtlLoc: "새 시설" }] }],
    },
    seoulSnapshot,
  });
  assert.ok(baseline.facilityRows.every(({ providerRecordHash, id }) =>
    added.facilityRows.find((row) => row.providerRecordHash === providerRecordHash)?.id === id));
  const removed = materializeAccessibilitySourceInput({
    input: { ...input, facilityRows: added.facilityRows },
    kricSnapshot: {
      ...kricSnapshot,
      queries: [{ ...kricSnapshot.queries[0], rows: [sameTypeRows[1], { gubun: "EV", grndDvCd: "1", stinFlor: 0, dtlLoc: "새 시설" }] }],
    },
    seoulSnapshot,
  });
  assert.ok(removed.facilityRows.every(({ providerRecordHash, id }) =>
    added.facilityRows.find((row) => row.providerRecordHash === providerRecordHash)?.id === id));
  assert.throws(() => materializeAccessibilitySourceInput({
    input: {
      ...input,
      facilityRows: [{
        sourceId: "kric-station-convenience-standard", id: "facility-malformed",
        providerRecordHash: "invalid", providerFacilityRef: "invalid",
      }],
    },
    kricSnapshot,
    seoulSnapshot,
  }), /malformed facility identity fields: facility-malformed/);
  assert.throws(() => materializeAccessibilitySourceInput({
    input: {
      ...input,
      facilityRows: [
        {
          sourceId: "kric-station-convenience-standard", id: "facility-collision",
          providerRecordHash: "a".repeat(64), providerFacilityRef: `S1:1:1:EV:${"a".repeat(64)}`,
        },
        {
          sourceId: "kric-station-convenience-standard", id: "facility-collision",
          providerRecordHash: "b".repeat(64), providerFacilityRef: `S1:1:2:EV:${"b".repeat(64)}`,
        },
      ],
    },
    kricSnapshot,
    seoulSnapshot,
  }), /facility identity collision/);
  const twoStationInput = {
    ...input,
    stationMappings: [
      ...input.stationMappings,
      { sourceId: "molit-urban-rail-full-route", sourceStationCode: "MOLIT-L-2", lineId: "line-2", stationId: "station-b" },
    ],
    stationLineRows: [
      ...input.stationLineRows,
      {
        sourceId: "molit-urban-rail-full-route", sourceStationCode: "MOLIT-L-2",
        stationCode: "2", lineId: "line-2", stationNameKo: "나",
      },
    ],
    minimumProductionCoverage: { facilities: 2 },
  };
  const sameProviderRow = { gubun: "EV", grndDvCd: "1", stinFlor: 1, dtlLoc: "동일 payload" };
  const twoStationSnapshot = {
    ...kricSnapshot,
    queries: [
      { ...kricSnapshot.queries[0], rows: [sameProviderRow] },
      {
        stationId: "station-b", lineId: "line-2", railOprIsttCd: "S1", lnCd: "2",
        stinCd: "2", providerRecordHash: "b".repeat(64), rows: [sameProviderRow],
      },
    ],
  };
  const twoStations = materializeAccessibilitySourceInput({
    input: twoStationInput, kricSnapshot: twoStationSnapshot, seoulSnapshot,
  });
  assert.equal(new Set(twoStations.facilityRows.map(({ id }) => id)).size, 2);
  const stationBId = twoStations.facilityRows
    .find(({ station }) => station.sourceStationCode === "MOLIT-L-2").id;
  const stationBOnly = materializeAccessibilitySourceInput({
    input: {
      ...twoStationInput, facilityRows: twoStations.facilityRows,
      minimumProductionCoverage: { facilities: 1 },
    },
    kricSnapshot: { ...twoStationSnapshot, queries: [twoStationSnapshot.queries[1]] },
    seoulSnapshot,
  });
  assert.equal(stationBOnly.facilityRows[0].id, stationBId);
  const duplicated = materializeAccessibilitySourceInput({
    input,
    kricSnapshot: { ...kricSnapshot, queries: [{ ...kricSnapshot.queries[0], rows: [sameTypeRows[0], sameTypeRows[0]] }] },
    seoulSnapshot,
  });
  assert.equal(duplicated.facilityRows.length, 1);
  const uncovered = materializeAccessibilitySourceInput({
    input, kricSnapshot, seoulSnapshot: { ...seoulSnapshot, stations: [] },
  });
  assert.deepEqual(
    ["evidenceKind", "installationStatus", "operationalStatus", "statusMeaning", "strictRouteEligibleReason"]
      .map((key) => uncovered.accessibilityStatusEvidence.at(-1)[key]),
    ["NOT_EXISTS", "NOT_COVERED", "NOT_COVERED", "FEED_ABSENCE_RECORD", "NO_OFFICIAL_STATUS_FEED"],
  );
  assert.equal(uncovered.routeEdges[0].accessibilityStatus, "NO_OFFICIAL_FEED");
  const maintenance = materializeAccessibilitySourceInput({
    input,
    kricSnapshot,
    seoulSnapshot: {
      ...seoulSnapshot,
      stations: [{ ...seoulSnapshot.stations[0], facilities: [{ operational: false }] }],
    },
  });
  assert.equal(maintenance.accessibilityStatusEvidence.at(-1).operationalStatus, "UNDER_MAINTENANCE");
  assert.throws(() => materializeAccessibilitySourceInput({
    input: { ...input, minimumProductionCoverage: { facilities: 2 } }, kricSnapshot, seoulSnapshot,
  }), /accessibility facility coverage below declared minimum: 1\/2/);
  assert.throws(() => materializeAccessibilitySourceInput({
    input,
    kricSnapshot: {
      ...kricSnapshot,
      queries: [{ ...kricSnapshot.queries[0], rows: [{ gubun: "DRIFT" }] }],
    },
    seoulSnapshot,
  }), /unknown KRIC facility code: DRIFT/);
  assert.throws(() => materializeAccessibilitySourceInput({
    input, kricSnapshot: { ...kricSnapshot, sourceId: "wrong" }, seoulSnapshot,
  }), /accessibility snapshot source identity mismatch/);
  assert.throws(() => materializeAccessibilitySourceInput({
    input,
    kricSnapshot: { ...kricSnapshot, queries: [{ ...kricSnapshot.queries[0], stationId: "station-missing" }] },
    seoulSnapshot,
  }), /KRIC snapshot canonical mapping missing: station-missing/);
});

test("station과 edge identity는 line까지 일치해야 하고 결측 line은 부재로 만들지 않는다", () => {
  const input = {
    sourceIds: [],
    stationMappings: [
      { sourceId: "molit-urban-rail-full-route", sourceStationCode: "MOLIT-L2-1", lineId: "line-2", stationId: "station-b" },
      { sourceId: "molit-urban-rail-full-route", sourceStationCode: "MOLIT-L1-1", lineId: "line-1", stationId: "station-a" },
    ],
    stationLineRows: [
      { sourceId: "molit-urban-rail-full-route", sourceStationCode: "MOLIT-L2-1", stationCode: "1", lineId: "line-2", stationNameKo: "나" },
      { sourceId: "molit-urban-rail-full-route", sourceStationCode: "MOLIT-L1-1", stationCode: "1", lineId: "line-1", stationNameKo: "가" },
    ],
    routeEdges: [{
      id: "edge-a", sourceId: "seoul-metro-accessibility", edgeType: "ENTRY",
      to: { sourceId: "official-lines", sourceStationCode: "1", lineId: "line-1" },
    }],
    supportedV1Scope: { includedStationIds: ["station-a"] },
    minimumProductionCoverage: { facilities: 1 },
    coverageEvidence: [],
  };
  const kricSnapshot = {
    sourceId: "kric-station-convenience-standard", snapshotId: "kric-1",
    observedAt: "2026-07-28T00:00:00Z", capturedAt: "2026-07-28T00:00:00Z",
    queries: [{
      stationId: "station-a", lineId: "line-1", railOprIsttCd: "S1", lnCd: "1", stinCd: "1",
      providerRecordHash: "a".repeat(64), rows: [{ gubun: "EV", grndDvCd: "1", stinFlor: 1, dtlLoc: "대합실" }],
    }],
  };
  const seoulSnapshot = {
    sourceId: "seoul-metro-accessibility", snapshotId: "seoul-1",
    observedAt: "2026-07-28T00:00:00Z", capturedAt: "2026-07-28T00:00:00Z",
    stations: [{ stationName: "가", lineName: "1호선", facilities: [{ operational: true }] }],
  };

  const output = materializeAccessibilitySourceInput({ input, kricSnapshot, seoulSnapshot });

  assert.match(output.facilityRows[0].name, /^가역/);
  assert.equal(output.routeEdges[0].providerRecordHash, output.accessibilityStatusEvidence.at(-1).providerRecordHash);
  assert.throws(() => materializeAccessibilitySourceInput({
    input: {
      ...input,
      stationMappings: [{ ...input.stationMappings[1], lineId: "line-x" }],
      stationLineRows: [{ ...input.stationLineRows[1], lineId: "line-x" }],
      routeEdges: [],
    },
    kricSnapshot: { ...kricSnapshot, queries: [{ ...kricSnapshot.queries[0], lineId: "line-x" }] },
    seoulSnapshot,
  }), /station line number missing: station-a/);
});

test("CLI는 알 수 없는 option을 거부한다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-accessibility-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, "input.json");
  const kricPath = path.join(directory, "kric.json");
  const seoulPath = path.join(directory, "seoul.json");
  const outputPath = path.join(directory, "output.json");
  await Promise.all([
    writeFile(inputPath, JSON.stringify({
      sourceIds: [], stationMappings: [], stationLineRows: [], routeEdges: [],
      supportedV1Scope: { includedStationIds: [] }, minimumProductionCoverage: { facilities: 0 }, coverageEvidence: [],
    })),
    writeFile(kricPath, JSON.stringify({ sourceId: "kric-station-convenience-standard", queries: [] })),
    writeFile(seoulPath, JSON.stringify({ sourceId: "seoul-metro-accessibility", stations: [] })),
  ]);

  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/materialize-accessibility-source-input.mjs",
    "--input", inputPath,
    "--kric-snapshot", kricPath,
    "--seoul-snapshot", seoulPath,
    "--output", outputPath,
    "--unexpected", "value",
  ], { cwd: path.resolve(import.meta.dirname, "../..") }), /unknown argument: --unexpected/);
  await assert.rejects(readFile(outputPath), /ENOENT/);
});
