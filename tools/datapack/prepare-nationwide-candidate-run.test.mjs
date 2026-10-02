import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { admitOutOfStationTransferLinks, applyMeasuredTransferTimePrecedence, assertCandidateClockAfterRawStorage, prepareNationwideCandidate, resolveSeoulMeasuredTransferMetrics, formatPlatformInfo, gwangjuFacilityState, officialTransferMetricsByDirection, resolveBusanTransferMetrics, resolveMolitTransferSnapshot, resolveNationwideCandidateInputSnapshots } from "./prepare-nationwide-candidate-run.mjs";

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
  // #872 S2: 서울교통공사 환승 지표 끝점이 27에서 160으로 늘어 미측정 환승 역-노선이 251에서 118로 줄었다.
  assert.strictEqual(transferUnknown.length, 118, "Unmeasured transfer stations must be UNKNOWN/PROVIDER_NO_DATA");

  const transferPresent = transferRows.filter(
    (r) => r.state === "VERIFIED_PRESENT" && r.evidenceKind === "OBSERVED"
  );
  assert.strictEqual(transferPresent.length, 186, "Measured transfer stations must be VERIFIED_PRESENT");
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
  // #872 S1(D1): 공식 지표가 없는 역내 환승은 0s/0m 행으로 두지 않고 뺀다.
  // #872 S2: 서울교통공사 지표가 1~8호선과 상대 노선 전체(102쌍, OFFICIAL 140·DERIVED_RECIPROCAL 64)로 넓어졌다.
  // #872 S3: 부산교통공사 원천의 1~4호선 내부 환승 6역 12방향(OFFICIAL)이 더해졌다.
  // #878: 서울교통공사 실측 환승시간만 있는 93방향(0초 1방향 제외)이 표준 보행속도 유도 거리로 더해졌다.
  assert.strictEqual(inStationTransfers.length, 216 + 93);
  // #872 후속(#866 D1 선행): 공식 근거가 없는 역 밖 환승(고정 거리·시간)은 route-edge 입력에 넣지 않는다.
  assert.strictEqual(outOfStationTransfers.length, 0);

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

  // 미측정 역내 환승(0s/0m)과 MOLIT 추정 공식 값은 없다. 남은 환승은 모두 공식 측정값(>0)이다.
  const zeroTransfers = inStationTransfers.filter((e) => e.durationSeconds === 0 && e.distanceMeters === 0);
  const measuredTransfers = inStationTransfers.filter((e) => e.durationSeconds > 0 && e.distanceMeters > 0);
  assert.strictEqual(zeroTransfers.length, 0);
  assert.strictEqual(measuredTransfers.length, 216 + 93);

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
});

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

// #867 리뷰 F1: 광주 FACILITY 판정은 합성 행으로 네 경우를 각각 고정한다. 공식 행이 없는 유형(null)은
// 미관측이므로, 관측 시설이 없고 null이 남아 있으면 부재로 단정하지 않는다.
test("광주 FACILITY 판정은 null을 미관측으로, 0만 있을 때만 부재로, 양수가 있으면 존재로 본다(#867 F1)", () => {
  const row = (elevator, wheelchairLift, escalator) => ({ elevator, wheelchair_lift: wheelchairLift, escalator });
  assert.equal(gwangjuFacilityState(row(null, null, null)), "UNKNOWN", "전부 null");
  assert.equal(gwangjuFacilityState(row(null, 0, null)), "UNKNOWN", "null·0 혼합(녹동 형태)");
  assert.equal(gwangjuFacilityState(row(0, null, 0)), "UNKNOWN", "null·0 혼합");
  assert.equal(gwangjuFacilityState(row(0, 0, 0)), "VERIFIED_ABSENT", "전부 0");
  assert.equal(gwangjuFacilityState(row(2, null, 0)), "VERIFIED_PRESENT", "양수와 null·0 혼합");
  assert.equal(gwangjuFacilityState(row(0, 0, 1)), "VERIFIED_PRESENT", "양수와 0");
});

// #872 S1: 환승 경로(station_pathway_edges)와 역내 환승 route edge는 공식 원천의 거리·시간에만 근거한다.
// 공식 지표가 없는 쌍은 경로 행을 만들지 않고, 추정 공식·다른 방향 대체·무단차 단정을 쓰지 않는다.
const TRANSFER_METRICS_PATH = "tools/datapack/release/current-transfer-topology-metrics.json";
const SEOUL_TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";
const MOLIT_TRANSFER_SOURCE_ID = "molit-railway-transfer-movement";
const BUSAN_TRANSFER_METRICS_PATH = "tools/datapack/release/current-busan-transfer-metrics.json";
const BUSAN_TRANSFER_SOURCE_ID = "busan-transportation-route-topology";
const MEASURED_METRICS_PATH = "tools/datapack/release/current-seoul-measured-transfer-metrics.json";
const MEASURED_SOURCE_ID = "seoul-metro-transfer-car-door-duration";
const DISTANCE_DERIVATION = "STANDARD_PACE_FROM_MEASURED_TIME";
// 이슈 #872 재현 근거의 부산·대구 MOLIT 환승역: 동래(역 밖 횡단 경로를 무단차로 단정), 거제·벡스코(다른 방향 경로 대체).
const MOLIT_ESTIMATE_STATION_IDS = ["station-dbfe9e072d98", "station-623ba7995f56", "station-fbcc387e1db9"];

