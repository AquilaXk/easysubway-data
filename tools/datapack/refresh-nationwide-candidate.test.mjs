import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";
import { rebindCurrentSeoulTransferSourceAdmission } from "./rebind-current-seoul-transfer-source-admission.mjs";
import {
  rewriteSeoulTransferFixtureCanonicalPack,
  SEOUL_TRANSFER_REBIND_PAR_BASE_URL,
  SEOUL_TRANSFER_REBIND_PATHS,
  writeSeoulTransferRebindRepository,
} from "./test-fixtures/seoul-transfer-rebind-repository.mjs";

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

test("#929 D3 정기 역할 갱신은 그 run의 gate-run 파일 없이는 시작하지 않는다", () => {
  const scheduled = [
    "--evaluated-at", "2026-10-01T00:00:00.000Z", "--release-sequence", "123",
    "--requested-by", "datapack-scheduled-refresh", "--approved-by", "datapack-release-gates",
  ];
  assert.throws(() => parseRefreshNationwideCandidateArgs(scheduled), /scheduled roles require --gate-run/);
  assert.deepEqual(parseRefreshNationwideCandidateArgs([...scheduled, "--gate-run", "/tmp/gate-run.json"]), {
    evaluatedAt: "2026-10-01T00:00:00.000Z", releaseSequence: 123,
    requestedBy: "datapack-scheduled-refresh", approvedBy: "datapack-release-gates", gateRunPath: "/tmp/gate-run.json",
  });
  assert.throws(() => parseRefreshNationwideCandidateArgs([...scheduled, "--gate-run", "relative.json"]), /--gate-run must be an absolute path/);
});

test("#929 D3 결속 검증은 release request의 gateRun이 이번 run과 다르면 실패한다", async () => {
  const state = await readNationwideCandidateRefreshState(root);
  const gateRun = { repository: "AquilaXk/easysubway-data", workflowPath: ".github/workflows/nationwide-candidate-refresh.yml",
    runId: 1, runAttempt: 1, event: "workflow_dispatch", headSha: "a".repeat(40) };
  const base = { ...state, evaluatedAt: state.fanIn.evaluatedAt,
    requestedBy: state.releaseRequest.requestedBy, approvedBy: state.releaseRequest.approvedBy };
  assert.ok(nationwideCandidateRefreshViolations({ ...base, gateRun }).some((violation) => /gateRun mismatch/.test(violation)));
  const bound = { ...base, releaseRequest: { ...state.releaseRequest, gateRun } };
  assert.ok(nationwideCandidateRefreshViolations(bound).some((violation) => /gateRun mismatch/.test(violation)));
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
// #942: 결속 검증을 통과한 뒤에만 후보 입력 매니페스트를 기록하고 OCI에 올린다.
const INPUT_STEPS = ["candidate input record", "candidate input publish"];
const CANDIDATE_INPUT_MANIFEST = "tools/datapack/release/nationwide-candidate-input-manifest.json";

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

test("#942 전국 후보 갱신은 결속 검증 뒤 입력 매니페스트를 기록하고 OCI에 올리며, 올리기가 실패하면 매니페스트까지 되돌린다", async (t) => {
  assert.ok(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.includes(CANDIDATE_INPUT_MANIFEST));
  const repositoryRoot = await copiedRepository(t);
  const manifestPath = path.join(repositoryRoot, CANDIDATE_INPUT_MANIFEST);
  const before = await readFile(manifestPath);
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
    runStep: async ({ name }) => {
      steps.push(name);
      if (name === "candidate input record") await writeFile(manifestPath, "recorded\n");
      if (name === "candidate input publish") throw new Error("CANDIDATE_INPUT_OBJECT_MISMATCH: injected");
    },
  }), /전국 후보 갱신 실패 \(candidate input publish\): CANDIDATE_INPUT_OBJECT_MISMATCH: injected/);
  assert.deepEqual(steps, [...STEPS, ...INPUT_STEPS]);
  assert.deepEqual(await readFile(manifestPath), before);
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
  assert.deepEqual(steps, [...STEPS, ...INPUT_STEPS]);
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

// #866 F1: 정책 단계의 ITX 원천 승인은 벽시계(EASYSUBWAY_DATAPACK_BUILD_NOW 또는 현재 시각)가 아니라 후보 시계(--evaluated-at)로 판정한다.
async function withWallClock(t, instant) {
  const previous = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = instant;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(instant) });
  t.after(() => {
    t.mock.timers.reset();
    if (previous === undefined) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previous;
  });
}

