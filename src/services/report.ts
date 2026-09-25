/**
 * services/report.ts: the Group and Individual reports as ONE document model,
 * built from a group view (every figure already computed by the engine) and
 * rendered three ways: plain text here (Copy, Telegram), PNG and PDF in
 * report_binary.ts. The renderers do no arithmetic; the one derived figure
 * here, the per-item breakdown in an individual report, ends in a "Rounding"
 * line so its lines always add up to the engine's share.
 */
import { displayRate, formatAmount, frac, roundHalfEven, type Frac } from "../engine";
import { t, tf } from "../i18n";
import type { GroupView, Stage } from "./ledger";

export interface Line {
  text: string;
  right?: string;
  muted?: boolean;
  bold?: boolean;
  indent?: boolean;
}

export type Section =
  | { heading: string; kind: "table"; columns: string[]; right: boolean[]; rows: string[][] }
  | { heading: string; kind: "lines"; lines: Line[] };

export interface ReportDoc {
  title: string;
  subtitle: string;
  status: string;
  /** open (NOT FINAL), final (FINAL, NOT SETTLED) or settled. */
  stage: Stage;
  /** The faint diagonal watermark; empty once settled. */
  stamp: string;
  summary: [string, string][];
  sections: Section[];
  /** "Made with" in the reader's language; `brand` follows it. */
  footer: string;
  brand: string;
}

/** Where the app lives, printed at the foot of every report. */
export const BRAND = "splitbill.adjiebrotots.com";

type View = GroupView;

function money(minor: unknown, ccy: string, dp: number, lang: string): string {
  return `${ccy} ${formatAmount(BigInt(String(minor)), dp, lang)}`;
}

function signed(minor: unknown, ccy: string, dp: number, lang: string): string {
  const v = BigInt(String(minor));
  const s = formatAmount(v < 0n ? -v : v, dp, lang);
  return `${ccy} ${v > 0n ? "+" : v < 0n ? "-" : ""}${s}`;
}

function fmtDate(iso: string, lang: string, tz?: string): string {
  if (iso === "-infinity") return t("rate.from_start", lang);
  const d = new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso);
  return new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: iso.length === 10 ? "UTC" : tz,
  }).format(d);
}

/** "16250.5" -> "16,250.5" (en) / "16.250,5" (id). */
export function fmtRate(text: string, lang: string): string {
  const [i, f] = text.split(".");
  const [thou, dec] = lang === "id" ? [".", ","] : [",", "."];
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, thou) + (f ? dec + f : "");
}

function names(v: View): Map<string, string> {
  return new Map(v.members.map((m) => [m.id, m.name]));
}

function statusLine(v: View, lang: string, now: Date): string {
  const tz = v.group.timezone;
  if (v.stage === "open") return `${t("rpt.not_final", lang)} · ${tf("rpt.as_of", lang, fmtDate(now.toISOString(), lang, tz))}`;
  if (v.stage === "final") {
    const head = `${t("rpt.final", lang)} · ${t("rpt.not_settled", lang)}`;
    const stored = v.transfers.filter((x) => x.id !== null);
    if (!stored.length) return `${head} · ${tf("rpt.as_of", lang, fmtDate(now.toISOString(), lang, tz))}`;
    const paid = stored.filter((x) => x.status === "paid").length;
    return `${head} · ${paid}/${stored.length} ${t("xfer.paid", lang).toLowerCase()}`;
  }
  // Settled: the later of the last payment and the day the numbers were locked.
  const locked = v.group.settled_at ? new Date(String(v.group.settled_at)).toISOString() : "";
  const on = v.payments.reduce((d, p) => (p.date > d.slice(0, 10) ? p.date : d), locked) || now.toISOString();
  return tf("rpt.settled_on", lang, fmtDate(on, lang, tz));
}

function stampOf(v: View, lang: string): string {
  return v.stage === "open" ? t("rpt.not_final", lang) : v.stage === "final" ? t("rpt.not_settled", lang) : "";
}

function rateLines(v: View, lang: string): Line[] {
  const used = new Map<string, NonNullable<View["bills"][number]["rate"]>>();
  for (const b of v.bills) if (b.rate) used.set(`${b.rate.currency}|${b.rate.effective}`, b.rate);
  for (const p of v.payments) if (p.rate) used.set(`${p.rate.currency}|${p.rate.effective}`, p.rate);
  return [...used.values()].sort((a, b) => (a.currency + a.effective < b.currency + b.effective ? -1 : 1)).map((r) => {
    const d = displayRate(r.rate, r.inverted);
    const rate = fmtRate(d.text, lang);
    const pair = d.inverted ? `1 ${v.group.currency} = ${rate} ${r.currency}` : `1 ${r.currency} = ${rate} ${v.group.currency}`;
    const from = r.effective === "-infinity" ? t("rate.from_start", lang).toLowerCase() : fmtDate(r.effective, lang);
    return { text: `${pair} · ${from}`, muted: true };
  });
}

