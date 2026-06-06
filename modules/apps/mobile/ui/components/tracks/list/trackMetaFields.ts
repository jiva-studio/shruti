import type { ComputedRef, InjectionKey, Ref } from "vue"

/**
 * The metadata pieces a track row can show under its title. The user
 * (Pro) lays them out across two slots — a prominent inline widget on
 * the title row and the reorderable line below it; everyone else gets
 * {@link DEFAULT_TRACK_META_CONFIG}.
 */
export type TrackMetaFieldKey = "reference" | "author" | "location" | "date" | "duration"

export const TRACK_META_FIELD_KEYS = [
  "reference",
  "author",
  "location",
  "date",
  "duration",
] as const

/**
 * Fields eligible for the prominent top widget. Only the two short,
 * identifier-like fields make sense as the inline chip next to the
 * title — author / location would be too long there and belong in the
 * line below.
 */
export type TrackMetaTopKey = "reference" | "date"
export const TOP_FIELD_KEYS = ["reference", "date"] as const

export interface TrackMetaField {
  readonly field: TrackMetaFieldKey
  readonly enabled: boolean
}

/**
 * Two-slot layout. `top` is the single field promoted to the inline
 * widget on the title row (or `null` for nothing); `bottom` is the
 * ordered, individually-togglable line below it. The field chosen for
 * `top` is always skipped in the line even if its `bottom` flag is on,
 * so the same piece of info never appears twice.
 */
export interface TrackMetaConfig {
  readonly top: TrackMetaTopKey | null
  readonly bottom: readonly TrackMetaField[]
}

/**
 * Default layout = the legacy information: the scripture reference as
 * the inline title chip (where it always sat), everything else on in
 * the line below in reading order.
 */
export const DEFAULT_TRACK_META_CONFIG: TrackMetaConfig = {
  top: "reference",
  bottom: [
    { field: "reference", enabled: true },
    { field: "author", enabled: true },
    { field: "location", enabled: true },
    { field: "date", enabled: true },
    // Off by default — opt-in so the default row keeps its legacy look.
    { field: "duration", enabled: false },
  ],
}

/** A fresh, mutable copy of the default — for the config ref's seed. */
export function defaultMetaConfig(): TrackMetaConfig {
  return {
    top: DEFAULT_TRACK_META_CONFIG.top,
    bottom: DEFAULT_TRACK_META_CONFIG.bottom.map((f) => ({ ...f })),
  }
}

/**
 * Active config provided once at the app root and injected by every
 * {@link TrackMetaLine} / TrackHeader. The settings preview overrides it
 * with a local draft via the component's `config` prop instead.
 */
export const TRACK_META_CONFIG_KEY: InjectionKey<
  Ref<TrackMetaConfig> | ComputedRef<TrackMetaConfig>
> = Symbol("trackMetaConfig")

function isKnownKey(value: unknown): value is TrackMetaFieldKey {
  return typeof value === "string" && (TRACK_META_FIELD_KEYS as readonly string[]).includes(value)
}

function isTopKey(value: unknown): value is TrackMetaTopKey {
  return typeof value === "string" && (TOP_FIELD_KEYS as readonly string[]).includes(value)
}

/**
 * Repairs a stored config: validates `top` (explicit `null` is kept; an
 * unknown/missing value falls back to the default prominent field) and
 * rebuilds `bottom` as exactly one entry per known field — dropping
 * unknown/duplicate keys, keeping the user's order, then appending any
 * field the stored value was missing (so a config saved before a new
 * field existed still surfaces it).
 */
export function normalizeMetaConfig(
  stored: Partial<TrackMetaConfig> | null | undefined
): TrackMetaConfig {
  const rawTop = stored?.top
  const top: TrackMetaTopKey | null =
    rawTop === null ? null : isTopKey(rawTop) ? rawTop : DEFAULT_TRACK_META_CONFIG.top

  const seen = new Set<TrackMetaFieldKey>()
  const bottom: TrackMetaField[] = []
  for (const item of stored?.bottom ?? []) {
    if (isKnownKey(item?.field) && !seen.has(item.field)) {
      seen.add(item.field)
      bottom.push({ field: item.field, enabled: Boolean(item.enabled) })
    }
  }
  for (const def of DEFAULT_TRACK_META_CONFIG.bottom) {
    if (!seen.has(def.field)) bottom.push({ ...def })
  }
  return { top, bottom }
}
