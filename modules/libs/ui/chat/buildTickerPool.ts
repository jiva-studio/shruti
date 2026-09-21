/** Minimal shape the ticker reads off a `research_source` event — just the
 *  display label. The full store type carries more (sourceKind etc.) the
 *  pure view never touches. */
export interface ResearchSourceLabel {
  readonly label: string
}

const MAX_ITEM_CHARS = 56

function shorten(value: string): string {
  const v = value.trim().replace(/\s+/g, " ")
  if (v.length <= MAX_ITEM_CHARS) return v
  return v.slice(0, MAX_ITEM_CHARS - 1).trimEnd() + "…"
}

/**
 * Items the status pill rotates through: the status label first, then the
 * research questions, then the source labels. Every item is shortened so the
 * pill width stays bounded, and blank ones are left out.
 */
export function buildTickerPool(
  statusLabel: string,
  questions?: readonly string[],
  sources?: ReadonlyMap<string, ResearchSourceLabel>
): string[] {
  const out: string[] = []
  if (statusLabel) out.push(statusLabel)
  for (const q of questions ?? []) {
    const v = shorten(q)
    if (v) out.push(v)
  }
  if (sources) {
    for (const src of sources.values()) {
      const v = shorten(src.label || "")
      if (v) out.push(v)
    }
  }
  return out
}
