import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// #942: 전국 후보가 만들어질 때 읽은 저장소 입력을 경로·sha256 매니페스트로 고정한다.
// 바이트는 저장소에 다시 커밋하지 않고 OCI에 content-addressed 객체로 둔다(#870 항목 3).
// PR CI는 이 매니페스트로 후보 내부 일관성을 검사하고, 고정 입력이 현재 작업 트리와 같은지(currency)는
// RC·publish 게이트(deterministic-release)가 검사한다.
export const CANDIDATE_INPUT_MANIFEST_PATH = "tools/datapack/release/nationwide-candidate-input-manifest.json";
export const CANDIDATE_INPUT_OBJECT_PREFIX = "candidate-inputs/sha256/";
// 공개 읽기 경로 받기 정책: 시도 3회, 시도 사이 1초·2초 대기. 시도마다 제한 시간은 30초 + 최저 1MB/s로 그 크기를 받는 데
// 걸리는 시간이다(고정 입력 합계 약 142MB, 가장 큰 34MB는 64초). 모두 실패하면 명시적으로 실패한다.
export const CANDIDATE_INPUT_FETCH_POLICY = Object.freeze({ attempts: 3, baseTimeoutMs: 30_000, minBytesPerSecond: 1_000_000, backoffMs: 1_000 });
// 받은 고정 바이트는 sha256 이름으로 디스크에 둔다. 같은 job의 여러 테스트 프로세스가 같은 객체를 다시 받지 않게 한다.
// 쓰기 전과 읽을 때마다 sha256·크기를 확인하고, 다르면 지우고 다시 받는다.
export const CANDIDATE_INPUT_CACHE_DIRECTORY = path.join(os.tmpdir(), "easysubway-candidate-inputs");

export function candidateInputFetchTimeoutMs(byteSize, policy = CANDIDATE_INPUT_FETCH_POLICY) {
  return policy.baseTimeoutMs + Math.ceil((byteSize / policy.minBytesPerSecond) * 1_000);
}

const MANIFEST_KEYS = [
  "schemaVersion", "artifactKind", "candidateId", "candidateBuildSpecSha256", "preparationSha256", "fanInSha256",
  "objectKeyPrefix", "files",
];
const FILE_KEYS = ["path", "sha256", "byteSize"];
const SHA256 = /^[a-f0-9]{64}$/u;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sameKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort(compare)) === JSON.stringify([...keys].sort(compare));

function invalid() {
  throw new Error("CANDIDATE_INPUT_MANIFEST_INVALID");
}

function validRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.includes("\\")
    && path.posix.normalize(value) === value && !value.split("/").includes("..");
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (typeof bytes === "string" || bytes instanceof Uint8Array) return Buffer.from(bytes);
  throw new Error("CANDIDATE_INPUT_READ_INVALID");
}

export function candidateInputObjectKey(digest) {
  if (!SHA256.test(digest ?? "")) invalid();
  return `${CANDIDATE_INPUT_OBJECT_PREFIX}${digest}`;
}

/** 읽기 함수를 감싸 읽은 경로마다 바이트 sha256·크기를 기록한다. 같은 경로를 다른 바이트로 다시 읽으면 실패한다. */
export function createRecordingReader(read) {
  const recorded = new Map();
  return {
    read: async (relative) => {
      if (!validRelativePath(relative)) throw new Error(`CANDIDATE_INPUT_PATH_INVALID: ${relative}`);
      const bytes = toBuffer(await read(relative));
      const entry = { path: relative, sha256: sha256(bytes), byteSize: bytes.length };
      const previous = recorded.get(relative);
      if (previous && (previous.sha256 !== entry.sha256 || previous.byteSize !== entry.byteSize)) {
        throw new Error(`CANDIDATE_INPUT_CHANGED_DURING_RECORDING: ${relative}`);
      }
      recorded.set(relative, entry);
      return bytes;
    },
    entries: () => [...recorded.values()].sort((left, right) => compare(left.path, right.path)),
  };
}

