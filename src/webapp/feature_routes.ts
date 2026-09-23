/**
 * webapp/feature_routes.ts: routes beyond the core (rates, reports, AI input,
 * Telegram linking, admin), registered into the one route table.
 */
import * as A from "../services/actions";
import { addRoutes } from "./api_routes";
import { json } from "./http";
import { err } from "../errors";
import type { User } from "./http";

function need(ctx: { user: User | null }): User {
  if (!ctx.user) throw new A.__AuthError();
  return ctx.user;
}

function answer<T>(r: Awaited<ReturnType<typeof A.run<T>>>): Response {
  if (r.ok) return json({ ok: true, data: r.data });
  return json({ ok: false, code: r.code, params: r.params }, r.status);
}

addRoutes({
  // ── rates ──
  "POST rate/set": async (_req, ctx) => answer(await A.run(() => A.setRate({ ...ctx.body, user_id: need(ctx).user_id }))),
  "POST rate/delete": async (_req, ctx) => answer(await A.run(() => A.deleteRate({ ...ctx.body, user_id: need(ctx).user_id }))),
  "POST rate/auto": async (_req, ctx) => answer(await A.run(() => A.suggestRate({ ...ctx.body, user_id: need(ctx).user_id }))),
  "POST group/currency": async (_req, ctx) => answer(await A.run(() => A.changeCurrency({ ...ctx.body, user_id: need(ctx).user_id }))),

  // ── admin: apply migrations (Bearer SETUP_SECRET) ──
  "POST admin/migrate": async (req) => {
    const secret = process.env.SETUP_SECRET;
    const auth = req.headers.get("authorization") || "";
    if (!secret || auth !== `Bearer ${secret}`) return json(err("forbidden", {}, 403), 403);
    const { runMigrations } = await import("../services/migrate");
    return json({ ok: true, data: { applied: await runMigrations() } });
  },
});
