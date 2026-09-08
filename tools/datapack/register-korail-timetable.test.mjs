import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import {
  buildKorailScheduleIds,
  buildKorailScheduleSnapshot,
  buildKorailTimetableRegistrationOutputs,
  commitKorailTimetableRegistrationOutputs,
} from "./register-korail-timetable.mjs";

test("derives stable Korail route and service identities from source, line, and native labels", () => {
  const ids = buildKorailScheduleIds({ lineId: "line-test" });
  assert.match(ids.routes.up, /^route-[a-f0-9]{64}$/);
  assert.match(ids.services["평일"], /^service-[a-f0-9]{64}$/);
  assert.notEqual(ids.routes.up, ids.routes.down);
  assert.notEqual(ids.services["평일"], ids.services["휴일"]);
  assert.throws(() => buildKorailScheduleIds({ lineId: "line-test", directions: ["상"] }), /KORAIL_TIMETABLE_REGISTRATION_IDS/);
});

test("binds every declared schedule input into a self-hashed immutable snapshot", () => {
  const snapshot = buildKorailScheduleSnapshot({ sourceFamilyId: "korail-metropolitan-timetable-file", originalCapturedAt: "2040-01-01T00:00:00.000Z", derivedFreshUntil: "2040-02-01T00:00:00.000Z", serviceEffectiveAt: "2039-12-31T15:00:00.000Z", serviceEffectiveUntil: null, calendarWindow: { startDate: "20400101", endDate: "20400131" }, originalSelection: { lineId: "line-test", operatorName: "한국철도공사", lineName: "대경선" }, topology: { sourceId: "korail-metropolitan-timetable-file", snapshotId: "topology", contentSha256: "a".repeat(64) }, raw: { sourceId: "korail-metropolitan-timetable-file", rawSha256: "b".repeat(64), byteSize: 1, collectionReceiptSha256: "c".repeat(64), publicationReceiptSha256: "d".repeat(64), rawObjectUri: "oci://bucket/raw" }, calendar: { manifestSha256: "e".repeat(64), months: [{ year: 2040, month: 1, sha256: "f".repeat(64) }] }, tables: { serviceCalendars: [], serviceCalendarDates: [], transitRoutes: [], transitTrips: [], transitStopTimes: [], holidayCalendarSources: [] } });
  assert.equal(snapshot.snapshotId, `${snapshot.sourceId}-${snapshot.contentSha256}`);
  assert.match(snapshot.rowsSha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.tripsSha256, /^[a-f0-9]{64}$/);
});

test("rejects a UTC-midnight effective date that excludes the Seoul service-day boundary", () => {
  const input = { sourceFamilyId: "korail-metropolitan-timetable-file", originalCapturedAt: "2040-01-01T00:00:00.000Z", derivedFreshUntil: "2040-02-01T00:00:00.000Z", serviceEffectiveAt: "2040-01-01T00:00:00.000Z", serviceEffectiveUntil: null, calendarWindow: { startDate: "20400101", endDate: "20400131" }, originalSelection: { lineId: "line-test", operatorName: "한국철도공사", lineName: "대경선" }, topology: { sourceId: "korail-metropolitan-timetable-file", snapshotId: "topology", contentSha256: "a".repeat(64) }, raw: { sourceId: "korail-metropolitan-timetable-file", rawSha256: "b".repeat(64), byteSize: 1, collectionReceiptSha256: "c".repeat(64), publicationReceiptSha256: "d".repeat(64), rawObjectUri: "oci://bucket/raw" }, calendar: { manifestSha256: "e".repeat(64), months: [{ year: 2040, month: 1, sha256: "f".repeat(64) }] }, tables: { serviceCalendars: [], serviceCalendarDates: [], transitRoutes: [], transitTrips: [], transitStopTimes: [], holidayCalendarSources: [] } };
  assert.throws(() => buildKorailScheduleSnapshot(input), /KORAIL_TIMETABLE_REGISTRATION_SNAPSHOT/);
});