export function buildCandidateInputManifest({ candidateId, candidateBuildSpecSha256, preparationSha256, fanInSha256, entries }) {
  return validateManifest({
    schemaVersion: 1,
    artifactKind: "nationwide-candidate-input-manifest",
    candidateId,
    candidateBuildSpecSha256,
    preparationSha256,
    fanInSha256,
    objectKeyPrefix: CANDIDATE_INPUT_OBJECT_PREFIX,
    files: [...(entries ?? [])].map(({ path: relative, sha256: digest, byteSize }) => ({ path: relative, sha256: digest, byteSize }))
      .sort((left, right) => compare(left.path, right.path)),
  });
}

function validateManifest(manifest) {
  if (!sameKeys(manifest, MANIFEST_KEYS) || manifest.schemaVersion !== 1
    || manifest.artifactKind !== "nationwide-candidate-input-manifest"
    || typeof manifest.candidateId !== "string" || manifest.candidateId.length === 0
    || ![manifest.candidateBuildSpecSha256, manifest.preparationSha256, manifest.fanInSha256].every((digest) => SHA256.test(digest ?? ""))
    || manifest.objectKeyPrefix !== CANDIDATE_INPUT_OBJECT_PREFIX
    || !Array.isArray(manifest.files) || manifest.files.length === 0) invalid();
  manifest.files.forEach((entry, index) => {
    if (!sameKeys(entry, FILE_KEYS) || !validRelativePath(entry.path) || !SHA256.test(entry.sha256 ?? "")
      || !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0
      || (index > 0 && compare(manifest.files[index - 1].path, entry.path) >= 0)) invalid();
  });
  return manifest;
}

export function parseCandidateInputManifest(bytes) {
  let manifest;
  try { manifest = JSON.parse(toBuffer(bytes).toString("utf8")); } catch { invalid(); }
  return validateManifest(manifest);
}

export function serializeCandidateInputManifest(manifest) {
  return `${JSON.stringify(validateManifest(manifest), null, 2)}\n`;
}

const sleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

async function readCappedBody(response, entry) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== entry.byteSize) {
    throw Object.assign(new Error(`CANDIDATE_INPUT_SIZE_MISMATCH: ${entry.path}`), { final: true });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.length;
    if (total > entry.byteSize) {
      await response.body.cancel().catch(() => {});
      throw Object.assign(new Error(`CANDIDATE_INPUT_SIZE_MISMATCH: ${entry.path}`), { final: true });
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function fetchPinnedObject({ entry, baseUrl, fetchImpl, policy }) {
  const url = `${baseUrl.replace(/\/+$/u, "")}/${candidateInputObjectKey(entry.sha256)}`;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("CANDIDATE_INPUT_FETCH_TIMEOUT")),
      candidateInputFetchTimeoutMs(entry.byteSize, policy));
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: "error" });
      if (response.ok) {
        const bytes = await readCappedBody(response, entry);
        if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.byteSize) {
          throw Object.assign(new Error(`CANDIDATE_INPUT_SHA_MISMATCH: ${entry.path}`), { final: true });
        }
        return bytes;
      }
    } catch (error) {
      if (error?.final) throw error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < policy.attempts && policy.backoffMs > 0) await sleep(policy.backoffMs * attempt);
  }
  throw new Error(`CANDIDATE_INPUT_FETCH_FAILED: ${entry.path}`);
}

async function readCachedObject(cacheDirectory, entry) {
  const file = path.join(cacheDirectory, entry.sha256);
  const bytes = await readFile(file).catch(() => null);
  if (!bytes) return null;
  if (bytes.length === entry.byteSize && sha256(bytes) === entry.sha256) return bytes;
  await rm(file, { force: true });
  return null;
}

