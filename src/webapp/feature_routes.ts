/**
 * webapp/feature_routes.ts: routes beyond the core (rates, reports, AI input,
 * Telegram linking, admin), registered into the one route table.
 */
import * as A from "../services/actions";
import { addRoutes } from "./api_routes";
import { binResponse, json } from "./http";
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

  // ── AI drafts ──
  "POST ai/chat": async (_req, ctx) => answer(await A.run(() => A.aiDraftFromText({ user_id: need(ctx).user_id, group_id: ctx.body.group_id, text: ctx.body.text }))),
  "POST ai/photo": async (req, ctx) => {
    const user = need(ctx);
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !file || typeof file === "string") return json({ ok: false, code: "image_invalid", params: {} }, 400);
    const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
    return answer(await A.run(() => A.aiDraftFromImage({
      user_id: user.user_id, group_id: form.get("group_id"), bytes, mime: (file as Blob).type || "image/jpeg", caption: form.get("caption") ?? "",
    })));
  },
  "GET draft": async (_req, ctx) => answer(await A.run(() => A.getDraft({ user_id: need(ctx).user_id, draft_id: ctx.qp.get("id") }))),

  // ── reports ──
  "GET report": async (_req, ctx) => {
    const q = ctx.qp;
    const r = await A.run(() => A.getReport({
      user_id: need(ctx).user_id, group_id: q.get("group_id"), type: q.get("type") ?? "group",
      member: q.get("member") ?? undefined, format: q.get("format") ?? "text", lang: q.get("lang") ?? ctx.user?.lang ?? "en",
    }));
    if (!r.ok) return answer(r);
    const d = r.data;
    if (d.kind === "text") return json({ ok: true, data: { text: d.text, filename: d.filename } });
    return binResponse(d.bytes, {
      "content-type": d.type,
      "content-disposition": `attachment; filename="${d.filename}"`,
      "cache-control": "no-store",
    });
  },

  // ── Telegram ──
  "POST telegram/link-code": async (_req, ctx) => answer(await A.run(() => A.telegramLinkCode({ user_id: need(ctx).user_id }))),
  "POST telegram/bind-code": async (_req, ctx) => answer(await A.run(() => A.telegramBindCode({ user_id: need(ctx).user_id, group_id: ctx.body.group_id }))),
  "POST telegram/unlink": async (_req, ctx) => answer(await A.run(() => A.telegramUnlink({ user_id: need(ctx).user_id }))),
  "POST admin/telegram-webhook": async (req) => {
    const secret = process.env.SETUP_SECRET;
    if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return json(err("forbidden", {}, 403), 403);
    const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    if (!base) return json({ ok: false, code: "telegram_unavailable", params: {} }, 400);
    const { setup } = await import("../telegram/api");
    return json({ ok: true, data: await setup(`${base}/webhook`) });
  },

  // ── admin: apply migrations (Bearer SETUP_SECRET) ──
  "POST admin/migrate": async (req) => {
    const secret = process.env.SETUP_SECRET;
    const auth = req.headers.get("authorization") || "";
    if (!secret || auth !== `Bearer ${secret}`) return json(err("forbidden", {}, 403), 403);
    const { MigrationError, migrationStatus, runMigrations } = await import("../services/migrate");
    try {
      return json({ ok: true, data: { applied: await runMigrations(), migrations: await migrationStatus() } });
    } catch (e) {
      if (!(e instanceof MigrationError)) throw e;
      console.error("[migrate]", e.cause);
      return json({ ok: false, code: "migration_failed", params: { name: e.migration, detail: e.detail } }, 500);
    }
  },
});
