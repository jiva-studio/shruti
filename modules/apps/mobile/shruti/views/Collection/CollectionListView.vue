<script setup lang="ts">
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import { IonBackButton, IonButtons, IonContent, IonPage, IonTitle, IonToolbar } from "@ionic/vue"
import { FlatHeader } from "@ui/primitives/index.js"
import { CollectionListItem } from "@ui/features/collections/index.js"
import RowDivider from "@ui/components/RowDivider.vue"
import { useShruti } from "@shruti/shruti.js"
import { useCollectionLanguage } from "@shruti/composables/useCollectionLanguage.js"
import { resolveAssetUrl } from "@shruti/services/regionsRegistry.js"

const props = defineProps<{ groupId?: string }>()

const { t } = useI18n()
const router = useRouter()
const app = useShruti()
// Collections follow the chosen library content language, not the UI locale.
const collectionLanguage = useCollectionLanguage()

interface Row {
  id: string
  name: string
  coverUrl?: string
  description?: string
}

const title = ref("")
const description = ref("")
const collections = ref<readonly Row[]>([])

async function load(groupId: string | undefined, locale: string): Promise<void> {
  title.value = ""
  description.value = ""
  collections.value = []
  try {
    const repos = app.repositories()
    if (groupId) {
      const groups = await repos.collections.listGroups(locale)
      const group = groups.find((g) => g.id === groupId)
      title.value = group?.name ?? ""
      description.value = group?.description ?? ""
      const cols = await repos.collections.getGroupCollections(groupId, locale)
      collections.value = cols.map((c) => ({
        id: c.id,
        name: c.name,
        coverUrl: resolveAssetUrl(c.cover),
        description: c.description,
      }))
    } else {
      title.value = t("search.collections.all")
      const cols = await repos.collections.listCollections(locale)
      collections.value = cols.map((c) => ({
        id: c.id,
        name: c.name,
        coverUrl: resolveAssetUrl(c.cover),
        description: c.description,
      }))
    }
  } catch (err) {
    console.warn("[collection-list] load failed", err)
    collections.value = []
  }
}

watch(
  () => [props.groupId, collectionLanguage.value] as const,
  ([groupId, locale]) => void load(groupId, locale),
  { immediate: true }
)

function openCollection(id: string): void {
  void app.haptics.impact("light")
  void router.push({ name: "collection", params: { id } })
}
</script>

<template>
  <IonPage>
    <FlatHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/search" />
        </IonButtons>
        <IonTitle>{{ title }}</IonTitle>
      </IonToolbar>
    </FlatHeader>

    <IonContent :fullscreen="true">
      <p v-if="description" class="group-description">{{ description }}</p>
      <div class="list">
        <template v-for="(c, index) in collections" :key="c.id">
          <CollectionListItem
            :name="c.name"
            :cover-url="c.coverUrl"
            :description="c.description"
            @click="openCollection(c.id)"
          />
          <RowDivider v-if="index < collections.length - 1" />
        </template>
      </div>
    </IonContent>
  </IonPage>
</template>

<style scoped>
.group-description {
  margin: 0;
  padding: 12px 16px 4px;
  font-size: 14px;
  line-height: 1.45;
  color: var(--ion-color-medium-shade);
}

.list {
  padding: 8px 0 16px;
}
</style>
