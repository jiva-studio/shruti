/** A field of the wrong type must not throw halfway through a stream, so
 *  every reader answers with something the caller can carry on with. */

type Wire = Record<string, unknown>

/** The string at `key`, or `fallback` when it is absent or not a string. */
export function str(p: Wire, key: string, fallback = ""): string {
  return typeof p[key] === "string" ? (p[key] as string) : fallback
}

/** The trimmed string at `key`, empty when absent, not a string, or blank. */
export function trimmed(p: Wire, key: string): string {
  return typeof p[key] === "string" ? (p[key] as string).trim() : ""
}

/** The string at `key`, or `undefined` when absent or blank — for a field the
 *  caller spreads in only when the server actually sent it. */
export function optStr(p: Wire, key: string): string | undefined {
  const v = trimmed(p, key)
  return v || undefined
}

/** The number at `key`, or `null` when absent or not a number. */
export function num(p: Wire, key: string): number | null {
  return typeof p[key] === "number" ? (p[key] as number) : null
}

/** A boolean field, true only on an explicit `true`. */
export function flag(p: Wire, key: string): boolean {
  return p[key] === true
}

/** The object at `key` as a plain record, or `null` — an array is not one. */
export function record(p: Wire, key: string): Wire | null {
  const v = p[key]
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  return v as Wire
}

/** The array at `key`, or an empty one. */
export function list(p: Wire, key: string): readonly unknown[] {
  return Array.isArray(p[key]) ? (p[key] as unknown[]) : []
}

/** Every entry of the record at `key` whose value is a non-empty string. */
export function stringMap(p: Wire, key: string): Record<string, string> {
  const out: Record<string, string> = {}
  const src = record(p, key)
  if (!src) return out
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "string" && v) out[k] = v
  }
  return out
}

/** A field the server sends in snake_case and older frames in camelCase. */
export function eitherNum(p: Wire, snake: string, camel: string): number | undefined {
  return num(p, snake) ?? num(p, camel) ?? undefined
}

/** As {@link eitherNum}, for a string field. */
export function eitherStr(p: Wire, snake: string, camel: string): string {
  return str(p, snake) || str(p, camel)
}
