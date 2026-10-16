import assert from "node:assert/strict";
import test from "node:test";

import { readCollectionRequestCount } from "./itx-collection-evidence.mjs";
import { buildZip } from "./test-fixtures/zip-archive.mjs";
import { captureBytes, failedRunArtifactZip, kasiFailureArtifactZip } from "./test-fixtures/itx-failed-run-artifact.mjs";

const REPOSITORY = "AquilaXk/easysubway-data";
const RUN_ID = 38943966334;
const ARTIFACT_NAME = `itx-current-promotion-${RUN_ID}`;
const TOKEN = "synthetic-github-token-that-must-not-leak";

function artifactFetch({ listing, zip, zipStatus = 200 }) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const request = new URL(url);
    if (request.pathname === `/repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts`) {
      return listing instanceof Error ? Promise.reject(listing) : Response.json(listing);
    }
    if (request.pathname === `/repos/${REPOSITORY}/actions/artifacts/12068711082/zip`) return new Response(zip, { status: zipStatus });
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls };
}
const liveListing = { total_count: 1, artifacts: [{ id: 12068711082, name: ARTIFACT_NAME, expired: false }] };
const read = (fetchImpl, overrides = {}) => readCollectionRequestCount({ repository: REPOSITORY, runId: RUN_ID, artifactName: ARTIFACT_NAME, token: TOKEN, fetchImpl, ...overrides });

test("실패 run artifact의 provider-response-capture requestCount를 읽는다 (전송 실패 포함)", async () => {
  const { fetchImpl, calls } = artifactFetch({ listing: liveListing, zip: await failedRunArtifactZip({ requestCount: 810, transportFailures: 3 }) });
  assert.equal(await read(fetchImpl), 810);
  assert.equal(calls.length, 2);
  const listing = new URL(calls[0].url);
  assert.equal(listing.searchParams.get("name"), ARTIFACT_NAME);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[1].options.redirect, "follow");
  assert.equal(calls[1].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.doesNotMatch(calls.map(({ url }) => url).join("\n"), /synthetic-github-token/u);
});

test("capture가 없고 freshness.json이 KASI 휴일 조회 실패 영수증이면 공급자를 부르지 않았으므로 0건이다", async () => {
  const { fetchImpl } = artifactFetch({ listing: liveListing, zip: kasiFailureArtifactZip() });
  assert.equal(await read(fetchImpl), 0);
});

test("증거를 읽지 못하면 추정하지 않고 null이다 (판정 단계가 fail-closed한다)", async () => {
  const goodZip = await failedRunArtifactZip({ requestCount: 5 });
  const cases = {
    "artifact 없음": artifactFetch({ listing: { total_count: 0, artifacts: [] }, zip: goodZip }),
    "artifact 만료": artifactFetch({ listing: { total_count: 1, artifacts: [{ id: 12068711082, name: ARTIFACT_NAME, expired: true }] }, zip: goodZip }),
    "같은 이름 artifact 둘": artifactFetch({ listing: { total_count: 2, artifacts: [{ id: 12068711082, name: ARTIFACT_NAME, expired: false }, { id: 2, name: ARTIFACT_NAME, expired: false }] }, zip: goodZip }),
    "다른 이름 artifact": artifactFetch({ listing: { total_count: 1, artifacts: [{ id: 12068711082, name: "other", expired: false }] }, zip: goodZip }),
    "목록 조회 오류": artifactFetch({ listing: new TypeError("fetch failed"), zip: goodZip }),
    "zip 내려받기 오류": artifactFetch({ listing: liveListing, zip: "no", zipStatus: 500 }),
    "zip 손상": artifactFetch({ listing: liveListing, zip: Buffer.from("not a zip") }),
    "capture와 영수증이 모두 없음": artifactFetch({ listing: liveListing, zip: buildZip([{ name: "itx-result.json", data: "{}\n" }]) }),
    "capture 무결성 불일치": artifactFetch({ listing: liveListing, zip: buildZip([{ name: "provider-response-capture.json", data: (await captureBytes({ requestCount: 2 })).toString("utf8").replace('"requestCount": 2', '"requestCount": 1') }]) }),
    "정상 수집의 freshness.json은 실패 영수증이 아님": artifactFetch({ listing: liveListing, zip: buildZip([{ name: "freshness.json", data: JSON.stringify({ schemaVersion: 1, artifactKind: "itx-admission-service-dates", serviceDates: {} }) }]) }),
    "다른 연산의 실패 영수증": artifactFetch({ listing: liveListing, zip: buildZip([{ name: "freshness.json", data: JSON.stringify({ artifactKind: "itx-current-collection-preflight", status: "FAILED", operation: "KST_PROVIDER_ENTRY_QUOTA" }) }]) }),
  };
  for (const [name, { fetchImpl }] of Object.entries(cases)) assert.equal(await read(fetchImpl), null, name);
});

test("artifact 이름이 없는 workflow(topology 갱신)는 요청 없이 null이다", async () => {
  const { fetchImpl, calls } = artifactFetch({ listing: liveListing, zip: await failedRunArtifactZip({ requestCount: 5 }) });
  assert.equal(await read(fetchImpl, { artifactName: null }), null);
  assert.equal(calls.length, 0);
});
