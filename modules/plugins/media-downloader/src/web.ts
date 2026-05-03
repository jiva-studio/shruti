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

/**
 * Web implementation. fetch() with streaming body to report progress, and
 * Cache API to persist files across reloads.
 *
 * Cache name: the `subdir` of the destination, defaulting to "shruti".
 * That keeps the file readable by `useWebRemoteFilesStorage` which reads
 * the same cache by `URL.pathname`.
 *
 * No real background: closing the tab cancels the in-flight download.
 * Already-cached files survive reloads. This is fine for parity / local
 * development; mobile gets actual background via the native modules.
 */
export class MediaDownloaderWeb extends WebPlugin implements MediaDownloaderPlugin {
  private tasks = new Map<string, DownloadTask>();
  private aborts = new Map<string, AbortController>();

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async download(options: DownloadOptions): Promise<DownloadTask> {
    const existing = this.tasks.get(options.id);
    if (existing && existing.state === 'running') return existing;

    const cacheName = options.destination.subdir ?? 'shruti';
    const cacheKey = this.cacheKey(options.url);

    const initial: DownloadTask = {
      id: options.id,
      state: 'running',
      bytesDownloaded: 0,
      contentLength: 0,
    };
    this.setTask(initial);

    const abort = new AbortController();
    this.aborts.set(options.id, abort);

    void this.runDownload(options, cacheName, cacheKey, abort.signal);
    return initial;
  }

  private async runDownload(
    options: DownloadOptions,
    cacheName: string,
    cacheKey: string,
    signal: AbortSignal,
  ): Promise<void> {
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

      const blob = new Blob(chunks as BlobPart[]);
      const cache = await caches.open(cacheName);
      await cache.put(cacheKey, new Response(blob));

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
      if (state === 'failed') {
        this.emit<FailedEvent>('failed', {
          id: options.id,
          error: message,
          retryable: true,
        });
      }
    } finally {
      this.aborts.delete(options.id);
    }
  }

  async pause(_options: { id: string }): Promise<void> {
    throw this.unimplemented('pause is not supported on Web');
  }

  async resume(_options: { id: string }): Promise<void> {
    throw this.unimplemented('resume is not supported on Web');
  }

  async cancel(options: { id: string; deletePartial?: boolean }): Promise<void> {
    const abort = this.aborts.get(options.id);
    abort?.abort();
    this.aborts.delete(options.id);
    if (options.deletePartial) {
      const task = this.tasks.get(options.id);
      if (task?.localUrl) URL.revokeObjectURL(task.localUrl);
    }
  }

  // ── Snapshot ──────────────────────────────────────────────────────────

  async getTask(options: { id: string }): Promise<{ task: DownloadTask | null }> {
    return { task: this.tasks.get(options.id) ?? null };
  }

  async listTasks(): Promise<{ tasks: DownloadTask[] }> {
    return { tasks: Array.from(this.tasks.values()) };
  }

  // ── Cache management (per-file) ───────────────────────────────────────

  async resolveLocalUrl(options: { url: string }): Promise<{ localUrl: string | null }> {
    const cacheName = this.cacheNameFor(options.url);
    const cache = await caches.open(cacheName);
    const cached = await cache.match(this.cacheKey(options.url));
    if (!cached) return { localUrl: null };
    const blob = await cached.blob();
    return { localUrl: URL.createObjectURL(blob) };
  }

  async deleteFile(options: { url: string }): Promise<void> {
    const cacheName = this.cacheNameFor(options.url);
    const cache = await caches.open(cacheName);
    await cache.delete(this.cacheKey(options.url));
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** Cache key matches `useWebRemoteFilesStorage` — pure URL pathname. */
  private cacheKey(url: string): string {
    return new URL(url).pathname;
  }

  /** Default cache name. The plugin currently uses one cache; if a future
   *  caller passes a different subdir, callers must keep it consistent. */
  private cacheNameFor(_url: string): string {
    return 'shruti';
  }

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
