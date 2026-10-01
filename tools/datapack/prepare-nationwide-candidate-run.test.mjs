import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { prepareNationwideCandidate, formatPlatformInfo, resolveMolitTransferSnapshot, resolveNationwideCandidateInputSnapshots } from "./prepare-nationwide-candidate-run.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha256 = (val) => createHash("sha256").update(val).digest("hex");

test("prepareNationwideCandidate enforces two-person rule strictly", async () => {
  // Missing requester
  await assert.rejects(
    async () => {
      await prepareNationwideCandidate({
        requestedBy: "",
        approvedBy: "approver-id",
      });
    },
    /DATAPACK_REQUESTED_BY/
  );

  // Missing approver
  await assert.rejects(
    async () => {
      await prepareNationwideCandidate({
        requestedBy: "requester-id",
        approvedBy: "",
      });
    },
    /DATAPACK_APPROVED_BY/
  );

  // Self-approval violation
  await assert.rejects(
    async () => {
      await prepareNationwideCandidate({
        requestedBy: "same-person",
        approvedBy: "same-person",
      });
    },
    /Two-person rule violation: requester and approver cannot be the same person/
  );

  await assert.rejects(
    async () => {
      await prepareNationwideCandidate({
        requestedBy: "   same-person   ",
        approvedBy: "same-person",
      });
    },
    /Two-person rule violation/
  );

  // Case-variation bypass check (e.g. aquila vs Aquila)
  await assert.rejects(
    async () => {
      await prepareNationwideCandidate({
        requestedBy: "aquila",
        approvedBy: "Aquila",
      });
    },
    /Two-person rule violation: requester and approver cannot be the same person/
  );

  await assert.rejects(
    async () => {
      await prepareNationwideCandidate({
        requestedBy: "   AQUILA   ",
        approvedBy: "aquila",
      });
    },
    /Two-person rule violation: requester and approver cannot be the same person/
  );
});

test("nationwide candidate preparation records genuine non-literal hashes and fail-closed evidence", async () => {
  const result = await prepareNationwideCandidate({
    requestedBy: "data-operator-lead",
    approvedBy: "data-release-authority",
    releaseSequence: 122,
    writeFiles: true,
  });
  const stationLineData = result.stationLineInput;
  const stationLineRaw = JSON.stringify(stationLineData);

  const fakeLiteralHashes = [
    sha256("facility-record-hash"),
    sha256("exit-record-hash"),
    sha256("transfer-record-hash"),
  ];

  // 1. Literal hashes must not exist anywhere in the JSON
  for (const literal of ["facility-record-hash", "exit-record-hash", "transfer-record-hash"]) {
    assert.strictEqual(
      stationLineRaw.includes(literal),
      false,
      `Raw station-line input must not contain literal string '${literal}'`
    );
  }

  // 2. Exactly 3,306 evidence rows (1,102 pairs * 3 domains)
  assert.strictEqual(stationLineData.evidenceRows.length, 3306);

  const facilityRows = stationLineData.evidenceRows.filter((r) => r.domain === "FACILITY");
  const exitRows = stationLineData.evidenceRows.filter((r) => r.domain === "EXIT");
  const transferRows = stationLineData.evidenceRows.filter((r) => r.domain === "TRANSFER");

  assert.strictEqual(facilityRows.length, 1102);
  assert.strictEqual(exitRows.length, 1102);
  assert.strictEqual(transferRows.length, 1102);

  // None of the rows should match any fake literal hash
  for (const row of stationLineData.evidenceRows) {
    assert.strictEqual(
      fakeLiteralHashes.includes(row.providerRecordHash),
      false,
      `Row for station ${row.stationId} domain ${row.domain} contains fake literal hash`
    );
  }

  // 3. Exactly 639 unmapped stations in FACILITY must be fail-closed UNKNOWN with authentic freshUntil
  const unmappedFacility = facilityRows.filter(
    (r) => r.state === "UNKNOWN" && r.evidenceKind === "PROVIDER_NO_DATA" && r.evidenceReason === "FACILITY_DATA_NOT_PROVIDED"
  );
  assert.strictEqual(unmappedFacility.length, 639, "Exactly 639 unmapped stations must have FACILITY_DATA_NOT_PROVIDED");
  // freshUntil은 fan-in이 고른 KRIC 편의시설 원장 head의 신선도 만료다(#862: 고정 날짜 대신 커밋된 fan-in에서 읽는다).
  const committedFanIn = JSON.parse(await readFile(path.join(root, "tools/datapack/release/current-five-region-source-fan-in.json"), "utf8"));
  const kricConvenienceHead = committedFanIn.selectedSources.find(({ sourceId }) => sourceId === "kric-station-convenience-standard");
  for (const r of unmappedFacility) {
    assert.strictEqual(r.freshUntil, kricConvenienceHead.freshnessExpiresAt, "Unmapped facility must have genuine KRIC convenience freshUntil");
  }
  assert.strictEqual(
    stationLineRaw.includes("2027-07-13T00:00:00.000Z"),
    false,
    "Raw station-line input must not contain forged timestamp '2027-07-13T00:00:00.000Z'"
  );

  // Total FACILITY UNKNOWN = 641 (639 unmapped + 1 blocked capital station + 1 Gwangju Nokdong)
  const totalUnknownFacility = facilityRows.filter((r) => r.state === "UNKNOWN");
  assert.strictEqual(totalUnknownFacility.length, 641);
  // #862: 광주 녹동은 공식 엘리베이터·에스컬레이터 행이 없다(null). 휠체어리프트 0만으로 부재를 단정하지 않는다.
  const nokdong = facilityRows.find((r) => r.stationId === "station-73a324a117ea" && r.lineId === "line-e57a361e8892");
  assert.equal(nokdong.state, "UNKNOWN");
  assert.equal(nokdong.evidenceReason, "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED");

  // 4. All 1,102 EXIT domain rows must be fail-closed UNKNOWN
  const exitUnknown = exitRows.filter(
    (r) => r.state === "UNKNOWN" && r.evidenceKind === "PROVIDER_NO_DATA" && r.evidenceReason === "EXIT_DATA_NOT_PROVIDED"
  );
  assert.strictEqual(exitUnknown.length, 1102, "All 1,102 stations must be fail-closed UNKNOWN in EXIT domain");

  // 5. TRANSFER domain distribution
  const transferNotApplicable = transferRows.filter(
    (r) => r.state === "NOT_APPLICABLE" && r.evidenceKind === "CURRENT_APPLICABILITY_RULE"
  );
  assert.strictEqual(transferNotApplicable.length, 798, "Single-line stations must be NOT_APPLICABLE");

  const transferUnknown = transferRows.filter(
    (r) => r.state === "UNKNOWN" && r.evidenceKind === "PROVIDER_NO_DATA" && r.evidenceReason === "TRANSFER_DATA_NOT_PROVIDED"
  );
  assert.strictEqual(transferUnknown.length, 251, "Unmeasured transfer stations must be UNKNOWN/PROVIDER_NO_DATA");

  const transferPresent = transferRows.filter(
    (r) => r.state === "VERIFIED_PRESENT" && r.evidenceKind === "OBSERVED"
  );
  assert.strictEqual(transferPresent.length, 53, "Measured transfer stations must be VERIFIED_PRESENT");
});

