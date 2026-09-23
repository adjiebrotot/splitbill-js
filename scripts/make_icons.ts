/**
 * make_icons.ts: draws the app icon (a receipt torn in two on the brand
 * blue) at the PWA sizes. Full-bleed so it also works as a maskable icon.
 *   npx tsx scripts/make_icons.ts
 */
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
import path from "node:path";

function draw(size: number): Buffer {
  const c = createCanvas(size, size);
  const x = c.getContext("2d");
  const s = size / 512;
  x.fillStyle = "#5a91e8";
  x.fillRect(0, 0, size, size);
  // Two halves of one receipt, a small gap between them.
  const top = 128 * s, bottom = 384 * s, w = 108 * s, gap = 14 * s, cx = size / 2;
  const half = (left: number, flip: boolean) => {
    x.beginPath();
    x.moveTo(left, top);
    x.lineTo(left + w, top);
    const teeth = 4;
    const tw = w / teeth;
    x.lineTo(left + w, bottom);
    for (let i = teeth; i > 0; i--) {
      x.lineTo(left + (i - 0.5) * tw, bottom - 16 * s);
      x.lineTo(left + (i - 1) * tw, bottom);
    }
    x.closePath();
    x.fillStyle = "#ffffff";
    x.fill();
    x.fillStyle = "#8bb8f8";
    for (let r = 0; r < 4; r++) {
      const y = top + (44 + r * 44) * s;
      const len = (r === 3 ? 0.45 : 0.7) * w;
      x.fillRect(flip ? left + w - 20 * s - len : left + 20 * s, y, len, 12 * s);
    }
  };
  half(cx - gap / 2 - w, false);
  half(cx + gap / 2, true);
  return c.toBuffer("image/png");
}

const out = path.join(__dirname, "../public/app/static/icons");
for (const n of [192, 512]) writeFileSync(path.join(out, `icon-${n}.png`), draw(n));
writeFileSync(path.join(__dirname, "../public/favicon.png"), draw(64));
console.log("icons written");
