/**
 * In-memory debug log buffer.
 *
 * A bounded ring buffer (last {@link LOG_CAPACITY} entries) that captures
 * everything written to `console.*` so it can be inspected inside the app
 * (Settings → Debug → "View logs") without a wired-up device or remote
 * logging service. Nothing is persisted — the buffer lives only for the
 * lifetime of the running app, which is exactly what we want for debugging
 * "what just happened" (subscription wiring, scheduled notifications, …).
 *
 * Capturing `console.*` means every existing `[purchases] …` / `[proactive]
 * …` line the app already emits lands here for free — no call sites need to
 * change. New diagnostics just use `console.*` with a `[scope]` prefix.
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEntry {
  /** Monotonic id — stable list key, also encodes insertion order. */
  id: number
  /** Epoch ms when the line was recorded. */
  ts: number
  level: LogLevel
  /** Already-formatted single-line (or multi-line) text. */
  text: string
}

/** Keep at most this many lines; oldest are dropped first. */
export const LOG_CAPACITY = 5000

const buffer: LogEntry[] = []
let nextId = 1
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) {
    try {
      l()
    } catch {
      // A flaky listener must never break logging.
    }
  }
}

function push(level: LogLevel, text: string): void {
  buffer.push({ id: nextId++, ts: Date.now(), level, text })
  // Trim from the front once we exceed the cap. splice keeps a single array
  // instance so the reactive snapshot stays cheap.
  if (buffer.length > LOG_CAPACITY) buffer.splice(0, buffer.length - LOG_CAPACITY)
  notify()
}

/**
 * Record an error-level line in the debug buffer directly, WITHOUT routing
 * through `console.error`. Used by the Sentry `reportError` bridge so the entry
 * is visible in Settings → Debug without also tripping the captureConsole
 * integration (which only escalates real `console.error` calls) — i.e. one
 * Sentry issue per reported error, not two.
 */
export function recordError(...args: unknown[]): void {
  push("error", formatArgs(args))
}

/** Live view of the buffer, oldest-first. Do not mutate. */
export function logSnapshot(): readonly LogEntry[] {
  return buffer
}

export function logCount(): number {
  return buffer.length
}

export function clearLogs(): void {
  buffer.length = 0
  notify()
}

/** Subscribe to buffer changes (append / clear). Returns an unsubscribe fn. */
export function subscribeLogs(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`
  if (typeof a === "undefined") return "undefined"
  try {
    return JSON.stringify(a)
  } catch {
    // Circular / non-serialisable — fall back to the default coercion.
    return String(a)
  }
}

function formatArgs(args: unknown[]): string {
  return args.map(formatArg).join(" ")
}

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug"

const LEVEL_OF: Record<ConsoleMethod, LogLevel> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
}

let captureInstalled = false

/**
 * Patch `console.*` so every call is also recorded into the buffer, then
 * delegated to the original method (so native logcat / web devtools still
 * see it). Idempotent. Call once, as early as possible in `main.ts`.
 */
export function installConsoleCapture(): void {
  if (captureInstalled || typeof console === "undefined") return
  captureInstalled = true

  const methods: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"]
  for (const m of methods) {
    const original = console[m]?.bind(console)
    console[m] = (...args: unknown[]): void => {
      try {
        push(LEVEL_OF[m], formatArgs(args))
      } catch {
        // Recording must never throw out of a console call.
      }
      original?.(...args)
    }
  }
}
