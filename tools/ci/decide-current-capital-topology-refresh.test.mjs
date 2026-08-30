import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const modulePath = new URL("./decide-current-capital-topology-refresh.mjs", import.meta.url);
const repo = "AquilaXk/easysubway-data";
const sha = "0123456789abcdef0123456789abcdef01234567";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const currentTopologyAdmission = {
  schemaVersion: 1,
  artifactKind: "capital-route-map-current-topology-admission",
  issue: 2776,
  status: "ADMITTED",
  topologySnapshotId: "capital-route-topology-20260830",
  topologyContentSha256: "a".repeat(64),
  positionSnapshotSha256: "b".repeat(64),
  reviewedAt: "2026-08-30T00:00:00.000Z",
  freshUntil: "2026-08-30T12:00:00.000Z",
  topologyLineages: [{ sourceId: "capital-route-topology", snapshotId: "capital-route-topology-20260830", contentSha256: "a".repeat(64), lineId: "seoul-2" }],
};

function capitalAdmissions() {
  return [
    ...Array.from({ length: 15 }, (_, index) => ({
      id: `capital-position-${index + 1}`,
      routeMapAdmissionEvidence: { topologySourceId: "capital-route-topology", currentTopologyAdmission: { ...currentTopologyAdmission } },
    })),
    {
      id: "seoul-metro-route-map-positions",
      productionUseAllowed: true,
      license: { redistributionAllowed: true },
      routeMapAdmissionEvidence: {
        issue: 2470,
        admissionKind: "official-file-latlon",
        materializer: "tools/datapack/materialize-seoul-route-map-positions.mjs",
        verificationTest: "tools/datapack/materialize-seoul-route-map-positions.test.mjs",
        topologySourceId: "capital-route-topology",
        snapshotSha256: "b".repeat(64),
        lineIds: ["seoul-2"],
        currentTopologyAdmission,
      },
    },
  ];
}

async function load() { return import(`${modulePath.href}?test=${Date.now()}`); }
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "topology-refresh-decision-"));
  const inventoryPath = path.join(dir, "inventory.json"); const policyPath = path.join(dir, "policy.json");
  const prsPath = path.join(dir, "prs.json"); const claimsPath = path.join(dir, "claims.txt");
  const candidatePath = path.join(dir, "candidate.json");
  const itxEvidencePath =
    "tools/datapack/itx-cheongchun-topology-evidence-20260830151000000.json";
  const itxEvidenceBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-mobile-topology-evidence",
    sourceArtifact: { freshUntil: "2026-08-30T16:00:00.000Z" },
  })}\n`);
  await writeFile(inventoryPath, JSON.stringify({ sources: [
    ...capitalAdmissions(),
    { id: "incheon-transit-station-info", topologyAdmissionEvidence: { freshUntil: "2026-08-30T13:00:00.000Z" } },
    { id: "incheon-line1-train-timetable", scheduleAdmissionEvidence: { freshUntil: "2026-08-30T14:00:00.000Z" } },
    { id: "incheon-line2-train-timetable", scheduleAdmissionEvidence: { freshUntil: "2026-08-30T15:00:00.000Z" } },
  ] }));
  await writeFile(policyPath, JSON.stringify({ monitoring: { alertBeforePackExpiry: "PT6H" } }));
  await writeFile(prsPath, "[]"); await writeFile(claimsPath, "[]");
  await mkdir(path.dirname(path.join(dir, itxEvidencePath)), { recursive: true });
  await writeFile(path.join(dir, itxEvidencePath), itxEvidenceBytes);
  await writeFile(candidatePath, JSON.stringify({
    itxTopologyEvidencePath: itxEvidencePath,
    itxTopologyEvidenceSha256: sha256(itxEvidenceBytes),
    networkEdgeEvidence: {},
  }));
  return {
    inventoryPath, policyPath, prsPath, claimsPath, candidatePath,
    repositoryRoot: dir, repository: repo, currentMainSha: sha,
  };
}

test("earliest canonical current topology expiry determines NOT_DUE, DUE, and EXPIRED", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  for (const [now, state] of [["2026-08-30T05:59:59.999Z", "NOT_DUE"], ["2026-08-30T06:00:00.000Z", "DUE"], ["2026-08-30T12:00:00.000Z", "EXPIRED"]]) {
    assert.equal((await decideCurrentCapitalTopologyRefresh({ ...input, now: new Date(now) })).state, state);
  }
});

test("requires exactly sixteen distinct admitted capital sources and all three Incheon inputs", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  const inventory = JSON.parse(await readFile(input.inventoryPath, "utf8"));
  inventory.sources.splice(0, 1);
  await writeFile(input.inventoryPath, JSON.stringify(inventory));
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh(input), /capital current topology admissions/);

  const restored = await fixture();
  const duplicate = JSON.parse(await readFile(restored.inventoryPath, "utf8"));
  duplicate.sources[1].id = duplicate.sources[0].id;
  await writeFile(restored.inventoryPath, JSON.stringify(duplicate));
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh(restored), /capital current topology admissions/);
});

test("candidate-selected ITX freshness participates in the earliest due decision", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  const candidate = JSON.parse(await readFile(input.candidatePath, "utf8"));
  const evidencePath = path.join(input.repositoryRoot, candidate.itxTopologyEvidencePath);
  const evidenceBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-mobile-topology-evidence",
    sourceArtifact: { freshUntil: "2026-08-30T10:00:00.000Z" },
  })}\n`);
  await writeFile(evidencePath, evidenceBytes);
  candidate.itxTopologyEvidenceSha256 = sha256(evidenceBytes);
  await writeFile(input.candidatePath, JSON.stringify(candidate));

  assert.equal((await decideCurrentCapitalTopologyRefresh({
    ...input,
    now: new Date("2026-08-30T04:00:00.000Z"),
  })).state, "DUE");
});

