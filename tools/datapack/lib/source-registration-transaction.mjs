import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

export const SOURCE_REGISTRATION_OUTPUTS = Object.freeze([
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
]);

const sha = (value) => createHash("sha256").update(value).digest("hex");

async function syncParent(file) {
  const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

export function createSourceRegistrationTransaction({ journalPath, lockPath, label, validateOutputs }) {
  const prefix = `${label} transaction`;
  const rootPath = (value) => {
    if (!path.isAbsolute(value ?? "")) throw new Error(`${label} registration requires an absolute repository root`);
    return path.resolve(value);
  };
  const target = (root, relative) => {
    if (!SOURCE_REGISTRATION_OUTPUTS.includes(relative) && relative !== journalPath && relative !== lockPath) throw new Error(`${label} registration target is invalid`);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new Error(`${label} registration target escapes repository`);
    return file;
  };
  async function safeParent(file) {
    const stat = await lstat(path.dirname(file));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${prefix} parent is unsafe`);
  }
  async function currentBytes(file) {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${prefix} target is unsafe`);
      return await readFile(file);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
  async function assertBytes(file, expected) {
    const actual = await currentBytes(file);
    if ((actual == null) !== (expected == null) || (actual != null && !actual.equals(expected))) throw new Error(`${prefix} preserves foreign replacement`);
  }
  async function atomicWrite(file, value, expected) {
    await safeParent(file); if (expected !== undefined) await assertBytes(file, expected);
    const temporary = path.join(path.dirname(file), "." + path.basename(file) + "." + randomUUID() + ".tmp");
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
      if (expected !== undefined) await assertBytes(file, expected);
      if (expected === null) { await link(temporary, file); await unlink(temporary); } else await rename(temporary, file);
      await syncParent(file); await assertBytes(file, value);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  function inputFile(root, input) {
    if (typeof input.relative === "string") {
      const file = path.resolve(root, input.relative);
      if (!file.startsWith(root + path.sep)) throw new Error(`${prefix} input escapes repository`);
      return file;
    }
    return input.absolute;
  }
  async function assertInputs(root, inputs) {
    for (const input of inputs) {
      const actual = await readFile(inputFile(root, input));
      if (!actual.equals(input.bytes)) throw new Error(`${prefix} preserves input binding`);
    }
  }
  const journalRecords = (outputs) => outputs.map(({ relative, bytes, prestateBytes }) => ({ relative, beforeBase64: prestateBytes.toString("base64"), beforeSha256: sha(prestateBytes), nextBase64: bytes.toString("base64"), nextSha256: sha(bytes) }));
  function validateJournal(journal) {
    if (journal?.schemaVersion !== 1 || !["PREPARED", "COMMITTED"].includes(journal.state) || !Array.isArray(journal.records) || journal.records.length !== SOURCE_REGISTRATION_OUTPUTS.length || JSON.stringify(journal.records.map(({ relative }) => relative)) !== JSON.stringify(SOURCE_REGISTRATION_OUTPUTS)) throw new Error(`${prefix} recovery is invalid`);
    for (const record of journal.records) {
      const before = Buffer.from(record.beforeBase64 ?? "", "base64"), next = Buffer.from(record.nextBase64 ?? "", "base64");
      if (before.toString("base64") !== record.beforeBase64 || next.toString("base64") !== record.nextBase64 || sha(before) !== record.beforeSha256 || sha(next) !== record.nextSha256) throw new Error(`${prefix} recovery is invalid`);
    }
  }
  async function recover(root) {
    const journal = await currentBytes(target(root, journalPath));
    if (journal == null) return;
    let parsed; try { parsed = JSON.parse(journal); } catch { throw new Error(`${prefix} journal is invalid JSON`); }
    validateJournal(parsed);
    for (const record of parsed.records) {
      const before = Buffer.from(record.beforeBase64, "base64");
      const next = Buffer.from(record.nextBase64, "base64");
      const file = target(root, record.relative);
      const actual = await currentBytes(file);
      const desired = parsed.state === "PREPARED" ? before : next;
      const prestate = parsed.state === "PREPARED" ? next : before;
      if (actual.equals(desired)) continue;
      if (!actual.equals(prestate)) throw new Error(`${prefix} preserves foreign replacement`);
      await atomicWrite(file, desired, prestate);
    }
    await unlink(target(root, journalPath)); await syncParent(target(root, journalPath));
  }
  async function acquireLock(root) {
    const lock = target(root, lockPath); await safeParent(lock);
    try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`${prefix} lock residue exists`);
      throw error;
    }
    return async () => { await rmdir(lock); };
  }
  return {
    async recover({ repositoryRoot } = {}) {
      const root = rootPath(repositoryRoot), release = await acquireLock(root);
      try { await recover(root); } finally { await release(); }
    },
    async commit({ repositoryRoot, outputs, failAfter = null } = {}) {
      const root = rootPath(repositoryRoot); validateOutputs(outputs); const release = await acquireLock(root);
      try {
        await recover(root); for (const output of outputs) await assertBytes(target(root, output.relative), output.prestateBytes);
        await assertInputs(root, outputs[0].inputs);
        const records = journalRecords(outputs), journal = target(root, journalPath);
        await atomicWrite(journal, Buffer.from(JSON.stringify({ schemaVersion: 1, state: "PREPARED", records })), null);
        try {
          for (const [index, record] of records.entries()) {
            await assertInputs(root, outputs[0].inputs);
            await atomicWrite(target(root, record.relative), Buffer.from(record.nextBase64, "base64"), Buffer.from(record.beforeBase64, "base64"));
            if (failAfter === index) throw new Error(`injected ${prefix} failure`);
          }
        } catch (error) { await recover(root); throw error; }
        const prepared = await currentBytes(journal);
        await atomicWrite(journal, Buffer.from(JSON.stringify({ schemaVersion: 1, state: "COMMITTED", records })), prepared);
        await recover(root); return { targets: SOURCE_REGISTRATION_OUTPUTS };
      } finally { await release(); }
    },
  };
}
