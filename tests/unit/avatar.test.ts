/**
 * Avatars: the server crops any picture to its centre square and stores one
 * small WebP; without a photo the page draws initials (ui.js).
 */
import { describe, it, expect } from "vitest";
import { AVATAR_SIDE, normalizeAvatar } from "@/services/avatar";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

async function png(w: number, h: number): Promise<Uint8Array> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const c = createCanvas(w, h);
  const x = c.getContext("2d");
  x.fillStyle = "#ff0000";
  x.fillRect(0, 0, w / 2, h);
  x.fillStyle = "#0000ff";
  x.fillRect(w / 2, 0, w / 2, h);
  return new Uint8Array(c.toBuffer("image/png"));
}

describe("avatar images", () => {
  it("crops the centre square and draws it at AVATAR_SIDE as WebP", async () => {
    const out = await normalizeAvatar(await png(1200, 600), "image/png");
    expect(Buffer.from(out.slice(8, 12)).toString("latin1")).toBe("WEBP");
    const { loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(Buffer.from(out));
    expect([img.width, img.height]).toEqual([AVATAR_SIDE, AVATAR_SIDE]);
  });

  it("never scales a small picture up", async () => {
    const { loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(Buffer.from(await normalizeAvatar(await png(80, 120), "image/png")));
    expect([img.width, img.height]).toEqual([80, 80]);
  });

  it("refuses what is not a picture", async () => {
    await expect(normalizeAvatar(new TextEncoder().encode("hello"), "image/png")).rejects.toMatchObject({ code: "image_invalid" });
    await expect(normalizeAvatar(await png(10, 10), "application/pdf")).rejects.toMatchObject({ code: "image_invalid" });
    await expect(normalizeAvatar(new Uint8Array(), "image/png")).rejects.toMatchObject({ code: "image_invalid" });
  });
});

describe("initials avatar (ui.js)", () => {
  const w: Record<string, any> = {};
  // A stub DOM: ui.js only wires listeners at load, and the avatar helpers touch none of it.
  const stub = (all: string) => new Proxy({}, { get: (_t, k) => (k === all ? () => [] : () => null) });
  runInNewContext(readFileSync("public/app/static/js/ui.js", "utf8"), {
    window: Object.assign(w, { addEventListener() {} }), document: stub("querySelectorAll"),
    navigator: {}, setTimeout, clearTimeout, console,
  });

  it("two letters: first and last word, or the first two of one word", () => {
    expect(w.initials("Jack Mo")).toBe("JM");
    expect(w.initials("Dwiki")).toBe("Dw");
    expect(w.initials("Albert")).toBe("Al");
    expect(w.initials("anna maria de souza")).toBe("AS");
    expect(w.initials("  (Budi)  ")).toBe("Bu");
    expect(w.initials("X")).toBe("X");
    expect(w.initials("Émile Zola")).toBe("ÉZ");
    expect(w.initials("")).toBe("?");
  });

  it("colour is stable for a key and one of the palette", () => {
    const a = w.avatarColor("u12");
    expect(w.avatarColor("u12")).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(w.AVATAR_COLORS);
    const seen = new Set(Array.from({ length: 50 }, (_, i) => w.avatarColor(`m${i}`)));
    expect(seen.size).toBe(w.AVATAR_COLORS);
  });

  it("a photo wins; initials are escaped", () => {
    expect(w.avatarHtml({ name: "Jo", url: "https://b.test/a.webp" })).toMatch(/^<img class="av" src="https:\/\/b\.test\/a\.webp"/);
    expect(w.avatarHtml({ name: "<b>", color: 2 })).toBe('<span class="av av-2" aria-hidden="true">B</span>');
    expect(w.avatarHtml({ name: "<>", color: 2, label: 'a"b' })).toBe('<span class="av av-2" role="img" aria-label="a&quot;b" title="a&quot;b">&lt;</span>');
  });
});
