#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";

const ENDPOINT = "https://apis.data.go.kr/1613000/TrainInfo/GetStrtpntAlocFndTrainInfo";
const OPERATION = "GetStrtpntAlocFndTrainInfo";
const OFFSETS = Object.freeze([-1, 0, 1]);
const EMPTY_RELATION_COUNTS = Object.freeze({
  previousCalendarDay: 0,
  sameCalendarDay: 0,
  nextCalendarDay: 0,
  otherCalendarDay: 0,
});

export async function probeTagoTrainDateSemantics({
  serviceDate,
  depPlaceId,
  arrPlaceId,
  trainGradeCode,
  outputPath,
  serviceKey,
  fetchImpl = fetch,
  now = new Date(),
  testHooks,
} = {}) {
  const target = validateTarget({ serviceDate, depPlaceId, arrPlaceId, trainGradeCode, outputPath, now });
  const key = normalizeDataGoKrServiceKey(serviceKey);
  const outputSnapshot = await snapshotAbsentOutput(target.outputPath);

  const artifact = createArtifact(target);
  for (const offset of OFFSETS) {
    const queryDate = addDays(target.serviceDate, offset);
    try {
      const call = await fetchAndSummarize({ target, key, offset, queryDate, fetchImpl });
      artifact.calls.push(call);
    } catch (error) {
      const failure = sanitizeFailure(error, offset);
      artifact.calls.push(failure.call);
      artifact.failure = failure.failure;
      artifact.diagnosticStatus = "FAILED";
      await writeArtifact(target.outputPath, artifact, outputSnapshot, testHooks);
      throw new Error("TAGO train date semantics probe failed");
    }
  }
  artifact.diagnosticStatus = observedStatus(artifact.calls);
  await writeArtifact(target.outputPath, artifact, outputSnapshot, testHooks);
  return artifact;
}

function validateTarget({ serviceDate, depPlaceId, arrPlaceId, trainGradeCode, outputPath, now }) {
  if (!isCalendarDate(serviceDate)) throw new Error("service date is invalid");
  const today = koreaCalendarDate(now);
  const dayOffset = Math.round((calendarMillis(serviceDate) - calendarMillis(today)) / 86_400_000);
  if (dayOffset < 0 || dayOffset >= 14) throw new Error("service date must be today through 13 days in Asia/Seoul");
  if (typeof depPlaceId !== "string" || !/^NAT\d{6}$/u.test(depPlaceId)
    || typeof arrPlaceId !== "string" || !/^NAT\d{6}$/u.test(arrPlaceId)
    || depPlaceId === arrPlaceId
    || typeof trainGradeCode !== "string" || !/^[A-Z0-9]{1,16}$/u.test(trainGradeCode)) throw new Error("target tuple is invalid");
  if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) throw new Error("output path must be an absolute path");
  return { serviceDate, depPlaceId, arrPlaceId, trainGradeCode, outputPath };
}

async function snapshotAbsentOutput(outputPath) {
  const ancestors = [];
  for (let current = path.dirname(outputPath); ; current = path.dirname(current)) {
    let currentStat;
    try {
      currentStat = await lstat(current);
    } catch {
      throw new Error("output parent is invalid");
    }
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) throw new Error("output parent is invalid");
    ancestors.push({ path: current, dev: currentStat.dev, ino: currentStat.ino, mode: currentStat.mode });
    if (current === path.parse(current).root) break;
  }
  try {
    await lstat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { ancestors };
    throw new Error("output path is invalid");
  }
  throw new Error("output path must be absent");
}

async function revalidateAbsentOutput(outputPath, snapshot) {
  await revalidateAncestorSnapshot(snapshot);
  try {
    await lstat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("output path changed");
  }
  throw new Error("output path changed");
}

async function revalidateAncestorSnapshot(snapshot) {
  for (const ancestor of snapshot.ancestors) {
    let current;
    try {
      current = await lstat(ancestor.path);
    } catch {
      throw new Error("output parent changed");
    }
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== ancestor.dev || current.ino !== ancestor.ino || current.mode !== ancestor.mode) {
      throw new Error("output parent changed");
    }
  }
}

function createArtifact(target) {
  return {
    schemaVersion: 1,
    artifactKind: "tago-train-date-semantics-diagnostic",
    contractVersion: "tago-train-date-semantics-diagnostic-v1",
    targetTupleSha256: createHash("sha256")
      .update(JSON.stringify([target.depPlaceId, target.arrPlaceId, target.trainGradeCode]))
      .digest("hex"),
    serviceDate: target.serviceDate,
    comparisonOffsets: [...OFFSETS],
    operation: OPERATION,
    calls: [],
    diagnosticStatus: null,
    failure: null,
    credentialRedacted: true,
  };
}

