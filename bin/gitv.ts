#!/usr/bin/env node
import type { Options } from "../lib/types.js";
import { errorMessage } from "../lib/errors.js";
import { spawn } from "node:child_process";
import { serve, DEFAULT_PORT } from "../lib/server.js";

const args = process.argv.slice(2),
  options: Options = {};
let root = ".",
  open = true;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    console.log(
      `gitv [repo] [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--no-open] [--interval 900] [--history 60]\n\nLive Git atlas · 真实仓库，逐字节解析\nNode.js 22+ · Git 2.30+ · read only`,
    );
    process.exit(0);
  }
  if (arg === "--version") {
    console.log("0.1.0");
    process.exit(0);
  }
  if (arg === "--no-open") open = false;
  else if (["--port", "--interval", "--history"].includes(arg)) {
    const n = Number(args[++i]);
    if (!Number.isInteger(n) || n < (arg === "--port" ? 0 : 1)) {
      console.error(`Invalid ${arg}`);
      process.exit(1);
    }
    options[arg.slice(2) as "port" | "interval" | "history"] = n;
  } else if (arg === "--host") options.host = args[++i];
  else if (arg.startsWith("-")) {
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  } else root = arg;
}
try {
  const app = await serve(root, options),
    url = `http://${options.host === "0.0.0.0" ? "localhost" : options.host || "127.0.0.1"}:${app.port}`;
  console.log(
    `\n  gitv  ◇  ${app.repo.root}\n  ${url}\n  Live · read only · Ctrl+C to stop\n`,
  );
  if (open) {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
    const child = spawn(
      cmd,
      process.platform === "win32" ? ["/c", "start", "", url] : [url],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
  }
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await app.close();
      process.exit(0);
    });
} catch (e) {
  console.error(`gitv: ${errorMessage(e)}`);
  process.exit(1);
}
