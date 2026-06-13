<template>
  <IonModal :is-open="open" class="collection-modal" @did-dismiss="emit('update:open', false)">
    <div v-if="detail" class="collection-detail">
      <div class="hero" :class="{ 'hero--placeholder': !coverUrl }">
        <img v-if="coverUrl" :src="coverUrl" :alt="detail.name" />
      </div>
      <div class="body">
        <h2 class="title">{{ detail.name }}</h2>
        <p v-if="detail.description" class="description">{{ detail.description }}</p>
        <p class="count">
          {{ t("search.collections.trackCount", { count: detail.trackIds.length }) }}
        </p>
      </div>
      <div class="actions">
        <IonButton expand="block" :disabled="adding || detail.trackIds.length === 0" @click="onAdd">
          {{ t("search.collections.addAll") }}
        </IonButton>
      </div>
    </div>
  </IonModal>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonModal, IonButton } from "@ionic/vue"
import { useShruti } from "@shruti/shruti.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { getRegions } from "@shruti/services/regionsRegistry.js"
import { addTracksToPlaylist } from "@lib/application"
import { useToast } from "@kit/composables"
import type { CollectionDetail } from "@infra/repositories/sql/index.js"

/**
 * Collection detail sheet opened from the Search carousel: cover, name,
 * description, lecture count and a one-tap "Add collection" that fans the
 * ordered tracks into the playlist. Loads on open; renders nothing until the
 * detail resolves.
 */
const props = defineProps<{
  open: boolean
  collectionId: string | null
  locale: string
}>()
const emit = defineEmits<{ (e: "update:open", open: boolean): void }>()

const { t } = useI18n()
const app = useShruti()
const playlist = usePlaylistStore()
const toast = useToast()

const detail = ref<CollectionDetail | null>(null)
const coverUrl = ref<string | undefined>(undefined)
const adding = ref(false)

async function load(id: string, locale: string): Promise<void> {
  detail.value = null
  coverUrl.value = undefined
  try {
    const d = await app.repositories().collections.getCollection(id, locale)
    detail.value = d
    if (d?.cover) {
      const region = getRegions()[0]
      coverUrl.value = region ? buildServerUrl(region, d.cover) : undefined
    }
  } catch (err) {
    console.warn("[collection-detail] load failed", err)
    detail.value = null
  }
}

watch(
  () => [props.open, props.collectionId] as const,
  ([open, id]) => {
    if (open && id) void load(id, props.locale)
  },
  { immediate: true }
)

async function onAdd(): Promise<void> {
  if (!detail.value || detail.value.trackIds.length === 0) return
  adding.value = true
  try {
    const result = await addTracksToPlaylist(
      { trackIds: [...detail.value.trackIds] },
      { playlist: { add: (id) => playlist.add(id) } }
    )
    if (!result.ok) {
      void toast.error(t("search.collections.addError"))
    } else {
      emit("update:open", false)
    }
  } catch {
    void toast.error(t("search.collections.addError"))
  } finally {
    adding.value = false
  }
}
</script>

<style scoped>
/* Cream-on-cream modals need an explicit radius + shadow or they vanish into
   the dimmed backdrop (project gotcha). Auto height = fit-content sheet. */
.collection-modal {
  --border-radius: 18px;
  --box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
  --height: auto;
  --width: 92%;
  --max-width: 420px;
}

.collection-detail {
  display: flex;
  flex-direction: column;
}

.hero {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--ion-color-light);
  overflow: hidden;
}

.hero--placeholder {
  background: linear-gradient(
    135deg,
    rgba(var(--ion-color-primary-rgb), 0.55),
    rgba(var(--ion-color-tertiary-rgb), 0.7)
  );
}

.hero img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.body {
  padding: 16px 18px 4px;
}

.title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
  color: var(--ion-text-color);
}

.description {
  margin: 0 0 10px;
  font-size: 14px;
  line-height: 1.45;
  color: var(--ion-color-medium-shade);
}

.count {
  margin: 0;
  font-size: 13px;
  color: var(--ion-color-medium);
}

.actions {
  padding: 8px 14px 16px;
}
</style>
