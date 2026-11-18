#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const [responsePath, expectedName, expectedRunIdInput, expectedSha] = process.argv.slice(2);
const expectedRunId = Number(expectedRunIdInput);

if (
  !responsePath ||
  !/^[A-Za-z0-9_.-]+$/.test(expectedName ?? "") ||
  !Number.isSafeInteger(expectedRunId) ||
  expectedRunId <= 0 ||
  !/^[a-f0-9]{40}$/.test(expectedSha ?? "")
) {
  console.error(
    "usage: require-workflow-artifact.mjs <response.json> <artifact-name> <run-id> <sha>",
  );
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(await readFile(responsePath, "utf8"));
} catch {
  console.error("workflow artifacts response is not valid JSON");
  process.exit(1);
}

if (
  !Number.isSafeInteger(payload?.total_count) ||
  payload.total_count < 0 ||
  !Array.isArray(payload?.artifacts) ||
  payload.total_count !== payload.artifacts.length ||
  payload.artifacts.length > 1
) {
  console.error("workflow artifacts response is inconsistent");
  process.exit(1);
}

if (payload.artifacts.length === 0) {
  console.error("required workflow artifact is unavailable");
  process.exit(3);
}

const [artifact] = payload.artifacts;
if (
  artifact?.name !== expectedName ||
  typeof artifact?.expired !== "boolean" ||
  !Number.isSafeInteger(artifact?.id) ||
  artifact.id <= 0 ||
  artifact?.workflow_run?.id !== expectedRunId ||
  artifact?.workflow_run?.head_sha !== expectedSha
) {
  console.error("workflow artifacts response is inconsistent");
  process.exit(1);
}

if (artifact.expired) {
  console.error("required workflow artifact is unavailable");
  process.exit(3);
}

console.log(`validated_artifact_id=${artifact.id}`);