test("nationwide route edge input rejects fake constants and unverified outdoor links", async () => {
  const result = await prepareNationwideCandidate({
    requestedBy: "data-operator-lead",
    approvedBy: "data-release-authority",
    releaseSequence: 122,
    writeFiles: false,
  });

  const routeData = result.routeInput;

  const entries = routeData.routeEdges.filter((e) => e.edgeType === "ENTRY");
  const exits = routeData.routeEdges.filter((e) => e.edgeType === "EXIT");
  const inStationTransfers = routeData.routeEdges.filter((e) => e.edgeType === "IN_STATION_TRANSFER");
  const outOfStationTransfers = routeData.routeEdges.filter((e) => e.edgeType === "OUT_OF_STATION_TRANSFER");

  // 1. Total counts
  assert.strictEqual(entries.length, 1102);
  assert.strictEqual(exits.length, 1102);
  assert.strictEqual(inStationTransfers.length, 388);
  assert.strictEqual(outOfStationTransfers.length, 14);

  // 2. ENTRY edges: no fake 90s/50m constant, all 0s/0m
  for (const e of entries) {
    assert.strictEqual(e.durationSeconds, 0, `Entry edge ${e.edgeId} must have durationSeconds 0`);
    assert.strictEqual(e.distanceMeters, 0, `Entry edge ${e.edgeId} must have distanceMeters 0`);
  }

  // 3. EXIT edges: no fake 60s/50m constant, all 0s/0m
  for (const e of exits) {
    assert.strictEqual(e.durationSeconds, 0, `Exit edge ${e.edgeId} must have durationSeconds 0`);
    assert.strictEqual(e.distanceMeters, 0, `Exit edge ${e.edgeId} must have distanceMeters 0`);
  }

  // 4. IN_STATION_TRANSFER: no fake 120s/50m uniform constants
  const uniformFakeTransfers = inStationTransfers.filter(
    (e) => e.durationSeconds === 120 && e.distanceMeters === 50
  );
  assert.strictEqual(uniformFakeTransfers.length, 0, "No transfer edge may have 120s/50m fake uniform constant");

  // Unmeasured in-station transfers are 0s/0m, measured ones are >0
  const zeroTransfers = inStationTransfers.filter((e) => e.durationSeconds === 0 && e.distanceMeters === 0);
  const measuredTransfers = inStationTransfers.filter((e) => e.durationSeconds > 0 && e.distanceMeters > 0);
  assert.strictEqual(zeroTransfers.length, 332);
  assert.strictEqual(measuredTransfers.length, 56);

  // 5. Canonical pack outdoor transfers must NOT have future timestamps or fabricated NO_STAIRS/AVAILABLE
  const canonicalPack = result.finalPack;
  const canonicalPackRaw = JSON.stringify(canonicalPack);
  assert.strictEqual(canonicalPackRaw.includes("1781568000"), false, "Must not contain fake future timestamp 1781568000");

  for (const link of canonicalPack.outOfStationTransferLinks) {
    assert.strictEqual(link.accessibilityStatus, "UNKNOWN");
    assert.strictEqual(link.stairAccessState, "UNKNOWN");
    assert.strictEqual(link.lastFieldVerifiedAt, undefined);
    assert.strictEqual(link.reliabilityScore, 0);
  }
});

test("prepareNationwideCandidate enforces fail-closed git provenance", async () => {
  const origGit = process.env.GIT_BIN;
  try {
    process.env.GIT_BIN = "false";
    await assert.rejects(
      async () => {
        await prepareNationwideCandidate({
          requestedBy: "operator-alice",
          approvedBy: "operator-bob",
        });
      },
      /Failed to resolve git HEAD commit/
    );

    process.env.GIT_BIN = "echo";
    await assert.rejects(
      async () => {
        await prepareNationwideCandidate({
          requestedBy: "operator-alice",
          approvedBy: "operator-bob",
        });
      },
      /Invalid git HEAD commit sha/
    );
  } finally {
    if (origGit) process.env.GIT_BIN = origGit;
    else delete process.env.GIT_BIN;
  }
});

