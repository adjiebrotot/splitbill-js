/**
 * next.config.mjs keeps `ws` out of the webpack bundle. Bundled, webpack turns
 * its optional `require("bufferutil")` into an empty module, ws takes that for
 * the native addon, and every WebSocket frame of 48+ bytes throws
 * "b.mask is not a function": every Neon transaction (writes, migrations)
 * fails in production while HTTP reads keep working.
 */
import { describe, it, expect } from "vitest";
import config from "../../next.config.mjs";

describe("next.config.mjs", () => {
  it("serves ws and the other runtime-only packages from node_modules", () => {
    expect(config.serverExternalPackages).toEqual(expect.arrayContaining(["ws", "pg", "@node-rs/bcrypt", "@napi-rs/canvas"]));
  });
});
