import assert from "node:assert/strict";
import { access, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { readCollectionRequestCount } from "./itx-collection-evidence.mjs";
import { captureBytes, writeFailedRunArtifact, writeKasiFailureArtifact } from "./test-fixtures/itx-failed-run-artifact.mjs";

const REPOSITORY = "AquilaXk/easysubway-data";
const RUN_ID = 38943966334;
const ARTIFACT_NAME = `itx-current-promotion-${RUN_ID}`;
const TOKEN = "synthetic-github-token-that-must-not-leak";

/** gh run download를 대신해 directory에 artifact 파일을 쓰는 가짜. 호출 인자를 기록한다. */
function downloader(populate) {
  const calls = [];
  const downloadArtifact = async (args) => {
    calls.push(args);
    await populate(args.directory);
  };
  return { downloadArtifact, calls };
}
const read = (downloadArtifact, overrides = {}) => readCollectionRequestCount({ repository: REPOSITORY, runId: RUN_ID, artifactName: ARTIFACT_NAME, token: TOKEN, downloadArtifact, ...overrides });

test("실패 run artifact의 provider-response-capture requestCount를 읽는다 (전송 실패 포함)하고 임시 디렉터리를 지운다", async () => {
  const { downloadArtifact, calls } = downloader((directory) => writeFailedRunArtifact(directory, { requestCount: 810, transportFailures: 3 }));
  assert.equal(await read(downloadArtifact), 810);
  assert.equal(calls.length, 1);
  assert.deepEqual({ repository: calls[0].repository, runId: calls[0].runId, artifactName: calls[0].artifactName, token: calls[0].token }, { repository: REPOSITORY, runId: RUN_ID, artifactName: ARTIFACT_NAME, token: TOKEN });
  await assert.rejects(() => access(calls[0].directory), { code: "ENOENT" });
});

test("capture가 없고 freshness.json이 KASI 휴일 조회 실패 영수증이면 공급자를 부르지 않았으므로 0건이다", async () => {
  const { downloadArtifact } = downloader(writeKasiFailureArtifact);
  assert.equal(await read(downloadArtifact), 0);
});

test("증거를 읽지 못하면 추정하지 않고 null이다 (판정 단계가 fail-closed한다)", async () => {
  const receipt = (value) => (directory) => writeFile(path.join(directory, "freshness.json"), JSON.stringify(value));
  const cases = {
    "artifact 없음·만료(내려받기 실패)": async () => { throw new Error("no artifact"); },
    "빈 artifact": async () => {},
    "capture 손상": (directory) => writeFile(path.join(directory, "provider-response-capture.json"), "not json"),
    "capture 무결성 불일치": async (directory) => writeFile(path.join(directory, "provider-response-capture.json"), (await captureBytes({ requestCount: 2 })).toString("utf8").replace('"requestCount": 2', '"requestCount": 1')),
    "capture가 심볼릭 링크": async (directory) => {
      await writeFile(path.join(directory, "target.json"), await captureBytes({ requestCount: 2 }));
      await symlink(path.join(directory, "target.json"), path.join(directory, "provider-response-capture.json"));
    },
    "정상 수집의 freshness.json은 실패 영수증이 아님": receipt({ schemaVersion: 1, artifactKind: "itx-admission-service-dates", serviceDates: {} }),
    "다른 연산의 실패 영수증": receipt({ artifactKind: "itx-current-collection-preflight", status: "FAILED", operation: "KST_PROVIDER_ENTRY_QUOTA" }),
    "영수증 손상": (directory) => writeFile(path.join(directory, "freshness.json"), "not json"),
  };
  for (const [name, populate] of Object.entries(cases)) assert.equal(await read(downloader(populate).downloadArtifact), null, name);
});

test("artifact 이름이 없는 workflow는 내려받지 않고 null이다", async () => {
  const { downloadArtifact, calls } = downloader((directory) => writeFailedRunArtifact(directory, { requestCount: 5 }));
  assert.equal(await read(downloadArtifact, { artifactName: null }), null);
  assert.equal(calls.length, 0);
});
