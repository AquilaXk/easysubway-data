import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";
import { candidatePinnedReader } from "./test-fixtures/candidate-pinned-inputs.mjs";
import { eventBaseSha, prBaseCanonicalPackReader, priorCanonicalPackBytes, runBaseSha } from "./test-fixtures/pr-base-pack.mjs";
import { CANONICAL_PACK_PATH, recordedTrees, replayMutations, runsOf } from "./test-fixtures/refresh-recorded-runs.mjs";
import {
  validateProductionTransferArtifacts,
  validateTransferAdmissionEvidence,
} from "./validate-source-inventory.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";

test("active Seoul TRANSFER source handoff는 exact current identity와 production artifact binding을 요구한다", async () => {
  const input = await activeTransferInputs();

  assert.doesNotThrow(() => validateTransferAdmissionEvidence(input.source));
  await assert.doesNotReject(validateProductionTransferArtifacts(input.inventory, {
    repositoryRoot: REPOSITORY_ROOT,
  }));

  assert.equal(input.candidate.sourceSnapshots.find(({ sourceId }) => sourceId === TRANSFER_SOURCE_ID)?.sourceId, TRANSFER_SOURCE_ID);
  assert.equal(input.source.requiredForProductionPack, true);
  assert.equal(input.candidate.sourceSnapshots.some(({ sourceId }) =>
    sourceId === "molit-railway-transfer-movement"), false);
  assert.equal(input.inventory.sources.some(({ id, requiredForProductionPack }) =>
    id === "molit-railway-transfer-movement" && requiredForProductionPack === true), false);
});

