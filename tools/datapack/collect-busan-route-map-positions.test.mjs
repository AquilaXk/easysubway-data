import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createBusanRouteMapPositionsSnapshot,
  validateBusanRouteMapPositionsSnapshot,
} from "./collect-busan-route-map-positions.mjs";

const capturedAt = "2026-07-20T11:13:18.000Z";

async function inputs() {
  const [html, css, topology, connectorEvidence] = await Promise.all([
    readFile(new URL("./sources/humetro-cyberstation-map-20260623.html", import.meta.url)),
    readFile(new URL("./sources/humetro-cyber-station-20250310c.css", import.meta.url)),
    readFile(new URL("./sources/busan-transportation-route-topology-20260720.json", import.meta.url), "utf8")
      .then(JSON.parse),
    readFile(new URL("./sources/busan-transportation-route-map-connectors-20260720.json", import.meta.url), "utf8")
      .then(JSON.parse),
  ]);
  return { html, css, topology, connectorEvidence };
}

test("부산 공식 사이버스테이션 HTML/CSS에서 1~4호선 114개 좌표 snapshot을 만든다", async () => {
  const { html, css, topology, connectorEvidence } = await inputs();
  const snapshot = createBusanRouteMapPositionsSnapshot({
    html, css, topology, connectorEvidence, capturedAt,
  });

  assert.equal(snapshot.artifactKind, "busan-route-map-positions-snapshot");
  assert.equal(snapshot.sourceId, "busan-transportation-route-map-positions");
  assert.equal(snapshot.stationCount, 114);
  assert.deepEqual(snapshot.lineStationCounts, { "1": 40, "2": 43, "3": 17, "4": 14 });
  assert.equal(snapshot.positions.length, 114);
  assert.equal(snapshot.connectorCount, 110);
  assert.equal(snapshot.connectorAssetCount, 32);
  assert.equal(snapshot.connectors.length, 110);
  const curvedConnector = snapshot.connectors.find(({ fromStationCode }) => fromStationCode === "301");
  assert.equal(curvedConnector.assetSha256, "36e19a8560836154a4487b8929703e78986b0c1a3fd74194a7edbdcb5e299cbe");
  assert.ok((curvedConnector.path.match(/ L /g) ?? []).length > 10);
  assert.deepEqual(snapshot.positions.find(({ stationCode }) => stationCode === "95"), {
    lineId: "line-ab1a041f6266",
    line: "1",
    stationCode: "95",
    stationName: "다대포 해수욕장",
    x: 311,
    y: 705,
    labelDx: -61,
    labelDy: 2,
    labelPolygon: [
      { x: 200, y: 700 }, { x: 300, y: 700 }, { x: 300, y: 714 }, { x: 200, y: 714 },
    ],
  });
  assert.deepEqual(snapshot.positions.find(({ stationCode }) => stationCode === "119"), {
    lineId: "line-ab1a041f6266",
    line: "1",
    stationCode: "119",
    stationName: "서면",
    x: 860,
    y: 652,
    labelDx: 2,
    labelDy: -13,
    labelPolygon: [
      { x: 837, y: 632 }, { x: 887, y: 632 }, { x: 887, y: 646 }, { x: 837, y: 646 },
    ],
  });
  assert.ok(snapshot.positions.every(({ labelPolygon }) => labelPolygon.length === 4));
  assert.match(snapshot.htmlSha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.cssSha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.rawSha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.positionsSha256, /^[a-f0-9]{64}$/);
  assert.equal(validateBusanRouteMapPositionsSnapshot(snapshot), snapshot);
});

test("공식 좌표 누락·중복·topology 불일치는 fail closed 한다", async () => {
  const { html, css, topology, connectorEvidence } = await inputs();
  const source = css.toString("utf8");
  assert.throws(
    () => createBusanRouteMapPositionsSnapshot({
      html,
      css: Buffer.from(source.replace(/\.s95 \{[^}]+\}/, "")),
      topology,
      connectorEvidence,
      capturedAt,
    }),
    /coordinate missing/,
  );
  assert.throws(
    () => createBusanRouteMapPositionsSnapshot({
      html,
      css: Buffer.from(`${source}\n.s95 {top:1px;left:1px;}`),
      topology,
      connectorEvidence,
      capturedAt,
    }),
    /duplicate coordinate/,
  );
  const mismatchedTopology = structuredClone(topology);
  mismatchedTopology.scope.find(({ stationCode }) => stationCode === "95").stationName = "변조역";
  assert.throws(
    () => createBusanRouteMapPositionsSnapshot({
      html, css, topology: mismatchedTopology, connectorEvidence, capturedAt,
    }),
    /station mismatch/,
  );
});

test("snapshot hash나 좌표가 바뀌면 admission을 거부한다", async () => {
  const { html, css, topology, connectorEvidence } = await inputs();
  const snapshot = createBusanRouteMapPositionsSnapshot({
    html, css, topology, connectorEvidence, capturedAt,
  });
  const tampered = structuredClone(snapshot);
  tampered.positions[0].x += 1;
  assert.throws(() => validateBusanRouteMapPositionsSnapshot(tampered), /invalid Busan route map positions snapshot/);
});

test("공식 connector evidence가 없으면 route map snapshot 생성을 거부한다", async () => {
  const { html, css, topology } = await inputs();
  assert.throws(
    () => createBusanRouteMapPositionsSnapshot({
      html,
      css,
      topology,
      connectorEvidence: {},
      capturedAt,
    }),
    /connector evidence/,
  );
});

test("snapshot 시점과 다른 connector evidence는 결합하지 않는다", async () => {
  const { html, css, topology, connectorEvidence } = await inputs();
  const staleConnectorEvidence = structuredClone(connectorEvidence);
  staleConnectorEvidence.capturedAt = "2026-07-20T11:13:17.000Z";

  assert.throws(
    () => createBusanRouteMapPositionsSnapshot({
      html,
      css,
      topology,
      connectorEvidence: staleConnectorEvidence,
      capturedAt,
    }),
    /connector evidence capturedAt mismatch/,
  );
});

test("#2379 inventory·candidate는 snapshot byte identity와 자유 이용 근거를 고정한다", async () => {
  const [snapshotBytes, connectorEvidenceBytes, inventory, candidates] = await Promise.all([
    readFile(new URL("./sources/busan-transportation-route-map-positions-20260720.json", import.meta.url)),
    readFile(new URL("./sources/busan-transportation-route-map-connectors-20260720.json", import.meta.url)),
    readFile(new URL("./source-inventory.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("./source-candidates.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const source = inventory.sources.find(({ id }) => id === "busan-transportation-route-map-positions");
  const candidate = candidates.candidates.find(({ id }) => id === source.id);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.license.redistributionAllowed, true);
  assert.equal(source.license.derivativeWorkAllowed, true);
  assert.equal(source.license.evidenceUrl, "https://www.data.go.kr/data/15054957/fileData.do");
  assert.equal(
    source.routeMapAdmissionEvidence.snapshotSha256,
    createHash("sha256").update(snapshotBytes).digest("hex"),
  );
  assert.equal(candidate.admissionStatus, "production_route_map_positions_materialized");
  assert.equal(
    candidate.evidence.connectorEvidenceArtifactSha256,
    createHash("sha256").update(connectorEvidenceBytes).digest("hex"),
  );
  assert.equal(
    JSON.parse(snapshotBytes).connectorEvidenceSha256,
    createHash("sha256").update(JSON.stringify(JSON.parse(connectorEvidenceBytes))).digest("hex"),
  );
  assert.equal(candidate.evidence.coverageAssessment.requirementCount, 4);
});
