import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { INVENTORY_PATH, LEDGER_PATH, PACK_STAMP_KEYS, POLICY, RECORDED, buildCapitalSnapshot, packSourcesOf, filenames, recordedTrees, runsOf, sha256, sourceInputOf } from "../datapack/test-fixtures/refresh-recorded-runs.mjs";

import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";
import {
  REFRESH_STAGES,
  REFRESH_STAGE_IDS,
  evaluateRefreshStage,
  isRefreshStage,
  refreshFileViolation,
  refreshPathShapeViolation,
} from "./refresh-stage-contracts.mjs";
import { evaluateLedgerChange } from "./source-ledger-gate.mjs";

// #1012: 정기 갱신 4종의 자동 병합 정책 계약. 경로 allowlist·소유 항목·소유 필드의 ground truth는 기록된 실제 갱신 PR 헤드다.
// fixture(refresh-recorded-runs.json)는 PR #937·#965·#1003·#1009·#1010·#1011의 base·head를 git show로 읽은 변경 파일 목록, 원장 행, inventory 항목의 바뀐 필드다.
// 이전 세대 PR(#644·#651·#667·#671·#708·#713)은 후보 spec·hash evidence를 같이 바꾸던 #862 결정 C 이전 산출물이라 기준으로 삼지 않는다.
const GOVERNANCE_PATH = "tools/datapack/source-governance-policy.json";
const SLA_PATH = "release/product-gates/datapack-freshness-sla.json";
const STAGES = ["gwangju-timetable-refresh", "capital-topology-refresh", "kric-facility-refresh", "seoul-accessibility-refresh"];


test("계약 표: 단계 네 개가 각자 workflow·claim 접두사·증거 단계 id·원장 방식을 가진다", () => {
  assert.deepEqual([...REFRESH_STAGE_IDS], STAGES);
  for (const stage of STAGES) {
    assert.equal(isRefreshStage(stage), true, stage);
    assert.ok(Object.hasOwn(REFRESH_CLAIM_PREFIXES, REFRESH_STAGES[stage].workflow), `${stage}: workflow의 claim 접두사가 있다`);
    assert.equal(REFRESH_STAGES[stage].stepId, stage, `${stage}: 증거 step id는 단계 id와 같다`);
  }
  assert.deepEqual(STAGES.map((stage) => REFRESH_STAGES[stage].workflow), [
    "retained-gwangju-timetable-refresh.yml", "current-capital-topology-refresh.yml", "kric-current-facility-refresh.yml", "seoul-current-accessibility-refresh.yml",
  ]);
  assert.deepEqual(STAGES.map((stage) => REFRESH_STAGES[stage].ledger), ["append", "unchanged", "append", "append"]);
  assert.deepEqual(STAGES.map((stage) => REFRESH_STAGES[stage].expectedSourceIds), [
    ["kric-nationwide-timetable-file"],
    ["capital-route-topology", "incheon-line1-train-timetable", "incheon-line2-train-timetable", "incheon-transit-station-info"],
    ["kric-station-convenience-standard"],
    ["seoul-metro-accessibility"],
  ]);
  for (const other of ["registration", "derivative-rebinding", "candidate-refresh", "itx-promotion", "source-reverification", "", undefined, null]) assert.equal(isRefreshStage(other), false, String(other));
  assert.throws(() => { REFRESH_STAGES["seoul-accessibility-refresh"].ledger = "unchanged"; }, TypeError, "표는 동결돼 있다");
});

test("기록된 실제 갱신 PR 여섯 건이 단계마다 있고 경로 검사를 통과한다", () => {
  assert.deepEqual(RECORDED.map(({ label }) => label), ["#965", "#1003", "#937", "#1011", "#1010", "#1009"]);
  for (const run of RECORDED) {
    assert.equal(refreshFileViolation(run.stage, run.files), null, run.label);
    assert.equal(refreshPathShapeViolation(run.stage, filenames(run)), null, run.label);
  }
});

// 소유 항목·필드 표는 기록된 실행이 실제로 바꾼 것과 정확히 같다. 하나라도 어긋나면(표가 넓거나 좁으면) 실패한다.
test("소유 inventory 항목과 필드 표는 기록된 실제 실행이 바꾼 항목·필드와 정확히 같다", () => {
  for (const stage of STAGES) {
    const owned = REFRESH_STAGES[stage].owned;
    for (const run of runsOf(stage)) {
      const recorded = Object.fromEntries(run.inventory.changed.map((entry) => [entry.id, entry.changedFields]));
      assert.deepEqual(Object.keys(owned).sort(), Object.keys(recorded).sort(), `${run.label}: 소유 항목`);
      for (const [id, fields] of Object.entries(recorded)) assert.deepEqual([...owned[id]].sort(), fields, `${run.label}: ${id} 소유 필드`);
    }
  }
  assert.equal(Object.keys(REFRESH_STAGES["capital-topology-refresh"].owned).length, 19);
  assert.deepEqual(REFRESH_STAGES["seoul-accessibility-refresh"].owned, { "seoul-metro-accessibility": ["observedDataUpdatedAt", "retrievedAt", "accessibilityAdmissionEvidence"] });
  assert.deepEqual(REFRESH_STAGES["kric-facility-refresh"].owned, { "kric-station-convenience-standard": ["observedDataUpdatedAt", "retrievedAt", "admissionEvidence", "accessibilityAdmissionEvidence"] });
  assert.deepEqual(REFRESH_STAGES["gwangju-timetable-refresh"].owned, { "kric-nationwide-timetable-file": ["retrievedAt", "retainedScheduleAdmissionEvidence"] });
});

test("단계별 경로 allowlist: .github·tools 코드·governance·SLA·후보 산출물은 어떤 단계도 허용하지 않는다", () => {
  const denied = [
    ".github/workflows/ci.yml", "tools/ci/automation-pr-policy.mjs", "tools/datapack/build-datapack.mjs", GOVERNANCE_PATH, SLA_PATH,
    "tools/ci/source-ledger-change-policy.json", "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json",
    "tools/datapack/sources/some-other-source-20261007.json", "README.md", "contracts/documentation/documentation-fragment.json",
  ];
  for (const run of RECORDED) {
    for (const extra of denied) {
      assert.notEqual(refreshPathShapeViolation(run.stage, [...filenames(run), extra].sort()), null, `${run.label} + ${extra}`);
      assert.notEqual(refreshFileViolation(run.stage, [...run.files, { filename: extra, status: "modified" }]), null, `${run.label} + ${extra}`);
      assert.notEqual(refreshFileViolation(run.stage, [...run.files, { filename: extra, status: "added" }]), null, `${run.label} + ${extra} (added)`);
    }
  }
  // 한 단계의 경로가 다른 단계에서는 허용되지 않는다.
  for (const run of RECORDED) {
    for (const other of STAGES.filter((stage) => stage !== run.stage)) assert.notEqual(refreshPathShapeViolation(other, filenames(run)), null, `${run.label} as ${other}`);
  }
});

