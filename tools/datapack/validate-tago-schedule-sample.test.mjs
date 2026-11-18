import { rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256 } from "../lib/hash.mjs";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const productionEnv = {
  ...process.env,
  EASYSUBWAY_DATAPACK_BUILD_PROFILE: "production",
};

const VALID_TAGO_DEPARTURE_ITEM = {
  endSubwayStationNm: "당고개",
  subwayRouteId: "MTRKR4",
  subwayStationId: "MTRKR4448",
  subwayStationNm: "상록수",
  dailyTypeCode: "01",
  upDownTypeCode: "U",
  depTime: "080500",
  arrTime: "080500",
  endSubwayStationId: "MTRKR4409",
};

async function withTagoSampleFile(prefix, rawSample, fn) {
  const samplePath = path.join(tmpdir(), `easysubway-tago-schedule-${prefix}-${Date.now()}.json`);
  await writeFile(samplePath, rawSample);
  try {
    await fn({
      samplePath,
      runValidator: () =>
        execFileAsync(
          process.execPath,
          ["tools/datapack/validate-tago-schedule-sample.mjs", "--sample", samplePath],
          { cwd: root, env: productionEnv },
        ),
    });
  } finally {
    await rm(samplePath, { force: true });
  }
}

test("TAGO 시간표 sample validator는 station-level row shape만 검증하고 production 승격은 막는다", async () => {
  const rawSample = `${JSON.stringify({
    response: {
      body: {
        items: {
          item: [
            VALID_TAGO_DEPARTURE_ITEM,
            {
              ...VALID_TAGO_DEPARTURE_ITEM,
              depTime: "081200",
              arrTime: "081200",
            },
          ],
        },
      },
    },
  })}\n`;

  await withTagoSampleFile("sample", rawSample, async ({ runValidator }) => {
    const { stdout } = await runValidator();
    const report = JSON.parse(stdout);
    assert.equal(report.candidateId, "molit-tago-subway-info");
    assert.equal(report.rowCount, 2);
    assert.equal(report.stationLevelOnly, true);
    assert.equal(report.productionUseAllowed, false);
    assert.equal(report.rawSha256, sha256(rawSample));
    assert.equal(report.remainingAdmissionBlocker, "line_wide_trip_stop_sequence_validation_required");
    assert.deepEqual(
      report.departures.map((departure) => departure.departureSeconds),
      [29100, 29520],
    );
  });
});

test("TAGO 시간표 sample validator는 잘못된 시간 row를 거부한다", async () => {
  const rawSample = JSON.stringify({
    response: {
      body: {
        items: {
          item: {
            ...VALID_TAGO_DEPARTURE_ITEM,
            arrTime: "080700",
          },
        },
      },
    },
  });

  await withTagoSampleFile("invalid", rawSample, async ({ runValidator }) => {
    await assert.rejects(runValidator(), /arrival must be <= departure/);
  });
});

test("TAGO 시간표 sample validator는 JSON serviceKey credential을 거부한다", async () => {
  const rawSample = JSON.stringify({
    serviceKey: "secret",
    response: {
      body: {
        items: {
          item: VALID_TAGO_DEPARTURE_ITEM,
        },
      },
    },
  });

  await withTagoSampleFile("secret", rawSample, async ({ runValidator }) => {
    await assert.rejects(runValidator(), /serviceKey credentials/);
  });
});

test("TAGO 시간표 sample validator는 destination field가 sample 전체에서 사라지면 거부한다", async () => {
  const { endSubwayStationNm: _unusedName, endSubwayStationId: _unusedId, ...itemWithoutDestination } =
    VALID_TAGO_DEPARTURE_ITEM;
  const rawSample = JSON.stringify({
    response: {
      body: {
        items: {
          item: itemWithoutDestination,
        },
      },
    },
  });

  await withTagoSampleFile("missing-destination", rawSample, async ({ runValidator }) => {
    await assert.rejects(runValidator(), /missing observed field: endSubwayStationNm/);
  });
});

test("TAGO 시간표 sample validator는 함수 import만으로 CLI를 실행하지 않는다", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { validateTagoScheduleSample } from './tools/datapack/validate-tago-schedule-sample.mjs'; console.log(typeof validateTagoScheduleSample);",
    ],
    { cwd: root, env: productionEnv },
  );
  assert.equal(stdout.trim(), "function");
});

test("TAGO 시간표 sample validator는 duplicate serviceKey credential을 거부한다", async () => {
  const rawSample = `{
      "serviceKey": "actual-secret",
      "serviceKey": "[서비스키값]",
      "response": {
        "body": {
          "items": {
            "item": ${JSON.stringify(VALID_TAGO_DEPARTURE_ITEM)}
          }
        }
      }
    }`;

  await withTagoSampleFile("duplicate-secret", rawSample, async ({ runValidator }) => {
    await assert.rejects(runValidator(), /serviceKey credentials/);
  });
});
