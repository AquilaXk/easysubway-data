// 지역 접근성 원천 row의 역 이름을 전국 후보의 정본 역에 맞추는 규칙.
// 후보 생성(prepare-nationwide-candidate-run.mjs)과 coverage report 검증이 같은 규칙을 써야
// claim의 stationId가 원천 row의 역에 결속된다.

const PROVIDER_STATION_NAME_ALIASES = new Map([
  ["성서산단", "성서산업단지"],
  ["광주송정", "광주송정역"],
]);

/** 정본 역 이름 정규화: 괄호 부기·끝 숫자를 지우고 가운뎃점을 맞춘다. */
export function cleanRegionalStationName(name) {
  return String(name ?? "").replace(/\(.*?\)/g, "").replace(/\d+$/, "").replace(/[·•ㆍ]/g, ".").trim();
}

/** 원천 row 역 이름의 비교 키. 정규화 뒤 원천 고유 별칭만 정본 이름으로 바꾼다. */
export function regionalProviderStationNameKey(rawName) {
  const name = cleanRegionalStationName(rawName);
  return PROVIDER_STATION_NAME_ALIASES.get(name) ?? name;
}
