import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCurrentItxCollectionCli } from "./run-current-itx-collection.mjs";

test("current ITX wrapper는 malformed credential로 holiday delegate를 호출하지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "current-itx-invalid-key-"));
  let calls = 0;
  try {
    const args = ["--output", path.join(directory, "output.json"), "--completeness-output", path.join(directory, "completeness.json"), "--station-catalog-pack", path.join(directory, "pack"), "--freshness-output", path.join(directory, "freshness.json")];
    await assert.rejects(runCurrentItxCollectionCli({ argv: args, env: { DATA_GO_KR_SERVICE_KEY: "invalid%ZZ" }, fetchHolidayCalendar: async () => { calls += 1; return new Set(); } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("KST 자정 양쪽에서도 주입된 단일 now를 날짜 계산과 collector에 그대로 전달한다", async () => {
  for (const now of [new Date("2026-07-19T14:59:59.999Z"), new Date("2026-07-19T15:00:00.000Z")]) {
    const dir = await mkdtemp(path.join(tmpdir(), "current-itx-collection-"));
    const freshnessOutput = path.join(dir, "freshness.json");
    const output = path.join(dir, "result.json");
    const completenessOutput = path.join(dir, "completeness.json");
    const stationCatalogPack = path.join(dir, "station-catalog-pack");
    let collectorNow;
    let collectorArgv;
    const serviceDates = now.toISOString() === "2026-07-19T14:59:59.999Z"
      ? { "8": "20260720", "7": "20260725", "9": "20260719" }
      : { "8": "20260720", "7": "20260725", "9": "20260726" };

    const result = await runCurrentItxCollectionCli({
      argv: [
        "--output", output,
        "--completeness-output", completenessOutput,
        "--station-catalog-pack", stationCatalogPack,
        "--freshness-output", freshnessOutput,
      ],
      now,
      fetchPublicHolidays: async ({ now: receivedNow }) => {
        assert.strictEqual(receivedNow, now);
        return new Set();
      },
      collectImpl: async ({ argv, now: receivedNow }) => {
        collectorArgv = argv;
        collectorNow = receivedNow;
        return { exitCode: 0 };
      },
    });

    assert.strictEqual(collectorNow, now);
    assert.deepEqual(result.serviceDates, serviceDates);
    assert.deepEqual(JSON.parse(await readFile(freshnessOutput, "utf8")), {
      schemaVersion: 1,
      artifactKind: "itx-admission-service-dates",
      timezone: "Asia/Seoul",
      serviceDates,
    });
    assert.deepEqual(collectorArgv, [
      "--output", output,
      "--completeness-output", completenessOutput,
      "--station-catalog-pack", stationCatalogPack,
      "--day8-date", serviceDates["8"],
      "--day7-date", serviceDates["7"],
      "--day9-date", serviceDates["9"],
    ]);
  }
});

test("current collection wrapper는 연말 7일 창의 각 연도 KASI 월을 모두 조회한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "current-itx-collection-year-boundary-"));
  const requests = [];
  await runCurrentItxCollectionCli({
    argv: [
      "--output", path.join(dir, "result.json"),
      "--completeness-output", path.join(dir, "completeness.json"),
      "--station-catalog-pack", path.join(dir, "station-catalog-pack"),
      "--freshness-output", path.join(dir, "freshness.json"),
    ],
    env: { DATA_GO_KR_SERVICE_KEY: "test-key" },
    now: new Date("2026-12-30T15:00:00.000Z"),
    fetchHolidayCalendar: async ({ year, months }) => {
      requests.push({ year, months: [...months].sort((left, right) => left - right) });
      return new Set();
    },
    collectImpl: async () => ({ exitCode: 0 }),
  });
  assert.deepEqual(requests, [{ year: 2026, months: [12] }, { year: 2027, months: [1] }]);
});

test("current collection wrapper는 평일 공휴일과 대체공휴일을 day9로 분류하고 평일 비휴일만 day8로 수집한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "current-itx-collection-holiday-"));
  let collectorArgv;
  await runCurrentItxCollectionCli({
    argv: [
      "--output", path.join(dir, "result.json"),
      "--completeness-output", path.join(dir, "completeness.json"),
      "--station-catalog-pack", path.join(dir, "station-catalog-pack"),
      "--freshness-output", path.join(dir, "freshness.json"),
    ],
    now: new Date("2026-08-16T15:00:00.000Z"),
    fetchPublicHolidays: async () => new Set(["20260817"]),
    collectImpl: async ({ argv }) => {
      collectorArgv = argv;
      return { exitCode: 0 };
    },
  });
  assert.deepEqual(collectorArgv.slice(-6), ["--day8-date", "20260818", "--day7-date", "20260822", "--day9-date", "20260817"]);
});

test("current collection wrapper는 exact allowlist 밖의 date override·replay·fallback을 거부한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "current-itx-collection-contract-"));
  const args = [
    "--output", path.join(dir, "result.json"),
    "--completeness-output", path.join(dir, "completeness.json"),
    "--station-catalog-pack", path.join(dir, "station-catalog-pack"),
    "--freshness-output", path.join(dir, "freshness.json"),
  ];
  for (const forbidden of [["--day8-date", "20260720"], ["--replay"], ["--fallback", "legacy"]]) {
    await assert.rejects(
      runCurrentItxCollectionCli({ argv: [...args, ...forbidden] }),
      /current ITX collection requires exactly --output, --completeness-output, --station-catalog-pack, and --freshness-output/,
    );
  }
});

test("current collection wrapper는 output root·부재·station child 경계를 fail-closed한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "current-itx-collection-boundary-"));
  const output = path.join(dir, "result.json");
  const completenessOutput = path.join(dir, "completeness.json");
  const freshnessOutput = path.join(dir, "freshness.json");
  const stationCatalogPack = path.join(dir, "station-catalog-pack");
  const args = (overrides = {}) => [
    "--output", overrides.output ?? output,
    "--completeness-output", overrides.completenessOutput ?? completenessOutput,
    "--station-catalog-pack", overrides.stationCatalogPack ?? stationCatalogPack,
    "--freshness-output", overrides.freshnessOutput ?? freshnessOutput,
  ];
  const rejects = (argv, message) => assert.rejects(
    runCurrentItxCollectionCli({ argv }),
    new RegExp(message),
  );

  await rejects(args({ output: "result.json" }), "paths must be absolute");
  await rejects(args({ completenessOutput: path.join(dir, "other", "completeness.json") }), "output paths must share one parent");
  await rejects(args({ freshnessOutput: output }), "output paths must differ");
  await rejects(args({ stationCatalogPack: path.join(path.dirname(dir), "outside-catalog") }), "station catalog pack must be a separate child");

  await writeFile(freshnessOutput, "already exists\n");
  await rejects(args(), "output paths must be absent");
});

test("current collection wrapper는 symlink 또는 교체된 output parent에 freshness를 쓰지 않는다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "current-itx-collection-parent-"));
  const outside = await mkdtemp(path.join(tmpdir(), "current-itx-collection-outside-"));
  const parent = path.join(root, "output");
  await mkdir(parent);
  const args = [
    "--output", path.join(parent, "result.json"),
    "--completeness-output", path.join(parent, "completeness.json"),
    "--station-catalog-pack", path.join(parent, "station-catalog-pack"),
    "--freshness-output", path.join(parent, "freshness.json"),
  ];
  await rename(parent, `${parent}-original`);
  await symlink(outside, parent);
  await assert.rejects(runCurrentItxCollectionCli({ argv: args }), /output parent must be an existing non-symlink directory/);
  await assert.rejects(lstat(path.join(outside, "freshness.json")));

  await unlink(parent);
  await mkdir(parent);
  await assert.rejects(runCurrentItxCollectionCli({
    argv: args,
    fetchPublicHolidays: async () => new Set(),
    beforeFreshnessWrite: async () => {
      await rename(parent, `${parent}-replaced`);
      await symlink(outside, parent);
    },
  }), /output parent was replaced/);
  await assert.rejects(lstat(path.join(outside, "freshness.json")));
  await assert.rejects(lstat(path.join(`${parent}-replaced`, "freshness.json")));
});