test("only a same-repository main-base claim can own this automation", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  const branch = "automation/636-current-topology-refresh-7";
  await writeFile(input.prsPath, JSON.stringify([{ state: "OPEN", isDraft: true, headRefName: branch, baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: repo } }]));
  assert.equal((await decideCurrentCapitalTopologyRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "OPEN_PR");
  await writeFile(input.prsPath, "[]"); await writeFile(input.claimsPath, JSON.stringify([{ headSha: sha, ref: `refs/heads/${branch}`, mergeBaseSha: sha, commitCount: 3, subjects: ["Claim current topology refresh", "Register current topology inputs", "Activate current topology inputs"] }]));
  assert.deepEqual(await decideCurrentCapitalTopologyRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch });
});

test("duplicate, malformed, and closed claims fail closed", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  await writeFile(input.claimsPath, `bad\n`);
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh(input), /claim/);
  await writeFile(input.claimsPath, JSON.stringify([{ headSha: sha, ref: "refs/heads/automation/636-current-topology-refresh-1", mergeBaseSha: sha, commitCount: 3, subjects: ["Claim current topology refresh", "Register current topology inputs", "Activate current topology inputs"] }, { headSha: sha, ref: "refs/heads/automation/636-current-topology-refresh-2", mergeBaseSha: sha, commitCount: 3, subjects: ["Claim current topology refresh", "Register current topology inputs", "Activate current topology inputs"] }]));
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh(input), /duplicate/);
  const branch = "automation/636-current-topology-refresh-1";
  await writeFile(input.claimsPath, JSON.stringify([{ headSha: sha, ref: `refs/heads/${branch}`, mergeBaseSha: sha, commitCount: 3, subjects: ["Claim current topology refresh", "Register current topology inputs", "Activate current topology inputs"] }]));
  await writeFile(input.prsPath, JSON.stringify([{ state: "CLOSED", isDraft: true, headRefName: branch, baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: repo } }]));
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh(input), /closed/);
});

test("old-main claim remains inactive while current-main incomplete claim fails closed", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  const branch = "automation/636-current-topology-refresh-8";
  await writeFile(input.claimsPath, JSON.stringify([{ headSha: sha, ref: `refs/heads/${branch}`, mergeBaseSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", commitCount: 0, subjects: [] }]));
  assert.equal((await decideCurrentCapitalTopologyRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "DUE");
  await writeFile(input.claimsPath, JSON.stringify([{ headSha: sha, ref: `refs/heads/${branch}`, mergeBaseSha: sha, commitCount: 2, subjects: ["Claim current topology refresh"] }]));
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh(input), /current-main/);
});

test("preflight blocks every possible UTC or KST identity during the job window", async () => {
  const { currentCapitalTopologyPreflight } = await load();
  assert.deepEqual(currentCapitalTopologyPreflight({ now: new Date("2026-08-30T14:59:00.000Z"), existingPaths: ["tools/datapack/sources/incheon-line1-train-timetable-20260831.json"] }).state, "WAIT_IMMUTABLE_IDENTITY");
  assert.equal(currentCapitalTopologyPreflight({ now: new Date("2026-08-30T14:00:00.000Z"), existingPaths: [] }).state, "CLEAR");
});
