/**
 * The Telegram medium end to end against Postgres, with the Bot API and the
 * AI mocked: linking by deep link, drafts with buttons, Save / Cancel,
 * double taps, other people's taps, update dedup, group binding, the
 * ForceReply flow, and unbinding when the bot is removed.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { schemaUrl, resetSchema } from "../helpers/db";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const URL_ = process.env.TEST_DATABASE_URL;
if (URL_) {
  process.env.DATABASE_URL = schemaUrl(URL_, "t_telegram");
  process.env.DB_DRIVER = "pg";
  process.env.SETUP_SECRET = "test-secret";
  process.env.TELEGRAM_BOT_TOKEN = "123:abc";
  process.env.TELEGRAM_BOT_USERNAME = "SplitBot";
  process.env.PUBLIC_BASE_URL = "https://split.test";
  process.env.LLM_API_KEY = "test";
}

vi.mock("@/services/ai_parse", async (orig) => {
  const real = await orig<typeof import("@/services/ai_parse")>();
  return {
    ...real,
    parseChat: vi.fn(async (text: string, ctx: import("@/services/ai_parse").ParseCtx, source: "chat" | "telegram") => {
      const all = ctx.members.filter((m) => m.active).map((m) => m.name);
      const draft = real.draftFromChat({
        description: text.split(" ")[0], date: null, currency: null, payer: "me", mode: "even",
        total_expr: (/\d+/.exec(text) ?? ["1000"])[0], people: all, percents: [], items: [], adjustments: [],
      }, ctx, source);
      return { draft, usage: { model: "mock", prompt_tokens: 0, completion_tokens: 0 }, raw: null };
    }),
  };
});

type Sent = { method: string; body: any };
const sent: Sent[] = [];
let msgId = 1000;

describe.skipIf(!URL_)("telegram bot", () => {
  let A: typeof import("@/services/actions");
  let U: typeof import("@/services/user_service");
  let bot: typeof import("@/telegram/bot");
  let db: typeof import("@/db");
  const uid: Record<string, string> = {};
  let gid = "";
  let upd = 1;

  const priv = (from: number, text: string) => ({ update_id: upd++, message: { message_id: upd, from: { id: from, first_name: "U" + from }, chat: { id: from, type: "private" }, text } });
  const grp = (from: number, text: string, extra: object = {}) => ({ update_id: upd++, message: { message_id: upd, from: { id: from, first_name: "U" + from }, chat: { id: -500, type: "supergroup" }, text, ...extra } });
  const tap = (from: number, data: string) => ({ update_id: upd++, callback_query: { id: "cb" + upd, from: { id: from }, data, message: { message_id: 77, chat: { id: from }, text: "Draft: x" } } });
  const texts = () => sent.filter((s) => s.method === "sendMessage" || s.method === "editMessageText").map((s) => String(s.body.text));
  const lastButtons = () => [...sent].reverse().find((s) => s.body?.reply_markup?.inline_keyboard?.length)?.body.reply_markup.inline_keyboard.flat() ?? [];

  beforeAll(async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      let body: any = {};
      try { body = JSON.parse(String(init?.body ?? "{}")); } catch { body = {}; }
      sent.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++msgId } }), { headers: { "content-type": "application/json" } });
    }));
    db = await import("@/db");
    await resetSchema("t_telegram");
    A = await import("@/services/actions");
    U = await import("@/services/user_service");
    bot = await import("@/telegram/bot");
    for (const n of ["ali", "bob", "cal"]) uid[n] = (await U.register({ username: n, display_name: n[0].toUpperCase() + n.slice(1), email: `${n}@t.test`, password: "secret-pw!" })).user_id;
    gid = (await A.createGroup({ user_id: uid.ali, kind: "travel", name: "Bali", currency: "IDR", members: ["Dan"] })).group_id;
    const v = await A.getGroupView({ user_id: uid.ali, group_id: gid });
    await A.joinByInvite({ user_id: uid.bob, code: v.group.invite_code! });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db?.closePool();
  });

  it("parses commands addressed to this bot only", () => {
    expect(bot.parseCommand("/bill@SplitBot lunch 60k")).toEqual({ cmd: "bill", arg: "lunch 60k", addressed: true });
    expect(bot.parseCommand("/report")).toEqual({ cmd: "report", arg: "", addressed: false });
    expect(bot.parseCommand("/bill@OtherBot x")).toBeNull();
    expect(bot.parseCommand("hello")).toBeNull();
  });

  it("an unlinked user is told how to link; a link code links", async () => {
    await bot.handleUpdate(priv(111, "hi"));
    expect(texts().pop()).toMatch(/not connected/);
    const { url } = await A.telegramLinkCode({ user_id: uid.ali });
    const code = url.split("start=")[1];
    await bot.handleUpdate(priv(111, `/start ${code}`));
    expect(texts().pop()).toMatch(/Connected as Ali/);
    // A used code cannot link a second account.
    await bot.handleUpdate(priv(999, `/start ${code}`));
    expect(texts().pop()).toMatch(/code is not right/);
    const bobCode = (await A.telegramLinkCode({ user_id: uid.bob })).url.split("start=")[1];
    await bot.handleUpdate(priv(222, `/start ${bobCode}`));
  });

  it("text becomes a draft; Save saves once; others cannot tap it; Cancel cancels", async () => {
    sent.length = 0;
    await bot.handleUpdate(priv(111, "Lunch 60000"));
    const save = lastButtons().find((b: any) => b.callback_data?.endsWith(":s"));
    expect(save).toBeTruthy();
    expect(lastButtons().find((b: any) => b.url)?.url).toMatch(/^https:\/\/split\.test\/app\/g\/[A-Z0-9]+#draft=/);
    await bot.handleUpdate(tap(222, save.callback_data));
    expect(sent.find((s) => s.method === "answerCallbackQuery" && /Only whoever sent this/.test(s.body.text))).toBeTruthy();
    await bot.handleUpdate(tap(111, save.callback_data));
    await bot.handleUpdate(tap(111, save.callback_data));
    const v = await A.getGroupView({ user_id: uid.ali, group_id: gid });
    expect(v.bills).toHaveLength(1);
    expect(v.bills[0].source).toBe("telegram");
    expect(v.balances.reduce((a, b) => a + b.net, 0n)).toBe(0n);

    await bot.handleUpdate(priv(111, "Taxi 30000"));
    const cancel = lastButtons().find((b: any) => b.callback_data?.endsWith(":c"));
    await bot.handleUpdate(tap(111, cancel.callback_data));
    expect(texts().pop()).toMatch(/Cancelled/);
    await bot.handleUpdate(tap(111, cancel.callback_data.replace(/:c$/, ":s")));
    expect((await A.getGroupView({ user_id: uid.ali, group_id: gid })).bills).toHaveLength(1);
  });

  it("a retried update is handled once", async () => {
    sent.length = 0;
    const u = priv(111, "/help");
    await bot.handleUpdate(u);
    await bot.handleUpdate(u);
    expect(sent.filter((s) => s.method === "sendMessage")).toHaveLength(1);
  });

  it("group chat: bind, /bill with text, /bill then a reply, strangers, unbind on removal", async () => {
    const code = (await A.telegramBindCode({ user_id: uid.ali, group_id: gid })).url.split("startgroup=")[1];
    // Only the owner's own code binds.
    await bot.handleUpdate(grp(222, `/start@SplitBot ${code}`));
    expect(texts().pop()).toMatch(/code is not right/);
    const code2 = (await A.telegramBindCode({ user_id: uid.ali, group_id: gid })).url.split("startgroup=")[1];
    await bot.handleUpdate(grp(111, `/start@SplitBot ${code2}`));
    expect(texts().pop()).toMatch(/now adds bills to Bali/);

    sent.length = 0;
    await bot.handleUpdate(grp(222, "/bill@SplitBot Dinner 90000"));
    expect(lastButtons().some((b: any) => b.callback_data?.endsWith(":s"))).toBe(true);

    await bot.handleUpdate(grp(222, "/bill"));
    expect(sent.some((s) => s.body?.reply_markup?.force_reply)).toBe(true);
    sent.length = 0;
    await bot.handleUpdate(grp(222, "Snacks 12000", { reply_to_message: { message_id: 5, from: { id: 1, is_bot: true } } }));
    expect(lastButtons().some((b: any) => b.callback_data?.endsWith(":s"))).toBe(true);

    // Chatter that is not for the bot is ignored without a reply.
    sent.length = 0;
    await bot.handleUpdate(grp(222, "see you at 7"));
    expect(sent).toHaveLength(0);

    await bot.handleUpdate(grp(333, "/report@SplitBot"));
    expect(texts().pop()).toMatch(/connect your account first/);

    await bot.handleUpdate({ update_id: upd++, my_chat_member: { chat: { id: -500 }, new_chat_member: { status: "left" } } });
    expect(await A.telegramChatGroup(-500)).toBeNull();
  });

  it("report buttons send a PNG", async () => {
    sent.length = 0;
    await bot.handleUpdate(priv(111, "/report"));
    const png = lastButtons().find((b: any) => /:png$/.test(b.callback_data));
    await bot.handleUpdate(tap(111, png.callback_data));
    expect(sent.some((s) => s.method === "sendPhoto")).toBe(true);
  });
});
