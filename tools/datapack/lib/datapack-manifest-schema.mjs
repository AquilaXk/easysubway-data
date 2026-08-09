import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";

const annotationKeywords = new Set(["$schema", "$id", "title"]);
const validationKeywords = new Set([
  "type",
  "required",
  "additionalProperties",
  "properties",
  "items",
  "minItems",
  "minimum",
  "pattern",
  "enum",
  "const",
]);
const supportedTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const v2RequiredFields = ["signature", "keyId", "channel", "releaseSequence", "publishedAt", "expiresAt"];

export function validateDatapackManifestJson(schemaPath, valuePath) {
  const errors = [];
  const schema = readJson(schemaPath, "schema", errors);
  const value = readJson(valuePath, "value", errors);
  if (schema === undefined || value === undefined) return errors;

  validateSchema(schema, "$", errors);
  if (errors.length === 0) validateValue(schema, value, "$", errors);
  validateVersionRules(value, errors);
  return errors;
}

function readJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label} JSON을 읽을 수 없습니다: ${error.message}`);
    return undefined;
  }
}

function validateSchema(schema, path, errors) {
  if (!isPlainObject(schema)) {
    errors.push(`${path} schema는 object여야 합니다`);
    return;
  }

  for (const [keyword, keywordValue] of Object.entries(schema)) {
    if (!annotationKeywords.has(keyword) && !validationKeywords.has(keyword)) {
      errors.push(`${path} unsupported schema keyword: ${keyword}`);
      continue;
    }
    if (annotationKeywords.has(keyword) && typeof keywordValue !== "string") {
      errors.push(`${path}.${keyword}는 string이어야 합니다`);
      continue;
    }
    switch (keyword) {
      case "type":
        if (typeof keywordValue !== "string" || !supportedTypes.has(keywordValue)) {
          errors.push(`${path}.type은 지원하는 JSON type string이어야 합니다`);
        }
        break;
      case "required":
        if (!Array.isArray(keywordValue) || keywordValue.some((field) => typeof field !== "string") || new Set(keywordValue).size !== keywordValue.length) {
          errors.push(`${path}.required는 unique string array여야 합니다`);
        }
        break;
      case "additionalProperties":
        if (typeof keywordValue !== "boolean") errors.push(`${path}.additionalProperties는 boolean이어야 합니다`);
        break;
      case "properties":
        if (!isPlainObject(keywordValue)) {
          errors.push(`${path}.properties는 schema-object child를 가진 plain object여야 합니다`);
        } else {
          for (const [property, childSchema] of Object.entries(keywordValue)) {
            validateSchema(childSchema, `${path}.properties.${property}`, errors);
          }
        }
        break;
      case "items":
        if (!isPlainObject(keywordValue)) {
          errors.push(`${path}.items는 schema object여야 합니다`);
        } else {
          validateSchema(keywordValue, `${path}.items`, errors);
        }
        break;
      case "minItems":
        if (!Number.isInteger(keywordValue) || keywordValue < 0) errors.push(`${path}.minItems는 nonnegative integer여야 합니다`);
        break;
      case "minimum":
        if (typeof keywordValue !== "number" || !Number.isFinite(keywordValue)) errors.push(`${path}.minimum은 finite number여야 합니다`);
        break;
      case "pattern":
        if (typeof keywordValue !== "string") {
          errors.push(`${path}.pattern은 valid regex string이어야 합니다`);
        } else {
          try {
            new RegExp(keywordValue);
          } catch {
            errors.push(`${path}.pattern은 valid regex string이어야 합니다`);
          }
        }
        break;
      case "enum":
        if (!Array.isArray(keywordValue) || keywordValue.length === 0) errors.push(`${path}.enum은 non-empty array여야 합니다`);
        break;
      case "const":
        break;
      default:
        break;
    }
  }

  requireKeywordType(schema, path, errors, ["required", "additionalProperties", "properties"], ["object"]);
  requireKeywordType(schema, path, errors, ["items", "minItems"], ["array"]);
  requireKeywordType(schema, path, errors, ["minimum"], ["number", "integer"]);
  requireKeywordType(schema, path, errors, ["pattern"], ["string"]);
}

function requireKeywordType(schema, path, errors, keywords, allowedTypes) {
  for (const keyword of keywords) {
    if (Object.hasOwn(schema, keyword) && !allowedTypes.includes(schema.type)) {
      errors.push(`${path}.${keyword}은 type ${allowedTypes.join(" 또는 ")}에서만 허용됩니다`);
    }
  }
}

function validateValue(schema, value, path, errors) {
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push(`${path} must be ${schema.type}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => isDeepStrictEqual(candidate, value))) {
    errors.push(`${path} must match enum`);
  }
  if (schema.const !== undefined && !isDeepStrictEqual(schema.const, value)) {
    errors.push(`${path} must match const`);
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path} must be at least ${schema.minimum}`);
  }
  if (schema.pattern !== undefined && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path} must match pattern`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateValue(schema.items, item, `${path}[${index}]`, errors));
    }
  }
  if (isPlainObject(value)) {
    if (schema.required !== undefined) {
      for (const field of schema.required) {
        if (!Object.hasOwn(value, field)) errors.push(`${path} required field missing: ${field}`);
      }
    }
    if (schema.additionalProperties === false) {
      const properties = schema.properties ?? {};
      for (const field of Object.keys(value)) {
        if (!Object.hasOwn(properties, field)) errors.push(`${path} additional property is unsupported: ${field}`);
      }
    }
    if (schema.properties !== undefined) {
      for (const [field, childSchema] of Object.entries(schema.properties)) {
        if (Object.hasOwn(value, field)) validateValue(childSchema, value[field], `${path}.${field}`, errors);
      }
    }
  }
}

function validateVersionRules(value, errors) {
  if (!isPlainObject(value)) return;
  if ((value.manifestVersion ?? 1) === 1 && !Object.hasOwn(value, "activePack")) {
    errors.push("v1 manifest requires activePack");
  }
  if (value.manifestVersion === 2) {
    for (const field of v2RequiredFields) {
      if (!Object.hasOwn(value, field)) errors.push(`v2 manifest required field missing: ${field}`);
    }
  }
  if (isPlainObject(value.rollout) && typeof value.rollout.percentage === "number" && value.rollout.percentage > 100) {
    errors.push("rollout.percentage must be at most 100");
  }
}

function matchesType(type, value) {
  switch (type) {
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
