/**
 * services/email_service.ts — transactional email via the Resend HTTP API.
 * Adapted from finance-tracker (rebranded; logic unchanged).
 *
 * Resend is HTTP-only (no long-lived SMTP socket), which is the right fit for
 * the serverless runtime this app deploys to — every send is a single fetch()
 * to https://api.resend.com/emails.
 *
 * Config (env):
 *   RESEND_API_KEY   Resend secret ("re_..."). When ABSENT, sends are a no-op
 *                    that logs the code to the server console — so the whole
 *                    registration flow works end-to-end in local dev without a
 *                    provider. Only prod needs the key.
 *   EMAIL_FROM       From header. Defaults to the verified sender domain
 *                    "Split Bill No-reply <no-reply-splitbill@adjiebrotots.com>".
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export const DEFAULT_FROM =
  "Split Bill No-reply <no-reply-splitbill@adjiebrotots.com>";

type Lang = "en" | "id";

interface SendResult {
  ok: boolean;
  /** true when no provider was configured and the code was only logged. */
  dev?: boolean;
  error?: string;
}

function _from(): string {
  return process.env.EMAIL_FROM || DEFAULT_FROM;
}

function _esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Whether a provider is set up. Without one no email leaves the server, so
 *  the app does not ask anyone to confirm an address. */
export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/** Raw send. Returns a structured result; never throws on network failure. */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(
      `[email] RESEND_API_KEY not set — would send to ${opts.to}: ${opts.subject}`,
    );
    return { ok: true, dev: true };
  }
  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: _from(),
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        ...(opts.text ? { text: opts.text } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) return { ok: true };
    const detail = await resp.text().catch(() => "");
    console.log(`[email] Resend error ${resp.status}: ${detail}`);
    return { ok: false, error: `Email provider returned ${resp.status}.` };
  } catch (e) {
    console.log(`[email] send failed: ${e}`);
    return { ok: false, error: "Could not reach the email provider." };
  }
}

const _COPY: Record<Lang, { subject: string; heading: string; intro: (n: string) => string; expiry: (when: string) => string; ignore: string; footer: string }> = {
  en: {
    subject: "Your Split Bill verification code",
    heading: "Confirm your email",
    intro: (n) => `Hi ${n}, welcome to Split Bill. Use this code to activate your account:`,
    expiry: (when) => `This code expires by ${when}.`,
    ignore: "If you did not create this account, you can ignore this email.",
    footer: "Split Bill by adjiebrotot",
  },
  id: {
    subject: "Kode verifikasi Split Bill",
    heading: "Konfirmasi emailmu",
    intro: (n) => `Hai ${n}, selamat datang di Split Bill. Pakai kode ini untuk mengaktifkan akunmu:`,
    expiry: (when) => `Kode ini kedaluwarsa pada ${when}.`,
    ignore: "Jika kamu tidak membuat akun ini, abaikan saja email ini.",
    footer: "Split Bill oleh adjiebrotot",
  },
};

/** Coerce a longOffset ("GMT+08:00") to a compact form ("GMT+8", "GMT+5:30"). */
function _prettyOffset(longOffset: string): string {
  // Some locales render the offset with "." and/or a leading zero; accept both.
  const m = /^GMT([+-])(\d{2})[:.](\d{2})$/.exec(longOffset);
  if (!m) return longOffset || "UTC"; // "GMT" (== UTC) or anything unexpected
  const hours = String(parseInt(m[2], 10));
  return `GMT${m[1]}${hours}${m[3] === "00" ? "" : ":" + m[3]}`;
}

/**
 * Human label for a timezone at a given instant, e.g. "GMT+8" for
 * Australia/Perth or "BST (GMT+1)" for Europe/London. The abbreviation (when
 * the locale exposes one) is taken in the user's language; the numeric offset
 * is read in a fixed locale so its punctuation is stable.
 */
function _tzLabel(when: Date, tz: string, locale: string): string {
  const name = (loc: string, opt: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(loc, { timeZone: tz, ...opt })
      .formatToParts(when)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  const pretty = _prettyOffset(name("en-GB", { timeZoneName: "longOffset" }));
  const short = name(locale, { timeZoneName: "short" });
  if (!short || /^(GMT|UTC)/i.test(short)) return pretty;
  return `${short} (${pretty})`;
}

// Fall back to the deployment's global timezone when a user has none stored.
const _DEFAULT_TZ = process.env.USER_TIMEZONE || "Asia/Jakarta";

/** A timezone Intl can format with, else the deployment default. */
function _safeTz(tz?: string | null): string {
  const z = String(tz || "").trim();
  if (!z) return _DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: z });
    return z;
  } catch {
    return _DEFAULT_TZ;
  }
}

/**
 * Format an expiry instant as an exact wall-clock time in the user's own
 * timezone, e.g. "29 May 2026 14:40 GMT+8". Reads far clearer than a vague
 * "24 hours" and lands in the reader's local time.
 */
function _formatExpiry(when: Date, lang: Lang, tz?: string | null): string {
  const zone = _safeTz(tz);
  const locale = lang === "id" ? "id-ID" : "en-GB";
  const parts = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: zone,
  }).formatToParts(when);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("day")} ${g("month")} ${g("year")} ${g("hour")}:${g("minute")} ${_tzLabel(when, zone, locale)}`;
}

/** Send the 6-digit account-activation code in the user's chosen language. */
export async function sendVerificationEmail(
  to: string,
  code: string,
  displayName: string,
  lang: Lang = "en",
  expiresAt?: Date,
  timezone?: string | null,
): Promise<SendResult> {
  const c = _COPY[lang] || _COPY.en;
  const name = _esc(displayName || "there");
  // Fall back to 24h from now if no explicit expiry was threaded through.
  const when = _formatExpiry(expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000), lang, timezone);
  const expiry = c.expiry(when);
  const html = `<!doctype html><html><body style="margin:0;background:#f2f6fd;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#20304a">
  <div style="max-width:460px;margin:0 auto;padding:32px 20px">
    <div style="background:#ffffff;border:1px solid #e2e9f5;border-radius:18px;padding:32px 28px">
      <div style="font-size:26px;font-weight:700;color:#3b6fd6;margin-bottom:6px">Split Bill</div>
      <h1 style="font-size:18px;margin:18px 0 10px">${_esc(c.heading)}</h1>
      <p style="font-size:14px;line-height:1.5;color:#4a5a74;margin:0 0 22px">${_esc(c.intro(name))}</p>
      <div style="text-align:center;margin:0 0 22px">
        <span style="display:inline-block;font-size:34px;font-weight:700;letter-spacing:10px;color:#20304a;background:#eef3fc;border-radius:12px;padding:16px 22px">${_esc(code)}</span>
      </div>
      <p style="font-size:13px;color:#7a89a3;margin:0 0 6px">${_esc(expiry)}</p>
      <p style="font-size:13px;color:#7a89a3;margin:0">${_esc(c.ignore)}</p>
    </div>
    <p style="text-align:center;font-size:11px;color:#9aa7bd;margin-top:16px">${_esc(c.footer)}</p>
  </div></body></html>`;
  const text = `${c.intro(displayName || "there")}\n\n    ${code}\n\n${expiry}\n${c.ignore}`;
  return sendEmail({ to, subject: c.subject, html, text });
}
