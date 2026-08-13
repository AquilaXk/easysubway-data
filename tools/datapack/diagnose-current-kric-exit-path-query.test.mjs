import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "./diagnose-current-kric-exit-path-query.mjs";
import { probeKricExitPathProviderQuery } from "./collect-kric-exit-path-provider-snapshot.mjs";
import {
  canonicalKricExitPathCollectionPlanJson,
  planKricExitPathCollection,
} from "./plan-kric-exit-path-collection.mjs";

const SERVICE_KEY = "aA1!".repeat(15);
const SOURCE_ID = "kric-station-movement-standard";

test("correlated diagnostic은 control과 exact target을 각각 한 번 호출하고 sanitized receipt만 남긴다", async () => {
  await withPlan(async ({ plan, planPath }) => {
    const queryId = plan.queryPlan[0].queryId;
    const calls = [];
    const logs = [];
    const receipt = await main(cliArgs(planPath, queryId, "12345"), {
      candidatesDocument: candidatesDocument(),
      env: { KRIC_SERVICE_KEY: SERVICE_KEY },
      controlProbeImpl: async (input) => {
        calls.push("control");
        assert.equal(input.requestTimeoutMs, 12_345);
        return "succeeded";
      },
      targetProbeImpl: async (input) => {
        assert.equal(input.requestTimeoutMs, 12_345);
        return probeKricExitPathProviderQuery({
          ...input,
          fetchImpl: async (url, options) => {
            calls.push("target");
            assert.equal(new URL(url).origin, "https://openapi.kric.go.kr");
            assert.ok(options.signal instanceof AbortSignal);
            return new Response(JSON.stringify({ header: { resultCode: "00" }, body: [] }), { status: 200 });
          },
        });
      },
      log: (message) => logs.push(message),
    });

    assert.deepEqual(calls, ["control", "target"]);
    assert.deepEqual(receipt, {
      result: "DIAGNOSED",
      sourceId: SOURCE_ID,
      queryId,
      controlStatus: "SUCCEEDED",
      targetStatus: "SUCCEEDED",
      targetResultState: "EXPLICIT_ZERO",
      attempts: { control: 1, target: 1 },
      credentialRedacted: true,
    });
    assert.deepEqual(logs, [`current KRIC EXIT timeout diagnosis ready: ${JSON.stringify(receipt)}`]);
    assert.doesNotMatch(logs[0], new RegExp(SERVICE_KEY));
    assert.doesNotMatch(logs[0], /providerStationId|providerNextStationId|must not leak/);
  });
});

test("control failure와 target timeout도 retry 없이 closed correlation으로 반환한다", async () => {
  await withPlan(async ({ plan, planPath }) => {
    const queryId = plan.queryPlan[0].queryId;
    let controlCalls = 0;
    let targetCalls = 0;
    const receipt = await main(cliArgs(planPath, queryId), {
      candidatesDocument: candidatesDocument(),
      env: { KRIC_SERVICE_KEY: SERVICE_KEY },
      controlProbeImpl: async () => { controlCalls += 1; return "failed"; },
      targetProbeImpl: async () => {
        targetCalls += 1;
        throw new Error(`KRIC EXIT request failed: NETWORK_TIMEOUT: ${queryId}`, {
          cause: new Error(`must not leak ${SERVICE_KEY}`),
        });
      },
      log: () => {},
    });

    assert.equal(controlCalls, 1);
    assert.equal(targetCalls, 1);
    assert.equal(receipt.controlStatus, "FAILED");
    assert.equal(receipt.targetStatus, "NETWORK_TIMEOUT");
    assert.equal(receipt.targetResultState, null);
    assert.equal(JSON.stringify(receipt).includes(SERVICE_KEY), false);
  });
});

