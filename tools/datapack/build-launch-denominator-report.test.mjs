import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildLaunchDenominatorReport,
  canonicalScopeHash,
} from "./build-launch-denominator-report.mjs";

const scope = {
  verifiedAccessibilityScope: {
    id: "capital-pilot-accessibility-v1",
    requiredRowIds: [
      "station-sangnoksu|seoul-4|ELEVATOR",
      "station-sangnoksu|seoul-4|ESCALATOR",
      "station-sangnoksu|seoul-4|WHEELCHAIR_LIFT",
      "station-sadang|seoul-4|ELEVATOR",
      "station-sadang|seoul-4|ESCALATOR",
      "station-sadang|seoul-4|WHEELCHAIR_LIFT",
    ],
  },
  routingLaunchScope: {
    id: "capital-routing-launch-v1",
    regionIds: ["capital"],
    operatorIds: ["seoul-metro", "korail"],
    lineIds: ["seoul-4", "line-6e39be0cb6e2", "line-54a7b980b7c3"],
    serviceIds: ["SUBWAY", "ITX_CHEONGCHUN"],
    baseRoutingStationIds: ["station-pilot-a", "station-pilot-b"],
    requiredTransferStationIds: ["station-a", "station-b"],
    requiredBaseEdgeIds: ["edge-a-b", "edge-b-c"],
    requiredTransferEdgeIds: ["transfer-b"],
    admittedStationEvidenceRequired: true,
    sourceDerivedConnectionEdgeEvidenceRequired: true,
  },
  nationwideRoadmapScope: {
    id: "nationwide-roadmap-v1",
    launchRequiredCount: 270,
  },
  identityMatrix: {
    requiredSharedFields: [
      "canonicalStationVersion",
      "corridorId",
      "serviceId",
      "lineageId",
      "schemaVersion",
    ],
    differentArtifactHashesAllowed: true,
  },
};

function passingEvidence({ nationwideMissing = 270 } = {}) {
  const identity = {
    canonicalStationVersion: "station-catalog-v18",
    corridorId: "capital-gyeongchun-v1",
    serviceId: "ITX_CHEONGCHUN",
    lineageId: "launch-lineage-v1",
    schemaVersion: 1,
  };
  return {
    pilot: { coveredRowIds: [...scope.verifiedAccessibilityScope.requiredRowIds] },
    routing: {
      regionIds: [...scope.routingLaunchScope.regionIds],
      operatorIds: [...scope.routingLaunchScope.operatorIds],
      lineIds: [...scope.routingLaunchScope.lineIds],
      baseStationIds: [...scope.routingLaunchScope.baseRoutingStationIds],
      admittedStationIds: ["station-a", "station-b", "station-c"],
      materializedStationIds: ["station-a", "station-b", "station-c"],
      transferStationIds: [...scope.routingLaunchScope.requiredTransferStationIds],
      baseEdgeIds: [...scope.routingLaunchScope.requiredBaseEdgeIds],
      transferEdgeIds: [...scope.routingLaunchScope.requiredTransferEdgeIds],
      sourceDerivedConnectionEdgeIds: {
        status: "ADMITTED",
        ids: ["source-edge-a"],
      },
      serviceIds: [...scope.routingLaunchScope.serviceIds],
    },
    source: {
      status: "ADMITTED",
      freshness: "FRESH",
      routingScopeHash: canonicalScopeHash(scope.routingLaunchScope),
      admittedStationIds: ["station-a", "station-b", "station-c"],
      sourceDerivedConnectionEdgeIds: ["source-edge-a"],
      artifactHash: "a".repeat(64),
      identity: { ...identity },
    },
    server: {
      status: "ACTIVE",
      routingReady: true,
      artifactHash: "b".repeat(64),
      identity: { ...identity },
    },
    mobile: {
      status: "READY",
      topologyReady: true,
      artifactHash: "c".repeat(64),
      identity: { ...identity },
    },
    safety: {
      signatureValid: true,
      rollbackVerified: true,
      freshness: "FRESH",
      lineage: "VERIFIED",
    },
    claims: {
      accessibilityScopeId: scope.verifiedAccessibilityScope.id,
      routingScopeId: scope.routingLaunchScope.id,
      serviceIds: [...scope.routingLaunchScope.serviceIds],
    },
    forbiddenEvidence: [],
    forbiddenEvidenceStatus: "VERIFIED",
    nationwide: { missingCount: nationwideMissing },
    candidateBinding: {
      status: "BOUND",
      buildCandidateId: "candidate-a",
      packCandidateId: "capital@1",
      candidateBuilderGitSha: "abcdef1",
      buildSpecSha256: "d".repeat(64),
      manifestSha256: "e".repeat(64),
      sourceEvidence: { status: "FRESH", sha256: "a".repeat(64), freshUntil: "2099-08-01T00:00:00Z" },
      serverEvidence: { status: "FRESH", sha256: "b".repeat(64), freshUntil: "2099-08-01T00:00:00Z" },
      mobileEvidence: { status: "FRESH", sha256: "c".repeat(64), freshUntil: "2099-08-01T00:00:00Z" },
    },
  };
}

