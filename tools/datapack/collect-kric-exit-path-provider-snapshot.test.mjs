import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalKricExitPathProviderSnapshotJson,
  collectKricExitPathProviderSnapshot,
} from "./collect-kric-exit-path-provider-snapshot.mjs";
import { planKricExitPathCollection } from "./plan-kric-exit-path-collection.mjs";

const CAPTURED_AT = "2026-08-11T00:00:00.000Z";
const SERVICE_KEY = "test-kric-secret-never-output";

test("exact query plan을 one-attempt KRIC provider snapshot으로 정규화한다", async () => {
  const collectionPlan = validPlan();
  const original = JSON.stringify(collectionPlan);
  const calls = [];
  const rawByStation = new Map();
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const station = new URL(url).searchParams.get("stinCd");
    const raw = providerSuccess(station === "S1"
      ? [providerRow("path-b", "2"), providerRow("path-a", "1")]
      : [providerRow("path-c", "1")]);
    rawByStation.set(station, raw);
    return jsonResponse(raw);
  };

  const snapshot = await collectKricExitPathProviderSnapshot({
    collectionPlan,
    sourceId: "kric-station-movement-standard",
    serviceKey: SERVICE_KEY,
    fetchImpl,
    now: new Date(CAPTURED_AT),
  });

  assert.equal(JSON.stringify(collectionPlan), original);
  assert.equal(calls.length, collectionPlan.queryPlan.length);
  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    "/openapi/handicapped/stationMovement",
    "/openapi/handicapped/stationMovement",
  ]);
  assert.deepEqual(calls.map(({ url }) => Object.fromEntries(url.searchParams)), [{
    serviceKey: SERVICE_KEY,
    format: "json",
    railOprIsttCd: "OP",
    lnCd: "L1",
    stinCd: "S1",
    nextStinCd: "S2",
  }, {
    serviceKey: SERVICE_KEY,
    format: "json",
    railOprIsttCd: "OP",
    lnCd: "L1",
    stinCd: "S2",
    nextStinCd: "S1",
  }]);
  assert.ok(calls.every(({ options }) => options.redirect === "error" && options.signal instanceof AbortSignal));
  assert.deepEqual(Object.keys(snapshot).sort(compareBytes), [
    "artifactKind", "capturedAt", "collectionPlanDigest", "coverage", "credentialRedacted",
    "freshUntil", "queryPlan", "queryPlanSha256", "results", "schemaVersion", "snapshotDigest",
    "snapshotId", "sourceId",
  ].sort(compareBytes));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.artifactKind, "kric-exit-path-provider-snapshot");
  assert.equal(snapshot.sourceId, "kric-station-movement-standard");
  assert.equal(snapshot.capturedAt, CAPTURED_AT);
  assert.equal(snapshot.freshUntil, "2026-08-12T00:00:00.000Z");
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.collectionPlanDigest, collectionPlan.collectionPlanDigest);
  assert.equal(snapshot.queryPlanSha256, collectionPlan.queryPlanSha256);
  assert.deepEqual(snapshot.queryPlan, collectionPlan.queryPlan);
  assert.deepEqual(snapshot.coverage, {
    requestPlanComplete: true,
    queryIds: collectionPlan.queryPlan.map(({ queryId }) => queryId),
  });
  assert.deepEqual(snapshot.results.map(({ state }) => state), ["ROWS_OBSERVED", "ROWS_OBSERVED"]);
  assert.deepEqual(snapshot.results[0].rows.map(({ mvPathMgNo }) => mvPathMgNo), ["path-a", "path-b"]);
  for (const [index, result] of snapshot.results.entries()) {
    const station = index === 0 ? "S1" : "S2";
    assert.equal(result.rawResponseSha256, sha256(Buffer.from(rawByStation.get(station))));
    assert.equal(result.rawResponseByteSize, Buffer.byteLength(rawByStation.get(station)));
    assert.equal(result.providerRecordHash, sha256(canonicalJson(result.rows)));
    assert.deepEqual(Object.keys(result).sort(compareBytes), [
      "providerRecordHash", "providerResultCode", "queryId", "rawResponseByteSize",
      "rawResponseSha256", "rows", "state",
    ].sort(compareBytes));
  }
  const { snapshotDigest, ...payload } = snapshot;
  assert.equal(snapshotDigest, sha256(canonicalJson(payload)));
  assert.doesNotMatch(canonicalKricExitPathProviderSnapshotJson(snapshot), new RegExp(SERVICE_KEY));
});

