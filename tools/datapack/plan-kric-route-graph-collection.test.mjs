import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";

const root = path.resolve(import.meta.dirname, "../..");

async function withCandidatePlanWorkspace(prefix, candidateId, fn) {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-${prefix}-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === candidateId);

  const writeCandidates = (doc = candidates) =>
    writeFile(candidatesPath, `${JSON.stringify(doc, null, 2)}\n`);

  const runPlanner = () =>
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/plan-kric-route-graph-collection.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        candidateId,
      ],
      { cwd: root },
    );

  try {
    await fn({ candidates, candidate, writeCandidates, runPlanner });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

test("KRIC route graph 수집 계획은 검증된 XML live sample을 재취득 없이 그대로 계획한다", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["tools/datapack/plan-kric-route-graph-collection.mjs"],
    { cwd: root },
  );
  const plan = JSON.parse(stdout);

  assert.equal(plan.artifactKind, "kric-route-graph-membership-collection-plan");
  assert.equal(plan.serviceKeyEnv, "KRIC_SERVICE_KEY");
  assert.equal(plan.productionUseAllowed, false);
  assert.equal("remainingAdmissionBlocker" in plan, false);
  assert.deepEqual(
    plan.requests.map((request) => request.candidateId),
    ["kric-subway-route-info", "kric-station-info"],
  );
  for (const request of plan.requests) {
    const url = new URL(request.url);
    const serviceKeyEntries = [...url.searchParams.entries()].filter(
      ([name]) => name.toLowerCase() === "servicekey",
    );
    assert.deepEqual(serviceKeyEntries, [["serviceKey", "[서비스키값]"]]);
    assert.match(request.url, /[?&]serviceKey=\[서비스키값\](?:&|$)/);
    assert.equal(url.searchParams.get("format"), "xml");
    assert.equal(request.sampleEvidenceStatus, "validated_live_sample");
    assert.equal(request.plannedSampleFormat, "xml");
    assert.equal(request.validatedLiveSampleFormat, "xml");
    assert.equal(request.sampleAcquisitionRequired, false);
    assert.equal("remainingAdmissionBlocker" in request, false);
    assert.equal(request.evidenceOutput, `.evidence/evidence/kric/${request.candidateId}.sample.json`);
    assert.equal(request.rawArchiveOutput, `.evidence/evidence/kric/${request.candidateId}.raw.json`);
    assert.equal(request.productionUseAllowed, false);
    assert.equal(request.automaticRouteGraphEdgeAllowed, false);
    assert.deepEqual(request.capabilities, {
      schedule: false,
      realtime: false,
      facility: false,
    });
  }
  assert.equal(plan.requests[0].priority, 1);
  assert.deepEqual(plan.requests[0].remainingAdmissionBlockers, [
    "credentialFreeRawArchive",
    "licenseCommercialRedistributionEvidence",
    "line4RouteStationOrderCoverage",
    "providerTermsOrQuotaApproval",
    "rawObjectUri",
  ]);
  assert.deepEqual(plan.requests[1].remainingAdmissionBlockers, [
    "credentialFreeRawArchive",
    "licenseCommercialRedistributionEvidence",
    "kricStandardStationFileComparison",
    "line4StationCoverage",
    "providerTermsOrQuotaApproval",
    "rawObjectUri",
  ]);
  assert.deepEqual(plan.requests[0].expectedFields, [
    "lnCd",
    "mreaWideCd",
    "railOprIsttCd",
    "routCd",
    "routNm",
    "stinCd",
    "stinConsOrdr",
    "stinNm",
  ]);
});

test("KRIC route graph 수집 계획은 pending 후보의 sample acquisition lifecycle을 보존한다", async () => {
  await withCandidatePlanWorkspace(
    "pending",
    "kric-subway-route-info",
    async ({ candidate, writeCandidates, runPlanner }) => {
      candidate.sampleEvidenceStatus = "sample_url_documented_key_required";
      delete candidate.evidence.liveSampleFormat;
      candidate.evidence.missingEvidence = ["sampleResponse"];
      await writeCandidates();

      const { stdout } = await runPlanner();
      const [request] = JSON.parse(stdout).requests;

      assert.equal(request.sampleEvidenceStatus, "sample_url_documented_key_required");
      assert.equal(request.plannedSampleFormat, "json");
      assert.equal(request.validatedLiveSampleFormat, null);
      assert.equal(request.sampleAcquisitionRequired, true);
      assert.equal("remainingAdmissionBlocker" in request, false);
      assert.deepEqual(request.remainingAdmissionBlockers, ["sampleResponse"]);
      assert.equal(request.productionUseAllowed, false);
      assert.equal(request.automaticRouteGraphEdgeAllowed, false);
    },
  );
});

test("KRIC route graph 수집 계획은 live sample format 누락 또는 미지원 값을 거부한다", async () => {
  await withCandidatePlanWorkspace(
    "live-format",
    "kric-subway-route-info",
    async ({ candidate, writeCandidates, runPlanner }) => {
      delete candidate.evidence.liveSampleFormat;
      await writeCandidates();
      await assert.rejects(runPlanner(), /liveSampleFormat is required/);

      candidate.evidence.liveSampleFormat = "csv";
      await writeCandidates();
      await assert.rejects(runPlanner(), /liveSampleFormat must be JSON or XML/);
    },
  );
});

