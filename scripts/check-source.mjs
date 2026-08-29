import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const forbidden = ["eval(", "exposedTo:", "Authorization: Bearer"];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.flatMap(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", ".git", ".next", "coverage"].includes(entry.name)) return files(path);
    return entry.isFile() ? [path] : [];
  }));
}

const sourceRoots = ["apps", "packages", "scripts"];
const sourceFiles = (await Promise.all(sourceRoots.map((root) => files(root).catch(() => [])))).flat(Infinity);
for (const path of sourceFiles.filter((file) => /\.(?:js|mjs|ts|tsx)$/.test(file) && file !== "scripts/check-source.mjs")) {
  const content = await readFile(path, "utf8");
  if (forbidden.some((value) => content.includes(value))) throw new Error(`forbidden runtime string in ${path}`);
}