test("explicit zero와 provider no-data를 path admission 없이 구분한다", async () => {
  const collectionPlan = validPlan();
  const responses = [providerSuccess([]), providerNoData()];
  const paths = [];
  const snapshot = await collectKricExitPathProviderSnapshot({
    collectionPlan,
    sourceId: "kric-station-movement-detailed",
    serviceKey: SERVICE_KEY,
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      return jsonResponse(responses.shift());
    },
    now: new Date(CAPTURED_AT),
  });

  assert.deepEqual(paths, [
    "/openapi/vulnerableUserInfo/stationMovement",
    "/openapi/vulnerableUserInfo/stationMovement",
  ]);
  assert.deepEqual(snapshot.results.map(({ state, providerResultCode, rows }) => ({
    state, providerResultCode, rows,
  })), [{
    state: "EXPLICIT_ZERO",
    providerResultCode: "00",
    rows: [],
  }, {
    state: "PROVIDER_NO_DATA",
    providerResultCode: "03",
    rows: [],
  }]);
  assert.ok(!canonicalKricExitPathProviderSnapshotJson(snapshot).includes("OBSERVED_EXIT_PATH"));
  assert.ok(!canonicalKricExitPathProviderSnapshotJson(snapshot).includes("EXIT_TO_PLATFORM_PATH"));
});

test("bare JSON array는 provider 결과 미검증 raw evidence로만 보존한다", async () => {
  const collectionPlan = validPlan();
  const responses = [JSON.stringify([providerRow("path-a", "1")]), "[]"];
  const snapshot = await collectKricExitPathProviderSnapshot({
    collectionPlan,
    sourceId: "kric-station-movement-standard",
    serviceKey: SERVICE_KEY,
    fetchImpl: async () => jsonResponse(responses.shift()),
    now: new Date(CAPTURED_AT),
  });

  assert.deepEqual(snapshot.results.map(({ state, providerResultCode, rows }) => ({
    state, providerResultCode, rowCount: rows.length,
  })), [{
    state: "PROVIDER_RESULT_UNVERIFIED",
    providerResultCode: null,
    rowCount: 1,
  }, {
    state: "PROVIDER_RESULT_UNVERIFIED",
    providerResultCode: null,
    rowCount: 0,
  }]);
  assert.ok(!snapshot.results.some(({ state }) => state === "EXPLICIT_ZERO"));
});

test("JSON escape와 URL encoding은 credential echo 검사를 우회하지 못한다", async () => {
  const serviceKey = 'test-kric-secret-" + %';
  const urlEncoded = new URLSearchParams({ serviceKey }).toString().slice("serviceKey=".length);
  for (const [label, echoed] of [["decoded exact", serviceKey], ["url encoded", urlEncoded]]) {
    let calls = 0;
    await assert.rejects(() => collectKricExitPathProviderSnapshot({
      collectionPlan: validPlan(),
      sourceId: "kric-station-movement-standard",
      serviceKey,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(JSON.stringify({
          header: { resultCode: "00", resultMsg: echoed },
          body: [],
        }));
      },
      now: new Date(CAPTURED_AT),
    }), /KRIC EXIT response echoed credential/, label);
    assert.equal(calls, 1, label);
  }
});

