/**
 * webapp/admin_routes.ts — the admin console's JSON API under
 * /app/api/admin/*, registered into the one route table. Thin handlers:
 * check the admin session, call admin_actions.ts, answer. The page is the
 * static /admin shell (public/app/static/pages/admin.html).
 *
 * The two Bearer SETUP_SECRET routes (admin/migrate, admin/telegram-webhook)
 * in feature_routes.ts stay for scripts and curl.
 */
import * as A from "../services/actions";
import * as AA from "../services/admin_actions";
import { err, type Result } from "../errors";
import { addRoutes } from "./api_routes";
import { json, withCookies } from "./http";
import {
  adminConfigured, adminCookies, adminToken, checkAdminPassword, clearAdminCookies, isAdmin,
} from "./admin_auth";

type Ctx = { body: Record<string, unknown>; qp: URLSearchParams };

function answer<T>(r: Result<T>): Response {
  if (r.ok) return json({ ok: true, data: r.data });
  return json({ ok: false, code: r.code, params: r.params }, r.status);
}

/** Admin-only route: 503 when the console is off, 401 when signed out. */
function guarded(fn: (ctx: Ctx) => Promise<unknown>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    if (!adminConfigured()) return answer(err("admin_unconfigured", {}, 503));
    if (!isAdmin(req)) return answer(err("admin_login_required", {}, 401));
    return answer(await A.run(() => fn(ctx)));
  };
}

addRoutes({
  // ── session ──
  "GET admin/session": async (req) =>
    json({ ok: true, data: { configured: adminConfigured(), signed_in: isAdmin(req) } }),
  "POST admin/login": async (_req, { body }) => {
    if (!adminConfigured()) return answer(err("admin_unconfigured", {}, 503));
    if (!checkAdminPassword(body.password)) {
      // Slow down guessing a little; the password itself must be long.
      await new Promise((r) => setTimeout(r, 400));
      return answer(err("admin_login_failed", {}, 401));
    }
    return withCookies(json({ ok: true, data: { signed_in: true } }), adminCookies(adminToken()));
  },
  "POST admin/logout": async () => withCookies(json({ ok: true, data: { signed_in: false } }), clearAdminCookies()),

  // ── database (read-only) ──
  "GET admin/db/tables": guarded(() => AA.dbTables()),
  "GET admin/db/rows": guarded(({ qp }) => AA.dbRows({ table: qp.get("table"), page: qp.get("page"), per_page: qp.get("per_page") })),

  // ── users ──
  "GET admin/users": guarded(({ qp }) => AA.listUsers({ q: qp.get("q"), page: qp.get("page") })),
  "GET admin/user": guarded(({ qp }) => AA.getUser({ user_id: qp.get("id") })),
  "POST admin/user/create": guarded(({ body }) => AA.createUser(body)),
  "POST admin/user/update": guarded(({ body }) => AA.updateUser(body)),
  "POST admin/user/reset-password": guarded(({ body }) => AA.resetPassword({ user_id: body.user_id })),
  "POST admin/user/unlink-telegram": guarded(({ body }) => AA.unlinkTelegram({ user_id: body.user_id })),
  "POST admin/user/delete": guarded(({ body }) => AA.deleteUser({ user_id: body.user_id, confirm: body.confirm })),

  // ── system ──
  "GET admin/system": guarded(() => AA.systemStatus()),
  "POST admin/system/migrate": guarded(() => AA.applyMigrations()),
  "POST admin/system/telegram": guarded(() => AA.telegramSetup()),
  "POST admin/system/cleanup": guarded(() => AA.runCleanup()),
  "POST admin/system/integrity": guarded(() => AA.integrityCheck()),
});
