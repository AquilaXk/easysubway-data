import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { packMarkerOnlyViolations } from "../../ci/refresh-stage-contracts.mjs";

// #1067: 수도권 topology 갱신이 pack의 출처 표식만 바꾼 뒤의 계약 테스트가 쓰는 갱신 전 pack 읽기.
// 갱신은 canonical pack의 출처 표식만 바꾸고(#1063이 구조 diff로 허용), applicability·지표는 이후 파생 재결속이 다시 묶는다.
// 그래서 갱신 PR뿐 아니라 그 뒤 재결속이 병합되기 전까지의 모든 PR(등록·다른 원천 갱신)에서 applicability는 갱신 전 pack을 선언하고,
// 그 pack은 작업 트리에도 후보 고정 입력에도 없다.
//
// 선언된 pack은 PR base의 first-parent 이력에서 sha256이 정확히 같은 pack으로만 찾는다. 찾은 시점부터 base까지 pack이 바뀐 커밋마다,
// 그리고 base에서 작업 트리까지, 갱신 단계 게이트와 같은 규칙(packMarkerOnlyViolations)으로 바뀐 것이 출처 표식뿐이어야 한다.
// 표식 밖의 값이 바뀐 이력, 이력에 없는 선언, 상한을 넘은 이력, base를 정할 수 없는 실행은 바이트를 주지 않는다(추정·낡은 값 대체 없음).
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../../..");
const CANONICAL_PACK_PATH = "tools/datapack/release/capital-production-canonical-pack.json";
const SHA1 = /^[0-9a-f]{40}$/u;
const ZERO_SHA1 = /^0{40}$/u;
// 선언 시점(마지막 파생 재결속)부터 base까지의 first-parent 이력 길이 상한. 하루에 수십 커밋이 병합되므로 며칠 분이다.
export const PACK_HISTORY_DEPTH = 400;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const gitBuffer = async (cwd, args) => (await execFileAsync("git", args, { cwd, maxBuffer: 512 * 1024 * 1024, encoding: "buffer" })).stdout;

/** GitHub 이벤트 payload에서 이 실행의 base 커밋을 읽는다. pull_request는 base.sha, push는 before(새 브랜치 push의 0 sha는 base가 없다). */
export function eventBaseSha(event) {
  const sha = event?.pull_request === undefined ? event?.before : event.pull_request?.base?.sha;
  return typeof sha === "string" && SHA1.test(sha) && !ZERO_SHA1.test(sha) ? sha : null;
}

/**
 * 이 실행의 base 커밋. pull_request는 base.sha, push는 before다. 이벤트에 base가 없으면(workflow_dispatch: automerge coordinator가 BEHIND PR에
 * required context를 붙일 때 쓰는 경로, 새 브랜치 push, 이벤트 없는 로컬 실행) main과 HEAD의 merge-base를 쓴다(mergeBase가 fetch 뒤 계산한다).
 * 그래도 정할 수 없으면 숨기지 않고 던진다.
 */
export async function runBaseSha({ env = process.env, readText = (file) => readFile(file, "utf8"), mergeBase } = {}) {
  if (env.GITHUB_EVENT_PATH) {
    const sha = eventBaseSha(JSON.parse(await readText(env.GITHUB_EVENT_PATH)));
    if (sha !== null) return sha;
  }
  if (typeof mergeBase !== "function") throw new Error("이 실행의 base 커밋을 정할 수 없다: 이벤트에 PR base·push before가 없고 merge-base 계산기도 없다");
  const sha = await mergeBase();
  if (!SHA1.test(sha ?? "")) throw new Error(`이 실행의 base 커밋(main과 HEAD의 merge-base)이 40자리 sha가 아니다: ${String(sha)}`);
  return sha;
}

/**
 * 커밋 이력을 읽는 git 구현. shallow checkout이면 base 이력을 blob 없이 한 번 받고(트리만), 필요한 pack blob만 지연해서 받는다.
 * 테스트는 같은 모양의 메모리 구현을 넣는다.
 */
