#!/usr/bin/env node
// 원천 재확인 controller가 등록하지 못한 recipe를 job 실패로 드러낸다(#1102, #870 전체 자동화).
//
// controller(run-source-reverification.mjs)는 recipe 하나가 실패해도 나머지 recipe의 등록은 남기고 실패를 result.failures에 담는다.
// workflow는 성공한 recipe로 gate -> 재확인 -> push -> PR을 그대로 진행한 뒤 이 도구를 마지막에 부른다. 실패가 하나라도 있으면 job이 실패해
// report-refresh-failure가 `원천 자동 갱신 실패` 이슈(#926)로 만들고 admin 자동화 상태가 그 이슈를 보여 준다.
// 결과 형식이 어긋나면(failures 없음 등) 추정하지 않고 실패한다.
//
// 사용: node tools/ci/source-reverification-failures.mjs --result <controller result.json>
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const RECIPE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const DETAIL_MAX = 500;
// eslint-disable-next-line no-control-regex -- 한 줄 주석 명령을 깨는 제어 문자를 지운다
const CONTROL = /[\u0000-\u001f\u007f]/gu;

function invalid(detail) {
  return new Error(`REVERIFICATION_RESULT_INVALID: ${detail}`);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// workflow 명령은 한 줄이다. 제어 문자는 공백으로 바꾸고 `%`는 명령 이스케이프와 겹치지 않게 이스케이프한다.
const annotationText = (value) => value.replaceAll(CONTROL, " ").replaceAll("%", "%25").slice(0, DETAIL_MAX);

/**
 * controller 결과에서 등록하지 못한 recipe를 읽는다. 없으면 { annotations: [] }, 있으면 annotations를 단 오류를 던진다.
 */
export function reportReverificationFailures(result) {
  if (!isObject(result) || !Array.isArray(result.steps) || !Array.isArray(result.failures)) throw invalid("steps and failures must be arrays");
  const annotations = result.failures.map((entry) => {
    if (!isObject(entry) || typeof entry.recipeId !== "string" || !RECIPE_ID.test(entry.recipeId)
      || typeof entry.code !== "string" || !CODE.test(entry.code) || typeof entry.detail !== "string" || entry.detail === "") throw invalid("failure entry");
    return `::error title=Source reverification::${entry.recipeId}: ${entry.code}: ${annotationText(entry.detail)}`;
  });
  if (annotations.length === 0) return { annotations };
  const recipes = result.failures.map(({ recipeId }) => recipeId).join(", ");
  throw Object.assign(
    new Error(`REVERIFICATION_RECIPES_FAILED: ${annotations.length} recipe(s) were not registered (${result.steps.length} registered): ${recipes}`),
    { annotations },
  );
}

export async function main(argv, { log = console.log } = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--result" || typeof argv[1] !== "string" || argv[1] === "") {
    throw new Error("REVERIFICATION_ARGUMENTS: usage: source-reverification-failures.mjs --result <result.json>");
  }
  let result;
  try {
    result = JSON.parse(await readFile(argv[1], "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw invalid("the result is not JSON");
    throw error;
  }
  try {
    return reportReverificationFailures(result);
  } catch (error) {
    for (const line of error.annotations ?? []) log(line);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
