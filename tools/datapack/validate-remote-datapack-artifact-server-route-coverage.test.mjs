import assert from "node:assert/strict";
import test from "node:test";

import {
  buildValidatorArgs,
  parseRemoteDatapackArtifactArgs,
} from "./validate-remote-datapack-artifact.mjs";

test("remote production validator forwards server route coverage evidence only when supplied", () => {
  const base = parseRemoteDatapackArtifactArgs([
    "--manifest-url", "https://example.test/current.json", "--output", "out", "--require-production",
  ]);
  assert.deepEqual(buildValidatorArgs({ manifestPath: "out/catalog/current.json", outputRoot: "out", requireProduction: true, serverRouteCoverageEvidence: base["server-route-coverage-evidence"] }), ["tools/datapack/validate-datapack.mjs", "--manifest", "out/catalog/current.json", "--root", "out", "--require-production"]);
  const withEvidence = parseRemoteDatapackArtifactArgs([
    "--manifest-url", "https://example.test/current.json", "--output", "out", "--require-production", "--server-route-coverage-evidence", "authority.json", "--server-route-coverage-provenance", "provenance.json",
  ]);
  assert.deepEqual(buildValidatorArgs({ manifestPath: "out/catalog/current.json", outputRoot: "out", requireProduction: true, serverRouteCoverageEvidence: withEvidence["server-route-coverage-evidence"], serverRouteCoverageProvenance: withEvidence["server-route-coverage-provenance"] }), ["tools/datapack/validate-datapack.mjs", "--manifest", "out/catalog/current.json", "--root", "out", "--require-production", "--server-route-coverage-evidence", "authority.json", "--server-route-coverage-provenance", "provenance.json"]);
  assert.throws(() => parseRemoteDatapackArtifactArgs(["--manifest-url", "https://example.test/current.json", "--output", "out", "--require-production", "--server-route-coverage-evidence", "authority.json"]), /evidence and provenance/);
});
