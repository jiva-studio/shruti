import type { Plugin, PluginListenerHandle } from '@capacitor/core';

/**
 * Where the downloaded file should land on disk.
 *
 * `directory` selects the platform-specific base folder:
 * - `cache` → maps to `Context.cacheDir` on Android, `NSCachesDirectory` on iOS,
 *   `caches.open(...)` on Web. Files here may be evicted by the OS under
 *   storage pressure.
 * - `data`  → maps to app-private persistent storage (Android `filesDir`,
 *   iOS `NSDocumentDirectory`). Web treats it identically to `cache`.
 *
 * The final path is `<base>/<subdir>/<filename>`. `subdir` is optional;
 * when absent the file is written directly under `<base>`.
 */
export type DownloadDestination = {
  directory: 'cache' | 'data';
  subdir?: string;
  filename: string;
};

/**
 * Options for `download()`. The `id` is app-chosen and is the addressing
 * key for `getTask` / `cancel` / events. Calling `download()` with an `id`
 * that is already in flight returns the existing task (idempotent).
 */
export interface DownloadOptions {
  id: string;
  url: string;
  /**
   * What names the FILE, independent of where it was fetched from — several
   * hosts serve the same file, and `id` deliberately differs per host so
   * candidates can race. This is what `resolveLocalUrl` / `deleteFile` are
   * addressed by, and what the platform must index its entries under.
   */
  fileKey: string;
  destination: DownloadDestination;
  /** Extra HTTP request headers (auth tokens, etc.). */
  headers?: Record<string, string>;
  /** Restrict the network type. Default `"any"`. */
  network?: 'any' | 'wifi-only';
}

export type TaskState =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DownloadTask {
  id: string;
  state: TaskState;
  /** 0..1. Undefined while contentLength is unknown (server omitted Content-Length). */
  progress?: number;
  bytesDownloaded: number;
  contentLength: number;
  /** Local URI of the finished file. Present only when `state === "completed"`. */
  localUrl?: string;
  /** Failure reason. Present only when `state === "failed"`. */
  error?: string;
}

export interface ProgressEvent {
  id: string;
  bytesDownloaded: number;
  contentLength: number;
  /** 0..1. Undefined when contentLength is 0/unknown. */
  progress?: number;
}

export interface StateChangedEvent {
  task: DownloadTask;
}

export interface CompletedEvent {
  id: string;
  localUrl: string;
  bytesDownloaded: number;
}

export interface FailedEvent {
  id: string;
  error: string;
  /**
   * Set when the transfer ended for a local reason rather than failing on
   * its own — `"cancelled"` for `cancel()` (or the platform aborting the
   * task), `"removed"` when it finished after `deleteFile()` had already
   * dropped its bookkeeping, leaving no file to hand back.
   *
   * Every platform emits `failed` in these cases so a caller awaiting the
   * transfer always settles. The code lets that caller tell a deliberate
   * local abort from a genuine error: neither is worth a retry affordance,
   * and neither should be retried against another server.
   */
  code?: 'cancelled' | 'removed';
}

/**
 * Background-capable media downloader.
 *
 * Native implementations:
 * - Android: WorkManager + OkHttp. Survives app suspension within WorkManager's regular (non-foreground) execution window (~10 min per attempt).
 * - iOS:     URLSession with `.background` configuration. Survives app suspension; the OS may relaunch the app to deliver completion events.
 * - Web:     fetch streaming + Cache API. Background lifecycle is bound to the tab; this implementation is for parity / local development.
 */
export interface MediaDownloaderPlugin extends Plugin {
  /**
   * Start a download (or attach to an in-flight one with the same `id`).
   * Returns the initial `DownloadTask` snapshot. Progress is delivered via
   * the `progress` event; final completion via `completed` (or `failed`).
   */
  download(options: DownloadOptions): Promise<DownloadTask>;

  /** iOS only. Android rejects with "not supported". */
  pause(options: { id: string }): Promise<void>;
  resume(options: { id: string }): Promise<void>;

  /** Cancel and remove the task. Optionally delete the partial file on disk. */
  cancel(options: { id: string; deletePartial?: boolean }): Promise<void>;

  /** Snapshot of one task by id. Returns `{ task: null }` if the platform doesn't know it.
   *  The wrapping object is required because Capacitor cannot resolve a bare `null`. */
  getTask(options: { id: string }): Promise<{ task: DownloadTask | null }>;

  /** Snapshot of every task the platform currently tracks (running + recently completed).
   *  Used at app start to rebuild UI state after a kill/relaunch. */
  listTasks(): Promise<{ tasks: DownloadTask[] }>;

  /**
   * Resolve a previously-downloaded file to a local URI, or `null` if it is
   * not cached.
   *
   * Addressed by {@link DownloadOptions.fileKey}, never by the URL it came
   * from: the same file is reachable at several hosts, and which one is
   * active changes under the app — a CDN promotion, a probe, a hedged
   * download that a different region won. Looking it up by address made a
   * saved lecture invisible the moment the host changed, and the caller then
   * treated the miss as a lost download.
   */
  resolveLocalUrl(options: { fileKey: string }): Promise<{ localUrl: string | null }>;

  /** Delete a cached file by its {@link DownloadOptions.fileKey}. No-op if it
   *  doesn't exist. */
  deleteFile(options: { fileKey: string }): Promise<void>;

  addListener(
    event: 'progress',
    listenerFunc: (event: ProgressEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'stateChanged',
    listenerFunc: (event: StateChangedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'completed',
    listenerFunc: (event: CompletedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'failed',
    listenerFunc: (event: FailedEvent) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}
