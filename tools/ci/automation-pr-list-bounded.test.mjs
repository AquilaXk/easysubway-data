import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// #993: 자동화 판정 step이 `gh pr list --state all --limit 1000`으로 PR 전체 이력을 받으면, 이력이 1000건에 닿는 순간
// 판정이 영구 실패하거나(`*_LIST_TRUNCATED`) 조용히 잘린 목록으로 판단한다. 판정은 열린 PR 목록과 claim 브랜치별 PR만 받아야 한다.
// 이 전수 검사가 같은 종류의 호출이 workflow나 도구에 다시 생기는 것을 막는다.
const ROOT = path.resolve(import.meta.dirname, "../..");
const WORKFLOW_DIR = path.join(ROOT, ".github/workflows");
const workflowFiles = readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith(".yml")).sort();
const read = (file) => readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
// `\` 줄 이음을 한 줄로 합쳐 여러 줄로 나눠 쓴 호출도 한 명령으로 본다.
const joined = (text) => text.replace(/\\\n\s*/gu, " ");
const commands = (text, pattern) => joined(text).split("\n").filter((line) => pattern.test(line));

// 판정이 쓰는 수집기 호출 수(workflow 9개, 호출 13곳).
const COLLECTOR_CALLS = Object.freeze({
  "current-capital-topology-refresh.yml": 1,
  "current-capital-topology-registration.yml": 2,
  "itx-current-promotion.yml": 1,
  "kric-current-facility-refresh.yml": 1,
  "nationwide-candidate-refresh.yml": 2,
  "retained-gwangju-timetable-refresh.yml": 1,
  "seoul-current-accessibility-refresh.yml": 1,
  "source-derivative-rebinding.yml": 2,
  "source-reverification.yml": 2,
});

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

test("판정 workflow 9개는 열린 PR + claim 브랜치별 PR 수집기를 13곳에서 쓴다", () => {
  for (const file of workflowFiles) {
    const count = commands(read(file), /node tools\/ci\/collect-automation-prs\.mjs/u).length;
    assert.equal(count, COLLECTOR_CALLS[file] ?? 0, `${file}: 수집기 호출 수`);
  }
  assert.equal(Object.values(COLLECTOR_CALLS).reduce((sum, count) => sum + count, 0), 13);
});

test("수집기 호출은 같은 step에서 먼저 받은 ls-remote 출력과 열린 PR 상한 1000을 쓴다", () => {
  for (const file of Object.keys(COLLECTOR_CALLS)) {
    const text = read(file);
    for (const step of text.split("\n      - ").filter((part) => part.includes("collect-automation-prs.mjs"))) {
      for (const call of commands(step, /node tools\/ci\/collect-automation-prs\.mjs/u)) {
        assert.match(call, /--repository "\$\{GITHUB_REPOSITORY\}" --refs "([^"]+)" --pr-limit 1000 --output "([^"]+)"/u, `${file}: ${call.trim()}`);
        const refs = /--refs "([^"]+)"/u.exec(call)[1];
        const before = joined(step).slice(0, joined(step).indexOf(call.trim()));
        const lsRemote = commands(before, /git ls-remote --heads origin/u).filter((line) => line.includes(`> "${refs}"`));
        assert.ok(lsRemote.length >= 1, `${file}: ${refs}는 수집기 호출 전에 git ls-remote로 받아야 한다`);
      }
    }
  }
});

test("도구 코드의 PR 전 상태 목록 조회는 이 허용 목록뿐이다", () => {
  // automation-pr-recreate: 닫힌 PR 최근 100건 표본(24시간 창 계산용, overflow: return, 최신순). 잘림이 실패가 되지 않고 이력 길이와 무관하다.
  // collect-automation-prs: 전 상태 조회는 --head <claim 브랜치> 단건뿐이고 열린 PR 목록은 --state open이다.
  const allowed = new Set(["tools/ci/automation-pr-recreate.mjs", "tools/ci/collect-automation-prs.mjs"]);
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
