/**
 * Every UI string exists in both languages, reads as Indonesian (not left in
 * English), carries no em dash, and every key or error code the code uses
 * has a string. The browser bundle is fresh.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { STRINGS, t, tf, normalizeLang } from "@/i18n";
import { renderBundle, OUT } from "../../scripts/build_i18n";

const ROOT = path.join(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const list = (dir: string) => readdirSync(path.join(ROOT, dir)).map((f) => path.join(dir, f));

// Same in both languages on purpose: brand names, codes, loanwords Indonesian uses as-is.
const SAME_OK = new Set([
  "app.name", "auth.email", "tg.title", "bill.item", "adj.tip", "bill.col_total", "bill.total",
  "bal.title", "rpt.balances", "bal.net", "rpt.col_net", "home.sort_az", "status.final", "rpt.final",
  "bill.view", "bill.col_what",
]);

describe("i18n", () => {
  it("every entry has both languages, and Indonesian is translated", () => {
    for (const [k, v] of Object.entries(STRINGS)) {
      expect(v.en, k).toBeTruthy();
      expect(v.id, k).toBeTruthy();
      if (!SAME_OK.has(k)) expect(v.id, `${k} left in English`).not.toBe(v.en);
    }
  });

  it("no em dash in any user-facing string", () => {
    for (const [k, v] of Object.entries(STRINGS)) {
      expect(v.en.includes("—") || v.id.includes("—"), k).toBe(false);
    }
  });

  it("keeps Bill as Bill in Indonesian, never Tagihan", () => {
    for (const [k, v] of Object.entries(STRINGS)) {
      expect(/tagihan/i.test(v.id), k).toBe(false);
    }
  });

  it("uses Akun for account", () => {
    for (const [k, v] of Object.entries(STRINGS)) expect(/rekening/i.test(v.id), k).toBe(false);
  });

  it("every key used by a page or script exists", () => {
    const used = new Set<string>();
    for (const f of list("public/app/static/pages")) {
      for (const m of read(f).matchAll(/data-i18n(?:-ph|-title|-tip|-aria)?="([^"]+)"/g)) used.add(m[1]);
    }
    for (const f of list("public/app/static/js")) {
      if (/engine\.js|i18n-all\.js/.test(f)) continue;
      for (const m of read(f).matchAll(/\bt\('([a-z_]+\.[a-z_.0-9]+)'/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !STRINGS[k]);
    expect(missing).toEqual([]);
  });

  it("every error code the server or engine can return has a message", () => {
    const codes = new Set<string>();
    const scan = (dir: string) => {
      for (const f of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) scan(p);
        else if (p.endsWith(".ts")) {
          const s = read(p);
          for (const m of s.matchAll(/\bfail\("([a-z_0-9]+)"/g)) codes.add(m[1]);
          for (const m of s.matchAll(/\berr\("([a-z_0-9]+)"/g)) codes.add(m[1]);
          for (const m of s.matchAll(/HINT = '([a-z_0-9]+)'/g)) codes.add(m[1]);
        }
      }
    };
    scan("src");
    const missing = [...codes].filter((c) => !c.startsWith("internal") && !STRINGS["err." + c]);
    expect(missing).toEqual([]);
  });

  it("t() fills params and falls back", () => {
    expect(t("err.item_unassigned", "id", { index: 2 })).toBe("Item 2 belum ada orangnya.");
    expect(tf("verify.desc", "en", "a@b.c")).toBe("We sent a 6-digit code to a@b.c.");
    expect(t("no.such.key")).toBe("no.such.key");
    expect(normalizeLang("ID-id")).toBe("id");
    expect(normalizeLang("fr")).toBe("en");
  });

  it("browser bundle is fresh (run: npx tsx scripts/build_i18n.ts)", () => {
    expect(readFileSync(OUT, "utf8")).toBe(renderBundle());
  });
});
