import type { TestContext } from "node:test";
import type { Snapshot } from "../lib/types.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Repository, git } from "../lib/repository.js";
import { parseIndex, applyDelta, oidFor } from "../lib/bytes.js";
import { serve, DEFAULT_PORT } from "../lib/server.js";

test("CLI and HTTP server default to the classroom port 4317", async () => {
  assert.equal(DEFAULT_PORT, 4317);
  const { stdout } = await exec(
    process.execPath,
    ["dist/bin/gitv.js", "--help"],
    { cwd: path.resolve(".") },
  );
  assert.match(stdout, /--port 4317/);
});
const exec = promisify(execFile);
async function fixture(t: TestContext, algorithm = "sha1") {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitv-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main", `--object-format=${algorithm}`]);
  await git(root, ["config", "user.name", "Gitv Test"]);
  await git(root, ["config", "user.email", "gitv@example.test"]);
  await writeFile(path.join(root, "hello.txt"), "hello\nworld\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "first"]);
  return root;
}
test("loose objects, raw header, tree entries, refs and index decode from disk", async (t) => {
  const root = await fixture(t),
    repo = await Repository.create(root);
  const head = present(repo.current.head).oid!,
    o = await repo.objects.inspect(head);
  assert.equal(o.type, "commit");
  assert.equal(o.computed, head);
  assert.equal(o.storage, "loose");
  assert.match(o.source, /objects/);
  assert.equal(o.parsed.message, "first\n");
  const tree = await repo.tree(head);
  assert.equal(tree.entries[0].name, "hello.txt");
  const blob = await repo.objects.read(tree.entries[0].oid);
  assert.equal(blob.body.toString(), "hello\nworld\n");
  assert.equal(repo.current.index.count, 1);
  const index = repo.meta("index").parsed;
  assert.ok("entries" in index);
  assert.equal(index.entries[0].oid, blob.oid);
  const headMeta = repo.meta("HEAD").parsed;
  assert.ok("text" in headMeta);
  assert.equal(headMeta.text, "ref: refs/heads/main\n");
});
test("index v2, v3, v4 long and UTF-8 names agree with git ls-files", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "中文"));
  await writeFile(path.join(root, "中文", "文档.txt"), "data");
  await writeFile(path.join(root, "中文", "文档二.txt"), "two");
  await git(root, ["add", "."]);
  for (const version of [2, 3, 4]) {
    await git(root, ["update-index", `--index-version=${version}`]);
    const raw = await readFile(path.join(root, ".git/index")),
      parsed = parseIndex(raw);
    const expected = (await git(root, ["ls-files", "-z"]))
      .toString()
      .split("\0")
      .filter(Boolean);
    assert.deepEqual(
      parsed.entries.map((e) => e.path),
      expected,
    );
    assert.equal(parsed.checksum, true);
  }
});
test("packed objects and real delta chains match git cat-file", async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 8; i++) {
    await writeFile(
      path.join(root, "large.txt"),
      Array.from(
        { length: 2000 },
        (_, n) => `line ${n}: ${n === i ? `revision ${i}` : "stable content"}`,
      ).join("\n"),
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", `version ${i}`]);
  }
  await git(root, ["gc", "--aggressive", "--prune=now"]);
  const repo = await Repository.create(root);
  const ids = (await git(root, ["rev-list", "--objects", "--all"]))
    .toString()
    .trim()
    .split("\n")
    .map((l) => l.split(" ")[0]);
  let deltas = 0;
  for (const oid of ids) {
    const o = await repo.objects.read(oid),
      actual = await git(root, ["cat-file", o.type, oid]);
    assert.deepEqual(o.body, actual);
    assert.equal(oidFor(o.type, o.body), oid);
    if (o.baseOid) {
      deltas++;
      assert.ok(present(o.instructions).length);
      assert.ok(present(o.indexEvidence).length);
    }
  }
  assert.ok(deltas > 0, "fixture must contain actual deltas");
});
test("SHA-256 repository object IDs and index checksums", async (t) => {
  const root = await fixture(t, "sha256"),
    repo = await Repository.create(root);
  assert.equal(present(repo.current.head).oid!.length, 64);
  assert.equal(repo.current.index.count, 1);
  const o = await repo.objects.inspect(present(repo.current.head).oid!);
  assert.equal(o.computed, o.oid);
  const tree = await repo.tree(o.oid);
  assert.equal(tree.entries[0].oid.length, 64);
  await git(root, ["gc"]);
  const fresh = await Repository.create(root);
  assert.equal((await fresh.objects.inspect(o.oid)).storage, "pack");
});
test("real add / commit changes preserve working tree snapshots and detect same-size edits", async (t) => {
  const root = await fixture(t),
    repo = await Repository.create(root);
  const first = repo.current.id;
  await writeFile(path.join(root, "hello.txt"), "HELLO\nworld\n");
  await repo.refresh();
  assert.equal(repo.current.files[0].status, " M");
  assert.ok(repo.current.changes.files.includes("hello.txt"));
  assert.equal(
    (await repo.file("hello.txt", first)).versions.at(-1)!.content!.text,
    "hello\nworld\n",
  );
  await git(root, ["add", "."]);
  await repo.refresh();
  assert.equal(repo.current.files[0].status, "M ");
  await git(root, ["commit", "-m", "second"]);
  await repo.refresh();
  assert.equal(repo.current.commits[0].subject, "second");
  assert.equal(repo.current.changes.added.length, 1);
});
test("conflict stages, rebase abort, packed refs, and stash are real", async (t) => {
  const root = await fixture(t);
  await git(root, ["switch", "-c", "feature"]);
  await writeFile(path.join(root, "hello.txt"), "feature\n");
  await git(root, ["commit", "-am", "feature"]);
  const original = (await git(root, ["rev-parse", "HEAD"])).toString().trim();
  await git(root, ["switch", "main"]);
  await writeFile(path.join(root, "hello.txt"), "main\n");
  await git(root, ["commit", "-am", "main"]);
  await git(root, ["switch", "feature"]);
  await git(root, ["rebase", "main"], true);
  const repo = await Repository.create(root);
  assert.equal(present(repo.current.operation).type, "rebase");
  assert.deepEqual(
    repo.current.files[0].stages.map((e) => e.stage),
    [1, 2, 3],
  );
  const file = await repo.file("hello.txt");
  assert.equal(file.versions.length, 5);
  assert.match(file.versions.at(-1)!.content!.text, /<<<<<<< HEAD/);
  await git(root, ["rebase", "--abort"]);
  await repo.refresh();
  assert.equal(present(repo.current.head).oid!, original);
  assert.equal(repo.current.operation, null);
  await git(root, ["tag", "-a", "v1", "-m", "release"]);
  await git(root, ["pack-refs", "--all"]);
  await repo.refresh();
  assert.ok(repo.current.refs.some((r) => r.source === "packed-refs"));
  const tag = repo.current.refs.find((r) => r.name === "refs/tags/v1");
  assert.equal((await repo.objects.read(present(tag).oid!)).type, "tag");
  await writeFile(path.join(root, "hello.txt"), "stash me");
  await git(root, ["stash", "push", "-m", "saved"]);
  await repo.refresh();
  assert.ok(repo.current.refs.find((r) => r.name === "refs/stash"));
});
test("rebase creates new commits and evidence-labelled patch-id mapping", async (t) => {
  const root = await fixture(t);
  await git(root, ["switch", "-c", "feature"]);
  await writeFile(path.join(root, "feature.txt"), "feature");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "feature"]);
  await git(root, ["switch", "main"]);
  await writeFile(path.join(root, "main.txt"), "main");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "advance"]);
  await git(root, ["switch", "feature"]);
  const repo = await Repository.create(root),
    old = present(repo.current.head).oid!;
  await git(root, ["rebase", "main"]);
  await repo.refresh();
  assert.notEqual(present(repo.current.head).oid!, old);
  assert.ok(repo.current.mappings.some((m) => m.old === old && !m.exact));
});
test("rebase --continue and --skip transition out of actual conflict state", async (t) => {
  for (const resolution of ["continue", "skip"]) {
    const root = await fixture(t);
    await git(root, ["switch", "-c", "topic"]);
    await writeFile(path.join(root, "hello.txt"), "topic\n");
    await git(root, ["commit", "-am", "topic"]);
    await git(root, ["switch", "main"]);
    await writeFile(path.join(root, "hello.txt"), "main\n");
    await git(root, ["commit", "-am", "main"]);
    await git(root, ["switch", "topic"]);
    await git(root, ["rebase", "main"], true);
    const repo = await Repository.create(root);
    assert.equal(present(repo.current.operation).type, "rebase");
    if (resolution === "continue") {
      await writeFile(path.join(root, "hello.txt"), "resolved\n");
      await git(root, ["add", "."]);
    }
    await git(root, ["-c", "core.editor=true", "rebase", `--${resolution}`]);
    await repo.refresh();
    assert.equal(repo.current.operation, null);
    assert.ok(
      repo.current.files.every((f) => f.stages.every((e) => e.stage === 0)),
    );
  }
});
test("interactive rebase edit, reword, squash, fixup and drop are observed from real state", async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 6; i++) {
    await writeFile(path.join(root, `step-${i}.txt`), `step ${i}`);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", `step ${i}`]);
  }
  const editor = path.join(root, ".git", "sequence-editor.mjs");
  await writeFile(
    editor,
    "import fs from 'node:fs'; const p=process.argv[2]; const actions=['edit','reword','squash','fixup','drop','pick']; let i=0; fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/^pick /gm,()=>actions[i++]+' '));",
  );
  await exec("git", ["-C", root, "rebase", "-i", "HEAD~6"], {
    env: {
      ...process.env,
      GIT_SEQUENCE_EDITOR: `node ${editor}`,
      GIT_EDITOR: "true",
    },
  });
  const repo = await Repository.create(root);
  assert.equal(present(repo.current.operation).type, "rebase");
  assert.match(present(repo.current.operation).files.done, /edit/);
  assert.match(
    present(repo.current.operation).files["git-rebase-todo"],
    /reword/,
  );
  await git(root, ["-c", "core.editor=true", "rebase", "--continue"]);
  await repo.refresh();
  assert.equal(repo.current.operation, null);
  const count = Number(
    (await git(root, ["rev-list", "--count", "HEAD"])).toString(),
  );
  assert.equal(count, 4);
});
test("REF_DELTA pack representation reconstructs actual Git blob bytes", async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 5; i++) {
    await writeFile(
      path.join(root, "versions.txt"),
      Array.from(
        { length: 1200 },
        (_, n) => `${n}: ${n === i ? "changed" : "unchanged text"}`,
      ).join("\n"),
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", `v${i}`]);
  }
  await git(root, [
    "pack-objects",
    "--all",
    "--window=50",
    "--depth=30",
    path.join(root, ".git/objects/pack/pack"),
  ]);
  await git(root, ["prune-packed"]);
  const repo = await Repository.create(root),
    ids = (await git(root, ["rev-list", "--objects", "--all"]))
      .toString()
      .trim()
      .split("\n")
      .map((l) => l.split(" ")[0]);
  let found = false;
  for (const oid of ids) {
    const o = await repo.objects.read(oid);
    if (o.storage === "REF_DELTA") {
      found = true;
      assert.deepEqual(o.body, await git(root, ["cat-file", o.type, oid]));
    }
  }
  assert.ok(found, "fixture must contain REF_DELTA");
});
test("large working file ranges, binary previews, and detached / unborn HEAD", async (t) => {
  const root = await fixture(t);
  const bytes = Buffer.alloc(400000, 65);
  await writeFile(path.join(root, "big.txt"), bytes);
  await writeFile(
    path.join(root, "binary.bin"),
    Buffer.from([0, 1, 2, 3, 4, 5]),
  );
  const repo = await Repository.create(root);
  const range = await repo.file("big.txt", null, 270000);
  assert.equal(range.versions.at(-1)!.content!.total, 400000);
  assert.equal(range.versions.at(-1)!.content!.text.length, 8192);
  assert.equal(
    (await repo.file("binary.bin")).versions.at(-1)!.content!.binary,
    true,
  );
  await git(root, ["switch", "--detach"]);
  await repo.refresh();
  assert.equal(present(repo.current.head).target, null);
  const empty = await mkdtemp(path.join(os.tmpdir(), "gitv-test-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await git(empty, ["init", "-b", "main"]);
  const unborn = await Repository.create(empty);
  assert.equal(unborn.current.commits.length, 0);
  assert.equal(present(unborn.current.head).target, "refs/heads/main");
});
test("cached object provenance moves from loose to pack after gc", async (t) => {
  const root = await fixture(t),
    repo = await Repository.create(root),
    oid = present(repo.current.head).oid!;
  assert.equal((await repo.objects.inspect(oid)).storage, "loose");
  await git(root, ["gc", "--prune=now"]);
  await repo.refresh();
  assert.equal((await repo.objects.inspect(oid)).storage, "pack");
  assert.ok(repo.current.packs.length);
});
test("ignored sensitive files require explicit content reveal", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, ".gitignore"), ".env\n");
  await writeFile(path.join(root, ".env"), "EXAMPLE_TOKEN=test-only\n");
  const repo = await Repository.create(root);
  assert.equal((await repo.file(".env")).hidden, true);
  const revealed = await repo.file(".env", null, 0, true);
  assert.match(revealed.versions.at(-1)!.content!.text, /EXAMPLE_TOKEN/);
  assert.ok(
    !JSON.stringify(repo.public(repo.current)).includes("EXAMPLE_TOKEN"),
  );
});
test("malformed delta, index checksum, missing object, and escaping symlink report errors", async (t) => {
  assert.throws(
    () => applyDelta(Buffer.from("x"), Buffer.from([1, 2, 0])),
    /Invalid/,
  );
  const root = await fixture(t),
    repo = await Repository.create(root);
  const bytes = await readFile(path.join(root, ".git/index"));
  bytes[20] ^= 1;
  assert.throws(() => parseIndex(bytes), /checksum/);
  await assert.rejects(repo.readWork("../no"), /Invalid/);
  await symlink(os.tmpdir(), path.join(root, "external"));
  await assert.rejects(repo.readWork("external/outside"), /escapes/);
  await assert.rejects(repo.objects.read("0".repeat(40)), /missing/);
});
test("HTTP serves UI, protects API, SSE publishes actual changes, remains read-only", async (t) => {
  const root = await fixture(t),
    app = await serve(root, { port: 0, interval: 100 });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`,
    headers = { "X-Gitv-Token": app.token };
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(base + "/api/snapshot")).status, 403);
  assert.equal(
    (await fetch(base + "/api/snapshot", { headers, method: "POST" })).status,
    405,
  );
  const controller = new AbortController(),
    response = await fetch(`${base}/api/events?token=${app.token}`, {
      signal: controller.signal,
    }),
    reader = present(response.body).getReader();
  const initial = await reader.read();
  assert.match(
    Buffer.from(present(initial.value)).toString(),
    /event: snapshot/,
  );
  const wait = new Promise<Snapshot>((resolve) =>
    app.repo.once("snapshot", resolve),
  );
  await writeFile(path.join(root, "hello.txt"), "changed");
  const changed = await Promise.race([
    wait,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(Error("watch timeout")), 4000),
    ),
  ]);
  assert.equal(changed.files[0].status, " M");
  controller.abort();
});

function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