test("반증: 경로 상태(added·modified)가 규칙과 다르거나 이름 변경·삭제이면 막는다", () => {
  for (const run of RECORDED) {
    for (const [index, entry] of run.files.entries()) {
      const flipped = entry.status === "added" ? "modified" : "added";
      const mutated = run.files.map((item, at) => (at === index ? { ...item, status: flipped } : item));
      assert.match(refreshFileViolation(run.stage, mutated), /변경 종류/u, `${run.label} ${entry.filename} -> ${flipped}`);
      for (const status of ["removed", "renamed", "copied", "changed", undefined]) {
        assert.notEqual(refreshFileViolation(run.stage, run.files.map((item, at) => (at === index ? { ...item, status } : item))), null, `${run.label} ${entry.filename} -> ${String(status)}`);
      }
      assert.notEqual(refreshFileViolation(run.stage, run.files.map((item, at) => (at === index ? { ...item, previous_filename: "tools/datapack/sources/old.json" } : item))), null, `${run.label} ${entry.filename} previous_filename`);
      assert.notEqual(refreshFileViolation(run.stage, run.files.filter((_, at) => at !== index)), null, `${run.label} ${entry.filename} 빠짐`);
    }
    assert.notEqual(refreshFileViolation(run.stage, [...run.files, run.files[0]]), null, `${run.label}: 같은 경로 중복`);
    assert.notEqual(refreshFileViolation(run.stage, []), null, `${run.label}: 빈 목록`);
  }
  for (const bad of [null, undefined, "x", [null], [{ filename: 3, status: "added" }], [{ status: "added" }]]) assert.notEqual(refreshFileViolation("seoul-accessibility-refresh", bad), null, JSON.stringify(bad));
});

test("반증: 수도권 topology 단계는 날짜 표식이 서로 맞지 않거나 새 파일이 둘이면 막는다", () => {
  const [run] = runsOf("capital-topology-refresh");
  const paths = filenames(run);
  const reverification = paths.find((entry) => entry.includes("capital-topology-reverification-"));
  assert.notEqual(refreshPathShapeViolation(run.stage, paths.map((entry) => (entry === reverification ? entry.replace(/\d{8}\.json$/u, "20990101.json") : entry)).sort()), null, "재검증 기록의 날짜가 topology와 다르다");
  assert.notEqual(refreshPathShapeViolation(run.stage, [...paths, "tools/datapack/sources/capital-route-topology-20990101.json"].sort()), null, "topology 파일이 둘");
  assert.notEqual(refreshPathShapeViolation(run.stage, [...paths, "tools/datapack/itx-current-network-edge-admission-20261007.json"].sort()), null, "ITX 입력은 관측된 적 없어 허용하지 않는다");
  assert.notEqual(refreshPathShapeViolation(run.stage, [...paths, "tools/datapack/release/capital-production-reviewed-pack.json"].sort()), null, "reviewed pack은 관측된 적 없어 허용하지 않는다");
});

// ---------------------------------------------------------------------------
// 게이트 재계산: 기록된 실제 실행에서 base·head 트리를 합성해 evaluateRefreshStage에 넘긴다.
// ---------------------------------------------------------------------------
function filesOf(run, trees) {
  return {
    readTree: async (relative) => {
      if (!trees.head.has(relative)) throw new Error(`head에 없는 파일: ${relative}`);
      return trees.head.get(relative);
    },
    readBase: async (sha, relative) => {
      assert.equal(sha, run.baseSha);
      if (!trees.base.has(relative)) throw new Error(`base에 없는 파일: ${relative}`);
      return trees.base.get(relative);
    },
  };
}

async function evaluate(run, mutations = {}, { paths = filenames(run), policy = POLICY } = {}) {
  return evaluateRefreshStage({ stage: run.stage, paths, baseSha: run.baseSha, policy, files: filesOf(run, recordedTrees(run, mutations)) });
}

const codes = (result) => result.violations.map(({ code }) => code);

test("기록된 실제 갱신 PR 여섯 건은 게이트 재계산을 위반 없이 통과하고 원천 행이 나온다", async () => {
  for (const run of RECORDED) {
    const result = await evaluate(run);
    assert.deepEqual(result.violations, [], run.label);
    assert.deepEqual(result.rows.map(({ sourceId }) => sourceId), REFRESH_STAGES[run.stage].expectedSourceIds, `${run.label}: 원천 행`);
    for (const row of result.rows) {
      assert.match(row.rawSha256, /^[0-9a-f]{64}$/u, `${run.label} ${row.sourceId}`);
      assert.match(row.contentSha256, /^[0-9a-f]{64}$/u, `${run.label} ${row.sourceId}`);
      assert.ok(Number.isSafeInteger(row.rowDelta) && Number.isSafeInteger(row.coverageDelta), `${run.label} ${row.sourceId}`);
    }
  }
});

test("원장 방식 단계의 원천 행은 원장 게이트(evaluateLedgerChange)가 만든 행과 정확히 같다", async () => {
  for (const run of RECORDED.filter(({ stage }) => REFRESH_STAGES[stage].ledger === "append")) {
    const expected = evaluateLedgerChange({ baseLedger: run.ledger.base, headLedger: run.ledger.head, policy: POLICY }).sources;
    assert.deepEqual((await evaluate(run)).rows, expected, run.label);
  }
});

test("수도권 topology 단계의 원천 행은 직전 현재 snapshot과 비교한 변화와 증거 sha를 담는다", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    const { rows, violations } = await evaluate(run);
    assert.deepEqual(violations, [], run.label);
    const snapshot = buildCapitalSnapshot();
    const capitalText = JSON.stringify(snapshot);
    assert.deepEqual(rows.find(({ sourceId }) => sourceId === "capital-route-topology"), {
      sourceId: "capital-route-topology", snapshotId: run.capital.head.path.split("/").pop().replace(/\.json$/u, ""), previousSnapshotId: run.capital.previous.snapshotId,
      rawSha256: sha256(capitalText), contentSha256: snapshot.contentSha256, rowDelta: 0, coverageDelta: 0, diffStatus: "NO_CHANGE",
    }, `${run.label}: capital`);
    const station = rows.find(({ sourceId }) => sourceId === "incheon-transit-station-info");
    const stationEvidence = run.inventory.changed.find(({ id }) => id === "incheon-transit-station-info").after.topologyAdmissionEvidence;
    assert.equal(station.snapshotId, stationEvidence.snapshotId, run.label);
    assert.equal(station.rawSha256, stationEvidence.rawSha256, run.label);
    assert.equal(station.contentSha256, stationEvidence.contentSha256, run.label);
    assert.deepEqual([station.rowDelta, station.coverageDelta, station.diffStatus], [0, 0, "NO_CHANGE"], run.label);
  }
});

test("반증: 허용 목록 밖 경로(추가 경로)가 주장되면 게이트가 아니라 경로 계약에서 막힌다", () => {
  for (const run of RECORDED) {
    assert.notEqual(refreshPathShapeViolation(run.stage, [...filenames(run), GOVERNANCE_PATH].sort()), null, run.label);
  }
});

