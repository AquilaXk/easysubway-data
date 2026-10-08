import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// #1047: GitHub environment에만 있는 secret은 job이 그 environment에 묶여야 값이 들어온다. 묶이지 않으면 빈 문자열이 되고
// 도구는 "must be ..."류 오류로 늦게 실패한다(정기 후보 갱신 run 37737000536). 이 계약은 모든 workflow의 `secrets.` 참조를 훑어
// 환경 범위 secret을 읽는 job이 그 secret을 가진 environment를 달고 있는지 확인한다.
//
// 표는 `gh secret list -R AquilaXk/easysubway-data`(저장소 수준)와 `--env <name>`(환경 수준)에서 환경에만 있는 secret이다(2026-10-08 확인).
// 저장소 수준에도 있는 secret(예 EASYSUBWAY_CANDIDATE_OCI_*, KRIC_SERVICE_KEY, EASYSUBWAY_DATAPACK_SIGNING_*)은 environment 없이도 읽히므로 넣지 않는다.
// secret 배치를 바꾸면 이 표와 함께 바꾼다. 값은 어디에도 두지 않는다.
export const ENVIRONMENT_ONLY_SECRETS = Object.freeze({
  EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: Object.freeze(["datapack-release-check"]),
  EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY: Object.freeze(["datapack-release-check"]),
  DATA_GO_KR_SERVICE_KEY: Object.freeze(["datapack-release-check", "itx-current-collection"]),
  EASYSUBWAY_DATAPACK_CALLBACK_HMAC_KEY: Object.freeze(["production-datapack"]),
  EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN: Object.freeze(["production-datapack"]),
});

const SECRET_REFERENCE = /\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/gu;
const referencedSecrets = (text) => new Set([...text.matchAll(SECRET_REFERENCE)].map((match) => match[1]));

/** `jobs:` 아래 job을 이름·environment 값(식 포함)·본문으로 나눈다. 들여쓰기 2칸이 job, 4칸이 job 속성이다. */
export function parseWorkflow(text) {
  const lines = text.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  assert.ok(jobsAt !== -1, "workflow에 jobs:가 없다");
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

/** 환경 범위 secret을 읽는데 그 secret을 가진 environment에 묶이지 않은 job·workflow 수준 참조. */
export function environmentSecretViolations(workflows, table = ENVIRONMENT_ONLY_SECRETS) {
  const violations = [];
  for (const [file, text] of Object.entries(workflows)) {
    const { header, jobs } = parseWorkflow(text);
    for (const secret of referencedSecrets(header)) {
      if (Object.hasOwn(table, secret)) violations.push(`${file}: workflow 수준에서 환경 범위 secret ${secret}을 읽는다(job environment가 적용되지 않는다)`);
    }
    for (const job of jobs) {
      for (const secret of referencedSecrets(job.text)) {
        if (!Object.hasOwn(table, secret)) continue;
        const bound = job.environment !== null && table[secret].some((name) => mentions(job.environment, name));
        if (!bound) violations.push(`${file}: job ${job.name}이 환경 범위 secret ${secret}을 읽지만 ${table[secret].join(" 또는 ")} environment에 묶여 있지 않다`);
      }
    }
  }
  return violations;
}

const WORKFLOW_DIR = path.resolve(import.meta.dirname, "../../.github/workflows");
const repositoryWorkflows = () => Object.fromEntries(readdirSync(WORKFLOW_DIR)
  .filter((file) => /\.ya?ml$/u.test(file)).sort()
  .map((file) => [file, readFileSync(path.join(WORKFLOW_DIR, file), "utf8")]));

test("저장소의 모든 workflow는 환경 범위 secret을 그 secret을 가진 environment에 묶인 job에서만 읽는다", () => {
  const workflows = repositoryWorkflows();
  assert.ok(Object.keys(workflows).length > 0);
  assert.deepEqual(environmentSecretViolations(workflows), []);
});

test("표의 환경 범위 secret은 실제 workflow가 읽는 것이며, 읽는 job은 모두 environment를 달았다(표가 낡지 않았다)", () => {
  const read = new Set(Object.values(repositoryWorkflows()).flatMap((text) => [...referencedSecrets(text)]));
  for (const secret of Object.keys(ENVIRONMENT_ONLY_SECRETS)) assert.ok(read.has(secret), `${secret}을 읽는 workflow가 없다. 표에서 지운다`);
});

test("반례: environment가 없거나 다른 environment이거나 workflow 수준 참조이면 위반이다", () => {
  const secret = "EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL";
  const job = (extra) => `jobs:\n  refresh:\n    runs-on: ubuntu-latest\n${extra}    steps:\n      - run: echo\n        env:\n          X: \${{ secrets.${secret} }}\n`;
  assert.deepEqual(environmentSecretViolations({ "ok.yml": `name: ok\n${job("    environment: datapack-release-check\n")}` }), []);
  assert.deepEqual(environmentSecretViolations({ "block.yml": `name: ok\n${job("    environment:\n      name: datapack-release-check\n")}` }), []);
  assert.deepEqual(environmentSecretViolations({ "expr.yml": `name: ok\n${job("    environment:\n      name: \${{ github.event_name == 'x' && 'production-datapack' || 'datapack-release-check' }}\n")}` }), []);
  const missing = environmentSecretViolations({ "missing.yml": `name: bad\n${job("")}` });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /missing\.yml: job refresh이 환경 범위 secret EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL을 읽지만 datapack-release-check environment에 묶여 있지 않다/u);
  assert.equal(environmentSecretViolations({ "other.yml": `name: bad\n${job("    environment: production-datapack\n")}` }).length, 1);
  assert.equal(environmentSecretViolations({ "similar.yml": `name: bad\n${job("    environment: datapack-release-check-copy\n")}` }).length, 1);
  const header = environmentSecretViolations({ "header.yml": `name: bad\nenv:\n  X: \${{ secrets.${secret} }}\n${job("    environment: datapack-release-check\n")}` });
  assert.equal(header.length, 1);
  assert.match(header[0], /workflow 수준에서/u);
  assert.deepEqual(environmentSecretViolations({ "repo-level.yml": `name: ok\njobs:\n  a:\n    steps:\n      - run: echo \${{ secrets.KRIC_SERVICE_KEY }}\n` }), []);
});

test("반례: 한 workflow의 job이 둘이면 environment 없는 job만 위반이다", () => {
  const secret = "DATA_GO_KR_SERVICE_KEY";
  const text = `name: two\njobs:\n  bound:\n    environment: itx-current-collection\n    steps:\n      - run: echo \${{ secrets.${secret} }}\n  unbound:\n    steps:\n      - run: echo \${{ secrets.${secret} }}\n`;
  const violations = environmentSecretViolations({ "two.yml": text });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /job unbound/u);
});
