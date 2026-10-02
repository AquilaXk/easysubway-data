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
  runNationwideCandidateRefreshStep,
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

test("현재 커밋 후보는 refresh-nationwide-candidate로 재생성돼 결속 검증을 통과한다(#862)", async () => {
  const state = await readNationwideCandidateRefreshState(root);
  const violations = nationwideCandidateRefreshViolations({
    ...state,
    evaluatedAt: state.fanIn.evaluatedAt,
    requestedBy: state.releaseRequest.requestedBy,
    approvedBy: state.releaseRequest.approvedBy,
  });
  assert.deepEqual(violations, []);
  assert.equal(state.buildSpec.facilityEvidenceLedgerHash, state.ledgerHashes.facilityEvidenceLedgerHash);
  assert.equal(state.buildSpec.publishedAt, state.fanIn.evaluatedAt);
});

test("결속 검증은 fan-in head·시계·ledger 해시·request 결속이 하나라도 어긋나면 실패한다", async () => {
  const committed = await readNationwideCandidateRefreshState(root);
  const consistent = () => {
    const state = structuredClone({ ...committed, buildSpecBytes: undefined });
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
  unboundRequest.releaseRequest.buildSpecSha256 = "3".repeat(64);
  assert.ok(evaluate(unboundRequest, { keepRequestDigest: true })
    .some((violation) => violation.includes("buildSpecSha256")));

  const otherRequester = consistent();
  assert.ok(evaluate(otherRequester, { requestedBy: "someone-else" })
    .some((violation) => violation.startsWith("requestedBy mismatch")));

  const staleHashEvidence = consistent();
  staleHashEvidence.hashEvidence.sourceSnapshotSetHash.value = "2".repeat(64);
  assert.ok(evaluate(staleHashEvidence).some((violation) => violation.startsWith("hash evidence sourceSnapshotSetHash mismatch")));
});

const ROUTE_EDGE_POLICY = "release/product-gates/route-edge-evaluation-policy.json";
const NATIONWIDE_ROUTE_EDGE_INPUT = "tools/datapack/release/nationwide-route-edge-input.json";
const ITX_CONTRACT = "tools/datapack/itx-cheongchun-coverage-contract.json";
const STEPS = ["five-region fan-in", "ownership ledger", "nationwide candidate preparation", "nationwide candidate build", "route edge policy sync"];

async function copiedRepository(t) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "nationwide-candidate-refresh-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  // 정책 sync는 ITX 승인 원천을 읽는다. 계약이 가리키는 원천·완결성 증거도 함께 복사한다.
  const itxReference = JSON.parse(await readFile(path.join(root, ITX_CONTRACT), "utf8")).sourceTimetableArtifact;
  for (const relative of [
    ...NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS,
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/fixtures/admin-review-overrides.json",
    ITX_CONTRACT,
    itxReference.artifactPath,
    itxReference.completenessEvidencePath,
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
  const buildSpecPath = path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json");
  const buildSpec = JSON.parse(await readFile(buildSpecPath));
  const steps = [];
  await assert.rejects(refreshNationwideCandidate({
    repositoryRoot,
    evaluatedAt: fanIn.evaluatedAt,
    releaseSequence: buildSpec.releaseSequence,
    requestedBy: request.requestedBy,
    approvedBy: request.approvedBy,
    assertCleanWorktree: async () => {},
    runStep: async ({ name }) => {
      steps.push(name);
      if (name === "nationwide candidate preparation") {
        await writeFile(path.join(repositoryRoot, "tools/datapack/release/nationwide-route-edge-input.json"), "partial\n");
      }
      // 빌드 단계가 원장과 어긋난 spec을 남기면 결속 검증이 잡아야 한다.
      if (name === "nationwide candidate build") {
        await writeFile(buildSpecPath, jsonBytes({ ...buildSpec, facilityEvidenceLedgerHash: "0".repeat(64) }));
      }
    },
  }), /전국 후보 갱신 실패 \(binding verification\): .*facilityEvidenceLedgerHash mismatch/s);
  assert.deepEqual(steps, STEPS);
  const after = await Promise.all(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.map((relative) => readFile(path.join(repositoryRoot, relative))));
  NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.forEach((relative, index) => assert.deepEqual(after[index], before[index], relative));
});

test("#862 전국 후보 갱신은 spec·scope·request·hash를 build-nationwide-candidate 한 경로로만 만든다", async (t) => {
  assert.ok(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.includes("release/product-gates/production-datapack-scope.json"));
  const repositoryRoot = await copiedRepository(t);
  const fanIn = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/current-five-region-source-fan-in.json")));
  const request = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/release-request.json")));
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json")));
  const steps = [];
  await assert.doesNotReject(refreshNationwideCandidate({
    repositoryRoot,
    evaluatedAt: fanIn.evaluatedAt,
    releaseSequence: buildSpec.releaseSequence,
    requestedBy: request.requestedBy,
    approvedBy: request.approvedBy,
    assertCleanWorktree: async () => {},
    runStep: async ({ name }) => { steps.push(name); },
  }));
  assert.deepEqual(steps, STEPS);
  const prepare = await readFile(path.join(root, "tools/datapack/prepare-nationwide-candidate-run.mjs"), "utf8");
  for (const output of ["candidate-build-spec.json", "release-request.json", "hash-evidence.json"]) {
    assert.equal(prepare.includes(output), false, `prepare must not patch ${output}`);
  }
});

test("#866 전국 후보 갱신은 마지막 단계에서 route-edge 정책을 전국 입력 sync 결과로 다시 만든다", async (t) => {
  assert.ok(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.includes(ROUTE_EDGE_POLICY));
  const repositoryRoot = await copiedRepository(t);
  const committedPolicy = await readFile(path.join(root, ROUTE_EDGE_POLICY));
  // 정책 digest를 다른 값으로 바꿔 둔다. 갱신이 전국 입력에서 다시 계산해야만 커밋 바이트로 돌아온다.
  const policy = JSON.parse(committedPolicy);
  const stalePolicy = committedPolicy.toString("utf8")
    .replace(policy.rideInvariant.subwayLocal.admittedEdgeSetSha256, "a".repeat(64))
    .replace(policy.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256, "b".repeat(64));
  assert.notEqual(stalePolicy, committedPolicy.toString("utf8"));
  await writeFile(path.join(repositoryRoot, ROUTE_EDGE_POLICY), stalePolicy);
  const fanIn = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/current-five-region-source-fan-in.json")));
  const request = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/release-request.json")));
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json")));
  const steps = [];
  const result = await refreshNationwideCandidate({
    repositoryRoot,
    evaluatedAt: fanIn.evaluatedAt,
    releaseSequence: buildSpec.releaseSequence,
    requestedBy: request.requestedBy,
    approvedBy: request.approvedBy,
    assertCleanWorktree: async () => {},
    runStep: async (context) => {
      steps.push(context.name);
      // 앞 단계(원천·prepare·build)는 커밋 산출물을 그대로 둔다. 정책 sync만 실제 단계로 실행한다.
      if (context.name === "route edge policy sync") await runNationwideCandidateRefreshStep(context);
    },
  });
  assert.deepEqual(steps, STEPS);
  assert.ok(result.outputs.includes(ROUTE_EDGE_POLICY));
  assert.deepEqual(await readFile(path.join(repositoryRoot, ROUTE_EDGE_POLICY)), committedPolicy);
});

test("#866 route-edge 정책 sync가 실패하면 정책을 포함한 모든 출력을 실행 전 바이트로 되돌린다", async (t) => {
  const repositoryRoot = await copiedRepository(t);
  const before = await Promise.all(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.map((relative) => readFile(path.join(repositoryRoot, relative))));
  const fanIn = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/current-five-region-source-fan-in.json")));
  const request = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/release-request.json")));
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json")));
  const steps = [];
  await assert.rejects(refreshNationwideCandidate({
    repositoryRoot,
    evaluatedAt: fanIn.evaluatedAt,
    releaseSequence: buildSpec.releaseSequence,
    requestedBy: request.requestedBy,
    approvedBy: request.approvedBy,
    assertCleanWorktree: async () => {},
    runStep: async (context) => {
      steps.push(context.name);
      if (context.name === "nationwide candidate preparation") {
        // 전국 입력의 RIDE 간선 hash를 깨뜨린다. 정책 sync가 이 입력을 거부해야 한다.
        const input = JSON.parse(await readFile(path.join(repositoryRoot, NATIONWIDE_ROUTE_EDGE_INPUT)));
        input.routeEdges.find(({ edgeType }) => edgeType === "RIDE").durationSeconds += 1;
        await writeFile(path.join(repositoryRoot, NATIONWIDE_ROUTE_EDGE_INPUT), jsonBytes(input));
      }
      if (context.name === "nationwide candidate build") {
        // 실패 전에 정책 파일이 바뀐 상태를 만든다. 롤백이 정책까지 되돌리는지 본다.
        const policyPath = path.join(repositoryRoot, ROUTE_EDGE_POLICY);
        const policyText = await readFile(policyPath, "utf8");
        const { rideInvariant } = JSON.parse(policyText);
        await writeFile(policyPath, policyText.replace(rideInvariant.subwayLocal.admittedEdgeSetSha256, "c".repeat(64)));
      }
      if (context.name === "route edge policy sync") await runNationwideCandidateRefreshStep(context);
    },
  }), /전국 후보 갱신 실패 \(route edge policy sync\): .*hash mismatch/s);
  assert.deepEqual(steps, STEPS);
  const after = await Promise.all(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.map((relative) => readFile(path.join(repositoryRoot, relative))));
  NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.forEach((relative, index) => assert.deepEqual(after[index], before[index], relative));
  assert.deepEqual(await readFile(path.join(repositoryRoot, ROUTE_EDGE_POLICY)), await readFile(path.join(root, ROUTE_EDGE_POLICY)));
});