test("반증: 정책성 inventory 필드(소유 항목의 productionUseAllowed·datasetUrl·license·updateFrequency)를 바꾸면 INVENTORY_GATE", async () => {
  for (const run of RECORDED) {
    const owned = run.inventory.changed[0].id;
    const mutations = {
      productionUseAllowed: (entry) => { entry.productionUseAllowed = !entry.productionUseAllowed; },
      datasetUrl: (entry) => { entry.datasetUrl = "https://evil.test/data"; },
      license: (entry) => { entry.license = { type: "OTHER" }; },
      updateFrequency: (entry) => { entry.updateFrequency = "never"; },
    };
    for (const [field, mutate] of Object.entries(mutations)) {
      const result = await evaluate(run, { mutateInventory: (inventory) => mutate(inventory.sources.find(({ id }) => id === owned)) });
      assert.ok(codes(result).includes("INVENTORY_GATE"), `${run.label} ${field}`);
      assert.match(result.violations.find(({ code }) => code === "INVENTORY_GATE").detail, new RegExp(`${owned}: fields outside the recipe's refresh set changed: .*${field}`, "u"), `${run.label} ${field}`);
    }
  }
});

test("반증: 소유하지 않은 inventory 항목을 바꾸거나 더하거나 지우면 INVENTORY_GATE", async () => {
  for (const run of RECORDED) {
    const unowned = run.inventory.unownedEntryIds[0];
    const changed = await evaluate(run, { mutateInventory: (inventory) => { inventory.sources.find(({ id }) => id === unowned).datasetUrl = "https://evil.test/x"; } });
    assert.match(changed.violations.find(({ code }) => code === "INVENTORY_GATE").detail, new RegExp(`${unowned}: .*not owned`, "u"), `${run.label}: 소유 밖 항목 변경`);
    const added = await evaluate(run, { mutateInventory: (inventory) => { inventory.sources.push({ id: "brand-new-source" }); } });
    assert.match(added.violations.find(({ code }) => code === "INVENTORY_GATE").detail, /brand-new-source: the inventory entry was added/u, `${run.label}: 항목 추가`);
    const removed = await evaluate(run, { mutateInventory: (inventory) => { inventory.sources = inventory.sources.filter(({ id }) => id !== unowned); } });
    assert.match(removed.violations.find(({ code }) => code === "INVENTORY_GATE").detail, new RegExp(`${unowned}: the inventory entry was removed`, "u"), `${run.label}: 항목 삭제`);
    const top = await evaluate(run, { mutateInventory: (inventory) => { inventory.schemaVersion = 99; inventory.extraTopLevel = true; } });
    assert.match(top.violations.find(({ code }) => code === "INVENTORY_GATE").detail, /top-level fields changed/u, `${run.label}: 최상위 필드`);
    const duplicate = await evaluate(run, { mutateInventory: (inventory) => { inventory.sources.push(structuredClone(inventory.sources.find(({ id }) => id === run.inventory.changed[0].id))); } });
    assert.ok(codes(duplicate).includes("INVENTORY_GATE"), `${run.label}: 소유 항목 중복`);
  }
});

test("반증: 원장 방식 단계에서 이미 있던 원장 행을 고치거나 행을 더 올리거나 덜 올리면 LEDGER_GATE", async () => {
  for (const run of RECORDED.filter(({ stage }) => REFRESH_STAGES[stage].ledger === "append")) {
    const identity = await evaluate(run, { mutateLedger: (rows) => { rows[0].rawSha256 = "0".repeat(64); } });
    assert.ok(codes(identity).includes("LEDGER_GATE"), `${run.label}: 원천 식별 변경`);
    const quiet = await evaluate(run, { mutateLedger: (rows) => { rows[0].freshUntil = "2099-01-01T00:00:00.000Z"; } });
    assert.match(quiet.violations.find(({ code }) => code === "LEDGER_GATE").detail, /existing ledger rows must stay byte-identical/u, `${run.label}: 식별 밖 필드도 고정`);
    const extra = await evaluate(run, { mutateLedger: (rows) => { rows.push({ ...rows[1], snapshotId: `${rows[1].snapshotId}-extra`, previousSnapshotId: rows[1].snapshotId }); } });
    assert.ok(codes(extra).includes("LEDGER_GATE") || codes(extra).includes("EVIDENCE_DRIFT"), `${run.label}: 행 추가`);
    assert.notDeepEqual(extra.violations, [], `${run.label}: 행 추가`);
    const none = await evaluate(run, { mutateLedger: (rows) => { rows.pop(); } });
    assert.ok(codes(none).includes("LEDGER_GATE"), `${run.label}: 새 행 없음`);
    const reordered = await evaluate(run, { mutateLedger: (rows) => { rows.reverse(); } });
    assert.ok(codes(reordered).includes("LEDGER_GATE"), `${run.label}: 순서 변경`);
    const otherSource = await evaluate(run, { mutateLedger: (rows) => { rows[1].sourceId = "capital-route-topology"; } });
    assert.notDeepEqual(otherSource.violations, [], `${run.label}: 다른 원천의 행`);
    const drift = await evaluate(run, {}, { policy: { ...POLICY, allowContentChange: false } });
    const contentChanged = run.ledger.head[1].contentSha256 !== run.ledger.head[0].contentSha256;
    assert.equal(codes(drift).includes("LEDGER_GATE"), contentChanged, `${run.label}: 정책이 내용 변경을 막으면 내용이 바뀐 갱신만 SOURCE_SHA_DRIFT`);
  }
});

test("반증: 정책의 변화 한도를 넘는 행 수 변화는 SOURCE_COUNT_DELTA로 막힌다", async () => {
  for (const run of RECORDED.filter(({ stage }) => REFRESH_STAGES[stage].ledger === "append")) {
    const result = await evaluate(run, { mutateLedger: (rows) => { rows[1].rowCount = rows[0].rowCount * 3; rows[1].diffSummary = { ...rows[1].diffSummary, rowDelta: rows[1].rowCount - rows[0].rowCount }; } });
    assert.match(result.violations.map(({ detail }) => detail).join("\n"), /SOURCE_COUNT_DELTA/u, run.label);
  }
});

test("반증: 수도권 topology 단계는 원장이 한 글자라도 바뀌면 LEDGER_GATE, 직전 snapshot 파일이 없으면 막는다", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    const changed = await evaluate(run, { mutateFiles: (head) => { head.set(LEDGER_PATH, JSON.stringify([{ snapshotId: "unrelated", sourceId: "unrelated", extra: true }])); } });
    assert.ok(codes(changed).includes("LEDGER_GATE"), run.label);
    const missingPrevious = await evaluate(run, { mutateFiles: (_head, base) => { base.delete(`tools/datapack/sources/${run.capital.previous.snapshotId}.json`); } });
    assert.ok(codes(missingPrevious).includes("INVENTORY_GATE") || codes(missingPrevious).includes("REFRESH_GATE"), `${run.label}: 직전 snapshot 파일 없음`);
    assert.notDeepEqual(missingPrevious.violations, [], `${run.label}: 직전 snapshot 파일 없음`);
  }
});

