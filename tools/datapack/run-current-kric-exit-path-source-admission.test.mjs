import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractCurrentKricExitCollectionBundle,
  runCurrentKricExitPathSourceAdmission,
} from "./run-current-kric-exit-path-source-admission.mjs";

const REPOSITORY = "AquilaXk/easysubway-data";
const HEAD_SHA = "a".repeat(40);
const RUN_ID = 4512;
const BUNDLE = Buffer.from('{"bundle":"trusted"}\n');

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function zipOne(name, bytes, { method = 0, flags = 0, extra = Buffer.alloc(0), descriptor = false } = {}) {
  const nameBytes = Buffer.from(name, "utf8");
  const checksum = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  const entryFlags = flags || 0x0800 | (descriptor ? 0x0008 : 0);
  local.writeUInt16LE(entryFlags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(descriptor ? 0 : checksum, 14);
  local.writeUInt32LE(descriptor ? 0 : bytes.length, 18);
  local.writeUInt32LE(descriptor ? 0 : bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(extra.length, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(entryFlags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
  const centralBytes = Buffer.concat([central, nameBytes, extra]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  const descriptorBytes = descriptor ? Buffer.from([0x50, 0x4b, 0x07, 0x08,
    checksum & 0xff, (checksum >>> 8) & 0xff, (checksum >>> 16) & 0xff, (checksum >>> 24) & 0xff,
    bytes.length & 0xff, (bytes.length >>> 8) & 0xff, (bytes.length >>> 16) & 0xff, (bytes.length >>> 24) & 0xff,
    bytes.length & 0xff, (bytes.length >>> 8) & 0xff, (bytes.length >>> 16) & 0xff, (bytes.length >>> 24) & 0xff,
  ]) : Buffer.alloc(0);
  end.writeUInt32LE(local.length + nameBytes.length + extra.length + bytes.length + descriptorBytes.length, 16);
  return Buffer.concat([local, nameBytes, extra, bytes, descriptorBytes, centralBytes, end]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function event(updatedAt = "2026-08-15T00:00:00.000Z") {
  return {
    repository: { full_name: REPOSITORY },
    workflow_run: {
      id: RUN_ID,
      name: "KRIC EXIT Path Provider Snapshot",
      path: ".github/workflows/kric-exit-path-provider-snapshot.yml@main",
      event: "workflow_dispatch",
      head_branch: "main",
      conclusion: "success",
      head_sha: HEAD_SHA,
      updated_at: updatedAt,
    },
  };
}

test("archive metadata digest and one regular bundle entry bind the #330 invocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "exit-source-admission-"));
  const output = path.join(root, "output");
  const archive = zipOne("current-kric-exit-collection-bundle.json", BUNDLE);
  const archiveDigest = sha256(archive);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith(`https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts?`)) {
      return responseJson({
        total_count: 1,
        artifacts: [{
          id: 87,
          name: `kric-exit-path-provider-snapshot-${RUN_ID}`,
          expired: false,
          digest: `sha256:${archiveDigest}`,
        }],
      });
    }
    if (url.endsWith("/actions/artifacts/87/zip")) return responseBytes(archive);
    throw new Error(`unexpected URL ${url}`);
  };
  await runCurrentKricExitPathSourceAdmission({
    event: event(), token: "test-token", workspace: root, outputDirectory: output, fetchImpl,
    execFileImpl: async (_command, args) => {
      assert.equal(args.filter((value) => value === "--collection-bundle").length, 1);
      assert.equal(args[args.indexOf("--expected-bundle-sha256") + 1], sha256(BUNDLE));
      assert.equal(args[args.indexOf("--expected-repository-sha") + 1], HEAD_SHA);
      assert.equal(args[args.indexOf("--expected-workflow-run-id") + 1], String(RUN_ID));
      await mkdir(output, { recursive: true, mode: 0o700 });
      await writeFile(path.join(output, "exit-path-normalized-source-snapshot.json"), "{}", { mode: 0o600 });
      await writeFile(path.join(output, "exit-path-source-admission.json"), '{"decision":"GO"}', { mode: 0o600 });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal((await readFile(path.join(output, "exit-path-source-admission.json"), "utf8")), '{"decision":"GO"}');
});

test("GitHub second-precision UTC updated_at는 canonical milliseconds로 admission에 전달된다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "exit-source-admission-time-")); const output = path.join(root, "output"); const archive = zipOne("current-kric-exit-collection-bundle.json", BUNDLE);
  await runCurrentKricExitPathSourceAdmission({ event: event("2026-08-15T00:00:00Z"), token: "test-token", workspace: root, outputDirectory: output,
    fetchImpl: async (url) => url.includes(`/actions/runs/${RUN_ID}/artifacts?`) ? responseJson({ total_count: 1, artifacts: [{ id: 87, name: `kric-exit-path-provider-snapshot-${RUN_ID}`, expired: false, digest: `sha256:${sha256(archive)}` }] }) : responseBytes(archive),
    execFileImpl: async (_command, args) => { assert.equal(args[args.indexOf("--observed-at") + 1], "2026-08-15T00:00:00.000Z"); await mkdir(output, { recursive: true }); await writeFile(path.join(output, "exit-path-normalized-source-snapshot.json"), "{}", { mode: 0o600 }); await writeFile(path.join(output, "exit-path-source-admission.json"), '{"decision":"GO"}', { mode: 0o600 }); },
  });
});

test("invalid or offset GitHub updated_at는 fetch 전에 fail closed한다", async () => {
  for (const updatedAt of ["2026-02-30T00:00:00Z", "2026-08-15T24:00:00Z", "2026-08-15T00:00:00+09:00"]) {
    let fetched = false;
    await assert.rejects(() => runCurrentKricExitPathSourceAdmission({ event: event(updatedAt), token: "test-token", workspace: "/tmp", outputDirectory: "/tmp/exit-admission-invalid-time", fetchImpl: async () => { fetched = true; } }), /UTC instant/);
    assert.equal(fetched, false);
  }
});

test("self-consistent bundle alone and unsafe archive entries fail before admission", async () => {
  assert.throws(
    () => extractCurrentKricExitCollectionBundle(zipOne("../current-kric-exit-collection-bundle.json", BUNDLE)),
    /ZIP entry name mismatch/,
  );
  assert.throws(
    () => extractCurrentKricExitCollectionBundle(Buffer.concat([
      zipOne("current-kric-exit-collection-bundle.json", BUNDLE),
      zipOne("extra.json", Buffer.from("{}")),
    ])),
    /exactly one ZIP entry/,
  );
});

test("one signed-storage redirect is credential-free and bit-3 descriptor uses central identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "exit-source-admission-redirect-"));
  const output = path.join(root, "output");
  const archive = zipOne("current-kric-exit-collection-bundle.json", BUNDLE, { descriptor: true });
  const calls = [];
  await runCurrentKricExitPathSourceAdmission({
    event: event(), token: "test-token", workspace: root, outputDirectory: output,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes(`/actions/runs/${RUN_ID}/artifacts?`)) return responseJson({ total_count: 1, artifacts: [{ id: 87, name: `kric-exit-path-provider-snapshot-${RUN_ID}`, expired: false, digest: `sha256:${sha256(archive)}` }] });
      if (url.endsWith("/actions/artifacts/87/zip")) return { status: 302, headers: { get: () => "https://pipelines.actions.githubusercontent.com/signed/archive" } };
      if (url === "https://pipelines.actions.githubusercontent.com/signed/archive") return responseBytes(archive);
      throw new Error(`unexpected URL ${url}`);
    },
    execFileImpl: async () => {
      await mkdir(output, { recursive: true, mode: 0o700 });
      await writeFile(path.join(output, "exit-path-normalized-source-snapshot.json"), "{}", { mode: 0o600 });
      await writeFile(path.join(output, "exit-path-source-admission.json"), '{"decision":"GO"}', { mode: 0o600 });
    },
  });
  assert.match(calls[1].options.headers.Authorization, /Bearer test-token/);
  assert.equal(calls[2].options.headers.Authorization, undefined);
  assert.equal(calls[2].options.redirect, "error");
});

function responseJson(value) {
  return { ok: true, status: 200, headers: new Map(), json: async () => value, arrayBuffer: async () => { throw new Error("not bytes"); } };
}

function responseBytes(bytes) {
  return { ok: true, status: 200, headers: new Map(), json: async () => { throw new Error("not json"); }, arrayBuffer: async () => bytes };
}
