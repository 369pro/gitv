# gitv contributor guide

## Product and architecture

gitv is a read-only classroom viewer of a real local Git repository. Its defining
contract is provenance: disk path → actual bytes → decoding → fields → relationships.
Read README.md for supported formats and explicit limits before changing a parser or
adding Git features. Keep reconstructed canonical bytes distinguishable from on-disk
pack bytes, and inferred rebase mappings distinguishable from exact evidence.

- `lib/bytes.ts`: byte ranges, content previews, object/index/metadata and delta parsing.
- `lib/objects.ts`: disk access, loose/packed objects, hash verification and cache.
- `lib/repository.ts`: read-only Git queries, snapshots, working files, watch lifecycle.
- `lib/server.ts`: HTTP/SSE, session token and the explicit static-asset allowlist.
- `lib/types.ts`: serializable domain contracts. Buffer/Map/cache state stays server-side.
- `public/api.ts`: typed HTTP boundary; `public/ui-types.ts`: inspector state variants.
- `public/app.ts`: browser UI; `public/i18n.ts`: Chinese/English copy.
- `bin/gitv.ts`: CLI; `scripts/`: build assets and disposable classroom fixtures.

## Implementation rules

Use strict TypeScript and ESM with `.js` extensions in relative imports. Those imports
resolve to TypeScript during development and JavaScript in `dist/` after compilation.
Edit source, not generated files. Keep compiler checks enabled; use explicit domain
types, narrowing and runtime validation rather than `any`, `@ts-ignore` or `@ts-nocheck`.
Types cannot validate arbitrary disk bytes or JSON: validate bounds and formats at
untrusted inputs, and keep boundary assertions narrow and documented.

Preserve read-only behavior in the viewer: user Git mutations happen in their terminal.
Use argument arrays for Git subprocesses, bounded output/decompression, and retain path
and symlink checks. Mutating Git commands belong only in disposable test/demo repos.
Production has no npm runtime dependencies; justify additions by the capability they
provide. New browser modules must be added to the server asset allowlist.

Keep snapshot content independent of live disk reads, preserve history limits and the
session-only replay contract. Capture inspector state before awaiting requests; a late
response must not overwrite a newer or closed inspector. Watch shutdown must release
timers and SSE clients. Default host/port remain loopback and 4317.

Keep the light classroom layout, dragging, byte highlighting, and CSS change animations.
Add user-facing copy in both languages; retain Git terms. Prefer self-explanatory visuals
over extra tooltips. Represent missing/unsupported data explicitly instead of inventing it.

## Development and completion

1. Inspect affected modules and existing tests; install locked dependencies with `npm ci`.
2. Implement in source with normal formatting; add behavior tests when interfaces, parsing,
   packaging, or state transitions change. Build real temporary repos for Git fixtures.
3. Run `npm run typecheck`, `npm run format:check`, and `npm test`. Use `npm run format`
   to format changes. For CLI/build changes, run `npm pack` and smoke-test the installed
   tarball without devDependencies. For UI changes, exercise the served page in a browser.
4. Update README when startup, architecture or limits change. Report checks actually run
   and remaining limitations. Review staged files before committing; keep temporary repos,
   browser artifacts, generated output, credentials and local machine paths out of commits.

The build copies CSS/HTML beside compiled browser modules. Tests run compiled TypeScript.
`./run.sh` builds and creates a disposable demo by default; pass a repo path to inspect it.
CI should run the same checks on supported Node.js versions.

## Documentation lookup (Context7)

Use Context7 MCP for library/framework/SDK/API/CLI/cloud documentation, including setup,
configuration and version-specific debugging, even when the API seems familiar.
First call `resolve-library-id` with the official library name and task question; choose
the exact, reputable match (version-specific when requested). Then call `query-docs`
with the chosen ID and a focused question. Prefer it over web search for library docs.
It is not needed for pure refactoring, business logic debugging, code review, scripts
written from scratch or general programming concepts. If unavailable, state that and
use official primary documentation as fallback; do not claim a lookup occurred.
