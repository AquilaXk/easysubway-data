#!/usr/bin/env node
import path from "node:path";

import { isMainModule } from "../lib/is-main-module.mjs";
import { publishKorailTimetableRaw } from "./publish-korail-metropolitan-timetable-raw.mjs";
import { prepareKorailTopologyRegistration, registerKorailRouteTopology } from "./register-korail-route-topology.mjs";

export function parseArgs(argv) {
  const mode = argv[0];
  const lastFlag = mode === "publish-and-register" ? "--operation-directory" : "--receipt";
  if (argv.length !== 7 || argv[1] !== "--repository-root" || argv[3] !== "--source-input"
    || argv[5] !== lastFlag) fail();
  const options = { mode, repositoryRoot: argv[2], sourceInputPath: argv[4],
    ...(mode === "publish-and-register" ? { operationDirectory: argv[6] } : { receiptPath: argv[6] }) };
  validateOptions(options);
  return options;
}

export async function runKorailTopologyRegistration(options, {
  prepare = prepareKorailTopologyRegistration,
  publish = publishKorailTimetableRaw,
  register = registerKorailRouteTopology,
  clock = () => new Date(),
  env = process.env,
} = {}) {
  validateOptions(options);
  const { mode, repositoryRoot, sourceInputPath, operationDirectory } = options;
  let receiptPath = options.receiptPath;
  if (mode === "publish-and-register") {
    const { preparation, sourceInput } = await prepare({ repositoryRoot, sourceInputPath, now: clock() });
    await publish({ preparation, collectionDirectory: sourceInput.collectionDirectory,
      operationDirectory, env, clock });
    receiptPath = path.join(operationDirectory, "receipt.json");
  }
  // 발행 이후 실패해도 영수증은 보존한다. 복구 명령은 수집·OCI를 다시 호출하지 않는다.
  return register({ repositoryRoot, sourceInputPath, receiptPath, now: clock() });
}

function validateOptions(options) {
  if (!options || !["publish-and-register", "register-published"].includes(options.mode)) fail();
  const last = options.mode === "publish-and-register" ? "operationDirectory" : "receiptPath";
  if (Object.keys(options).length !== 4
    || [options.repositoryRoot, options.sourceInputPath, options[last]]
      .some((value) => typeof value !== "string" || !path.isAbsolute(value))) fail();
}

function fail() { throw new Error("KORAIL_TOPOLOGY_REGISTRATION_ARGUMENTS"); }

export async function main(argv = process.argv.slice(2)) {
  const result = await runKorailTopologyRegistration(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) main().catch(() => {
  process.stderr.write("KORAIL_TOPOLOGY_REGISTRATION_FAILED\n");
  process.exitCode = 1;
});
