import { createProviderResponseRecorder, providerResponseCaptureBytes } from "../../datapack/provider-response-capture.mjs";
import { buildZip } from "./zip-archive.mjs";

const SERVICE_DATES = Object.freeze({ "7": "20261017", "8": "20261019", "9": "20261018" });
const REQUEST_URL = (index) => `https://apis.data.go.kr/1613000/TrainInfo/GetStrtpntAlocFndTrainInfo?serviceKey=synthetic-key&_type=json&pageNo=${index}`;

/** 공급자 요청 requestCount건을 실제 recorder로 기록한 capture 바이트. 마지막 transportFailures건은 전송 실패로 기록한다. */
export async function captureBytes({ requestCount, transportFailures = 0 }) {
  const recorder = createProviderResponseRecorder({
    observedAt: "2026-10-16T18:00:58.277Z",
    selectedServiceDates: SERVICE_DATES,
    fetchImpl: async (url) => {
      if (Number(new URL(url).searchParams.get("pageNo")) > requestCount - transportFailures) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ response: { header: { resultCode: "99" } } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  for (let index = 1; index <= requestCount; index += 1) {
    await recorder.fetchImpl(REQUEST_URL(index)).catch(() => {});
  }
  return providerResponseCaptureBytes(recorder.captureArtifact());
}

/** itx-current-promotion 실패 run이 올리는 artifact ZIP(freshness.json·itx-result.json·provider-response-capture.json). */
export async function failedRunArtifactZip({ requestCount, transportFailures = 0 }) {
  return buildZip([
    { name: "freshness.json", data: `${JSON.stringify({ schemaVersion: 1, artifactKind: "itx-admission-service-dates", timezone: "Asia/Seoul", serviceDates: SERVICE_DATES })}\n` },
    { name: "itx-result.json", data: "{}\n" },
    { name: "provider-response-capture.json", data: await captureBytes({ requestCount, transportFailures }) },
  ], { dataDescriptor: true });
}

/** KASI 휴일 조회가 실패해 공급자(TAGO)를 부르기 전에 끝난 run의 artifact. capture는 없고 freshness.json이 실패 영수증이다. */
export function kasiFailureArtifactZip() {
  const receipt = { schemaVersion: 1, artifactKind: "itx-current-collection-preflight", status: "FAILED", operation: "KASI_PUBLIC_HOLIDAY_CALENDAR", failureCategory: "KASI_HTTP", attemptCount: 6 };
  return buildZip([{ name: "freshness.json", data: `${JSON.stringify(receipt, null, 2)}\n` }], { dataDescriptor: true });
}
