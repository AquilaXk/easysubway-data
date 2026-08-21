#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const emptySha256 = sha256(Buffer.alloc(0));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const planPath = path.resolve(requireArg(args, "plan"));
  const root = path.resolve(requireArg(args, "root"));
  const dryRun = args.has("dry-run");
  const verifyOnly = args.has("verify-only");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  validatePlan(plan);

  const client = dryRun ? null : objectStorageClient();
  const putPackKeys = new Set();
  const verifiedPackKeys = new Set();

  for (const step of plan.steps) {
    if (step.type === "put-pack-object") {
      const bytes = await readAndVerifySource(root, step);
      putPackKeys.add(step.objectKey);
      if (!dryRun && !verifyOnly) {
        await client.putObject(step.objectKey, bytes, step);
      }
      continue;
    }

    if (step.type === "verify-pack-object") {
      if (!verifyOnly && !putPackKeys.has(step.objectKey)) {
        throw new Error(`${step.objectKey} must be uploaded before verification`);
      }
      if (!dryRun) {
        await client.verifyObject(step.objectKey, step);
      }
      verifiedPackKeys.add(step.objectKey);
      continue;
    }

    if (step.type === "put-manifest-object") {
      for (const key of putPackKeys) {
        if (!verifiedPackKeys.has(key)) {
          throw new Error(`catalog/current.json cannot be published before ${key} verification`);
        }
      }
      const bytes = await readAndVerifySource(root, step);
      if (!dryRun && !verifyOnly) {
        await client.putObject(step.objectKey, bytes, step);
      }
      continue;
    }

    if (step.type === "verify-manifest-object") {
      if (!dryRun) {
        await client.verifyObject(step.objectKey, step);
      }
      continue;
    }

    if (step.type === "put-release-manifest-object") {
      const bytes = await readAndVerifySource(root, step);
      if (!dryRun && !verifyOnly) {
        const existing = await client.headObject(step.objectKey);
        if (existing.exists) {
          if (existing.sha256 !== step.sha256) {
            throw new Error(`${step.objectKey} immutable violation: stored sha ${existing.sha256} != ${step.sha256}`);
          }
          // 동일 바이트 → 멱등 skip.
        } else {
          await client.putObject(step.objectKey, bytes, step);
        }
      }
      continue;
    }

    if (step.type === "verify-release-manifest-object") {
      if (!dryRun) {
        await client.verifyObject(step.objectKey, step);
      }
      continue;
    }

    if (step.type === "put-source-raw-object") {
      const bytes = await readAndVerifySource(root, step);
      if (!dryRun && !verifyOnly) {
        const created = await client.putObjectIfAbsent(step.objectKey, bytes, step);
        if (!created) {
          const existing = await client.readObject(step.objectKey);
          if (!existing.exists
            || existing.body.length !== step.sizeBytes
            || sha256(existing.body) !== step.sha256) {
            throw new Error(`${step.objectKey} immutable violation`);
          }
        }
      }
      continue;
    }

    if (step.type === "verify-source-raw-object") {
      if (!dryRun) {
        const stored = await client.readObject(step.objectKey);
        if (!stored.exists
          || stored.body.length !== step.sizeBytes
          || sha256(stored.body) !== step.sha256) {
          throw new Error(`${step.objectKey} uploaded checksum mismatch`);
        }
      }
      continue;
    }

    if (step.type === "fetch-source-raw-object") {
      if (!dryRun && !verifyOnly) {
        await fetchSourceRawObject(client, root, step);
      }
      continue;
    }

    if (step.type === "put-release-request-binding-object") {
      const bytes = await readAndVerifySource(root, step);
      if (!dryRun && !verifyOnly) {
        const created = await client.putObjectIfAbsent(step.objectKey, bytes, step);
        if (!created) {
          const existing = await client.readObject(step.objectKey);
          if (!existing.exists) {
            throw new Error(`${step.objectKey} conditional create conflict but object is unavailable`);
          }
          const storedSha256 = sha256(existing.body);
          if (storedSha256 !== step.sha256) {
            throw new Error(`${step.objectKey} immutable violation: stored sha ${storedSha256} != ${step.sha256}`);
          }
        }
      }
      continue;
    }

    if (step.type === "verify-release-request-binding-object") {
      if (!dryRun) {
        const stored = await client.readObject(step.objectKey);
        if (!stored.exists || stored.body.length !== step.sizeBytes
          || sha256(stored.body) !== step.sha256) {
          throw new Error(`${step.objectKey} uploaded checksum mismatch`);
        }
      }
      continue;
    }

    throw new Error(`unsupported publish step: ${step.type}`);
  }
}