async function preparedTransferEvidence() {
  const result = await prepareNationwideCandidate({
    requestedBy: "data-operator-lead",
    approvedBy: "data-release-authority",
    releaseSequence: 122,
    writeFiles: false,
  });
  // #872 S3: 공식 환승 지표는 서울교통공사 지표와 부산교통공사 지표 두 원천이다. 방향마다 원천 id와 시간을 함께 들고 다닌다.
  const seoulMetrics = JSON.parse(await readFile(path.join(root, TRANSFER_METRICS_PATH), "utf8")).metrics
    .map((metric) => ({ ...metric, sourceId: SEOUL_TRANSFER_SOURCE_ID }));
  const busanMetrics = JSON.parse(await readFile(path.join(root, BUSAN_TRANSFER_METRICS_PATH), "utf8")).metrics
    .map((metric) => ({ ...metric, sourceId: BUSAN_TRANSFER_SOURCE_ID, officialDurationSecondsReference: metric.officialDurationSeconds }));
  // #876(메인 결정 B): 실측 환승시간과 겹치는 서울 방향은 시간 = 실측, 거리 = 서울교통공사 공식 거리, 원천 = 실측 원천,
  // 레코드 hash = 두 원천 레코드 hash의 결속이다. 실측 원천만 있는 방향(거리 없음)은 후보에서 사용 불가다.
  const measuredByDirection = new Map(JSON.parse(await readFile(path.join(root, MEASURED_METRICS_PATH), "utf8")).metrics
    .map((metric) => [`${metric.stationId}\0${metric.fromLineId}\0${metric.toLineId}`, metric]));
  const precedence = (metric) => {
    const timed = measuredByDirection.get(`${metric.stationId}\0${metric.fromLineId}\0${metric.toLineId}`);
    if (!timed) return metric;
    return {
      ...metric, sourceId: MEASURED_SOURCE_ID, officialDurationSecondsReference: timed.measuredDurationSeconds,
      sourceRecordSha256: sha256(JSON.stringify({ distanceSourceRecordSha256: metric.sourceRecordSha256, durationSourceRecordSha256: timed.sourceRecordSha256 })),
    };
  };
  // #878(QA 결정 2026-10-02): 거리 원천이 없는 실측 방향은 거리 = round(실측초 × 1.2)로 유도한 공식 시간 환승이다.
  // 유도 표기와 실측 레코드 hash를 함께 결속한다. 실측 0초 방향은 거리·시간이 모두 0이라 서버 근거 판별을 통과하지 못해 사용 불가다.
  const seoulDirections = new Set(seoulMetrics.map((metric) => `${metric.stationId}\0${metric.fromLineId}\0${metric.toLineId}`));
  const derivedMetrics = [...measuredByDirection.entries()]
    .filter(([key, timed]) => !seoulDirections.has(key) && timed.measuredDurationSeconds > 0)
    .map(([, timed]) => ({
      stationId: timed.stationId, fromLineId: timed.fromLineId, toLineId: timed.toLineId, sourceId: MEASURED_SOURCE_ID,
      distanceMeters: Math.round(timed.measuredDurationSeconds * 1.2), officialDurationSecondsReference: timed.measuredDurationSeconds,
      metricProvenance: "OFFICIAL_SOURCE", distanceDerivation: DISTANCE_DERIVATION,
      sourceRecordSha256: sha256(JSON.stringify({ derivationPaceMetersPerSecond: 1.2, distanceDerivation: DISTANCE_DERIVATION, durationSourceRecordSha256: timed.sourceRecordSha256 })),
    }));
  const metrics = [...seoulMetrics.map(precedence), ...busanMetrics, ...derivedMetrics];
  const metricByDirection = new Map(metrics.map((metric) => [
    `${metric.stationId}\0${metric.fromLineId}\0${metric.toLineId}`, metric,
  ]));
  const nodeById = new Map(result.finalPack.stationPathwayNodes.map((node) => [node.id, node]));
  const edgeDirection = (edge) => {
    const from = nodeById.get(edge.fromNodeId);
    const to = nodeById.get(edge.toNodeId);
    assert.ok(from && to, `pathway edge ${edge.id} endpoints must be pathway nodes`);
    assert.equal(from.stationId, to.stationId, `pathway edge ${edge.id} must stay in one station`);
    return `${from.stationId}\0${from.lineId}\0${to.lineId}`;
  };
  return { result, metrics, metricByDirection, edgeDirection, measuredByDirection };
}

test("#872 S1 공식 지표가 없는 환승 쌍은 경로 행을 만들지 않고 규칙 FK는 null·UNVERIFIED다", async () => {
  const { result, metricByDirection, edgeDirection } = await preparedTransferEvidence();
  const pack = result.finalPack;

  for (const edge of pack.stationPathwayEdges) {
    assert.ok(metricByDirection.has(edgeDirection(edge)), `pathway edge ${edge.id} has no official metric for its direction`);
    assert.notEqual(edge.verificationStatus, "UNVERIFIED", `UNVERIFIED pathway edge must not be emitted: ${edge.id}`);
    assert.ok(edge.sourceId, `pathway edge ${edge.id} must carry a source`);
  }

  const edgeIds = new Set(pack.stationPathwayEdges.map(({ id }) => id));
  const unfounded = pack.transferRules.filter((rule) =>
    !metricByDirection.has(`${rule.fromStationId}\0${rule.fromLineId}\0${rule.toLineId}`));
  assert.ok(unfounded.length > 0, "fixture must contain transfer pairs without official metrics");
  for (const rule of unfounded) {
    assert.equal(rule.pathwayEdgeId, null, `rule ${rule.id} must not reference a pathway edge`);
    assert.equal(rule.strictStepFreePathwayEdgeId, null, `rule ${rule.id} must not reference a step-free edge`);
    assert.equal(rule.verificationStatus, "UNVERIFIED", `rule ${rule.id} must stay UNVERIFIED`);
    assert.equal(rule.sourceId, "", `rule ${rule.id} must not claim a source`);
    assert.equal(rule.minTransferSeconds, 0, `rule ${rule.id} must not carry an estimated transfer time`);
  }
  for (const rule of pack.transferRules) {
    if (rule.pathwayEdgeId !== null) assert.ok(edgeIds.has(rule.pathwayEdgeId), `rule ${rule.id} references a missing edge`);
  }
  assert.equal(pack.minimumTableRows.station_pathway_edges, pack.stationPathwayEdges.length);
});

test("#872 S1 MOLIT 환승 이동 원천은 거리·시간·무단차 간선에 쓰지 않는다(추정 공식·다른 방향 대체·AVAILABLE 단정 금지)", async () => {
  const { result, metricByDirection } = await preparedTransferEvidence();
  const pack = result.finalPack;
  const molitStations = new Set(MOLIT_ESTIMATE_STATION_IDS);

  assert.deepEqual(pack.stationPathwayEdges.filter(({ sourceId }) => sourceId === MOLIT_TRANSFER_SOURCE_ID).map(({ id }) => id), []);
  // #872 S3: 동래(1↔4호선)는 부산교통공사 공식 환승 행이 생겼다. 이 역들의 경로 행은 그 공식 원천에서만 나온다.
  // 거제·벡스코(동해선 외부 코드)는 공식 행을 역 코드로 매핑할 수 없어 여전히 경로 행이 없다.
  assert.deepEqual(pack.stationPathwayEdges.filter(({ id, sourceId }) => [...molitStations].some((stationId) => id.includes(stationId))
    && sourceId !== BUSAN_TRANSFER_SOURCE_ID).map(({ id }) => id), []);
  assert.deepEqual(pack.stationPathwayEdges.filter(({ id }) => ["station-623ba7995f56", "station-fbcc387e1db9"].some((stationId) => id.includes(stationId)))
    .map(({ id }) => id), []);
  for (const rule of pack.transferRules.filter(({ fromStationId }) => molitStations.has(fromStationId))) {
    const official = metricByDirection.get(`${rule.fromStationId}\0${rule.fromLineId}\0${rule.toLineId}`);
    if (official) {
      assert.equal(official.sourceId, BUSAN_TRANSFER_SOURCE_ID, `rule ${rule.id} may only be backed by the Busan official source`);
      assert.equal(rule.sourceId, BUSAN_TRANSFER_SOURCE_ID);
      assert.equal(rule.minTransferSeconds, official.officialDurationSeconds, `rule ${rule.id} must carry the official source value only`);
      continue;
    }
    assert.equal(rule.sourceId, "", `MOLIT rule ${rule.id} must not claim a source`);
    assert.equal(rule.verificationStatus, "UNVERIFIED", `MOLIT rule ${rule.id} must stay UNVERIFIED`);
    assert.equal(rule.minTransferSeconds, 0, `MOLIT rule ${rule.id} must not carry max(120, n*30) estimate`);
  }
  // 무단차 간선은 공식 경로와 공식 거리가 함께 있을 때만 만든다. 현재 그런 원천은 없다.
  assert.deepEqual(pack.stationPathwayEdges.filter(({ requiresElevator }) => requiresElevator).map(({ id }) => id), []);
  assert.deepEqual(pack.stationPathwayEdges.filter(({ accessibilityStatus }) => accessibilityStatus === "AVAILABLE").map(({ id }) => id), []);
  assert.deepEqual(pack.transferRules.filter(({ strictStepFreePathwayEdgeId }) => strictStepFreePathwayEdgeId !== null).map(({ id }) => id), []);

  const molitRouteTransfers = result.routeInput.routeEdges.filter(({ edgeType, fromNodeId }) =>
    edgeType === "IN_STATION_TRANSFER" && molitStations.has(fromNodeId.split(":")[0]));
  assert.deepEqual(molitRouteTransfers.filter(({ fromNodeId, toNodeId }) => {
    const [stationId, fromLineId] = fromNodeId.split(":");
    return metricByDirection.get(`${stationId}\0${fromLineId}\0${toNodeId.split(":")[1]}`)?.sourceId !== BUSAN_TRANSFER_SOURCE_ID;
  }).map(({ edgeId }) => edgeId), []);
});

