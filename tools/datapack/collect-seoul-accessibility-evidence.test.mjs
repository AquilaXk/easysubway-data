import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildAccessibilitySnapshot,
  collectSeoulAccessibility,
  normalizeAccessibilityRows,
  writeSeoulAccessibilityEvidence,
} from "./collect-seoul-accessibility-evidence.mjs";

const execFileAsync = promisify(execFile);
const collectorPath = fileURLToPath(new URL("./collect-seoul-accessibility-evidence.mjs", import.meta.url));

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

test("collector aborts stalled provider requests after the configured timeout", async () => {
  let observedAbortSignal = false;
  await assert.rejects(
    collectSeoulAccessibility({
      endpoint: "https://apis.data.go.kr/example",
      serviceKey: "secret",
      requestTimeoutMs: 1,
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
