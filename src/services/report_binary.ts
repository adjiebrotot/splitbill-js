/**
 * services/report_binary.ts: a ReportDoc drawn as PNG (@napi-rs/canvas) or
 * PDF (pdf-lib). One layout, two painters: the layout measures with the
 * painter's own font metrics and emits rows; PNG stacks them on one tall
 * image, PDF paginates them on A4. No arithmetic on money happens here.
 *
 * Heavy modules (Skia, pdf-lib, fonts) load only when a file is rendered
 * (dynamic import from the route). Fonts are Liberation Sans / Mono, read
 * from src/assets/fonts (traced by outputFileTracingIncludes).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReportDoc, Line } from "./report";

type Font = "sans" | "sansB" | "mono" | "monoB";
type RGB = [number, number, number];

const C = {
  bg: [240, 244, 255] as RGB,
  surface: [255, 255, 255] as RGB,
  text: [45, 52, 54] as RGB,
  muted: [91, 102, 112] as RGB,
  border: [224, 230, 240] as RGB,
  primary: [139, 184, 248] as RGB,
  primaryInk: [20, 53, 107] as RGB,
  openBg: [255, 246, 224] as RGB,
  openInk: [107, 78, 0] as RGB,
  okBg: [200, 247, 197] as RGB,
  okInk: [20, 83, 45] as RGB,
  stamp: [140, 29, 43] as RGB,
};

interface Painter {
  measure(s: string, f: Font, size: number): number;
  text(s: string, x: number, y: number, f: Font, size: number, color: RGB, align?: "left" | "right"): void;
  rect(x: number, y: number, w: number, h: number, color: RGB, radius?: number): void;
  line(x1: number, y1: number, x2: number, y2: number, color: RGB): void;
}

interface Row {
  h: number;
  draw: (p: Painter, y: number) => void;
  /** Keep with the next row across a page break (headings). */
  keep?: boolean;
}

const FONT_DIR = join(process.cwd(), "src", "assets", "fonts");
const FILES: Record<Font, string> = {
  sans: "LiberationSans-Regular.ttf",
  sansB: "LiberationSans-Bold.ttf",
  mono: "LiberationMono-Regular.ttf",
  monoB: "LiberationMono-Bold.ttf",
};
const _bytes = new Map<Font, Buffer>();
function fontBytes(f: Font): Buffer {
  if (!_bytes.has(f)) _bytes.set(f, readFileSync(join(FONT_DIR, FILES[f])));
  return _bytes.get(f)!;
}

function fit(p: Painter, s: string, f: Font, size: number, max: number): string {
  if (p.measure(s, f, size) <= max) return s;
  let out = s;
  while (out && p.measure(out + "…", f, size) > max) out = out.slice(0, -1);
  return out + "…";
}

