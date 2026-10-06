import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// PR을 만드는 workflow 탐지(#967). GITHUB_TOKEN으로 연 PR은 pull_request CI가 action_required로 멈추므로,
// PR을 만드는 모든 지점이 App 토큰 계약을 따라야 한다. 탐지는 철자가 아니라 동작을 본다(#968 리뷰 F1).

// 줄 이음(`\` + 줄바꿈)을 한 줄로 합쳐 `gh pr \` 다음 줄 `create`처럼 갈라 쓴 호출을 잡는다.
const joinContinuations = (text) => String(text ?? "").replace(/\\\r?\n[ \t]*/gu, " ");

/** 텍스트가 gh pr create 또는 gh api로 pulls를 만드는 호출(POST·필드 전달)을 담고 있으면 true다. */
export function createsPullRequest(text) {
  const joined = joinContinuations(text);
  if (/\bgh\s+pr\s+create\b/u.test(joined)) return true;
  return joined.split("\n").some((line) => {
    if (!/\bgh\s+api\b/u.test(line) || !/\/pulls(?=["'\s]|$)/u.test(line)) return false;
    if (/(?:^|\s)(?:-X|--method)[\s=]+GET\b/iu.test(line)) return false;
    // POST를 명시했거나 필드·입력을 넘기면(gh api는 필드가 있으면 POST) PR 생성이다.
    return /(?:^|\s)(?:-X|--method)[\s=]+POST\b/iu.test(line) || /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:\s|=)/u.test(line);
  });
}

/**
 * .github/workflows와 .github/actions 아래(하위 디렉터리 포함)에서 PR 생성을 담은 파일의 저장소 상대 경로를 정렬해 돌려준다(#968 리뷰 F2).
 * workflow뿐 아니라 composite action과 그 안의 스크립트도 같은 계약이다. 디렉터리가 없으면 비어 있다.
 */
export function scanPullRequestCreators(root) {
  const found = [];
  const walk = (relative, filter) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child, filter);
      else if (entry.isFile() && filter(entry.name) && createsPullRequest(readFileSync(path.join(root, child), "utf8"))) found.push(child);
    }
  };
  walk(".github/workflows", (name) => /\.ya?ml$/u.test(name));
  walk(".github/actions", (name) => !/\.(?:md|png|jpg|svg)$/u.test(name));
  // 경로는 ASCII다. 비교 함수를 명시해 정렬 순서(UTF-16 코드 단위)를 고정한다.
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
