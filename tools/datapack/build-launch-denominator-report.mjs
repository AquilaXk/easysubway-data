import { createHash } from "node:crypto";

const REQUIRED_IDENTITY_FIELDS = [
  "canonicalStationVersion",
  "corridorId",
  "serviceId",
  "lineageId",
  "schemaVersion",
];

export function canonicalScopeHash(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  return createHash("sha256").update(JSON.stringify(canonicalize(scope))).digest("hex");
}

export function buildLaunchDenominatorReport(scope, evidence) {
  const evaluatorInput = sanitizeEvaluatorInput(evidence);
  const blockers = collectV1Blockers(scope, evaluatorInput);
  const identities = ["source", "server", "mobile"].map((consumer) => evaluatorInput[consumer].identity);
  const sharedFields = scope?.identityMatrix?.requiredSharedFields ?? [];
  const identityCompatible = !blockers.some((blocker) => blocker.startsWith("IDENTITY_"));
  const sharedIdentity = Object.fromEntries(
    sharedFields.map((field) => [field, identityCompatible ? identities[0]?.[field] ?? null : null]),
  );
  const requiredAccessibilityRows = requiredPilotRowIds(scope?.verifiedAccessibilityScope);
  const coveredAccessibilityRows = new Set(evaluatorInput.pilot.coveredRowIds ?? []);
  const coveredAccessibilityCount = requiredAccessibilityRows
    .filter((rowId) => coveredAccessibilityRows.has(rowId)).length;
  return {
    decision: blockers.length === 0 ? "GO" : "NO_GO",
    blockers,
    evaluatorInput,
    nationwideBlocksV1: false,
    scopes: {
      verifiedAccessibilityScope: scopeSummary(scope?.verifiedAccessibilityScope),
      routingLaunchScope: scopeSummary(scope?.routingLaunchScope),
      nationwideRoadmapScope: scopeSummary(scope?.nationwideRoadmapScope),
    },
    identityLinkage: {
      compatible: identityCompatible,
      matrixSha256: scope?.identityMatrix ? canonicalScopeHash(scope.identityMatrix) : null,
      shared: sharedIdentity,
      artifactHashes: {
        source: evaluatorInput.source.artifactHash,
        server: evaluatorInput.server.artifactHash,
        mobile: evaluatorInput.mobile.artifactHash,
      },
    },
    coverage: {
      accessibility: {
        requiredCount: requiredAccessibilityRows.length,
        coveredCount: coveredAccessibilityCount,
        gapCount: requiredAccessibilityRows.length - coveredAccessibilityCount,
      },
      nationwide: {
        requiredCount: scope?.nationwideRoadmapScope?.launchRequiredCount ?? 0,
        missingCount: evaluatorInput.nationwide.missingCount,
        blocksV1: false,
      },
    },
    consumerStates: {
      source: evaluatorInput.source.status ?? "UNAVAILABLE",
      server: evaluatorInput.server.status ?? "UNAVAILABLE",
      mobile: evaluatorInput.mobile.status ?? "UNAVAILABLE",
    },
    routing: {
      admittedStationIds: {
        status: evaluatorInput.source.status === "ADMITTED" ? "ADMITTED" : "MISSING",
        ids: evaluatorInput.source.admittedStationIds ?? [],
      },
      sourceDerivedConnectionEdgeIds: evaluatorInput.routing.sourceDerivedConnectionEdgeIds,
    },
  };
}

