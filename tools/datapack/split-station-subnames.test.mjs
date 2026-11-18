import assert from "node:assert/strict";
import test from "node:test";
import { splitStationName } from "./split-station-subnames.mjs";

test("splitStationName은 '역명(부역명)'을 역명+부역명으로 가른다", () => {
  assert.deepEqual(splitStationName("가야대(삼계)"), {
    nameKo: "가야대",
    nameSub: "삼계",
  });
});

test("splitStationName은 괄호 없는 역명을 그대로 두고 부역명은 빈 문자열", () => {
  assert.deepEqual(splitStationName("사당"), { nameKo: "사당", nameSub: "" });
});

test("splitStationName은 부역명 내부의 점·영문·숫자를 보존한다", () => {
  assert.deepEqual(splitStationName("가평(자라섬.남이섬)"), {
    nameKo: "가평",
    nameSub: "자라섬.남이섬",
  });
  assert.deepEqual(splitStationName("남천(KBS.수영구청)"), {
    nameKo: "남천",
    nameSub: "KBS.수영구청",
  });
  assert.deepEqual(splitStationName("명덕(2.28민주운동기념회관)"), {
    nameKo: "명덕",
    nameSub: "2.28민주운동기념회관",
  });
});

test("splitStationName은 라벨 축약(routeMapStationLabel)과 같은 base를 낸다", () => {
  // routeMapStationLabel: 첫 '(' 이전만 취함 → base 일치해야 렌더 정합.
  for (const raw of ["서울대입구(관악구청)", "청량리(서울시립대입구)", "총신대입구(이수)"]) {
    const { nameKo } = splitStationName(raw);
    assert.equal(nameKo, raw.slice(0, raw.indexOf("(")));
  }
});
