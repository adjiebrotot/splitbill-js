/** Admin console sign-in: the token, its expiry, and the route guard. No DB. */
import { describe, it, expect, beforeEach } from "vitest";
import { adminToken, checkAdminPassword, verifyAdminToken } from "@/webapp/admin_auth";
import { handleApi } from "@/webapp/api_routes";
import "@/webapp/admin_routes";

const PW = "correct horse battery staple";

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { host: "sb.test" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://sb.test/app/api/${path}`, {
    method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

describe("admin token", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = PW;
  });

  it("checks the password exactly", () => {
    expect(checkAdminPassword(PW)).toBe(true);
    expect(checkAdminPassword(PW + " ")).toBe(false);
    expect(checkAdminPassword("")).toBe(false);
    expect(checkAdminPassword(undefined)).toBe(false);
  });

  it("round-trips, expires, and rejects tampering", () => {
    const now = Date.now();
    const tok = adminToken(now);
    expect(verifyAdminToken(tok, now)).toBe(true);
    expect(verifyAdminToken(tok, now + 13 * 3600 * 1000)).toBe(false);
    const [exp, sig] = tok.split(".");
    expect(verifyAdminToken(`${Number(exp) + 3600}.${sig}`, now)).toBe(false);
    expect(verifyAdminToken("garbage", now)).toBe(false);
    expect(verifyAdminToken(null, now)).toBe(false);
  });

  it("changing ADMIN_PASSWORD signs everyone out; unset turns the console off", () => {
    const tok = adminToken();
    process.env.ADMIN_PASSWORD = "another long password";
    expect(verifyAdminToken(tok)).toBe(false);
    delete process.env.ADMIN_PASSWORD;
    expect(verifyAdminToken(tok)).toBe(false);
    expect(checkAdminPassword("")).toBe(false);
  });
});

describe("admin routes", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = PW;
  });

  it("refuses every admin route without a session", async () => {
    for (const [m, p] of [["GET", "admin/users"], ["GET", "admin/db/tables"], ["GET", "admin/system"], ["POST", "admin/user/delete"], ["POST", "admin/system/migrate"]]) {
      const r = await handleApi(req(m, p, m === "POST" ? { body: {} } : {}), p.replace(/\?.*/, ""));
      expect(r.status, p).toBe(401);
      expect((await r.json()).code).toBe("admin_login_required");
    }
    // A member session cookie is not an admin session.
    const r = await handleApi(req("GET", "admin/users", { cookie: "sb_session=abc; sb_admin=1.2" }), "admin/users");
    expect(r.status).toBe(401);
  });

  it("answers 503 when ADMIN_PASSWORD is unset", async () => {
    delete process.env.ADMIN_PASSWORD;
    const r = await handleApi(req("POST", "admin/login", { body: { password: "x" } }), "admin/login");
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("admin_unconfigured");
    const s = await (await handleApi(req("GET", "admin/session"), "admin/session")).json();
    expect(s.data).toEqual({ configured: false, signed_in: false });
  });

  it("signs in with the right password only, and the cookie is scoped and HttpOnly", async () => {
    const bad = await handleApi(req("POST", "admin/login", { body: { password: "nope" } }), "admin/login");
    expect(bad.status).toBe(401);
    expect((await bad.json()).code).toBe("admin_login_failed");
    expect(bad.headers.get("set-cookie")).toBeNull();

    const good = await handleApi(req("POST", "admin/login", { body: { password: PW } }), "admin/login");
    expect(good.status).toBe(200);
    const cookies = good.headers.getSetCookie();
    const admin = cookies.find((c) => c.startsWith("sb_admin="))!;
    expect(admin).toContain("HttpOnly");
    expect(admin).toContain("Path=/app/api/admin");
    expect(admin).toContain("SameSite=Strict");

    const cookie = admin.split(";")[0];
    const s = await (await handleApi(req("GET", "admin/session", { cookie }), "admin/session")).json();
    expect(s.data).toEqual({ configured: true, signed_in: true });
  });

  it("refuses a cross-site admin write", async () => {
    const r = new Request("https://sb.test/app/api/admin/login", {
      method: "POST",
      headers: { host: "sb.test", origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ password: PW }),
    });
    expect((await handleApi(r, "admin/login")).status).toBe(403);
  });
});
