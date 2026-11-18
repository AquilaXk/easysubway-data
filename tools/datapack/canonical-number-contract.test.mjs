import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MAX_SAFE_CANONICAL_NUMBER_MAGNITUDE,
  canonicalJson,
  ecmascriptNumber,
} from "./lib/manifest-validation.mjs";

// contracts/datapack/canonical-number-contract.json 은 Node·Java·Dart 세 구현이
// 공유하는 정준 숫자 표기 계약이다. 기대 문자열은 세 런타임 실측으로 고정된 상수이며
// 이 테스트는 구현을 복제하지 않고 저장된 상수와만 비교한다.
const contract = JSON.parse(
  readFileSync("contracts/datapack/canonical-number-contract.json", "utf8"),
);

test("정준 숫자 상한이 공유 계약과 일치한다", () => {
  assert.equal(MAX_SAFE_CANONICAL_NUMBER_MAGNITUDE, contract.maxSafeIntegerMagnitude);
  assert.equal(MAX_SAFE_CANONICAL_NUMBER_MAGNITUDE, 9007199254740991);
});

test("공유 계약의 숫자 표기를 그대로 재현한다", () => {
  for (const entry of contract.formatting) {
    assert.equal(
      ecmascriptNumber(JSON.parse(entry.literal)),
      entry.canonical,
      `formatting/${entry.id} (${entry.literal})`,
    );
  }
});

test("안전 정수 범위 안 숫자만 매니페스트 정준화가 수용한다", () => {
  for (const entry of contract.formatting) {
    const document = JSON.parse(`{"value":${entry.literal}}`);
    const label = `formatting/${entry.id} (${entry.literal})`;
    if (entry.withinSafeRange) {
      assert.equal(canonicalJson(document), `{"value":${entry.canonical}}`, label);
    } else {
      assert.throws(() => canonicalJson(document), /safe integer range/, label);
    }
  }
});

test("정준 표기가 합의되지 않는 리터럴은 거부한다", () => {
  for (const entry of contract.rejectedLiterals) {
    const document = JSON.parse(`{"value":${entry.literal}}`);
    assert.throws(
      () => canonicalJson(document),
      /manifest canonical number/,
      `rejectedLiterals/${entry.id} (${entry.literal})`,
    );
  }
});

test("유한하지 않은 숫자는 null로 조용히 대체되지 않고 거부된다", () => {
  const specialValues = { Infinity, "-Infinity": -Infinity, NaN };
  for (const entry of contract.rejectedSpecialValues) {
    const value = specialValues[entry.value];
    assert.equal(Number.isNaN(value) || !Number.isFinite(value), true, entry.id);
    assert.throws(
      () => canonicalJson({ value }),
      /must be finite/,
      `rejectedSpecialValues/${entry.id}`,
    );
    assert.throws(() => ecmascriptNumber(value), /must be finite/, entry.id);
  }
});

test("최단 왕복 표기가 아닌 리터럴은 파서가 배정도로 접어 정준형으로 만든다", () => {
  for (const entry of contract.nonCanonicalLiterals) {
    const document = JSON.parse(`{"value":${entry.literal}}`);
    assert.equal(
      canonicalJson(document),
      `{"value":${entry.doubleCanonical}}`,
      `nonCanonicalLiterals/${entry.id} (${entry.literal})`,
    );
  }
});

test("정준 표기 표본은 파싱 후 재정준화해도 자기 자신으로 돌아온다", () => {
  assert.ok(contract.roundTripSamples.length >= 300);
  for (const sample of contract.roundTripSamples) {
    assert.equal(ecmascriptNumber(JSON.parse(sample)), sample, `roundTripSamples/${sample}`);
  }
});

test("키는 UTF-16 코드 유닛 순서로 정렬되고 공백 없이 이어붙인다", () => {
  assert.equal(
    canonicalJson({ b: [1, true, null, "x"], A: 2, a: { z: 3, y: 4 } }),
    '{"A":2,"a":{"y":4,"z":3},"b":[1,true,null,"x"]}',
  );
});
