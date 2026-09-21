/** An i18n key with the params it takes, for the caller to translate. */
export interface Phrase {
  readonly key: string
  readonly params?: Record<string, string | number>
}

const FAILED_TEXT_KEYS: Record<string, string> = {
  rate_limited: "chat.errRate",
  max_turns_exceeded: "chat.errMaxTurns",
  chat_unavailable: "chat.errUnavailable.body",
  agent_error: "chat.errAgent",
  http_401: "chat.errAuth",
  http_403: "chat.errAuth",
  protocol_version_required: "chat.errProtocol",
  server_unreachable: "chat.errServiceNotReady",
  network: "chat.errNetwork",
  stream: "chat.errStreamDropped",
}

/** The body a failed bubble falls back to, by error code. */
export function failedTextKey(code: string): string {
  if (code.startsWith("http_5")) return "chat.errServiceNotReady"
  return FAILED_TEXT_KEYS[code] ?? "chat.errUnknown"
}

function pad(n: number): string {
  return n.toString().padStart(2, "0")
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * The "{when}" fragment of a retry deadline: seconds under a minute, minutes
 * under an hour, else a wall-clock time. Tomorrow is named, because the server
 * resets at UTC midnight and the local day may already have turned.
 */
export function retryWhenPhrase(remainingMs: number, deadlineMs: number, nowMs: number): Phrase {
  const seconds = Math.ceil(remainingMs / 1000)
  if (seconds < 60) return { key: "chat.retryInSeconds", params: { n: seconds } }
  if (seconds < 60 * 60) {
    return { key: "chat.retryInMinutes", params: { n: Math.ceil(seconds / 60) } }
  }
  const deadline = new Date(deadlineMs)
  const time = `${pad(deadline.getHours())}:${pad(deadline.getMinutes())}`
  return isSameLocalDay(deadline, new Date(nowMs))
    ? { key: "chat.retryAtTime", params: { time } }
    : { key: "chat.retryAtTimeTomorrow", params: { time } }
}

/** The reset countdown the quota bodies carry, or "now" once it has passed. */
export function resetWhenPhrase(retryAfterAt: number | undefined, nowMs: number): Phrase | null {
  if (typeof retryAfterAt !== "number") return null
  const remainingMs = retryAfterAt - nowMs
  if (remainingMs <= 0) return { key: "chat.retryNow" }
  return retryWhenPhrase(remainingMs, retryAfterAt, nowMs)
}
