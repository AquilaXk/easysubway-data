import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main, reportReverificationFailures } from "./source-reverification-failures.mjs";

// #1102: 원천 재확인 controller가 recipe 일부를 등록하고 나머지가 실패한 경우, workflow가 PR을 만든 뒤 마지막에 job을 실패시켜 #926 실패 이슈로 드러낸다.
const failure = (recipeId, code, detail) => ({ recipeId, code, detail });

test("실패한 recipe가 없으면 아무것도 보고하지 않는다", () => {
  assert.deepEqual(reportReverificationFailures({ steps: [{ id: "a", changed: true, paths: [] }], evidenceSources: [], failures: [] }), { annotations: [] });
});

test("실패한 recipe는 recipe별 ::error 주석으로 코드와 사유를 남기고 REVERIFICATION_RECIPES_FAILED로 실패한다", () => {
  const result = {
    steps: [{ id: "other", changed: true, paths: [] }],
    evidenceSources: [],
    failures: [
      failure("topology", "REVERIFICATION_GROUP_ROLLED_BACK", "topology was registered but its dependent accessibility failed, so the whole group was rolled back"),
      failure("accessibility", "SOURCE_REGISTRATION_FAILED", "accessibility/only: Gwangju accessibility registration failed"),
    ],
  };
  assert.throws(() => reportReverificationFailures(result), (error) => {
    assert.equal(error.message, "REVERIFICATION_RECIPES_FAILED: 2 recipe(s) were not registered (1 registered): topology, accessibility");
    assert.deepEqual(error.annotations, [
      "::error title=Source reverification::topology: REVERIFICATION_GROUP_ROLLED_BACK: topology was registered but its dependent accessibility failed, so the whole group was rolled back",
      "::error title=Source reverification::accessibility: SOURCE_REGISTRATION_FAILED: accessibility/only: Gwangju accessibility registration failed",
    ]);
    return true;
  });
});

test("annotation 명령을 깨는 제어 문자는 공백으로 바꾸고 %는 이스케이프한다", () => {
  assert.throws(() => reportReverificationFailures({ steps: [], evidenceSources: [], failures: [failure("a", "SOURCE_FETCH_FAILED", "line1\n::error::injected\r%0A")] }), (error) => {
    assert.deepEqual(error.annotations, ["::error title=Source reverification::a: SOURCE_FETCH_FAILED: line1 ::error::injected %250A"]);
    assert.doesNotMatch(error.annotations[0], /[\r\n]/u);
    return true;
  });
  const long = "x".repeat(2000);
  assert.throws(() => reportReverificationFailures({ steps: [], evidenceSources: [], failures: [failure("a", "SOURCE_FETCH_FAILED", long)] }), (error) => {
    assert.equal(error.annotations[0].length, "::error title=Source reverification::a: SOURCE_FETCH_FAILED: ".length + 500);
    return true;
  });
});

test("결과 형식이 어긋나면(failures 없음·잘못된 항목) 추정하지 않고 실패한다", () => {
  for (const result of [null, {}, { steps: [], evidenceSources: [] }, { steps: [], evidenceSources: [], failures: "x" },
    { steps: [], evidenceSources: [], failures: [{ recipeId: "", code: "X", detail: "y" }] },
    { steps: [], evidenceSources: [], failures: [{ recipeId: "a", code: "not a code", detail: "y" }] },
    { steps: [], evidenceSources: [], failures: [{ recipeId: "a", code: "SOURCE_FETCH_FAILED" }] }]) {
    assert.throws(() => reportReverificationFailures(result), /REVERIFICATION_RESULT_INVALID/u);
  }
});

test("CLI는 result 파일을 읽어 주석을 출력하고 실패가 있으면 실패하며, 인자가 어긋나면 거부한다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reverification-failures-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clean = path.join(directory, "clean.json");
  const failed = path.join(directory, "failed.json");
  await writeFile(clean, JSON.stringify({ steps: [], evidenceSources: [], failures: [] }));
  await writeFile(failed, JSON.stringify({ steps: [{ id: "a", changed: true, paths: [] }], evidenceSources: [], failures: [failure("b", "SOURCE_FETCH_FAILED", "b/only: HTTP 503")] }));
  const lines = [];
  await main(["--result", clean], { log: (line) => lines.push(line) });
  assert.deepEqual(lines, []);
  await assert.rejects(main(["--result", failed], { log: (line) => lines.push(line) }), /REVERIFICATION_RECIPES_FAILED/u);
  assert.deepEqual(lines, ["::error title=Source reverification::b: SOURCE_FETCH_FAILED: b/only: HTTP 503"]);
  await assert.rejects(main(["--result", path.join(directory, "missing.json")]), /ENOENT/u);
  await assert.rejects(main([]), /REVERIFICATION_ARGUMENTS/u);
  await assert.rejects(main(["--result"]), /REVERIFICATION_ARGUMENTS/u);
  await assert.rejects(main(["--output", clean]), /REVERIFICATION_ARGUMENTS/u);
});
