import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { git } from "../lib/repository.js";

const root = await mkdtemp(path.join(os.tmpdir(), "gitv-classroom-"));
await git(root, ["init", "-b", "main"]);
await git(root, ["config", "user.name", "Alex Chen"]);
await git(root, ["config", "user.email", "alex@example.test"]);
await writeFile(
  path.join(root, "README.md"),
  "# Little observatory\n\nA small place to watch things change.\n\nEvery object begins with bytes.\n",
);
await writeFile(path.join(root, ".gitignore"), "node_modules/\n.env\n");
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "Begin with a blank sky"]);
await mkdir(path.join(root, "src"));
await writeFile(
  path.join(root, "src", "sky.js"),
  'export const sky = {\n  color: "morning",\n  stars: 24,\n};\n',
);
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "Give the sky a little color"]);
await git(root, ["switch", "-c", "feature/stars"]);
await writeFile(
  path.join(root, "src", "stars.js"),
  'export function stars(count) {\n  return "✦".repeat(count);\n}\n',
);
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "Scatter stars across the canvas"]);
await git(root, ["switch", "main"]);
await writeFile(
  path.join(root, "palette.json"),
  JSON.stringify(
    { paper: "#fafaf7", ink: "#262b28", sun: "#ed6a43" },
    null,
    2,
  ) + "\n",
);
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "Choose a quieter palette"]);
await git(root, ["tag", "-a", "v0.1", "-m", "First light"]);
await git(root, [
  "merge",
  "feature/stars",
  "--no-ff",
  "-m",
  "Bring the stars home",
]);
await git(root, ["branch", "feature/night"]);
await writeFile(
  path.join(root, "src", "sky.js"),
  'export const sky = {\n  color: "evening",\n  stars: 48,\n};\n',
);
await git(root, ["add", "src/sky.js"]);
await writeFile(
  path.join(root, "src", "sky.js"),
  'export const sky = {\n  color: "midnight",\n  stars: 96,\n};\n',
);
await writeFile(
  path.join(root, "notes.md"),
  "## Next observation\n\n- Follow the moving HEAD\n- Unfold a tree\n- Read the bytes\n",
);
await writeFile(
  path.join(root, "signal.bin"),
  Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 17) % 256)),
);
await writeFile(path.join(root, ".env"), "DEMO_SECRET=not-a-real-secret\n");
console.log(root);
