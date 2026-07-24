import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import {
  applyCapitalRouteTopology,
  loadCapitalRouteTopologySnapshot,
  queryAnyangNeighbors,
  queryNeighbors,
} from "./apply-capital-route-topology-to-bundled-pack.mjs";
import {
  normalizeStationName,
  parseLineSource,
  LINE_SOURCES,
} from "./collect-capital-route-topology.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const SNAPSHOT_PATH = path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json");
const PACK_PATH = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");

test("공식 CSV 괄호 부기 역명을 pack name_ko 매칭용으로 정규화한다", () => {
  assert.equal(normalizeStationName("청량리(서울시립대입구)"), "청량리");
  assert.equal(normalizeStationName("불암산(당고개)"), "불암산");
  assert.equal(normalizeStationName("광교(경기대)"), "광교");
});

test("고정 스냅샷은 Anyang·신분당·8호선·인천1·갭해소 3노선 계약을 만족한다", async () => {
  const snapshot = loadCapitalRouteTopologySnapshot(JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")));
  assert.equal(snapshot.lines.length, 24);
  assert.equal(snapshot.topologyGaps.length, 0);

  const line1 = snapshot.lines.find(({ lineId }) => lineId === "line-472a81add377");
  assert.ok(line1);
  assert.equal(line1.edgeCount, 202);
  const anyangNeighbors = [...new Set(
    line1.edges.filter(({ fromStationName }) => fromStationName === "안양")
      .map(({ toStationName }) => toStationName),
  )].sort((left, right) => left.localeCompare(right, "ko"));
  assert.deepEqual(anyangNeighbors, ["관악", "명학"]);
  assert.ok(!anyangNeighbors.includes("소사"));

  const shinbundang = snapshot.lines.find(({ lineId }) => lineId === "shinbundang");
  const gangnam = [...new Set(
    shinbundang.edges.filter(({ fromStationName }) => fromStationName === "강남")
      .map(({ toStationName }) => toStationName),
  )].sort((left, right) => left.localeCompare(right, "ko"));
  assert.deepEqual(gangnam, ["신논현", "양재"]);

  const line8 = snapshot.lines.find(({ lineId }) => lineId === "line-2b2d9eaa53d0");
  const moran = [...new Set(
    line8.edges.filter(({ fromStationName }) => fromStationName === "모란")
      .map(({ toStationName }) => toStationName),
  )];
  assert.deepEqual(moran, ["수진"]);

  const incheon1 = snapshot.lines.find(({ lineId }) => lineId === "line-98718184f016");
  const gyeyang = [...new Set(
    incheon1.edges.filter(({ fromStationName }) => fromStationName === "계양")
      .map(({ toStationName }) => toStationName),
  )];
  assert.deepEqual(gyeyang, ["귤현"]);

  const guro = [...new Set(
    line1.edges.filter(({ fromStationName }) => fromStationName === "구로")
      .map(({ toStationName }) => toStationName),
  )].sort((left, right) => left.localeCompare(right, "ko"));
  assert.deepEqual(guro, ["가산디지털단지", "구일", "신도림"]);

  const sillim = snapshot.lines.find(({ lineId }) => lineId === "line-aefa08ccc0a9");
  assert.ok(sillim);
  const sillimNeighbors = [...new Set(
    sillim.edges.filter(({ fromStationName }) => fromStationName === "신림")
      .map(({ toStationName }) => toStationName),
  )].sort((left, right) => left.localeCompare(right, "ko"));
  assert.deepEqual(sillimNeighbors, ["당곡", "서원"]);

  const gimpo = snapshot.lines.find(({ lineId }) => lineId === "line-5500c1600f71");
  assert.ok(gimpo);
  const yangchon = [...new Set(
    gimpo.edges.filter(({ fromStationName }) => fromStationName === "양촌")
      .map(({ toStationName }) => toStationName),
  )];
  assert.deepEqual(yangchon, ["구래"]);

  const seohae = snapshot.lines.find(({ lineId }) => lineId === "line-051552e50435");
  assert.ok(seohae);
  const sosa = [...new Set(
    seohae.edges.filter(({ fromStationName }) => fromStationName === "소사")
      .map(({ toStationName }) => toStationName),
  )].sort((left, right) => left.localeCompare(right, "ko"));
  assert.deepEqual(sosa, ["부천종합운동장역", "소새울"]);
  const gimpogonghang = [...new Set(
    seohae.edges.filter(({ fromStationName }) => fromStationName === "김포공항역")
      .map(({ toStationName }) => toStationName),
  )].sort((left, right) => left.localeCompare(right, "ko"));
  assert.deepEqual(gimpogonghang, ["능곡", "원종"]);
});

test("원문 CSV 재파싱이 스냅샷 contentSha256과 일치한다(대표 노선)", async () => {
  const snapshot = loadCapitalRouteTopologySnapshot(JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")));
  for (const slug of ["line1", "shinbundang", "line8", "incheon1", "line2", "gimpo", "sillim"]) {
    const source = LINE_SOURCES.find((item) => item.slug === slug);
    const raw = await readFile(path.resolve(root, source.localCsv));
    const parsed = parseLineSource(source, raw, { capturedAt: new Date(snapshot.capturedAt) });
    const line = snapshot.lines.find(({ lineId }) => lineId === source.lineId);
    assert.equal(parsed.contentSha256, line.contentSha256, slug);
    assert.equal(parsed.rawSha256, line.rawSha256, slug);
  }
  const seohaeSource = LINE_SOURCES.find((item) => item.slug === "seohae");
  const seohaeParsed = parseLineSource(
    seohaeSource,
    await readFile(path.resolve(root, seohaeSource.localCsv)),
    {
      capturedAt: new Date(snapshot.capturedAt),
      secondaryBytes: await readFile(path.resolve(root, seohaeSource.localMolitCsv)),
    },
  );
  const seohaeLine = snapshot.lines.find(({ lineId }) => lineId === seohaeSource.lineId);
  assert.equal(seohaeParsed.contentSha256, seohaeLine.contentSha256, "seohae");
  assert.equal(seohaeParsed.rawSha256, seohaeLine.rawSha256, "seohae");
});

test("bundled capital pack에 공식 topology를 적용하면 안양·스팟체크·ITX·idempotent가 성립한다", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "capital-route-apply-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const sqlitePath = path.join(directory, "capital.sqlite");
  const indexPath = path.join(directory, "index.json");
  await copyFile(PACK_PATH, packPath);
  await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);

  await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
  const beforeDb = new DatabaseSync(sqlitePath, { readOnly: true });
  const beforeItx = beforeDb.prepare(`
    SELECT COUNT(*) AS count FROM network_edges WHERE service_class = 'ITX_CHEONGCHUN'
  `).get().count;
  beforeDb.close();

  const { stdout } = await execFileAsync(process.execPath, [
    "tools/datapack/apply-capital-route-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--snapshot", SNAPSHOT_PATH,
    "--index", indexPath,
    "--dry-run",
  ], { cwd: root });
  assert.match(stdout, /Anyang=\[관악, 명학\]/);
  assert.equal(Buffer.compare(await readFile(packPath), await readFile(PACK_PATH)), 0);

  const snapshot = loadCapitalRouteTopologySnapshot(JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")));
  await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
  applyCapitalRouteTopology(sqlitePath, snapshot);
  assert.deepEqual(queryAnyangNeighbors(sqlitePath), ["관악", "명학"]);
  assert.deepEqual(queryNeighbors(sqlitePath, "shinbundang", "강남"), ["신논현", "양재"]);
  assert.deepEqual(queryNeighbors(sqlitePath, "line-2b2d9eaa53d0", "모란"), ["수진"]);
  assert.deepEqual(queryNeighbors(sqlitePath, "line-98718184f016", "계양"), ["귤현"]);
  assert.deepEqual(
    queryNeighbors(sqlitePath, "line-472a81add377", "구로"),
    ["가산디지털단지", "구일", "신도림"],
  );
  assert.deepEqual(
    queryNeighbors(sqlitePath, "line-aefa08ccc0a9", "신림"),
    ["당곡", "서원"],
  );
  assert.deepEqual(
    queryNeighbors(sqlitePath, "line-5500c1600f71", "양촌"),
    ["구래"],
  );
  assert.deepEqual(
    queryNeighbors(sqlitePath, "line-051552e50435", "소사"),
    ["부천종합운동장", "소새울"],
  );
  assert.deepEqual(
    queryNeighbors(sqlitePath, "line-051552e50435", "김포공항"),
    ["능곡", "원종"],
  );

  const afterDb = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const afterItx = afterDb.prepare(`
      SELECT COUNT(*) AS count FROM network_edges WHERE service_class = 'ITX_CHEONGCHUN'
    `).get().count;
    assert.equal(afterItx, beforeItx);

    const line1Count = afterDb.prepare(`
      SELECT COUNT(*) AS count FROM network_edges
      WHERE edge_type = 'RIDE' AND service_class = 'SUBWAY' AND service_pattern = 'LOCAL'
        AND from_node_id GLOB '*:line-472a81add377'
    `).get().count;
    assert.equal(line1Count, 202);
  } finally {
    afterDb.close();
  }

  // idempotent second apply
  applyCapitalRouteTopology(sqlitePath, snapshot);
  assert.deepEqual(queryAnyangNeighbors(sqlitePath), ["관악", "명학"]);
  assert.deepEqual(queryNeighbors(sqlitePath, "shinbundang", "강남"), ["신논현", "양재"]);

  await execFileAsync(process.execPath, [
    "tools/datapack/apply-capital-route-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--snapshot", SNAPSHOT_PATH,
    "--index", indexPath,
  ], { cwd: root });
  await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
  assert.deepEqual(queryAnyangNeighbors(sqlitePath), ["관악", "명학"]);
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const pack = index.packs.find(({ id }) => id === "capital");
  assert.match(pack.sha256, /^[a-f0-9]{64}$/);
  assert.match(pack.sqliteSha256, /^[a-f0-9]{64}$/);
  assert.equal(pack.byteSize, (await readFile(packPath)).byteLength);
});

test("apply는 지원하지 않는 snapshot identity를 거부한다", async () => {
  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
  snapshot.schemaVersion = 999;
  assert.throws(() => loadCapitalRouteTopologySnapshot(snapshot), /identity is invalid/);
});