/** Everything below the page header, as rows of known height. */
function layout(doc: ReportDoc, p: Painter, W: number, pad: number): Row[] {
  const rows: Row[] = [];
  const inner = W - pad * 2;

  // Title block.
  rows.push({
    h: 86,
    draw: (pp, y) => {
      pp.text("Split Bill", pad, y + 14, "sansB", 12, C.muted);
      const chip = doc.status;
      const cw = Math.min(pp.measure(chip, "sansB", 10) + 20, inner * 0.7);
      pp.rect(W - pad - cw, y + 2, cw, 20, doc.settled ? C.okBg : C.openBg, 10);
      pp.text(fit(pp, chip, "sansB", 10, cw - 16), W - pad - cw + 10, y + 16, "sansB", 10, doc.settled ? C.okInk : C.openInk);
      pp.text(fit(pp, doc.title, "sansB", 24, inner), pad, y + 54, "sansB", 24, C.text);
      pp.text(fit(pp, doc.subtitle, "sans", 13, inner), pad, y + 76, "sans", 13, C.muted);
    },
  });

  // Summary tiles.
  if (doc.summary.length) {
    rows.push({
      h: 78,
      draw: (pp, y) => {
        const n = doc.summary.length;
        const gap = 10;
        const tw = (inner - gap * (n - 1)) / n;
        doc.summary.forEach(([k, v], i) => {
          const x = pad + i * (tw + gap);
          pp.rect(x, y + 10, tw, 58, C.surface, 10);
          pp.text(fit(pp, k.toUpperCase(), "sansB", 9, tw - 24), x + 12, y + 30, "sansB", 9, C.muted);
          pp.text(fit(pp, v, "monoB", 13, tw - 24), x + 12, y + 54, "monoB", 13, C.text);
        });
      },
    });
  }

  for (const s of doc.sections) {
    rows.push({
      h: 36,
      keep: true,
      draw: (pp, y) => pp.text(s.heading.toUpperCase(), pad, y + 26, "sansB", 11, C.muted),
    });
    if (s.kind === "table") {
      // Column widths: figures take what they need, the name gets the rest.
      const sizes = s.columns.map((c, i) => Math.max(
        p.measure(c.toUpperCase(), "sansB", 9),
        ...s.rows.map((r) => p.measure(r[i], i === 0 ? "sans" : "mono", 11)),
      ));
      const figW = sizes.slice(1).map((w) => Math.min(w, inner * 0.3));
      const gap = 14;
      const nameW = Math.max(60, inner - 20 - figW.reduce((a, b) => a + b + gap, 0));
      const colX: number[] = [pad + 10];
      let x = pad + 10 + nameW;
      figW.forEach((w) => {
        x += gap + w;
        colX.push(x);
      });
      const cell = (pp: Painter, y: number, r: string[], head: boolean) => {
        r.forEach((c, i) => {
          const f: Font = head ? "sansB" : i === 0 ? "sans" : "mono";
          const size = head ? 9 : 11;
          const txt = head ? c.toUpperCase() : c;
          if (i === 0) pp.text(fit(pp, txt, f, size, nameW), colX[0], y, f, size, head ? C.muted : C.text);
          else pp.text(fit(pp, txt, f, size, figW[i - 1]), colX[i], y, f, size, head ? C.muted : C.text, "right");
        });
      };
      rows.push({
        h: 28,
        keep: true,
        draw: (pp, y) => {
          pp.rect(pad, y, inner, 28, C.surface, 0);
          cell(pp, y + 18, s.columns, true);
          pp.line(pad, y + 27, pad + inner, y + 27, C.border);
        },
      });
      s.rows.forEach((r, i) => {
        rows.push({
          h: 28,
          draw: (pp, y) => {
            pp.rect(pad, y, inner, 28, C.surface, 0);
            cell(pp, y + 18, r, false);
            if (i < s.rows.length - 1) pp.line(pad + 10, y + 27.5, pad + inner - 10, y + 27.5, C.border);
          },
        });
      });
    } else {
      s.lines.forEach((l: Line) => {
        rows.push({
          h: 26,
          draw: (pp, y) => {
            pp.rect(pad, y, inner, 26, C.surface, 0);
            const ind = l.indent ? 22 : 10;
            const rf: Font = l.bold ? "monoB" : "mono";
            const rw = l.right ? Math.min(pp.measure(l.right, rf, 11), inner * 0.6) : 0;
            const lf: Font = l.bold && !l.indent ? "sansB" : "sans";
            const color = l.muted ? C.muted : C.text;
            pp.text(fit(pp, l.text, lf, 11, inner - ind - rw - 24), pad + ind, y + 17, lf, 11, color);
            if (l.right) pp.text(fit(pp, l.right, rf, 11, rw), pad + inner - 10, y + 17, rf, 11, color, "right");
          },
        });
      });
    }
  }

  // Branding: "Made with splitbill.adjiebrotots.com", centred under a rule.
  rows.push({
    h: 52,
    draw: (pp, y) => {
      pp.line(pad, y + 18, pad + inner, y + 18, C.border);
      const lead = doc.footer + " ";
      const lw = pp.measure(lead, "sans", 11);
      const bw = pp.measure(doc.brand, "sansB", 11);
      const x = pad + (inner - lw - bw) / 2;
      pp.text(lead, x, y + 40, "sans", 11, C.muted);
      pp.text(doc.brand, x + lw, y + 40, "sansB", 11, C.primaryInk);
    },
  });
  return rows;
}

// ── PNG ─────────────────────────────────────────────────────────────────────

