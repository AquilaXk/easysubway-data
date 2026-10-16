import { createSign, generateKeyPairSync } from "node:crypto";

// 서명 라이브러리 테스트 전용 키쌍이다. 운영 키와 무관하며 프로세스마다 새로 만든다(저장소에 키 리터럴을 두지 않는다).
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export const testPrivateKeyPem = privateKey;
export const testPublicKeyPem = publicKey;

export function rsaSha256Signature(value) {
  return createSign("RSA-SHA256").update(value).sign(testPrivateKeyPem).toString("base64url");
}
