import { spawn } from "node:child_process";

const TIMEOUT_MS = 15_000;
const CHILD_ENV_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "LANG",
  "LC_ALL",
]);

function childEnvironment(env) {
  const childEnv = {};
  for (const name of CHILD_ENV_NAMES) {
    if (typeof env?.[name] === "string") childEnv[name] = env[name];
  }
  return childEnv;
}

export async function syncGhSecret({
  secretName,
  ghRepository,
  environment,
  serviceKey,
  failureMessage,
  env,
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const args = ["secret", "set", secretName, "--repo", ghRepository];
  if (environment !== undefined) args.push("--env", environment);

  let child;
  try {
    child = spawnImpl("gh", args, {
      env: childEnvironment(env),
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: TIMEOUT_MS,
    });
  } catch {
    throw new Error(failureMessage);
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const finish = (succeeded) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeoutImpl(timeout);
      if (succeeded) resolve();
      else reject(new Error(failureMessage));
    };
    if (child == null
      || typeof child.once !== "function"
      || child.stdin == null
      || typeof child.stdin.end !== "function") {
      finish(false);
      return;
    }
    const fail = () => finish(false);
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (code === 0 && signal == null) finish(true);
      else fail();
    });
    child.stdin.once?.("error", fail);
    try {
      timeout = setTimeoutImpl(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The public result remains sanitized if process termination fails.
        }
        fail();
      }, TIMEOUT_MS);
    } catch {
      fail();
      return;
    }
    try {
      child.stdin.end(serviceKey);
    } catch {
      fail();
    }
  });
}
