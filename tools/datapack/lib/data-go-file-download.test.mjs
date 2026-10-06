import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  downloadDataGoFile,
  isCanonicalDataGoDownloadUrl,
  parseDataGoDownloadAction,
  resolveDataGoFileDownload,
  verifyDataGoDownloadProvenance,
} from "./data-go-file-download.mjs";

const fixtureDir = path.resolve(import.meta.dirname, "../fixtures/data-go-file-download");
const read = (name) => readFile(path.join(fixtureDir, name), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// 포털 detail 페이지(JSON-LD 없는 1호선 상선, JSON-LD 있는 접근성)와 selectFileDataDownload.do 실제 응답을 재생한다.
async function portalFetch({ pages = {}, selects = {}, files = {}, calls = [] } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(url);
    const respond = (body, status = 200, headers = {}) => new Response(body, { status, headers });
    if (parsed.pathname.endsWith("/fileData.do")) {
      const id = parsed.pathname.split("/")[2];
      return pages[id] === undefined ? respond("not found", 404) : respond(pages[id], 200, { "content-type": "text/html" });
    }
    if (parsed.pathname === "/tcs/dss/selectFileDataDownload.do") {
      const id = parsed.searchParams.get("publicDataPk");
      return selects[id] === undefined ? respond("{}", 500) : respond(selects[id], 200, { "content-type": "application/json" });
    }
    if (parsed.pathname === "/cmm/cmm/fileDownload.do") {
      const file = files[parsed.searchParams.get("atchFileId")];
      return file === undefined
        ? respond("missing", 404)
        : respond(file.body, file.status ?? 200, { "content-type": file.type ?? "application/octet-stream; charset=UTF-8" });
    }
    return respond("unexpected", 500);
  };
}

async function realPortal(overrides = {}) {
  const calls = [];
  const fetchImpl = await portalFetch({
    calls,
    pages: { 15065526: await read("detail-15065526.html"), 15149872: await read("detail-15149872.html") },
    selects: { 15065526: await read("select-15065526.json"), 15149872: await read("select-15149872.json") },
    files: {
      FILE_000000003042523: { body: "상선,csv\n1,2\n" },
      FILE_000000007633578: { body: "호선,역명\n1,a\n" },
    },
    ...overrides,
  });
  return { fetchImpl, calls };
}

test("detail 페이지의 다운로드 버튼에서 데이터셋 PK·상세 PK·파일 순번을 정확히 한 번만 읽는다", async () => {
  assert.deepEqual(parseDataGoDownloadAction(await read("detail-15065526.html"), "15065526"), {
    publicDataPk: "15065526",
    publicDataDetailPk: "uddi:2e3b04af-143f-480f-8948-ef72ce788d05",
    fileDetailSn: "1",
  });
  assert.deepEqual(parseDataGoDownloadAction(await read("detail-15149872.html"), "15149872"), {
    publicDataPk: "15149872",
    publicDataDetailPk: "uddi:f296123b-22e5-428f-86af-f78b86307a6a",
    fileDetailSn: "1",
  });
});

test("다운로드 버튼이 없거나 둘 이상이거나 다른 데이터셋이면 명시적으로 실패한다", async () => {
  const html = await read("detail-15065526.html");
  assert.throws(() => parseDataGoDownloadAction("<html>none</html>", "15065526"), /exactly one download action/);
  assert.throws(() => parseDataGoDownloadAction(html, "15065527"), /exactly one download action/);
  const second = html.replace("'1', '9')", "'2', '9')");
  assert.throws(() => parseDataGoDownloadAction(`${html}${second}`, "15065526"), /exactly one download action/);
  assert.throws(() => parseDataGoDownloadAction(undefined, "15065526"), /HTML is required/);
  assert.throws(() => parseDataGoDownloadAction(html, "../15065526"), /dataset id/);
});

test("JSON-LD가 없는 페이지도 selectFileDataDownload.do 응답으로 canonical FILE URL을 결정한다", async () => {
  const { fetchImpl, calls } = await realPortal();
  const resolved = await resolveDataGoFileDownload(fetchImpl, "15065526");
  assert.deepEqual(resolved, {
    datasetId: "15065526",
    detailUrl: "https://www.data.go.kr/data/15065526/fileData.do",
    downloadUrl: "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003042523&fileDetailSn=1&insertDataPrcus=N",
  });
  assert.equal(isCanonicalDataGoDownloadUrl(resolved.downloadUrl), true);
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    "/data/15065526/fileData.do",
    "/tcs/dss/selectFileDataDownload.do",
  ]);
  const query = new URL(calls[1].url).searchParams;
  assert.equal(query.get("publicDataPk"), "15065526");
  assert.equal(query.get("publicDataDetailPk"), "uddi:2e3b04af-143f-480f-8948-ef72ce788d05");
  assert.equal(query.get("fileDetailSn"), "1");
  assert.equal(query.get("publicDataTyCode"), "PR0051");
  assert.equal(calls[1].init.method ?? "GET", "GET");
  // JSON-LD가 있는 페이지도 같은 단일 경로로 해석된다.
  assert.equal(
    (await resolveDataGoFileDownload(fetchImpl, "15149872")).downloadUrl,
    "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000007633578&fileDetailSn=1&insertDataPrcus=N",
  );
});

