import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCurrentCapitalFacilityCollectionPlan, canonicalCurrentCapitalFacilityCollectionPlanJson } from "../build-current-capital-facility-collection-plan.mjs";
import { buildCurrentCapitalFacilitySourceAdmission, canonicalCurrentCapitalFacilitySourceAdmissionJson } from "../build-current-capital-facility-source-admission.mjs";
import { buildCurrentExitAdmissionArtifactReceipt, canonicalCurrentExitAdmissionArtifactReceiptJson } from "../build-current-exit-admission-artifact-receipt.mjs";
import { buildCurrentExitPathSourceAdmission } from "../build-current-exit-path-source-admission.mjs";
import { canonicalExitPathAdmissionJson } from "../build-exit-path-admission.mjs";
import { buildCurrentKricExitCollectionPlan } from "../build-current-kric-exit-collection-plan.mjs";
import { collectKricStandardAccessibilityObservation } from "../collect-kric-accessibility-snapshots.mjs";
import { collectKricExitPathProviderSnapshot, canonicalKricExitPathProviderSnapshotJson } from "../collect-kric-exit-path-provider-snapshot.mjs";
import { deriveFreshnessExpiresAt } from "../freshness-policy.mjs";
import { canonicalJson } from "../lib/manifest-validation.mjs";
import { deriveReleaseProjection } from "../rebind-current-candidate-source-snapshots.mjs";
import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";
import { buildSnapshotDiff } from "../source-snapshot-policy.mjs";

const FACILITY_SOURCE_ID = "kric-station-convenience-standard";
const EXIT_SOURCE_ID = "kric-station-movement-standard";
const FACILITY_BLOCKED_PROVIDER_TUPLE = Object.freeze(["S1", "2", "234-4"]);
const DATA = "tools/datapack";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function json(root, relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

function sourceClass(policy, sourceId) {
  const matches = policy.sourceClasses.filter(({ sourceIds }) => sourceIds.includes(sourceId));
  if (matches.length !== 1) throw new Error("synthetic KRIC freshness policy is incomplete");
  return matches[0];
}

function selected(candidate, snapshots) {
  const rows = candidate.sourceSnapshotIds.map((snapshotId) => snapshots.find((row) => row.snapshotId === snapshotId));
  if (rows.some((row) => row == null) || new Set(rows.map(({ snapshotId }) => snapshotId)).size !== rows.length) {
    throw new Error("synthetic KRIC candidate selection is incomplete");
  }
  return rows;
}

function facilityRoster(plan) {
  return plan.stationLineProviderMappings.map((entry) => ({
    stationId: entry.stationId,
    lineId: entry.lineId,
    railOprIsttCd: entry.providerOperatorId,
    lnCd: entry.providerLineId,
    stinCd: entry.providerStationId,
    canonicalMappings: [{ artifactId: "synthetic-current-kric", stationId: entry.stationId, lineId: entry.lineId }],
  }));
}

function facilityFetch(url) {
  const tuple = [url.searchParams.get("railOprIsttCd"), url.searchParams.get("lnCd"), url.searchParams.get("stinCd")];
  if (tuple.every((value, index) => value === FACILITY_BLOCKED_PROVIDER_TUPLE[index])) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ header: { resultCode: "03" }, body: [] }),
    };
  }
  const key = tuple.join("\0");
  const codes = sha(key).slice(0, 2) === "00" ? ["EV", "ES"] : ["EV"];
  return {
    ok: true,
    status: 200,
    json: async () => ({
      header: { resultCode: "00" },
      body: codes.map((gubun) => ({
        dtlLoc: "synthetic", grndDvCd: "1", gubun, imgPath: "", mlFmlDvCd: "", stinFlor: 1, trfcWeakDvCd: "01",
      })),
    }),
  };
}