test("registers retained Korail schedule inputs atomically with receipt-bound parent evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "korail-schedule-registration-"));
  try {
    const { sourceInputPath, candidate, parent, expectedOutputs, time } = await writeRegistrationFixture(root);
    const now = time.now;
    const outputs = await buildKorailTimetableRegistrationOutputs({ repositoryRoot: root, sourceInputPath, now });

    assert.deepEqual(outputs.map(({ relative }) => relative), expectedOutputs);
    const inventory = JSON.parse(outputs[0].bytes);
    const ledger = JSON.parse(outputs[1].bytes);
    const source = inventory.sources.at(-1);
    const row = ledger.at(-1);
    const sourceClass = JSON.parse(outputs[3].bytes).sourceClasses.find(({ id }) => id === "planned_timetable");

    assert.equal(source.id, candidate.id);
    assert.equal(source.updateFrequency, sourceClass.maximumReverificationCadence);
    assert.equal(source.scheduleAdmissionEvidence.topologySnapshotId, parent.snapshot.snapshotId);
    assert.equal(source.scheduleAdmissionEvidence.rawSha256, parent.rawSha256);
    assert.equal(row.serviceEffectiveAt, time.serviceEffectiveAt);
    assert.equal(row.rawReceiptSha256, parent.publicationReceiptSha256);
    assert.equal(row.rawObjectUri, parent.rawObjectUri);

    const snapshotPath = path.join(root, source.scheduleAdmissionEvidence.snapshotPath);
    const snapshot = JSON.parse(await readFile(snapshotPath));
    assert.equal(snapshot.raw.publicationReceiptSha256, parent.publicationReceiptSha256);
    assert.equal(snapshot.topology.snapshotId, parent.snapshot.snapshotId);
    assert.equal(snapshot.serviceEffectiveAt, row.serviceEffectiveAt);

    const candidatePath = path.join(root, "tools/datapack/source-candidates.json");
    const candidateBytes = await readFile(candidatePath);
    await writeFile(candidatePath, Buffer.concat([candidateBytes, Buffer.from("\n")]));
    await assert.rejects(commitKorailTimetableRegistrationOutputs({ repositoryRoot: root, outputs }), /input binding/);
    await writeFile(candidatePath, candidateBytes);

    await assert.rejects(commitKorailTimetableRegistrationOutputs({ repositoryRoot: root, outputs, failAfter: 1 }), /injected Korail timetable transaction failure/);
    for (const output of outputs) {
      assert.deepEqual(await readFile(path.join(root, output.relative)), output.prestateBytes);
    }

    await commitKorailTimetableRegistrationOutputs({ repositoryRoot: root, outputs });
    for (const output of outputs) {
      assert.deepEqual(await readFile(path.join(root, output.relative)), output.bytes);
    }

    const projection = path.join(root, "registered-source-only.json");
    await writeFile(projection, `${JSON.stringify({ ...inventory, sources: [source] }, null, 2)}\n`);
    execFileSync(process.execPath, [path.join(import.meta.dirname, "validate-source-inventory.mjs"),
      "--inventory", projection, "--candidates", candidatePath], { cwd: root, stdio: "pipe" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeRegistrationFixture(root) {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const expectedOutputs = ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json"];
  const [inventoryBytes, governanceBytes, freshnessBytes] = await Promise.all([
    readFile(path.join(repositoryRoot, expectedOutputs[0])),
    readFile(path.join(repositoryRoot, expectedOutputs[2])),
    readFile(path.join(repositoryRoot, expectedOutputs[3])),
  ]);
  const governance = JSON.parse(governanceBytes);
  const time = fixtureTime(governance);
  const candidate = fixtureScheduleCandidate();
  const candidates = { schemaVersion: 1, artifactKind: "production-source-candidates", candidates: [candidate] };

  const workbook = await writeSyntheticWorkbook(root);
  const rawSha256 = hash(workbook);
  const { capturedAt } = time;
  const rawObjectUri = "oci://fixture-bucket/easysubway/raw/korail.xlsx";
  const collectionReceipt = {
    schemaVersion: 1,
    artifactKind: "korail-metropolitan-timetable-file-receipt",
    sourceId: "korail-metropolitan-timetable-file",
    capturedAt,
    rawFile: "timetable.xlsx",
    byteLength: workbook.length,
    sha256: rawSha256,
    officialUrl: "https://www.korail.com/file/cubedata/COMMON/jfile/fixture.xlsx",
    credentialRedacted: true,
  };
  const collectionReceiptPath = path.join(root, "retained/collection-receipt.json");
  await writeJson(collectionReceiptPath, collectionReceipt);

  const membership = membershipObservation({ capturedAt });
  const membershipPath = path.join(root, "retained/membership.json");
  const membershipReceiptPath = path.join(root, "retained/membership-receipt.json");
  await writeJson(membershipPath, membership);
  await writeJson(membershipReceiptPath, {
    schemaVersion: 1,
    artifactKind: "kric-current-station-line-file-receipt",
    sourceId: membership.sourceId,
    capturedAt,
    rawFile: membership.rawFile,
    byteLength: membership.rawByteLength,
    sha256: membership.rawSha256,
    credentialRedacted: true,
  });

  const catalogPath = path.join(root, "retained/catalog.json");
  const catalogBytes = Buffer.from(JSON.stringify({ packs: [{
    stations: [{ id: "fixture-a", nameKo: "가역" }, { id: "fixture-b", nameKo: "나역" }],
    stationLines: [{ stationId: "fixture-a", lineId: candidate.coverageScope.lineIds[0], lineSequence: 1 },
      { stationId: "fixture-b", lineId: candidate.coverageScope.lineIds[0], lineSequence: 2 }],
  }] }));
  await writeFile(catalogPath, catalogBytes);

  const calendarDirectory = path.join(root, "retained/holidays");
  await mkdir(calendarDirectory, { recursive: true });
  const calendarRaw = Buffer.from(`<response><header><resultCode>00</resultCode></header><body><items><item><locdate>${time.serviceDate}</locdate><isHoliday>Y</isHoliday></item></items><totalCount>1</totalCount></body></response>`);
  const calendarSha256 = hash(calendarRaw);
  await writeFile(path.join(calendarDirectory, `${time.year}-${String(time.month).padStart(2, "0")}.xml`), calendarRaw);
  await writeJson(path.join(calendarDirectory, "months.json"), {
    schemaVersion: 1,
    sourceId: "kasi-public-holiday-calendar",
    months: [{ year: time.year, month: time.month, file: `${time.year}-${String(time.month).padStart(2, "0")}.xml`, sha256: calendarSha256, retrievedAt: capturedAt }],
  });

  const topologyContent = {
    schemaVersion: 1,
    artifactKind: "korail-metropolitan-topology-snapshot",
    status: "PENDING",
    releaseEligible: false,
    sourceId: "korail-metropolitan-timetable-file",
    capturedAt,
    freshUntil: time.parentFreshUntil,
    sourceClassId: "route_graph_topology",
    freshnessPolicySha256: hash("fixture-freshness-policy"),
    rawSha256,
    stationCount: 2,
    edgeCount: 2,
    observation: { sources: { membership: { sourceId: membership.sourceId } } },
  };
  const snapshot = { ...topologyContent, contentSha256: hash(canonicalJson(topologyContent)) };
  snapshot.snapshotId = `${snapshot.sourceId}-${snapshot.contentSha256}`;
  const topologyPath = path.join(root, "tools/datapack/sources", `${snapshot.snapshotId}.json`);
  await writeJson(topologyPath, snapshot);
  const publicationReceipt = {
    schemaVersion: 1,
    artifactKind: "korail-metropolitan-timetable-raw-receipt",
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    contentSha256: snapshot.contentSha256,
    collectionReceiptSha256: hash(await readFile(collectionReceiptPath)),
    capturedAt,
    rawObjectUri,
    rawObjectSha256: rawSha256,
    byteSize: workbook.length,
    storedAt: time.storedAt,
    rawRetentionExpiresAt: time.rawRetentionExpiresAt,
  };
  const publicationReceiptPath = path.join(root, "retained/publication-receipt.json");
  await writeJson(publicationReceiptPath, publicationReceipt);
  const publicationReceiptSha256 = hash(await readFile(publicationReceiptPath));

  const licenseEvidenceHash = hash(canonicalJson({
    type: candidate.evidence.license,
    provider: candidate.evidence.provider,
    evidenceUrl: candidate.evidence.licenseEvidenceUrl,
    redistributionAllowed: true,
  }));
  const inventory = JSON.parse(inventoryBytes);
  const governedSourceIds = new Set(governance.sources.map(({ sourceId }) => sourceId));
  inventory.sources = inventory.sources.filter(({ id }) => governedSourceIds.has(id) && ![
    "korail-metropolitan-timetable-file", "korail-metropolitan-planned-timetable",
  ].includes(id));
  inventory.sources.push({
    id: "korail-metropolitan-timetable-file",
    sourceSystem: "fixture-retained-korail",
    requiredForProductionPack: false,
    admissionEvidence: { licenseEvidenceHash },
    topologyAdmissionEvidence: { snapshotId: snapshot.snapshotId, contentSha256: snapshot.contentSha256 },
  });
  const ledger = [];
  ledger.push({
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    rawSha256,
    contentSha256: snapshot.contentSha256,
    capturedAt,
    retrievedAt: capturedAt,
    rawReceiptSha256: publicationReceiptSha256,
    rawObjectUri,
    rawObjectSha256: rawSha256,
    byteSize: workbook.length,
    rawRetentionExpiresAt: publicationReceipt.rawRetentionExpiresAt,
  });
  const freshness = JSON.parse(freshnessBytes);
  const planned = freshness.sourceClasses.find(({ id }) => id === "planned_timetable");
  planned.sourceIds = planned.sourceIds.filter((id) => id !== candidate.id);

  for (const [relative, value] of [
    [expectedOutputs[0], inventory], [expectedOutputs[1], ledger], [expectedOutputs[2], governance],
    [expectedOutputs[3], freshness], ["tools/datapack/source-candidates.json", candidates],
  ]) await writeJson(path.join(root, relative), value);

  const governanceEntry = {
    sourceId: candidate.id,
    ...candidate.scheduleRegistration,
    escalationHours: 4,
    alertRoute: "fixture-owner",
    licenseReview: {
      status: "APPROVED",
      termsHash: licenseEvidenceHash,
      termsUrl: candidate.evidence.licenseEvidenceUrl,
      reviewedProvider: candidate.evidence.provider,
      reviewedDatasetUrl: candidate.detailUrl,
      reviewedAt: capturedAt,
      nextReviewAt: time.nextReviewAt,
      redistributionScopes: ["DERIVED_DATAPACK"],
      approvedByRole: candidate.scheduleRegistration.approvalRole,
    },
  };
  const sourceInputPath = path.join(root, "registration-input.json");
  await writeJson(sourceInputPath, {
    schemaVersion: 1,
    artifactKind: "korail-timetable-registration-input",
    retainedWorkbookPath: path.join(root, "timetable.xlsx"),
    collectionReceiptPath,
    publicationReceiptPath,
    topologySnapshotPath: topologyPath,
    stationLineObservationPath: membershipPath,
    stationLineReceiptPath: membershipReceiptPath,
    canonicalCatalogPath: catalogPath,
    canonicalCatalogSha256: hash(catalogBytes),
    calendarDirectory,
    calendarWindow: { startDate: time.serviceDate, endDate: time.serviceDate },
    serviceEffectiveAt: time.serviceEffectiveAt,
    serviceEffectiveUntil: null,
    operatorName: "한국철도공사",
    lineName: "대경선",
    lineId: candidate.coverageScope.lineIds[0],
    governanceEntry,
  });
  return {
    sourceInputPath,
    candidate,
    parent: { snapshot, rawSha256, rawObjectUri, publicationReceiptSha256 },
    expectedOutputs,
    time,
  };
}

async function writeSyntheticWorkbook(root) {
  const xlsxRoot = path.join(root, "xlsx");
  await mkdir(path.join(xlsxRoot, "xl/_rels"), { recursive: true });
  await mkdir(path.join(xlsxRoot, "xl/worksheets"));
  await writeFile(path.join(xlsxRoot, "xl/workbook.xml"), '<workbook><sheets><sheet name="평일_상" r:id="rId1"/><sheet name="휴일_하" r:id="rId2"/></sheets></workbook>');
  await writeFile(path.join(xlsxRoot, "xl/_rels/workbook.xml.rels"), '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>');
  await writeFile(path.join(xlsxRoot, "xl/worksheets/sheet1.xml"), worksheetXml("가", "나", "T1"));
  await writeFile(path.join(xlsxRoot, "xl/worksheets/sheet2.xml"), worksheetXml("나", "가", "T2"));
  execFileSync("zip", ["-qr", "../timetable.xlsx", "xl"], { cwd: xlsxRoot, stdio: "pipe" });
  return readFile(path.join(root, "timetable.xlsx"));
}

function worksheetXml(origin, terminal, trainNo) {
  const rows = [[10, "시발역", origin], [12, "종착역", terminal], [14, "열차번호", trainNo],
    [20, origin, ""], [21, "", "0.5"], [22, terminal, "0.51"], [23, "", ""]];
  const cells = rows.map(([row, left, right]) => `<row r="${row}"><c r="A${row}" t="inlineStr"><is><t>${left}</t></is></c><c r="B${row}" t="inlineStr"><is><t>${right}</t></is></c></row>`).join("");
  return `<worksheet><sheetData>${cells}</sheetData></worksheet>`;
}

function membershipObservation({ capturedAt }) {
  const records = [["001", "가"], ["002", "나"]].map(([stationNumber, stationName]) => {
    const row = { operatorName: "한국철도공사", lineName: "대경선", stationNumber, stationName };
    return { ...row, sourceRowSha256: hash(JSON.stringify(row)) };
  });
  return {
    schemaVersion: 1,
    artifactKind: "kric-current-station-line-observation",
    sourceId: "kric-current-station-line-file",
    observedAt: capturedAt,
    rawFile: "membership.xlsx",
    rawByteLength: 2,
    rawSha256: hash("[]"),
    rowCount: records.length,
    records,
    recordsSha256: hash(Buffer.from(`${JSON.stringify(records)}\n`)),
  };
}

function fixtureScheduleCandidate() {
  return {
    id: "korail-metropolitan-planned-timetable",
    priority: "P0",
    domain: "schedule_timetable",
    sourceFamilyId: "korail-metropolitan-timetable-file",
    coverageScope: { regionIds: ["fixture-region"], operatorIds: ["fixture-korail"], lineIds: ["fixture-line"] },
    displayName: "Fixture Korail planned timetable",
    detailUrl: "https://example.test/korail-timetable",
    licenseEvidenceStatus: "confirmed_unrestricted_public_data_free_use",
    sampleEvidenceStatus: "retained_file_parsed",
    admissionStatus: "preflight_only",
    mobileEmbeddingAllowed: false,
    scheduleRegistration: {
      sourceClassId: "planned_timetable",
      retentionClassId: "standard-90d",
      ownerRole: "datapack-source-owner",
      stewardRole: "datapack-data-steward",
      approvalRole: "datapack-release-approver",
    },
    evidence: {
      licenseEvidenceUrl: "https://example.test/korail-license",
      license: "unrestricted",
      formats: ["XLSX"],
      provider: "한국철도공사",
      coverage: "Fixture planned timetable",
      retainedReceiptSourceId: "korail-metropolitan-timetable-file",
    },
  };
}

function fixtureTime(policy) {
  const epoch = new Date(`${policy.policyVersion}T00:00:00.000Z`);
  assert.equal(epoch.toISOString().slice(0, 10), policy.policyVersion);
  const standardRetention = policy.retentionClasses.find(({ id }) => id === "standard-90d");
  assert.ok(standardRetention);
  const capturedAt = epoch.toISOString();
  const serviceDay = new Date(epoch.valueOf() + 24 * 60 * 60 * 1_000);
  const serviceDate = serviceDay.toISOString().slice(0, 10).replaceAll("-", "");
  const serviceEffectiveAt = new Date(epoch.valueOf() + 15 * 60 * 60 * 1_000).toISOString();
  return {
    capturedAt,
    now: new Date(epoch.valueOf() + 16 * 60 * 60 * 1_000),
    storedAt: new Date(epoch.valueOf() + 60_000).toISOString(),
    parentFreshUntil: new Date(epoch.valueOf() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    rawRetentionExpiresAt: new Date(epoch.valueOf() + standardRetention.retentionDays * 24 * 60 * 60 * 1_000).toISOString(),
    nextReviewAt: new Date(epoch.valueOf() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
    serviceDate,
    serviceEffectiveAt,
    year: serviceDay.getUTCFullYear(),
    month: serviceDay.getUTCMonth() + 1,
  };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
