import { describe, it, expect } from "vitest";

import { _normalizeSslMode } from "@/db";

describe("_normalizeSslMode — silences pg-connection-string SSL warning", () => {
  it("rewrites sslmode=require to verify-full (preserves current behavior)", () => {
    expect(
      _normalizeSslMode("postgresql://u:p@host-pooler:5432/db?sslmode=require"),
    ).toBe("postgresql://u:p@host-pooler:5432/db?sslmode=verify-full");
  });

  it("rewrites prefer and verify-ca too", () => {
    expect(_normalizeSslMode("postgres://h/db?sslmode=prefer")).toBe(
      "postgres://h/db?sslmode=verify-full",
    );
    expect(_normalizeSslMode("postgres://h/db?sslmode=verify-ca")).toBe(
      "postgres://h/db?sslmode=verify-full",
    );
  });

  it("is case-insensitive on the value", () => {
    expect(_normalizeSslMode("postgres://h/db?sslmode=REQUIRE")).toBe(
      "postgres://h/db?sslmode=verify-full",
    );
  });

  it("rewrites sslmode when it is not the first query param", () => {
    expect(
      _normalizeSslMode("postgres://h/db?application_name=ft&sslmode=require"),
    ).toBe("postgres://h/db?application_name=ft&sslmode=verify-full");
  });

  it("leaves warning-free modes untouched", () => {
    for (const mode of ["verify-full", "disable", "no-verify", "allow"]) {
      const s = `postgres://h/db?sslmode=${mode}`;
      expect(_normalizeSslMode(s)).toBe(s);
    }
  });

  it("leaves a connection string with no sslmode untouched", () => {
    const s = "postgres://u:p@host:5432/db";
    expect(_normalizeSslMode(s)).toBe(s);
  });

  it("does not touch a bucket named 'require' or unrelated params", () => {
    const s = "postgres://h/db?options=sslmode-require&sslmoderequire=1";
    expect(_normalizeSslMode(s)).toBe(s);
  });
});