test("prepareNationwideCandidate dynamically generates authentic nationwide candidate without synthetic schedules", async () => {
  const result = await prepareNationwideCandidate({
    requestedBy: "data-operator-lead",
    approvedBy: "data-release-authority",
    releaseSequence: 122,
  });

  assert.ok(result.preparationRelPath);
  assert.ok(result.nationwidePackRelPath);
  assert.ok(result.routeInputRelPath);
  assert.ok(result.stationLineInputRelPath);
  // #862: spec·request·hash evidence는 prepare가 아니라 build-nationwide-candidate.mjs --preparation이 만든다.
  assert.equal(Object.hasOwn(result, "buildSpecRelPath"), false);
  assert.equal(Object.hasOwn(result, "releaseRequestRelPath"), false);
  assert.equal(Object.hasOwn(result, "hashEvidenceRelPath"), false);

  // 1. Verify nationwide production pack
  const packRaw = await readFile(path.join(root, result.nationwidePackRelPath), "utf8");
  const packData = JSON.parse(packRaw);
  const pack = packData.packs[0];

  // Authentic routes across all nationwide operational scopes
  assert.strictEqual(pack.transitRoutes.length, 15);
  const routeIds = new Set(pack.transitRoutes.map((r) => r.id));
  assert.ok(routeIds.has("route-seoul-4-up"));
  assert.ok(routeIds.has("route-seoul-4-down"));
  assert.ok(routeIds.has("route-incheon-1-up"));
  assert.ok(routeIds.has("route-incheon-1-dn"));
  assert.ok(routeIds.has("route-incheon-2-up"));
  assert.ok(routeIds.has("route-incheon-2-dn"));
  assert.ok(routeIds.has("route-busan-line-1"));
  assert.ok(routeIds.has("route-busan-line-2"));
  assert.ok(routeIds.has("route-busan-line-3"));
  assert.ok(routeIds.has("route-busan-line-4"));
  assert.ok(routeIds.has("route-daegu-line-1"));
  assert.ok(routeIds.has("route-daegu-line-2"));
  assert.ok(routeIds.has("route-daegu-line-3"));
  assert.ok(routeIds.has("route-daejeon-line-1"));
  assert.ok(routeIds.has("route-gwangju-line-1"));

  // Zero synthetic trips manufactured by interval loop
  const syntheticTrips = pack.transitTrips.filter((t) => /trip-.*-(wd|hd)-\d+/.test(t.id));
  assert.strictEqual(syntheticTrips.length, 0, "Pack must contain 0 synthetic trips");
  // #855: 대전·광주 추정 종착역 정차 898개와 원천 정차 하나뿐인 녹동 출발 38개(격리 증거)가 빠진다.
  assert.strictEqual(pack.transitTrips.length, 9013, "Pack must contain exactly 9,013 authentic trips");
  assert.strictEqual(pack.transitStopTimes.length, 243389, "Pack must contain exactly 243,389 authentic stop times");
  assert.strictEqual(pack.serviceCalendars.length, 22);
  assert.strictEqual(pack.serviceCalendarDates.length, 104);

  // Station car door hints expanded nationwide. #854: 계약 밖 KRIC 행은 격리 증거로 옮겨지고
  // 팩에 남은 행과 격리 행의 합은 격리 전 435행과 같다.
  const carDoorQuarantine = JSON.parse(await readFile(
    path.join(root, "tools/datapack/release/nationwide-car-door-hint-quarantine.json"),
    "utf8",
  ));
  assert.strictEqual(carDoorQuarantine.summary.quarantinedCount, 386);
  assert.strictEqual(pack.stationCarDoorHints.length, 49);
  assert.strictEqual(pack.stationCarDoorHints.length + carDoorQuarantine.summary.quarantinedCount, 435);
  assert.strictEqual(pack.minimumTableRows.station_car_door_hints, 49);

  // Platform info fully populated on all station lines
  const emptyPlatformLines = pack.stationLines.filter((sl) => !sl.platformInfo || sl.platformInfo.trim() === "");
  assert.strictEqual(emptyPlatformLines.length, 0, "All stationLines must have non-empty platformInfo");

  // 2. Verify candidate preparation provenance
  const prepRaw = await readFile(path.join(root, result.preparationRelPath), "utf8");
  const prep = JSON.parse(prepRaw);
  assert.match(prep.builderIdentity.gitSha, /^[0-9a-f]{40}$/);
  assert.notStrictEqual(prep.builderIdentity.gitSha, "d7fe7773528239e27e3788679d1b46b813cce046");
  assert.strictEqual(prep.authority.requestedBy, "data-operator-lead");
  assert.strictEqual(prep.authority.approvedBy, "data-release-authority");

  // 3. 준비 결과가 후보 생성기에 넘길 팩·입력 파일을 정확히 가리킨다.
  assert.strictEqual(prep.materialization.fixturePath, result.nationwidePackRelPath);
  assert.strictEqual(prep.stationLineInput.path, result.stationLineInputRelPath);
  assert.strictEqual(prep.stationLineInput.sha256,
    sha256(await readFile(path.join(root, result.stationLineInputRelPath))));
  assert.strictEqual(prep.routeEdgeInput.sha256,
    sha256(await readFile(path.join(root, result.routeInputRelPath))));
});

