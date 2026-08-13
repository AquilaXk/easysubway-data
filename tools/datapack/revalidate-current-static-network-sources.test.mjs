import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCurrentStaticSourceRevalidation,
  fetchCurrentStaticSourceResponses,
  writeCurrentStaticSourceRevalidation,
} from "./revalidate-current-static-network-sources.mjs";

const observedAt = "2026-08-13T10:30:00.000Z";
const molitCsvBytes = await readFile(new URL(
  "./sources/molit-urban-rail-full-route-20251211.csv",
  import.meta.url,
));
const trackedSnapshots = JSON.parse(await readFile(new URL(
  "./release/source-snapshots.json",
  import.meta.url,
), "utf8"));
const trackedMolitSnapshot = trackedSnapshots.find(
  ({ sourceId }) => sourceId === "molit-urban-rail-full-route",
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function projectedRows() {
  return {
    molit: [
      ["선바위", "30"],
      ["경마공원", "31"],
      ["대공원", "32"],
      ["과천", "33"],
      ["정부과천청사", "34"],
    ].map(([stationName, sequence]) => ({
      line_name: "4호선",
      operator_name: "코레일",
      region: "수도권",
      station_name: stationName,
      station_sequence: sequence,
    })),
    seoul: Array.from({ length: 5 }, (_, index) => ({
      line: "04호선",
      station_code: `04${31 + index}`,
      station_name: `역-${index + 1}`,
    })),
  };
}

function responseBytes(rows = projectedRows()) {
  return {
    molit: Buffer.from(molitCsvBytes),
    seoul: Buffer.from(JSON.stringify({
      SearchSTNBySubwayLineInfo: {
        list_total_count: 5,
        RESULT: { CODE: "INFO-000", MESSAGE: "정상 처리되었습니다" },
        row: rows.seoul.map((row) => ({
          FR_CODE: row.station_code.slice(1),
          LINE_NUM: row.line,
          STATION_CD: row.station_code,
          STATION_NM: row.station_name,
          STATION_NM_CHN: `站-${row.station_code}`,
          STATION_NM_ENG: `Station-${row.station_code}`,
          STATION_NM_JPN: `駅-${row.station_code}`,
        })),
      },
    })),
  };
}

function previousSnapshots(rows = projectedRows()) {
  const synthetic = Object.entries(rows).map(([kind, records]) => {
    const sourceId = kind === "molit"
      ? "molit-urban-rail-full-route"
      : "seoulmetro-station-line-info";
    const fields = Object.keys(records[0]).sort();
    return {
      schemaVersion: 1,
      artifactKind: "official-source-snapshot",
      snapshotId: `${sourceId}-capital-admission-20260712`,
      sourceId,
      provider: kind === "molit" ? "국토교통부" : "서울교통공사",
      retrievedAt: "2026-07-12T00:00:00.000Z",
      sourceUpdatedAt: "2026-06-22T00:00:00.000Z",
      rowCount: 5,
      coverageCount: 5,
      rawSha256: sha256(Buffer.from(`${JSON.stringify(records)}\n`)),
      rawObjectUri: `s3://easysubway-datapack-sources/${sourceId}/20260712.json`,
      redactedRequestFingerprint: sha256(`request:${sourceId}`),
      schemaFingerprint: sha256(JSON.stringify(fields)),
      snapshotStatus: "LOCKED",
      schemaStatus: "PASS",
      licenseStatus: "PASS",
      fetchStatus: "SUCCESS",
      redistributionAllowed: true,
      credentialRedacted: true,
      previousSnapshotId: null,
      diffSummary: null,
      freshnessExpiresAt: "2026-08-11T00:00:00.000Z",
      rawRetentionExpiresAt: "2026-10-10T00:00:00.000Z",
      providerRecordHashes: records.map((record) => sha256(JSON.stringify(record))),
    };
  });
  return [structuredClone(trackedMolitSnapshot), synthetic.find(({ sourceId }) => (
    sourceId === "seoulmetro-station-line-info"
  ))];
}

test("current static responses가 unchanged면 exact child snapshots와 sanitized evidence를 만든다", () => {
  const responses = responseBytes();
  const first = buildCurrentStaticSourceRevalidation({
    sourceSnapshots: previousSnapshots(),
    observedAt,
    responseBytesBySource: responses,
  });
  const second = buildCurrentStaticSourceRevalidation({
    sourceSnapshots: previousSnapshots(),
    observedAt,
    responseBytesBySource: responses,
  });

  assert.deepEqual(second, first);
  assert.deepEqual(first.map(({ sourceId }) => sourceId), [
    "molit-urban-rail-full-route",
    "seoulmetro-station-line-info",
  ]);
  for (const { evidence, snapshot } of first) {
    assert.equal(snapshot.previousSnapshotId.endsWith("20260712"), true);
    assert.equal(snapshot.diffSummary.status, "NO_CHANGE");
    assert.equal(snapshot.retrievedAt, observedAt);
    assert.equal(snapshot.freshnessExpiresAt, "2026-09-12T10:30:00.000Z");
    assert.equal(snapshot.rawRetentionExpiresAt, "2026-11-11T10:30:00.000Z");
    assert.equal(snapshot.revalidationEvidenceSha256, evidence.evidenceSha256);
    assert.equal(evidence.outcome, "NO_CHANGE_REVALIDATED");
    assert.equal(evidence.operation, evidence.sourceId === "molit-urban-rail-full-route"
      ? "molit-urban-rail-full-route-file-five-records"
      : "seoulmetro-line4-stations-one-to-five");
    assert.match(evidence.responseSha256, /^[0-9a-f]{64}$/);
    assert.equal(evidence.credentialRedacted, true);
    assert.doesNotMatch(JSON.stringify(evidence), /Station-04|站-04|駅-04|s3:|serviceKey/);
  }
});

test("row order/value/field/provider/schema mismatch는 child output을 만들지 않는다", () => {
  const cases = [
    (responses) => {
      responses.molit = Buffer.from(responses.molit);
      responses.molit[0] = 0x58;
    },
    (responses) => {
      const firstSequence = responses.molit.indexOf(Buffer.from(",1,"));
      assert.notEqual(firstSequence, -1);
      responses.molit = Buffer.from(responses.molit);
      responses.molit[firstSequence + 1] = 0x30;
    },
    (responses) => {
      responses.molit = Buffer.concat([responses.molit, Buffer.from([0x81])]);
    },
    (responses) => {
      const value = JSON.parse(responses.seoul);
      value.SearchSTNBySubwayLineInfo.row[0].EXTRA = "raw-secret-sentinel";
      responses.seoul = Buffer.from(JSON.stringify(value));
    },
    (responses) => {
      const value = JSON.parse(responses.seoul);
      value.SearchSTNBySubwayLineInfo.RESULT.CODE = "ERROR-500";
      responses.seoul = Buffer.from(JSON.stringify(value));
    },
  ];
  for (const mutate of cases) {
    const responses = responseBytes();
    mutate(responses);
    assert.throws(() => buildCurrentStaticSourceRevalidation({
      sourceSnapshots: previousSnapshots(),
      observedAt,
      responseBytesBySource: responses,
    }), (error) => {
      assert.match(error.message, /^STATIC_SOURCE_REVALIDATION_/);
      assert.doesNotMatch(error.message, /raw-secret-sentinel|역-|Station-|serviceKey/i);
      return true;
    });
  }
});

test("tracked provider boundary는 public MOLIT CSV와 Seoul을 exact one-call한다", async () => {
  const requested = [];
  const responses = responseBytes();
  const result = await fetchCurrentStaticSourceResponses({
    seoulOpenApiKey: "seoul-key",
    fetchImpl: async (url, init) => {
      requested.push({ url: String(url), init });
      const body = requested.length === 1 ? responses.molit : responses.seoul;
      return new Response(body, {
        status: 200,
        headers: { "content-type": requested.length === 1 ? "application/octet-stream" : "application/json" },
      });
    },
  });

  assert.equal(requested.length, 2);
  assert.equal(requested[0].url,
    "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003561913&fileDetailSn=1&insertDataPrcus=N");
  assert.doesNotMatch(requested[0].url, /api\.odcloud|serviceKey|uddi:/u);
  assert.equal(Object.hasOwn(requested[0].init.headers, "Authorization"), false);
  assert.deepEqual(requested[0].init.headers, { accept: "application/octet-stream" });
  assert.match(decodeURI(new URL(requested[1].url).pathname),
    /\/seoul-key\/json\/SearchSTNBySubwayLineInfo\/1\/5\/\/\/4호선$/);
  assert.equal(result.molit.equals(responses.molit), true);
  assert.equal(result.seoul.equals(responses.seoul), true);

  await assert.rejects(fetchCurrentStaticSourceResponses({
    seoulOpenApiKey: "seoul-key",
    fetchImpl: async () => { throw new Error("seoul-key raw-secret-sentinel"); },
  }), (error) => {
    assert.equal(error.message, "STATIC_SOURCE_REVALIDATION_MOLIT_TRANSPORT");
    return true;
  });
});

test("provider 실패는 source와 closed HTTP stage만 분류하고 retry하지 않는다", async () => {
  const responses = responseBytes();
  const cases = [
    {
      expected: "STATIC_SOURCE_REVALIDATION_MOLIT_HTTP_503",
      fetchImpl: async () => new Response("raw-secret-sentinel", { status: 503 }),
      calls: 1,
    },
    {
      expected: "STATIC_SOURCE_REVALIDATION_SEOUL_CONTENT_TYPE",
      fetchImpl: async (_url, _init, call) => call === 1
        ? new Response(responses.molit, { status: 200, headers: { "content-type": "application/octet-stream" } })
        : new Response("raw-secret-sentinel", { status: 200, headers: { "content-type": "text/plain" } }),
      calls: 2,
    },
    {
      expected: "STATIC_SOURCE_REVALIDATION_SEOUL_BODY_SIZE",
      fetchImpl: async (_url, _init, call) => call === 1
        ? new Response(responses.molit, { status: 200, headers: { "content-type": "application/octet-stream" } })
        : new Response(Buffer.alloc(1024 * 1024 + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      calls: 2,
    },
    {
      expected: "STATIC_SOURCE_REVALIDATION_SEOUL_TRANSPORT",
      fetchImpl: async (_url, _init, call) => {
        if (call === 1) {
          return new Response(responses.molit, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }
        throw new Error("raw-secret-sentinel seoul-key encoded-key");
      },
      calls: 2,
    },
  ];

  for (const scenario of cases) {
    let calls = 0;
    await assert.rejects(fetchCurrentStaticSourceResponses({
      seoulOpenApiKey: "seoul-key",
      fetchImpl: (url, init) => {
        calls += 1;
        return scenario.fetchImpl(url, init, calls);
      },
    }), (error) => {
      assert.equal(error.message, scenario.expected);
      assert.doesNotMatch(error.message, /raw-secret|seoul-key|https?:/iu);
      return true;
    });
    assert.equal(calls, scenario.calls);
  }
});

test("validated four-file output은 absent directory에 한 번만 publish한다", async (context) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "static-source-revalidation-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const outputDirectory = path.join(parent, "20260813");
  const result = buildCurrentStaticSourceRevalidation({
    sourceSnapshots: previousSnapshots(),
    observedAt,
    responseBytesBySource: responseBytes(),
  });

  const outputs = await writeCurrentStaticSourceRevalidation({ outputDirectory, result });
  assert.equal(outputs.length, 4);
  for (const output of outputs) {
    const metadata = await lstat(output);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.mode & 0o777, 0o600);
    const contents = await readFile(output, "utf8");
    assert.doesNotThrow(() => JSON.parse(contents));
  }
  await assert.rejects(
    writeCurrentStaticSourceRevalidation({ outputDirectory, result }),
    /output directory must be absent/,
  );
  const existingEmpty = path.join(parent, "existing-empty");
  await mkdir(existingEmpty);
  await assert.rejects(
    writeCurrentStaticSourceRevalidation({ outputDirectory: existingEmpty, result }),
    /output directory must be absent/,
  );
  assert.deepEqual(await readdir(existingEmpty), []);
});
