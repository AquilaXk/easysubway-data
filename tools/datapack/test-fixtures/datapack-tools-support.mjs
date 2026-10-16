import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
