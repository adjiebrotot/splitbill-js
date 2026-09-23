/**
 * engine/errors.ts — the one error type the engine throws.
 *
 * `code` is a stable machine key; the service layer maps it to an i18n string
 * (`err.<code>`) so the engine stays free of any language. `params` carries the
 * values the message needs (an item index, a difference, a currency).
 */
export class EngineError extends Error {
  readonly code: string;
  readonly params: Record<string, string | number>;

  constructor(code: string, params: Record<string, string | number> = {}) {
    super(code + (Object.keys(params).length ? " " + JSON.stringify(params) : ""));
    this.name = "EngineError";
    this.code = code;
    this.params = params;
  }
}

export function fail(code: string, params: Record<string, string | number> = {}): never {
  throw new EngineError(code, params);
}