export async function publishImmutableObjectPlan({ plan, root, client = null, env = process.env }) {
  const resolvedRoot = path.resolve(root);
  validateImmutableObjectPlan(plan);
  const storage = client ?? objectStorageClient(env);
  for (const step of plan.steps) {
    if (step.type === "put-immutable-bundle-object") {
      await putImmutableObject(storage, resolvedRoot, step);
    } else {
      await verifyImmutableObject(storage, step);
    }
  }
}

async function putImmutableObject(client, root, step) {
  const bytes = await readAndVerifySource(root, step);
  if (await client.putObjectIfAbsent(step.objectKey, bytes, step)) return;
  const existing = await client.readObject(step.objectKey);
  if (!exactStoredObject(existing, step)) throw new Error(`${step.objectKey} immutable violation`);
}

async function verifyImmutableObject(client, step) {
  const stored = await client.readObject(step.objectKey);
  if (!exactStoredObject(stored, step)) throw new Error(`${step.objectKey} uploaded checksum mismatch`);
}

function exactStoredObject(stored, step) {
  return stored.exists
    && stored.body.length === step.sizeBytes
    && sha256(stored.body) === step.sha256;
}

function validateImmutableObjectPlan(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("immutable object plan steps must be a non-empty array");
  }
  for (const step of plan.steps) {
    if (!new Set(["put-immutable-bundle-object", "verify-immutable-bundle-object"]).has(step.type)) {
      throw new Error(`unsupported immutable object step: ${step.type}`);
    }
    safeRelativeObjectPath(requireString(step.objectKey, "step.objectKey"), "step.objectKey");
    safeRelativeObjectPath(requireString(step.sourcePath, "step.sourcePath"), "step.sourcePath");
    if (!/^[a-f0-9]{64}$/.test(step.sha256)) throw new Error(`${step.objectKey} sha256 must be lowercase hex`);
    if (!Number.isInteger(step.sizeBytes) || step.sizeBytes < 1) {
      throw new Error(`${step.objectKey} sizeBytes must be a positive integer`);
    }
  }
}

