import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS,
  nationwideCandidateRefreshViolations,
  parseRefreshNationwideCandidateArgs,
  readNationwideCandidateRefreshState,
  refreshNationwideCandidate,
} from "./refresh-nationwide-candidate.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const VALID_ARGS = [
  "--evaluated-at", "2026-10-01T00:00:00.000Z",
  "--release-sequence", "123",
  "--requested-by", "data-operator-lead",
  "--approved-by", "data-release-authority",
];

test("전국 후보 갱신은 시계·sequence·2인 승인 역할을 모두 명시 인자로만 받는다", () => {
  assert.deepEqual(parseRefreshNationwideCandidateArgs(VALID_ARGS), {
    evaluatedAt: "2026-10-01T00:00:00.000Z",
    releaseSequence: 123,
    requestedBy: "data-operator-lead",
    approvedBy: "data-release-authority",
  });
  const without = (flag) => {
    const index = VALID_ARGS.indexOf(flag);
    return [...VALID_ARGS.slice(0, index), ...VALID_ARGS.slice(index + 2)];
  };
  const previous = { requestedBy: process.env.DATAPACK_REQUESTED_BY, approvedBy: process.env.DATAPACK_APPROVED_BY };
  process.env.DATAPACK_REQUESTED_BY = "env-requester";
  process.env.DATAPACK_APPROVED_BY = "env-approver";
  try {
    assert.throws(() => parseRefreshNationwideCandidateArgs(without("--requested-by")), /--requested-by is required/);
    assert.throws(() => parseRefreshNationwideCandidateArgs(without("--approved-by")), /--approved-by is required/);
  } finally {
    for (const [key, value] of [["DATAPACK_REQUESTED_BY", previous.requestedBy], ["DATAPACK_APPROVED_BY", previous.approvedBy]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.throws(() => parseRefreshNationwideCandidateArgs(without("--evaluated-at")), /--evaluated-at is required/);
  assert.throws(() => parseRefreshNationwideCandidateArgs(without("--release-sequence")), /--release-sequence is required/);
  const replace = (flag, value) => VALID_ARGS.map((entry, index) => (VALID_ARGS[index - 1] === flag ? value : entry));
  assert.throws(() => parseRefreshNationwideCandidateArgs(replace("--approved-by", "  Data-Operator-Lead ")), /two-person/);
  assert.throws(() => parseRefreshNationwideCandidateArgs(replace("--evaluated-at", "2026-10-01")), /--evaluated-at/);
  assert.throws(() => parseRefreshNationwideCandidateArgs(replace("--release-sequence", "0")), /--release-sequence/);
  assert.throws(() => parseRefreshNationwideCandidateArgs([...VALID_ARGS, "--force"]), /unknown/);
  assert.throws(() => parseRefreshNationwideCandidateArgs([...VALID_ARGS, "--approved-by", "other"]), /duplicate/);
});

test("현재 커밋 후보는 facilityEvidenceLedgerHash가 전국 팩과 어긋나 결속 검증에서 정당하게 실패한다", async () => {
  const state = await readNationwideCandidateRefreshState(root);
  const violations = nationwideCandidateRefreshViolations({
    ...state,
    evaluatedAt: state.fanIn.evaluatedAt,
    requestedBy: state.releaseRequest.requestedBy,
    approvedBy: state.releaseRequest.approvedBy,
  });
  // 커밋 후보 a5576faa…는 #858·#859 뒤 prepare가 rowCount만 고쳐 남은 값이다. #862 3단계에서 재생성한다.
  assert.deepEqual(violations, [
    `facilityEvidenceLedgerHash mismatch (build spec: ${state.buildSpec.facilityEvidenceLedgerHash}, recomputed: ${state.ledgerHashes.facilityEvidenceLedgerHash})`,
  ]);
  assert.equal(state.buildSpec.facilityEvidenceLedgerHash, "a5576faa6c4fc3cb888dbd8e12e83ce1de0bb4fc83905ff4916907da6be0aecb");
  assert.equal(state.ledgerHashes.facilityEvidenceLedgerHash, "3766092de0dcebe265569a4038473a5889a85a935f3b533e1a92ebe752542e02");
});

test("결속 검증은 fan-in head·시계·ledger 해시·request 결속이 하나라도 어긋나면 실패한다", async () => {
  const committed = await readNationwideCandidateRefreshState(root);
  const consistent = () => {
    const state = structuredClone({ ...committed, buildSpecBytes: undefined });
    state.buildSpec.facilityEvidenceLedgerHash = state.ledgerHashes.facilityEvidenceLedgerHash;
    state.hashEvidence.ledgerHashes.facilityEvidenceLedgerHash.value = state.ledgerHashes.facilityEvidenceLedgerHash;
    return state;
  };
  const evaluate = (state, overrides = {}) => {
    const buildSpecBytes = jsonBytes(state.buildSpec);
    if (!overrides.keepRequestDigest) state.releaseRequest.buildSpecSha256 = sha256(buildSpecBytes);
    return nationwideCandidateRefreshViolations({
      ...state,
      buildSpecBytes,
      evaluatedAt: overrides.evaluatedAt ?? state.fanIn.evaluatedAt,
      requestedBy: overrides.requestedBy ?? state.releaseRequest.requestedBy,
      approvedBy: state.releaseRequest.approvedBy,
    });
  };
  assert.deepEqual(evaluate(consistent()), []);

  const otherClock = evaluate(consistent(), { evaluatedAt: "2026-10-01T00:00:00.000Z" });
  assert.ok(otherClock.some((violation) => violation.startsWith("fan-in evaluatedAt mismatch")), otherClock.join("\n"));

  const staleHeads = consistent();
  staleHeads.buildSpec.sourceSnapshotIds = staleHeads.buildSpec.sourceSnapshotIds.slice(1);
  assert.ok(evaluate(staleHeads).some((violation) => violation.startsWith("sourceSnapshotIds do not match fan-in heads")));

  const staleSet = consistent();
  staleSet.buildSpec.sourceSnapshotSetHash = "0".repeat(64);
  assert.ok(evaluate(staleSet).some((violation) => violation.startsWith("sourceSnapshotSetHash mismatch")));

  const staleClock = consistent();
  staleClock.buildSpec.publishedAt = "2026-09-01T00:00:00.000Z";
  assert.ok(evaluate(staleClock).some((violation) => violation.startsWith("publishedAt mismatch")));

  const staleLedger = consistent();
  staleLedger.buildSpec.routeEvidenceLedgerHash = "1".repeat(64);
  assert.ok(evaluate(staleLedger).some((violation) => violation.startsWith("routeEvidenceLedgerHash mismatch")));

  const unboundRequest = consistent();
  assert.ok(evaluate(unboundRequest, { keepRequestDigest: true })
    .some((violation) => violation.includes("buildSpecSha256")));

  const otherRequester = consistent();
  assert.ok(evaluate(otherRequester, { requestedBy: "someone-else" })
    .some((violation) => violation.startsWith("requestedBy mismatch")));

  const staleHashEvidence = consistent();
  staleHashEvidence.hashEvidence.sourceSnapshotSetHash.value = "2".repeat(64);
  assert.ok(evaluate(staleHashEvidence).some((violation) => violation.startsWith("hash evidence sourceSnapshotSetHash mismatch")));
});

async function copiedRepository(t) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "nationwide-candidate-refresh-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  for (const relative of [
    ...NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS,
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/fixtures/admin-review-overrides.json",
  ]) {
    await mkdir(path.dirname(path.join(repositoryRoot, relative)), { recursive: true });
    await cp(path.join(root, relative), path.join(repositoryRoot, relative));
  }
  return repositoryRoot;
}

