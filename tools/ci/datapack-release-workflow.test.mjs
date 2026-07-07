import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const yml = readFileSync(path.join(root, ".github/workflows/datapack-release.yml"), "utf8");

// 외부 yaml 의존성 없이(리포는 node 내장 --test만 사용) workflow_dispatch 입력 이름을
// 들여쓰기로 추출한다: "    inputs:" 다음, 4칸 이하 들여쓰기로 블록이 끝나기 전까지의 6칸 키.
function workflowDispatchInputNames(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /^ {4}inputs:\s*$/.test(l));
  assert.notEqual(start, -1, "workflow_dispatch.inputs 블록을 찾지 못함");
  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (/^ {0,4}\S/.test(l)) break; // 들여쓰기 4칸 이하 = inputs 블록 종료
    const m = l.match(/^ {6}(\w+):/); // 6칸 들여쓰기 = 입력 이름
    if (m) names.push(m[1]);
  }
  return names;
}

test("workflow_dispatch 입력은 mode·targetChannel·modeArgs 3개로 통합돼 한도(10) 이하다", () => {
  const names = workflowDispatchInputNames(yml);
  assert.ok(names.length <= 10, `입력 ${names.length}개 — 한도 초과`);
  assert.deepEqual([...names].sort(), ["mode", "modeArgs", "targetChannel"]);
  // modeArgs는 required이고 description에 복붙용 예시(buildSpecPath 포함)를 담는다.
  assert.match(yml, /modeArgs:[\s\S]*?required:\s*true/);
  assert.match(yml, /modeArgs:[\s\S]*?buildSpecPath/);
});

test("modeArgs 파싱 스텝이 개별 인자를 output으로 펼친다", () => {
  assert.match(yml, /id:\s*args/);
  assert.match(yml, /modeArgs/);
  assert.match(yml, /buildSpecPath/);
  assert.match(yml, /releaseRequestId/);
});

test("modeArgs 파싱 스텝은 비-JSON·개행 주입을 방어한다", () => {
  // JSON.parse 실패·비객체 입력 → 명확한 실패(try/catch + object 검증)
  assert.match(yml, /modeArgs must be a JSON object/);
  // GITHUB_OUTPUT 개행 주입 차단 — 값에 개행이 있으면 거부
  assert.match(yml, /must not contain newlines/);
});

test("production-publish는 release request 조회 스텝과 !cancelled() 콜백 스텝을 가진다", () => {
  assert.match(yml, /release-requests\/\$\{?\{?.*releaseRequestId/); // 조회 GET
  assert.match(yml, /release-callbacks/); // 콜백 POST
  assert.match(yml, /build-release-callback\.mjs/);
  assert.match(yml, /!cancelled\(\)\s*&&/); // 콜백 조건에 !cancelled()
  assert.match(yml, /manifestSha256/);
  // 콜백 조건은 production-publish 스텝 출력 기준이어야 한다 — 비-production 모드에선 빈값
  assert.match(yml, /steps\.production-publish\.outputs\.manifestSha256/);
  // evidence-bundle 출력을 콜백 게이트로 사용하면 release-candidate에서도 발사 → 금지
  assert.doesNotMatch(yml, /steps\.evidence-bundle\.outputs\.manifestSha256/);
});

test("워크플로는 rollout-update 모드·publish-rollout 스텝을 가지고 빌드 스텝을 pointer-only로 게이트한다", () => {
  assert.match(yml, /rollout-update/);
  assert.match(yml, /publish-rollout\.mjs/);
  assert.match(yml, /rolloutPercentage/);
  assert.match(yml, /rolloutTargetSequence/);
  assert.match(yml, /is-pointer-only/);            // 빌드 스텝 게이팅 output
  assert.doesNotMatch(yml, /mode != 'rollback'/);  // 구 게이트가 pointer-only로 통합됨
});
