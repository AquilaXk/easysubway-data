#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectSeoulStationLineInfo } from "./collect-seoul-station-line-info.mjs";
import { projectSeoulStationLineMembership } from "./project-seoul-station-line-membership.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Freezes the admitted Seoul station-line membership projection (STATION_CD per LINE_NUM bound to
// the MOLIT roster line id and canonical station name) so the sync pack build can consume it offline.
export async function materializeSeoulStationCodeMembership({
  repositoryRoot = path.resolve(import.meta.dirname, "../.."),
  csvPath,
  capturedAt,
  outputPath,
} = {}) {
  if (!csvPath || !capturedAt || !outputPath) throw new Error("csvPath, capturedAt and outputPath are required");
  const snapshot = collectSeoulStationLineInfo({ csvBytes: await readFile(csvPath), capturedAt });
  const stagedSnapshotPath = `${outputPath}.snapshot.tmp`;
  await writeFile(stagedSnapshotPath, JSON.stringify(snapshot));
  let projected;
  try {
    projected = await projectSeoulStationLineMembership({ repositoryRoot, snapshotPath: stagedSnapshotPath });
  } finally {
    await rm(stagedSnapshotPath, { force: true });
  }
  const { projection, inputs } = projected;
  const artifact = {
    schemaVersion: 1,
    artifactKind: "seoul-station-code-membership-binding",
    sourceId: projection.sourceId,
    capturedAt,
    snapshot,
    records: projection.records,
    recordsSha256: projection.recordsSha256,
    inputs: {
      molit: { snapshotId: inputs.molit.snapshotId, rawSha256: inputs.molit.rawSha256, observationSha256: inputs.molit.sha256 },
      positions: { snapshotId: inputs.positions.snapshotId, rawSha256: inputs.positions.rawSha256, observationSha256: inputs.positions.sha256 },
      inventorySha256: inputs.inventory.sha256,
      ledgerSha256: inputs.ledger.sha256,
    },
    artifactSha256: sha256(JSON.stringify({ snapshotRawSha256: snapshot.rawSha256, recordsSha256: projection.recordsSha256 })),
  };
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [csvPath, capturedAt, outputPath] = process.argv.slice(2);
  materializeSeoulStationCodeMembership({ csvPath, capturedAt, outputPath: path.resolve(outputPath ?? "") })
    .then((artifact) => console.log(`wrote ${artifact.records.length} membership records, recordsSha256=${artifact.recordsSha256}`))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
