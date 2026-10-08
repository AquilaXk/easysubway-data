#!/usr/bin/env node
// #1047: workflow의 `secrets.` 참조를 저장소 수준·환경 전용·미등록으로 분류하는 계약(tools/ci/workflow-secret-classification.json).
// 환경에만 있는 secret은 job이 그 environment에 묶여야 값이 들어온다. 묶이지 않으면 빈 문자열이 되고 도구는 늦게 실패한다
// (정기 후보 갱신 run 37737000536). 분류되지 않은 이름과 `secrets: inherit`는 이 계약이 거부한다.
// 계약 파일과 실제 secret 목록의 일치는 `node tools/ci/workflow-secret-classification.mjs`(gh 로그인 필요)가 확인한다.
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const CLASSIFICATION_PATH = "tools/ci/workflow-secret-classification.json";

export function loadClassification(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, CLASSIFICATION_PATH), "utf8"));
}

/** 이름 → { kind: "github" | "repository" | "environment-only" | "unprovisioned", environments? }. 같은 이름이 두 분류에 있으면 실패한다. */
export function classificationTable(contract) {
  const table = new Map();
  const put = (name, entry) => {
    if (table.has(name)) throw new Error(`secret ${name}이 둘 이상의 분류에 있다`);
    table.set(name, entry);
  };
  for (const name of contract.githubProvided) put(name, { kind: "github" });
  for (const name of contract.repositorySecrets) put(name, { kind: "repository" });
  const environmentsByName = new Map();
  for (const [environment, names] of Object.entries(contract.environmentSecrets)) {
    for (const name of names) environmentsByName.set(name, [...(environmentsByName.get(name) ?? []), environment]);
  }
  for (const [name, environments] of environmentsByName) {
    if (!contract.repositorySecrets.includes(name)) put(name, { kind: "environment-only", environments });
  }
  for (const name of Object.keys(contract.unprovisionedSecrets)) put(name, { kind: "unprovisioned" });
  return table;
}

const SECRET_REFERENCE = /(?<![\w.-])secrets\.([A-Za-z_][A-Za-z0-9_]*)/gu;
export const referencedSecrets = (text) => new Set([...text.matchAll(SECRET_REFERENCE)].map((match) => match[1]));

/** `jobs:` 아래 job을 이름·environment 값(식 포함)·본문으로 나눈다. 들여쓰기 2칸이 job, 4칸이 job 속성이다. */
export function parseWorkflow(text) {
  const lines = text.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (jobsAt === -1) throw new Error("workflow에 jobs:가 없다");
  const header = lines.slice(0, jobsAt).join("\n");
  const jobs = [];
  let current = null;
  for (const line of lines.slice(jobsAt + 1)) {
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (job) {
      current = { name: job[1], lines: [] };
      jobs.push(current);
    } else if (current) current.lines.push(line);
  }
  return {
    header,
    jobs: jobs.map(({ name, lines: body }) => {
      const at = body.findIndex((line) => /^ {4}environment:/u.test(line));
      let environment = null;
      if (at !== -1) {
        const inline = body[at].replace(/^ {4}environment:\s*/u, "");
        const block = [];
        for (const line of body.slice(at + 1)) {
          if (!/^ {5,}\S/u.test(line)) break;
          block.push(line.trim());
        }
        environment = [inline, ...block].join("\n");
      }
      return { name, environment, text: body.join("\n") };
    }),
  };
}

const mentions = (environmentText, name) =>
  new RegExp(String.raw`(^|[^A-Za-z0-9_-])${name}([^A-Za-z0-9_-]|$)`, "u").test(environmentText);

/** 위반 목록: `secrets: inherit`, 분류되지 않은 이름, workflow 수준의 환경 전용 참조, environment에 묶이지 않은 job의 환경 전용 참조. */
export function secretClassificationViolations(workflows, contract) {
  const table = classificationTable(contract);
  const violations = [];
  for (const [file, text] of Object.entries(workflows)) {
    if (/^\s*secrets:\s*inherit\s*$/mu.test(text)) violations.push(`${file}: secrets: inherit는 쓰지 않는다(넘기는 secret을 이름으로 적는다)`);
    const { header, jobs } = parseWorkflow(text);
    for (const secret of referencedSecrets(text)) {
      if (!table.has(secret)) violations.push(`${file}: secret ${secret}이 ${CLASSIFICATION_PATH}에 분류되어 있지 않다`);
    }
    for (const secret of referencedSecrets(header)) {
      if (table.get(secret)?.kind === "environment-only") violations.push(`${file}: workflow 수준에서 환경 범위 secret ${secret}을 읽는다(job environment가 적용되지 않는다)`);
    }
    for (const job of jobs) {
      for (const secret of referencedSecrets(job.text)) {
        const entry = table.get(secret);
        if (entry?.kind !== "environment-only") continue;
        const bound = job.environment !== null && entry.environments.some((name) => mentions(job.environment, name));
        if (!bound) violations.push(`${file}: job ${job.name}이 환경 범위 secret ${secret}을 읽지만 ${entry.environments.join(" 또는 ")} environment에 묶여 있지 않다`);
      }
    }
  }
  return violations;
}

export function repositoryWorkflows(root = ROOT) {
  const directory = path.join(root, ".github/workflows");
  return Object.fromEntries(readdirSync(directory).filter((file) => /\.ya?ml$/u.test(file)).sort()
    .map((file) => [file, readFileSync(path.join(directory, file), "utf8")]));
}

/** 계약과 실제 secret 이름 집합의 차이. actual = { repository: string[], environments: { [name]: string[] } }. */
export function secretListDifferences(contract, actual) {
  const differences = [];
  const compare = (label, expected, observed) => {
    const want = new Set(expected);
    const have = new Set(observed);
    for (const name of have) if (!want.has(name)) differences.push(`${label}: 계약에 없는 secret ${name}`);
    for (const name of want) if (!have.has(name)) differences.push(`${label}: 계약에만 있는 secret ${name}`);
  };
  compare("저장소", contract.repositorySecrets, actual.repository);
  const names = new Set([...Object.keys(contract.environmentSecrets), ...Object.keys(actual.environments)]);
  for (const environment of [...names].sort()) {
    compare(`environment ${environment}`, contract.environmentSecrets[environment] ?? [], actual.environments[environment] ?? []);
  }
  const provisioned = new Set([...actual.repository, ...Object.values(actual.environments).flat()]);
  for (const name of Object.keys(contract.unprovisionedSecrets)) {
    if (provisioned.has(name)) differences.push(`unprovisionedSecrets: ${name}이 이제 존재한다. 분류를 옮긴다`);
  }
  return differences;
}

const execFileAsync = promisify(execFile);
async function ghJson(args) {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function main({ root = ROOT, gh = ghJson, log = console.log } = {}) {
  const contract = loadClassification(root);
  const repository = contract.repository;
  const names = async (extra) => (await gh(["secret", "list", "-R", repository, "--json", "name", ...extra])).map(({ name }) => name);
  const { environments } = await gh(["api", `repos/${repository}/environments`]);
  const actual = { repository: await names([]), environments: {} };
  for (const { name } of environments) actual.environments[name] = await names(["--env", name]);
  const differences = secretListDifferences(contract, actual);
  for (const line of differences) log(line);
  if (differences.length > 0) throw new Error(`${CLASSIFICATION_PATH}이 실제 secret 목록과 다르다(${differences.length}건)`);
  log("OK: 계약이 실제 secret 목록과 같다");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
