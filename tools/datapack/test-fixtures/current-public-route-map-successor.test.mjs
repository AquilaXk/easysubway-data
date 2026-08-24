import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activateSyntheticCurrentPublicRouteMapSuccessor,
  copySyntheticCurrentPublicRouteMapRepository,
} from "./current-public-route-map-successor.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

test("current public candidate slot derives its complete legacy predecessor contract on a topology-only refresh", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-predecessor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: new Date("2026-08-22T09:45:18.609Z"),
  });

  const before = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  assert.equal(before.sourceSnapshots[0].sourceId, "seoul-metro-route-map-positions");

  const result = await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now: new Date("2026-08-22T10:45:18.609Z"),
  });
  assert.equal(result.predecessorSnapshotId, "seoulmetro-cyberstation-route-map-capital-admission-20260712");

  const after = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  assert.equal(after.sourceSnapshots[0].sourceId, "seoul-metro-route-map-positions");
  assert.equal(after.sourceSnapshotIds[0], result.snapshotId);
});