test("전국 후보 갱신은 단계가 실패하면 모든 출력을 원래 바이트로 되돌리고 실패를 드러낸다", async (t) => {
  const repositoryRoot = await copiedRepository(t);
  const before = await Promise.all(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.map((relative) => readFile(path.join(repositoryRoot, relative))));
  const steps = [];
  await assert.rejects(refreshNationwideCandidate({
    repositoryRoot,
    ...parseRefreshNationwideCandidateArgs(VALID_ARGS),
    assertCleanWorktree: async () => {},
    runStep: async ({ name }) => {
      steps.push(name);
      if (name === "five-region fan-in") {
        await writeFile(path.join(repositoryRoot, "tools/datapack/release/current-five-region-source-fan-in.json"), "partial\n");
        return;
      }
      throw new Error("injected ownership failure");
    },
  }), /전국 후보 갱신 실패 \(ownership ledger\): injected ownership failure/);
  assert.deepEqual(steps, ["five-region fan-in", "ownership ledger"]);
  const after = await Promise.all(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.map((relative) => readFile(path.join(repositoryRoot, relative))));
  NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.forEach((relative, index) => assert.deepEqual(after[index], before[index], relative));
});

test("전국 후보 갱신은 결속 검증이 실패해도 출력을 되돌리고 성공으로 끝내지 않는다", async (t) => {
  const repositoryRoot = await copiedRepository(t);
  const before = await Promise.all(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.map((relative) => readFile(path.join(repositoryRoot, relative))));
  const fanIn = JSON.parse(before[0]);
  const request = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/release-request.json")));
  const steps = [];
  await assert.rejects(refreshNationwideCandidate({
    repositoryRoot,
    evaluatedAt: fanIn.evaluatedAt,
    releaseSequence: 122,
    requestedBy: request.requestedBy,
    approvedBy: request.approvedBy,
    assertCleanWorktree: async () => {},
    runStep: async ({ name }) => {
      steps.push(name);
      if (name === "nationwide candidate preparation") {
        await writeFile(path.join(repositoryRoot, "tools/datapack/release/nationwide-route-edge-input.json"), "partial\n");
      }
    },
  }), /전국 후보 갱신 실패 \(binding verification\): .*facilityEvidenceLedgerHash mismatch/s);
  assert.deepEqual(steps, ["five-region fan-in", "ownership ledger", "nationwide candidate preparation"]);
  const after = await Promise.all(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.map((relative) => readFile(path.join(repositoryRoot, relative))));
  NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.forEach((relative, index) => assert.deepEqual(after[index], before[index], relative));
});