function sanitizeEvaluatorInput(evidence) {
  const arrayOrNull = (value) => Array.isArray(value) ? [...value] : null;
  const identity = (value) => Object.fromEntries(
    REQUIRED_IDENTITY_FIELDS.map((field) => [field, value?.[field] ?? null]),
  );
  return {
    pilot: { coveredRowIds: arrayOrNull(evidence?.pilot?.coveredRowIds) },
    routing: {
      regionIds: arrayOrNull(evidence?.routing?.regionIds),
      operatorIds: arrayOrNull(evidence?.routing?.operatorIds),
      lineIds: arrayOrNull(evidence?.routing?.lineIds),
      baseStationIds: arrayOrNull(evidence?.routing?.baseStationIds),
      admittedStationIds: arrayOrNull(evidence?.routing?.admittedStationIds),
      materializedStationIds: arrayOrNull(evidence?.routing?.materializedStationIds),
      transferStationIds: arrayOrNull(evidence?.routing?.transferStationIds),
      baseEdgeIds: arrayOrNull(evidence?.routing?.baseEdgeIds),
      transferEdgeIds: arrayOrNull(evidence?.routing?.transferEdgeIds),
      sourceDerivedConnectionEdgeIds: {
        status: evidence?.routing?.sourceDerivedConnectionEdgeIds?.status ?? "MISSING",
        ids: arrayOrNull(evidence?.routing?.sourceDerivedConnectionEdgeIds?.ids) ?? [],
      },
      serviceIds: arrayOrNull(evidence?.routing?.serviceIds),
    },
    source: {
      status: evidence?.source?.status ?? null,
      freshness: evidence?.source?.freshness ?? null,
      routingScopeHash: evidence?.source?.routingScopeHash ?? null,
      admittedStationIds: arrayOrNull(evidence?.source?.admittedStationIds),
      sourceDerivedConnectionEdgeIds: arrayOrNull(evidence?.source?.sourceDerivedConnectionEdgeIds),
      artifactHash: evidence?.source?.artifactHash ?? null,
      identity: identity(evidence?.source?.identity),
    },
    server: {
      status: evidence?.server?.status ?? null,
      routingReady: evidence?.server?.routingReady === true,
      artifactHash: evidence?.server?.artifactHash ?? null,
      identity: identity(evidence?.server?.identity),
    },
    mobile: {
      status: evidence?.mobile?.status ?? null,
      topologyReady: evidence?.mobile?.topologyReady === true,
      artifactHash: evidence?.mobile?.artifactHash ?? null,
      identity: identity(evidence?.mobile?.identity),
    },
    safety: {
      signatureValid: evidence?.safety?.signatureValid === true,
      rollbackVerified: evidence?.safety?.rollbackVerified === true,
      freshness: evidence?.safety?.freshness ?? null,
      lineage: evidence?.safety?.lineage ?? null,
    },
    claims: {
      accessibilityScopeId: evidence?.claims?.accessibilityScopeId ?? null,
      routingScopeId: evidence?.claims?.routingScopeId ?? null,
      serviceIds: arrayOrNull(evidence?.claims?.serviceIds),
    },
    forbiddenEvidence: Array.isArray(evidence?.forbiddenEvidence)
      ? evidence.forbiddenEvidence.map(({ evidenceClass }) => ({ evidenceClass: evidenceClass ?? null }))
      : null,
    forbiddenEvidenceStatus: evidence?.forbiddenEvidenceStatus ?? null,
    nationwide: { missingCount: evidence?.nationwide?.missingCount ?? null },
    candidateBinding: sanitizeCandidateBinding(evidence?.candidateBinding),
  };
}

function sanitizeCandidateBinding(value) {
  const artifact = (evidence) => ({
    status: evidence?.status ?? "MISSING",
    sha256: evidence?.sha256 ?? null,
    freshUntil: evidence?.freshUntil ?? null,
  });
  return {
    status: value?.status ?? "INCOMPLETE",
    buildCandidateId: value?.buildCandidateId ?? null,
    packCandidateId: value?.packCandidateId ?? null,
    candidateBuilderGitSha: value?.candidateBuilderGitSha ?? null,
    buildSpecSha256: value?.buildSpecSha256 ?? null,
    manifestSha256: value?.manifestSha256 ?? null,
    sourceEvidence: artifact(value?.sourceEvidence),
    serverEvidence: artifact(value?.serverEvidence),
    mobileEvidence: artifact(value?.mobileEvidence),
  };
}