test("active Seoul TRANSFER metrics와 applicability는 current pre-candidate contract를 재생성한다", async () => {
  const input = await activeTransferInputs();
  const regenerated = buildApplicability({
    canonicalPack: input.canonicalPack,
    canonicalPackBytes: input.canonicalPackBytes,
    transferTopologyMetrics: input.metrics,
    metricsBytes: input.metricsBytes,
  });

  assert.deepEqual(regenerated, input.applicability);
  assert.equal(regenerated.artifactKind, "current-capital-transfer-topology-applicability-pre-candidate");
  assert.equal(regenerated.productionUseAllowed, false);
  assert.equal(regenerated.candidateBinding, null);
  // #872 S2: 분모는 서울교통공사 1~8호선과 상대 노선 19개의 역-노선 전체다.
  assert.equal(regenerated.cells.length, 698);
  assert.deepEqual(regenerated.stateSummary, {
    APPLICABLE_TRANSFER_ENDPOINT: 160,
    NOT_APPLICABLE_IN_CANONICAL_PAIR_SET: 538,
  });
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// #1038: applicability는 pack과 지표에서 다시 만들 수 있어야 한다. 어떤 pack·지표에서 만들었는지는 applicability가 스스로 선언한다.
// 원천 갱신 PR은 pack만 바꾸므로 applicability가 후보가 고정한 옛 pack·지표를 선언하고, 재결속 PR은 pack·지표·applicability를 함께 새 바이트로
// 다시 쓰므로 작업 트리 바이트를 선언한다(#954: 둘을 섞지 않는다). 선언한 sha와 맞는 바이트를 고르고, 어느 쪽과도 맞지 않으면 실패한다.
// #1067: 수도권 topology 갱신 PR은 pack의 출처 표식만 바꾸고 applicability는 마지막 파생 재결속의 pack(= PR base)을 선언한다.
// 작업 트리·고정 입력이 모두 맞지 않을 때만 readBase로 PR base 바이트를 읽는다. readBase는 base->head 차이가 출처 표식뿐일 때만 바이트를 주고,
// 아니면 던지고, base를 알 수 없으면 null이다. 일반 PR은 앞의 두 곳에서 끝나 base를 읽지 않는다.
async function declaredBytes({ label, relative, readPinned, workingTree, matches, readBase = async () => null }) {
  for (const read of [() => workingTree(relative), () => readPinned(relative)]) {
    const bytes = await read();
    if (matches(bytes)) return bytes;
  }
  let baseNote = "PR base를 알 수 없다";
  const base = await readBase().catch((error) => { baseNote = error.message; return null; });
  if (base !== null) {
    if (matches(base)) return base;
    baseNote = "PR base 바이트도 선언과 다르다";
  }
  throw new assert.AssertionError({ message: `applicability가 선언한 ${label}와 맞는 바이트가 후보 고정 입력에도 작업 트리에도 없다: ${relative} (${baseNote})` });
}

test("#1038 applicability가 선언한 바이트는 작업 트리 또는 후보 고정 입력에서 고르고, 어느 쪽과도 맞지 않으면 실패한다", async () => {
  const working = Buffer.from("working");
  const pinned = Buffer.from("pinned");
  const pick = (target, calls = []) => declaredBytes({
    label: "fixture", relative: "x.json",
    readPinned: async () => { calls.push("pinned"); return pinned; },
    workingTree: async () => { calls.push("working"); return working; },
    matches: (bytes) => sha256(bytes) === sha256(target),
  });
  const workingCalls = [];
  assert.deepEqual(await pick(working, workingCalls), working);
  assert.deepEqual(workingCalls, ["working"], "재결속 PR: 작업 트리 바이트가 선언과 맞으면 고정 입력을 받지 않는다");
  const pinnedCalls = [];
  assert.deepEqual(await pick(pinned, pinnedCalls), pinned);
  assert.deepEqual(pinnedCalls, ["working", "pinned"], "원천 갱신 PR: 작업 트리가 다르면 후보 고정 바이트를 쓴다");
  await assert.rejects(pick(Buffer.from("other")), /applicability가 선언한 fixture와 맞는 바이트가 후보 고정 입력에도 작업 트리에도 없다/u);
});

test("#1067 갱신 PR: 작업 트리·고정 입력이 모두 선언과 다르면 PR base 바이트를 읽는다(앞의 두 곳이 맞으면 읽지 않는다)", async () => {
  const [working, pinned, prior] = ["working", "pinned", "prior"].map((text) => Buffer.from(text));
  const calls = [];
  const pick = (target, readBase) => declaredBytes({
    label: "fixture", relative: "x.json",
    workingTree: async () => { calls.push("working"); return working; },
    readPinned: async () => { calls.push("pinned"); return pinned; },
    matches: (bytes) => sha256(bytes) === sha256(target),
    ...(readBase === undefined ? {} : { readBase }),
  });
  const readBase = async () => { calls.push("base"); return prior; };
  assert.deepEqual(await pick(prior, readBase), prior);
  assert.deepEqual(calls.splice(0), ["working", "pinned", "base"]);
  assert.deepEqual(await pick(working, readBase), working);
  assert.deepEqual(calls.splice(0), ["working"], "작업 트리가 맞으면 base를 읽지 않는다");
  assert.deepEqual(await pick(pinned, readBase), pinned);
  assert.deepEqual(calls.splice(0), ["working", "pinned"], "고정 입력이 맞으면 base를 읽지 않는다");
  await assert.rejects(pick(Buffer.from("other"), readBase), /PR base 바이트도 선언과 다르다/u);
  await assert.rejects(pick(prior), /PR base를 알 수 없다/u, "base 읽기가 없으면 실패한다");
  await assert.rejects(pick(prior, async () => null), /PR base를 알 수 없다/u, "base를 알 수 없으면 실패한다");
  await assert.rejects(pick(prior, async () => { throw new Error("출처 표식 밖이 바뀌었다"); }), /출처 표식 밖이 바뀌었다/u, "base 읽기가 거부하면 사유와 함께 실패한다");
});

const [topologyRun] = runsOf("capital-topology-refresh");
const BASE_SHA = topologyRun.baseSha;
function prFiles(mutations = {}, { readBaseSha = BASE_SHA } = {}) {
  const trees = recordedTrees(topologyRun, mutations);
  return {
    files: {
      readTree: async (relative) => { if (!trees.head.has(relative)) throw new Error(`head에 없는 파일: ${relative}`); return trees.head.get(relative); },
      readBase: async (sha, relative) => {
        assert.equal(sha, readBaseSha);
        if (!trees.base.has(relative)) throw new Error(`base에 없는 파일: ${relative}`);
        return trees.base.get(relative);
      },
    },
    trees,
  };
}

test("#1067 PR base의 pack은 base->head 차이가 출처 표식뿐일 때만 선언된 갱신 전 pack으로 받는다", async () => {
  for (const mutations of [{}, replayMutations()]) {
    const { files, trees } = prFiles(mutations);
    const bytes = await priorCanonicalPackBytes({ baseSha: BASE_SHA, files });
    assert.equal(bytes.toString("utf8"), trees.base.get(CANONICAL_PACK_PATH), "base 바이트 그대로");
    assert.notEqual(sha256(bytes), sha256(trees.head.get(CANONICAL_PACK_PATH)), "갱신 PR의 head pack은 base와 다르다");
    // 실제 helper 경로: 작업 트리(head)·고정 입력(옛 후보 pack)이 선언과 다르고 base만 맞는다.
    const declared = sha256(bytes);
    const picked = await declaredBytes({
      label: "canonical pack sha256", relative: CANONICAL_PACK_PATH,
      workingTree: async () => Buffer.from(trees.head.get(CANONICAL_PACK_PATH)), readPinned: async () => Buffer.from("candidate-pinned"),
      readBase: async () => bytes, matches: (candidate) => sha256(candidate) === declared,
    });
    assert.equal(sha256(picked), declared);
  }
});

test("#1067 반증: 출처 표식 밖(값·키·계보)이 바뀐 pack은 PR base를 선언된 pack으로 받지 않는다", async () => {
  const cases = {
    "접근성 값 하나 변경": replayMutations({ canonical: (pack) => { pack.packs[0].facilities[0].status = "AVAILABLE"; } }),
    "표식 값이 원장 계보 밖": replayMutations({ canonical: (pack) => { pack.packs[0].stationFacilityEvidence.find((row) => row.sourceId === "kric-station-convenience-standard").sourceSnapshotId = "kric-station-convenience-standard-20990101T000000000Z"; } }),
    "새 키 추가": { mutatePack: (pack) => { pack.packs[0].stations[0].extra = true; } },
    "배열 길이 변경": { mutatePack: (pack) => { pack.packs[0].networkEdges.pop(); } },
  };
  for (const [label, mutations] of Object.entries(cases)) {
    const { files } = prFiles(mutations);
    await assert.rejects(priorCanonicalPackBytes({ baseSha: BASE_SHA, files }), /출처 표식 밖이 바뀌었다/u, label);
  }
  const { files } = prFiles({ mutateFiles: (_head, base) => { base.delete(CANONICAL_PACK_PATH); } });
  await assert.rejects(priorCanonicalPackBytes({ baseSha: BASE_SHA, files }), /비교하지 못했다/u, "base에 pack이 없으면 실패한다");
});

test("#1067 base 커밋은 CI 이벤트에서만 정한다(pull_request는 base.sha, push는 before, 그 밖은 없음)", async () => {
  const sha = "a".repeat(40);
  assert.equal(eventBaseSha({ pull_request: { base: { sha } } }), sha);
  assert.equal(eventBaseSha({ before: sha }), sha, "push");
  assert.equal(eventBaseSha({ before: "0".repeat(40) }), null, "새 브랜치 push");
  assert.equal(eventBaseSha({ pull_request: { base: { sha: "main" } } }), null, "sha가 아님");
  assert.equal(eventBaseSha({ pull_request: {}, before: sha }), null, "pull_request 이벤트는 before를 보지 않는다");
  assert.equal(eventBaseSha({}), null);
  assert.equal(await runBaseSha({ env: {} }), null, "이벤트가 없는 로컬 실행");
  assert.equal(await runBaseSha({ env: { GITHUB_EVENT_PATH: "/event.json" }, readText: async () => JSON.stringify({ pull_request: { base: { sha } } }) }), sha);
  await assert.rejects(runBaseSha({ env: { GITHUB_EVENT_PATH: "/event.json" }, readText: async () => "{ not json" }), "읽은 이벤트가 깨졌으면 숨기지 않고 던진다");
  assert.equal(await prBaseCanonicalPackReader({ env: {} })(), null, "base를 알 수 없으면 null");
});

test("#1067 prBaseCanonicalPackReader는 이벤트 파일의 base 커밋에서 갱신 전 pack을 읽는다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pr-base-event-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, "event.json");
  await writeFile(eventPath, JSON.stringify({ pull_request: { base: { sha: BASE_SHA } } }));
  const { files, trees } = prFiles();
  const bytes = await prBaseCanonicalPackReader({ env: { GITHUB_EVENT_PATH: eventPath }, files })();
  assert.equal(bytes.toString("utf8"), trees.base.get(CANONICAL_PACK_PATH));
  const other = prFiles({}, { readBaseSha: "b".repeat(40) });
  await writeFile(eventPath, JSON.stringify({ pull_request: { base: { sha: BASE_SHA } } }));
  await assert.rejects(prBaseCanonicalPackReader({ env: { GITHUB_EVENT_PATH: eventPath }, files: other.files })(), /비교하지 못했다/u, "다른 커밋의 base는 읽지 못해 실패한다");
});

async function activeTransferInputs() {
  const workingTree = (relative) => readFile(new URL(`../../${relative}`, import.meta.url));
  const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
  const readPinned = await candidatePinnedReader();
  const [candidate, inventory, snapshots, applicability] = await Promise.all([
    readJson("./release/candidate-build-spec.json"),
    readJson("./source-inventory.json"),
    readJson("./release/source-snapshots.json"),
    readJson("./release/current-capital-transfer-topology-applicability.json"),
  ]);
  const canonicalPackBytes = await declaredBytes({
    label: "canonical pack sha256", relative: "tools/datapack/release/capital-production-canonical-pack.json", readPinned, workingTree,
    readBase: prBaseCanonicalPackReader(),
    matches: (bytes) => sha256(bytes) === applicability.canonicalIdentity?.canonicalPackSha256,
  });
  const metricsBytes = await declaredBytes({
    label: "transfer topology metrics artifactSha256", relative: "tools/datapack/release/current-transfer-topology-metrics.json", readPinned, workingTree,
    matches: (bytes) => JSON.parse(bytes).artifactSha256 === applicability.transferTopologyMetricsIdentity?.artifactSha256,
  });
  const canonicalPack = JSON.parse(canonicalPackBytes);
  const metrics = JSON.parse(metricsBytes);
  const projection = candidate.sourceSnapshots?.find(({ sourceId }) => sourceId === TRANSFER_SOURCE_ID);
  const snapshot = snapshots.find(({ snapshotId }) => snapshotId === projection?.snapshotId);
  const source = inventory.sources?.find(({ id }) => id === TRANSFER_SOURCE_ID);
  assert.ok(projection && snapshot && source, "active Seoul TRANSFER handoff is required");
  return {
    candidate,
    inventory,
    snapshots,
    canonicalPack,
    canonicalPackBytes,
    metrics,
    metricsBytes,
    applicability,
    source,
    snapshot,
  };
}
