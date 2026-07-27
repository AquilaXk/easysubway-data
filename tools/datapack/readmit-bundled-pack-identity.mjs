#!/usr/bin/env node
/**
 * tools/datapack/readmit-bundled-pack-identity.mjs
 *
 * 목적:
 *   apps/mobile/assets/datapacks/capital.sqlite.gz(번들 canonical pack)가
 *   ITX-청춘 위상(#2097 KORAIL 완전성 심사·#2135 ADMITTED 반입)과 무관한
 *   이유로 바뀌었을 때(예: #2068 노선도 재설계·역 신원 교정) tools/datapack/
 *   itx-cheongchun-topology-evidence.json의 pack.output* 핀을 오너 승인 하에
 *   재승인(readmit)한다.
 *
 *   #2097/#2135로 이미 공식 심사된 "input"(ITX 적용 전 admitted 기준본,
 *   tools/datapack/itx-cheongchun-coverage-contract.json의
 *   officialEvidence.korailCompletenessAdmission.canonicalPackIdentity)과 ITX
 *   소스 시간표 artifact(tools/datapack/sources/itx-cheongchun-source-
 *   timetable-*.json)는 이 도구가 손대지 않는다 — 그 값들은 실제 KORAIL 심사
 *   시점의 역사적 사실이라 재작성하면 evidence 조작이 된다. 이 도구가 갱신
 *   하는 것은 오직 "output"(현재 번들 pack) 식별자와, 그 재승인이 유효함을
 *   입증하는 행 단위 diff evidence·ITX 하위그래프 불변 증명뿐이다.
 *
 * 사용 — 생성 모드(재승인 실행, tracked evidence를 갱신):
 *   node tools/datapack/readmit-bundled-pack-identity.mjs \
 *     --previous-pack <직전 admitted pack .gz 경로> \
 *     --provenance "<오너 승인 근거 텍스트>" \
 *     [--pack apps/mobile/assets/datapacks/capital.sqlite.gz] \
 *     [--evidence tools/datapack/itx-cheongchun-topology-evidence.json]
 *
 *   --previous-pack는 직전에 tracked evidence가 pin하고 있던 output pack의
 *   바이트와 정확히 일치해야 한다(재승인 체인이 실제 이전 상태에서 이어짐을
 *   보장 — git 이력에서 추출해 넘긴다):
 *     git show origin/main:apps/mobile/assets/datapacks/capital.sqlite.gz \
 *       > /tmp/previous-capital.sqlite.gz
 *
 * 사용 — 검증 모드(CI 게이트, 체인·라이브 파일 정합만 확인):
 *   node tools/datapack/readmit-bundled-pack-identity.mjs --check
 *     [--pack apps/mobile/assets/datapacks/capital.sqlite.gz] \
 *     [--evidence tools/datapack/itx-cheongchun-topology-evidence.json]
 *
 * 옵션:
 *   --pack <path>          번들 canonical pack(.sqlite.gz). 기본값
 *                          apps/mobile/assets/datapacks/capital.sqlite.gz
 *   --previous-pack <path> (생성 모드 필수) 직전 admitted pack(.sqlite.gz)
 *   --evidence <path>      기본값
 *                          tools/datapack/itx-cheongchun-topology-evidence.json
 *   --provenance <text>    (생성 모드 필수) 오너 승인 근거 기록
 *   --check                검증 모드
 *   --genesis-pack <path>  (검증 모드 전용, 테스트용) 체인의 첫 링크가 이어져야
 *                          할 pack(.sqlite.gz). 기본값은 하드코딩된
 *                          ORIGINAL_ITX_ADMISSION_OUTPUT(#2135 원 ITX 반입
 *                          output) — production 검증에서는 지정하지 않는다.
 *   --help, -h             이 사용법을 출력
 *
 * 생성 모드 fail-closed 불변식(위반 시 예외로 즉시 중단 — 파일 미기록):
 *   1) --previous-pack 바이트가 evidence.pack.output*(재승인 전 상태)와
 *      sha256(gzip)·sha256(sqlite) 모두 정확히 일치.
 *   2) network_edges WHERE service_class='ITX_CHEONGCHUN' 행 집합이 직전
 *      pack과 새 pack 사이에 byte-identical(정렬 후 비교), 정확히
 *      EXPECTED_ITX_EDGE_COUNT(48)행.
 *   3) route_service_artifact_evidence WHERE service_class='ITX_CHEONGCHUN'
 *      행이 byte-identical.
 *   4) ITX edge가 참조하는 모든 station_id:line_id가 새 pack의 station_lines
 *      ×route_map_positions 조인에 그대로 존재(멤버십 소실 없음).
 *   5) 새 pack이 PRAGMA foreign_key_check·integrity_check 정상, user_version
 *      == 18.
 *   6) 새 pack이 직전 pack과 최소 1바이트 이상 달라야 함(무의미한 재승인
 *      거부).
 *
 * 검증 모드가 확인하는 것(체인 무결성 + 라이브 파일 정합):
 *   - evidence.readmissions가 있으면: 각 항목의 previousPack이 직전 항목의
 *     newPack과 연쇄(첫 항목은 ORIGINAL_ITX_ADMISSION_OUTPUT과 연쇄)하고,
 *     마지막 항목의 newPack이 evidence.pack.output*과 일치.
 *   - evidence.pack.outputSha256/outputSqliteSha256이 실제 --pack 파일의
 *     현재 바이트와 일치(재승인 없이 직접 pack을 건드리는 무단 변조는 그대로
 *     걸린다 — 이 도구도, build-server-timetable-snapshot.mjs도,
 *     apply-itx-topology-to-bundled-pack.mjs --check도 전부 같은 이유로
 *     실패한다).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { codepointCompare } from "../lib/codepoint-compare.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ITX_SERVICE_CLASS = "ITX_CHEONGCHUN";
const EXPECTED_ITX_EDGE_COUNT = 48;
const EXPECTED_CATALOG_VERSION = 18;
// #2135 원 ITX 반입(commit 35da1b71)이 만든 최초 output identity — 이후
// 프레시니스 갱신(commit 3cad7466)까지 반영된, 재승인 체인이 시작되기 직전의
// 마지막 순정 ITX-only output. 재승인 체인의 첫 링크는 반드시 여기서
// 이어져야 한다(위조된 체인의 시작점 방지).
const ORIGINAL_ITX_ADMISSION_OUTPUT = {
  sha256: "dfe8420b2f26d2ca2948575098e0a6a5e278c3b203f7cd9c1f1b588a07e74b02",
  sqliteSha256: "c39f23cd6b8b20f88672d0456b72a4efbd3697b81035cfb49ded289e50f3a4aa",
  byteSize: 359388,
};
// 행 diff에서 개별 행 키까지 evidence에 싣는 상한(초과 테이블은 카운트만 —
// route_map_positions 좌표 재해석 등 수백~수천 행 규모 변경까지 원문을 실으면
// evidence sidecar가 비대해진다).
const CHANGED_ROW_DETAIL_LIMIT = 20;

function printHelp() {
  process.stdout.write(`readmit-bundled-pack-identity.mjs — capital.sqlite.gz canonical pack 재승인 도구

생성 모드:
  node tools/datapack/readmit-bundled-pack-identity.mjs \\
    --previous-pack <직전 admitted pack .gz 경로> \\
    --provenance "<오너 승인 근거 텍스트>" \\
    [--pack apps/mobile/assets/datapacks/capital.sqlite.gz] \\
    [--evidence tools/datapack/itx-cheongchun-topology-evidence.json]

검증 모드:
  node tools/datapack/readmit-bundled-pack-identity.mjs --check

파일 상단 주석에 fail-closed 불변식·옵션 전체 설명이 있습니다.
`);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryPath(value) {
  return path.resolve(root, value);
}

function withSqlite(gzipBytes, label, fn) {
  const directory = mkdtempSync(path.join(tmpdir(), `readmit-pack-${label}-`));
  try {
    const sqlitePath = path.join(directory, "capital.sqlite");
    let sqliteBytes;
    try {
      sqliteBytes = gunzipSync(gzipBytes);
    } catch {
      throw new Error(`${label} pack is not valid gzip`);
    }
    writeFileSync(sqlitePath, sqliteBytes);
    const database = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      return fn(database, sqliteBytes);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function listTables(database) {
  return database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
}

function primaryKeyColumns(database, table) {
  const info = database.prepare(`PRAGMA table_info("${table}")`).all();
  const pk = info.filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk).map((row) => row.name);
  return pk.length > 0 ? pk : info.map((row) => row.name);
}

function tableRows(database, table) {
  if (!listTables(database).includes(table)) return [];
  return database.prepare(`SELECT * FROM "${table}"`).all();
}

// 두 pack 사이 한 테이블의 행 단위 diff. PK(없으면 전 컬럼)로 행을 키잉해
// removed/added/changed(같은 키, 다른 값)를 센다. 변경 행 수가 임계 이하면
// 감사 가능하도록 키·before/after 값을 evidence에 함께 싣는다.
function diffTable(previousDb, newDb, table) {
  const pk = primaryKeyColumns(listTables(newDb).includes(table) ? newDb : previousDb, table);
  const keyOf = (row) => pk.map((column) => JSON.stringify(row[column])).join("|");
  const previousRows = tableRows(previousDb, table);
  const newRows = tableRows(newDb, table);
  const canonicalRow = (row) => JSON.stringify(Object.fromEntries(
    Object.entries(row).sort(([left], [right]) => codepointCompare(left, right)),
  ));
  const previousByKey = new Map(previousRows.map((row) => [keyOf(row), row]));
  const newByKey = new Map(newRows.map((row) => [keyOf(row), row]));
  const removedKeys = [];
  const addedKeys = [];
  const changedKeys = [];
  for (const [key, previousRow] of previousByKey) {
    if (!newByKey.has(key)) {
      removedKeys.push(key);
    } else if (canonicalRow(newByKey.get(key)) !== canonicalRow(previousRow)) {
      changedKeys.push(key);
    }
  }
  for (const key of newByKey.keys()) {
    if (!previousByKey.has(key)) addedKeys.push(key);
  }
  const totalAffected = removedKeys.length + addedKeys.length + changedKeys.length;
  const result = {
    table,
    previousRowCount: previousRows.length,
    newRowCount: newRows.length,
    rowsRemoved: removedKeys.length,
    rowsAdded: addedKeys.length,
    rowsChanged: changedKeys.length,
  };
  if (totalAffected > 0 && totalAffected <= CHANGED_ROW_DETAIL_LIMIT) {
    result.detail = {
      removed: removedKeys.map((key) => previousByKey.get(key)),
      added: addedKeys.map((key) => newByKey.get(key)),
      changed: changedKeys.map((key) => ({
        previous: previousByKey.get(key),
        new: newByKey.get(key),
      })),
    };
  }
  return result;
}

function buildRowDiffEvidence(previousDb, newDb) {
  const tables = new Set([...listTables(previousDb), ...listTables(newDb)]);
  const diffs = [];
  for (const table of [...tables].sort(codepointCompare)) {
    const diff = diffTable(previousDb, newDb, table);
    if (diff.rowsRemoved > 0 || diff.rowsAdded > 0 || diff.rowsChanged > 0) {
      diffs.push(diff);
    }
  }
  return diffs;
}

function itxNetworkEdgeRows(database) {
  return database.prepare(`
    SELECT id, from_node_id, to_node_id, duration_seconds, distance_meters,
           edge_type, service_pattern, service_class
    FROM network_edges
    WHERE service_class = ?
    ORDER BY id
  `).all(ITX_SERVICE_CLASS);
}

function itxRouteServiceEvidenceRows(database) {
  return database.prepare(`
    SELECT service_class, timetable_artifact_id, timetable_artifact_sha256,
           canonical_pack_id, canonical_pack_sha256, canonical_pack_sqlite_sha256,
           admission_status, admission_eligible, fresh_until, source_issue
    FROM route_service_artifact_evidence
    WHERE service_class = ?
  `).all(ITX_SERVICE_CLASS);
}

// ITX-청춘 하위그래프(엣지·admission evidence)가 두 pack 사이 byte-identical
// 임을 fail-closed로 증명한다. 다르면 "무관한 재승인"이 아니라 ITX 위상
// 자체를 건드린 것이므로 즉시 예외를 던져 재승인을 거부한다.
function verifyItxSubgraphUnchanged(previousDb, newDb) {
  const previousEdges = itxNetworkEdgeRows(previousDb);
  const newEdges = itxNetworkEdgeRows(newDb);
  if (previousEdges.length !== EXPECTED_ITX_EDGE_COUNT || newEdges.length !== EXPECTED_ITX_EDGE_COUNT) {
    throw new Error(
      `readmission requires exactly ${EXPECTED_ITX_EDGE_COUNT} ITX_CHEONGCHUN network_edges rows in both packs`,
    );
  }
  const previousEdgesJson = JSON.stringify(previousEdges);
  const newEdgesJson = JSON.stringify(newEdges);
  if (previousEdgesJson !== newEdgesJson) {
    throw new Error(
      "readmission refused: ITX_CHEONGCHUN network_edges differ between previous and new pack " +
      "(this is an ITX-affecting change, not eligible for unrelated-change readmission)",
    );
  }
  const previousEvidence = itxRouteServiceEvidenceRows(previousDb);
  const newEvidence = itxRouteServiceEvidenceRows(newDb);
  if (JSON.stringify(previousEvidence) !== JSON.stringify(newEvidence)) {
    throw new Error(
      "readmission refused: ITX_CHEONGCHUN route_service_artifact_evidence differs between " +
      "previous and new pack (this is an ITX-affecting change, not eligible for unrelated-change readmission)",
    );
  }
  return {
    edgesSha256: sha256(Buffer.from(previousEdgesJson)),
    evidenceSha256: sha256(Buffer.from(JSON.stringify(previousEvidence))),
    edgeCount: previousEdges.length,
  };
}

// ITX edge가 참조하는 stationId:lineId가 새 pack의 station_lines×
// route_map_positions 조인에 그대로 존재하는지 확인한다(멤버십 소실 없음 —
// 무관한 재설계가 ITX 정거장 앵커를 조용히 지우지 않았음을 증명).
function verifyItxStationMembership(database, edges) {
  const stationLineKeys = new Set();
  for (const edge of edges) {
    for (const nodeId of [edge.from_node_id, edge.to_node_id]) {
      const [stationId, lineId] = nodeId.split(":");
      stationLineKeys.add(`${stationId}:${lineId}`);
    }
  }
  const missing = [];
  for (const key of stationLineKeys) {
    const [stationId, lineId] = key.split(":");
    const present = database.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM station_lines sl
        JOIN route_map_positions rm
          ON rm.station_id = sl.station_id AND rm.line_id = sl.line_id
        WHERE sl.station_id = ? AND sl.line_id = ?
      ) AS present
    `).get(stationId, lineId).present;
    if (present !== 1) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(`readmission refused: ITX station membership missing in new pack: ${missing.join(", ")}`);
  }
}

function verifyStructuralIntegrity(database) {
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) throw new Error("readmission refused: new pack foreign_key_check failed");
  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") throw new Error("readmission refused: new pack integrity_check failed");
  const userVersion = database.prepare("PRAGMA user_version").get().user_version;
  if (userVersion !== EXPECTED_CATALOG_VERSION) {
    throw new Error(`readmission refused: new pack user_version ${userVersion} !== ${EXPECTED_CATALOG_VERSION}`);
  }
}

function packIdentity(gzipBytes, sqliteBytes) {
  return { sha256: sha256(gzipBytes), sqliteSha256: sha256(sqliteBytes), byteSize: gzipBytes.length };
}

function identitiesEqual(left, right) {
  return left?.sha256 === right?.sha256
    && left?.sqliteSha256 === right?.sqliteSha256
    && left?.byteSize === right?.byteSize;
}

function runGenerate({ packPath, previousPackPath, evidencePath, provenance }) {
  if (!previousPackPath) throw new Error("생성 모드는 --previous-pack이 필수입니다");
  if (!provenance) throw new Error("생성 모드는 --provenance가 필수입니다");
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  if (evidence?.schemaVersion !== 1 || evidence?.artifactKind !== "itx-cheongchun-mobile-topology-evidence") {
    throw new Error("readmission refused: tracked evidence schema is not recognized");
  }
  const newGzipBytes = readFileSync(packPath);
  const previousGzipBytes = readFileSync(previousPackPath);

  const currentPinnedOutput = {
    sha256: evidence.pack?.outputSha256,
    sqliteSha256: evidence.pack?.outputSqliteSha256,
    byteSize: evidence.pack?.byteSize,
  };

  return withSqlite(previousGzipBytes, "previous", (previousDb, previousSqliteBytes) => withSqlite(
    newGzipBytes,
    "new",
    (newDb, newSqliteBytes) => {
      const previousIdentity = packIdentity(previousGzipBytes, previousSqliteBytes);
      const newIdentity = packIdentity(newGzipBytes, newSqliteBytes);

      if (!identitiesEqual(previousIdentity, currentPinnedOutput)) {
        throw new Error(
          "readmission refused: --previous-pack does not match the currently tracked evidence " +
          "pack.output identity (readmission chain must continue from the last admitted state)",
        );
      }
      if (identitiesEqual(newIdentity, previousIdentity)) {
        throw new Error("readmission refused: new pack is byte-identical to the previous pack (nothing to readmit)");
      }

      verifyStructuralIntegrity(newDb);
      const itxProof = verifyItxSubgraphUnchanged(previousDb, newDb);
      verifyItxStationMembership(newDb, itxNetworkEdgeRows(newDb));
      const rowDiff = buildRowDiffEvidence(previousDb, newDb);

      const readmissions = Array.isArray(evidence.readmissions) ? [...evidence.readmissions] : [];
      readmissions.push({
        readmittedAt: new Date().toISOString(),
        provenance,
        previousPack: previousIdentity,
        newPack: newIdentity,
        byteSizeDelta: newIdentity.byteSize - previousIdentity.byteSize,
        itxSubgraph: {
          unchanged: true,
          edgeCount: itxProof.edgeCount,
          edgesSha256: itxProof.edgesSha256,
          evidenceSha256: itxProof.evidenceSha256,
        },
        rowDiff,
      });

      const nextEvidence = {
        ...evidence,
        pack: {
          ...evidence.pack,
          outputSha256: newIdentity.sha256,
          outputSqliteSha256: newIdentity.sqliteSha256,
          byteSize: newIdentity.byteSize,
          byteSizeDelta: newIdentity.byteSize - evidence.pack.inputByteSize,
        },
        readmissions,
      };
      writeFileSync(evidencePath, `${JSON.stringify(nextEvidence, null, 2)}\n`);
      process.stdout.write(
        `readmitted capital pack: ${previousIdentity.sha256.slice(0, 12)} -> ${newIdentity.sha256.slice(0, 12)} ` +
        `(rows diff across ${rowDiff.length} tables, ITX subgraph unchanged: ${itxProof.edgeCount} edges)\n`,
      );
      return nextEvidence;
    },
  ));
}

function runCheck({ packPath, evidencePath, genesisIdentity }) {
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const packGzipBytes = readFileSync(packPath);
  const livePackSha256 = sha256(packGzipBytes);
  if (evidence?.pack?.outputSha256 !== livePackSha256) {
    throw new Error("readmission check failed: tracked evidence pack.outputSha256 does not match the live pack file");
  }
  const readmissions = Array.isArray(evidence.readmissions) ? evidence.readmissions : [];
  let expectedPrevious = genesisIdentity;
  for (const [index, entry] of readmissions.entries()) {
    if (!identitiesEqual(entry.previousPack, expectedPrevious)) {
      throw new Error(`readmission check failed: readmissions[${index}].previousPack breaks the identity chain`);
    }
    if (entry.itxSubgraph?.unchanged !== true || entry.itxSubgraph?.edgeCount !== EXPECTED_ITX_EDGE_COUNT) {
      throw new Error(`readmission check failed: readmissions[${index}] does not prove the ITX subgraph invariant`);
    }
    expectedPrevious = entry.newPack;
  }
  if (readmissions.length > 0) {
    const last = readmissions.at(-1).newPack;
    if (!identitiesEqual(last, {
      sha256: evidence.pack.outputSha256,
      sqliteSha256: evidence.pack.outputSqliteSha256,
      byteSize: evidence.pack.byteSize,
    })) {
      throw new Error("readmission check failed: evidence.pack.output* does not match the last readmission's newPack");
    }
  }
  process.stdout.write(
    `readmission chain OK: ${readmissions.length} readmission(s), live pack matches pack.outputSha256=${livePackSha256.slice(0, 12)}\n`,
  );
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  const packPath = path.resolve(root, option("--pack", "apps/mobile/assets/datapacks/capital.sqlite.gz"));
  const evidencePath = path.resolve(
    root,
    option("--evidence", "tools/datapack/itx-cheongchun-topology-evidence.json"),
  );
  if (process.argv.includes("--check")) {
    const genesisPackArgument = option("--genesis-pack", null);
    const genesisIdentity = genesisPackArgument == null
      ? ORIGINAL_ITX_ADMISSION_OUTPUT
      : packIdentity(readFileSync(repositoryPath(genesisPackArgument)), gunzipSync(readFileSync(repositoryPath(genesisPackArgument))));
    runCheck({ packPath, evidencePath, genesisIdentity });
    return;
  }
  const previousPackArgument = option("--previous-pack", null);
  const previousPackPath = previousPackArgument == null ? null : repositoryPath(previousPackArgument);
  const provenance = option("--provenance", null);
  runGenerate({ packPath, previousPackPath, evidencePath, provenance });
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
