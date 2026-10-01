import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { prepareNationwideCandidate, formatPlatformInfo, resolveNationwideCandidateInputSnapshots } from "./prepare-nationwide-candidate-run.mjs";

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
  for (const r of unmappedFacility) {
    assert.strictEqual(r.freshUntil, "2026-12-03T04:39:09.603Z", "Unmapped facility must have genuine KRIC convenience freshUntil");
  }
  assert.strictEqual(
    stationLineRaw.includes("2027-07-13T00:00:00.000Z"),
    false,
    "Raw station-line input must not contain forged timestamp '2027-07-13T00:00:00.000Z'"
  );

  // Total FACILITY UNKNOWN = 641 (639 unmapped + 1 blocked capital station + 1 Gwangju Nokdong)
  const totalUnknownFacility = facilityRows.filter((r) => r.state === "UNKNOWN");
  assert.strictEqual(totalUnknownFacility.length, 641);

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
  assert.ok(result.buildSpecRelPath);
  assert.ok(result.releaseRequestRelPath);
  assert.ok(result.hashEvidenceRelPath);

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

  // 3. Verify candidate build spec
  const buildSpecRaw = await readFile(path.join(root, result.buildSpecRelPath), "utf8");
  const buildSpec = JSON.parse(buildSpecRaw);
  assert.strictEqual(buildSpec.fixtureSha256, sha256(Buffer.from(packRaw)));
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
    readSourceBytes: (relative) => readFile(path.join(root, relative)),
  };
}

const COMMITTED_INPUT_SNAPSHOT_IDS = Object.freeze({
  incheonTopology: "incheon-transit-station-info-20260904",
  incheonLine1: "incheon-line1-train-timetable-20260905",
  incheonLine2: "incheon-line2-train-timetable-20260905",
  busanAccessibility: "busan-transportation-accessibility-3854af12545fc002afaae3204784bf5e9a786a328223c531702b635cf9c47a78-20260909",
  daeguAccessibility: "daegu-transportation-accessibility-25276f4f6e48ab8c6ffca6af833af14ad33fd86777af9d3376eed4b6a77fef9e-20260909",
  daejeonAccessibility: "daejeon-transportation-accessibility-31ef85c5ac5d279d7322c028e05f7be16e6c5a794aa313aef314eef076b61426-20260909",
  gwangjuAccessibility: "gwangju-transportation-accessibility-a39793ed95d7f0075fa0fd58378e651823d9c1ed752ac310a86c853f8853f521-20260909",
  kricConvenience: "kric-station-convenience-standard-20260904T043909603Z",
  busanTimetable: "busan-transportation-timetable-20260909",
  daeguTimetable1: "daegu-line1-train-timetable-f923a86097012cd0d0b76e59599790fb4ec4756269fb0afd293ac9683c31f77c",
  daeguTimetable2: "daegu-line2-train-timetable-798b98f01d9803c2dbe148c6864a876ef991401f19105f711722740a8e5f8215",
  daeguTimetable3: "daegu-line3-train-timetable-9763cdb46b4b2a7ab6ae24f607bba79206763a7329a68b86d16d12f2622d3100",
  daejeonTimetable: "daejeon-train-timetable-20260909",
});

test("후보 입력 선택은 커밋된 원장 head·inventory evidence에서 현재 입력 13개를 고른다", async () => {
  const selected = await resolveNationwideCandidateInputSnapshots(await committedSelectionInputs());
  assert.deepEqual(Object.keys(selected).sort(), Object.keys(COMMITTED_INPUT_SNAPSHOT_IDS).sort());
  for (const [key, snapshotId] of Object.entries(COMMITTED_INPUT_SNAPSHOT_IDS)) {
    assert.equal(selected[key].snapshotId, snapshotId, key);
    assert.equal(selected[key].path, `tools/datapack/sources/${snapshotId}.json`, key);
    assert.ok(Buffer.isBuffer(selected[key].bytes), key);
  }
  assert.equal(selected.kricConvenience.freshnessExpiresAt, "2026-12-03T04:39:09.603Z");
});

test("원장 head가 새 snapshot으로 이어지면 코드 수정 없이 새 입력을 고른다", async () => {
  const inputs = await committedSelectionInputs();
  const sourceId = "busan-transportation-accessibility";
  const previous = inputs.sourceSnapshots.find((row) => row.sourceId === sourceId);
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

test("인천 입력은 inventory admission evidence가 없거나 원본 바이트가 다르면 실패한다", async () => {
  const missing = await committedSelectionInputs();
  delete missing.sourceInventory.sources.find(({ id }) => id === "incheon-line1-train-timetable").scheduleAdmissionEvidence;
  await assert.rejects(resolveNationwideCandidateInputSnapshots(missing), /snapshot path missing or ambiguous for incheon-line1-train-timetable/);

  const tampered = await committedSelectionInputs();
  const readCommitted = tampered.readSourceBytes;
  tampered.readSourceBytes = async (relative) => {
    const bytes = await readCommitted(relative);
    if (relative !== "tools/datapack/sources/incheon-line2-train-timetable-20260905.json") return bytes;
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
