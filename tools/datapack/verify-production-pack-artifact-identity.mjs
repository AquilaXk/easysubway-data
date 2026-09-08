#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const CURRENT_TOPOLOGY_VERIFIER_PATH = path.join(
  root,
  "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
);
const DEPLOYED_EVIDENCE_ARTIFACT_KIND = "itx-cheongchun-mobile-topology-evidence";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || argv[index + 1] == null) throw new Error(`invalid argument: ${flag ?? ""}`);
    args[flag.slice(2)] = argv[index + 1];
  }
  return args;
}

function requiredArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`--${name} is required`);
  return value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
}

function tableRowCounts(sqlitePath) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const tables = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all();
    return Object.fromEntries(tables.map(({ name }) => [
      name,
      database.prepare(`SELECT count(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count,
    ]));
  } finally {
    database.close();
  }
}

function networkEdgeCounts(sqlitePath) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT source_id, source_snapshot_id, provider_record_hash, provenance_kind,
             verification_status, last_verified_at, evidence_hash
      FROM network_edges
    `).all();
    const hasValidHash = (value) => /^[0-9a-f]{64}$/.test(value);
    const hasCompleteProvenance = (row) => row.source_id !== ""
      && row.source_snapshot_id !== ""
      && hasValidHash(row.provider_record_hash)
      && hasValidHash(row.evidence_hash)
      && row.provenance_kind !== "UNKNOWN"
      && row.verification_status !== "UNKNOWN"
      && row.last_verified_at != null;
    const provenanceComplete = rows.filter(hasCompleteProvenance);
    return {
      total: rows.length,
      provenanceComplete: provenanceComplete.length,
      strictEligible: provenanceComplete.filter((row) => row.verification_status === "VERIFIED"
        && ["OFFICIAL_SOURCE", "OPERATOR_CONFIRMED", "FIELD_SURVEY"].includes(row.provenance_kind)
        && !/^([0-9a-f])\1{63}$/.test(row.evidence_hash)).length,
    };
  } finally {
    database.close();
  }
}

export function verifyProductionPackArtifactIdentity(inputs) {
  return verifyProductionPackArtifact(inputs, "current");
}

export function verifyProductionPackArtifactIntegrity(inputs) {
  return verifyProductionPackArtifact(inputs, "immutable-integrity");
}

async function verifyProductionPackArtifact({ evidencePath, assetPath, indexPath, packId }, verification) {
  evidencePath = path.resolve(evidencePath);
  assetPath = path.resolve(assetPath);
  indexPath = path.resolve(indexPath);
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-production-pack-identity-"));
  try {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    if (evidence.schemaVersion !== 1
      || evidence.artifactKind !== DEPLOYED_EVIDENCE_ARTIFACT_KIND
      || Object.hasOwn(evidence, "readmissions")) {
      throw new Error("deployed current topology evidence contract mismatch");
    }

    // Validate immutable deployed bytes and v19 route-service evidence. Release eligibility is
    // separately checked by the default current verifier in the release workflow.
    await execFileAsync(process.execPath, [
      CURRENT_TOPOLOGY_VERIFIER_PATH,
      verification === "current" ? "--check" : "--verify-immutable-integrity",
      "--pack", assetPath,
      "--evidence", evidencePath,
      "--index", indexPath,
    ], { cwd: root });

    const assetGzip = await readFile(assetPath);
    let assetSqlite;
    try {
      assetSqlite = gunzipSync(assetGzip);
    } catch {
      throw new Error("deployed asset is not valid gzip");
    }
    const gzipSha256 = sha256(assetGzip);
    const sqliteSha256 = sha256(assetSqlite);
    const byteSize = assetGzip.length;

    assertEqual(evidence.pack?.id, packId, "evidence pack id");
    assertEqual(evidence.pack?.outputSha256, gzipSha256, "evidence asset gzip sha256");
    assertEqual(evidence.pack?.outputSqliteSha256, sqliteSha256, "evidence asset SQLite sha256");
    assertEqual(evidence.pack?.byteSize, byteSize, "evidence asset byteSize");

    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const indexPacks = index.packs?.filter(({ id }) => id === packId) ?? [];
    if (indexPacks.length !== 1) throw new Error(`index must contain exactly one pack: ${packId}`);
    assertEqual(indexPacks[0].asset, path.relative(path.join(root, "apps/mobile"), assetPath).split(path.sep).join("/"), "index asset");
    assertEqual(indexPacks[0].sha256, gzipSha256, "index sha256");
    assertEqual(indexPacks[0].sqliteSha256, sqliteSha256, "index SQLite sha256");
    assertEqual(indexPacks[0].byteSize, byteSize, "index byteSize");

    const sqlitePath = path.join(outputDir, "capital.sqlite");
    await writeFile(sqlitePath, assetSqlite);

    return {
      verification,
      packId,
      gzipSha256,
      sqliteSha256,
      byteSize,
      rowCounts: tableRowCounts(sqlitePath),
      networkEdgeCounts: networkEdgeCounts(sqlitePath),
    };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const verification = args.verification ?? "current";
  if (!["current", "immutable-integrity"].includes(verification)) {
    throw new Error("unknown production pack verification mode");
  }
  const verify = verification === "current"
    ? verifyProductionPackArtifactIdentity : verifyProductionPackArtifactIntegrity;
  const report = await verify({
    evidencePath: requiredArg(args, "evidence"),
    assetPath: requiredArg(args, "asset"),
    indexPath: requiredArg(args, "index"),
    packId: requiredArg(args, "pack-id"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