test("반증: 수도권 topology 단계의 route-map 항목은 currentTopologyAdmission 밖 필드를 바꿀 수 없다", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    const routeMapId = run.inventory.changed.find(({ routeMap }) => routeMap).id;
    const outside = await evaluate(run, { mutateInventory: (inventory) => { inventory.sources.find(({ id }) => id === routeMapId).routeMapAdmissionEvidence.snapshotSha256 = "0".repeat(64); } });
    assert.match(outside.violations.find(({ code }) => code === "INVENTORY_GATE").detail, /currentTopologyAdmission/u, run.label);
    const inside = await evaluate(run, { mutateInventory: (inventory) => { inventory.sources.find(({ id }) => id === routeMapId).routeMapAdmissionEvidence.currentTopologyAdmission.status = "ADMITTED_BY_HAND"; } });
    assert.match(inside.violations.find(({ code }) => code === "INVENTORY_GATE").detail, /currentTopologyAdmission/u, `${run.label}: 허용 밖 하위 키`);
  }
});

test("반증: 수도권 topology 단계는 route-map 항목들이 가리키는 topology가 새 snapshot과 다르면 REFRESH_GATE", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    const routeMapId = run.inventory.changed.find(({ routeMap }) => routeMap).id;
    const stale = await evaluate(run, { mutateInventory: (inventory) => { inventory.sources.find(({ id }) => id === routeMapId).routeMapAdmissionEvidence.currentTopologyAdmission.topologySnapshotId = run.capital.previous.snapshotId; } });
    assert.ok(codes(stale).includes("REFRESH_GATE"), run.label);
    const station = await evaluate(run, { mutateInventory: (inventory) => { inventory.sources.find(({ id }) => id === "incheon-transit-station-info").topologyAdmissionEvidence.snapshotId = "incheon-transit-station-info-20000101"; } });
    assert.ok(codes(station).includes("REFRESH_GATE"), `${run.label}: 역 정보 증거가 새 파일을 가리키지 않음`);
    const timetable = await evaluate(run, { mutateInventory: (inventory) => { inventory.sources.find(({ id }) => id === "incheon-line1-train-timetable").scheduleAdmissionEvidence.topologySnapshotId = "incheon-transit-station-info-20000101"; } });
    assert.ok(codes(timetable).includes("REFRESH_GATE"), `${run.label}: 시간표 증거가 역 정보 snapshot에 결속되지 않음`);
    const reverification = await evaluate(run, { mutateFiles: (head) => { head.set(run.capital.reverificationPath, JSON.stringify({ candidate: { contentSha256: "0".repeat(64) } })); } });
    assert.ok(codes(reverification).includes("REFRESH_GATE"), `${run.label}: 재검증 기록이 새 topology와 다름`);
    const rawDrift = await evaluate(run, { mutateFiles: (head) => { const [filename] = Object.keys(run.snapshotFiles).filter((entry) => entry.includes("incheon-line1")); head.set(filename, JSON.stringify({ ...run.snapshotFiles[filename], rawSha256: "0".repeat(64) })); } });
    assert.ok(codes(rawDrift).includes("REFRESH_GATE"), `${run.label}: 시간표 파일의 원본 sha가 증거와 다름`);
  }
});

test("반증: 수도권 topology 단계의 간선이 한도를 넘게 줄면 막는다", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    const shrunk = await evaluate(run, { mutateCapitalLines: (lines) => { for (const line of lines) { line.edges = line.edges.slice(0, 1); line.scope = line.scope.slice(0, 2); } } });
    assert.match(shrunk.violations.map(({ detail }) => detail).join("\n"), /SOURCE_COUNT_DELTA/u, run.label);
  }
});

test("반증: Seoul·KRIC 단계는 inventory 증거가 새 snapshot 파일·원장 행과 어긋나면 REFRESH_GATE", async () => {
  for (const run of RECORDED.filter(({ stage }) => ["seoul-accessibility-refresh", "kric-facility-refresh"].includes(stage))) {
    const entryId = run.inventory.changed[0].id;
    const evidenceMutations = {
      snapshotId: (evidence) => { evidence.snapshotId = `${evidence.snapshotId}-x`; },
      snapshotPath: (evidence) => { evidence.snapshotPath = "tools/datapack/sources/other.json"; },
      snapshotFileSha256: (evidence) => { evidence.snapshotFileSha256 = "0".repeat(64); },
      rawSha256: (evidence) => { evidence.rawSha256 = "0".repeat(64); },
      contentSha256: (evidence) => { evidence.contentSha256 = "0".repeat(64); },
      capturedAt: (evidence) => { evidence.capturedAt = "2000-01-01T00:00:00.000Z"; },
    };
    for (const [field, mutate] of Object.entries(evidenceMutations)) {
      const result = await evaluate(run, { mutateInventory: (inventory) => mutate(inventory.sources.find(({ id }) => id === entryId).accessibilityAdmissionEvidence) });
      assert.ok(codes(result).includes("REFRESH_GATE"), `${run.label} ${field}`);
    }
  }
});

test("반증: 광주 단계는 보관 증거가 새 원장 행과 어긋나면 REFRESH_GATE", async () => {
  for (const run of runsOf("gwangju-timetable-refresh")) {
    const entryId = run.inventory.changed[0].id;
    const mutations = {
      snapshotId: (evidence) => { evidence.snapshotId = `${evidence.snapshotId}0`; },
      rawSha256: (evidence) => { evidence.rawSha256 = "0".repeat(64); },
      observationIdentitySha256: (evidence) => { evidence.observationIdentitySha256 = "0".repeat(64); },
      observedAt: (evidence) => { evidence.observedAt = "2000-01-01T00:00:00.000Z"; },
    };
    for (const [field, mutate] of Object.entries(mutations)) {
      const result = await evaluate(run, { mutateInventory: (inventory) => mutate(inventory.sources.find(({ id }) => id === entryId).retainedScheduleAdmissionEvidence) });
      assert.ok(codes(result).includes("REFRESH_GATE"), `${run.label} ${field}`);
    }
  }
});

