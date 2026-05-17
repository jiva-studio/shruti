<template>
  <article
    class="lecture-card"
    role="button"
    tabindex="0"
    @click="onOpen"
    @keydown.enter.space.prevent="onOpen"
  >
    <template v-if="loading">
      <div class="placeholder">
        <IonSpinner name="dots" />
      </div>
    </template>
    <template v-else-if="error">
      <div class="placeholder error">
        {{ $t("chat.lectureCardMissing") }}
      </div>
    </template>
    <template v-else>
      <header class="title">{{ title }}</header>
      <div v-if="metaLine" class="meta-row">{{ metaLine }}</div>
      <div v-if="references.length" class="references">
        <span v-for="ref in references" :key="ref.key" class="ref">{{ ref.label }}</span>
      </div>
    </template>
    <IonActionSheet
      :is-open="actionSheetOpen"
      :buttons="actionSheetButtons"
      @did-dismiss="actionSheetOpen = false"
    />
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonActionSheet, IonSpinner } from "@ionic/vue"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { resolveLocalizedName, resolveTrackTitle } from "@shruti/composables/resolveLocalized.js"
import { useAddToPlaylist } from "@shruti/composables/useAddToPlaylist.js"
import { useTrackRowAsync } from "@shruti/composables/useTrackRowAsync.js"
import { useToast } from "@shruti/services/useToast.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"

const props = defineProps<{ trackId: string }>()
const { t } = useI18n()
const appLanguage = useAppLanguage()
const { addToPlaylist } = useAddToPlaylist()
const toast = useToast()

const actionSheetOpen = ref(false)

interface SheetButton {
  readonly text: string
  readonly role?: "cancel" | "destructive"
  readonly handler: () => void
}

const actionSheetButtons = computed<readonly SheetButton[]>(() => [
  {
    text: t("search.actions.addToPlaylist"),
    handler: (): void => {
      void onAddToPlaylist()
    },
  },
  {
    text: t("app.cancel"),
    role: "cancel",
    handler: (): void => undefined,
  },
])

async function onAddToPlaylist(): Promise<void> {
  try {
    await addToPlaylist(props.trackId)
    await toast.info(t("chat.citationAddedToPlaylist"))
  } catch (err) {
    console.warn("[lecture-card] add to playlist failed", err)
    await toast.error(t("chat.citationAddFailed"))
  }
}

const { track, location, sourcesById, loading, error } = useTrackRowAsync(
  () => props.trackId
)

const title = computed(() => {
  if (!track.value) return ""
  return resolveTrackTitle(track.value, appLanguage.value) ?? track.value.id
})

const locationName = computed(() =>
  location.value ? (resolveLocalizedName(location.value, appLanguage.value) ?? "") : ""
)

const dateLabel = computed(() => {
  if (!track.value) return ""
  return track.value.date ?? ""
})

const durationLabel = computed(() => {
  if (!track.value) return ""
  const ms = maxAudioDurationMs(track.value)
  if (ms <= 0) return ""
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
})

const metaLine = computed<string>(() => {
  const parts: string[] = []
  if (locationName.value) parts.push(locationName.value)
  if (dateLabel.value) parts.push(dateLabel.value)
  if (durationLabel.value) parts.push(durationLabel.value)
  return parts.join(" · ")
})

const references = computed<readonly { key: string; label: string }[]>(() => {
  if (!track.value) return []
  const out: { key: string; label: string }[] = []
  for (const r of track.value.references) {
    if (!r.tokens || r.tokens.length === 0) continue
    const tail = r.tokens.join(".")
    const source = r.sourceId ? sourcesById.value.get(r.sourceId) : null
    // Localised short name (e.g. "БГ", "БГ", "ШБ") with fallback through the
    // by-language map. Falls back to raw source_id stripped of "source_"
    // prefix if no dict row was loaded yet.
    let shortName: string | null = null
    if (source) {
      const preferred = source.names.get(appLanguage.value)
      const en = source.names.get("en")
      const anyName = preferred ?? en ?? source.names.values().next().value
      shortName = anyName?.shortName ?? anyName?.fullName ?? null
    }
    const label = shortName ? `${shortName} ${tail}` : tail
    out.push({ key: `${r.sourceId ?? ""}-${tail}`, label })
    if (out.length >= 4) break
  }
  return out
})

function onOpen() {
  if (!track.value) return
  actionSheetOpen.value = true
}
</script>

<style scoped>
.lecture-card {
  display: block;
  margin: 10px 0;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.28);
  background: rgba(var(--ion-color-primary-rgb), 0.08);
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    background 120ms ease,
    transform 60ms ease;
}

.lecture-card:active {
  background: rgba(var(--ion-color-primary-rgb), 0.14);
  transform: scale(0.997);
}

.title {
  font-weight: 600;
  font-size: 15px;
  line-height: 1.3;
  margin-bottom: 4px;
  color: var(--ion-text-color);
  /* No wrapping pathology — title can wrap normally but stays compact. */
}

.meta-row {
  font-size: 12px;
  line-height: 1.4;
  color: var(--ion-color-step-650, #6f6f6f);
  /* One line, ellipsis if overflows — eliminates the "orphan dot on new
   * line" issue we had with flex-wrap + ::before separators. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.references {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.ref {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px; /* full pill */
  background: rgba(var(--ion-color-primary-rgb), 0.18);
  color: var(--ion-color-primary);
  white-space: nowrap;
}

.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  color: var(--ion-color-step-500, #8a8a8a);
}

.placeholder.error {
  font-size: 13px;
}
</style>
