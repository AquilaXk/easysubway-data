import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function stageSyntheticCurrentItxTopologyAdmission(
  repositoryRoot,
  baseSpec,
  inWindow,
) {
  const contractPath = baseSpec.networkEdgeEvidence?.itxCoverageContract?.path;
  if (typeof contractPath !== "string") {
    throw new Error("staged ITX coverage contract path is invalid");
  }
  const contractBytes = await readFile(path.join(repositoryRoot, contractPath));
  const contract = JSON.parse(contractBytes);
  const reference = contract.sourceTimetableArtifact;
  const sourceBytes = await readFile(path.join(repositoryRoot, reference?.artifactPath ?? ""));
  const source = JSON.parse(sourceBytes);
  const serviceDate = kstDate(inWindow);
  const stagedContract = structuredClone(contract);
  stagedContract.sourceTimetableArtifact.promotion.mode = "UNCHANGED_AUTO";
  stagedContract.sourceTimetableArtifact.promotion.previousArtifactSha256 = reference.sha256;
  const admission = syntheticCurrentItxTopologyAdmission({
    source,
    previousArtifactSha256: reference.sha256,
    inWindow,
    serviceDate,
  });
  const admissionPath = `tools/datapack/itx-current-network-edge-admission-${serviceDate}.json`;
  const stagedContractBytes = Buffer.from(`${JSON.stringify(stagedContract, null, 2)}\n`);
  const admissionBytes = Buffer.from(`${JSON.stringify(admission, null, 2)}\n`);
  await Promise.all([
    writeFile(path.join(repositoryRoot, contractPath), stagedContractBytes),
    writeFile(path.join(repositoryRoot, admissionPath), admissionBytes),
  ]);
  const nextBaseSpec = structuredClone(baseSpec);
  nextBaseSpec.networkEdgeEvidence.itxCoverageContract.sha256 = sha256(stagedContractBytes);
  nextBaseSpec.networkEdgeEvidence.itxCurrentTopologyAdmission = {
    path: admissionPath,
    sha256: sha256(admissionBytes),
  };
  return { baseSpec: nextBaseSpec, admissionPath, admissionBytes };
}

function syntheticCurrentItxTopologyAdmission({
  source,
  previousArtifactSha256,
  inWindow,
  serviceDate,
}) {
  const tuples = [...new Map((source.stationSequences ?? []).flatMap(({ stops = [] }) =>
    stops.slice(1).map((to, index) => [stops[index].stationId, to.stationId, "ITX_CHEONGCHUN"])
  ).map((tuple) => [JSON.stringify(tuple), tuple])).values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  const stationIds = [...new Set(tuples.flatMap(([fromStationId, toStationId]) => [
    fromStationId,
    toStationId,
  ]))].sort((left, right) => left.localeCompare(right, "en"));
  const artifact = {
    schemaVersion: 1,
    artifactKind: "itx-current-network-edge-admission",
    artifactId: `itx-current-network-edge-admission-${serviceDate}`,
    serviceId: "ITX_CHEONGCHUN",
    sourceIssue: 2776,
    status: "ADMITTED",
    scheduleAdmissionStatus: "MISSING",
    topologyMode: "UNCHANGED_AUTO_STATION_SET",
    serviceDate,
    observedAt: inWindow.toISOString(),
    freshUntil: nextKstMidnight(serviceDate),
    collectionSha256: sha256(JSON.stringify(source)),
    previousArtifactSha256,
    stationSetHash: sha256(JSON.stringify(stationIds)),
    odMatrixHash: sha256(JSON.stringify(tuples)),
    operationEvidenceSha256: sha256(JSON.stringify(source.stationSequences)),
    stationSequenceSha256: sha256(JSON.stringify(source.stationSequences)),
    canonicalStationSetSha256: sha256(JSON.stringify(stationIds)),
    observedPairSetSha256: sha256(JSON.stringify(tuples)),
    admittedPairSetSha256: sha256(JSON.stringify(tuples)),
    observedPairChange: {
      addedCount: 0,
      removedCount: 0,
      addedSha256: sha256(JSON.stringify([])),
      removedSha256: sha256(JSON.stringify([])),
    },
    pairHashes: tuples.map((tuple) => sha256(JSON.stringify(tuple))),
    reconstructionSummary: {
      trainCount: source.stationSequences.length,
      stopCount: source.stationSequences.reduce((sum, { stops = [] }) => sum + stops.length, 0),
      conflictingTimestampCount: 0,
      missingPairCount: 0,
      duplicateOdCount: 0,
    },
    credentialRedacted: true,
  };
  artifact.evidenceHash = sha256(JSON.stringify(artifact));
  return artifact;
}

function kstDate(value) {
  return new Date(value.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString().slice(0, 10).replaceAll("-", "");
}

function nextKstMidnight(serviceDate) {
  const date = new Date(Date.UTC(
    Number(serviceDate.slice(0, 4)),
    Number(serviceDate.slice(4, 6)) - 1,
    Number(serviceDate.slice(6, 8)),
  ));
  date.setUTCDate(date.getUTCDate() + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
    + `-${String(date.getUTCDate()).padStart(2, "0")}T00:00:00+09:00`;
}
