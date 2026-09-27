/**
 * services/receipt.ts: a bill's photo, the proof behind its numbers.
 *
 * Whatever arrives (the page already sends a small grey JPEG, bill.js
 * shrink()) is drawn inside the same pixel budget the AI reads at
 * (llm_client.ts imageScale) and stored as WebP, about 100 KB a receipt.
 * The Blob URL is random and never leaves the server: members see the photo
 * through GET receipt (actions.ts getReceipt), which checks membership.
 */
import { fail } from "../errors";
import { imageScale } from "./llm_client";

const RECEIPT_QUALITY = 70;
export const RECEIPT_MAX_UPLOAD = 10 * 1024 * 1024;
const MIME_RE = /^image\/(jpeg|png|webp|heic|heif)$/;

export interface ReceiptStore {
  put(pathname: string, bytes: Uint8Array, contentType: string): Promise<string>;
  get(url: string): Promise<Uint8Array | null>;
  del(url: string): Promise<void>;
}

const blobStore: ReceiptStore = {
  async put(pathname, bytes, contentType) {
    const { put } = await import("@vercel/blob");
    const r = await put(pathname, Buffer.from(bytes), {
      access: "public", contentType, addRandomSuffix: true,
      cacheControlMaxAge: 365 * 24 * 60 * 60, token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return r.url;
  },
  async get(url) {
    const r = await fetch(url);
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  },
  async del(url) {
    const { del } = await import("@vercel/blob");
    await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
  },
};

let _store: ReceiptStore | null = null;

/** Tests: swap Blob for an in-memory store (null puts Blob back). */
export function _setReceiptStore(s: ReceiptStore | null): void {
  _store = s;
}

export function receiptStore(): ReceiptStore | null {
  if (_store) return _store;
  return process.env.BLOB_READ_WRITE_TOKEN ? blobStore : null;
}

/** Inside the AI's pixel budget, WebP. Throws image_invalid when it is not a picture. */
export async function normalizeReceipt(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  if (!bytes?.length || bytes.length > RECEIPT_MAX_UPLOAD || !MIME_RE.test(mime)) fail("image_invalid");
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  let img: Awaited<ReturnType<typeof loadImage>>;
  try {
    img = await loadImage(Buffer.from(bytes));
  } catch {
    fail("image_invalid");
  }
  if (!(img.width > 0 && img.height > 0)) fail("image_invalid");
  const scale = imageScale(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // A transparent PNG would turn black in some viewers: give it a white ground.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img as never, 0, 0, w, h);
  return new Uint8Array(canvas.toBuffer("image/webp", RECEIPT_QUALITY));
}
