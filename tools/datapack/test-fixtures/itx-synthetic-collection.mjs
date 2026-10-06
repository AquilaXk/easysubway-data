// #979: 다음 주 ITX 수집을 합성한다. 현재 승인 원천·완전성 증거의 날짜를 7일(요일 유지) 뒤로 옮기고 해시를 다시 맞춘 뒤,
// 실제 후보 생성기(buildItxSourceCandidate)로 후보를 만든다. 실제 공급자 호출 없이 승격 → 재결속 전 구간을 돌려 보는 시뮬레이션과 테스트가 쓴다.
// 합성 capture·replay는 게이트 결속 검사에 필요한 최소 형태다(공급자 응답은 비어 있다).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildItxSourceCandidate } from "../collect-korail-itx-cheongchun-timetable.mjs";
import { emitStationCatalogPack } from "../emit-station-catalog-pack.mjs";
import { createProviderResponseRecorder, providerResponseCaptureBytes } from "../provider-response-capture.mjs";

const DAY_MS = 86_400_000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function shiftIsoDate(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

export async function synthesizeNextItxCollection({ repositoryRoot, outputDirectory, shiftDays = 7 }) {
  if (shiftDays % 7 !== 0 || shiftDays <= 0) throw new Error("shiftDays must be a positive multiple of 7 to keep weekday identities");
  const contract = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const reference = contract.sourceTimetableArtifact;
  let text = await readFile(path.join(repositoryRoot, reference.completenessEvidencePath), "utf8");
  const completeness = JSON.parse(text);
  const observedShifted = new Date(Date.parse(completeness.observedAt) + shiftDays * DAY_MS);
  const observedAt = observedShifted.toISOString();
  const artifactId = `itx-cheongchun-source-timetable-${observedAt.replace(/\D/g, "")}`;
  // 날짜 문자열을 모두 같은 일수만큼 옮긴다(ISO 날짜, 따옴표로 둘러싼 YYYYMMDD 운행일, 수집 시각 stamp).
  text = text.replaceAll(/20\d\d-\d\d-\d\d/g, (date) => shiftIsoDate(date, shiftDays));
  text = text.replaceAll(/"(20\d\d)(\d\d)(\d\d)"/g, (_, year, month, day) => `"${shiftIsoDate(`${year}-${month}-${day}`, shiftDays).replaceAll("-", "")}"`);
  text = text.replaceAll(reference.artifactId, artifactId);
  const next = JSON.parse(text);
  next.observedAt = observedAt;
  for (const day of next.serviceDays ?? []) {
    if (day.roster) day.roster.observedAt = observedAt;
    if (day.timetable) day.timetable.observedAt = observedAt;
  }
  next.sourceTimetableArtifact.artifactId = artifactId;
  next.snapshotDiff.previousArtifactSha256 = reference.sha256;
  delete next.evidenceHash;
  next.evidenceHash = sha256(JSON.stringify(next));

  await mkdir(outputDirectory, { recursive: true });
  const stationCatalogPackPath = path.join(outputDirectory, "station-catalog-pack");
  await emitStationCatalogPack({ repositoryRoot, output: stationCatalogPackPath, catalogPackId: "itx-current-station-catalog-v1" });
  const catalog = JSON.parse(await readFile(path.join(stationCatalogPackPath, "manifest.json"), "utf8"));
  const now = observedShifted;
  // 후보 생성기는 완전성 증거의 station catalog 식별이 팩과 같아야 한다. 같은 입력에서 만든 팩이라 같지만 manifest sha는 팩 바이트에서 다시 계산한다.
  const manifestSha256 = sha256(await readFile(path.join(stationCatalogPackPath, "manifest.json")));
  next.stationCatalogPackIdentity = {
    artifactKind: "station-catalog-pack",
    manifestVersion: 1,
    catalogPackId: catalog.catalogPackId,
    stationSetSha256: catalog.stationSetSha256,
    payloadSha256: catalog.payloadSha256,
    manifestSha256,
  };
  delete next.evidenceHash;
  next.evidenceHash = sha256(JSON.stringify(next));
  const completenessBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  const candidate = await buildItxSourceCandidate({ completeness: next, stationCatalogPackPath, now, repositoryRoot });
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);

  const recorder = createProviderResponseRecorder({
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    observedAt,
    selectedServiceDates: next.selectedServiceDates,
  });
  await recorder.fetchImpl("https://apis.data.go.kr/B551457/run/v2/travelerTrainRunPlan2?serviceKey=SYNTHETIC&pageNo=1");
  const replay = { ...next, validationMode: "REPLAY", admissionStatus: "REPLAY_ONLY" };
  delete replay.evidenceHash;
  replay.evidenceHash = sha256(JSON.stringify(replay));
  const files = {
    candidatePath: path.join(outputDirectory, "itx-result.json"),
    completenessPath: path.join(outputDirectory, "itx-completeness.json"),
    capturePath: path.join(outputDirectory, "provider-response-capture.json"),
    replayEvidencePath: path.join(outputDirectory, "itx-replay.json"),
    stationCatalogPackPath,
  };
  await writeFile(files.candidatePath, candidateBytes);
  await writeFile(files.completenessPath, completenessBytes);
  await writeFile(files.capturePath, providerResponseCaptureBytes(recorder.captureArtifact()));
  await writeFile(files.replayEvidencePath, `${JSON.stringify(replay, null, 2)}\n`);
  return { ...files, artifactId, observedAt, now, candidate };
}
