import { createHash } from "node:crypto";

import { createCandidateOciClient } from "../publish-candidate-oci-artifact.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function createMapCatalogOciPublisher({ target, credentials, transport } = {}) {
  validateTarget(target);
  validateCredentials(credentials);
  if (!transport || typeof transport.putObject !== "function" || typeof transport.getObject !== "function") throw new Error("OCI transport is invalid");
  const request = (method, key, body, headers = {}) => ({ method, endpoint: target.compatEndpoint, namespace: target.namespace, bucket: target.bucket, key: safeKey(key), body, headers, credentials });
  return {
    async putObjectIfAbsent(key, bytes) {
      const body = bytesOf(bytes);
      const response = await transport.putObject(request("PUT", key, body, { "if-none-match": "*", "content-length": String(body.length) }));
      if (response?.statusCode === 412) throw new Error("OCI immutable collision");
      if (!Number.isInteger(response?.statusCode) || response.statusCode < 200 || response.statusCode >= 300) throw new Error("OCI conditional PUT failed");
    },
    async fullGet(key) {
      const response = await transport.getObject(request("GET", key, undefined));
      if (response?.statusCode !== 200 || !Buffer.isBuffer(response.body)) throw new Error("OCI full GET failed");
      return Buffer.from(response.body);
    },
  };
}

export function createMapCatalogOciS3CompatTransport({ target, credentials, fetchImpl } = {}) {
  validateTarget(target);
  validateCredentials(credentials);
  if (fetchImpl !== undefined && typeof fetchImpl !== "function") throw new Error("OCI fetch implementation is invalid");
  const client = createCandidateOciClient({
    EASYSUBWAY_CANDIDATE_OCI_NAMESPACE: target.namespace,
    EASYSUBWAY_CANDIDATE_OCI_BUCKET: target.bucket,
    EASYSUBWAY_CANDIDATE_OCI_REGION: target.region,
    EASYSUBWAY_CANDIDATE_OCI_ACCESS_KEY: credentials.accessKey,
    EASYSUBWAY_CANDIDATE_OCI_SECRET_KEY: credentials.secretKey,
  }, fetchImpl);
  if (client.identity.namespace !== target.namespace || client.identity.bucket !== target.bucket) throw new Error("OCI transport target mismatch");
  const exact = (request) => {
    if (!request || request.endpoint !== target.compatEndpoint || request.namespace !== target.namespace || request.bucket !== target.bucket) throw new Error("OCI transport target mismatch");
    return safeKey(request.key);
  };
  return {
    async putObject(request) {
      const key = exact(request); const body = bytesOf(request.body);
      return { statusCode: await client.putObjectIfAbsent(key, body) ? 201 : 412 };
    },
    async getObject(request) {
      const value = await client.readObject(exact(request));
      return value.exists ? { statusCode: 200, body: Buffer.from(value.body) } : { statusCode: 404 };
    },
  };
}

export async function putCreateOnlyAndFullGet(publisher, { key, bytes } = {}) {
  if (!publisher || typeof publisher.putObjectIfAbsent !== "function" || typeof publisher.fullGet !== "function") throw new Error("OCI publisher is invalid");
  const expected = bytesOf(bytes); const safe = safeKey(key);
  await publisher.putObjectIfAbsent(safe, expected);
  const body = await publisher.fullGet(safe);
  if (body.length !== expected.length || sha256(body) !== sha256(expected)) throw new Error("OCI full GET mismatch");
  return { statusCode: 200, sizeBytes: body.length, sha256: sha256(body) };
}

function validateTarget(value) {
  exactKeys(value, ["namespace", "bucket", "region", "compatEndpoint", "objectPrefix"], "OCI target");
  if ([value.namespace, value.bucket, value.region, value.compatEndpoint, value.objectPrefix].some((item) => typeof item !== "string")) throw new Error("OCI target is invalid");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value.namespace) || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value.bucket) || !/^[a-z]+(?:-[a-z0-9]+)+-[0-9]+$/u.test(value.region) || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u.test(value.objectPrefix) || value.compatEndpoint !== `https://${value.namespace}.compat.objectstorage.${value.region}.oraclecloud.com`) throw new Error("OCI compat endpoint mismatch");
}

function validateCredentials(value) { exactKeys(value, ["accessKey", "secretKey"], "OCI credentials"); if (typeof value.accessKey !== "string" || value.accessKey.length === 0 || typeof value.secretKey !== "string" || value.secretKey.length === 0) throw new Error("OCI credentials are invalid"); }
function bytesOf(value) { if (!Buffer.isBuffer(value) || value.length < 1) throw new Error("OCI object bytes are invalid"); return Buffer.from(value); }
function safeKey(value) { if (typeof value !== "string" || !value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("OCI object key is invalid"); return value; }
function exactKeys(value, expected, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} is invalid`); }