// Seoul 단계가 소유한 입력 파일(capital-pilot-production-source-input.json)은 서울 접근성 snapshot을 가리키는 증거 필드 몇 개만 바뀐다.
test("Seoul 입력 파일은 새 snapshot에 결속된 증거 필드만 바뀌어야 한다. 그 밖의 변경은 REFRESH_GATE", async () => {
  const [run] = runsOf("seoul-accessibility-refresh");
  const withInput = (mutate) => evaluate(run, { mutateInput: mutate });
  assert.ok(codes(await withInput((input) => { input.facilityRows[0].note = "바뀜"; })).includes("REFRESH_GATE"), "무관한 행 변경");
  assert.ok(codes(await withInput((input) => { input.newSection = []; })).includes("REFRESH_GATE"), "새 최상위 키");
  assert.ok(codes(await withInput((input) => { input.routeEdges.push({ id: "x" }); })).includes("REFRESH_GATE"), "배열 길이 변경");
  assert.ok(codes(await withInput((input) => { input.routeEdges[0].stationId = "station-evil"; })).includes("REFRESH_GATE"), "증거 필드가 아닌 필드");
  assert.ok(codes(await withInput((input) => { input.routeEdges[0].sourceSnapshotId = "seoul-metro-accessibility-19990101T000000000Z"; })).includes("REFRESH_GATE"), "새 snapshot이 아닌 id");
  assert.ok(codes(await withInput((input) => { input.routeEdges[0].lastVerifiedAt = "1999-01-01T00:00:00.000Z"; })).includes("REFRESH_GATE"), "새 snapshot 시각이 아닌 시각");
  assert.ok(codes(await withInput((input) => { input.routeEdges[0].evidenceHash = "not-a-hash"; })).includes("REFRESH_GATE"), "해시 형식");
  assert.ok(codes(await withInput((input) => { input.routeEdges[0].sourceSnapshotId = input.routeEdges[1].sourceSnapshotId = "kric-station-convenience-standard-20261007T162707637Z"; })).includes("REFRESH_GATE"), "다른 원천 snapshot으로 바꿈");
  const noChange = await evaluate(run, { mutateInput: (input) => { for (const key of ["routeEdges", "accessibilityStatusEvidence"]) input[key] = sourceInputOf(run, "before")[key]; } });
  assert.ok(codes(noChange).includes("REFRESH_GATE"), "입력 파일이 바뀌지 않았는데 갱신으로 주장");
});

test("입력 오류는 예외가 아니라 위반으로 돌려준다(fail closed)", async () => {
  const run = runsOf("kric-facility-refresh")[0];
  const broken = await evaluate(run, { mutateFiles: (head) => { head.set(INVENTORY_PATH, "{ not json"); } });
  assert.ok(codes(broken).includes("INVENTORY_GATE"));
  const missingLedger = await evaluate(run, { mutateFiles: (head) => { head.delete(LEDGER_PATH); } });
  assert.ok(codes(missingLedger).includes("LEDGER_GATE"));
  const badPolicy = await evaluate(run, {}, { policy: { schemaVersion: 1 } });
  assert.notDeepEqual(badPolicy.violations, []);
  await assert.rejects(evaluateRefreshStage({ stage: "registration", paths: [], baseSha: run.baseSha, policy: POLICY, files: {} }), /REFRESH_STAGE_UNKNOWN/u);
});

// ---------------------------------------------------------------------------
// falsifiability probe로 드러난 틈을 닫는 반증(#1012): 검사 하나를 없애면 반드시 실패해야 하는 개별 시험.
// ---------------------------------------------------------------------------
test("반증: 원장 새 행의 contentSha256만 바뀌면(정책은 내용 변경을 허용) inventory 증거와의 결속이 REFRESH_GATE로 막는다", async () => {
  for (const run of RECORDED.filter(({ stage }) => REFRESH_STAGES[stage].ledger === "append")) {
    const result = await evaluate(run, { mutateLedger: (rows) => { rows[1].contentSha256 = "9".repeat(64); } });
    assert.deepEqual(codes(result).filter((code) => code !== "REFRESH_GATE"), [], `${run.label}: 원장 게이트는 통과한다`);
    assert.ok(codes(result).includes("REFRESH_GATE"), `${run.label}: 결속이 어긋난다`);
  }
});

test("반증: Seoul 입력 파일에서 이미 있는 비증거 필드(stationId)를 고치면 REFRESH_GATE", async () => {
  const [run] = runsOf("seoul-accessibility-refresh");
  const result = await evaluate(run, { mutateInput: (input) => { input.accessibilityStatusEvidence[4].stationId = "station-evil"; } });
  assert.match(result.violations.map(({ detail }) => detail).join("\n"), /증거 필드가 아닌 필드가 바뀌었다: stationId/u);
});

test("반증: currentTopologyAdmission을 가진 항목이 소유한 16개와 다르면(소유 밖 항목이 더해지면) REFRESH_GATE", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    const extra = { id: "extra-route-map-positions", routeMapAdmissionEvidence: { currentTopologyAdmission: { topologySnapshotId: run.capital.head.path.split("/").pop().replace(/\.json$/u, "") } } };
    const result = await evaluate(run, { mutateBaseInventory: (inventory) => { inventory.sources.push(structuredClone(extra)); }, mutateInventory: (inventory) => { inventory.sources.push(structuredClone(extra)); } });
    assert.match(result.violations.map(({ detail }) => detail).join("\n"), /소유한 16개와 다르다/u, run.label);
  }
});

test("반증: topology 변화 한도는 항목마다 따로 막는다(간선 수 비율·커버리지 감소·내용 변경 정책)", async () => {
  const addEdges = (count) => (lines) => { for (let index = 0; index < count; index += 1) { const line = lines[index]; const last = line.scope.at(-1); const name = `새역${index}`; line.scope.push({ stationName: name, sequence: last.sequence + 1 }); line.edges.push({ fromStationName: last.stationName, toStationName: name, distanceMeters: 900, durationSeconds: 0, branchNames: [] }); } };
  for (const run of runsOf("capital-topology-refresh")) {
    const ratio = await evaluate(run, { mutateCapitalLines: addEdges(6) });
    assert.match(ratio.violations.map(({ detail }) => detail).join("\n"), /SOURCE_COUNT_DELTA: .*rowDelta/u, `${run.label}: 간선 수 비율`);
    // 역 정보 증거의 역 수가 줄면 커버리지 감소다(topology 파일은 노선 집합이 고정이라 노선 수로는 줄일 수 없다).
    const coverage = await evaluate(run, { mutateInventory: (inventory) => { const evidence = inventory.sources.find(({ id }) => id === "incheon-transit-station-info").topologyAdmissionEvidence; evidence.stationCount -= 1; } });
    assert.match(coverage.violations.map(({ detail }) => detail).join("\n"), /SOURCE_COUNT_DELTA: .*decreases coverage/u, `${run.label}: 커버리지 감소`);
    const changed = (lines) => { lines[0].edges[0].distanceMeters += 1; };
    const content = await evaluate(run, { mutateCapitalLines: changed }, { policy: { ...POLICY, allowContentChange: false } });
    assert.match(content.violations.map(({ detail }) => detail).join("\n"), /SOURCE_SHA_DRIFT/u, `${run.label}: 내용 변경 정책`);
    const allowed = await evaluate(run, { mutateCapitalLines: changed });
    assert.deepEqual(allowed.violations, [], `${run.label}: 정책이 내용 변경을 허용하면 한도 안의 내용 변경은 통과한다`);
    assert.equal(allowed.rows.find(({ sourceId }) => sourceId === "capital-route-topology").diffStatus, "CHANGED", run.label);
    const malformed = await evaluate(run, { mutateFiles: (head) => { head.set(run.capital.head.path, JSON.stringify({ ...buildCapitalSnapshot(), sourceId: "other-source" })); } });
    assert.ok(codes(malformed).includes("REFRESH_GATE"), `${run.label}: topology 파일 형식`);
  }
});