export function gitRepo({ root = ROOT, git = gitBuffer } = {}) {
  const text = async (args) => (await git(root, args)).toString("utf8").trim();
  // 이력을 깊게 받는 fetch(--depth, --filter)는 저장소를 shallow·partial로 바꾼다. 이미 shallow인 checkout(CI)에서만 하고, 전체 이력을 가진 개발 저장소는 건드리지 않는다.
  const isShallow = async () => (await text(["rev-parse", "--is-shallow-repository"])) === "true";
  return {
    async ensureHistory(sha, depth) {
      if (!SHA1.test(sha)) throw new Error(`base 커밋이 40자리 sha가 아니다: ${String(sha)}`);
      if (!(await isShallow())) return;
      await git(root, ["fetch", "--no-tags", `--depth=${depth}`, "--filter=blob:none", "origin", sha]);
    },
    // origin/main과 HEAD의 이력을 받아 merge-base를 구한다. 상한 안에서 공통 조상이 없으면 git이 실패해 그대로 던진다.
    async mergeBase(depth) {
      const deepen = (await isShallow()) ? [`--depth=${depth}`, "--filter=blob:none"] : [];
      await git(root, ["fetch", "--no-tags", ...deepen, "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      if (deepen.length > 0) await git(root, ["fetch", "--no-tags", ...deepen, "origin", await text(["rev-parse", "HEAD"])]);
      return text(["merge-base", "origin/main", "HEAD"]);
    },
    async firstParents(sha, limit) {
      return (await text(["rev-list", "--first-parent", "-n", String(limit), sha])).split("\n").filter(Boolean);
    },
    async blobOid(commit, relative) {
      try { return await text(["rev-parse", `${commit}:${relative}`]); } catch { return null; }
    },
    readBlob: (oid) => git(root, ["cat-file", "blob", oid]),
    async readAt(commit, relative) {
      return (await git(root, ["show", `${commit}:${relative}`])).toString("utf8");
    },
  };
}

/** refresh-stage-contracts가 읽는 files 계약. 작업 트리(head)는 파일에서, base는 커밋에서 읽는다. */
function filesBetween({ repo, readTree }) {
  return { readTree, readBase: (sha, relative) => repo.readAt(sha, relative) };
}

/**
 * 선언된 pack 바이트. PR base의 first-parent 이력에서 sha256이 선언과 같은 pack을 찾고, 거기서 작업 트리까지 바뀐 것이 출처 표식뿐일 때만 돌려준다.
 * 아니면 사유를 담아 던진다.
 * @param {{ baseSha: string, declaredSha256: string, repo: ReturnType<typeof gitRepo>, readWorking?: (relative: string) => Promise<string>, depth?: number }} input
 */
export async function priorCanonicalPackBytes({ baseSha, declaredSha256, repo, readWorking = (relative) => readFile(path.join(ROOT, relative), "utf8"), depth = PACK_HISTORY_DEPTH }) {
  if (!/^[0-9a-f]{64}$/u.test(declaredSha256 ?? "")) throw new Error("applicability가 선언한 canonical pack sha256 형식이 다르다");
  await repo.ensureHistory(baseSha, depth);
  const chain = await repo.firstParents(baseSha, depth);
  if (chain[0] !== baseSha) throw new Error(`base 커밋(${baseSha})의 이력을 읽지 못했다`);
  const oids = [];
  const shaOfOid = new Map();
  let found = -1;
  let foundBytes = null;
  for (const commit of chain) {
    const oid = await repo.blobOid(commit, CANONICAL_PACK_PATH);
    if (oid === null) break;
    oids.push(oid);
    if (!shaOfOid.has(oid)) {
      const bytes = await repo.readBlob(oid);
      shaOfOid.set(oid, sha256(bytes));
      if (shaOfOid.get(oid) === declaredSha256) { foundBytes = bytes; }
    }
    if (shaOfOid.get(oid) === declaredSha256) { found = oids.length - 1; break; }
  }
  if (found < 0 && oids.length >= depth) {
    throw new Error(`선언된 pack(${declaredSha256})을 base(${baseSha})의 first-parent 이력 상한 ${depth}커밋 안에서 찾지 못했다(이력이 상한에서 잘렸다. 파생 재결속이 밀렸거나 상한을 올려야 한다)`);
  }
  if (found < 0) throw new Error(`선언된 pack(${declaredSha256})이 base(${baseSha})의 first-parent 이력 ${oids.length}커밋 어디에도 없다(선언이 이력에 없다)`);
  // 선언 시점부터 base까지: pack이 바뀐 커밋은 모두 출처 표식 변경뿐이어야 한다.
  for (let index = found; index > 0; index -= 1) {
    if (oids[index] === oids[index - 1]) continue;
    const violations = await packMarkerOnlyViolations({ baseSha: chain[index], files: filesBetween({ repo, readTree: (relative) => repo.readAt(chain[index - 1], relative) }), packPath: CANONICAL_PACK_PATH });
    if (violations.length > 0) {
      throw new Error(`pack이 ${chain[index]}에서 ${chain[index - 1]}로 바뀔 때 출처 표식 밖이 바뀌었다(${violations.length}건): ${violations.slice(0, 3).join(" | ")}`);
    }
  }
  // base에서 작업 트리까지.
  const violations = await packMarkerOnlyViolations({ baseSha, files: filesBetween({ repo, readTree: readWorking }), packPath: CANONICAL_PACK_PATH });
  if (violations.length > 0) {
    throw new Error(`PR base의 canonical pack(${baseSha})에서 작업 트리까지 출처 표식 밖이 바뀌었다(${violations.length}건): ${violations.slice(0, 3).join(" | ")}`);
  }
  return Buffer.from(foundBytes);
}

/** declaredBytes의 readBase 자리에 넣는 읽기. base를 정할 수 없으면 사유와 함께 던진다. */
export function prBaseCanonicalPackReader({ declaredSha256, env = process.env, repo = gitRepo(), readWorking } = {}) {
  return async () => {
    const baseSha = await runBaseSha({ env, mergeBase: () => repo.mergeBase(PACK_HISTORY_DEPTH) });
    return priorCanonicalPackBytes({ baseSha, declaredSha256, repo, ...(readWorking === undefined ? {} : { readWorking }) });
  };
}
