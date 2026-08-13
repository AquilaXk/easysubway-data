import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  main,
} from "./collect-current-kric-exit-path-provider-snapshot.mjs";
import { canonicalKricExitPathProviderSnapshotJson } from "./collect-kric-exit-path-provider-snapshot.mjs";
import {
  canonicalKricExitPathCollectionPlanJson,
  planKricExitPathCollection,
} from "./plan-kric-exit-path-collection.mjs";

const SERVICE_KEY = "aA1!".repeat(15);
const CAPTURED_AT = new Date("2026-08-14T00:00:00.000Z");

test("tracked CLI는 catalog-bound plan을 serial raw snapshot으로 RUNNER_TEMP에 원자 기록한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-exit-live-cli-"));
  try {
    const planPath = path.join(directory, "plan.json");
    const output = path.join(directory, "snapshot.json");
    const plan = validPlan();
    await writeFile(planPath, canonicalKricExitPathCollectionPlanJson(plan));
    let active = 0;
    let maxActive = 0;
    const calls = [];
    const logs = [];

    const snapshot = await main(cliArgs(planPath, output), {
      env: { KRIC_SERVICE_KEY: SERVICE_KEY, RUNNER_TEMP: directory },
      fetchImpl: async (url) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(new URL(url));
        await Promise.resolve();
        active -= 1;
        return jsonResponse(providerSuccess([]));
      },
      log: (message) => logs.push(message),
      now: CAPTURED_AT,
      delayImpl: async () => {},
    });

    assert.equal(calls.length, plan.queryPlan.length);
    assert.equal(maxActive, 1);
    assert.ok(calls.every((url) => url.origin === "https://openapi.kric.go.kr"));
    assert.deepEqual(calls.map((url) => url.searchParams.get("stinCd")), ["S1", "S2"]);
    assert.equal(await readFile(output, "utf8"), canonicalKricExitPathProviderSnapshotJson(snapshot));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(logs, [`current KRIC EXIT raw snapshot ready: ${JSON.stringify({
      result: "PASS",
      sourceId: "kric-station-movement-standard",
      queryCount: 2,
      resultCount: 2,
      resultStateCounts: {
        EXPLICIT_ZERO: 2,
        PROVIDER_NO_DATA: 0,
        PROVIDER_RESULT_UNVERIFIED: 0,
        ROWS_OBSERVED: 0,
      },
      snapshotDigest: snapshot.snapshotDigest,
      capturedAt: snapshot.capturedAt,
      freshUntil: snapshot.freshUntil,
    })}`]);
    assert.doesNotMatch(logs[0], new RegExp(SERVICE_KEY));
    assert.doesNotMatch(await readFile(output, "utf8"), new RegExp(SERVICE_KEY));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog, credential, RUNNER_TEMP와 canonical plan drift는 provider call 전에 거부한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-exit-live-preflight-"));
  const outside = await mkdtemp(path.join(tmpdir(), "easysubway-exit-live-outside-"));
  try {
    const planPath = path.join(directory, "plan.json");
    const nonCanonicalPlan = path.join(directory, "pretty-plan.json");
    const planSymlink = path.join(directory, "plan-link.json");
    await writeFile(planPath, canonicalKricExitPathCollectionPlanJson(validPlan()));
    await writeFile(nonCanonicalPlan, JSON.stringify(validPlan(), null, 2));
    await symlink(planPath, planSymlink);
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(providerSuccess([]));
    };
    const cases = [{
      label: "credential",
      args: cliArgs(planPath, path.join(directory, "credential.json")),
      env: { KRIC_SERVICE_KEY: "wrong", RUNNER_TEMP: directory },
      document: candidatesDocument(),
      expected: /credential length|credential character classes/,
    }, {
      label: "catalog endpoint",
      args: cliArgs(planPath, path.join(directory, "catalog.json")),
      env: { KRIC_SERVICE_KEY: SERVICE_KEY, RUNNER_TEMP: directory },
      document: candidatesDocument({ endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl" }),
      expected: /source catalog mismatch/,
    }, {
      label: "outside output",
      args: cliArgs(planPath, path.join(outside, "outside.json")),
      env: { KRIC_SERVICE_KEY: SERVICE_KEY, RUNNER_TEMP: directory },
      document: candidatesDocument(),
      expected: /output must be a direct RUNNER_TEMP child/,
    }, {
      label: "non-canonical plan",
      args: cliArgs(nonCanonicalPlan, path.join(directory, "noncanonical.json")),
      env: { KRIC_SERVICE_KEY: SERVICE_KEY, RUNNER_TEMP: directory },
      document: candidatesDocument(),
      expected: /collection plan must be canonical JSON/,
    }, {
      label: "symlink plan",
      args: cliArgs(planSymlink, path.join(directory, "symlink-input.json")),
      env: { KRIC_SERVICE_KEY: SERVICE_KEY, RUNNER_TEMP: directory },
      document: candidatesDocument(),
      expected: /collection-plan must be a regular file/,
    }];

    for (const entry of cases) {
      await assert.rejects(() => main(entry.args, {
        candidatesDocument: entry.document,
        env: entry.env,
        fetchImpl,
        now: CAPTURED_AT,
      }), entry.expected, entry.label);
    }
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("provider 중간 실패는 retry와 partial output 없이 종료한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-exit-live-failure-"));
  try {
    const planPath = path.join(directory, "plan.json");
    const output = path.join(directory, "snapshot.json");
    await writeFile(planPath, canonicalKricExitPathCollectionPlanJson(validPlan()));
    let calls = 0;
    await assert.rejects(() => main(cliArgs(planPath, output), {
      candidatesDocument: candidatesDocument(),
      env: { KRIC_SERVICE_KEY: SERVICE_KEY, RUNNER_TEMP: directory },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 2) throw new Error(`must not leak ${SERVICE_KEY}`);
        return jsonResponse(providerSuccess([]));
      },
      now: CAPTURED_AT,
      delayImpl: async () => {},
    }), (error) => {
      assert.match(error.message, /KRIC EXIT request failed/);
      assert.doesNotMatch(error.message, new RegExp(SERVICE_KEY));
      return true;
    });
    assert.equal(calls, 2);
    await assert.rejects(() => readFile(output), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("snapshot write 실패는 final과 staging partial output을 남기지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-exit-live-write-failure-"));
  try {
    const planPath = path.join(directory, "plan.json");
    const output = path.join(directory, "snapshot.json");
    await writeFile(planPath, canonicalKricExitPathCollectionPlanJson(validPlan()));

    await assert.rejects(() => main(cliArgs(planPath, output), {
      candidatesDocument: candidatesDocument(),
      env: { KRIC_SERVICE_KEY: SERVICE_KEY, RUNNER_TEMP: directory },
      fetchImpl: async () => jsonResponse(providerSuccess([])),
      now: CAPTURED_AT,
      delayImpl: async () => {},
      writeFileImpl: async (target, bytes, options) => {
        await writeFile(target, bytes.subarray(0, 32), options);
        throw new Error("injected snapshot write failure");
      },
    }), /injected snapshot write failure/);

    await assert.rejects(() => readFile(output), { code: "ENOENT" });
    assert.deepEqual(await readdir(directory), ["plan.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing 또는 symlink output과 unbounded CLI option은 network 전에 실패한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-exit-live-output-"));
  try {
    const planPath = path.join(directory, "plan.json");
    const existing = path.join(directory, "existing.json");
    const link = path.join(directory, "link.json");
    await writeFile(planPath, canonicalKricExitPathCollectionPlanJson(validPlan()));
    await writeFile(existing, "preserve");
    await symlink(existing, link);
    let calls = 0;
    const dependencies = {
      candidatesDocument: candidatesDocument(),
      env: { KRIC_SERVICE_KEY: SERVICE_KEY, RUNNER_TEMP: directory },
      fetchImpl: async () => { calls += 1; return jsonResponse(providerSuccess([])); },
      now: CAPTURED_AT,
    };
    await assert.rejects(() => main(cliArgs(planPath, existing), dependencies), /output must be absent/);
    await assert.rejects(() => main(cliArgs(planPath, link), dependencies), /output must be absent/);
    await assert.rejects(() => main([
      ...cliArgs(planPath, path.join(directory, "timeout.json")),
      "--request-timeout-ms", "60001",
    ], dependencies), /arguments mismatch|timeout is invalid/);
    assert.equal(calls, 0);
    assert.equal(await readFile(existing, "utf8"), "preserve");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function cliArgs(planPath, output) {
  return [
    "--collection-plan", planPath,
    "--source-id", "kric-station-movement-standard",
    "--output", output,
    "--request-interval-ms", "0",
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
          candidateId: "kric-station-movement-standard",
          endpoint,
          sampleUrl: sampleUrl.href,
          expectedSuccess: { minimumRowCount: 1, requiredFields: ["mvPathMgNo"] },
          verifiedAt: "2026-08-14",
        },
        credentialSignalResultCodes: ["20"],
      },
    },
    candidates: [{
      id: "kric-station-movement-standard",
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
      operation: {
        endpoint,
      },
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

function providerSuccess(rows) {
  return JSON.stringify({ header: { resultCode: "00", resultMsg: "NORMAL SERVICE" }, body: rows });
}

function jsonResponse(raw) {
  return new Response(raw, { status: 200, headers: { "content-type": "application/json" } });
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
