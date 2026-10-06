// 수집기 출력을 중간 상태 없이 드러낸다: 같은 디렉터리의 staging에 모두 쓴 뒤에만 최종 이름으로 연결한다.
import { link, mkdtemp, open, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// 최종 이름이 하나라도 이미 있으면 EEXIST로 실패하고 이번 호출이 만든 파일은 하나도 남기지 않는다.
export async function writeFilesCreateOnly(entries, { mode = 0o666 } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("staged output requires at least one file");
  const directory = path.dirname(entries[0].path);
  if (new Set(entries.map(({ path: entryPath }) => entryPath)).size !== entries.length) {
    throw new Error("staged output has duplicate output path");
  }
  if (entries.some(({ path: entryPath }) => path.dirname(entryPath) !== directory)) {
    throw new Error("staged output files must share one directory");
  }
  const staging = await mkdtemp(path.join(directory, ".staging-"));
  const linked = [];
  try {
    const staged = [];
    for (const [index, entry] of entries.entries()) {
      const stagedPath = path.join(staging, String(index));
      await writeFile(stagedPath, entry.bytes, { flag: "wx", mode });
      staged.push(stagedPath);
    }
    for (const [index, entry] of entries.entries()) {
      // link는 대상이 있으면 EEXIST로 실패해 덮어쓰지 않는다.
      await link(staged[index], entry.path);
      linked.push(entry.path);
    }
  } catch (error) {
    await Promise.all(linked.map((linkedPath) => unlink(linkedPath).catch(() => {})));
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// 같은 디렉터리의 임시 파일에 쓰고 rename으로 교체한다. 기존 출력이 심볼릭 링크여도 그 대상은 건드리지 않는다.
export async function writeFileReplacing(outputPath, bytes) {
  const directory = path.dirname(outputPath);
  const staging = await mkdtemp(path.join(directory, ".staging-"));
  try {
    const stagedPath = path.join(staging, path.basename(outputPath));
    const handle = await open(stagedPath, "wx", 0o666);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(stagedPath, outputPath);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