async function fetchAndSummarize({ target, key, offset, queryDate, fetchImpl }) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("serviceKey", key);
  url.searchParams.set("depPlaceId", target.depPlaceId);
  url.searchParams.set("arrPlaceId", target.arrPlaceId);
  url.searchParams.set("depPlandTime", queryDate);
  url.searchParams.set("trainGradeCode", target.trainGradeCode);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "999");
  url.searchParams.set("_type", "json");

  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/json" },
    });
  } catch {
    throw failureError("transport", null, null);
  }
  if (!response.ok) throw failureError("http", response.status, null);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw failureError("schema", response.status, null);
  let document;
  try {
    document = JSON.parse(await response.text());
  } catch {
    throw failureError("schema", response.status, null);
  }
  const header = objectAt(document?.response?.header);
  const providerResultCode = safeResultCode(header?.resultCode);
  if (providerResultCode !== "00") throw failureError("provider", response.status, providerResultCode);
  const body = objectAt(document?.response?.body);
  if (!body || typeof body.totalCount !== "number" || !Number.isInteger(body.totalCount) || body.totalCount < 0) {
    throw failureError("schema", response.status, providerResultCode);
  }
  const totalCount = body.totalCount;
  let rows;
  if (totalCount === 0) {
    if (Object.hasOwn(body, "items") && body.items !== null) throw failureError("schema", response.status, providerResultCode);
    rows = [];
  } else {
    const items = objectAt(body.items);
    if (!items || !Object.hasOwn(items, "item") || items.item == null) throw failureError("schema", response.status, providerResultCode);
    rows = Array.isArray(items.item) ? items.item : [items.item];
    if (rows.length === 0 || rows.some((row) => !objectAt(row)) || totalCount !== rows.length) {
      throw failureError("schema", response.status, providerResultCode);
    }
  }
  const counts = relationCounts(rows, queryDate, response.status, providerResultCode);
  return {
    offset,
    httpStatus: response.status,
    providerResultCode,
    schemaStatus: "EXPECTED",
    rowCount: rows.length,
    totalCount,
    departureCalendarRelationCounts: counts,
  };
}

function relationCounts(rows, queryDate, httpStatus, providerResultCode) {
  const counts = { ...EMPTY_RELATION_COUNTS };
  for (const row of rows) {
    const timestamp = row.depplandtime;
    if (typeof timestamp !== "string" || !/^\d{14}$/u.test(timestamp) || !isCalendarDate(timestamp.slice(0, 8))
      || Number(timestamp.slice(8, 10)) > 23 || Number(timestamp.slice(10, 12)) > 59 || Number(timestamp.slice(12, 14)) > 59) {
      throw failureError("schema", httpStatus, providerResultCode);
    }
    const delta = Math.round((calendarMillis(timestamp.slice(0, 8)) - calendarMillis(queryDate)) / 86_400_000);
    if (delta === -1) counts.previousCalendarDay += 1;
    else if (delta === 0) counts.sameCalendarDay += 1;
    else if (delta === 1) counts.nextCalendarDay += 1;
    else counts.otherCalendarDay += 1;
  }
  return counts;
}

function observedStatus(calls) {
  if (calls.length !== OFFSETS.length || calls.some((call) => call.rowCount === 0)) return "OBSERVED_INCONCLUSIVE";
  const categories = calls.map((call) => Object.entries(call.departureCalendarRelationCounts)
    .filter(([, count]) => count > 0).map(([category]) => category));
  if (categories.some((active) => active.length !== 1) || new Set(categories.map(([category]) => category)).size !== 1) {
    return "OBSERVED_INCONCLUSIVE";
  }
  return "OBSERVED";
}

function failureError(stage, httpStatus, providerResultCode) {
  return { stage, httpStatus, providerResultCode };
}

function sanitizeFailure(error, offset) {
  const source = error && typeof error === "object" ? error : {};
  const httpStatus = Number.isInteger(source.httpStatus) ? source.httpStatus : null;
  const providerResultCode = safeResultCode(source.providerResultCode);
  return {
    call: {
      offset,
      httpStatus,
      providerResultCode,
      schemaStatus: "FAILED",
      rowCount: null,
      totalCount: null,
      departureCalendarRelationCounts: { ...EMPTY_RELATION_COUNTS },
    },
    failure: {
      stage: ["transport", "http", "provider", "schema"].includes(source.stage) ? source.stage : "transport",
      offset,
      httpStatus,
      providerResultCode,
    },
  };
}

