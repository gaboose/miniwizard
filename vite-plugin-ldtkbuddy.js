// Runs ldtkbuddy on each ldtk json it finds, writing its output to a copy of
// the project's folder under Vite's cacheDir. Relative references in the page
// (e.g. "./ldtk.json", "./atlas.png") that have a processed copy there are
// pointed at it.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REF = /(["'])(\.\.?\/[^"']+)\1/g; // any quoted relative path

export default function ldtkbuddy(cmd = ["go", "run", "github.com/gaboose/ldtkbuddy@b88b51d"]) {
  let root, outRoot, serving;
  const mirror = (file) => path.join(outRoot, path.relative(root, file));
  return {
    name: "ldtkbuddy",
    configResolved(config) {
      root = config.root;
      outRoot = path.join(config.cacheDir, "ldtkbuddy");
      serving = config.command === "serve";
    },
    // Dev only: after the HTML request regenerates the mirror, Vite serves the
    // json import untransformed (raw JSON as a JS module), so convert it here.
    enforce: "pre",
    async load(id) {
      const file = id.split("?")[0];
      if (!serving || !file.endsWith(".json") || !file.startsWith(outRoot)) return;
      return "export default " + (await fs.readFile(file, "utf8"));
    },
    transformIndexHtml: {
      order: "pre",
      async handler(html, { filename, server }) {
        const dir = path.dirname(filename);
        for (const [, , ref] of html.matchAll(REF)) {
          const file = path.resolve(dir, ref);
          const data = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
          if (data?.__header__?.app !== "LDtk") continue;
          await run(cmd[0], [...cmd.slice(1), "-o", path.dirname(mirror(file)), file]);
        }
        // Vite's dev server caches modules and doesn't watch cacheDir, so bust it.
        const query = server ? `?t=${Date.now()}` : "";
        return html.replace(REF, (m, q, ref) => {
          const out = mirror(path.resolve(dir, ref));
          if (!existsSync(out)) return m;
          return q + "/" + path.relative(root, out).split(path.sep).join("/") + query + q;
        });
      },
    },
  };
}