// 자동화 workflow 계약 테스트의 공통 도구(#969, #3036). 등록·후보·재결속 등 workflow 계약 테스트가
// 들여쓰기·줄바꿈 원문 정규식 대신 구조화된 workflow·job·step 필드로 계약을 검증한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

export const OPEN_PR_CONDITION = "${{ steps.decision.outputs.state == 'OPEN_PR' }}";

function lineIndent(line) {
  return /^ */u.exec(line)[0].length;
}

function isIgnorableLine(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function isNonEmptyLine(line) {
  return line.trim() !== "";
}

function stripQuotes(raw) {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.endsWith(first) && !trimmed.slice(1, -1).includes(first)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineArray(trimmed) {
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map(stripQuotes);
}

function parseScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed === "{}") return {};
  if (trimmed === "[]") return [];
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/u.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return parseInlineArray(trimmed);
  return stripQuotes(trimmed);
}

function parseKeyValue(trimmed) {
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx <= 0) return null;
  const key = trimmed.slice(0, colonIdx);
  if (!/^[A-Za-z0-9_.-]+$/u.test(key)) return null;
  return { key, rest: trimmed.slice(colonIdx + 1).trim() };
}

function firstMeaningfulIndex(lines, start, end) {
  for (let i = start; i < end; i += 1) {
    if (!isIgnorableLine(lines[i])) return i;
  }
  return -1;
}

function findSectionEnd(lines, start, end, parentIndent) {
  for (let i = start; i < end; i += 1) {
    if (!isIgnorableLine(lines[i]) && lineIndent(lines[i]) <= parentIndent) return i;
  }
  return end;
}

function findBlockScalarEnd(lines, start, end, parentIndent) {
  for (let i = start; i < end; i += 1) {
    if (isNonEmptyLine(lines[i]) && lineIndent(lines[i]) <= parentIndent) return i;
  }
  return end;
}

function isBlockScalarIndicator(rest) {
  return rest === "|" || rest === "|-" || rest === ">" || rest === ">-";
}

function dedentLine(line, minIndent) {
  return isNonEmptyLine(line) ? line.slice(minIndent) : "";
}

function extractBlockScalar(lines, start, end, parentIndent) {
  const scalarEnd = findBlockScalarEnd(lines, start, end, parentIndent);
  const slice = lines.slice(start, scalarEnd);
  const nonEmptyIndents = slice.filter(isNonEmptyLine).map(lineIndent);
  if (nonEmptyIndents.length === 0) return "";
  const minIndent = Math.min(...nonEmptyIndents);
  return slice.map((line) => dedentLine(line, minIndent)).join("\n").trimEnd();
}

function parseYamlSequenceItem(lines, index, next, baseIndent) {
  const afterDash = lines[index].trim().slice(2).trim();
  const kv = parseKeyValue(afterDash);
  if (!kv) return parseScalar(afterDash);
  const firstValue = kv.rest ? parseScalar(kv.rest) : parseYamlNode(lines, index + 1, next);
  const restMap = kv.rest ? parseYamlMapping(lines, index + 1, next, baseIndent + 2) : {};
  return { [kv.key]: firstValue, ...restMap };
}

function parseYamlSequence(lines, start, end, baseIndent) {
  const items = [];
  let i = start;
  while (i < end) {
    if (isIgnorableLine(lines[i]) || lineIndent(lines[i]) !== baseIndent) {
      i += 1;
      continue;
    }
    const next = findSectionEnd(lines, i + 1, end, baseIndent);
    items.push(parseYamlSequenceItem(lines, i, next, baseIndent));
    i = next;
  }
  return items;
}

function parseYamlMapping(lines, start, end, baseIndent) {
  const map = {};
  let i = start;
  while (i < end) {
    if (isIgnorableLine(lines[i]) || lineIndent(lines[i]) !== baseIndent) {
      i += 1;
      continue;
    }
    const next = findSectionEnd(lines, i + 1, end, baseIndent);
    const kv = parseKeyValue(lines[i].trim());
    if (kv) {
      map[kv.key] = kv.rest ? parseScalar(kv.rest) : parseYamlNode(lines, i + 1, next);
    }
    i = next;
  }
  return map;
}

function parseYamlNode(lines, start, end) {
  const first = firstMeaningfulIndex(lines, start, end);
  if (first === -1) return {};
  const baseIndent = lineIndent(lines[first]);
  if (lines[first].trimStart().startsWith("- ")) {
    return parseYamlSequence(lines, first, end, baseIndent);
  }
  return parseYamlMapping(lines, first, end, baseIndent);
}