function withGap(mutator) {
  const evidence = passingEvidence();
  mutator(evidence);
  return evidence;
}

test("nationwide 0% does not block a fully satisfied v1 scope", () => {
  const report = buildLaunchDenominatorReport(scope, passingEvidence({ nationwideMissing: 270 }));
  assert.equal(report.decision, "GO");
  assert.equal(report.nationwideBlocksV1, false);
  assert.deepEqual(report.blockers, []);
});

test("report는 secret 없는 evaluator input만 포함하고 자체 재계산할 수 있다", () => {
  const evidence = passingEvidence();
  evidence.apiKey = "must-not-leak";
  evidence.source.credential = "must-not-leak";
  const report = buildLaunchDenominatorReport(scope, evidence);
  assert.doesNotMatch(JSON.stringify(report), /must-not-leak/);
  assert.deepEqual(buildLaunchDenominatorReport(scope, report.evaluatorInput), report);
});

test("pilot row and each routing exact-set gap block launch", async (context) => {
  const gaps = [
    ["pilot row", (evidence) => evidence.pilot.coveredRowIds.pop(), "PILOT_ROW_GAP"],
    ["base routing station", (evidence) => evidence.routing.baseStationIds.pop(), "ROUTING_BASE_STATION_ID_GAP"],
    ["admitted station", (evidence) => evidence.routing.admittedStationIds.pop(), "ROUTING_STATION_ID_GAP"],
    ["materialized station", (evidence) => evidence.routing.materializedStationIds.pop(), "ROUTING_STATION_ID_GAP"],
    ["transfer station", (evidence) => evidence.routing.transferStationIds.pop(), "ROUTING_TRANSFER_STATION_ID_GAP"],
    ["base edge", (evidence) => evidence.routing.baseEdgeIds.pop(), "ROUTING_BASE_EDGE_ID_GAP"],
    ["transfer edge", (evidence) => evidence.routing.transferEdgeIds.pop(), "ROUTING_TRANSFER_EDGE_ID_GAP"],
    [
      "source-derived connection edge",
      (evidence) => { evidence.routing.sourceDerivedConnectionEdgeIds = { status: "MISSING", ids: [] }; },
      "ROUTING_SOURCE_DERIVED_CONNECTION_EDGE_ID_GAP",
    ],
  ];
  for (const [name, mutate, blocker] of gaps) {
    await context.test(name, () => {
      const report = buildLaunchDenominatorReport(scope, withGap(mutate));
      assert.equal(report.decision, "NO_GO");
      assert.ok(report.blockers.includes(blocker));
    });
  }
});

test("source ADMITTED roster의 일부만 materialize해도 launch를 통과하지 않는다", () => {
  const report = buildLaunchDenominatorReport(scope, withGap((evidence) => {
    evidence.routing.admittedStationIds.pop();
    evidence.routing.materializedStationIds.pop();
  }));
  assert.equal(report.decision, "NO_GO");
  assert.ok(report.blockers.includes("ROUTING_STATION_ID_GAP"));
});

