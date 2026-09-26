/**
 * The receipt photo shortcut: a small plain JPEG (the page's shrink(), a
 * Telegram photo) is sent as it is; anything else is redrawn.
 */
import { describe, it, expect } from "vitest";
import { IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE, imageScale, jpegInfo, normalizeImage } from "@/services/llm_client";

async function jpeg(w: number, h: number): Promise<Uint8Array> {
  const { createCanvas } = await import("@napi-rs/canvas");
  return new Uint8Array(createCanvas(w, h).toBuffer("image/jpeg", 80));
}

/** Insert an APP1 Exif segment right after SOI. */
function withExif(b: Uint8Array): Uint8Array {
  const seg = [0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00];
  return new Uint8Array([b[0], b[1], ...seg, ...b.slice(2)]);
}

describe("receipt images", () => {
  it("reads a JPEG's size and EXIF flag from its header", async () => {
    const b = await jpeg(640, 480);
    expect(jpegInfo(b)).toEqual({ w: 640, h: 480, exif: false });
    expect(jpegInfo(withExif(b))).toEqual({ w: 640, h: 480, exif: true });
    expect(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegInfo(b.slice(0, 20))).toBeNull();
  });

  it("passes a small plain JPEG through, redraws a big one or one with EXIF", async () => {
    const small = await jpeg(1200, 900);
    expect((await normalizeImage(small, "image/jpeg")).bytes).toBe(small);
    const exif = withExif(small);
    expect((await normalizeImage(exif, "image/jpeg")).bytes).not.toBe(exif);
    const big = await jpeg(2400, 1000);
    const out = await normalizeImage(big, "image/jpeg");
    expect(jpegInfo(out.bytes)).toMatchObject({ w: 1600, h: 667 });
  });

  it("fits a phone photo into the pixel budget, never scales up", async () => {
    // 1200 x 900 is 1.08 MP: inside the budget. 1600 x 1200 is not.
    expect(imageScale(1200, 900)).toBe(1);
    const photo = await jpeg(4000, 3000);
    const info = jpegInfo((await normalizeImage(photo, "image/jpeg")).bytes)!;
    expect(Math.max(info.w, info.h)).toBeLessThanOrEqual(IMAGE_MAX_SIDE);
    expect(info.w * info.h).toBeLessThanOrEqual(IMAGE_MAX_PIXELS * 1.01);
    expect(info).toMatchObject({ w: 1265, h: 949 });
    const mid = await jpeg(1600, 1200);
    expect((await normalizeImage(mid, "image/jpeg")).bytes).not.toBe(mid);
  });
});
