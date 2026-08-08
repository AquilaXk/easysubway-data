import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCurrentItxCollectionCli } from "./run-current-itx-collection.mjs";

test("KST 자정 양쪽에서도 주입된 단일 now를 날짜 계산과 collector에 그대로 전달한다", async () => {
  for (const now of [new Date("2026-07-19T14:59:59.999Z"), new Date("2026-07-19T15:00:00.000Z")]) {
    const dir = await mkdtemp(path.join(tmpdir(), "current-itx-collection-"));
    const freshnessOutput = path.join(dir, "freshness.json");
    const output = path.join(dir, "result.json");
    const completenessOutput = path.join(dir, "completeness.json");
    const stationCatalogPack = path.join(dir, "station-catalog-pack");
    let computeNow;
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
      computeServiceDates: (receivedNow) => {
        computeNow = receivedNow;
        return serviceDates;
      },
      collectImpl: async ({ argv, now: receivedNow }) => {
        collectorArgv = argv;
        collectorNow = receivedNow;
        return { exitCode: 0 };
      },
    });

    assert.strictEqual(computeNow, now);
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