test("accessibility coverage는 required ID와 unique covered ID의 교집합으로 계산한다", async (context) => {
  await context.test("wrong IDs", () => {
    const evidence = passingEvidence();
    evidence.pilot.coveredRowIds = Array.from({ length: 6 }, (_, index) => `wrong-row-${index}`);
    const report = buildLaunchDenominatorReport(scope, evidence);
    assert.deepEqual(report.coverage.accessibility, { requiredCount: 6, coveredCount: 0, gapCount: 6 });
  });
  await context.test("duplicate ID", () => {
    const evidence = passingEvidence();
    evidence.pilot.coveredRowIds[5] = evidence.pilot.coveredRowIds[0];
    const report = buildLaunchDenominatorReport(scope, evidence);
    assert.deepEqual(report.coverage.accessibility, { requiredCount: 6, coveredCount: 5, gapCount: 1 });
  });
});

test("production routing scope는 mutable #2135 roster 대신 안정적인 launch 요구조건만 고정한다", async () => {
  const productionScope = JSON.parse(await readFile(
    path.join(import.meta.dirname, "../../apps/mobile/release/production-datapack-scope.json"),
    "utf8",
  ));
  assert.deepEqual(productionScope.routingLaunchScope.lineIds, [
    "seoul-4",
    "line-6e39be0cb6e2",
    "line-54a7b980b7c3",
  ]);
  assert.equal(productionScope.routingLaunchScope.candidateStationIds, undefined);
  assert.deepEqual(productionScope.routingLaunchScope.baseRoutingStationIds, [
    "station-sangnoksu",
    "station-sadang",
  ]);
  assert.deepEqual(productionScope.routingLaunchScope.requiredTransferStationIds, [
    "station-8aa315864466",
    "station-c0679b9a6cf8",
    "station-e5cf592cf355",
    "station-b819702fa7d9",
    "station-83bcb1eae340",
  ]);
  assert.equal(productionScope.routingLaunchScope.admittedStationEvidenceRequired, true);
  assert.equal(productionScope.routingLaunchScope.sourceDerivedConnectionEdgeEvidenceRequired, true);
  assert.equal(productionScope.routingLaunchScope.sourceDerivedConnectionEdgeIds, undefined);
  assert.equal(productionScope.routingLaunchScope.admittedStationIdsSource, undefined);
});

test("committed current report는 gap과 unavailable consumer를 숨기지 않고 NO_GO다", async () => {
  const productionScope = JSON.parse(await readFile(
    path.join(import.meta.dirname, "../../apps/mobile/release/production-datapack-scope.json"),
    "utf8",
  ));
  const report = JSON.parse(await readFile(
    path.join(import.meta.dirname, "reports/android-v1-launch-denominator-20260715.json"),
    "utf8",
  ));
  assert.deepEqual(buildLaunchDenominatorReport(productionScope, report.evaluatorInput), report);
  assert.equal(report.decision, "NO_GO");
  assert.equal(report.scopes.routingLaunchScope.id, productionScope.routingLaunchScope.id);
  assert.equal(report.scopes.routingLaunchScope.sha256, canonicalScopeHash(productionScope.routingLaunchScope));
  assert.equal(report.identityLinkage.matrixSha256, canonicalScopeHash(productionScope.identityMatrix));
  assert.deepEqual(report.coverage.accessibility, { requiredCount: 6, coveredCount: 6, gapCount: 0 });
  assert.deepEqual(report.coverage.nationwide, { requiredCount: 270, missingCount: 270, blocksV1: false });
  assert.deepEqual(report.consumerStates, { source: "MISSING", server: "UNAVAILABLE", mobile: "MISSING" });
  assert.deepEqual(report.routing.sourceDerivedConnectionEdgeIds, { status: "MISSING", ids: [] });
  assert.deepEqual(report.routing.admittedStationIds, { status: "MISSING", ids: [] });
});

