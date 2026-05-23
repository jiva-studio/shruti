/**
 * Async-loop worker. Pulls one render job at a time from public.tasks
 * (kind='share_video.render') using SELECT FOR UPDATE SKIP LOCKED so
 * multiple worker instances would never grab the same row.
 *
 * Concurrency is intentionally 1 per process: ffmpeg `-preset fast` at
 * 720p already pulls ~1.75 vCPU on a Cloud Provider 4-vCPU box. Two parallel
 * renders would starve chat and share-audio. The queue absorbs spikes.
 *
 * Lease: each job gets `lease_expires_at = now() + 10 min`. On worker
 * boot we revive any rows still flagged `running` past their lease —
 * that covers crash-mid-render and SIGKILL-during-render.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { renderReel } from '../pipeline';
import { log as rootLog } from './log';
import { RenderRequest as PipelineReq } from './validate';

const POLL_INTERVAL_MS = 2_500;       // back-off between empty polls
const LEASE_MS = 10 * 60 * 1000;       // generous; ffmpeg-pass takes <2 min in practice
const KIND = 'share_video.render';
const WORKER_ID = `${os.hostname()}:${process.pid}`;

// Child logger so every line emitted from the worker carries
// component=worker for easy Datadog filtering.
const log = rootLog.child({ component: 'worker', worker_id: WORKER_ID });

const BUCKET = process.env.SHRUTI_S3_BUCKET || process.env.BUCKET || '';
const BACKGROUNDS_PREFIX = process.env.SHRUTI_S3_BACKGROUNDS_PREFIX || 'private/share/video/backgrounds';
const OUTPUT_PREFIX = process.env.SHRUTI_S3_VIDEO_PREFIX || 'public/share/video';
const TEMP_ROOT = process.env.TEMP_ROOT || '/tmp/render';

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const LOGO_PATH = path.join(PACKAGE_ROOT, 'assets', 'logo.mp4');
const TITLE_ICON_PATH = path.join(PACKAGE_ROOT, 'assets', 'icon.png');

interface TaskRow {
  id: string;
  payload: {
    request: PipelineReq;
    user_id: string;
  };
  attempts: number;
  max_attempts: number;
}

export function startWorker(pool: Pool, s3: S3Client): { stop: () => Promise<void> } {
  let running = true;
  let currentLoop: Promise<void>;

  async function reviveExpiredLeases(): Promise<void> {
    // kind-agnostic on purpose — covers anything that survived a crash.
    const res = await pool.query(
      `UPDATE tasks
          SET status='pending', worker_id=NULL, lease_expires_at=NULL
        WHERE status='running' AND lease_expires_at < now()
        RETURNING id`,
    );
    if (res.rowCount && res.rowCount > 0) {
      log.info({ count: res.rowCount }, 'lease_revival');
    }
  }

  async function leaseOne(): Promise<TaskRow | null> {
    // Pick the oldest pending of our kind, lock it, transition to running.
    // Single UPDATE … FROM … RETURNING avoids the explicit transaction we'd
    // otherwise need for SELECT FOR UPDATE + UPDATE.
    const sql = `
      WITH picked AS (
        SELECT id FROM tasks
         WHERE kind = $1 AND status = 'pending'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE tasks t SET
        status            = 'running',
        attempts          = attempts + 1,
        started_at        = now(),
        lease_expires_at  = now() + ($2 || ' milliseconds')::interval,
        worker_id         = $3
      FROM picked
      WHERE t.id = picked.id
      RETURNING t.id, t.payload, t.attempts, t.max_attempts
    `;
    const { rows } = await pool.query<TaskRow>(sql, [KIND, String(LEASE_MS), WORKER_ID]);
    return rows[0] ?? null;
  }

  async function finish(id: string, url: string, outputKey: string): Promise<void> {
    await pool.query(
      `UPDATE tasks
          SET status='done',
              result=jsonb_build_object('url', $2::text, 'output_key', $3::text),
              finished_at=now(),
              lease_expires_at=NULL
        WHERE id=$1`,
      [id, url, outputKey],
    );
  }

  async function fail(id: string, attempts: number, maxAttempts: number, error: string): Promise<void> {
    // If we still have attempts left, push it back to pending for retry.
    // Otherwise mark failed terminally.
    const willRetry = attempts < maxAttempts;
    await pool.query(
      `UPDATE tasks
          SET status            = $2,
              error             = $3,
              finished_at       = CASE WHEN $2='failed' THEN now() ELSE finished_at END,
              lease_expires_at  = NULL
        WHERE id=$1`,
      [id, willRetry ? 'pending' : 'failed', error],
    );
    log.error({ task_id: id, attempts, willRetry, err: error }, 'task_fail');
  }

  async function processOne(task: TaskRow): Promise<void> {
    const t0 = Date.now();
    const tempDir = path.join(TEMP_ROOT, `share-video-${task.id}`);
    try {
      const req = task.payload.request;
      fs.mkdirSync(tempDir, { recursive: true });
      const result = await renderReel({
        req,
        videoId: task.id,
        bucket: BUCKET,
        backgroundsPrefix: BACKGROUNDS_PREFIX,
        outputPrefix: OUTPUT_PREFIX,
        logoPath: LOGO_PATH,
        titleIconPath: TITLE_ICON_PATH,
        s3,
        tempDir,
      });
      await finish(task.id, result.url, result.outputKey);
      log.info({ task_id: task.id, dur_ms: Date.now() - t0, url: result.url }, 'task_done');
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      await fail(task.id, task.attempts, task.max_attempts, msg);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupErr: any) {
        log.warn(
          { task_id: task.id, err: String(cleanupErr?.message ?? cleanupErr) },
          'tempdir_cleanup_failed',
        );
      }
    }
  }

  async function loop(): Promise<void> {
    await reviveExpiredLeases().catch((e) =>
      log.error({ err: String(e?.message ?? e) }, 'revive_failed'),
    );
    while (running) {
      try {
        const t = await leaseOne();
        if (!t) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        await processOne(t);
      } catch (e: any) {
        log.error({ err: String(e?.message ?? e) }, 'loop_error');
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  currentLoop = loop();
  log.info({ kind: KIND }, 'worker_started');

  return {
    async stop() {
      running = false;
      await currentLoop;
      log.info('worker_stopped');
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
