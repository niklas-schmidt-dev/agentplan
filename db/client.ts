import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { agentplanPool?: Pool };

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const pool = new Pool({ connectionString, max: 10 });
  attachDatabasePool(pool);
  return pool;
}

function getPool(): Pool {
  const pool = globalForDb.agentplanPool ?? createPool();
  globalForDb.agentplanPool = pool;
  return pool;
}

// Lazy so that importing this module (e.g. during `next build`) needs no secrets;
// the pool is only created on first query. Cached on globalThis across dev reloads.
let cachedDb: Database | undefined;

export function getDb(): Database {
  if (!cachedDb) {
    cachedDb = drizzle(getPool(), { schema });
  }
  return cachedDb;
}

/**
 * Holds a PostgreSQL session advisory lock while the callback runs. This is for
 * workflows that must serialize database decisions around external I/O, where
 * keeping a database transaction open would create rollback inconsistencies.
 */
export async function withDbAdvisoryLock<T>(
  key: string,
  callback: (db: Database) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  let locked = false;
  let destroyClient = false;
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [key]);
    locked = true;
    return await callback(drizzle(client, { schema }));
  } finally {
    if (locked) {
      try {
        await client.query("select pg_advisory_unlock(hashtext($1))", [key]);
      } catch {
        // Destroying the connection also releases every session lock it held.
        destroyClient = true;
      }
    }
    client.release(destroyClient);
  }
}

/** Test helper: release the pool so test runners can exit cleanly. */
export async function closeDb(): Promise<void> {
  await globalForDb.agentplanPool?.end();
  globalForDb.agentplanPool = undefined;
  cachedDb = undefined;
}
