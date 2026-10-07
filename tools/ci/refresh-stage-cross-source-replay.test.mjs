import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentSeoulAccessibilityRegistrationOutputs } from "../datapack/register-current-seoul-accessibility-snapshot.mjs";
import { materializeAccessibilitySourceInput } from "../datapack/materialize-accessibility-source-input.mjs";
import { buildSnapshotDiff } from "../datapack/source-snapshot-policy.mjs";
import { POLICY } from "../datapack/test-fixtures/refresh-recorded-runs.mjs";
import { evaluateRefreshStage, kricRebaseViolations } from "./refresh-stage-contracts.mjs";

// #1018: 입력 파일(capital-pilot-production-source-input.json)은 KRIC과 서울 두 원천의 head를 함께 투영한 파일이다.
// KRIC 정기 갱신은 원장·inventory만 옮기고 입력 파일은 그대로 둔다(그래야 단계 규칙이 입력 파일을 허용 경로로 두지 않는다).
// 그래서 서울 정기 갱신이 입력을 만들 때 KRIC 소유 행도 현재 KRIC head로 다시 만든다(build-datapack이 행의 sourceSnapshotId를 inventory 증거와 맞춘다).
// 이 파일은 실제 생산자(registerCurrentSeoulAccessibilitySnapshot의 출력 계산)를 그대로 돌려 "KRIC 갱신 병합 -> 서울 갱신" 순서를 재생하고, 서울 단계 게이트가 그 결과를 받아들이는지 본다.
const ROOT = path.resolve(import.meta.dirname, "../..");
const LEDGER = "tools/datapack/release/source-snapshots.json";
const INVENTORY = "tools/datapack/source-inventory.json";
const INPUT = "tools/datapack/inputs/capital-pilot-production-source-input.json";
const SUPPORT = ["tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json"];
const KRIC = "kric-station-convenience-standard";
const SEOUL = "seoul-metro-accessibility";
const STEP_MS = 10 * 60_000;

const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const stamp = (millis) => new Date(millis).toISOString().replaceAll(/[-:.]/gu, "");
const entry = (inventory, id) => inventory.sources.find((source) => source.id === id);
const detailsOf = (result) => result.violations.map(({ code, detail }) => `${code}: ${detail}`).join("\n");

/** 현재 저장소의 실제 파일에서 시작하는 트리(상대 경로 -> 본문). KRIC·서울 head snapshot 파일을 포함한다. */
async function seedTree() {
  const tree = new Map();
  for (const relative of [LEDGER, INVENTORY, INPUT, ...SUPPORT]) tree.set(relative, await readFile(path.join(ROOT, relative), "utf8"));
  const inventory = JSON.parse(tree.get(INVENTORY));
  for (const id of [KRIC, SEOUL]) {
    const snapshotPath = entry(inventory, id).accessibilityAdmissionEvidence.snapshotPath;
    tree.set(snapshotPath, await readFile(path.join(ROOT, snapshotPath), "utf8"));
  }
  return tree;
}

