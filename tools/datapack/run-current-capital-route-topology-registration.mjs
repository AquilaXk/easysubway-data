#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { publishCapitalRouteTopologyRaw } from "./publish-capital-route-topology-raw.mjs";
import { assertExactMainPreflight } from "./publish-seoul-transfer-raw.mjs";
import { readCurrentCapitalRouteTopologyAdmission, registerCurrentCapitalRouteTopology } from "./register-current-capital-route-topology.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RAW = "capital-route-topology.raw.json";
const RECEIPT = "capital-route-topology.raw-receipt.json";
const JOURNAL = "capital-route-topology-registration.json";
const MARKERS = ["tools/datapack/release/current-capital-accessibility-transition.json", "tools/datapack/release/current-capital-accessibility-transition-successor.json"];
const TARGETS = ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json"];
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function absolute(value, label) { if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`); return path.resolve(value); }
function parse(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); } }
function exactTargets(targets) { if (!Array.isArray(targets) || JSON.stringify(targets) !== JSON.stringify(TARGETS)) throw new Error("capital topology registrar targets are invalid"); return targets; }
function validJournal(value, { repositoryRoot, expectedMainSha, publicationOperationId } = {}) {
  const keys = ["schemaVersion", "phase", "repositoryRoot", "expectedMainSha", "publicationOperationId", "sourceId", "snapshotId", "rawSha256", "preparedAt"];
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()) || value.schemaVersion !== 1 || !["PREPARED", "PUBLISHING", "PUBLISHED", "FINALIZED"].includes(value.phase) || !SHA.test(value.expectedMainSha ?? "") || !DIGEST.test(value.rawSha256 ?? "") || !path.isAbsolute(value.repositoryRoot ?? "") || ![value.publicationOperationId, value.sourceId, value.snapshotId, value.preparedAt].every((entry) => typeof entry === "string" && entry.length > 0) || Number.isNaN(Date.parse(value.preparedAt)) || repositoryRoot != null && value.repositoryRoot !== repositoryRoot || expectedMainSha != null && value.expectedMainSha !== expectedMainSha || publicationOperationId != null && value.publicationOperationId !== publicationOperationId) throw new Error("capital topology registration journal is invalid");
  return value;
}
async function absent(file, label) { try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`); throw new Error(`${label} must be absent`); } catch (error) { if (error?.code === "ENOENT") return; throw error; } }
async function regularBytes(file, label) { const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await handle.stat(); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`); const bytes = await handle.readFile(); if (bytes.length !== stat.size) throw new Error(`${label} changed during read`); return bytes; } finally { await handle.close(); } }
async function externalOperationRoot(repositoryRoot, operationRoot, { create } = {}) {
  const repository = await realpath(absolute(repositoryRoot, "repositoryRoot")); const requested = absolute(operationRoot, "operationRoot"); const parent = await realpath(path.dirname(requested)); const operation = path.join(parent, path.basename(requested));
  if (operation === repository || operation.startsWith(repository + path.sep)) throw new Error("operationRoot must be external to repositoryRoot"); if (create) await mkdir(operation, { mode: 0o700 });
  const stat = await lstat(operation); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("operationRoot must be a private regular directory"); return { repository, operation };
}
async function createOnce(file, bytes) { const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
async function syncDirectory(root) { const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY); try { await handle.sync(); } finally { await handle.close(); } }
async function writeJournal(root, journal) { const bytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`); const file = path.join(root, JOURNAL); const previous = await readFile(file).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error)); if (previous == null) { await createOnce(file, bytes); await syncDirectory(root); return; } const temp = path.join(root, `.${JOURNAL}.tmp`); await createOnce(temp, bytes); try { await rename(temp, file); await syncDirectory(root); } finally { await unlink(temp).catch(() => {}); } }
async function readJournal(root, expected) { return validJournal(parse(await regularBytes(path.join(root, JOURNAL), "capital topology registration journal"), "capital topology registration journal"), expected); }
async function sealReceipt(root, journal) { const raw = await regularBytes(path.join(root, RAW), "capital topology raw"); if (sha256(raw) !== journal.rawSha256) throw new Error("capital topology raw binding is invalid"); const receiptBytes = await regularBytes(path.join(root, RECEIPT), "capital topology OCI receipt"); const receipt = parse(receiptBytes, "capital topology OCI receipt"); if (receipt?.rawObjectSha256 !== journal.rawSha256 || receipt?.sourceId !== journal.sourceId || receipt?.snapshotId !== journal.snapshotId) throw new Error("capital topology OCI receipt binding is invalid"); return receiptBytes; }
async function registerPublished({ repository, operation, journal, register, now, exactMain = assertExactMainPreflight }) { await exactMain({ repositoryRoot: repository, expectedMainSha: journal.expectedMainSha }); await Promise.all(MARKERS.map((relative) => absent(path.join(repository, relative), "current-capital terminal marker"))); await sealReceipt(operation, journal); const registered = await register({ repositoryRoot: repository, receiptPath: path.join(operation, RECEIPT), now }); const targets = exactTargets(registered?.targets); await writeJournal(operation, { ...journal, phase: "FINALIZED" }); return { status: "PASS", sourceId: journal.sourceId, snapshotId: journal.snapshotId, targets }; }

