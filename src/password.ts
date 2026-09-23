/**
 * password.ts — password hashing and rules. Copied from finance-tracker
 * (native @node-rs/bcrypt, cost 12).
 */
import { hashSync, verifySync } from "@node-rs/bcrypt";

const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string): string {
  return hashSync(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hashed: string): boolean {
  try {
    return verifySync(plain, hashed);
  } catch {
    return false;
  }
}

const _SPECIALS = "!@#$%^&*()-_=+[]{}|;:',.<>?/`~";

/** Returns an i18n key when the password is too weak, else null. */
export function passwordProblem(pwd: string): string | null {
  if (typeof pwd !== "string" || pwd.length < 8) return "err.password_short";
  if (pwd.length > 200) return "err.password_long";
  for (const c of pwd) if (_SPECIALS.includes(c)) return null;
  return "err.password_special";
}
