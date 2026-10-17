import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stageLocalMobileFixture } from "../ci/stage-local-mobile-fixture.mjs";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";
import { sha256 } from "../lib/hash.mjs";

const root = path.resolve(import.meta.dirname, "../..");
stageLocalMobileFixture({ repositoryRoot: root });

test("official snapshot admission validates exact non-production raw binding", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-official-snapshot-admission-"));
  try {
    const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
    const candidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8"));
    const inventoryPath = path.join(directory, "inventory.json");
    const candidatesPath = path.join(directory, "candidates.json");
    const source = inventory.sources.find(({ id }) => id === "molit-railway-transfer-movement");
    const candidate = candidates.candidates.find(({ id }) => id === "molit-railway-transfer-movement");
    const binding = structuredClone(candidate.rawSnapshotAdmission);
    assert.equal(source.coverageScope.mappingStatus, "UNMAPPED_RAW_SNAPSHOT");
    assert.deepEqual(source.coverageScope.regionIds, []);
    assert.deepEqual(source.coverageScope.operatorIds, []);
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await execFileAsync("node", ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath, "--candidates", candidatesPath], { cwd: root });
    for (const value of [undefined, true]) {
      if (value === undefined) delete source.productionUseAllowed;
      else source.productionUseAllowed = value;
      await writeFile(inventoryPath, JSON.stringify(inventory));
      await assert.rejects(
        execFileAsync("node", ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath, "--candidates", candidatesPath], { cwd: root }),
        /coverageScope.mappingStatus requires a non-production raw snapshot/,
      );
      source.productionUseAllowed = false;
    }
    const metadata = JSON.parse(await readFile(binding.metadataPath, "utf8"));
    assert.equal(metadata.observedRailOperatorCodes.length, 18);
    const rawBytes = gunzipSync(await readFile(path.join(path.dirname(binding.metadataPath), metadata.gzipPath)));
    const alternateGzipBytes = gzipSync(rawBytes, { level: 1, mtime: 0 });
    const alternateGzipSha256 = sha256(alternateGzipBytes);
    assert.notEqual(alternateGzipSha256, metadata.gzipSha256);
    const alternateMetadata = { ...metadata, gzipSha256: alternateGzipSha256 };
    const alternateMetadataBytes = Buffer.from(JSON.stringify(alternateMetadata));
    const alternateMetadataPath = path.join(directory, "alternate-compression.json");
    await writeFile(path.join(directory, metadata.gzipPath), alternateGzipBytes);
    await writeFile(alternateMetadataPath, alternateMetadataBytes);
    const alternateBinding = {
      ...binding,
      metadataPath: alternateMetadataPath,
      metadataFileSha256: sha256(alternateMetadataBytes),
      gzipSha256: alternateGzipSha256,
    };
    source.rawSnapshotAdmission = structuredClone(alternateBinding);
    candidate.rawSnapshotAdmission = structuredClone(alternateBinding);
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await execFileAsync("node", ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath, "--candidates", candidatesPath], { cwd: root });
    source.rawSnapshotAdmission = structuredClone(binding);
    candidate.rawSnapshotAdmission = structuredClone(binding);
    const mappedSource = inventory.sources.find(({ id }) => id !== source.id);
    const mappedRegionIds = mappedSource.coverageScope.regionIds;
    mappedSource.coverageScope.regionIds = [];
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await assert.rejects(
      execFileAsync("node", ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath, "--candidates", candidatesPath], { cwd: root }),
      /coverageScope.regionIds must be a non-empty array/,
    );
    mappedSource.coverageScope.regionIds = mappedRegionIds;
    // #862: 판이 바뀌면 고정 날짜가 실제 값과 같아질 수 있어, 현재 metadata에서 하루 뒤로 바꾼 값을 쓴다.
    const metadataOnlyMutation = { ...metadata, freshUntil: new Date(Date.parse(metadata.freshUntil) + 86_400_000).toISOString() };
    const metadataOnlyMutationBytes = Buffer.from(JSON.stringify(metadataOnlyMutation));
    const metadataOnlyMutationPath = path.join(directory, `${binding.snapshotId}.csv.gz.json`);
    await writeFile(path.join(directory, metadata.gzipPath), await readFile(path.join(path.dirname(binding.metadataPath), metadata.gzipPath)));
    await writeFile(metadataOnlyMutationPath, metadataOnlyMutationBytes);
    source.rawSnapshotAdmission.metadataPath = metadataOnlyMutationPath;
    source.rawSnapshotAdmission.metadataFileSha256 = sha256(metadataOnlyMutationBytes);
    candidate.rawSnapshotAdmission = structuredClone(source.rawSnapshotAdmission);
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(execFileAsync("node", ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath, "--candidates", candidatesPath], { cwd: root }), /official snapshot metadata mismatch/);
    source.rawSnapshotAdmission = structuredClone(binding);
    candidate.rawSnapshotAdmission = structuredClone(binding);
    const invalidTimestampMetadataBytes = Buffer.from(JSON.stringify({ ...metadata, capturedAt: "2026-07-29" }));
    const invalidTimestampMetadataPath = path.join(directory, "invalid-timestamp.json");
    await writeFile(invalidTimestampMetadataPath, invalidTimestampMetadataBytes);
    source.rawSnapshotAdmission.metadataPath = invalidTimestampMetadataPath;
    source.rawSnapshotAdmission.metadataFileSha256 = sha256(invalidTimestampMetadataBytes);
    candidate.rawSnapshotAdmission = structuredClone(source.rawSnapshotAdmission);
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(execFileAsync("node", ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath, "--candidates", candidatesPath], { cwd: root }), /RFC 3339 UTC timestamp/);
    source.rawSnapshotAdmission = structuredClone(binding);
    candidate.rawSnapshotAdmission = structuredClone(binding);
    candidate.admissionStatus = "PENDING";
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(
      execFileAsync("node", ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath, "--candidates", candidatesPath], { cwd: root }),
      /official snapshot admissionStatus invalid/,
    );
    candidate.admissionStatus = "official_snapshot_admitted";
    source.rawSnapshotAdmission.rawSha256 = "0".repeat(64);
    candidate.rawSnapshotAdmission.rawSha256 = "0".repeat(64);
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(execFileAsync("node", ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath, "--candidates", candidatesPath], { cwd: root }), /raw hash is not the pinned provider artifact/);
    source.rawSnapshotAdmission = structuredClone(binding);
    candidate.rawSnapshotAdmission = structuredClone(binding);
    candidates.candidates = candidates.candidates.filter(({ id }) => id !== candidate.id);
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(execFileAsync("node", ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath, "--candidates", candidatesPath], { cwd: root }), /official snapshot requires an admitted candidate/);
    candidates.candidates.push(candidate);
    const mutatedRawBytes = Buffer.from(rawBytes);
    mutatedRawBytes[mutatedRawBytes.length - 1] ^= 1;
    const mutatedGzipBytes = gzipSync(mutatedRawBytes, { mtime: 0 });
    const mutatedRawSha256 = sha256(mutatedRawBytes);
    const mutatedMetadata = { ...metadata, rawSha256: mutatedRawSha256, gzipSha256: sha256(mutatedGzipBytes) };
    const mutatedMetadataBytes = Buffer.from(JSON.stringify(mutatedMetadata));
    const mutatedMetadataPath = path.join(directory, "mutated-snapshot.json");
    await writeFile(path.join(directory, metadata.gzipPath), mutatedGzipBytes);
    await writeFile(mutatedMetadataPath, mutatedMetadataBytes);
    const mutatedBinding = {
      ...binding,
      metadataPath: mutatedMetadataPath,
      metadataFileSha256: sha256(mutatedMetadataBytes),
      rawSha256: mutatedRawSha256,
      gzipSha256: sha256(mutatedGzipBytes),
    };
    source.rawSnapshotAdmission = structuredClone(mutatedBinding);
    candidate.rawSnapshotAdmission = structuredClone(mutatedBinding);
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(execFileAsync("node", ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath, "--candidates", candidatesPath], { cwd: root }), /raw hash is not the pinned provider artifact/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("source inventory 검증기는 required source의 라이선스와 갱신일 누락을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  invalidInventory.sources[0].license.type = "";
  invalidInventory.sources[1].observedDataUpdatedAt = "";

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /license.type is required|observedDataUpdatedAt is required/,
  );
});

