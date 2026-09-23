/**
 * build_engine.mjs — bundle src/engine into the browser copy the bill form
 * previews with (window.SBEngine). The output is checked in; the unit test
 * tests/unit/engine_bundle.test.ts rebuilds it in memory and fails if the
 * checked-in file is stale. The server never trusts numbers from this copy.
 *
 *   node scripts/build_engine.mjs
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = path.join(root, "public/app/static/js/engine.js");

export async function buildEngine() {
  const r = await build({
    entryPoints: [path.join(root, "src/engine/index.ts")],
    bundle: true,
    format: "iife",
    globalName: "SBEngine",
    platform: "neutral",
    target: "es2020",
    minify: true,
    write: false,
    legalComments: "none",
    logLevel: "silent",
    banner: { js: "/* Generated from src/engine by scripts/build_engine.mjs. Do not edit. */" },
  });
  return r.outputFiles[0].text;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const text = await buildEngine();
  let old = "";
  try { old = readFileSync(OUT, "utf8"); } catch {}
  if (old !== text) writeFileSync(OUT, text);
  console.log(`engine.js ${old === text ? "unchanged" : "written"} (${text.length} bytes)`);
}
