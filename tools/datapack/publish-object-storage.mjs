#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const emptySha256 = sha256(Buffer.alloc(0));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const planPath = path.resolve(requireArg(args, "plan"));
  const root = path.resolve(requireArg(args, "root"));
  const dryRun = args.has("dry-run");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  validatePlan(plan);

  const client = dryRun ? null : objectStorageClient();
  const putPackKeys = new Set();
  const verifiedPackKeys = new Set();

  for (const step of plan.steps) {
    if (step.type === "put-pack-object") {
      const bytes = await readAndVerifySource(root, step);
      putPackKeys.add(step.objectKey);
      if (!dryRun) {
        await client.putObject(step.objectKey, bytes, step);
      }
      continue;
    }

    if (step.type === "verify-pack-object") {
      if (!putPackKeys.has(step.objectKey)) {
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
      if (!dryRun) {
        await client.putObject(step.objectKey, bytes, step);
      }
      continue;
    }

    throw new Error(`unsupported publish step: ${step.type}`);
  }
}

function objectStorageClient() {
  const endpoint = new URL(requireEnv("EASYSUBWAY_OBJECT_STORAGE_ENDPOINT"));
  const bucket = requiredSafeObjectSegment(requireEnv("EASYSUBWAY_DATAPACK_BUCKET"), "EASYSUBWAY_DATAPACK_BUCKET");
  const region = requireEnv("EASYSUBWAY_OBJECT_STORAGE_REGION");
  const accessKey = requireEnv("EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY");
  const secretKey = requireEnv("EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY");

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
          "x-amz-meta-sha256": step.sha256,
          "x-amz-meta-size-bytes": String(step.sizeBytes),
        },
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${key} PUT failed with HTTP ${response.statusCode}`);
      }
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
        response.resume();
        response.on("end", () => resolve(response));
      },
    );
    request.on("error", reject);
    if (options.method !== "HEAD") {
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
    .sort(([left], [right]) => left.localeCompare(right))
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

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--dry-run") {
      args.set("dry-run", "true");
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

function requireEnv(name) {
  const value = process.env[name]?.trim();
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
  return key.endsWith(".json") ? "application/json" : "application/octet-stream";
}

function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