// ---------------------------------------------------------------------------
// 리뷰 F2: snapshot 본문의 신원(contentSha256·lineCount·totalEdgeCount)은 선언값이 아니라 본문에서 다시 계산한다.
// 원본 응답의 출처는 병합 뒤 등록 workflow가 OCI 원본으로 확인한다(경계는 계약 주석과 PR 본문에 적는다).
// ---------------------------------------------------------------------------
test("F2 반증: topology snapshot의 선언 신원이 본문과 다르면 REFRESH_GATE(해시·개수를 임의로 써도 통과하지 못한다)", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    const rewrite = (edit) => (head) => { const snapshot = JSON.parse(head.get(run.capital.head.path)); edit(snapshot); head.set(run.capital.head.path, JSON.stringify(snapshot)); };
    const arbitrary = "a".repeat(64);
    const hash = await evaluate(run, { mutateFiles: (head, base) => { rewrite((snapshot) => { snapshot.contentSha256 = arbitrary; })(head, base); head.set(run.capital.reverificationPath, JSON.stringify({ candidate: { contentSha256: arbitrary } })); } });
    assert.ok(codes(hash).includes("REFRESH_GATE"), `${run.label}: 임의 contentSha256`);
    const counts = await evaluate(run, { mutateFiles: rewrite((snapshot) => { snapshot.totalEdgeCount -= 1; }) });
    assert.ok(codes(counts).includes("REFRESH_GATE"), `${run.label}: 선언 totalEdgeCount만 다름`);
    const lines = await evaluate(run, { mutateFiles: rewrite((snapshot) => { snapshot.lineCount -= 1; }) });
    assert.ok(codes(lines).includes("REFRESH_GATE"), `${run.label}: 선언 lineCount만 다름`);
    const body = await evaluate(run, { mutateFiles: rewrite((snapshot) => { snapshot.lines[0].edges[0].distanceMeters += 7; }) });
    assert.ok(codes(body).includes("REFRESH_GATE"), `${run.label}: 본문 간선을 고치고 해시는 그대로`);
    const lineHash = await evaluate(run, { mutateFiles: rewrite((snapshot) => { snapshot.lines[0].contentSha256 = arbitrary; }) });
    assert.ok(codes(lineHash).includes("REFRESH_GATE"), `${run.label}: 노선 contentSha256`);
    const lineSet = await evaluate(run, { mutateFiles: rewrite((snapshot) => { snapshot.lines.pop(); }) });
    assert.ok(codes(lineSet).includes("REFRESH_GATE"), `${run.label}: 노선 집합이 소유 규칙과 다름`);
  }
});

test("F2 반증: 직전 snapshot 파일이 본문과 어긋나도 막는다(비교 기준을 선언값으로 믿지 않는다)", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    const path = `tools/datapack/sources/${run.capital.previous.snapshotId}.json`;
    const result = await evaluate(run, { mutateFiles: (_head, base) => { const snapshot = JSON.parse(base.get(path)); snapshot.totalEdgeCount += 40; base.set(path, JSON.stringify(snapshot)); } });
    assert.ok(codes(result).includes("REFRESH_GATE"), run.label);
  }
});

// 경계: 이 단계의 snapshot 행 rawSha256은 커밋된 파일 바이트의 sha256이다. 수도권 topology는 그 파일 바이트가 곧 OCI에 게시되는 원본이고,
// 병합 뒤 등록 workflow가 같은 바이트의 sha256을 영수증의 rawObjectSha256과 대조한다. 그 코드 근거가 사라지면 이 경계 설명이 거짓이 되므로 테스트로 고정한다.
test("F2 경계: 등록 workflow의 코드가 snapshot 파일 바이트의 sha256을 OCI 영수증의 원본 sha와 대조한다", async () => {
  const source = await readFile(new URL("../datapack/run-current-capital-route-topology-registration.mjs", import.meta.url), "utf8");
  assert.match(source, /const rawSha256 = sha256\(admission\.topologyBytes\)/u, "게시할 원본은 보호 admission이 읽은 topology 파일 바이트");
  assert.match(source, /sha256\(raw\) !== journal\.rawSha256/u, "게시 직전 원본 바이트 sha를 저널과 대조");
  assert.match(source, /receipt\?\.rawObjectSha256 !== journal\.rawSha256/u, "OCI 영수증의 rawObjectSha256을 저널과 대조");
  const contract = await readFile(new URL("./refresh-stage-contracts.mjs", import.meta.url), "utf8");
  assert.match(contract, /원본 응답의 출처는 병합 뒤 등록 workflow가 OCI 원본으로 확인/u, "계약 주석이 경계를 밝힌다");
  assert.match(contract, /requireCurrentSourceSeparatedCapitalTopology/u, "신원은 생산자의 검증 함수로 다시 계산한다");
});

// ---------------------------------------------------------------------------
// 리뷰 F4: topology 자동 경로는 제거를 허용하지 않는다. 직전 역·간선 집합은 새 집합의 부분집합이어야 하고(항목 식별자 기준),
// 추가·수정은 capital-route-topology 전용 override의 작은 한도(간선 2%)까지만 허용한다. 제거나 한도 초과는 사람 경로(#926 보고)다.
// ---------------------------------------------------------------------------
const addStation = (lineIndex, name) => (lines) => {
  const line = lines[lineIndex];
  const last = line.scope.at(-1);
  line.scope.push({ stationName: name, sequence: last.sequence + 1 });
  line.edges.push({ fromStationName: last.stationName, toStationName: name, distanceMeters: 900, durationSeconds: 0, branchNames: [] });
};
const details = (result) => result.violations.map(({ detail }) => detail).join("\n");

test("F4: 정책 파일에 capital-route-topology 전용 override가 있고 다른 원천의 한도는 그대로다", () => {
  assert.deepEqual(POLICY.sourceOverrides, { "capital-route-topology": { maxRowDeltaRatio: 0.02 } });
  assert.equal(POLICY.maxRowDeltaRatio, 0.05);
  assert.equal(POLICY.allowContentChange, true);
  assert.equal(POLICY.allowCoverageDecrease, false);
});

test("F4 반증: 간선이나 역이 하나라도 제거되면 REFRESH_GATE(정책 한도와 무관하게 사람 경로)", async () => {
  const loose = { ...POLICY, maxRowDeltaRatio: 1, sourceOverrides: {} };
  for (const run of runsOf("capital-topology-refresh")) {
    const edgeRemoved = (lines) => { lines[3].edges.pop(); };
    const stationRemoved = (lines) => { lines[2].scope.pop(); lines[2].edges.pop(); };
    for (const [label, mutate] of [["간선 제거", edgeRemoved], ["역·간선 제거", stationRemoved]]) {
      for (const policy of [POLICY, loose]) {
        const result = await evaluate(run, { mutateCapitalLines: mutate }, { policy });
        assert.ok(codes(result).includes("REFRESH_GATE"), `${run.label} ${label}`);
        assert.match(details(result), /제거/u, `${run.label} ${label}`);
      }
    }
    // 같은 수로 교체해도(하나 빼고 하나 더하면 개수는 그대로) 제거로 잡힌다.
    const swapped = (lines) => { lines[0].edges.pop(); addStation(5, "교체로추가된역")(lines); };
    const swap = await evaluate(run, { mutateCapitalLines: swapped });
    assert.equal(swap.rows.find(({ sourceId }) => sourceId === "capital-route-topology").rowDelta, 0, `${run.label}: 개수는 같다`);
    assert.match(details(swap), /제거/u, `${run.label}: 같은 수 교체`);
    // 같은 노선 안에서 간선 끝 역을 바꿔 치환해도 제거다.
    const rewired = (lines) => { lines[1].edges[2] = { ...lines[1].edges[2], toStationName: "다른역" }; lines[1].scope[3] = { ...lines[1].scope[3], stationName: "다른역" }; };
    const rewire = await evaluate(run, { mutateCapitalLines: rewired });
    assert.match(details(rewire), /제거/u, `${run.label}: 같은 노선 치환`);
  }
});

