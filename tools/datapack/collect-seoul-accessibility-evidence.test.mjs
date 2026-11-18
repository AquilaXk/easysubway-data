import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildAccessibilitySnapshot,
  collectSeoulAccessibility,
  collectSeoulAccessibilityObservation,
  normalizeAccessibilityRows,
  seoulObservationOutputRoot,
  validateSeoulAccessibilityObservation,
  writeSeoulAccessibilityEvidence,
  writeSeoulAccessibilityObservation,
} from "./collect-seoul-accessibility-evidence.mjs";

const execFileAsync = promisify(execFile);
const collectorPath = fileURLToPath(new URL("./collect-seoul-accessibility-evidence.mjs", import.meta.url));

test("Seoul accessibility collector는 유효한 endpoint·source에서 malformed credential을 URL·provider 호출 전에 거부한다", async () => {
  let calls = 0;
  await assert.rejects(collectSeoulAccessibility({ endpoint: "https://apis.data.go.kr/example", serviceKey: "invalid%ZZ", fetchImpl: async () => { calls += 1; } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});

test("collector rejects non-HTTPS endpoints", async () => {
  await assert.rejects(
    collectSeoulAccessibility({ endpoint: "http://apis.data.go.kr", serviceKey: "secret" }),
    /HTTPS endpoint is required/,
  );
});

test("collector rejects unknown sources before fetching", async () => {
  let fetched = false;
  for (const source of ["other", "toString", "constructor"]) {
    await assert.rejects(
      collectSeoulAccessibility({
        endpoint: "https://apis.data.go.kr/example",
        serviceKey: "secret",
        source,
        fetchImpl: async () => {
          fetched = true;
        },
      }),
      /Seoul accessibility API response invalid: source/,
    );
  }
  assert.equal(fetched, false);
});

test("collector redacts request details from network failures", async () => {
  await assert.rejects(
    collectSeoulAccessibility({
      endpoint: "https://apis.data.go.kr/example",
      serviceKey: "secret",
      fetchImpl: async (url) => {
        throw new Error(String(url));
      },
    }),
    (error) => {
      assert.match(error.message, /Seoul accessibility API request failed/);
      assert.doesNotMatch(error.message, /secret|https?:\/\//);
      return true;
    },
  );
});

test("collector classifies fetch rejections with closed redaction-safe transport codes", async () => {
  const endpoint = "https://apis.data.go.kr/example";
  const serviceKey = "secret";
  const cases = [
    ["NETWORK_DNS", new Error(`${endpoint}?serviceKey=${serviceKey}`, { cause: { code: "ENOTFOUND" } })],
    ["NETWORK_TLS", Object.assign(new Error(`${endpoint}?serviceKey=${serviceKey}`), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })],
    ["NETWORK_TIMEOUT", new Error(`${endpoint}?serviceKey=${serviceKey}`, { cause: { name: "TimeoutError" } })],
    ["NETWORK_SOCKET", new Error(`${endpoint}?serviceKey=${serviceKey}`, { cause: { code: "ECONNRESET" } })],
    ["NETWORK_UNKNOWN", new Error(`${endpoint}?serviceKey=${serviceKey}`)],
  ];
  for (const [transportCode, failure] of cases) {
    await assert.rejects(
      collectSeoulAccessibility({
        endpoint,
        serviceKey,
        requestAttempts: 1,
        fetchImpl: async () => { throw failure; },
      }),
      (error) => {
        assert.equal(error.message, `Seoul accessibility API request failed: ${transportCode}`);
        assert.doesNotMatch(error.message, /secret|https?:\/\/|ENOTFOUND|ERR_TLS|TimeoutError|ECONNRESET/);
        return true;
      },
    );
  }
});

test("facility-location collector does not retry network failures", async () => {
  let calls = 0;
  await assert.rejects(
    collectSeoulAccessibility({
      endpoint: "https://apis.data.go.kr/B553766/facility/getFcElvtr",
      serviceKey: "secret",
      source: "facility-location",
      fetchImpl: async () => {
        calls += 1;
        throw new Error("provider unavailable");
      },
    }),
    /Seoul accessibility API request failed/,
  );
  assert.equal(calls, 1);
});

test("facility-location collector does not retry HTTP 5xx responses", async () => {
  let calls = 0;
  await assert.rejects(
    collectSeoulAccessibility({
      endpoint: "https://apis.data.go.kr/B553766/facility/getFcElvtr",
      serviceKey: "secret",
      source: "facility-location",
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 503, text: async () => "unavailable" };
      },
    }),
    /Seoul accessibility API HTTP 503/,
  );
  assert.equal(calls, 1);
});

test("scheduled Seoul accessibility collection accepts an explicit single-attempt contract", async () => {
  let calls = 0;
  await assert.rejects(
    collectSeoulAccessibility({
      endpoint: "https://apis.data.go.kr/example",
      serviceKey: "secret",
      requestAttempts: 1,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("provider unavailable");
      },
    }),
    /Seoul accessibility API request failed/,
  );
  assert.equal(calls, 1);
});

test("collector aborts stalled provider requests after the configured timeout", async () => {
  let observedAbortSignal = false;
  await assert.rejects(
    collectSeoulAccessibility({
      endpoint: "https://apis.data.go.kr/example",
      serviceKey: "secret",
      requestTimeoutMs: 1,
      sleepImpl: async () => {},
      logImpl: () => {},
      fetchImpl: async (_url, options) => {
        const signal = options?.signal;
        observedAbortSignal = signal instanceof AbortSignal;
        if (!signal) {
          throw new Error("missing abort signal");
        }
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    }),
    /Seoul accessibility API request failed/,
  );
  assert.equal(observedAbortSignal, true);
});

test("collector rejects HTTP 403 before reading the response body", async () => {
  let bodyRead = false;
  await assert.rejects(
    collectSeoulAccessibility({
      endpoint: "https://apis.data.go.kr/example",
      serviceKey: "secret",
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        text: async () => {
          bodyRead = true;
          throw new Error("serviceKey=secret raw body");
        },
      }),
    }),
    /Seoul accessibility API HTTP 403/,
  );
  assert.equal(bodyRead, false);
});

