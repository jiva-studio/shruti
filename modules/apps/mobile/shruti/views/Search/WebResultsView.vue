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
      <p v-if="query" class="query">{{ query }}</p>

      <div v-if="web.isLoadingFirstPage.value" class="state">
        <IonSpinner name="dots" />
      </div>

      <div v-else-if="web.error.value" class="state state--muted">
        {{ $t("search.web.unavailable") }}
      </div>

      <template v-else>
        <p v-for="(m, i) in web.messages.value" :key="i" class="note">{{ m.text }}</p>

        <div v-if="web.hits.value.length" class="grid">
          <WebLectureCard v-for="hit in web.hits.value" :key="hit.item_id" :hit="hit" />
        </div>

        <div v-else class="state state--muted">{{ $t("search.web.empty") }}</div>

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

      <div class="bottom-spacer" aria-hidden="true" />
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useRoute, useRouter } from "vue-router"
import {
  IonButton,
  IonButtons,
  IonContent,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { IconArrowLeft } from "@tabler/icons-vue"
import { FlatHeader } from "@ui/primitives/index.js"
import { useSearchFiltersBinding } from "./composables/useSearchFiltersBinding.js"
import { useWebSearch } from "./composables/useWebSearch.js"
import WebLectureCard from "./components/WebLectureCard.vue"

/**
 * Everything the archives turned up for one search, as a page.
 *
 * The shelf on the library tab is a glance — a few covers you can flick
 * through. This is where "see all" lands: the same card, laid out to be read
 * down rather than across, and the only place that pages in more.
 *
 * The query travels in the URL rather than through a store, so the page is a
 * real address: it survives a reload and can be linked to. The filters come
 * from the same persisted binding the tab uses, so the two agree without one
 * having to hand them over.
 */
const route = useRoute()
const router = useRouter()

const query = ref<string>(typeof route.query.q === "string" ? route.query.q : "")
const { filters } = useSearchFiltersBinding()
const enabled = computed(() => query.value.trim().length > 0)

const web = useWebSearch({ query, filters, enabled })
</script>

<style scoped>
.query {
  margin: 4px 16px 12px;
  color: var(--ion-color-medium);
  font-size: 14px;
}

/* Read down, not across: two to a row on a phone, more as the screen allows. */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 12px;
  padding: 0 16px;
}

.state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 96px;
  padding: 8px 16px;
  text-align: center;
}

.state--muted {
  color: var(--ion-color-medium);
  font-size: 14px;
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

.bottom-spacer {
  height: var(--kit-page-reserved-space, 0px);
}
</style>
