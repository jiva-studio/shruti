import type { TrackMetaConfig, TrackMetaFieldKey } from "./trackMetaFields.js"

/** What a row carries for each field; an absent one shows no segment. */
export interface TrackMetaValues {
  readonly references?: readonly string[]
  readonly tags?: readonly string[]
  readonly location?: string
  readonly date?: string
  readonly duration?: string
}

export interface TrackMetaSegment {
  readonly key: string
  readonly kind: "reference" | "text"
  readonly text: string
  readonly extra: number
}

function segmentFor(field: TrackMetaFieldKey, values: TrackMetaValues): TrackMetaSegment | null {
  if (field === "reference") {
    const refs = values.references ?? []
    const text = refs[0] ?? (values.tags ?? [])[0]
    if (!text) return null
    return { key: "reference", kind: "reference", text, extra: Math.max(0, refs.length - 1) }
  }
  const text = values[field]
  if (!text) return null
  return { key: field, kind: "text", text, extra: 0 }
}

/**
 * The meta line for one row: the configured `bottom` fields that resolved, in
 * the user's order, minus the one promoted to the top widget. The duration
 * stands in when nothing else resolved, so the line is never blank.
 */
export function buildMetaSegments(
  config: TrackMetaConfig,
  values: TrackMetaValues
): TrackMetaSegment[] {
  const out: TrackMetaSegment[] = []
  for (const { field, enabled } of config.bottom) {
    if (!enabled || field === config.top) continue
    const seg = segmentFor(field, values)
    if (seg) out.push(seg)
  }
  if (out.length === 0 && values.duration) {
    out.push({ key: "duration", kind: "text", text: values.duration, extra: 0 })
  }
  return out
}
