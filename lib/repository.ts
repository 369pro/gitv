import type {
  Options,
  Ref,
  Operation,
  IndexData,
  Commit,
  Tag,
  WorkingFile,
  Snapshot,
  Mapping,
  Changes,
  Version,
  FileView,
} from "./types.js";
import { errorCode, errorMessage } from "./errors.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  readdir,
  lstat,
  realpath,
  readlink,
  open,
} from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ObjectStore } from "./objects.js";
import { hash, page, content, parseIndex, parseMetadata } from "./bytes.js";

const exec = promisify(execFile);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};
for (const name of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
])
  delete env[name];
const names = (b: Buffer) => b.toString("utf8").split("\0").filter(Boolean);
const sensitive = (p: string) =>
  /(^|\/)(\.env(?:\..*)?|id_(rsa|ed25519|ecdsa)|credentials(?:\..*)?|.*\.(pem|key|p12))$/i.test(
    p,
  );
export async function git(root: string, args: string[], optional = false) {
  try {
    const command = exec(
      "git",
      ["--no-pager", "-c", "core.quotePath=false", "-C", root, ...args],
      { env, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 15000 },
    );
    command.child.stdin?.end();
    return (await command).stdout;
  } catch (e) {
    if (optional) return Buffer.alloc(0);
    throw Error(
      (e instanceof Error && "stderr" in e ? String(e.stderr).trim() : "") ||
        errorMessage(e),
    );
  }
}
async function walk(dir: string, prefix = ""): Promise<string[]> {
  const result = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const name = prefix + e.name;
    if (e.isDirectory())
      result.push(...(await walk(path.join(dir, e.name), name + "/")));
    else if (e.isFile()) result.push(name);
  }
  return result;
}
interface WorkBytes {
  bytes: Buffer;
  size: number;
  offset: number;
  symlink?: boolean;
  directory?: boolean;
}
interface CapturedSnapshot extends Snapshot {
  _raw: Map<string, Buffer>;
  _captured: Map<string, WorkBytes>;
  _index: IndexData;
  _bytes: number;
}
export class Repository extends EventEmitter {
  root: string;
  gitdir: string;
  common: string;
  algorithm: string;
  objects: ObjectStore;
  snapshots: CapturedSnapshot[];
  current!: CapturedSnapshot;
  sequence: number;
  historyLimit: number;
  commitLimit: number;
  fileLimit: number;
  revealed: Set<string>;
  lastSignature: string;
  busy: boolean;
  timer?: ReturnType<typeof setInterval>;
  static async create(input: string, options: Options = {}) {
    const root = (
      await git(path.resolve(input), ["rev-parse", "--show-toplevel"])
    )
      .toString()
      .trim();
    const gitdir = (await git(root, ["rev-parse", "--absolute-git-dir"]))
      .toString()
      .trim();
    const common = path.resolve(
      root,
      (await git(root, ["rev-parse", "--git-common-dir"])).toString().trim(),
    );
    const algorithm = (await git(root, ["rev-parse", "--show-object-format"]))
      .toString()
      .trim();
    const repo = new Repository(root, gitdir, common, algorithm, options);
    await repo.refresh();
    return repo;
  }
  constructor(
    root: string,
    gitdir: string,
    common: string,
    algorithm: string,
    options: Options,
  ) {
    super();
    this.root = root;
    this.gitdir = gitdir;
    this.common = common;
    this.algorithm = algorithm;
    this.objects = new ObjectStore(path.join(common, "objects"), algorithm);
    this.snapshots = [];
    this.sequence = 0;
    this.historyLimit = options.history || 60;
    this.commitLimit = 40;
    this.fileLimit = 120;
    this.revealed = new Set();
    this.lastSignature = "";
    this.busy = false;
  }
  async refs() {
    const result: Ref[] = [],
      raw = new Map<string, Buffer>();
    const packedRaw = await readFile(
      path.join(this.common, "packed-refs"),
    ).catch((e) => {
      if (errorCode(e) === "ENOENT") return Buffer.alloc(0);
      throw e;
    });
    const packed = packedRaw.toString("utf8");
    raw.set("packed-refs", packedRaw);
    for (const line of packed.split("\n")) {
      const m = /^([a-f0-9]+) (refs\/.+)$/.exec(line);
      if (m) result.push({ name: m[2], oid: m[1], source: "packed-refs" });
    }
    for (const name of await walk(path.join(this.common, "refs"), "refs/")) {
      const bytes = await readFile(path.join(this.common, name));
      raw.set(name, bytes);
      const value = bytes.toString().trim();
      const old = result.findIndex((r) => r.name === name);
      if (old >= 0) result.splice(old, 1);
      result.push({
        name,
        oid: /^[0-9a-f]+$/.test(value) ? value : null,
        target: value.startsWith("ref: ") ? value.slice(5) : null,
        source: name,
      });
    }
    for (const name of [
      "HEAD",
      "ORIG_HEAD",
      "MERGE_HEAD",
      "REBASE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
    ]) {
      const bytes = await readFile(path.join(this.gitdir, name)).catch(
        () => null,
      );
      if (!bytes) continue;
      raw.set(name, bytes);
      const value = bytes.toString().trim();
      result.push({
        name,
        oid: /^[0-9a-f]+$/.test(value) ? value : null,
        target: value.startsWith("ref: ") ? value.slice(5) : null,
        source: name,
      });
    }
    for (let i = 0; i < 5; i++)
      for (const r of result)
        if (r.target)
          r.oid = result.find((t) => t.name === r.target)?.oid || null;
    return { result, raw };
  }
  async operations(raw: Map<string, Buffer>): Promise<Operation | null> {
    for (const dir of ["rebase-merge", "rebase-apply", "sequencer"]) {
      const dirpath = path.join(this.gitdir, dir);
      if (!(await lstat(dirpath).catch(() => null))?.isDirectory()) continue;
      const files: Record<string, string> = {};
      for (const name of [
        "head-name",
        "orig-head",
        "onto",
        "stopped-sha",
        "msgnum",
        "end",
        "next",
        "last",
        "git-rebase-todo",
        "done",
        "rewritten-list",
        "todo",
      ]) {
        const data = await readFile(path.join(dirpath, name)).catch(() => null);
        if (data) {
          files[name] = data.toString();
          raw.set(`${dir}/${name}`, data);
        }
      }
      return {
        type: dir.startsWith("rebase") ? "rebase" : "sequencer",
        directory: dir,
        files,
      };
    }
    return null;
  }
  async readWork(file: string, limit = 256 * 1024, offset = 0) {
    if (
      !file ||
      file.includes("\0") ||
      path.isAbsolute(file) ||
      file.split(/[\\/]/).some((p) => p === ".." || p === ".git")
    )
      throw Error("Invalid working tree path");
    const filename = path.join(this.root, file);
    const parent = await realpath(path.dirname(filename));
    if (parent !== this.root && !parent.startsWith(this.root + path.sep))
      throw Error("Path escapes working tree");
    const s = await lstat(filename);
    if (s.isSymbolicLink()) {
      const bytes = Buffer.from(await readlink(filename));
      return { bytes, size: bytes.length, symlink: true, offset: 0 };
    }
    if (!s.isFile())
      return { bytes: Buffer.alloc(0), size: 0, directory: true, offset: 0 };
    const h = await open(filename, "r");
    try {
      const bytes = Buffer.alloc(Math.min(limit, Math.max(0, s.size - offset)));
      const r = await h.read(bytes, 0, bytes.length, offset);
      return { bytes: bytes.subarray(0, r.bytesRead), size: s.size, offset };
    } finally {
      await h.close();
    }
  }
  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      const refs = await this.refs(),
        raw = refs.raw;
      const operation = await this.operations(raw);
      const indexRaw = await readFile(path.join(this.gitdir, "index")).catch(
        (e) => {
          if (errorCode(e) === "ENOENT") return null;
          throw e;
        },
      );
      let index: IndexData = { entries: [], fields: [], version: null };
      const warnings: string[] = [];
      if (indexRaw) {
        raw.set("index", indexRaw);
        try {
          index = parseIndex(indexRaw, this.algorithm);
          if (index.partial)
            warnings.push(
              "Unsupported mandatory index extension; displayed entries may be incomplete",
            );
        } catch (e) {
          warnings.push(errorMessage(e));
        }
      }
      const head = refs.result.find((r) => r.name === "HEAD");
      const [statusRaw, logRaw, untracked, reflogBytes] = await Promise.all([
        git(this.root, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]),
        git(
          this.root,
          [
            "rev-list",
            "--topo-order",
            `--max-count=${this.commitLimit}`,
            "--all",
            "--reflog",
            ...(head?.oid ? ["HEAD"] : []),
          ],
          true,
        ),
        git(this.root, ["ls-files", "--others", "--exclude-standard", "-z"]),
        readFile(path.join(this.gitdir, "logs/HEAD")).catch(() =>
          Buffer.alloc(0),
        ),
      ]);
      raw.set("logs/HEAD", reflogBytes);
      const changes = new Map<
          string,
          { status: string; from: string | null }
        >(),
        statusParts = names(statusRaw);
      for (let i = 0; i < statusParts.length; i++) {
        const s = statusParts[i],
          status = s.slice(0, 2),
          file = s.slice(3);
        changes.set(file, {
          status,
          from: /[RC]/.test(status) ? statusParts[++i] : null,
        });
      }
      const paths = [
        ...new Set([
          ...index.entries.map((e) => e.path),
          ...names(untracked),
          ...changes.keys(),
        ]),
      ].sort(
        (a, b) =>
          Number(changes.has(b)) - Number(changes.has(a)) || a.localeCompare(b),
      );
      const stats = await Promise.all(
        paths.map(async (p) => {
          const s = await lstat(path.join(this.root, p)).catch(() => null);
          return [p, s ? `${s.size}:${s.mtimeMs}:${s.ctimeMs}` : "missing"];
        }),
      );
      await this.objects.refresh();
      const signature = hash(
        Buffer.from(
          JSON.stringify([
            Array.from(raw, ([k, v]) => [k, hash(v)]),
            statusRaw.toString("hex"),
            stats,
            logRaw.toString(),
            this.objects.packSignature,
            this.commitLimit,
            this.fileLimit,
            [...this.revealed],
          ]),
        ),
      );
      if (signature === this.lastSignature) return;
      await this.objects.refresh();
      const commits: Commit[] = [];
      for (const oid of logRaw.toString().trim().split("\n").filter(Boolean)) {
        try {
          const o = await this.objects.read(oid);
          if (o.type !== "commit" || !o.parsed.tree || !o.parsed.parents)
            throw Error("Expected a commit with a tree");
          commits.push({
            oid,
            ...o.parsed,
            tree: o.parsed.tree,
            parents: o.parsed.parents,
            message: o.parsed.message || "",
            subject: o.parsed.subject || "",
            source: o.source,
            storage: o.storage,
          });
        } catch (e) {
          warnings.push(errorMessage(e));
        }
      }
      const tags: Tag[] = [];
      for (const ref of refs.result.filter((r) =>
        r.name.startsWith("refs/tags/"),
      )) {
        try {
          const o = await this.objects.read(ref.oid || "");
          if (o.type === "tag" && o.parsed.object)
            tags.push({
              oid: o.oid,
              name: ref.name,
              object: o.parsed.object,
              subject: o.parsed.message || "",
              source: o.source,
              storage: o.storage,
            });
        } catch (e) {
          warnings.push(errorMessage(e));
        }
      }
      const files: WorkingFile[] = [],
        captured = new Map<string, WorkBytes>();
      let capturedBytes = 0;
      for (const p of paths.slice(0, this.fileLimit)) {
        const stages = index.entries.filter((e) => e.path === p);
        const hidden = sensitive(p) && !this.revealed.has(p);
        let work = null;
        try {
          work = hidden ? null : await this.readWork(p);
        } catch (e) {
          if (errorCode(e) !== "ENOENT")
            warnings.push(`${p}: ${errorMessage(e)}`);
        }
        if (work && capturedBytes + work.bytes.length <= 16 * 1024 * 1024) {
          captured.set(p, work);
          capturedBytes += work.bytes.length;
        }
        const entry = stages.find((e) => e.stage === 0),
          preview = work ? content(work.bytes, 0, 480) : null;
        files.push({
          path: p,
          status: changes.get(p)?.status || "  ",
          from: changes.get(p)?.from,
          stages,
          oid: entry?.oid,
          hidden,
          size: work?.size ?? entry?.size ?? 0,
          preview,
          missing: !hidden && !work,
        });
      }
      const reflog = reflogBytes
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-80)
        .reverse()
        .map((line) => {
          const m = /^(\S+) (\S+) (.*)\t(.*)$/.exec(line);
          return m
            ? { old: m[1], oid: m[2], actor: m[3], message: m[4] }
            : { message: line };
        });
      const previous = this.current;
      const snapshot: CapturedSnapshot = {
        label: "",
        _raw: raw,
        _captured: captured,
        _index: index,
        _bytes: 0,
        id: ++this.sequence,
        time: Date.now(),
        root: this.root,
        name: path.basename(this.root),
        algorithm: this.algorithm,
        refs: refs.result,
        head,
        commits,
        tags,
        files,
        fileCount: paths.length,
        index: {
          version: index.version,
          count: index.count || 0,
          partial: index.partial,
        },
        reflog,
        operation,
        warnings: [...new Set(warnings)],
        packs: this.objects.packs.map((p) => ({
          name: path.basename(p.packfile),
          count: p.count,
        })),
        mappings: [],
        changes: previous
          ? this.compare(previous, { refs: refs.result, files, commits })
          : { added: [], removed: [], moved: [], files: [] },
      };
      if (operation?.files["rewritten-list"])
        for (const line of operation.files["rewritten-list"]
          .trim()
          .split("\n")) {
          const [old, oid] = line.split(" ");
          if (old && oid)
            snapshot.mappings.push({
              old,
              oid,
              evidence: "rewritten-list",
              exact: true,
            });
        }
      if (
        previous &&
        (operation?.type === "rebase" ||
          previous.operation?.type === "rebase" ||
          reflog[0]?.message.includes("rebase"))
      ) {
        snapshot.mappings.push(
          ...(await this.matchPatches(
            previous.commits,
            commits,
            snapshot.mappings,
          )),
        );
      }
      snapshot.label = previous
        ? JSON.stringify(previous.head) !== JSON.stringify(head)
          ? reflog[0]?.message || "HEAD"
          : snapshot.changes.files.length
            ? `${snapshot.changes.files.length} files`
            : snapshot.changes.moved.length
              ? "refs"
              : operation
                ? "rebase"
                : "objects / index"
        : "snapshot";
      snapshot._raw = raw;
      snapshot._captured = captured;
      snapshot._index = index;
      const headCommit = commits.find((c) => c.oid === head?.oid);
      if (headCommit?.tree)
        await this.objects.read(headCommit.tree).catch(() => null);
      snapshot._bytes =
        [...raw.values()].reduce((n, b) => n + b.length, 0) +
        [...captured.values()].reduce((n, w) => n + w.bytes.length, 0);
      this.snapshots.push(snapshot);
      this.current = snapshot;
      this.lastSignature = signature;
      let retained = this.snapshots.reduce((n, s) => n + s._bytes, 0);
      while (
        this.snapshots.length > 1 &&
        (this.snapshots.length > this.historyLimit ||
          retained > 64 * 1024 * 1024)
      )
        retained -= this.snapshots.shift()!._bytes;
      this.emit("snapshot", this.public(snapshot));
    } catch (e) {
      this.emit("warning", errorMessage(e));
      if (!this.current) throw e;
    } finally {
      this.busy = false;
    }
  }
  public(s: CapturedSnapshot): Snapshot {
    const { _raw, _captured, _index, _bytes, ...result } = s;
    return result;
  }
  get(id?: string | number | null) {
    const s = id
      ? this.snapshots.find((s) => s.id === Number(id))
      : this.current;
    if (!s) throw Error("Snapshot expired");
    return s;
  }
  compare(
    a: Snapshot,
    b: Pick<Snapshot, "commits" | "refs" | "files">,
  ): Changes {
    const old = new Set(a.commits.map((c) => c.oid)),
      now = new Set(b.commits.map((c) => c.oid));
    return {
      added: [...now].filter((x) => !old.has(x)),
      removed: [...old].filter((x) => !now.has(x)),
      moved: b.refs
        .filter((r) => a.refs.find((o) => o.name === r.name)?.oid !== r.oid)
        .map((r) => ({
          name: r.name,
          from: a.refs.find((o) => o.name === r.name)?.oid,
          to: r.oid,
        })),
      files: [
        ...new Set([
          ...a.files.map((f) => f.path),
          ...b.files.map((f) => f.path),
        ]),
      ].filter(
        (p) =>
          JSON.stringify(a.files.find((f) => f.path === p)) !==
          JSON.stringify(b.files.find((f) => f.path === p)),
      ),
    };
  }
  async patchId(oid: string): Promise<string | null> {
    const patch = await git(
      this.root,
      [
        "show",
        "--format=",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        oid,
        "--",
      ],
      true,
    );
    if (!patch.length) return null;
    return new Promise((resolve) => {
      const child = spawn("git", ["patch-id", "--stable"], { env });
      let result = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 5000);
      child.stdout.on("data", (b) => (result += b));
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(result.trim().split(" ")[0] || null);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(patch);
    });
  }
  async matchPatches(
    old: Commit[],
    now: Commit[],
    known: Mapping[],
  ): Promise<Mapping[]> {
    const added = now
        .filter((c) => !old.some((o) => o.oid === c.oid))
        .slice(0, 12),
      result: Mapping[] = [];
    if (!added.length) return result;
    const oldIds = await Promise.all(
      old
        .slice(0, 24)
        .map(async (c) => [c.oid, await this.patchId(c.oid)] as const),
    );
    for (const c of added) {
      const id = await this.patchId(c.oid),
        candidates = oldIds.filter(
          ([oid, p]) => oid !== c.oid && p && p === id,
        );
      if (candidates.length === 1 && !known.some((m) => m.oid === c.oid))
        result.push({
          old: candidates[0][0],
          oid: c.oid,
          evidence: "patch-id --stable",
          exact: false,
        });
    }
    return result;
  }
  async tree(oid: string, offset = 0) {
    const o = await this.objects.read(oid);
    const target =
      o.type === "commit" ? await this.objects.read(o.parsed.tree || "") : o;
    if (target.type !== "tree" || !target.parsed.entries)
      throw Error("Expected tree or commit");
    const entries = [];
    for (const e of target.parsed.entries.slice(offset, offset + 60)) {
      let preview = null,
        size = 0,
        warning = null;
      if (e.type === "blob" && !sensitive(e.name))
        try {
          const blob = await this.objects.read(e.oid);
          size = blob.body.length;
          preview = content(blob.body, 0, 360);
        } catch (error) {
          warning = errorMessage(error);
        }
      entries.push({ ...e, preview, size, warning, hidden: sensitive(e.name) });
    }
    return {
      oid: target.oid,
      source: target.source,
      entries,
      total: target.parsed.entries.length,
      offset,
    };
  }
  meta(name: string, id?: string | number | null, offset = 0) {
    const s = this.get(id),
      raw = s._raw.get(name);
    if (!raw) throw Error("Metadata not captured in this snapshot");
    const parsed =
      name === "index"
        ? {
            ...s._index,
            entries: s._index.entries.slice(0, 500),
            fields: s._index.fields.slice(0, 1500),
          }
        : parseMetadata(raw, name);
    return {
      name,
      source: path.join(
        name.startsWith("refs/") || name === "packed-refs"
          ? this.common
          : this.gitdir,
        name,
      ),
      raw: page(raw, offset),
      parsed,
    };
  }
  async resolvePath(commit: string | null | undefined, file: string) {
    if (!commit) return null;
    let object = await this.objects.read(commit);
    if (object.type === "commit")
      object = await this.objects.read(object.parsed.tree || "");
    const parts = file.split("/");
    for (let i = 0; i < parts.length; i++) {
      const entry = object.parsed.entries?.find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) return entry.oid;
      object = await this.objects.read(entry.oid);
    }
    return null;
  }
  async file(
    file: string,
    id?: string | number | null,
    offset = 0,
    reveal = false,
  ): Promise<FileView> {
    const s = this.get(id),
      live = s === this.current;
    let entry = s.files.find((f) => f.path === file);
    if (!entry && live) {
      const ignored = (await git(this.root, ["check-ignore", "--", file], true))
        .toString()
        .replace(/\n$/, "");
      if (ignored === file)
        entry = {
          path: file,
          hidden: sensitive(file),
          missing: false,
          status: "!!",
          stages: [],
          size: 0,
          preview: null,
        };
    }
    if (!entry) throw Error("File not in this snapshot page");
    if (sensitive(file) && !reveal)
      return { path: file, hidden: true, versions: [] };
    const versions: Version[] = [],
      headOid = await this.resolvePath(s.head?.oid, file).catch(() => null);
    const load = async (label: string, oid?: string | null) => {
      if (!oid || /^0+$/.test(oid)) {
        versions.push({ label, absent: true });
        return;
      }
      try {
        const o = await this.objects.read(oid);
        versions.push({
          label,
          oid,
          source: o.source,
          content: content(o.body, offset),
        });
      } catch (e) {
        versions.push({ label, oid, error: errorMessage(e) });
      }
    };
    await load("HEAD", headOid);
    const stages = s._index.entries.filter((e) => e.path === file);
    if (stages.some((e) => e.stage)) {
      for (const [stage, label] of [
        [1, "base · stage 1"],
        [2, "ours · stage 2"],
        [3, "theirs · stage 3"],
      ] as const)
        await load(label, stages.find((e) => e.stage === stage)?.oid);
    } else await load("index", stages.find((e) => e.stage === 0)?.oid);
    let work: WorkBytes | null | undefined = s._captured.get(file);
    if (
      s === this.current &&
      (reveal ||
        !work ||
        (offset + 8192 > work.bytes.length && offset < work.size))
    )
      work = await this.readWork(file, 65536, offset).catch(() => null);
    if (work) {
      const relative = Math.max(0, offset - (work.offset || 0)),
        c = content(work.bytes, relative);
      c.offset = offset;
      c.total = work.size;
      c.next =
        offset + Math.min(8192, work.bytes.length - relative) < work.size
          ? offset + 8192
          : null;
      if (relative >= work.bytes.length && work.size > work.bytes.length)
        versions.push({
          label: "working tree",
          error: "This byte range was not captured in the historical snapshot",
        });
      else
        versions.push({
          label: "working tree",
          source: path.join(this.root, file),
          content: c,
          symlink: work.symlink,
        });
    } else
      versions.push(
        !live && !entry.missing && !entry.hidden
          ? {
              label: "working tree",
              error:
                "Working bytes were not captured within this snapshot budget",
            }
          : { label: "working tree", absent: true },
      );
    const diff = live
      ? (
          await git(
            this.root,
            [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              "--",
              file,
            ],
            true,
          )
        ).toString()
      : null;
    const staged = live
      ? (
          await git(
            this.root,
            [
              "diff",
              "--cached",
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              "--",
              file,
            ],
            true,
          )
        ).toString()
      : null;
    return {
      path: file,
      versions,
      diff,
      staged,
      historical: !live,
      operation: s.operation,
      sides: {
        ours: s.head?.oid,
        theirs: s.refs.find(
          (r) =>
            r.name ===
            (s.operation?.type === "rebase" ? "REBASE_HEAD" : "MERGE_HEAD"),
        )?.oid,
      },
    };
  }
  async commitDiff(oid: string, parent = "") {
    const o = await this.objects.read(oid);
    if (o.type !== "commit" || !o.parsed.parents)
      throw Error("Expected commit");
    parent ||= o.parsed.parents[0] || "";
    if (parent && !o.parsed.parents.includes(parent))
      throw Error("Invalid parent");
    return {
      parents: o.parsed.parents,
      parent,
      diff: (
        await git(
          this.root,
          parent
            ? [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                parent,
                oid,
                "--",
              ]
            : [
                "show",
                "--format=",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                oid,
                "--",
              ],
        )
      ).toString(),
    };
  }
  watch(interval = 900) {
    this.timer = setInterval(() => this.refresh().catch(() => {}), interval);
    return () => clearInterval(this.timer);
  }
}
