import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCurrentExitPathSourceAdmission,
  main,
} from "./build-current-exit-path-source-admission.mjs";

const CAPTURED_AT = "2026-08-14T07:17:51.158Z";
const OBSERVED_AT = "2026-08-14T07:36:53.296Z";
const FRESH_UNTIL = "2026-08-15T07:17:51.158Z";
const SOURCE_ID = "kric-station-movement-standard";

test("current provider snapshot을 candidate station-line EXIT admission으로 투영한다", () => {
  const input = validInput();
  const result = buildCurrentExitPathSourceAdmission(input);

  assert.equal(result.normalizedSnapshot.schemaVersion, 3);
  assert.equal(result.normalizedSnapshot.queryPlan.length, 3);
  assert.deepEqual(result.normalizedSnapshot.results.map(({ state }) => state).sort(), [
    "OBSERVED_EXIT_PATH", "OBSERVED_EXIT_PATH", "PROVIDER_NO_DATA",
  ]);
  assert.equal(result.admission.decision, "GO");
  assert.equal(result.admission.stateSummary.ADMITTED_EXIT_PATH, 2);
  assert.equal(result.admission.stateSummary.UNKNOWN, 0);
  assert.equal(result.admission.materializerEvidenceRows.length, 2);
  assert.equal(
    result.admission.sourceIdentity.providerSnapshotDigest,
    JSON.parse(input.providerSnapshotBytes).snapshotDigest,
  );
  assert.equal(
    result.admission.sourceIdentity.providerSnapshotRawSha256,
    sha256(input.providerSnapshotBytes),
  );
  assert.equal(
    result.admission.sourceIdentity.facilityAdmissionDigest,
    input.facilityAdmission.admissionDigest,
  );
});

test("positive observation이 없는 provider no-data station-line은 UNKNOWN으로 유지한다", () => {
  const input = validInput();
  const snapshot = JSON.parse(input.providerSnapshotBytes);
  const stationBQueryId = input.collectionPlan.stationLineQueries
    .find(({ stationLineId }) => stationLineId === "station-b:seoul-4").queryIds[0];
  snapshot.results = snapshot.results.map((result) => result.queryId === stationBQueryId
    ? providerResult(result.queryId, "PROVIDER_NO_DATA")
    : result);
  input.providerSnapshotBytes = providerSnapshotBytes(snapshot);

  const result = buildCurrentExitPathSourceAdmission(input);
  assert.equal(result.admission.decision, "NO_GO");
  assert.equal(result.admission.stateSummary.ADMITTED_EXIT_PATH, 1);
  assert.equal(result.admission.stateSummary.UNKNOWN, 1);
  assert.equal(result.admission.cells.find(({ stationId }) => stationId === "station-b").admissionReason,
    "PROVIDER_NO_DATA_IS_NOT_ABSENCE");
});

test("raw identity, candidate identity와 source license drift를 fail closed한다", () => {
  const cases = [
    ["raw digest", (input) => {
      const snapshot = JSON.parse(input.providerSnapshotBytes);
      snapshot.snapshotDigest = "0".repeat(64);
      input.providerSnapshotBytes = Buffer.from(canonicalJson(snapshot));
    }, /provider snapshot digest mismatch/],
    ["candidate", (input) => { input.candidateBuildSpec.candidateId = "other"; }, /candidate identity mismatch/],
    ["collection plan", (input) => {
      input.collectionPlan.collectionPlanDigest = "0".repeat(64);
    }, /collection plan digest mismatch|collection plan identity mismatch/],
    ["license", (input) => {
      input.sourceInventory.sources[0].license.redistributionAllowed = false;
    }, /source license mismatch/],
    ["source set", (input) => {
      input.candidateBuildSpec.sourceSnapshotSetHash = "f".repeat(64);
    }, /source snapshot set identity mismatch/],
  ];
  for (const [label, mutate, expected] of cases) {
    const input = validInput();
    mutate(input);
    assert.throws(() => buildCurrentExitPathSourceAdmission(input), expected, label);
  }
});

