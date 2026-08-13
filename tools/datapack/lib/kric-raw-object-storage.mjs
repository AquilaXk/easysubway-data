import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function publishImmutableKricRawObject({
  execFileImpl,
  errorPrefix,
  bucket,
  objectKey,
  expectedBucketOwner,
  bodyPath,
  checksumSha256,
  byteSize,
  rawObjectSha256,
  artifactKind,
  sourceId,
}) {
  const trustedBucketOwner = requiredAccount(expectedBucketOwner, "expectedBucketOwner");
  const { stdout: callerStdout } = await runAws(execFileImpl, errorPrefix, "caller identity", [
    "sts", "get-caller-identity", "--query", "Account", "--output", "text", "--no-cli-pager",
  ]);
  const caller = callerStdout.trim();
  if (!/^\d{12}$/u.test(caller)) throw new Error("AWS caller account is invalid");
  if (caller !== trustedBucketOwner) throw new Error("AWS caller account does not match expected bucket owner");

  const common = [
    "--bucket", bucket,
    "--key", objectKey,
    "--expected-bucket-owner", trustedBucketOwner,
    "--output", "json",
    "--no-cli-pager",
  ];
  let idempotentExistingObject = false;
  try {
    await runAws(execFileImpl, errorPrefix, "upload", [
      "s3api", "put-object",
      ...common,
      "--body", bodyPath,
      "--content-type", "application/json",
      "--checksum-sha256", checksumSha256,
      "--metadata", `artifact-kind=${artifactKind},source-id=${sourceId},sha256=${rawObjectSha256}`,
      "--if-none-match", "*",
    ]);
  } catch (error) {
    if (error?.awsFailureCode !== "PreconditionFailed" && error?.awsFailureCode !== "412") throw error;
    idempotentExistingObject = true;
  }

  const { stdout } = await runAws(execFileImpl, errorPrefix, "head verification", [
    "s3api", "head-object",
    ...common,
    "--checksum-mode", "ENABLED",
  ]);
  const head = JSON.parse(stdout);
  if (head?.ContentLength !== byteSize
    || head.ChecksumSHA256 !== checksumSha256
    || head.Metadata?.sha256 !== rawObjectSha256
    || head.Metadata?.["artifact-kind"] !== artifactKind
    || head.Metadata?.["source-id"] !== sourceId) {
    throw new Error("S3 object identity mismatch");
  }
  return { head, trustedBucketOwner, idempotentExistingObject };
}

export async function writeKricRawReceipt(receiptPath, receipt, { mode } = {}) {
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  const options = mode == null ? { flag: "wx" } : { flag: "wx", mode };
  try {
    await writeFile(receiptPath, body, options);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (await readFile(receiptPath, "utf8") !== body) {
      throw new Error("raw receipt already exists with different bytes");
    }
  }
}

export function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

export function requiredAccount(value, label) {
  const text = requiredText(value, label);
  if (!/^\d{12}$/u.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

export function requiredUtcInstant(value, label) {
  const text = requiredText(value, label);
  const timestamp = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/u.test(text)
    || Number.isNaN(timestamp)) throw new Error(`${label} must be a UTC instant`);
  return new Date(timestamp).toISOString();
}

function safeAwsFailureCode(error) {
  const text = String(error?.stderr ?? error?.message ?? "");
  return text.match(/\(([A-Za-z][A-Za-z0-9_-]*)\) when calling/u)?.[1]
    ?? text.match(/\b([45]\d\d)\b/u)?.[1]
    ?? "UNKNOWN";
}

async function runAws(execFileImpl, errorPrefix, context, args) {
  try {
    return await execFileImpl("aws", args, { maxBuffer: 1024 * 1024 });
  } catch (error) {
    const failureCode = safeAwsFailureCode(error);
    const sanitized = new Error(`${errorPrefix} ${context} failed: ${failureCode}`);
    sanitized.awsFailureCode = failureCode;
    throw sanitized;
  }
}
