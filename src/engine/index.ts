/**
 * engine/index.ts — the whole accounting engine, for the server AND the
 * browser bundle (public/app/static/js/engine.js, built by
 * scripts/build_engine.mjs). Keep it free of any Node or DOM import.
 */

export const ENGINE_VERSION = 1;

export * from "./errors";
export * from "./rational";
export * from "./currency";
export * from "./amount";
export * from "./allocate";
export * from "./settle";
export * from "./group";
