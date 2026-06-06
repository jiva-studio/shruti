import { computed, type ComputedRef, type WritableComputedRef } from "vue"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import { useConfig } from "./useConfig.js"
import {
  DEFAULT_TRACK_META_CONFIG,
  defaultMetaConfig,
  normalizeMetaConfig,
  type TrackMetaConfig,
} from "@ui/components/tracks/list/index.js"

export const TRACK_META_CONFIG_CONFIG_KEY = "settings.trackMetaConfig"

export interface TrackMetadataFieldsReturn {
  /** Editor binding: always a fully-normalized config so fields added in
   *  a newer version surface even on a layout saved before they existed.
   *  Writes go straight back to the stored preference. */
  raw: WritableComputedRef<TrackMetaConfig>
  /** Effective config the lists render: the saved layout for Pro users,
   *  the default for everyone else (mirrors how auto-scroll forces OFF
   *  for non-subscribers without discarding their stored choice). */
  config: ComputedRef<TrackMetaConfig>
}

export function useTrackMetadataFields(): TrackMetadataFieldsReturn {
  const stored = useConfig<TrackMetaConfig>(TRACK_META_CONFIG_CONFIG_KEY, defaultMetaConfig())
  const purchases = usePurchasesStore()

  const raw = computed<TrackMetaConfig>({
    get: () => normalizeMetaConfig(stored.value),
    set: (value) => {
      stored.value = value
    },
  })

  const config = computed<TrackMetaConfig>(() =>
    purchases.isSubscribed ? normalizeMetaConfig(stored.value) : DEFAULT_TRACK_META_CONFIG
  )

  return { raw, config }
}
