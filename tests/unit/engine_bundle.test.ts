/** I8: the browser engine bundle is exactly what src/engine builds to today. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildEngine, OUT } from "../../scripts/build_engine.mjs";

describe("engine bundle", () => {
  it("is fresh (run `node scripts/build_engine.mjs` after editing src/engine)", async () => {
    expect(readFileSync(OUT, "utf8")).toBe(await buildEngine());
  });

  it("runs in a plain script context and matches the server", async () => {
    const code = readFileSync(OUT, "utf8");
    const g: Record<string, any> = {};
    new Function("window", "self", code + ";window.SBEngine=SBEngine;")(g, g);
    const E = g.SBEngine;
    const order = new Map([["a", 1], ["b", 2], ["c", 3]]);
    const alloc = E.allocate({ payer: "a", mode: "even", total: 1000n, participants: [{ member: "a" }, { member: "b" }, { member: "c" }] }, order);
    expect(Object.fromEntries(alloc.shares)).toEqual({ a: 334n, b: 333n, c: 333n });
    expect(typeof E.ENGINE_VERSION).toBe("number");
  });
});
