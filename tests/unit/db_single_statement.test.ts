/**
 * The bare helpers carry ONE statement, so they must not open a transaction of
 * their own.
 *
 * Postgres already wraps a lone statement in an implicit transaction, so BEGIN
 * and COMMIT around it change no semantics and cost two extra network round
 * trips. On the serverless path that is the whole cost of a read: the
 * statements run in single-digit milliseconds, and everything else is the wire.
 * A Neon query log taken before this change showed 60 BEGIN and 60 COMMIT for a
 * session whose real work was a few dozen statements.
 *
 * The part that MUST NOT regress is the other branch: a helper called from
 * inside `atomic()` / `withConn()` has to run on that block's own connection,
 * or it would neither see the block's uncommitted writes nor be rolled back
 * with them. These tests pin both branches — the standalone statement issues no
 * transaction bookkeeping, and the joined one runs on the ambient client and
 * still issues none of its own.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** Every statement the fake driver was asked to run, in order. */
const statements: string[] = [];
/** Which connection object ran each statement — "pool" or a client id. */
const ranOn: string[] = [];

let clientSeq = 0;

function makeClient(): any {
  const id = `client${++clientSeq}`;
  return {
    id,
    query: vi.fn(async (cfg: any) => {
      statements.push(cfg.text);
      ranOn.push(id);
      return { rows: [[1]], rowCount: 1, fields: [{ name: "?column?" }] };
    }),
    release: vi.fn(),
  };
}

const pool = {
  connect: vi.fn(async () => makeClient()),
  query: vi.fn(async (cfg: any) => {
    statements.push(cfg.text);
    ranOn.push("pool");
    return { rows: [[1]], rowCount: 1, fields: [{ name: "?column?" }] };
  }),
  end: vi.fn(async () => {}),
};

// DB_DRIVER=pg keeps the driver import off @neondatabase/serverless (which
// would want a WebSocket). The transaction/round-trip behaviour under test is
// driver-independent — it lives in db.ts, above whichever pool it holds.
vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(() => pool),
    types: { setTypeParser: vi.fn() },
  },
  Pool: vi.fn(() => pool),
  types: { setTypeParser: vi.fn() },
}));

process.env.DB_DRIVER = "pg";
process.env.DATABASE_URL = "postgres://u:p@host/db";

const { fetchone, fetchall, execute, withConn, atomic, closePool } = await import("@/db");

/** Transaction bookkeeping, as opposed to the caller's own SQL. */
const txKeywords = (s: string[]) =>
  s.filter((q) => /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(q));

beforeEach(async () => {
  await closePool().catch(() => {});
  statements.length = 0;
  ranOn.length = 0;
  clientSeq = 0;
  pool.connect.mockClear();
  pool.query.mockClear();
});

describe("bare helpers — one statement, no transaction of its own", () => {
  it("fetchone sends only the caller's SQL", async () => {
    await fetchone("SELECT 1", []);
    expect(statements).toEqual(["SELECT 1"]);
    expect(txKeywords(statements)).toEqual([]);
  });

  it("fetchall sends only the caller's SQL", async () => {
    await fetchall("SELECT 2", []);
    expect(statements).toEqual(["SELECT 2"]);
  });

  it("execute sends only the caller's SQL", async () => {
    await execute("UPDATE t SET a=1", []);
    expect(statements).toEqual(["UPDATE t SET a=1"]);
  });

  it("goes through pool.query, checking out no client to release", async () => {
    await fetchone("SELECT 1", []);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(ranOn).toEqual(["pool"]);
  });

  it("three reads cost three round trips, not nine", async () => {
    await fetchone("SELECT 1", []);
    await fetchall("SELECT 2", []);
    await execute("UPDATE t SET a=1", []);
    expect(statements).toHaveLength(3);
  });

  it("still returns null for an empty result and the rowcount for a write", async () => {
    pool.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0, fields: [] }));
    expect(await fetchone("SELECT 1 WHERE false", [])).toBeNull();
    pool.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 7, fields: [] }));
    expect(await execute("DELETE FROM t", [])).toBe(7);
  });
});

describe("inside a transaction — join it, never bypass it", () => {
  it("atomic() still brackets its block with BEGIN/COMMIT", async () => {
    await atomic(async () => {
      await execute("INSERT INTO t VALUES (1)", []);
    });
    expect(statements).toEqual(["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"]);
  });

  it("runs the helper on the block's connection, not the pool", async () => {
    await atomic(async () => {
      await fetchone("SELECT 1", []);
    });
    // Every statement on one and the same client; nothing went to pool.query,
    // which would have been a different connection that cannot see the block's
    // uncommitted writes.
    expect(new Set(ranOn).size).toBe(1);
    expect(ranOn).not.toContain("pool");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("adds no BEGIN/COMMIT of its own for a joined helper", async () => {
    await atomic(async () => {
      await fetchone("SELECT 1", []);
      await execute("UPDATE t SET a=1", []);
      await fetchall("SELECT 2", []);
    });
    expect(txKeywords(statements)).toEqual(["BEGIN", "COMMIT"]);
  });

  it("rolls the block back on a throw, and the helper's write with it", async () => {
    await expect(
      atomic(async () => {
        await execute("INSERT INTO t VALUES (1)", []);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(statements).toEqual([
      "BEGIN",
      "INSERT INTO t VALUES (1)",
      "ROLLBACK",
    ]);
  });

  it("withConn keeps its transaction — callers pass multi-statement blocks", async () => {
    await withConn(async (cur) => {
      await cur.execute("INSERT INTO t VALUES (1)", []);
      await cur.execute("INSERT INTO t VALUES (2)", []);
    });
    expect(statements).toEqual([
      "BEGIN",
      "INSERT INTO t VALUES (1)",
      "INSERT INTO t VALUES (2)",
      "COMMIT",
    ]);
  });

  it("a nested atomic() joins the outermost transaction", async () => {
    await atomic(async () => {
      await execute("INSERT INTO t VALUES (1)", []);
      await atomic(async () => {
        await execute("INSERT INTO t VALUES (2)", []);
      });
    });
    expect(txKeywords(statements)).toEqual(["BEGIN", "COMMIT"]);
    expect(new Set(ranOn).size).toBe(1);
  });
});
