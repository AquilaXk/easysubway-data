// route_map 도구 공용 datapack I/O 헬퍼 (#1789 Stage 1a 중복 정리).
//
// gz 팩을 임시 sqlite로 열고, 수정 후 다시 gz로 써 넣으며 index.json의
// sha/byteSize를 갱신하는 절차를 한곳에 모은다 — octolinearize/converge/
// project-nodes/snap 도구가 같은 보일러플레이트를 복제하지 않도록.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../lib/hash.mjs";

/** 리포지토리 루트(도구는 tools/route-map/ 아래에 있다). */
export const repoRoot = path.resolve(import.meta.dirname, "../..");

const DEFAULT_INDEX_REL_PATH = "apps/mobile/assets/datapacks/index.json";
const FALLBACK_PACK_REL_PATHS = [
  "apps/mobile/assets/datapacks/nationwide.sqlite.gz",
  "apps/mobile/assets/datapacks/capital.sqlite.gz",
];

/** 리포 루트 하위로만 해석되는 절대 경로를 돌려준다(`..` 탈출·루트 밖 절대경로 차단). */
function resolveWithinRepo(relPath, root = repoRoot) {
  const baseRoot = path.resolve(root);
  const resolved = path.resolve(baseRoot, relPath);
  if (resolved !== baseRoot && !resolved.startsWith(baseRoot + path.sep)) {
    throw new Error(`경로가 리포지토리 루트를 벗어난다: ${relPath}`);
  }
  return resolved;
}

function candidatePackRelPaths(rawPath) {
  const trimmed = String(rawPath ?? "").trim().replace(/^\/+/, "");
  if (!trimmed) return [];
  const candidates = [
    trimmed,
    path.posix.join("apps/mobile", trimmed),
    path.posix.join("apps/mobile/assets/datapacks", path.posix.basename(trimmed)),
  ];
  return [...new Set(candidates)];
}

/**
 * 번들 데이터팩(`nationwide.sqlite.gz` 또는 `capital.sqlite.gz`)의 리포 상대 경로를 해석한다.
 * `apps/mobile/assets/datapacks/index.json`이 있으면 `nationwide` -> `capital` 순으로
 * `asset`/`url` 경로가 실제 파일로 존재하는지 확인해 반환하고, 없으면
 * `nationwide.sqlite.gz` -> `capital.sqlite.gz` 순서로 존재하는 파일을 반환한다.
 */
export function resolveBundledRouteMapPackPath(root = repoRoot) {
  const baseRoot = path.resolve(root);
  const indexPath = resolveWithinRepo(DEFAULT_INDEX_REL_PATH, baseRoot);
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, "utf8"));
      const packs = Array.isArray(index?.packs) ? index.packs : [];
      for (const targetId of ["nationwide", "capital"]) {
        const entry = packs.find((pack) => pack?.id === targetId);
        if (!entry) continue;
        for (const raw of [entry.asset, entry.url]) {
          for (const candidate of candidatePackRelPaths(raw)) {
            if (existsSync(resolveWithinRepo(candidate, baseRoot))) {
              return candidate;
            }
          }
        }
      }
    } catch {
      // index.json 파싱 실패 시 파일 존재 여부 폴백으로 진행한다.
    }
  }
  for (const fallback of FALLBACK_PACK_REL_PATHS) {
    if (existsSync(resolveWithinRepo(fallback, baseRoot))) {
      return fallback;
    }
  }
  return FALLBACK_PACK_REL_PATHS[1];
}

/**
 * gz 팩을 임시 sqlite 파일로 풀어 [DatabaseSync] 핸들과 경로를 연다.
 * 반환한 `dir`은 호출부가 finally에서 [cleanupPackDir]로 지운다.
 * `packRelPath`는 리포 루트 기준 상대 경로, `tmpPrefix`는 임시 디렉터리 접두.
 */
export function openPack(packRelPath, tmpPrefix = "route-map-pack-", root = repoRoot) {
  const packPath = resolveWithinRepo(packRelPath, root);
  const sqliteBytes = gunzipSync(readFileSync(packPath));
  const dir = mkdtempSync(path.join(tmpdir(), tmpPrefix));
  const sqlitePath = path.join(dir, "pack.sqlite");
  writeFileSync(sqlitePath, sqliteBytes);
  return { db: new DatabaseSync(sqlitePath), dir, sqlitePath, packPath };
}

/** 기본 번들 노선도 데이터팩을 열어 반환한다. */
export function openDefaultPack(prefix = "route-map-pack-", root = repoRoot) {
  return openPack(resolveBundledRouteMapPackPath(root), prefix, root);
}

/**
 * 수정된 sqlite를 다시 gz(level 9)로 압축해 팩에 써 넣고 index.json의 대응 팩
 * 항목(sha256/sqliteSha256/byteSize)을 갱신한다. db를 닫은 뒤 호출한다.
 * 갱신된 `byteSize`와 gz `sha256`을 돌려준다.
 */
export function writePack({ sqlitePath, packPath, packRelPath, indexRelPath, root = repoRoot }) {
  const resolvedPackPath = resolveWithinRepo(packRelPath, root);
  if (path.resolve(packPath) !== resolvedPackPath) {
    throw new Error(`packPath가 packRelPath와 일치하지 않는다: ${packPath}`);
  }
  const sqliteBytes = readFileSync(sqlitePath);
  const gz = gzipSync(sqliteBytes, { level: 9 });
  writeFileSync(resolvedPackPath, gz);
  const indexPath = resolveWithinRepo(indexRelPath, root);
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const pack =
    index.packs.find((p) => {
      const ref = p.asset ?? p.url;
      return typeof ref === "string" && ref.length > 0 && packRelPath.endsWith(ref);
    }) ??
    index.packs.find((p) => p.id === "nationwide" || p.id === "capital");
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