export async function renderPng(doc: ReportDoc): Promise<Uint8Array> {
  const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
  const fam: Record<Font, string> = { sans: "SBSans", sansB: "SBSansB", mono: "SBMono", monoB: "SBMonoB" };
  for (const f of Object.keys(fam) as Font[]) {
    if (!GlobalFonts.has(fam[f])) GlobalFonts.register(fontBytes(f), fam[f]);
  }
  const W = 540, PAD = 24, SCALE = 2;
  const probe = createCanvas(10, 10).getContext("2d");
  const measure = (s: string, f: Font, size: number) => {
    probe.font = `${size}px "${fam[f]}"`;
    return probe.measureText(s).width;
  };
  const rows = layout(doc, { measure, text() {}, rect() {}, line() {} }, W, PAD);
  const H = rows.reduce((h, r) => h + r.h, 0) + PAD;
  const canvas = createCanvas(W * SCALE, H * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const painter: Painter = {
    measure,
    text(s, x, y, f, size, color, align = "left") {
      ctx.font = `${size}px "${fam[f]}"`;
      ctx.fillStyle = css(color);
      ctx.textAlign = align;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(s, x, y);
    },
    rect(x, y, w, h, color, radius = 0) {
      ctx.fillStyle = css(color);
      ctx.beginPath();
      if (radius) ctx.roundRect(x, y, w, h, radius);
      else ctx.rect(x, y, w, h);
      ctx.fill();
    },
    line(x1, y1, x2, y2, color) {
      ctx.strokeStyle = css(color);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    },
  };
  ctx.fillStyle = css(C.bg);
  ctx.fillRect(0, 0, W, H);
  let y = PAD / 2;
  for (const r of rows) {
    r.draw(painter, y);
    y += r.h;
  }
  if (!doc.settled) {
    // A faint diagonal stamp: an unsettled report is never mistaken for final.
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-Math.PI / 7);
    const label = doc.status.split(" · ")[0];
    ctx.font = `10px "${fam.sansB}"`;
    const px = Math.min(44, (W * 0.8 * 10) / ctx.measureText(label).width);
    ctx.font = `${px}px "${fam.sansB}"`;
    ctx.fillStyle = "rgba(140,29,43,0.08)";
    ctx.textAlign = "center";
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
  return new Uint8Array(await canvas.encode("png"));
}

// ── PDF ─────────────────────────────────────────────────────────────────────

export async function renderPdf(doc: ReportDoc): Promise<Uint8Array> {
  const { PDFDocument, rgb, degrees } = await import("pdf-lib");
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${doc.title} · ${doc.subtitle}`);
  pdf.setProducer("Split Bill");
  const fonts = {
    sans: await pdf.embedFont(fontBytes("sans"), { subset: true }),
    sansB: await pdf.embedFont(fontBytes("sansB"), { subset: true }),
    mono: await pdf.embedFont(fontBytes("mono"), { subset: true }),
    monoB: await pdf.embedFont(fontBytes("monoB"), { subset: true }),
  };
  const PW = 595.28, PH = 841.89, PAD = 40;
  const measure = (s: string, f: Font, size: number) => fonts[f].widthOfTextAtSize(s, size);
  const rows = layout(doc, { measure, text() {}, rect() {}, line() {} }, PW, PAD);
  const col = (c: RGB) => rgb(c[0] / 255, c[1] / 255, c[2] / 255);

  let page = pdf.addPage([PW, PH]);
  const newPage = () => {
    page = pdf.addPage([PW, PH]);
    page.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: col(C.bg) });
  };
  const stamp = () => {
    if (doc.settled) return;
    const s = doc.status.split(" · ")[0];
    const th = (25 * Math.PI) / 180;
    const size = Math.min(54, (PW * 0.8) / fonts.sansB.widthOfTextAtSize(s, 1));
    const w = fonts.sansB.widthOfTextAtSize(s, size);
    // Rotation is about the text origin: back off half the width along the angle.
    page.drawText(s, {
      x: PW / 2 - (w / 2) * Math.cos(th), y: PH / 2 - (w / 2) * Math.sin(th),
      size, font: fonts.sansB, color: col(C.stamp), opacity: 0.07, rotate: degrees(25),
    });
  };
  page.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: col(C.bg) });
  const painter: Painter = {
    measure,
    text(s, x, y, f, size, color, align = "left") {
      const w = measure(s, f, size);
      page.drawText(s, { x: align === "right" ? x - w : x, y: PH - y, size, font: fonts[f], color: col(color) });
    },
    rect(x, y, w, h, color) {
      page.drawRectangle({ x, y: PH - y - h, width: w, height: h, color: col(color) });
    },
    line(x1, y1, x2, y2, color) {
      page.drawLine({ start: { x: x1, y: PH - y1 }, end: { x: x2, y: PH - y2 }, thickness: 0.6, color: col(color) });
    },
  };
  let y = PAD;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const need = r.keep && rows[i + 1] ? r.h + rows[i + 1].h : r.h;
    if (y + need > PH - PAD) {
      newPage();
      y = PAD;
    }
    r.draw(painter, y);
    y += r.h;
  }
  // The stamp goes on top of the content, on every page.
  for (const pg of pdf.getPages()) {
    page = pg;
    stamp();
  }
  return pdf.save();
}
