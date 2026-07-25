// route_map_positions admitted 소스가 claim한 (region, operator, line) scope에 대해
// "MOLIT roster 역 집합 ⊆ admitted snapshot 역 집합" containment를 판정한다(#2516).
//
// 면제는 두 가지만 허용하고 둘 다 근거를 실측 검증한다.
// - 승인 별칭 사전: 같은 역을 다른 표기로 실은 경우만. 별칭 대상이 snapshot에 실존해야 하고,
//   roster의 다른 역을 가리는 표기는 거부한다(결측 은폐 차단).
// - 문서화된 결측 ledger: quarantine 기록·공식 원문 결함처럼 실측 가능한 근거가 있는 결측만.
//   근거가 데이터로 확인되지 않으면 면제하지 않는다.
// 그 외 불일치는 전부 fail-closed다.
//
// 근거 필드 검증 범위(정직한 한계 서술):
// - officialUrl은 그 scope를 커버하는 소스·admitted snapshot과 그 scope의 topology lineage 소스가
//   등재한 공식 데이터셋 URL만 허용한다. 전역 집합이면 다른 지역 데이터셋 URL도 근거가 된다.
//   URL이 그 역명을 실제로 싣는지는 원격 조회 없이 확인할 수 없다.
// - issue 번호와 note 서술의 내용은 검증하지 않는다. 형식과 존재만 강제한다.
// - renamedAt은 형식과 상한(snapshot capturedAt)만 본다. 개명 사실 자체는 crossCheck로 확인한다.
//
// lineIds claim의 admission 모델은 두 가지다.
// - collector snapshot 모델: routeMapAdmissionEvidence.snapshotPath가 가리키는 admitted snapshot으로
//   역 집합을 실측한다. containment 판정의 정본이며 claim이 감사 대상 scope를 만든다.
// - candidate 게이트 line-scope 재기술 모델(#2510 B0, #2514): 승계 팩에 이미 있는 provenance 행을
//   (operator, line) line-scope로 재기술해 candidate 게이트 requirement를 SUPPORTED로 전이시킨 claim이다.
//   저장소에 admitted snapshot 파일이 없어 역 집합을 실측할 수 없으므로 이 claim은 containment 근거가
//   되지 못하고 감사 대상 scope도 만들지 못한다. 근거 없는 claim이 감사를 침묵시키지 못하도록
//   ① candidate pack spec의 재기술 등재(lineIds 동형), ② 그 spec 바이트에 결속된 게이트 evidence의
//   SUPPORTED 실증, ③ 같은 scope가 실제 containment 감사 대상으로 남아 있음을 모두 요구한다.
//   ③은 snapshot 커버 여부가 아니라 auditableScopeKeys가 확정한 감사 집합으로 판정한다. scope가
//   activeLineScopes에서 빠지거나 roster가 없으면 감사가 사라지는데 커버 여부만 보면 그대로 통과한다.
//   ③이 없으면 재기술 등재만으로 containment 감사를 끌 수 있으므로 fail-closed의 핵심이다.

import { createHash } from "node:crypto";

export const ROUTE_MAP_DOMAIN = "route_map_positions";

const CANDIDATE_GATE_EVIDENCE_KIND = "nationwide-candidate-coverage-gate-evidence";

const ALIAS_REASON_CODES = Object.freeze([
  "OFFICIAL_LINE_ORDINAL_SUFFIX",
  "OFFICIAL_ABBREVIATION",
  "OFFICIAL_RENAME",
]);

const GAP_REASON_CODES = Object.freeze([
  "ADMISSION_QUARANTINED",
  "OFFICIAL_FILE_ROW_ABSENT",
  "PACK_SCOPE_ABSENT",
]);

// OFFICIAL_RENAME은 URL·날짜만으로는 세탁이 가능하므로 기계적 교차 근거를 하나 요구한다.
// 표기 방향을 분리한다. XOR 하나로 묶으면 정당한 개명과 snapshot 표기 오염이 같은 시그니처가 된다.
// - ROSTER_SUBNAME: roster 원문이 snapshot측 표기를 부역명으로 병기한다.
// - PACK_TOPOLOGY_ADOPTED_NAME: pack topology가 snapshot측 신표기를 채택하고 roster측 구표기를 싣지 않는다.
// - OFFICIAL_FILE_STALE_NAME: pack topology·roster는 신표기인데 admitted snapshot만 구표기다.
//   이 방향은 오염과 구분되지 않으므로 공식 원문 바이트(rawSha256 결속)에 그 표기가 실재해야 한다.
const TOPOLOGY_SNAPSHOT_DIR = "tools/datapack/sources";

// MOLIT 원본과 admitted snapshot은 같은 역을 다른 표기로 싣는다(부역명 병기, 역 접미사).
// 판정 대상은 역 집합의 포함 관계뿐이므로 표기 차이만 제거하고 비교한다.
function normalizeStationName(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/\([^()]*\)/gu, "")
    .replace(/[·.\s]/gu, "")
    .replace(/역$/u, "")
    .trim();
}

// 부역명 병기 표기에서 괄호 안 이름만 뽑는다(불암산(당고개) → 당고개).
function parentheticalNames(rawName) {
  return [...String(rawName).normalize("NFKC").matchAll(/\(([^()]*)\)/gu)]
    .map(([, inner]) => normalizeStationName(inner));
}

