import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../../", import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), "gitv-package-test-"));
try {
  const packed = await exec(
    "npm",
    ["pack", "--pack-destination", temp, "--json", "--ignore-scripts"],
    { cwd: project },
  );
  const packages = JSON.parse(packed.stdout) as { filename: string }[];
  assert.equal(packages.length, 1);
  const install = path.join(temp, "install");
  await mkdir(install);
  await exec("npm", [
    "install",
    "--prefix",
    install,
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    path.join(temp, packages[0].filename),
  ]);
  const executable = path.join(install, "node_modules/.bin/gitv");
  assert.match((await exec(executable, ["--help"])).stdout, /--port 4317/);
  assert.equal((await exec(executable, ["--version"])).stdout.trim(), "0.1.0");
  const repo = path.join(temp, "repo");
  await mkdir(repo);
  await exec("git", ["-C", repo, "init", "-b", "main"]);
  const child = spawn(executable, [repo, "--port", "0", "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const exited = once(child, "exit");
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error(`Startup timeout: ${output} ${errors}`)),
        10000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error(`CLI exited ${code}: ${errors}`));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /app\.js/);
    for (const asset of [
      "app.js",
      "api.js",
      "errors.js",
      "i18n.js",
      "session.js",
      "style.css",
    ]) {
      const response = await fetch(`${url}/${asset}`);
      assert.equal(
        response.status,
        200,
        `${asset} must be packaged and served`,
      );
      assert.ok((await response.text()).length > 0);
    }
    assert.equal((await fetch(`${url}/api/snapshot`)).status, 403);
    assert.equal((await fetch(`${url}/../package.json`)).status, 404);
    console.log(
      "Package smoke passed: isolated install, executable bin, random port, all browser modules/assets and API protection.",
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