test("F4: 간선 추가는 2% 이내만 자동 통과하고 넘으면 SOURCE_COUNT_DELTA(수정된 간선도 같은 한도에 센다)", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    const one = await evaluate(run, { mutateCapitalLines: addStation(0, "새역1") });
    assert.deepEqual(one.violations, [], `${run.label}: 66개 중 1개(1.5%)는 통과`);
    const row = one.rows.find(({ sourceId }) => sourceId === "capital-route-topology");
    assert.deepEqual([row.rowDelta, row.diffStatus], [1, "CHANGED"], run.label);
    const two = await evaluate(run, { mutateCapitalLines: (lines) => { addStation(0, "새역1")(lines); addStation(1, "새역2")(lines); } });
    assert.match(details(two), /SOURCE_COUNT_DELTA: .*rowDelta 2 \(3\.0%\) exceeds 2\.0%/u, `${run.label}: 2개(3.0%)는 한도 초과`);
    const modifiedOne = await evaluate(run, { mutateCapitalLines: (lines) => { lines[0].edges[0].distanceMeters += 10; } });
    assert.deepEqual(modifiedOne.violations, [], `${run.label}: 수정 1개는 통과`);
    const modifiedTwo = await evaluate(run, { mutateCapitalLines: (lines) => { lines[0].edges[0].distanceMeters += 10; lines[1].edges[0].distanceMeters += 10; } });
    assert.match(details(modifiedTwo), /SOURCE_COUNT_DELTA: .*changed edges 2 \(3\.0%\) exceed 2\.0%/u, `${run.label}: 수정 2개는 한도 초과`);
    const mixed = await evaluate(run, { mutateCapitalLines: (lines) => { addStation(0, "새역1")(lines); lines[1].edges[0].distanceMeters += 10; } });
    assert.match(details(mixed), /changed edges 2/u, `${run.label}: 추가 + 수정 합산`);
    // 전용 override가 아니라 일반 한도(5%)였다면 통과했을 변화다.
    const generic = await evaluate(run, { mutateCapitalLines: (lines) => { addStation(0, "새역1")(lines); addStation(1, "새역2")(lines); } }, { policy: { ...POLICY, sourceOverrides: {} } });
    assert.deepEqual(generic.violations, [], `${run.label}: override가 없으면 5% 한도라 통과한다(override가 실제로 쓰인다)`);
  }
});

// ---------------------------------------------------------------------------
// 리뷰 F1: canonical pack은 경로만 보지 않고 base·head를 구조 diff로 비교한다.
// 기록된 실제 갱신 커밋(ab90519c9: #1003 활성화 커밋 등)은 출처 표식 키 4개(sourceSnapshotId·updatedAt·lastVerifiedAt·reviewedAt)만 바꾼다.
// 이 키의 값은 새 snapshot id·증거 시각과 정확히 같아야 하고, 그 밖의 키·값·키 구성·배열 길이와 순서는 한 글자도 달라지면 안 된다(PACK_CONTENT).
// ---------------------------------------------------------------------------
test("F1: 표식 키 4개가 기록된 갱신 커밋이 바꾸는 키와 같다", () => {
  assert.deepEqual([...PACK_STAMP_KEYS].sort(), ["lastVerifiedAt", "reviewedAt", "sourceSnapshotId", "updatedAt"]);
});

const packCases = (run) => {
  const sources = packSourcesOf(run);
  const station = sources["incheon-transit-station-info"].after;
  const line1 = sources["incheon-line1-train-timetable"].after;
  return {
    "빈 pack({})": (pack) => { for (const key of Object.keys(pack)) delete pack[key]; },
    "pack 껍데기만 남김": (pack) => { pack.packs = [{ networkEdges: [{ accessible: false }] }]; },
    "접근성 값 하나 변경": (pack) => { pack.packs[0].networkEdges[0].stairFree = false; },
    "역 접근성 값 변경": (pack) => { pack.packs[0].stations[1].accessible = true; },
    "간선 추가": (pack) => { pack.packs[0].networkEdges.push({ ...pack.packs[0].networkEdges[0], id: "edge-new" }); },
    "간선 삭제": (pack) => { pack.packs[0].networkEdges.pop(); },
    "정차 시각 하나 변경": (pack) => { pack.packs[0].transitStopTimes[1].arrivalSeconds += 1; },
    "정차 시각 삭제": (pack) => { pack.packs[0].transitStopTimes.pop(); },
    "배열 순서 변경": (pack) => { pack.packs[0].stations.reverse(); },
    "표식 키 sourceSnapshotId에 엉뚱한 값": (pack) => { pack.packs[0].stations[0].sourceSnapshotId = "evil-snapshot"; },
    "표식 키 lastVerifiedAt에 엉뚱한 값": (pack) => { pack.packs[0].networkEdges[0].lastVerifiedAt = "1999-01-01T00:00:00.000Z"; },
    "표식 키 updatedAt에 엉뚱한 값": (pack) => { pack.packs[0].transitTrips[0].updatedAt = "1999-01-01T00:00:00.000Z"; },
    "표식 키 reviewedAt에 엉뚱한 값": (pack) => { pack.packs[0].routeMapPositions[0].reviewedAt = "1999-01-01T00:00:00.000Z"; },
    "표식 키 값의 형식 변경": (pack) => { pack.packs[0].stations[0].lastVerifiedAt = 20261007; },
    "역 표식에 시간표 snapshot id": (pack) => { pack.packs[0].stations[0].sourceSnapshotId = line1.snapshotId; },
    "역 표식에 시간표 시각": (pack) => { pack.packs[0].stations[0].lastVerifiedAt = line1.at; },
    "시간표 표식에 역 시각": (pack) => { pack.packs[0].transitTrips[0].updatedAt = station.at; },
    "소유하지 않은 원천의 표식 변경": (pack) => { pack.packs[0].sourceInventory[0].updatedAt = station.at; },
    "소유하지 않은 snapshot의 표식 변경": (pack) => { pack.packs[0].routeMapPositions[1].reviewedAt = station.at; },
    "sourceInventory 표식에 엉뚱한 시각": (pack) => { pack.packs[0].sourceInventory[1].updatedAt = "1999-01-01T00:00:00.000Z"; },
    "표식 키가 없던 객체에 표식 추가": (pack) => { pack.packs[0].metadata.sourceSnapshotId = station.snapshotId; },
    "표식 키 삭제": (pack) => { delete pack.packs[0].stations[0].lastVerifiedAt; },
    "표식과 같은 객체의 다른 키 변경": (pack) => { pack.packs[0].stations[0].nameKo = "다"; },
    "새 키 추가": (pack) => { pack.packs[0].stations[0].extra = true; },
    "최상위 키 추가": (pack) => { pack.extra = true; },
    "pack 하나 추가": (pack) => { pack.packs.push(structuredClone(pack.packs[0])); },
    "메타데이터 변경": (pack) => { pack.packs[0].metadata.note = "바뀜"; },
    "통째로 다른 sha": (pack) => { pack.packs[0].routeServiceArtifactEvidence[0].sha256 = "3".repeat(64); },
  };
};

