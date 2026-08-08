<template>
  <IonPage>
    <FlatHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonButton :aria-label="$t('app.back')" @click="router.back()">
            <IconArrowLeft :size="22" />
          </IonButton>
        </IonButtons>
        <IonTitle>{{ $t("search.web.title") }}</IonTitle>
      </IonToolbar>
    </FlatHeader>

    <IonContent :fullscreen="true">
      <div class="page-content">
        <!-- What the service said about the request itself: a speaker it does
             not know, a field the sentence overruled. Without these an empty
             page cannot tell "nothing matches" from "nothing could". -->
        <p v-for="(m, i) in web.messages.value" :key="i" class="note">{{ m.text }}</p>

        <PageSticker v-if="sticker" :header="sticker.header" :message="sticker.message" />

        <template v-else>
          <!-- The grid that is coming, drawn empty — same tile, no content — so
               the page has its shape before the archives answer. -->
          <div v-if="web.isLoadingFirstPage.value" class="grid">
            <TrackTile v-for="n in SKELETON_COUNT" :key="n" status="loading" />
          </div>

          <div v-else class="grid">
            <WebTrackCard v-for="hit in web.hits.value" :key="hit.item_id" :hit="hit" />
          </div>

          <IonButton
            v-if="web.hasMore.value"
            class="more"
            fill="clear"
            size="small"
            :disabled="web.isLoading.value"
            @click="web.loadMore()"
          >
            {{ $t("search.web.more") }}
          </IonButton>
        </template>
      </div>

      <DockSpacer />
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import { IonButton, IonButtons, IonContent, IonPage, IonTitle, IonToolbar } from "@ionic/vue"
import { IconArrowLeft } from "@tabler/icons-vue"
import { FlatHeader, PageSticker } from "@ui/primitives/index.js"
import { useSearchFiltersBinding } from "./composables/useSearchFiltersBinding.js"
import { useSearchDock } from "@shruti/composables/useSearchDock.js"
import DockSpacer from "@shruti/components/DockSpacer.vue"
import { useWebSearch } from "./composables/useWebSearch.js"
import WebTrackCard from "./components/WebTrackCard.vue"
import TrackTile from "@shruti/components/TrackTile.vue"

/**
 * Everything the archives turned up for one search, as a page.
 *
 * The shelf on the library tab is a glance — a few covers you can flick
 * through. This is where "see all" lands: the same card, laid out to be read
 * down rather than across, and the only place that pages in more.
 *
 * The tab's field floats over this page too, so the query is read live from the
 * shared ref: editing the words here re-runs the search. `?q=` is the address
 * the page was opened at — it seeds the field on a cold arrival (reload, link)
 * and nothing more. The filters come from the same persisted binding the tab
 * uses, so the two agree without one having to hand them over.
 */
const SKELETON_COUNT = 8

const props = withDefaults(defineProps<{ initialQuery?: string }>(), { initialQuery: "" })

const router = useRouter()
const { t } = useI18n()

const { text: query } = useSearchDock()
if (props.initialQuery && !query.value.trim()) query.value = props.initialQuery

const { filters } = useSearchFiltersBinding()
const enabled = computed(() => query.value.trim().length > 0)

const web = useWebSearch({ query, filters, enabled })

// The three ways this page has nothing to lay out. An empty field is the one
// that used to read as an answer — "nothing on the archives we index" is what
// the archives said, and with nothing asked they were never asked at all.
const sticker = computed<{ header?: string; message: string } | null>(() => {
  if (!enabled.value) return { message: t("search.web.prompt") }
  // Before the last answer: the skeletons hold the page, and the error still
  // standing from the previous words is not this search's verdict.
  if (web.isLoadingFirstPage.value) return null
  if (web.error.value) return { message: t("search.web.unavailable") }
  if (web.hits.value.length === 0) {
    return { header: t("search.noResultsTitle"), message: t("search.web.empty") }
  }
  return null
})
</script>

<style scoped>
/* A column that fills the page, so the sticker centres in it. */
.page-content {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* Read down, not across: two to a row on a phone, more as the screen allows. */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 14px;
  padding: 0 16px;
}

.note {
  margin: 0 16px 8px;
  color: var(--ion-color-medium);
  font-size: 13px;
  line-height: 1.35;
}

.more {
  margin: 12px 8px 0;
}
</style>
