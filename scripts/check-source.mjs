import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const forbidden = ["eval(", "exposedTo:", "Authorization: Bearer"];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.flatMap(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) return files(path);
    return entry.isFile() ? [path] : [];
  }));
}

const sourceFiles = (await files("packages").catch(() => [])).flat(Infinity);
for (const path of sourceFiles.filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))) {
  const content = await readFile(path, "utf8");
  if (forbidden.some((value) => content.includes(value))) throw new Error(`forbidden runtime string in ${path}`);
}
