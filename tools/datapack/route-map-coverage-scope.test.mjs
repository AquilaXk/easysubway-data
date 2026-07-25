import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseMolitLineOperatorRosters } from "./build-molit-nationwide-fixture.mjs";
import { ROUTE_MAP_DOMAIN, auditRouteMapCoverageScopes } from "./route-map-coverage-scope.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const MOLIT_ROSTER_PATH = "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv";
const EXEMPTIONS_PATH = "tools/datapack/route-map-coverage-scope-exemptions.json";
const SEOUL_SNAPSHOT_PATH = "tools/datapack/sources/seoul-metro-route-map-positions-20260724.json";
const GWANGJU_SNAPSHOT_PATH = "tools/datapack/sources/gwangju-transportation-route-map-positions-20260725.json";
const UI_SNAPSHOT_PATH = "tools/datapack/sources/kric-ui-sinseol-route-map-positions-20260725.json";
const DAEGU_SNAPSHOT_PATH = "tools/datapack/sources/daegu-transportation-route-map-positions-20260724.json";
const CAPITAL_TOPOLOGY_PATH = "tools/datapack/sources/capital-route-topology-20260724.json";
const CANDIDATE_SPEC_PATH = "tools/datapack/nationwide-candidate-pack-spec.json";
const CANDIDATE_EVIDENCE_PATH = "tools/datapack/reports/nationwide-candidate-coverage-gate.json";
// #2514(#2510 B0)가 line-scope로 재기술한 소스. admitted snapshot 파일이 없어 containment 근거가 되지 못한다.
const CANDIDATE_REDESCRIBED_SOURCE_ID = "seoulmetro-cyberstation-route-map";
const CANDIDATE_REDESCRIBED_SCOPE_KEY = "capital:seoul-metro:seoul-4";

// #2499·#2508에서 배선한 dual-operator containment는 전 scope 감사의 부분집합으로 유지한다.
const DUAL_OPERATOR_SCOPE_KEYS = Object.freeze([
  "capital:korail:line-051552e50435",
  "capital:operator-28e01fb8509d:shinbundang",
  "capital:operator-38450e138464:line-051552e50435",
  "capital:operator-5ca780d7dee1:line-8604048b6430",
  "capital:operator-936e454d0bfb:line-f0e747248a31",
  "capital:operator-9e999d4aa596:line-8604048b6430",
]);

