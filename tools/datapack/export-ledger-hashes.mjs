#!/usr/bin/env node
// 원장 해시 exporter — admission admin review 필수 필드 6종 hash의 producer.
//
// source-admission-runbook.json의 requiredAdminReviewFields 중 hash 6종
// (licenseEvidenceHash, aliasLedgerHash, operatorMappingLedgerHash,
//  facilityEvidenceLedgerHash, routeEvidenceLedgerHash, overrideHash)을
// 리포에 실존하는 canonical 원장 데이터에서 결정적으로 산출한다.
//
// 결정성 규칙:
//   - 모든 객체 key를 재귀적으로 사전순 정렬(sortJson)한 뒤 JSON.stringify.
//   - 배열(레코드 집합)은 canonical row 문자열로 직렬화한 뒤 사전순 정렬하여
//     입력 순서와 무관하게 동일 해시를 낸다.
//   - 공백 없는 JSON.stringify(기본) 사용 — 구분자·들여쓰기 없음.
//   - sha256 hex(소문자 64자).
//
// canonical 원장 소스(실측):
//   - aliasLedger:           fixture pack.stationAliases
//   - operatorMappingLedger: fixture pack.operators
//   - facilityEvidenceLedger: fixture pack.stationFacilityEvidence(있으면) → 없으면 pack.facilities
//   - routeEvidenceLedger:   fixture pack.networkEdges
//   - override:              manual override ledger 파일(apply-admin-review-overrides.mjs 계약)
//                            — fixture 원장과 달리 배열(facilityStatusUpdates) 순서를 보존한다(순서가 의미를 갖는 데이터).
//   - licenseEvidence:       source-inventory.json 해당 source.license 블록
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareStrings,
  parseArgs,
  readJsonFile,
  requireArg,
  requiredArray,
  requiredString,
  sortJson,
} from "./lib/ledger-admission-cli.mjs";

const root = path.resolve(import.meta.dirname, "../..");

const ledgerKinds = new Set(["alias", "operator-mapping", "facility-evidence", "route-evidence", "override", "license"]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kind = requireArg(args, "kind");
  if (!ledgerKinds.has(kind)) {
    throw new Error(`--kind must be one of ${[...ledgerKinds].join(", ")}`);
  }

  const result = await exportLedgerHash(kind, args);
  console.log(JSON.stringify(result, null, 2));
}

async function exportLedgerHash(kind, args) {
  if (kind === "license") {
    return exportLicenseEvidenceHash(args);
  }
  if (kind === "override") {
    return exportOverrideHash(args);
  }
  return exportFixtureLedgerHash(kind, args);
}

// fixture pack에서 원장 레코드 집합을 뽑아 canonical 해시를 낸다.
async function exportFixtureLedgerHash(kind, args) {
  const fixturePath = path.resolve(root, requireArg(args, "fixture"));
  const fixture = await readJsonFile(fixturePath);
  const packs = requiredArray(fixture.packs, "fixture.packs");

  if (kind === "facility-evidence") {
    return exportFacilityEvidenceLedgerHash({ packs, fixturePath });
  }

  const rows = [];
  for (const pack of packs) {
    rows.push(...ledgerRowsForPack(kind, pack));
  }
  const canonicalRows = canonicalizeRows(rows);
  return {
    schemaVersion: 1,
    artifactKind: `datapack-${kind}-ledger-hash`,
    kind,
    fixturePath: path.relative(root, fixturePath),
    rowCount: canonicalRows.length,
    ledgerHash: sha256(JSON.stringify(canonicalRows)),
  };
}

// facility-evidence 전용 exporter — pack별 source(stationFacilityEvidence/facilities)를 수집하고
// pack 간 source 혼합을 거부한다. 단일 source면 그 값을 evidenceSource로 표기한다.
function exportFacilityEvidenceLedgerHash({ packs, fixturePath }) {
  const rows = [];
  const sources = new Set();
  for (const pack of packs) {
    const { source, rows: packRows } = facilityEvidenceRowsForPack(pack);
    sources.add(source);
    rows.push(...packRows);
  }
  if (sources.size > 1) {
    throw new Error(
      `facility-evidence source mixing is not allowed across packs: ${[...sources].join(" vs ")}`,
    );
  }
  const [evidenceSource] = sources.size > 0 ? [...sources] : ["facilities"];
  const canonicalRows = canonicalizeRows(rows);
  return {
    schemaVersion: 1,
    artifactKind: "datapack-facility-evidence-ledger-hash",
    kind: "facility-evidence",
    evidenceSource,
    fixturePath: path.relative(root, fixturePath),
    rowCount: canonicalRows.length,
    ledgerHash: sha256(JSON.stringify(canonicalRows)),
  };
}

