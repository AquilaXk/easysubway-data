#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import {
  CANDIDATE_INPUT_MANIFEST_PATH,
  buildCandidateInputManifest,
  createRecordingReader,
  parseCandidateInputManifest,
  publishCandidateInputObjects,
  serializeCandidateInputManifest,
} from "./lib/candidate-input-bundle.mjs";
import { prepareNationwideCandidate } from "./prepare-nationwide-candidate-run.mjs";
import { requireOciParBaseUrl } from "./lib/kric-raw-object-storage.mjs";
import { preauthenticatedObjectStorageClient } from "./publish-object-storage.mjs";

// #942: 전국 후보가 읽은 저장소 입력을 매니페스트로 기록하고(record), 그 바이트를 OCI 공개 읽기 경로에 올린다(publish).
// record는 커밋된 preparation과 같은 조건으로 prepare를 쓰기 없이 다시 실행해 읽은 경로를 모은다. 다시 만든 preparation이
// 커밋된 preparation과 다르면(빌더 git sha 제외) 지금 입력이 후보 입력이 아니므로 기록하지 않고 실패한다.
// 사용:
//   node tools/datapack/record-nationwide-candidate-inputs.mjs record
//   node tools/datapack/record-nationwide-candidate-inputs.mjs publish   (EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL 필요)

const ROOT = path.resolve(import.meta.dirname, "../..");
const PREPARATION_PATH = "tools/datapack/release/nationwide-candidate-preparation.json";
const BUILD_SPEC_PATH = "tools/datapack/release/candidate-build-spec.json";
const FAN_IN_PATH = "tools/datapack/release/current-five-region-source-fan-in.json";
// prepare가 읽지 않지만 PR CI의 후보 재현 검사가 후보 시점 바이트로 읽어야 하는 입력이다.
export const ADDITIONAL_PINNED_INPUT_PATHS = Object.freeze([
  "tools/datapack/nationwide-coverage-targets.json",
  "tools/datapack/release/nationwide-requirement-ownership.json",
  "tools/datapack/reports/nationwide-coverage-tally.json",
  "tools/datapack/source-governance-policy.json",
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function withoutBuilderGitSha(preparation) {
  const copy = structuredClone(preparation);
  if (copy?.builderIdentity) delete copy.builderIdentity.gitSha;
  return copy;
}

export async function recordNationwideCandidateInputs({ repositoryRoot = ROOT, prepare = prepareNationwideCandidate } = {}) {
  const readLocal = (relative) => readFile(path.join(repositoryRoot, relative));
  const [preparationBytes, buildSpecBytes, fanInBytes] = await Promise.all([PREPARATION_PATH, BUILD_SPEC_PATH, FAN_IN_PATH].map(readLocal));
  const committed = JSON.parse(preparationBytes);
  const { candidateId, releaseSequence } = committed.releaseIdentity ?? {};
  const { requestedBy, approvedBy } = committed.authority ?? {};
  if (!candidateId || !Number.isSafeInteger(releaseSequence) || !requestedBy || !approvedBy
    || JSON.parse(buildSpecBytes).candidateId !== candidateId) {
    throw new Error("CANDIDATE_INPUT_RECORD_CANDIDATE_INVALID");
  }
  const recorder = createRecordingReader(readLocal);
  const result = await prepare({
    repositoryRoot, releaseSequence, requestedBy, approvedBy, writeFiles: false, readRepositoryFile: recorder.read,
  });
  if (!isDeepStrictEqual(withoutBuilderGitSha(result.preparation), withoutBuilderGitSha(committed))) {
    throw new Error("CANDIDATE_INPUT_RECORD_NOT_REPRODUCIBLE: current inputs do not reproduce the committed preparation");
  }
  for (const relative of ADDITIONAL_PINNED_INPUT_PATHS) await recorder.read(relative);
  const manifest = buildCandidateInputManifest({
    candidateId,
    candidateBuildSpecSha256: sha256(buildSpecBytes),
    preparationSha256: sha256(preparationBytes),
    fanInSha256: sha256(fanInBytes),
    entries: recorder.entries(),
  });
  await writeFile(path.join(repositoryRoot, CANDIDATE_INPUT_MANIFEST_PATH), serializeCandidateInputManifest(manifest));
  return manifest;
}

export async function publishNationwideCandidateInputs({ repositoryRoot = ROOT, env = process.env, client = null } = {}) {
  const readLocal = (relative) => readFile(path.join(repositoryRoot, relative));
  const manifest = parseCandidateInputManifest(await readLocal(CANDIDATE_INPUT_MANIFEST_PATH));
  let storage = client;
  if (!storage) {
    requireOciParBaseUrl(env);
    storage = preauthenticatedObjectStorageClient(new URL(env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL.trim()), { includeErrorBody: false });
  }
  return publishCandidateInputObjects({ manifest, readLocal, client: storage });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, ...rest] = process.argv.slice(2);
  const run = mode === "record" && rest.length === 0 ? recordNationwideCandidateInputs
    : mode === "publish" && rest.length === 0 ? publishNationwideCandidateInputs : null;
  if (!run) {
    process.stderr.write("usage: record-nationwide-candidate-inputs.mjs record|publish\n");
    process.exitCode = 1;
  } else {
    run().then((value) => {
      process.stdout.write(`${JSON.stringify(mode === "record" ? { candidateId: value.candidateId, fileCount: value.files.length } : value)}\n`);
    }, (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