// route_map_positions admitted 소스가 claim한 활성 (region, operator, line) scope 전량을
// source-inventory 등재 순서 그대로 고정한다. 감사 대상이 줄어드는 회귀를 잡기 위한 장치다.
const AUDITED_SCOPE_KEYS = Object.freeze([
  "busan:busan-transportation:line-ab1a041f6266",
  "busan:busan-transportation:line-d74614a04530",
  "busan:busan-transportation:line-d812a5bc1e5f",
  "busan:busan-transportation:line-eb7b47920390",
  "daegu:daegu-transportation:line-5b8d9b05e7e6",
  "daegu:daegu-transportation:line-e2938a4cc492",
  "daegu:daegu-transportation:line-0ffaa95b1b5d",
  "daejeon:daejeon-transportation:line-7051a9c2525c",
  "gwangju:gwangju-metropolitan-rapid-transit:line-e57a361e8892",
  "capital:incheon-transit:line-42b5805f3b5a",
  "capital:incheon-transit:line-98718184f016",
  "capital:incheon-transit:line-15b3b8a93259",
  "capital:operator-8134e61f8dbd:line-e9e9a5b520a4",
  "capital:operator-b2d80436b438:line-828f04afc588",
  "capital:operator-2e23276dfa94:line-5500c1600f71",
  "capital:operator-5ca780d7dee1:line-8604048b6430",
  "capital:operator-9e999d4aa596:line-8604048b6430",
  "capital:korail:line-54a7b980b7c3",
  "capital:korail:line-e4939a4b4713",
  "capital:korail:line-6e39be0cb6e2",
  "capital:korail:line-051552e50435",
  "capital:operator-38450e138464:line-051552e50435",
  "capital:operator-936e454d0bfb:line-f0e747248a31",
  "capital:operator-28e01fb8509d:shinbundang",
  "capital:operator-10d7cf275a80:line-aefa08ccc0a9",
  "capital:korail:line-558d0bd8312d",
  "capital:operator-3c623bf1a427:line-30886152e4f8",
  "capital:operator-29e323a78a93:line-62096860ab09",
  "capital:seoul-metro:line-472a81add377",
  "capital:seoul-metro:seoul-2",
  "capital:seoul-metro:line-41a8c75ec9d8",
  "capital:seoul-metro:seoul-4",
  "capital:seoul-metro:line-80fc4d5350d4",
  "capital:seoul-metro:line-3f41718e0833",
  "capital:seoul-metro:line-15b3b8a93259",
  "capital:seoul-metro:line-2b2d9eaa53d0",
]);

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function loadAuditInputs() {
  const [inventory, targets, exemptions, molitCsvBytes, candidateSpecBytes, candidateEvidence] = await Promise.all([
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/nationwide-coverage-targets.json"),
    readJson(EXEMPTIONS_PATH),
    readFile(path.join(root, MOLIT_ROSTER_PATH)),
    readFile(path.join(root, CANDIDATE_SPEC_PATH)),
    readJson(CANDIDATE_EVIDENCE_PATH),
  ]);
  const snapshotsByPath = new Map();
  for (const source of inventory.sources) {
    const snapshotPath = source.routeMapAdmissionEvidence?.snapshotPath;
    if (source.coverageScope?.sourceDomains?.includes(ROUTE_MAP_DOMAIN) && snapshotPath) {
      snapshotsByPath.set(snapshotPath, await readJson(snapshotPath));
    }
  }
  const topologiesByPath = new Map();
  const topologyPaths = [
    ...exemptions.documentedCoverageGaps,
    ...exemptions.approvedStationNameAliases,
  ].map((entry) => entry.evidence?.packTopologyPath).filter(Boolean);
  for (const topologyPath of [...new Set(topologyPaths), CAPITAL_TOPOLOGY_PATH]) {
    topologiesByPath.set(topologyPath, await readJson(topologyPath));
  }
  const rawSourcesByPath = new Map();
  const rawPaths = exemptions.approvedStationNameAliases
    .map((alias) => alias.evidence?.officialRawPath).filter(Boolean);
  for (const rawPath of new Set(rawPaths)) {
    rawSourcesByPath.set(rawPath, await readFile(path.join(root, rawPath)));
  }
  return {
    inventory,
    targets,
    exemptions,
    rosters: parseMolitLineOperatorRosters(molitCsvBytes),
    snapshotsByPath,
    topologiesByPath,
    rawSourcesByPath,
    candidateLineScopeAdmission: {
      specPath: CANDIDATE_SPEC_PATH,
      specBytes: candidateSpecBytes,
      evidence: candidateEvidence,
    },
  };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// topology를 고쳐도 무결성 검사를 통과시키려면 선언 해시를 같이 다시 계산해야 한다.
// 표기 방향 판정 자체를 시험할 때만 쓴다.
function rehashTopology(topology) {
  for (const line of topology.lines) {
    line.stationCount = line.scope.length;
    line.contentSha256 = sha256(JSON.stringify({ scope: line.scope, edges: line.edges }));
  }
  topology.contentSha256 = sha256(JSON.stringify({
    lines: topology.lines.map(({ lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId }) => ({
      lineId,
      edgeCount,
      stationCount,
      contentSha256,
      rawSha256,
      datasetId,
    })),
    topologyGaps: topology.topologyGaps,
  }));
  return topology;
}

// topology 바이트를 고치면 상위 contentSha256이 바뀌므로 그 파일을 가리키는 admission lineage 선언도
// 함께 맞춰야 다른 scope가 lineage 불일치로 먼저 막히지 않는다.
function rebindTopologyLineages(inventory, topologyPath, contentSha256) {
  const snapshotId = path.basename(topologyPath, ".json");
  for (const source of inventory.sources) {
    for (const lineage of source.routeMapAdmissionEvidence?.topologyLineages ?? []) {
      if (lineage.snapshotId === snapshotId) {
        lineage.contentSha256 = contentSha256;
      }
    }
  }
  return inventory;
}

// 무결성·lineage 결속을 전부 통과시킨 상태에서 표기 방향 조건만 시험하기 위한 장치다.
function withPatchedCapitalTopology(inputs, lineId, patchScope) {
  const topology = structuredClone(inputs.topologiesByPath.get(CAPITAL_TOPOLOGY_PATH));
  const line = topology.lines.find((entry) => entry.lineId === lineId);
  line.scope = patchScope(line.scope);
  rehashTopology(topology);
  return {
    ...inputs,
    inventory: rebindTopologyLineages(
      structuredClone(inputs.inventory),
      CAPITAL_TOPOLOGY_PATH,
      topology.contentSha256,
    ),
    topologiesByPath: new Map(inputs.topologiesByPath).set(CAPITAL_TOPOLOGY_PATH, topology),
  };
}

function scopeKeyOf({ regionId, operatorId, lineId }) {
  return `${regionId}:${operatorId}:${lineId}`;
}

// 위반은 별칭 → 결측 ledger → containment 순서로 쌓이므로 나열 순서가 결정론적이다.
function violationKinds(result) {
  return result.violations.map(({ kind }) => kind);
}

function aliasNamed(exemptions, snapshotStationName) {
  return exemptions.approvedStationNameAliases
    .find((alias) => alias.snapshotStationName === snapshotStationName);
}

function gapNamed(exemptions, rosterStationName) {
  return exemptions.documentedCoverageGaps
    .find((gap) => gap.rosterStationName === rosterStationName);
}

test("route_map_positions 전 scope containment는 승인 별칭·문서화 결측 반영 후 fail-closed다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const result = auditRouteMapCoverageScopes(inputs);

  assert.deepEqual(
    result.violations.map(({ message }) => message),
    [],
    "containment 위반이 남아 있다",
  );
  assert.deepEqual(result.auditedScopeKeys, [...AUDITED_SCOPE_KEYS]);
  for (const scopeKey of DUAL_OPERATOR_SCOPE_KEYS) {
    assert.ok(
      result.auditedScopeKeys.includes(scopeKey),
      `#2508 dual-operator scope가 감사에서 빠졌다: ${scopeKey}`,
    );
  }
});