test("routing region, operator, and line evidence must exactly match launch scope", async (context) => {
  const gaps = [
    ["missing region", "regionIds", (values) => values.pop(), "ROUTING_REGION_SCOPE_MISMATCH"],
    ["extra region", "regionIds", (values) => values.push("other-region"), "ROUTING_REGION_SCOPE_MISMATCH"],
    ["missing operator", "operatorIds", (values) => values.pop(), "ROUTING_OPERATOR_SCOPE_MISMATCH"],
    ["extra operator", "operatorIds", (values) => values.push("other-operator"), "ROUTING_OPERATOR_SCOPE_MISMATCH"],
    ["missing line", "lineIds", (values) => values.pop(), "ROUTING_LINE_SCOPE_MISMATCH"],
    ["extra line", "lineIds", (values) => values.push("other-line"), "ROUTING_LINE_SCOPE_MISMATCH"],
  ];
  for (const [name, field, mutate, blocker] of gaps) {
    await context.test(name, () => {
      const report = buildLaunchDenominatorReport(scope, withGap((evidence) => {
        mutate(evidence.routing[field]);
      }));
      assert.equal(report.decision, "NO_GO");
      assert.ok(report.blockers.includes(blocker));
    });
  }
});

test("source admission, freshness, and routing scope hash fail closed", async (context) => {
  const gaps = [
    ["missing source", (evidence) => { evidence.source.status = "MISSING"; }, "SOURCE_NOT_ADMITTED"],
    ["stale source", (evidence) => { evidence.source.freshness = "STALE"; }, "SOURCE_STALE"],
    ["scope hash mismatch", (evidence) => { evidence.source.routingScopeHash = "d".repeat(64); }, "ROUTING_SCOPE_HASH_MISMATCH"],
  ];
  for (const [name, mutate, blocker] of gaps) {
    await context.test(name, () => {
      const report = buildLaunchDenominatorReport(scope, withGap(mutate));
      assert.equal(report.decision, "NO_GO");
      assert.ok(report.blockers.includes(blocker));
    });
  }
});

test("out-of-scope service and fixture or legacy evidence block launch", async (context) => {
  await context.test("out-of-scope service", () => {
    const report = buildLaunchDenominatorReport(scope, withGap((evidence) => {
      evidence.routing.serviceIds.push("KTX");
    }));
    assert.equal(report.decision, "NO_GO");
    assert.ok(report.blockers.includes("ROUTING_SERVICE_SCOPE_MISMATCH"));
  });
  for (const evidenceClass of ["FIXTURE", "LEGACY", "OTHER_SERVICE"]) {
    await context.test(evidenceClass, () => {
      const report = buildLaunchDenominatorReport(scope, withGap((evidence) => {
        evidence.forbiddenEvidence.push({ evidenceClass });
      }));
      assert.equal(report.decision, "NO_GO");
      assert.ok(report.blockers.includes("FORBIDDEN_EVIDENCE_CLASS"));
    });
  }
});

test("server, mobile, shared identity, and common safety evidence fail closed", async (context) => {
  const gaps = [
    ["inactive server", (evidence) => { evidence.server.status = "INACTIVE"; }, "SERVER_NOT_ACTIVE"],
    ["server routing", (evidence) => { evidence.server.routingReady = false; }, "SERVER_ROUTING_NOT_READY"],
    ["mobile status", (evidence) => { evidence.mobile.status = "MISSING"; }, "MOBILE_NOT_READY"],
    ["mobile topology", (evidence) => { evidence.mobile.topologyReady = false; }, "MOBILE_TOPOLOGY_NOT_READY"],
    ["identity", (evidence) => { evidence.mobile.identity.lineageId = "other-lineage"; }, "IDENTITY_FIELD_MISMATCH:lineageId"],
    ["signature", (evidence) => { evidence.safety.signatureValid = false; }, "SIGNATURE_INVALID"],
    ["rollback", (evidence) => { evidence.safety.rollbackVerified = false; }, "ROLLBACK_UNVERIFIED"],
    ["freshness", (evidence) => { evidence.safety.freshness = "STALE"; }, "EVIDENCE_STALE"],
    ["lineage", (evidence) => { evidence.safety.lineage = "MISMATCH"; }, "LINEAGE_UNVERIFIED"],
    ["claim", (evidence) => { evidence.claims.routingScopeId = "other-scope"; }, "CLAIM_SCOPE_MISMATCH"],
  ];
  for (const [name, mutate, blocker] of gaps) {
    await context.test(name, () => {
      const report = buildLaunchDenominatorReport(scope, withGap(mutate));
      assert.equal(report.decision, "NO_GO");
      assert.ok(report.blockers.includes(blocker));
    });
  }
});

