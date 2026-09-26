/**
 * db.ts — PostgreSQL connection + helpers. Copied from finance-tracker-js.
 *
 * Contract:
 *   - Rows come back as ARRAYS (rowMode:"array"), mirroring Python's tuple
 *     cursors so `row[0]` maps 1:1. Column order is exactly the SELECT order.
 *   - `withConn(fn)` mirrors `with get_conn() as conn: with conn.cursor() as cur`.
 *     The block runs in a transaction that commits on success / rolls back on
 *     throw — exactly like psycopg2's implicit per-context transaction. Callers
 *     pass multi-statement blocks that depend on that atomicity.
 *   - `atomic(fn)` mirrors `db.atomic()`: one shared connection, one commit at
 *     block end, rollback on exception, nested calls join the outermost tx.
 *     Ambient connection is tracked via AsyncLocalStorage (parity with the
 *     Python contextvars ambient connection).
 *   - The bare helpers (fetchone/fetchall/execute) carry ONE statement, so they
 *     do NOT open a transaction of their own — see `querySingle` below.
 *   - `%s` placeholders are converted to `$1,$2,…` at authoring time in every
 *     ported query; this layer passes SQL through unchanged.
 *   - Lazy connect: the pool is created on first query, never at import time,
 *     so anonymous requests do zero DB I/O.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type Row = unknown[];

interface QueryResult {
  rows: Row[];
  rowCount: number | null;
  fields?: Array<{ name: string }>;
}

interface PoolClient {
  query(config: {
    text: string;
    values?: unknown[];
    rowMode?: "array";
  }): Promise<QueryResult>;
  release(): void;
}

interface Pool {
  connect(): Promise<PoolClient>;
  query(config: {
    text: string;
    values?: unknown[];
    rowMode?: "array";
  }): Promise<QueryResult>;
  end(): Promise<void>;
}

let _pool: Pool | null = null;

/**
 * Normalize the `sslmode` query parameter to `verify-full`.
 *
 * pg-connection-string@2.14.0 (bundled with pg@8) calls `process.emitWarning`
 * — surfaced as an `[error]` line in serverless logs — the first time it parses
 * a connection string whose `sslmode` is `prefer`, `require`, or `verify-ca`,
 * because those are all currently treated as aliases for `verify-full`. In prod
 * the Neon pooler presents a valid, hostname-matching certificate, so this
 * verify-full behavior already applies; rewriting the value to `verify-full`
 * explicitly keeps the exact same SSL semantics while silencing the warning.
 * Other modes (`disable`, `no-verify`, an already-explicit `verify-full`, or an
 * absent sslmode) are left untouched.
 */
export function _normalizeSslMode(connectionString: string): string {
  return connectionString.replace(
    /([?&]sslmode=)(prefer|require|verify-ca)\b/gi,
    "$1verify-full",
  );
}