test("면제 fixture는 사유별로 요구되는 근거 필드를 모두 싣는다 (#2516)", async () => {
  const { exemptions } = await loadAuditInputs();

  assert.equal(exemptions.artifactKind, "route-map-coverage-scope-exemptions");
  assert.equal(typeof exemptions.renamedAtBasis, "string");
  for (const alias of exemptions.approvedStationNameAliases) {
    const label = `${alias.scopeKey} ${alias.snapshotStationName}`;
    assert.equal(typeof alias.evidence?.officialUrl, "string", `${label}: officialUrl이 없다`);
    assert.ok(alias.evidence.officialUrl.startsWith("https://"), `${label}: officialUrl이 https가 아니다`);
    assert.equal(typeof alias.evidence.note, "string", `${label}: 근거 서술이 없다`);
    assert.ok(alias.evidence.note.length > 0, `${label}: 근거 서술이 비어 있다`);
    if (alias.reasonCode === "OFFICIAL_RENAME") {
      assert.match(alias.evidence.renamedAt ?? "", /^\d{4}-\d{2}-\d{2}$/u, `${label}: 시행일이 없다`);
      assert.equal(typeof alias.evidence.crossCheck, "string", `${label}: 교차 근거 방식이 없다`);
    }
  }
  for (const gap of exemptions.documentedCoverageGaps) {
    const label = `${gap.scopeKey} ${gap.rosterStationName}`;
    assert.equal(typeof gap.evidence?.snapshotPath, "string", `${label}: snapshotPath가 없다`);
    assert.ok(gap.evidence.snapshotPath.startsWith("tools/datapack/sources/"), `${label}: snapshotPath 경로가 다르다`);
    assert.equal(typeof gap.evidence.officialUrl, "string", `${label}: officialUrl이 없다`);
    assert.equal(typeof gap.evidence.note, "string", `${label}: 근거 서술이 없다`);
    assert.ok(gap.evidence.note.length > 0, `${label}: 근거 서술이 비어 있다`);
  }
});

test("admitted snapshot에서 커버 역이 사라지면 containment가 실패한다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const snapshot = structuredClone(inputs.snapshotsByPath.get(GWANGJU_SNAPSHOT_PATH));
  snapshot.positions = snapshot.positions.filter(({ stationName }) => stationName !== "광주송정");
  const snapshotsByPath = new Map(inputs.snapshotsByPath).set(GWANGJU_SNAPSHOT_PATH, snapshot);

  const result = auditRouteMapCoverageScopes({ ...inputs, snapshotsByPath });

  assert.deepEqual(violationKinds(result), ["MISSING_STATION"]);
  assert.match(result.violations[0].message, /광주송정/u);
});

test("결측을 가리는 별칭은 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  // 8호선 암사역사공원 결측을 이웃 역 암사 표기로 덮으려는 시도.
  exemptions.documentedCoverageGaps = exemptions.documentedCoverageGaps
    .filter(({ rosterStationName }) => rosterStationName !== "암사역사공원");
  exemptions.approvedStationNameAliases.push({
    scopeKey: "capital:seoul-metro:line-2b2d9eaa53d0",
    snapshotStationName: "암사",
    rosterStationName: "암사역사공원",
    reasonCode: "OFFICIAL_RENAME",
    evidence: {
      issue: 2516,
      renamedAt: "2024-08-10",
      crossCheck: "ROSTER_SUBNAME",
      officialUrl: "https://www.data.go.kr/data/15099316/fileData.do",
      note: "근거 없는 별칭",
    },
  });

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["ALIAS_SHADOWS_ROSTER_STATION", "MISSING_STATION"]);
});

test("snapshot에 없는 역을 가리키는 별칭은 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  exemptions.documentedCoverageGaps = exemptions.documentedCoverageGaps
    .filter(({ rosterStationName }) => rosterStationName !== "신설동");
  exemptions.approvedStationNameAliases.push({
    scopeKey: "capital:operator-3c623bf1a427:line-30886152e4f8",
    snapshotStationName: "신설동종점",
    rosterStationName: "신설동",
    reasonCode: "OFFICIAL_RENAME",
    evidence: {
      issue: 2516,
      renamedAt: "2017-09-02",
      crossCheck: "ROSTER_SUBNAME",
      officialUrl: "https://www.data.go.kr/data/15041324/fileData.do",
      note: "근거 없는 별칭",
    },
  });

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["ALIAS_SNAPSHOT_STATION_ABSENT", "MISSING_STATION"]);
});

test("근거 서술이 빠진 별칭은 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  delete exemptions.approvedStationNameAliases[0].evidence.note;

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["ALIAS_EVIDENCE_NOTE_MISSING", "MISSING_STATION"]);
});

test("등재되지 않은 URL을 근거로 단 별칭은 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  exemptions.approvedStationNameAliases[0].evidence.officialUrl = "https://example.com/";

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["ALIAS_EVIDENCE_URL_UNREGISTERED", "MISSING_STATION"]);
});

test("다른 scope에 등재된 공식 URL은 근거가 되지 못한다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  // 서울 역사 좌표 데이터셋은 inventory에 등재돼 있지만 대구 1호선 scope를 커버하는 출처가 아니다.
  aliasNamed(exemptions, "명덕1").evidence.officialUrl = "https://www.data.go.kr/data/15099316/fileData.do";

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["ALIAS_EVIDENCE_URL_UNREGISTERED", "MISSING_STATION"]);
});

