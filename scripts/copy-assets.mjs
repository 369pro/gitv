import { copyFile, mkdir } from "node:fs/promises";
const target = new URL("../dist/public/", import.meta.url);
await mkdir(target, { recursive: true });
for (const file of ["index.html", "style.css"]) {
  await copyFile(
    new URL(`../public/${file}`, import.meta.url),
    new URL(file, target),
  );
}
