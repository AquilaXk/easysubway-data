import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, withoutSignature } from "./lib/manifest-validation.mjs";

const scriptPath = fileURLToPath(new URL("./promote-and-sign.mjs", import.meta.url));
const toolsRoot = fileURLToPath(new URL("..", import.meta.url));
const PRIVATE_KEY_ENV = "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM";

function generatedKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

function writeWorkdir() {
  const dir = mkdtempSync(path.join(tmpdir(), "promote-and-sign-"));
  const datapackDir = path.join(dir, "artifacts", "datapack");
  mkdirSync(datapackDir, { recursive: true });
  const manifest = {
    manifestVersion: 2,
    channel: "candidate",
    keyId: "candidate",
    packs: [
      {
        id: "seoul",
        version: "2026.10.06",
        sha256: "a".repeat(64),
        sqliteSha256: "b".repeat(64),
        sizeBytes: 1024,
        url: "https://example.invalid/datapacks/seoul.zip",
      },
    ],
  };
  const provenance = { manifestSha256: "0".repeat(64), packs: [{ id: "seoul", artifactKind: "candidate" }] };
  const manifestPath = path.join(datapackDir, "current.json");
  const provenancePath = path.join(datapackDir, "current.provenance.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return { dir, manifestPath, provenancePath };
}

function runPromote(dir, env) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: dir,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

test("서명 키 환경변수가 없으면 non-zero로 종료하고 산출물을 쓰지 않는다", () => {
  const work = writeWorkdir();
  try {
    const beforeManifest = readFileSync(work.manifestPath, "utf8");
    const beforeProvenance = readFileSync(work.provenancePath, "utf8");

    const result = runPromote(work.dir, {});

    assert.notEqual(result.status, 0, `exit ${result.status}\n${result.stdout}`);
    assert.match(result.stderr, new RegExp(`${PRIVATE_KEY_ENV} is required`));
    assert.doesNotMatch(result.stdout, /Promoted and signed/);
    assert.equal(readFileSync(work.manifestPath, "utf8"), beforeManifest);
    assert.equal(readFileSync(work.provenancePath, "utf8"), beforeProvenance);
  } finally {
    rmSync(work.dir, { recursive: true, force: true });
  }
});

test("서명 키 환경변수가 공백뿐이어도 non-zero로 종료하고 산출물을 쓰지 않는다", () => {
  const work = writeWorkdir();
  try {
    const beforeManifest = readFileSync(work.manifestPath, "utf8");

    const result = runPromote(work.dir, { [PRIVATE_KEY_ENV]: "  \n " });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${PRIVATE_KEY_ENV} is required`));
    assert.equal(readFileSync(work.manifestPath, "utf8"), beforeManifest);
  } finally {
    rmSync(work.dir, { recursive: true, force: true });
  }
});

test("서명 키가 PEM으로 해석되지 않으면 키 값을 노출하지 않고 non-zero로 종료하며 산출물을 쓰지 않는다", () => {
  const work = writeWorkdir();
  try {
    const beforeManifest = readFileSync(work.manifestPath, "utf8");
    const beforeProvenance = readFileSync(work.provenancePath, "utf8");
    const garbage = "not-a-pem-SECRET-MARKER";

    const result = runPromote(work.dir, { [PRIVATE_KEY_ENV]: garbage });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${PRIVATE_KEY_ENV} is not a valid private key PEM`));
    assert.doesNotMatch(result.stderr, /SECRET-MARKER/);
    assert.doesNotMatch(result.stdout, /Promoted and signed/);
    assert.equal(readFileSync(work.manifestPath, "utf8"), beforeManifest);
    assert.equal(readFileSync(work.provenancePath, "utf8"), beforeProvenance);
  } finally {
    rmSync(work.dir, { recursive: true, force: true });
  }
});

for (const [label, generate, keyType] of [
  ["EC P-256", () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }), "ec"],
  ["Ed25519", () => generateKeyPairSync("ed25519"), "ed25519"],
]) {
  test(`RSA가 아닌 ${label} 서명 키는 서명 전에 non-zero로 종료하고 산출물을 쓰지 않는다`, () => {
    const work = writeWorkdir();
    try {
      const beforeManifest = readFileSync(work.manifestPath, "utf8");
      const beforeProvenance = readFileSync(work.provenancePath, "utf8");
      const privateKeyPem = generate().privateKey.export({ type: "pkcs8", format: "pem" });

      const result = runPromote(work.dir, { [PRIVATE_KEY_ENV]: privateKeyPem });

      assert.notEqual(result.status, 0, `exit ${result.status}\n${result.stdout}`);
      assert.match(result.stderr, new RegExp(`${PRIVATE_KEY_ENV} must be an RSA private key \\(got ${keyType}\\)`));
      assert.doesNotMatch(result.stderr, /PRIVATE KEY/);
      assert.doesNotMatch(result.stdout, /Promoted and signed/);
      assert.equal(readFileSync(work.manifestPath, "utf8"), beforeManifest);
      assert.equal(readFileSync(work.provenancePath, "utf8"), beforeProvenance);
    } finally {
      rmSync(work.dir, { recursive: true, force: true });
    }
  });
}

test("주입한 서명 키로만 production manifest를 서명한다", () => {
  const work = writeWorkdir();
  try {
    const { privateKeyPem, publicKeyPem } = generatedKeyPair();
    const other = generatedKeyPair();

    const result = runPromote(work.dir, { [PRIVATE_KEY_ENV]: privateKeyPem });

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(work.manifestPath, "utf8"));
    assert.equal(manifest.channel, "production");
    assert.equal(manifest.keyId, "production-v1");
    const signedPayload = canonicalJson(withoutSignature(manifest));
    const signature = Buffer.from(manifest.signature.value, "base64url");
    assert.equal(createVerify("RSA-SHA256").update(signedPayload).verify(publicKeyPem, signature), true);
    assert.equal(createVerify("RSA-SHA256").update(signedPayload).verify(other.publicKeyPem, signature), false);
    const provenance = JSON.parse(readFileSync(work.provenancePath, "utf8"));
    assert.equal(provenance.packs[0].artifactKind, "production");
  } finally {
    rmSync(work.dir, { recursive: true, force: true });
  }
});

function nonTestSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "fixtures") continue;
    const entryPath = path.join(directory, entry);
    if (statSync(entryPath).isDirectory()) {
      files.push(...nonTestSourceFiles(entryPath));
    } else if (/\.(mjs|js|cjs)$/.test(entry) && !/\.test\.(mjs|js|cjs)$/.test(entry)) {
      files.push(entryPath);
    }
  }
  return files;
}

test("tools 프로덕션 코드에는 비공개키 리터럴이 없다", () => {
  const offenders = nonTestSourceFiles(toolsRoot).filter((file) =>
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(offenders.map((file) => path.relative(toolsRoot, file)), []);
});