test("승인 목록 밖 사유 코드는 별칭·ledger 모두에서 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  aliasNamed(exemptions, "성서산단").reasonCode = "OFFICIAL_WHATEVER";
  gapNamed(exemptions, "하양").reasonCode = "OFFICIAL_WHATEVER";

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), [
    "ALIAS_REASON_CODE_INVALID",
    "LEDGER_REASON_CODE_INVALID",
    "MISSING_STATION",
    "MISSING_STATION",
  ]);
});

test("호선 접미사 표기 별칭은 표기 규칙이 어긋나면 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  aliasNamed(exemptions, "성서산단").reasonCode = "OFFICIAL_LINE_ORDINAL_SUFFIX";

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["ALIAS_LINE_ORDINAL_MISMATCH", "MISSING_STATION"]);
});

test("공식 개명 별칭은 노선 나열 위치가 다르면 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const snapshot = structuredClone(inputs.snapshotsByPath.get(SEOUL_SNAPSHOT_PATH));
  // 상계를 지우면 당고개의 이웃이 노원으로 바뀌어 불암산과 같은 위치라는 근거가 깨진다.
  snapshot.positions = snapshot.positions
    .filter((position) => !(position.lineId === "seoul-4" && position.stationName === "상계"));
  const snapshotsByPath = new Map(inputs.snapshotsByPath).set(SEOUL_SNAPSHOT_PATH, snapshot);

  const result = auditRouteMapCoverageScopes({ ...inputs, snapshotsByPath });

  assert.deepEqual(violationKinds(result), ["ALIAS_RENAME_SEQUENCE_MISMATCH", "MISSING_STATION"]);
});

test("허위 근거를 단 공식 개명 별칭은 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  // 축약 표기를 개명으로 세탁하려는 시도. 이웃 역은 같지만 교차 근거가 성립하지 않는다.
  const alias = aliasNamed(exemptions, "성서산단");
  alias.reasonCode = "OFFICIAL_RENAME";
  alias.evidence.renamedAt = "2024-01-01";
  alias.evidence.crossCheck = "ROSTER_SUBNAME";

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["ALIAS_RENAME_SUBNAME_ABSENT", "MISSING_STATION"]);
});

test("교차 근거 방식을 선언하지 않은 개명 별칭은 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  delete aliasNamed(exemptions, "당고개").evidence.crossCheck;

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["ALIAS_RENAME_CROSS_CHECK_INVALID", "MISSING_STATION"]);
});

test("snapshot 수집 시점보다 늦은 개명일은 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  aliasNamed(exemptions, "당고개").evidence.renamedAt = "2027-01-01";

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["ALIAS_RENAME_DATE_OUT_OF_RANGE", "MISSING_STATION"]);
});

test("pack topology가 snapshot 구표기도 실으면 개명 별칭이 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const topology = structuredClone(inputs.topologiesByPath.get(CAPITAL_TOPOLOGY_PATH));
  const line = topology.lines.find(({ lineId }) => lineId === "line-15b3b8a93259");
  line.scope = [...line.scope, { ...line.scope[0], stationName: "뚝섬유원지" }];
  const topologiesByPath = new Map(inputs.topologiesByPath).set(CAPITAL_TOPOLOGY_PATH, rehashTopology(topology));

  const result = auditRouteMapCoverageScopes({ ...inputs, topologiesByPath });

  // 해시를 다시 맞추면 lineage 선언과 어긋나므로 다른 scope 위반도 함께 난다.
  assert.ok(violationKinds(result).includes("ALIAS_RENAME_SNAPSHOT_NAME_PRESENT"));
  assert.ok(violationKinds(result).includes("MISSING_STATION"));
});

test("pack topology에서 역을 지워 pack 결측을 세탁할 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const topology = structuredClone(inputs.topologiesByPath.get(CAPITAL_TOPOLOGY_PATH));
  const line = topology.lines.find(({ lineId }) => lineId === "line-2b2d9eaa53d0");
  line.scope = line.scope.filter(({ stationName }) => stationName !== "암사역사공원");
  const topologiesByPath = new Map(inputs.topologiesByPath).set(CAPITAL_TOPOLOGY_PATH, topology);

  const result = auditRouteMapCoverageScopes({ ...inputs, topologiesByPath });

  assert.deepEqual(violationKinds(result), ["LEDGER_PACK_TOPOLOGY_CONTENT_MISMATCH", "MISSING_STATION"]);
});

test("topology 해시를 맞춰도 admission lineage 선언과 다르면 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const topology = structuredClone(inputs.topologiesByPath.get(CAPITAL_TOPOLOGY_PATH));
  const line = topology.lines.find(({ lineId }) => lineId === "line-828f04afc588");
  line.scope = line.scope.filter(({ stationName }) => stationName !== "용인중앙시장");
  const topologiesByPath = new Map(inputs.topologiesByPath).set(CAPITAL_TOPOLOGY_PATH, rehashTopology(topology));

  const result = auditRouteMapCoverageScopes({ ...inputs, topologiesByPath });

  assert.ok(violationKinds(result).includes("ALIAS_PACK_TOPOLOGY_LINEAGE_MISMATCH"));
});

