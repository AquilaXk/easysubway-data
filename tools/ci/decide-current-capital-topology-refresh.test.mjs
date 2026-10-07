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
  const prsPath = path.join(dir, "prs.json"); const claimsPath = path.join(dir, "claims.txt"); const claimEvidencePath = path.join(dir, "claim-evidence.json");
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
  await writeFile(prsPath, "[]"); await writeFile(claimsPath, "[]"); await writeFile(claimEvidencePath, "[]");
  await mkdir(path.dirname(path.join(dir, itxEvidencePath)), { recursive: true });
  await writeFile(path.join(dir, itxEvidencePath), itxEvidenceBytes);
  await writeFile(candidatePath, JSON.stringify({
    itxTopologyEvidencePath: itxEvidencePath,
    itxTopologyEvidenceSha256: sha256(itxEvidenceBytes),
    networkEdgeEvidence: {},
  }));
  return {
    inventoryPath, policyPath, prsPath, claimsPath, claimEvidencePath, candidatePath,
    repositoryRoot: dir, repository: repo, currentMainSha: sha,
  };
}

async function setCandidateItxFreshUntil(input, freshUntil) {
  const candidate = JSON.parse(await readFile(input.candidatePath, "utf8"));
  const evidencePath = path.join(input.repositoryRoot, candidate.itxTopologyEvidencePath);
  const evidenceBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-mobile-topology-evidence",
    sourceArtifact: { freshUntil },
  })}\n`);
  await writeFile(evidencePath, evidenceBytes);
  candidate.itxTopologyEvidenceSha256 = sha256(evidenceBytes);
  await writeFile(input.candidatePath, JSON.stringify(candidate));
}

async function setCandidateItxAdmission(input, freshUntil) {
  const candidate = JSON.parse(await readFile(input.candidatePath, "utf8"));
  const artifactId = "itx-current-network-edge-admission-20260830";
  const relativePath = `tools/datapack/${artifactId}.json`;
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "itx-current-network-edge-admission",
    artifactId,
    status: "ADMITTED",
    freshUntil,
  })}\n`);
  await writeFile(path.join(input.repositoryRoot, relativePath), bytes);
  candidate.networkEdgeEvidence.itxCurrentTopologyAdmission = {
    path: relativePath,
    sha256: sha256(bytes),
  };
  await writeFile(input.candidatePath, JSON.stringify(candidate));
}

test("earliest canonical current topology expiry determines NOT_DUE, DUE, and EXPIRED", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  for (const [now, state] of [["2026-08-30T05:59:59.999Z", "NOT_DUE"], ["2026-08-30T06:00:00.000Z", "DUE"], ["2026-08-30T12:00:00.000Z", "EXPIRED"]]) {
    assert.equal((await decideCurrentCapitalTopologyRefresh({ ...input, now: new Date(now) })).state, state);
  }
  assert.deepEqual(await decideCurrentCapitalTopologyRefresh({
    ...input,
    now: new Date("2026-08-30T07:00:00.000Z"),
  }), {
    state: "DUE",
    alertBeforePackExpiry: "PT6H",
    itxFreshUntil: "2026-08-30T16:00:00.000Z",
    itxRefreshRequired: false,
    cleanupClaims: [],
  });
});

test("같은 KST 날 ITX를 이미 수집했고 이번 갱신이 ITX 수집을 요구하면 WAIT_ITX_COLLECTED_TODAY로 정상 종료한다 (F4)", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  const now = new Date("2026-08-30T11:00:00.000Z");
  const due = await decideCurrentCapitalTopologyRefresh({ ...input, now });
  assert.deepEqual({ state: due.state, itxRefreshRequired: due.itxRefreshRequired }, { state: "DUE", itxRefreshRequired: true });
  const waiting = await decideCurrentCapitalTopologyRefresh({ ...input, now, itxCollectedToday: true });
  assert.deepEqual({ state: waiting.state, itxRefreshRequired: waiting.itxRefreshRequired }, { state: "WAIT_ITX_COLLECTED_TODAY", itxRefreshRequired: true });
  // 만료된 뒤에도, ITX 수집이 필요 없으면(아직 신선하면) 평소처럼 진행한다.
  const expired = await decideCurrentCapitalTopologyRefresh({ ...input, now: new Date("2026-08-30T12:00:00.000Z"), itxCollectedToday: true });
  assert.equal(expired.state, "WAIT_ITX_COLLECTED_TODAY");
  const notRequired = await decideCurrentCapitalTopologyRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z"), itxCollectedToday: true });
  assert.deepEqual({ state: notRequired.state, itxRefreshRequired: notRequired.itxRefreshRequired }, { state: "DUE", itxRefreshRequired: false });
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh({ ...input, now, itxCollectedToday: "yes" }), /decision input is invalid/);
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
  await setCandidateItxFreshUntil(input, "2026-08-30T10:00:00.000Z");

  const result = await decideCurrentCapitalTopologyRefresh({
    ...input,
    now: new Date("2026-08-30T04:00:00.000Z"),
  });
  assert.equal(result.state, "DUE");
  assert.equal(result.itxFreshUntil, "2026-08-30T10:00:00.000Z");
  assert.equal(result.itxRefreshRequired, true);
});