test("해석 단계의 모든 실패(HTTP·형식·불일치)는 명시적 오류이며 대체 URL을 만들지 않는다", async () => {
  const selectBody = JSON.parse(await read("select-15065526.json"));
  const withSelect = async (mutate) => {
    const body = structuredClone(selectBody);
    mutate(body);
    return (await realPortal({
      selects: { 15065526: JSON.stringify(body), 15149872: await read("select-15149872.json") },
    })).fetchImpl;
  };
  await assert.rejects(resolveDataGoFileDownload((await realPortal({ pages: {} })).fetchImpl, "15065526"),
    /15065526 detail HTTP 404/);
  await assert.rejects(resolveDataGoFileDownload((await realPortal({ selects: {} })).fetchImpl, "15065526"),
    /15065526 download lookup HTTP 500/);
  await assert.rejects(resolveDataGoFileDownload((await realPortal({
    selects: { 15065526: "<html>login</html>" },
  })).fetchImpl, "15065526"), /download lookup is not JSON/);
  await assert.rejects(resolveDataGoFileDownload(await withSelect((body) => { body.status = false; }), "15065526"),
    /download lookup rejected/);
  await assert.rejects(resolveDataGoFileDownload(await withSelect((body) => { body.dpk = "uddi:other"; }), "15065526"),
    /download lookup detail PK mismatch/);
  await assert.rejects(resolveDataGoFileDownload(await withSelect((body) => { body.atchFileId = "../x"; }), "15065526"),
    /atchFileId is invalid/);
  await assert.rejects(resolveDataGoFileDownload(await withSelect((body) => { body.fileDetailSn = "0"; }), "15065526"),
    /fileDetailSn is invalid/);
  await assert.rejects(resolveDataGoFileDownload(await withSelect((body) => { body.fileDetailSn = "2"; }), "15065526"),
    /fileDetailSn is invalid/);
});

test("다운로드는 FILE 본문을 받아 sha256과 provenance를 돌려주고 Referer를 붙인다", async () => {
  const { fetchImpl, calls } = await realPortal();
  const downloaded = await downloadDataGoFile(fetchImpl, "15065526");
  assert.equal(Buffer.from(downloaded.bytes).toString("utf8"), "상선,csv\n1,2\n");
  assert.equal(downloaded.rawSha256, sha256(Buffer.from("상선,csv\n1,2\n")));
  assert.equal(downloaded.detailUrl, "https://www.data.go.kr/data/15065526/fileData.do");
  assert.equal(downloaded.datasetId, "15065526");
  assert.match(downloaded.downloadUrl, /fileDownload\.do\?atchFileId=FILE_000000003042523/);
  const fileCall = calls.at(-1);
  assert.equal(fileCall.init.headers.Referer, "https://www.data.go.kr/data/15065526/fileData.do");
  assert.ok(!JSON.stringify(calls).includes("serviceKey"));
});

test("다운로드 본문이 비었거나 오류 페이지거나 HTTP 오류면 성공으로 보지 않는다", async () => {
  await assert.rejects(downloadDataGoFile((await realPortal({
    files: { FILE_000000003042523: { body: "" } },
  })).fetchImpl, "15065526"), /15065526 file is empty/);
  await assert.rejects(downloadDataGoFile((await realPortal({
    files: { FILE_000000003042523: { body: "<html>error</html>", type: "text/html;charset=UTF-8" } },
  })).fetchImpl, "15065526"), /15065526 file is not a data file/);
  await assert.rejects(downloadDataGoFile((await realPortal({
    files: { FILE_000000003042523: { body: "x", status: 503 } },
  })).fetchImpl, "15065526"), /15065526 file HTTP 503/);
  await assert.rejects(downloadDataGoFile((await realPortal({ files: {} })).fetchImpl, "15065526"),
    /15065526 file HTTP 404/);
});

test("provenance 검증은 데이터셋 순서·URL·원본 sha 불일치를 거부한다", async () => {
  const { fetchImpl } = await realPortal();
  const first = await downloadDataGoFile(fetchImpl, "15065526");
  const second = await downloadDataGoFile(fetchImpl, "15149872");
  const bytesByDatasetId = { 15065526: first.bytes, 15149872: second.bytes };
  const entry = ({ datasetId, detailUrl, downloadUrl, rawSha256 }) => ({ datasetId, detailUrl, downloadUrl, rawSha256 });
  const provenance = [entry(first), entry(second)];
  assert.deepEqual(
    verifyDataGoDownloadProvenance(provenance, ["15065526", "15149872"], bytesByDatasetId),
    provenance,
  );
  assert.throws(() => verifyDataGoDownloadProvenance(provenance, ["15149872", "15065526"], bytesByDatasetId),
    /download provenance is invalid/);
  assert.throws(() => verifyDataGoDownloadProvenance(provenance.slice(0, 1), ["15065526", "15149872"], bytesByDatasetId),
    /download provenance is invalid/);
  assert.throws(() => verifyDataGoDownloadProvenance(
    [{ ...provenance[0], rawSha256: "0".repeat(64) }, provenance[1]], ["15065526", "15149872"], bytesByDatasetId,
  ), /15065526 download provenance sha256 mismatch/);
  assert.throws(() => verifyDataGoDownloadProvenance(
    [{ ...provenance[0], downloadUrl: "https://evil.example/cmm/cmm/fileDownload.do?atchFileId=FILE_1&fileDetailSn=1" }, provenance[1]],
    ["15065526", "15149872"], bytesByDatasetId,
  ), /15065526 download provenance is invalid/);
  assert.throws(() => verifyDataGoDownloadProvenance(
    [{ ...provenance[0], detailUrl: "https://www.data.go.kr/data/1/fileData.do" }, provenance[1]],
    ["15065526", "15149872"], bytesByDatasetId,
  ), /15065526 download provenance is invalid/);
  assert.throws(() => verifyDataGoDownloadProvenance(
    provenance, ["15065526", "15149872"], { 15065526: Buffer.from("changed"), 15149872: second.bytes },
  ), /15065526 download provenance sha256 mismatch/);
});
