import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildReviewedKricAdmission, REVIEWED_KRIC_CANDIDATE_IDS } from "./admit-reviewed-kric-candidates.mjs";

const root = new URL("../../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

test("KRIC live sample 8건은 admin review 후 provenance 전용 inventory source로 승격한다", async () => {
  const candidates = await readJson("tools/datapack/source-candidates.json");
  const inventory = await readJson("tools/datapack/source-inventory.json");
  const baseInventory = structuredClone(inventory);
  baseInventory.sources = baseInventory.sources.filter(({ id }) => !REVIEWED_KRIC_CANDIDATE_IDS.includes(id));

  const result = buildReviewedKricAdmission({ candidates, inventory: baseInventory });
  const expectedScopes = {
    "kric-subway-route-info": { regionIds: ["capital"], operatorIds: ["airport-railroad"] },
    "kric-station-info": { regionIds: ["capital"], operatorIds: ["korail"] },
    "kric-train-operation-organ": { regionIds: ["daejeon"], operatorIds: ["daejeon-transportation"] },
  };

  assert.equal(REVIEWED_KRIC_CANDIDATE_IDS.length, 8);
  for (const candidateId of REVIEWED_KRIC_CANDIDATE_IDS) {
    const candidate = result.candidates.candidates.find(({ id }) => id === candidateId);
    const source = result.inventory.sources.find(({ id }) => id === candidateId);

    assert.ok(candidate, candidateId);
    assert.ok(source, candidateId);
    assert.equal(candidate.sampleEvidenceStatus, "validated_live_sample");
    assert.equal(candidate.admissionStatus, "admitted_to_production_inventory");
    assert.equal(candidate.productionInventoryReferenceId, candidateId);
    assert.equal(candidate.evidence.adminReview.decision, "APPROVED");
    assert.equal(candidate.evidence.adminReview.approvedBy, "AquilaXk");
    assert.equal(source.requiredForProductionPack, false);
    assert.equal(source.productionUseAllowed, false);
    assert.equal(source.admissionEvidence.issue, 1397);
    assert.equal(source.admissionEvidence.sampleEvidenceHash, candidate.evidence.liveSampleEvidenceHash);
    assert.equal(source.admissionEvidence.rawSha256, candidate.evidence.liveSampleRawSha256);
    assert.equal(source.admissionEvidence.schemaFingerprint, candidate.evidence.liveSampleSchemaFingerprint);
    assert.equal(source.admissionEvidence.quotaEvidence.productionUseAllowed, false);
    assert.equal(source.admissionEvidence.quotaEvidence.defaultDailyLimit, "unlimited");
    assert.ok(Object.values(source.capabilities).every(({ productionUseAllowed }) => productionUseAllowed === false));
    if (expectedScopes[candidateId]) {
      assert.deepEqual(
        {
          regionIds: source.coverageScope.regionIds,
          operatorIds: source.coverageScope.operatorIds,
        },
        expectedScopes[candidateId],
      );
    }
  }

  const standard = result.candidates.candidates.find(({ id }) => id === "kric-transfer-movement-standard");
  assert.equal(standard.admissionStatus, "evidence_recorded_admin_review_required");
  assert.equal(standard.sampleEvidenceStatus, "sample_url_documented_key_required");
  assert.equal(standard.automaticRouteGraphEdgeAllowed, false);
  assert.equal(standard.evidence.adminReview.decision, "REJECTED_NO_DATA");
  assert.equal(standard.evidence.adminReview.approvedBy, "AquilaXk");
  assert.match(standard.evidence.adminReview.reasonKo, /resultCode=03/);
  assert.match(standard.evidence.adminReview.reasonKo, /29252661883/);
  assert.equal(result.inventory.sources.some(({ id }) => id === standard.id), false);

  assert.deepEqual(
    buildReviewedKricAdmission({ candidates: result.candidates, inventory: result.inventory }),
    result,
    "동일한 admin review를 재적용해도 admission hash와 inventory가 바뀌면 안 된다",
  );

  const admissionHashes = REVIEWED_KRIC_CANDIDATE_IDS.map(
    (candidateId) => result.inventory.sources.find(({ id }) => id === candidateId)
      .admissionEvidence.sourceInventorySha256,
  );
  assert.equal(
    new Set(admissionHashes).size,
    1,
    "같은 batch로 admit한 8개 source는 동일한 canonical inventory hash를 공유한다",
  );

  const changedBaseInventory = structuredClone(baseInventory);
  changedBaseInventory.sources[0].coverage = `${changedBaseInventory.sources[0].coverage} 변경`;
  const changed = buildReviewedKricAdmission({ candidates, inventory: changedBaseInventory });
  const changedHash = changed.inventory.sources.find(
    ({ id }) => id === REVIEWED_KRIC_CANDIDATE_IDS[0],
  ).admissionEvidence.sourceInventorySha256;
  assert.notEqual(changedHash, admissionHashes[0], "기존 inventory 내용이 달라지면 admission hash도 달라져야 한다");
});
