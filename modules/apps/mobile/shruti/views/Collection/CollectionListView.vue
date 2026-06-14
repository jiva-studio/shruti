<template>
  <IonPage>
    <IonHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/search" />
        </IonButtons>
        <IonTitle>{{ title }}</IonTitle>
      </IonToolbar>
    </IonHeader>

    <IonContent :fullscreen="true">
      <div class="list">
        <CollectionListItem
          v-for="c in collections"
          :key="c.id"
          :name="c.name"
          :cover-url="c.coverUrl"
          :description="c.description"
          @click="openCollection(c.id)"
        />
      </div>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { CollectionListItem } from "@ui/features/collections/index.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { getRegions } from "@shruti/services/regionsRegistry.js"

const props = defineProps<{ groupId?: string }>()

const { t } = useI18n()
const router = useRouter()
const app = useShruti()
const appLanguage = useAppLanguage()

interface Row {
  id: string
  name: string
  coverUrl?: string
  description?: string
}

const title = ref("")
const collections = ref<readonly Row[]>([])

function coverUrl(cover: string): string | undefined {
  if (!cover) return undefined
  const region = getRegions()[0]
  return region ? buildServerUrl(region, cover) : undefined
}

async function load(groupId: string | undefined, locale: string): Promise<void> {
  title.value = ""
  collections.value = []
  try {
    const repos = app.repositories()
    if (groupId) {
      const groups = await repos.collections.listGroups(locale)
      title.value = groups.find((g) => g.id === groupId)?.name ?? ""
      const cols = await repos.collections.getGroupCollections(groupId, locale)
      collections.value = cols.map((c) => ({
        id: c.id,
        name: c.name,
        coverUrl: coverUrl(c.cover),
        description: c.description,
      }))
    } else {
      title.value = t("search.collections.all")
      const cols = await repos.collections.listCollections(locale)
      collections.value = cols.map((c) => ({
        id: c.id,
        name: c.name,
        coverUrl: coverUrl(c.cover),
        description: c.description,
      }))
    }
  } catch (err) {
    console.warn("[collection-list] load failed", err)
    collections.value = []
  }
}

watch(
  () => [props.groupId, appLanguage.value] as const,
  ([groupId, locale]) => void load(groupId, locale),
  { immediate: true }
)

function openCollection(id: string): void {
  void router.push({ name: "collection", params: { id } })
}
</script>

<style scoped>
.list {
  padding: 8px 0 16px;
}
</style>