function parseStepStringEntry(kv, lines, childStart, childEnd, baseIndent) {
  if (isBlockScalarIndicator(kv.rest)) {
    return extractBlockScalar(lines, childStart, childEnd, baseIndent);
  }
  return stripQuotes(kv.rest);
}

function parseStepStringMap(lines, start, end, baseIndent) {
  const map = {};
  let i = start;
  while (i < end) {
    if (isIgnorableLine(lines[i]) || lineIndent(lines[i]) !== baseIndent) {
      i += 1;
      continue;
    }
    const next = findSectionEnd(lines, i + 1, end, baseIndent);
    const kv = parseKeyValue(lines[i].trim());
    if (kv) {
      map[kv.key] = parseStepStringEntry(kv, lines, i + 1, next, baseIndent);
    }
    i = next;
  }
  return map;
}

function buildStepBlock(lines, start, end, stepIndent) {
  const prefix = `${" ".repeat(stepIndent)}- name: `;
  if (lines[start].startsWith(prefix)) {
    const header = lines[start].slice(prefix.length);
    return [header, ...lines.slice(start + 1, end)].join("\n");
  }
  return lines.slice(start, end).join("\n");
}

function applyStepScalarProperty(step, key, rest) {
  const text = stripQuotes(rest);
  if (key === "name") step.name = text;
  else if (key === "id") step.id = text;
  else if (key === "if") step.if = text;
  else if (key === "uses") step.uses = text;
  else if (key === "continue-on-error") step.continueOnError = parseScalar(rest);
  else if (key === "working-directory") step.workingDirectory = text;
  else if (key === "shell") step.shell = text;
}

function applyStepProperty(step, kv, propLines, childStart, childEnd, propIndent) {
  if (kv.key === "with") {
    step.with = kv.rest ? parseScalar(kv.rest) : parseStepStringMap(propLines, childStart, childEnd, propIndent + 2);
    return;
  }
  if (kv.key === "env") {
    step.env = kv.rest ? parseScalar(kv.rest) : parseStepStringMap(propLines, childStart, childEnd, propIndent + 2);
    return;
  }
  if (kv.key === "run") {
    step.run = isBlockScalarIndicator(kv.rest)
      ? extractBlockScalar(propLines, childStart, childEnd, propIndent)
      : stripQuotes(kv.rest);
    return;
  }
  applyStepScalarProperty(step, kv.key, kv.rest);
}

function parseSingleStep(lines, start, end, stepIndent) {
  const propIndent = stepIndent + 2;
  const firstProp = `${" ".repeat(propIndent)}${lines[start].trim().slice(2).trim()}`;
  const propLines = [firstProp, ...lines.slice(start + 1, end)];
  const step = {
    name: null,
    id: null,
    if: null,
    uses: null,
    with: {},
    env: {},
    run: "",
    continueOnError: null,
    workingDirectory: null,
    shell: null,
    block: buildStepBlock(lines, start, end, stepIndent),
  };
  let j = 0;
  while (j < propLines.length) {
    if (isIgnorableLine(propLines[j]) || lineIndent(propLines[j]) !== propIndent) {
      j += 1;
      continue;
    }
    const propEnd = findSectionEnd(propLines, j + 1, propLines.length, propIndent);
    const kv = parseKeyValue(propLines[j].trim());
    if (kv) {
      applyStepProperty(step, kv, propLines, j + 1, propEnd, propIndent);
    }
    j = propEnd;
  }
  return step;
}

function parseStepsSection(lines, start, end, stepIndent) {
  const parsed = [];
  let i = start;
  while (i < end) {
    if (isIgnorableLine(lines[i]) || lineIndent(lines[i]) !== stepIndent || !lines[i].trimStart().startsWith("- ")) {
      i += 1;
      continue;
    }
    const next = findSectionEnd(lines, i + 1, end, stepIndent);
    parsed.push(parseSingleStep(lines, i, next, stepIndent));
    i = next;
  }
  return parsed;
}

function applyJobScalarProperty(job, key, rest) {
  if (key === "name") job.name = stripQuotes(rest);
  else if (key === "if") job.if = stripQuotes(rest);
  else if (key === "runs-on") job.runsOn = stripQuotes(rest);
  else if (key === "timeout-minutes") job.timeoutMinutes = Number(rest);
}

function parseKvNodeValue(kv, lines, childStart, childEnd) {
  return kv.rest ? parseScalar(kv.rest) : parseYamlNode(lines, childStart, childEnd);
}

function parseKvStringMapOrScalar(kv, lines, childStart, childEnd, baseIndent) {
  return kv.rest ? parseScalar(kv.rest) : parseStepStringMap(lines, childStart, childEnd, baseIndent);
}

