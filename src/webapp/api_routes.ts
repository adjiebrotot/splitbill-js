/**
 * webapp/api_routes.ts: the JSON API under /app/api/*. A route table, one
 * thin handler each: parse the body, call actions.ts / user_service, answer.
 * No business logic lives here (CLAUDE.md: actions.ts is the only hub).
 *
 * Every answer is { ok: true, data } or { ok: false, code, params }.
 */
import * as A from "../services/actions";
import * as U from "../services/user_service";
import { ENGINE_VERSION } from "../engine";
import { aiConfigured } from "../services/llm_client";
import { normalizeLang } from "../i18n";
import { err, type Result } from "../errors";
import {
  clearSessionCookies, getUser, json, langCookie, redirect, safeNext, sessionCookies, withCookies, type User,
} from "./http";

type Handler = (req: Request, ctx: { user: User | null; body: Record<string, unknown>; qp: URLSearchParams }) => Promise<Response>;

function answer<T>(r: Result<T>, extraHeaders: Record<string, string> = {}): Response {
  if (r.ok) return json({ ok: true, data: r.data }, 200, extraHeaders);
  return json({ ok: false, code: r.code, params: r.params }, r.status);
}

function need(ctx: { user: User | null }): User {
  if (!ctx.user) throw new A.__AuthError();
  return ctx.user;
}

/**
 * A group write. The answer carries the group's fresh `view` (the one the
 * post-write gate computed), so the page redraws without a second request.
 */
export async function answerWrite<T>(ctx: { user: User | null }, fn: (userId: string) => Promise<T>): Promise<Response> {
  const uid = need(ctx).user_id;
  const r = await A.run(() => A.withView(uid, () => fn(uid)));
  if (!r.ok) return answer(r);
  return json({ ok: true, data: r.data.data, view: r.data.view });
}