test("source inventory 검증기는 알 수 없는 라이선스 유형을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  invalidInventory.sources[0].license.type = "UNKNOWN";

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-unknown-license-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /license.type must be KOGL-1/,
  );
});

test("source inventory 검증기는 공공데이터포털 이용허락범위 제한 없음 source를 허용한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const freeUseInventory = structuredClone(sourceInventory);
  freeUseInventory.sources[0].license = {
    type: "PUBLIC_DATA_FREE_USE",
    name: "공공데이터포털 이용허락범위 제한 없음",
    attribution: "공공데이터포털 이용허락범위 제한 없음",
    commercialUseAllowed: true,
    derivativeWorkAllowed: true,
    redistributionAllowed: true,
    evidenceUrl: "https://www.data.go.kr/data/15098554/openapi.do",
  };

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-free-use-license-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(freeUseInventory, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-inventory.mjs",
      "--inventory",
      inventoryPath,
    ],
    { cwd: root },
  );
});

test("source inventory 검증기는 coverageScope 누락을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  delete invalidInventory.sources[0].coverageScope;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-coverage-scope-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /coverageScope must be an object/,
  );
});

test("source inventory 검증기는 중복 lineIds를 거부한다", async () => {
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  inventory.sources[0].coverageScope.lineIds = ["seoul-4", "seoul-4"];
  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-line-scope-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath],
      { cwd: root },
    ),
    /coverageScope\.lineIds must not contain duplicates/,
  );
});

