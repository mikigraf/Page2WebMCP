import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.flatMap(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", ".git", ".next"].includes(entry.name)) return files(path);
    return entry.isFile() ? [path] : [];
  }));
}

const sourceRoots = ["apps", "packages", "scripts"];
const sourceFiles = (await Promise.all(sourceRoots.map((root) => files(root).catch(() => [])))).flat(Infinity);
const violations = [];
for (const path of sourceFiles.filter((file) => /\.(?:ts|tsx|mjs)$/.test(file))) {
  const content = await readFile(path, "utf8");
  if (/\t/.test(content)) violations.push(`${path}: tabs are not permitted`);
  if (/[ \t]+$/m.test(content)) violations.push(`${path}: trailing whitespace`);
}

if (violations.length > 0) throw new Error(violations.join("\n"));