test("formatPlatformInfo normalizes KRIC and regional platform metadata to canonical JSON", () => {
  // 1. Empty/falsy/primitive edge cases
  assert.strictEqual(formatPlatformInfo(null), "");
  assert.strictEqual(formatPlatformInfo(undefined), "");
  assert.strictEqual(formatPlatformInfo({}), "");
  assert.strictEqual(formatPlatformInfo([]), "");
  assert.strictEqual(formatPlatformInfo(123), "");
  assert.strictEqual(formatPlatformInfo(true), "");
  assert.strictEqual(formatPlatformInfo(false), "");
  assert.strictEqual(formatPlatformInfo({ unknownField: "ignore" }), "");

  // 2. Existing string preserved
  assert.strictEqual(formatPlatformInfo("당고개 방면 / 오이도 방면"), "당고개 방면 / 오이도 방면");

  // 3. KRIC stPlf field names
  const kricRaw = {
    plfCplFlg: "Y",
    plfTpNm: "상대식",
    scrCharExt: "10",
    sfFotExt: "200",
  };
  const expectedKric = JSON.stringify({
    oppositeCrossing: "Y",
    platformType: "상대식",
    screenDoor: "10",
    safetyGap: "200",
  });
  assert.strictEqual(formatPlatformInfo(kricRaw), expectedKric);

  // 4. Regional agency field names (e.g. Daejeon)
  const regionalRaw = {
    opposite_side: "가능",
    unload_door: "오른쪽",
    platform: "상대식",
    screen_door: "설치",
  };
  const expectedRegional = JSON.stringify({
    oppositeCrossing: "Y",
    platformType: "상대식",
    screenDoor: "설치",
    unloadDoor: "오른쪽",
  });
  assert.strictEqual(formatPlatformInfo(regionalRaw), expectedRegional);

  // 5. Canonical field names and boolean conversions
  const canonical = {
    oppositeCrossing: "N",
    platformType: "섬식",
    unloadDoor: "LEFT",
  };
  assert.strictEqual(formatPlatformInfo(canonical), JSON.stringify(canonical));

  const booleanCrossing = {
    oppositeCrossing: true,
  };
  assert.strictEqual(formatPlatformInfo(booleanCrossing), JSON.stringify({ oppositeCrossing: "Y" }));
});

test("prepareNationwideCandidate binds platform metadata onto stationLines", async () => {
  const sampleMap = new Map([
    ["station-00089f8f97de:line-558d0bd8312d", { plfCplFlg: "Y", plfTpNm: "상대식", scrCharExt: "10" }],
  ]);

  const rawBefore = await readFile(path.join(root, "tools/datapack/release/nationwide-production-canonical-pack.json"), "utf8");

  const result = await prepareNationwideCandidate({
    requestedBy: "data-operator-lead",
    approvedBy: "data-release-authority",
    platformInfoMap: sampleMap,
    writeFiles: false,
  });

  const pack = result.finalPack;
  const targetLine = pack.stationLines.find(
    (sl) => sl.stationId === "station-00089f8f97de" && sl.lineId === "line-558d0bd8312d"
  );
  assert.ok(targetLine, "Target stationLine must exist");
  assert.strictEqual(
    targetLine.platformInfo,
    JSON.stringify({ oppositeCrossing: "Y", platformType: "상대식", screenDoor: "10" })
  );

  // Assert that on-disk canonical pack was not mutated by test execution
  const rawAfter = await readFile(path.join(root, result.nationwidePackRelPath), "utf8");
  assert.strictEqual(rawAfter, rawBefore, "On-disk release pack must remain unpolluted by test run");

  const canonicalOnDisk = JSON.parse(rawAfter).packs[0];
  const diskLine = canonicalOnDisk.stationLines.find(
    (sl) => sl.stationId === "station-00089f8f97de" && sl.lineId === "line-558d0bd8312d"
  );
  assert.notStrictEqual(diskLine.platformInfo, targetLine.platformInfo, "On-disk release pack must not contain sampleMap override");
});



// #862 결정 #15: 후보 입력 snapshot은 고정 경로가 아니라 원장 head(+ fan-in 선택)에서 고른다.
async function committedSelectionInputs() {
  const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  return {
    sourceInventory: await readJson("tools/datapack/source-inventory.json"),
    sourceSnapshots: await readJson("tools/datapack/release/source-snapshots.json"),
    fanIn: await readJson("tools/datapack/release/current-five-region-source-fan-in.json"),
    freshnessPolicy: await readJson("release/product-gates/datapack-freshness-sla.json"),
    readSourceBytes: (relative) => readFile(path.join(root, relative)),
  };
}

// 커밋된 후보(2026-10-01 재생성)의 시계는 인천 station-info(route_graph_topology, P1D) 창 안이다.
// 선택 규칙만 보는 테스트는 커밋된 시계를 그대로 쓴다.
async function committedSelectionInputsWithinIncheonWindow() {
  return committedSelectionInputs();
}