test("source inventory 검증기는 schedule/realtime/facility capability 누락을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  delete invalidInventory.sources[0].capabilities;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-capabilities-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /capabilities must be an object/,
  );
});

test("source inventory 검증기는 provider 조건이 막힌 live ETA 승격을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  const realtimeSource = invalidInventory.sources.find((source) => source.id === "seoul-realtime-arrival-station-info");
  realtimeSource.capabilities = {
    schedule: {
      status: "UNSUPPORTED",
      productionUseAllowed: false,
      coverageStatus: "NOT_PROVIDED_BY_SOURCE",
      updateFrequency: realtimeSource.updateFrequency,
      unsupportedNotes: "realtime arrival source does not provide scheduled timetable data",
    },
    realtime: {
      status: "CANDIDATE",
      productionUseAllowed: false,
      liveEtaEligible: false,
      rateLimitStatus: "BLOCKED_PENDING_PROVIDER_TERMS_OR_QUOTA",
      coverageStatus: "SOURCE_INVENTORY_COVERED",
      updateFrequency: realtimeSource.updateFrequency,
      unsupportedNotes: "provider terms and rate limits are not approved for production live ETA",
    },
    facility: {
      status: "UNSUPPORTED",
      productionUseAllowed: false,
      coverageStatus: "NOT_PROVIDED_BY_SOURCE",
      updateFrequency: realtimeSource.updateFrequency,
      unsupportedNotes: "realtime arrival source does not provide facility data",
    },
  };
  realtimeSource.capabilities.realtime.liveEtaEligible = true;
  realtimeSource.capabilities.realtime.rateLimitStatus = "BLOCKED_PENDING_PROVIDER_TERMS_OR_QUOTA";

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-live-eta-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /live ETA requires compatible provider terms and rate limits/,
  );
});

test("source inventory 검증기는 candidate capability의 production 사용 승격을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  const scheduleSource = invalidInventory.sources.find((source) => source.id === "molit-tago-subway-info");
  scheduleSource.capabilities.schedule.productionUseAllowed = true;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-candidate-production-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /productionUseAllowed requires SUPPORTED status/,
  );
});

