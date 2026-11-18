// `node --import <이 파일> guard-itx-current-collection-budget.mjs ...`로 가드 CLI 앞에 끼워 GitHub API와 시계를 고정한다.
// 시나리오는 GUARD_STUB_SCENARIO(JSON)로 받는다. 응답 모양은 실제 GitHub REST 응답(runs 목록 · run의 jobs)을 따른다.
//   now                    고정 시각(ISO). 기본은 장애가 있던 2026-10-22T14:57:17Z.
//   runs                   "<workflow 파일>|<event>" -> run 배열. 없는 키는 빈 목록이다.
//   jobs                   run id -> job 배열.
//   runsFault, jobsFault   정상 응답 대신 줄 응답: { throwMessage } | { status, body? } | { rawBody } | { brokenBody } | { explodingResponse } | { padBytes } | { totalCount }
//                          brokenBody: 상태 200 응답의 본문을 읽는 도중 연결이 끊긴다.
//                          padBytes: 목록은 비었지만 JSON 본문이 이 바이트 수 이상으로 크다.
//                          explodingResponse: 응답 객체를 읽는 순간 이 메시지의 예외가 난다(가드가 모르는 예외).
const scenario = JSON.parse(process.env.GUARD_STUB_SCENARIO ?? "{}");
const FIXED_NOW = Date.parse(scenario.now ?? "2026-10-22T14:57:17Z");
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length === 0 ? [FIXED_NOW] : args));
  }

  static now() {
    return FIXED_NOW;
  }
};

function faultResponse(fault, listKey, list) {
  if (fault.throwMessage !== undefined) throw new Error(fault.throwMessage);
  if (fault.rawBody !== undefined) return new Response(fault.rawBody, { status: 200 });
  if (fault.brokenBody) return new Response(new ReadableStream({ pull: (controller) => controller.error(new Error("socket closed")) }), { status: 200 });
  if (fault.explodingResponse) return { text: async () => "{}", get ok() { throw new Error(fault.explodingResponse); } };
  if (fault.padBytes) return Response.json({ total_count: 0, [listKey]: [], pad: "x".repeat(fault.padBytes) });
  if (fault.status !== undefined) return new Response(fault.body ?? "{}", { status: fault.status });
  return Response.json({ total_count: fault.totalCount, [listKey]: list });
}

globalThis.fetch = async (url) => {
  const { pathname, searchParams } = new URL(url);
  const jobsMatch = /\/actions\/runs\/(\d+)\/jobs$/u.exec(pathname);
  if (jobsMatch) {
    const jobs = scenario.jobs?.[jobsMatch[1]] ?? [];
    return scenario.jobsFault ? faultResponse(scenario.jobsFault, "jobs", jobs) : Response.json({ total_count: jobs.length, jobs });
  }
  const workflowFile = pathname.split("/").at(-2);
  const runs = scenario.runs?.[`${workflowFile}|${searchParams.get("event")}`] ?? [];
  const fault = scenario.runsFault;
  return fault && (fault.workflowFile === undefined || fault.workflowFile === workflowFile)
    ? faultResponse(fault, "workflow_runs", runs)
    : Response.json({ total_count: runs.length, workflow_runs: runs });
};
