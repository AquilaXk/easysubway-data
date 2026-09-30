import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// #854 결함 2: 전국 정본 팩(pack id "nationwide")에서 audit-route-map이
// 자양(뚝섬한강공원)·불암산(당고개) 두 역의 routeMapPositions sourceLabel을
// ROUTE_MAP_SOURCE_LABEL_MISMATCH(HIGH)로 막았다. 두 역은 공식 역사 좌표 파일이
// 개명 전 역명을 유지하는 공식 개명(OFFICIAL_RENAME)이고, 같은 행이 capital 팩에서는
// 승인 별칭으로 통과한다. 이 테스트는 공식 원천 대조와 감사 결과를 함께 고정한다.

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const canonicalPackPath = "tools/datapack/release/nationwide-production-canonical-pack.json";
const exemptionsPath = "tools/datapack/route-map-coverage-scope-exemptions.json";
const officialCoordinatePath = "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv";
const molitRosterPath = "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv";

// 공식 원천 대조 기준. 값은 아래 테스트가 원천 파일에서 다시 읽어 확인한다.
const renamedStations = [
  {
    stationId: "station-f306bbca9985",
    lineId: "line-15b3b8a93259",
    coordinateLine: "7",
    coordinateStationCode: "2730",
    coordinateStationName: "뚝섬유원지",
    rosterLine: "7호선",
    rosterSequence: "20",
    rosterStationName: "자양(뚝섬한강공원)",
  },
  {
    stationId: "station-871f17171f3c",
    lineId: "seoul-4",
    coordinateLine: "4",
    coordinateStationCode: "409",
    coordinateStationName: "당고개",
    rosterLine: "4호선",
    rosterSequence: "4",
    rosterStationName: "불암산(당고개)",
  },
];

async function readEucKrCsv(relativePath) {
  const text = new TextDecoder("euc-kr").decode(await readFile(path.join(root, relativePath)));
  const [header, ...rows] = text.split(/\r?\n/).filter(Boolean).map((line) => line.split(","));
  return rows.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index]])));
}

function activePackOf(fixture) {
  const activeId = fixture.manifest?.activePack?.id;
  const matches = (fixture.packs ?? []).filter(({ id }) => id === activeId);
  assert.equal(matches.length, 1, `activePack ${activeId}은 정확히 한 팩과 맞아야 한다`);
  return matches[0];
}

function stationDisplayName(station) {
  return station.nameSub ? `${station.nameKo}(${station.nameSub})` : station.nameKo;
}