test("source inventory 검증기는 admitted candidate의 admission evidence 누락을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  const source = invalidInventory.sources.find((entry) => entry.id === "molit-tago-subway-info");
  delete source.admissionEvidence;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-admission-evidence-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /molit-tago-subway-info\.admissionEvidence must be an object/,
  );
});

test("source inventory 검증기는 admitted candidate sample evidence hash 불일치를 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  const source = invalidInventory.sources.find((entry) => entry.id === "molit-tago-subway-info");
  source.admissionEvidence.sampleEvidenceHash = sha256("wrong-sample-evidence");

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-admission-hash-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /molit-tago-subway-info\.admissionEvidence\.sampleEvidenceHash must be/,
  );
});

test("source inventory 검증기는 admitted candidate live sample evidence hash 누락을 거부한다", async () => {
  const sourceCandidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8"));
  const invalidCandidates = structuredClone(sourceCandidates);
  const candidate = invalidCandidates.candidates.find((entry) => entry.id === "molit-tago-subway-info");
  delete candidate.evidence.liveSampleEvidenceHash;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-candidate-admission-hash-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(candidatesPath, `${JSON.stringify(invalidCandidates, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--candidates",
        candidatesPath,
      ],
      { cwd: root },
    ),
    /molit-tago-subway-info\.evidence\.liveSampleEvidenceHash is required/,
  );
});

test("source inventory 검증기는 v1 optional source가 production 필수로 남는 것을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  invalidInventory.sources.find((source) => source.id === "kric-disabled-toilet").requiredForProductionPack = true;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-optional-scope-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
        "--scope",
        "release/product-gates/production-datapack-scope.json",
      ],
      { cwd: root },
    ),
    /optional source .* must not be requiredForProductionPack/,
  );
});

test("source inventory 검증기는 admitted candidate의 quota evidence 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-quota-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const promotedInventoryPath = path.join(outputDir, "source-inventory.quota-blocked-production.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const source = inventory.sources.find((entry) => entry.id === "seoul-realtime-arrival-station-info");
  delete source.admissionEvidence.quotaEvidence;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /seoul-realtime-arrival-station-info\.admissionEvidence\.quotaEvidence must be an object/,
  );

  const promotedInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const promotedSource = promotedInventory.sources.find((entry) => entry.id === "molit-tago-subway-info");
  promotedSource.capabilities.schedule.status = "SUPPORTED";
  promotedSource.capabilities.schedule.productionUseAllowed = true;
  await writeFile(promotedInventoryPath, `${JSON.stringify(promotedInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        promotedInventoryPath,
      ],
      { cwd: root },
    ),
    /molit-tago-subway-info\.admissionEvidence\.quotaEvidence\.productionUseAllowed must be true when source has production capability/,
  );
});

test("source inventory 검증기는 같은 shared quota store의 hard limit 불일치를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-shared-quota-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const trainPosition = inventory.sources.find((entry) => entry.id === "seoul-topis-realtime-train-position");
  trainPosition.admissionEvidence.quotaEvidence.runtimeDailyHardLimit = 799;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath],
      { cwd: root },
    ),
    /shared quota store realtime_provider_call_quota_state must use identical runtime hard limits/,
  );
});

test("source inventory 검증기는 guarded realtime quota의 shared store 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-guarded-quota-store-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const arrival = inventory.sources.find((entry) => entry.id === "seoul-realtime-arrival-station-info");
  delete arrival.admissionEvidence.quotaEvidence.sharedQuotaStore;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath],
      { cwd: root },
    ),
    /seoul-realtime-arrival-station-info\.guarded realtime requires sharedQuotaStore/,
  );
});