test("CLI는 normalized snapshot과 admission을 absent directory에 함께 쓴다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-exit-admission-"));
  const input = validInput();
  const paths = {
    provider: path.join(root, "provider.json"),
    plan: path.join(root, "plan.json"),
    facility: path.join(root, "facility.json"),
    candidate: path.join(root, "candidate.json"),
    inventory: path.join(root, "inventory.json"),
    sourceSnapshots: path.join(root, "source-snapshots.json"),
    output: path.join(root, "output"),
  };
  await Promise.all([
    writeFile(paths.provider, input.providerSnapshotBytes),
    writeFile(paths.plan, canonicalJson(input.collectionPlan)),
    writeFile(paths.facility, `${JSON.stringify(input.facilityAdmission, null, 2)}\n`),
    writeFile(paths.candidate, `${JSON.stringify(input.candidateBuildSpec, null, 2)}\n`),
    writeFile(paths.inventory, `${JSON.stringify(input.sourceInventory, null, 2)}\n`),
    writeFile(paths.sourceSnapshots, `${JSON.stringify(input.sourceSnapshots, null, 2)}\n`),
  ]);

  await main([
    "--provider-snapshot", paths.provider,
    "--collection-plan", paths.plan,
    "--facility-admission", paths.facility,
    "--candidate-build-spec", paths.candidate,
    "--source-inventory", paths.inventory,
    "--source-snapshots", paths.sourceSnapshots,
    "--observed-at", OBSERVED_AT,
    "--output-directory", paths.output,
  ], { log: () => {} });

  const normalizedPath = path.join(paths.output, "exit-path-normalized-source-snapshot.json");
  const admissionPath = path.join(paths.output, "exit-path-source-admission.json");
  const [normalized, admission, normalizedStat, admissionStat] = await Promise.all([
    readFile(normalizedPath, "utf8"),
    readFile(admissionPath, "utf8"),
    stat(normalizedPath),
    stat(admissionPath),
  ]);
  assert.equal(JSON.parse(normalized).artifactKind, "exit-path-normalized-source-snapshot");
  assert.equal(JSON.parse(admission).decision, "GO");
  assert.equal(normalizedStat.mode & 0o777, 0o600);
  assert.equal(admissionStat.mode & 0o777, 0o600);
  await assert.rejects(() => main([
    "--provider-snapshot", paths.provider,
    "--collection-plan", paths.plan,
    "--facility-admission", paths.facility,
    "--candidate-build-spec", paths.candidate,
    "--source-inventory", paths.inventory,
    "--source-snapshots", paths.sourceSnapshots,
    "--observed-at", OBSERVED_AT,
    "--output-directory", paths.output,
  ], { log: () => {} }), /output directory must be absent/);
});

