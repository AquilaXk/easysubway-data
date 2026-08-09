import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateDatapackManifestJson } from "./datapack-manifest-schema.mjs";

function withJsonFiles(schema, value, verify) {
  const directory = mkdtempSync(join(tmpdir(), "datapack-manifest-schema-"));
  const schemaPath = join(directory, "schema.json");
  const valuePath = join(directory, "value.json");
  try {
    if (schema !== undefined) writeFileSync(schemaPath, `${JSON.stringify(schema)}\n`);
    if (value !== undefined) writeFileSync(valuePath, `${JSON.stringify(value)}\n`);
    verify(schemaPath, valuePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertAccepted(schema, value) {
  withJsonFiles(schema, value, (schemaPath, valuePath) => {
    assert.deepEqual(validateDatapackManifestJson(schemaPath, valuePath), []);
  });
}

function assertRejected(schema, value) {
  withJsonFiles(schema, value, (schemaPath, valuePath) => {
    assert.notDeepEqual(validateDatapackManifestJson(schemaPath, valuePath), []);
  });
}

function assertSchemaRejected(schema, expectedFragment) {
  withJsonFiles(schema, { activePack: {} }, (schemaPath, valuePath) => {
    const errors = validateDatapackManifestJson(schemaPath, valuePath);
    assert.ok(errors.some((error) => error.includes(expectedFragment)), errors.join("\n"));
  });
}

const keywordSchema = {
  type: "object",
  required: ["entries", "minimum", "category", "marker"],
  additionalProperties: false,
  properties: {
    activePack: { type: "object" },
    entries: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: { name: { type: "string", pattern: "^[a-z]+$" } },
      },
    },
    minimum: { type: "number", minimum: 3 },
    category: { enum: ["approved", "pending"] },
    marker: { const: { kind: "fixed", sequence: [1, 2] } },
  },
};

const keywordValue = {
  activePack: {},
  entries: [{ name: "alpha" }, { name: "beta" }],
  minimum: 3,
  category: "approved",
  marker: { kind: "fixed", sequence: [1, 2] },
};

test("manifest schema keyword matrix accepts the valid value", () => {
  assertAccepted(keywordSchema, keywordValue);
});

test("manifest schema keyword matrix rejects nested and scalar mutations", () => {
  const { category: _category, ...missingRequiredCategory } = keywordValue;
  for (const value of [
    missingRequiredCategory,
    { ...keywordValue, entries: [{}, { name: "beta" }] },
    { ...keywordValue, entries: [{ name: "alpha" }] },
    { ...keywordValue, entries: "not-an-array" },
    { ...keywordValue, entries: [{ name: "alpha" }, { name: "INVALID" }] },
    { ...keywordValue, entries: [{ name: "alpha", unexpected: true }, { name: "beta" }] },
    { ...keywordValue, minimum: 2 },
    { ...keywordValue, category: "unknown" },
    { ...keywordValue, marker: { kind: "fixed", sequence: [2, 1] } },
    { ...keywordValue, unexpected: true },
  ]) {
    assertRejected(keywordSchema, value);
  }
});

test("current sourceInventory item schema allows extra source fields", () => {
  const manifestSchema = JSON.parse(readFileSync("contracts/datapack/datapack-manifest.schema.json", "utf8"));
  const sourceInventorySchema = manifestSchema.properties.packs.items.properties.sourceInventory;
  assertAccepted(sourceInventorySchema, [{
    id: "official-source",
    licenseStatus: "redistributable",
    updatedAt: "2026-08-09T00:00:00.000Z",
    owner: "official operator",
  }]);
});

test("manifest version rules reject missing bounded fields and accept v2 without activePack", () => {
  assertAccepted({ type: "object" }, {
    manifestVersion: 2,
    signature: {},
    keyId: "key",
    channel: "production",
    releaseSequence: 1,
    publishedAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2026-08-10T00:00:00.000Z",
  });
  assertRejected({ type: "object" }, { manifestVersion: 1 });
  assertRejected({ type: "object" }, {});
  for (const field of ["signature", "keyId", "channel", "releaseSequence", "publishedAt", "expiresAt"]) {
    const value = {
      manifestVersion: 2,
      signature: {},
      keyId: "key",
      channel: "production",
      releaseSequence: 1,
      publishedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
    };
    delete value[field];
    assertRejected({ type: "object" }, value);
  }
  assertRejected({ type: "object" }, { manifestVersion: 1, activePack: {}, rollout: { percentage: 101 } });
});

test("missing, malformed, and unsupported schema input fails closed without throwing", () => {
  withJsonFiles(undefined, {}, (schemaPath, valuePath) => {
    assert.doesNotThrow(() => assert.notDeepEqual(validateDatapackManifestJson(schemaPath, valuePath), []));
  });
  withJsonFiles({ type: "object" }, undefined, (schemaPath, valuePath) => {
    assert.doesNotThrow(() => assert.notDeepEqual(validateDatapackManifestJson(schemaPath, valuePath), []));
  });
  withJsonFiles({ type: "object" }, {}, (schemaPath, valuePath) => {
    writeFileSync(schemaPath, "{");
    assert.doesNotThrow(() => assert.notDeepEqual(validateDatapackManifestJson(schemaPath, valuePath), []));
  });
  withJsonFiles({ type: "object" }, {}, (schemaPath, valuePath) => {
    writeFileSync(valuePath, "{");
    assert.doesNotThrow(() => assert.notDeepEqual(validateDatapackManifestJson(schemaPath, valuePath), []));
  });
  for (const [schema, expectedFragment] of [
    [{ type: "unsupported" }, ".type"],
    [{ type: "object", required: ["duplicate", "duplicate"] }, ".required"],
    [{ type: "object", additionalProperties: "false" }, ".additionalProperties"],
    [{ type: "object", properties: [] }, ".properties"],
    [{ type: "array", items: [] }, ".items"],
    [{ type: "array", minItems: -1 }, ".minItems"],
    [{ type: "number", minimum: "1" }, ".minimum"],
    [{ type: "string", pattern: "[" }, ".pattern"],
    [{ enum: [] }, ".enum"],
    [{ unknownKeyword: true }, "unsupported schema keyword: unknownKeyword"],
    [{ type: "string", minItems: 1 }, ".minItems"],
    [{ type: "object", minimum: 1 }, ".minimum"],
    [{ type: "array", pattern: "^[a-z]+$" }, ".pattern"],
    [{ type: "string", properties: {} }, ".properties"],
  ]) {
    assertSchemaRejected(schema, expectedFragment);
  }
});
