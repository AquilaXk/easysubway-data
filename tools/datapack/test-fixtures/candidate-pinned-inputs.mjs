import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CANDIDATE_INPUT_MANIFEST_PATH,
  createCandidateInputReader,
  parseCandidateInputManifest,
} from "../lib/candidate-input-bundle.mjs";

// #942: PR CI의 후보 재현 검사는 작업 트리 대신 커밋된 후보가 고정한 입력 바이트를 읽는다.
// 작업 트리 바이트가 고정값과 같으면 그대로 쓰고, 다르면(원천 등록만 한 PR) 공개 읽기 경로
// EASYSUBWAY_DATA_PACK_BASE_URL에서 고정 sha256 객체를 받아 확인한다. CI는 같은 버킷 공개 경로인
// vars.OCI_SERVER_ROUTE_PUBLIC_BASE_URL(서버 경로 번들용 변수, 용도 공유)을 이 이름으로 넘긴다.
// 받지 못하거나 sha가 다르면 테스트가 실패한다(건너뛰지 않는다).
const ROOT = path.resolve(import.meta.dirname, "../../..");

export async function committedCandidateInputManifest(root = ROOT) {
  return parseCandidateInputManifest(await readFile(path.join(root, CANDIDATE_INPUT_MANIFEST_PATH)));
}

// 작업 트리에서 그대로 읽어도 되는 후보 산출물이다. 전국 후보 갱신 도구가 한 번에 다시 쓰는 출력이라 커밋된 후보와 함께 움직인다.
// production 상수를 import하지 않고 여기 고정한다. 갱신 도구 출력 목록(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS)과 같은지는
// nationwide-candidate-pin-consistency.test.mjs가 확인한다.
export const CANDIDATE_OUTPUT_PATHS = Object.freeze([
  "release/product-gates/production-datapack-scope.json",
  "release/product-gates/route-edge-evaluation-policy.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/current-five-region-source-fan-in.json",
  "tools/datapack/release/hash-evidence.json",
  "tools/datapack/release/nationwide-candidate-input-manifest.json",
  "tools/datapack/release/nationwide-candidate-preparation.json",
  "tools/datapack/release/nationwide-capital-timetable-report.json",
  "tools/datapack/release/nationwide-car-door-hint-quarantine.json",
  "tools/datapack/release/nationwide-official-line-timetable-report.json",
  "tools/datapack/release/nationwide-official-stop-times.json.gz",
  "tools/datapack/release/nationwide-production-canonical-pack.json",
  "tools/datapack/release/nationwide-regional-timetable-quarantine.json",
  "tools/datapack/release/nationwide-route-edge-input.json",
  "tools/datapack/release/nationwide-station-line-input.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/reports/nationwide-requirement-ownership-ledger.json",
]);

// 후보 입력은 고정 바이트로, 후보 산출물(CANDIDATE_OUTPUT_PATHS)은 커밋된 바이트로 읽는다.
// 그 밖의 경로는 후보와 결속되지 않았으므로 CANDIDATE_INPUT_NOT_PINNED로 실패한다.
export async function candidatePinnedReader({ root = ROOT, env = process.env, fetchImpl = fetch, cacheDirectory } = {}) {
  const readLocal = (relative) => readFile(path.join(root, relative));
  const manifest = await committedCandidateInputManifest(root);
  const pinned = new Set(manifest.files.map(({ path: relative }) => relative));
  const outputs = new Set(CANDIDATE_OUTPUT_PATHS);
  const readPinned = createCandidateInputReader({
    manifest, readLocal, baseUrl: env.EASYSUBWAY_DATA_PACK_BASE_URL, fetchImpl, ...(cacheDirectory ? { cacheDirectory } : {}),
  });
  return (relative) => (!pinned.has(relative) && outputs.has(relative) ? readLocal(relative) : readPinned(relative));
}

/**
 * 후보 작업 공간 안의 저장소 상대 경로만 절대 경로로 바꾼다. 절대 경로·상위 경로 인자는 작업 공간을 무시하고 작업 트리를
 * 읽게 되므로 실패시킨다(#954 리뷰 F2). 테스트가 직접 쓴 임시 파일은 이 함수를 거치지 않고 읽는다.
 */
export function candidateWorkspacePath(candidateRoot, relative) {
  if (typeof relative !== "string" || relative === "" || path.isAbsolute(relative) || relative.includes("\\")
    || relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`CANDIDATE_WORKSPACE_PATH_NOT_RELATIVE: ${String(relative)}`);
  }
  return path.join(candidateRoot, relative);
}

export async function candidatePinnedJson(read, relative) {
  return JSON.parse((await read(relative)).toString("utf8"));
}

/**
 * 하위 프로세스로 도구를 실행하는 후보 재현 테스트용 작업 공간.
 * 고정 입력이 모두 작업 트리와 같으면 저장소 루트를 그대로 쓴다(일반 PR).
 * 다르면(원천만 등록한 PR) 다른 고정 입력의 바이트를 먼저 받아 확인한 뒤, 저장소를 임시 디렉터리에 복사하고
 * 그 입력만 고정 바이트로 덮어쓴다. 도구 코드와 고정되지 않은 파일은 이 PR의 것을 그대로 쓴다.
 * cleanup()이나 프로세스 종료 때 임시 디렉터리를 지운다. 받기에 실패하면 작업 공간을 만들지 않고 실패한다.
 */
export async function candidatePinnedWorkspace({ root = ROOT, env = process.env, fetchImpl = fetch, cacheDirectory } = {}) {
  const manifest = await committedCandidateInputManifest(root);
  const read = createCandidateInputReader({
    manifest, readLocal: (relative) => readFile(path.join(root, relative)), baseUrl: env.EASYSUBWAY_DATA_PACK_BASE_URL, fetchImpl,
    ...(cacheDirectory ? { cacheDirectory } : {}),
  });
  const stale = [];
  for (const entry of manifest.files) {
    const local = await readFile(path.join(root, entry.path)).catch(() => null);
    if (!local || createHash("sha256").update(local).digest("hex") !== entry.sha256) stale.push(entry);
  }
  if (stale.length === 0) return { root, stalePaths: [], cleanup: async () => {} };
  const pinnedBytes = new Map();
  for (const entry of stale) pinnedBytes.set(entry.path, await read(entry.path));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "easysubway-candidate-pinned-"));
  const remove = () => rmSync(workspace, { recursive: true, force: true });
  process.once("exit", remove);
  const excluded = new Set([".git", "node_modules", ".external"]);
  await cp(root, workspace, {
    recursive: true,
    filter: (source) => !excluded.has(path.relative(root, source).split(path.sep)[0]),
  });
  for (const [relative, bytes] of pinnedBytes) await writeFile(path.join(workspace, relative), bytes);
  return {
    root: workspace,
    stalePaths: stale.map(({ path: relative }) => relative),
    cleanup: async () => { process.removeListener("exit", remove); remove(); },
  };
}

/**
 * 테스트 파일이 프로세스당 한 번만 후보 작업 공간을 만들고 거기서 상대 경로로 읽게 한다(#954).
 * root()는 작업 공간 루트, read(relative, encoding)는 작업 공간 안의 저장소 상대 경로를 읽는다.
 */
export function candidateWorkspaceAccess() {
  let rootPromise;
  const root = () => (rootPromise ??= candidatePinnedWorkspace().then(({ root: candidateRoot }) => candidateRoot));
  const read = async (relative, encoding) => readFile(candidateWorkspacePath(await root(), relative), encoding);
  return { root, read };
}
