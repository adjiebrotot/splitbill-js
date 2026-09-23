/**
 * Reports: every figure is the engine's, an individual report's lines on a
 * bill add up exactly to that member's share, the status says NOT SETTLED
 * until it is, and PNG / PDF render.
 */
import { describe, it, expect } from "vitest";
import { compute, viewOf } from "@/services/ledger";
import { groupReport, memberReport, renderText, fmtRate } from "@/services/report";
import { formatAmount } from "@/engine";
import type { GroupState } from "@/services/repo";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function state(seed: number, settled = false): GroupState {
  const r = rng(seed);
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const n = int(2, 6);
  const members = Array.from({ length: n }, (_, i) => ({ id: String(i + 1), name: "M" + (i + 1), user_id: i === 0 ? "u1" : null, username: null, position: i + 1, active: true }));
  const ids = members.map((m) => m.id);
  const sub = () => ids.filter(() => r() < 0.6).concat(ids[int(0, n - 1)]).filter((v, i, a) => a.indexOf(v) === i);
  const bills = Array.from({ length: int(1, 5) }, (_, i) => {
    const mode = (["items", "even", "percent"] as const)[int(0, 2)];
    const who = sub();
    const items = Array.from({ length: int(1, 4) }, (_, j) => ({ id: `${i}-${j}`, name: "item" + j, qty: "1", amount: String(int(1, 99999)), members: sub() }));
    const itemsTotal = items.reduce((s, x) => s + BigInt(x.amount), 0n);
    const adjustments = r() < 0.6 ? [{ kind: "tax" as const, amount: String(int(1, 5000)) }] : [];
    let left = 10000;
    const participants = who.map((m, k) => {
      const bp = k === who.length - 1 ? left : int(1, left - (who.length - 1 - k));
      left -= bp;
      return { member: m, bp: mode === "percent" ? bp : null };
    });
    const total = mode === "items" ? itemsTotal + adjustments.reduce((s, a) => s + BigInt(a.amount), 0n) : BigInt(int(1, 999999));
    return {
      id: String(i + 1), description: "Bill " + i, date: "2026-09-0" + int(1, 9), currency: "USD", dp: 2, mode,
      total: String(total), stated: null, payer: ids[int(0, n - 1)], source: "form", created_by: "u1",
      created_at: "", updated_at: "", version: 1,
      items: mode === "items" ? items : [], adjustments: mode === "items" ? adjustments : [], participants: mode === "items" ? [] : participants,
    };
  });
  return {
    group: { group_id: "G", kind: "travel", name: "Trip", owner: "u1", currency: "USD", dp: 2, timezone: "Asia/Jakarta",
      status: settled ? "settled" : "open", round: settled ? 1 : 0, revision: "1", invite_code: null,
      settled_at: settled ? "2026-09-10T10:00:00Z" : null, created_at: "" },
    members, bills, payments: [], transfers: [], rates: [],
  };
}

describe("reports", () => {
  it("group report balances are the engine's, and say NOT SETTLED while open", () => {
    const s = state(1);
    const v = viewOf(s, compute(s), "u1");
    const doc = groupReport(v, "en");
    expect(doc.status).toMatch(/^NOT SETTLED/);
    const table = doc.sections[0];
    if (table.kind !== "table") throw new Error("expected table");
    for (const b of v.balances) {
      const row = table.rows.find((r) => r[0] === "M" + b.id)!;
      const net = BigInt(String(b.net));
      expect(row[row.length - 1]).toBe((net > 0n ? "+" : net < 0n ? "-" : "") + formatAmount(net < 0n ? -net : net, 2, "en"));
    }
    expect(renderText(doc)).toContain("NOT SETTLED");
  });

  it("settled reports say so", () => {
    const s = state(2, true);
    const v = viewOf(s, compute(s), "u1");
    expect(groupReport(v, "id").status).toMatch(/^DISELESAIKAN/);
  });

  it("an individual report's lines on each bill add up to the share (500 groups)", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const s = state(seed);
      const v = viewOf(s, compute(s), "u1");
      for (const m of v.members) {
        const doc = memberReport(v, m.id, "en");
        const bills = doc.sections.find((x) => x.heading === "Bills");
        if (!bills || bills.kind !== "lines") continue;
        let sum = 0n;
        for (const l of bills.lines) {
          if (!l.indent) { sum = 0n; continue; }
          const val = BigInt((l.right ?? "0").split(" ")[0].replace(/[,.]/g, ""));
          if (l.text === "your share") expect(val, `seed ${seed} member ${m.id}`).toBe(sum);
          else sum += val;
        }
      }
    }
  });

  it("formats rates per language", () => {
    expect(fmtRate("16250", "en")).toBe("16,250");
    expect(fmtRate("16250.5", "id")).toBe("16.250,5");
    expect(fmtRate("0.0625", "en")).toBe("0.0625");
  });

  it("renders PNG and PDF", async () => {
    const s = state(3);
    const doc = groupReport(viewOf(s, compute(s), "u1"), "en");
    const { renderPng, renderPdf } = await import("@/services/report_binary");
    const png = await renderPng(doc);
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const pdf = await renderPdf(doc);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
  });
});