test("shared identity fields reject empty values and wrong types", async (context) => {
  const invalidValues = [
    ["canonicalStationVersion", ""],
    ["canonicalStationVersion", 1],
    ["corridorId", "   "],
    ["corridorId", false],
    ["serviceId", ""],
    ["serviceId", 1],
    ["lineageId", "\t"],
    ["lineageId", []],
    ["schemaVersion", ""],
    ["schemaVersion", "1"],
    ["schemaVersion", 0],
    ["schemaVersion", 1.5],
    ["schemaVersion", Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [field, invalidValue] of invalidValues) {
    await context.test(`${field}: ${JSON.stringify(invalidValue)}`, () => {
      const evidence = passingEvidence();
      for (const consumer of ["source", "server", "mobile"]) {
        evidence[consumer].identity[field] = invalidValue;
      }
      const report = buildLaunchDenominatorReport(scope, evidence);
      assert.equal(report.decision, "NO_GO");
      assert.ok(report.blockers.includes(`IDENTITY_FIELD_INVALID:${field}`));
    });
  }

  await context.test("invalid value also preserves mismatch blocker", () => {
    const evidence = passingEvidence();
    evidence.mobile.identity.serviceId = "";
    const report = buildLaunchDenominatorReport(scope, evidence);
    assert.ok(report.blockers.includes("IDENTITY_FIELD_INVALID:serviceId"));
    assert.ok(report.blockers.includes("IDENTITY_FIELD_MISMATCH:serviceId"));
  });

  await context.test("validation does not normalize original values before equality", () => {
    const evidence = passingEvidence();
    evidence.mobile.identity.corridorId = ` ${evidence.mobile.identity.corridorId} `;
    const report = buildLaunchDenominatorReport(scope, evidence);
    assert.equal(report.blockers.includes("IDENTITY_FIELD_INVALID:corridorId"), false);
    assert.ok(report.blockers.includes("IDENTITY_FIELD_MISMATCH:corridorId"));
  });
});

test("identity matrix must declare every required shared field", async (context) => {
  const requiredFields = [
    "canonicalStationVersion",
    "corridorId",
    "serviceId",
    "lineageId",
    "schemaVersion",
  ];
  const invalidMatrices = [
    ["missing matrix", undefined],
    ["empty fields", { requiredSharedFields: [], differentArtifactHashesAllowed: true }],
    ...requiredFields.map((missingField) => [
      `missing ${missingField}`,
      {
        requiredSharedFields: requiredFields.filter((field) => field !== missingField),
        differentArtifactHashesAllowed: true,
      },
    ]),
  ];
  for (const [name, identityMatrix] of invalidMatrices) {
    await context.test(name, () => {
      const invalidScope = structuredClone(scope);
      if (identityMatrix === undefined) delete invalidScope.identityMatrix;
      else invalidScope.identityMatrix = identityMatrix;
      const report = buildLaunchDenominatorReport(invalidScope, passingEvidence());
      assert.equal(report.decision, "NO_GO");
      assert.ok(report.blockers.includes("IDENTITY_MATRIX_CONTRACT_INVALID"));
    });
  }
});

test("forbidden evidence scan requires an explicit verified empty result", async (context) => {
  const gaps = [
    ["missing array", (evidence) => { delete evidence.forbiddenEvidence; }],
    ["missing status", (evidence) => { delete evidence.forbiddenEvidenceStatus; }],
    ["incomplete status", (evidence) => { evidence.forbiddenEvidenceStatus = "PENDING"; }],
  ];
  for (const [name, mutate] of gaps) {
    await context.test(name, () => {
      const report = buildLaunchDenominatorReport(scope, withGap(mutate));
      assert.equal(report.decision, "NO_GO");
      assert.ok(report.blockers.includes("FORBIDDEN_EVIDENCE_UNVERIFIED"));
    });
  }
});

test("different source, server, and mobile artifact hashes are allowed when shared identity matches", () => {
  const report = buildLaunchDenominatorReport(scope, passingEvidence());
  assert.equal(report.decision, "GO");
  assert.equal(report.identityLinkage.compatible, true);
  assert.deepEqual(report.identityLinkage.artifactHashes, {
    source: "a".repeat(64),
    server: "b".repeat(64),
    mobile: "c".repeat(64),
  });
});

test("nationwide progress does not change the routing launch scope hash", () => {
  const before = structuredClone(scope);
  const after = structuredClone(scope);
  before.nationwideRoadmapScope.missingCount = 270;
  after.nationwideRoadmapScope.missingCount = 0;
  assert.equal(
    canonicalScopeHash(before.routingLaunchScope),
    canonicalScopeHash(after.routingLaunchScope),
  );
});

test("candidate binding and authoritative evidence hashes fail closed", async (context) => {
  await context.test("missing binding", () => {
    const evidence = passingEvidence();
    delete evidence.candidateBinding;
    const report = buildLaunchDenominatorReport(scope, evidence);
    assert.equal(report.decision, "NO_GO");
    assert.ok(report.blockers.includes("CANDIDATE_BINDING_INVALID"));
  });
  await context.test("consumer evidence hash mismatch", () => {
    const evidence = passingEvidence();
    evidence.candidateBinding.serverEvidence.sha256 = "f".repeat(64);
    const report = buildLaunchDenominatorReport(scope, evidence);
    assert.equal(report.decision, "NO_GO");
    assert.ok(report.blockers.includes("CANDIDATE_EVIDENCE_HASH_MISMATCH:server"));
  });
  await context.test("stale consumer evidence", () => {
    const evidence = passingEvidence();
    evidence.candidateBinding.mobileEvidence.status = "STALE";
    const report = buildLaunchDenominatorReport(scope, evidence);
    assert.equal(report.decision, "NO_GO");
    assert.ok(report.blockers.includes("CANDIDATE_EVIDENCE_NOT_FRESH:mobile"));
  });
});

test("malformed scope subsections produce explicit contract blockers without throwing", async (context) => {
  for (const subsection of [
    "verifiedAccessibilityScope",
    "routingLaunchScope",
    "nationwideRoadmapScope",
    "identityMatrix",
  ]) {
    for (const [label, malformed] of [["missing", null], ["empty", {}]]) {
      await context.test(`${subsection} ${label}`, () => {
        const malformedScope = structuredClone(scope);
        malformedScope[subsection] = malformed;
        const report = buildLaunchDenominatorReport(malformedScope, passingEvidence());
        assert.equal(report.decision, "NO_GO");
        assert.ok(report.blockers.includes(`SCOPE_CONTRACT_INVALID:${subsection}`));
        if (malformed === null) assert.equal(report.scopes[subsection]?.sha256 ?? null, null);
      });
    }
  }
});

test("canonicalScopeHash는 로케일 콜레이션과 무관하게 코드포인트 정렬로 고정된다 (#2390)", () => {
  // 이 fixture의 배열은 대소문자가 섞여 있어 로케일 콜레이션과 코드포인트 정렬이 서로 다른 순서를 낸다:
  //   코드포인트(고정): ["A","B","C","a","b"] (대문자 U+0041~ 가 소문자 U+0061~ 앞)
  //   ICU 콜레이션(en/ko 등): ["a","A","b","B","C"] (대소문자 tertiary)
  // "a" vs "B"만 봐도 en localeCompare는 a<B, 코드포인트는 B<a로 갈린다.
  const fixtureScope = { values: ["a", "B", "C", "b", "A"] };
  // 아래 상수는 코드포인트 정렬로 산출해 하드코딩했다. 이 상수가 흔들리면 canonicalization이
  // 환경(로케일) 의존으로 회귀한 것이다 — localeCompare 복귀를 즉시 실패시키는 게이트다.
  assert.equal(
    canonicalScopeHash(fixtureScope),
    "d9043362dbb747ebaa5969c0862f3e6a755db54bf578e92670e351d86868fc28",
  );
});

test("incompatible shared identity values are null in report output", () => {
  const evidence = passingEvidence();
  evidence.mobile.identity.corridorId = "other-corridor";
  const report = buildLaunchDenominatorReport(scope, evidence);
  assert.equal(report.identityLinkage.compatible, false);
  assert.deepEqual(report.identityLinkage.shared, {
    canonicalStationVersion: null,
    corridorId: null,
    serviceId: null,
    lineageId: null,
    schemaVersion: null,
  });
});
