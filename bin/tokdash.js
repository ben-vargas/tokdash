#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = resolve(packageRoot, "src/server/index.ts");

const child = spawn("bun", [serverEntry, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});

let spawnFailed = false;
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
const signalHandlers = new Map(
  forwardedSignals.map((signal) => [signal, () => child.kill(signal)]),
);

for (const [signal, handler] of signalHandlers) {
  process.on(signal, handler);
}

child.on("error", (error) => {
  spawnFailed = true;
  if (error.code === "ENOENT") {
    console.error(
      "TokDash requires the Bun runtime, but the `bun` executable was not found. Install Bun with `curl -fsSL https://bun.sh/install | bash` or visit https://bun.sh, then run TokDash again.",
    );
  } else {
    console.error(`TokDash could not start Bun: ${error.message}`);
  }
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  for (const [name, handler] of signalHandlers) {
    process.off(name, handler);
  }
  if (spawnFailed) return;
  if (signal !== null) {
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
    return;
  }
  process.exit(code ?? 1);
});