test("candidate-selected ITX freshness accepts an explicit timezone offset", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  await setCandidateItxFreshUntil(input, "2026-08-31T01:00:00+09:00");

  assert.equal((await decideCurrentCapitalTopologyRefresh({
    ...input,
    now: new Date("2026-08-30T05:59:59.999Z"),
  })).state, "NOT_DUE");
});

test("ITX provider skip uses the standalone evidence retained by the next candidate", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  await setCandidateItxFreshUntil(input, "2026-08-30T10:00:00.000Z");
  await setCandidateItxAdmission(input, "2026-08-30T16:00:00.000Z");

  const result = await decideCurrentCapitalTopologyRefresh({
    ...input,
    now: new Date("2026-08-30T07:00:00.000Z"),
  });
  assert.equal(result.state, "DUE");
  assert.equal(result.itxFreshUntil, "2026-08-30T10:00:00.000Z");
  assert.equal(result.itxRefreshRequired, true);
});

const PREFIX = "automation/636-current-topology-refresh-";
const OLD_MAIN = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const SUBJECTS = ["Claim current topology refresh", "Register current topology inputs", "Activate current topology inputs"];
const NOW = new Date("2026-08-30T07:00:00.000Z");
const claimRecord = (runId, { mergeBaseSha = sha, commitCount = 1, subjects = SUBJECTS.slice(0, commitCount) } = {}) => ({ headSha: sha, ref: `refs/heads/${PREFIX}${runId}`, mergeBaseSha, commitCount, subjects });
const topologyPr = (number, state, runId) => ({ number, state, isDraft: true, headRefName: `${PREFIX}${runId}`, baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: repo } });
const claimEvidence = (runId, overrides = {}) => ({
  branch: `${PREFIX}${runId}`, runId: String(runId),
  run: { found: true, status: "completed", conclusion: "failure", workflowName: "Current Capital Topology Refresh", headBranch: "main", steps: [] },
  commits: { aheadBy: 1, subjects: [SUBJECTS[0]], changedFiles: 0 }, artifacts: [], ...overrides,
});
const withOutput = (runId) => claimEvidence(runId, { commits: { aheadBy: 3, subjects: SUBJECTS, changedFiles: 6 } });
const running = (runId) => claimEvidence(runId, { run: { found: true, status: "in_progress", conclusion: null, workflowName: "Current Capital Topology Refresh", headBranch: "main", steps: [] } });
const setClaims = async (input, claims, ...evidence) => { await writeFile(input.claimsPath, JSON.stringify(claims)); await writeFile(input.claimEvidencePath, JSON.stringify(evidence)); };
const topologyResult = { alertBeforePackExpiry: "PT6H", itxFreshUntil: "2026-08-30T16:00:00.000Z", itxRefreshRequired: false };

test("only a same-repository main-base claim can own this automation", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  const branch = `${PREFIX}7`;
  await writeFile(input.prsPath, JSON.stringify([{ number: 1, state: "OPEN", isDraft: true, headRefName: branch, baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: repo } }]));
  assert.equal((await decideCurrentCapitalTopologyRefresh({ ...input, now: NOW })).state, "OPEN_PR");
  await writeFile(input.prsPath, "[]"); await setClaims(input, [claimRecord(7, { commitCount: 3 })], withOutput(7));
  assert.deepEqual(await decideCurrentCapitalTopologyRefresh({ ...input, now: NOW }), { state: "RECOVER_CLAIM", ...topologyResult, branch, cleanupClaims: [] });
});

test("an exact empty current-main claim is reused after a provider failure", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  const branch = `${PREFIX}33457248862`;
  await setClaims(input, [claimRecord(33457248862)], claimEvidence(33457248862));
  assert.deepEqual(await decideCurrentCapitalTopologyRefresh({ ...input, now: NOW }), { state: "REUSE_CLAIM", ...topologyResult, branch, cleanupClaims: [] });
});

test("duplicate, malformed, and closed claims fail closed", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  await writeFile(input.claimsPath, `bad\n`);
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh(input), /claim/);
  await setClaims(input, [claimRecord(1, { commitCount: 3 }), claimRecord(2, { commitCount: 3 })], withOutput(1), withOutput(2));
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh(input), /duplicate/);
  await setClaims(input, [claimRecord(1, { commitCount: 3 })], withOutput(1));
  await writeFile(input.prsPath, JSON.stringify([topologyPr(5, "CLOSED", 1)]));
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh(input), /closed/);
});