const candidatePublishedAt = Date.parse(JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8")).publishedAt);
const latestCapture = (tree) => {
  const inventory = JSON.parse(tree.get(INVENTORY));
  return Math.max(
    candidatePublishedAt,
    ...[KRIC, SEOUL].map((id) => Date.parse(entry(inventory, id).accessibilityAdmissionEvidence.capturedAt)),
  );
};

/** KRIC 정기 갱신이 병합된 뒤의 트리. 원장·inventory·새 snapshot 파일만 바뀌고 입력 파일은 그대로다(kric-facility-refresh 단계 규칙). */
function applyKricRefresh(tree, { changeContent = false } = {}) {
  const next = new Map(tree);
  const inventory = JSON.parse(next.get(INVENTORY));
  const ledger = JSON.parse(next.get(LEDGER));
  const source = entry(inventory, KRIC);
  const evidence = source.accessibilityAdmissionEvidence;
  const previous = JSON.parse(next.get(evidence.snapshotPath));
  const capturedMillis = latestCapture(tree) + STEP_MS;
  const capturedAt = new Date(capturedMillis).toISOString();
  const snapshot = structuredClone(previous);
  snapshot.snapshotId = `${KRIC}-${stamp(capturedMillis)}`;
  snapshot.capturedAt = capturedAt;
  snapshot.observedAt = capturedAt;
  snapshot.freshUntil = new Date(capturedMillis + 86_400_000).toISOString();
  snapshot.rawSha256 = sha(`kric raw ${snapshot.snapshotId}`);
  if (changeContent) {
    const query = snapshot.queries.find(({ rows }) => rows.some((row) => row.gubun === "EV"));
    query.rows.find((row) => row.gubun === "EV").dtlLoc = `${query.rows.find((row) => row.gubun === "EV").dtlLoc} 변경`;
    snapshot.contentSha256 = sha(JSON.stringify(snapshot.queries));
  }
  const snapshotPath = `tools/datapack/sources/${snapshot.snapshotId}.json`;
  const snapshotText = json(snapshot);
  next.set(snapshotPath, snapshotText);

  const heads = ledger.filter((row) => row.sourceId === KRIC);
  const head = heads.find(({ snapshotId }) => !heads.some((row) => row.previousSnapshotId === snapshotId));
  const row = {
    ...structuredClone(head),
    snapshotId: snapshot.snapshotId,
    previousSnapshotId: head.snapshotId,
    retrievedAt: capturedAt,
    sourceUpdatedAt: capturedAt,
    rawSha256: snapshot.rawSha256,
    contentSha256: snapshot.contentSha256,
    rawObjectUri: head.rawObjectUri.replace(/\/[0-9a-f]{64}\.json$/u, `/${snapshot.rawSha256}.json`),
    rawReceipt: { ...head.rawReceipt, snapshotId: snapshot.snapshotId, capturedAt, snapshotFileSha256: sha(snapshotText), rawObjectSha256: snapshot.rawSha256 },
  };
  row.diffSummary = buildSnapshotDiff(head, row);
  next.set(LEDGER, json([...ledger, row]));

  source.retrievedAt = capturedAt.slice(0, 10);
  source.observedDataUpdatedAt = capturedAt.slice(0, 10);
  source.accessibilityAdmissionEvidence = {
    ...evidence, snapshotId: snapshot.snapshotId, snapshotPath, capturedAt, observedAt: capturedAt, freshUntil: snapshot.freshUntil,
    rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256, snapshotFileSha256: sha(snapshotText),
  };
  next.set(INVENTORY, json(inventory));
  return { tree: next, paths: [snapshotPath, INVENTORY, LEDGER], snapshotId: snapshot.snapshotId };
}

/** 실제 생산자로 서울 정기 갱신을 한 번 돌린 뒤의 트리. 입력 파일을 포함한 네 파일이 바뀐다(seoul-accessibility-refresh 단계 규칙). */
async function applySeoulRefresh(tree) {
  const root = await mkdtemp(path.join(os.tmpdir(), "refresh-cross-source-"));
  const observation = await mkdtemp(path.join(os.tmpdir(), "refresh-cross-source-observation-"));
  try {
    for (const [relative, text] of tree) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), text);
    }
    const inventory = JSON.parse(tree.get(INVENTORY));
    const prior = JSON.parse(tree.get(entry(inventory, SEOUL).accessibilityAdmissionEvidence.snapshotPath));
    const capturedMillis = latestCapture(tree) + STEP_MS;
    const capturedAt = new Date(capturedMillis).toISOString();
    const snapshot = {
      ...prior, snapshotId: `${SEOUL}-${stamp(capturedMillis)}`, previousSnapshotId: prior.snapshotId,
      retrievedAt: capturedAt, capturedAt, observedAt: capturedAt, freshUntil: new Date(capturedMillis + 86_400_000).toISOString(),
      rawSha256: sha(`seoul raw ${capturedAt}`),
    };
    const snapshotBytes = Buffer.from(json(snapshot));
    const rawObjectSha256 = sha(`seoul oci raw ${capturedAt}`);
    const receipt = {
      schemaVersion: 1, artifactKind: "seoul-accessibility-raw-object-receipt", sourceId: SEOUL, snapshotId: snapshot.snapshotId,
      snapshotRawSha256: snapshot.rawSha256, capturedAt, snapshotFileSha256: sha(snapshotBytes),
      rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/${SEOUL}/${capturedAt.slice(0, 10).replaceAll("-", "")}/${rawObjectSha256}.json`,
      rawObjectSha256, byteSize: 29, storedAt: new Date(capturedMillis + 1_000).toISOString(),
      rawRetentionExpiresAt: new Date(capturedMillis + 90 * 86_400_000).toISOString(),
    };
    const snapshotPath = path.join(observation, `${snapshot.snapshotId}.json`);
    const receiptPath = path.join(observation, "receipt.json");
    await writeFile(snapshotPath, snapshotBytes);
    await writeFile(receiptPath, json(receipt));
    const outputs = await buildCurrentSeoulAccessibilityRegistrationOutputs({
      repositoryRoot: root, snapshotPath, receiptPath, now: new Date(capturedMillis + 60_000),
    });
    const next = new Map(tree);
    for (const { relative, bytes } of outputs) next.set(relative, bytes.toString("utf8"));
    return { tree: next, paths: outputs.map(({ relative }) => relative), snapshotId: snapshot.snapshotId };
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(observation, { recursive: true, force: true })]);
  }
}

const gate = (stage, base, step) => evaluateRefreshStage({
  stage, paths: step.paths, baseSha: "base", policy: POLICY,
  files: {
    readTree: async (relative) => { if (!step.tree.has(relative)) throw new Error(`head에 없는 파일: ${relative}`); return step.tree.get(relative); },
    readBase: async (_sha, relative) => { if (!base.has(relative)) throw new Error(`base에 없는 파일: ${relative}`); return base.get(relative); },
  },
});

const kricRowIds = (tree) => {
  const input = JSON.parse(tree.get(INPUT));
  return [...new Set([...input.facilityRows, ...input.accessibilityStatusEvidence].filter(({ sourceId }) => sourceId === KRIC).map(({ sourceSnapshotId }) => sourceSnapshotId))];
};

test("KRIC 갱신이 병합된 직후의 서울 갱신은 입력 파일의 KRIC 소유 행을 현재 KRIC head로 다시 만들어도 게이트를 통과한다(#1018)", async () => {
  const start = await seedTree();
  const kric = applyKricRefresh(start);
  assert.deepEqual(detailsOf(await gate("kric-facility-refresh", start, kric)), "", "KRIC 갱신 PR 자체는 통과한다");
  assert.equal(kric.tree.get(INPUT), start.get(INPUT), "KRIC 갱신은 입력 파일을 만지지 않는다");

  const seoul = await applySeoulRefresh(kric.tree);
  // 서울 생산자는 KRIC 소유 행을 현재 KRIC head로 다시 만든다. 입력 파일의 KRIC 행이 KRIC inventory 증거와 같아야 build-datapack이 받는다.
  assert.deepEqual(kricRowIds(seoul.tree), [kric.snapshotId], "생산자는 KRIC 행을 KRIC head로 옮긴다");
  assert.notEqual(seoul.tree.get(INPUT), kric.tree.get(INPUT));
  assert.equal(detailsOf(await gate("seoul-accessibility-refresh", kric.tree, seoul)), "");
});

test("KRIC 내용이 바뀐 갱신 뒤의 서울 갱신도 KRIC 소유 행 전체를 생산자 규칙으로 다시 만든 값과 같으면 통과한다(#1018)", async () => {
  const start = await seedTree();
  const kric = applyKricRefresh(start, { changeContent: true });
  const seoul = await applySeoulRefresh(kric.tree);
  assert.equal(detailsOf(await gate("seoul-accessibility-refresh", kric.tree, seoul)), "");
});

test("서울 갱신 다음 KRIC 갱신, 다시 서울 갱신 순서도 각 단계 게이트를 통과한다(#1018 역순)", async () => {
  const start = await seedTree();
  const firstSeoul = await applySeoulRefresh(start);
  assert.equal(detailsOf(await gate("seoul-accessibility-refresh", start, firstSeoul)), "", "서울 먼저");
  const kric = applyKricRefresh(firstSeoul.tree);
  assert.equal(detailsOf(await gate("kric-facility-refresh", firstSeoul.tree, kric)), "", "그 다음 KRIC");
  assert.equal(kric.tree.get(INPUT), firstSeoul.tree.get(INPUT), "KRIC 갱신은 입력 파일을 만지지 않는다");
  const secondSeoul = await applySeoulRefresh(kric.tree);
  assert.deepEqual(kricRowIds(secondSeoul.tree), [kric.snapshotId]);
  assert.equal(detailsOf(await gate("seoul-accessibility-refresh", kric.tree, secondSeoul)), "", "다음 서울은 KRIC 행을 따라간다");
});

test("KRIC 갱신이 연속으로 두 번 병합돼도 다음 서울 갱신은 마지막 KRIC head만 따른다(#1018)", async () => {
  const start = await seedTree();
  const first = applyKricRefresh(start);
  const second = applyKricRefresh(first.tree);
  const seoul = await applySeoulRefresh(second.tree);
  assert.deepEqual(kricRowIds(seoul.tree), [second.snapshotId]);
  assert.equal(detailsOf(await gate("seoul-accessibility-refresh", second.tree, seoul)), "");
});

test("반증: KRIC 소유 행을 생산자 값과 다르게 바꾸면 서울 단계 게이트가 막는다(#1018)", async () => {
  const start = await seedTree();
  const kric = applyKricRefresh(start);
  const seoul = await applySeoulRefresh(kric.tree);
  const tamper = (mutate) => {
    const input = JSON.parse(seoul.tree.get(INPUT));
    mutate(input);
    return { ...seoul, tree: new Map(seoul.tree).set(INPUT, json(input)) };
  };
  const facility = tamper((input) => { input.facilityRows[0].description = "위조"; });
  assert.match(detailsOf(await gate("seoul-accessibility-refresh", kric.tree, facility)), /REFRESH_GATE: .*KRIC/u);
  const status = tamper((input) => { input.accessibilityStatusEvidence.find(({ sourceId }) => sourceId === KRIC).evidenceHash = "0".repeat(64); });
  assert.match(detailsOf(await gate("seoul-accessibility-refresh", kric.tree, status)), /REFRESH_GATE: .*KRIC/u);
  const dropped = tamper((input) => { input.facilityRows.pop(); });
  assert.match(detailsOf(await gate("seoul-accessibility-refresh", kric.tree, dropped)), /REFRESH_GATE: .*KRIC/u);
  const stale = tamper((input) => {
    for (const row of [...input.facilityRows, ...input.accessibilityStatusEvidence]) if (row.sourceId === KRIC) row.sourceSnapshotId = `${KRIC}-19990101T000000000Z`;
  });
  assert.match(detailsOf(await gate("seoul-accessibility-refresh", kric.tree, stale)), /REFRESH_GATE: .*KRIC/u);
});

test("반증: KRIC head snapshot 파일 바이트가 inventory 증거와 다르면 서울 단계 게이트가 막는다(#1018)", async () => {
  const start = await seedTree();
  const kric = applyKricRefresh(start);
  const seoul = await applySeoulRefresh(kric.tree);
  const kricPath = `tools/datapack/sources/${kric.snapshotId}.json`;
  const forged = { ...seoul, tree: new Map(seoul.tree).set(kricPath, `${seoul.tree.get(kricPath)} `) };
  assert.match(detailsOf(await gate("seoul-accessibility-refresh", kric.tree, forged)), /REFRESH_GATE: .*KRIC.*snapshotFileSha256/u);
});

test("반증: 서울 소유 행의 변조는 KRIC 행이 정상이어도 여전히 막는다(#1018)", async () => {
  const start = await seedTree();
  const kric = applyKricRefresh(start);
  const seoul = await applySeoulRefresh(kric.tree);
  const input = JSON.parse(seoul.tree.get(INPUT));
  input.accessibilityStatusEvidence.find(({ sourceId }) => sourceId === SEOUL).stationId = "station-evil";
  const result = await gate("seoul-accessibility-refresh", kric.tree, { ...seoul, tree: new Map(seoul.tree).set(INPUT, json(input)) });
  assert.match(detailsOf(result), /증거 필드가 아닌 필드가 바뀌었다: stationId/u);
});

// 주변 단계 게이트(inventory 소유 필드, 원장 한 행 규칙)는 아래 위조를 먼저 막는다. 그 규칙에 기대지 않고 KRIC 함수 자체가 base에 묶여 있는지 직접 부른다.
const rebaseCheck = (base, step) => kricRebaseViolations({
  base: JSON.parse(base.get(INPUT)), head: JSON.parse(step.tree.get(INPUT)),
  baseInventory: JSON.parse(base.get(INVENTORY)), headInventory: JSON.parse(step.tree.get(INVENTORY)),
  baseSha: "base", seoulSnapshotId: step.snapshotId,
  files: {
    readTree: async (relative) => { if (!step.tree.has(relative)) throw new Error(`head에 없는 파일: ${relative}`); return step.tree.get(relative); },
    readBase: async (_sha, relative) => base.get(relative),
  },
});
const refreshGateDetails = (result) => result.violations.filter(({ code }) => code === "REFRESH_GATE").map(({ detail }) => detail).join("\n");
const withInput = (step, mutate) => {
  const input = JSON.parse(step.tree.get(INPUT));
  mutate(input);
  return { ...step, tree: new Map(step.tree).set(INPUT, json(input)) };
};

test("반증: 서울 소유 행의 sourceId를 KRIC으로 바꿔 서울 규칙을 피하려 하면 막는다(#1022 F2 relabel)", async () => {
  const kric = applyKricRefresh(await seedTree());
  const seoul = await applySeoulRefresh(kric.tree);
  const relabeled = withInput(seoul, (input) => { input.accessibilityStatusEvidence.find(({ sourceId }) => sourceId === SEOUL).sourceId = KRIC; });
  const result = await gate("seoul-accessibility-refresh", kric.tree, relabeled);
  assert.match(refreshGateDetails(result), /accessibilityStatusEvidence: 행 수가 바뀌었다/u);
  assert.match(refreshGateDetails(result), /KRIC 소유 행/u);
});

test("반증: KRIC 행과 서울 행의 소유자(sourceId)를 맞바꿔도 막는다(#1022 F2 swap)", async () => {
  const kric = applyKricRefresh(await seedTree());
  const seoul = await applySeoulRefresh(kric.tree);
  const swapped = withInput(seoul, (input) => {
    const rows = input.accessibilityStatusEvidence;
    const [kricRow, seoulRow] = [rows.find(({ sourceId }) => sourceId === KRIC), rows.find(({ sourceId }) => sourceId === SEOUL)];
    [kricRow.sourceId, seoulRow.sourceId] = [SEOUL, KRIC];
  });
  const result = await gate("seoul-accessibility-refresh", kric.tree, swapped);
  assert.notEqual(refreshGateDetails(result), "");
  assert.match(refreshGateDetails(result), /KRIC 소유 행 \d+개가 KRIC head/u);
});

test("반증: head inventory의 KRIC 증거를 비-head snapshot으로 재지정하면(파일 sha 재계산 포함) KRIC 함수 안에서 base 증거와 달라 막는다(#1022 F1·F2)", async () => {
  const start = await seedTree();
  const kric = applyKricRefresh(start);
  const seoul = await applySeoulRefresh(kric.tree);
  const olderEvidence = entry(JSON.parse(start.get(INVENTORY)), KRIC).accessibilityAdmissionEvidence;
  // 입력 KRIC 행도 그 옛 snapshot에서 생산자 규칙으로 다시 만들어, 행 대조만으로는 걸리지 않게 한다.
  const olderSnapshot = JSON.parse(seoul.tree.get(olderEvidence.snapshotPath));
  const seoulDoc = JSON.parse(seoul.tree.get(`tools/datapack/sources/${seoul.snapshotId}.json`));
  const forged = withInput(seoul, (input) => {
    const projected = materializeAccessibilitySourceInput({ input: JSON.parse(kric.tree.get(INPUT)), kricSnapshot: olderSnapshot, seoulSnapshot: seoulDoc });
    input.facilityRows = projected.facilityRows;
    input.accessibilityStatusEvidence = projected.accessibilityStatusEvidence;
  });
  const inventory = JSON.parse(forged.tree.get(INVENTORY));
  entry(inventory, KRIC).accessibilityAdmissionEvidence = structuredClone(olderEvidence);
  forged.tree = new Map(forged.tree).set(INVENTORY, json(inventory));
  assert.equal(sha(forged.tree.get(olderEvidence.snapshotPath)), olderEvidence.snapshotFileSha256, "재지정한 증거의 sha는 파일과 맞는다");
  assert.deepEqual(await rebaseCheck(kric.tree, seoul), [], "정상 트리는 함수 안에서 통과한다");
  assert.match((await rebaseCheck(kric.tree, forged)).join("\n"), /head inventory의 KRIC accessibilityAdmissionEvidence가 base와 다르다/u);
  assert.notEqual(detailsOf(await gate("seoul-accessibility-refresh", kric.tree, forged)), "", "단계 게이트도 막는다");
});

test("반증: KRIC head snapshot 파일을 위조하고 inventory 증거 sha까지 다시 계산해도 base 증거와 달라 막는다(#1022 F1)", async () => {
  const kric = applyKricRefresh(await seedTree());
  const seoul = await applySeoulRefresh(kric.tree);
  const kricPath = `tools/datapack/sources/${kric.snapshotId}.json`;
  const forgedText = `${seoul.tree.get(kricPath)} `;
  const inventory = JSON.parse(seoul.tree.get(INVENTORY));
  entry(inventory, KRIC).accessibilityAdmissionEvidence.snapshotFileSha256 = sha(forgedText);
  const forged = { ...seoul, tree: new Map(seoul.tree).set(kricPath, forgedText).set(INVENTORY, json(inventory)) };
  assert.match((await rebaseCheck(kric.tree, forged)).join("\n"), /head inventory의 KRIC accessibilityAdmissionEvidence가 base와 다르다/u);
  assert.notEqual(detailsOf(await gate("seoul-accessibility-refresh", kric.tree, forged)), "", "단계 게이트도 막는다");
});

test("반증: head 원장에 KRIC 행이 더해지면 KRIC 함수 안에서 base 원장과 달라 막는다(#1022 F1)", async () => {
  const kric = applyKricRefresh(await seedTree());
  const seoul = await applySeoulRefresh(kric.tree);
  const ledger = JSON.parse(seoul.tree.get(LEDGER));
  const head = ledger.filter((row) => row.sourceId === KRIC).at(-1);
  ledger.push({ ...structuredClone(head), snapshotId: `${KRIC}-20991231T000000000Z`, previousSnapshotId: head.snapshotId });
  const forged = { ...seoul, tree: new Map(seoul.tree).set(LEDGER, json(ledger)) };
  assert.match((await rebaseCheck(kric.tree, forged)).join("\n"), /head 원장의 KRIC 행이 base와 다르다/u);
  assert.notEqual(detailsOf(await gate("seoul-accessibility-refresh", kric.tree, forged)), "", "단계 게이트도 막는다");
});
