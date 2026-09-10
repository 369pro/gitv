import type { AddressInfo } from "node:net";
import type { Options } from "./types.js";
import { errorMessage } from "./errors.js";
function required(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (!value) throw Error(`Missing ${name}`);
  return value;
}
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Repository } from "./repository.js";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
export const DEFAULT_PORT = 4317;

export async function serve(root: string, options: Options = {}) {
  const repo = await Repository.create(root, options),
    clients = new Set<http.ServerResponse>(),
    token = randomBytes(24).toString("hex");
  const send = (event: string, data: unknown) => {
    for (const client of clients)
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  repo.on("snapshot", (s) => send("snapshot", s));
  repo.on("warning", (message) => send("warning", { message }));
  const server = http.createServer(async (req, res) => {
    const json = (body: unknown, code = 200) => {
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url || "/", "http://localhost");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );
      if (req.method !== "GET") return json({ error: "Read-only server" }, 405);
      if (url.pathname.startsWith("/api/")) {
        if (
          req.headers["x-gitv-token"] !== token &&
          url.searchParams.get("token") !== token
        )
          return json({ error: "Session token required" }, 403);
        const p = url.searchParams,
          offset = Math.max(0, Number(p.get("offset")) || 0);
        if (url.pathname === "/api/snapshot")
          return json(repo.public(repo.get(p.get("id"))));
        if (url.pathname === "/api/history")
          return json(
            repo.snapshots.map((s) => ({
              id: s.id,
              time: s.time,
              label: s.label,
            })),
          );
        if (url.pathname === "/api/object")
          return json(
            await repo.objects.inspect(required(p, "oid"), {
              offset,
              part: p.get("part") || "body",
            }),
          );
        if (url.pathname === "/api/tree")
          return json(await repo.tree(required(p, "oid"), offset));
        if (url.pathname === "/api/meta")
          return json(repo.meta(required(p, "name"), p.get("id"), offset));
        if (url.pathname === "/api/file")
          return json(
            await repo.file(
              required(p, "path"),
              p.get("id"),
              offset,
              p.get("reveal") === "1",
            ),
          );
        if (url.pathname === "/api/diff")
          return json(
            await repo.commitDiff(required(p, "oid"), p.get("parent") || ""),
          );
        if (url.pathname === "/api/more") {
          repo.commitLimit += 40;
          repo.fileLimit += 120;
          await repo.refresh();
          return json(repo.public(repo.current));
        }
        if (url.pathname === "/api/ignored") {
          const { git } = await import("./repository.js");
          const prefix = p.get("prefix");
          return json(
            (
              await git(repo.root, [
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                ...(prefix ? [] : ["--directory"]),
                "-z",
                ...(prefix ? ["--", prefix] : []),
              ])
            )
              .toString()
              .split("\0")
              .filter(Boolean)
              .slice(offset, offset + 300),
          );
        }
        if (url.pathname === "/api/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(
            `event: snapshot\ndata: ${JSON.stringify(repo.public(repo.current))}\n\n`,
          );
          clients.add(res);
          req.on("close", () => clients.delete(res));
          return;
        }
        return json({ error: "Not found" }, 404);
      }
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === "/session.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Cache-Control", "no-store");
        res.end(`export const token = ${JSON.stringify(token)};`);
        return;
      }
      const assets: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/api.js": ["api.js", "text/javascript"],
        "/errors.js": ["errors.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
        "/i18n.js": ["i18n.js", "text/javascript"],
      };
      const asset = assets[url.pathname];
      if (!asset) return json({ error: "Not found" }, 404);
      res.setHeader("Content-Type", asset[1] + "; charset=utf-8");
      res.end(await readFile(publicDir + asset[0]));
    } catch (e) {
      json({ error: errorMessage(e) }, 422);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      options.port ?? DEFAULT_PORT,
      options.host || "127.0.0.1",
      resolve,
    );
  });
  const stop = repo.watch(options.interval || 900);
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": heartbeat\n\n");
  }, 15000);
  return {
    server,
    repo,
    token,
    port: (server.address() as AddressInfo).port,
    async close() {
      stop();
      clearInterval(heartbeat);
      for (const c of clients) c.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