async function itxFreshUntilMillis() {
  const reference = JSON.parse(await readFile(path.join(root, ITX_CONTRACT), "utf8")).sourceTimetableArtifact;
  const freshUntil = Date.parse(reference.freshUntil);
  assert.ok(Number.isFinite(freshUntil), "ITX freshUntil must be an instant");
  return freshUntil;
}

const DAY_MS = 24 * 60 * 60 * 1000;

test("#866 F1 후보 시계가 ITX freshUntil 이후면 벽시계가 신선해도 정책 단계가 expired로 실패하고 모든 출력을 되돌린다", async (t) => {
  const repositoryRoot = await copiedRepository(t);
  const before = await Promise.all(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.map((relative) => readFile(path.join(repositoryRoot, relative))));
  const freshUntil = await itxFreshUntilMillis();
  const request = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/release-request.json")));
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json")));
  // 벽시계는 freshUntil 이전(신선)이다. 벽시계로 판정하면 sync가 성공해 이 테스트가 실패한다.
  await withWallClock(t, new Date(freshUntil - DAY_MS).toISOString());
  const steps = [];
  await assert.rejects(refreshNationwideCandidate({
    repositoryRoot,
    evaluatedAt: new Date(freshUntil + DAY_MS).toISOString(),
    releaseSequence: buildSpec.releaseSequence,
    requestedBy: request.requestedBy,
    approvedBy: request.approvedBy,
    assertCleanWorktree: async () => {},
    runStep: async (context) => {
      steps.push(context.name);
      if (context.name === "five-region fan-in") {
        await writeFile(path.join(repositoryRoot, "tools/datapack/release/current-five-region-source-fan-in.json"), "partial\n");
      }
      if (context.name === "route edge policy sync") await runNationwideCandidateRefreshStep(context);
    },
  }), /전국 후보 갱신 실패 \(route edge policy sync\): ITX topology source artifact is expired/);
  assert.deepEqual(steps, STEPS);
  const after = await Promise.all(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.map((relative) => readFile(path.join(repositoryRoot, relative))));
  NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.forEach((relative, index) => assert.deepEqual(after[index], before[index], relative));
});

test("#866 F1 벽시계가 ITX freshUntil 이후여도 후보 시계가 신선하면 정책 단계는 후보 시계로 판정해 성공한다", async (t) => {
  const repositoryRoot = await copiedRepository(t);
  const freshUntil = await itxFreshUntilMillis();
  const fanIn = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/current-five-region-source-fan-in.json")));
  assert.ok(Date.parse(fanIn.evaluatedAt) < freshUntil, "committed candidate clock must precede ITX freshUntil");
  const request = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/release-request.json")));
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json")));
  // 벽시계는 freshUntil 이후(만료)다. 벽시계로 판정하면 expired로 실패해 이 테스트가 실패한다.
  await withWallClock(t, new Date(freshUntil + DAY_MS).toISOString());
  await refreshNationwideCandidate({
    repositoryRoot,
    evaluatedAt: fanIn.evaluatedAt,
    releaseSequence: buildSpec.releaseSequence,
    requestedBy: request.requestedBy,
    approvedBy: request.approvedBy,
    assertCleanWorktree: async () => {},
    runStep: async (context) => {
      if (context.name === "route edge policy sync") await runNationwideCandidateRefreshStep(context);
    },
  });
  assert.deepEqual(await readFile(path.join(repositoryRoot, ROUTE_EDGE_POLICY)), await readFile(path.join(root, ROUTE_EDGE_POLICY)));
});

// #866 PR-C: 후보 재생성(새 후보 id·새 build spec bytes)이 갱신 연쇄 밖의 재결속 게이트에 걸리지 않아야 한다.
// 갱신은 NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS 전체를 다시 쓴다. 그러므로 출력 밖의 커밋 JSON이 현재 후보 id나
// 출력 파일의 sha256을 담고 있으면, 새 후보로 갱신한 순간 그 파일이 stale 결속이 된다(예전 수도권 live chain
// fan-in과 수도권 accessibility 입력 사본이 그랬다). 출력 밖 결속이 0이어야 한다.
function listJsonFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) listJsonFiles(absolute, files);
    else if (entry.name.endsWith(".json")) files.push(absolute);
  }
  return files;
}

