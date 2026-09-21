// captureConsole stringifies a logged non-Error object to the useless title
// "[object Object]" but keeps the original values in `event.extra.arguments`.
// Rebuild a readable message from them in `beforeSend`.

export const ONLY_OBJECT_TAGS = /^(\[object \w+\]\s*)+$/

// Error-like shapes (plugin rejections, API envelopes): prefer the message.
function describeErrorLike(obj: Record<string, unknown>): string | null {
  if (typeof obj["message"] !== "string") return null
  const code = obj["code"] ?? obj["status"] ?? obj["name"]
  return code != null ? `${String(code)}: ${obj["message"]}` : obj["message"]
}

function describeObject(obj: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(obj)
    // Cap the length so a huge blob doesn't blow up the issue title.
    if (json && json !== "{}") return json.length > 300 ? `${json.slice(0, 300)}…` : json
  } catch {
    // Circular / unserialisable — fall through to the key list.
  }
  const keys = Object.keys(obj)
  return keys.length ? `{ ${keys.join(", ")} }` : "[object Object]"
}

function describeValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (value === null || typeof value !== "object") return String(value)
  const obj = value as Record<string, unknown>
  return describeErrorLike(obj) ?? describeObject(obj)
}

export function describeConsoleArgs(args: unknown): string | null {
  if (!Array.isArray(args) || args.length === 0) return null
  const parts = args.map(describeValue).filter((s): s is string => s.length > 0)
  return parts.length > 0 ? parts.join(" ") : null
}
