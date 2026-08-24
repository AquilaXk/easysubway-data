const V2 = "seoul-public-latlon-line-order-layout-v2";
const fail = (code) => { throw new Error(`V2_${code}`); };

// This is deliberately additive: predecessor lineage, CAS and OCI receipt
// validation remain owned by the caller and must already have passed.
export function requirePublicStaticNetworkV2Admission({ positions, positionSource } = {}) {
  const layout = positions?.routeMapLayoutEvidence;
  const artifact = positions?.routeMapLayoutArtifact;
  const admission = positionSource?.routeMapAdmissionEvidence?.currentLayoutAdmission;
  if (!layout || !artifact || !admission
    || layout.layoutAlgorithmVersion !== V2
    || artifact.layoutAlgorithmVersion !== V2
    || admission.layoutAlgorithmVersion !== V2) fail("MISSING");
  return { layout, admission };
}
