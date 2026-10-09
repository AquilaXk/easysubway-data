import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { REFRESH_STAGES } from "./refresh-stage-contracts.mjs";

// #1060: 자동 갱신 단계(#870)가 허용 경로로 바꾸는 파일을 documentation-fragment resources에 등록하면
// 자동 병합 PR이 fragment를 갱신하지 않아 main이 매번 drift한다. 두 집합은 서로소여야 한다.
const FRAGMENT_PATH = "contracts/documentation/documentation-fragment.json";

test("자동 갱신 단계 허용 경로는 fragment에 등록된 TRACKED resource와 겹치지 않는다", async () => {
  const fragment = JSON.parse(await readFile(new URL(`../../${FRAGMENT_PATH}`, import.meta.url), "utf8"));
  const prefix = `${fragment.repository}:`;
  const tracked = fragment.resources.filter(({ sourceSurface }) => sourceSurface === "TRACKED").map(({ resource }) => resource.slice(prefix.length));
  assert.ok(tracked.length > 0, "fragment에 TRACKED resource가 있다");

  const collisions = [];
  for (const [stage, { rules, owned }] of Object.entries(REFRESH_STAGES)) {
    for (const path of tracked) {
      for (const { id, regex } of rules) if (regex.test(path)) collisions.push(`${stage}: ${path} (규칙 ${id})`);
    }
    assert.ok(Object.keys(owned).length > 0, `${stage}: 소유 항목이 있다`);
  }
  assert.deepEqual(collisions, [], `자동 갱신 대상 파일은 fragment resources에 등록하지 않는다: ${collisions.join("; ")}`);
});