test("collector redacts raw body and request details from invalid JSON", async () => {
  await assert.rejects(
    collectSeoulAccessibility({
      endpoint: "https://apis.data.go.kr/example",
      serviceKey: "secret",
      fetchImpl: async () => ({
        ok: true,
        text: async () => {
          throw new Error("raw body https://apis.data.go.kr/example?serviceKey=secret");
        },
      }),
    }),
    (error) => {
      assert.equal(error.message, "Seoul accessibility API response invalid");
      assert.doesNotMatch(error.message, /raw body|secret|https?:\/\//);
      return true;
    },
  );
});

test("collector rejects API-level error envelopes without exposing the provider message", async () => {
  await assert.rejects(
    collectSeoulAccessibility({
      endpoint: "https://apis.data.go.kr/example",
      serviceKey: "secret",
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify({
          response: {
            header: { resultCode: "99", resultMsg: "serviceKey=secret raw provider message" },
            body: {
              items: {
                item: [{ lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실-승강장" }],
              },
            },
          },
        }),
      }),
    }),
    (error) => {
      assert.equal(error.message, "Seoul accessibility API response invalid: envelope");
      assert.doesNotMatch(error.message, /secret|provider message/);
      return true;
    },
  );
});

test("collector rejects malformed items with a fixed credential-free error", async () => {
  await assert.rejects(
    collectSeoulAccessibility({
      endpoint: "https://apis.data.go.kr/example",
      serviceKey: "secret",
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify({
          response: {
            header: { resultCode: "00" },
            body: { items: { item: { reflected: "serviceKey=secret" } } },
          },
        }),
      }),
    }),
    (error) => {
      assert.equal(error.message, "Seoul accessibility API response invalid: items");
      assert.doesNotMatch(error.message, /secret|rows\.map/);
      return true;
    },
  );
});

test("full-scope collector는 station filter 없이 pagination total을 보존한다", async () => {
  const requestUrls = [];
  const { rows, rawRowCount, rawSha256 } = await collectSeoulAccessibility({
    endpoint: "https://apis.data.go.kr/example",
    serviceKey: "secret",
    fetchImpl: async (url) => {
      requestUrls.push(new URL(url));
      return {
        ok: true,
        text: async () => JSON.stringify({
          response: {
            header: { resultCode: "00" },
            body: {
              totalCount: 3,
              items: { item: [
                { lineNm: "1호선", stnNm: "서울역", oprtngSitu: "M", dtlPstn: "대합실-승강장" },
                { lineNm: "4호선", stnNm: "사당", oprtngSitu: "S", dtlPstn: "출입구-대합실" },
                { lineNm: "4호선", stnNm: "폐기", oprtngSitu: "D", dtlPstn: "삭제 시설" },
              ] },
            },
          },
        }),
      };
    },
  });

  assert.equal(rows.length, 2);
  assert.equal(rawRowCount, 3);
  assert.match(rawSha256, /^[0-9a-f]{64}$/);
  assert.equal(requestUrls.length, 1);
  assert.equal(requestUrls[0].searchParams.has("lineNm"), false);
  assert.equal(requestUrls[0].searchParams.has("stnNm"), false);
  assert.equal(requestUrls[0].searchParams.get("pageNo"), "1");
  assert.equal(requestUrls[0].searchParams.get("numOfRows"), "1000");
});

test("collector pagination은 다중 page만 허용하고 불완전·빈 전수응답을 거부한다", async () => {
  const row = (stationName) => ({
    lineNm: "4호선", stnNm: stationName, oprtngSitu: "M", dtlPstn: "대합실-승강장",
  });
  const response = (totalCount, rows) => ({
    ok: true,
    text: async () => JSON.stringify({
      response: { header: { resultCode: "00" }, body: { totalCount, items: { item: rows } } },
    }),
  });
  const collect = (pages, pageNumbers = []) => collectSeoulAccessibility({
    endpoint: "https://apis.data.go.kr/example",
    serviceKey: "secret",
    fetchImpl: async (url) => {
      const pageNo = Number(new URL(url).searchParams.get("pageNo"));
      pageNumbers.push(pageNo);
      return pages[pageNo - 1];
    },
  });

  const pageNumbers = [];
  const result = await collect([response(2, [row("사당")]), response(2, [row("서울역")])], pageNumbers);
  assert.deepEqual(pageNumbers, [1, 2]);
  assert.equal(result.rows.length, 2);
  await assert.rejects(collect([response(2, [row("사당")]), response(3, [row("서울역")])]), /invalid: totalCount/);
  await assert.rejects(collect([response(1, [row("사당"), row("서울역")])]), /invalid: pagination/);
  await assert.rejects(collect([response(2, [row("사당")]), response(2, [])]), /invalid: pagination/);
  await assert.rejects(
    collect([response(2, [row("사당")]), response(2, [row("사당")])]),
    /invalid: pagination/,
  );
  await assert.rejects(
    collect([
      response(4, [row("사당"), row("서울역")]),
      response(4, [row("서울역"), row("사당")]),
    ]),
    /invalid: pagination/,
  );
  await assert.rejects(collect([response(0, [])]), /invalid: emptyExhaustiveList/);
});

