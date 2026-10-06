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
