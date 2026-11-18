import assert from "node:assert/strict";
import test from "node:test";
import { buildGeoTransform, splitHighDegreeNodes } from "./export-loom-geojson.mjs";

const BBOX = { minX: 100, maxX: 5600, minY: 190, maxY: 6200 };

test("buildGeoTransform 왕복 항등: design → geo → design ≤ 0.05px", () => {
  const { toGeo, toDesign } = buildGeoTransform(BBOX);
  let maxRt = 0;
  for (let x = BBOX.minX; x <= BBOX.maxX; x += 550) {
    for (let y = BBOX.minY; y <= BBOX.maxY; y += 600) {
      const [lon, lat] = toGeo(x, y);
      const b = toDesign(lon, lat);
      maxRt = Math.max(maxRt, Math.hypot(b.x - x, b.y - y));
    }
  }
  assert.ok(maxRt <= 0.05, `maxRoundTrip=${maxRt}`);
});

test("buildGeoTransform은 축정렬을 보존한다(수평 design → 등위도, 수직 → 등경도)", () => {
  const { toGeo } = buildGeoTransform(BBOX);
  // 같은 y(수평선) → 같은 위도
  assert.equal(toGeo(200, 1000)[1], toGeo(5000, 1000)[1]);
  // 같은 x(수직선) → 같은 경도
  assert.equal(toGeo(1500, 300)[0], toGeo(1500, 6000)[0]);
});

test("buildGeoTransform은 design 45° 벡터를 web-mercator 45°로 사영한다(위도 왜곡 보정 실검증)", () => {
  const { toGeo, transform } = buildGeoTransform(BBOX);
  const { R, M_PER_DEG_LON } = transform;
  // 독립 웹메르카토르(표준식) — 변환 내부 mercY/invMercLat에 의존하지 않는 기준선.
  // (선형 lat 매핑으로 회귀하면 위도 왜곡으로 Δmx≠Δmy가 되어 이 단언이 깨진다 —
  //  왕복 항등·축정렬 테스트만으로는 잡히지 않던 T1의 핵심 속성을 실제로 검증한다.)
  const webmerc = (lon, lat) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return { mx: lon * M_PER_DEG_LON, my: (R / 2) * Math.log((1 + s) / (1 - s)) };
  };
  const ga = toGeo(1000, 1000);
  const gb = toGeo(1500, 1500); // design 대각(dx=dy=500)
  const ma = webmerc(ga[0], ga[1]);
  const mb = webmerc(gb[0], gb[1]);
  const dmx = mb.mx - ma.mx;
  const dmy = mb.my - ma.my;
  assert.ok(
    Math.abs(Math.abs(dmx) - Math.abs(dmy)) / Math.abs(dmx) < 2e-3,
    `Δmx=${dmx} Δmy=${dmy} (webmerc 45° 아님 — 위도 왜곡 보정 실패)`,
  );
});

test("splitHighDegreeNodes는 차수>8 노드를 분할해 모든 차수를 8 이하로 만든다", () => {
  const nodeCoord = new Map();
  nodeCoord.set("hub", { x: 0, y: 0, name: "허브" });
  const edgeList = [];
  for (let i = 0; i < 9; i += 1) {
    const leaf = `leaf${i}`;
    nodeCoord.set(leaf, { x: i + 1, y: i + 1, name: `L${i}` });
    edgeList.push({ from: "hub", to: leaf, lines: new Set([`line-${i}`]) });
  }
  const split = splitHighDegreeNodes(nodeCoord, edgeList);
  assert.equal(split.length, 1);
  assert.equal(split[0].id, "hub");
  // 분할 노드 hub#2 생성, station_label 매핑(원 id 접두) 보존
  assert.ok(nodeCoord.has("hub#2"));
  assert.equal(nodeCoord.get("hub#2").name, "허브");
  // 재계산 차수 전부 ≤ 8
  const deg = new Map();
  for (const e of edgeList) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  for (const d of deg.values()) assert.ok(d <= 8, `degree ${d} > 8`);
});

test("splitHighDegreeNodes는 매우 높은 차수(>14)도 반복 분할로 모두 8 이하로 만든다", () => {
  const nodeCoord = new Map();
  nodeCoord.set("hub", { x: 0, y: 0, name: "허브" });
  const edgeList = [];
  for (let i = 0; i < 17; i += 1) {
    const leaf = `leaf${i}`;
    nodeCoord.set(leaf, { x: i + 1, y: i + 1, name: `L${i}` });
    edgeList.push({ from: "hub", to: leaf, lines: new Set([`line-${i}`]) });
  }
  splitHighDegreeNodes(nodeCoord, edgeList);
  // 1회 분할이면 ceil(17/2)+1=10>8이 남는다 — 반복 분할로 전부 ≤8이어야 한다
  const deg = new Map();
  for (const e of edgeList) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  for (const d of deg.values()) assert.ok(d <= 8, `degree ${d} > 8`);
  // 분할본 접미가 유니크(#2,#3,…)해 충돌 없음
  const ids = [...nodeCoord.keys()].filter((k) => k.startsWith("hub"));
  assert.equal(new Set(ids).size, ids.length);
});

test("splitHighDegreeNodes는 차수 ≤8이면 아무것도 하지 않는다", () => {
  const nodeCoord = new Map([["a", { x: 0, y: 0 }], ["b", { x: 1, y: 1 }]]);
  const edgeList = [{ from: "a", to: "b", lines: new Set(["l1"]) }];
  assert.deepEqual(splitHighDegreeNodes(nodeCoord, edgeList), []);
  assert.equal(edgeList.length, 1);
});
