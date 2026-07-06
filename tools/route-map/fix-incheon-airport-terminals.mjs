#!/usr/bin/env node
// #1789 소스 데이터 보정: 인천공항1터미널(seq 13)과 인천공항2터미널(seq 14)이
// 원천 Wikimedia PD linemap에서 한 점(331.344, 2858.222)에 붙어 화면에 한 역처럼
// 겹쳤다(공항철도 서쪽 종점 확장 구간 T1→T2 미분리). 두 역은 실제 별개 역이므로
// T2를 공항철도 진행 방향(수직 하강, x 고정)으로 한 칸(≈94px, 화물청사→T1 간격)
// 이격하고 track을 거기까지 연장한다. 8선형(수직) 보존. 이후 enrich 재생성으로
// label_polygon·up/down_path를 정합화한다.
//
// 사용: node tools/route-map/fix-incheon-airport-terminals.mjs [--pack …] [--check]
import { cleanupPackDir, openPack, writePack } from "./pack-io.mjs";

const REGION = "수도권";
const AREX_LINE = "line-e9e9a5b520a4";
const T2_STATION = "station-00ac443982bf"; // 인천공항2터미널
const T2_NEW = { x: 331.344, y: 2952.222 }; // T1(331.344,2858.222) 한 칸 아래

function parseArgs(argv) {
  const o = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    index: "apps/mobile/assets/datapacks/index.json",
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack": o.pack = argv[++i]; break;
      case "--index": o.index = argv[++i]; break;
      case "--check": o.check = true; break;
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "fix-incheon-");
  try {
    const t2 = db
      .prepare(
        "SELECT x, y FROM route_map_positions WHERE station_id=? AND region=?",
      )
      .get(T2_STATION, REGION);
    if (!t2) throw new Error(`T2 위치 없음: ${T2_STATION}`);
    const t1 = db
      .prepare(
        "SELECT p.x, p.y FROM route_map_positions p JOIN stations s ON s.id=p.station_id " +
          "WHERE s.name_ko='인천공항1터미널' AND p.region=?",
      )
      .get(REGION);
    const before = `T1(${t1.x},${t1.y}) T2(${t2.x},${t2.y})`;
    const coincident = Math.hypot(t1.x - t2.x, t1.y - t2.y) < 1;
    console.log(`before: ${before} · 동일점=${coincident}`);
    if (!coincident) {
      console.log("이미 이격됨 — 변경 없음.");
      return;
    }
    if (o.check) {
      console.log(`(--check) T2 → (${T2_NEW.x},${T2_NEW.y}) 로 이격 예정, track 연장.`);
      return;
    }
    db.exec("BEGIN");
    // 1) T2 위치 이격
    db.prepare(
      "UPDATE route_map_positions SET x=?, y=? WHERE station_id=? AND region=?",
    ).run(T2_NEW.x, T2_NEW.y, T2_STATION, REGION);
    // 2) AREX track을 T2 신위치까지 연장(현 track은 T1 점에서 끝남).
    const track = db
      .prepare(
        "SELECT track_index, path FROM route_map_line_tracks WHERE line_id=? AND region=? ORDER BY track_index",
      )
      .all(AREX_LINE, REGION);
    // T1 점(x,y)에서 끝나는 조각을 찾아 T2 점을 이어붙인다.
    const endsAtT1 = (path) => {
      const nums = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => +m[0]);
      const lx = nums[nums.length - 2];
      const ly = nums[nums.length - 1];
      return Math.hypot(lx - t1.x, ly - t1.y) < 1;
    };
    const target = track.find((t) => endsAtT1(t.path));
    if (!target) throw new Error("T1 점에서 끝나는 AREX track 조각을 못 찾음");
    const newPath = `${target.path} L ${T2_NEW.x} ${T2_NEW.y}`;
    db.prepare(
      "UPDATE route_map_line_tracks SET path=? WHERE line_id=? AND region=? AND track_index=?",
    ).run(newPath, AREX_LINE, REGION, target.track_index);
    db.exec("COMMIT");
    console.log(`after: T1(${t1.x},${t1.y}) T2(${T2_NEW.x},${T2_NEW.y}) · track 조각 ${target.track_index} 연장`);
    db.close();
    const { byteSize } = writePack({
      sqlitePath,
      packPath,
      packRelPath: o.pack,
      indexRelPath: o.index,
    });
    console.log(`팩 갱신 (byteSize ${byteSize}) — label_polygon 정합 위해 enrich 재실행 필요.`);
  } finally {
    cleanupPackDir(dir);
  }
}

main();
