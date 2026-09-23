/** The webhook refuses any request without Telegram's secret token. */
import { describe, it, expect, beforeEach } from "vitest";

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123456789:test-token";
});

describe("webhook auth", () => {
  it("derives a stable secret from the bot token, none without one", async () => {
    const { webhookSecretToken } = await import("@/telegram/api");
    expect(webhookSecretToken()).toBe(webhookSecretToken());
    expect(webhookSecretToken()).toMatch(/^[0-9a-f]{64}$/);
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(webhookSecretToken()).toBeNull();
  });

  it("answers 401 to a forged or missing secret", async () => {
    const { POST } = await import("../../app/webhook/route");
    const body = JSON.stringify({ update_id: 1, message: { text: "/start", chat: { id: 1, type: "private" }, from: { id: 1 } } });
    expect((await POST(new Request("http://x/webhook", { method: "POST", body }))).status).toBe(401);
    expect((await POST(new Request("http://x/webhook", { method: "POST", body, headers: { "x-telegram-bot-api-secret-token": "nope" } }))).status).toBe(401);
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect((await POST(new Request("http://x/webhook", { method: "POST", body, headers: { "x-telegram-bot-api-secret-token": "" } }))).status).toBe(401);
  });
});
