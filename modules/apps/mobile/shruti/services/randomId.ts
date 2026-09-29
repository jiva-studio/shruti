/** A fresh unique id: a UUID where the runtime has one, a time-and-random string otherwise. */
export function randomId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}
