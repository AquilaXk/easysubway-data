#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY = "AquilaXk/easysubway-data";

export async function publishServerRouteBundlePublicationDescriptor({ descriptorPath, repositoryGitSha, repositoryRoot = process.cwd(), client = null, env = process.env, publicRead = null } = {}) {
  const sha = requiredSha(repositoryGitSha, "repository git sha");
  await assertDetachedCleanHead(repositoryRoot, sha);
  const storage = client ?? createServerRouteOciClient(env);
  assertServerRouteOciClientIdentity(storage, env);
  const bytes = await regular(path.resolve(required(descriptorPath, "descriptor")), "descriptor");
  const descriptor = await parseCanonicalDescriptor(bytes);
  if (descriptor.producer.repository !== REPOSITORY || descriptor.producer.gitSha !== sha) {
    throw new Error("descriptor producer identity mismatch");
  }
  const key = publicationDescriptorKey(descriptor.descriptorSha256);
  const created = await storage.putObjectIfAbsent(key, bytes);
  if (!created) throw new Error("descriptor immutable create conflict");
  const stored = await storage.readObject(key);
  if (!stored?.exists || !Buffer.isBuffer(stored.body) || !stored.body.equals(bytes)
    || sha256(stored.body) !== sha256(bytes)) {
    throw new Error("descriptor OCI full GET mismatch");
  }
  const publicResponse = await (publicRead ?? readCredentialFreeDescriptorObject)(
    `${serverRouteOciPublicBaseUrl(env)}/${encodeObjectKey(key)}`,
    bytes.length,
  );
  if (!publicResponse || publicResponse.statusCode !== 200 || !Buffer.isBuffer(publicResponse.body) || !publicResponse.body.equals(bytes)
    || sha256(publicResponse.body) !== sha256(bytes)) {
    throw new Error("descriptor public full GET mismatch");
  }
  return { descriptorSha256: descriptor.descriptorSha256, objectKey: key };
}

export function publicationDescriptorKey(descriptorSha256) {
  if (!/^[a-f0-9]{64}$/.test(descriptorSha256 ?? "")) throw new Error("descriptor sha256 must be lowercase sha256");
  return `server-route-bundle-publication-descriptors/v2/${descriptorSha256}.json`;
}

export function createServerRouteOciClient(env = process.env, fetchImpl = fetch) {
  const identity = ociIdentity(env);
  const { namespace, bucket, region, endpoint } = identity;
  const access = required(env.OCI_SERVER_ROUTE_PUBLISHER_ACCESS_KEY, "OCI_SERVER_ROUTE_PUBLISHER_ACCESS_KEY");
  const secret = required(env.OCI_SERVER_ROUTE_PUBLISHER_SECRET_KEY, "OCI_SERVER_ROUTE_PUBLISHER_SECRET_KEY");
  const base = new URL(endpoint);
  const call = async (key, method, body = Buffer.alloc(0), extra = {}) => {
    const url = new URL(`/${encodeURIComponent(bucket)}/${key.split("/").map(encode).join("/")}`, base);
    const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = stamp.slice(0, 8);
    const payloadSha = sha256(body);
    const headers = { host: url.host, "x-amz-content-sha256": payloadSha, "x-amz-date": stamp, ...extra };
    const names = Object.keys(headers).sort(compare);
    const canonical = [method, url.pathname, "", `${names.map((name) => `${name}:${headers[name]}`).join("\n")}\n`, names.join(";"), payloadSha].join("\n");
    const hmac = (keyValue, text) => createHmac("sha256", keyValue).update(text).digest();
    const scope = `${date}/${region}/s3/aws4_request`;
    const signing = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hmac(signing, `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha256(Buffer.from(canonical))}`).toString("hex")}`;
    const response = await fetchImpl(url, { method, headers, body: method === "GET" ? undefined : body, redirect: "error" });
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
  };
  return {
    identity,
    async putObjectIfAbsent(key, bytes) {
      const response = await call(key, "PUT", bytes, { "content-length": String(bytes.length), "if-none-match": "*" });
      if (response.status === 412) return false;
      if (response.status < 200 || response.status >= 300) throw new Error("OCI conditional PUT failed");
      return true;
    },
    async readObject(key) {
      const response = await call(key, "GET");
      if (response.status === 404) return { exists: false };
      if (response.status !== 200) throw new Error("OCI authenticated GET failed");
      return { exists: true, body: response.body };
    },
  };
}

export function serverRouteOciPublicBaseUrl(env = process.env) {
  const { namespace, bucket, region } = ociIdentity(env);
  return `https://objectstorage.${region}.oraclecloud.com/n/${namespace}/b/${bucket}/o`;
}