test("KASI 실패에서는 collector와 freshness·output·completeness 생성이 모두 발생하지 않는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "current-itx-collection-kasi-failure-"));
  const output = path.join(dir, "result.json");
  const completenessOutput = path.join(dir, "completeness.json");
  const freshnessOutput = path.join(dir, "freshness.json");
  let collectorCalls = 0;
  await assert.rejects(runCurrentItxCollectionCli({
    argv: ["--output", output, "--completeness-output", completenessOutput, "--station-catalog-pack", path.join(dir, "station-catalog-pack"), "--freshness-output", freshnessOutput],
    fetchPublicHolidays: async () => { throw new Error("KASI public holiday request failed: HTTP_403"); },
    collectImpl: async () => { collectorCalls += 1; return { exitCode: 0 }; },
  }), /KASI public holiday request failed: HTTP_403/);
  assert.equal(collectorCalls, 0);
  await assert.rejects(lstat(output));
  await assert.rejects(lstat(completenessOutput));
  await assert.rejects(lstat(freshnessOutput));
});

test("공휴일 토요일만 있는 7일 창은 day7 evidence 없이 collector 전에 fail closed한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "current-itx-collection-holiday-saturday-"));
  const output = path.join(dir, "result.json");
  const completenessOutput = path.join(dir, "completeness.json");
  const freshnessOutput = path.join(dir, "freshness.json");
  let collectorCalls = 0;
  await assert.rejects(runCurrentItxCollectionCli({
    argv: ["--output", output, "--completeness-output", completenessOutput, "--station-catalog-pack", path.join(dir, "station-catalog-pack"), "--freshness-output", freshnessOutput],
    now: new Date("2026-08-15T15:00:00.000Z"),
    fetchPublicHolidays: async () => new Set(["20260822"]),
    collectImpl: async () => { collectorCalls += 1; return { exitCode: 0 }; },
  }), /no holiday-aware ITX admission date within window/);
  assert.equal(collectorCalls, 0);
  await assert.rejects(lstat(output));
  await assert.rejects(lstat(completenessOutput));
  await assert.rejects(lstat(freshnessOutput));
});
