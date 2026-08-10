import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildServerRouteBundleFinal,
  canonicalServerRouteBundleFinalJson,
  validateServerRouteBundleFinal,
} from "./server-route-bundle-final.mjs";

const SHA = (value) => value.repeat(64);
const GATES = [
  "sourceFreshness",
  "stationLineAccessibility",
  "routeEdgeEvaluation",
  "artifactInventory",
  "signature",
  "publication",
  "rebuildParityPromotion",
];
const GATE_STATES = {
  sourceFreshness: ["PASS", "UNAVAILABLE", "STALE", "PARTIAL", "IDENTITY_MISMATCH"],
  stationLineAccessibility: ["PASS", "UNAVAILABLE", "MISSING", "STALE", "UNKNOWN", "PARTIAL", "IDENTITY_MISMATCH"],
  routeEdgeEvaluation: ["PASS", "UNAVAILABLE", "MISSING", "STALE", "UNKNOWN", "NOT_EVALUATED", "PARTIAL", "IDENTITY_MISMATCH"],
  artifactInventory: ["PASS", "UNAVAILABLE", "MISSING", "PARTIAL", "IDENTITY_MISMATCH"],
  signature: ["PASS", "UNAVAILABLE", "IDENTITY_MISMATCH"],
  publication: ["PASS", "UNAVAILABLE", "IDENTITY_MISMATCH"],
  rebuildParityPromotion: ["PASS", "UNAVAILABLE", "PARTIAL", "IDENTITY_MISMATCH"],
};

function passingInput() {
  return {
    candidate: {
      repository: "AquilaXk/easysubway-data",
      gitSha: "1".repeat(40),
      bundleId: "capital-route-bundle-20260810",
      releaseSequence: 1,
      stationSetSha256: SHA("2"),
      sourceSnapshotSetHash: SHA("3"),
      signingInputSha256: SHA("4"),
      signedManifestRawSha256: SHA("5"),
      payloadRootSha256: SHA("6"),
      componentInventorySha256: SHA("7"),
      componentDigests: {
        topology: SHA("8"),
        timetable: SHA("9"),
        accessibility: SHA("a"),
        fare: SHA("b"),
      },
      activeFrom: "2026-08-10T09:00:00.000+09:00",
      freshUntil: "2026-08-11T09:00:00.000+09:00",
      keyId: "production-2026-08",
    },
    gates: Object.fromEntries(GATES.map((gate, index) => [
      gate,
      { state: "PASS", evidenceSha256: (index + 1).toString(16).repeat(64) },
    ])),
  };
}

function withGate(gate, state) {
  const input = passingInput();
  input.gates[gate] = {
    state,
    evidenceSha256: state === "UNAVAILABLE" ? null : SHA("c"),
  };
  return input;
}

test("모든 exact gate와 raw identity가 닫힌 candidate만 GO다", () => {
  const input = passingInput();
  const before = structuredClone(input);
  const result = buildServerRouteBundleFinal(input);

  assert.deepEqual(input, before);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.artifactKind, "server-route-bundle-final");
  assert.equal(result.result, "GO");
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.candidate, input.candidate);
  assert.deepEqual(result.gates, input.gates);
  assert.match(result.finalSha256, /^[a-f0-9]{64}$/);
  assert.equal(validateServerRouteBundleFinal(result).finalSha256, result.finalSha256);
  assert.equal(canonicalServerRouteBundleFinalJson(result), JSON.stringify(result));
});

test("각 unresolved gate는 deterministic NO_GO blocker가 되고 UNAVAILABLE만 null evidence를 허용한다", async (context) => {
  const cases = [
    ["sourceFreshness", "STALE"],
    ["stationLineAccessibility", "MISSING"],
    ["routeEdgeEvaluation", "NOT_EVALUATED"],
    ["artifactInventory", "PARTIAL"],
    ["signature", "UNAVAILABLE"],
    ["publication", "UNAVAILABLE"],
    ["rebuildParityPromotion", "PARTIAL"],
  ];
  for (const [gate, state] of cases) {
    await context.test(`${gate}:${state}`, () => {
      const result = buildServerRouteBundleFinal(withGate(gate, state));
      assert.equal(result.result, "NO_GO");
      assert.deepEqual(result.blockers, [`${gate}:${state}`]);
      assert.equal(validateServerRouteBundleFinal(result).finalSha256, result.finalSha256);
    });
  }

  const unavailableWithHash = withGate("signature", "UNAVAILABLE");
  unavailableWithHash.gates.signature.evidenceSha256 = SHA("d");
  assert.throws(() => buildServerRouteBundleFinal(unavailableWithHash), /UNAVAILABLE evidenceSha256 must be null/);

  const staleWithoutHash = withGate("sourceFreshness", "STALE");
  staleWithoutHash.gates.sourceFreshness.evidenceSha256 = null;
  assert.throws(() => buildServerRouteBundleFinal(staleWithoutHash), /evidenceSha256 must be sha256/);
});