// 2026-10-01 공식 도구로 등록한 원장 head(커밋된 후보 seq123이 고른 입력)다.
const COMMITTED_INPUT_SNAPSHOT_IDS = Object.freeze({
  incheonTopology: "incheon-transit-station-info-20261001",
  incheonLine1: "incheon-line1-train-timetable-20261001",
  incheonLine2: "incheon-line2-train-timetable-20261001",
  busanAccessibility: "busan-transportation-accessibility-e375fb59a4dca444fbca4bf3c5b1f8d22798a2246eb1c079d89d94cf26539718-20261001",
  daeguAccessibility: "daegu-transportation-accessibility-c4ad26c98f70af70ea6b934bf139cc5f8da2d9f79e431634c29e15363abd897f-20261001",
  daejeonAccessibility: "daejeon-transportation-accessibility-15481d28be46f5f4ac48f56f869667c8848180a2f487879c8ed17a97f51a7c19-20261001",
  gwangjuAccessibility: "gwangju-transportation-accessibility-31f78d5d42932d519fa8848f234bdce91348de567363e34f73ff9ef625d95ebd-20261001",
  kricConvenience: "kric-station-convenience-standard-20261001T050747096Z",
  busanTimetable: "busan-transportation-timetable-20261001",
  daeguTimetable1: "daegu-line1-train-timetable-596c7bd51ae34e5f482df154316e08d166c89bcbb27ab180f6170f6c8ce9d264",
  daeguTimetable2: "daegu-line2-train-timetable-bbc7d89913727bbc29c7ae2804994d6a901013df345a73ae8344d81b4800e17b",
  daeguTimetable3: "daegu-line3-train-timetable-54570947f7cb59ad8b1ea510bdcbf696e15b4e21efef4f89997638fd441d3b55",
  daejeonTimetable: "daejeon-train-timetable-20261001",
});

test("후보 입력 선택은 커밋된 원장 head·inventory evidence에서 현재 입력 13개를 고른다", async () => {
  const selected = await resolveNationwideCandidateInputSnapshots(await committedSelectionInputsWithinIncheonWindow());
  assert.deepEqual(Object.keys(selected).sort(), Object.keys(COMMITTED_INPUT_SNAPSHOT_IDS).sort());
  for (const [key, snapshotId] of Object.entries(COMMITTED_INPUT_SNAPSHOT_IDS)) {
    assert.equal(selected[key].snapshotId, snapshotId, key);
    assert.equal(selected[key].path, `tools/datapack/sources/${snapshotId}.json`, key);
    assert.ok(Buffer.isBuffer(selected[key].bytes), key);
  }
  assert.equal(selected.kricConvenience.freshnessExpiresAt, "2026-12-30T05:07:47.096Z");
});

test("원장 head가 새 snapshot으로 이어지면 코드 수정 없이 새 입력을 고른다", async () => {
  const inputs = await committedSelectionInputsWithinIncheonWindow();
  const sourceId = "busan-transportation-accessibility";
  const headId = inputs.fanIn.selectedSources.find((row) => row.sourceId === sourceId).snapshotId;
  const previous = inputs.sourceSnapshots.find((row) => row.snapshotId === headId);
  const successorId = `${sourceId}-successor-20260930`;
  const successorPath = `tools/datapack/sources/${successorId}.json`;
  const successorBytes = Buffer.from(JSON.stringify({ sourceId, rawSha256: "f".repeat(64), rows: [] }));
  inputs.sourceSnapshots.push({ ...previous, snapshotId: successorId, previousSnapshotId: previous.snapshotId, rawSha256: "f".repeat(64) });
  const source = inputs.sourceInventory.sources.find(({ id }) => id === sourceId);
  source.accessibilityAdmissionEvidence = { ...source.accessibilityAdmissionEvidence, snapshotId: successorId, snapshotPath: successorPath, rawSha256: "f".repeat(64) };
  const selectedSource = inputs.fanIn.selectedSources.find((row) => row.sourceId === sourceId);
  selectedSource.snapshotId = successorId;
  const readCommitted = inputs.readSourceBytes;
  inputs.readSourceBytes = async (relative) => relative === successorPath ? successorBytes : readCommitted(relative);

  const selected = await resolveNationwideCandidateInputSnapshots(inputs);
  assert.equal(selected.busanAccessibility.snapshotId, successorId);
  assert.equal(selected.busanAccessibility.path, successorPath);
  assert.deepEqual(selected.busanAccessibility.bytes, successorBytes);
});

test("후보 입력 head가 없거나 모호하거나 만료됐거나 fan-in과 다르면 명시적으로 실패한다", async () => {
  const missing = await committedSelectionInputs();
  missing.sourceSnapshots = missing.sourceSnapshots.filter(({ sourceId }) => sourceId !== "daejeon-train-timetable");
  await assert.rejects(resolveNationwideCandidateInputSnapshots(missing), /terminal snapshot head missing for daejeon-train-timetable/);

  const ambiguous = await committedSelectionInputs();
  const busanTimetable = ambiguous.sourceSnapshots.find(({ sourceId }) => sourceId === "busan-transportation-timetable");
  ambiguous.sourceSnapshots.push({ ...busanTimetable, snapshotId: "busan-transportation-timetable-fork", previousSnapshotId: null });
  await assert.rejects(resolveNationwideCandidateInputSnapshots(ambiguous), /terminal snapshot head mismatch for busan-transportation-timetable/);

  const expired = await committedSelectionInputs();
  expired.fanIn.selectedSources.find(({ sourceId }) => sourceId === "kric-station-convenience-standard")
    .freshnessExpiresAt = expired.fanIn.evaluatedAt;
  await assert.rejects(resolveNationwideCandidateInputSnapshots(expired), /nationwide candidate input is expired for kric-station-convenience-standard/);

  const unselected = await committedSelectionInputs();
  unselected.fanIn.selectedSources = unselected.fanIn.selectedSources.filter(({ sourceId }) => sourceId !== "daegu-line2-train-timetable");
  await assert.rejects(resolveNationwideCandidateInputSnapshots(unselected), /not selected by fan-in for daegu-line2-train-timetable/);

  const diverged = await committedSelectionInputs();
  diverged.fanIn.selectedSources.find(({ sourceId }) => sourceId === "gwangju-transportation-accessibility")
    .snapshotId = "gwangju-transportation-accessibility-older";
  await assert.rejects(resolveNationwideCandidateInputSnapshots(diverged), /fan-in selection does not match ledger head for gwangju-transportation-accessibility/);
});