test("F1: canonical pack 내용이 출처 표식 밖에서 바뀌거나 표식 값이 새 snapshot과 다르면 PACK_CONTENT", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    for (const [label, mutate] of Object.entries(packCases(run))) {
      const result = await evaluate(run, { mutatePack: mutate });
      assert.ok(codes(result).includes("PACK_CONTENT"), `${run.label}: ${label}`);
    }
  }
});

test("F1: 기록된 갱신처럼 표식만 새 snapshot·증거 시각으로 바뀐 pack은 통과한다(대조군)", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    const result = await evaluate(run);
    assert.deepEqual(result.violations, [], run.label);
  }
});

test("F1: pack 파일을 읽을 수 없거나 JSON이 아니면 PACK_CONTENT(fail closed)", async () => {
  for (const run of runsOf("capital-topology-refresh")) {
    const unreadable = await evaluate(run, { mutateFiles: (head) => { head.delete("tools/datapack/release/capital-production-canonical-pack.json"); } });
    assert.ok(codes(unreadable).includes("PACK_CONTENT"), `${run.label}: head에 없음`);
    const broken = await evaluate(run, { mutateFiles: (head) => { head.set("tools/datapack/release/capital-production-canonical-pack.json", "{ not json"); } });
    assert.ok(codes(broken).includes("PACK_CONTENT"), `${run.label}: JSON 아님`);
    const noBase = await evaluate(run, { mutateFiles: (_head, base) => { base.delete("tools/datapack/release/capital-production-canonical-pack.json"); } });
    assert.ok(codes(noBase).includes("PACK_CONTENT"), `${run.label}: base에 없음`);
  }
});

// ---------------------------------------------------------------------------
// 리뷰 F3: Seoul 입력 파일의 evidenceHash는 형식만 보지 않고 새 snapshot에서 생성 코드와 같은 방식으로 다시 계산한 값과 같아야 한다.
// 생성 코드(materialize-accessibility-source-input.mjs)가 내보내는 계산 함수를 그대로 쓴다.
// ---------------------------------------------------------------------------
test("F3: 기록된 Seoul 갱신의 evidenceHash는 생성 코드의 계산 함수로 다시 계산한 값과 같다", async () => {
  const { seoulEdgeEvidenceHash, seoulStatusEvidenceHash } = await import("../datapack/materialize-accessibility-source-input.mjs");
  const [run] = runsOf("seoul-accessibility-refresh");
  const changes = run.sourceInputChanges;
  assert.ok(changes.some(({ container }) => container === "routeEdges") && changes.some(({ container }) => container === "accessibilityStatusEvidence"));
  for (const { container, after } of changes) {
    const expected = container === "routeEdges"
      ? seoulEdgeEvidenceHash({ edgeId: after.id, sourceSnapshotId: after.sourceSnapshotId, providerRecordHash: after.providerRecordHash })
      : seoulStatusEvidenceHash({ snapshotId: after.sourceSnapshotId, stationId: after.stationId, lineId: after.lineId, providerRecordHash: after.providerRecordHash });
    assert.equal(after.evidenceHash, expected, `${container}`);
  }
});

test("F3 반증: Seoul 입력 파일의 evidenceHash가 새 snapshot에서 다시 계산한 값과 다르면 REFRESH_GATE", async () => {
  const [run] = runsOf("seoul-accessibility-refresh");
  for (const { container, index } of run.sourceInputChanges) {
    for (const forged of ["f".repeat(64), "0".repeat(64)]) {
      const result = await evaluate(run, { mutateInput: (input) => { input[container][index].evidenceHash = forged; } });
      assert.match(details(result), /evidenceHash가 새 snapshot에서 다시 계산한 값과 다르다/u, `${container}[${index}] ${forged.slice(0, 1)}`);
    }
    // 한 글자만 뒤집은 해시도 막는다.
    const flipped = await evaluate(run, { mutateInput: (input) => { const hash = input[container][index].evidenceHash; input[container][index].evidenceHash = `${hash[0] === "a" ? "b" : "a"}${hash.slice(1)}`; } });
    assert.match(details(flipped), /evidenceHash가 새 snapshot에서 다시 계산한 값과 다르다/u, `${container}[${index}] 한 글자`);
  }
  // 해시 계산에 쓰인 입력(providerRecordHash)을 바꾸고 해시를 맞춰 다시 써도 providerRecordHash는 증거 필드가 아니라 막힌다.
  const rehash = await evaluate(run, { mutateInput: (input) => { input.routeEdges[0].providerRecordHash = "9".repeat(64); } });
  assert.match(details(rehash), /증거 필드가 아닌 필드가 바뀌었다: providerRecordHash/u);
  const control = await evaluate(run);
  assert.deepEqual(control.violations, [], "대조군: 기록된 실제 입력은 통과한다");
});

// ---------------------------------------------------------------------------
// 리뷰 F5: 계약 주석이 실제 동작과 같아야 한다. 허용 목록 밖 경로(reviewed pack·ITX 입력 등)는 PR이 열린 뒤 사람 경로로 가는 것이 아니라
// emitter가 push 전에 거부해 workflow가 실패하고 #926 실패 보고로 드러난다(브랜치도 PR도 만들어지지 않는다).
// ---------------------------------------------------------------------------
test("F5: 계약 주석이 허용 밖 경로의 실제 동작(push 전 실패, #926 보고)을 설명하고 사람 경로로 간다고 말하지 않는다", async () => {
  const text = await readFile(new URL("./refresh-stage-contracts.mjs", import.meta.url), "utf8");
  const header = text.slice(0, text.indexOf("import "));
  assert.doesNotMatch(header, /workflow가 만들 수는 있지만 자동 병합 대상이 아니라 사람 경로로 보낸다/u);
  assert.match(header, /관측된 적 없는 경로\(reviewed pack, ITX 입력\)는 허용하지 않는다\. 이런 변경은 emitter가 push 전에 거부해 workflow가 실패하고 #926 실패 보고로 드러난다/u);
  assert.match(header, /브랜치도 PR도 만들어지지 않는다/u);
});