test("collector는 normalized content와 별도로 raw pagination identity를 보존한다", async () => {
  const payload = (deletedPath) => ({
    response: {
      header: { resultCode: "00" },
      body: {
        totalCount: 2,
        items: { item: [
          { lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실-승강장" },
          { lineNm: "4호선", stnNm: "폐기", oprtngSitu: "D", dtlPstn: deletedPath },
        ] },
      },
    },
  });
  const collect = async (deletedPath) => collectSeoulAccessibility({
    endpoint: "https://apis.data.go.kr/example",
    serviceKey: "secret",
    fetchImpl: async () => {
      const body = JSON.stringify(payload(deletedPath));
      return { ok: true, json: async () => JSON.parse(body), text: async () => body };
    },
  });

  const first = await collect("삭제 시설 A");
  const second = await collect("삭제 시설 B");

  assert.equal(first.rawRowCount, 2);
  // anti-cheat-allow: circular-oracle -- 무관한 필드 변경 또는 비변경 상황에서 기존 식별자/바이트 불변성(invariance) 검증
  assert.deepEqual(first.rows, second.rows);
  assert.notEqual(first.rawSha256, second.rawSha256);
});

test("collector keeps only station, location and operation evidence", () => {
  const snapshot = normalizeAccessibilityRows([
    { lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실-승강장" },
  ]);
  assert.deepEqual(snapshot, [
    { stationName: "사당", lineName: "4호선", operational: true, situationCode: "M", situation: "사용가능", pathDescription: "대합실-승강장" },
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey/);
});

test("normalizer stores trimmed provider identity values", () => {
  assert.deepEqual(normalizeAccessibilityRows([
    { lineNm: " 4호선 ", stnNm: " 사당 ", oprtngSitu: "M", dtlPstn: " 대합실-승강장 " },
  ]), [{
    stationName: "사당",
    lineName: "4호선",
    operational: true,
    situationCode: "M",
    situation: "사용가능",
    pathDescription: "대합실-승강장",
  }]);
});

test("normalizer records verified non-available maintenance states", () => {
  assert.deepEqual(
    normalizeAccessibilityRows([
      { lineNm: "4호선", stnNm: "사당", oprtngSitu: "S", dtlPstn: "9,10번 출입구 사이" },
    ]),
    [
      {
        stationName: "사당",
        lineName: "4호선",
        operational: false,
        situationCode: "S",
        situation: "보수중",
        pathDescription: "9,10번 출입구 사이",
      },
    ],
  );
});

test("normalizer drops deleted (D) facility rows without failing", () => {
  assert.deepEqual(
    normalizeAccessibilityRows([
      { lineNm: "4호선", stnNm: "사당", oprtngSitu: "D", dtlPstn: "폐기 승강기" },
      { lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실-승강장" },
    ]),
    [
      {
        stationName: "사당",
        lineName: "4호선",
        operational: true,
        situationCode: "M",
        situation: "사용가능",
        pathDescription: "대합실-승강장",
      },
    ],
  );
});

test("normalizer rejects undocumented operation codes", () => {
  assert.throws(
    () =>
      normalizeAccessibilityRows([
        { lineNm: "4호선", stnNm: "상록수", oprtngSitu: "Y", dtlPstn: "1번 출구-대합실" },
      ]),
    /Seoul accessibility API response invalid/,
  );
});

test("normalizer preserves provider rows with a missing operation state as unverified", () => {
  assert.deepEqual(
    normalizeAccessibilityRows([
      { lineNm: "4호선", stnNm: "사당", dtlPstn: "대합실-승강장" },
    ]),
    [{
      stationName: "사당",
      lineName: "4호선",
      operational: null,
      situationCode: null,
      situation: "PROVIDER_STATUS_MISSING",
      pathDescription: "대합실-승강장",
    }],
  );
});

test("normalizer rejects malformed and incomplete evidence rows", () => {
  const valid = { lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실-승강장" };
  for (const row of [
    null,
    { ...valid, lineNm: undefined },
    { ...valid, lineNm: 4 },
    { ...valid, stnNm: undefined },
    { ...valid, stnNm: 123 },
    { ...valid, dtlPstn: undefined },
    { ...valid, dtlPstn: 123 },
    { ...valid, oprtngSitu: 123 },
  ]) {
    assert.throws(() => normalizeAccessibilityRows([row]), /Seoul accessibility API response invalid/);
  }
});

test("snapshot contains sorted full-scope evidence and hashes", () => {
  const snapshot = buildAccessibilitySnapshot(
    [
      { stationName: "사당", lineName: "4호선", operational: true, situationCode: "M", situation: "사용가능", pathDescription: "대합실-승강장" },
      { stationName: "상록수", lineName: "4호선", operational: false, situationCode: "S", situation: "보수중", pathDescription: "1번 출구-대합실" },
    ],
    "2026-07-10T00:00:00.000Z",
    { rawRowCount: 2, rawSha256: "a".repeat(64) },
  );

  assert.equal(snapshot.sourceId, "seoul-metro-accessibility");
  assert.equal(snapshot.snapshotId, "seoul-metro-accessibility-20260710T000000000Z");
  assert.equal(snapshot.observedAt, "2026-07-10T00:00:00.000Z");
  assert.match(snapshot.schemaFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.capturedAt, "2026-07-10T00:00:00.000Z");
  assert.equal(snapshot.freshUntil, "2026-07-11T00:00:00.000Z");
  assert.equal(snapshot.rowCount, 2);
  assert.match(snapshot.rawSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(snapshot.contentSha256, snapshot.rawSha256);
  assert.deepEqual(snapshot.stations.map(({ stationName }) => stationName), ["사당", "상록수"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey|https?:\/\//);
});

test("facility-location snapshot preserves the provider station code under a distinct source identity", () => {
  const rows = normalizeAccessibilityRows(
    [{ lineNm: "2호선", stnNm: "신정네거리", stnCd: "0249", oprtngSitu: "M", dtlPstn: "대합실-승강장" }],
    { source: "facility-location" },
  );
  const snapshot = buildAccessibilitySnapshot(
    rows,
    "2026-07-29T00:00:00.000Z",
    { source: "facility-location", rawRowCount: 1, rawSha256: "a".repeat(64) },
  );

  assert.equal(snapshot.sourceId, "seoul-metro-facility-location");
  assert.equal(snapshot.artifactKind, "seoul-facility-location-snapshot");
  assert.equal(snapshot.snapshotId, "seoul-metro-facility-location-20260729T000000000Z");
  assert.equal(snapshot.stations[0].providerStationCode, "0249");
});

test("facility-location snapshot identity is stable for duplicate station names with distinct codes", () => {
  const rows = normalizeAccessibilityRows([
    { lineNm: "2호선", stnNm: "환승역", stnCd: "0202", oprtngSitu: "M", dtlPstn: "2번" },
    { lineNm: "2호선", stnNm: "환승역", stnCd: "0201", oprtngSitu: "M", dtlPstn: "1번" },
  ], { source: "facility-location" });
  const build = (input) => buildAccessibilitySnapshot(input, "2026-07-29T00:00:00.000Z", {
    source: "facility-location",
    rawRowCount: 2,
    rawSha256: "a".repeat(64),
  });

  assert.deepEqual(build(rows).stations, build([...rows].reverse()).stations);
  assert.equal(build(rows).contentSha256, build([...rows].reverse()).contentSha256);
});

test("facility-location collection rejects endpoint overrides before fetching", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "easysubway-facility-location-endpoint-"));
  let fetched = false;
  try {
    await assert.rejects(
      collectSeoulAccessibility({
        endpoint: "https://apis.data.go.kr/example",
        serviceKey: "secret",
        source: "facility-location",
        fetchImpl: async () => {
          fetched = true;
          throw new Error("must not fetch");
        },
      }),
      /endpoint/,
    );
    await assert.rejects(
      writeSeoulAccessibilityEvidence({
        endpoint: "https://apis.data.go.kr/example",
        serviceKey: "secret",
        source: "facility-location",
        output: "unused.json",
        outputRoot,
        fetchImpl: async () => {
          fetched = true;
          throw new Error("must not fetch");
        },
      }),
      /endpoint/,
    );
    assert.equal(fetched, false);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("same-day captures keep distinct timestamped files and explicit lineage", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "easysubway-seoul-snapshots-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      response: {
        header: { resultCode: "00" },
        body: {
          totalCount: 1,
          items: { item: [{ lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실-승강장" }] },
        },
      },
    }),
  });
  const first = await writeSeoulAccessibilityEvidence({
    endpoint: "https://apis.data.go.kr/example",
    serviceKey: "secret",
    output: "snapshots",
    outputRoot,
    fetchImpl,
    retrievedAt: "2026-07-28T15:35:25.704Z",
  });
  const firstPath = join(outputRoot, "snapshots", `${first.snapshotId}.json`);
  const firstBytes = await readFile(firstPath, "utf8");

  const second = await writeSeoulAccessibilityEvidence({
    endpoint: "https://apis.data.go.kr/example",
    serviceKey: "secret",
    output: "snapshots",
    outputRoot,
    fetchImpl,
    retrievedAt: "2026-07-28T16:35:25.704Z",
    previousSnapshot: first,
  });

  assert.equal(first.snapshotId, "seoul-metro-accessibility-20260728T153525704Z");
  assert.equal(second.snapshotId, "seoul-metro-accessibility-20260728T163525704Z");
  // anti-cheat-allow: circular-oracle -- 입력 스냅샷의 계통(lineage) 및 출처 식별자 보존 검증
  assert.equal(second.previousSnapshotId, first.snapshotId);
  assert.equal(await readFile(firstPath, "utf8"), firstBytes);
  await access(join(outputRoot, "snapshots", `${second.snapshotId}.json`));

  const rows = normalizeAccessibilityRows([
    { lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실-승강장" },
  ]);
  for (const previousSnapshot of [
    { ...first, snapshotId: "seoul-metro-accessibility-20260728T010203004Z" },
    {
      ...first,
      snapshotId: "seoul-metro-accessibility-20260728T183525704Z",
      retrievedAt: "2026-07-28T18:35:25.704Z",
    },
  ]) {
    assert.throws(
      () => buildAccessibilitySnapshot(rows, "2026-07-28T17:35:25.704Z", {
        rawRowCount: 1,
        rawSha256: "a".repeat(64),
        previousSnapshot,
      }),
      /snapshotIdentity/,
    );
  }
});

test("fresh Seoul observation은 snapshot·raw pages·manifest를 한 create-only directory에 결속한다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "easysubway-seoul-observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputRoot = join(root, "observation");
  const providerBody = JSON.stringify({
    response: {
      header: { resultCode: "00" },
      body: {
        totalCount: 1,
        items: { item: [{ lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실-승강장" }] },
      },
    },
  });
  const observation = await collectSeoulAccessibilityObservation({
    endpoint: "https://apis.data.go.kr/example",
    serviceKey: "secret-must-not-appear",
    retrievedAt: "2026-08-14T00:00:00.000Z",
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => providerBody }),
  });
  const manifest = await writeSeoulAccessibilityObservation({ outputRoot, observation });
  const files = (await readdir(outputRoot)).sort();
  assert.deepEqual(files, [manifest.rawArtifactFile, manifest.snapshotFile, "observation.json"].sort());
  const snapshotBytes = await readFile(join(outputRoot, manifest.snapshotFile));
  const rawBytes = await readFile(join(outputRoot, manifest.rawArtifactFile));
  assert.equal(createHash("sha256").update(snapshotBytes).digest("hex"), manifest.snapshotFileSha256);
  assert.equal(createHash("sha256").update(rawBytes).digest("hex"), manifest.rawObjectSha256);
  assert.equal(rawBytes.includes(Buffer.from("secret-must-not-appear")), false);
  assert.equal(JSON.parse(rawBytes).responses[0].bodyBase64, Buffer.from(providerBody).toString("base64"));
  await assert.rejects(
    writeSeoulAccessibilityObservation({ outputRoot, observation }),
    /output root already exists/,
  );
});

test("#834 facility-location observation은 stnCd를 보존한 snapshot·키 없는 raw·manifest를 결속하고 원문으로 재현한다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "easysubway-seoul-facility-observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputRoot = join(root, "observation");
  const providerBody = JSON.stringify({
    response: {
      header: { resultCode: "00" },
      body: {
        totalCount: 2,
        items: { item: [
          { lineNm: "2호선", stnNm: "시청", stnCd: "0201", oprtngSitu: "M", dtlPstn: "9번 출입구" },
          { lineNm: "2호선", stnNm: "시청", stnCd: "0201", oprtngSitu: "S", dtlPstn: "을지로입구 방면2-3" },
        ] },
      },
    },
  });
  const fetched = [];
  const observation = await collectSeoulAccessibilityObservation({
    source: "facility-location",
    serviceKey: "secret-must-not-appear",
    retrievedAt: "2026-09-30T01:02:03.004Z",
    fetchImpl: async (url) => {
      fetched.push(new URL(url).pathname);
      return { ok: true, status: 200, text: async () => providerBody };
    },
  });
  assert.deepEqual(fetched, ["/B553766/facility/getFcElvtr"]);
  const manifest = await writeSeoulAccessibilityObservation({ outputRoot, observation, source: "facility-location" });
  assert.deepEqual((await readdir(outputRoot)).sort(), [
    "observation.json",
    "seoul-metro-facility-location-20260930T010203004Z.json",
    "seoul-metro-facility-location-20260930T010203004Z.raw.json",
  ]);
  const snapshotBytes = await readFile(join(outputRoot, manifest.snapshotFile));
  const rawArtifactBytes = await readFile(join(outputRoot, manifest.rawArtifactFile));
  assert.equal(rawArtifactBytes.includes(Buffer.from("secret-must-not-appear")), false);
  assert.equal(JSON.parse(rawArtifactBytes).responses[0].bodyBase64, Buffer.from(providerBody).toString("base64"));
  const snapshot = validateSeoulAccessibilityObservation({
    observation: manifest, snapshotBytes, rawArtifactBytes, source: "facility-location",
  });
  assert.equal(snapshot.sourceId, "seoul-metro-facility-location");
  assert.equal(snapshot.capturedAt, "2026-09-30T01:02:03.004Z");
  assert.equal(snapshot.rowCount, 2);
  assert.deepEqual(snapshot.stations, [{
    stationName: "시청",
    lineName: "2호선",
    providerStationCode: "0201",
    facilities: [
      { operational: false, situationCode: "S", situation: "보수중", pathDescription: "을지로입구 방면2-3" },
      { operational: true, situationCode: "M", situation: "사용가능", pathDescription: "9번 출입구" },
    ],
  }]);
  const tampered = JSON.parse(rawArtifactBytes);
  tampered.responses[0].bodyBase64 = Buffer.from(providerBody.replace("9번 출입구", "8번 출입구")).toString("base64");
  const tamperedBytes = Buffer.from(`${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => validateSeoulAccessibilityObservation({
    observation: {
      ...manifest,
      rawObjectSha256: createHash("sha256").update(tamperedBytes).digest("hex"),
      rawObjectChecksumSha256: createHash("sha256").update(tamperedBytes).digest("base64"),
      rawObjectByteSize: tamperedBytes.length,
    },
    snapshotBytes, rawArtifactBytes: tamperedBytes, source: "facility-location",
  }), /raw collection is invalid/);
  assert.throws(() => validateSeoulAccessibilityObservation({
    observation: manifest, snapshotBytes, rawArtifactBytes: tamperedBytes, source: "facility-location",
  }), /observation manifest mismatch/);
});

test("raw observation은 URL·JSON escape로 반사된 service key도 보존 전에 거부한다", async () => {
  const decodedKey = "abcdefghijklmnop+qr/stuvwxyz";
  const encodedKey = encodeURIComponent(decodedKey);
  const baseBody = JSON.stringify({
    response: {
      header: { resultCode: "00", credentialEcho: "REFLECTED_KEY" },
      body: {
        totalCount: 1,
        items: { item: [{ lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실-승강장" }] },
      },
    },
  });
  for (const reflected of [encodedKey, decodedKey.replaceAll("+", "\\u002b").replaceAll("/", "\\/")]) {
    await assert.rejects(
      collectSeoulAccessibilityObservation({
        endpoint: "https://apis.data.go.kr/example",
        serviceKey: encodedKey,
        retrievedAt: "2026-08-14T00:00:00.000Z",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => baseBody.replace("REFLECTED_KEY", reflected),
        }),
      }),
      /Seoul accessibility API response invalid/,
    );
  }
});

test("Seoul observation CLI output은 canonical temp root 아래 safe name으로만 구성한다", async () => {
  const output = await seoulObservationOutputRoot("capture-20260814T000000Z");
  assert.equal(output.startsWith(`${await realpath(tmpdir())}/easysubway-seoul-accessibility-`), true);
  await assert.rejects(seoulObservationOutputRoot("../escape"), /directory name is invalid/);
});

test("snapshot content identity is stable when provider facility order changes", () => {
  const rows = [
    { stationName: "사당", lineName: "4호선", operational: true, situationCode: "M", situation: "사용가능", pathDescription: "9번 출구" },
    { stationName: "사당", lineName: "4호선", operational: false, situationCode: "S", situation: "보수중", pathDescription: "1번 출구" },
  ];
  const build = (input) => buildAccessibilitySnapshot(
    input,
    "2026-07-10T00:00:00.000Z",
    { rawRowCount: 2, rawSha256: "a".repeat(64) },
  );

  const first = build(rows);
  const reversed = build([...rows].reverse());

  assert.deepEqual(first.stations, reversed.stations);
  assert.equal(first.contentSha256, reversed.contentSha256);
});

test("accessibility snapshot ignores facility-only provider codes in station identity", () => {
  const snapshot = buildAccessibilitySnapshot([
    { stationName: "사당", lineName: "4호선", providerStationCode: "A", operational: true, situationCode: "M", situation: "사용가능", pathDescription: "1번" },
    { stationName: "사당", lineName: "4호선", providerStationCode: "B", operational: true, situationCode: "M", situation: "사용가능", pathDescription: "2번" },
  ], "2026-07-29T00:00:00.000Z", { rawRowCount: 2, rawSha256: "a".repeat(64) });

  assert.equal(snapshot.stations.length, 1);
  assert.equal(snapshot.stations[0].facilities.length, 2);
});

test("snapshot rejects facilities without a verified or provider-missing status tuple", () => {
  const validSadang = {
    stationName: "사당",
    lineName: "4호선",
    operational: true,
    situationCode: "M",
    situation: "사용가능",
    pathDescription: "대합실-승강장",
  };
  assert.doesNotThrow(() => buildAccessibilitySnapshot([{
    ...validSadang,
    operational: null,
    situationCode: null,
    situation: "PROVIDER_STATUS_MISSING",
  }], "2026-07-10T00:00:00.000Z", { rawRowCount: 1, rawSha256: "a".repeat(64) }));
  for (const row of [
    { ...validSadang, operational: undefined },
    { ...validSadang, operational: "Y" },
    { ...validSadang, situationCode: undefined },
    { ...validSadang, situationCode: "Y" },
    { ...validSadang, situation: undefined },
    { ...validSadang, pathDescription: undefined },
    { ...validSadang, pathDescription: 123 },
    { ...validSadang, stationName: undefined },
  ]) {
    assert.throws(
      () => buildAccessibilitySnapshot(
        [row],
        "2026-07-10T00:00:00.000Z",
        { rawRowCount: 1, rawSha256: "a".repeat(64) },
      ),
      /Seoul accessibility API response invalid/,
    );
  }
});

test("invalid provider evidence never reaches the output write", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "easysubway-accessibility-"));
  const valid = { lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실-승강장" };
  const jsonResponse = (item, resultCode = "00") => async () => ({
    ok: true,
    text: async () => JSON.stringify({ response: { header: { resultCode }, body: { items: { item } } } }),
  });
  const cases = [
    async () => ({ ok: false, status: 403 }),
    async () => ({
      ok: true,
      text: async () => {
        throw new Error("raw serviceKey=secret");
      },
    }),
    jsonResponse([valid], "99"),
    jsonResponse({ reflected: "serviceKey=secret" }),
    ...[
      null,
      { ...valid, lineNm: undefined },
      { ...valid, lineNm: 4 },
      { ...valid, stnNm: undefined },
      { ...valid, stnNm: 123 },
      { ...valid, dtlPstn: undefined },
      { ...valid, dtlPstn: 123 },
      { ...valid, oprtngSitu: 123 },
      { ...valid, oprtngSitu: "Y" },
    ].map((row) => jsonResponse([row])),
  ];

  try {
    for (const [index, fetchImpl] of cases.entries()) {
      const output = join(outputDir, `${index}.json`);
      await assert.rejects(
        writeSeoulAccessibilityEvidence({
          endpoint: "https://apis.data.go.kr/example",
          serviceKey: "secret",
          output,
          outputRoot: outputDir,
          fetchImpl,
          retrievedAt: "2026-07-10T00:00:00.000Z",
        }),
      );
      await assert.rejects(access(output), (error) => error.code === "ENOENT");
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("writer rejects output outside the allowed root before fetching", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "easysubway-accessibility-output-root-"));
  let fetched = false;
  try {
    await assert.rejects(
      writeSeoulAccessibilityEvidence({
        endpoint: "https://apis.data.go.kr/example",
        serviceKey: "secret",
        output: join(outputRoot, "..", "escaped-accessibility.json"),
        outputRoot,
        fetchImpl: async () => {
          fetched = true;
          throw new Error("must not fetch");
        },
      }),
      /output path must stay within allowed root/,
    );
    assert.equal(fetched, false);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("writer rejects an output path that escapes through a symlink", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "easysubway-accessibility-output-symlink-"));
  const outputRoot = join(workDir, "allowed");
  const outsideRoot = join(workDir, "outside");
  await mkdir(outputRoot);
  await mkdir(outsideRoot);
  await symlink(outsideRoot, join(outputRoot, "escape"));
  let fetched = false;
  try {
    await assert.rejects(
      writeSeoulAccessibilityEvidence({
        endpoint: "https://apis.data.go.kr/example",
        serviceKey: "secret",
        output: join(outputRoot, "escape", "evidence.json"),
        outputRoot,
        fetchImpl: async () => {
          fetched = true;
          throw new Error("must not fetch");
        },
      }),
      /output path must stay within allowed root/,
    );
    assert.equal(fetched, false);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("writer rejects an existing output file symlink before fetching", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "easysubway-accessibility-output-file-symlink-"));
  const outputRoot = join(workDir, "allowed");
  const outsideFile = join(workDir, "outside.json");
  const output = join(outputRoot, "evidence.json");
  await mkdir(outputRoot);
  await writeFile(outsideFile, "keep");
  await symlink(outsideFile, output);
  let fetched = false;
  try {
    await assert.rejects(
      writeSeoulAccessibilityEvidence({
        endpoint: "https://apis.data.go.kr/example",
        serviceKey: "secret",
        output,
        outputRoot,
        fetchImpl: async () => {
          fetched = true;
          throw new Error("must not fetch");
        },
      }),
      /output path must stay within allowed root/,
    );
    assert.equal(fetched, false);
    assert.equal(await readFile(outsideFile, "utf8"), "keep");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("CLI requires the service key before collection", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [collectorPath, "--output", "unused.json", "--output-root", tmpdir()],
      { env: {} },
    ),
    /DATA_GO_KR_SERVICE_KEY env is required/,
  );
});

test("CLI rejects unknown facility-location source modes before collection", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        collectorPath,
        "--output", "unused.json",
        "--output-root", tmpdir(),
        "--source", "other",
      ],
      { env: { DATA_GO_KR_SERVICE_KEY: "secret" } },
    ),
    /Seoul accessibility API response invalid: source/,
  );
});

test("seoul-metro-accessibility is admitted while sibling facility-location stays pending", async () => {
  const candidatesDocument = JSON.parse(
    await readFile(new URL("./source-candidates.json", import.meta.url), "utf8"),
  );
  const admitted = candidatesDocument.candidates.find((candidate) => candidate.id === "seoul-metro-accessibility");
  assert.deepEqual(
    {
      id: admitted?.id,
      domain: admitted?.domain,
      requestUrl: admitted?.requestUrl,
      admissionStatus: admitted?.admissionStatus,
      retrievedAt: admitted?.evidence?.retrievedAt,
      usePermissionRange: admitted?.evidence?.usePermissionRange,
    },
    {
      id: "seoul-metro-accessibility",
      domain: "accessibility_facilities",
      requestUrl: "https://apis.data.go.kr/B553766/wksn/getWksnElvtr",
      admissionStatus: "admitted_to_production_inventory",
      retrievedAt: "2026-07-10",
      usePermissionRange: "이용허락범위 제한 없음",
    },
  );

  const pending = candidatesDocument.candidates.find((candidate) => candidate.id === "seoul-metro-facility-location");
  assert.deepEqual(
    {
      id: pending?.id,
      domain: pending?.domain,
      requestUrl: pending?.requestUrl,
      admissionStatus: pending?.admissionStatus,
      retrievedAt: pending?.evidence?.retrievedAt,
      usePermissionRange: pending?.evidence?.usePermissionRange,
    },
    {
      id: "seoul-metro-facility-location",
      domain: "accessibility_facilities",
      requestUrl: "https://apis.data.go.kr/B553766/facility/getFcElvtr",
      admissionStatus: "evidence_recorded_admin_review_required",
      retrievedAt: "2026-07-10",
      usePermissionRange: "이용허락범위 제한 없음",
    },
  );

  const inventory = JSON.parse(await readFile(new URL("./source-inventory.json", import.meta.url), "utf8"));
  assert.ok(
    inventory.sources.some(({ id }) => id === "seoul-metro-accessibility"),
    "seoul-metro-accessibility must be admitted to the production source inventory",
  );
  assert.deepEqual(
    inventory.sources.filter(({ id }) => id === "seoul-metro-facility-location"),
    [],
  );
  assert.doesNotMatch(
    await readFile(new URL("../../.env.example", import.meta.url), "utf8"),
    /^DATA_GO_KR_SERVICE_KEY=/m,
  );
});

// 일시 오류 재시도(#1326, Refs #870): 멱등 GET만, 최대 3번 시도, full jitter(base 2s·cap 20s), Retry-After 존중.
const RETRY_ENDPOINT = "https://apis.data.go.kr/example";
const RETRY_KEY = "retry-secret-key";
const okPage = () => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 1, items: { item: [
    { lineNm: "1호선", stnNm: "서울역", oprtngSitu: "M", dtlPstn: "대합실-승강장" },
  ] } } } }),
});
const failedPage = (status, headers = {}) => ({ ok: false, status, headers: new Headers(headers), text: async () => "unavailable" });
const timeoutError = () => Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
const resetError = () => new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });

async function collectWithScript(script, { random = () => 0.5, requestAttempts } = {}) {
  const sleeps = [];
  const logs = [];
  let calls = 0;
  const fetchImpl = async () => {
    const step = script[Math.min(calls, script.length - 1)];
    calls += 1;
    if (step instanceof Error) throw step;
    return step();
  };
  const outcome = await collectSeoulAccessibility({
    endpoint: RETRY_ENDPOINT,
    serviceKey: RETRY_KEY,
    fetchImpl,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    randomImpl: random,
    logImpl: (line) => logs.push(line),
    ...(requestAttempts === undefined ? {} : { requestAttempts }),
  }).then((value) => ({ value }), (error) => ({ error }));
  return { ...outcome, calls, sleeps, logs };
}

test("일시 오류 재시도 표: 성공·소진·즉시 실패·Retry-After가 시도 수와 대기를 정한다", async () => {
  const cases = [
    { name: "timeout 한 번 뒤 성공", script: [timeoutError(), okPage], calls: 2, sleeps: [1_000], ok: true },
    { name: "연결 reset 두 번 뒤 성공", script: [resetError(), resetError(), okPage], calls: 3, sleeps: [1_000, 2_000], ok: true },
    { name: "timeout 3회는 소진 실패", script: [timeoutError()], calls: 3, sleeps: [1_000, 2_000], message: "Seoul accessibility API request failed: NETWORK_TIMEOUT" },
    { name: "503 뒤 성공", script: [() => failedPage(503), okPage], calls: 2, sleeps: [1_000], ok: true },
    { name: "429·502·504가 이어지면 시도 3에서 소진", script: [() => failedPage(429), () => failedPage(502), () => failedPage(504)], calls: 3, sleeps: [1_000, 2_000], message: "Seoul accessibility API HTTP 504" },
    { name: "503 3회는 소진 실패", script: [() => failedPage(503)], calls: 3, sleeps: [1_000, 2_000], message: "Seoul accessibility API HTTP 503" },
    { name: "401은 즉시 실패", script: [() => failedPage(401), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API HTTP 401" },
    { name: "403은 즉시 실패", script: [() => failedPage(403), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API HTTP 403" },
    { name: "404는 즉시 실패", script: [() => failedPage(404), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API HTTP 404" },
    { name: "500 뒤 성공(AWS SDK standard retry와 같은 일시 상태)", script: [() => failedPage(500), okPage], calls: 2, sleeps: [1_000], ok: true },
    { name: "501은 일시 목록에 없다", script: [() => failedPage(501), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API HTTP 501" },
    { name: "408은 일시 목록에 없다", script: [() => failedPage(408), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API HTTP 408" },
    { name: "알 수 없는 전송 오류는 즉시 실패", script: [new Error("boom"), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API request failed: NETWORK_UNKNOWN" },
    { name: "TLS 오류는 즉시 실패", script: [Object.assign(new Error("tls"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API request failed: NETWORK_TLS" },
    { name: "503 Retry-After 초 값을 따른다", script: [() => failedPage(503, { "Retry-After": "7" }), okPage], calls: 2, sleeps: [7_000], ok: true },
    { name: "429 Retry-After가 cap 20초를 넘으면 기다리지 않고 즉시 실패", script: [() => failedPage(429, { "Retry-After": "300" }), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API HTTP 429: RETRY_AFTER_EXCEEDS_CAP retryAfterSeconds=300 capSeconds=20" },
    { name: "503 Retry-After가 cap을 넘어도 즉시 실패(날짜 형식)", script: [() => failedPage(503, { "Retry-After": new Date(Date.now() + 600_000).toUTCString() }), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API HTTP 503: RETRY_AFTER_EXCEEDS_CAP retryAfterSeconds=" },
    { name: "429 Retry-After가 cap 안이면 따르고 두 번째 429도 따른다", script: [() => failedPage(429, { "Retry-After": "20" }), () => failedPage(429, { "Retry-After": "3" }), okPage], calls: 3, sleeps: [20_000, 3_000], ok: true },
    { name: "429 Retry-After 없음은 jitter 대기로 한 번만 재시도", script: [() => failedPage(429), okPage], calls: 2, sleeps: [1_000], ok: true },
    { name: "429가 Retry-After 없이 두 번이면 두 번째에서 실패", script: [() => failedPage(429)], calls: 2, sleeps: [1_000], message: "Seoul accessibility API HTTP 429" },
    { name: "429 Retry-After 없음 뒤 503은 남은 시도 안에서 재시도", script: [() => failedPage(429), () => failedPage(503), okPage], calls: 3, sleeps: [1_000, 2_000], ok: true },
    { name: "502 뒤 성공", script: [() => failedPage(502), okPage], calls: 2, sleeps: [1_000], ok: true },
    { name: "504 뒤 성공", script: [() => failedPage(504), okPage], calls: 2, sleeps: [1_000], ok: true },
    { name: "408은 일시 집합 밖이라 즉시 실패", script: [() => failedPage(408), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API HTTP 408" },
    { name: "501은 즉시 실패", script: [() => failedPage(501), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API HTTP 501" },
    { name: "505는 즉시 실패", script: [() => failedPage(505), okPage], calls: 1, sleeps: [], message: "Seoul accessibility API HTTP 505" },
    { name: "읽을 수 없는 Retry-After는 jitter 대기", script: [() => failedPage(503, { "Retry-After": "soon" }), okPage], calls: 2, sleeps: [1_000], ok: true },
  ];
  for (const expected of cases) {
    const result = await collectWithScript(expected.script);
    assert.equal(result.calls, expected.calls, `${expected.name}: 시도 수`);
    assert.deepEqual(result.sleeps, expected.sleeps, `${expected.name}: 대기`);
    if (expected.ok) {
      assert.equal(result.error, undefined, `${expected.name}: ${result.error?.message}`);
      assert.equal(result.value.rows.length, 1);
    } else {
      assert.ok(result.error?.message.startsWith(expected.message), `${expected.name}: ${result.error?.message}`);
    }
  }
});

test("재시도 대기는 full jitter다: random(0, min(20초, 2초·2^n)) 범위", async () => {
  for (const [random, expectedSleeps] of [[() => 0, [0, 0]], [() => 0.999999, [1_999, 3_999]]]) {
    const result = await collectWithScript([timeoutError()], { random });
    assert.deepEqual(result.sleeps, expectedSleeps);
  }
});

test("시도마다 로그 한 줄: 시도 번호·오류 종류·대기 ms. 키와 쿼리 값은 없다", async () => {
  const result = await collectWithScript([timeoutError(), () => failedPage(503), okPage]);
  assert.deepEqual(result.logs, [
    "Seoul accessibility retry attempt=1/3 kind=NETWORK_TIMEOUT delayMs=1000",
    "Seoul accessibility retry attempt=2/3 kind=HTTP_503 delayMs=2000",
  ]);
  const exhausted = await collectWithScript([timeoutError()]);
  assert.equal(exhausted.logs.at(-1), "Seoul accessibility request failed after 3 attempts: NETWORK_TIMEOUT");
  const httpExhausted = await collectWithScript([() => failedPage(503)]);
  assert.equal(httpExhausted.logs.at(-1), "Seoul accessibility request failed after 3 attempts: HTTP_503");
  for (const line of [...result.logs, ...exhausted.logs]) assert.doesNotMatch(line, new RegExp(`${RETRY_KEY}|https?://|serviceKey`));
});

test("본문 수신 중 timeout도 같은 요청을 다시 보낸다", async () => {
  const bodyTimeout = () => ({ ok: true, status: 200, headers: new Headers(), text: async () => { throw timeoutError(); } });
  const result = await collectWithScript([bodyTimeout, okPage]);
  assert.equal(result.calls, 2);
  assert.equal(result.error, undefined);
});

test("스키마·원천 오류 코드는 재시도하지 않고 즉시 실패한다", async () => {
  const providerError = () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ response: { header: { resultCode: "30" } } }) });
  const notJson = () => ({ ok: true, status: 200, headers: new Headers(), text: async () => "<html>" });
  for (const [script, message] of [[[providerError, okPage], "Seoul accessibility API response invalid: envelope"], [[notJson, okPage], "Seoul accessibility API response invalid"]]) {
    const result = await collectWithScript(script);
    assert.equal(result.calls, 1);
    assert.equal(result.error?.message, message);
  }
});

test("requestAttempts는 1~3이고 시도 수 상한이 된다. facility-location은 계속 1이다", async () => {
  const one = await collectWithScript([timeoutError()], { requestAttempts: 1 });
  assert.equal(one.calls, 1);
  const two = await collectWithScript([timeoutError()], { requestAttempts: 2 });
  assert.equal(two.calls, 2);
  for (const requestAttempts of [0, 4, 1.5, "3"]) {
    const invalid = await collectWithScript([okPage], { requestAttempts });
    assert.equal(invalid.calls, 0);
    assert.equal(invalid.error?.message, "Seoul accessibility API response invalid: requestAttempts");
  }
});

test("재시도는 페이지마다 따로 센다: 둘째 page의 일시 오류도 최대 3번까지 시도한다", async () => {
  const row = (name) => ({ lineNm: "1호선", stnNm: name, oprtngSitu: "M", dtlPstn: "대합실-승강장" });
  const pageOf = (items) => () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 2, items: { item: items } } } }) });
  const result = await collectWithScript([pageOf([row("가")]), timeoutError(), pageOf([row("나")])]);
  assert.equal(result.calls, 3);
  assert.equal(result.error, undefined);
  assert.equal(result.value.rows.length, 2);
});

test("재시도하려고 버리는 비-OK 응답의 본문은 취소한다. 마지막 응답은 건드리지 않는다", async () => {
  const cancelled = [];
  const failedWithBody = (status, label) => () => ({ ...failedPage(status), body: { cancel: async () => { cancelled.push(label); } } });
  const result = await collectWithScript([failedWithBody(503, "first"), failedWithBody(503, "second"), failedWithBody(503, "last")]);
  assert.equal(result.calls, 3);
  assert.deepEqual(cancelled, ["first", "second"]);
  const rejecting = await collectWithScript([() => ({ ...failedPage(503), body: { cancel: async () => { throw new Error("already closed"); } } }), okPage]);
  assert.equal(rejecting.error, undefined, "취소 실패가 수집을 막지 않는다");
});