// 아래 세 회귀는 lineage가 등재된 에버라인·7호선 scope를 써서 개명 방향 조건 자체를 실행시킨다.
// lineage 미등재 scope로는 앞단에서 막혀 방향 판정에 도달하지 못한다.
test("pack topology가 snapshot 신표기를 싣지 않으면 채택 근거 개명 별칭이 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const patched = withPatchedCapitalTopology(inputs, "line-828f04afc588", (scope) => scope
    .filter(({ stationName }) => stationName !== "용인중앙시장"));

  const result = auditRouteMapCoverageScopes(patched);

  assert.deepEqual(violationKinds(result), ["ALIAS_RENAME_ADOPTED_NAME_ABSENT", "MISSING_STATION"]);
});

test("pack topology가 roster 구표기도 실으면 채택 근거 개명 별칭이 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const patched = withPatchedCapitalTopology(inputs, "line-828f04afc588", (scope) => [
    ...scope,
    { ...scope[0], stationName: "운동장.송담대" },
  ]);

  const result = auditRouteMapCoverageScopes(patched);

  assert.deepEqual(violationKinds(result), ["ALIAS_RENAME_ROSTER_NAME_PRESENT", "MISSING_STATION"]);
});

test("pack topology가 roster 신표기를 싣지 않으면 원문 구표기 개명 별칭이 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const patched = withPatchedCapitalTopology(inputs, "line-15b3b8a93259", (scope) => scope
    .filter(({ stationName }) => stationName !== "자양"));

  const result = auditRouteMapCoverageScopes(patched);

  assert.deepEqual(violationKinds(result), ["ALIAS_RENAME_ROSTER_NAME_ABSENT", "MISSING_STATION"]);
});

test("snapshot 표기 오염은 모든 교차 근거 경로에서 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const snapshot = structuredClone(inputs.snapshotsByPath.get(SEOUL_SNAPSHOT_PATH));
  // 4호선 쌍문을 오수집 표기로 오염시킨 뒤 개명으로 세탁하려는 시도.
  for (const position of snapshot.positions) {
    if (position.lineId === "seoul-4" && position.stationName === "쌍문") {
      position.stationName = "쌍문사거리";
    }
  }
  const snapshotsByPath = new Map(inputs.snapshotsByPath).set(SEOUL_SNAPSHOT_PATH, snapshot);
  const laundering = {
    scopeKey: "capital:seoul-metro:seoul-4",
    snapshotStationName: "쌍문사거리",
    rosterStationName: "쌍문",
    reasonCode: "OFFICIAL_RENAME",
    evidence: {
      issue: 2516,
      renamedAt: "2024-01-01",
      officialUrl: "https://www.data.go.kr/data/15099316/fileData.do",
      packTopologyPath: CAPITAL_TOPOLOGY_PATH,
      officialRawPath: "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv",
      note: "오염 세탁 시도",
    },
  };
  const rejected = {
    ROSTER_SUBNAME: "ALIAS_RENAME_SUBNAME_ABSENT",
    // seoul-metro 노선은 topology lineage 미등재라 부재 근거 경로가 lineage 단계에서 먼저 막힌다.
    PACK_TOPOLOGY_ADOPTED_NAME: "ALIAS_PACK_TOPOLOGY_LINEAGE_UNDECLARED",
    OFFICIAL_FILE_STALE_NAME: "ALIAS_RENAME_RAW_NAME_ABSENT",
  };

  for (const [crossCheck, expected] of Object.entries(rejected)) {
    const exemptions = structuredClone(inputs.exemptions);
    exemptions.approvedStationNameAliases.push({
      ...laundering,
      evidence: { ...laundering.evidence, crossCheck },
    });
    const result = auditRouteMapCoverageScopes({ ...inputs, exemptions, snapshotsByPath });
    assert.deepEqual(violationKinds(result), [expected, "MISSING_STATION"], `crossCheck=${crossCheck}`);
  }
});

test("공식 원문에 실재하는 표기로 오염시켜도 구표기 근거로 세탁되지 않는다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  // 원문 부분문자열 일치만 요구하면 같은 CSV의 다른 노선 행 역명(종로3가)이나 한 글자(쌍)로
  // 4호선 쌍문을 제자리에서 오염시켜도 근거가 성립한다. 밀려난 roster 표기가 원문에 남아 있어야 한다.
  for (const polluted of ["종로3가", "쌍"]) {
    const snapshot = structuredClone(inputs.snapshotsByPath.get(SEOUL_SNAPSHOT_PATH));
    for (const position of snapshot.positions) {
      if (position.lineId === "seoul-4" && position.stationName === "쌍문") {
        position.stationName = polluted;
      }
    }
    const snapshotsByPath = new Map(inputs.snapshotsByPath).set(SEOUL_SNAPSHOT_PATH, snapshot);
    const exemptions = structuredClone(inputs.exemptions);
    exemptions.approvedStationNameAliases.push({
      scopeKey: "capital:seoul-metro:seoul-4",
      snapshotStationName: polluted,
      rosterStationName: "쌍문",
      reasonCode: "OFFICIAL_RENAME",
      evidence: {
        issue: 2516,
        renamedAt: "2024-01-01",
        crossCheck: "OFFICIAL_FILE_STALE_NAME",
        officialUrl: "https://www.data.go.kr/data/15099316/fileData.do",
        packTopologyPath: CAPITAL_TOPOLOGY_PATH,
        officialRawPath: "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv",
        note: "오염 세탁 시도",
      },
    });

    const result = auditRouteMapCoverageScopes({ ...inputs, exemptions, snapshotsByPath });

    assert.deepEqual(
      violationKinds(result),
      ["ALIAS_RENAME_RAW_ROSTER_NAME_PRESENT", "MISSING_STATION"],
      `오염 표기=${polluted}`,
    );
  }
});

