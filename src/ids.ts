/**
 * ids.ts — short random ids from an unambiguous alphabet (no 0/1/I/O).
 */
import { randomInt, randomBytes, createHash } from "node:crypto";

export const SAFE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function randomCode(len: number, chars = SAFE_CHARS): string {
  let out = "";
  for (let i = 0; i < len; i++) out += chars[randomInt(chars.length)];
  return out;
}

/** Group ids: 8 chars = 32^8 ~ 1.1e12, so a guess is not a practical attack. */
export function newGroupId(): string {
  return randomCode(8);
}

/** Invite codes are the only secret in a join link: longer. */
export function newInviteCode(): string {
  return randomCode(12);
}

export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