test("target HTTP와 provider/schema failure는 raw error 없이 closed status로 축약한다", async () => {
  await withPlan(async ({ plan, planPath }) => {
    const queryId = plan.queryPlan[0].queryId;
    for (const [message, expected] of [
      [`KRIC EXIT HTTP 503: ${queryId}`, "HTTP_STATUS"],
      [`KRIC EXIT provider result invalid: ${queryId}/20`, "PROVIDER_FAILURE"],
      [`unexpected must not leak ${SERVICE_KEY}`, "PROVIDER_FAILURE"],
    ]) {
      const receipt = await main(cliArgs(planPath, queryId), {
        candidatesDocument: candidatesDocument(),
        env: { KRIC_SERVICE_KEY: SERVICE_KEY },
        controlProbeImpl: async () => "succeeded",
        targetProbeImpl: async () => { throw new Error(message); },
        log: () => {},
      });
      assert.equal(receipt.targetStatus, expected);
      assert.equal(JSON.stringify(receipt).includes(SERVICE_KEY), false);
    }
  });
});

test("missing query와 credential/catalog drift는 live probe 전에 실패한다", async () => {
  await withPlan(async ({ plan, planPath }) => {
    let calls = 0;
    const dependencies = {
      candidatesDocument: candidatesDocument(),
      env: { KRIC_SERVICE_KEY: SERVICE_KEY },
      controlProbeImpl: async () => { calls += 1; return "succeeded"; },
      targetProbeImpl: async () => { calls += 1; return { state: "EXPLICIT_ZERO" }; },
      log: () => {},
    };
    await assert.rejects(
      () => main(cliArgs(planPath, "0".repeat(64)), dependencies),
      /query ID is not present/,
    );
    await assert.rejects(
      () => main(cliArgs(planPath, plan.queryPlan[0].queryId), {
        ...dependencies,
        env: { KRIC_SERVICE_KEY: "wrong" },
      }),
      /credential length|credential character classes/,
    );
    assert.equal(calls, 0);
  });
});

async function withPlan(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-exit-timeout-diagnostic-"));
  try {
    const plan = validPlan();
    const planPath = path.join(directory, "plan.json");
    await writeFile(planPath, canonicalKricExitPathCollectionPlanJson(plan));
    await callback({ directory, plan, planPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function cliArgs(planPath, queryId, requestTimeoutMs = "30000") {
  return [
    "--collection-plan", planPath,
    "--source-id", SOURCE_ID,
    "--query-id", queryId,
    "--request-timeout-ms", requestTimeoutMs,
  ];
}

function candidatesDocument({ endpoint = "https://openapi.kric.go.kr/openapi/handicapped/stationMovement" } = {}) {
  const sampleUrl = new URL(endpoint);
  for (const [name, value] of [
    ["serviceKey", "[서비스키값]"], ["format", "xml"], ["railOprIsttCd", "OP"],
    ["lnCd", "L1"], ["stinCd", "S1"], ["nextStinCd", "S2"],
  ]) sampleUrl.searchParams.set(name, value);
  return {
    providers: {
      kric: {
        credential: {
          env: "KRIC_SERVICE_KEY",
          length: SERVICE_KEY.length,
          characterClasses: ["digit", "lower", "symbol", "upper"],
          fingerprintAlgorithm: "sha256-12",
          fingerprint: null,
        },
        controlOperation: {
          candidateId: SOURCE_ID,
          endpoint,
          sampleUrl: sampleUrl.href,
          expectedSuccess: { minimumRowCount: 1, requiredFields: ["mvPathMgNo"] },
          verifiedAt: "2026-08-14",
        },
        credentialSignalResultCodes: ["20"],
      },
    },
    candidates: [{
      id: SOURCE_ID,
      requestUrl: endpoint,
      evidence: {
        endpoint,
        sampleUrl: sampleUrl.href,
        formats: ["JSON", "XML"],
        outputFields: [
          "edMovePath", "elvtSttCd", "elvtTpCd", "exitMvTpOrdr",
          "imgPath", "mvContDtl", "mvPathMgNo", "stMovePath",
        ],
      },
      operation: { endpoint },
    }],
  };
}

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
  return planKricExitPathCollection({
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
  });
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