function ledgerRowsForPack(kind, pack) {
  switch (kind) {
    case "alias":
      return requiredArray(pack.stationAliases ?? [], "pack.stationAliases").map((row) => ({
        stationId: requiredString(row.stationId, "stationAliases.stationId"),
        alias: requiredString(row.alias, "stationAliases.alias"),
        normalizedAlias: requiredString(row.normalizedAlias, "stationAliases.normalizedAlias"),
      }));
    case "operator-mapping":
      return requiredArray(pack.operators ?? [], "pack.operators").map((row) => ({
        id: requiredString(row.id, "operators.id"),
        nameKo: requiredString(row.nameKo, "operators.nameKo"),
        nameEn: requiredString(row.nameEn, "operators.nameEn"),
      }));
    case "facility-evidence":
      return facilityEvidenceRowsForPack(pack).rows;
    case "route-evidence":
      return requiredArray(pack.networkEdges ?? [], "pack.networkEdges").map((row) => ({
        id: requiredString(row.id, "networkEdges.id"),
        fromNodeId: requiredString(row.fromNodeId, "networkEdges.fromNodeId"),
        toNodeId: requiredString(row.toNodeId, "networkEdges.toNodeId"),
        edgeType: requiredString(row.edgeType, "networkEdges.edgeType"),
      }));
    default:
      throw new Error(`unsupported fixture ledger kind: ${kind}`);
  }
}

// facility-evidence 전용 매핑 — source(stationFacilityEvidence primary → facilities fallback) 판정을
// 이 한 곳에만 둔다(매핑 중복 금지). { source, rows }를 반환한다.
function facilityEvidenceRowsForPack(pack) {
  const evidence = pack.stationFacilityEvidence;
  if (Array.isArray(evidence) && evidence.length > 0) {
    return {
      source: "stationFacilityEvidence",
      rows: evidence.map((row) => ({
        stationId: requiredString(row.stationId, "stationFacilityEvidence.stationId"),
        lineId: requiredString(row.lineId, "stationFacilityEvidence.lineId"),
        facilityType: requiredString(row.facilityType, "stationFacilityEvidence.facilityType"),
        evidenceHash: requiredString(row.evidenceHash, "stationFacilityEvidence.evidenceHash"),
        providerRecordHash: requiredString(row.providerRecordHash, "stationFacilityEvidence.providerRecordHash"),
      })),
    };
  }
  return {
    source: "facilities",
    rows: requiredArray(pack.facilities ?? [], "pack.facilities").map((row) => ({
      id: requiredString(row.id, "facilities.id"),
      stationId: requiredString(row.stationId, "facilities.stationId"),
      type: requiredString(row.type, "facilities.type"),
      status: requiredString(row.status, "facilities.status"),
    })),
  };
}

// license evidence hash — source-inventory.json 해당 source의 license 블록.
async function exportLicenseEvidenceHash(args) {
  const inventoryPath = path.resolve(root, args.inventory ?? "tools/datapack/source-inventory.json");
  const sourceId = requireArg(args, "source-id");
  const inventory = await readJsonFile(inventoryPath);
  const source = requiredArray(inventory.sources, "inventory.sources").find((entry) => entry.id === sourceId);
  if (!source) {
    throw new Error(`source-id not found in inventory: ${sourceId}`);
  }
  const license = source.license;
  if (!license || typeof license !== "object" || Array.isArray(license)) {
    throw new Error(`inventory source ${sourceId} has no license block`);
  }
  return {
    schemaVersion: 1,
    artifactKind: "datapack-license-evidence-hash",
    kind: "license",
    inventoryPath: path.relative(root, inventoryPath),
    sourceId,
    ledgerHash: sha256(JSON.stringify(sortJson(license))),
  };
}

// override hash — manual override ledger(apply-admin-review-overrides.mjs 계약과 동일 파일).
//
// fixture 원장(canonical row 정렬)과 달리, override 원장은 facilityStatusUpdates 배열의
// "순서가 의미를 갖는" 데이터다: apply-admin-review-overrides.mjs가 latestFacilityUpdates를
// 계산할 때 reviewedAt 동률(tie)이면 배열 인덱스를 tiebreaker(sequence)로 사용한다.
// 따라서 override 해시는 sortJson으로 객체 key만 사전순 정렬하고 배열 순서는 파일 원본
// 그대로 보존하며, fixture 원장처럼 canonical row 재정렬을 적용하지 않는 것이 계약이다.
// (배열을 canonical 정렬하면 override의 tiebreaker 의미가 깨지므로 정렬하지 않는다.)
async function exportOverrideHash(args) {
  const overridesPath = path.resolve(root, requireArg(args, "overrides"));
  const overrides = await readJsonFile(overridesPath);
  if (overrides.artifactKind !== "datapack-manual-override-ledger") {
    throw new Error("override ledger artifactKind must be datapack-manual-override-ledger");
  }
  if (overrides.ledgerSource !== "manual_overrides") {
    throw new Error("override ledger ledgerSource must be manual_overrides");
  }
  return {
    schemaVersion: 1,
    artifactKind: "datapack-override-ledger-hash",
    kind: "override",
    overridesPath: path.relative(root, overridesPath),
    rowCount: Array.isArray(overrides.facilityStatusUpdates) ? overrides.facilityStatusUpdates.length : 0,
    ledgerHash: sha256(JSON.stringify(sortJson(overrides))),
  };
}

// row 집합을 canonical 문자열로 직렬화한 뒤 사전순 정렬 — 입력 순서 불변.
function canonicalizeRows(rows) {
  return rows.map((row) => JSON.stringify(sortJson(row))).sort(compareStrings);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export { exportLedgerHash, canonicalizeRows, sortJson, sha256 };
