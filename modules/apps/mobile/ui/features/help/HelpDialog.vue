<template>
  <IonModal class="help-dialog" :is-open="open" @did-dismiss="onDismiss">
    <Header>
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
    </Header>

    <IonContent ref="contentRef">
      <HelpToc v-if="currentPageId === null" @select="onPageSelected" />
      <HelpPage v-else :id="currentPageId" />
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonButton, IonButtons, IonContent, IonModal, IonTitle, IonToolbar } from "@ionic/vue"
import { Header } from "@ui/primitives/index.js"
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

<style>
/* Kill the Material elevation under the toolbar so the help modal reads
   as a flat sheet, matching SelectorDialog and the rest of the app. The
   `Header` primitive already strips the iOS hairline via `ion-no-border`
   on Android; this also kills Android's box-shadow. */
.help-dialog ion-header,
.help-dialog ion-header::after {
  box-shadow: none !important;
  background-image: none;
}
.help-dialog ion-header::after {
  display: none;
}
</style>