test("인천 입력은 정책 클래스로 유도한 신선도가 후보 시계 이전이면 만료로 실패한다(#862 3c)", async () => {
  // station-info(route_graph_topology, P1D)는 수집 1일 뒤 만료다.
  const topology = await committedSelectionInputs();
  const topologyCapturedAt = topology.sourceInventory.sources.find(({ id }) => id === "incheon-transit-station-info").topologyAdmissionEvidence.capturedAt;
  topology.fanIn.evaluatedAt = new Date(Date.parse(topologyCapturedAt) + 24 * 60 * 60 * 1_000).toISOString();
  await assert.rejects(resolveNationwideCandidateInputSnapshots(topology),
    /nationwide candidate input is expired for incheon-transit-station-info/);

  // 시간표(incheon_timetable_observation, capturedAt·P30D)는 수집 30일 뒤 만료다.
  const timetable = await committedSelectionInputs();
  const capturedAt = timetable.sourceInventory.sources.find(({ id }) => id === "incheon-line1-train-timetable").scheduleAdmissionEvidence.capturedAt;
  timetable.fanIn.evaluatedAt = new Date(Date.parse(capturedAt) + 30 * 24 * 60 * 60 * 1_000).toISOString();
  timetable.sourceInventory.sources.find(({ id }) => id === "incheon-transit-station-info").topologyAdmissionEvidence.capturedAt
    = new Date(Date.parse(timetable.fanIn.evaluatedAt) - 60_000).toISOString();
  await assert.rejects(resolveNationwideCandidateInputSnapshots(timetable), /nationwide candidate input is expired for incheon-line1-train-timetable/);

  // 후보 시계보다 늦은 수집은 미래 관측으로 실패한다.
  const future = await committedSelectionInputsWithinIncheonWindow();
  const line1CapturedAt = future.sourceInventory.sources.find(({ id }) => id === "incheon-line1-train-timetable").scheduleAdmissionEvidence.capturedAt;
  future.fanIn.evaluatedAt = new Date(Date.parse(line1CapturedAt) - 1).toISOString();
  future.sourceInventory.sources.find(({ id }) => id === "incheon-transit-station-info").topologyAdmissionEvidence.capturedAt
    = new Date(Date.parse(future.fanIn.evaluatedAt) - 60_000).toISOString();
  await assert.rejects(resolveNationwideCandidateInputSnapshots(future), /nationwide candidate input is observed after the candidate clock for incheon-line1-train-timetable/);
});

// #862: MOLIT 환승 이동 원천은 정책으로 유도한 freshUntil이 후보 시계 이전이면 만료로 실패한다.
test("MOLIT 환승 이동 원천은 정책 신선도가 후보 시계 이전이면 만료로 실패한다(#862)", async () => {
  const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const sourceInventory = await readJson("tools/datapack/source-inventory.json");
  const freshnessPolicy = await readJson("release/product-gates/datapack-freshness-sla.json");
  const admission = sourceInventory.sources.find(({ id }) => id === "molit-railway-transfer-movement").rawSnapshotAdmission;
  const metadata = await readJson(admission.metadataPath);
  const read = (relative) => readFile(path.join(root, relative));
  const before = new Date(Date.parse(metadata.freshUntil) - 60_000).toISOString();
  const resolved = await resolveMolitTransferSnapshot({ sourceInventory, freshnessPolicy, evaluatedAt: before, read });
  assert.equal(resolved.metadata.snapshotId, admission.snapshotId);
  await assert.rejects(resolveMolitTransferSnapshot({ sourceInventory, freshnessPolicy, evaluatedAt: metadata.freshUntil, read }),
    /nationwide candidate MOLIT transfer snapshot is expired/);
  const future = new Date(Date.parse(metadata.observedAt) - 60_000).toISOString();
  await assert.rejects(resolveMolitTransferSnapshot({ sourceInventory, freshnessPolicy, evaluatedAt: future, read }),
    /nationwide candidate MOLIT transfer snapshot is observed after the candidate clock/);
});

test("인천 입력은 inventory admission evidence가 없거나 원본 바이트가 다르면 실패한다", async () => {
  const missing = await committedSelectionInputsWithinIncheonWindow();
  delete missing.sourceInventory.sources.find(({ id }) => id === "incheon-line1-train-timetable").scheduleAdmissionEvidence;
  await assert.rejects(resolveNationwideCandidateInputSnapshots(missing), /snapshot path missing or ambiguous for incheon-line1-train-timetable/);

  const tampered = await committedSelectionInputsWithinIncheonWindow();
  const readCommitted = tampered.readSourceBytes;
  tampered.readSourceBytes = async (relative) => {
    const bytes = await readCommitted(relative);
    if (relative !== `tools/datapack/sources/${COMMITTED_INPUT_SNAPSHOT_IDS.incheonLine2}.json`) return bytes;
    return Buffer.from(JSON.stringify({ ...JSON.parse(bytes), rawSha256: "0".repeat(64) }));
  };
  await assert.rejects(resolveNationwideCandidateInputSnapshots(tampered), /raw binding mismatch for incheon-line2-train-timetable/);
});

test("prepare-nationwide-candidate-run은 원장 head로 고르는 입력 경로를 하드코딩하지 않는다", async () => {
  const source = await readFile(path.join(root, "tools/datapack/prepare-nationwide-candidate-run.mjs"), "utf8");
  for (const snapshotId of Object.values(COMMITTED_INPUT_SNAPSHOT_IDS)) {
    assert.equal(source.includes(snapshotId), false, `${snapshotId} must come from the ledger head`);
  }
});

