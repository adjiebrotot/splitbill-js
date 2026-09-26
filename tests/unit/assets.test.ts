/**
 * Cache busting and the page contract, checked instead of remembered:
 *   - every ?v= is the content hash of its file, and sw.js CACHE follows;
 *   - the service worker precaches every page shell and every script a page loads;
 *   - pages carry no <style> of their own and no inline handlers that build
 *     HTML from JSON (CLAUDE.md), modals end in the primary button alone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { stampAll } from "../../scripts/stamp_assets";

const ROOT = path.join(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const pages = readdirSync(path.join(ROOT, "public/app/static/pages")).map((f) => "public/app/static/pages/" + f);

describe("static assets", () => {
  it("every ?v= matches its file (run: npx tsx scripts/stamp_assets.ts)", () => {
    expect(stampAll(false)).toEqual([]);
  });

  it("sw.js precaches every page shell and every local script and stylesheet", () => {
    const sw = read("public/sw.js");
    for (const p of pages) {
      expect(sw, p).toContain("/" + p.replace("public/", ""));
      for (const m of read(p).matchAll(/(?:src|href)="(\/app\/static\/(?:js|css)\/[^"?]+)\?v=/g)) {
        expect(sw, `${p} loads ${m[1]}`).toContain(m[1] + "?v=");
      }
    }
  });

  it("pages load the minified copy of every hand-written script and stylesheet", () => {
    for (const p of pages) {
      for (const m of read(p).matchAll(/(?:src|href)="\/app\/static\/(?:js|css)\/([^"?]+)\?v=/g)) {
        expect(["engine.js", "i18n-all.js"].includes(m[1]) || /\.min\.(js|css)$/.test(m[1]), `${p} loads ${m[1]}`).toBe(true);
      }
      expect(read(p), p).not.toContain("fonts.googleapis.com");
    }
  });

  it("every rewrite target exists and sw.js maps the same URLs", () => {
    const cfg = read("next.config.mjs");
    const sw = read("public/sw.js");
    for (const m of cfg.matchAll(/destination: "(\/app\/static\/pages\/[a-z]+\.html)"/g)) {
      expect(pages).toContain("public" + m[1]);
      expect(sw).toContain(m[1]);
    }
  });
});

describe("page contract (DESIGN-SYSTEM.md)", () => {
  it("pages hold no <style> block and no em dash", () => {
    for (const p of pages) {
      const s = read(p);
      expect(s.includes("<style"), p).toBe(false);
      expect(s.includes("—") || s.includes("&mdash;"), p).toBe(false);
    }
  });

  it("modals end in the primary alone, and close only via the head x", () => {
    for (const p of pages) {
      const s = read(p);
      for (const m of s.matchAll(/<div class="modal-actions">([\s\S]*?)<\/div>/g)) {
        expect(m[1], p).toContain("btn-primary");
        expect(m[1], p).not.toMatch(/common\.cancel/);
      }
      for (const m of s.matchAll(/<div class="modal-head">([\s\S]*?)<\/div>/g)) {
        expect(m[1], p).toContain("modal-close");
        expect(m[1], p).toContain("#i-x");
      }
    }
  });

  it("deletes go through confirmDialog", () => {
    const js = read("public/app/static/js/group.js");
    expect(js).toMatch(/confirmDialog\(t\('bill\.delete_confirm'\), \{ okLabel: t\('common\.delete'\) \}\)/);
  });

  it("no JSON.stringify inside an HTML attribute", () => {
    for (const f of readdirSync(path.join(ROOT, "public/app/static/js"))) {
      if (f === "engine.js" || f === "i18n-all.js" || f.includes(".min.")) continue;
      expect(read("public/app/static/js/" + f), f).not.toMatch(/="[^"]*' \+ JSON\.stringify/);
    }
  });
});
