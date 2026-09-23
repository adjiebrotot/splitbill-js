import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { handleUpdate } from "@/telegram/bot";
import { webhookSecretToken } from "@/telegram/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function _eq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Telegram webhook. The update body names the user (message.from.id), so an
 * unauthenticated POST could act as anyone: the secret token set with
 * setWebhook must match. The work (a vision read takes ~15s) runs in after(),
 * so Telegram gets its 200 at once and never retries a slow update; retries
 * that do happen are dropped by update_id dedup.
 */
export async function POST(req: Request): Promise<Response> {
  const expected = webhookSecretToken();
  const got = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!expected || !_eq(got, expected)) return new Response(null, { status: 401 });
  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return new Response(null, { status: 200 });
  }
  after(async () => {
    try {
      await handleUpdate(update);
    } catch (e) {
      console.error("[telegram]", e);
    }
  });
  return new Response(null, { status: 200 });
}
