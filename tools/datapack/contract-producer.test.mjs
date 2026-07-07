import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateJson } from "../ci/check-contracts.mjs";

test("build-datapack 산출 manifest가 계약 스키마를 통과한다", () => {
  const out = mkdtempSync(join(tmpdir(), "dp-contract-"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  try {
    execFileSync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        "tools/datapack/fixtures/catalog-fixture.json",
        "--output",
        out,
      ],
      {
        env: {
          ...process.env,
          EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }),
          EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }),
        },
      },
    );

    const errors = [];
    validateJson("contracts/datapack/datapack-manifest.schema.json", join(out, "current.json"), errors);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("v2 datapack manifest는 activePack 없이 계약 스키마를 통과한다", () => {
  const out = mkdtempSync(join(tmpdir(), "dp-contract-v2-"));
  const fixturePath = join(out, "fixture-v2.json");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  try {
    const fixture = JSON.parse(readFileSync("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
    fixture.manifest = {
      ...fixture.manifest,
      manifestVersion: 2,
      channel: "production",
      releaseSequence: 7,
      publishedAt: "2026-06-25T00:00:00.000Z",
      expiresAt: "2026-06-26T00:00:00.000Z",
      keyId: "fixture-key",
    };
    delete fixture.manifest.activePack;
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

    execFileSync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", out],
      {
        env: {
          ...process.env,
          EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }),
          EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }),
          EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "fixture-key",
        },
      },
    );

    const manifest = JSON.parse(readFileSync(join(out, "current.json"), "utf8"));
    const errors = [];
    validateJson("contracts/datapack/datapack-manifest.schema.json", join(out, "current.json"), errors);
    assert.equal("activePack" in manifest, false);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
