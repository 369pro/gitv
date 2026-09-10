# gitv

A live, byte-by-byte atlas of a **real Git repository**. 一个从磁盘 bytes 出发的 Git 可视化命令行工具。

TypeScript (strict) · Node.js ≥ 22 · Git ≥ 2.30 · macOS / Linux · no runtime dependencies.

## Run

```sh
git clone git@github.com:369pro/gitv.git
cd gitv
npm ci
npm run build
npm link
gitv /absolute/path/to/repository
```

For a quick classroom demo, or to pass a repository path through the helper:

```sh
./run.sh
./run.sh /absolute/path/to/repository
./run.sh /absolute/path/to/repository --port 4317 --no-open
```

With no repository argument, `run.sh` creates a temporary real Git repository and visualizes it. Options beginning with `-` are forwarded to `gitv`.

Or without installation:

```sh
npm run build
node dist/bin/gitv.js /absolute/path/to/repository
```

The browser opens automatically at `http://127.0.0.1:4317`. Run Git commands in a separate terminal; gitv observes changes without executing repository mutations. Stop the server with Ctrl+C. Use `--port` to override the default when needed.

```sh
gitv ./repo --no-open --port 4317
gitv ./repo --host 0.0.0.0             # explicitly share with the local network
gitv ./repo --interval 700 --history 80
npm test
node dist/scripts/demo.js             # creates a REAL disposable Git repo; prints its path
```

The server exposes repository data to anyone who can reach it when shared on a network. Its session token prevents casual cross-origin API calls; it is not user authentication. The default is loopback-only.

## Explore

- **History & refs**: commits, parent edges, branch/remote-tracking refs, HEAD, annotated tags, stash, detached HEAD. Drag nodes; drag the canvas to pan; scroll to zoom; Fit restores framing.
- **Objects & contents**: select a commit, open directories, inspect shared tree/blob identities. Cards contain text, image previews or binary byte histograms. Cards and working-file rows can be dragged within their panels.
- **Index & working tree**: separate staged/unstaged indicators. Open a file for HEAD/index/working-tree content and real Git diffs. Conflicts show base/ours/theirs stages, actual conflict markers and the commits behind each side.
- **Byte inspector**: disk path → raw hex → decompression → coloured fields → object relationships. Byte offsets and field highlights correspond to bytes actually read. No fabricated data or substitute repositories.
- **Classroom mode**: commit/tree/blob content is initially masked until its object inspector reaches the final step. Step manually or autoplay at 0.5×/1×/2×. Default browsing keeps the structure visible and inspection optional.
- **Rebase**: ordinary/interactive operation metadata, todo/done, conflict, continue/skip/abort; old and rewritten commits remain accessible through reflog. `rewritten-list` links are solid; equal `git patch-id --stable` links are inferred and dashed. No correspondence is invented for ambiguous squash/split/drop operations.
- **Live / pause / replay**: scrub snapshots observed during this server session. Playback never modifies Git. New nodes enter, ref movements animate and changed files flash. Switch between Chinese and English; Git terminology stays unchanged.

## What is actually parsed

`lib/bytes.ts` parses canonical commit/tree/tag bodies, index v2/v3/v4 (including prefix-compressed paths and conflict stages), ref/reflog text and delta copy/insert instructions.

`lib/objects.ts` reads loose zlib files directly. For packed objects it reads the real `.idx` fanout, object IDs and offsets (v1/v2 and 64-bit offsets), seeks into `.pack`, decodes the entry header, inflates data, recursively resolves OFS_DELTA/REF_DELTA, applies delta instructions and verifies the reconstructed object ID. Both SHA-1 and SHA-256 repositories are supported. A canonical header reconstructed for pack hashing is labelled as reconstructed, never presented as bytes stored in that pack.

`lib/repository.ts` uses Git only for discovery, status, history enumeration, ignored-file enumeration, diffs and patch IDs. Snapshot content and inspector provenance come from the filesystem. Commands use argument arrays, optional Git locks are disabled, and external diff/textconv are disabled. Working-tree symlinks are displayed as link text, not followed outside the repository.

