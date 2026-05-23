/**
 * Daily per-user usage counter. Backed by the same `public.usage` table
 * that chat uses (see infra/db/migrations/0013_chat_usage.up.sql). The
 * table is generic by design — chat keys rows with `<scope>:user:<sub>`
 * + day; share-video keys with `share_video:user:<sub>` + day.
 *
 * One INSERT … ON CONFLICT … DO UPDATE per call atomically increments
 * the daily count and returns the new value. Caller decides whether to
 * reject based on the configured per-anonymous / per-signed-in limit.
 */

import { Pool } from 'pg';

export interface UsageResult {
  count: number;
  limit: number;
  allowed: boolean;
}

const KIND = 'share_video';

export async function incrementAndCheck(
  pool: Pool,
  userId: string,
  anonymous: boolean,
): Promise<UsageResult> {
  const anonLimit = parseInt(process.env.SHARE_VIDEO_ANON_PER_DAY || '3', 10);
  const signedLimit = parseInt(process.env.SHARE_VIDEO_SIGNED_IN_PER_DAY || '20', 10);
  const limit = anonymous ? anonLimit : signedLimit;

  const key = `${KIND}:user:${userId}`;
  // Use postgres' CURRENT_DATE under UTC — matches chat's bucket boundary.
  const { rows } = await pool.query<{ count: number }>(
    `
    INSERT INTO usage (key, day, count) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (key, day) DO UPDATE
       SET count = usage.count + 1
    RETURNING count
    `,
    [key],
  );
  const count = rows[0].count;
  return { count, limit, allowed: count <= limit };
}
