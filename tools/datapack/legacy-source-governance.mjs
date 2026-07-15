import { createHash } from "node:crypto";

const GOVERNANCE_POLICY_VERSION = "2026-07-15";
const GOVERNANCE_POLICY_SHA256 = "ebc469886bbc11af62629d2d55129e2d27bdcabec300dcc268bb73d546fe2128";
const approvedLegacySnapshotHashes = new Map([
  ["molit-urban-rail-full-route-capital-admission-20260712", "3f676f7ffd29b1a1b5872d65c9926284ba6c88f9a64e00d31323c8617131f452"],
  ["seoulmetro-station-line-info-capital-admission-20260712", "8a171105588371f087f8ee58e2c207c0ed1a32dc6b459aa0427d7262ad393e07"],
  ["seoulmetro-cyberstation-route-map-capital-admission-20260712", "ae9d8e6b2f188418d9c1ee0fda785d9fd3665b771eafdd3c5e15ef0b34f957b4"],
  ["kric-station-elevator-capital-admission-20260712", "c1351b184a737276d3dcc914e3db5df7d9e5c7ff82326cd5fbadbe6da2eba097"],
  ["kric-station-elevator-movement-capital-admission-20260712", "0bf00ab2ad3505dc0ade0c5d42d7500fe5891e6f9a961502323e387a3474980c"],
  ["kric-station-escalator-capital-admission-20260712", "7e2047e4cd54fe6c1aba05a3880537851159bd6a59a0a89e75c737bec3706df5"],
  ["kric-wheelchair-lift-location-capital-admission-20260712", "5e8639bfa85a3113362ebb413bc8ef9ca9b282deddde4f7c08d562959d26cd8e"],
  ["kric-wheelchair-lift-movement-capital-admission-20260712", "07fb9337abf08aa4b08c845989552c1c076a7b32c9698431edcee4c8490c77a0"],
  ["seoul-metro-accessibility-capital-admission-20260712", "4e9ba33455d89b68e6e9e0708c07fa2ab2aaa31bb7fe8b5c3930cfe71a315340"],
  ["kric-subway-timetable-line4-pilot-20260709", "09323a9ebd2f7398c0baf18fb40100936790e571ce1ae00d6e8aae9f044ad80a"],
]);

export function approvedLegacyGovernanceBinding(snapshot) {
  const expectedHash = approvedLegacySnapshotHashes.get(snapshot?.snapshotId);
  if (expectedHash == null || sha256(JSON.stringify(snapshot)) !== expectedHash) return null;
  return {
    governancePolicyVersion: GOVERNANCE_POLICY_VERSION,
    governancePolicySha256: GOVERNANCE_POLICY_SHA256,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
