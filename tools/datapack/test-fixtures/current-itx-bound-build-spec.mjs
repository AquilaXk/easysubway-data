// #979: 커밋된 build spec의 ITX pin(coverage contract sha·버전 증거 경로·sha)은 게시된(OCI) 후보 입력을 가리키므로 ITX 승격 PR에서는
// 작업 트리의 현재 승인 원천과 다를 수 있다(병합 뒤 전국 후보 준비가 다시 묶는다). 작업 트리의 원천을 읽는 검사는 이 helper로 pin을
// 현재 contract·버전 증거 기준으로 다시 계산한 사본을 쓴다. 커밋된 spec 파일은 건드리지 않는다.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function bindBuildSpecToCurrentItx(buildSpec, repositoryRoot) {
  const contractBytes = await readFile(path.join(repositoryRoot, "tools/datapack/itx-cheongchun-coverage-contract.json"));
  const { artifactId } = JSON.parse(contractBytes).sourceTimetableArtifact;
  const evidencePath = `tools/datapack/itx-cheongchun-topology-evidence-${artifactId.slice("itx-cheongchun-source-timetable-".length)}.json`;
  const spec = structuredClone(buildSpec);
  spec.networkEdgeEvidence.itxCoverageContract.sha256 = sha256(contractBytes);
  spec.itxTopologyEvidencePath = evidencePath;
  spec.itxTopologyEvidenceSha256 = sha256(await readFile(path.join(repositoryRoot, evidencePath)));
  return spec;
}
