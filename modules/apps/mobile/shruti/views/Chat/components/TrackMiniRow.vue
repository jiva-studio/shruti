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
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonActionSheet } from "@ionic/vue"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { groupReferences } from "@shruti/composables/groupReferences.js"
import {
  resolveLocalizedNameOrEmpty,
  resolveTrackTitle,
} from "@shruti/composables/resolveLocalized.js"
import { useAddToPlaylist } from "@shruti/composables/useAddToPlaylist.js"
import { useToast } from "@shruti/services/useToast.js"
import type { AuthorId, LocationId, SourceId, TrackId } from "@lib/domain/core.js"
import type { Author } from "@lib/domain/author.js"
import type { Track } from "@lib/domain/track.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"

const props = defineProps<{ trackId: string }>()

const { t } = useI18n()
const app = useShruti()
const appLanguage = useAppLanguage()
const { addToPlaylist } = useAddToPlaylist()
const toast = useToast()

const loading = ref(true)
const error = ref(false)
const track = ref<Track | null>(null)
const author = ref<Author | null>(null)
const location = ref<Location | null>(null)
const sourcesById = ref<Map<string, Source>>(new Map())
const actionSheetOpen = ref(false)

interface SheetButton {
  readonly text: string
  readonly role?: "cancel" | "destructive"
  readonly handler: () => void
}

const actionSheetButtons = computed<readonly SheetButton[]>(() => [
  {
    text: t("search.actions.addToPlaylist"),
    handler: () => { void onAddOne() },
  },
  {
    text: t("app.cancel"),
    role: "cancel",
    handler: () => undefined,
  },
])

const title = computed(() =>
  track.value ? (resolveTrackTitle(track.value, appLanguage.value) ?? track.value.id) : ""
)

const references = computed<string[]>(() => {
  if (!track.value) return []
  return groupReferences(
    track.value.references,
    sourcesById.value,
    appLanguage.value
  )
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
  if (track.value.date) parts.push(formatDate(track.value.date))
  return parts.join(" · ")
})

function formatDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  if (!m) return d
  const [, y, mo, day] = m
  if (appLanguage.value === "ru") return `${day}.${mo}.${y}`
  return `${Number(day)} ${monthEn(mo)} ${y}`
}

function monthEn(mo: string): string {
  const i = Math.max(0, Math.min(11, Number(mo) - 1))
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i]
}

async function load(): Promise<void> {
  loading.value = true
  error.value = false
  try {
    const repos = app.repositories()
    const trk = await repos.tracks.getById(props.trackId as TrackId)
    if (!trk) {
      error.value = true
      return
    }
    track.value = trk
    const sourceIds = Array.from(
      new Set(trk.references.map((r) => r.sourceId).filter((id): id is string => !!id))
    )
    const [au, loc, sources] = await Promise.all([
      trk.authorId
        ? repos.authors.getById(trk.authorId as AuthorId)
        : Promise.resolve(null),
      trk.locationId
        ? repos.locations.getById(trk.locationId as LocationId)
        : Promise.resolve(null),
      Promise.all(sourceIds.map((id) => repos.sources.getById(id as SourceId))),
    ])
    author.value = (au as Author | null) ?? null
    location.value = (loc as Location | null) ?? null
    const sourceMap = new Map<string, Source>()
    for (const s of sources) {
      if (s) sourceMap.set(s.id, s as Source)
    }
    sourcesById.value = sourceMap
  } catch (err) {
    console.warn("TrackMiniRow: failed to load track", err)
    error.value = true
  } finally {
    loading.value = false
  }
}

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

onMounted(() => { void load() })
watch(() => props.trackId, () => { void load() })
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
  font-size: 12px;
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
  background: linear-gradient(90deg, rgba(120,120,120,0.12), rgba(120,120,120,0.06), rgba(120,120,120,0.12));
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