const JOB_STRUCTURED_PARSERS = {
  environment: (kv, lines, childStart, childEnd) =>
    kv.rest ? stripQuotes(kv.rest) : parseKvNodeValue(kv, lines, childStart, childEnd),
  permissions: (kv, lines, childStart, childEnd) => parseKvStringMapOrScalar(kv, lines, childStart, childEnd, 6),
  concurrency: (kv, lines, childStart, childEnd) => parseKvNodeValue(kv, lines, childStart, childEnd),
  env: (kv, lines, childStart, childEnd) => parseKvStringMapOrScalar(kv, lines, childStart, childEnd, 6),
  needs: (kv, lines, childStart, childEnd) => parseKvNodeValue(kv, lines, childStart, childEnd),
  outputs: (kv, lines, childStart, childEnd) => parseKvStringMapOrScalar(kv, lines, childStart, childEnd, 6),
  steps: (_kv, lines, childStart, childEnd) => parseStepsSection(lines, childStart, childEnd, 6),
};

function applyJobStructuredProperty(job, kv, lines, childStart, childEnd) {
  const parser = JOB_STRUCTURED_PARSERS[kv.key];
  if (parser) {
    job[kv.key] = parser(kv, lines, childStart, childEnd);
    return;
  }
  applyJobScalarProperty(job, kv.key, kv.rest);
}

function parseSingleJob(id, lines, start, end) {
  const job = {
    id,
    name: null,
    if: null,
    runsOn: null,
    timeoutMinutes: null,
    environment: null,
    permissions: {},
    concurrency: null,
    env: {},
    needs: null,
    outputs: {},
    steps: [],
  };
  let i = start;
  while (i < end) {
    if (isIgnorableLine(lines[i]) || lineIndent(lines[i]) !== 4) {
      i += 1;
      continue;
    }
    const next = findSectionEnd(lines, i + 1, end, 4);
    const kv = parseKeyValue(lines[i].trim());
    if (kv) {
      applyJobStructuredProperty(job, kv, lines, i + 1, next);
    }
    i = next;
  }
  return job;
}

function parseJobsSection(lines, start, end) {
  const jobs = {};
  let i = start;
  while (i < end) {
    if (isIgnorableLine(lines[i]) || lineIndent(lines[i]) !== 2) {
      i += 1;
      continue;
    }
    const next = findSectionEnd(lines, i + 1, end, 2);
    const kv = parseKeyValue(lines[i].trim());
    if (kv) {
      jobs[kv.key] = parseSingleJob(kv.key, lines, i + 1, next);
    }
    i = next;
  }
  return jobs;
}

function applyWorkflowProperty(workflow, kv, lines, childStart, childEnd) {
  if (kv.key === "name") {
    workflow.name = stripQuotes(kv.rest);
  } else if (kv.key === "on") {
    workflow.on = kv.rest ? parseScalar(kv.rest) : parseYamlNode(lines, childStart, childEnd);
  } else if (kv.key === "permissions") {
    workflow.permissions = kv.rest ? parseScalar(kv.rest) : parseStepStringMap(lines, childStart, childEnd, 2);
  } else if (kv.key === "concurrency") {
    workflow.concurrency = kv.rest ? parseScalar(kv.rest) : parseYamlNode(lines, childStart, childEnd);
  } else if (kv.key === "env") {
    workflow.env = kv.rest ? parseScalar(kv.rest) : parseStepStringMap(lines, childStart, childEnd, 2);
  } else if (kv.key === "jobs") {
    workflow.jobs = parseJobsSection(lines, childStart, childEnd);
  }
}

export function parseWorkflowYaml(yml) {
  const lines = yml.split("\n");
  const workflow = {
    name: null,
    on: {},
    permissions: null,
    concurrency: null,
    env: {},
    jobs: {},
    job: null,
  };
  let i = 0;
  while (i < lines.length) {
    if (isIgnorableLine(lines[i]) || lineIndent(lines[i]) !== 0) {
      i += 1;
      continue;
    }
    const next = findSectionEnd(lines, i + 1, lines.length, 0);
    const kv = parseKeyValue(lines[i].trim());
    if (kv) {
      applyWorkflowProperty(workflow, kv, lines, i + 1, next);
    }
    i = next;
  }
  workflow.job = Object.values(workflow.jobs).at(-1) ?? null;
  return workflow;
}

export function ifCondition(stepOrBlock) {
  if (stepOrBlock && typeof stepOrBlock === "object") {
    return stepOrBlock.if ?? null;
  }
  if (typeof stepOrBlock !== "string") return null;
  for (const line of stepOrBlock.split("\n").slice(1)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("if:")) {
      const afterColon = trimmed.slice(3);
      if (afterColon.length > 0) return afterColon.trim();
    }
  }
  return null;
}