test("plan/source/time/request 경계는 첫 provider call 전에 fail closed한다", async () => {
  const cases = [{
    label: "unsupported source",
    sourceId: "kric-station-movement-unknown",
    collectionPlan: validPlan(),
    expected: /unsupported KRIC EXIT source/,
  }, {
    label: "tampered plan digest",
    sourceId: "kric-station-movement-standard",
    collectionPlan: mutate(validPlan(), (plan) => { plan.queryPlan[0].providerStationId = "TAMPERED"; }),
    expected: /EXIT query plan digest mismatch|EXIT collection plan digest mismatch/,
  }, {
    label: "forged query id",
    sourceId: "kric-station-movement-standard",
    collectionPlan: rebindPlan(mutate(validPlan(), (plan) => { plan.queryPlan[0].queryId = "forged"; })),
    expected: /EXIT provider query identity mismatch/,
  }, {
    label: "duplicate provider request tuple",
    sourceId: "kric-station-movement-standard",
    collectionPlan: rebindPlan(mutate(validPlan(), (plan) => {
      Object.assign(plan.queryPlan[1], {
        providerOperatorId: plan.queryPlan[0].providerOperatorId,
        providerLineId: plan.queryPlan[0].providerLineId,
        providerStationId: plan.queryPlan[0].providerStationId,
        providerNextStationId: plan.queryPlan[0].providerNextStationId,
        routeEdgeId: "duplicate-provider-tuple-edge",
      });
      plan.queryPlan[1].queryId = queryId(plan.queryPlan[1]);
      plan.queryPlan.sort(compareQueries);
    })),
    expected: /duplicate KRIC EXIT provider request tuple/,
  }];
  for (const entry of cases) {
    let calls = 0;
    await assert.rejects(() => collectKricExitPathProviderSnapshot({
      collectionPlan: entry.collectionPlan,
      sourceId: entry.sourceId,
      serviceKey: SERVICE_KEY,
      fetchImpl: async () => { calls += 1; return jsonResponse(providerSuccess([])); },
      now: new Date(CAPTURED_AT),
    }), entry.expected, entry.label);
    assert.equal(calls, 0, entry.label);
  }
  await assert.rejects(() => collectKricExitPathProviderSnapshot({
    collectionPlan: validPlan(), sourceId: "kric-station-movement-standard", serviceKey: "",
  }), /KRIC_SERVICE_KEY is required/);
  await assert.rejects(() => collectKricExitPathProviderSnapshot({
    collectionPlan: validPlan(), sourceId: "kric-station-movement-standard", serviceKey: SERVICE_KEY,
    now: new Date("invalid"),
  }), /collection time must be valid/);
});

test("provider transport·envelope·strict JSON·row drift는 partial snapshot을 만들지 않는다", async () => {
  const invalidResponses = [{
    label: "http",
    response: new Response("unavailable", { status: 503 }),
    expected: /KRIC EXIT HTTP 503/,
  }, {
    label: "invalid utf8",
    response: new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }),
    expected: /KRIC EXIT response must be strict UTF-8 JSON/,
  }, {
    label: "duplicate json key",
    response: jsonResponse('{"header":{"resultCode":"00","resultCode":"00"},"body":[]}'),
    expected: /duplicate JSON key/,
  }, {
    label: "unsafe positive integer",
    response: jsonResponse(providerSuccessWithIntegerLiteral("9007199254740993")),
    expected: /KRIC EXIT response must be strict UTF-8 JSON/,
  }, {
    label: "unsafe negative integer",
    response: jsonResponse(providerSuccessWithIntegerLiteral("-9007199254740993")),
    expected: /KRIC EXIT response must be strict UTF-8 JSON/,
  }, {
    label: "oversized body",
    response: jsonResponse(JSON.stringify({
      header: { resultCode: "00" },
      body: [{ ...providerRow("path-a", "1"), mvContDtl: "x".repeat(1024 * 1024) }],
    })),
    expected: /KRIC EXIT response size invalid/,
  }, {
    label: "unknown provider code",
    response: jsonResponse(JSON.stringify({ header: { resultCode: "99" }, body: [] })),
    expected: /KRIC EXIT provider result invalid/,
  }, {
    label: "no-data with rows",
    response: jsonResponse(JSON.stringify({ header: { resultCode: "03" }, body: [providerRow("path-a", "1")] })),
    expected: /KRIC EXIT provider no-data shape mismatch/,
  }, {
    label: "body object",
    response: jsonResponse(JSON.stringify({ header: { resultCode: "00" }, body: {} })),
    expected: /KRIC EXIT response body must be an array/,
  }, {
    label: "extra row field",
    response: jsonResponse(providerSuccess([{ ...providerRow("path-a", "1"), extra: "x" }])),
    expected: /KRIC EXIT provider row keys mismatch/,
  }, {
    label: "nested row field",
    response: jsonResponse(providerSuccess([{ ...providerRow("path-a", "1"), imgPath: { nested: true } }])),
    expected: /KRIC EXIT provider row scalar mismatch/,
  }, {
    label: "blank path order",
    response: jsonResponse(providerSuccess([{ ...providerRow("path-a", "1"), exitMvTpOrdr: "" }])),
    expected: /KRIC EXIT provider row ordering identity missing/,
  }, {
    label: "duplicate row",
    response: jsonResponse(providerSuccess([providerRow("path-a", "1"), providerRow("path-a", "1")])),
    expected: /duplicate KRIC EXIT provider row/,
  }];

  for (const entry of invalidResponses) {
    let calls = 0;
    await assert.rejects(() => collectKricExitPathProviderSnapshot({
      collectionPlan: validPlan(),
      sourceId: "kric-station-movement-standard",
      serviceKey: SERVICE_KEY,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? entry.response : jsonResponse(providerSuccess([]));
      },
      now: new Date(CAPTURED_AT),
    }), entry.expected, entry.label);
    assert.equal(calls, 1, entry.label);
  }

  let attempts = 0;
  await assert.rejects(() => collectKricExitPathProviderSnapshot({
    collectionPlan: validPlan(),
    sourceId: "kric-station-movement-standard",
    serviceKey: SERVICE_KEY,
    fetchImpl: async () => { attempts += 1; throw new Error(`secret ${SERVICE_KEY}`); },
    now: new Date(CAPTURED_AT),
  }), /KRIC EXIT request failed/);
  assert.equal(attempts, 1);
});