function validInput() {
  const sourceSnapshots = [{
    sourceId: "base-source",
    snapshotId: "base-snapshot",
    rawSha256: "1".repeat(64),
    rawObjectUri: "s3://example/base.json",
    schemaFingerprint: "2".repeat(64),
    licenseStatus: "PASS",
    redistributionAllowed: true,
    snapshotStatus: "LOCKED",
    credentialRedacted: true,
  }];
  const candidate = {
    candidateId: "capital-pilot-candidate-20260813",
    stationSetSha256: "",
    sourceSetSha256: sha256(JSON.stringify(sourceSnapshots)),
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
  };
  const stationLines = [stationLine("station-a", "가역", "101"), stationLine("station-b", "나역", "102")];
  candidate.stationSetSha256 = sha256(canonicalJson(stationLines.map(({ stationId }) => stationId)));
  const queryA1 = query(stationLines[0], "101", "102", "edge-a-b");
  const queryA2 = query(stationLines[0], "101", "103", "edge-a-c");
  const queryB = query(stationLines[1], "102", "101", "edge-b-a");
  const outside = query(stationLine("station-c", "다역", "103"), "103", "101", "edge-c-a");
  const queryPlan = [queryA1, queryA2, queryB, outside].sort(compareQueries);
  const providerMappings = stationLines.concat([stationLine("station-c", "다역")]).map((line) => ({
    stationId: line.stationId,
    lineId: line.lineId,
    providerOperatorId: "S1",
    providerLineId: "4",
    providerStationId: line.stationId === "station-a" ? "101" : line.stationId === "station-b" ? "102" : "103",
  }));
  const stationLineQueries = [
    { stationLineId: "station-a:seoul-4", queryIds: [queryA1.queryId, queryA2.queryId] },
    { stationLineId: "station-b:seoul-4", queryIds: [queryB.queryId] },
    { stationLineId: "station-c:seoul-4", queryIds: [outside.queryId] },
  ];
  const collectionPlanPayload = {
    schemaVersion: 1,
    artifactKind: "kric-exit-path-collection-plan",
    candidate: {
      candidateId: `current-production-exit-${"a".repeat(64)}`,
      stationSetSha256: sha256(canonicalJson(["station-a", "station-b", "station-c"])),
      stationLineSetSha256: sha256("full-station-line-set"),
      stationLineMappingSha256: sha256("full-station-line-mapping"),
      providerMappingSha256: sha256(canonicalJson(providerMappings)),
      topologySha256: sha256("topology"),
    },
    providerMappings,
    routeEdges: [],
    queryPlan,
    stationLineQueries,
    queryPlanSha256: sha256(canonicalJson(queryPlan)),
  };
  const collectionPlan = {
    ...collectionPlanPayload,
    collectionPlanDigest: sha256(canonicalJson(collectionPlanPayload)),
  };
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "kric-exit-path-provider-snapshot",
    sourceId: SOURCE_ID,
    snapshotId: "kric-station-movement-standard-20260814T071751158Z",
    capturedAt: CAPTURED_AT,
    freshUntil: FRESH_UNTIL,
    credentialRedacted: true,
    collectionPlanDigest: collectionPlan.collectionPlanDigest,
    queryPlanSha256: sha256(canonicalJson(queryPlan)),
    coverage: { requestPlanComplete: true, queryIds: queryPlan.map(({ queryId }) => queryId) },
    queryPlan,
    results: queryPlan.map(({ queryId }) => {
      if (queryId === queryA2.queryId || queryId === outside.queryId) {
        return providerResult(queryId, "PROVIDER_NO_DATA");
      }
      return providerResult(queryId, "ROWS_OBSERVED");
    }),
  };
  const facilityPayload = {
    schemaVersion: 1,
    artifactKind: "facility-source-admission-matrix",
    observedAt: "2026-08-13T23:18:58.000Z",
    candidate,
    sourceIdentity: {},
    stationLineSetSha256: sha256(canonicalJson(stationLines.map(({ stationId, lineId, operatorId }) => ({
      stationId, lineId, operatorId,
    })))),
    stationLineMappingSha256: sha256(canonicalJson(stationLines)),
    sourceInputIdentitySha256: "3".repeat(64),
    queryPartition: {
      joined: stationLines.map((line) => ({
        stationId: line.stationId,
        lineId: line.lineId,
        providerOperatorId: "S1",
        providerLineId: "4",
        providerStationId: line.stationId === "station-a" ? "101" : "102",
      })),
      unmatched: [],
      ambiguous: [],
      summary: {},
    },
    inputEvidencePartition: {},
    denominatorRows: [],
    denominatorStateSummary: {},
    cells: stationLines.map((line) => ({
      candidateId: candidate.candidateId,
      stationSetSha256: candidate.stationSetSha256,
      sourceSetSha256: candidate.sourceSetSha256,
      stationId: line.stationId,
      lineId: line.lineId,
      operatorId: line.operatorId,
      state: "ADMITTED_FACILITY_PRESENT",
    })),
    cellStateSummary: {},
    materializerEvidenceRows: [],
    decision: "GO",
  };
  const facilityAdmission = {
    ...facilityPayload,
    admissionDigest: sha256(canonicalJson(facilityPayload)),
  };
  return {
    providerSnapshotBytes: providerSnapshotBytes(snapshot),
    collectionPlan,
    facilityAdmission,
    candidateBuildSpec: {
      schemaVersion: 1,
      artifactKind: "datapack-candidate-build-spec",
      candidateId: candidate.candidateId,
      sourceSnapshotIds: sourceSnapshots.map(({ snapshotId }) => snapshotId),
      sourceSnapshots: sourceSnapshots.map((entry) => ({ ...entry })),
      sourceSnapshotSetHash: candidate.sourceSetSha256,
    },
    sourceSnapshots,
    sourceInventory: {
      sources: [{
        id: SOURCE_ID,
        owner: "국가철도공단",
        provider: "국가철도공단",
        providerDepartment: "철도산업정보센터",
        sourceSystem: "KRIC OpenAPI",
        datasetUrl: "https://data.kric.go.kr/example",
        datasetKind: "open-api",
        coverageScope: { regionIds: ["capital"], operatorIds: ["seoul-metro"], sourceDomains: ["indoor_movement_paths"] },
        license: {
          type: "KOGL-1",
          name: "공공누리 1유형",
          attribution: "출처표시",
          commercialUseAllowed: true,
          derivativeWorkAllowed: true,
          redistributionAllowed: true,
          evidenceUrl: "https://data.kric.go.kr/example",
        },
        admissionEvidence: {
          decision: "APPROVED",
          licenseEvidenceHash: "4".repeat(64),
        },
      }],
    },
    observedAt: OBSERVED_AT,
  };
}

