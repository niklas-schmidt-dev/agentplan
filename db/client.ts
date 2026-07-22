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

// Lazy so that importing this module (e.g. during `next build`) needs no secrets;
// the pool is only created on first query. Cached on globalThis across dev reloads.
let cachedDb: Database | undefined;

export function getDb(): Database {
  if (!cachedDb) {
    const pool = globalForDb.agentplanPool ?? createPool();
    globalForDb.agentplanPool = pool;
    cachedDb = drizzle(pool, { schema });
  }
  return cachedDb;
}