test("current-main incomplete claim fails closed while its producer is finished", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  await setClaims(input, [claimRecord(8, { commitCount: 2, subjects: [SUBJECTS[0]] })], withOutput(8));
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh(input), /current-main/);
});

// #995: 만든 run이 아직 도는 claim은 어떤 상태든 기다린다. 도는 run의 claim을 다른 run이 재사용·복구하지 않는다.
test("a claim whose producer run is still running waits, even when it looks incomplete or stale", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  const branch = `${PREFIX}9`;
  for (const claim of [claimRecord(9), claimRecord(9, { commitCount: 2, subjects: SUBJECTS.slice(0, 2) }), claimRecord(9, { commitCount: 3 }), claimRecord(9, { mergeBaseSha: OLD_MAIN })]) {
    await setClaims(input, [claim], running(9));
    assert.deepEqual(await decideCurrentCapitalTopologyRefresh({ ...input, now: NOW }), { state: "CLAIM_IN_PROGRESS", ...topologyResult, branch, cleanupClaims: [] }, JSON.stringify(claim));
  }
});

// 504와 같은 종류: claim 뒤에 main이 움직이면 그 claim은 current가 아니라서 어떤 판정도 보지 않았고 다른 자동화를 영원히 막았다.
test("a stale-main empty claim of a finished run is handed to cleanup while the due state continues", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  const branch = `${PREFIX}10`;
  await setClaims(input, [claimRecord(10, { mergeBaseSha: OLD_MAIN })], claimEvidence(10));
  assert.deepEqual(await decideCurrentCapitalTopologyRefresh({ ...input, now: NOW }), { state: "DUE", ...topologyResult, cleanupClaims: [branch] });
  assert.deepEqual(await decideCurrentCapitalTopologyRefresh({ ...input, now: new Date("2026-08-30T01:00:00.000Z") }), { state: "NOT_DUE", ...topologyResult, cleanupClaims: [branch] });
  await setClaims(input, [claimRecord(10, { mergeBaseSha: OLD_MAIN, commitCount: 0, subjects: [] })], claimEvidence(10, { run: { found: false } }));
  assert.deepEqual((await decideCurrentCapitalTopologyRefresh({ ...input, now: NOW })).cleanupClaims, [branch]);
});

test("a stale-main claim that carries output is an anomaly, never deleted or ignored", async () => {
  const { decideCurrentCapitalTopologyRefresh } = await load(); const input = await fixture();
  await setClaims(input, [claimRecord(11, { mergeBaseSha: OLD_MAIN, commitCount: 3 })], withOutput(11));
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh({ ...input, now: NOW }), /stale current topology refresh claim carries output/);
});

test("a claim without evidence is not guessed and the CLI writes the cleanup claims", async () => {
  const { decideCurrentCapitalTopologyRefresh, runCurrentCapitalTopologyRefreshDecision } = await load(); const input = await fixture();
  await setClaims(input, [claimRecord(12, { mergeBaseSha: OLD_MAIN })]);
  await assert.rejects(() => decideCurrentCapitalTopologyRefresh({ ...input, now: NOW }), /CLAIM_ORPHAN_EVIDENCE_MISSING/);
  await setClaims(input, [claimRecord(12, { mergeBaseSha: OLD_MAIN })], claimEvidence(12));
  const outputPath = path.join(input.repositoryRoot, "decision.json"); const githubOutputPath = path.join(input.repositoryRoot, "github-output.txt");
  await runCurrentCapitalTopologyRefreshDecision({ ...input, outputPath, githubOutputPath, now: NOW });
  assert.equal(await readFile(githubOutputPath, "utf8"), `state=DUE\nbranch=\ncleanup_claims=${PREFIX}12\nitx_fresh_until=2026-08-30T16:00:00.000Z\nitx_refresh_required=false\n`);
});

test("preflight blocks every possible UTC or KST identity during the job window", async () => {
  const { currentCapitalTopologyPreflight } = await load();
  assert.deepEqual(currentCapitalTopologyPreflight({ now: new Date("2026-08-30T14:59:00.000Z"), existingPaths: ["tools/datapack/sources/incheon-line1-train-timetable-20260831.json"] }).state, "WAIT_IMMUTABLE_IDENTITY");
  assert.deepEqual(currentCapitalTopologyPreflight({ now: new Date("2026-08-30T14:59:00.000Z"), existingPaths: ["tools/datapack/itx-current-network-edge-admission-20260831.json"] }).state, "WAIT_IMMUTABLE_IDENTITY");
  assert.equal(currentCapitalTopologyPreflight({ now: new Date("2026-08-30T14:59:00.000Z"), existingPaths: ["tools/datapack/itx-current-network-edge-admission-20260831.json"], itxRefreshRequired: false }).state, "CLEAR");
  assert.equal(currentCapitalTopologyPreflight({ now: new Date("2026-08-30T14:00:00.000Z"), existingPaths: [] }).state, "CLEAR");
});