async function getPool(): Promise<Pool> {
  if (_pool) return _pool;
  const rawConnectionString = process.env.DATABASE_URL;
  if (!rawConnectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const connectionString = _normalizeSslMode(rawConnectionString);
  const driver = (process.env.DB_DRIVER || "neon").toLowerCase();

  if (driver === "pg") {
    const pg = await import("pg");
    // DATE (OID 1082) -> raw "YYYY-MM-DD" string ("-infinity" stays as-is).
    // TIMESTAMPTZ stays a Date instant. BIGINT (OID 20) stays a string; read
    // money through num.toMinor().
    pg.types.setTypeParser(1082, (v: string) => v);
    _pool = new pg.Pool({ connectionString, max: 10 }) as unknown as Pool;
  } else {
    const neon = await import("@neondatabase/serverless");
    (neon as any).types?.setTypeParser?.(1082, (v: string) => v);
    // In the Node runtime the serverless driver needs a WebSocket impl; the edge
    // runtime provides a global WebSocket, so only patch when missing.
    if (!neon.neonConfig.webSocketConstructor) {
      try {
        const ws = await import("ws");
        neon.neonConfig.webSocketConstructor =
          ws.default as unknown as typeof WebSocket;
      } catch {
        /* edge runtime: global WebSocket is used */
      }
    }
    // Send `pool.query()` — and ONLY that — over Neon's SQL-over-HTTP endpoint
    // instead of a WebSocket. `querySingle` is the sole caller, so this covers
    // exactly the one-statement reads and leaves every transaction on the
    // WebSocket path, where `pool.connect()` still goes.
    //
    // WHY IT IS THE BIGGER HALF OF THE SAVING. A serverless invocation is a
    // fresh process with a cold pool, so the first query on the WebSocket path
    // pays a TLS + WebSocket handshake and a Postgres session startup before it
    // sends any SQL, then leaves a pooler connection parked until the instance
    // is frozen. Over HTTP the same statement is one request with no session to
    // set up, nothing to tear down, and no pooler slot held afterwards.
    //
    // Parity is exact, and it is worth naming why rather than trusting it:
    //   - `rowMode:"array"` is translated to the HTTP client's `arrayMode`, so
    //     rows stay ARRAYS (§2b of the porting contract).
    //   - the driver requests `fullResults`, so `rows` / `rowCount` / `fields`
    //     all arrive exactly as the WebSocket path returns them.
    //   - type parsers resolve through the same global pg-types registry the
    //     `setTypeParser(1082, …)` above writes to, so DATE stays a
    //     "YYYY-MM-DD" string on both paths.
    //   - errors arrive as NeonDbError carrying `code`, so callers that branch
    //     on a SQLSTATE (presence_service on 42703, the shortcut/holding-cost
    //     column probes) behave identically.
    //
    // DB_HTTP_READS=0 forces every read back onto the WebSocket path, so this
    // can be reverted by an environment change rather than a deploy.
    if (process.env.DB_HTTP_READS !== "0") {
      neon.neonConfig.poolQueryViaFetch = true;
    }
    _pool = new neon.Pool({ connectionString }) as unknown as Pool;
  }
  return _pool;
}

/** Ambient transaction connection (parity with Python `_ambient_conn`). */
const _als = new AsyncLocalStorage<{ client: PoolClient }>();

/** True inside atomic() / withConn(): reads see this block's uncommitted writes. */
export function inTransaction(): boolean {
  return _als.getStore() !== undefined;
}

async function runInTx<T>(fn: () => Promise<T>): Promise<T> {
  const existing = _als.getStore();
  if (existing) {
    // Already inside a transaction — join it (no BEGIN/COMMIT here).
    return fn();
  }
  const pool = await getPool();
  const client = await pool.connect();
  try {
    return await _als.run({ client }, async () => {
      await client.query({ text: "BEGIN" });
      try {
        const result = await fn();
        await client.query({ text: "COMMIT" });
        return result;
      } catch (e) {
        try {
          await client.query({ text: "ROLLBACK" });
        } catch {
          /* ignore rollback failure; surface the original error */
        }
        throw e;
      }
    });
  } finally {
    client.release();
  }
}

/**
 * Run ONE statement, without a transaction of its own.
 *
 * WHY THERE IS NO BEGIN/COMMIT HERE. Postgres already wraps a lone statement in
 * an implicit transaction: it commits when the statement succeeds and rolls
 * back when it throws. Sending BEGIN and COMMIT around it buys nothing and
 * costs two extra network round trips — and on the serverless path a round trip
 * is the whole cost of a read, since the statements themselves run in
 * single-digit milliseconds. The bare helpers below carry one statement each
 * and were paying that tax on every call; a report's FX lookups alone turned
 * ~35 reads into ~105 round trips.
 *
 * INSIDE `atomic()` / `withConn()` NOTHING CHANGES. A helper called from within
 * a transaction MUST run on that transaction's connection, or it would neither
 * see the block's uncommitted writes nor be rolled back with them. The ambient
 * store is checked first for exactly that reason, and the statement is issued
 * on the block's own client with no BEGIN/COMMIT of its own — which is what
 * `runInTx` did for a joined call anyway.
 *
 * Only the standalone case reaches the pool, and it goes through `pool.query()`
 * rather than `pool.connect()` so the Neon driver can serve it over HTTP (see
 * `getPool`). No client is checked out, so there is none to leak or release.
 */
async function querySingle(
  sql: string,
  params: unknown[],
): Promise<QueryResult> {
  const store = _als.getStore();
  if (store) {
    return store.client.query({ text: sql, values: params, rowMode: "array" });
  }
  const pool = await getPool();
  return pool.query({ text: sql, values: params, rowMode: "array" });
}

/**
 * Cursor over a single query result. Mirrors psycopg2's cursor: async
 * `execute`, then SYNC `fetchone` / `fetchall` reading the buffered rows.
 */
export class Cursor {
  private _result: QueryResult | null = null;
  constructor(private client: PoolClient) {}

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this._result = await this.client.query({
      text: sql,
      values: params,
      rowMode: "array",
    });
  }

  fetchone(): Row | null {
    const rows = this._result?.rows ?? [];
    return rows.length ? rows[0] : null;
  }

  fetchall(): Row[] {
    return this._result?.rows ?? [];
  }

  get rowcount(): number {
    return this._result?.rowCount ?? -1;
  }

  /** Column names of the last result, mirroring psycopg2 `cur.description`
   *  where each entry's `[0]` is the column name. */
  get description(): Array<[string]> | null {
    const fields = this._result?.fields;
    return fields ? fields.map((f) => [f.name] as [string]) : null;
  }
}

/**
 * Mirrors `with get_conn() as conn: with conn.cursor() as cur:` — runs `fn`
 * with a cursor inside a transaction that commits on success / rolls back on
 * throw. Joins the ambient `atomic()` transaction when already inside one.
 */
export async function withConn<T>(fn: (cur: Cursor) => Promise<T>): Promise<T> {
  return runInTx(async () => {
    const store = _als.getStore()!;
    const cur = new Cursor(store.client);
    return fn(cur);
  });
}

/** Mirrors `db.atomic()`: one transaction spanning the whole block. */
export function atomic<T>(fn: () => Promise<T>): Promise<T> {
  return runInTx(fn);
}

/**
 * Execute a raw, possibly multi-statement SQL script (no params) via the
 * simple query protocol, inside the current/ambient transaction. Migration and
 * seed files contain several `;`-separated statements, which the extended
 * (parameterized) protocol rejects — omitting `values` keeps it simple-query.
 */
export async function executeScript(sql: string): Promise<void> {
  await runInTx(async () => {
    const store = _als.getStore()!;
    await store.client.query({ text: sql });
  });
}

export async function fetchone(
  sql: string,
  params: unknown[] = [],
): Promise<Row | null> {
  const rows = (await querySingle(sql, params)).rows;
  return rows.length ? rows[0] : null;
}

export async function fetchall(
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  return (await querySingle(sql, params)).rows;
}

export async function execute(
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  return (await querySingle(sql, params)).rowCount ?? -1;
}

/**
 * Renumber psycopg2-style `%s` placeholders to `$1,$2,…` in order. Lets ported
 * queries keep the Python SQL text verbatim. Safe for this codebase: it never
 * uses LIKE '%...%' or literal `%s` in SQL strings.
 */
export function sub(sql: string): string {
  let i = 0;
  return sql.replace(/%s/g, () => `$${++i}`);
}

/** Test/harness helper — closes the pool so the process can exit cleanly. */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