test("공식 원문에 결속되지 않은 원본 경로는 개명 근거가 되지 못한다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  delete aliasNamed(exemptions, "뚝섬유원지").evidence.officialRawPath;

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["ALIAS_RENAME_RAW_SOURCE_UNBOUND", "MISSING_STATION"]);
});

test("quarantine 기록이 없는 결측 ledger 항목은 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  const gap = gapNamed(exemptions, "암사역사공원");
  gap.reasonCode = "ADMISSION_QUARANTINED";
  gap.evidence.quarantineReasonCode = "OFFICIAL_DUPLICATE_LATLON";

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["LEDGER_QUARANTINE_RECORD_ABSENT", "MISSING_STATION"]);
});

test("quarantine 사유 항목도 공식 출처 URL을 요구한다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  delete gapNamed(exemptions, "마곡").evidence.officialUrl;

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["LEDGER_EVIDENCE_URL_UNREGISTERED", "MISSING_STATION"]);
});

test("pack topology가 싣고 있는 역은 pack 결측으로 면제할 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  gapNamed(exemptions, "하양").reasonCode = "PACK_SCOPE_ABSENT";

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["LEDGER_PACK_TOPOLOGY_STATION_PRESENT", "MISSING_STATION"]);
});

test("lineage 미등재 topology는 pack 결측 근거로 쓸 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  // 서울교통공사 노선은 topology lineage 미등재라 재해시 삭제로 세탁할 수 없다.
  gapNamed(exemptions, "암사역사공원").reasonCode = "PACK_SCOPE_ABSENT";
  const topology = structuredClone(inputs.topologiesByPath.get(CAPITAL_TOPOLOGY_PATH));
  const line = topology.lines.find(({ lineId }) => lineId === "line-2b2d9eaa53d0");
  line.scope = line.scope.filter(({ stationName }) => stationName !== "암사역사공원");
  const topologiesByPath = new Map(inputs.topologiesByPath).set(CAPITAL_TOPOLOGY_PATH, rehashTopology(topology));

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions, topologiesByPath });

  assert.ok(violationKinds(result).includes("LEDGER_PACK_TOPOLOGY_LINEAGE_UNDECLARED"));
  assert.ok(violationKinds(result).includes("MISSING_STATION"));
});

test("pack topology에 없는 역은 공식 원문 결측으로 면제할 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  gapNamed(exemptions, "신설동").reasonCode = "OFFICIAL_FILE_ROW_ABSENT";

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["LEDGER_PACK_TOPOLOGY_STATION_ABSENT", "MISSING_STATION"]);
});

test("collector가 선언하지 않은 결측은 공식 원문 결측으로 면제할 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const snapshot = structuredClone(inputs.snapshotsByPath.get(DAEGU_SNAPSHOT_PATH));
  snapshot.topologyGaps = snapshot.topologyGaps.filter(({ stationName }) => stationName !== "하양");
  const snapshotsByPath = new Map(inputs.snapshotsByPath).set(DAEGU_SNAPSHOT_PATH, snapshot);

  const result = auditRouteMapCoverageScopes({ ...inputs, snapshotsByPath });

  assert.deepEqual(violationKinds(result), ["LEDGER_TOPOLOGY_GAP_NOT_DECLARED", "MISSING_STATION"]);
});

test("scope에 등재되지 않은 topology 파일을 가리키면 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  gapNamed(exemptions, "하양").evidence.packTopologyPath = CAPITAL_TOPOLOGY_PATH;

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["LEDGER_PACK_TOPOLOGY_UNBOUND", "MISSING_STATION"]);
});

test("이미 커버된 역을 임의로 면제하는 ledger 항목은 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  exemptions.documentedCoverageGaps.push({
    scopeKey: "gwangju:gwangju-metropolitan-rapid-transit:line-e57a361e8892",
    rosterStationName: "광주송정역",
    reasonCode: "OFFICIAL_FILE_ROW_ABSENT",
    evidence: {
      issue: 2516,
      snapshotPath: GWANGJU_SNAPSHOT_PATH,
      packTopologyPath: CAPITAL_TOPOLOGY_PATH,
      officialUrl: "https://www.data.go.kr/data/15109340/fileData.do",
      note: "근거 없는 면제",
    },
  });

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["LEDGER_NOT_NEEDED"]);
});

test("admission으로 해소된 결측은 ledger에 남길 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const snapshot = structuredClone(inputs.snapshotsByPath.get(UI_SNAPSHOT_PATH));
  snapshot.positions = [...snapshot.positions, { ...snapshot.positions[0], stationName: "신설동" }];
  const snapshotsByPath = new Map(inputs.snapshotsByPath).set(UI_SNAPSHOT_PATH, snapshot);

  const result = auditRouteMapCoverageScopes({ ...inputs, snapshotsByPath });

  assert.deepEqual(violationKinds(result), ["LEDGER_NOT_NEEDED"]);
});

