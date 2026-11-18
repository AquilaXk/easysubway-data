// 테스트 전용: data.go.kr 파일데이터 포털(detail 페이지 → selectFileDataDownload.do → fileDownload.do)을 재생하는 fetch.
// 응답 형태는 fixtures/data-go-file-download의 실제 포털 응답과 같다.
export function createDataGoPortalFetch(filesByDatasetId, { calls = [], failFile = new Set() } = {}) {
  const detailPkOf = (id) => `uddi:00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
  const atchFileIdOf = (id) => `FILE_${String(id).padStart(15, "0")}`;
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(url);
    const respond = (body, status = 200, type = "application/octet-stream; charset=UTF-8") => new Response(
      body, { status, headers: { "content-type": type } },
    );
    if (/^\/data\/\d+\/fileData\.do$/u.test(parsed.pathname)) {
      const id = parsed.pathname.split("/")[2];
      if (!filesByDatasetId[id]) return respond("not found", 404, "text/html");
      return respond(
        `<button onclick="fileDetailObj.fn_fileDataDown('${id}', '${detailPkOf(id)}', '','1', '1')">다운로드</button>`,
        200, "text/html",
      );
    }
    if (parsed.pathname === "/tcs/dss/selectFileDataDownload.do") {
      const id = parsed.searchParams.get("publicDataPk");
      return respond(JSON.stringify({
        status: true,
        fileDetailSn: parsed.searchParams.get("fileDetailSn"),
        dpk: parsed.searchParams.get("publicDataDetailPk"),
        atchFileId: atchFileIdOf(id),
      }), 200, "application/json");
    }
    if (parsed.pathname === "/cmm/cmm/fileDownload.do") {
      const id = Object.keys(filesByDatasetId).find((candidate) => atchFileIdOf(candidate) === parsed.searchParams.get("atchFileId"));
      if (id === undefined || failFile.has(id)) return respond("unavailable", 503, "text/plain");
      return respond(filesByDatasetId[id]);
    }
    return respond("unexpected", 500, "text/plain");
  };
}