`lib/server.ts` serves local assets and JSON/SSE using Node's HTTP module. `public/` is a dependency-free browser UI with CSS animations, a draggable SVG/HTML graph and a byte inspector. TypeScript compiles the CLI, backend, browser modules and tests into `dist/`; the build copies CSS/HTML alongside them. No CDN, external fonts or model service is required.

## Development

```sh
npm ci
npm run typecheck
npm run format:check
npm test
npm run test:package
```

`./run.sh` builds before starting. With a repository argument it inspects that repo;
otherwise it creates a temporary classroom repo (even when gitv itself is a Git repo).
For development, edit `.ts` source and rebuild/restart to pick up changes. `dist/` is
generated and ignored by Git. Relative imports use `.js` extensions for Node/browser ESM.

Shared domain types live in `lib/types.ts`. `public/api.ts` ties browser responses to
server types; `public/ui-types.ts` models inspector variants. Type checking supplements
the runtime bounds, checksum and path checks; it does not validate arbitrary disk bytes.
See [AGENTS.md](AGENTS.md) for contributor rules and completion checks.

`npm pack` builds a distributable tarball with compiled runtime code and static assets.
Install that tarball with `npm install -g /path/to/gitv-0.1.0.tgz`; consumers need Node/Git,
but no TypeScript compiler. This project has not been published to the npm registry.

## Boundaries

- Initial pages contain 40 commits, 120 working files and 60 entries per tree. Load more progressively grows the history/file windows; tree pages remain navigable. Only expand the history needed for the lesson; very large expanded graphs cost browser memory.
- A polling observer runs every 900 ms by default, does not overlap scans, and retries on the next tick after read errors. It observes states, not shell commands. A rapid rebase may finish between scans; intermediate states cannot be reconstructed reliably and are not invented.
- Up to 60 snapshots and approximately 64 MiB of captured working/metadata bytes are retained. Object content/provenance has a separate 64 MiB cache. Each working file captures its first 256 KiB per snapshot; live content can be paged beyond that. Historical ranges not captured or already evicted are explicitly unavailable. History is in-memory and does not survive server shutdown.
- Object decompression is capped at 64 MiB per object; larger objects report a limit instead of allocating unbounded memory. Text/hex pages and image previews avoid rendering full large blobs. Images over 2 MiB use byte views. Diffs use Git with a 32 MiB command-output cap.
- SHA-1/SHA-256, ordinary loose/packed refs, standard object stores and index v2–v4 are supported. Reftable, split/sparse index semantics, alternates, partial-clone lazy fetch, LFS payload resolution, submodule expansion and dedicated multi-worktree navigation are not implemented. Unsupported mandatory index extensions are visibly marked partial. Gitlinks remain identifiable.
- `--rebase-merges` is rendered as the actual resulting graph but has no dedicated lesson animation. Only states observed while running can be replayed. Inferred rewrite matching is bounded to 12 newly observed and 24 prior commits per transition.
- Obvious sensitive working filenames are masked in file views and can be explicitly revealed. This is a presentation safeguard, not a repository-wide secret scanner; object hashes/refs and deliberately inspected object bytes remain visible.
- Windows, exported recordings and cross-session replay are outside this first version.

## Sources

Binary parsers follow the official [Git pack format](https://git-scm.com/docs/gitformat-pack), [Git index format](https://git-scm.com/docs/gitformat-index) and [Git repository layout](https://git-scm.com/docs/gitrepository-layout). The spatial teaching reference is [Learn Git Branching](https://learngitbranching.js.org/?demo=&locale=zh_CN). Node decompression behaviour was checked against [Node.js zlib documentation](https://nodejs.org/api/zlib.html), including via Context7 MCP.

## Verification

`npm test` builds temporary real repositories and compares decoded objects against Git itself. It exercises both delta representations, SHA-256, index versions, same-size edits, stage/commit transitions, packed refs, annotated tags, stash, rebase conflict/abort/continue/skip and interactive actions, retained snapshots, path boundaries, corrupted data, API access and live SSE updates. Test fixtures are removed after each test; the optional classroom demo is retained for interactive use.