async function runAudit(fixturePath) {
  const args = [
    "tools/route-map/audit-route-map.mjs",
    "--fixture",
    fixturePath,
    "--reviewed-ambiguities",
    "tools/route-map/fixtures/reviewed-ambiguities.json",
    "--route-map-coverage-scope-exemptions",
    exemptionsPath,
    "--fail-on",
    "BLOCKER,HIGH",
  ];
  const result = await execFileAsync(process.execPath, args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .then(({ stdout }) => ({ stdout, code: 0 }))
    .catch((error) => ({ stdout: error.stdout ?? "", code: error.code ?? 1 }));
  assert.ok(result.stdout.trim().length > 0, `audit 출력이 비어 있음: code=${result.code}`);
  return { ...JSON.parse(result.stdout), exitCode: result.code };
}

test("두 역의 팩 라벨은 공식 좌표 파일·MOLIT 역 목록·승인 개명 기록과 일치한다", async () => {
  const fixture = JSON.parse(await readFile(path.join(root, canonicalPackPath), "utf8"));
  const pack = activePackOf(fixture);
  const exemptions = JSON.parse(await readFile(path.join(root, exemptionsPath), "utf8"));
  const coordinateRows = await readEucKrCsv(officialCoordinatePath);
  const rosterRows = await readEucKrCsv(molitRosterPath);

  for (const expected of renamedStations) {
    const label = `${expected.stationId}/${expected.lineId}`;
    const station = pack.stations.find(({ id }) => id === expected.stationId);
    const positions = pack.routeMapPositions.filter(
      (row) => row.stationId === expected.stationId && row.lineId === expected.lineId,
    );
    assert.ok(station, `${label} 역이 팩에 있어야 한다`);
    assert.equal(positions.length, 1, `${label} routeMapPositions는 한 행이어야 한다`);
    const [position] = positions;

    // 공식 역사 좌표 파일(data.go.kr 15099316): 같은 외부역코드 행의 역명이 sourceLabel이고,
    // 그 행의 위경도가 팩 역 좌표와 같다(같은 역이다).
    const coordinateMatches = coordinateRows.filter(
      (row) => row["호선"] === expected.coordinateLine
        && row["고유역번호(외부역코드)"] === expected.coordinateStationCode,
    );
    assert.equal(coordinateMatches.length, 1, `${label} 공식 좌표 행은 하나여야 한다`);
    const [coordinateRow] = coordinateMatches;
    assert.equal(coordinateRow["역명"], expected.coordinateStationName);
    assert.equal(position.sourceLabel, coordinateRow["역명"]);
    assert.equal(Number(coordinateRow["위도"]), station.latitude);
    assert.equal(Number(coordinateRow["경도"]), station.longitude);

    // MOLIT 도시철도 전체노선 역 목록: 같은 노선 순번 행의 역명이 팩 역 표시명이다.
    const rosterMatches = rosterRows.filter(
      (row) => row["권역명"] === "수도권"
        && row["철도운영기관명"] === "서울교통공사"
        && row["노선명"] === expected.rosterLine
        && row["순번"] === expected.rosterSequence,
    );
    assert.equal(rosterMatches.length, 1, `${label} MOLIT 역 목록 행은 하나여야 한다`);
    assert.equal(rosterMatches[0]["역명"], expected.rosterStationName);
    assert.equal(stationDisplayName(station), expected.rosterStationName);

    // 승인 개명 기록은 이 역·노선에 정확히 하나다.
    const aliases = exemptions.approvedStationNameAliases.filter(
      (alias) => alias.scopeKey === `capital:seoul-metro:${expected.lineId}`
        && alias.snapshotStationName === expected.coordinateStationName,
    );
    assert.equal(aliases.length, 1, `${label} 승인 개명 기록은 하나여야 한다`);
    assert.equal(aliases[0].reasonCode, "OFFICIAL_RENAME");
    assert.equal(aliases[0].rosterStationName, expected.rosterStationName);
  }
});

test("release-candidate 감사 인자로 커밋된 전국 정본 팩을 감사하면 BLOCKER·HIGH가 0이고 두 역은 승인 개명이다", async () => {
  const audit = await runAudit(canonicalPackPath);

  assert.deepEqual(
    audit.findings.filter(({ severity }) => severity === "BLOCKER" || severity === "HIGH"),
    [],
  );
  assert.equal(audit.exitCode, 0);
  for (const expected of renamedStations) {
    const approved = audit.findings.filter(
      (finding) => finding.code === "APPROVED_ROUTE_MAP_SOURCE_LABEL_RENAME"
        && finding.stationId === expected.stationId
        && finding.lineId === expected.lineId,
    );
    assert.equal(approved.length, 1, `${expected.stationId}/${expected.lineId} 승인 개명 INFO`);
    assert.equal(approved[0].packId, "nationwide");
  }
});

// 승인 개명의 권역은 팩 id가 아니라, 팩이 선언한 coverageLineOperatorScopes의
// 정확한 region:operator:line 조합으로 결속한다.
function renameFixture({ packId, coverageLineOperatorScopes }) {
  const sourceSha256 = "f093fd7af5fe992b9697ef798039f6a2944cf3db9e82507ba742b2f403b60074";
  const sourceUrl = "https://www.data.go.kr/data/15099316/fileData.do";
  return {
    packs: [{
      id: packId,
      sourceInventory: [{
        id: "seoul-metro-route-map-positions",
        sourceSha256,
        url: sourceUrl,
        coverageScope: {
          sourceDomains: ["route_map_positions"],
          regionIds: ["capital"],
          operatorIds: ["seoul-metro"],
          lineIds: ["seoul-4"],
        },
      }],
      ...(coverageLineOperatorScopes ? { coverageLineOperatorScopes } : {}),
      stations: [{ id: "station-bulam", nameKo: "불암산", nameSub: "당고개" }],
      stationLines: [{ stationId: "station-bulam", lineId: "seoul-4" }],
      routeMapPositions: [{
        stationId: "station-bulam",
        lineId: "seoul-4",
        region: "수도권",
        x: 1,
        y: 1,
        sourceId: "seoul-metro-route-map-positions",
        sourceName: "official coordinates",
        sourceUrl,
        sourceSha256,
        sourceLabel: "당고개",
        licenseStatus: "redistributable",
        reviewedAt: "2026-08-26T03:54:08.251Z",
      }],
    }],
  };
}

async function auditFixture(fixture) {
  const dir = await mkdtemp(path.join(tmpdir(), "easysubway-854-rename-"));
  try {
    const fixturePath = path.join(dir, "fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");
    return await runAudit(fixturePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("전국 팩은 선언한 coverageLineOperatorScopes 조합으로 승인 개명을 인정한다", async () => {
  const audit = await auditFixture(renameFixture({
    packId: "nationwide",
    coverageLineOperatorScopes: [
      { regionId: "capital", operatorId: "korail", lineId: "seoul-4" },
      { regionId: "capital", operatorId: "seoul-metro", lineId: "seoul-4" },
    ],
  }));

  assert.equal(audit.summary.findingsBySeverity.HIGH, 0);
  assert.ok(audit.findings.some((finding) =>
    finding.code === "APPROVED_ROUTE_MAP_SOURCE_LABEL_RENAME" && finding.severity === "INFO"));
});

test("팩이 개명 기록의 region:operator:line 조합을 선언하지 않으면 라벨 불일치로 막는다", async () => {
  for (const fixture of [
    renameFixture({
      packId: "nationwide",
      coverageLineOperatorScopes: [{ regionId: "capital", operatorId: "korail", lineId: "seoul-4" }],
    }),
    renameFixture({
      packId: "nationwide",
      coverageLineOperatorScopes: [{ regionId: "busan", operatorId: "seoul-metro", lineId: "seoul-4" }],
    }),
    renameFixture({ packId: "capital", coverageLineOperatorScopes: null }),
  ]) {
    const audit = await auditFixture(fixture);
    assert.equal(audit.summary.findingsBySeverity.HIGH, 1);
    assert.equal(audit.findings[0].code, "ROUTE_MAP_SOURCE_LABEL_MISMATCH");
    assert.equal(audit.exitCode, 1);
  }
});
