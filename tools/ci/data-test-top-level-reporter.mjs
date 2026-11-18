// data-test-discovery가 partition 실행의 완전성을 대조하려고 쓰는 node:test reporter다.
// top-level(nesting 0) test의 완료 이벤트만 JSON 한 줄씩 낸다. suite는 쓰지 않는 파일만 나누므로
// top-level 이벤트는 곧 파일의 top-level test다. 선택된 test가 하나도 없는 실행에서 runner가
// 파일 자체를 1행 1열의 test로 보고하는 이벤트는 test가 아니므로 제외한다(파일 로드 실패는
// 프로세스 종료 코드로 드러난다).
export default async function* topLevelReporter(source) {
  for await (const event of source) {
    if ((event.type !== 'test:pass' && event.type !== 'test:fail') || event.data.nesting !== 0) continue;
    const { name, file, line, column } = event.data;
    const fileWrapper =
      line === 1 && column === 1 && typeof file === 'string' && typeof name === 'string' && file.endsWith(name);
    if (fileWrapper) continue;
    yield `${JSON.stringify({ name, ok: event.type === 'test:pass' })}\n`;
  }
}
