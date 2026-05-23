/**
 * Shared `pg` Pool factory. One pool per process; reused by server.ts and
 * worker.ts (they live in the same node process).
 */

import { Pool } from 'pg';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  pool = new Pool({
    connectionString: url,
    // share-video is single-worker (concurrency=1) plus a few HTTP handlers.
    // 5 connections is roomy — server uses 1-2 at a time, worker pins 1.
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
