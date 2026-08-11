import { WebPlugin } from '@capacitor/core';

import type {
  CompletedEvent,
  DownloadOptions,
  DownloadTask,
  FailedEvent,
  MediaDownloaderPlugin,
  ProgressEvent,
  StateChangedEvent,
  TaskState,
} from './definitions';

/** Matches `useWebRemoteFilesStorage`, which reads the same cache. */
const CACHE_NAME = 'shruti';

/**
 * Web implementation. fetch() with streaming body to report progress, and
 * Cache API to persist files across reloads.
 *
 * Entries are stored under `options.fileKey` — the caller's name for the
 * file, not the address it was fetched from. `destination.subdir` is ignored
 * on web: it's a native-only filesystem layout hint.
 *
 * No real background: closing the tab cancels the in-flight download.
 */
export class MediaDownloaderWeb extends WebPlugin implements MediaDownloaderPlugin {
  private tasks = new Map<string, DownloadTask>();
  /**
   * The transfer currently speaking for a task id: its abort handle and the
   * token that identifies it. An id with no entry here has no live transfer,
   * whatever `tasks` still says — that is the difference `download()` and
   * `runDownload()` are decided on.
   */
  private runs = new Map<string, { seq: number; abort: AbortController }>();
  private seq = 0;

  /** Is `seq` still the run that owns `id`, or has it been cancelled/replaced? */
  private isCurrent(id: string, seq: number): boolean {
    return this.runs.get(id)?.seq === seq;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async download(options: DownloadOptions): Promise<DownloadTask> {
    const existing = this.tasks.get(options.id);
    // Idempotent only while a transfer is actually live. A `running` entry
    // whose run is gone is a corpse — the fetch was cancelled, or it never
    // answered the abort — and handing it back would answer with a task that
    // can no longer emit anything, leaving the caller pending forever. That is
    // what stranded a re-added lecture after a cancel (#1680): the second
    // download joined the dead one instead of opening its own request.
    if (existing && existing.state === 'running' && this.runs.has(options.id)) return existing;

    const cacheKey = options.fileKey;

    const initial: DownloadTask = {
      id: options.id,
      state: 'running',
      bytesDownloaded: 0,
      contentLength: 0,
    };
    this.setTask(initial);

    const seq = ++this.seq;
    const abort = new AbortController();
    this.runs.set(options.id, { seq, abort });

    void this.runDownload(options, cacheKey, abort.signal, seq);
    return initial;
  }

  /**
   * `seq` is this transfer's claim on `options.id`. A fetch cannot be forced
   * to settle — an aborted request may answer late, or never — so every write
   * and every event is gated on the claim still being current. A run that lost
   * it says nothing at all: it must not report progress, overwrite the cache
   * entry a successor is writing, or settle a caller that is waiting on
   * someone else.
   */
  private async runDownload(
    options: DownloadOptions,
    cacheKey: string,
    signal: AbortSignal,
    seq: number,
  ): Promise<void> {
    const current = (): boolean => this.isCurrent(options.id, seq);
    try {
      const response = await fetch(options.url, {
        signal,
        headers: options.headers,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const total = Number(response.headers.get('Content-Length') ?? 0);

      let received = 0;
      const chunks: Uint8Array[] = [];
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!current()) return;
          chunks.push(value);
          received += value.length;
          this.emitProgress(options.id, received, total);
        }
      } else {
        const blob = await response.blob();
        received = blob.size;
        chunks.push(new Uint8Array(await blob.arrayBuffer()));
        this.emitProgress(options.id, received, received);
      }

      if (!current()) return;
      const blob = new Blob(chunks as BlobPart[]);
      const cache = await caches.open(CACHE_NAME);
      if (!current()) return;
      await cache.put(cacheKey, new Response(blob));
      if (!current()) return;

      const localUrl = URL.createObjectURL(blob);
      const completedTask: DownloadTask = {
        id: options.id,
        state: 'completed',
        bytesDownloaded: received,
        contentLength: total || received,
        progress: 1,
        localUrl,
      };
      this.setTask(completedTask);
      this.emit<CompletedEvent>('completed', {
        id: options.id,
        localUrl,
        bytesDownloaded: received,
      });
    } catch (err) {
      if (!current()) return;
      const isAbort = (err as { name?: string })?.name === 'AbortError';
      const state: TaskState = isAbort ? 'cancelled' : 'failed';
      const message = err instanceof Error ? err.message : String(err);
      const failedTask: DownloadTask = {
        ...(this.tasks.get(options.id) ?? {
          id: options.id,
          bytesDownloaded: 0,
          contentLength: 0,
        }),
        state,
        error: state === 'failed' ? message : undefined,
      };
      this.setTask(failedTask);
      // An abort is terminal for the caller too — it awaits `completed` /
      // `failed`, so staying silent leaves it pending forever. Report it as
      // a failure carrying the `cancelled` code, which the caller uses to
      // tell a deliberate abort from a genuine error. `cancel()` has already
      // settled its own; what lands here is an abort from outside (the page
      // tearing the request down), which is terminal all the same.
      this.emit<FailedEvent>('failed', {
        id: options.id,
        error: isAbort ? 'cancelled' : message,
        ...(isAbort ? { code: 'cancelled' as const } : {}),
      });
    } finally {
      if (current()) this.runs.delete(options.id);
    }
  }

