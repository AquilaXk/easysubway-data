import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AUTOMATION_PR_EVIDENCE_MARKER, automationPrEvidenceBlock, derivativeRebindingPullRequestBody, main, parseAutomationPrEvidence } from "./automation-pr-evidence.mjs";

// #969: 2단계(자동 병합 정책)가 읽는 자동화 PR 출력 계약. PR 본문의 기계 판독 블록은 색인일 뿐이고,
// 정책은 diff와 원장에서 다시 계산해 대조한다. 블록은 정확히 하나여야 하고 알려진 단계와 필드만 받는다.
const RUN_URL = "https://github.com/AquilaXk/easysubway-data/actions/runs/123";
const STEPS = [{ id: "busan-transfer-metrics", changed: true, paths: ["tools/datapack/release/current-busan-transfer-metrics.json"] }, { id: "seoul-measured-transfer-metrics", changed: false }];

test("블록은 단계·이슈·실행 run·바뀐 단계의 경로를 JSON 한 줄로 남기고 그대로 읽힌다", () => {
  const block = automationPrEvidenceBlock({ stage: "derivative-rebinding", runUrl: RUN_URL, steps: STEPS });
  assert.match(block, new RegExp(`^<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} \\{.*\\} -->$`, "u"));
  assert.doesNotMatch(block, /\n/u);
  assert.deepEqual(parseAutomationPrEvidence(`본문\n\n${block}\n`), {
    schemaVersion: 1, stage: "derivative-rebinding", issue: 969, runUrl: RUN_URL,
    steps: [{ id: "busan-transfer-metrics", changed: true, paths: ["tools/datapack/release/current-busan-transfer-metrics.json"] }, { id: "seoul-measured-transfer-metrics", changed: false, paths: [] }],
  });
});

test("블록이 없으면 null, 둘 이상이거나 형식이 어긋나면 실패한다", () => {
  assert.equal(parseAutomationPrEvidence("블록 없음"), null);
  const block = automationPrEvidenceBlock({ stage: "derivative-rebinding", runUrl: RUN_URL, steps: STEPS });
  assert.throws(() => parseAutomationPrEvidence(`${block}\n${block}`), /AUTOMATION_PR_EVIDENCE_DUPLICATE/u);
  assert.throws(() => parseAutomationPrEvidence(`<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} {not json} -->`), /AUTOMATION_PR_EVIDENCE_INVALID/u);
  assert.throws(() => parseAutomationPrEvidence(`<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} ${JSON.stringify({ schemaVersion: 2 })} -->`), /AUTOMATION_PR_EVIDENCE_INVALID/u);
});

test("알 수 없는 단계·잘못된 run URL·바뀌지 않았는데 경로가 있는 단계는 만들 때 실패한다", () => {
  assert.throws(() => automationPrEvidenceBlock({ stage: "unknown", runUrl: RUN_URL, steps: STEPS }), /AUTOMATION_PR_EVIDENCE_INVALID/u);
  assert.throws(() => automationPrEvidenceBlock({ stage: "derivative-rebinding", runUrl: "http://x", steps: STEPS }), /AUTOMATION_PR_EVIDENCE_INVALID/u);
  assert.throws(() => automationPrEvidenceBlock({ stage: "derivative-rebinding", runUrl: RUN_URL, steps: [{ id: "a", changed: false, paths: ["x"] }] }), /AUTOMATION_PR_EVIDENCE_INVALID/u);
  assert.throws(() => automationPrEvidenceBlock({ stage: "derivative-rebinding", runUrl: RUN_URL, steps: [{ id: "a", changed: true, paths: [] }] }), /AUTOMATION_PR_EVIDENCE_INVALID/u);
});

test("파생 재결속 PR 본문은 단계별 결과와 증거 블록을 담고 Refs만 건다", () => {
  const body = derivativeRebindingPullRequestBody({ runUrl: RUN_URL, steps: STEPS });
  assert.match(body, /\| busan-transfer-metrics \| 갱신 \|/u);
  assert.match(body, /\| seoul-measured-transfer-metrics \| 변경 없음 \|/u);
  assert.match(body, /Refs #969\nRefs #870/u);
  assert.doesNotMatch(body, /Closes/u);
  assert.equal(parseAutomationPrEvidence(body).stage, "derivative-rebinding");
});

test("CLI는 controller 결과 JSON에서 본문 파일을 만든다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "automation-pr-evidence-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const result = path.join(directory, "result.json"); const output = path.join(directory, "body.md");
  await writeFile(result, JSON.stringify({ steps: STEPS }));
  await main(["derivative-rebinding-body", "--result", result, "--run-url", RUN_URL, "--output", output]);
  assert.equal(parseAutomationPrEvidence(await readFile(output, "utf8")).steps.length, 2);
  await assert.rejects(main(["derivative-rebinding-body", "--result", result, "--run-url", RUN_URL, "--output", output]), /EEXIST/u);
  await assert.rejects(main(["other", "--result", result]), /AUTOMATION_PR_EVIDENCE_ARGUMENTS/u);
});
