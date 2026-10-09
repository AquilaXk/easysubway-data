import assert from "node:assert/strict";
import test from "node:test";

import {
  classificationTable,
  loadClassification,
  main,
  referencedSecrets,
  repositoryWorkflows,
  secretClassificationViolations,
  secretListDifferences,
} from "./workflow-secret-classification.mjs";

// #1047: 모든 workflow의 `secrets.` 참조는 tools/ci/workflow-secret-classification.json에서 저장소 수준·환경 전용·미등록 중 하나로 분류되어야 한다.
// 분류되지 않은 새 이름과 `secrets: inherit`는 실패한다. 환경 전용 secret을 읽는 job은 그 secret을 가진 environment에 묶여야 한다.
// 계약 파일이 실제 `gh secret list`와 같은지는 node tools/ci/workflow-secret-classification.mjs(gh 로그인 필요)가 확인한다.
const contract = loadClassification();

test("저장소의 모든 workflow는 secret을 분류된 이름으로만 읽고, 환경 전용 secret은 그 environment에 묶인 job에서만 읽는다", () => {
  const workflows = repositoryWorkflows();
  assert.ok(Object.keys(workflows).length > 0);
  assert.deepEqual(secretClassificationViolations(workflows, contract), []);
});

test("계약은 닫힌 형식이고 한 이름이 두 분류에 있지 않다", () => {
  assert.deepEqual(Object.keys(contract), ["schemaVersion", "artifactKind", "repository", "verifiedAgainst", "refreshProcedure", "githubProvided", "repositorySecrets", "environmentSecrets", "unprovisionedSecrets"]);
  assert.doesNotThrow(() => classificationTable(contract));
  assert.throws(() => classificationTable({ ...contract, unprovisionedSecrets: { ...contract.unprovisionedSecrets, KRIC_SERVICE_KEY: "x" } }), /둘 이상의 분류/u);
  const table = classificationTable(contract);
  for (const name of ["EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL", "EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY", "DATA_GO_KR_SERVICE_KEY"]) assert.equal(table.get(name).kind, "environment-only", name);
  // 저장소 수준에도 있는 이름은 환경에도 있어도 environment 없이 읽힌다.
  assert.equal(table.get("KRIC_SERVICE_KEY").kind, "repository");
});

test("환경 전용으로 분류한 secret은 모두 실제 workflow가 읽는다(분류가 낡지 않았다)", () => {
  const read = new Set(Object.values(repositoryWorkflows()).flatMap((text) => [...referencedSecrets(text)]));
  for (const [name, entry] of classificationTable(contract)) {
    if (entry.kind === "environment-only" || entry.kind === "unprovisioned") assert.ok(read.has(name), `${name}을 읽는 workflow가 없다. 분류에서 지운다`);
  }
});

const SECRET = "EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL";
const jobWith = (extra, name = SECRET) =>
  `jobs:\n  refresh:\n    runs-on: ubuntu-latest\n${extra}    steps:\n      - run: echo\n        env:\n          X: \${{ secrets.${name} }}\n`;

test("반례: environment가 없거나 다른 environment이거나 workflow 수준 참조이면 위반이다", () => {
  const check = (workflows) => secretClassificationViolations(workflows, contract);
  assert.deepEqual(check({ "ok.yml": `name: ok\n${jobWith("    environment: datapack-release-check\n")}` }), []);
  assert.deepEqual(check({ "block.yml": `name: ok\n${jobWith("    environment:\n      name: datapack-release-check\n")}` }), []);
  assert.deepEqual(check({ "expr.yml": `name: ok\n${jobWith("    environment:\n      name: \${{ github.event_name == 'x' && 'production-datapack' || 'datapack-release-check' }}\n")}` }), []);
  const missing = check({ "missing.yml": `name: bad\n${jobWith("")}` });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /missing\.yml: job refresh이 환경 범위 secret EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL을 읽지만 datapack-release-check environment에 묶여 있지 않다/u);
  assert.equal(check({ "other.yml": `name: bad\n${jobWith("    environment: production-datapack\n")}` }).length, 1);
  assert.equal(check({ "similar.yml": `name: bad\n${jobWith("    environment: datapack-release-check-copy\n")}` }).length, 1);
  const header = check({ "header.yml": `name: bad\nenv:\n  X: \${{ secrets.${SECRET} }}\n${jobWith("    environment: datapack-release-check\n")}` });
  assert.equal(header.length, 1);
  assert.match(header[0], /workflow 수준에서/u);
  assert.deepEqual(check({ "repo-level.yml": `name: ok\njobs:\n  a:\n    steps:\n      - run: echo \${{ secrets.KRIC_SERVICE_KEY }} \${{ secrets.GITHUB_TOKEN }}\n` }), []);
});

