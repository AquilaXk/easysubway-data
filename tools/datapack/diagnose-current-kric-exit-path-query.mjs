#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readRegularSnapshot } from "./build-current-kric-exit-collection-plan.mjs";
import {
  parseCanonicalPlan,
  validateProviderBoundary,
} from "./collect-current-kric-exit-path-provider-snapshot.mjs";
import {
  probeKricExitPathProviderQuery,
  resolveKricExitPathProviderQuery,
} from "./collect-kric-exit-path-provider-snapshot.mjs";
import { assertKricControlOperation } from "./collect-kric-source-candidate-evidence.mjs";
import {
  CANDIDATES_PATH,
  requiredText,
  runProviderControlOperation,
  sanitizeErrorMessage,
} from "./lib/source-candidate-evidence-collector.mjs";
import { resolveProviderCallIntegrity } from "./lib/provider-call-integrity.mjs";

const PROVIDER_ID = "kric";
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const RESULT_STATES = new Set([
  "EXPLICIT_ZERO",
  "PROVIDER_NO_DATA",
  "PROVIDER_RESULT_UNVERIFIED",
  "ROWS_OBSERVED",
]);
const TRANSPORT_STATES = new Set([
  "NETWORK_DNS",
  "NETWORK_TLS",
  "NETWORK_TIMEOUT",
  "NETWORK_SOCKET",
  "NETWORK_UNKNOWN",
]);

export async function main(argv, {
  candidatesDocument,
  controlProbeImpl = runProviderControlOperation,
  env = process.env,
  log = console.log,
  targetProbeImpl = probeKricExitPathProviderQuery,
} = {}) {
  const args = parseArgs(argv);
  const serviceKey = requiredText(env.KRIC_SERVICE_KEY, "KRIC_SERVICE_KEY");
  const planSnapshot = await readRegularSnapshot(args.collectionPlan, "collection-plan");
  const collectionPlan = parseCanonicalPlan(planSnapshot.bytes);
  resolveKricExitPathProviderQuery({ collectionPlan, queryId: args.queryId, sourceId: args.sourceId });

  const document = candidatesDocument ?? JSON.parse(await readFile(CANDIDATES_PATH, "utf8"));
  validateProviderBoundary({ document, serviceKey, sourceId: args.sourceId });
  const integrity = resolveProviderCallIntegrity(document, PROVIDER_ID, { required: true });
  const controlOperation = assertKricControlOperation(document, integrity.controlOperation);

  let controlStatus = "FAILED";
  try {
    const status = await controlProbeImpl({ controlOperation, serviceKey });
    controlStatus = status === "succeeded" ? "SUCCEEDED" : "FAILED";
  } catch {
    controlStatus = "FAILED";
  }

  let targetStatus = "PROVIDER_FAILURE";
  let targetResultState = null;
  try {
    const result = await targetProbeImpl({
      collectionPlan,
      queryId: args.queryId,
      sourceId: args.sourceId,
      serviceKey,
      requestTimeoutMs: args.requestTimeoutMs,
    });
    if (result?.queryId === args.queryId && RESULT_STATES.has(result.state)) {
      targetStatus = "SUCCEEDED";
      targetResultState = result.state;
    }
  } catch (error) {
    targetStatus = classifyTargetFailure(error, args.queryId);
  }

  const receipt = {
    result: "DIAGNOSED",
    sourceId: args.sourceId,
    queryId: args.queryId,
    controlStatus,
    targetStatus,
    targetResultState,
    attempts: { control: 1, target: 1 },
    credentialRedacted: true,
  };
  log(`current KRIC EXIT timeout diagnosis ready: ${JSON.stringify(receipt)}`);
  return receipt;
}

function classifyTargetFailure(error, queryId) {
  const message = error instanceof Error ? error.message : "";
  const escapedQueryId = queryId.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const transport = message.match(new RegExp(
    `^KRIC EXIT request failed: (${[...TRANSPORT_STATES].join("|")}): ${escapedQueryId}$`,
  ));
  if (transport) return transport[1];
  if (new RegExp(`^KRIC EXIT HTTP [0-9]{3}: ${escapedQueryId}$`).test(message)) return "HTTP_STATUS";
  return "PROVIDER_FAILURE";
}

function parseArgs(argv) {
  const flags = new Set(["collection-plan", "source-id", "query-id", "request-timeout-ms"]);
  if (!Array.isArray(argv) || argv.length !== flags.size * 2) {
    throw new Error("KRIC EXIT timeout diagnostic arguments mismatch");
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = typeof argv[index] === "string" ? argv[index].replace(/^--/, "") : "";
    const value = argv[index + 1];
    if (!flags.has(flag) || values[flag] !== undefined || typeof value !== "string" || value === "") {
      throw new Error("KRIC EXIT timeout diagnostic arguments mismatch");
    }
    values[flag] = value;
  }
  if (!path.isAbsolute(values["collection-plan"])) {
    throw new Error("--collection-plan must be an absolute path");
  }
  if (!/^[0-9a-f]{64}$/.test(values["query-id"])) throw new Error("--query-id must be a SHA-256 identity");
  const requestTimeoutMs = Number(values["request-timeout-ms"]);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error("KRIC EXIT request timeout is invalid");
  }
  return {
    collectionPlan: path.resolve(values["collection-plan"]),
    sourceId: requiredText(values["source-id"], "--source-id"),
    queryId: values["query-id"],
    requestTimeoutMs,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(sanitizeErrorMessage(error, process.env.KRIC_SERVICE_KEY ?? ""));
    process.exitCode = 1;
  }
}
