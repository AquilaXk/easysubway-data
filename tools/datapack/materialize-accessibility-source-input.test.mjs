import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { collectKricAccessibilitySnapshots } from "./collect-kric-accessibility-snapshots.mjs";
import { materializeAccessibilitySourceInput } from "./materialize-accessibility-source-input.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";

const execFileAsync = promisify(execFile);

test("fresh KRIC codes와 Seoul status만 production source input으로 materialize한다", () => {
  const input = {
    sourceIds: ["kric-station-elevator-movement", "kric-wheelchair-lift-movement"],
    movementPathCandidates: [
      { sourceId: "kric-station-elevator-movement" },
      { sourceId: "kric-wheelchair-lift-movement" },
      { sourceId: "seoul-metro-accessibility", id: "seoul-status-candidate" },
    ],
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
    coverageEvidence: [{
      sourceDomain: "accessibility_facilities",
      sourceIds: ["kric-station-elevator-movement", "kric-wheelchair-lift-movement"],
    }],
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
  assert.deepEqual(output.movementPathCandidates, [
    { sourceId: "seoul-metro-accessibility", id: "seoul-status-candidate" },
  ]);
  assert.deepEqual(output.coverageEvidence[0].sourceIds, [
    "kric-station-convenience-standard",
    "seoul-metro-accessibility",
  ]);
  const regionalProjection = materializeAccessibilitySourceInput({
    input: {
      ...input,
      kricStandardAccessibilityRoster: [Object.fromEntries(
        ["stationId", "lineId", "railOprIsttCd", "lnCd", "stinCd"].map((field) => [field, kricSnapshot.queries[0][field]]),
      )],
    },
    kricSnapshot: {
      ...kricSnapshot,
      queries: [
        ...kricSnapshot.queries,
        {
          stationId: "station-outside-region", lineId: "line-outside-region",
          railOprIsttCd: "KR", lnCd: "K1", stinCd: "K999",
          providerRecordHash: "f".repeat(64), rows: [{ gubun: "EV", grndDvCd: "1", stinFlor: 1, dtlLoc: "외부 지역" }],
        },
      ],
    },
    seoulSnapshot,
  });
  assert.deepEqual(regionalProjection.facilityRows, output.facilityRows);
  assert.deepEqual(regionalProjection.accessibilityStatusEvidence, output.accessibilityStatusEvidence);
  for (const [row, expected] of [
    [{ gubun: "DRIFT" }, /unknown KRIC facility code: DRIFT/],
    [{ gubun: "EV", grndDvCd: "9", stinFlor: 1, dtlLoc: "외부 지역" }, /unknown KRIC ground division code: 9/],
  ]) {
    assert.throws(() => materializeAccessibilitySourceInput({
      input: {
        ...input,
        kricStandardAccessibilityRoster: [Object.fromEntries(
          ["stationId", "lineId", "railOprIsttCd", "lnCd", "stinCd"].map((field) => [field, kricSnapshot.queries[0][field]]),
        )],
      },
      kricSnapshot: {
        ...kricSnapshot,
        queries: [
          ...kricSnapshot.queries,
          {
            stationId: "station-outside-region", lineId: "line-outside-region",
            railOprIsttCd: "KR", lnCd: "K1", stinCd: "K999",
            providerRecordHash: "f".repeat(64), rows: [row],
          },
        ],
      },
      seoulSnapshot,
    }), expected);
  }
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

test("exact terminal 03은 facility를 만들지 않고 세 blocked carrier row로 보존한다", () => {
  const input = {
    sourceIds: [], coverageEvidence: [], movementPathCandidates: [], minimumProductionCoverage: { facilities: 0 },
    stationMappings: [{ sourceId: "molit-urban-rail-full-route", stationId: "station-b35616704ce3", lineId: "seoul-2", sourceStationCode: "S1-234-4" }],
    stationLineRows: [{ sourceId: "molit-urban-rail-full-route", sourceStationCode: "S1-234-4", stationCode: "4", lineId: "seoul-2", stationNameKo: "가역" }],
  };
  const output = materializeAccessibilitySourceInput({ input, kricSnapshot: {
    sourceId: "kric-station-convenience-standard", snapshotId: "kric-mixed", observedAt: "2026-08-15T00:00:00Z", capturedAt: "2026-08-15T00:00:00Z",
    providerResultCode: "MIXED", queries: [{ stationId: "station-b35616704ce3", lineId: "seoul-2", railOprIsttCd: "S1", lnCd: "2", stinCd: "234-4", providerResultCode: "03", terminalPolicy: "EXACT_TUPLE_PROVIDER_RESULT_03", providerRecordHash: null, rawResponseSha256: "a".repeat(64), rows: [] }],
  }, seoulSnapshot: { sourceId: "seoul-metro-accessibility", snapshotId: "seoul-1", observedAt: "2026-08-15T00:00:00Z", capturedAt: "2026-08-15T00:00:00Z", stations: [] } });
  assert.deepEqual(output.facilityRows, []);
  const blocked = output.accessibilityStatusEvidence.filter(({ evidenceKind }) => evidenceKind === "UNVERIFIED_EVIDENCE_BLOCKED");
  assert.equal(blocked.length, 3);
  for (const row of blocked) {
    assert.deepEqual(
      [row.operatorId, row.state, row.terminalPolicy, row.providerResultCode, row.strictRouteEligible, row.strictRouteEligibleReason, row.installationStatus, row.operationalStatus, row.statusMeaning, row.confidence, row.providerRecordHash, row.providerResponseSha256, row.evidenceReason],
      ["seoul-metro", "UNVERIFIED_EVIDENCE_BLOCKED", "EXACT_TUPLE_PROVIDER_RESULT_03", "03", false, "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED", "UNKNOWN", "UNKNOWN", "PROVIDER_RESULT_UNVERIFIED", 0, null, "a".repeat(64), "시설 존재·부재가 검증되지 않아 경로를 차단했습니다."],
    );
    assert.equal(row.evidenceHash, createHash("sha256").update(canonicalJson({
      sourceSnapshotId: "kric-mixed", stationId: "station-b35616704ce3", lineId: "seoul-2",
      operatorId: "seoul-metro", facilityType: row.facilityType,
      terminalPolicy: "EXACT_TUPLE_PROVIDER_RESULT_03", providerResponseSha256: "a".repeat(64),
    })).digest("hex"));
  }
  const candidate = {
    candidateId: "candidate-terminal", stationSetSha256: "b".repeat(64), sourceSetSha256: "c".repeat(64),
    mappingContractVersion: "station-line-v1", materializerVersion: "1",
  };
  const terminal = materializeStationLineAccessibility({
    candidate,
    stationLines: [{ stationId: "station-b35616704ce3", lineId: "seoul-2", operatorId: "seoul-metro" }],
    evidenceRows: blocked.map(({ note: _note, provenanceKind: _provenanceKind, verifiedAt: _verifiedAt, retrievedAt: _retrievedAt, ...row }) => ({
      ...row, ...candidate, domain: "FACILITY", evidenceRawSha256: "d".repeat(64),
      capturedAt: "2026-08-15T00:00:00.000Z", freshUntil: "2026-08-16T00:00:00.000Z",
      provenanceId: "kric-official", licenseId: "public-data-license",
    })),
    observedAt: "2026-08-15T12:00:00.000Z",
  });
  assert.equal(terminal.rows.find(({ domain }) => domain === "FACILITY").state, "UNVERIFIED_EVIDENCE_BLOCKED");
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

test("CLI는 알 수 없는 option을 거부하고 current KRIC snapshot metadata를 결속한다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-accessibility-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, "input.json");
  const kricPath = path.join(directory, "kric.json");
  const seoulPath = path.join(directory, "seoul.json");
  const outputPath = path.join(directory, "output.json");
  const [kricSnapshot] = await collectKricAccessibilitySnapshots({
    roster: [{
      stationId: "station-a", lineId: "line-1", railOprIsttCd: "S1", lnCd: "1", stinCd: "101",
      canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-a", lineId: "line-1" }],
    }],
    serviceKey: "unused",
    now: new Date("2026-08-27T00:00:00.000Z"),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ header: { resultCode: "00", resultMsg: "redacted" }, body: [] }),
    }),
  });
  await Promise.all([
    writeFile(inputPath, JSON.stringify({
      sourceIds: [],
      stationMappings: [{
        sourceId: "molit-urban-rail-full-route", sourceStationCode: "MOLIT-L-1",
        lineId: "line-1", stationId: "station-a",
      }],
      stationLineRows: [{
        sourceId: "molit-urban-rail-full-route", sourceStationCode: "MOLIT-L-1",
        stationCode: "1", lineId: "line-1", stationNameKo: "가",
      }],
      routeEdges: [],
      supportedV1Scope: { includedStationIds: [] }, minimumProductionCoverage: { facilities: 0 }, coverageEvidence: [],
    })),
    writeFile(kricPath, JSON.stringify(kricSnapshot)),
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

  await writeFile(kricPath, JSON.stringify({ ...kricSnapshot, contentSha256: "a".repeat(64) }));
  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/materialize-accessibility-source-input.mjs",
    "--input", inputPath,
    "--kric-snapshot", kricPath,
    "--seoul-snapshot", seoulPath,
    "--output", outputPath,
  ], { cwd: path.resolve(import.meta.dirname, "../..") }), /KRIC accessibility snapshot identity is invalid/);
  await assert.rejects(readFile(outputPath), /ENOENT/);

  await writeFile(kricPath, JSON.stringify(kricSnapshot));

  await execFileAsync(process.execPath, [
    "tools/datapack/materialize-accessibility-source-input.mjs",
    "--input", inputPath,
    "--kric-snapshot", kricPath,
    "--seoul-snapshot", seoulPath,
    "--output", outputPath,
  ], { cwd: path.resolve(import.meta.dirname, "../..") });
  const materialized = JSON.parse(await readFile(outputPath));
  assert.deepEqual(materialized.kricStandardAccessibilitySnapshot, {
    snapshotId: kricSnapshot.snapshotId,
    contentSha256: kricSnapshot.contentSha256,
    freshUntil: "2026-08-28T00:00:00.000Z",
  });
});