export function groupReport(v: View, lang: string, now = new Date()): ReportDoc {
  const g = v.group;
  const nm = names(v);
  const hasPayments = v.balances.some((b) => BigInt(String(b.sent)) !== 0n || BigInt(String(b.received)) !== 0n);
  const rows = v.balances
    .filter((b) => v.members.find((m) => m.id === b.id)?.active || BigInt(String(b.net)) !== 0n || BigInt(String(b.paid)) !== 0n)
    .map((b) => {
      const row = [nm.get(b.id) ?? "?", g.currency, formatAmount(BigInt(String(b.paid)), g.dp, lang), formatAmount(BigInt(String(b.share)), g.dp, lang)];
      if (hasPayments) {
        const pay = BigInt(String(b.sent)) - BigInt(String(b.received));
        row.push(pay === 0n ? "-" : signed(pay, g.currency, g.dp, lang).replace(`${g.currency} `, ""));
      }
      row.push(signed(b.net, g.currency, g.dp, lang).replace(`${g.currency} `, ""));
      return row;
    });
  const columns = [t("rpt.col_member", lang), t("rpt.col_ccy", lang), t("rpt.col_paid", lang), t("rpt.col_share", lang)];
  if (hasPayments) columns.push(t("rpt.payments", lang));
  columns.push(t("rpt.col_net", lang));

  const transfers: Line[] = v.transfers.length
    ? v.transfers.map((x) => ({
        text: `${nm.get(x.from)} → ${nm.get(x.to)}${x.status === "paid" ? " " + t("rpt.paid_tag", lang) : ""}`,
        right: money(x.amount, g.currency, g.dp, lang),
        muted: x.status === "paid",
        bold: x.status !== "paid",
      }))
    : [{ text: t("rpt.none", lang), muted: true }];

  const sections: Section[] = [
    { heading: t("rpt.balances", lang), kind: "table", columns, right: columns.map((_, i) => i > 1), rows },
    { heading: t("rpt.transfers", lang), kind: "lines", lines: transfers },
  ];
  const rates = rateLines(v, lang);
  if (rates.length) sections.push({ heading: t("rpt.rates", lang), kind: "lines", lines: rates });
  return {
    title: g.name,
    subtitle: t("rpt.group_title", lang),
    status: statusLine(v, lang, now),
    stage: v.stage,
    stamp: stampOf(v, lang),
    summary: [
      [t("new.currency", lang), g.currency],
      [t("bal.spent", lang), money(v.spent, g.currency, g.dp, lang)],
    ],
    sections,
    footer: t("rpt.footer", lang),
    brand: BRAND,
  };
}

/** One member's lines on one bill, adding up exactly to their share x. */
function billLines(b: View["bills"][number], memberId: string, lang: string): Line[] {
  const x = BigInt(String(b.shares[memberId]?.[0] ?? "0"));
  if (x === 0n) return [];
  const out: Line[] = [];
  let listed = 0n;
  if (b.mode === "items") {
    let sub: Frac = frac(0n);
    let itemsSub = 0n;
    for (const i of b.items) {
      const a = BigInt(i.amount);
      itemsSub += a;
      if (!i.members.includes(memberId) || a === 0n) continue;
      const k = BigInt(i.members.length);
      sub = frac(sub.num * k + a * sub.den, sub.den * k);
      const shown = roundHalfEven(a, k);
      listed += shown;
      out.push({ text: k > 1n ? `${i.name} (1/${k})` : i.name, right: formatAmount(shown, b.dp, lang), indent: true });
    }
    const adj = b.adjustments.reduce((s, a) => s + BigInt(a.amount), 0n);
    if (adj !== 0n && itemsSub > 0n) {
      const shown = roundHalfEven(adj * sub.num, itemsSub * sub.den);
      listed += shown;
      out.push({ text: b.adjustments.map((a) => t("adj." + a.kind, lang)).join(", "), right: formatAmount(shown, b.dp, lang), indent: true });
    }
  } else if (b.mode === "even") {
    listed = x;
    out.push({ text: `${t("mode.even", lang)} (1/${b.participants.length})`, right: formatAmount(x, b.dp, lang), indent: true });
  } else {
    const p = b.participants.find((q) => q.member === memberId);
    listed = x;
    out.push({ text: `${((p?.bp ?? 0) / 100).toFixed(2).replace(/\.?0+$/, "")}%`, right: formatAmount(x, b.dp, lang), indent: true });
  }
  if (listed !== x) out.push({ text: t("rpt.rounding", lang), right: formatAmount(x - listed, b.dp, lang), indent: true, muted: true });
  return out;
}

