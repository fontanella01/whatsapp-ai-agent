import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzlePglite<typeof schema>>;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

type SqlRunner = (sql: string) => Promise<unknown>;

// Applies every .sql file in migrations/ in name order, once.
// A tiny table remembers which ones already ran.
async function migrate(run: SqlRunner, query: (sql: string) => Promise<string[]>) {
  await run("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set(await query("SELECT name FROM schema_migrations"));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await run("BEGIN");
    try {
      await run(sql);
      await run(`INSERT INTO schema_migrations (name) VALUES ('${file.replace(/'/g, "''")}')`);
      await run("COMMIT");
    } catch (err) {
      await run("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
}

// With DATABASE_URL: a real PostgreSQL server (production).
// Without it: PGlite, a full PostgreSQL compiled to WebAssembly that runs inside
// Node — no install needed for development and tests. `dataDir` keeps data on
// disk; leaving it empty keeps everything in memory (used by the tests).
export async function createDb(opts: { url?: string; dataDir?: string } = {}): Promise<{ db: Db; close: () => Promise<void> }> {
  if (opts.url) {
    const pool = new pg.Pool({ connectionString: opts.url });
    // BEGIN/COMMIT must run on the same connection, so migrations use one dedicated client.
    const conn = await pool.connect();
    try {
      await migrate(
        (sql) => conn.query(sql),
        async (sql) => (await conn.query(sql)).rows.map((r) => r.name),
      );
    } finally {
      conn.release();
    }
    // Same schema and query API as the PGlite driver, so the rest of the app does not care.
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    return { db, close: () => pool.end() };
  }

  const client = new PGlite(opts.dataDir);
  await migrate(
    (sql) => client.exec(sql),
    async (sql) => (await client.query<{ name: string }>(sql)).rows.map((r) => r.name),
  );
  return { db: drizzlePglite(client, { schema }), close: () => client.close() };
}
