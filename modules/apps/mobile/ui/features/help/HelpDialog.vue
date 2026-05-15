<template>
  <IonModal :is-open="open" @did-dismiss="onDismiss">
    <IonHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonButton v-if="currentPageId" shape="round" size="small" @click="currentPageId = null">
            {{ $t("help.back") }}
          </IonButton>
        </IonButtons>
        <IonTitle>{{ headerTitle }}</IonTitle>
        <IonButtons slot="end">
          <IonButton shape="round" size="small" @click="open = false">
            {{ $t("help.close") }}
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </IonHeader>

    <IonContent ref="contentRef">
      <HelpToc v-if="currentPageId === null" @select="onPageSelected" />
      <HelpPage v-else :id="currentPageId" />
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonModal,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import HelpToc from "./HelpToc.vue"
import HelpPage from "./HelpPage.vue"
import type { HelpPageId } from "./pages/manifest.js"

const open = defineModel<boolean>("open", { required: true, default: false })

const { t } = useI18n()

const currentPageId = ref<HelpPageId | null>(null)
const contentRef = ref<InstanceType<typeof IonContent> | null>(null)

const headerTitle = computed(() =>
  currentPageId.value === null ? t("help.title") : t(`help.pages.${currentPageId.value}.title`)
)

function onPageSelected(id: HelpPageId): void {
  currentPageId.value = id
}

function onDismiss(): void {
  open.value = false
  currentPageId.value = null
}

// Scroll modal back to the top whenever the user switches page.
watch(currentPageId, async () => {
  await contentRef.value?.$el?.scrollToTop?.(0)
})
</script>

<style scoped>
ion-content {
  --padding-top: 8px;
}
</style>