function objectStorageClient(env = process.env) {
  const preauthBaseUrl = env?.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL?.trim();
  if (preauthBaseUrl) {
    return preauthenticatedObjectStorageClient(new URL(preauthBaseUrl));
  }

  const endpoint = new URL(requireEnv(env, "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT"));
  const bucket = requiredSafeObjectSegment(requireEnv(env, "EASYSUBWAY_DATAPACK_BUCKET"), "EASYSUBWAY_DATAPACK_BUCKET");
  const region = requireEnv(env, "EASYSUBWAY_OBJECT_STORAGE_REGION");
  const accessKey = requireEnv(env, "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY");
  const secretKey = requireEnv(env, "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY");

  return {
    putObject: async (key, bytes, step) => {
      const response = await signedRequest({
        endpoint,
        bucket,
        key,
        region,
        accessKey,
        secretKey,
        method: "PUT",
        body: bytes,
        headers: {
          "content-length": String(bytes.length),
          "content-type": contentTypeForKey(key),
          "cache-control": cacheControlForKey(key),
          "x-amz-meta-sha256": step.sha256,
          "x-amz-meta-size-bytes": String(step.sizeBytes),
        },
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${key} PUT failed with HTTP ${response.statusCode}`);
      }
    },
    putObjectIfAbsent: async (key, bytes, step) => {
      const response = await signedRequest({
        endpoint,
        bucket,
        key,
        region,
        accessKey,
        secretKey,
        method: "PUT",
        body: bytes,
        headers: {
          "content-length": String(bytes.length),
          "content-type": contentTypeForKey(key),
          "cache-control": cacheControlForKey(key),
          "if-none-match": "*",
          "x-amz-meta-sha256": step.sha256,
          "x-amz-meta-size-bytes": String(step.sizeBytes),
        },
      });
      if (response.statusCode === 412) return false;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${key} conditional PUT failed with HTTP ${response.statusCode}`);
      }
      return true;
    },
    verifyObject: async (key, step) => {
      const response = await signedRequest({
        endpoint,
        bucket,
        key,
        region,
        accessKey,
        secretKey,
        method: "HEAD",
        body: Buffer.alloc(0),
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${key} HEAD failed with HTTP ${response.statusCode}`);
      }
      if (Number(response.headers["content-length"]) !== step.sizeBytes) {
        throw new Error(`${key} uploaded size mismatch`);
      }
      if (response.headers["x-amz-meta-sha256"] !== step.sha256) {
        throw new Error(`${key} uploaded checksum mismatch`);
      }
      const expectedCacheControl = cacheControlForKey(key);
      if (response.headers["cache-control"] !== expectedCacheControl) {
        throw new Error(`${key} cache-control mismatch: ${response.headers["cache-control"]} != ${expectedCacheControl}`);
      }
    },
    headObject: async (key) => {
      const response = await signedRequest({
        endpoint, bucket, key, region, accessKey, secretKey,
        method: "HEAD", body: Buffer.alloc(0),
      });
      if (response.statusCode === 404) return { exists: false };
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${key} HEAD failed with HTTP ${response.statusCode}`);
      }
      return { exists: true, sha256: response.headers["x-amz-meta-sha256"] };
    },
    readObject: async (key) => {
      const response = await signedRequest({
        endpoint, bucket, key, region, accessKey, secretKey,
        method: "GET", body: Buffer.alloc(0),
      });
      if (response.statusCode === 404) return { exists: false };
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${key} GET failed with HTTP ${response.statusCode}`);
      }
      return { exists: true, body: response.body };
    },
  };
}

function preauthenticatedObjectStorageClient(baseUrl) {
  return {
    putObject: async (key, bytes, step) => {
      const response = await unsignedRequest({
        url: preauthObjectUrl(baseUrl, key),
        method: "PUT",
        body: bytes,
        headers: {
          "content-length": String(bytes.length),
          "content-type": contentTypeForKey(key),
          "cache-control": cacheControlForKey(key),
          "opc-meta-sha256": step.sha256,
          "opc-meta-size-bytes": String(step.sizeBytes),
        },
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${key} PUT failed with HTTP ${response.statusCode}${errorBodySuffix(response.body)}`);
      }
    },
    putObjectIfAbsent: async (key, bytes, step) => {
      const response = await unsignedRequest({
        url: preauthObjectUrl(baseUrl, key),
        method: "PUT",
        body: bytes,
        headers: {
          "content-length": String(bytes.length),
          "content-type": contentTypeForKey(key),
          "cache-control": cacheControlForKey(key),
          "if-none-match": "*",
          "opc-meta-sha256": step.sha256,
          "opc-meta-size-bytes": String(step.sizeBytes),
        },
      });
      if (response.statusCode === 412) return false;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${key} conditional PUT failed with HTTP ${response.statusCode}${errorBodySuffix(response.body)}`);
      }
      return true;
    },
    verifyObject: async (key, step) => {
      const response = await unsignedRequest({
        url: preauthObjectUrl(baseUrl, key),
        method: "GET",
        body: Buffer.alloc(0),
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${key} GET failed with HTTP ${response.statusCode}${errorBodySuffix(response.body)}`);
      }
      if (response.body.length !== step.sizeBytes) {
        throw new Error(`${key} uploaded size mismatch`);
      }
      if (sha256(response.body) !== step.sha256) {
        throw new Error(`${key} uploaded checksum mismatch`);
      }
      const expectedCacheControl = cacheControlForKey(key);
      if (response.headers["cache-control"] !== expectedCacheControl) {
        console.warn(`warning: ${key} cache-control not verified in preauth mode (got ${response.headers["cache-control"] ?? "none"})`);
      }
    },
    headObject: async (key) => {
      const response = await unsignedRequest({ url: preauthObjectUrl(baseUrl, key), method: "GET", body: Buffer.alloc(0) });
      if (response.statusCode === 404) return { exists: false };
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${key} GET failed with HTTP ${response.statusCode}${errorBodySuffix(response.body)}`);
      }
      return { exists: true, sha256: sha256(response.body) };
    },
    readObject: async (key) => {
      const response = await unsignedRequest({
        url: preauthObjectUrl(baseUrl, key), method: "GET", body: Buffer.alloc(0),
      });
      if (response.statusCode === 404) return { exists: false };
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${key} GET failed with HTTP ${response.statusCode}${errorBodySuffix(response.body)}`);
      }
      return { exists: true, body: response.body };
    },
  };
}

