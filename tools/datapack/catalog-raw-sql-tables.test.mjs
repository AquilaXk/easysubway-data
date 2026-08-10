import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const catalogPath = new URL("../../contracts/datapack/catalog-raw-sql-tables.json", import.meta.url);
const schemaPath = new URL("../../contracts/datapack/catalog-raw-sql-tables.schema.json", import.meta.url);

function assertMatchesSchema(schema, value, path = "$") {
  if (schema.const !== undefined) {
    assert.deepEqual(value, schema.const, `${path} must equal its const value`);
  }
  if (schema.enum !== undefined) {
    assert.ok(schema.enum.includes(value), `${path} must be one of its enum values`);
  }
  if (schema.type === "object") {
    assert.ok(value !== null && !Array.isArray(value) && typeof value === "object", `${path} must be an object`);
    for (const property of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, property), `${path}.${property} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const property of Object.keys(value)) {
        assert.ok(Object.hasOwn(schema.properties ?? {}, property), `${path}.${property} is not allowed`);
      }
    }
    for (const [property, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, property)) {
        assertMatchesSchema(propertySchema, value[property], `${path}.${property}`);
      }
    }
    return;
  }
  if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${path} must be an array`);
    assert.ok(value.length >= (schema.minItems ?? 0), `${path} must contain enough items`);
    if (schema.uniqueItems) {
      assert.equal(new Set(value.map((item) => JSON.stringify(item))).size, value.length, `${path} items must be unique`);
    }
    value.forEach((item, index) => assertMatchesSchema(schema.items, item, `${path}[${index}]`));
    return;
  }
  if (schema.type === "string") {
    assert.equal(typeof value, "string", `${path} must be a string`);
    assert.ok(value.length >= (schema.minLength ?? 0), `${path} must be long enough`);
    if (schema.pattern) {
      assert.match(value, new RegExp(schema.pattern), `${path} must match its pattern`);
    }
    return;
  }
  if (schema.type === "integer") {
    assert.ok(Number.isInteger(value), `${path} must be an integer`);
  }
}

test("raw SQL table catalog는 Hub issue reference와 기존 same-repo issue reference를 허용한다", async () => {
  const [catalog, schema] = await Promise.all([catalogPath, schemaPath].map(async (path) => JSON.parse(
    await readFile(path, "utf8"),
  )));
  const issues = Object.fromEntries(catalog.tables.map(({ name, issue }) => [name, issue]));

  assert.deepEqual(issues, {
    route_map_positions: "Hub Issue #2527",
    route_map_line_tracks: "Hub Issue #2527",
    transit_feed_info: "Hub Issue #2530",
  });

  const issuePattern = new RegExp(schema.properties.tables.items.properties.issue.pattern);
  for (const issue of ["#96", "Hub Issue #2527"]) {
    assert.match(issue, issuePattern);
  }
  for (const issue of ["Hub Issue #0", "hub Issue #2527", "Data Issue #2527", "Hub PR #2527"]) {
    assert.doesNotMatch(issue, issuePattern);
  }

  assertMatchesSchema(schema, catalog);
  const invalidCatalog = structuredClone(catalog);
  invalidCatalog.tables[0].issue = "Hub PR #2527";
  assert.throws(() => assertMatchesSchema(schema, invalidCatalog), /must match its pattern/);
});
