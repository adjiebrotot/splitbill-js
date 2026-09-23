/**
 * telegram/api.ts: the Bot API calls Split Bill uses. Webhook secret and
 * send/download helpers adapted from finance-tracker telegram_service.ts;
 * adds inline keyboards, callback answers, message edits, photos and
 * scoped command menus. Every call is best-effort: it never throws.
 */
import { createHash } from "node:crypto";

type Dict = Record<string, any>;

function _token(): string {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

function _base(): string {
  return `https://api.telegram.org/bot${_token()}`;
}

export function botUsername(): string {
  return (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
}

/** Derived from the bot token, so no extra env var; Telegram echoes it back. */
export function webhookSecretToken(): string | null {
  const t = _token();
  if (!t) return null;
  return createHash("sha256").update(`sb-webhook:${t}`, "utf8").digest("hex");
}

export async function call(method: string, params: Dict, timeoutMs = 15000): Promise<Dict> {
  if (!_token()) return { ok: false, description: "TELEGRAM_BOT_TOKEN is not set" };
  try {
    const resp = await fetch(`${_base()}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await resp.json()) as Dict;
  } catch (e) {
    console.log(`[telegram] ${method} failed: ${e}`);
    return { ok: false };
  }
}

export interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface SendOpts {
  buttons?: Button[][];
  replyTo?: number;
  threadId?: number;
  forceReply?: boolean;
  placeholder?: string;
}

function _extra(o: SendOpts = {}): Dict {
  const p: Dict = {};
  if (o.buttons?.length) p.reply_markup = { inline_keyboard: o.buttons };
  if (o.forceReply) p.reply_markup = { force_reply: true, selective: true, input_field_placeholder: o.placeholder?.slice(0, 64) };
  if (o.replyTo) p.reply_parameters = { message_id: o.replyTo, allow_sending_without_reply: true };
  if (o.threadId) p.message_thread_id = o.threadId;
  return p;
}

export async function sendMessage(chatId: number, html: string, o: SendOpts = {}): Promise<Dict> {
  return call("sendMessage", { chat_id: chatId, text: html.slice(0, 4000), parse_mode: "HTML", link_preview_options: { is_disabled: true }, ..._extra(o) });
}

export async function editMessage(chatId: number, messageId: number, html: string, buttons?: Button[][]): Promise<Dict> {
  return call("editMessageText", {
    chat_id: chatId, message_id: messageId, text: html.slice(0, 4000), parse_mode: "HTML",
    link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: buttons ?? [] },
  });
}

export async function answerCallback(id: string, text?: string, alert = false): Promise<Dict> {
  return call("answerCallbackQuery", { callback_query_id: id, text: text?.slice(0, 190), show_alert: alert });
}

async function _upload(method: "sendDocument" | "sendPhoto", field: string, chatId: number, filename: string, bytes: Uint8Array, type: string, caption = "", threadId?: number): Promise<Dict> {
  if (!_token()) return { ok: false };
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption.slice(0, 1000));
    if (threadId) form.append("message_thread_id", String(threadId));
    form.append(field, new Blob([bytes as unknown as BlobPart], { type }), filename);
    const resp = await fetch(`${_base()}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
    return (await resp.json()) as Dict;
  } catch (e) {
    console.log(`[telegram] ${method} failed: ${e}`);
    return { ok: false };
  }
}

export const sendDocument = (chatId: number, filename: string, bytes: Uint8Array, type: string, caption = "", threadId?: number) =>
  _upload("sendDocument", "document", chatId, filename, bytes, type, caption, threadId);

export const sendPhoto = (chatId: number, filename: string, bytes: Uint8Array, caption = "", threadId?: number) =>
  _upload("sendPhoto", "photo", chatId, filename, bytes, "image/png", caption, threadId);

/** getFile + download, 3 tries (Telegram's file host is occasionally slow). */
export async function downloadFile(fileId: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const info = await call("getFile", { file_id: fileId });
  const path = info?.result?.file_path;
  if (!info.ok || !path) return null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/file/bot${_token()}/${path}`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const bytes = new Uint8Array(await r.arrayBuffer());
        const mime = /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg";
        return { bytes, mime };
      }
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  return null;
}

/** Register the webhook and the two command menus (private chats, groups). */
export async function setup(webhookUrl: string): Promise<Dict> {
  const set = await call("setWebhook", {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    drop_pending_updates: true,
    secret_token: webhookSecretToken(),
  });
  const cmds = (list: [string, string][]) => list.map(([command, description]) => ({ command, description }));
  const priv = await call("setMyCommands", {
    scope: { type: "all_private_chats" },
    commands: cmds([
      ["groups", "Pick the split to add bills to"],
      ["report", "Group report"],
      ["me", "My report"],
      ["help", "How to use the bot"],
    ]),
  });
  const grp = await call("setMyCommands", {
    scope: { type: "all_group_chats" },
    commands: cmds([
      ["bill", "Add a bill (text, or reply with a receipt photo)"],
      ["report", "Group report"],
      ["me", "My report, sent to you privately"],
      ["help", "How to use the bot"],
    ]),
  });
  const info = await call("getWebhookInfo", {});
  return { setWebhook: set, commands: { private: priv.ok, group: grp.ok }, info: info.result };
}
