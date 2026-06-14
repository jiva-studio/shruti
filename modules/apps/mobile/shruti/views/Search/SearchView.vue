<template>
  <AppPage :reserve-bottom-space="player.open">
    <div v-for="g in topGroups" :key="g.id" class="collection-group">
      <IonListHeader>
        <IonLabel>{{ g.name }}</IonLabel>
        <IonButton
          class="no-ripple"
          :aria-label="$t('search.collections.seeAll')"
          @click="openGroup(g.id)"
        >
          <IconChevronRight :size="20" />
        </IonButton>
      </IonListHeader>
      <CollectionsCarousel :items="g.collections" @select="onSelectCollection" />
    </div>

    <template v-if="otherCollections.length">
      <IonListHeader>
        <IonLabel>{{ $t("search.collections.others") }}</IonLabel>
        <IonButton
          class="no-ripple"
          :aria-label="$t('search.collections.seeAll')"
          @click="openAllCollections"
        >
          <IconChevronRight :size="20" />
        </IonButton>
      </IonListHeader>
      <CollectionListItem
        v-for="c in otherCollections"
        :key="c.id"
        :name="c.name"
        :cover-url="c.coverUrl"
        :description="c.description"
        @click="onSelectCollection(c.id)"
      />
    </template>

    <IonListHeader>
      <IonLabel>{{ $t("search.popularLecturesTitle") }}</IonLabel>
      <IonButton
        class="no-ripple"
        :aria-label="$t('search.collections.seeAll')"
        @click="openTracks"
      >
        <IconChevronRight :size="20" />
      </IonButton>
    </IonListHeader>
    <TracksList :rows="previewLectures" @select="search.onSelect">
      <template #state="{ state, progressPct }">
        <TrackStateIndicator :state="state" :progress="progressPct" />
      </template>
    </TracksList>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useRouter } from "vue-router"
import { IonButton, IonLabel, IonListHeader, onIonViewWillEnter } from "@ionic/vue"
import { IconChevronRight } from "@tabler/icons-vue"
import { AppPage } from "@ui/primitives/index.js"
import { TracksList, type UiTrackRow } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { CollectionsCarousel, CollectionListItem } from "@ui/features/collections/index.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import {
  useCollectionGroups,
  type GroupCollection,
} from "@shruti/composables/useCollectionGroups.js"
import { useSearchController } from "./SearchView.controller.js"

const player = usePlayerStore()
const router = useRouter()
const search = useSearchController()
const appLanguage = useAppLanguage()
const { groups: collectionGroups, allCollections } = useCollectionGroups(appLanguage)

const topGroups = computed(() => collectionGroups.value.slice(0, 2))
const OTHER_COLLECTIONS_LIMIT = 4
const PREVIEW_LECTURES_LIMIT = 10
const otherCollections = ref<readonly GroupCollection[]>([])
const previewLectures = ref<readonly UiTrackRow[]>([])

function shuffled<T>(items: readonly T[]): T[] {
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool
}

function pickDiscovery(): void {
  const shown = new Set(topGroups.value.flatMap((g) => g.collections.map((c) => c.id)))
  otherCollections.value = shuffled(allCollections.value.filter((c) => !shown.has(c.id))).slice(
    0,
    OTHER_COLLECTIONS_LIMIT
  )
  previewLectures.value = shuffled(search.rows.value).slice(0, PREVIEW_LECTURES_LIMIT)
}

// Depend on the row COUNT, not the rows array: the mapped rows recompute a new
// array on every download/playback store tick, and watching the array itself
// re-ran the shuffle dozens of times a second (remounting the cards). The count
// only changes when results actually load, so the sample stays stable.
watch([collectionGroups, allCollections, () => search.rows.value.length], pickDiscovery, {
  immediate: true,
})
onIonViewWillEnter(pickDiscovery)

function onSelectCollection(id: string): void {
  void router.push({ name: "collection", params: { id } })
}

function openGroup(groupId: string): void {
  void router.push({ name: "collection-group", params: { groupId } })
}

function openAllCollections(): void {
  void router.push({ name: "collections" })
}

function openTracks(): void {
  void router.push({ name: "tracks" })
}
</script>

<style scoped>
ion-list-header ion-label {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--ion-text-color);
}

ion-list-header ion-button {
  --color: var(--ion-color-medium);
}

:deep(ion-list) {
  --padding-top: 0;
  padding-top: 0;
}
</style>
