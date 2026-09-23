/**
 * build_i18n.ts: write public/app/static/js/i18n-all.js from src/i18n.ts.
 * Checked in; tests/unit/i18n.test.ts fails when it is stale.
 *   npx tsx scripts/build_i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { allBundles } from "../src/i18n";

export const OUT = path.join(__dirname, "../public/app/static/js/i18n-all.js");

export function renderBundle(): string {
  return "/* Generated from src/i18n.ts by scripts/build_i18n.ts. Do not edit. */\n" +
    "window.__I18N_ALL__=" + JSON.stringify(allBundles()) + ";\n";
}

if (require.main === module) {
  const text = renderBundle();
  let old = "";
  try {
    old = readFileSync(OUT, "utf8");
  } catch {}
  if (old !== text) writeFileSync(OUT, text);
  console.log(`i18n-all.js ${old === text ? "unchanged" : "written"} (${text.length} bytes)`);
}
