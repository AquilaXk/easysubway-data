import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as fareProbe from "./probe-seoul-fare-api.mjs";

const FARE_KEY = "DATA_GO_KR_SERVICE_KEY_VALUE";
const requiredFareFields = [
  "childCardFare",
  "childCashFare",
  "gnrlCardFare",
  "gnrlCashFare",
  "yungCardFare",
  "yungCashFare",
];

const officialSample = {
  dptreStnCd: "0150",
  dptreStnNm: "서울역",
  arvlStnCd: "0151",
  arvlStnNm: "시청",
  gnrlCardFare: 1550,
  gnrlCashFare: 1650,
  yungCardFare: 900,
  yungCashFare: 1650,
  childCardFare: 550,
  childCashFare: 550,
};

const directionalFares = {
  "서울역→시청": [1550, 1650, 900, 1650, 550, 550],
  "상록수→사당": [101, 102, 103, 104, 105, 106],
  "사당→상록수": [201, 202, 203, 204, 205, 206],
};

const directionalCodes = {
  "서울역→시청": ["0150", "0151"],
  "상록수→사당": ["9001", "9002"],
  "사당→상록수": ["9002", "9001"],
};

function farePayload(url, { omitField, extra = true } = {}) {
  const originName = url.searchParams.get("dptreStnNm");
  const destinationName = url.searchParams.get("arvlStnNm");
  const direction = `${originName}→${destinationName}`;
  const values = directionalFares[direction];
  const codes = directionalCodes[direction];
  const item = {
    dptreStnCd: codes[0],
    dptreStnNm: originName,
    arvlStnCd: codes[1],
    arvlStnNm: destinationName,
    gnrlCardFare: values[0],
    gnrlCashFare: values[1],
    yungCardFare: values[2],
    yungCashFare: values[3],
    childCardFare: values[4],
    childCashFare: values[5],
    ...(extra ? { providerNotice: "documented-extra" } : {}),
  };
  delete item[omitField];
  return { response: { header: { resultCode: "00" }, body: { totalCount: 1, items: { item: [item] } } } };
}

function createFetch({
  canaryResponse,
  fareResponse,
  onCall = () => {},
} = {}) {
  return async (input) => {
    const url = new URL(input);
    const direction = `${url.searchParams.get("dptreStnNm")}→${url.searchParams.get("arvlStnNm")}`;
    onCall(`fare:${direction}`, url);
    if (direction === "서울역→시청" && canaryResponse) return canaryResponse({ direction, url });
    if (direction !== "서울역→시청" && fareResponse) return fareResponse({ direction, url });
    return Response.json(farePayload(url));
  };
}