function collectV1Blockers(scope, evidence) {
  const blockers = [];
  const accessibilityScope = scope?.verifiedAccessibilityScope;
  const routingScope = scope?.routingLaunchScope;
  const identityMatrix = scope?.identityMatrix;

  for (const subsection of [
    "verifiedAccessibilityScope",
    "routingLaunchScope",
    "nationwideRoadmapScope",
    "identityMatrix",
  ]) {
    const value = scope?.[subsection];
    if (!validScopeSubsection(subsection, value)) {
      blockers.push(`SCOPE_CONTRACT_INVALID:${subsection}`);
    }
  }

  const candidateBinding = evidence?.candidateBinding;
  if (!validCandidateBinding(candidateBinding)) blockers.push("CANDIDATE_BINDING_INVALID");
  for (const consumer of ["source", "server", "mobile"]) {
    const boundEvidence = candidateBinding?.[`${consumer}Evidence`];
    if (boundEvidence?.status !== "FRESH") {
      blockers.push(`CANDIDATE_EVIDENCE_NOT_FRESH:${consumer}`);
    } else if (boundEvidence.sha256 !== evidence?.[consumer]?.artifactHash) {
      blockers.push(`CANDIDATE_EVIDENCE_HASH_MISMATCH:${consumer}`);
    }
  }

  if (!sameSet(requiredPilotRowIds(accessibilityScope), evidence?.pilot?.coveredRowIds)) {
    blockers.push("PILOT_ROW_GAP");
  }

  if (!sameSet(routingScope?.regionIds, evidence?.routing?.regionIds)) {
    blockers.push("ROUTING_REGION_SCOPE_MISMATCH");
  }
  if (!sameSet(routingScope?.operatorIds, evidence?.routing?.operatorIds)) {
    blockers.push("ROUTING_OPERATOR_SCOPE_MISMATCH");
  }
  if (!sameSet(routingScope?.lineIds, evidence?.routing?.lineIds)) {
    blockers.push("ROUTING_LINE_SCOPE_MISMATCH");
  }
  if (!sameSet(routingScope?.baseRoutingStationIds, evidence?.routing?.baseStationIds)) {
    blockers.push("ROUTING_BASE_STATION_ID_GAP");
  }

  const admittedStations = evidence?.routing?.admittedStationIds;
  const sourceAdmittedStations = evidence?.source?.admittedStationIds;
  if (
    routingScope?.admittedStationEvidenceRequired !== true
    || !sameSet(sourceAdmittedStations, admittedStations)
    || !sameSet(sourceAdmittedStations, evidence?.routing?.materializedStationIds)
  ) {
    blockers.push("ROUTING_STATION_ID_GAP");
  }
  if (!sameSet(routingScope?.requiredBaseEdgeIds, evidence?.routing?.baseEdgeIds)) {
    blockers.push("ROUTING_BASE_EDGE_ID_GAP");
  }
  if (!sameSet(routingScope?.requiredTransferStationIds, evidence?.routing?.transferStationIds)) {
    blockers.push("ROUTING_TRANSFER_STATION_ID_GAP");
  }
  if (!sameSet(routingScope?.requiredTransferEdgeIds, evidence?.routing?.transferEdgeIds)) {
    blockers.push("ROUTING_TRANSFER_EDGE_ID_GAP");
  }
  if (
    routingScope?.sourceDerivedConnectionEdgeEvidenceRequired !== true
    || evidence?.routing?.sourceDerivedConnectionEdgeIds?.status !== "ADMITTED"
    || !sameSet(
      evidence?.source?.sourceDerivedConnectionEdgeIds,
      evidence?.routing?.sourceDerivedConnectionEdgeIds?.ids,
    )
  ) {
    blockers.push("ROUTING_SOURCE_DERIVED_CONNECTION_EDGE_ID_GAP");
  }
  if (!sameSet(routingScope?.serviceIds, evidence?.routing?.serviceIds)) {
    blockers.push("ROUTING_SERVICE_SCOPE_MISMATCH");
  }

  if (evidence?.source?.status !== "ADMITTED") blockers.push("SOURCE_NOT_ADMITTED");
  if (evidence?.source?.freshness !== "FRESH") blockers.push("SOURCE_STALE");
  if (evidence?.source?.routingScopeHash !== canonicalScopeHash(routingScope)) {
    blockers.push("ROUTING_SCOPE_HASH_MISMATCH");
  }
  if (evidence?.server?.status !== "ACTIVE") blockers.push("SERVER_NOT_ACTIVE");
  if (evidence?.server?.routingReady !== true) blockers.push("SERVER_ROUTING_NOT_READY");
  if (evidence?.mobile?.status !== "READY") blockers.push("MOBILE_NOT_READY");
  if (evidence?.mobile?.topologyReady !== true) blockers.push("MOBILE_TOPOLOGY_NOT_READY");

  const consumers = ["source", "server", "mobile"];
  if (
    !nonEmptyStringSet(identityMatrix?.requiredSharedFields)
    || !REQUIRED_IDENTITY_FIELDS.every((field) => identityMatrix.requiredSharedFields.includes(field))
  ) {
    blockers.push("IDENTITY_MATRIX_CONTRACT_INVALID");
  }
  for (const field of identityMatrix?.requiredSharedFields ?? []) {
    const values = consumers.map((consumer) => evidence?.[consumer]?.identity?.[field]);
    if (REQUIRED_IDENTITY_FIELDS.includes(field) && values.some((value) => !validIdentityField(field, value))) {
      blockers.push(`IDENTITY_FIELD_INVALID:${field}`);
    }
    if (values.some((value) => value === undefined || value === null) || new Set(values).size !== 1) {
      blockers.push(`IDENTITY_FIELD_MISMATCH:${field}`);
    }
  }
  const artifactHashes = consumers.map((consumer) => evidence?.[consumer]?.artifactHash);
  if (artifactHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash ?? ""))) {
    blockers.push("IDENTITY_ARTIFACT_HASH_INVALID");
  } else if (identityMatrix?.differentArtifactHashesAllowed !== true && new Set(artifactHashes).size !== 1) {
    blockers.push("IDENTITY_ARTIFACT_HASH_MISMATCH");
  }

  if (evidence?.safety?.signatureValid !== true) blockers.push("SIGNATURE_INVALID");
  if (evidence?.safety?.rollbackVerified !== true) blockers.push("ROLLBACK_UNVERIFIED");
  if (evidence?.safety?.freshness !== "FRESH") blockers.push("EVIDENCE_STALE");
  if (evidence?.safety?.lineage !== "VERIFIED") blockers.push("LINEAGE_UNVERIFIED");

  if (
    evidence?.claims?.accessibilityScopeId !== accessibilityScope?.id
    || evidence?.claims?.routingScopeId !== routingScope?.id
    || !sameSet(evidence?.claims?.serviceIds, routingScope?.serviceIds)
  ) {
    blockers.push("CLAIM_SCOPE_MISMATCH");
  }
  if (!Array.isArray(evidence?.forbiddenEvidence) || evidence?.forbiddenEvidenceStatus !== "VERIFIED") {
    blockers.push("FORBIDDEN_EVIDENCE_UNVERIFIED");
  }
  if ((evidence?.forbiddenEvidence ?? []).some(({ evidenceClass }) =>
    ["FIXTURE", "LEGACY", "OTHER_SERVICE"].includes(evidenceClass))) {
    blockers.push("FORBIDDEN_EVIDENCE_CLASS");
  }

  return [...new Set(blockers)];
}

