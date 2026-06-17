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
      <IconHeadphones class="lecture-icon" :size="32" :stroke-width="1.6" aria-hidden="true" />
      <div class="lecture-info">
        <span class="title">{{ title }}</span>
        <div class="details-line">
          <span v-if="primaryRef" class="ref">{{ primaryRef }}</span>
          <span v-if="extraRefCount > 0" class="ref extra">+{{ extraRefCount }}</span>
          <span v-if="metaLine" class="details">{{ metaLine }}</span>
        </div>
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
import { IconHeadphones } from "@tabler/icons-vue"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { groupReferences } from "@lib/domain/services/references.js"
import {
  preferredContentLanguage,
  resolveLocalizedName,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"
import { useAddToPlaylist } from "@lectorium/composables/useAddToPlaylist.js"
import { useTrackRowAsync } from "@lectorium/composables/useTrackRowAsync.js"
import { useToast } from "@kit/composables"
import { maxAudioDurationMs } from "@lib/domain/track.js"

const props = defineProps<{ trackId: string }>()
const { t } = useI18n()
const appLanguage = useAppLanguage()
const libraryLanguages = useLibraryLanguages()
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

const { track, location, sourcesById, loading, error } = useTrackRowAsync(() => props.trackId)

const title = computed(() => {
  if (!track.value) return ""
  const contentLang = preferredContentLanguage(
    track.value,
    libraryLanguages.value,
    appLanguage.value
  )
  return resolveTrackTitle(track.value, contentLang ?? appLanguage.value) ?? track.value.id
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

const references = computed<string[]>(() => {
  if (!track.value) return []
  return groupReferences(track.value.references, sourcesById.value, appLanguage.value)
})

const primaryRef = computed(() => references.value[0] ?? "")
const extraRefCount = computed(() => Math.max(0, references.value.length - 1))

function onOpen() {
  if (!track.value) return
  actionSheetOpen.value = true
}
</script>

<style scoped>
/* Minimal row in a stacked TrackList — no card-background or border;
   the row sits in a flat list with a document icon on the left,
   title + ref+meta on the right. Mirrors the PDF list pattern. */
.lecture-card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0;
  padding: 8px 4px;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 120ms ease;
}

.lecture-card:active {
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}

.lecture-icon {
  flex: 0 0 32px;
  color: var(--ion-color-primary);
}

.lecture-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title {
  font-weight: 500;
  font-size: 15px;
  line-height: 1.3;
  color: var(--ion-text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* One physical line: ref chip first, then `location · date · duration`.
 * Same layout as TrackMiniRow inside playlist cards. */
.details-line {
  display: flex;
  align-items: baseline;
  flex-wrap: nowrap;
  gap: 6px;
  min-width: 0;
}

.ref {
  flex: 0 0 auto;
  background: var(--ion-color-light-shade);
  color: var(--ion-color-medium);
  font-size: 11px;
  font-weight: 700;
  font-stretch: condensed;
  line-height: 1.4;
  padding: 0 5px;
  border-radius: 5px;
  white-space: nowrap;
}

.ref.extra {
  opacity: 0.55;
}

.details {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.25;
  color: var(--ion-color-medium);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
