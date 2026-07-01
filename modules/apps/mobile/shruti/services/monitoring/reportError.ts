/**
 * Explicit error reporting for swallowed failures.
 *
 * The app is structurally designed to never crash: most failures are caught and
 * logged-and-continued (or silently ignored), so they never become unhandled
 * exceptions and Sentry's global handlers never see them. For the catch sites
 * that represent a REAL failure (a bug or outage, not expected control flow),
 * call `reportError` instead of a bare `console.warn`/`catch {}` so the failure
 * both stays in the in-app debug buffer AND becomes a Sentry issue.
 *
 * Benign/expected signatures (see {@link isExpectedError}) are dropped, so it's
 * safe to use even where an occasional expected error can also occur.
 *
 * `console.error` is handled separately and automatically (the captureConsole
 * integration escalates it), so existing `console.error` sites need no change —
 * use this for the SILENT / `console.warn` sites that should be visible.
 */
import * as Sentry from "@sentry/capacitor"
import { recordError } from "../logger/index.js"
import { isExpectedError } from "./isExpectedError.js"

export function reportError(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>
): void {
  // Always surface in Settings → Debug, even for expected errors (the buffer is
  // the local diagnostic). recordError pushes directly, bypassing console.error
  // so the captureConsole bridge doesn't also fire for this line.
  recordError(`[${scope}]`, error)
  if (isExpectedError(error)) return
  Sentry.captureException(error, {
    tags: { scope },
    ...(context ? { extra: context } : {}),
  })
}

/**
 * Report a KNOWN-benign-but-worth-watching condition at WARNING level.
 *
 * Unlike {@link reportError}, this is for signals that are not faults on their
 * own (so they must not page like a crash) yet whose TREND matters — e.g. an
 * empty RevenueCat offering set, which is normal for reviewers/sandbox but a
 * store-wide product outage if it spikes. Surfaces in the debug buffer and as a
 * warning-level Sentry event that trends in the dashboard without alerting.
 */
export function reportWarning(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>
): void {
  recordError(`[${scope}]`, error)
  if (isExpectedError(error)) return
  Sentry.captureException(error, {
    level: "warning",
    tags: { scope },
    ...(context ? { extra: context } : {}),
  })
}
