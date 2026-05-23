/**
 * HTTP entrypoint for share-video. Spawns the queue worker as an in-process
 * loop alongside the Express server — same node process, sharing the pg
 * pool and S3 client.
 *
 *   GET  /healthz       → liveness
 *   POST /reels         → enqueue render → 202 {video_id, ready:false}
 *   GET  /reels/:id     → poll status   → 200 {video_id, ready, url?, error?}
 *
 * JWT validation (Bearer required on /reels) lands in a follow-up commit
 * (P6.5). Until then, posts are anonymous and the body is the rate-limit
 * surface; Caddy edge (20/hour/IP on /share/video/*) caps abuse.
 */

import * as crypto from 'crypto';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { S3Client } from '@aws-sdk/client-s3';
import { getPool, closePool } from './db';
import { assertSchemaReady } from './assertSchema';
import { log, httpLogger } from './log';
import { requireAuth } from './middleware/auth';
import { incrementAndCheck } from './usage';
import { parseRenderRequest, ValidationError } from './validate';
import { startWorker } from './worker';

const PORT = parseInt(process.env.PORT || '8083', 10);
const KIND = 'share_video.render';

const app = express();
app.use(httpLogger);
app.use(express.json({ limit: '32kb' }));

// Express 4 doesn't forward rejected async handler promises to the
// error middleware automatically — they become unhandledRejection and
// kill the Node process. Wrap every async handler so any throw lands
// in app.use(err, …) below as a 500 instead of taking the server down.
function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/reels', requireAuth, wrap(async (req: Request, res: Response) => {
  let parsed;
  try {
    parsed = parseRenderRequest(req.body);
  } catch (e) {
    if (e instanceof ValidationError) {
      return res.status(400).json({ error: e.message });
    }
    throw e;
  }
  const user = req.user!; // requireAuth set this

  // Idempotency: if client supplied a video_id and that task already
  // exists for THIS user, return its current state instead of creating
  // a duplicate row. We re-check ownership in the SELECT so a guessed
  // id from another user can't be probed via the idempotency path.
  const pool = getPool();
  if (parsed.videoId) {
    const existing = await pool.query<{ id: string; status: string; result: any; error: string | null }>(
      `SELECT id, status, result, error
         FROM tasks
        WHERE id = $1 AND kind = $2 AND payload->>'user_id' = $3`,
      [parsed.videoId, KIND, user.id],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return res.status(row.status === 'done' ? 200 : 202).json({
        video_id: row.id,
        ready: row.status === 'done',
        url: row.result?.url,
        error: row.error ?? undefined,
      });
    }
  }

  // Per-user daily quota. Anonymous JWTs get a tighter cap than signed-in.
  // We increment BEFORE the INSERT so a request that hits the limit
  // doesn't leave a pending row behind to be picked up by the worker.
  const usage = await incrementAndCheck(pool, user.id, user.anonymous);
  if (!usage.allowed) {
    return res.status(429).json({
      code: 'rate_limited',
      limit: usage.limit,
      current: usage.count,
      key_type: 'user',
    });
  }

  const videoId = parsed.videoId ?? crypto.randomUUID();

  await pool.query(
    `INSERT INTO tasks (id, kind, payload, status)
     VALUES ($1, $2, $3::jsonb, 'pending')`,
    [
      videoId,
      KIND,
      JSON.stringify({
        request: { ...parsed, videoId },
        user_id: user.id,
      }),
    ],
  );

  res.status(202).json({ video_id: videoId, ready: false });
}));

app.get('/reels/:id', requireAuth, wrap(async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) && !/^[0-9a-f-]{36}$/.test(id)) {
    return res.status(400).json({ error: 'invalid video_id format' });
  }
  const user = req.user!;
  // payload.user_id filter prevents one signed-in user from polling
  // another's render. 404 (not 403) on mismatch — don't leak existence.
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; status: string; result: any; error: string | null }>(
    `SELECT id, status, result, error
       FROM tasks
      WHERE id = $1 AND kind = $2 AND payload->>'user_id' = $3`,
    [id, KIND, user.id],
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'not found' });
  }
  const row = rows[0];
  res.status(row.status === 'failed' ? 200 : row.status === 'done' ? 200 : 202).json({
    video_id: row.id,
    ready: row.status === 'done',
    url: row.result?.url,
    error: row.error ?? undefined,
  });
}));

// Last-resort express error handler. `wrap()` above forwards async-handler
// rejections here; this is also where sync throws land.
app.use((err: Error, req: Request, res: Response, _next: any) => {
  const reqLog = (req as any).log ?? log;
  reqLog.error({ err: err.message, stack: err.stack }, 'request_error');
  res.status(500).json({ error: 'internal server error' });
});

let workerHandle: ReturnType<typeof startWorker> | undefined;
let httpServer: ReturnType<typeof app.listen> | undefined;

async function boot(): Promise<void> {
  const pool = getPool();
  await assertSchemaReady(pool);
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  workerHandle = startWorker(pool, s3);
  httpServer = app.listen(PORT, () => {
    log.info({ port: PORT }, 'server_listening');
  });
}

async function shutdown(sig: string): Promise<void> {
  log.info({ signal: sig }, 'shutdown_start');
  if (httpServer) {
    await new Promise<void>((r) => httpServer!.close(() => r()));
  }
  if (workerHandle) {
    await workerHandle.stop();
  }
  await closePool();
  log.info('shutdown_done');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

boot().catch((e) => {
  log.error({ err: e?.message ?? String(e) }, 'boot_failed');
  process.exit(1);
});