function stationLine(stationId, stationName) {
  return {
    stationId,
    stationName,
    stationAliases: [],
    regionId: "capital",
    lineId: "seoul-4",
    lineName: "4호선",
    operatorId: "seoul-metro",
    operatorName: "서울교통공사",
  };
}

function query(line, providerStationId, providerNextStationId, routeEdgeId) {
  const identity = {
    providerLineId: "4",
    providerNextStationId,
    providerOperatorId: "S1",
    providerStationId,
    routeEdgeId,
  };
  return {
    queryId: sha256(canonicalJson(identity)),
    routeEdgeId,
    providerOperatorId: "S1",
    providerLineId: "4",
    providerStationId,
    providerNextStationId,
    operatorName: line.operatorName,
    lineName: line.lineName,
    stationName: line.stationName,
    regionId: line.regionId,
  };
}

function providerResult(queryId, state) {
  const rows = state === "ROWS_OBSERVED" ? [{
    edMovePath: "출입구",
    elvtSttCd: "1",
    elvtTpCd: "EV",
    exitMvTpOrdr: "1",
    imgPath: null,
    mvContDtl: "이동",
    mvPathMgNo: queryId.slice(0, 12),
    stMovePath: "승강장",
  }] : [];
  return {
    queryId,
    state,
    providerResultCode: state === "PROVIDER_NO_DATA" ? "03" : "00",
    rawResponseSha256: sha256(`raw:${queryId}:${state}`),
    rawResponseByteSize: 64,
    providerRecordHash: sha256(canonicalJson(rows)),
    rows,
  };
}

function providerSnapshotBytes(snapshot) {
  const { snapshotDigest: ignored, ...payload } = snapshot;
  return Buffer.from(canonicalJson({ ...payload, snapshotDigest: sha256(canonicalJson(payload)) }));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
}

function compareQueries(left, right) {
  return compareBytes(left.providerStationId, right.providerStationId)
    || compareBytes(left.providerNextStationId, right.providerNextStationId)
    || compareBytes(left.routeEdgeId, right.routeEdgeId)
    || compareBytes(left.queryId, right.queryId);
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
