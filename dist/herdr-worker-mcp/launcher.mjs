#!/usr/bin/env node

// mcp/worker/src/launcher.ts
import { mkdir, chmod } from "node:fs/promises";
import { join as join2 } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

// mcp/worker/src/state.ts
import { homedir } from "node:os";
import { join } from "node:path";
function stateDirectory(environment = process.env) {
  return join(environment.XDG_STATE_HOME || join(homedir(), ".local/state"), "herdr-core", "worker-mcp");
}

// mcp/worker/src/launcher.ts
try {
  process.umask(63);
  const directory = stateDirectory();
  await mkdir(directory, { recursive: true, mode: 448 });
  await chmod(directory, 448);
  const identity = createHash("sha256").update(JSON.stringify([process.env.HC_TERMINAL_ID, process.env.HC_PARENT])).digest("hex");
  const journal = join2(directory, `${identity}.json`);
  const child = spawn("flock", ["--exclusive", "--nonblock", "--no-fork", `${journal}.lock`, process.execPath, fileURLToPath(new URL("./server.mjs", import.meta.url)), journal], { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.once("error", () => {
    console.error("Cannot start MCP server: flock unavailable.");
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    if (code) console.error("MCP server failed or journal is locked.");
    process.exitCode = code ?? 1;
  });
} catch {
  console.error("Cannot initialize MCP state directory.");
  process.exitCode = 1;
}