async function signedRequest(options) {
  const requestUrl = objectUrl(options.endpoint, options.bucket, options.key);
  const body = options.body ?? Buffer.alloc(0);
  const payloadHash = options.method === "HEAD" ? emptySha256 : sha256(body);
  const amzDate = amzTimestamp(new Date());
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    host: requestUrl.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(options.headers ?? {}),
  };
  const authorization = authorizationHeader({
    accessKey: options.accessKey,
    secretKey: options.secretKey,
    region: options.region,
    method: options.method,
    requestUrl,
    headers,
    payloadHash,
    dateStamp,
    amzDate,
  });
  const transport = requestUrl.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const request = transport.request(
      requestUrl,
      {
        method: options.method,
        headers: {
          ...headers,
          authorization,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          response.body = Buffer.concat(chunks);
          resolve(response);
        });
      },
    );
    request.on("error", reject);
    if (options.method !== "HEAD") {
      request.write(body);
    }
    request.end();
  });
}

async function unsignedRequest(options) {
  const transport = options.url.protocol === "https:" ? https : http;
  const body = options.body ?? Buffer.alloc(0);
  return await new Promise((resolve, reject) => {
    const chunks = [];
    const request = transport.request(
      options.url,
      {
        method: options.method,
        headers: options.headers ?? {},
      },
      (response) => {
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          response.body = Buffer.concat(chunks);
          resolve(response);
        });
      },
    );
    request.on("error", reject);
    if (options.method !== "HEAD" && body.length > 0) {
      request.write(body);
    }
    request.end();
  });
}

function authorizationHeader(input) {
  const canonical = canonicalRequest(input.method, input.requestUrl, input.headers, input.payloadHash);
  const scope = `${input.dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    sha256(Buffer.from(canonical)),
  ].join("\n");
  const signature = hmac(signingKey(input.secretKey, input.dateStamp, input.region), stringToSign).toString("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders(input.headers)}, Signature=${signature}`;
}

function canonicalRequest(method, requestUrl, headers, payloadHash) {
  const canonicalHeaders = Object.entries(lowercaseHeaders(headers))
    .sort(([left], [right]) => codepointCompare(left, right))
    .map(([key, value]) => `${key}:${String(value).trim().replace(/\s+/g, " ")}`)
    .join("\n");
  return [
    method,
    requestUrl.pathname,
    requestUrl.searchParams.toString(),
    `${canonicalHeaders}\n`,
    signedHeaders(headers),
    payloadHash,
  ].join("\n");
}

function signedHeaders(headers) {
  return Object.keys(lowercaseHeaders(headers)).sort().join(";");
}

function lowercaseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function signingKey(secretKey, dateStamp, region) {
  const dateKey = hmac(`AWS4${secretKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

async function readAndVerifySource(root, step) {
  const sourcePath = safeRelativeObjectPath(requireString(step.sourcePath, "step.sourcePath"), "step.sourcePath");
  const bytes = await readFile(path.join(root, sourcePath));
  if (bytes.length !== step.sizeBytes) {
    throw new Error(`${step.objectKey} source size mismatch`);
  }
  const checksum = sha256(bytes);
  if (checksum !== step.sha256) {
    throw new Error(`${step.objectKey} source checksum mismatch`);
  }
  return bytes;
}

async function fetchSourceRawObject(client, root, step) {
  const destinationPath = safeRelativeObjectPath(
    requireString(step.destinationPath, "step.destinationPath"),
    "step.destinationPath",
  );
  const outputPath = await safeCreateNewOutputPath(root, destinationPath);
  let output;
  try {
    output = await open(outputPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`${destinationPath} create-new destination already exists`);
    }
    throw error;
  }

  let complete = false;
  try {
    const stored = await client.readObject(step.objectKey);
    if (!stored.exists) {
      throw new Error(`${step.objectKey} source object is unavailable`);
    }
    if (stored.body.length !== step.sizeBytes) {
      throw new Error(`${step.objectKey} source size mismatch`);
    }
    if (sha256(stored.body) !== step.sha256) {
      throw new Error(`${step.objectKey} source checksum mismatch`);
    }
    await output.writeFile(stored.body);
    await output.sync();
    await output.close();
    output = null;

    const written = await readFile(outputPath);
    if (written.length !== step.sizeBytes || sha256(written) !== step.sha256) {
      throw new Error(`${step.objectKey} downloaded file checksum mismatch`);
    }
    complete = true;
  } finally {
    if (output) {
      await output.close().catch(() => {});
    }
    if (!complete) {
      await unlink(outputPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
}

async function safeCreateNewOutputPath(root, destinationPath) {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("fetch destination root must be a real directory, not a symlink");
  let parent = root;
  for (const segment of path.posix.dirname(destinationPath).split("/")) {
    if (segment === "." || segment === "") continue;
    parent = path.join(parent, segment);
    const stat = await lstat(parent);
    if (stat.isSymbolicLink()) throw new Error(`${destinationPath} parent must not be a symlink`);
    if (!stat.isDirectory()) throw new Error(`${destinationPath} parent must be a directory`);
  }
  return path.join(root, destinationPath);
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("publish plan steps must be a non-empty array");
  }
  for (const step of plan.steps) {
    requireString(step.type, "step.type");
    requireString(step.objectKey, "step.objectKey");
    safeRelativeObjectPath(step.objectKey, "step.objectKey");
    if (step.sourcePath !== undefined) {
      safeRelativeObjectPath(step.sourcePath, "step.sourcePath");
    }
    if (step.destinationPath !== undefined) {
      safeRelativeObjectPath(step.destinationPath, "step.destinationPath");
    }
    if (step.type === "fetch-source-raw-object" && step.destinationPath === undefined) {
      throw new Error("fetch-source-raw-object destinationPath is required");
    }
    if (step.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(step.sha256)) {
      throw new Error(`${step.objectKey} sha256 must be lowercase hex`);
    }
    if (step.sizeBytes !== undefined && (!Number.isInteger(step.sizeBytes) || step.sizeBytes < 1)) {
      throw new Error(`${step.objectKey} sizeBytes must be a positive integer`);
    }
  }
}

function objectUrl(endpoint, bucket, key) {
  const url = new URL(endpoint.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${bucket}/${safeRelativeObjectPath(key, "objectKey")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
  url.search = "";
  return url;
}

function preauthObjectUrl(baseUrl, key) {
  const url = new URL(baseUrl.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${safeRelativeObjectPath(key, "objectKey")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
  return url;
}

function errorBodySuffix(body) {
  const text = body?.toString("utf8").trim();
  return text ? `: ${text.slice(0, 500)}` : "";
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--dry-run" || key === "--verify-only") {
      args.set(key.slice(2), "true");
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    const normalizedKey = key.slice(2);
    if (args.has(normalizedKey)) {
      throw new Error(`duplicate argument: ${key}`);
    }
    args.set(normalizedKey, value);
    index += 1;
  }
  return args;
}

function requireArg(args, name) {
  const value = args.get(name);
  if (!value) {
    throw new Error(`missing required argument: --${name}`);
  }
  return value;
}

function requireEnv(env, name) {
  const value = env?.[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredSafeObjectSegment(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a safe object storage segment`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function safeRelativeObjectPath(value, label) {
  if (/%[0-9a-f]{2}/i.test(value)) {
    throw new Error(`${label} must be a safe relative object key`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    throw new Error(`${label} must be a safe relative object key`);
  }
  if (value.split("/").includes("..")) {
    throw new Error(`${label} must be a safe relative object key`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${label} must be a safe relative object key`);
  }
  return normalized;
}

function contentTypeForKey(key) {
  if (key.endsWith(".json")) {
    return "application/json";
  }
  if (key.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (key.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

function cacheControlForKey(key) {
  return key === "catalog/current.json"
    ? "public, max-age=60"
    : "public, max-age=31536000, immutable";
}

function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