function candidateIdentityBindersOutsideRefresh(repositoryRoot) {
  const outputs = new Set(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS);
  const buildSpec = JSON.parse(readFileSync(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  const tokens = [
    [buildSpec.candidateId, "candidateId"],
    ...NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.map((relative) => [
      sha256(readFileSync(path.join(repositoryRoot, relative))), `sha256(${relative})`,
    ]),
  ];
  const binders = [];
  for (const absolute of ["tools", "release"].flatMap((scanRoot) => listJsonFiles(path.join(repositoryRoot, scanRoot)))) {
    const relative = path.relative(repositoryRoot, absolute).split(path.sep).join("/");
    if (outputs.has(relative)) continue;
    const text = readFileSync(absolute, "utf8");
    const hits = tokens.filter(([token]) => text.includes(token)).map(([, label]) => label);
    if (hits.length > 0) binders.push(`${relative}: ${hits.join(", ")}`);
  }
  return binders.sort();
}

test("#866 PR-C 현재 후보 식별을 결속한 커밋 JSON은 전국 후보 갱신 출력뿐이다(새 후보 id로 재생성해도 다른 재결속 게이트가 없다)", () => {
  assert.deepEqual(candidateIdentityBindersOutsideRefresh(root), []);
});

test("#866 PR-C 후보 식별 결속 검사기는 출력 밖에 심은 결속을 잡는다", async (t) => {
  const repositoryRoot = await copiedRepository(t);
  assert.deepEqual(candidateIdentityBindersOutsideRefresh(repositoryRoot), []);
  const buildSpecBytes = await readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"));
  const buildSpec = JSON.parse(buildSpecBytes);
  await mkdir(path.join(repositoryRoot, "tools/datapack/release/stale"), { recursive: true });
  await writeFile(path.join(repositoryRoot, "tools/datapack/release/stale/fan-in.json"),
    jsonBytes({ candidateBuildSpec: { sha256: sha256(buildSpecBytes) } }));
  await writeFile(path.join(repositoryRoot, "release/stale-input.json"), jsonBytes({ candidate: { candidateId: buildSpec.candidateId } }));
  assert.deepEqual(candidateIdentityBindersOutsideRefresh(repositoryRoot), [
    "release/stale-input.json: candidateId",
    "tools/datapack/release/stale/fan-in.json: sha256(tools/datapack/release/candidate-build-spec.json)",
  ]);
});

// #866 PR-C에서 수도권 live chain과 함께 환승 재결속 명령이 지워져 전국 발행 PR이 막혔다(#892).
// 일일 갱신의 activate 단계는 수도권 정본 팩을 다시 쓰므로, 전국 후보 갱신 전에 서울 환승 증거를 새 팩에
// 다시 묶는 명령이 있어야 한다. 그 명령(과 그 테스트)이 다시 지워지면 이 테스트가 실패한다.
// 이 테스트는 재결속 명령의 존재·동작과 출력 경계만 증명한다. 전국 후보 갱신은 호출하지 않는다. 지금은 workflow가
// 이 명령을 부르지 않으므로 activate 뒤 운영자가 실행한다(자동화는 #870 항목).
test("#866 일일 정본 팩 변경으로 풀린 서울 환승 증거 결속을 다시 묶는 명령이 있고 그 출력은 전국 후보 갱신 출력과 겹치지 않는다", async (t) => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "nationwide-seoul-transfer-rebind-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const fixture = await writeSeoulTransferRebindRepository(repositoryRoot);
  const packBytes = await rewriteSeoulTransferFixtureCanonicalPack(repositoryRoot, (pack) => { pack.manifest.keyId = "daily-activate"; });
  const regenerate = async () => {
    const metricsBytes = await readFile(path.join(repositoryRoot, SEOUL_TRANSFER_REBIND_PATHS.metrics));
    return buildApplicability({ canonicalPack: JSON.parse(packBytes), canonicalPackBytes: packBytes, transferTopologyMetrics: JSON.parse(metricsBytes), metricsBytes });
  };
  await assert.rejects(regenerate(), /NO_GO canonical identity mismatch/);
  const result = await rebindCurrentSeoulTransferSourceAdmission({
    repositoryRoot,
    env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: SEOUL_TRANSFER_REBIND_PAR_BASE_URL },
    now: new Date("2026-10-02T09:00:00.000Z"),
    client: { async readObject(key) { assert.equal(key, fixture.receipt.objectKey); return { exists: true, body: fixture.rawBytes }; } },
  });
  assert.equal(result.changed, true);
  assert.equal(result.canonicalPackSha256, sha256(packBytes));
  assert.deepEqual(await regenerate(), JSON.parse(await readFile(path.join(repositoryRoot, SEOUL_TRANSFER_REBIND_PATHS.applicability))));
  // 재결속은 후보 spec·request·hash를 쓰지 않는다. 그것들은 이 명령(refresh-nationwide-candidate)의 출력이다.
  assert.equal(result.targets.some((relative) => NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS.includes(relative)), false);
});
