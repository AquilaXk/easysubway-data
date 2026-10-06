#!/usr/bin/env node
// 자동화 PR의 기계 판독 증거 블록(#969, 2단계 자동 병합 정책의 입력 계약).
// PR 본문에 `<!-- easysubway-automation-pr:v1 {JSON} -->`를 정확히 하나 남긴다. 정책은 이 블록을 색인으로만 쓰고
// 변경 경로·원장·원천 sha는 diff에서 다시 계산해 대조한다. 블록만 믿고 병합하지 않는다.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const AUTOMATION_PR_EVIDENCE_MARKER = "easysubway-automation-pr:v1";
const STAGES = Object.freeze(["derivative-rebinding"]);
const BLOCK = new RegExp(`<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} (.*?) -->`, "gu");
const RUN_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/[1-9][0-9]*$/u;
const ISSUE = 969;

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function evidenceValue({ stage, runUrl, steps }) {
  if (!STAGES.includes(stage) || typeof runUrl !== "string" || !RUN_URL.test(runUrl) || !Array.isArray(steps) || steps.length === 0) fail("AUTOMATION_PR_EVIDENCE_INVALID", "stage, run URL or steps");
  return {
    schemaVersion: 1, stage, issue: ISSUE, runUrl,
    steps: steps.map((step) => {
      const paths = step?.changed === true ? step.paths : (step?.paths ?? []);
      if (typeof step?.id !== "string" || step.id === "" || typeof step.changed !== "boolean" || !Array.isArray(paths)
        || paths.some((entry) => typeof entry !== "string" || entry === "") || step.changed !== (paths.length > 0)) fail("AUTOMATION_PR_EVIDENCE_INVALID", `step ${String(step?.id)}`);
      return { id: step.id, changed: step.changed, paths: [...paths] };
    }),
  };
}

export function automationPrEvidenceBlock(input) {
  return `<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} ${JSON.stringify(evidenceValue(input))} -->`;
}

export function parseAutomationPrEvidence(body) {
  const blocks = [...String(body ?? "").matchAll(BLOCK)];
  if (blocks.length === 0) return null;
  if (blocks.length > 1) fail("AUTOMATION_PR_EVIDENCE_DUPLICATE");
  let value;
  try { value = JSON.parse(blocks[0][1]); } catch { fail("AUTOMATION_PR_EVIDENCE_INVALID", "not JSON"); }
  if (value?.schemaVersion !== 1) fail("AUTOMATION_PR_EVIDENCE_INVALID", "schemaVersion");
  return evidenceValue(value);
}

export function derivativeRebindingPullRequestBody({ runUrl, steps }) {
  const block = automationPrEvidenceBlock({ stage: "derivative-rebinding", runUrl, steps });
  return [
    "## Summary", "",
    "- 원천 등록·재확인 뒤 입력 결속이 바뀐 파생 산출물을 `run-derivative-rebinding`이 다시 만들었다.",
    "- 도구는 멱등이라 바뀐 단계만 커밋이 있다. 후보·hash·release request는 이 PR이 바꾸지 않는다(후보 갱신의 몫이다).",
    `- 실행 run: ${runUrl}`, "",
    "| 단계 | 결과 | 경로 |", "| --- | --- | --- |",
    ...steps.map((step) => `| ${step.id} | ${step.changed ? "갱신" : "변경 없음"} | ${step.changed ? step.paths.map((entry) => `\`${entry}\``).join(", ") : "-"} |`),
    "", "Refs #969", "Refs #870", "", block, "",
  ].join("\n");
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || Object.hasOwn(values, rest[index].slice(2)) || typeof rest[index + 1] !== "string") fail("AUTOMATION_PR_EVIDENCE_ARGUMENTS");
    values[rest[index].slice(2)] = rest[index + 1];
  }
  if (command !== "derivative-rebinding-body" || ["result", "run-url", "output"].some((key) => !Object.hasOwn(values, key))) fail("AUTOMATION_PR_EVIDENCE_ARGUMENTS");
  const { steps } = JSON.parse(await readFile(values.result, "utf8"));
  await writeFile(values.output, derivativeRebindingPullRequestBody({ runUrl: values["run-url"], steps }), { flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
