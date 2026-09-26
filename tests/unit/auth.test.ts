/** Session cookie signing, password rules, and safe redirects. */
import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.SETUP_SECRET = "unit-test-secret";
});

describe("session cookie", () => {
  it("round-trips and rejects tampering", async () => {
    const { sessionValue, readSession } = await import("@/webapp/auth");
    const v = sessionValue("42", "ali", "id");
    expect(readSession(v)).toEqual({ user_id: "42", username: "ali", lang: "id" });
    const d = JSON.parse(Buffer.from(v, "base64").toString());
    const forged = Buffer.from(JSON.stringify({ ...d, uid: "43" })).toString("base64");
    expect(readSession(forged)).toBeNull();
    expect(readSession("garbage")).toBeNull();
    expect(readSession(null)).toBeNull();
  });

  it("changing only the unsigned language still verifies", async () => {
    const { sessionValue, readSession } = await import("@/webapp/auth");
    const d = JSON.parse(Buffer.from(sessionValue("1", "bob", "en"), "base64").toString());
    const v = Buffer.from(JSON.stringify({ ...d, lang: "id" })).toString("base64");
    expect(readSession(v)?.lang).toBe("id");
  });

  it("fails closed without SETUP_SECRET", async () => {
    const { readSession, sessionValue } = await import("@/webapp/auth");
    const v = sessionValue("1", "bob", null);
    const old = process.env.SETUP_SECRET;
    delete process.env.SETUP_SECRET;
    expect(readSession(v)).toBeNull();
    process.env.SETUP_SECRET = old;
  });
});

describe("helpers", () => {
  it("password rules", async () => {
    const { passwordProblem, hashPassword, verifyPassword } = await import("@/password");
    expect(passwordProblem("short!")).toBe("err.password_short");
    expect(passwordProblem("longenough")).toBe("err.password_special");
    expect(passwordProblem("long-enough")).toBeNull();
    const h = hashPassword("long-enough");
    expect(verifyPassword("long-enough", h)).toBe(true);
    expect(verifyPassword("nope", h)).toBe(false);
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
  });

  it("safeNext only allows same-site paths", async () => {
    const { safeNext } = await import("@/webapp/http");
    expect(safeNext("/app/g/ABC")).toBe("/app/g/ABC");
    expect(safeNext("//evil.com")).toBe("/app");
    expect(safeNext("/\\evil.com")).toBe("/app");
    expect(safeNext("https://evil.com")).toBe("/app");
    expect(safeNext(null)).toBe("/app");
  });

  it("toMinor refuses anything but an integer", async () => {
    const { toMinor } = await import("@/num");
    expect(toMinor("123")).toBe(123n);
    expect(toMinor(-5)).toBe(-5n);
    expect(() => toMinor("1.5")).toThrow();
    expect(() => toMinor("12abc")).toThrow();
    expect(() => toMinor(2 ** 60)).toThrow();
  });
});

describe("email provider", () => {
  it("counts as set up only with RESEND_API_KEY", async () => {
    const { emailConfigured } = await import("@/services/email_service");
    const had = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    expect(emailConfigured()).toBe(false);
    process.env.RESEND_API_KEY = "re_test";
    expect(emailConfigured()).toBe(true);
    if (had === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = had;
  });
});
