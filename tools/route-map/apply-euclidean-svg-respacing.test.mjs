import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  solveEuclideanRepel,
  findElementRange,
  addTranslate,
  patchLabelElement,
  applyDeltasToSvg,
  SVG_NAME_ALIASES,
} from "./apply-euclidean-svg-respacing.mjs";

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "euclid-svg-test-"));
  const dbPath = path.join(dir, "t.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE route_map_positions (
      station_id TEXT, line_id TEXT, region TEXT, x REAL, y REAL
    );
    CREATE TABLE stations (id TEXT PRIMARY KEY, name_ko TEXT);
  `);
  return { db, dir };
}

test("solveEuclideanRepel: 위반 쌍을 8선형 방향으로 밀어 threshold+여유를 확보한다", () => {
  const { db, dir } = makeDb();
  try {
    db.prepare("INSERT INTO stations VALUES (?,?)").run("a", "역A");
    db.prepare("INSERT INTO stations VALUES (?,?)").run("b", "역B");
    db.prepare(
      "INSERT INTO route_map_positions (station_id, line_id, region, x, y) VALUES (?,?,?,?,?)",
    ).run("a", "L1", "수도권", 0, 0);
    db.prepare(
      "INSERT INTO route_map_positions (station_id, line_id, region, x, y) VALUES (?,?,?,?,?)",
    ).run("b", "L1", "수도권", 10, 0); // dist 10 < 48

    const { deltas, finalViolations } = solveEuclideanRepel(db, "수도권", {
      threshold: 48,
      target: 52,
    });
    assert.equal(finalViolations.length, 0);
    assert.equal(deltas.length, 2);
    const byName = new Map(deltas.map((d) => [d.name, d]));
    // 8선형(수평) 방향으로만 밀려야 함 — dy는 0.
    assert.equal(byName.get("역A").dy, 0);
    assert.equal(byName.get("역B").dy, 0);
    // a는 음의 x방향, b는 양의 x방향으로 밀림(서로 반대).
    assert.ok(byName.get("역A").dx < 0);
    assert.ok(byName.get("역B").dx > 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("solveEuclideanRepel: 위반이 없으면 delta 없음", () => {
  const { db, dir } = makeDb();
  try {
    db.prepare("INSERT INTO stations VALUES (?,?)").run("a", "역A");
    db.prepare("INSERT INTO stations VALUES (?,?)").run("b", "역B");
    db.prepare(
      "INSERT INTO route_map_positions (station_id, line_id, region, x, y) VALUES (?,?,?,?,?)",
    ).run("a", "L1", "수도권", 0, 0);
    db.prepare(
      "INSERT INTO route_map_positions (station_id, line_id, region, x, y) VALUES (?,?,?,?,?)",
    ).run("b", "L1", "수도권", 100, 0); // dist 100 >= 48

    const { deltas, finalViolations } = solveEuclideanRepel(db, "수도권");
    assert.equal(deltas.length, 0);
    assert.equal(finalViolations.length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findElementRange: self-closing circle 요소의 [start,end) 범위를 정확히 잡는다", () => {
  const svg = '<g><circle id="_역A" cx="1" cy="2" /><circle id="_역B" /></g>';
  const range = findElementRange(svg, 'id="_역A"', "circle", true);
  assert.equal(svg.slice(range.start, range.end), '<circle id="_역A" cx="1" cy="2" />');
});

test("findElementRange: group(g) 요소는 여는 태그까지만 잡는다", () => {
  const svg = '<g id="transfer-station-symbol-역A" data-x="1"><title>t</title></g>';
  const range = findElementRange(svg, 'id="transfer-station-symbol-역A"', "g", false);
  assert.equal(
    svg.slice(range.start, range.end),
    '<g id="transfer-station-symbol-역A" data-x="1">',
  );
});

test("addTranslate: 2-인수 translate에 delta를 가산한다", () => {
  const el = '<circle id="_x" transform="translate(1,2)" />';
  assert.equal(
    addTranslate(el, 3, 4),
    '<circle id="_x" transform="translate(4,6)" />',
  );
});

test("addTranslate: 1-인수 translate(ty 암묵 0)도 인식한다", () => {
  const el = '<circle id="_x" transform="translate(5)" />';
  assert.equal(
    addTranslate(el, 1, 2),
    '<circle id="_x" transform="translate(6,2)" />',
  );
});

test("addTranslate: 기존 transform(회전 등)이 있으면 translate를 앞에 합성한다", () => {
  const el = '<g id="_x" transform="rotate(90)"><title/></g>';
  assert.equal(
    addTranslate(el, 1, 2),
    '<g id="_x" transform="translate(1,2) rotate(90)"><title/></g>',
  );
});

test("addTranslate: transform 속성이 없으면 새로 추가한다", () => {
  const el = '<circle id="_x" cx="1" />';
  assert.equal(
    addTranslate(el, 1, 2),
    '<circle id="_x" cx="1"  transform="translate(1,2)"/>',
  );
});

test("patchLabelElement: transform이 있으면 addTranslate로 위임한다", () => {
  const el = '<text id="station-label-x" transform="translate(1,2)">x</text>';
  assert.equal(
    patchLabelElement(el, 3, 4),
    '<text id="station-label-x" transform="translate(4,6)">x</text>',
  );
});

test("patchLabelElement: x/y 속성형(마커 없는 라벨-only 역)은 text와 모든 tspan의 x/y를 가산한다", () => {
  const el =
    '<text id="station-label-안산" x="10" y="20"><tspan x="10" y="20">안산</tspan></text>';
  assert.equal(
    patchLabelElement(el, 5, -3),
    '<text id="station-label-안산" x="15" y="17"><tspan x="15" y="17">안산</tspan></text>',
  );
});

test("patchLabelElement: x 속성이 없으면(형식 미인식) null을 반환한다", () => {
  const el = '<text id="station-label-x">x</text>';
  assert.equal(patchLabelElement(el, 1, 1), null);
});

test("applyDeltasToSvg: circle 마커를 찾아 패치한다", () => {
  const svg = '<svg><circle id="_역A" transform="translate(0,0)" /></svg>';
  const { svg: out, patched, missing } = applyDeltasToSvg(svg, [
    { name: "역A", dx: 10, dy: 20 },
  ]);
  assert.equal(missing.length, 0);
  assert.equal(patched.length, 1);
  assert.equal(patched[0].kind, "circle");
  assert.match(out, /translate\(21\.978,43\.956\)/); // dx/0.455, dy/0.455
});

test("applyDeltasToSvg: station-node-* circle(병점류 대체 규약)도 찾는다", () => {
  const svg = '<svg><circle id="station-node-병점" transform="translate(0,0)" /></svg>';
  const { patched, missing } = applyDeltasToSvg(svg, [{ name: "병점", dx: 5, dy: 5 }]);
  assert.equal(missing.length, 0);
  assert.equal(patched[0].kind, "circle");
});

test("applyDeltasToSvg: transfer-station-symbol 캡슐(g)도 찾는다", () => {
  const svg = '<svg><g id="transfer-station-symbol-약수" transform="translate(0,0)"><title/></g></svg>';
  const { patched, missing } = applyDeltasToSvg(svg, [{ name: "약수", dx: 5, dy: 5 }]);
  assert.equal(missing.length, 0);
  assert.equal(patched[0].kind, "capsule");
});

test("applyDeltasToSvg: terminal-station-symbol(g)도 찾는다", () => {
  const svg =
    '<svg><g id="terminal-station-symbol-인천공항2터미널" transform="translate(0,0)"><title/></g></svg>';
  const { patched, missing } = applyDeltasToSvg(svg, [
    { name: "인천공항2터미널", dx: 1, dy: 1 },
  ]);
  assert.equal(missing.length, 0);
  assert.equal(patched[0].kind, "terminal");
});

test("applyDeltasToSvg: 마커가 전혀 없으면 라벨(station-label-*)로 폴백한다(v1 안산선 꼬리 등)", () => {
  const svg = '<svg><text id="station-label-안산" x="10" y="20"></text></svg>';
  const { patched, missing } = applyDeltasToSvg(svg, [{ name: "안산", dx: 5, dy: 5 }]);
  assert.equal(missing.length, 0);
  assert.equal(patched[0].kind, "label");
});

test("applyDeltasToSvg: 마커도 라벨도 없으면 missing에 기록한다(별칭별 사유 + 전체 요약)", () => {
  const svg = "<svg></svg>";
  const { missing } = applyDeltasToSvg(svg, [{ name: "없는역", dx: 1, dy: 1 }]);
  assert.equal(missing.length, 2);
  assert.ok(missing.some((m) => m.reason === "마커·라벨 전부 미발견"));
  assert.ok(missing.some((m) => m.reason === "전 별칭 미발견"));
});

test("applyDeltasToSvg: 별칭(SVG_NAME_ALIASES)의 모든 SVG 이름을 같은 delta로 패치한다(신촌/양평 콜론 복수 마커)", () => {
  assert.deepEqual(SVG_NAME_ALIASES["신촌"], ["신촌:2호선", "신촌:경의중앙선"]);
  const svg =
    '<svg><circle id="_신촌:2호선" transform="translate(0,0)" /><circle id="_신촌:경의중앙선" transform="translate(0,0)" /></svg>';
  const { patched, missing } = applyDeltasToSvg(svg, [{ name: "신촌", dx: 10, dy: 10 }]);
  assert.equal(missing.length, 0);
  assert.equal(patched.length, 2);
});

test("applyDeltasToSvg: 총신대입구→이수 별칭을 인식한다", () => {
  assert.deepEqual(SVG_NAME_ALIASES["총신대입구"], ["이수"]);
  const svg = '<svg><g id="transfer-station-symbol-이수" transform="translate(0,0)"><title/></g></svg>';
  const { patched, missing } = applyDeltasToSvg(svg, [{ name: "총신대입구", dx: 1, dy: 1 }]);
  assert.equal(missing.length, 0);
  assert.equal(patched[0].svgName, "이수");
});
