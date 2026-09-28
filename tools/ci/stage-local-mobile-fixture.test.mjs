import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  stageLocalMobileFixture,
  EXPECTED_CAPITAL_GZIP_SHA256,
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
  assert.equal(actualSha256, EXPECTED_CAPITAL_GZIP_SHA256);
});

test("stageLocalMobileFixture rejects invalid repository root without candidates", () => {
  const nonExistent = path.join(tmpdir(), `non-existent-easysubway-${Date.now()}`);
  assert.throws(
    () => stageLocalMobileFixture({ repositoryRoot: nonExistent, candidatePaths: [] }),
    /Could not locate local mobile repository with pinned revision/
  );
});
