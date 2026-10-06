import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateItxPromotionGate,
  itxPromotionGateReceiptBytes,
  parseItxPromotionGatePolicy,
} from "../itx-promotion-gate.mjs";
import {
  ITX_PROMOTION_MODE_GATE_PASSED,
  ITX_PROMOTION_MODE_OWNER_APPROVED,
  hasCurrentItxPromotionIdentity,
  isCurrentItxPromotionMode,
  itxPromotionReceiptPath,
  verifyItxGatePromotion,
} from "./itx-promotion-authority.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const POLICY = parseItxPromotionGatePolicy(JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/itx-promotion-gate-policy.json"), "utf8")));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ARTIFACT_ID = "itx-cheongchun-source-timetable-20261010000000000";
const PREVIOUS_ID = "itx-cheongchun-source-timetable-20261003000000000";

function ownerReference(overrides = {}) {
  const sha = "a".repeat(64);
  return {
    artifactId: ARTIFACT_ID,
    sha256: sha,
    promotion: {
      mode: ITX_PROMOTION_MODE_OWNER_APPROVED,
      previousArtifactSha256: "b".repeat(64),
      previousArtifactPath: `tools/datapack/sources/${PREVIOUS_ID}.json`,
      approvalUrl: "https://github.com/AquilaXk/easysubway-data/issues/636#issuecomment-5981684543",
      approvedArtifactSha256: sha,
    },
    ...overrides,
  };
}

function gateReference(overrides = {}) {
  const sha = "a".repeat(64);
  return {
    artifactId: ARTIFACT_ID,
    sha256: sha,
    promotion: {
      mode: ITX_PROMOTION_MODE_GATE_PASSED,
      previousArtifactSha256: "b".repeat(64),
      previousArtifactPath: `tools/datapack/sources/${PREVIOUS_ID}.json`,
      gate: { policyId: "itx-promotion-gate-v1", receiptPath: itxPromotionReceiptPath(ARTIFACT_ID), receiptSha256: "c".repeat(64) },
      gatedArtifactSha256: sha,
      baselineArtifactPath: `tools/datapack/sources/${PREVIOUS_ID}.json`,
      baselineArtifactSha256: "b".repeat(64),
    },
    ...overrides,
  };
}

test("승격 모드는 승인·게이트 두 가지만 현재 승격으로 인정한다", () => {
  assert.equal(isCurrentItxPromotionMode(ITX_PROMOTION_MODE_OWNER_APPROVED), true);
  assert.equal(isCurrentItxPromotionMode(ITX_PROMOTION_MODE_GATE_PASSED), true);
  for (const mode of ["UNCHANGED_AUTO", "CURRENT_CANDIDATE_AUTO", undefined, null, ""]) assert.equal(isCurrentItxPromotionMode(mode), false);
});

