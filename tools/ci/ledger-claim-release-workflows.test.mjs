import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CLAIM_OWNERS } from "./claim-orphans.mjs";
import { loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// 단독 운영 계약: 모든 자동 갱신·등록·승격·재결속·후보 workflow는 automation/* claim 브랜치 없이
// main에 직접 커밋·push하기 전에 origin/main CAS를 검증하고 실패 요약 step으로 끝난다.
const ROOT = path.resolve(import.meta.dirname, "../..");
const WORKFLOWS_DIR = path.join(ROOT, ".github/workflows");
const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((file) => file.endsWith(".yml")).sort();

const DIRECT_MAIN_REFRESH_WORKFLOWS = Object.freeze([
  "retained-gwangju-timetable-refresh.yml",
  "seoul-current-accessibility-refresh.yml",
  "kric-current-facility-refresh.yml",
  "current-capital-topology-refresh.yml",
  "current-capital-topology-registration.yml",
  "source-reverification.yml",
  "source-derivative-rebinding.yml",
  "itx-current-promotion.yml",
  "nationwide-candidate-refresh.yml",
]);

test("CLAIM_OWNERS의 workflow 전부는 단독 운영으로 전환되어 claim 브랜치·PR 없이 동작한다", () => {
  for (const file of Object.keys(CLAIM_OWNERS)) {
    assert.ok(DIRECT_MAIN_REFRESH_WORKFLOWS.includes(file), file);
  }
  for (const file of workflowFiles) {
    const text = readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
    assert.doesNotMatch(text, /refs\/heads\/automation\//u, `${file}: automation claim 브랜치 금지`);
    assert.doesNotMatch(text, /release-own-claim\.mjs|reclaim-stale-claims\.mjs|ledger-writers-idle\.mjs|remove-orphan-claims\.mjs/u, `${file}: claim 관리 스크립트 금지`);
  }
});

test("단독 운영 갱신·후보 workflow 전부는 Report refresh failure summary로 끝나고 main 직접 push 전 CAS를 검사한다", () => {
  for (const file of DIRECT_MAIN_REFRESH_WORKFLOWS) {
    const { yml, steps } = loadWorkflow(ROOT, file);
    const names = steps().map(({ name }) => name);
    assert.equal(names.at(-1).endsWith("Report refresh failure summary"), true, `${file}: 마지막 step`);
    assert.match(yml, /git push origin HEAD:main/u, `${file}: HEAD:main 직접 push`);
    const pushIndex = yml.indexOf("git push origin HEAD:main");
    const fetchIndex = yml.lastIndexOf("git fetch --no-tags origin main", pushIndex);
    assert.ok(fetchIndex !== -1 && fetchIndex < pushIndex, `${file}: push 직전 origin/main fetch`);
    assert.match(yml.slice(fetchIndex, pushIndex), /git rev-parse origin\/main/u, `${file}: origin/main SHA 비교`);
  }
});
