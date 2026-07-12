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
        json: async () => {
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
        json: async () => {
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
        json: async () => ({
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
      assert.equal(error.message, "Seoul accessibility API response invalid");
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
        json: async () => ({
          response: {
            header: { resultCode: "00" },
            body: { items: { item: { reflected: "serviceKey=secret" } } },
          },
        }),
      }),
    }),
    (error) => {
      assert.equal(error.message, "Seoul accessibility API response invalid");
      assert.doesNotMatch(error.message, /secret|rows\.map/);
      return true;
    },
  );
});

test("collector accepts only the documented success schema", async () => {
  const requestUrls = [];
  const rows = await collectSeoulAccessibility({
    endpoint: "https://apis.data.go.kr/example",
    serviceKey: "secret",
    fetchImpl: async (url) => {
      requestUrls.push(new URL(url));
      const stationName = new URL(url).searchParams.get("stnNm");
      return {
        ok: true,
        json: async () => ({
          response: {
            header: { resultCode: "00" },
            body: {
              items: {
                item: [
                  {
                    lineNm: "4호선",
                    stnNm: stationName,
                    oprtngSitu: stationName === "상록수" ? "S" : "M",
                    dtlPstn: stationName === "상록수" ? "1번 출구-대합실" : "대합실-승강장",
                  },
                ],
              },
            },
          },
        }),
      };
    },
  });

  assert.deepEqual(rows, [
    { stationName: "상록수", lineName: "4호선", operational: false, situationCode: "S", situation: "보수중", pathDescription: "1번 출구-대합실" },
    { stationName: "사당", lineName: "4호선", operational: true, situationCode: "M", situation: "사용가능", pathDescription: "대합실-승강장" },
  ]);
  assert.deepEqual(
    requestUrls.map((url) => ({
      lineName: url.searchParams.get("lineNm"),
      stationName: url.searchParams.get("stnNm"),
      pageNo: url.searchParams.get("pageNo"),
      numOfRows: url.searchParams.get("numOfRows"),
    })),
    [
      { lineName: "4호선", stationName: "상록수", pageNo: "1", numOfRows: "1000" },
      { lineName: "4호선", stationName: "사당", pageNo: "1", numOfRows: "1000" },
    ],
  );
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

test("collector rejects rows outside the requested pilot station-line", async () => {
  await assert.rejects(
    collectSeoulAccessibility({
      endpoint: "https://apis.data.go.kr/example",
      serviceKey: "secret",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          response: {
            header: { resultCode: "00" },
            body: {
              items: {
                item: [{ lineNm: "2호선", stnNm: "상록수", oprtngSitu: "M", dtlPstn: "출입구-대합실" }],
              },
            },
          },
        }),
      }),
    }),
    /Seoul accessibility API response invalid/,
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
    { ...valid, oprtngSitu: undefined },
    { ...valid, oprtngSitu: 123 },
  ]) {
    assert.throws(() => normalizeAccessibilityRows([row]), /Seoul accessibility API response invalid/);
  }
});

test("snapshot contains sanitized evidence for both pilot stations", () => {
  const snapshot = buildAccessibilitySnapshot(
    [
      { stationName: "사당", lineName: "4호선", operational: true, situationCode: "M", situation: "사용가능", pathDescription: "대합실-승강장" },
      { stationName: "상록수", lineName: "4호선", operational: false, situationCode: "S", situation: "보수중", pathDescription: "1번 출구-대합실" },
    ],
    "2026-07-10T00:00:00.000Z",
  );

  assert.deepEqual(snapshot, {
    sourceId: "seoul-metro-accessibility",
    retrievedAt: "2026-07-10T00:00:00.000Z",
    stations: [
      {
        stationName: "상록수",
        lineName: "4호선",
        facilities: [{ operational: false, situationCode: "S", situation: "보수중", pathDescription: "1번 출구-대합실" }],
      },
      {
        stationName: "사당",
        lineName: "4호선",
        facilities: [{ operational: true, situationCode: "M", situation: "사용가능", pathDescription: "대합실-승강장" }],
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /serviceKey|https?:\/\//);
});

test("snapshot rejects missing pilot station evidence", () => {
  assert.throws(
    () =>
      buildAccessibilitySnapshot(
        [{ stationName: "사당", lineName: "4호선", operational: true, situationCode: "M", situation: "사용가능", pathDescription: "대합실-승강장" }],
        "2026-07-10T00:00:00.000Z",
      ),
    /accessibility evidence missing for 상록수/,
  );
});

test("snapshot rejects pilot facilities without a boolean status, situation code and path", () => {
  const validSadang = {
    stationName: "사당",
    lineName: "4호선",
    operational: true,
    situationCode: "M",
    situation: "사용가능",
    pathDescription: "대합실-승강장",
  };
  const validSangnoksu = {
    stationName: "상록수",
    lineName: "4호선",
    operational: false,
    situationCode: "S",
    situation: "보수중",
    pathDescription: "1번 출구-대합실",
  };
  for (const sangnoksu of [
    { ...validSangnoksu, operational: undefined },
    { ...validSangnoksu, operational: "Y" },
    { ...validSangnoksu, situationCode: undefined },
    { ...validSangnoksu, situationCode: "Y" },
    { ...validSangnoksu, situation: undefined },
    { ...validSangnoksu, pathDescription: undefined },
    { ...validSangnoksu, pathDescription: 123 },
    { ...validSangnoksu, stationName: undefined },
  ]) {
    assert.throws(
      () => buildAccessibilitySnapshot([sangnoksu, validSadang], "2026-07-10T00:00:00.000Z"),
      /Seoul accessibility API response invalid/,
    );
  }
});

test("invalid provider evidence never reaches the output write", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "easysubway-accessibility-"));
  const valid = { lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실-승강장" };
  const jsonResponse = (item, resultCode = "00") => async () => ({
    ok: true,
    json: async () => ({ response: { header: { resultCode }, body: { items: { item } } } }),
  });
  const cases = [
    async () => ({ ok: false, status: 403 }),
    async () => ({
      ok: true,
      json: async () => {
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
      { ...valid, oprtngSitu: undefined },
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
      [collectorPath, "--output", "unused.json"],
      { env: {} },
    ),
    /DATA_GO_KR_SERVICE_KEY env is required/,
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