async function writeArtifact(outputPath, artifact, snapshot, testHooks) {
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  let temporaryHandle;
  let initialTemporarySnapshot;
  let temporarySnapshot;
  try {
    await testHooks?.beforeTempWrite?.();
    await revalidateAbsentOutput(outputPath, snapshot);
    temporaryHandle = await open(temporaryPath, "wx+", 0o600);
    initialTemporarySnapshot = await snapshotTemporaryHandle(temporaryHandle, 0);
    if (testHooks?.writeTemporary) await testHooks.writeTemporary(temporaryHandle, bytes);
    else await temporaryHandle.writeFile(bytes);
    await temporaryHandle.chmod(0o600);
    await temporaryHandle.sync();
    temporarySnapshot = await snapshotTemporaryHandle(temporaryHandle, bytes.length);
    await testHooks?.beforePublish?.();
    await revalidateAbsentOutput(outputPath, snapshot);
    await assertTemporaryMatchesHandle(temporaryPath, temporaryHandle, temporarySnapshot);
    await testHooks?.beforeLink?.({ temporaryPath });
    await revalidateAbsentOutput(outputPath, snapshot);
    await assertTemporaryMatchesHandle(temporaryPath, temporaryHandle, temporarySnapshot);
    await link(temporaryPath, outputPath);
    await removeOwnedTemporary(temporaryPath, temporarySnapshot, snapshot);
  } catch {
    if (temporarySnapshot) await removeOwnedTemporary(temporaryPath, temporarySnapshot, snapshot).catch(() => {});
    else if (initialTemporarySnapshot && temporaryHandle) {
      const currentTemporarySnapshot = await snapshotTemporaryHandleState(temporaryHandle).catch(() => null);
      if (currentTemporarySnapshot
        && currentTemporarySnapshot.dev === initialTemporarySnapshot.dev
        && currentTemporarySnapshot.ino === initialTemporarySnapshot.ino) {
        await removeInterruptedTemporary(temporaryPath, initialTemporarySnapshot, snapshot).catch(() => {});
      }
    }
    throw new Error("sanitized diagnostic artifact could not be written");
  } finally {
    await temporaryHandle?.close().catch(() => {});
  }
}

async function snapshotTemporaryHandle(handle, expectedSize) {
  const current = await snapshotTemporaryHandleState(handle);
  if (current.size !== expectedSize) {
    throw new Error("temporary artifact is invalid");
  }
  return current;
}

async function snapshotTemporaryHandleState(handle) {
  const current = await handle.stat();
  if (!current.isFile() || (current.mode & 0o777) !== 0o600) {
    throw new Error("temporary artifact is invalid");
  }
  return { dev: current.dev, ino: current.ino, size: current.size };
}

async function assertOwnedTemporary(temporaryPath, snapshot) {
  const current = await lstat(temporaryPath);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== snapshot.dev || current.ino !== snapshot.ino
    || (current.mode & 0o777) !== 0o600 || current.size !== snapshot.size) {
    throw new Error("temporary artifact changed");
  }
}

async function assertTemporaryMatchesHandle(temporaryPath, handle, snapshot) {
  const currentHandle = await snapshotTemporaryHandle(handle, snapshot.size);
  if (currentHandle.dev !== snapshot.dev || currentHandle.ino !== snapshot.ino || currentHandle.size !== snapshot.size) {
    throw new Error("temporary artifact changed");
  }
  await assertOwnedTemporary(temporaryPath, currentHandle);
}

async function removeOwnedTemporary(temporaryPath, temporarySnapshot, outputSnapshot) {
  try {
    await revalidateAncestorSnapshot(outputSnapshot);
    await assertOwnedTemporary(temporaryPath, temporarySnapshot);
    await unlink(temporaryPath);
  } catch {
    // 외부 교체 또는 parent drift 뒤에는 소유하지 않은 경로를 지우지 않는다.
  }
}

async function removeInterruptedTemporary(temporaryPath, temporarySnapshot, outputSnapshot) {
  try {
    await revalidateAncestorSnapshot(outputSnapshot);
    const current = await lstat(temporaryPath);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== temporarySnapshot.dev || current.ino !== temporarySnapshot.ino
      || (current.mode & 0o777) !== 0o600) return;
    await unlink(temporaryPath);
  } catch {
    // 부분 write 실패 뒤에도 외부 교체 또는 parent drift 경로는 삭제하지 않는다.
  }
}

function objectAt(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function safeResultCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,32}$/u.test(value) ? value : null;
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{8}$/u.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function calendarMillis(value) {
  return Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)));
}

function addDays(value, offset) {
  const date = new Date(calendarMillis(value));
  date.setUTCDate(date.getUTCDate() + offset);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function koreaCalendarDate(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value: part }) => [type, part]));
  return `${value.year}${value.month}${value.day}`;
}

export function parseTagoTrainDateSemanticsCliArguments(argv) {
  if (argv.length !== 10) throw new Error("invalid arguments");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!new Set(["--service-date", "--dep-place-id", "--arr-place-id", "--train-grade-code", "--output"]).has(flag)
      || typeof argv[index + 1] !== "string" || Object.hasOwn(values, flag)) throw new Error("invalid arguments");
    values[flag] = argv[index + 1];
  }
  if (Object.keys(values).length !== 5) throw new Error("invalid arguments");
  return {
    serviceDate: values["--service-date"], depPlaceId: values["--dep-place-id"], arrPlaceId: values["--arr-place-id"],
    trainGradeCode: values["--train-grade-code"], outputPath: values["--output"],
  };
}

async function main() {
  const arguments_ = parseTagoTrainDateSemanticsCliArguments(process.argv.slice(2));
  const artifact = await probeTagoTrainDateSemantics({ ...arguments_, serviceKey: process.env.DATA_GO_KR_SERVICE_KEY });
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write("TAGO train date semantics probe failed\n");
    process.exitCode = 1;
  });
}
