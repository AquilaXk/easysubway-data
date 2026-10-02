#!/usr/bin/env node
// #866 PR-B: release-candidate·stage·map-catalog은 전국 후보 준비(nationwide-candidate-preparation.json)가
// sha로 결속한 station-line·route-edge 입력만 쓴다. 다른 입력이나 다른 후보는 명시적으로 거부한다(대체 경로 없음).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs, requiredArg } from "./lib/cli-args.mjs";
import { sha256 } from "./lib/manifest-validation.mjs";

export const NATIONWIDE_CANDIDATE_PREPARATION_PATH = "tools/datapack/release/nationwide-candidate-preparation.json";
const PREPARATION_KEYS = [
  "schemaVersion", "artifactKind", "scopeId", "materialization", "releaseIdentity",
  "builderIdentity", "authority", "routeEdgeInput", "stationLineInput",
];
const INPUTS = [
  ["stationLineInput", "station-line input"],
  ["routeEdgeInput", "route-edge input"],
];

// preparation이 build spec과 같은 후보를 가리키는지 확인하고, 결속된 입력 경로·sha를 돌려준다.
export function bindNationwideCandidatePreparation({ preparationBytes, buildSpec }) {
  if (!Buffer.isBuffer(preparationBytes)) throw new TypeError("candidate preparation must be bytes");
  let preparation;
  try {
    preparation = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(preparationBytes));
  } catch {
    throw new Error("candidate preparation must be UTF-8 JSON");
  }
  if (!preparation || typeof preparation !== "object" || Array.isArray(preparation)
    || Object.keys(preparation).length !== PREPARATION_KEYS.length
    || PREPARATION_KEYS.some((key) => !Object.hasOwn(preparation, key))
    || preparation.schemaVersion !== 1
    || preparation.artifactKind !== "nationwide-candidate-preparation") {
    throw new Error("candidate preparation shape mismatch");
  }
  const candidateId = buildSpec?.candidateId;
  if (typeof candidateId !== "string" || candidateId.length === 0
    || preparation.scopeId !== buildSpec.productionScopeId
    || preparation.releaseIdentity?.candidateId !== candidateId
    || preparation.releaseIdentity?.publishedAt !== buildSpec.publishedAt
    || preparation.releaseIdentity?.releaseSequence !== buildSpec.releaseSequence
    || preparation.authority?.candidateId !== candidateId
    || preparation.authority?.scopeId !== preparation.scopeId
    || preparation.materialization?.fixturePath !== buildSpec.fixturePath) {
    throw new Error("candidate preparation identity mismatch");
  }
  return Object.fromEntries(INPUTS.map(([field, label]) => {
    const entry = preparation[field];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).length !== 2 || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")) {
      throw new Error(`candidate preparation ${label} binding mismatch`);
    }
    return [field, { path: repositoryRelativeJsonPath(entry.path, label), sha256: entry.sha256 }];
  }));
}

// 받은 입력 bytes가 preparation sha와 build spec 후보에 정확히 결속되는지 확인한다.
export function assertNationwideCandidateInputBytes({ binding, buildSpec, stationLineInputBytes, routeEdgeInputBytes }) {
  for (const [field, label, bytes] of [
    ["stationLineInput", "station-line input", stationLineInputBytes],
    ["routeEdgeInput", "route-edge input", routeEdgeInputBytes],
  ]) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError(`${label} must be bytes`);
    if (sha256(bytes) !== binding?.[field]?.sha256) {
      throw new Error(`${label} sha256 mismatch with nationwide candidate preparation`);
    }
    let value;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error(`${label} must be UTF-8 JSON`);
    }
    const candidate = value?.candidate;
    if (candidate?.candidateId !== buildSpec?.candidateId
      || candidate?.sourceSetSha256 !== buildSpec?.sourceSnapshotSetHash) {
      throw new Error(`${label} candidate identity mismatch`);
    }
    // #873: 전국 경로는 승강장(역-노선)에서 시작해 승강장에서 끝난다. 역 단위 ENTRY/EXIT 간선은 받지 않는다.
    if (field === "routeEdgeInput" && Array.isArray(value?.routeEdges)
      && value.routeEdges.some((edge) => edge?.edgeType === "ENTRY" || edge?.edgeType === "EXIT")) {
      throw new Error(`${label} must not contain ENTRY/EXIT edges`);
    }
  }
}

function repositoryRelativeJsonPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value) || value.includes("\\")
    || !value.endsWith(".json")
    || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`candidate preparation ${label} path must be repository-relative JSON`);
  }
  return value;
}

// map-catalog-publish가 emit 전에 같은 결속을 확인하는 CLI.
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const names = ["build-spec", "candidate-preparation", "station-line-input", "route-edge-input"];
  if (args.size !== names.length || names.some((name) => !args.has(name))) throw new Error("CLI arguments mismatch");
  const [buildSpecBytes, preparationBytes, stationLineInputBytes, routeEdgeInputBytes] = await Promise.all(
    names.map((name) => readFile(requiredArg(args, name))),
  );
  const buildSpec = JSON.parse(buildSpecBytes.toString("utf8"));
  const binding = bindNationwideCandidatePreparation({ preparationBytes, buildSpec });
  for (const [field, name] of [["stationLineInput", "station-line-input"], ["routeEdgeInput", "route-edge-input"]]) {
    if (path.posix.normalize(requiredArg(args, name)) !== binding[field].path) {
      throw new Error(`${name} path mismatch with nationwide candidate preparation`);
    }
  }
  assertNationwideCandidateInputBytes({ binding, buildSpec, stationLineInputBytes, routeEdgeInputBytes });
  return binding;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`nationwide-candidate-input-binding: ${error.message}\n`);
    process.exitCode = 1;
  });
}