function exitFetch(url) {
  const query = url.searchParams.get("stinCd") ?? "";
  const present = sha(query).slice(0, 1) === "0";
  return new Response(JSON.stringify({
    header: { resultCode: "00", resultMsg: "NORMAL SERVICE" },
    body: present ? [{
        edMovePath: null, elvtSttCd: null, elvtTpCd: null, exitMvTpOrdr: "1", imgPath: null,
        mvContDtl: null, mvPathMgNo: "1", stMovePath: null,
    }] : [],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function zip(entries) {
  let offset = 0; const locals = []; const centrals = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const bytes = Buffer.from(entry.bytes); const crc = crc32(bytes);
    const local = Buffer.alloc(30 + name.length + bytes.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    name.copy(local, 30); bytes.copy(local, 30 + name.length); locals.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42); name.copy(central, 46); centrals.push(central); offset += local.length;
  }
  const central = Buffer.concat(centrals); const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0); footer.writeUInt16LE(entries.length, 8); footer.writeUInt16LE(entries.length, 10); footer.writeUInt32LE(central.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, footer]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function stageSyntheticCurrentKricAccessibilitySuccessors(root, { now }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("synthetic KRIC successor time is invalid");
  const files = {
    candidate: `${DATA}/release/candidate-build-spec.json`, snapshots: `${DATA}/release/source-snapshots.json`, inventory: `${DATA}/source-inventory.json`,
    governance: `${DATA}/source-governance-policy.json`, freshness: "release/product-gates/datapack-freshness-sla.json",
    canonicalPack: `${DATA}/release/capital-production-canonical-pack.json`, coverage: `${DATA}/nationwide-coverage-targets.json`,
    catalog: `${DATA}/sources/kric-provider-code-catalog-20260228.json`, rosters: `${DATA}/sources/kric-nationwide-route-rosters-20260730T203926676Z.json`,
    request: `${DATA}/release/release-request.json`, hashes: `${DATA}/release/hash-evidence.json`,
    facility: `${DATA}/release/current-capital-facility-source-admission.json`, exitNormalized: `${DATA}/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json`,
    exitAdmission: `${DATA}/release/current-exit-admission-v2/exit-path-source-admission.json`, exitReceipt: `${DATA}/release/current-exit-admission-v2/exit-path-admission-artifact-receipt.json`,
  };
  const [candidate, snapshots, inventory, governanceBytes, freshness, canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, request, hashes] = await Promise.all([
    json(root, files.candidate), json(root, files.snapshots), json(root, files.inventory), readFile(path.join(root, files.governance)), json(root, files.freshness),
    readFile(path.join(root, files.canonicalPack)), readFile(path.join(root, files.coverage)), readFile(path.join(root, files.catalog)), readFile(path.join(root, files.rosters)), json(root, files.request), json(root, files.hashes),
  ]);
  const governance = JSON.parse(governanceBytes);
  const facilitySource = inventory.sources.find(({ id }) => id === FACILITY_SOURCE_ID);
  const previous = selected(candidate, snapshots).find(({ sourceId }) => sourceId === FACILITY_SOURCE_ID);
  if (!facilitySource || !previous || snapshots.filter(({ sourceId, snapshotId }) => sourceId === FACILITY_SOURCE_ID && snapshotId === previous.snapshotId).length !== 1) {
    throw new Error("synthetic KRIC FACILITY predecessor is incomplete");
  }
  const capturedAt = new Date(now.getTime() - 60_000);
  if (capturedAt.getTime() <= Date.parse(previous.retrievedAt)) throw new Error("synthetic KRIC FACILITY successor must advance its predecessor");
  const preliminaryPlan = buildCurrentCapitalFacilityCollectionPlan({ canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes: jsonBytes(inventory) });
  const { snapshot, rawArtifact } = await collectKricStandardAccessibilityObservation({
    roster: facilityRoster(preliminaryPlan),
    serviceKey: "fixture-only-key", now: capturedAt, allowTerminalResult03: true, fetchImpl: facilityFetch,
  });
  const blockedQueries = snapshot.queries.filter(({ providerResultCode }) => providerResultCode === "03");
  if (snapshot.absenceEvidenceMode !== "EXHAUSTIVE_LIST_WITH_UNVERIFIED_EVIDENCE_BLOCKED"
    || blockedQueries.length !== 1
    || !FACILITY_BLOCKED_PROVIDER_TUPLE.every((value, index) => [
      blockedQueries[0].railOprIsttCd,
      blockedQueries[0].lnCd,
      blockedQueries[0].stinCd,
    ][index] === value)
    || blockedQueries[0].status !== "UNVERIFIED_EVIDENCE_BLOCKED"
    || blockedQueries[0].terminalPolicy !== "EXACT_TUPLE_PROVIDER_RESULT_03"
    || blockedQueries[0].providerRecordHash !== null
    || blockedQueries[0].rows.length !== 0) {
    throw new Error("synthetic KRIC FACILITY blocked tuple is incomplete");
  }
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  const rawArtifactBytes = Buffer.from(`${JSON.stringify(rawArtifact, null, 2)}\n`);
  const observedAt = now.toISOString();
  facilitySource.observedDataUpdatedAt = capturedAt.toISOString().slice(0, 10);
  facilitySource.retrievedAt = capturedAt.toISOString().slice(0, 10);
  facilitySource.accessibilityAdmissionEvidence = {
    ...facilitySource.accessibilityAdmissionEvidence,
    snapshotId: snapshot.snapshotId, snapshotPath: `${DATA}/sources/${snapshot.snapshotId}.json`, capturedAt: snapshot.capturedAt,
    observedAt: snapshot.observedAt, freshUntil: snapshot.freshUntil, rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256,
    schemaFingerprint: snapshot.schemaFingerprint, redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
    snapshotFileSha256: sha(snapshotBytes), absenceEvidenceMode: snapshot.absenceEvidenceMode,
  };
  const inventoryBytes = jsonBytes(inventory);
  const facilityPlan = buildCurrentCapitalFacilityCollectionPlan({ canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes: inventoryBytes });
  const rawObjectSha256 = sha(rawArtifactBytes);
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy: governance, sourceId: FACILITY_SOURCE_ID, retrievedAt: snapshot.capturedAt });
  const ledger = {
    schemaVersion: 1, artifactKind: "official-source-snapshot", sourceId: FACILITY_SOURCE_ID, snapshotId: snapshot.snapshotId,
    provider: facilitySource.provider, retrievedAt: snapshot.capturedAt, sourceUpdatedAt: snapshot.observedAt, rowCount: snapshot.rowCount, coverageCount: 213,
    rawSha256: rawObjectSha256, rawObjectUri: `oci://fixture/easysubway-datapacks/source-raw/${FACILITY_SOURCE_ID}/${snapshot.capturedAt.slice(0, 10).replaceAll("-", "")}/${rawObjectSha256}.json`,
    rawReceipt: { sourceId: FACILITY_SOURCE_ID, snapshotId: snapshot.snapshotId, snapshotRawSha256: snapshot.rawSha256, snapshotFileSha256: sha(snapshotBytes), rawObjectSha256, capturedAt: snapshot.capturedAt, storedAt: observedAt, byteSize: rawArtifactBytes.length },
    contentSha256: snapshot.contentSha256, redactedRequestFingerprint: snapshot.redactedRequestFingerprint, schemaFingerprint: snapshot.schemaFingerprint,
    snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS", redistributionAllowed: true, credentialRedacted: true,
    previousSnapshotId: previous.snapshotId, freshnessExpiresAt: deriveFreshnessExpiresAt({ policy: freshness, sourceClassId: sourceClass(freshness, FACILITY_SOURCE_ID).id, basisAt: snapshot.capturedAt, evaluationAt: observedAt }), rawRetentionExpiresAt,
    adminReviewRecordHash: facilitySource.admissionEvidence.adminReviewRecordHash, governancePolicySha256: sha(governanceBytes), governancePolicyVersion: governance.policyVersion,
  };
  ledger.diffSummary = buildSnapshotDiff(previous, ledger);
  snapshots.push(ledger);
  const facilityIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === FACILITY_SOURCE_ID);
  if (facilityIndex < 0) throw new Error("synthetic KRIC candidate membership is incomplete");
  candidate.sourceSnapshotIds[facilityIndex] = ledger.snapshotId;
  const candidateSelected = selected(candidate, snapshots);
  candidate.sourceSnapshots = candidateSelected.map((entry) => deriveReleaseProjection({ snapshot: entry, sourceInventory: inventory, governancePolicy: governance, governancePolicyBytes: governanceBytes, freshnessPolicy: freshness, nowMillis: now.getTime() }));
  candidate.sourceSnapshotSetHash = sha(JSON.stringify(snapshots.filter(({ snapshotId }) => new Set(candidate.sourceSnapshotIds).has(snapshotId))));
  candidate.sourceInventorySha256 = sha(JSON.stringify(inventory));
  candidate.networkEdgeEvidence.sourceInventory.sha256 = sha(inventoryBytes);
  const candidateBytes = jsonBytes(candidate);
  Object.assign(request, { buildSpecSha256: sha(candidateBytes), sourceSnapshotSetHash: candidate.sourceSnapshotSetHash });
  hashes.sourceSnapshotSetHash.value = candidate.sourceSnapshotSetHash;
  hashes.sourceInventorySha256.value = candidate.sourceInventorySha256;
  hashes.sourceSnapshots.order = `release snapshot 순서: ${candidateSelected.map(({ sourceId }) => sourceId).join(" → ")}`;
  hashes.perSourceEvidence = candidateSelected.map((entry) => ({ sourceId: entry.sourceId, snapshotId: entry.snapshotId, rawSha256: entry.rawSha256, adminReviewRecordHash: inventory.sources.find(({ id }) => id === entry.sourceId).admissionEvidence.adminReviewRecordHash, perSourceSnapshotSetHash: sha(JSON.stringify([entry])) }));
  const facility = buildCurrentCapitalFacilitySourceAdmission({
    planBytes: Buffer.from(canonicalCurrentCapitalFacilityCollectionPlanJson(facilityPlan)), canonicalPackBytes, snapshotBytes,
    candidateBuildSpec: candidate, sourceInventoryBytes: inventoryBytes, sourceSnapshots: snapshots, governancePolicy: governance, governancePolicyBytes: governanceBytes, freshnessPolicy: freshness, observedAt,
  });
  const exitPlan = buildCurrentKricExitCollectionPlan({ canonicalPackBytes, coverageTargetsBytes, providerCodeCatalogBytes, routeRostersBytes, sourceInventoryBytes: inventoryBytes, incheonTopologyBytes: await readFile(path.join(root, inventory.sources.find(({ id }) => id === "incheon-transit-station-info").routeMapAdmissionEvidence.snapshotPath)) }, { now, coverageSelector: "capital-seoul-metro-production" });
  const exitSnapshot = await collectKricExitPathProviderSnapshot({ collectionPlan: exitPlan, sourceId: EXIT_SOURCE_ID, serviceKey: "fixture-only-key", now, fetchImpl: exitFetch });
  const exitResult = buildCurrentExitPathSourceAdmission({ providerSnapshotBytes: Buffer.from(canonicalKricExitPathProviderSnapshotJson(exitSnapshot)), collectionPlan: exitPlan, facilityAdmission: facility, candidateBuildSpec: candidate, sourceInventory: inventory, sourceSnapshots: snapshots, observedAt });
  const normalizedBytes = Buffer.from(canonicalJson(exitResult.normalizedSnapshot));
  const admissionBytes = Buffer.from(canonicalExitPathAdmissionJson(exitResult.admission));
  const archive = zip([{ name: "exit-path-normalized-source-snapshot.json", bytes: normalizedBytes }, { name: "exit-path-source-admission.json", bytes: admissionBytes }]);
  const identity = sha(candidateBytes); const providerWorkflowRunId = Number.parseInt(identity.slice(0, 7), 16) + 1; const admissionWorkflowRunId = Number.parseInt(identity.slice(7, 14), 16) + 1;
  const receipt = buildCurrentExitAdmissionArtifactReceipt({ artifactArchiveBytes: archive, repository: "AquilaXk/easysubway-data", admissionWorkflowRunId, providerWorkflowRunId, headSha: identity.slice(0, 40), artifactId: Number.parseInt(identity.slice(14, 21), 16) + 1, artifactName: `kric-exit-path-source-admission-${providerWorkflowRunId}`, artifactArchiveSha256: sha(archive) });
  await Promise.all([
    writeFile(path.join(root, `${DATA}/sources/${snapshot.snapshotId}.json`), snapshotBytes), writeFile(path.join(root, files.snapshots), jsonBytes(snapshots)),
    writeFile(path.join(root, files.inventory), inventoryBytes), writeFile(path.join(root, files.candidate), candidateBytes), writeFile(path.join(root, files.request), jsonBytes(request)), writeFile(path.join(root, files.hashes), jsonBytes(hashes)),
    writeFile(path.join(root, files.facility), Buffer.from(canonicalCurrentCapitalFacilitySourceAdmissionJson(facility))), writeFile(path.join(root, files.exitNormalized), normalizedBytes), writeFile(path.join(root, files.exitAdmission), admissionBytes), writeFile(path.join(root, files.exitReceipt), Buffer.from(canonicalCurrentExitAdmissionArtifactReceiptJson(receipt))),
  ]);
  return { facilitySnapshotId: snapshot.snapshotId, exitSnapshotId: exitSnapshot.snapshotId };
}
