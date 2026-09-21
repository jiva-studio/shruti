import { ONLY_OBJECT_TAGS, describeConsoleArgs } from "./describeConsoleArgs.js"

// Email is the only real PII the app handles; opaque ids and sandbox paths are
// deliberately left intact because they are useful for grouping.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

export const redactEmail = (s: string): string => s.replace(EMAIL_RE, "[email]")

interface ScrubbableEvent {
  message?: string
  extra?: { [key: string]: unknown }
  exception?: { values?: { value?: string }[] }
}

// captureConsole titles `console.error(<non-Error object>)` as "[object Object]"
// but keeps the original values in extra.arguments.
function recoverConsoleTitle(event: ScrubbableEvent): void {
  if (!event.message || !ONLY_OBJECT_TAGS.test(event.message)) return
  const recovered = describeConsoleArgs(event.extra?.["arguments"])
  if (recovered) event.message = recovered
}

export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  recoverConsoleTitle(event)
  if (event.message) event.message = redactEmail(event.message)
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redactEmail(ex.value)
  }
  return event
}