function validPlan() {
  const stationLines = [stationLine("station-a", "가역"), stationLine("station-b", "나역")];
  const providerMappings = stationLines.map(({ stationId, lineId }, index) => ({
    stationId,
    lineId,
    providerOperatorId: "OP",
    providerLineId: "L1",
    providerStationId: `S${index + 1}`,
  }));
  const routeEdges = [{
    routeEdgeId: "edge-a-b",
    fromStationId: "station-a",
    toStationId: "station-b",
    lineId: "line-1",
    edgeType: "RIDE",
    servicePattern: "LOCAL",
    serviceClass: "SUBWAY",
  }, {
    routeEdgeId: "edge-b-a",
    fromStationId: "station-b",
    toStationId: "station-a",
    lineId: "line-1",
    edgeType: "RIDE",
    servicePattern: "LOCAL",
    serviceClass: "SUBWAY",
  }];
  const input = {
    candidate: {
      candidateId: "candidate-capital",
      stationSetSha256: sha256(canonicalJson(["station-a", "station-b"])),
      stationLineSetSha256: sha256(canonicalJson(stationLines.map(({ stationId, lineId, operatorId }) => ({
        stationId, lineId, operatorId,
      })))),
      stationLineMappingSha256: sha256(canonicalJson(stationLines)),
      providerMappingSha256: sha256(canonicalJson(providerMappings)),
      topologySha256: sha256(canonicalJson(routeEdges)),
    },
    stationLines,
    providerMappings,
    routeEdges,
  };
  return planKricExitPathCollection(input);
}

function stationLine(stationId, stationName) {
  return {
    stationId,
    stationName,
    stationAliases: [],
    regionId: "capital",
    lineId: "line-1",
    lineName: "1호선",
    operatorId: "operator-1",
    operatorName: "운영사",
  };
}

function providerRow(mvPathMgNo, exitMvTpOrdr) {
  return {
    edMovePath: "승강장",
    elvtSttCd: null,
    elvtTpCd: null,
    exitMvTpOrdr,
    imgPath: "",
    mvContDtl: `${exitMvTpOrdr}단계 이동`,
    mvPathMgNo,
    stMovePath: "출입구",
  };
}

function providerSuccess(rows) {
  return JSON.stringify({ header: { resultCode: "00", resultMsg: "NORMAL SERVICE" }, body: rows });
}

function providerNoData() {
  return JSON.stringify({ header: { resultCode: "03", resultMsg: "NO DATA" }, body: [] });
}

function providerSuccessWithIntegerLiteral(literal) {
  return providerSuccess([{ ...providerRow("path-a", "1"), exitMvTpOrdr: "UNSAFE_INTEGER" }])
    .replace('"UNSAFE_INTEGER"', literal);
}

function jsonResponse(raw) {
  return new Response(raw, { status: 200, headers: { "content-type": "application/json" } });
}

function mutate(value, action) {
  const clone = structuredClone(value);
  action(clone);
  return clone;
}

function rebindPlan(plan) {
  plan.queryPlanSha256 = sha256(canonicalJson(plan.queryPlan));
  const { collectionPlanDigest: _, ...payload } = plan;
  plan.collectionPlanDigest = sha256(canonicalJson(payload));
  return plan;
}

function queryId(query) {
  return sha256(canonicalJson({
    providerLineId: query.providerLineId,
    providerNextStationId: query.providerNextStationId,
    providerOperatorId: query.providerOperatorId,
    providerStationId: query.providerStationId,
    routeEdgeId: query.routeEdgeId,
  }));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
  }
  return value;
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

function compareQueries(left, right) {
  return compareBytes(left.providerStationId, right.providerStationId)
    || compareBytes(left.providerNextStationId, right.providerNextStationId)
    || compareBytes(left.routeEdgeId, right.routeEdgeId)
    || compareBytes(left.queryId, right.queryId);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