test("정규화 표기가 겹치는 snapshot 역은 위반으로 올린다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const snapshot = structuredClone(inputs.snapshotsByPath.get(SEOUL_SNAPSHOT_PATH));
  // 서로 다른 두 역이 한 칸으로 접합되면 결측이 조용히 가려진다.
  for (const position of snapshot.positions) {
    if (position.lineId === "seoul-4" && position.stationName === "쌍문") {
      position.stationName = "노원(당고개방면)";
    }
  }
  const snapshotsByPath = new Map(inputs.snapshotsByPath).set(SEOUL_SNAPSHOT_PATH, snapshot);

  const result = auditRouteMapCoverageScopes({ ...inputs, snapshotsByPath });

  assert.deepEqual(violationKinds(result), ["SNAPSHOT_NAME_COLLISION", "MISSING_STATION"]);
});

test("정규화 표기가 겹치는 roster 역은 위반으로 올린다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const rosters = new Map(inputs.rosters);
  const key = "gwangju:gwangju-metropolitan-rapid-transit:line-e57a361e8892";
  const roster = structuredClone(rosters.get(key));
  roster.stationNames = roster.stationNames.map((name) => (name === "돌고개" ? "농성역" : name));
  rosters.set(key, roster);

  const result = auditRouteMapCoverageScopes({ ...inputs, rosters });

  // 충돌 감지가 없으면 두 역이 한 칸으로 접합돼 결측이 조용히 사라진다.
  assert.deepEqual(violationKinds(result), ["ROSTER_NAME_COLLISION"]);
});

test("같은 scope에서 별칭을 중복 등재할 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  exemptions.approvedStationNameAliases.push(structuredClone(aliasNamed(exemptions, "명덕1")));

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["ALIAS_DUPLICATE"]);
});

test("roster 원문과 다른 표기를 가리키는 별칭·ledger는 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  aliasNamed(exemptions, "명덕1").rosterStationName = "명덕";
  gapNamed(exemptions, "하양").rosterStationName = "하양역";

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), [
    "ALIAS_ROSTER_STATION_ABSENT",
    "LEDGER_ROSTER_STATION_ABSENT",
    "MISSING_STATION",
  ]);
});

test("같은 scope에서 결측 ledger를 중복 등재할 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  exemptions.documentedCoverageGaps.push(structuredClone(gapNamed(exemptions, "하양")));

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["LEDGER_DUPLICATE"]);
});

test("원본 행 회계가 맞지 않으면 공식 원문 결측으로 면제할 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const snapshot = structuredClone(inputs.snapshotsByPath.get(SEOUL_SNAPSHOT_PATH));
  snapshot.rawStationCount += 1;
  const snapshotsByPath = new Map(inputs.snapshotsByPath).set(SEOUL_SNAPSHOT_PATH, snapshot);

  const result = auditRouteMapCoverageScopes({ ...inputs, snapshotsByPath });

  assert.deepEqual(violationKinds(result), ["LEDGER_RAW_ROW_ACCOUNTING_MISMATCH", "MISSING_STATION"]);
});

test("quarantine 기록이 있는 역은 공식 원문 결측으로 분류할 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const exemptions = structuredClone(inputs.exemptions);
  const gap = gapNamed(exemptions, "마곡");
  gap.reasonCode = "OFFICIAL_FILE_ROW_ABSENT";
  gap.evidence.packTopologyPath = CAPITAL_TOPOLOGY_PATH;

  const result = auditRouteMapCoverageScopes({ ...inputs, exemptions });

  assert.deepEqual(violationKinds(result), ["LEDGER_STATION_QUARANTINED", "MISSING_STATION"]);
});

test("MOLIT roster가 없는 scope는 감사에서 제외되고 위반으로 남는다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const rosters = new Map(inputs.rosters);
  rosters.delete("gwangju:gwangju-metropolitan-rapid-transit:line-e57a361e8892");

  const result = auditRouteMapCoverageScopes({ ...inputs, rosters });

  assert.deepEqual(violationKinds(result), ["ROSTER_MISSING"]);
  assert.equal(
    result.auditedScopeKeys.includes("gwangju:gwangju-metropolitan-rapid-transit:line-e57a361e8892"),
    false,
  );
});

test("lineIds를 claim한 route_map_positions 소스는 admitted snapshot 경로가 있어야 한다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const inventory = structuredClone(inputs.inventory);
  const source = inventory.sources.find(({ id }) => id === "daejeon-transportation-route-map-positions");
  delete source.routeMapAdmissionEvidence.snapshotPath;

  const result = auditRouteMapCoverageScopes({ ...inputs, inventory });

  assert.deepEqual(violationKinds(result), ["SOURCE_SNAPSHOT_PATH_MISSING"]);
  assert.equal(result.auditedScopeKeys.includes("daejeon:daejeon-transportation:line-7051a9c2525c"), false);
});