function validScopeSubsection(subsection, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (subsection === "verifiedAccessibilityScope") {
    return nonEmptyString(value.id)
      && (
        nonEmptyStringSet(value.requiredRowIds)
        || (
          nonEmptyStringSet(value.includedStationIds)
          && nonEmptyStringSet(value.includedLineIds)
          && nonEmptyStringSet(value.requiredFacilityTypes)
        )
      );
  }
  if (subsection === "routingLaunchScope") {
    return nonEmptyString(value.id)
      && nonEmptyStringSet(value.regionIds)
      && nonEmptyStringSet(value.operatorIds)
      && nonEmptyStringSet(value.lineIds)
      && nonEmptyStringSet(value.serviceIds)
      && nonEmptyStringSet(value.baseRoutingStationIds);
  }
  if (subsection === "nationwideRoadmapScope") {
    return nonEmptyString(value.id)
      && Number.isSafeInteger(value.launchRequiredCount)
      && value.launchRequiredCount >= 0;
  }
  return subsection === "identityMatrix"
    && nonEmptyStringSet(value.requiredSharedFields)
    && typeof value.differentArtifactHashesAllowed === "boolean";
}

function validCandidateBinding(value) {
  return value?.status === "BOUND"
    && nonEmptyString(value.buildCandidateId)
    && nonEmptyString(value.packCandidateId)
    && nonEmptyString(value.candidateBuilderGitSha)
    && /^[a-f0-9]{64}$/.test(value.buildSpecSha256 ?? "")
    && /^[a-f0-9]{64}$/.test(value.manifestSha256 ?? "")
    && ["source", "server", "mobile"].every((consumer) => {
      const artifact = value?.[`${consumer}Evidence`];
      return artifact?.status === "FRESH"
        && /^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")
        && typeof artifact.freshUntil === "string"
        && Number.isFinite(Date.parse(artifact.freshUntil));
    });
}

function validIdentityField(field, value) {
  if (field === "schemaVersion") return Number.isSafeInteger(value) && value > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requiredPilotRowIds(scope) {
  if (nonEmptyStringSet(scope?.requiredRowIds)) return scope.requiredRowIds;
  if (!nonEmptyStringSet(scope?.includedStationIds) || !nonEmptyStringSet(scope?.requiredFacilityTypes)) return [];
  return scope.includedStationIds.flatMap((stationId) =>
    scope.requiredFacilityTypes.map((facilityType) => `${stationId}|${scope.includedLineIds?.[0] ?? ""}|${facilityType}`));
}

function scopeSummary(value) {
  return {
    id: value?.id ?? null,
    sha256: canonicalScopeHash(value),
  };
}

function sameSet(left, right) {
  if (!nonEmptyStringSet(left) || !nonEmptyStringSet(right)) return false;
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return expected.size === left.length && new Set(right).size === right.length
    && right.every((value) => expected.has(value));
}

function nonEmptyStringSet(values) {
  return Array.isArray(values) && values.length > 0
    && values.every((value) => typeof value === "string" && value.length > 0)
    && new Set(values).size === values.length;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}
