#!/usr/bin/env node
// #903: kric-subway-timetable-station-lines 수집본 OCI 원본 게시기(immutable PUT + 검증 GET).
// 게시 전에 수집본을 재구성까지 검증한다. PAR·키는 출력하지 않는다.
// 보존 만료일은 등록기와 같은 규칙으로 계산한다: 등록 전에는 같은 약관의 kric-subway-timetable governance 항목을
// sourceId만 바꿔 투영한다(등록기가 governance 항목의 동일성을 강제한다).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/is-main-module.mjs";
import { responsesFromCollection } from "./collect-kric-station-timetables.mjs";
import { buildApiStationTimetableTrips } from "./lib/kric-station-timetable-api-trips.mjs";
import { requireOciParBaseUrl, requiredText, writeKricRawReceipt } from "./lib/kric-raw-object-storage.mjs";
import { publishImmutableObjectPlan } from "./publish-object-storage.mjs";
import { STATION_LINES_SOURCE_ID } from "./register-kric-station-timetables.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";

const TERMS_SOURCE_ID = "kric-subway-timetable";
const OCI_NAMESPACE = "axvym6vk8g7i";
const OCI_BUCKET = "easysubway-datapacks";
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fail = (code) => { throw new Error(`KRIC_STATION_RAW_${code}`); };

export async function publishKricStationTimetablesRaw({
  inputPath, receiptPath, expectedRawObjectSha256, expectedByteSize, repositoryRoot = REPOSITORY_ROOT,
  env = process.env, client = null, now = new Date(),
} = {}) {
  const resolvedInput = path.resolve(requiredText(inputPath, "inputPath"));
  const resolvedReceipt = path.resolve(requiredText(receiptPath, "receiptPath"));
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) fail("TIME");
  const bytes = await readFile(resolvedInput);
  const rawObjectSha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = JSON.parse(bytes.toString("utf8"));
  buildApiStationTimetableTrips({ responses: responsesFromCollection(artifact) });
  if (rawObjectSha256 !== expectedRawObjectSha256) fail("RAW_SHA256_MISMATCH");
  if (bytes.length !== Number(expectedByteSize)) fail("RAW_BYTE_SIZE_MISMATCH");
  if (now.valueOf() < Date.parse(artifact.collectedAt)) fail("PUBLICATION_BEFORE_COLLECTION");
  requireOciParBaseUrl(env);
  const governance = JSON.parse(await readFile(path.join(path.resolve(repositoryRoot), "tools/datapack/source-governance-policy.json"), "utf8"));
  const registered = governance.sources.some(({ sourceId }) => sourceId === STATION_LINES_SOURCE_ID);
  const terms = governance.sources.find(({ sourceId }) => sourceId === TERMS_SOURCE_ID);
  if (!registered && !terms) fail("TERMS_SOURCE_MISSING");
  const policy = registered ? governance : { ...governance, sources: [...governance.sources, { ...terms, sourceId: STATION_LINES_SOURCE_ID }] };
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy, sourceId: STATION_LINES_SOURCE_ID, retrievedAt: artifact.collectedAt });
  if (now.valueOf() >= Date.parse(rawRetentionExpiresAt)) fail("RETENTION_EXPIRED");
  const capturedDate = artifact.capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${STATION_LINES_SOURCE_ID}/${capturedDate}/${rawObjectSha256}.json`;
  const step = { objectKey, sourcePath: path.basename(resolvedInput), sha256: rawObjectSha256, sizeBytes: bytes.length };
  try {
    await publishImmutableObjectPlan({ root: path.dirname(resolvedInput), client, env, plan: { steps: [
      { type: "put-immutable-bundle-object", ...step }, { type: "verify-immutable-bundle-object", ...step },
    ] } });
  } catch (error) {
    const status = /\bHTTP\s+([1-5]\d\d)\b/u.exec(String(error?.message ?? ""))?.[1];
    throw new Error(`KRIC station raw object storage publication failed${status ? `: HTTP ${status}` : ""}`);
  }
  const receipt = {
    schemaVersion: 1, artifactKind: "kric-timetable-raw-object-receipt", sourceId: STATION_LINES_SOURCE_ID,
    snapshotId: `${STATION_LINES_SOURCE_ID}-${capturedDate}`, capturedAt: artifact.capturedAt, collectedAt: artifact.collectedAt,
    rawObjectUri: `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${objectKey}`, rawObjectSha256, ociNamespace: OCI_NAMESPACE,
    bucket: OCI_BUCKET, objectKey, capturedDate, byteSize: bytes.length, storedAt: now.toISOString(), rawRetentionExpiresAt,
  };
  await writeKricRawReceipt(resolvedReceipt, receipt, { mode: 0o600 });
  return receipt;
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const args = Object.fromEntries(Array.from({ length: argv.length / 2 }, (_, index) => [argv[index * 2], argv[index * 2 + 1]]));
  publishKricStationTimetablesRaw({ inputPath: args["--input"], receiptPath: args["--receipt"],
    expectedRawObjectSha256: args["--expected-sha256"], expectedByteSize: args["--expected-byte-size"] })
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