// #2514(#2510 B0)의 candidate 게이트 line-scope 재기술은 admitted snapshot 파일 없이 lineIds를 claim한다.
// 이 claim은 containment 근거가 아니므로 감사 대상 scope를 만들지 못하고, 근거 결속이 하나라도
// 깨지면 위반으로 남아야 한다.
test("admitted snapshot 없는 재기술 claim은 근거가 전부 결속되면 위반이 아니다 (#2516)", async () => {
  const inputs = await loadAuditInputs();

  const result = auditRouteMapCoverageScopes(inputs);

  // 이 소스에는 저장소에 admitted snapshot 파일이 없다. 창작한 snapshotPath로 통과시킨 것이 아님을 고정한다.
  assert.equal(
    inputs.inventory.sources
      .find(({ id }) => id === CANDIDATE_REDESCRIBED_SOURCE_ID).routeMapAdmissionEvidence,
    undefined,
  );
  assert.deepEqual(violationKinds(result), []);
  // 이 scope의 containment는 admitted snapshot을 가진 seoul-metro-route-map-positions가 계속 실측한다.
  assert.ok(result.auditedScopeKeys.includes(CANDIDATE_REDESCRIBED_SCOPE_KEY));
});

test("candidate 재기술 근거가 없으면 snapshot 없는 lineIds claim은 위반이다 (#2516)", async () => {
  const inputs = await loadAuditInputs();

  const result = auditRouteMapCoverageScopes({ ...inputs, candidateLineScopeAdmission: {} });

  assert.deepEqual(violationKinds(result), ["SOURCE_SNAPSHOT_PATH_MISSING"]);
});

test("candidate spec 재기술 lineIds가 claim과 다르면 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const inventory = structuredClone(inputs.inventory);
  const source = inventory.sources.find(({ id }) => id === CANDIDATE_REDESCRIBED_SOURCE_ID);
  source.coverageScope.lineIds = [...source.coverageScope.lineIds, "seoul-2"];

  const result = auditRouteMapCoverageScopes({ ...inputs, inventory });

  assert.deepEqual(violationKinds(result), ["SOURCE_CANDIDATE_LINE_SCOPE_MISMATCH"]);
});

test("게이트 evidence에 결속되지 않은 candidate spec은 근거가 되지 못한다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  // JSON 의미는 그대로 두고 바이트만 바꾼다 — evidence가 기록한 spec 해시와 어긋난다.
  const specBytes = Buffer.concat([inputs.candidateLineScopeAdmission.specBytes, Buffer.from("\n")]);
  const candidateLineScopeAdmission = { ...inputs.candidateLineScopeAdmission, specBytes };

  const result = auditRouteMapCoverageScopes({ ...inputs, candidateLineScopeAdmission });

  assert.deepEqual(violationKinds(result), ["SOURCE_CANDIDATE_EVIDENCE_SPEC_UNBOUND"]);
});

test("게이트가 SUPPORTED로 실증하지 않은 재기술 scope는 거부된다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const evidence = structuredClone(inputs.candidateLineScopeAdmission.evidence);
  evidence.variants.lineScoped.supportedRequirementKeys = evidence.variants.lineScoped.supportedRequirementKeys
    .filter((key) => key !== `${CANDIDATE_REDESCRIBED_SCOPE_KEY}:${ROUTE_MAP_DOMAIN}`);
  const candidateLineScopeAdmission = { ...inputs.candidateLineScopeAdmission, evidence };

  const result = auditRouteMapCoverageScopes({ ...inputs, candidateLineScopeAdmission });

  assert.deepEqual(violationKinds(result), ["SOURCE_CANDIDATE_SCOPE_NOT_SUPPORTED"]);
});

test("재기술만으로는 containment 감사가 사라진 scope를 통과시킬 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const inventory = structuredClone(inputs.inventory);
  // 이 scope를 실측하던 admitted snapshot 소스의 claim을 지우면 containment를 판정할 근거가 없어진다.
  const source = inventory.sources.find(({ id }) => id === "seoul-metro-route-map-positions");
  source.coverageScope.lineIds = source.coverageScope.lineIds.filter((lineId) => lineId !== "seoul-4");

  const result = auditRouteMapCoverageScopes({ ...inputs, inventory });

  assert.ok(violationKinds(result).includes("SOURCE_CANDIDATE_SCOPE_UNAUDITED"));
  assert.equal(result.auditedScopeKeys.includes(CANDIDATE_REDESCRIBED_SCOPE_KEY), false);
});

test("activeLineScopes에서 빠진 scope는 재기술 claim으로 통과시킬 수 없다 (#2516)", async () => {
  const inputs = await loadAuditInputs();
  const targets = structuredClone(inputs.targets);
  // snapshot이 그대로 커버해도 #2138 requirement에서 빠지면 containment 감사 자체가 사라진다.
  targets.activeLineScopes = targets.activeLineScopes
    .filter((scope) => scopeKeyOf(scope) !== CANDIDATE_REDESCRIBED_SCOPE_KEY);

  const result = auditRouteMapCoverageScopes({ ...inputs, targets });

  assert.deepEqual(violationKinds(result), ["SOURCE_CANDIDATE_SCOPE_UNAUDITED", "ALIAS_SCOPE_NOT_AUDITED"]);
  assert.equal(result.auditedScopeKeys.includes(CANDIDATE_REDESCRIBED_SCOPE_KEY), false);
});
