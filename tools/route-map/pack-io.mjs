// route_map 도구 공용 datapack I/O 헬퍼 (#1789 Stage 1a 중복 정리).
//
// gz 팩을 임시 sqlite로 열고, 수정 후 다시 gz로 써 넣으며 index.json의
// sha/byteSize를 갱신하는 절차를 한곳에 모은다 — octolinearize/converge/
// project-nodes/snap 도구가 같은 보일러플레이트를 복제하지 않도록.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 리포지토리 루트(도구는 tools/route-map/ 아래에 있다). */
export const repoRoot = path.resolve(import.meta.dirname, "../..");

/** 리포 루트 하위로만 해석되는 절대 경로를 돌려준다(`..` 탈출·루트 밖 절대경로 차단). */
function resolveWithinRepo(relPath) {
  const resolved = path.resolve(repoRoot, relPath);
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(`경로가 리포지토리 루트를 벗어난다: ${relPath}`);
  }
  return resolved;
}

/** 버퍼의 sha256 hex 문자열. */
export const sha256 = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");

/**
 * gz 팩을 임시 sqlite 파일로 풀어 [DatabaseSync] 핸들과 경로를 연다.
 * 반환한 `dir`은 호출부가 finally에서 [cleanupPackDir]로 지운다.
 * `packRelPath`는 리포 루트 기준 상대 경로, `tmpPrefix`는 임시 디렉터리 접두.
 */
export function openPack(packRelPath, tmpPrefix) {
  const packPath = resolveWithinRepo(packRelPath);
  const sqliteBytes = gunzipSync(readFileSync(packPath));
  const dir = mkdtempSync(path.join(tmpdir(), tmpPrefix));
  const sqlitePath = path.join(dir, "pack.sqlite");
  writeFileSync(sqlitePath, sqliteBytes);
  return { db: new DatabaseSync(sqlitePath), dir, sqlitePath, packPath };
}

/**
 * 수정된 sqlite를 다시 gz(level 9)로 압축해 팩에 써 넣고 index.json의 대응 팩
 * 항목(sha256/sqliteSha256/byteSize)을 갱신한다. db를 닫은 뒤 호출한다.
 * 갱신된 `byteSize`와 gz `sha256`을 돌려준다.
 */
export function writePack({ sqlitePath, packPath, packRelPath, indexRelPath }) {
  const resolvedPackPath = resolveWithinRepo(packRelPath);
  if (path.resolve(packPath) !== resolvedPackPath) {
    throw new Error(`packPath가 packRelPath와 일치하지 않는다: ${packPath}`);
  }
  const sqliteBytes = readFileSync(sqlitePath);
  const gz = gzipSync(sqliteBytes, { level: 9 });
  writeFileSync(resolvedPackPath, gz);
  const indexPath = resolveWithinRepo(indexRelPath);
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const pack = index.packs.find((p) => packRelPath.endsWith(p.asset));
  if (pack) {
    pack.sha256 = sha256(gz);
    pack.sqliteSha256 = sha256(sqliteBytes);
    pack.byteSize = gz.length;
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  }
  return { byteSize: gz.length, sha256: sha256(gz) };
}

/** [openPack]이 만든 임시 디렉터리를 지운다. */
export function cleanupPackDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}
