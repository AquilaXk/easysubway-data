import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { busanTimetableCounts, collectBusanTimetable } from "./collect-busan-timetable.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import {
  prepareBusanTimetableRegistration,
  registerBusanTimetable,
} from "./register-busan-timetable.mjs";

const topology = JSON.parse(await readFile(
  new URL("./sources/busan-transportation-route-topology-20260720.json", import.meta.url),
  "utf8",
));
const FROZEN_TOPOLOGY_BYTES = await readFile(
  new URL("./sources/busan-transportation-route-topology-20260720.json", import.meta.url),
);

test("Busan timetable counts retain distinct opaque destination groups", () => {
  const rows = [
    { line: "1", day: "1", trainno: "10", updown: "0", endcode: "318", scode: "100" },
    { line: "1", day: "1", trainno: "10", updown: "0", endcode: "318", scode: "101" },
    { line: "1", day: "1", trainno: "10", updown: "0", endcode: "319", scode: "100" },
  ];

  assert.deepEqual(busanTimetableCounts(rows), {
    departureCount: 3,
    tripCount: 2,
    stopTimeCount: 3,
  });
});

test("부산 timetable collector는 malformed credential로 provider를 호출하지 않는다", async () => {
  let calls = 0;
  await assert.rejects(collectBusanTimetable({ serviceKey: "invalid%ZZ", stationScopes: topology.scope, fetchImpl: async () => { calls += 1; } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});

function response({ stationName, stationCode, line, items, captureRaw = null }) {
  const body = items.map((item) => `<item>${item}</item>`).join("");
  const raw = `<?xml version="1.0" encoding="UTF-8"?><response>
    <header><resultCode>00</resultCode><resultMsg>정상</resultMsg></header>
    <body><scode>${stationCode}</scode><line>${line}</line><sname>${stationName}</sname>
    <engname>Station ${stationCode}</engname>${body}</body>
    <numOfRows>${items.length}</numOfRows><pageNo>1</pageNo><totalCount>${items.length}</totalCount></response>`;
  captureRaw?.(Buffer.from(raw));
  return new Response(raw, {
    headers: { "content-type": "application/xml" },
  });
}

test("Busan timetable registration replays retained responses through the source transaction", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "busan-timetable-register-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const capturedAt = new Date("2026-03-02T00:00:00.000Z");
  const now = new Date(capturedAt.valueOf() + 60_000);
  const snapshot = await collectBusanTimetable({
    serviceKey: "fixture-key",
    stationScopes: topology.scope,
    now: capturedAt,
    fetchImpl: async (url) => {
      const request = new URL(url);
      const station = topology.scope.find(({ stationCode }) => stationCode === request.searchParams.get("scode"));
      const line = lineCode(station.lineId);
      const day = request.searchParams.get("day");
      return response({
        stationName: station.stationName,
        stationCode: station.stationCode,
        line,
        items: ["0", "1"].map((updown) => [
          `<trainno>${line}${day}${updown}</trainno><hour>05</hour><time>01</time>`,
          `<day>${day}</day><updown>${updown}</updown><endcode>${station.stationCode}</endcode>`,
        ].join("")),
      });
    },
  });
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  const snapshotPath = path.join(root, "retained-timetable.json");
  const topologySnapshotId = "frozen-busan-topology";
  const topologyRelative = `tools/datapack/sources/${topologySnapshotId}.json`;
  const sourceId = "busan-transportation-timetable";
  const license = { redistributionAllowed: true, evidenceUrl: "https://example.test/license" };
  const licenseHash = createHash("sha256").update(canonicalJson(license)).digest("hex");
  const freshness = {
    id: "busan_timetable_observation",
    sourceIds: [sourceId],
    basisField: "capturedAt",
    reverificationCadence: "P30D",
    futureBasisAllowed: false,
    providerValidityEndField: null,
    eventTriggers: ["official timetable revision"],
  };
  const governance = governancePolicy({ sourceId, sourceClassId: freshness.id, licenseHash, license, now });
  const source = {
    id: sourceId,
    provider: "fixture Busan operator",
    datasetUrl: "https://example.test/timetable",
    productionUseAllowed: true,
    requiredForProductionPack: false,
    license,
    capabilities: { schedule: { productionUseAllowed: true } },
    scheduleAdmissionEvidence: {
      issue: 2368,
      materializer: "tools/datapack/materialize-busan-timetable.mjs",
      verificationTest: "tools/datapack/materialize-busan-timetable.test.mjs",
      capturedAt: new Date(capturedAt.valueOf() - 24 * 60 * 60 * 1_000).toISOString(),
      freshUntil: capturedAt.toISOString(),
    },
  };
  const topologySource = {
    id: "busan-transportation-route-topology",
    productionUseAllowed: true,
    requiredForProductionPack: false,
    license: { redistributionAllowed: true },
    topologyAdmissionEvidence: {
      snapshotId: topologySnapshotId,
      snapshotPath: topologyRelative,
      capturedAt: topology.capturedAt,
      stationCount: topology.stationCount,
      edgeCount: topology.edgeCount,
      rawSha256: topology.rawSha256,
      contentSha256: topology.contentSha256,
    },
  };
  const outputValues = [
    { sources: [source, topologySource] },
    [],
    governance,
    { sourceClasses: [] },
  ];
  for (const [index, relative] of SOURCE_REGISTRATION_OUTPUTS.entries()) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(outputValues[index], null, 2)}\n`);
  }
  await mkdir(path.join(root, "tools/datapack/sources"), { recursive: true });
  await writeFile(path.join(root, topologyRelative), FROZEN_TOPOLOGY_BYTES);
  await writeFile(snapshotPath, snapshotBytes);
  await writeFile(path.join(root, "tools/datapack/source-candidates.json"), JSON.stringify({ candidates: [{
    id: sourceId,
    domain: "schedule_timetable",
    registrationMetadata: { governance: governance.sources[0], freshness },
  }] }));

  const receiptPath = path.join(root, "receipt.json");
  const options = { repositoryRoot: root, snapshotPath, receiptPath, now, env: fixtureOciEnv() };
  const prepared = await prepareBusanTimetableRegistration(options);
  await writeFile(receiptPath, `${JSON.stringify(receiptFor(prepared, now))}\n`);
  await registerBusanTimetable(options);

  const [registeredInventory, registeredLedger, , registeredFreshness] = await Promise.all(
    SOURCE_REGISTRATION_OUTPUTS.map(async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"))),
  );
  const registered = registeredInventory.sources.find(({ id }) => id === sourceId);
  assert.equal(registered.requiredForProductionPack, true);
  assert.deepEqual(registered.admissionEvidence, { licenseEvidenceHash: licenseHash });
  assert.equal(registered.scheduleAdmissionEvidence.snapshotId, prepared.snapshotId);
  assert.equal(registered.scheduleAdmissionEvidence.rowCount, snapshot.rows.length);
  assert.equal(registered.scheduleAdmissionEvidence.departureCount, snapshot.rows.length);
  assert.equal(registered.scheduleAdmissionEvidence.stopTimeCount, snapshot.rows.length);
  assert.equal(registered.scheduleAdmissionEvidence.tripCount,
    new Set(snapshot.rows.map((row) => [row.line, row.day, row.trainno, row.updown, row.endcode].join("\0"))).size);
  assert.equal(registered.scheduleAdmissionEvidence.topologySnapshotId, topologySnapshotId);
  assert.equal(registeredLedger.at(-1).freshUntil, snapshot.freshUntil);
  assert.equal(registeredFreshness.sourceClasses.at(-1).id, freshness.id);
  assert.deepEqual(await readFile(path.join(root, registered.scheduleAdmissionEvidence.snapshotPath)), snapshotBytes);
});

test("부산 timetable collector는 114개 역과 3개 요일을 bounded fan-out한다", async () => {
  const requested = [];
  const originalBytes = new Map();
  const secret = "never-print-service-key";
  const opaqueDestinationCode = "318";
  const snapshot = await collectBusanTimetable({
    serviceKey: secret,
    stationScopes: topology.scope,
    now: new Date("2026-07-20T09:00:00.000Z"),
    fetchImpl: async (url) => {
      const request = new URL(url);
      requested.push(request);
      const station = topology.scope.find(({ stationCode }) => stationCode === request.searchParams.get("scode"));
      const line = ({
        "line-ab1a041f6266": "1",
        "line-eb7b47920390": "2",
        "line-d74614a04530": "3",
        "line-d812a5bc1e5f": "4",
      })[station.lineId];
      const day = request.searchParams.get("day");
      const stationName = station.stationCode === "205" ? "벡스코 공식별칭" : station.stationName;
      return response({ stationName, stationCode: station.stationCode, line, items: ["0", "1"].map((updown) => [
        `<trainno>${line}${day}0${updown}</trainno>`,
        "<hour>05</hour><time>01</time>",
        `<day>${day}</day><updown>${updown}</updown>`,
        `<endcode>${station.stationCode === topology.scope[0].stationCode
          ? opaqueDestinationCode : station.stationCode}</endcode>`,
      ].join("")), captureRaw: (bytes) => originalBytes.set(`${station.stationCode}\0${day}`, bytes) });
    },
  });

  assert.equal(requested.length, 342);
  assert.equal(snapshot.requestCount, 342);
  assert.equal(snapshot.stationCount, 114);
  assert.equal(snapshot.rowCount, 684);
  assert.deepEqual(snapshot.dayTypes, ["1", "2", "3"]);
  assert.deepEqual(snapshot.lineIds, topology.lineIds);
  assert.deepEqual([...requested[0].searchParams], [
    ["serviceKey", secret], ["act", "xml"], ["scode", topology.scope[0].stationCode], ["day", "1"],
    ["pageNo", "1"], ["numOfRows", "999"],
  ]);
  assert.equal(snapshot.credentialRedacted, true);
  assert.match(snapshot.rowsSha256, /^[a-f0-9]{64}$/);
  const rawResponseScope = topology.scope.flatMap(({ stationCode }) => ["1", "2", "3"].map((day) => ({ stationCode, day })));
  assert.deepEqual(snapshot.rawResponses, rawResponseScope.map(({ stationCode, day }) => ({
    stationCode,
    day,
    bytesBase64: originalBytes.get(`${stationCode}\0${day}`).toString("base64"),
  })));
  assert.equal(snapshot.rawSha256, createHash("sha256").update(JSON.stringify(rawResponseScope.map(({ stationCode, day }) => ({
    stationCode,
    day,
    rawSha256: createHash("sha256").update(originalBytes.get(`${stationCode}\0${day}`)).digest("hex"),
  })))).digest("hex"));
  assert.deepEqual(snapshot.scope, topology.scope.map(({ stationCode, stationName, lineId }) => ({
    stationCode, stationName, lineId,
  })));
  assert.equal(snapshot.rows.find(({ scode }) => scode === "205").sname, "벡스코 공식별칭");
  assert.ok(snapshot.rows.some(({ scode, endcode }) =>
    scode === topology.scope[0].stationCode && endcode === opaqueDestinationCode));
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
});

test("부산 timetable collector는 역·요일별 양방향 누락을 fail closed한다", async () => {
  await assert.rejects(collectBusanTimetable({
    serviceKey: "key",
    stationScopes: topology.scope,
    fetchImpl: async (url) => {
      const request = new URL(url);
      const station = topology.scope.find(({ stationCode }) => stationCode === request.searchParams.get("scode"));
      const line = ({
        "line-ab1a041f6266": "1", "line-eb7b47920390": "2",
        "line-d74614a04530": "3", "line-d812a5bc1e5f": "4",
      })[station.lineId];
      const day = request.searchParams.get("day");
      const directions = station.stationCode === topology.scope[0].stationCode && day === "1" ? ["0"] : ["0", "1"];
      return response({
        stationName: station.stationName,
        stationCode: station.stationCode,
        line,
        items: directions.map((updown) => [
          `<trainno>${line}${day}0${updown}</trainno><hour>05</hour><time>01</time>`,
          `<day>${day}</day><updown>${updown}</updown><endcode>${station.stationCode}</endcode>`,
        ].join("")),
      });
    },
  }), /station\/day\/direction scope incomplete/);
});

test("부산 timetable collector는 credential 없는 transport code만 진단한다", async () => {
  const transport = Object.assign(new Error("secret-bearing transport detail"), { code: "ENOTFOUND" });
  await assert.rejects(collectBusanTimetable({
    serviceKey: "never-print-service-key",
    stationScopes: topology.scope,
    sleepImpl: async () => {},
    fetchImpl: async () => { throw transport; },
  }), (error) => {
    assert.match(error.message, /transport failure; code=ENOTFOUND/);
    assert.doesNotMatch(error.message, /never-print|secret-bearing/);
    return true;
  });
});

test("부산 timetable collector는 pagination mismatch count만 진단한다", async () => {
  await assert.rejects(collectBusanTimetable({
    serviceKey: "key",
    stationScopes: topology.scope,
    fetchImpl: async () => new Response(`<?xml version="1.0"?><response>
      <header><resultCode>00</resultCode></header><body><item>
      <sname>역</sname><engname>Station</engname><trainno>101</trainno><hour>05</hour><time>01</time>
      <day>1</day><updown>0</updown><endcode>100</endcode><scode>100</scode><line>1</line>
      </item></body><totalCount>2</totalCount></response>`, {
      headers: { "content-type": "application/xml" },
    }),
  }), /truncated items; items=1; totalCount=2; rawSha256=[a-f0-9]{64}/);
});

test("부산 timetable collector는 값 대신 실패 field만 진단한다", async () => {
  await assert.rejects(collectBusanTimetable({
    serviceKey: "key",
    concurrency: 1,
    stationScopes: topology.scope,
    fetchImpl: async (url) => {
      const request = new URL(url);
      const station = topology.scope.find(({ stationCode }) => stationCode === request.searchParams.get("scode"));
      const line = ({
        "line-ab1a041f6266": "1", "line-eb7b47920390": "2",
        "line-d74614a04530": "3", "line-d812a5bc1e5f": "4",
      })[station.lineId];
      const day = request.searchParams.get("day");
      return response({ stationName: station.stationName, stationCode: station.stationCode, line, items: [[
        "<trainno>INVALID</trainno><hour>05</hour><time>01</time>",
        `<day>${day}</day><updown>0</updown><endcode>${station.stationCode}</endcode>`,
      ].join("")] });
    },
  }), (error) => {
    assert.match(error.message, /item\[0\] values=trainno/);
    assert.match(error.message, new RegExp(`stationCode=${topology.scope[0].stationCode}; day=1`));
    assert.doesNotMatch(error.message, /endcodeState=(MATCHED|UNKNOWN_STATION|OTHER_LINE)/);
    assert.doesNotMatch(error.message, /INVALID|never-print-service-key/);
    return true;
  });
});

function lineCode(lineId) {
  return {
    "line-ab1a041f6266": "1",
    "line-eb7b47920390": "2",
    "line-d74614a04530": "3",
    "line-d812a5bc1e5f": "4",
  }[lineId];
}

function governancePolicy({ sourceId, sourceClassId, licenseHash, license, now }) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-source-governance-policy",
    policyVersion: "2026-03-01",
    sources: [{
      sourceId,
      sourceClassId,
      retentionClassId: "standard-90d",
      ownerRole: "data-owner",
      stewardRole: "data-steward",
      approvalRole: "data-owner",
      escalationHours: 24,
      alertRoute: "data-owner",
      licenseReview: {
        status: "APPROVED",
        termsHash: licenseHash,
        termsUrl: license.evidenceUrl,
        reviewedProvider: "fixture Busan operator",
        reviewedDatasetUrl: "https://example.test/timetable",
        reviewedAt: new Date(now.valueOf() - 60_000).toISOString(),
        nextReviewAt: new Date(now.valueOf() + 60_000).toISOString(),
        redistributionScopes: ["DERIVED_DATAPACK"],
        approvedByRole: "data-owner",
      },
    }],
    retentionClasses: [{ id: "standard-90d", retentionDays: 90 }],
    reasonCodeEscalations: [{
      responsibleRole: "data-owner",
      alertRoute: "data-owner",
      escalationHours: 24,
      reasonCodes: [
        "SOURCE_LINEAGE_BROKEN", "SOURCE_DIFF_MISSING", "SOURCE_FRESHNESS_POLICY_MISSING",
        "SOURCE_SNAPSHOT_EXPIRED", "RAW_RETENTION_OVERDUE", "LEGAL_HOLD_INVALID",
        "LICENSE_REVIEW_REQUIRED", "REDISTRIBUTION_NOT_APPROVED", "SOURCE_GOVERNANCE_OWNER_MISSING",
      ],
    }],
  };
}

function fixtureOciEnv() {
  return {
    EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL:
      "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/",
  };
}

function receiptFor(prepared, now) {
  const objectKey = `source-raw/busan-transportation-timetable/${prepared.snapshotId.slice(-8)}/${prepared.snapshotSha256}.json`;
  return {
    schemaVersion: 1,
    artifactKind: "static-network-source-raw-object-receipt",
    sourceId: "busan-transportation-timetable",
    snapshotId: prepared.snapshotId,
    capturedAt: prepared.snapshot.capturedAt,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`,
    rawObjectSha256: prepared.snapshotSha256,
    byteSize: prepared.snapshotBytes.length,
    storedAt: now.toISOString(),
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    ociNamespace: "axvym6vk8g7i",
    bucket: "easysubway-datapacks",
    objectKey,
    contentType: "application/json",
  };
}