async function withOutput(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "official-od-fare-test-"));
  const outputPath = path.join(directory, "evidence.json");
  try {
    return await run(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function probe({ fareServiceKey = FARE_KEY, fetchImpl, outputPath }) {
  return fareProbe.probeOfficialOdFares({
    fareServiceKey,
    outputPath,
    fetchImpl,
    retryDelayMs: 0,
    timeoutMs: 100,
  });
}

test("서울역-시청 공식 요금 응답 계약을 검증한다", () => {
  assert.doesNotThrow(() => fareProbe.validateFareSample({ ...officialSample, providerNotice: "extra" }));
  assert.throws(
    () => fareProbe.validateFareSample({ ...officialSample, yungCashFare: "1650" }),
    /yungCashFare/,
  );
  const { childCashFare: _, ...missingFare } = officialSample;
  assert.throws(() => fareProbe.validateFareSample(missingFare), /childCashFare/);
});

test("HTTPS fare 응답 code canary로 양방향 공식 OD 증거만 기록한다", async () => {
  await withOutput(async (outputPath) => {
    const calls = [];
    const evidence = await probe({
      outputPath,
      fetchImpl: createFetch({
        onCall: (kind, url) => {
          assert.equal(url.protocol, "https:");
          assert.equal(url.searchParams.has("dptreStnCd"), false);
          assert.equal(url.searchParams.has("arvlStnCd"), false);
          calls.push(kind);
        },
      }),
    });

    assert.deepEqual(calls, [
      "fare:서울역→시청",
      "fare:상록수→사당",
      "fare:사당→상록수",
    ]);
    assert.equal(evidence.artifactKind, "official-od-fare-probe-evidence");
    assert.equal(evidence.mappingField, "dptreStnCd/arvlStnCd");
    assert.deepEqual(evidence.providerMappings.map(({ stationId, lineId, fareStationCode }) => ({
      stationId,
      lineId,
      fareStationCode,
    })), [
      { stationId: "station-sangnoksu", lineId: "seoul-4", fareStationCode: "9001" },
      { stationId: "station-sadang", lineId: "seoul-4", fareStationCode: "9002" },
    ]);
    assert.deepEqual(evidence.quotes.map(({ originStationId, destinationStationId }) =>
      `${originStationId}→${destinationStationId}`), [
      "station-sangnoksu→station-sadang",
      "station-sadang→station-sangnoksu",
    ]);
    assert.deepEqual(Object.keys(evidence.quotes[0].fares).sort(), requiredFareFields);
    assert.equal(JSON.stringify(evidence).includes("providerNotice"), false);
    assert.deepEqual(evidence.attemptCounts, { "station-sangnoksu→station-sadang": 1, "station-sadang→station-sangnoksu": 1 });

    const stored = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(stored, evidence);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(`${FARE_KEY}|serviceKey|https?://`));
  });
});

test("fieldNames는 process locale과 무관한 canonical 순서를 유지한다", async (context) => {
  const collator = new Intl.Collator("cs");
  context.mock.method(String.prototype, "localeCompare", function compare(other) {
    return collator.compare(String(this), other);
  });

  await withOutput(async (outputPath) => {
    const evidence = await probe({ outputPath, fetchImpl: createFetch() });
    assert.deepEqual(evidence.fieldNames, requiredFareFields);
  });
});

test("fare canary 응답 code가 모호하면 target 호출 전에 실패한다", async () => {
  await withOutput(async (outputPath) => {
    const calls = [];
    const canaryResponse = ({ url }) => {
      const payload = farePayload(url);
      payload.response.body.items.item.push({ ...payload.response.body.items.item[0], dptreStnCd: "9999" });
      payload.response.body.totalCount = 2;
      return Response.json(payload);
    };

    await assert.rejects(
      () => probe({ outputPath, fetchImpl: createFetch({ canaryResponse, onCall: (kind) => calls.push(kind) }) }),
      /fare API response mapping is absent or ambiguous/,
    );
    assert.deepEqual(calls, ["fare:서울역→시청"]);
    await assert.rejects(access(outputPath));
  });
});

test("fare canary 응답 code가 known pair와 다르면 target 호출 전에 실패한다", async () => {
  await withOutput(async (outputPath) => {
    const calls = [];
    const canaryResponse = ({ url }) => {
      const payload = farePayload(url);
      payload.response.body.items.item[0].dptreStnCd = "9999";
      return Response.json(payload);
    };

    await assert.rejects(
      () => probe({ outputPath, fetchImpl: createFetch({ canaryResponse, onCall: (kind) => calls.push(kind) }) }),
      /dptreStnCd/,
    );
    assert.deepEqual(calls, ["fare:서울역→시청"]);
    await assert.rejects(access(outputPath));
  });
});

test("현재 page가 totalCount 전체를 포함하지 않으면 target 호출 전에 실패한다", async () => {
  await withOutput(async (outputPath) => {
    const calls = [];
    const canaryResponse = ({ url }) => {
      const payload = farePayload(url);
      payload.response.body.totalCount = 2;
      return Response.json(payload);
    };

    await assert.rejects(
      () => probe({ outputPath, fetchImpl: createFetch({ canaryResponse, onCall: (kind) => calls.push(kind) }) }),
      /pagination is incomplete/,
    );
    assert.deepEqual(calls, ["fare:서울역→시청"]);
    await assert.rejects(access(outputPath));
  });
});

test("target 양방향 응답 code가 서로 다르면 output을 만들지 않는다", async () => {
  await withOutput(async (outputPath) => {
    const fareResponse = ({ direction, url }) => {
      const payload = farePayload(url);
      if (direction === "사당→상록수") payload.response.body.items.item[0].arvlStnCd = "9999";
      return Response.json(payload);
    };

    await assert.rejects(
      () => probe({ outputPath, fetchImpl: createFetch({ fareResponse }) }),
      /target station code equivalence failed/,
    );
    await assert.rejects(access(outputPath));
  });
});

test("429와 5xx는 방향별 최대 두 번만 재시도하고 attempt count를 기록한다", async () => {
  await withOutput(async (outputPath) => {
    const attempts = new Map();
    const fetchImpl = createFetch({
      fareResponse: ({ direction, url }) => {
        const count = (attempts.get(direction) ?? 0) + 1;
        attempts.set(direction, count);
        if (count === 1) return new Response("temporary", { status: direction.startsWith("상록수") ? 429 : 503 });
        return Response.json(farePayload(url));
      },
    });

    const evidence = await probe({ outputPath, fetchImpl });
    assert.deepEqual(evidence.attemptCounts, { "station-sangnoksu→station-sadang": 2, "station-sadang→station-sangnoksu": 2 });
    assert.deepEqual(Object.fromEntries(attempts), { "상록수→사당": 2, "사당→상록수": 2 });
  });
});

test("계속되는 5xx는 두 번에서 중단하고 output을 만들지 않는다", async () => {
  await withOutput(async (outputPath) => {
    let fareAttempts = 0;
    const fetchImpl = createFetch({
      fareResponse: () => {
        fareAttempts += 1;
        return new Response("temporary", { status: 503 });
      },
    });
    await assert.rejects(() => probe({ outputPath, fetchImpl }), /fare API HTTP 503/);
    assert.equal(fareAttempts, 2);
    await assert.rejects(access(outputPath));
  });
});

test("transport failure는 한 번만 재시도한다", async () => {
  await withOutput(async (outputPath) => {
    let forwardAttempts = 0;
    const fetchImpl = createFetch({
      fareResponse: ({ direction, url }) => {
        if (direction === "상록수→사당" && ++forwardAttempts === 1) throw new Error("socket closed");
        return Response.json(farePayload(url));
      },
    });
    const evidence = await probe({ outputPath, fetchImpl });
    assert.equal(evidence.attemptCounts["station-sangnoksu→station-sadang"], 2);
    assert.equal(forwardAttempts, 2);
  });
});

test("response body transport failure도 한 번만 재시도한다", async () => {
  await withOutput(async (outputPath) => {
    const attempts = new Map();
    const fetchImpl = createFetch({
      fareResponse: ({ direction, url }) => {
        const count = (attempts.get(direction) ?? 0) + 1;
        attempts.set(direction, count);
        const payload = farePayload(url);
        return {
          ok: true,
          status: 200,
          async json() {
            if (count === 1) throw new TypeError("terminated");
            return payload;
          },
        };
      },
    });

    const evidence = await probe({ outputPath, fetchImpl });
    assert.deepEqual(evidence.attemptCounts, { "station-sangnoksu→station-sadang": 2, "station-sadang→station-sangnoksu": 2 });
    assert.deepEqual(Object.fromEntries(attempts), { "상록수→사당": 2, "사당→상록수": 2 });
  });
});

test("malformed JSON은 transport failure로 재시도하지 않는다", async () => {
  await withOutput(async (outputPath) => {
    let attempts = 0;
    const fetchImpl = createFetch({
      fareResponse: () => {
        attempts += 1;
        return new Response("{invalid", { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await assert.rejects(() => probe({ outputPath, fetchImpl }), /fare API returned invalid JSON/);
    assert.equal(attempts, 1);
    await assert.rejects(access(outputPath));
  });
});

test("계속되는 transport failure는 두 번에서 중단하고 output을 만들지 않는다", async () => {
  await withOutput(async (outputPath) => {
    let fareAttempts = 0;
    const fetchImpl = createFetch({
      fareResponse: () => {
        fareAttempts += 1;
        throw new Error("socket closed");
      },
    });
    await assert.rejects(() => probe({ outputPath, fetchImpl }), /socket closed/);
    assert.equal(fareAttempts, 2);
    await assert.rejects(access(outputPath));
  });
});

test("429가 아닌 4xx는 재시도하지 않고 output을 만들지 않는다", async () => {
  await withOutput(async (outputPath) => {
    let fareAttempts = 0;
    const fetchImpl = createFetch({
      fareResponse: () => {
        fareAttempts += 1;
        return new Response("bad request", { status: 400 });
      },
    });
    await assert.rejects(() => probe({ outputPath, fetchImpl }), /fare API HTTP 400/);
    assert.equal(fareAttempts, 1);
    await assert.rejects(access(outputPath));
  });
});

test("실패한 재실행은 기존 evidence를 제거한다", async () => {
  await withOutput(async (outputPath) => {
    await writeFile(outputPath, "stale evidence\n", { mode: 0o600 });
    const fetchImpl = createFetch({
      fareResponse: () => new Response("bad request", { status: 400 }),
    });

    await assert.rejects(() => probe({ outputPath, fetchImpl }), /fare API HTTP 400/);
    await assert.rejects(access(outputPath));
  });
});

test("credential 검증 실패도 기존 evidence를 제거한다", async () => {
  await withOutput(async (outputPath) => {
    await writeFile(outputPath, "stale evidence\n", { mode: 0o600 });

    await assert.rejects(() => probe({ fareServiceKey: "", outputPath }), /DATA_GO_KR_SERVICE_KEY/);
    await assert.rejects(access(outputPath));
  });
});

test("필수 요금 필드 누락과 credential-bearing 오류를 fail closed하고 redaction한다", async () => {
  await withOutput(async (outputPath) => {
    const missingFieldFetch = createFetch({
      fareResponse: ({ url }) => Response.json(farePayload(url, { omitField: "childCashFare" })),
    });
    await assert.rejects(() => probe({ outputPath, fetchImpl: missingFieldFetch }), /childCashFare/);
    await assert.rejects(access(outputPath));

    const secretErrorFetch = async (input) => {
      const url = String(input);
      throw new Error(`request failed ${url} ${FARE_KEY}`);
    };
    const error = await probe({ outputPath, fetchImpl: secretErrorFetch }).catch((caught) => caught);
    assert.equal(error instanceof Error, true);
    assert.doesNotMatch(error.message, new RegExp(`${FARE_KEY}|https?://|serviceKey=`));
    await assert.rejects(access(outputPath));

    const encodedKey = "ENCODED%2FKEY";
    const decodedKey = "ENCODED/KEY";
    const decodedErrorFetch = async () => {
      throw new Error(`request failed with ${decodedKey}`);
    };
    const decodedError = await probe({
      fareServiceKey: encodedKey,
      outputPath,
      fetchImpl: decodedErrorFetch,
    }).catch((caught) => caught);
    assert.doesNotMatch(decodedError.message, new RegExp(`${encodedKey}|${decodedKey}`));
    await assert.rejects(access(outputPath));
  });
});