test("#872 S1 서울 환승 경로 행은 같은 방향 공식 지표의 sourceRecordSha256·거리·시간과 같고, 역방향(DERIVED_RECIPROCAL) 쌍은 경로 행 없이 route edge만 유지한다", async () => {
  const { result, metrics, metricByDirection, edgeDirection } = await preparedTransferEvidence();
  const pack = result.finalPack;
  const sourceRecordHashes = new Set(metrics.map(({ sourceRecordSha256 }) => sourceRecordSha256));
  const officialMetrics = metrics.filter(({ metricProvenance }) => metricProvenance === "OFFICIAL_SOURCE");
  const derivedMetrics = metrics.filter(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL");
  assert.ok(derivedMetrics.length > 0, "fixture must contain derived reciprocal metrics (강남·까치산)");
  assert.equal(officialMetrics.length + derivedMetrics.length, metrics.length);

  // production pathway 계약은 DERIVED_RECIPROCAL을 받지 않는다(#872 D4 보완). 경로 행은 공식 지표에만 만든다.
  assert.equal(pack.stationPathwayEdges.length, officialMetrics.length, "one official walk edge per OFFICIAL_SOURCE metric direction");
  for (const edge of pack.stationPathwayEdges) {
    const metric = metricByDirection.get(edgeDirection(edge));
    assert.equal(metric.metricProvenance, "OFFICIAL_SOURCE", `edge ${edge.id} must not use a derived reciprocal value`);
    // #872 S3: 경로 행의 원천 id는 그 방향 공식 지표의 원천(서울교통공사 또는 부산교통공사)과 같아야 한다.
    assert.equal(edge.sourceId, metric.sourceId);
    assert.equal(edge.provenanceKind, "OFFICIAL_SOURCE");
    assert.equal(edge.verificationStatus, "VERIFIED");
    assert.ok(sourceRecordHashes.has(edge.providerRecordHash), `edge ${edge.id} hash must exist in metrics`);
    assert.equal(edge.providerRecordHash, metric.sourceRecordSha256, `edge ${edge.id} hash must equal its direction metric`);
    assert.equal(edge.evidenceHash, metric.sourceRecordSha256);
    assert.equal(edge.durationSeconds, metric.officialDurationSecondsReference);
    assert.equal(edge.distanceMeters, metric.distanceMeters);
  }
  for (const rule of pack.transferRules.filter(({ pathwayEdgeId }) => pathwayEdgeId !== null)) {
    const metric = metricByDirection.get(`${rule.fromStationId}\0${rule.fromLineId}\0${rule.toLineId}`);
    assert.equal(metric?.metricProvenance, "OFFICIAL_SOURCE", `rule ${rule.id} must reference only an official pathway edge`);
    assert.equal(rule.sourceId, metric.sourceId);
    assert.equal(rule.verificationStatus, "VERIFIED");
    assert.equal(rule.minTransferSeconds, metric.officialDurationSecondsReference);
  }

  const routeTransfers = new Map(result.routeInput.routeEdges
    .filter(({ edgeType }) => edgeType === "IN_STATION_TRANSFER")
    .map((edge) => [edge.edgeId, edge]));
  for (const metric of derivedMetrics) {
    const key = `${metric.stationId}-${metric.fromLineId}-${metric.toLineId}`;
    assert.equal(pack.stationPathwayEdges.some(({ id }) => id.startsWith(`pathway-edge-${key}-`)), false, `derived pair ${key} must not emit a pathway row`);
    const rule = pack.transferRules.find(({ id }) => id === `rule-transfer-${key}`);
    assert.ok(rule, `derived pair ${key} keeps its transfer rule`);
    assert.equal(rule.pathwayEdgeId, null);
    assert.equal(rule.strictStepFreePathwayEdgeId, null);
    assert.equal(rule.verificationStatus, "UNVERIFIED", `derived pair ${key} must not be presented as verified official`);
    // 길찾기 route edge는 #350에서 승인된 역방향 지표 값을 그대로 쓴다(길찾기 동작 변경 없음).
    const routeEdge = routeTransfers.get(`transfer-${key}`);
    assert.ok(routeEdge, `derived pair ${key} keeps its route edge`);
    assert.equal(routeEdge.durationSeconds, metric.officialDurationSecondsReference);
    assert.equal(routeEdge.distanceMeters, metric.distanceMeters);
  }
});

test("#872 S1 route-edge input은 공식 지표가 없는 역내 환승을 0s/0m로 두지 않고 뺀다(D1)", async () => {
  const { result, metrics, metricByDirection } = await preparedTransferEvidence();
  const transfers = result.routeInput.routeEdges.filter(({ edgeType }) => edgeType === "IN_STATION_TRANSFER");

  assert.equal(transfers.length, metrics.length);
  for (const edge of transfers) {
    const [fromStationId, fromLineId] = edge.fromNodeId.split(":");
    const [toStationId, toLineId] = edge.toNodeId.split(":");
    assert.equal(fromStationId, toStationId);
    const metric = metricByDirection.get(`${fromStationId}\0${fromLineId}\0${toLineId}`);
    assert.ok(metric, `route transfer ${edge.edgeId} has no official metric`);
    assert.equal(edge.durationSeconds, metric.officialDurationSecondsReference);
    assert.equal(edge.distanceMeters, metric.distanceMeters);
  }
  assert.deepEqual(transfers.filter(({ durationSeconds, distanceMeters }) => durationSeconds === 0 || distanceMeters === 0)
    .map(({ edgeId }) => edgeId), []);
});

// #872 S3(QA 결정 2026-10-02): 부산교통공사 원천의 환승 행(1~4호선 내부)을 공식 환승 거리·시간으로 쓴다.
// 경로 행·규칙·route edge는 fan-in이 고른 부산 원천 head에 결속되고, 값은 원천 그대로(100m·분 단위)다.
test("#872 S3 부산교통공사 공식 환승 행은 fan-in head에 결속된 OFFICIAL_SOURCE 경로 행·규칙·route edge가 된다", async () => {
  const { result, metrics, edgeDirection } = await preparedTransferEvidence();
  const pack = result.finalPack;
  const fanIn = JSON.parse(await readFile(path.join(root, "tools/datapack/release/current-five-region-source-fan-in.json"), "utf8"));
  const head = fanIn.selectedSources.find(({ sourceId }) => sourceId === BUSAN_TRANSFER_SOURCE_ID);
  const busanMetrics = metrics.filter(({ sourceId }) => sourceId === BUSAN_TRANSFER_SOURCE_ID);
  const seoulOfficial = metrics.filter(({ sourceId, metricProvenance }) => sourceId === SEOUL_TRANSFER_SOURCE_ID && metricProvenance === "OFFICIAL_SOURCE");
  assert.equal(busanMetrics.length, 12);
  assert.equal(new Set(busanMetrics.map(({ stationId }) => stationId)).size, 6);

  const busanEdges = pack.stationPathwayEdges.filter(({ sourceId }) => sourceId === BUSAN_TRANSFER_SOURCE_ID);
  assert.equal(busanEdges.length, busanMetrics.length);
  assert.equal(pack.stationPathwayEdges.filter(({ sourceId }) => sourceId === SEOUL_TRANSFER_SOURCE_ID).length, seoulOfficial.length,
    "서울 경로 행은 그대로다");
  const busanByDirection = new Map(busanMetrics.map((metric) => [`${metric.stationId}\0${metric.fromLineId}\0${metric.toLineId}`, metric]));
  for (const edge of busanEdges) {
    const metric = busanByDirection.get(edgeDirection(edge));
    assert.ok(metric, `Busan edge ${edge.id} has no Busan official metric`);
    assert.equal(edge.sourceSnapshotId, head.snapshotId);
    assert.equal(edge.lastVerifiedAt, head.capturedAt);
    assert.equal(edge.provenanceKind, "OFFICIAL_SOURCE");
    assert.equal(edge.verificationStatus, "VERIFIED");
    assert.equal(edge.providerRecordHash, metric.sourceRecordSha256);
    assert.equal(edge.evidenceHash, metric.sourceRecordSha256);
    assert.equal(edge.distanceMeters, metric.distanceMeters);
    assert.equal(edge.durationSeconds, metric.officialDurationSeconds);
    assert.equal(edge.distanceMeters % 100, 0, "원천 거리는 100m 단위다");
    assert.equal(edge.durationSeconds % 60, 0, "원천 시간은 분 단위다");
    assert.equal(edge.requiresElevator, false);
    assert.equal(edge.accessibilityStatus, "UNKNOWN", "원천은 무단차 여부를 주지 않는다");
  }
  for (const metric of busanMetrics) {
    const key = `${metric.stationId}-${metric.fromLineId}-${metric.toLineId}`;
    const rule = pack.transferRules.find(({ id }) => id === `rule-transfer-${key}`);
    assert.equal(rule.sourceId, BUSAN_TRANSFER_SOURCE_ID);
    assert.equal(rule.verificationStatus, "VERIFIED");
    assert.equal(rule.pathwayEdgeId, `pathway-edge-${key}-walk`);
    assert.equal(rule.strictStepFreePathwayEdgeId, null);
    assert.equal(rule.minTransferSeconds, metric.officialDurationSeconds);
    const routeEdge = result.routeInput.routeEdges.find(({ edgeId }) => edgeId === `transfer-${key}`);
    assert.equal(routeEdge.edgeType, "IN_STATION_TRANSFER");
    assert.equal(routeEdge.durationSeconds, metric.officialDurationSeconds);
    assert.equal(routeEdge.distanceMeters, metric.distanceMeters);
  }

  // 경로 행이 가리키는 원천은 팩 sourceInventory에 있어야 한다(production pathway 계약).
  const packSource = pack.sourceInventory.find(({ id }) => id === BUSAN_TRANSFER_SOURCE_ID);
  assert.ok(packSource, "Busan transfer source must be in the pack sourceInventory");
  assert.equal(packSource.updatedAt, head.capturedAt);
  assert.equal(packSource.redistributionAllowed, true);
  // 리뷰 F3: 팩 원천 설명은 이 원천이 실제로 채우는 환승 표와 공식 환승 도메인을 담는다. 값은 inventory에서 유도한다:
  // 필드 = inventory fieldsProvided + 이 원천을 인용하는 팩 표, 도메인 = inventory 도메인 + 공식 환승 거리·시간 원천의 도메인.
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const busanInventory = inventory.sources.find(({ id }) => id === BUSAN_TRANSFER_SOURCE_ID);
  const seoulInventory = inventory.sources.find(({ id }) => id === SEOUL_TRANSFER_SOURCE_ID);
  assert.deepEqual(packSource.fields, [...busanInventory.fieldsProvided, "station_pathway_edges", "transfer_rules"]);
  assert.deepEqual(packSource.coverageScope, {
    ...busanInventory.coverageScope,
    sourceDomains: [...busanInventory.coverageScope.sourceDomains, ...seoulInventory.coverageScope.sourceDomains],
  });
  assert.ok(pack.stationPathwayEdges.some(({ sourceId }) => sourceId === BUSAN_TRANSFER_SOURCE_ID));
  assert.ok(pack.transferRules.some(({ sourceId }) => sourceId === BUSAN_TRANSFER_SOURCE_ID));
});

test("#872 S3 생성기는 커밋된 부산 환승 지표가 fan-in head·재계산과 다르면 명시적으로 실패한다", async () => {
  const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const fanIn = await readJson("tools/datapack/release/current-five-region-source-fan-in.json");
  const sourceInventory = await readJson("tools/datapack/source-inventory.json");
  const read = (relative) => readFile(path.join(root, relative));
  const resolved = await resolveBusanTransferMetrics({ fanIn, sourceInventory, read });
  assert.equal(resolved.metrics.length, 12);
  assert.equal(resolved.head.snapshotId, fanIn.selectedSources.find(({ sourceId }) => sourceId === BUSAN_TRANSFER_SOURCE_ID).snapshotId);

  const tamperedRead = async (relative) => {
    const bytes = await read(relative);
    if (relative !== BUSAN_TRANSFER_METRICS_PATH) return bytes;
    return Buffer.from(bytes.toString("utf8").replace("\"officialDurationSeconds\":120", "\"officialDurationSeconds\":60"));
  };
  await assert.rejects(resolveBusanTransferMetrics({ fanIn, sourceInventory, read: tamperedRead }),
    /nationwide candidate Busan transfer metrics differ from the rebuild/);

  const otherHead = structuredClone(fanIn);
  otherHead.selectedSources.find(({ sourceId }) => sourceId === BUSAN_TRANSFER_SOURCE_ID).rawSha256 = "0".repeat(64);
  await assert.rejects(resolveBusanTransferMetrics({ fanIn: otherHead, sourceInventory, read }),
    /nationwide candidate Busan transfer metrics do not match the fan-in head/);
});

// #872 S3 리뷰 F1: 한 환승 방향을 서울교통공사·부산교통공사 두 원천이 함께 주장하면 어느 값도 고르지 않고 실패한다.
test("#872 S3 한 환승 방향을 두 공식 원천이 함께 주장하면 후보 생성이 실패한다", () => {
  const metric = { stationId: "station-1fc7a7c971c8", fromLineId: "line-ab1a041f6266", toLineId: "line-eb7b47920390" };
  const seoul = { sourceId: SEOUL_TRANSFER_SOURCE_ID, sourceSnapshotId: "seoul-snapshot", lastVerifiedAt: "2026-08-15T09:40:38.817Z",
    metrics: [{ ...metric, officialDurationSecondsReference: 90 }], durationOf: (m) => m.officialDurationSecondsReference };
  const busan = { sourceId: BUSAN_TRANSFER_SOURCE_ID, sourceSnapshotId: "busan-snapshot", lastVerifiedAt: "2026-10-01T04:15:27.569Z",
    metrics: [{ ...metric, officialDurationSeconds: 120 }], durationOf: (m) => m.officialDurationSeconds };

  const separate = officialTransferMetricsByDirection([seoul, { ...busan, metrics: [{ ...metric, fromLineId: metric.toLineId, toLineId: metric.fromLineId, officialDurationSeconds: 120 }] }]);
  assert.equal(separate.size, 2);
  assert.deepEqual(separate.get(`${metric.stationId}:${metric.fromLineId}->${metric.toLineId}`).sourceId, SEOUL_TRANSFER_SOURCE_ID);
  assert.equal(separate.get(`${metric.stationId}:${metric.toLineId}->${metric.fromLineId}`).durationSeconds, 120);

  assert.throws(() => officialTransferMetricsByDirection([seoul, busan]),
    /nationwide candidate transfer metric is claimed by two sources: station-1fc7a7c971c8:line-ab1a041f6266->line-eb7b47920390/);
  assert.throws(() => officialTransferMetricsByDirection([{ ...busan, metrics: [...busan.metrics, ...busan.metrics] }]),
    /claimed by two sources/);
});

// #876(QA 결정 2026-10-02): 서울교통공사 실측 환승시간(15098252)은 공식 환승 시간 원천이다. 메인 결정 B(2026-10-02):
// - 서울교통공사 거리 원천과 겹치는 방향은 시간 = 15098252 실측, 거리 = 서울교통공사 공식 거리다. 두 원천을 모두 기록한다.
// - #878(QA 결정 2026-10-02, 스키마 v20 계획 대체): 거리 없이 시간만 있는 방향은 거리 = round(실측초 × 1.2)m로 유도한다.
//   1.2 m/s는 표준 보행속도 앵커(#1700)다. 유도값임을 표기하고, 거리 원천이 있는 방향에는 유도를 쓰지 않는다.
const MEASURED_TRANSFER_SOURCE_ID = "seoul-metro-transfer-car-door-duration";
function precedenceFixture() {
  const seoulMetric = { stationId: "station-a", fromLineId: "line-1", toLineId: "line-2", distanceMeters: 120, officialDurationSecondsReference: 100,
    metricProvenance: "OFFICIAL_SOURCE", sourceRecordSha256: "a".repeat(64) };
  const seoulReverse = { ...seoulMetric, fromLineId: "line-2", toLineId: "line-1", metricProvenance: "DERIVED_RECIPROCAL" };
  const officialByDirection = officialTransferMetricsByDirection([{ sourceId: SEOUL_TRANSFER_SOURCE_ID, sourceSnapshotId: "seoul-snapshot",
    lastVerifiedAt: "2026-08-15T09:40:38.817Z", metrics: [seoulMetric, seoulReverse], durationOf: (m) => m.officialDurationSecondsReference }]);
  const measuredMetric = (fromLineId, toLineId, seconds, stationId = "station-a") => ({ stationId, fromLineId, toLineId, measuredDurationSeconds: seconds,
    distanceMeters: null, metricProvenance: "OFFICIAL_SOURCE", measurement: "MEASURED", sourceRecordSha256: sha256(`${stationId}${fromLineId}${toLineId}`) });
  const measured = { sourceId: MEASURED_TRANSFER_SOURCE_ID, sourceSnapshotId: "measured-snapshot", lastVerifiedAt: "2026-10-01T16:33:24.036Z",
    metrics: [measuredMetric("line-1", "line-2", 214), measuredMetric("line-2", "line-1", 0), measuredMetric("line-1", "line-3", 300, "station-b"),
      measuredMetric("line-3", "line-1", 311, "station-b"), measuredMetric("line-1", "line-4", 5, "station-b"), measuredMetric("line-1", "line-4", 0, "station-c")] };
  return { officialByDirection, measured, seoulMetric, measuredMetric };
}

test("#876 겹치는 방향은 시간=실측 원천, 거리=서울교통공사 공식 거리이고 두 원천의 레코드 hash를 함께 결속한다", () => {
  const { officialByDirection, measured, seoulMetric } = precedenceFixture();
  const { byDirection } = applyMeasuredTransferTimePrecedence({ officialByDirection, measured });
  const merged = byDirection.get("station-a:line-1->line-2");
  assert.equal(merged.durationSeconds, 214, "시간은 실측 원천이 이긴다");
  assert.equal(merged.metric.distanceMeters, 120, "거리는 서울교통공사 공식 거리를 유지한다");
  assert.equal(merged.metric.metricProvenance, "OFFICIAL_SOURCE");
  assert.equal(merged.sourceId, MEASURED_TRANSFER_SOURCE_ID);
  assert.equal(merged.sourceSnapshotId, "measured-snapshot");
  assert.equal(merged.lastVerifiedAt, "2026-10-01T16:33:24.036Z");
  assert.deepEqual(merged.distanceSource, { sourceId: SEOUL_TRANSFER_SOURCE_ID, sourceSnapshotId: "seoul-snapshot",
    sourceRecordSha256: seoulMetric.sourceRecordSha256, metricProvenance: "OFFICIAL_SOURCE" });
  assert.equal(merged.durationSourceRecordSha256, measured.metrics[0].sourceRecordSha256);
  assert.equal(merged.metric.sourceRecordSha256, sha256(JSON.stringify({
    distanceSourceRecordSha256: seoulMetric.sourceRecordSha256, durationSourceRecordSha256: measured.metrics[0].sourceRecordSha256,
  })));
  // 역방향(DERIVED_RECIPROCAL) 거리와 겹치면 거리 표기는 역방향으로 남는다(경로 행 없이 route edge만, D4 보완). 0초 실측도 값이다.
  const reverse = byDirection.get("station-a:line-2->line-1");
  assert.equal(reverse.durationSeconds, 0);
  assert.equal(reverse.metric.metricProvenance, "DERIVED_RECIPROCAL");
  // #878: 거리 원천이 있는 방향은 표준 보행속도 유도를 쓰지 않는다(공식 거리 그대로, 유도 표기 없음).
  for (const overlap of [merged, reverse]) {
    assert.equal(overlap.distanceDerivation, undefined, "거리 원천이 있는 방향에 유도 표기가 붙으면 안 된다");
    assert.equal(overlap.derivationPaceMetersPerSecond, undefined);
  }
  assert.equal(reverse.metric.distanceMeters, 120, "역방향 거리도 거리 원천 값 그대로다");
});

// #878(QA 결정 2026-10-02): 시간만 있는 실측 방향의 거리 = round(실측초 × 1.2)m. 유도값임을 표기하고 실측 레코드 hash와 함께 결속한다.
test("#878 시간만 있는 실측 방향은 거리 = round(실측초 × 1.2)이고, 유도 표기가 붙어 공식 측정 거리와 구별된다", () => {
  const { officialByDirection, measured } = precedenceFixture();
  const { byDirection, derivedDistanceDirections } = applyMeasuredTransferTimePrecedence({ officialByDirection, measured });
  const expected = [["station-b", "line-1", "line-3", 300, 360], ["station-b", "line-3", "line-1", 311, 373], ["station-b", "line-1", "line-4", 5, 6]];
  for (const [stationId, fromLineId, toLineId, seconds, meters] of expected) {
    const timed = measured.metrics.find((metric) => metric.stationId === stationId && metric.fromLineId === fromLineId && metric.toLineId === toLineId);
    const entry = byDirection.get(`${stationId}:${fromLineId}->${toLineId}`);
    assert.ok(entry, `${stationId} ${fromLineId}->${toLineId} must be usable with a derived distance`);
    assert.equal(entry.durationSeconds, seconds, "시간은 실측값 그대로다");
    assert.equal(entry.metric.distanceMeters, meters, "거리 = round(실측초 × 1.2)");
    assert.equal(entry.metric.metricProvenance, "OFFICIAL_SOURCE", "근거(시간)는 공식 실측 원천이다");
    assert.equal(entry.sourceId, MEASURED_TRANSFER_SOURCE_ID);
    assert.equal(entry.sourceSnapshotId, "measured-snapshot");
    assert.equal(entry.lastVerifiedAt, "2026-10-01T16:33:24.036Z");
    assert.equal(entry.distanceDerivation, "STANDARD_PACE_FROM_MEASURED_TIME");
    assert.equal(entry.derivationPaceMetersPerSecond, 1.2);
    assert.equal(entry.distanceSource, undefined, "유도 거리는 거리 원천을 주장하지 않는다");
    assert.equal(entry.durationSourceRecordSha256, timed.sourceRecordSha256);
    const binding = sha256(JSON.stringify({ derivationPaceMetersPerSecond: 1.2, distanceDerivation: "STANDARD_PACE_FROM_MEASURED_TIME", durationSourceRecordSha256: timed.sourceRecordSha256 }));
    assert.equal(entry.metric.sourceRecordSha256, binding, "레코드 hash는 유도 표기와 실측 레코드 hash의 결속이다");
    assert.notEqual(entry.metric.sourceRecordSha256, timed.sourceRecordSha256, "유도 거리 행은 실측 레코드 hash만으로 보이면 안 된다");
  }
  assert.deepEqual(derivedDistanceDirections.map(({ stationId, fromLineId, toLineId, measuredDurationSeconds, distanceMeters }) =>
    [stationId, fromLineId, toLineId, measuredDurationSeconds, distanceMeters]), expected);
});

// #878: 실측 0초 방향은 유도 거리도 0이다. 서버 근거 판별(distance > 0 || duration > 0)이 0/0을 버리므로 값을 만들지 않고 사용 불가로 남긴다.
test("#878 시간만 있는 실측 0초 방향은 거리를 만들지 않고 사용 불가 목록에 남긴다", () => {
  const { officialByDirection, measured } = precedenceFixture();
  const { byDirection, derivedDistanceDirections, unavailableDirections } = applyMeasuredTransferTimePrecedence({ officialByDirection, measured });
  assert.equal(byDirection.has("station-c:line-1->line-4"), false, "0초·0m 방향은 후보에 넣지 않는다");
  assert.equal(derivedDistanceDirections.some(({ stationId }) => stationId === "station-c"), false);
  assert.deepEqual(unavailableDirections.map(({ stationId, fromLineId, toLineId, measuredDurationSeconds, reason }) => [stationId, fromLineId, toLineId, measuredDurationSeconds, reason]),
    [["station-c", "line-1", "line-4", 0, "ZERO_MEASURED_DURATION"]]);
  // 거리 원천과 겹치는 0초 실측은 거리 원천이 있으므로 그대로 쓴다(유도 없음).
  assert.equal(byDirection.get("station-a:line-2->line-1").durationSeconds, 0);
});

test("#876 실측 원천이 서울교통공사 거리 원천이 아닌 공식 원천(부산)과 겹치거나 계약이 다르면 실패한다", () => {
  const { measured, measuredMetric } = precedenceFixture();
  const busanByDirection = officialTransferMetricsByDirection([{ sourceId: BUSAN_TRANSFER_SOURCE_ID, sourceSnapshotId: "busan-snapshot",
    lastVerifiedAt: "2026-10-01T04:15:27.569Z", durationOf: (m) => m.officialDurationSeconds,
    metrics: [{ stationId: "station-a", fromLineId: "line-1", toLineId: "line-2", distanceMeters: 100, officialDurationSeconds: 120, metricProvenance: "OFFICIAL_SOURCE", sourceRecordSha256: "b".repeat(64) }] }]);
  assert.throws(() => applyMeasuredTransferTimePrecedence({ officialByDirection: busanByDirection, measured }),
    /measured transfer time overlaps a non-distance official source: station-a:line-1->line-2/);
  const { officialByDirection } = precedenceFixture();
  for (const patch of [{ distanceMeters: 0 }, { measurement: "ESTIMATED" }, { metricProvenance: "DERIVED_RECIPROCAL" }, { measuredDurationSeconds: -1 }, { measuredDurationSeconds: null }]) {
    assert.throws(() => applyMeasuredTransferTimePrecedence({ officialByDirection, measured: { ...measured, metrics: [{ ...measuredMetric("line-1", "line-2", 214), ...patch }] } }),
      /measured transfer metric contract mismatch/);
  }
  assert.throws(() => applyMeasuredTransferTimePrecedence({ officialByDirection, measured: { ...measured, metrics: [measured.metrics[0], measured.metrics[0]] } }),
    /measured transfer direction is duplicated/);
});

// #878: 시간만 있는 방향(94)은 거리 = round(실측초 × 1.2)로 유도한 VERIFIED 공식 시간 환승이 된다. 실측 0초 방향(중랑 경의중앙→경춘)만 사용 불가로 남는다.
const ZERO_MEASURED_DIRECTION = "station-edf782c1647a-line-6e39be0cb6e2-line-54a7b980b7c3";
test("#876 #878 전국 후보는 겹치는 방향에 실측 시간·서울 거리를, 시간만 있는 방향에 실측 시간·유도 거리를 쓰고, 팩 원천 목록에 실측 원천을 싣는다", async () => {
  const { result, metricByDirection, measuredByDirection } = await preparedTransferEvidence();
  const pack = result.finalPack;
  const routeTransfers = new Map(result.routeInput.routeEdges.filter(({ edgeType }) => edgeType === "IN_STATION_TRANSFER").map((edge) => [edge.edgeId, edge]));
  let overlapping = 0;
  let timeOnly = 0;
  for (const [key, timed] of measuredByDirection) {
    assert.equal(timed.distanceMeters, null, "실측 원천은 거리를 주지 않는다");
    const id = `${timed.stationId}-${timed.fromLineId}-${timed.toLineId}`;
    const rule = pack.transferRules.find(({ id: ruleId }) => ruleId === `rule-transfer-${id}`);
    assert.ok(rule, `measured direction ${id} must be a canonical transfer pair`);
    if (metricByDirection.get(key)?.sourceId === MEASURED_SOURCE_ID && metricByDirection.get(key).distanceDerivation === undefined) {
      overlapping += 1;
      assert.equal(routeTransfers.get(`transfer-${id}`).durationSeconds, timed.measuredDurationSeconds);
      assert.equal(rule.minTransferSeconds, timed.measuredDurationSeconds);
      assert.equal(rule.sourceId, MEASURED_SOURCE_ID);
      continue;
    }
    timeOnly += 1;
    if (timed.measuredDurationSeconds === 0) {
      assert.equal(id, ZERO_MEASURED_DIRECTION);
      assert.equal(routeTransfers.has(`transfer-${id}`), false, "0초·0m 방향은 서버 근거 판별을 통과하지 못하므로 route edge를 만들지 않는다");
      assert.equal(pack.stationPathwayEdges.some(({ id: edgeId }) => edgeId.startsWith(`pathway-edge-${id}-`)), false);
      assert.deepEqual([rule.verificationStatus, rule.sourceId, rule.minTransferSeconds, rule.pathwayEdgeId], ["UNVERIFIED", "", 0, null]);
      continue;
    }
    const derivedMeters = Math.round(timed.measuredDurationSeconds * 1.2);
    const routeEdge = routeTransfers.get(`transfer-${id}`);
    assert.ok(routeEdge, `time-only direction ${id} must be a route edge with a derived distance`);
    assert.deepEqual([routeEdge.durationSeconds, routeEdge.distanceMeters], [timed.measuredDurationSeconds, derivedMeters]);
    const edge = pack.stationPathwayEdges.find(({ id: edgeId }) => edgeId === `pathway-edge-${id}-walk`);
    assert.ok(edge, `time-only direction ${id} must be a VERIFIED pathway row`);
    assert.deepEqual([edge.durationSeconds, edge.distanceMeters, edge.sourceId, edge.provenanceKind, edge.verificationStatus],
      [timed.measuredDurationSeconds, derivedMeters, MEASURED_SOURCE_ID, "OFFICIAL_SOURCE", "VERIFIED"]);
    const binding = sha256(JSON.stringify({ derivationPaceMetersPerSecond: 1.2, distanceDerivation: DISTANCE_DERIVATION, durationSourceRecordSha256: timed.sourceRecordSha256 }));
    assert.deepEqual([edge.providerRecordHash, edge.evidenceHash], [binding, binding], `derived row ${id} must bind the derivation marker`);
    assert.deepEqual([rule.verificationStatus, rule.sourceId, rule.minTransferSeconds, rule.pathwayEdgeId],
      ["VERIFIED", MEASURED_SOURCE_ID, timed.measuredDurationSeconds, `pathway-edge-${id}-walk`]);
  }
  assert.deepEqual([overlapping, timeOnly], [169, 94]);
  const measuredEdges = pack.stationPathwayEdges.filter(({ sourceId }) => sourceId === MEASURED_SOURCE_ID);
  assert.equal(measuredEdges.length, 124 + 93, "서울 OFFICIAL_SOURCE 거리와 겹치는 방향(124)과 유도 거리 방향(93)이 경로 행이 된다");
  const head = JSON.parse(await readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8")).filter(({ sourceId }) => sourceId === MEASURED_SOURCE_ID).at(-1);
  for (const edge of measuredEdges) {
    assert.equal(edge.sourceSnapshotId, head.snapshotId);
    assert.equal(edge.lastVerifiedAt, head.capturedAt);
  }
  const packSource = pack.sourceInventory.find(({ id }) => id === MEASURED_SOURCE_ID);
  assert.ok(packSource, "실측 원천은 팩 sourceInventory에 있어야 한다(production pathway 계약)");
  assert.equal(packSource.updatedAt, head.capturedAt);
  assert.ok(packSource.fields.includes("station_pathway_edges") && packSource.fields.includes("transfer_rules"));
});

// #879 리뷰 F1: 후보 시계(evaluatedAt = publishedAt)는 후보가 인용하는 원문 OCI 객체의 저장 시각(receipt storedAt)보다 앞설 수 없다.
test("#879 F1 후보 시계가 인용 원문의 OCI 저장 시각보다 앞서면 후보 생성이 실패한다", () => {
  const stored = [{ sourceId: "a", storedAt: "2026-10-01T22:47:24.547Z" }, { sourceId: "b", storedAt: "2026-10-01T05:09:04.373Z" }];
  assert.doesNotThrow(() => assertCandidateClockAfterRawStorage({ evaluatedAt: "2026-10-01T22:47:24.547Z", stored }));
  assert.throws(() => assertCandidateClockAfterRawStorage({ evaluatedAt: "2026-10-01T22:47:00.000Z", stored }),
    /nationwide candidate clock precedes the raw object storage of a cited source: a/);
  assert.throws(() => assertCandidateClockAfterRawStorage({ evaluatedAt: "2026-10-01T22:47:30.000Z", stored: [{ sourceId: "c", storedAt: "not-a-time" }] }),
    /nationwide candidate cited raw object storedAt is invalid: c/);
});

test("#879 F1 실측 환승 원천은 원장 영수증 hash에 결속된 OCI 영수증의 storedAt 이후 시계에서만 쓴다", async () => {
  const read = (relative) => readFile(path.join(root, relative));
  const readJson = async (relative) => JSON.parse(await read(relative));
  const [sourceInventory, sourceSnapshots, freshnessPolicy] = await Promise.all([
    readJson("tools/datapack/source-inventory.json"), readJson("tools/datapack/release/source-snapshots.json"), readJson("release/product-gates/datapack-freshness-sla.json"),
  ]);
  const row = sourceSnapshots.filter(({ sourceId }) => sourceId === MEASURED_SOURCE_ID).at(-1);
  const receipt = JSON.parse(await read(`tools/datapack/sources/${row.snapshotId}.receipt.json`));
  assert.equal(sha256(await read(`tools/datapack/sources/${row.snapshotId}.receipt.json`)), row.rawReceiptSha256);
  const resolved = await resolveSeoulMeasuredTransferMetrics({ sourceInventory, sourceSnapshots, freshnessPolicy, evaluatedAt: receipt.storedAt, read });
  assert.equal(resolved.receipt.storedAt, receipt.storedAt);
  await assert.rejects(resolveSeoulMeasuredTransferMetrics({ sourceInventory, sourceSnapshots, freshnessPolicy, evaluatedAt: "2026-10-01T22:47:00.000Z", read }),
    /nationwide candidate clock precedes the raw object storage of a cited source: seoul-metro-transfer-car-door-duration/);
  const tampered = async (relative) => (relative.endsWith(".receipt.json") ? Buffer.from((await read(relative)).toString("utf8").replace(receipt.storedAt, "2026-10-01T16:40:00.000Z")) : read(relative));
  await assert.rejects(resolveSeoulMeasuredTransferMetrics({ sourceInventory, sourceSnapshots, freshnessPolicy, evaluatedAt: receipt.storedAt, read: tampered }),
    /nationwide candidate Seoul measured transfer receipt does not match the ledger/);
  // 커밋된 후보는 인용 원문 저장 이후의 시계를 쓴다.
  const spec = await readJson("tools/datapack/release/candidate-build-spec.json");
  assert.ok(Date.parse(spec.publishedAt) >= Date.parse(receipt.storedAt), `${spec.publishedAt} < ${receipt.storedAt}`);
});

// #872 후속(#866 메인 결정 D1 선행): 역 밖 환승 링크는 링크 자체에 공식 VERIFIED 근거(원천·snapshot·레코드 hash·실측 거리·시간)가
// 있을 때만 route-edge 입력과 팩 환승 데이터에 들어간다. 근거가 없는 링크는 고정 거리·시간 없이 사유와 함께 제외 목록에 남는다.
function verifiedOutOfStationLink(overrides = {}) {
  return {
    id: "out-link-verified", fromStationId: "station-a", fromLineId: "line-1", toStationId: "station-b", toLineId: "line-2",
    durationSeconds: 300, distanceMeters: 250, bidirectional: false,
    sourceId: "official-out-of-station-source", sourceSnapshotId: "snapshot-1", providerRecordHash: "a".repeat(64),
    evidenceHash: "b".repeat(64), provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "VERIFIED",
    ...overrides,
  };
}

test("#872 역 밖 환승은 링크 자체의 공식 VERIFIED 근거가 있을 때만 남고, 나머지는 사유와 함께 제외된다", () => {
  const verified = verifiedOutOfStationLink();
  const unverified = { id: "out-link-unverified", fromStationId: "station-c", fromLineId: "line-1", toStationId: "station-d", toLineId: "line-3", bidirectional: true, provenanceKind: "UNVERIFIED", verificationStatus: "UNVERIFIED" };
  const noSource = verifiedOutOfStationLink({ id: "out-link-no-source", sourceId: "" });
  const noHash = verifiedOutOfStationLink({ id: "out-link-no-hash", providerRecordHash: "" });
  const derived = verifiedOutOfStationLink({ id: "out-link-derived", provenanceKind: "DERIVED_RECIPROCAL" });
  const zeroDistance = verifiedOutOfStationLink({ id: "out-link-zero-distance", distanceMeters: 0 });
  const zeroDuration = verifiedOutOfStationLink({ id: "out-link-zero-duration", durationSeconds: 0 });

  const { admitted, excluded } = admitOutOfStationTransferLinks([verified, unverified, noSource, noHash, derived, zeroDistance, zeroDuration]);

  assert.deepEqual(admitted, [verified], "공식 VERIFIED 근거와 실측 거리·시간이 있는 링크는 그대로 남는다");
  assert.deepEqual(excluded.map(({ id, reason }) => [id, reason]), [
    ["out-link-unverified", "NO_OFFICIAL_VERIFIED_EVIDENCE"],
    ["out-link-no-source", "NO_OFFICIAL_VERIFIED_EVIDENCE"],
    ["out-link-no-hash", "NO_OFFICIAL_VERIFIED_EVIDENCE"],
    ["out-link-derived", "NO_OFFICIAL_VERIFIED_EVIDENCE"],
    ["out-link-zero-distance", "NO_OFFICIAL_MEASUREMENT"],
    ["out-link-zero-duration", "NO_OFFICIAL_MEASUREMENT"],
  ]);
  assert.deepEqual(excluded[0], {
    id: "out-link-unverified", fromStationId: "station-c", fromLineId: "line-1", toStationId: "station-d", toLineId: "line-3",
    bidirectional: true, reason: "NO_OFFICIAL_VERIFIED_EVIDENCE",
  }, "제외 목록은 끝점과 사유만 남기고 거리·시간 값을 싣지 않는다");
});

test("#872 전국 후보는 미검증 역 밖 환승을 route-edge 입력·팩에서 빼고, 제외 사유 목록을 돌려주며, 고정 거리·시간을 남기지 않는다", async () => {
  const result = await prepareNationwideCandidate({
    requestedBy: "data-operator-lead",
    approvedBy: "data-release-authority",
    releaseSequence: 122,
    writeFiles: false,
  });

  assert.deepEqual(result.routeInput.routeEdges.filter(({ edgeType }) => edgeType === "OUT_OF_STATION_TRANSFER"), []);
  assert.deepEqual(result.finalPack.outOfStationTransferLinks, []);
  assert.equal(result.finalPack.networkEdges.some(({ edgeType }) => edgeType === "OUT_OF_STATION_TRANSFER"), false);
  assert.equal(result.finalPack.minimumTableRows.out_of_station_transfer_links, 0);

  const expectedExcluded = [
    "out-link-sinchon-2-to-gj", "out-link-sinchon-gj-to-2", "out-link-seongnam-7-incheon2",
    "out-link-dongnae-1-to-dh", "out-link-dongnae-dh-to-1", "out-link-bujeon-1-to-dh",
    "out-link-daegu-cheongna-to-banwoldang", "out-link-daegu-banwoldang-to-cheongna",
    "out-link-daejeon-seodaejeon-to-oryong", "out-link-daejeon-oryong-to-seodaejeon",
    "out-link-gwangju-songjeong-dosan",
  ];
  assert.deepEqual(result.excludedOutOfStationTransferLinks.map(({ id }) => id), expectedExcluded);
  // 양방향 3개를 펼치면 제외된 방향은 14개다.
  assert.equal(result.excludedOutOfStationTransferLinks.reduce((sum, { bidirectional }) => sum + (bidirectional ? 2 : 1), 0), 14);
  for (const link of result.excludedOutOfStationTransferLinks) {
    assert.equal(link.reason, "NO_OFFICIAL_VERIFIED_EVIDENCE", `${link.id} has no official evidence`);
    assert.equal(Object.hasOwn(link, "durationSeconds"), false, `${link.id} must not carry a fixed duration`);
    assert.equal(Object.hasOwn(link, "distanceMeters"), false, `${link.id} must not carry a fixed distance`);
  }

  // 제외된 역 밖 환승의 끝점 TRANSFER 칸은 환승 없음(NOT_APPLICABLE)으로 바꾸지 않는다. 근거가 없으므로 사용 불가로 드러난다.
  const transferCells = new Map(result.stationLineInput.evidenceRows
    .filter(({ domain }) => domain === "TRANSFER").map((row) => [`${row.stationId}:${row.lineId}`, row.state]));
  for (const link of result.excludedOutOfStationTransferLinks) {
    for (const node of [`${link.fromStationId}:${link.fromLineId}`, `${link.toStationId}:${link.toLineId}`]) {
      assert.notEqual(transferCells.get(node), "NOT_APPLICABLE", `${link.id} endpoint ${node} must stay unavailable, not NOT_APPLICABLE`);
    }
  }
});
