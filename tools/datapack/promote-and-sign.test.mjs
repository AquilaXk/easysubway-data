import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

const PRIVATE_KEY_LITERAL = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

// 비공개키 리터럴 가드에서 제외하는 파일. 경로마다 사유를 적고, 가드 테스트가 목록이 낡지 않았는지(여전히 추적되고
// 실제로 리터럴을 담고 있는지) 함께 확인한다.
const PRIVATE_KEY_LITERAL_ALLOWLIST = new Map([
  ["tools/datapack/datapack-tools.test.mjs", "서명 라이브러리 테스트 전용 RSA fixture 키(운영 키와 무관, 지문 불일치)"],
]);

function findPrivateKeyLiterals(repoRoot, allowlist) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return tracked
    .filter((relativePath) => !allowlist.has(relativePath))
    .filter((relativePath) => PRIVATE_KEY_LITERAL.test(readFileSync(path.join(repoRoot, relativePath), "latin1")))
    .sort();
}

function temporaryGitRepo(files) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "private-key-guard-"));
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repoRoot, relativePath)), { recursive: true });
    writeFileSync(path.join(repoRoot, relativePath), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["add", "-A"], { cwd: repoRoot });
  return repoRoot;
}

// 가드가 이 파일을 리터럴로 오탐하지 않도록 헤더를 조립한다.
const pemHeader = `${"-----BEGIN "}${"PRIVATE KEY-----"}\nZmFrZQ==\n`;

test("비공개키 리터럴 가드는 확장자와 무관하게 추적 파일 전체에서 리터럴을 찾는다", () => {
  const repoRoot = temporaryGitRepo({
    "tools/ci/zz.json": pemHeader,
    "tools/ci/clean.json": "{}\n",
    "docs/note.md": `예시\n${pemHeader}`,
    "tools/datapack/ok.test.mjs": pemHeader,
  });
  try {
    assert.deepEqual(findPrivateKeyLiterals(repoRoot, new Map([["tools/datapack/ok.test.mjs", "테스트 fixture"]])), [
      "docs/note.md",
      "tools/ci/zz.json",
    ]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("저장소 추적 파일에는 허용 목록 밖의 비공개키 리터럴이 없다", () => {
  const repoRoot = path.resolve(toolsRoot, "..");
  assert.deepEqual(findPrivateKeyLiterals(repoRoot, PRIVATE_KEY_LITERAL_ALLOWLIST), []);
});

test("비공개키 리터럴 허용 목록은 낡지 않았다", () => {
  const repoRoot = path.resolve(toolsRoot, "..");
  for (const [allowedPath, reason] of PRIVATE_KEY_LITERAL_ALLOWLIST) {
    assert.notEqual(reason.trim(), "", `${allowedPath} 사유 필요`);
    assert.match(readFileSync(path.join(repoRoot, allowedPath), "utf8"), PRIVATE_KEY_LITERAL, `${allowedPath}에 리터럴이 없으면 목록에서 제거`);
  }
});