// #862 2단계 추가 사항: 신선도·식별자 상수를 원장 head(fan-in)·inventory head·정책에서 유도한다.
const HARDCODED_CANDIDATE_CONSTANTS = Object.freeze([
  "nationwide-candidate-20260923",
  "2026-12-08T03:16:08.098Z",
  "2027-08-11T00:00:00.000Z",
  "2027-08-15T09:40:38.817Z",
  "2026-08-15T09:40:38.817Z",
  "2026-07-29T12:32:28.000Z",
  "2026-09-05T17:29:18.428Z",
  "2026-09-04T17:29:18.428Z",
  "seoul-metro-transfer-distance-duration-20260815T094038817Z",
  "molit-railway-transfer-movement-20250811",
  "capital-route-topology-20260904",
  "capital-route-topology-20260724",
  "capital-topology-reverification-20260904",
  "seoul-metro-official-od-fares-current-20260826T035408251Z",
  "itx-cheongchun-topology-evidence-20260830151508786",
  "3a45dc1d82f81666c48eeef81fdc35b0e4a0c59312e4b26907f644c45b518ce3",
  "39978b3c3dd3fb64b7f15d739453b19ad0b51a0f216cea22d3efb77dbfebf398",
  "c64b8a890c1576368566e89b5a70fdbaa88292f1b87fd44462d9a0a2bd33b4b0",
  "82dc0d5a7c726532e8aca86b31603c0edd3cd238a67b4067f4aab0ac59e27edf",
  "56aea1437ed41bfa113dae3553aa6823b9eb1a0c18418fa2e4f4347ca4155595",
  "057e89316465215d7bc0add5d28d4bddc7f10d3756970ff4d2def02c51838a1f",
  "0532458dc81590ad020987ddb34ef301ab96a86d1475325f94c8c956066f8b84",
  "1026e93ae3c6fd81bf9a6ac92b810439fc7e7e9fdd0a7c8167840cb5876d84a4",
  "6734a85960a9c14c177f1df6754f764fadfd44a9e2c2627ce77d771b75208d18",
  "02a70526eb373f2e9925075e588f8b520fc1eeeb292eb53d43655439a897d608",
  "a5d64bbabd8d4ef5f88a3f06c6eb1a3ebc2c682e62e42b899d8b8e689bb26d8c",
  "50e2f03b2975c26d488b4f0a23c9a0f5cad7e91a56eb9b7b4977fbbba611745d",
  "9b15822f3e82d8c360be1c9006ae691ec87c7117e3f8ec47d25eec93132fcb4a",
]);