test("승인 모드 승격은 #96·#636 코멘트 URL과 승인 sha가 있어야 하고 게이트 키를 섞지 못한다", () => {
  assert.equal(hasCurrentItxPromotionIdentity(ownerReference()), true);
  const cases = {
    "foreign issue": (reference) => { reference.promotion.approvalUrl = "https://github.com/AquilaXk/easysubway-data/issues/1#issuecomment-1"; },
    "foreign repository": (reference) => { reference.promotion.approvalUrl = "https://github.com/other/easysubway-data/issues/636#issuecomment-1"; },
    "approved sha": (reference) => { reference.promotion.approvedArtifactSha256 = "d".repeat(64); },
    "gate key mixed in": (reference) => { reference.promotion.gate = gateReference().promotion.gate; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const reference = ownerReference();
    mutate(reference);
    assert.equal(hasCurrentItxPromotionIdentity(reference), false, name);
  }
});

test("게이트 모드 승격은 정확한 키·영수증 경로·정책 id·후보 sha를 요구하고 승인 키를 섞지 못한다", () => {
  assert.equal(hasCurrentItxPromotionIdentity(gateReference()), true);
  const cases = {
    "approval url": (reference) => { reference.promotion.approvalUrl = "https://github.com/AquilaXk/easysubway-data/issues/636#issuecomment-1"; },
    "approved sha": (reference) => { reference.promotion.approvedArtifactSha256 = reference.sha256; },
    "policy id": (reference) => { reference.promotion.gate.policyId = "itx-promotion-gate-v2"; },
    "receipt path": (reference) => { reference.promotion.gate.receiptPath = "tools/datapack/sources/other-promotion-gate.json"; },
    "receipt sha": (reference) => { reference.promotion.gate.receiptSha256 = "xyz"; },
    "gated sha": (reference) => { reference.promotion.gatedArtifactSha256 = "d".repeat(64); },
    "missing previous": (reference) => { reference.promotion.previousArtifactSha256 = null; },
    "extra gate key": (reference) => { reference.promotion.gate.extra = true; },
    "missing baseline": (reference) => { delete reference.promotion.baselineArtifactSha256; },
    "baseline sha": (reference) => { reference.promotion.baselineArtifactSha256 = "short"; },
    "baseline path": (reference) => { reference.promotion.baselineArtifactPath = "tools/datapack/other.json"; },
    "extra promotion key": (reference) => { reference.promotion.extra = true; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const reference = gateReference();
    mutate(reference);
    assert.equal(hasCurrentItxPromotionIdentity(reference), false, name);
  }
});

// ---------------------------------------------------------------------------
// 커밋된 증거 재검증
// ---------------------------------------------------------------------------
function daySets(dayCd, { shiftSeconds = 0 } = {}) {
  const stations = ["station-a", "station-b", "station-c"];
  const trains = Array.from({ length: 40 }, (_, index) => String(2001 + index));
  return {
    stationSet: stations,
    odSet: stations.flatMap((from) => stations.filter((to) => to !== from).map((to) => [dayCd, from, to])),
    trainSet: trains,
    stopSequenceSet: trains.map((train) => [dayCd, train, "up", stations]),
    timetableTupleSet: trains.flatMap((train, index) => stations.map((station, stop) => [
      dayCd, train, station, 20_000 + index * 600 + stop * 300 + (index === 5 && stop === 1 ? shiftSeconds : 0), 20_060 + index * 600 + stop * 300 + (index === 5 && stop === 1 ? shiftSeconds : 0),
    ])),
  };
}

function snapshot(artifactId, { shiftSeconds = 0 } = {}) {
  return {
    artifactKind: "itx-cheongchun-source-timetable",
    artifactId,
    observedAt: "2026-10-04T15:15:19.524Z",
    freshUntil: "2026-10-12T00:00:00+09:00",
    selectedServiceDates: { "8": "20261006", "7": "20261010", "9": "20261011" },
    validationStatus: "SUPPORTED",
    normalizedSnapshotSets: ["8", "7", "9"].map((dayCd) => ({ dayCd, sets: daySets(dayCd, { shiftSeconds }) })),
    stationRosters: ["8", "7", "9"].map((dayCd) => ({
      dayCd,
      stations: ["station-a", "station-b", "station-c"].map((id) => ({ canonicalStationId: id, providerStationId: `P-${id}` })),
    })),
    sourceLineage: ["8", "7", "9"].map((dayCd) => ({ dayCd, rosterEvidenceHash: sha256(`r${dayCd}`), timetableEvidenceHash: sha256(`t${dayCd}`) })),
    completenessEvidenceSha256: sha256("completeness"),
  };
}

async function committedPromotion({ shiftSeconds = 0, baselineShiftSeconds = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-authority-"));
  const sourceDir = path.join(dir, "tools/datapack/sources");
  await mkdir(sourceDir, { recursive: true });
  const previous = snapshot(PREVIOUS_ID);
  const candidate = snapshot(ARTIFACT_ID, { shiftSeconds });
  const previousBytes = Buffer.from(`${JSON.stringify(previous, null, 2)}\n`);
  // 기준선(마지막 owner 승인 원천)이 직전 원천과 다르면 별도 파일이다.
  const BASELINE_ID = "itx-cheongchun-source-timetable-20260920000000000";
  const baseline = baselineShiftSeconds === null ? previous : snapshot(BASELINE_ID, { shiftSeconds: baselineShiftSeconds });
  const baselineBytes = baselineShiftSeconds === null ? previousBytes : Buffer.from(`${JSON.stringify(baseline, null, 2)}\n`);
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const completeness = {
    validationMode: "ADMISSION",
    validationStatus: "SUPPORTED",
    observedAt: candidate.observedAt,
    selectedServiceDates: candidate.selectedServiceDates,
    sourceTimetableArtifact: { artifactId: ARTIFACT_ID },
    serviceDays: candidate.sourceLineage.map(({ dayCd, rosterEvidenceHash, timetableEvidenceHash }) => ({
      dayCd, status: "SUPPORTED", expectedOdCount: 6, completedOdCount: 6, failedOdCount: 0,
      roster: { evidenceHash: rosterEvidenceHash }, timetable: { evidenceHash: timetableEvidenceHash },
    })),
  };
  const capture = {
    artifactKind: "provider-response-capture",
    observedAt: candidate.observedAt,
    selectedServiceDates: candidate.selectedServiceDates,
    contentSha256: sha256("capture-content"),
    records: [{ index: 0, outcome: { kind: "RESPONSE", response: { status: 200 } } }],
  };
  const replay = { ...completeness, validationMode: "REPLAY", evidenceHash: sha256("replay") };
  const receipt = evaluateItxPromotionGate({
    policy: POLICY,
    candidate,
    candidateSha256: sha256(candidateBytes),
    completeness,
    completenessSha256: candidate.completenessEvidenceSha256,
    previous,
    previousSha256: sha256(previousBytes),
    baseline,
    baselineSha256: sha256(baselineBytes),
    capture,
    captureSha256: sha256("capture-bytes"),
    replay,
  });
  const receiptBytes = itxPromotionGateReceiptBytes(receipt);
  await writeFile(path.join(sourceDir, `${PREVIOUS_ID}.json`), previousBytes);
  if (baselineShiftSeconds !== null) await writeFile(path.join(sourceDir, `${BASELINE_ID}.json`), baselineBytes);
  await writeFile(path.join(sourceDir, `${ARTIFACT_ID}.json`), candidateBytes);
  await writeFile(path.join(dir, itxPromotionReceiptPath(ARTIFACT_ID)), receiptBytes);
  const reference = gateReference({
    sha256: sha256(candidateBytes),
    artifactPath: `tools/datapack/sources/${ARTIFACT_ID}.json`,
    freshUntil: candidate.freshUntil,
  });
  reference.promotion.previousArtifactSha256 = sha256(previousBytes);
  reference.promotion.gatedArtifactSha256 = reference.sha256;
  reference.promotion.gate.receiptSha256 = sha256(receiptBytes);
  reference.promotion.baselineArtifactSha256 = sha256(baselineBytes);
  reference.promotion.baselineArtifactPath = `tools/datapack/sources/${baselineShiftSeconds === null ? PREVIOUS_ID : BASELINE_ID}.json`;
  return { dir, reference, receipt, sourceDir, candidate, previous };
}

test("커밋된 게이트 영수증은 두 원천 파일에서 지표를 다시 계산해 PASS를 확인한다", async () => {
  const fixture = await committedPromotion();
  try {
    const receipt = await verifyItxGatePromotion({ reference: fixture.reference, repositoryRoot: fixture.dir });
    assert.equal(receipt.status, "PASS");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("영수증·후보·직전 원천 중 하나라도 어긋나면 재검증이 실패한다", async () => {
  const cases = {
    "receipt bytes": async ({ dir }) => writeFile(path.join(dir, itxPromotionReceiptPath(ARTIFACT_ID)), "{}\n"),
    "candidate bytes": async ({ dir }) => writeFile(path.join(dir, `tools/datapack/sources/${ARTIFACT_ID}.json`), "{}\n"),
    "previous bytes": async ({ dir }) => writeFile(path.join(dir, `tools/datapack/sources/${PREVIOUS_ID}.json`), "{}\n"),
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const fixture = await committedPromotion();
    try {
      await tamper(fixture);
      await assert.rejects(verifyItxGatePromotion({ reference: fixture.reference, repositoryRoot: fixture.dir }), /ITX_PROMOTION_/u, name);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }
});

test("영수증이 PASS여도 영수증에 적힌 지표가 원천 파일에서 다시 계산한 값과 다르면 실패한다", async () => {
  const fixture = await committedPromotion();
  try {
    const receipt = JSON.parse(await readFile(path.join(fixture.dir, itxPromotionReceiptPath(ARTIFACT_ID)), "utf8"));
    receipt.checks.find(({ id, dayCd }) => id === "TRIP_COUNT" && dayCd === "8").observed.delta = 1;
    const forged = itxPromotionGateReceiptBytes(receipt);
    await writeFile(path.join(fixture.dir, itxPromotionReceiptPath(ARTIFACT_ID)), forged);
    fixture.reference.promotion.gate.receiptSha256 = sha256(forged);
    await assert.rejects(verifyItxGatePromotion({ reference: fixture.reference, repositoryRoot: fixture.dir }), /ITX_PROMOTION_RECEIPT_METRICS_MISMATCH/u);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("원천이 한도를 넘게 달라졌다면 다시 계산한 지표가 차단이라 PASS 영수증도 거부된다", async () => {
  // 후보 파일을 영수증 발급 뒤에 한도 밖으로 바꾸고 sha를 다시 맞춘 위조: 지표 재계산이 막는다.
  const fixture = await committedPromotion();
  try {
    const forgedCandidate = snapshot(ARTIFACT_ID, { shiftSeconds: 100 });
    for (const day of forgedCandidate.normalizedSnapshotSets) {
      day.sets.timetableTupleSet = day.sets.timetableTupleSet.map((tuple, index) => (index % 3 === 1 ? [tuple[0], tuple[1], tuple[2], tuple[3] + 900, tuple[4] + 900] : tuple));
    }
    const bytes = Buffer.from(`${JSON.stringify(forgedCandidate, null, 2)}\n`);
    await writeFile(path.join(fixture.sourceDir, `${ARTIFACT_ID}.json`), bytes);
    fixture.reference.sha256 = sha256(bytes);
    fixture.reference.promotion.gatedArtifactSha256 = fixture.reference.sha256;
    const receipt = JSON.parse(await readFile(path.join(fixture.dir, itxPromotionReceiptPath(ARTIFACT_ID)), "utf8"));
    receipt.candidate.sha256 = fixture.reference.sha256;
    const rebound = itxPromotionGateReceiptBytes(receipt);
    await writeFile(path.join(fixture.dir, itxPromotionReceiptPath(ARTIFACT_ID)), rebound);
    fixture.reference.promotion.gate.receiptSha256 = sha256(rebound);
    await assert.rejects(verifyItxGatePromotion({ reference: fixture.reference, repositoryRoot: fixture.dir }), /ITX_PROMOTION_RECEIPT_METRICS_MISMATCH/u);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("영수증의 판정이 PASS가 아니거나 후보·직전 결속이 다르면 지표가 맞아도 거부한다", async () => {
  for (const [name, mutate] of Object.entries({
    "status BLOCK": (receipt) => { receipt.status = "BLOCK"; },
    "blocked ids": (receipt) => { receipt.blockedCheckIds = ["TRIP_COUNT:8"]; },
    "other candidate": (receipt) => { receipt.candidate.artifactId = PREVIOUS_ID; },
    "other previous": (receipt) => { receipt.previous.sha256 = "d".repeat(64); },
    "other freshUntil": (receipt) => { receipt.candidate.freshUntil = "2026-10-19T00:00:00+09:00"; },
    "other policy": (receipt) => { receipt.policyId = "itx-promotion-gate-v2"; },
  })) {
    const fixture = await committedPromotion();
    try {
      const receipt = JSON.parse(await readFile(path.join(fixture.dir, itxPromotionReceiptPath(ARTIFACT_ID)), "utf8"));
      mutate(receipt);
      const forged = itxPromotionGateReceiptBytes(receipt);
      await writeFile(path.join(fixture.dir, itxPromotionReceiptPath(ARTIFACT_ID)), forged);
      fixture.reference.promotion.gate.receiptSha256 = sha256(forged);
      await assert.rejects(verifyItxGatePromotion({ reference: fixture.reference, repositoryRoot: fixture.dir }), /ITX_PROMOTION_RECEIPT_IDENTITY_INVALID/u, name);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }
});

test("기준선이 직전 원천과 다르면 기준선 대비 지표도 다시 계산해 영수증과 대조한다 (F2)", async () => {
  // 기준선과 같은 내용의 후보: 직전도 기준선과 같아 모든 BASELINE_* check가 통과한다.
  const fixture = await committedPromotion({ baselineShiftSeconds: 0 });
  try {
    assert.ok(fixture.receipt.checks.some(({ id }) => id === "BASELINE_TRIP_COUNT"));
    assert.equal((await verifyItxGatePromotion({ reference: fixture.reference, repositoryRoot: fixture.dir })).status, "PASS");
    // 기준선 파일이 바뀌면(sha가 다르면) 거부한다.
    await writeFile(path.join(fixture.dir, fixture.reference.promotion.baselineArtifactPath), "{}\n");
    await assert.rejects(verifyItxGatePromotion({ reference: fixture.reference, repositoryRoot: fixture.dir }), /ITX_PROMOTION_SOURCE_SHA256_MISMATCH/u);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("승인 모드 승격에는 게이트 재검증을 적용하지 않는다", async () => {
  await assert.rejects(verifyItxGatePromotion({ reference: ownerReference(), repositoryRoot }), /ITX_PROMOTION_GATE_IDENTITY_INVALID/u);
});

test("저장소의 현재 승격 근거는 구조가 맞고, 게이트 승격이면 커밋된 영수증이 재검증된다", async () => {
  const contract = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const reference = contract.sourceTimetableArtifact;
  assert.equal(hasCurrentItxPromotionIdentity(reference), true);
  if (reference.promotion.mode === ITX_PROMOTION_MODE_GATE_PASSED) {
    const receipt = await verifyItxGatePromotion({ reference, repositoryRoot });
    assert.equal(receipt.status, "PASS");
  }
});