export function parseArgs(argv) {
  if (argv.length === 6 && argv[0] === "--repository-root" && argv[2] === "--operation-root" && argv[4] === "--expected-main-sha" && SHA.test(argv[5] ?? "")) return { phase: "run", repositoryRoot: argv[1], operationRoot: argv[3], expectedMainSha: argv[5] };
  if (argv[0] === "recover-published" && argv.length === 11 && argv[1] === "--repository-root" && argv[3] === "--source-operation-root" && argv[5] === "--target-operation-root" && argv[7] === "--expected-main-sha" && argv[9] === "--expected-publication-operation-id" && SHA.test(argv[8] ?? "") && typeof argv[10] === "string" && argv[10] !== "") return { phase: "recover-published", repositoryRoot: argv[2], sourceOperationRoot: argv[4], targetOperationRoot: argv[6], expectedMainSha: argv[8], expectedPublicationOperationId: argv[10] };
  throw new Error("capital topology registration arguments are invalid");
}

export async function runCurrentCapitalRouteTopologyRegistration({ repositoryRoot = ROOT, operationRoot, expectedMainSha, readAdmission = readCurrentCapitalRouteTopologyAdmission, publish = publishCapitalRouteTopologyRaw, register = registerCurrentCapitalRouteTopology, exactMain = assertExactMainPreflight, env = process.env, now = new Date() } = {}) {
  if (!SHA.test(expectedMainSha ?? "") || !(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("capital topology registration arguments are invalid");
  const { repository, operation } = await externalOperationRoot(repositoryRoot, operationRoot, { create: true }); await Promise.all(MARKERS.map((relative) => absent(path.join(repository, relative), "current-capital terminal marker")));
  const admission = await readAdmission({ repositoryRoot: repository, now }); if (!Buffer.isBuffer(admission?.topologyBytes)) throw new Error("capital topology protected admission is invalid");
  const rawSha256 = sha256(admission.topologyBytes); await createOnce(path.join(operation, RAW), admission.topologyBytes);
  let journal = validJournal({ schemaVersion: 1, phase: "PREPARED", repositoryRoot: repository, expectedMainSha, publicationOperationId: path.basename(operation), sourceId: admission.sourceId, snapshotId: admission.snapshotId, rawSha256, preparedAt: now.toISOString() }); await writeJournal(operation, journal);
  journal = { ...journal, phase: "PUBLISHING" }; await writeJournal(operation, journal);
  try { await publish({ repositoryRoot: repository, expectedMainSha, operationRoot: operation, rawRelativePath: RAW, receiptPath: path.join(operation, RECEIPT), env, now }); await sealReceipt(operation, journal); } catch (error) { throw new Error("capital topology OCI publication failed", { cause: error }); }
  journal = { ...journal, phase: "PUBLISHED" }; await writeJournal(operation, journal); return registerPublished({ repository, operation, journal, register, exactMain, now });
}

export async function recoverPublishedCurrentCapitalRouteTopologyRegistration({ repositoryRoot = ROOT, sourceOperationRoot, targetOperationRoot, expectedMainSha, expectedPublicationOperationId, readAdmission = readCurrentCapitalRouteTopologyAdmission, register = registerCurrentCapitalRouteTopology, exactMain = assertExactMainPreflight, now = new Date() } = {}) {
  if (!SHA.test(expectedMainSha ?? "") || typeof expectedPublicationOperationId !== "string" || expectedPublicationOperationId === "" || !(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("capital topology recovery arguments are invalid");
  const { repository, operation: source } = await externalOperationRoot(repositoryRoot, sourceOperationRoot); const { operation: target } = await externalOperationRoot(repository, targetOperationRoot, { create: true }); if (source === target) throw new Error("source and target operation roots must differ");
  const journal = await readJournal(source, { repositoryRoot: repository, expectedMainSha, publicationOperationId: expectedPublicationOperationId }); if (!["PUBLISHING", "PUBLISHED", "FINALIZED"].includes(journal.phase)) throw new Error("capital topology publication is not recoverable");
  await exactMain({ repositoryRoot: repository, expectedMainSha });
  const admission = await readAdmission({ repositoryRoot: repository, now });
  if (!Buffer.isBuffer(admission?.topologyBytes) || admission.sourceId !== journal.sourceId || admission.snapshotId !== journal.snapshotId || sha256(admission.topologyBytes) !== journal.rawSha256) throw new Error("retained capital topology publication no longer binds current admission");
  const receipt = await regularBytes(path.join(source, RECEIPT), "retained capital topology OCI receipt"); const receiptValue = parse(receipt, "retained capital topology OCI receipt");
  if (receiptValue?.sourceId !== journal.sourceId || receiptValue?.snapshotId !== journal.snapshotId || receiptValue?.rawObjectSha256 !== journal.rawSha256) throw new Error("retained capital topology OCI receipt binding is invalid");
  const copied = { ...journal, phase: "PUBLISHED" };
  await createOnce(path.join(target, RAW), admission.topologyBytes); await createOnce(path.join(target, RECEIPT), receipt); await writeJournal(target, copied); await sealReceipt(target, copied);
  return registerPublished({ repository, operation: target, journal: copied, register, exactMain, now });
}

export async function main(argv = process.argv.slice(2)) { const args = parseArgs(argv); const result = args.phase === "run" ? await runCurrentCapitalRouteTopologyRegistration(args) : await recoverPublishedCurrentCapitalRouteTopologyRegistration(args); process.stdout.write(`${JSON.stringify(result)}\n`); return result; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