async function writeCachedObject(cacheDirectory, entry, bytes) {
  await mkdir(cacheDirectory, { recursive: true });
  const temporary = path.join(cacheDirectory, `.${entry.sha256}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, path.join(cacheDirectory, entry.sha256));
}

/**
 * 후보가 고정한 입력만 읽는 reader. 작업 트리 바이트가 고정값과 같으면 그대로 쓰고, 다르면 공개 읽기 경로에서
 * 고정 sha256 객체를 받아 바이트를 확인한 뒤 쓴다. 고정되지 않은 경로, 공개 경로 미설정, 받기 실패, sha 불일치는
 * 모두 명시적으로 실패한다(작업 트리 값으로 대체하지 않는다).
 */
export function createCandidateInputReader({
  manifest, readLocal, baseUrl, fetchImpl = fetch, policy = CANDIDATE_INPUT_FETCH_POLICY,
  cacheDirectory = CANDIDATE_INPUT_CACHE_DIRECTORY,
}) {
  const pinned = new Map(validateManifest(manifest).files.map((entry) => [entry.path, entry]));
  const resolved = new Map();
  return async (relative) => {
    const entry = pinned.get(relative);
    if (!entry) throw new Error(`CANDIDATE_INPUT_NOT_PINNED: ${relative}`);
    if (!resolved.has(relative)) {
      resolved.set(relative, (async () => {
        const local = await readLocal(relative).then(toBuffer, () => null);
        if (local && local.length === entry.byteSize && sha256(local) === entry.sha256) return local;
        const cached = await readCachedObject(cacheDirectory, entry);
        if (cached) return cached;
        if (typeof baseUrl !== "string" || !/^https:\/\//u.test(baseUrl)) {
          throw new Error("CANDIDATE_INPUT_BASE_URL_REQUIRED: EASYSUBWAY_DATA_PACK_BASE_URL");
        }
        const fetched = await fetchPinnedObject({ entry, baseUrl, fetchImpl, policy });
        await writeCachedObject(cacheDirectory, entry, fetched);
        return fetched;
      })());
      resolved.get(relative).catch(() => resolved.delete(relative));
    }
    return Buffer.from(await resolved.get(relative));
  };
}

/** currency: 후보가 고정한 입력이 모두 지금 작업 트리 바이트와 같아야 한다. 다른 경로를 모두 밝힌다. */
export async function assertCandidateInputsCurrent({ manifest, readLocal }) {
  const stale = [];
  for (const entry of validateManifest(manifest).files) {
    const local = await readLocal(entry.path).then(toBuffer, () => null);
    if (!local || local.length !== entry.byteSize || sha256(local) !== entry.sha256) stale.push(entry.path);
  }
  if (stale.length > 0) throw new Error(`CANDIDATE_INPUT_STALE: ${stale.join(", ")}`);
}

/** 고정 입력 바이트를 OCI에 올린다. 이미 있는 객체는 읽어서 바이트가 같은지 확인한다. */
export async function publishCandidateInputObjects({ manifest, readLocal, client }) {
  await assertCandidateInputsCurrent({ manifest, readLocal });
  let uploaded = 0;
  let verifiedExisting = 0;
  for (const entry of manifest.files) {
    const key = candidateInputObjectKey(entry.sha256);
    const bytes = toBuffer(await readLocal(entry.path));
    const created = await client.putObjectIfAbsent(key, bytes, {
      objectKey: key, sha256: entry.sha256, sizeBytes: entry.byteSize, contentType: "application/octet-stream",
    });
    const stored = await client.readObject(key, { maxResponseBytes: entry.byteSize });
    const body = stored?.exists ? toBuffer(stored.body) : null;
    if (!body || body.length !== entry.byteSize || sha256(body) !== entry.sha256) {
      throw new Error(`CANDIDATE_INPUT_OBJECT_MISMATCH: ${entry.path}`);
    }
    if (created) uploaded += 1;
    else verifiedExisting += 1;
  }
  return { uploaded, verifiedExisting };
}