export function assertServerRouteOciClientIdentity(client, env = process.env) {
  const expected = ociIdentity(env);
  if (!client || typeof client.putObjectIfAbsent !== "function" || typeof client.readObject !== "function"
    || !client.identity || typeof client.identity !== "object"
    || client.identity.namespace !== expected.namespace
    || client.identity.bucket !== expected.bucket
    || client.identity.region !== expected.region
    || client.identity.endpoint !== expected.endpoint
    || Object.keys(client.identity).length !== 4) {
    throw new Error("injected client must use the exact OCI server-route identity");
  }
}

async function readCredentialFreeDescriptorObject(url, maxBytes) {
  const { readCredentialFreeObject } = await import("./publish-server-route-bundle.mjs");
  return readCredentialFreeObject(url, maxBytes);
}

function ociIdentity(env) {
  const namespace = segment(required(env.OCI_SERVER_ROUTE_NAMESPACE, "OCI_SERVER_ROUTE_NAMESPACE"));
  const bucket = segment(required(env.OCI_SERVER_ROUTE_BUCKET, "OCI_SERVER_ROUTE_BUCKET"));
  const region = segment(required(env.OCI_SERVER_ROUTE_REGION, "OCI_SERVER_ROUTE_REGION"));
  const endpoint = `https://${namespace}.compat.objectstorage.${region}.oraclecloud.com`;
  if (env.OCI_SERVER_ROUTE_COMPAT_ENDPOINT !== endpoint) throw new Error("OCI_SERVER_ROUTE_COMPAT_ENDPOINT must be the exact OCI compatibility endpoint");
  return { namespace, bucket, region, endpoint };
}

async function parseCanonicalDescriptor(bytes) {
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("descriptor must be canonical JSON"); }
  if (!bytes.equals(Buffer.from(canonicalJson(parsed)))) throw new Error("descriptor must be canonical JSON");
  const { validateServerRouteBundlePublicationDescriptor } = await import("./build-server-route-bundle-publication-descriptor.mjs");
  return validateServerRouteBundlePublicationDescriptor(parsed);
}
async function assertDetachedCleanHead(root, sha) {
  const cwd = path.resolve(required(root, "repository root"));
  const [{ stdout }, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
    execFileAsync("git", ["status", "--porcelain"], { cwd }),
  ]);
  if (stdout.trim() !== sha || status.stdout !== "") throw new Error("repository must be clean at the requested detached HEAD");
  try { await execFileAsync("git", ["symbolic-ref", "-q", "HEAD"], { cwd }); } catch (error) { if (error.code === 1) return; throw error; }
  throw new Error("repository must be a detached worktree");
}
async function regular(target, label) { const stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`${label} must be a non-empty regular non-symlink`); return readFile(target); }
function required(value, label) { if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) throw new Error(`${label} is required`); return value; }
function requiredSha(value, label) { if (!/^[a-f0-9]{64}$/.test(value ?? "") && !/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error(`${label} must be lowercase sha`); return value; }
function segment(value) { if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new Error("OCI identity is invalid"); return value; }
function encodeObjectKey(key) { return key.split("/").map(encode).join("/"); }
function encode(value) { return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function compare(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function parseArgs(argv) { if (argv.length !== 4 || argv[0] !== "--descriptor" || argv[2] !== "--repository-git-sha") throw new Error("exact CLI arguments are required"); return { descriptorPath: argv[1], repositoryGitSha: argv[3] }; }
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  publishServerRouteBundlePublicationDescriptor(args).then(({ descriptorSha256 }) => process.stdout.write(`PUBLISHED ${descriptorSha256}\n`)).catch((error) => { process.stderr.write(`publish-server-route-bundle-publication-descriptor: ${error.message}\n`); process.exitCode = 1; });
}
