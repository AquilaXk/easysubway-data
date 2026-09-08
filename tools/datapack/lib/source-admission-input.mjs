const SOURCE_SNAPSHOT_PATH = /^tools\/datapack\/sources\/[^/]+\.json$/u;

export async function readSelectedSourceSnapshot({
  inventory,
  sourceId,
  evidenceKind,
  readTracked,
} = {}) {
  const sources = inventory?.sources?.filter(({ id }) => id === sourceId) ?? [];
  const source = sources.length === 1 ? sources[0] : null;
  const evidence = source?.[evidenceKind];
  const snapshotPath = evidence?.snapshotPath;
  if (!source || typeof evidenceKind !== "string" || !evidence
    || typeof evidence.snapshotId !== "string" || evidence.snapshotId.length === 0
    || typeof snapshotPath !== "string" || !SOURCE_SNAPSHOT_PATH.test(snapshotPath)
    || typeof readTracked !== "function") {
    throw new Error(`selected source snapshot is invalid: ${sourceId}`);
  }
  const bytes = await readTracked(snapshotPath);
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`selected source snapshot JSON is invalid: ${sourceId}`);
  }
}
