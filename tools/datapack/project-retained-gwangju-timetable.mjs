#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  RETAINED_GWANGJU_PROJECTION_EVIDENCE_KEY,
  RETAINED_GWANGJU_PROJECTION_SOURCE_ID,
  projectRetainedGwangjuRecords,
  retainedGwangjuProjectionEvidence,
  validateRetainedGwangjuProjection,
} from "./lib/kric-retained-gwangju-projection.mjs";
import { restoreAdmittedGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";

// #913: 광주 보관본(KRIC 전체_도시철도운행정보) 등록 뒤 계약 노선 행 projection을 커밋한다.
// 관측 바이트는 원장 head의 rawObjectSha256과 관측 식별자(restoreAdmittedGwangjuTimetable)로 확인한다.
// 사용: node tools/datapack/project-retained-gwangju-timetable.mjs --observation <절대경로 observation.json>
//   (run-retained-gwangju-timetable-refresh 운영 디렉터리의 observation.json, 또는 같은 원본 xlsx와 원장 receipt로 다시 만든 관측)

const ROOT = path.resolve(import.meta.dirname, "../..");
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const LEDGER_PATH = "tools/datapack/release/source-snapshots.json";
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

export async function projectRetainedGwangjuTimetable({ repositoryRoot = ROOT, observationPath }) {
  if (typeof observationPath !== "string" || !path.isAbsolute(observationPath)) throw new Error("--observation must be absolute");
  const [observationBytes, inventoryBytes, ledgerBytes] = await Promise.all([
    readFile(observationPath), readFile(path.join(repositoryRoot, INVENTORY_PATH)), readFile(path.join(repositoryRoot, LEDGER_PATH)),
  ]);
  const inventory = JSON.parse(inventoryBytes);
  const ledger = JSON.parse(ledgerBytes);
  const retained = restoreAdmittedGwangjuTimetable({ observationBytes, inventory, snapshots: ledger });
  const sources = inventory.sources.filter(({ id }) => id === RETAINED_GWANGJU_PROJECTION_SOURCE_ID);
  if (sources.length !== 1) throw new Error("retained Gwangju projection source is missing or ambiguous");
  const retainedEvidence = sources[0].retainedScheduleAdmissionEvidence;
  const snapshot = projectRetainedGwangjuRecords({
    retained, retainedEvidence, observationRawObjectSha256: createHash("sha256").update(observationBytes).digest("hex"),
  });
  const evidence = retainedGwangjuProjectionEvidence(snapshot);
  validateRetainedGwangjuProjection({ snapshot, evidence, retainedEvidence });
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  const target = path.join(repositoryRoot, evidence.snapshotPath);
  const existing = await readFile(target).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
  if (existing && !existing.equals(snapshotBytes)) throw new Error("retained Gwangju projection snapshot path holds different bytes");
  if (!existing) await writeFile(target, snapshotBytes, { flag: "wx" });
  sources[0][RETAINED_GWANGJU_PROJECTION_EVIDENCE_KEY] = evidence;
  await writeFile(path.join(repositoryRoot, INVENTORY_PATH), jsonBytes(inventory));
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  try {
    if (argv.length !== 2 || argv[0] !== "--observation") throw new Error("usage: project-retained-gwangju-timetable.mjs --observation <absolute observation.json>");
    process.stdout.write(`${JSON.stringify(await projectRetainedGwangjuTimetable({ observationPath: argv[1] }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
