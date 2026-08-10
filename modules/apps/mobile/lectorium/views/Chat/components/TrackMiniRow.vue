<template>
  <button
    type="button"
    class="mini-row"
    :class="{ skeleton: loading, missing: error }"
    :disabled="loading || error"
    @click="onOpen"
  >
    <span v-if="loading" class="placeholder">&nbsp;</span>
    <span v-else-if="error" class="placeholder">
      {{ $t("chat.lectureCardMissing") }}
    </span>
    <template v-else>
      <span class="title">{{ title }}</span>
      <span class="details-line">
        <span v-if="primaryRef" class="ref">{{ primaryRef }}</span>
        <span v-if="extraRefCount > 0" class="ref extra">+{{ extraRefCount }}</span>
        <span v-if="detailsLine" class="details">{{ detailsLine }}</span>
      </span>
    </template>
    <IonActionSheet
      :is-open="actionSheetOpen"
      :buttons="actionSheetButtons"
      @did-dismiss="actionSheetOpen = false"
    />
  </button>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonActionSheet } from "@ionic/vue"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { groupReferences } from "@lib/domain/services/references.js"
import {
  preferredContentLanguage,
  resolveLocalizedNameOrEmpty,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"
import { useAddToPlaylist } from "@lectorium/composables/useAddToPlaylist.js"
import { useTrackRowAsync } from "@lectorium/composables/useTrackRowAsync.js"
import { formatTrackDate } from "@lectorium/composables/formatTrackDate.js"
import { useToast } from "@kit/composables"

const props = defineProps<{ trackId: string }>()

const { t } = useI18n()
const appLanguage = useAppLanguage()
const libraryLanguages = useLibraryLanguages()
const { addToPlaylist } = useAddToPlaylist()
const toast = useToast()

const { track, author, location, sourcesById, loading, error } = useTrackRowAsync(
  () => props.trackId
)
const actionSheetOpen = ref(false)

interface SheetButton {
  readonly text: string
  readonly role?: "cancel" | "destructive"
  readonly handler: () => void
}

const actionSheetButtons = computed<readonly SheetButton[]>(() => [
  {
    text: t("search.actions.addToPlaylist"),
    handler: () => {
      void onAddOne()
    },
  },
  {
    text: t("app.cancel"),
    role: "cancel",
    handler: () => undefined,
  },
])

const title = computed(() => {
  if (!track.value) return ""
  // Title follows the content language (a library language the track has),
  // not the UI language — which still drives author / location / date labels.
  const cl =
    preferredContentLanguage(track.value, libraryLanguages.value, appLanguage.value) ??
    appLanguage.value
  return resolveTrackTitle(track.value, cl) ?? track.value.id
})

const references = computed<string[]>(() => {
  if (!track.value) return []
  return groupReferences(track.value.references, sourcesById.value, appLanguage.value)
})

const primaryRef = computed(() => references.value[0] ?? "")
const extraRefCount = computed(() => Math.max(0, references.value.length - 1))

/** Sequence on the second line: author · location · date — references
 *  go BEFORE this string as separate chip elements. */
const detailsLine = computed(() => {
  if (!track.value) return ""
  const parts: string[] = []
  const au = resolveLocalizedNameOrEmpty(author.value, appLanguage.value)
  if (au) parts.push(au)
  const loc = resolveLocalizedNameOrEmpty(location.value, appLanguage.value)
  if (loc) parts.push(loc)
  if (track.value.date) parts.push(formatTrackDate(track.value.date, appLanguage.value))
  return parts.join(" · ")
})

function onOpen(): void {
  if (!track.value) return
  actionSheetOpen.value = true
}

async function onAddOne(): Promise<void> {
  try {
    await addToPlaylist(props.trackId)
    await toast.info(t("chat.citationAddedToPlaylist"))
  } catch (err) {
    console.warn("[mini-row] add to playlist failed", err)
    await toast.error(t("chat.citationAddFailed"))
  }
}
</script>

<style scoped>
/* Full reset of the native <button> so it lays out like a plain block —
 * inner typography (13px title, 12px details) relies on font: inherit. */
.mini-row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: 0;
  border-radius: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.mini-row + .mini-row {
  border-top: 1px solid rgba(var(--ion-color-step-200-rgb, 200, 200, 200), 0.14);
}

.mini-row[disabled] {
  cursor: default;
}

.title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* One physical line: chip first, then `author · location · date`.
 * Chip never shrinks; the details string takes the remaining width and
 * truncates with ellipsis if too long. */
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
  /* flex 1 + min-width:0 are required so the long author/location/date
   * string can shrink and ellipsis instead of wrapping onto its own line. */
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
  font-size: 13px;
  opacity: 0.55;
}

.mini-row.skeleton .placeholder {
  background: linear-gradient(
    90deg,
    rgba(120, 120, 120, 0.12),
    rgba(120, 120, 120, 0.06),
    rgba(120, 120, 120, 0.12)
  );
  border-radius: 6px;
  min-height: 12px;
  width: 60%;
  display: inline-block;
}

.mini-row.missing {
  opacity: 0.55;
  pointer-events: none;
}
</style>