test("#862 prepare는 신선도·식별자 상수와 날짜 fallback을 하드코딩하지 않는다", async () => {
  const source = await readFile(path.join(root, "tools/datapack/prepare-nationwide-candidate-run.mjs"), "utf8");
  for (const literal of HARDCODED_CANDIDATE_CONSTANTS) {
    assert.equal(source.includes(literal), false, `${literal} must be derived from the ledger, inventory or policy head`);
  }
  assert.doesNotMatch(source, /\?\?\s*"20[0-9]{2}-[0-9]{2}-[0-9]{2}/u, "date fallbacks must not hide a missing source date");
});

test("#862 prepare 증거 행·네트워크 증거·운임 증거는 fan-in head·inventory head·정책에서 유도된다", async () => {
  const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const fanIn = await readJson("tools/datapack/release/current-five-region-source-fan-in.json");
  const inventory = await readJson("tools/datapack/source-inventory.json");
  const policy = await readJson("release/product-gates/datapack-freshness-sla.json");
  const head = (sourceId) => fanIn.selectedSources.find((row) => row.sourceId === sourceId);
  const result = await prepareNationwideCandidate({
    requestedBy: "data-operator-lead", approvedBy: "data-release-authority", releaseSequence: 122, writeFiles: false,
  });

  const date = fanIn.evaluatedAt.slice(0, 10).replaceAll("-", "");
  assert.equal(result.candidateId, `nationwide-candidate-${date}-seq122`);

  const rows = result.stationLineInput.evidenceRows;
  for (const sourceId of [
    "busan-transportation-accessibility", "daegu-transportation-accessibility",
    "daejeon-transportation-accessibility", "gwangju-transportation-accessibility",
    "kric-station-convenience-standard", "seoul-metro-transfer-distance-duration",
  ]) {
    const selected = rows.filter((row) => row.sourceId === sourceId);
    assert.ok(selected.length > 0, sourceId);
    for (const row of selected) {
      assert.equal(row.sourceSnapshotId, head(sourceId).snapshotId, sourceId);
      assert.equal(row.freshUntil, head(sourceId).freshnessExpiresAt, sourceId);
      assert.equal(row.licenseId, head(sourceId).licenseRecordSha256, sourceId);
    }
  }

  const molitSource = inventory.sources.find(({ id }) => id === "molit-railway-transfer-movement");
  const molitMeta = await readJson(molitSource.rawSnapshotAdmission.metadataPath);
  const molitClass = policy.sourceClasses.find(({ sourceIds }) => sourceIds?.includes("molit-railway-transfer-movement"));
  const { deriveFreshnessExpiresAt } = await import("./freshness-policy.mjs");
  const molitFreshUntil = deriveFreshnessExpiresAt({
    policy, sourceClassId: molitClass.id, basisAt: molitMeta[molitClass.basisField], evaluationAt: molitMeta.capturedAt,
  });
  const molitRows = rows.filter((row) => row.sourceId === "molit-railway-transfer-movement");
  assert.ok(molitRows.length > 0);
  for (const row of molitRows) {
    assert.equal(row.sourceSnapshotId, molitSource.rawSnapshotAdmission.snapshotId);
    assert.equal(row.freshUntil, molitFreshUntil);
    assert.equal(row.evidenceRawSha256, molitSource.rawSnapshotAdmission.rawSha256);
  }

  const edges = result.preparation.materialization.networkEdgeEvidence;
  const capitalHead = head("capital-route-topology");
  const candidateSnapshot = await readJson(`tools/datapack/sources/${capitalHead.snapshotId}.json`);
  assert.equal(edges.capitalTopologyCandidate.snapshotId, capitalHead.snapshotId);
  assert.equal(edges.capitalTopologyAdmission.snapshotId, capitalHead.snapshotId);
  assert.equal(edges.capitalTopologyAdmission.contentSha256, capitalHead.contentSha256);
  assert.equal(edges.capitalTopologyAdmission.freshUntil, candidateSnapshot.freshUntil);
  const reverification = await readJson(edges.capitalTopologyReverification.path);
  assert.equal(reverification.candidate.contentSha256, capitalHead.contentSha256);
  assert.equal(edges.capitalTopology.snapshotId, reverification.baseline.snapshotId);
  for (const key of ["capitalTopology", "capitalTopologyCandidate", "capitalTopologyReverification", "itxCoverageContract"]) {
    assert.equal(edges[key].sha256, sha256(await readFile(path.join(root, edges[key].path))), key);
  }

  const contract = await readJson("tools/datapack/itx-cheongchun-coverage-contract.json");
  const artifactStamp = contract.sourceTimetableArtifact.artifactId.replace("itx-cheongchun-source-timetable-", "");
  assert.equal(result.preparation.materialization.itxTopologyEvidencePath, `tools/datapack/itx-cheongchun-topology-evidence-${artifactStamp}.json`);
  assert.equal(result.preparation.materialization.itxTopologyEvidenceSha256,
    sha256(await readFile(path.join(root, result.preparation.materialization.itxTopologyEvidencePath))));

  const admissionBytes = await readFile(path.join(root, "tools/datapack/official-od-fare-admission.json"));
  const fareAdmission = JSON.parse(admissionBytes).admissions.find(({ sourceId }) => sourceId === "seoul-metro-official-od-fares");
  const fare = result.preparation.materialization.officialOdFareEvidence;
  assert.deepEqual(Object.keys(fare).sort(), ["admissionHash", "evidenceHash", "mappingLedgerHash", "quoteSetHash", "quotes", "snapshotId", "sourceId"]);
  assert.equal(fare.snapshotId, fareAdmission.snapshotId);
  assert.equal(fare.evidenceHash, fareAdmission.evidenceHash);
  assert.equal(fare.admissionHash, sha256(admissionBytes));
  assert.equal(fare.quoteSetHash, fareAdmission.quoteSetHash);
  assert.equal(fare.mappingLedgerHash, fareAdmission.fareStationLineMappingLedgerHash);
  assert.deepEqual(fare.quotes, result.finalPack.officialOdFareQuotes.filter(({ sourceId }) => sourceId === fare.sourceId));

test("nationwide candidate preparation은 tracked ITX coverage contract와 승인 원천의 버전 topology 증거에 결속된다", async () => {
  const result = await prepareNationwideCandidate({
    requestedBy: "data-operator-lead",
    approvedBy: "data-release-authority",
    releaseSequence: 122,
    writeFiles: false,
  });
  const contractPath = "tools/datapack/itx-cheongchun-coverage-contract.json";
  const contractBytes = await readFile(path.join(root, contractPath));
  const artifactId = JSON.parse(contractBytes).sourceTimetableArtifact.artifactId;
  const digits = /^itx-cheongchun-source-timetable-([0-9]{17})$/u.exec(artifactId)?.[1];
  assert.ok(digits, "tracked ITX source artifact id must be versioned");
  const evidencePath = `tools/datapack/itx-cheongchun-topology-evidence-${digits}.json`;
  const evidenceBytes = await readFile(path.join(root, evidencePath));
  const { materialization } = result.preparation;
  assert.deepEqual(materialization.networkEdgeEvidence.itxCoverageContract, {
    path: contractPath,
    sha256: sha256(contractBytes),
  });
  assert.equal(materialization.itxTopologyEvidencePath, evidencePath);
  assert.equal(materialization.itxTopologyEvidenceSha256, sha256(evidenceBytes));
});

// #862: build spec은 prepare가 아니라 build-nationwide-candidate --preparation이 만든다(결정 C).
// 커밋된 spec이 커밋된 preparation과 같은 ITX 결속을 쓰는지 본다.
test("nationwide candidate build spec은 preparation과 같은 ITX coverage contract·topology 증거 결속을 쓴다", async () => {
  const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const { materialization } = await readJson("tools/datapack/release/nationwide-candidate-preparation.json");
  const buildSpec = await readJson("tools/datapack/release/candidate-build-spec.json");
  assert.deepEqual(
    buildSpec.networkEdgeEvidence.itxCoverageContract,
    materialization.networkEdgeEvidence.itxCoverageContract,
  );
  assert.equal(buildSpec.itxTopologyEvidencePath, materialization.itxTopologyEvidencePath);
  assert.equal(buildSpec.itxTopologyEvidenceSha256, materialization.itxTopologyEvidenceSha256);
});