test("반례: 분류되지 않은 새 secret 이름과 secrets: inherit는 environment 유무와 무관하게 위반이다", () => {
  const check = (workflows) => secretClassificationViolations(workflows, contract);
  const unclassified = check({ "new.yml": `name: bad\n${jobWith("    environment: datapack-release-check\n", "NEW_ENV_ONLY_KEY")}` });
  assert.equal(unclassified.length, 1);
  assert.match(unclassified[0], /new\.yml: secret NEW_ENV_ONLY_KEY이 tools\/ci\/workflow-secret-classification\.json에 분류되어 있지 않다/u);
  assert.equal(check({ "bare.yml": `name: bad\n${jobWith("", "ANOTHER_NEW_KEY")}` }).length, 1);
  const inherit = check({ "caller.yml": "name: bad\njobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit\n" });
  assert.equal(inherit.length, 1);
  assert.match(inherit[0], /secrets: inherit/u);
  assert.deepEqual(check({ "mapped.yml": "name: ok\njobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    secrets:\n      K: ${{ secrets.KRIC_SERVICE_KEY }}\n" }), []);
});

test("반례: 한 workflow의 job이 둘이면 environment 없는 job만 위반이다", () => {
  const text = "name: two\njobs:\n  bound:\n    environment: itx-current-collection\n    steps:\n      - run: echo ${{ secrets.DATA_GO_KR_SERVICE_KEY }}\n  unbound:\n    steps:\n      - run: echo ${{ secrets.DATA_GO_KR_SERVICE_KEY }}\n";
  const violations = secretClassificationViolations({ "two.yml": text }, contract);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /job unbound/u);
});

test("계약과 실제 secret 목록의 차이를 이름 단위로 드러낸다", async () => {
  const actual = { repository: [...contract.repositorySecrets], environments: structuredClone(contract.environmentSecrets) };
  assert.deepEqual(secretListDifferences(contract, actual), []);
  const drifted = structuredClone(actual);
  drifted.repository.push("BRAND_NEW_SECRET");
  drifted.environments["datapack-release-check"] = drifted.environments["datapack-release-check"].filter((name) => name !== "DATA_GO_KR_SERVICE_KEY");
  drifted.environments["new-environment"] = ["X"];
  drifted.repository.push("D20_SECRET_SCANNING_ALERTS_READ_TOKEN");
  const differences = secretListDifferences(contract, drifted);
  assert.ok(differences.includes("저장소: 계약에 없는 secret BRAND_NEW_SECRET"));
  assert.ok(differences.includes("environment datapack-release-check: 계약에만 있는 secret DATA_GO_KR_SERVICE_KEY"));
  assert.ok(differences.includes("environment new-environment: 계약에 없는 secret X"));
  assert.ok(differences.some((line) => /unprovisionedSecrets: D20_SECRET_SCANNING_ALERTS_READ_TOKEN이 이제 존재한다/u.test(line)));

  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "api") return { environments: Object.keys(contract.environmentSecrets).map((name) => ({ name })) };
    const env = args.includes("--env") ? args[args.indexOf("--env") + 1] : null;
    return (env === null ? contract.repositorySecrets : contract.environmentSecrets[env]).map((name) => ({ name }));
  };
  const lines = [];
  await main({ gh, log: (line) => lines.push(line) });
  assert.deepEqual(lines, ["OK: 계약이 실제 secret 목록과 같다"]);
  assert.ok(calls.every((call) => !call.includes("--show-values")));
  await assert.rejects(main({ gh: async (args) => (args[0] === "api" ? { environments: [] } : [{ name: "EXTRA" }]), log: () => {} }), /실제 secret 목록과 다르다/u);
});
