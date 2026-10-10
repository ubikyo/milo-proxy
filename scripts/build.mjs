// Bundles the proxy into a single file, ws included: what is deployed is
// dist/milo-proxy.mjs alone, with no "npm install" on the site's machine.

import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racine = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifeste = JSON.parse(await fs.readFile(path.join(racine, "package.json"), "utf8"));

await build({
  entryPoints: [path.join(racine, "src", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(racine, "dist", "milo-proxy.mjs"),
  sourcemap: true,
  // Messages are in French: the file must remain UTF-8.
  charset: "utf8",
  define: { __VERSION__: JSON.stringify(manifeste.version) },
  // ws's optional native helpers: absent, it uses its own code.
  external: ["bufferutil", "utf-8-validate"],
  // ws is CommonJS: "require" must exist in the ES module.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

console.log(`Milo Proxy ${manifeste.version} empaqueté dans dist/milo-proxy.mjs`);