  async pause(_options: { id: string }): Promise<void> {
    throw this.unimplemented('pause is not supported on Web');
  }

  async resume(_options: { id: string }): Promise<void> {
    throw this.unimplemented('resume is not supported on Web');
  }

  /**
   * Stop a transfer, and be terminal about it.
   *
   * Aborting the controller is a request, not an outcome: a request stalled on
   * a server that accepted the connection and went quiet can answer the abort
   * late, or not at all, and until it does the task would sit `running` with
   * nobody transferring — a state no later call could get out of. So the task
   * is settled here rather than in whatever the fetch eventually decides to
   * do, and dropping the run makes that decision moot (see `runDownload`).
   */
  async cancel(options: { id: string; deletePartial?: boolean }): Promise<void> {
    const run = this.runs.get(options.id);
    run?.abort.abort();
    this.runs.delete(options.id);

    const task = this.tasks.get(options.id);
    if (options.deletePartial && task?.localUrl) URL.revokeObjectURL(task.localUrl);
    if (!task || task.state !== 'running') return;

    this.setTask({ ...task, state: 'cancelled', error: undefined });
    // The caller awaits `completed` / `failed`; staying silent leaves it
    // pending forever. `code` is what tells a deliberate abort from a fault.
    this.emit<FailedEvent>('failed', {
      id: options.id,
      error: 'cancelled',
      code: 'cancelled',
    });
  }

  // ── Snapshot ──────────────────────────────────────────────────────────

  async getTask(options: { id: string }): Promise<{ task: DownloadTask | null }> {
    return { task: this.tasks.get(options.id) ?? null };
  }

  async listTasks(): Promise<{ tasks: DownloadTask[] }> {
    return { tasks: Array.from(this.tasks.values()) };
  }

  // ── Cache management (per-file) ───────────────────────────────────────

  async resolveLocalUrl(options: { fileKey: string }): Promise<{ localUrl: string | null }> {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(options.fileKey);
    if (!cached) return { localUrl: null };
    const blob = await cached.blob();
    return { localUrl: URL.createObjectURL(blob) };
  }

  async deleteFile(options: { fileKey: string }): Promise<void> {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(options.fileKey);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private setTask(task: DownloadTask): void {
    this.tasks.set(task.id, task);
    this.emit<StateChangedEvent>('stateChanged', { task });
  }

  private emitProgress(id: string, bytes: number, total: number): void {
    const progress = total > 0 ? Math.min(1, bytes / total) : undefined;
    const existing = this.tasks.get(id);
    if (existing) {
      this.tasks.set(id, {
        ...existing,
        bytesDownloaded: bytes,
        contentLength: total,
        progress,
      });
    }
    this.emit<ProgressEvent>('progress', {
      id,
      bytesDownloaded: bytes,
      contentLength: total,
      progress,
    });
  }

  private emit<T>(event: string, data: T): void {
    this.notifyListeners(event, data as unknown as Record<string, unknown>);
  }
}
