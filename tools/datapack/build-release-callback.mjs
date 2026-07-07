#!/usr/bin/env node
// #1694 Part C: 게시 결과에서 release-callback payload를 만들고 HMAC-SHA256 서명한다.
import crypto from "node:crypto";

const e = process.env;
const fields = {
  schemaVersion: 1,
  artifactKind: "datapack-release-callback",
  releaseRequestId: e.RELEASE_REQUEST_ID,
  workflowRunUrl: e.WORKFLOW_RUN_URL,
  manifestSha256: e.MANIFEST_SHA256,
  sqliteSha256: e.SQLITE_SHA256,
  gzipSha256: e.GZIP_SHA256,
  evidenceBundleSha256: e.EVIDENCE_BUNDLE_SHA256,
  validatorStatus: e.VALIDATOR_STATUS,
  routeRegressionStatus: e.ROUTE_REGRESSION_STATUS,
  publishStatus: e.PUBLISH_STATUS,
};
const order = ["schemaVersion","artifactKind","releaseRequestId","workflowRunUrl","manifestSha256",
  "sqliteSha256","gzipSha256","evidenceBundleSha256","validatorStatus","routeRegressionStatus","publishStatus"];
const message = order.map((k) => String(fields[k])).join("\n");
const value = crypto.createHmac("sha256", e.EASYSUBWAY_DATAPACK_CALLBACK_HMAC_KEY || "")
  .update(message, "utf8").digest("hex");

process.stdout.write(JSON.stringify({ ...fields, callbackVerifier: { kind: "payload-signature", value } }));
