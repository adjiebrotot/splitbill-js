/**
 * stamp_assets.ts: content-hash cache busting, done by a script instead of by
 * hand. Every reference to "/app/static/<file>?v=<anything>" in the pages, the
 * static JS/CSS and public/sw.js is rewritten to "?v=<sha256[0:8] of file>".
 * Repeats until nothing changes (ui.js names icons.svg, pages name ui.js).
 * The service worker's CACHE name is derived from all of its stamped URLs, so
 * any asset change evicts the old precache.
 *
 *   npx tsx scripts/stamp_assets.ts          write
 *   npx tsx scripts/stamp_assets.ts --check  exit 1 if anything is stale
 * tests/unit/assets.test.ts runs the check.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "public");
const REF = /(\/app\/static\/[A-Za-z0-9_./-]+)\?v=[A-Za-z0-9@._-]*/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(html|js|css|svg|json)$/.test(n)) out.push(p);
  }
  return out;
}

function hashOf(urlPath: string): string {
  const file = path.join(PUB, urlPath);
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 8);
}

function stampText(text: string): string {
  return text.replace(REF, (_m, p: string) => `${p}?v=${hashOf(p)}`);
}

function stampCache(sw: string): string {
  const refs = [...sw.matchAll(REF)].map((m) => m[0]).sort().join("\n");
  const v = createHash("sha256").update(refs).digest("hex").slice(0, 8);
  return sw.replace(/const CACHE = '[^']*';/, `const CACHE = 'sb-${v}';`);
}

export function stampAll(write: boolean): string[] {
  const files = [...walk(path.join(PUB, "app")), path.join(PUB, "sw.js")];
  const changed = new Set<string>();
  for (let pass = 0; pass < 6; pass++) {
    let any = false;
    for (const f of files) {
      const old = readFileSync(f, "utf8");
      let next = stampText(old);
      if (f.endsWith("sw.js")) next = stampCache(next);
      if (next !== old) {
        any = true;
        changed.add(path.relative(ROOT, f));
        if (!write) return [...changed];
        writeFileSync(f, next);
      }
    }
    if (!any) break;
  }
  return [...changed];
}

if (require.main === module) {
  const check = process.argv.includes("--check");
  const changed = stampAll(!check);
  if (check && changed.length) {
    console.error("stale asset versions in: " + changed.join(", ") + "\nrun: npx tsx scripts/stamp_assets.ts");
    process.exit(1);
  }
  console.log(changed.length ? "stamped: " + changed.join(", ") : "all asset versions current");
}
