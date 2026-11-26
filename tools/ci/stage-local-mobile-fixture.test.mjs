import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  stageLocalMobileFixture,
  expectedDerivedCapitalGzipSha256,
  PINNED_MOBILE_REVISION,
} from "./stage-local-mobile-fixture.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("stageLocalMobileFixture verifies pinned mobile fixture idempotently", () => {
  const result = stageLocalMobileFixture({ repositoryRoot: root });
  assert.ok(result.staged === true || result.alreadyPresent === true);

  const capitalGzipPath = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");
  assert.ok(existsSync(capitalGzipPath), "capital.sqlite.gz must exist");

  const indexPath = path.join(root, "apps/mobile/assets/datapacks/index.json");
  assert.ok(existsSync(indexPath), "index.json must exist");

  const actualSha256 = createHash("sha256").update(readFileSync(capitalGzipPath)).digest("hex");
  // 파생된 팩의 sha256은 커밋된 topology 증거가 정한다(승격마다 코드에 박지 않는다).
  assert.equal(actualSha256, expectedDerivedCapitalGzipSha256(root));
});

test("stageLocalMobileFixture rejects invalid repository root without candidates", () => {
  const nonExistent = path.join(tmpdir(), `non-existent-easysubway-${Date.now()}`);
  assert.throws(
    () => stageLocalMobileFixture({ repositoryRoot: nonExistent, candidatePaths: [] }),
    /Could not locate local mobile repository with pinned revision/
  );
});

test("stageLocalMobileFixture rejects symlink target directory before staging", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "stage-fixture-symlink-"));
  try {
    const appsDir = path.join(scratch, "apps");
    const realTarget = path.join(scratch, "real-target");
    mkdirSync(appsDir, { recursive: true });
    mkdirSync(realTarget, { recursive: true });
    symlinkSync(realTarget, path.join(appsDir, "mobile"));
    assert.throws(
      () => stageLocalMobileFixture({ repositoryRoot: scratch, candidatePaths: [] }),
      /Target mobile directory must be a real directory/
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
