/** Fixed buckets used by the duration filter chip. Bounds in ms. */
export const DURATION_FILTERS = [
  { id: "short", minMs: 0, maxMs: 30 * 60 * 1000 },
  { id: "medium", minMs: 30 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  { id: "long", minMs: 60 * 60 * 1000, maxMs: Number.MAX_SAFE_INTEGER },
] as const

export type DurationFilterId = (typeof DURATION_FILTERS)[number]["id"]

export function durationFilterBounds(id: DurationFilterId): { minMs: number; maxMs: number } {
  const f = DURATION_FILTERS.find((x) => x.id === id)
  if (!f) throw new Error(`unknown duration filter: ${id}`)
  return { minMs: f.minMs, maxMs: f.maxMs }
}
