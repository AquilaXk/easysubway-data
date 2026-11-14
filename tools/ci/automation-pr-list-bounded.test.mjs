import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// 단독 운영 계약: 어떤 workflow도 automation PR 목록이나 claim 브랜치 조회를 쓰지 않는다.
// 도구 코드의 PR 전 상태 조회 허용 목록 감사는 그대로 유지한다.
const ROOT = path.resolve(import.meta.dirname, "../..");
const WORKFLOW_DIR = path.join(ROOT, ".github/workflows");
const workflowFiles = readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith(".yml")).sort();
const read = (file) => readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
const joined = (text) => text.replace(/\\\n\s*/gu, " ");
const commands = (text, pattern) => joined(text).split("\n").filter((line) => pattern.test(line));

test("workflow의 PR 목록 조회는 전 상태(all·closed·merged)를 상한만 두고 받지 않는다. 전 상태 조회는 --head 단건뿐이다", () => {
  for (const file of workflowFiles) {
    for (const line of commands(read(file), /gh pr list/u)) {
      if (/--state\s+(all|closed|merged)\b/u.test(line)) {
        assert.match(line, /--head\s/u, `${file}: 전 상태 PR 목록은 --head 단건 조회여야 한다 — ${line.trim()}`);
        assert.doesNotMatch(line, /--limit\s+[1-9]\d{3,}/u, `${file}: --head 조회에 이력 규모(1000 이상)의 상한을 두지 않는다 — ${line.trim()}`);
      }
    }
    assert.doesNotMatch(joined(read(file)), /pulls\?[^"\s]*state=(all|closed)/u, `${file}: REST 전 상태 PR 목록 조회 금지`);
  }
});

test("단독 운영 전환 뒤 workflow들은 collect-automation-prs·gh pr list·gh issue create를 호출하지 않는다", () => {
  for (const file of workflowFiles) {
    const text = joined(read(file));
    assert.equal(commands(text, /collect-automation-prs\.mjs/u).length, 0, `${file}: collect-automation-prs.mjs 금지`);
    assert.equal(commands(text, /gh pr (list|create|merge|close)/u).length, 0, `${file}: gh pr 자동화 금지`);
    assert.equal(commands(text, /gh issue (create|comment|close)/u).length, 0, `${file}: gh issue 자동화 금지`);
  }
});

test("도구 코드의 PR 전 상태 목록 조회는 이 허용 목록뿐이다", () => {
  const allowed = new Set(["tools/ci/automation-pr-recreate.mjs", "tools/ci/collect-automation-prs.mjs", "tools/ci/remove-orphan-claims.mjs"]);
  const visit = (directory) => readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return relative === "tools/node_modules" ? [] : visit(relative);
    return entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs") ? [relative] : [];
  });
  for (const file of visit("tools")) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    const listsAllStates = /pulls\?[^`"'\s]*state=(all|closed)|"pr",\s*"list"[^)]*"--state",\s*"(all|closed|merged)"/u.test(text);
    assert.equal(listsAllStates, allowed.has(file), file);
  }
});
