import { createSign } from "node:crypto";
import { canonicalJson, withoutSignature } from "./manifest-validation.mjs";

export function signingPrivateKey() {
  const pem = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM?.trim();
  if (!pem) {
    throw new Error("EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM is required for production data pack signatures");
  }
  return pem;
}

export function rsaSha256Signature(privateKey, value) {
  return createSign("RSA-SHA256").update(value).sign(privateKey).toString("base64url");
}

export function manifestSignatureValue(manifest) {
  return rsaSha256Signature(signingPrivateKey(), canonicalJson(withoutSignature(manifest)));
}
