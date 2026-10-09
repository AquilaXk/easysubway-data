import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { packMarkerOnlyViolations } from "../../ci/refresh-stage-contracts.mjs";

// #1067: 수도권 topology 갱신 PR의 계약 테스트가 쓰는 PR base 읽기.
// 갱신 PR은 canonical pack의 출처 표식만 바꾸고(#1063이 구조 diff로 허용), applicability·지표는 병합 뒤 파생 재결속이 다시 묶는다.
// 그래서 갱신 PR의 applicability는 갱신 전(PR base) pack을 선언하고, 그 pack은 작업 트리에도 후보 고정 입력에도 없다.
// base 바이트는 base->head pack 차이가 갱신 단계 게이트와 같은 규칙(packMarkerOnlyViolations)으로 출처 표식뿐일 때만 돌려준다.
// 표식 밖의 값이 바뀐 pack은 base를 읽지 않고 사유와 함께 던진다. base를 알 수 없는 실행(CI 이벤트 없음)은 null이다.
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../../..");
const CANONICAL_PACK_PATH = "tools/datapack/release/capital-production-canonical-pack.json";
const SHA1 = /^[0-9a-f]{40}$/u;
const ZERO_SHA1 = /^0{40}$/u;

const defaultGit = async (cwd, args) => (await execFileAsync("git", args, { cwd, maxBuffer: 512 * 1024 * 1024 })).stdout;

/** GitHub 이벤트 payload에서 이 실행의 base 커밋을 읽는다. pull_request는 base.sha, push는 before(새 브랜치 push의 0 sha는 base가 없다). */
export function eventBaseSha(event) {
  const sha = event?.pull_request === undefined ? event?.before : event.pull_request?.base?.sha;
  return typeof sha === "string" && SHA1.test(sha) && !ZERO_SHA1.test(sha) ? sha : null;
}

/** GITHUB_EVENT_PATH의 이벤트로 base 커밋을 정한다. 이벤트가 없으면(로컬 실행) null이다. 읽거나 해석하지 못하면 던진다. */
export async function runBaseSha({ env = process.env, readText = (file) => readFile(file, "utf8") } = {}) {
  if (!env.GITHUB_EVENT_PATH) return null;
  return eventBaseSha(JSON.parse(await readText(env.GITHUB_EVENT_PATH)));
}

/** refresh-stage-contracts가 읽는 files 계약의 git 구현. 작업 트리는 파일에서, base는 커밋에서 읽는다. 로컬에 없는 base 커밋은 한 번 받는다(shallow checkout). */
export function gitFiles({ root = ROOT, git = defaultGit } = {}) {
  return {
    readTree: (relative) => readFile(path.join(root, relative), "utf8"),
    readBase: async (sha, relative) => {
      if (!SHA1.test(sha)) throw new Error(`base 커밋이 40자리 sha가 아니다: ${String(sha)}`);
      try {
        await git(root, ["cat-file", "-e", `${sha}^{commit}`]);
      } catch {
        await git(root, ["fetch", "--no-tags", "--depth=1", "origin", sha]);
      }
      return git(root, ["show", `${sha}:${relative}`]);
    },
  };
}

/**
 * PR base의 canonical pack 바이트. base->head 차이가 출처 표식뿐일 때만 돌려주고, 아니면 사유를 담아 던진다.
 * @param {{ baseSha: string, files: ReturnType<typeof gitFiles> }} input
 */
export async function priorCanonicalPackBytes({ baseSha, files }) {
  const violations = await packMarkerOnlyViolations({ baseSha, files, packPath: CANONICAL_PACK_PATH });
  if (violations.length > 0) {
    throw new Error(`PR base의 canonical pack(${baseSha})에서 출처 표식 밖이 바뀌었다(${violations.length}건): ${violations.slice(0, 3).join(" | ")}`);
  }
  return Buffer.from(await files.readBase(baseSha, CANONICAL_PACK_PATH), "utf8");
}

/** declaredBytes의 readBase 자리에 넣는 읽기. base를 알 수 없으면 null이다. */
export function prBaseCanonicalPackReader({ env = process.env, files = gitFiles() } = {}) {
  return async () => {
    const baseSha = await runBaseSha({ env });
    return baseSha === null ? null : priorCanonicalPackBytes({ baseSha, files });
  };
}
