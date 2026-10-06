#!/usr/bin/env node
// ITX-청춘 승격 뒤 파생 재결속(#979, #870 3단계 후속). 승격(--auto-gate)이 coverage contract와 원천·완전성 증거·게이트 영수증을 쓴 직후에
// 같은 workflow 안에서 돌아, 승격 PR 하나가 사람 손 없이 required CI를 통과하게 한다.
//
//  1. 게이트 승격 근거를 다시 계산해 확인한다(verifyCurrentItxPromotion).
//  2. 저장소 안 apps/mobile에 stage된 입력 fixture 팩(ITX topology 적용 전, mobile 고정 커밋)에 새 원천 topology를 적용해 팩·index·증거를 만든다
//     (apply-itx-topology write 모드). 입력 팩 식별은 contract의 topologyInputPackIdentity와 같아야 한다.
//  3. 증거를 승격 snapshot의 버전 증거(itx-cheongchun-topology-evidence-<stamp>.json)로도 남긴다(후보 생성이 읽는다).
//  4. 후보 build spec의 ITX 결속(contract sha·버전 증거 경로·sha)을 새 원천으로 바꾼다(bindApprovedItxCurrentSourceSpec).
//  5. 5권역 alignment fixture의 packSha256만 새 팩으로 다시 맞춘다. 다른 값이 바뀌면 이상이라 실패한다.
// 출력 팩은 mobile 레포에 커밋하지 않는다. CI staging이 같은 입력 fixture에서 같은 팩을 파생하고 증거와 대조한다.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { bindApprovedItxCurrentSourceSpec, deriveApprovedItxTopologyEvidencePath } from "./activate-current-source-set.mjs";
import { verifyCurrentItxPromotion } from "./lib/itx-promotion-authority.mjs";

const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const CONTRACT = "tools/datapack/itx-cheongchun-coverage-contract.json";
const EVIDENCE = "tools/datapack/itx-cheongchun-topology-evidence.json";
const SPEC = "tools/datapack/release/candidate-build-spec.json";
export const ALIGNMENT_FIXTURES = Object.freeze([
  "busan", "daegu", "daejeon", "gwangju", "seoul",
].map((name) => `tools/route-map/route-map-defs/${name}-alignment-fixture.json`));

function fail(code, detail = "") {
  throw new Error(detail ? `ITX_REBINDING_${code}: ${detail}` : `ITX_REBINDING_${code}`);
}

async function run(repositoryRoot, script, args, env = {}) {
  try {
    await execFileAsync(process.execPath, [path.join(repositoryRoot, script), ...args], {
      cwd: repositoryRoot, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const lines = String(error?.stderr || error?.message).split("\n").filter((line) => line.trim() !== "");
    fail("TOOL_FAILED", `${script}: ${lines.find((line) => /error/iu.test(line)) ?? lines[0]}`);
  }
}

/** 승격 snapshot 하나의 파생 결속을 만든다. 바뀐 저장소 상대 경로를 정렬해 돌려준다. */
export async function rebindItxPromotion({ repositoryRoot: requestedRoot, buildNow }) {
  if (!path.isAbsolute(requestedRoot)) fail("ARGUMENTS", "repositoryRoot must be absolute");
  // 하위 도구의 직접 실행 판정은 실경로(import.meta.url)와 argv[1]을 비교하므로 심볼릭 링크 경로를 풀어 넘긴다.
  const repositoryRoot = await realpath(requestedRoot);
  if (typeof buildNow !== "string" || Number.isNaN(Date.parse(buildNow)) || new Date(buildNow).toISOString() !== buildNow) fail("ARGUMENTS", "buildNow must be an ISO instant");
  const read = (relative) => readFile(path.join(repositoryRoot, relative));
  const contractBytes = await read(CONTRACT);
  const reference = JSON.parse(contractBytes).sourceTimetableArtifact;
  verifyCurrentItxPromotion({ reference, repositoryRoot });
  if (reference.promotion?.mode !== "CURRENT_CANDIDATE_GATE_PASSED") fail("PROMOTION_MODE", "only gate promotions are rebound automatically");

  // 2. 입력 fixture에 topology를 적용한다(입력 팩 sha가 contract와 다르면 도구가 거부한다).
  const packRelative = "apps/mobile/assets/datapacks/capital.sqlite.gz";
  const packPath = path.join(repositoryRoot, packRelative);
  await run(repositoryRoot, "tools/datapack/apply-itx-topology-to-bundled-pack.mjs", [], { EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow });
  const evidenceBytes = await read(EVIDENCE);
  const evidence = JSON.parse(evidenceBytes);
  if (evidence.sourceArtifact?.sha256 !== reference.sha256) fail("EVIDENCE_MISMATCH", "evidence source sha is not the promoted source");
  if (evidence.pack?.outputSha256 !== sha256(await readFile(packPath))) fail("EVIDENCE_MISMATCH", "evidence output sha is not the rewritten pack");

  // 3. 버전 증거
  const versionedPath = deriveApprovedItxTopologyEvidencePath(reference);
  await writeFile(path.join(repositoryRoot, versionedPath), evidenceBytes, { flag: "wx" });

  // 4. 후보 build spec 결속
  const baseSpec = JSON.parse(await read(SPEC));
  const bound = await bindApprovedItxCurrentSourceSpec({
    baseSpec,
    coverageContractBytes: contractBytes,
    sourceBytes: await read(reference.artifactPath),
    completenessBytes: await read(reference.completenessEvidencePath),
    topologyEvidenceBytes: evidenceBytes,
    topologyEvidencePath: versionedPath,
    buildNow,
    repositoryRoot,
  });
  await writeFile(path.join(repositoryRoot, SPEC), `${JSON.stringify(bound, null, 2)}\n`);

  // 5. alignment fixture: packSha256만 바뀌어야 한다.
  const changed = [EVIDENCE, versionedPath, SPEC];
  for (const relative of ALIGNMENT_FIXTURES) {
    const currentBytes = await read(relative);
    const current = JSON.parse(currentBytes);
    await run(repositoryRoot, "tools/route-map/generate-basemap-alignment-fixture.mjs", [
      "--pack", packRelative, "--geometry", current.generatedFrom.geometry, "--region", current.region, "--out", relative,
    ]);
    const next = JSON.parse(await read(relative));
    const normalized = structuredClone(next);
    normalized.generatedFrom.packSha256 = current.generatedFrom.packSha256;
    if (JSON.stringify(normalized) !== JSON.stringify(current)) {
      await writeFile(path.join(repositoryRoot, relative), currentBytes);
      fail("ALIGNMENT_CONTENT_CHANGED", relative);
    }
    if (next.generatedFrom.packSha256 !== current.generatedFrom.packSha256) changed.push(relative);
  }
  return changed.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || Object.hasOwn(values, key.slice(2)) || typeof argv[index + 1] !== "string") fail("ARGUMENTS", String(key));
    values[key.slice(2)] = argv[index + 1];
  }
  for (const key of ["repository-root", "build-now"]) if (!Object.hasOwn(values, key)) fail("ARGUMENTS", `missing --${key}`);
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = parseArgs(process.argv.slice(2));
    const changed = await rebindItxPromotion({ repositoryRoot: values["repository-root"], buildNow: values["build-now"] });
    console.log(changed.join("\n"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