function scopeKey({ regionId, operatorId, lineId }) {
  return `${regionId}:${operatorId}:${lineId}`;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIssueNumber(value) {
  return Number.isInteger(value) && value > 0;
}

function isIsoDate(value) {
  return isNonEmptyString(value) && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function isSubsequence(short, long) {
  let index = 0;
  for (const character of long) {
    if (character === short[index]) {
      index += 1;
    }
  }
  return index === short.length;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// 노선 topology snapshot은 두 형태다: capital처럼 lines[] 묶음, daegu처럼 단일 lineId.
function topologyLineOf(topology, lineId) {
  if (Array.isArray(topology?.lines)) {
    const line = topology.lines.find((entry) => entry?.lineId === lineId);
    return Array.isArray(line?.scope) ? { scope: line.scope, edges: line.edges, contentSha256: line.contentSha256 } : null;
  }
  if (topology?.lineId === lineId && Array.isArray(topology.scope)) {
    return { scope: topology.scope, edges: topology.edges, contentSha256: topology.contentSha256 };
  }
  return null;
}

// topology snapshot에서 역을 지워 결측을 세탁하지 못하도록 선언된 content 해시를 재계산해 대조한다.
// capital 묶음 형태는 상위 payload 해시까지 재계산해 lineage 선언과 결속한다.
function topologyContentMatches(topology, line) {
  if (sha256(JSON.stringify({ scope: line.scope, edges: line.edges })) !== line.contentSha256) {
    return false;
  }
  if (!Array.isArray(topology.lines)) {
    return true;
  }
  const payload = {
    lines: topology.lines.map(({ lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId }) => ({
      lineId,
      edgeCount,
      stationCount,
      contentSha256,
      rawSha256,
      datasetId,
    })),
    topologyGaps: topology.topologyGaps,
  };
  return sha256(JSON.stringify(payload)) === topology.contentSha256;
}

function claimedScopes(scope) {
  const claims = [];
  for (const regionId of scope.regionIds ?? []) {
    for (const operatorId of scope.operatorIds ?? []) {
      for (const lineId of scope.lineIds ?? []) {
        claims.push({ key: scopeKey({ regionId, operatorId, lineId }), lineId });
      }
    }
  }
  return claims;
}

// (operator, line) scope를 claim하지 않는 소스는 containment 판정 대상이 아니다.
function claimsRouteMapLineScope(source) {
  const scope = source.coverageScope;
  return Boolean(scope?.sourceDomains?.includes(ROUTE_MAP_DOMAIN)) && (scope.lineIds ?? []).length > 0;
}

function sameStringSet(left, right) {
  const leftSet = new Set(Array.isArray(left) ? left : []);
  const rightSet = new Set(Array.isArray(right) ? right : []);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

// spec 바이트를 직접 해시해 parse 결과와 결속한다 — 호출자가 서로 다른 spec 문서와 해시를 넘길 수 없다.
function readCandidateLineScopeAdmission({ specPath, specBytes, evidence } = {}) {
  if (!isNonEmptyString(specPath) || !specBytes) {
    return null;
  }
  let spec;
  try {
    spec = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(specBytes));
  } catch {
    return null;
  }
  return { specPath, specSha256: sha256(specBytes), spec, evidence };
}

// evidence가 이 spec 바이트를 입력으로 기록했을 때만 SUPPORTED 실증을 근거로 인정한다.
function candidateEvidenceBindsSpec(admission) {
  const declared = admission.evidence?.inputs?.spec;
  return admission.evidence?.artifactKind === CANDIDATE_GATE_EVIDENCE_KIND
    && declared?.path === admission.specPath
    && declared.sha256 === admission.specSha256;
}

// 재기술 claim 하나의 근거 결속. 성립하면 등재된 재기술 항목을 돌려준다.
function boundCandidateRedescription({ source, admission, push }) {
  const redescription = (admission?.spec?.lineScopeRedescriptions ?? [])
    .find((entry) => entry?.sourceId === source.id && entry.sourceDomain === ROUTE_MAP_DOMAIN);
  if (!redescription) {
    push(
      "SOURCE_SNAPSHOT_PATH_MISSING",
      "lineIds를 claim한 route_map_positions 소스는 routeMapAdmissionEvidence.snapshotPath 또는"
      + " candidate 게이트 line-scope 재기술 근거가 필요하다",
    );
    return null;
  }
  if (!sameStringSet(redescription.lineIds, source.coverageScope.lineIds)) {
    push("SOURCE_CANDIDATE_LINE_SCOPE_MISMATCH", "candidate spec 재기술 lineIds가 coverageScope.lineIds와 다르다");
    return null;
  }
  if (!candidateEvidenceBindsSpec(admission)) {
    push("SOURCE_CANDIDATE_EVIDENCE_SPEC_UNBOUND", "candidate 게이트 evidence가 이 spec 바이트를 입력으로 기록하지 않았다");
    return null;
  }
  return redescription;
}

function validateCandidateScope({ key, redescription, supported, auditedScopeKeys, push }) {
  const requirementKey = `${key}:${ROUTE_MAP_DOMAIN}`;
  if (!(redescription.requirementKeys ?? []).includes(requirementKey) || !supported.has(requirementKey)) {
    push("SOURCE_CANDIDATE_SCOPE_NOT_SUPPORTED", `candidate 게이트가 ${requirementKey}를 SUPPORTED로 실증하지 않았다`);
    return;
  }
  // 같은 scope가 containment 감사 대상으로 남아 있지 않으면 이 claim만으로는 판정할 근거가 없다.
  if (!auditedScopeKeys.has(key)) {
    push("SOURCE_CANDIDATE_SCOPE_UNAUDITED", `${key}가 containment 감사 대상 scope가 아니어서 판정할 수 없다`);
  }
}

// snapshot 없는 lineIds claim은 candidate 게이트 재기술 근거가 전부 성립할 때만 위반이 아니다.
// 재기술 claim 자체는 역 집합을 싣지 않으므로 감사 대상 scope를 만들지 않는다.
function validateCandidateLineScopeClaims({ sources, admission, auditedScopeKeys, violations }) {
  for (const source of sources) {
    const push = (kind, message) => violations.push({ kind, sourceId: source.id, message: `${source.id}: ${message}` });
    const redescription = boundCandidateRedescription({ source, admission, push });
    if (!redescription) {
      continue;
    }
    const supported = new Set(admission.evidence.variants?.lineScoped?.supportedRequirementKeys ?? []);
    for (const { key } of claimedScopes(source.coverageScope)) {
      validateCandidateScope({ key, redescription, supported, auditedScopeKeys, push });
    }
  }
}

// snapshotId → 등재 경로. topology snapshot 파일명은 snapshotId를 그대로 쓴다.
function lineageTopologyPaths(admissionEvidence, lineId) {
  return (admissionEvidence.topologyLineages ?? [])
    .filter((lineage) => lineage.lineId === lineId && isNonEmptyString(lineage.snapshotId))
    .map((lineage) => ({
      path: `${TOPOLOGY_SNAPSHOT_DIR}/${lineage.snapshotId}.json`,
      contentSha256: lineage.contentSha256,
      snapshotId: lineage.snapshotId,
    }));
}

function addOfficialUrls(target, entry) {
  const add = (value) => {
    if (typeof value === "string" && value.startsWith("https://")) {
      target.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(add);
    }
  };
  add(entry?.datasetUrl);
  add(entry?.datasetUrls);
  add(entry?.detailUrl);
  add(entry?.license?.evidenceUrl);
}

// topology snapshotId → 그 snapshot을 admission한 inventory 소스. lineage 소스의 공식 URL도
// 그 scope의 근거로 인정하기 위한 색인이다(대구 2호선 역 구간정보 파일 등).
function topologySourcesBySnapshotId(inventory) {
  const sources = new Map();
  for (const source of inventory.sources ?? []) {
    const snapshotId = source.topologyAdmissionEvidence?.snapshotId;
    if (isNonEmptyString(snapshotId)) {
      sources.set(snapshotId, source);
    }
  }
  return sources;
}

// 정규화 키가 겹치면 뒤 항목이 앞 항목을 덮어 서로 다른 두 역이 한 칸으로 접합된다.
// 결측 은폐로 이어지므로 덮어쓰기 대신 위반으로 올린다.
function indexPositions(target, positions, lineId, push) {
  for (const position of positions ?? []) {
    if (position.lineId !== lineId) {
      continue;
    }
    const key = normalizeStationName(position.stationName);
    const previous = target.get(key);
    if (previous && previous.stationName !== position.stationName) {
      push(`정규화 표기가 충돌한다 (${previous.stationName} / ${position.stationName})`);
    }
    target.set(key, position);
  }
}

function indexScopeCoverage(coverage, snapshot, lineId, push) {
  indexPositions(coverage.positionsByName, snapshot.positions, lineId, push);
  indexPositions(coverage.quarantinedByName, snapshot.quarantinedPositions, lineId, push);
}

// coverageScope가 route_map_positions를 claim한 소스에서 (scope, snapshot) 결속을 모은다.
// 같은 scope를 여러 소스가 나눠 커버할 수 있으므로(예: 9호선 1단계 + 2·3단계) 역 집합은 합집합이다.
// 근거 URL 화이트리스트도 여기서 scope 단위로 모은다 — 전역 집합이면 그 scope와 무관한 출처가 통과한다.
function collectScopeCoverage({ inventory, snapshotsByPath, violations }) {
  const coverageByScope = new Map();
  const officialUrlsByScope = new Map();
  const claims = [];
  const candidateClaimants = [];
  const topologySources = topologySourcesBySnapshotId(inventory);
  for (const source of inventory.sources ?? []) {
    if (!claimsRouteMapLineScope(source)) {
      continue;
    }
    const snapshotPath = source.routeMapAdmissionEvidence?.snapshotPath;
    if (!isNonEmptyString(snapshotPath)) {
      candidateClaimants.push(source);
      continue;
    }
    const snapshot = snapshotsByPath.get(snapshotPath);
    if (!snapshot) {
      violations.push({
        kind: "SOURCE_SNAPSHOT_UNREADABLE",
        sourceId: source.id,
        message: `${source.id}: snapshot을 읽지 못했다 (${snapshotPath})`,
      });
      continue;
    }
    for (const { key, lineId } of claimedScopes(source.coverageScope)) {
      claims.push({ sourceId: source.id, key });
      const coverage = coverageByScope.get(key) ?? {
        lineId,
        sourceIds: [],
        snapshotPaths: [],
        capturedAts: [],
        rawSha256s: new Set(),
        topologyPaths: new Set(),
        topologyContentByPath: new Map(),
        positionsByName: new Map(),
        quarantinedByName: new Map(),
      };
      coverage.sourceIds.push(source.id);
      coverage.snapshotPaths.push(snapshotPath);
      coverage.capturedAts.push(String(snapshot.capturedAt ?? ""));
      if (isNonEmptyString(snapshot.rawSha256)) {
        coverage.rawSha256s.add(snapshot.rawSha256);
      }
      const officialUrls = officialUrlsByScope.get(key) ?? new Set();
      addOfficialUrls(officialUrls, source);
      addOfficialUrls(officialUrls, snapshot);
      officialUrlsByScope.set(key, officialUrls);
      for (const lineage of lineageTopologyPaths(source.routeMapAdmissionEvidence, lineId)) {
        coverage.topologyPaths.add(lineage.path);
        coverage.topologyContentByPath.set(lineage.path, lineage.contentSha256);
        addOfficialUrls(officialUrls, topologySources.get(lineage.snapshotId));
      }
      indexScopeCoverage(coverage, snapshot, lineId, (message) => violations.push({
        kind: "SNAPSHOT_NAME_COLLISION",
        scopeKey: key,
        message: `${key} (${source.id}): ${message}`,
      }));
      coverageByScope.set(key, coverage);
    }
  }
  return { coverageByScope, officialUrlsByScope, claims, candidateClaimants };
}

// scope가 topology lineage를 등재했으면 그 snapshot만, 없으면 inventory에 등재된
// route_map topology snapshot 전체를 허용한다(서울 8호선처럼 lineage 미등재 scope 대응).
function collectRegisteredTopologyPaths(inventory) {
  const paths = new Set();
  for (const source of inventory.sources ?? []) {
    if (!source.coverageScope?.sourceDomains?.includes(ROUTE_MAP_DOMAIN)) {
      continue;
    }
    for (const lineage of source.routeMapAdmissionEvidence?.topologyLineages ?? []) {
      if (isNonEmptyString(lineage.snapshotId)) {
        paths.add(`${TOPOLOGY_SNAPSHOT_DIR}/${lineage.snapshotId}.json`);
      }
    }
  }
  return paths;
}

function resolveTopologyNames({ topologyPath, coverage, registeredTopologyPaths, topologiesByPath, prefix, push, requireLineage = false }) {
  const allowed = coverage.topologyPaths.size > 0 ? coverage.topologyPaths : registeredTopologyPaths;
  if (!isNonEmptyString(topologyPath) || !allowed.has(topologyPath)) {
    push(`${prefix}_PACK_TOPOLOGY_UNBOUND`, "packTopologyPath가 이 scope에 등재된 topology snapshot이 아니다");
    return null;
  }
  const topology = topologiesByPath.get(topologyPath);
  const line = topologyLineOf(topology, coverage.lineId);
  if (!line) {
    push(`${prefix}_PACK_TOPOLOGY_MISSING`, `pack topology에서 ${coverage.lineId} scope를 찾지 못했다`);
    return null;
  }
  if (!topologyContentMatches(topology, line)) {
    push(`${prefix}_PACK_TOPOLOGY_CONTENT_MISMATCH`, "pack topology 내용이 선언된 contentSha256과 다르다");
    return null;
  }
  const declared = coverage.topologyContentByPath.get(topologyPath);
  // "topology에 역이 없다"를 근거로 쓰는 검사는 파일 자기정합성만으로는 부족하다. 해시를 함께 다시
  // 계산해 붙이면 자기정합성은 통과하므로, admission lineage가 선언한 contentSha256 결속을 요구한다.
  if (requireLineage && !isNonEmptyString(declared)) {
    push(`${prefix}_PACK_TOPOLOGY_LINEAGE_UNDECLARED`, "이 scope의 admission lineage가 topology contentSha256을 선언하지 않았다");
    return null;
  }
  if (isNonEmptyString(declared) && declared !== topology.contentSha256) {
    push(`${prefix}_PACK_TOPOLOGY_LINEAGE_MISMATCH`, "pack topology가 admission lineage의 contentSha256과 다르다");
    return null;
  }
  return new Set(line.scope.map((entry) => normalizeStationName(entry?.stationName)));
}

function validateAliasShape({ alias, auditedScopeKeys, officialUrlsByScope, push }) {
  if (!isNonEmptyString(alias?.scopeKey) || !auditedScopeKeys.has(alias.scopeKey)) {
    push("ALIAS_SCOPE_NOT_AUDITED", "containment 감사 대상 scope가 아니다");
    return false;
  }
  if (!isNonEmptyString(alias.snapshotStationName) || !isNonEmptyString(alias.rosterStationName)) {
    push("ALIAS_STATION_NAME_INVALID", "snapshotStationName·rosterStationName이 필요하다");
    return false;
  }
  if (!ALIAS_REASON_CODES.includes(alias.reasonCode)) {
    push("ALIAS_REASON_CODE_INVALID", `reasonCode가 승인 목록에 없다 (${alias.reasonCode})`);
    return false;
  }
  if (!isIssueNumber(alias.evidence?.issue)) {
    push("ALIAS_EVIDENCE_ISSUE_INVALID", "evidence.issue는 양의 정수 이슈 번호여야 한다");
    return false;
  }
  if (!officialUrlsByScope.get(alias.scopeKey)?.has(alias.evidence.officialUrl)) {
    push("ALIAS_EVIDENCE_URL_UNREGISTERED", "evidence.officialUrl이 이 scope에 등재된 공식 데이터셋 URL이 아니다");
    return false;
  }
  if (!isNonEmptyString(alias.evidence.note)) {
    push("ALIAS_EVIDENCE_NOTE_MISSING", "evidence.note 근거 서술이 필요하다");
    return false;
  }
  return true;
}

function validateAliasBinding({ alias, coverage, roster, snapshotName, rosterName, seen, push }) {
  // 별칭 대상 역이 snapshot에 실존해야 한다 — 결측을 별칭으로 은폐할 수 없다.
  if (!coverage.positionsByName.has(snapshotName)) {
    push("ALIAS_SNAPSHOT_STATION_ABSENT", "snapshotStationName이 admitted snapshot에 없다");
    return false;
  }
  if (!roster.stationNames.includes(alias.rosterStationName)) {
    push("ALIAS_ROSTER_STATION_ABSENT", "rosterStationName이 MOLIT roster 원문과 다르다");
    return false;
  }
  if (coverage.positionsByName.has(rosterName)) {
    push("ALIAS_NOT_NEEDED", "roster 역이 이미 snapshot에 있어 별칭이 필요 없다");
    return false;
  }
  // snapshot 표기가 roster의 다른 역과 같으면 한 역이 두 역을 커버하게 되므로 거부한다.
  if (roster.stationNames.some((name) => normalizeStationName(name) === snapshotName)) {
    push("ALIAS_SHADOWS_ROSTER_STATION", "snapshotStationName이 roster의 다른 역과 같다");
    return false;
  }
  if (seen.snapshotNames.has(snapshotName) || seen.rosterNames.has(rosterName)) {
    push("ALIAS_DUPLICATE", "같은 scope에서 별칭은 1:1이어야 한다");
    return false;
  }
  return true;
}

function neighboursOf(orderedNames, stationName) {
  const index = orderedNames.indexOf(stationName);
  if (index < 0) {
    return null;
  }
  return [orderedNames[index - 1] ?? null, orderedNames[index + 1] ?? null];
}

function sameNeighbours(left, right) {
  if (!left || !right) {
    return false;
  }
  const [leftPrevious, leftNext] = left;
  const [rightPrevious, rightNext] = right;
  // snapshot과 roster의 나열 방향이 반대일 수 있어 역순 일치도 같은 위치로 본다.
  return (leftPrevious === rightPrevious && leftNext === rightNext)
    || (leftPrevious === rightNext && leftNext === rightPrevious);
}

// 대구 공식 파일·pack topology는 환승역을 "역명 + 호선번호"로 표기한다(명덕1 = 1호선 명덕).
function verifyLineOrdinalSuffixAlias({ coverage, snapshotName, rosterName, push }) {
  const ordinal = coverage.positionsByName.get(snapshotName).line;
  if (!isNonEmptyString(ordinal) || !/^\d+$/u.test(ordinal)) {
    push("ALIAS_LINE_ORDINAL_UNKNOWN", "snapshot position에 호선 번호(line)가 없다");
    return false;
  }
  if (snapshotName !== `${rosterName}${ordinal}`) {
    push("ALIAS_LINE_ORDINAL_MISMATCH", `표기가 "${rosterName}${ordinal}" 형태가 아니다`);
    return false;
  }
  return true;
}

function verifyAbbreviationAlias({ snapshotName, rosterName, push }) {
  if (snapshotName.length >= rosterName.length || !isSubsequence(snapshotName, rosterName)) {
    push("ALIAS_ABBREVIATION_MISMATCH", "snapshot 표기가 roster 표기의 축약형이 아니다");
    return false;
  }
  return true;
}

// roster 원문이 snapshot측 표기를 부역명으로 병기하는 경우.
function verifyRosterSubnameCrossCheck({ alias, snapshotName, push }) {
  if (!parentheticalNames(alias.rosterStationName).includes(snapshotName)) {
    push("ALIAS_RENAME_SUBNAME_ABSENT", "roster 원문이 옛 표기를 부역명으로 병기하지 않는다");
    return false;
  }
  return true;
}

function renameTopologyNames(context, requireLineage) {
  return resolveTopologyNames({
    topologyPath: context.alias.evidence?.packTopologyPath,
    coverage: context.coverage,
    registeredTopologyPaths: context.registeredTopologyPaths,
    topologiesByPath: context.topologiesByPath,
    prefix: "ALIAS",
    push: context.push,
    requireLineage,
  });
}

// pack topology가 snapshot측 신표기를 채택하고 roster측 구표기를 버린 경우.
// snapshot 표기가 오염되면 topology에는 roster측 표기가 남아 있으므로 여기서 걸린다.
function verifyAdoptedNameCrossCheck(context) {
  const { snapshotName, rosterName, push } = context;
  const topologyNames = renameTopologyNames(context, true);
  if (!topologyNames) {
    return false;
  }
  if (!topologyNames.has(snapshotName)) {
    push("ALIAS_RENAME_ADOPTED_NAME_ABSENT", "pack topology가 snapshot 표기를 싣지 않는다");
    return false;
  }
  if (topologyNames.has(rosterName)) {
    push("ALIAS_RENAME_ROSTER_NAME_PRESENT", "pack topology가 roster 표기도 실어 신표기 채택으로 볼 수 없다");
    return false;
  }
  return true;
}

// pack topology·roster는 신표기인데 admitted snapshot만 구표기인 경우.
// 이 방향은 표기 오염과 형태가 같아서, 구표기가 rawSha256으로 결속된 공식 원문 바이트에
// 실재하는지까지 확인해야 근거가 된다.
function verifyStaleNameCrossCheck(context) {
  const { alias, coverage, snapshotName, rosterName, rawSourcesByPath, push } = context;
  // 이 방향의 결정적 근거는 공식 원문 바이트 대조라 lineage 선언까지 요구하지 않는다.
  const topologyNames = renameTopologyNames(context, false);
  if (!topologyNames) {
    return false;
  }
  if (!topologyNames.has(rosterName)) {
    push("ALIAS_RENAME_ROSTER_NAME_ABSENT", "pack topology가 roster 표기를 싣지 않는다");
    return false;
  }
  if (topologyNames.has(snapshotName)) {
    push("ALIAS_RENAME_SNAPSHOT_NAME_PRESENT", "pack topology가 snapshot 표기도 실어 구표기로 볼 수 없다");
    return false;
  }
  const rawPath = alias.evidence?.officialRawPath;
  const rawBytes = isNonEmptyString(rawPath) ? rawSourcesByPath.get(rawPath) : undefined;
  if (!rawBytes || !coverage.rawSha256s.has(sha256(rawBytes))) {
    push("ALIAS_RENAME_RAW_SOURCE_UNBOUND", "officialRawPath가 admitted snapshot의 rawSha256과 결속되지 않는다");
    return false;
  }
  const rawTexts = decodedRawTexts(rawBytes);
  if (!rawTexts.some((text) => text.includes(alias.snapshotStationName))) {
    push("ALIAS_RENAME_RAW_NAME_ABSENT", "공식 원문 바이트에 snapshot 표기가 없다");
    return false;
  }
  // 부분문자열 일치는 행·노선 범위가 없어 다른 노선 행의 역명이나 한 글자도 근거가 된다. 방향을 함께
  // 요구해 오염과 구분한다 — 구표기를 싣는 원문이라면 roster 신표기는 아직 없어야 한다. snapshot 표기를
  // 제자리에서 오염시키면 밀려난 roster 표기가 원문에 그대로 남아 있으므로 여기서 걸린다.
  if (rawTexts.some((text) => text.includes(rosterName))) {
    push("ALIAS_RENAME_RAW_ROSTER_NAME_PRESENT", "공식 원문 바이트가 roster 신표기도 실어 구표기로 볼 수 없다");
    return false;
  }
  return true;
}

// 공식 원문 CSV는 EUC-KR과 UTF-8이 섞여 있어 두 해석 모두에서 표기를 찾는다.
function decodedRawTexts(bytes) {
  return ["euc-kr", "utf-8"].map((encoding) => {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      return "";
    }
  });
}

// 두 표기가 같은 역이라는 기계적 교차 근거. 선언한 방식이 실제로 성립해야 한다.
function verifyRenameCrossCheck(context) {
  const crossCheck = context.alias.evidence?.crossCheck;
  if (crossCheck === "ROSTER_SUBNAME") {
    return verifyRosterSubnameCrossCheck(context);
  }
  if (crossCheck === "PACK_TOPOLOGY_ADOPTED_NAME") {
    return verifyAdoptedNameCrossCheck(context);
  }
  if (crossCheck === "OFFICIAL_FILE_STALE_NAME") {
    return verifyStaleNameCrossCheck(context);
  }
  context.push("ALIAS_RENAME_CROSS_CHECK_INVALID", `evidence.crossCheck가 승인 목록에 없다 (${crossCheck})`);
  return false;
}

function verifyRenameAlias(context) {
  const { alias, coverage, roster, snapshotName, rosterName, push } = context;
  const renamedAt = alias.evidence?.renamedAt;
  if (!isIsoDate(renamedAt)) {
    push("ALIAS_RENAME_DATE_INVALID", "evidence.renamedAt(YYYY-MM-DD) 공식 변경 시행일이 필요하다");
    return false;
  }
  // 개명일이 snapshot 수집 시점보다 늦을 수 없다.
  const capturedOn = coverage.capturedAts.map((value) => value.slice(0, 10)).filter(isIsoDate);
  if (capturedOn.length === 0 || capturedOn.some((captured) => renamedAt > captured)) {
    push("ALIAS_RENAME_DATE_OUT_OF_RANGE", "renamedAt이 admitted snapshot capturedAt보다 늦다");
    return false;
  }
  // 같은 역이라는 근거를 데이터로 확인한다: 노선 나열에서 이웃 역이 같아야 한다.
  if (!sameNeighbours(
    neighboursOf([...coverage.positionsByName.keys()], snapshotName),
    neighboursOf(roster.stationNames.map(normalizeStationName), rosterName),
  )) {
    push("ALIAS_RENAME_SEQUENCE_MISMATCH", "노선 나열에서 두 표기의 이웃 역이 다르다");
    return false;
  }
  return verifyRenameCrossCheck(context);
}

function validateAliasReason(context) {
  const { reasonCode } = context.alias;
  if (reasonCode === "OFFICIAL_LINE_ORDINAL_SUFFIX") {
    return verifyLineOrdinalSuffixAlias(context);
  }
  if (reasonCode === "OFFICIAL_ABBREVIATION") {
    return verifyAbbreviationAlias(context);
  }
  if (reasonCode === "OFFICIAL_RENAME") {
    return verifyRenameAlias(context);
  }
  context.push("ALIAS_REASON_CODE_UNSUPPORTED", `reasonCode 검증 분기가 없다 (${reasonCode})`);
  return false;
}

function validateAliases({
  aliases,
  auditedScopeKeys,
  coverageByScope,
  rosters,
  officialUrlsByScope,
  registeredTopologyPaths,
  topologiesByPath,
  rawSourcesByPath,
  violations,
}) {
  const aliasedRosterNamesByScope = new Map();
  const seenByScope = new Map();
  for (const [index, alias] of aliases.entries()) {
    const label = `승인 별칭[${index}] ${alias?.scopeKey} ${alias?.snapshotStationName}→${alias?.rosterStationName}`;
    const push = (kind, message) => violations.push({
      kind,
      scopeKey: alias?.scopeKey,
      message: `${label}: ${message}`,
    });
    if (!validateAliasShape({ alias, auditedScopeKeys, officialUrlsByScope, push })) {
      continue;
    }
    const seen = seenByScope.get(alias.scopeKey)
      ?? { snapshotNames: new Set(), rosterNames: new Set() };
    seenByScope.set(alias.scopeKey, seen);
    const snapshotName = normalizeStationName(alias.snapshotStationName);
    const rosterName = normalizeStationName(alias.rosterStationName);
    const context = {
      alias,
      coverage: coverageByScope.get(alias.scopeKey),
      roster: rosters.get(alias.scopeKey),
      snapshotName,
      rosterName,
      seen,
      registeredTopologyPaths,
      topologiesByPath,
      rawSourcesByPath,
      push,
    };
    if (!validateAliasBinding(context) || !validateAliasReason(context)) {
      continue;
    }
    seen.snapshotNames.add(snapshotName);
    seen.rosterNames.add(rosterName);
    const aliased = aliasedRosterNamesByScope.get(alias.scopeKey) ?? new Set();
    aliased.add(rosterName);
    aliasedRosterNamesByScope.set(alias.scopeKey, aliased);
  }
  return aliasedRosterNamesByScope;
}

function validateGapShape({ gap, auditedScopeKeys, officialUrlsByScope, push }) {
  if (!isNonEmptyString(gap?.scopeKey) || !auditedScopeKeys.has(gap.scopeKey)) {
    push("LEDGER_SCOPE_NOT_AUDITED", "containment 감사 대상 scope가 아니다");
    return false;
  }
  if (!isNonEmptyString(gap.rosterStationName)) {
    push("LEDGER_STATION_NAME_INVALID", "rosterStationName이 필요하다");
    return false;
  }
  if (!GAP_REASON_CODES.includes(gap.reasonCode)) {
    push("LEDGER_REASON_CODE_INVALID", `reasonCode가 승인 목록에 없다 (${gap.reasonCode})`);
    return false;
  }
  if (!isIssueNumber(gap.evidence?.issue)) {
    push("LEDGER_EVIDENCE_ISSUE_INVALID", "evidence.issue는 양의 정수 이슈 번호여야 한다");
    return false;
  }
  if (!officialUrlsByScope.get(gap.scopeKey)?.has(gap.evidence.officialUrl)) {
    push("LEDGER_EVIDENCE_URL_UNREGISTERED", "evidence.officialUrl이 이 scope에 등재된 공식 데이터셋 URL이 아니다");
    return false;
  }
  if (!isNonEmptyString(gap.evidence.note)) {
    push("LEDGER_EVIDENCE_NOTE_MISSING", "evidence.note 근거 서술이 필요하다");
    return false;
  }
  return true;
}

function validateGapBinding({ gap, coverage, roster, rosterName, aliased, seen, push }) {
  if (!roster.stationNames.includes(gap.rosterStationName)) {
    push("LEDGER_ROSTER_STATION_ABSENT", "rosterStationName이 MOLIT roster 원문과 다르다");
    return false;
  }
  // 별칭 적용 후에도 여전히 결측인 항목만 남긴다 — admission으로 해소되면 ledger에서 빼야 한다.
  if (coverage.positionsByName.has(rosterName) || aliased.has(rosterName)) {
    push("LEDGER_NOT_NEEDED", "역이 이미 admitted snapshot에 있어 면제가 필요 없다");
    return false;
  }
  if (seen.has(rosterName)) {
    push("LEDGER_DUPLICATE", "같은 scope에 중복 항목이 있다");
    return false;
  }
  const snapshotPath = gap.evidence.snapshotPath;
  if (!isNonEmptyString(snapshotPath) || !coverage.snapshotPaths.includes(snapshotPath)) {
    push("LEDGER_SNAPSHOT_NOT_CLAIMED", "evidence.snapshotPath가 이 scope를 커버하는 admitted snapshot이 아니다");
    return false;
  }
  return true;
}

function gapTopologyNames(context, requireLineage) {
  return resolveTopologyNames({
    topologyPath: context.gap.evidence.packTopologyPath,
    coverage: context.coverage,
    registeredTopologyPaths: context.registeredTopologyPaths,
    topologiesByPath: context.topologiesByPath,
    prefix: "LEDGER",
    push: context.push,
    requireLineage,
  });
}

function verifyQuarantinedGap({ gap, coverage, rosterName, push }) {
  const quarantined = coverage.quarantinedByName.get(rosterName);
  const declared = gap.evidence.quarantineReasonCode;
  if (!quarantined || !isNonEmptyString(declared) || quarantined.reasonCode !== declared) {
    push("LEDGER_QUARANTINE_RECORD_ABSENT", "snapshot quarantinedPositions에 같은 reasonCode 기록이 없다");
    return false;
  }
  return true;
}

// 공식 원문에 행이 없다는 근거. collector가 topologyGaps로 결측을 직접 선언했으면 그 목록을 정본으로 쓰고,
// 선언이 없는 snapshot은 원본 행이 전부 admitted·quarantined로 회계되는지로 판정한다.
// rawStationCount의 의미는 collector마다 다르므로(pack 밖 잉여 행을 세지 않는 수집기가 있다) 회계 검사만으로는
// 부족하고, topologyGaps 선언이 있으면 그쪽을 우선한다.
function verifyOfficialFileRowAbsence({ coverage, rosterName, snapshot, push }) {
  const declaredGaps = snapshot?.topologyGaps;
  if (Array.isArray(declaredGaps)) {
    const declared = declaredGaps.some((entry) => entry?.lineId === coverage.lineId
      && normalizeStationName(entry.stationName) === rosterName);
    if (!declared) {
      push("LEDGER_TOPOLOGY_GAP_NOT_DECLARED", "snapshot topologyGaps에 선언되지 않은 역이다");
    }
    return declared;
  }
  const accounted = (snapshot?.stationCount ?? Number.NaN) + (snapshot?.quarantinedCount ?? Number.NaN);
  if (!Number.isInteger(snapshot?.rawStationCount) || snapshot.rawStationCount !== accounted) {
    push("LEDGER_RAW_ROW_ACCOUNTING_MISMATCH", "snapshot rawStationCount가 stationCount+quarantinedCount와 다르다");
    return false;
  }
  return true;
}

// pack은 이 역을 요구하는데 공식 원문에 행이 없는 경우만 이 사유에 해당한다.
function verifyOfficialFileRowAbsentGap(context) {
  const { coverage, rosterName, push } = context;
  // topology가 역을 싣고 있다는 존재 근거라 재해시 삭제로 유리해지지 않는다.
  const topologyNames = gapTopologyNames(context, false);
  if (!topologyNames) {
    return false;
  }
  if (!topologyNames.has(rosterName)) {
    push("LEDGER_PACK_TOPOLOGY_STATION_ABSENT", "pack topology에 없는 역은 OFFICIAL_FILE_ROW_ABSENT가 아니다");
    return false;
  }
  if (coverage.quarantinedByName.has(rosterName)) {
    push("LEDGER_STATION_QUARANTINED", "quarantine 기록이 있는 역은 ADMISSION_QUARANTINED로 분류한다");
    return false;
  }
  return verifyOfficialFileRowAbsence(context);
}

// pack 노선 topology 자체가 역을 싣지 않은 경우만 이 사유에 해당한다.
function verifyPackScopeAbsentGap(context) {
  const topologyNames = gapTopologyNames(context, true);
  if (!topologyNames) {
    return false;
  }
  if (topologyNames.has(context.rosterName)) {
    context.push("LEDGER_PACK_TOPOLOGY_STATION_PRESENT", "pack topology에 있는 역은 PACK_SCOPE_ABSENT가 아니다");
    return false;
  }
  return true;
}

function validateGapReason(context) {
  const { reasonCode } = context.gap;
  if (reasonCode === "ADMISSION_QUARANTINED") {
    return verifyQuarantinedGap(context);
  }
  if (reasonCode === "OFFICIAL_FILE_ROW_ABSENT") {
    return verifyOfficialFileRowAbsentGap(context);
  }
  if (reasonCode === "PACK_SCOPE_ABSENT") {
    return verifyPackScopeAbsentGap(context);
  }
  context.push("LEDGER_REASON_CODE_UNSUPPORTED", `reasonCode 검증 분기가 없다 (${reasonCode})`);
  return false;
}

function validateGaps({
  gaps,
  auditedScopeKeys,
  coverageByScope,
  rosters,
  aliasedRosterNamesByScope,
  officialUrlsByScope,
  registeredTopologyPaths,
  snapshotsByPath,
  topologiesByPath,
  violations,
}) {
  const gapRosterNamesByScope = new Map();
  for (const [index, gap] of gaps.entries()) {
    const label = `결측 ledger[${index}] ${gap?.scopeKey} ${gap?.rosterStationName}`;
    const push = (kind, message) => violations.push({
      kind,
      scopeKey: gap?.scopeKey,
      message: `${label}: ${message}`,
    });
    if (!validateGapShape({ gap, auditedScopeKeys, officialUrlsByScope, push })) {
      continue;
    }
    const rosterName = normalizeStationName(gap.rosterStationName);
    const seen = gapRosterNamesByScope.get(gap.scopeKey) ?? new Set();
    gapRosterNamesByScope.set(gap.scopeKey, seen);
    const context = {
      gap,
      coverage: coverageByScope.get(gap.scopeKey),
      roster: rosters.get(gap.scopeKey),
      rosterName,
      aliased: aliasedRosterNamesByScope.get(gap.scopeKey) ?? new Set(),
      seen,
      snapshot: snapshotsByPath.get(gap.evidence.snapshotPath),
      registeredTopologyPaths,
      topologiesByPath,
      push,
    };
    if (!validateGapBinding(context) || !validateGapReason(context)) {
      continue;
    }
    seen.add(rosterName);
  }
  return gapRosterNamesByScope;
}

function auditableScopeKeys({ claims, activeScopeKeys, rosters, violations }) {
  const auditedScopeKeys = [];
  const seen = new Set();
  for (const claim of claims) {
    // activeLineScopes에 없는 (operator, line) 조합은 #2138 requirement가 아니라 lineage 표기다.
    if (!activeScopeKeys.has(claim.key) || seen.has(claim.key)) {
      continue;
    }
    seen.add(claim.key);
    if (!rosters.get(claim.key)) {
      violations.push({
        kind: "ROSTER_MISSING",
        scopeKey: claim.key,
        message: `${claim.key}: MOLIT roster가 없다 (${claim.sourceId})`,
      });
      continue;
    }
    auditedScopeKeys.push(claim.key);
  }
  return auditedScopeKeys;
}

function reportMissingStations({ auditedScopeKeys, rosters, coverageByScope, aliasedRosterNamesByScope, gapRosterNamesByScope, violations }) {
  for (const key of auditedScopeKeys) {
    const roster = rosters.get(key);
    const coverage = coverageByScope.get(key);
    const aliased = aliasedRosterNamesByScope.get(key) ?? new Set();
    const ledgered = gapRosterNamesByScope.get(key) ?? new Set();
    // roster 두 역이 한 키로 접합되면 한쪽만 커버돼도 결측이 보고되지 않으므로 충돌을 위반으로 올린다.
    const rosterByKey = new Map();
    for (const stationName of roster.stationNames) {
      const normalized = normalizeStationName(stationName);
      const previous = rosterByKey.get(normalized);
      if (previous && previous !== stationName) {
        violations.push({
          kind: "ROSTER_NAME_COLLISION",
          scopeKey: key,
          message: `${key}: MOLIT roster 정규화 표기가 충돌한다 (${previous} / ${stationName})`,
        });
      }
      rosterByKey.set(normalized, stationName);
    }
    // MOLIT roster 나열 순서를 유지한다(노선 순서). 정렬은 로케일 의존이라 쓰지 않는다.
    const missing = [...rosterByKey.keys()]
      .filter((stationName) => !coverage.positionsByName.has(stationName)
        && !aliased.has(stationName)
        && !ledgered.has(stationName));
    if (missing.length > 0) {
      violations.push({
        kind: "MISSING_STATION",
        scopeKey: key,
        message: `${key} (${roster.operatorName}): admitted snapshot [${coverage.sourceIds.join(", ")}]에 없는 역 ${missing.join(", ")}`,
      });
    }
  }
}

/**
 * route_map_positions admitted 소스가 claim하는 scope 전량의 containment를 판정한다.
 *
 * @returns {{ auditedScopeKeys: string[], violations: Array<{ kind: string, message: string }> }}
 */
export function auditRouteMapCoverageScopes({
  inventory,
  targets,
  rosters,
  exemptions,
  snapshotsByPath,
  topologiesByPath = new Map(),
  rawSourcesByPath = new Map(),
  candidateLineScopeAdmission = {},
}) {
  const violations = [];
  const activeScopeKeys = new Set((targets.activeLineScopes ?? []).map(scopeKey));
  const { coverageByScope, officialUrlsByScope, claims, candidateClaimants } = collectScopeCoverage({
    inventory,
    snapshotsByPath,
    violations,
  });
  const auditedScopeKeys = auditableScopeKeys({ claims, activeScopeKeys, rosters, violations });
  const auditedScopeKeySet = new Set(auditedScopeKeys);
  // 재기술 claim의 ③은 실제 감사 집합이 확정된 뒤에만 판정할 수 있다.
  validateCandidateLineScopeClaims({
    sources: candidateClaimants,
    admission: readCandidateLineScopeAdmission(candidateLineScopeAdmission),
    auditedScopeKeys: auditedScopeKeySet,
    violations,
  });
  const shared = {
    auditedScopeKeys: auditedScopeKeySet,
    coverageByScope,
    rosters,
    officialUrlsByScope,
    registeredTopologyPaths: collectRegisteredTopologyPaths(inventory),
    topologiesByPath,
    rawSourcesByPath,
    violations,
  };

  const aliasedRosterNamesByScope = validateAliases({
    ...shared,
    aliases: exemptions.approvedStationNameAliases ?? [],
  });
  const gapRosterNamesByScope = validateGaps({
    ...shared,
    gaps: exemptions.documentedCoverageGaps ?? [],
    aliasedRosterNamesByScope,
    snapshotsByPath,
  });

  reportMissingStations({
    auditedScopeKeys,
    rosters,
    coverageByScope,
    aliasedRosterNamesByScope,
    gapRosterNamesByScope,
    violations,
  });

  return { auditedScopeKeys, violations };
}
