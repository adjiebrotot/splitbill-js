/**
 * errors.ts — the one result shape every action returns.
 *
 * Failures carry a stable `code` (an i18n key suffix, `err.<code>`) plus the
 * values its message needs, never a sentence: the web app translates on the
 * client, Telegram on the server, in the reader's language.
 */

export interface Ok<D> {
  ok: true;
  data: D;
}

export interface Err {
  ok: false;
  code: string;
  params: Record<string, string | number>;
  status: number;
}

export type Result<D> = Ok<D> | Err;

export function ok<D>(data: D): Ok<D> {
  return { ok: true, data };
}

export function err(code: string, params: Record<string, string | number> = {}, status = 400): Err {
  return { ok: false, code, params, status };
}

/** Thrown inside a transaction to roll it back and surface as an Err. */
export class ActionError extends Error {
  constructor(readonly code: string, readonly params: Record<string, string | number> = {}, readonly status = 400) {
    super(code);
    this.name = "ActionError";
  }
}

export function fail(code: string, params: Record<string, string | number> = {}, status = 400): never {
  throw new ActionError(code, params, status);
}