test("GO의 signed manifest와 payload/component raw identity 누락을 거부한다", () => {
  for (const field of ["signedManifestRawSha256", "payloadRootSha256", "componentInventorySha256"]) {
    const input = passingInput();
    input.candidate[field] = null;
    assert.throws(() => buildServerRouteBundleFinal(input), new RegExp(`${field} is required for GO`));
  }
  for (const component of ["topology", "timetable", "accessibility", "fare"]) {
    const input = passingInput();
    input.candidate.componentDigests[component] = null;
    assert.throws(() => buildServerRouteBundleFinal(input), new RegExp(`componentDigests\\.${component} is required for GO`));
  }
});

test("closed identity, state, time, result, blocker와 finalSha256 변조를 fail closed한다", () => {
  const mutations = [
    ["input extra", (input) => { input.extra = true; }, /input keys mismatch/],
    ["candidate extra", (input) => { input.candidate.extra = true; }, /candidate keys mismatch/],
    ["gates missing", (input) => { delete input.gates.publication; }, /gates keys mismatch/],
    ["state", (input) => { input.gates.signature.state = "SKIPPED"; }, /signature state is invalid/],
    ["git sha", (input) => { input.candidate.gitSha = "1".repeat(39); }, /gitSha/],
    ["sha", (input) => { input.candidate.stationSetSha256 = "A".repeat(64); }, /stationSetSha256/],
    ["sequence", (input) => { input.candidate.releaseSequence = 0; }, /releaseSequence/],
    ["time", (input) => { input.candidate.activeFrom = "2026-08-10T00:00:00.000Z"; }, /activeFrom/],
    ["ordering", (input) => { input.candidate.freshUntil = input.candidate.activeFrom; }, /activeFrom must be before freshUntil/],
  ];
  for (const [name, mutate, expected] of mutations) {
    const input = passingInput();
    mutate(input);
    assert.throws(() => buildServerRouteBundleFinal(input), expected, name);
  }

  const valid = buildServerRouteBundleFinal(passingInput());
  const wrongResult = { ...valid, result: "NO_GO" };
  assert.throws(() => validateServerRouteBundleFinal(wrongResult), /result mismatch/);
  const wrongBlocker = { ...valid, blockers: ["signature:UNAVAILABLE"] };
  assert.throws(() => validateServerRouteBundleFinal(wrongBlocker), /blockers mismatch/);
  const wrongDigest = { ...valid, finalSha256: SHA("f") };
  assert.throws(() => validateServerRouteBundleFinal(wrongDigest), /finalSha256 mismatch/);
  const extra = { ...valid, extra: true };
  assert.throws(() => validateServerRouteBundleFinal(extra), /FINAL keys mismatch/);
});

test("blocker와 canonical bytes는 input object insertion order와 반복에 무관하다", () => {
  const firstInput = withGate("publication", "UNAVAILABLE");
  firstInput.gates.signature = { state: "UNAVAILABLE", evidenceSha256: null };
  const first = buildServerRouteBundleFinal(firstInput);

  const secondInput = {
    gates: Object.fromEntries(Object.entries(firstInput.gates).reverse()),
    candidate: Object.fromEntries(Object.entries(firstInput.candidate).reverse()),
  };
  secondInput.candidate.componentDigests = Object.fromEntries(
    Object.entries(firstInput.candidate.componentDigests).reverse(),
  );
  const second = buildServerRouteBundleFinal(secondInput);

  assert.deepEqual(first.blockers, ["publication:UNAVAILABLE", "signature:UNAVAILABLE"]);
  assert.equal(canonicalServerRouteBundleFinalJson(first), canonicalServerRouteBundleFinalJson(second));
  assert.equal(first.finalSha256, createHash("sha256").update(JSON.stringify({
    artifactKind: first.artifactKind,
    blockers: first.blockers,
    candidate: first.candidate,
    gates: first.gates,
    result: first.result,
    schemaVersion: first.schemaVersion,
  })).digest("hex"));
});