const ROUTES: Record<string, Handler> = {
  // ── auth ──
  "POST auth/login": async (_req, { body }) => {
    const r = await A.run(() => U.login(body.identifier, body.password));
    if (!r.ok) return answer(r);
    const me = r.data;
    return withCookies(json({ ok: true, data: me }), sessionCookies(me.user_id, me.username, me.language, body.remember !== false));
  },
  "POST auth/register": async (_req, { body }) => {
    const r = await A.run(() => U.register(body as never));
    if (!r.ok) return answer(r);
    const me = r.data;
    return withCookies(json({ ok: true, data: me }), sessionCookies(me.user_id, me.username, me.language, true));
  },
  "POST auth/logout": async () => withCookies(json({ ok: true, data: null }), clearSessionCookies()),
  "GET auth/logout": async () => redirect("/login", clearSessionCookies()),
  "GET auth/providers": async () =>
    json({ ok: true, data: { google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) } }, 200, { "cache-control": "public, max-age=300" }),
  "GET auth/google/start": async (req) => (await import("./google_auth")).googleStart(req),
  "GET auth/google/callback": async (req) => (await import("./google_auth")).googleCallback(req),
  "POST auth/verify": async (_req, ctx) => answer(await A.run(() => U.verifyEmail(need(ctx).user_id, ctx.body.code))),
  "POST auth/resend": async (_req, ctx) => answer(await A.run(() => U.resendCode(need(ctx).user_id))),

  // ── boot: one request per page (me + that page's data) ──
  "GET boot": async (_req, ctx) => {
    const user = need(ctx);
    const page = ctx.qp.get("page") || "";
    const uid = user.user_id;
    const r = await A.run(async () => {
      // The account and the page's data are independent reads: run them together.
      const pageData = (async (): Promise<Record<string, unknown>> => {
        if (page === "home") return { groups: await A.listMyGroups({ user_id: uid }), ai: aiConfigured() }; // home opens a trip's bill editor in place
        if (page === "group") return { group: await A.getGroupView({ user_id: uid, group_id: ctx.qp.get("id") }), ai: aiConfigured() };
        if (page === "join") return { invite: await A.peekInvite({ user_id: uid, code: ctx.qp.get("code") }) };
        return {};
      })();
      pageData.catch(() => {}); // settled below; a missing account wins over its error
      const me = await U.getMe(uid);
      if (!me) throw new A.__AuthError();
      return { me, engine_version: ENGINE_VERSION, ...(await pageData) };
    });
    return answer(r);
  },

  // ── settings ──
  "PATCH settings": async (_req, ctx) => {
    const r = await A.run(() => U.updateSettings(need(ctx).user_id, ctx.body));
    if (!r.ok) return answer(r);
    return withCookies(json({ ok: true, data: r.data }), [
      ...sessionCookies(r.data.user_id, r.data.username, r.data.language, true),
      langCookie(normalizeLang(r.data.language)),
    ]);
  },
  "POST settings/password": async (_req, ctx) => answer(await A.run(() => U.changePassword(need(ctx).user_id, ctx.body.current, ctx.body.next))),

  // ── groups ──
  "GET groups": async (_req, ctx) => answer(await A.run(() => A.listMyGroups({ user_id: need(ctx).user_id }))),
  "POST groups": async (_req, ctx) => answer(await A.run(() => A.createGroup({ ...ctx.body, user_id: need(ctx).user_id }))),
  "GET group": async (_req, ctx) => answer(await A.run(() => A.getGroupView({ user_id: need(ctx).user_id, group_id: ctx.qp.get("id") }))),
  "POST group/rename": async (_req, ctx) => answerWrite(ctx, (uid) => A.renameGroup({ ...ctx.body, user_id: uid })),
  "POST group/delete": async (_req, ctx) => answer(await A.run(() => A.deleteGroup({ ...ctx.body, user_id: need(ctx).user_id }))),
  "POST group/invite-reset": async (_req, ctx) => answerWrite(ctx, (uid) => A.resetInvite({ ...ctx.body, user_id: uid })),
  "POST invite/join": async (_req, ctx) => answer(await A.run(() => A.joinByInvite({ user_id: need(ctx).user_id, code: ctx.body.code }))),

  // ── members ──
  "POST member/add": async (_req, ctx) => answerWrite(ctx, (uid) => A.addMember({ ...ctx.body, user_id: uid })),
  "POST member/rename": async (_req, ctx) => answerWrite(ctx, (uid) => A.renameMember({ ...ctx.body, user_id: uid })),
  "POST member/remove": async (_req, ctx) => answerWrite(ctx, (uid) => A.removeMember({ ...ctx.body, user_id: uid })),
  "POST member/reactivate": async (_req, ctx) => answerWrite(ctx, (uid) => A.reactivateMember({ ...ctx.body, user_id: uid })),
  "POST member/link": async (_req, ctx) => answerWrite(ctx, (uid) => A.linkMember({ ...ctx.body, user_id: uid })),

  // ── bills & payments ──
  "POST bill/save": async (_req, ctx) => answerWrite(ctx, (uid) => A.saveBill({ ...ctx.body, user_id: uid })),
  "POST bill/delete": async (_req, ctx) => answerWrite(ctx, (uid) => A.deleteBill({ ...ctx.body, user_id: uid })),
  "POST payment/record": async (_req, ctx) => answerWrite(ctx, (uid) => A.recordPayment({ ...ctx.body, user_id: uid })),
  "POST payment/delete": async (_req, ctx) => answerWrite(ctx, (uid) => A.deletePayment({ ...ctx.body, user_id: uid })),

  // ── settle ──
  "POST settle": async (_req, ctx) => answerWrite(ctx, (uid) => A.settleGroup({ ...ctx.body, user_id: uid })),
  "POST reopen": async (_req, ctx) => answerWrite(ctx, (uid) => A.reopenGroup({ ...ctx.body, user_id: uid })),
  "POST transfer/paid": async (_req, ctx) => answerWrite(ctx, (uid) => A.markTransferPaid({ ...ctx.body, user_id: uid })),
  "POST transfer/unpaid": async (_req, ctx) => answerWrite(ctx, (uid) => A.unmarkTransferPaid({ ...ctx.body, user_id: uid })),
};

/** Register more routes from feature modules (rates, reports, AI, Telegram). */
export function addRoutes(more: Record<string, Handler>): void {
  Object.assign(ROUTES, more);
}

/**
 * Same-origin check for writes. The session cookie is SameSite=Lax already;
 * this refuses a cross-site write even from a browser that ignores that.
 */
function _sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get("x-forwarded-host") || req.headers.get("host") || new URL(req.url).host);
  } catch {
    return false;
  }
}

export async function handleApi(req: Request, path: string): Promise<Response> {
  const method = req.method.toUpperCase();
  const key = `${method} ${path}`;
  const route = ROUTES[key];
  if (!route) return json({ ok: false, code: "not_found", params: {} }, 404);
  if (method !== "GET" && !_sameOrigin(req)) return json({ ok: false, code: "forbidden", params: {} }, 403);

  let body: Record<string, unknown> = {};
  if (method !== "GET" && method !== "HEAD") {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      if (typeof body !== "object" || Array.isArray(body)) body = {};
    } else if (!ct.includes("multipart/form-data") && path !== "auth/logout" && !path.startsWith("admin/")) {
      return json({ ok: false, code: "unsupported", params: {} }, 415);
    }
  }
  const qp = new URL(req.url).searchParams;
  const user = getUser(req);
  try {
    return await route(req, { user, body, qp });
  } catch (e) {
    if (e instanceof A.__AuthError) return answer(err("login_required", {}, 401));
    console.error("[api]", key, e);
    return answer(err("internal", {}, 500));
  }
}

export { safeNext };
