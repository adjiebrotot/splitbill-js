/**
 * telegram/bot.ts: the Telegram medium. Parses updates, calls actions.ts,
 * replies. No business logic here (CLAUDE.md hub rule).
 *
 * Private chat: link by one-time deep link, pick the active split, send text
 * or a receipt photo -> draft with [Save] [Edit in app] [Cancel].
 * Group chat (privacy mode on): the bot only receives /cmd@bot, bare /cmd
 * when it was the last bot to post, and replies to its own messages. So a
 * bill is "/bill <text>", or "/bill" then a reply (text or photo) to the
 * ForceReply prompt, which always reaches the bot.
 */
import * as A from "../services/actions";
import { allocate, formatAmount, minorUnits, EngineError } from "../engine";
import { t, tf } from "../i18n";
import * as T from "./api";

type Dict = Record<string, any>;

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function base(): string {
  return (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

function langOf(u: A.TgUser | null, from: Dict | undefined): string {
  if (u) return u.language;
  return String(from?.language_code ?? "").startsWith("id") ? "id" : "en";
}

function errText(code: string, params: Record<string, string | number>, lang: string): string {
  const k = "err." + code;
  const s = t(k, lang, params);
  return s === k ? t("err.generic", lang) : s;
}

/** "/bill@MyBot lunch 60k" -> {cmd:"bill", arg:"lunch 60k"}; another bot's command -> null. */
export function parseCommand(text: string): { cmd: string; arg: string; addressed: boolean } | null {
  const m = /^\/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const bot = T.botUsername().toLowerCase();
  if (m[2] && bot && m[2].toLowerCase() !== bot) return null;
  return { cmd: m[1].toLowerCase(), arg: (m[3] ?? "").trim(), addressed: !!m[2] };
}

/** Report text uses *heading* lines; Telegram HTML wants <b>. */
function reportHtml(text: string): string {
  return esc(text).replace(/^\*(.+)\*$/gm, "<b>$1</b>");
}

// ── drafts ──────────────────────────────────────────────────────────────────

async function draftMessage(d: Dict, userId: string, lang: string): Promise<{ html: string; buttons: T.Button[][] }> {
  const v = await A.getGroupView({ user_id: userId, group_id: d.group_id });
  const name = (id: string) => v.members.find((m) => m.id === id)?.name ?? "?";
  const dp = minorUnits(d.currency);
  const amt = (m: bigint | string) => formatAmount(BigInt(m), dp, lang);
  const lines: string[] = [`<b>${esc(t("tg.draft_title", lang))}: ${esc(d.description)}</b>`, `${esc(d.date)} · ${esc(tf("tg.paid_by", lang, name(d.payer)))}`];
  let problem: string | null = null;
  try {
    if (d.mode === "items") {
      for (const it of d.items ?? []) {
        lines.push(`• ${esc(it.name)}: ${it.amount != null ? amt(it.amount) : "?"} (${esc((it.members ?? []).map(name).join(", ") || "?")})`);
      }
      for (const a of d.adjustments ?? []) lines.push(`• ${esc(t("adj." + a.kind, lang))}: ${amt(a.amount)}`);
    }
    if ((d.items ?? []).some((i: Dict) => i.amount == null) || (d.mode !== "items" && !d.total)) throw new EngineError("amount_invalid");
    const order = new Map(v.members.map((m) => [m.id, m.position]));
    const alloc = allocate({
      payer: d.payer, mode: d.mode,
      total: d.mode === "items" ? undefined : BigInt(d.total),
      items: d.mode === "items" ? (d.items ?? []).map((i: Dict) => ({ amount: BigInt(i.amount), members: i.members })) : undefined,
      adjustments: d.mode === "items" ? (d.adjustments ?? []).map((a: Dict) => ({ kind: a.kind, amount: BigInt(a.amount) })) : undefined,
      participants: d.mode === "items" ? undefined : (d.participants ?? []).map((p: Dict) => ({ member: p.member, bp: p.bp })),
    }, order);
    if (d.stated_total && BigInt(d.stated_total) !== alloc.total) throw new EngineError("stated_total_mismatch");
    if (d.unknown?.length) problem = tf("input.unknown", lang, d.unknown.join(", "));
    lines.push(`<b>${esc(t("bill.total", lang))}: ${amt(alloc.total)} ${esc(d.currency)}</b>`);
    lines.push([...alloc.shares].map(([m, x]) => `${esc(name(m))} ${amt(x)}`).join(" · "));
  } catch (e) {
    problem = e instanceof EngineError ? errText(e.code, e.params, lang) : t("err.generic", lang);
  }
  if (problem) lines.push("", esc(tf("tg.draft_fix", lang, problem)));
  const edit: T.Button = { text: t("tg.btn_edit", lang), url: `${base()}/app/g/${d.group_id}#draft=${d.draft_id}` };
  const buttons: T.Button[][] = problem
    ? [[edit], [{ text: t("tg.btn_cancel", lang), callback_data: `d:${d.draft_id}:c` }]]
    : [[{ text: t("tg.btn_save", lang), callback_data: `d:${d.draft_id}:s` }, { text: t("tg.btn_cancel", lang), callback_data: `d:${d.draft_id}:c` }], [edit]];
  if (!base()) buttons.splice(problem ? 0 : 1, 1);
  return { html: lines.join("\n"), buttons };
}

async function makeDraft(m: Dict, u: A.TgUser, groupId: string, lang: string, text: string | null): Promise<void> {
  const chatId = m.chat.id;
  const threadId = m.message_thread_id;
  const wait = await T.sendMessage(chatId, esc(t("tg.reading", lang)), { replyTo: m.message_id, threadId });
  let r;
  if (m.photo?.length) {
    const biggest = m.photo[m.photo.length - 1];
    const file = await T.downloadFile(biggest.file_id);
    if (!file) {
      await T.sendMessage(chatId, esc(t("tg.file_failed", lang)), { replyTo: m.message_id, threadId });
      return;
    }
    r = await A.run(() => A.aiDraftFromImage({ user_id: u.user_id, group_id: groupId, bytes: file.bytes, mime: file.mime, caption: m.caption ?? text ?? "", source: "telegram" }));
  } else {
    r = await A.run(() => A.aiDraftFromText({ user_id: u.user_id, group_id: groupId, text: text ?? "", source: "telegram" }));
  }
  const waitId = wait?.result?.message_id;
  if (!r.ok) {
    const msg = esc(errText(r.code, r.params, lang));
    if (waitId) await T.editMessage(chatId, waitId, msg);
    else await T.sendMessage(chatId, msg, { replyTo: m.message_id, threadId });
    return;
  }
  const { html, buttons } = await draftMessage({ ...r.data, group_id: groupId }, u.user_id, lang);
  if (waitId) await T.editMessage(chatId, waitId, html, buttons);
  else await T.sendMessage(chatId, html, { buttons, replyTo: m.message_id, threadId });
}

// ── reports ─────────────────────────────────────────────────────────────────

async function sendReport(chatId: number, u: A.TgUser, groupId: string, type: "group" | "member", lang: string, threadId?: number): Promise<void> {
  const r = await A.run(() => A.getReport({ user_id: u.user_id, group_id: groupId, type, format: "text", lang }));
  if (!r.ok) {
    await T.sendMessage(chatId, esc(errText(r.code, r.params, lang)), { threadId });
    return;
  }
  const text = r.data.kind === "text" ? r.data.text : "";
  await T.sendMessage(chatId, reportHtml(text), {
    threadId,
    buttons: [[
      { text: "PNG", callback_data: `r:${groupId}:${type === "group" ? "g" : "m"}:png` },
      { text: "PDF", callback_data: `r:${groupId}:${type === "group" ? "g" : "m"}:pdf` },
    ]],
  });
}

// ── private chat ────────────────────────────────────────────────────────────

async function activeGroup(u: A.TgUser): Promise<string | null> {
  const groups = await A.telegramGroups({ user_id: u.user_id });
  if (u.telegram_group && groups.some((g) => g.group_id === u.telegram_group)) return u.telegram_group;
  if (groups.length === 1) {
    await A.telegramSetGroup({ user_id: u.user_id, group_id: groups[0].group_id });
    return groups[0].group_id;
  }
  return null;
}

async function askGroup(chatId: number, u: A.TgUser, lang: string): Promise<void> {
  const groups = await A.telegramGroups({ user_id: u.user_id });
  if (!groups.length) {
    await T.sendMessage(chatId, esc(t("tg.no_groups", lang)));
    return;
  }
  await T.sendMessage(chatId, esc(t("tg.pick_group", lang)), {
    buttons: groups.map((g) => [{ text: (g.group_id === u.telegram_group ? "✓ " : "") + g.name, callback_data: `g:${g.group_id}` }]),
  });
}

async function onPrivate(m: Dict): Promise<void> {
  const chatId = m.chat.id;
  const text = String(m.text ?? m.caption ?? "");
  const cmd = m.text ? parseCommand(m.text) : null;
  let u = await A.telegramUser(m.from.id);
  let lang = langOf(u, m.from);

  if (cmd?.cmd === "start" && /^L[A-Z0-9]+$/.test(cmd.arg)) {
    const r = await A.run(() => A.telegramLink({ code: cmd.arg, telegram_id: m.from.id }));
    if (!r.ok) {
      await T.sendMessage(chatId, esc(errText(r.code, r.params, lang)));
      return;
    }
    u = r.data;
    lang = u.language;
    await T.sendMessage(chatId, esc(tf("tg.linked_ok", lang, u.display_name)) + "\n\n" + esc(t("tg.help_private", lang)));
    return;
  }
  if (!u) {
    await T.sendMessage(chatId, esc(t("tg.not_linked", lang)));
    return;
  }
  if (cmd) {
    if (cmd.cmd === "start" || cmd.cmd === "help") return void (await T.sendMessage(chatId, esc(t("tg.help_private", lang))));
    if (cmd.cmd === "groups") return askGroup(chatId, u, lang);
    if (cmd.cmd === "unlink") {
      await A.telegramUnlink({ user_id: u.user_id });
      return void (await T.sendMessage(chatId, esc(t("tg.unlinked", lang))));
    }
    if (cmd.cmd === "report" || cmd.cmd === "me") {
      const gid = await activeGroup(u);
      if (!gid) return askGroup(chatId, u, lang);
      return sendReport(chatId, u, gid, cmd.cmd === "me" ? "member" : "group", lang);
    }
    return void (await T.sendMessage(chatId, esc(t("tg.unknown_cmd", lang))));
  }
  const gid = await activeGroup(u);
  if (!gid) return askGroup(chatId, u, lang);
  if (m.media_group_id) await T.sendMessage(chatId, esc(t("tg.album_first", lang)));
  if (m.photo?.length || text.trim()) await makeDraft(m, u, gid, lang, text);
}

// ── group chat ──────────────────────────────────────────────────────────────

async function onGroup(m: Dict, cmd: ReturnType<typeof parseCommand>): Promise<void> {
  const chatId = m.chat.id;
  const threadId = m.message_thread_id;
  const u = await A.telegramUser(m.from.id);
  const lang = langOf(u, m.from);
  const say = (html: string, extra: T.SendOpts = {}) => T.sendMessage(chatId, html, { replyTo: m.message_id, threadId, ...extra });

  if (cmd?.cmd === "start" && /^B[A-Z0-9]+$/.test(cmd.arg)) {
    const r = await A.run(() => A.telegramBind({ code: cmd.arg, chat_id: chatId, telegram_id: m.from.id }));
    if (!r.ok) return void (await say(esc(errText(r.code, r.params, lang))));
    const v = await A.getGroupView({ user_id: u!.user_id, group_id: r.data.group_id });
    return void (await say(esc(tf("tg.bound", lang, v.group.name)) + "\n\n" + esc(t("tg.help_group", lang))));
  }
  const gid = await A.telegramChatGroup(chatId);
  if (!gid) return void (await say(esc(t("tg.chat_not_bound", lang))));
  if (!u) return void (await say(esc(tf("tg.link_first", lang, m.from.first_name ?? "", T.botUsername()))));

  if (!cmd) {
    // A reply to our /bill prompt: the only non-command message we act on.
    const pending = await A.telegramTakePending(chatId, m.from.id);
    if (pending?.kind === "await_bill") return makeDraft(m, u, gid, lang, String(m.text ?? m.caption ?? ""));
    return;
  }
  switch (cmd.cmd) {
    case "help":
    case "start":
      return void (await say(esc(t("tg.help_group", lang))));
    case "bill":
      if (cmd.arg || m.photo?.length) return makeDraft(m, u, gid, lang, cmd.arg);
      await A.telegramSetPending(chatId, m.from.id, "await_bill", {});
      return void (await say(esc(t("tg.send_bill", lang)), { forceReply: true, placeholder: t("input.chat_ph", lang) }));
    case "report":
      return sendReport(chatId, u, gid, "group", lang, threadId);
    case "me": {
      const r = await T.sendMessage(m.from.id, esc(t("tg.reading", lang)));
      if (!r.ok) return void (await say(esc(tf("tg.start_private", lang, T.botUsername()))));
      await sendReport(m.from.id, u, gid, "member", lang);
      return void (await say(esc(t("tg.sent_private", lang))));
    }
    case "unbind": {
      const r = await A.run(() => A.telegramUnbind({ chat_id: chatId, user_id: u.user_id }));
      return void (await say(esc(r.ok ? t("tg.unbound", lang) : errText(r.code, r.params, lang))));
    }
    default:
      return;
  }
}

// ── buttons ─────────────────────────────────────────────────────────────────

async function onCallback(q: Dict): Promise<void> {
  const data = String(q.data ?? "");
  const u = await A.telegramUser(q.from.id);
  const lang = langOf(u, q.from);
  const msg = q.message;
  if (!u) return void (await T.answerCallback(q.id, t("tg.not_linked", lang), true));

  let m: RegExpExecArray | null;
  if ((m = /^g:([A-Za-z0-9]+)$/.exec(data))) {
    const r = await A.run(() => A.telegramSetGroup({ user_id: u.user_id, group_id: m![1] }));
    await T.answerCallback(q.id);
    if (r.ok && msg) await T.editMessage(msg.chat.id, msg.message_id, esc(tf("tg.group_set", lang, r.data.name)));
    return;
  }
  if ((m = /^d:([A-Za-z0-9_-]+):([sc])$/.exec(data))) {
    const [, draftId, op] = m;
    const own = await A.run(() => A.getDraft({ user_id: u.user_id, draft_id: draftId }));
    if (!own.ok) return void (await T.answerCallback(q.id, t("tg.not_yours", lang), true));
    if (op === "c") {
      await A.cancelDraft({ user_id: u.user_id, draft_id: draftId });
      await T.answerCallback(q.id);
      if (msg) await T.editMessage(msg.chat.id, msg.message_id, `${esc((own.data as Record<string, unknown>).description)}\n${esc(t("tg.cancelled", lang))}`);
      return;
    }
    const r = await A.run(() => A.saveDraftAsBill({ user_id: u.user_id, draft_id: draftId }));
    if (!r.ok) return void (await T.answerCallback(q.id, errText(r.code, r.params, lang), true));
    await T.answerCallback(q.id, t("tg.saved", lang));
    if (msg) {
      const html = String(msg.text ?? "").split("\n").slice(0, 1).map(esc).join("") + `\n✓ ${esc(t("tg.saved", lang))}`;
      await T.editMessage(msg.chat.id, msg.message_id, html);
    }
    return;
  }
  if ((m = /^r:([A-Za-z0-9]+):([gm]):(png|pdf)$/.exec(data))) {
    const [, gid, kind, fmt] = m;
    await T.answerCallback(q.id, t("rpt.downloading", lang));
    const r = await A.run(() => A.getReport({ user_id: u.user_id, group_id: gid, type: kind === "g" ? "group" : "member", format: fmt, lang }));
    const chatId = msg?.chat?.id ?? q.from.id;
    if (!r.ok || r.data.kind !== "file") {
      await T.sendMessage(chatId, esc(r.ok ? t("err.generic", lang) : errText(r.code, r.params, lang)));
      return;
    }
    if (fmt === "png") await T.sendPhoto(chatId, r.data.filename, r.data.bytes, "", msg?.message_thread_id);
    else await T.sendDocument(chatId, r.data.filename, r.data.bytes, r.data.type, "", msg?.message_thread_id);
    return;
  }
  await T.answerCallback(q.id);
}

// ── entry ───────────────────────────────────────────────────────────────────

export async function handleUpdate(u: Dict): Promise<void> {
  const m = u.message;
  const isGroup = m && (m.chat?.type === "group" || m.chat?.type === "supergroup");
  let cmd: ReturnType<typeof parseCommand> = null;
  if (m && isGroup) {
    if (m.migrate_to_chat_id) return void (await A.telegramChatMigrated(m.chat.id, m.migrate_to_chat_id));
    cmd = parseCommand(String(m.text ?? m.caption ?? ""));
    // Not a command for us and not a reply to one of our messages: ignore
    // before touching the database (a bot made admin sees every message).
    if (!cmd && !m.reply_to_message?.from?.is_bot) return;
  }
  if (typeof u.update_id === "number" && !(await A.telegramFirstSeen(u.update_id))) return;

  if (u.callback_query) return onCallback(u.callback_query);
  if (u.my_chat_member) {
    const st = u.my_chat_member.new_chat_member?.status;
    if (st === "left" || st === "kicked") await A.telegramChatGone(u.my_chat_member.chat.id);
    return;
  }
  if (!m || !m.from || m.from.is_bot || m.sender_chat) return;
  if (m.chat?.type === "private") return onPrivate(m);
  if (isGroup) return onGroup(m, cmd);
}