test("source inventory는 official OD fare admission hash 쌍을 함께 요구한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const validInventory = structuredClone(sourceInventory);
  const fareSource = validInventory.sources.find(({ id }) => id === "seoul-metro-official-od-fares");
  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-inventory-"));
  try {
    const validPath = path.join(workspace, "valid.json");
    await writeFile(validPath, JSON.stringify(validInventory));
    await execFileAsync(process.execPath, [
      "tools/datapack/validate-source-inventory.mjs", "--inventory", validPath,
    ], { cwd: root });

    const invalidInventory = structuredClone(validInventory);
    delete invalidInventory.sources.find(({ id }) => id === fareSource.id).fareStationLineMappingLedgerHash;
    const invalidPath = path.join(workspace, "invalid.json");
    await writeFile(invalidPath, JSON.stringify(invalidInventory));
    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/validate-source-inventory.mjs", "--inventory", invalidPath,
      ], { cwd: root }),
      /fareStationLineMappingLedgerHash must be a sha256 hex string/,
    );

    const nonFareInventory = structuredClone(sourceInventory);
    const nonFareSource = nonFareInventory.sources.find(({ id }) => id === "kric-disabled-toilet");
    nonFareSource.officialOdFareAdmissionHash = "a".repeat(64);
    nonFareSource.fareStationLineMappingLedgerHash = "b".repeat(64);
    const nonFarePath = path.join(workspace, "non-fare.json");
    await writeFile(nonFarePath, JSON.stringify(nonFareInventory));
    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/validate-source-inventory.mjs", "--inventory", nonFarePath,
      ], { cwd: root }),
      /official OD fare references require all six official fare fields/,
    );

    const partialFareInventory = structuredClone(nonFareInventory);
    partialFareInventory.sources.find(({ id }) => id === "kric-disabled-toilet").fieldsProvided.push("gnrlCardFare");
    const partialFarePath = path.join(workspace, "partial-fare.json");
    await writeFile(partialFarePath, JSON.stringify(partialFareInventory));
    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/validate-source-inventory.mjs", "--inventory", partialFarePath,
      ], { cwd: root }),
      /official OD fare references require all six official fare fields/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("official OD fare candidate admission은 inventory hash 쌍과 일치해야 한다", async () => {
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const candidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8"));
  const source = inventory.sources.find(({ id }) => id === "seoul-metro-official-od-fares");
  const candidate = candidates.candidates.find(({ id }) => id === "seoul-metro-official-od-fares");
  const admissionBundle = JSON.parse(
    await readFile(path.join(root, "tools/datapack/official-od-fare-admission.json"), "utf8"),
  );
  const admission = admissionBundle.admissions.find(
    ({ sourceId }) => sourceId === "seoul-metro-official-od-fares",
  );

  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-candidate-"));
  try {
    const inventoryPath = path.join(workspace, "inventory.json");
    const candidatesPath = path.join(workspace, "candidates.json");
    const admissionPath = path.join(workspace, "admission.json");
    const validate = () => execFileAsync(process.execPath, [
      "tools/datapack/validate-source-inventory.mjs",
      "--inventory", inventoryPath,
      "--candidates", candidatesPath,
      "--official-od-fare-admission", admissionPath,
    ], { cwd: root });
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await writeFile(admissionPath, JSON.stringify(admissionBundle, null, 2) + "\n");
    await validate();

    candidate.evidence.fareStationLineMappingLedgerHash = "c".repeat(64);
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(validate(), /fareStationLineMappingLedgerHash must match/);

    candidate.evidence.fareStationLineMappingLedgerHash = source.fareStationLineMappingLedgerHash;
    candidate.domain = "accessibility_facilities";
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(validate(), /candidate domain must be "official_od_fares"/);

    candidate.domain = "official_od_fares";
    source.coverageScope.sourceDomains = ["accessibility_facilities"];
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(validate(), /source domain must be official_od_fares/);

    source.coverageScope.sourceDomains = ["official_od_fares"];
    candidate.admissionStatus = "evidence_recorded_admin_review_required";
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(validate(), /official OD fare source requires an admitted candidate/);

    candidate.admissionStatus = "official_od_fare_admitted_to_production_inventory";
    admission.decision = "REJECTED";
    const rejectedBytes = JSON.stringify(admissionBundle, null, 2) + "\n";
    source.officialOdFareAdmissionHash = sha256(rejectedBytes);
    candidate.evidence.officialOdFareAdmissionHash = source.officialOdFareAdmissionHash;
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await writeFile(admissionPath, rejectedBytes);
    await assert.rejects(validate(), /admission decision must be "APPROVED"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