export function memberReport(v: View, memberId: string, lang: string, now = new Date()): ReportDoc {
  const g = v.group;
  const nm = names(v);
  const who = nm.get(memberId) ?? "?";
  const bal = v.balances.find((b) => b.id === memberId);
  const net = BigInt(String(bal?.net ?? "0"));

  const pay = v.transfers.filter((x) => x.from === memberId);
  const get = v.transfers.filter((x) => x.to === memberId);
  const xfer = (list: typeof pay, other: "from" | "to"): Line[] => list.map((x) => ({
    text: `${nm.get(x[other])}${x.status === "paid" ? " " + t("rpt.paid_tag", lang) : ""}`,
    right: money(x.amount, g.currency, g.dp, lang),
    muted: x.status === "paid",
    bold: x.status !== "paid",
  }));

  const sections: Section[] = [];
  if (pay.length) sections.push({ heading: t("rpt.you_pay", lang), kind: "lines", lines: xfer(pay, "to") });
  if (get.length) sections.push({ heading: t("rpt.you_get", lang), kind: "lines", lines: xfer(get, "from") });
  if (!pay.length && !get.length) sections.push({ heading: t("rpt.transfers", lang), kind: "lines", lines: [{ text: t("rpt.none", lang), muted: true }] });

  const billL: Line[] = [];
  for (const b of v.bills) {
    const mine = b.shares[memberId];
    const paid = b.payer === memberId;
    if (!mine && !paid) continue;
    billL.push({
      text: `${fmtDate(b.date, lang)} · ${b.description} · ${tf("rpt.paid_by", lang, nm.get(b.payer) ?? "?")}`,
      right: money(b.total, b.currency, b.dp, lang),
      bold: true,
    });
    billL.push(...billLines(b, memberId, lang));
    if (mine) {
      const conv = b.currency !== g.currency && mine[1] != null ? ` = ${money(mine[1], g.currency, g.dp, lang)}` : "";
      billL.push({ text: t("rpt.your_share", lang), right: money(mine[0], b.currency, b.dp, lang) + conv, indent: true });
    }
  }
  if (billL.length) sections.push({ heading: t("rpt.bills", lang), kind: "lines", lines: billL });

  const payL: Line[] = v.payments.filter((p) => p.from === memberId || p.to === memberId).map((p) => ({
    text: `${fmtDate(p.date, lang)} · ${nm.get(p.from)} → ${nm.get(p.to)}`,
    right: money(p.amount, p.currency, p.dp, lang) + (p.currency !== g.currency && p.converted != null ? ` = ${money(p.converted, g.currency, g.dp, lang)}` : ""),
  }));
  if (payL.length) sections.push({ heading: t("rpt.payments", lang), kind: "lines", lines: payL });
  const rates = rateLines(v, lang);
  if (rates.length) sections.push({ heading: t("rpt.rates", lang), kind: "lines", lines: rates });

  return {
    title: g.name,
    subtitle: tf("rpt.member_title", lang, who),
    status: statusLine(v, lang, now),
    stage: v.stage,
    stamp: stampOf(v, lang),
    summary: [
      [t("rpt.col_paid", lang), money(bal?.paid ?? 0, g.currency, g.dp, lang)],
      [t("rpt.col_share", lang), money(bal?.share ?? 0, g.currency, g.dp, lang)],
      [t(net > 0n ? "bal.you_get" : net < 0n ? "bal.you_owe" : "bal.mine", lang), money(net < 0n ? -net : net, g.currency, g.dp, lang)],
    ],
    sections,
    footer: t("rpt.footer", lang),
    brand: BRAND,
  };
}

/** Plain text for Copy and Telegram: no alignment tricks, reads fine in any chat app. */
export function renderText(doc: ReportDoc): string {
  const out: string[] = [];
  out.push(`*${doc.title}*`);
  out.push(doc.subtitle);
  out.push(doc.status);
  out.push("");
  for (const [k, v] of doc.summary) out.push(`${k}: ${v}`);
  for (const s of doc.sections) {
    out.push("");
    out.push(`*${s.heading}*`);
    if (s.kind === "table") {
      for (const r of s.rows) {
        out.push(`${r[0]}: ` + r.slice(1).map((c, i) => `${s.columns[i + 1].toLowerCase()} ${c}`).join(", "));
      }
    } else {
      for (const l of s.lines) out.push(`${l.indent ? "  " : ""}${l.text}${l.right ? ": " + l.right : ""}`);
    }
  }
  out.push("");
  out.push(`${doc.footer} ${doc.brand}`);
  return out.join("\n");
}
