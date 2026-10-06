// #979: 다음 주 ITX 수집을 합성한다. 현재 승인 원천·완전성 증거의 날짜를 7일(요일 유지) 뒤로 옮기고 해시를 다시 맞춘 뒤,
// 실제 후보 생성기(buildItxSourceCandidate)로 후보를 만든다. 실제 공급자 호출 없이 승격 → 재결속 전 구간을 돌려 보는 시뮬레이션과 테스트가 쓴다.
// 합성 capture·replay는 게이트 결속 검사에 필요한 최소 형태다(공급자 응답은 비어 있다).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildItxSourceCandidate, evaluateItxSnapshotAnomaly } from "../collect-korail-itx-cheongchun-timetable.mjs";
import { emitStationCatalogPack } from "../emit-station-catalog-pack.mjs";
import { createProviderResponseRecorder, providerResponseCaptureBytes } from "../provider-response-capture.mjs";

const DAY_MS = 86_400_000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function shiftIsoDate(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

// 한 시나리오가 바꾼 정차역(이름)을 돌려주기 위한 값. 호출 간 공유하지 않도록 함수 안에서 선언한다.
export async function synthesizeNextItxCollection({ repositoryRoot, outputDirectory, shiftDays = 7, observedAtOverride = null, topologyChange = null }) {
  if (shiftDays % 7 !== 0 || shiftDays <= 0) throw new Error("shiftDays must be a positive multiple of 7 to keep weekday identities");
  const contract = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const reference = contract.sourceTimetableArtifact;
  let topologyChangeSummary = null;
  let text = await readFile(path.join(repositoryRoot, reference.completenessEvidencePath), "utf8");
  const completeness = JSON.parse(text);
  // observedAtOverride: 운행일은 shiftDays만큼 옮기되 수집 시각은 이 시각으로 둔다(다른 원천의 신선도 시계와 맞춘 시뮬레이션용).
  const observedShifted = new Date(observedAtOverride ?? Date.parse(completeness.observedAt) + shiftDays * DAY_MS);
  const observedAt = observedShifted.toISOString();
  const artifactId = `itx-cheongchun-source-timetable-${observedAt.replace(/\D/g, "")}`;
  // 날짜 문자열을 모두 같은 일수만큼 옮긴다(ISO 날짜, 따옴표로 둘러싼 YYYYMMDD 운행일, 수집 시각 stamp).
  text = text.replaceAll(/20\d\d-\d\d-\d\d/g, (date) => shiftIsoDate(date, shiftDays));
  text = text.replaceAll(/"(20\d\d)(\d\d)(\d\d)"/g, (_, year, month, day) => {
    const shifted = shiftIsoDate([year, month, day].join("-"), shiftDays).replaceAll("-", "");
    return `"${shifted}"`;
  });
  text = text.replaceAll(reference.artifactId, artifactId);
  const next = JSON.parse(text);
  next.observedAt = observedAt;
  for (const day of next.serviceDays ?? []) {
    if (day.roster) day.roster.observedAt = observedAt;
    if (day.timetable) day.timetable.observedAt = observedAt;
  }
  next.sourceTimetableArtifact.artifactId = artifactId;
  next.snapshotDiff.previousArtifactSha256 = reference.sha256;
  if (topologyChange !== null) {
    // 운행역이 바뀐 수집은 자동 게이트가 막고(역·정차 순서 한도 0) 사람 승인 경로로만 승격된다. 변경 요약(snapshotDiff)과 상태를 실제 판정 함수로 다시 계산한다.
    const changedStop = applyTopologyChange(next, topologyChange);
    const previousSource = JSON.parse(await readFile(path.join(repositoryRoot, reference.artifactPath), "utf8"));
    next.snapshotDiff = evaluateItxSnapshotAnomaly({ serviceDays: next.serviceDays, previousArtifact: previousSource });
    // 직전 원천의 식별은 contract가 가리키는 원천 파일 sha256이다(원천 파일에는 자기 sha가 없다).
    next.snapshotDiff.previousArtifactSha256 = reference.sha256;
    next.admissionStatus = next.snapshotDiff.status;
    next.sourceTimetableArtifact.status = next.snapshotDiff.status;
    if (next.snapshotDiff.status === "CHANGE_REVIEW_REQUIRED") {
      next.failureStage = "SNAPSHOT_DIFF";
      next.failureReasonCode = "SNAPSHOT_ANOMALY_BLOCKED";
    }
    topologyChangeSummary = changedStop;
  }
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
  return { ...files, artifactId, observedAt, now, candidate, topologyChangeSummary };
}

const clockText = (seconds) => [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");

function renumber(day) {
  // 정차 목록이 바뀐 열차의 파생 필드(정차 순번·OD 수·정차 수)와 transitStopTimes를 같은 정차 목록에서 다시 만든다.
  const { timetable } = day;
  for (const sequence of timetable.stationSequences) {
    sequence.stops.forEach((stop, index) => { stop.stopSequence = index + 1; });
    sequence.stopCount = sequence.stops.length;
    sequence.observedOdCount = (sequence.stops.length * (sequence.stops.length - 1)) / 2;
  }
  const rowsByTrip = new Map();
  for (const sequence of timetable.stationSequences) {
    const tripId = `route-${timetable.canonicalLineId}-${sequence.directionId}-${sequence.trainNumber}-${day.dayCd}`;
    rowsByTrip.set(tripId, sequence.stops.map((stop, index) => ({
      tripId, stopSequence: index + 1, stationId: stop.stationId, lineId: stop.lineId,
      arrivalSeconds: stop.arrivalSeconds, departureSeconds: stop.departureSeconds,
    })));
  }
  timetable.transitStopTimes = timetable.transitStopTimes
    .map((row) => row.tripId)
    .filter((tripId, index, all) => all.indexOf(tripId) === index)
    .flatMap((tripId) => rowsByTrip.get(tripId));
  const stopCount = timetable.stationSequences.reduce((total, sequence) => total + sequence.stops.length, 0);
  timetable.reconstructionSummary.stopCount = stopCount;
  day.reconstructionSummary.stopCount = stopCount;
  const { evidenceHash: _previous, ...rest } = timetable;
  timetable.evidenceHash = sha256(JSON.stringify(rest));
}

/**
 * 합성 수집의 정차역 하나를 바꾼다.
 * - "remove-served-station": 어느 열차에서도 기점·종점이 아닌 운행역 하나를 모든 열차에서 뺀다.
 * - "add-served-station": 어느 열차도 서지 않던 로스터 역 하나를, 그 역을 건너뛰는 모든 열차에 시각을 끼워 넣어 정차시킨다.
 * 바뀐 역의 이름과 방식을 돌려준다.
 */
function applyTopologyChange(completeness, change) {
  const days = completeness.serviceDays;
  const roster = days[0].roster.stations;
  const served = new Set();
  const endpoints = new Set();
  for (const day of days) {
    for (const sequence of day.timetable.stationSequences) {
      sequence.stops.forEach((stop, index) => {
        served.add(stop.stationId);
        if (index === 0 || index === sequence.stops.length - 1) endpoints.add(stop.stationId);
      });
    }
  }
  if (change === "remove-served-station") {
    const target = roster.find((station) => served.has(station.canonicalStationId) && !endpoints.has(station.canonicalStationId));
    if (!target) throw new Error("no removable interior served station");
    for (const day of days) {
      for (const sequence of day.timetable.stationSequences) {
        sequence.stops = sequence.stops.filter((stop) => stop.stationId !== target.canonicalStationId);
      }
      renumber(day);
    }
    return { change, nameKo: target.nameKo, stationId: target.canonicalStationId };
  }
  if (change === "add-served-station") {
    for (const target of roster.filter((station) => !served.has(station.canonicalStationId))) {
      let inserted = 0;
      for (const day of days) {
        for (const sequence of day.timetable.stationSequences) {
          const index = sequence.stops.findIndex((stop, position) => {
            const next = sequence.stops[position + 1];
            if (!next) return false;
            const low = Math.min(stop.corridorSequence, next.corridorSequence);
            const high = Math.max(stop.corridorSequence, next.corridorSequence);
            return target.corridorSequence > low && target.corridorSequence < high;
          });
          if (index < 0) continue;
          const previous = sequence.stops[index];
          const following = sequence.stops[index + 1];
          const arrival = Math.min(previous.departureSeconds + 60, following.arrivalSeconds);
          const datePart = previous.departureAt.slice(0, 10);
          sequence.stops.splice(index + 1, 0, {
            stationId: target.canonicalStationId, nameKo: target.nameKo, corridorSequence: target.corridorSequence, lineId: target.lineId,
            arrivalAt: `${datePart}T${clockText(arrival)}+09:00`, departureAt: `${datePart}T${clockText(arrival)}+09:00`,
            arrivalSeconds: arrival, departureSeconds: arrival, stopSequence: 0,
          });
          inserted += 1;
        }
      }
      if (inserted === 0) continue;
      for (const day of days) renumber(day);
      return { change, nameKo: target.nameKo, stationId: target.canonicalStationId };
    }
    throw new Error("no unserved roster station sits inside a train gap");
  }
  throw new Error(`unknown topology change: ${change}`);
}
