import assert from "node:assert/strict";
import test from "node:test";

import { validateKricLine4PilotCollectionArtifact } from "./apply-kric-line4-pilot-schedule.mjs";

test("KRIC pilot artifact는 명시적인 허용 sourceId를 요구한다", () => {
  assert.throws(
    () => validateKricLine4PilotCollectionArtifact({ artifactKind: "kric-line4-timetable-collection" }),
    /sourceId is required/,
  );
  assert.throws(
    () => validateKricLine4PilotCollectionArtifact({
      artifactKind: "kric-line4-timetable-collection",
      sourceId: "untrusted-source",
    }),
    /sourceId mismatch/,
  );
});
