// 공용 station 카탈로그 수술 헬퍼 (#1789 P0). split/merge 도구가 공유하는
// 인자 파싱·FK-safe 노선 재지정·팩 open/write 스캐폴드를 한곳에 모아 중복을 없앤다.
import { cleanupPackDir, openPack, writePack } from "./pack-io.mjs";

/** {pack,index,check} 공통 인자 파서. */
export function parsePackArgs(argv) {
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

// 라우팅 그래프 network_edges의 노드 id는 "station_id:line_id" 문자열이며 FK가 없다.
// 따라서 station_lines를 옮겨도 이 노드가 따라오지 않아 foreign_key_check로는 못 잡는
// 고아가 생긴다(경로탐색 단절). 아래 헬퍼로 노드 접두 station_id를 함께 옮긴다.

/** 정확히 `${fromStationId}:${lineId}` 노드를 `${toStationId}:${lineId}`로 재지정. */
export function rehomeLineNode(db, fromStationId, toStationId, lineId) {
  const from = `${fromStationId}:${lineId}`;
  const to = `${toStationId}:${lineId}`;
  db.prepare("UPDATE network_edges SET from_node_id=? WHERE from_node_id=?").run(to, from);
  db.prepare("UPDATE network_edges SET to_node_id=? WHERE to_node_id=?").run(to, from);
}

/**
 * `${fromStationId}:...`로 시작하는 모든 network_edges 노드의 station 접두를
 * toStationId로 옮긴다(line 접미는 보존). 병합으로 흡수 역이 삭제된 뒤 남은 잔여
 * 노드를 idempotent하게 복구할 때 사용한다.
 */
export function rehomeAllStationNodes(db, fromStationId, toStationId) {
  const like = `${fromStationId}:%`;
  const cut = fromStationId.length + 1; // ":line…" 부터 보존 (1-based substr)
  db.prepare(
    "UPDATE network_edges SET from_node_id = ? || substr(from_node_id, ?) WHERE from_node_id LIKE ?",
  ).run(toStationId, cut, like);
  db.prepare(
    "UPDATE network_edges SET to_node_id = ? || substr(to_node_id, ?) WHERE to_node_id LIKE ?",
  ).run(toStationId, cut, like);
}

/**
 * 한 노선의 (station_lines + route_map_positions + network_edges 노드) 행을
 * from→to station_id로 이전한다. route_map_positions.(station_id,line_id)→station_lines
 * FK가 걸려 있어(원행을 먼저 바꾸면 positions가 순간 고아) 복제→positions 재지정→원행
 * 삭제 순서로 무결성을 유지한다. network_edges는 FK가 없으므로 노드 접두를 함께 옮겨
 * 라우팅 그래프 정합을 지킨다. 대상 id가 이미 그 노선을 가지면 PK 충돌이므로 예외.
 */
export function reparentLine(db, { fromStationId, toStationId, lineId, label = "" }) {
  const dup = db
    .prepare("SELECT 1 FROM station_lines WHERE station_id=? AND line_id=?")
    .get(toStationId, lineId);
  if (dup) throw new Error(`${label}: 대상 id가 이미 ${lineId} 멤버 — PK 충돌, 수동 확인`);
  const sl = db
    .prepare("SELECT * FROM station_lines WHERE station_id=? AND line_id=?")
    .get(fromStationId, lineId);
  if (!sl) throw new Error(`${label}: 이동할 station_line 없음 (${fromStationId},${lineId})`);
  const cols = Object.keys(sl);
  db.prepare(
    `INSERT INTO station_lines (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...cols.map((c) => (c === "station_id" ? toStationId : sl[c])));
  db.prepare(
    "UPDATE route_map_positions SET station_id=? WHERE station_id=? AND line_id=?",
  ).run(toStationId, fromStationId, lineId);
  rehomeLineNode(db, fromStationId, toStationId, lineId);
  db.prepare("DELETE FROM station_lines WHERE station_id=? AND line_id=?").run(
    fromStationId,
    lineId,
  );
}

/**
 * 변이된 팩의 참조 무결성 게이트. openPack이 foreign_keys OFF로 열기 때문에 미완전
 * 수술이 조용히 통과하지 않도록, write 직전 이 검사를 강제한다.
 *  1) PRAGMA foreign_key_check == 0 (station_lines/stations 참조 자식 테이블)
 *  2) network_edges의 station:line 노드가 실제 station_lines 멤버십과 대응 (FK 없음)
 * 위반 시 throw하여 손상 팩이 커밋되지 않게 한다.
 */
export function assertReferentialIntegrity(db) {
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  if (fk.length > 0) {
    throw new Error(
      `foreign_key_check 위반 ${fk.length}건: ${JSON.stringify(fk.slice(0, 5))}`,
    );
  }
  const memberships = new Set(
    db
      .prepare("SELECT station_id || ':' || line_id AS node FROM station_lines")
      .all()
      .map((r) => r.node),
  );
  const nodePattern = /^station-[0-9a-f]{12}:line-[0-9a-f]{12}$/;
  const dangling = new Set();
  for (const e of db
    .prepare("SELECT from_node_id, to_node_id FROM network_edges")
    .all()) {
    for (const n of [e.from_node_id, e.to_node_id]) {
      const node = String(n);
      if (nodePattern.test(node) && !memberships.has(node)) dangling.add(node);
    }
  }
  if (dangling.size > 0) {
    throw new Error(
      `network_edges 고아 노드 ${dangling.size}개(멤버십 없음): ${[...dangling].slice(0, 10).join(", ")}`,
    );
  }
}

/**
 * 팩을 임시 sqlite로 열어 `run(db)`를 실행하고, check가 아니면 다시 써 넣는다.
 * `run`은 BEGIN/COMMIT과 콘솔 출력을 스스로 처리한다(check 모드는 write 생략).
 */
export function mutatePack({ pack, index, tmpPrefix, check, run }) {
  const { db, dir, sqlitePath, packPath } = openPack(pack, tmpPrefix);
  try {
    run(db);
    if (check) return;
    assertReferentialIntegrity(db);
    db.close();
    const { byteSize } = writePack({
      sqlitePath,
      packPath,
      packRelPath: pack,
      indexRelPath: index,
    });
    console.log(`팩 갱신 (byteSize ${byteSize})`);
  } finally {
    cleanupPackDir(dir);
  }
}
