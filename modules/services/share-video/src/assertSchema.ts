/**
 * Boot-time check that the central migrator has applied `public.tasks`.
 * Defensive — `docker compose` blocks share-video on
 * `migrator: service_completed_successfully` so the table should always
 * exist by the time we start, but a stand-alone `docker run` would skip
 * that. We'd rather crash with a clear hint than spew pg errors.
 */

import { Pool } from 'pg';
import { log } from './log';

export async function assertSchemaReady(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'tasks'
     ) AS exists`,
  );
  if (!rows[0].exists) {
    log.error(
      { missing: 'public.tasks', hint: 'run `docker compose logs migrator`' },
      'schema_not_migrated',
    );
    process.exit(1);
  }
}
