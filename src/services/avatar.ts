/**
 * services/avatar.ts — a user's photo: normalised on the server, kept in
 * Vercel Blob. Whatever arrives (the page already sends a small JPEG) is
 * cropped to its centre square, drawn at AVATAR_SIDE and stored as WebP, so
 * every avatar in the app is the same small file. Without a photo the page
 * draws initials (ui.js avatarHtml); nothing is stored for that.
 */
import { fail } from "../errors";

export const AVATAR_SIDE = 256;
const AVATAR_QUALITY = 82;
const MAX_UPLOAD = 10 * 1024 * 1024;
const MIME_RE = /^image\/(jpeg|png|webp|heic|heif)$/;

export interface AvatarStore {
  put(pathname: string, bytes: Uint8Array, contentType: string): Promise<string>;
  del(url: string): Promise<void>;
}

const blobStore: AvatarStore = {
  async put(pathname, bytes, contentType) {
    const { put } = await import("@vercel/blob");
    const r = await put(pathname, Buffer.from(bytes), {
      access: "public", contentType, addRandomSuffix: true,
      cacheControlMaxAge: 365 * 24 * 60 * 60, token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return r.url;
  },
  async del(url) {
    const { del } = await import("@vercel/blob");
    await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
  },
};

let _store: AvatarStore | null = null;

/** Tests: swap Blob for an in-memory store (null puts Blob back). */
export function _setAvatarStore(s: AvatarStore | null): void {
  _store = s;
}

export function avatarStore(): AvatarStore | null {
  if (_store) return _store;
  return process.env.BLOB_READ_WRITE_TOKEN ? blobStore : null;
}

/** Centre square, AVATAR_SIDE on a side, WebP. Throws image_invalid when it is not a picture. */
export async function normalizeAvatar(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  if (!bytes?.length || bytes.length > MAX_UPLOAD || !MIME_RE.test(mime)) fail("image_invalid");
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  let img: Awaited<ReturnType<typeof loadImage>>;
  try {
    img = await loadImage(Buffer.from(bytes));
  } catch {
    fail("image_invalid");
  }
  const w = img.width, h = img.height;
  if (!(w > 0 && h > 0)) fail("image_invalid");
  const side = Math.min(w, h);
  const out = Math.min(AVATAR_SIDE, side);
  const canvas = createCanvas(out, out);
  const ctx = canvas.getContext("2d");
  // A transparent PNG would turn black in some viewers: give it a white ground.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out, out);
  ctx.drawImage(img as never, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
  return new Uint8Array(canvas.toBuffer("image/webp", AVATAR_QUALITY));
}