function findMatchingSteps(allSteps, name) {
  const byName = allSteps.filter((item) => item.name === name);
  if (byName.length > 0) return byName;
  return allSteps.filter((item) => item.uses === name || Boolean(item.uses?.startsWith(`${name}@`)));
}

function resolveWorkflowStep(allSteps, name) {
  const found = findMatchingSteps(allSteps, name);
  assert.equal(found.length, 1, `step ${name}`);
  return found[0];
}

export function loadWorkflow(root, file) {
  const yml = readFileSync(path.join(root, ".github/workflows", file), "utf8");
  const workflow = parseWorkflowYaml(yml);
  const job = workflow.job;
  const allSteps = job?.steps ?? [];
  const namedSteps = allSteps.filter((item) => item.name !== null);
  return {
    yml,
    workflow,
    job,
    steps: () => namedSteps,
    step: (name) => resolveWorkflowStep(allSteps, name),
  };
}

function stepIndexByName(stepList, name) {
  return stepList.findIndex((item) => item.name === name);
}

/** OPEN_PR이면 App 토큰 → required CI 보장 → 열린 PR 상한 검사 순서로 돌고 모두 OPEN_PR 조건이다. */
export function assertOpenPullRequestSteps({ steps, file, decisionName }) {
  const all = steps();
  const decision = stepIndexByName(all, decisionName);
  const token = stepIndexByName(all, "Mint App token for the open refresh pull request");
  const ensure = stepIndexByName(all, "Ensure required CI on the open refresh pull request");
  const age = stepIndexByName(all, "Enforce open refresh pull request age limit");
  assert.ok(decision !== -1 && decision < token && token < ensure && ensure < age, `${file}: step order`);
  for (const item of [token, ensure, age]) {
    assert.equal(ifCondition(all[item]), OPEN_PR_CONDITION, `${file}: ${all[item].name}`);
  }
  assert.equal(all[token].with["permission-pull-requests"], "write");
  assert.equal(all[ensure].env.APP_PR_TOKEN, "${{ steps.app-token-open.outputs.token }}");
  assert.ok(
    all[ensure].run.includes(
      `node tools/ci/refresh-pr-required-ci.mjs --workflow ${file} --repository "\${GITHUB_REPOSITORY}" --github-output "\${GITHUB_OUTPUT}"`,
    ),
  );
  // step output은 env로 받아 셸에는 변수로만 넣는다(표현식을 run 스크립트에 직접 펼치지 않는다).
  assert.equal(all[age].env.CI_STATE, "${{ steps.required-ci.outputs.state }}");
  assert.ok(
    all[age].run.includes(
      `node tools/ci/refresh-open-pr-age.mjs --workflow ${file} --prs "\${open_prs}" --policy release/product-gates/datapack-freshness-sla.json --repository "\${GITHUB_REPOSITORY}" --ci-state "\${CI_STATE}"`,
    ),
  );
}

/** run 스크립트에는 ${{ }} 표현식을 직접 넣지 않는다. 값은 env로 받아 셸 변수로 쓴다(셸 주입 방지, #972·#974 리뷰). */
export function assertNoExpressionInRunScripts({ job, steps, file }) {
  const allSteps = job?.steps ?? steps();
  for (const item of allSteps) {
    const script = typeof item.run === "string" ? item.run : item.block?.split("\n        run: ")[1] ?? "";
    assert.doesNotMatch(script, /\$\{\{/u, `${file}: step "${item.name ?? item.uses ?? "unnamed"}" interpolates an expression into its run script`);
  }
}

/** 실패 보고 step이 failure()일 때만 자기 workflow 이름으로 돌고 마지막 step이다. */
export function assertFailureReportLast({ yml, job, steps, step, file, condition = "${{ failure() }}" }) {
  const report = step("Report refresh failure as an issue");
  assert.equal(ifCondition(report), condition);
  assert.equal(report.env.GH_TOKEN, "${{ github.token }}");
  assert.ok(
    report.run.includes(
      `node tools/ci/report-refresh-failure.mjs --workflow ${file} --repository "\${GITHUB_REPOSITORY}" --run-id "\${GITHUB_RUN_ID}"`,
    ),
  );
  const allSteps = job?.steps ?? (typeof steps === "function" ? steps() : []);
  if (allSteps.length > 0) {
    assert.equal(allSteps.at(-1)?.name, report.name);
  }
  if (typeof yml === "string") {
    assert.equal(yml.trimEnd().endsWith(report.block.trimEnd()), true);
  }
  return report;
}