test("KRIC route graph 수집 계획은 validated live sample provenance 누락·invalid·field mismatch를 거부한다", async () => {
  await withCandidatePlanWorkspace(
    "live-provenance",
    "kric-subway-route-info",
    async ({ candidates, candidate, writeCandidates, runPlanner }) => {
      const invalidValues = {
        liveSampleRawSha256: "A".repeat(64),
        liveSampleSchemaFingerprint: "invalid",
        liveSampleEvidenceHash: "0".repeat(63),
        liveSampleRetrievedAt: "2026-07-11T09:58:45+09:00",
        liveSampleRowCount: 0,
        liveSampleFields: ["lnCd", "lnCd"],
      };

      for (const [field, invalidValue] of Object.entries(invalidValues)) {
        const invalidCandidates = structuredClone(candidates);
        const invalidCandidate = invalidCandidates.candidates.find((entry) => entry.id === candidate.id);
        delete invalidCandidate.evidence[field];
        await writeCandidates(invalidCandidates);
        await assert.rejects(runPlanner(), new RegExp(`${field}.*required`));

        invalidCandidate.evidence[field] = invalidValue;
        await writeCandidates(invalidCandidates);
        await assert.rejects(runPlanner(), new RegExp(field));
      }

      const mismatchedCandidates = structuredClone(candidates);
      const mismatchedCandidate = mismatchedCandidates.candidates.find((entry) => entry.id === candidate.id);
      mismatchedCandidate.evidence.liveSampleFields = mismatchedCandidate.evidence.liveSampleFields.slice(1);
      await writeCandidates(mismatchedCandidates);
      await assert.rejects(runPlanner(), /liveSampleFields must match outputFields/);

      for (const outputFields of ["lnCd", [], ["lnCd", "lnCd"]]) {
        const invalidCandidates = structuredClone(candidates);
        const invalidCandidate = invalidCandidates.candidates.find((entry) => entry.id === candidate.id);
        invalidCandidate.evidence.outputFields = outputFields;
        invalidCandidate.evidence.liveSampleFields = ["lnCd"];
        await writeCandidates(invalidCandidates);
        await assert.rejects(runPlanner(), /outputFields must be non-empty unique strings/);
      }
    },
  );
});

test("KRIC route graph 수집 계획은 지원하지 않는 KRIC 후보를 거부한다", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/plan-kric-route-graph-collection.mjs", "--candidate", "kric-station-platform"],
      { cwd: root },
    ),
    /unsupported KRIC route graph candidate: kric-station-platform/,
  );
});

test("KRIC route graph 수집 계획은 case-insensitive format 변형을 validated XML format 하나로 정규화한다", async () => {
  await withCandidatePlanWorkspace(
    "format",
    "kric-subway-route-info",
    async ({ candidate, writeCandidates, runPlanner }) => {
      candidate.evidence.sampleUrl = candidate.evidence.sampleUrl.replace(
        "format=xml",
        "Format=xml&format=xml",
      );
      await writeCandidates();

      const { stdout } = await runPlanner();
      const [request] = JSON.parse(stdout).requests;
      const formatEntries = [...new URL(request.url).searchParams.entries()].filter(
        ([name]) => name.toLowerCase() === "format",
      );

      assert.deepEqual(formatEntries, [["format", "xml"]]);
      assert.match(request.url, /[?&]format=xml(?:&|$)/);
    },
  );
});

test("KRIC route graph 수집 계획은 provenance 전용이 아닌 admission 또는 production/automatic edge가 열린 후보를 거부한다", async () => {
  await withCandidatePlanWorkspace(
    "state",
    "kric-subway-route-info",
    async ({ candidate, writeCandidates, runPlanner }) => {
      candidate.admissionStatus = "admitted_to_production_inventory";
      candidate.productionInventoryRelationship = "production_runtime_source";
      await writeCandidates();
      await assert.rejects(runPlanner(), /admissionStatus must be pending admin review or inventory provenance only/);

      candidate.admissionStatus = "evidence_recorded_admin_review_required";
      candidate.automaticRouteGraphEdgeAllowed = true;
      await writeCandidates();
      await assert.rejects(runPlanner(), /automatic route graph edge must stay disabled/);

      candidate.automaticRouteGraphEdgeAllowed = false;
      candidate.capabilities.schedule.productionUseAllowed = true;
      await writeCandidates();
      await assert.rejects(runPlanner(), /production capability must stay disabled: schedule/);
    },
  );
});

test("KRIC route graph 수집 계획은 실제 serviceKey가 섞인 후보를 거부한다", async () => {
  await withCandidatePlanWorkspace(
    "secret",
    "kric-subway-route-info",
    async ({ candidate, writeCandidates, runPlanner }) => {
      const originalSampleUrl = candidate.evidence.sampleUrl;
      for (const taintedUrl of [
        originalSampleUrl.replace("[서비스키값]", "real-secret-key"),
        `${originalSampleUrl}&serviceKey=real-secret-key`,
        `${originalSampleUrl}&ServiceKey=real-secret-key`,
      ]) {
        candidate.evidence.sampleUrl = taintedUrl;
        await writeCandidates();
        await assert.rejects(runPlanner(), /sampleUrl must keep exactly one redacted serviceKey/);
      }
    },
  );
});
