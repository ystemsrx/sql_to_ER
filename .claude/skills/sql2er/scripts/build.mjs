// Bundles the headless engine (engine/cli.ts + the app's parser/builder/layout)
// into one self-contained Node ESM file: scripts/sql2er-agent.mjs.
// Run from the repo root:  node .claude/skills/sql2er/scripts/build.mjs
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../"); // scripts -> sql2er -> skills -> .claude -> repo root
const src = resolve(root, "src");

await esbuild.build({
  entryPoints: [resolve(here, "engine/cli.ts")],
  outfile: resolve(here, "sql2er-agent.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  // The engine imports the app's pure modules as @app/*; map that to ../src.
  alias: { "@app": src },
  legalComments: "none",
  logLevel: "info",
});

process.stdout.write("built sql2er-agent.mjs\n");