test("tracked JSON schema는 runtime exact field와 gate enum을 같은 v1 contract로 고정한다", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../../contracts/datapack/server-route-bundle-final.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schemaVersion", "artifactKind", "result", "candidate", "gates", "blockers", "finalSha256",
  ]);
  assert.deepEqual(schema.properties.result.enum, ["GO", "NO_GO"]);
  assert.equal(schema.properties.candidate.additionalProperties, false);
  assert.deepEqual(schema.properties.gates.required, GATES);
  for (const gate of GATES) {
    assert.equal(schema.properties.gates.properties[gate].additionalProperties, false);
    assert.deepEqual(schema.properties.gates.properties[gate].properties.state.enum, GATE_STATES[gate]);
  }
  assert.deepEqual(
    [...schema.properties.blockers.items.enum].sort(),
    GATES.flatMap((gate) => GATE_STATES[gate]
      .filter((state) => state !== "PASS")
      .map((state) => `${gate}:${state}`))
      .sort(),
  );
});

test("tracked JSON schema는 runtime이 거부하는 GO identity, gate evidence, blocker 조합을 거부한다", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../../contracts/datapack/server-route-bundle-final.schema.json", import.meta.url),
    "utf8",
  ));
  const valid = buildServerRouteBundleFinal(passingInput());
  assert.equal(validateSchemaNode(schema, valid, schema), true);

  for (const field of ["signedManifestRawSha256", "payloadRootSha256", "componentInventorySha256"]) {
    const mutated = structuredClone(valid);
    mutated.candidate[field] = null;
    assert.equal(validateSchemaNode(schema, mutated, schema), false, `GO ${field}`);
  }
  for (const component of ["topology", "timetable", "accessibility", "fare"]) {
    const mutated = structuredClone(valid);
    mutated.candidate.componentDigests[component] = null;
    assert.equal(validateSchemaNode(schema, mutated, schema), false, `GO componentDigests.${component}`);
  }

  for (const gate of GATES) {
    const passWithoutEvidence = structuredClone(valid);
    passWithoutEvidence.gates[gate].evidenceSha256 = null;
    assert.equal(validateSchemaNode(schema, passWithoutEvidence, schema), false, `${gate} PASS null evidence`);

    const unavailable = buildServerRouteBundleFinal(withGate(gate, "UNAVAILABLE"));
    assert.equal(validateSchemaNode(schema, unavailable, schema), true, `${gate} UNAVAILABLE null evidence`);
    unavailable.gates[gate].evidenceSha256 = SHA("f");
    assert.equal(validateSchemaNode(schema, unavailable, schema), false, `${gate} UNAVAILABLE hash evidence`);
  }

  const impossibleBlockers = ["signature:MISSING", "sourceFreshness:NOT_EVALUATED"];
  for (const blocker of impossibleBlockers) {
    const mutated = structuredClone(buildServerRouteBundleFinal(withGate("signature", "UNAVAILABLE")));
    mutated.blockers = [blocker];
    assert.equal(validateSchemaNode(schema, mutated, schema), false, blocker);
  }
});

function validateSchemaNode(rule, value, root) {
  if (rule.$ref) {
    const target = rule.$ref.slice(2).split("/").reduce((current, part) => current[part], root);
    return validateSchemaNode(target, value, root);
  }
  if (rule.allOf && !rule.allOf.every((child) => validateSchemaNode(child, value, root))) return false;
  if (rule.oneOf && rule.oneOf.filter((child) => validateSchemaNode(child, value, root)).length !== 1) return false;
  if (rule.if) {
    const branch = validateSchemaNode(rule.if, value, root) ? rule.then : rule.else;
    if (branch && !validateSchemaNode(branch, value, root)) return false;
  }
  if (Object.hasOwn(rule, "const") && !Object.is(value, rule.const)) return false;
  if (rule.enum && !rule.enum.some((entry) => Object.is(entry, value))) return false;
  if (rule.type && !matchesSchemaType(rule.type, value)) return false;
  if (typeof value === "string" && rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
  if (typeof value === "number" && rule.minimum !== undefined && value < rule.minimum) return false;
  if (typeof value === "number" && rule.maximum !== undefined && value > rule.maximum) return false;
  if (Array.isArray(value)) {
    if (rule.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) return false;
    if (rule.items && !value.every((entry) => validateSchemaNode(rule.items, entry, root))) return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ((rule.required ?? []).some((field) => !Object.hasOwn(value, field))) return false;
    if (rule.additionalProperties === false
      && Object.keys(value).some((field) => !Object.hasOwn(rule.properties ?? {}, field))) return false;
    if (!Object.entries(rule.properties ?? {}).every(([field, child]) => (
      !Object.hasOwn(value, field) || validateSchemaNode(child, value[field], root)
    ))) return false;
  }
  return true;
}

function matchesSchemaType(type, value) {
  if (type === "null") return value === null;
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}
