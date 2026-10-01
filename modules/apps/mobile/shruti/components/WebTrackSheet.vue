<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { IonButton, IonContent, IonFooter, IonModal } from "@ionic/vue"
import { IconPlaylistAdd, IconShare, IconStarsFilled } from "@tabler/icons-vue"
import { trackName } from "@lib/contracts"
import { formatTrackDate } from "@lib/domain/services/trackDate.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useElementHeight } from "@shruti/composables/useElementHeight.js"
import { useWebLectureSummary } from "@shruti/composables/useWebLectureSummary.js"
import { useShruti } from "@shruti/shruti.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { useWebTrackSheetStore } from "@shruti/stores/useWebTrackSheetStore.js"
import { useWebLectureAdd } from "@shruti/views/Search/composables/useWebLectureAdd.js"
import TrackSheetHeader from "@shruti/components/TrackSheetHeader.vue"

const { t } = useI18n()
const app = useShruti()
const appLanguage = useAppLanguage()
const sheet = useWebTrackSheetStore()
const library = useLibraryStore()

const modalRef = useTemplateRef<{ $el: HTMLElement & { dismiss: () => Promise<boolean> } }>(
  "modalRef"
)
const hit = computed(() => sheet.hit)
const open = computed(() => sheet.isOpen)

const addLecture = useWebLectureAdd(() => sheet.hit!)
const { summary, isAiGenerated } = useWebLectureSummary(hit)

const contentRef = ref<InstanceType<typeof IonContent> | null>(null)
const headerComp = useTemplateRef<{ $el: HTMLElement }>("headerComp")
const footerComp = useTemplateRef<{ $el: HTMLElement }>("footerComp")
const headerHeight = useElementHeight(computed(() => headerComp.value?.$el ?? null))
const footerHeight = useElementHeight(computed(() => footerComp.value?.$el ?? null))

const contentInsets = computed(() => ({
  "--padding-top": `${headerHeight.value}px`,
  "--padding-bottom": `${footerHeight.value}px`,
}))

const title = computed(() => {
  if (!hit.value) return ""
  return trackName(hit.value) || t("library.untitled")
})

const author = computed(() => hit.value?.author?.trim() || null)

const metaParts = computed<readonly { text: string; shrinkable: boolean }[]>(() => {
  if (!hit.value) return []
  const parts: { text: string; shrinkable: boolean }[] = []
  if (hit.value.location?.trim()) {
    parts.push({ text: hit.value.location.trim(), shrinkable: true })
  }
  if (hit.value.recorded_on) {
    parts.push({
      text: formatTrackDate(hit.value.recorded_on.slice(0, 10), appLanguage.value),
      shrinkable: false,
    })
  }
  return parts
})

const isAlreadyAdded = computed(() => {
  if (!hit.value) return false
  return library.hasSource(hit.value.media_url)
})

const primaryActionLabel = computed(() => {
  if (isAlreadyAdded.value) return t("search.actions.alreadyInPlaylist")
  if (addLecture.state.value === "pending") return t("library.status.processing")
  return t("search.actions.addToPlaylist")
})

const addDisabled = computed(() => isAlreadyAdded.value || addLecture.state.value === "pending")

async function onShare(): Promise<void> {
  if (!hit.value) return
  void app.haptics.impact("light")
  try {
    await app.shareService.share({
      url: hit.value.media_url,
      title: title.value,
      dialogTitle: t("search.share.dialogLink"),
    })
  } catch (err) {
    console.warn("[web-track-sheet] share failed", err)
  }
}

async function onPrimaryAction(): Promise<void> {
  if (!hit.value) return
  await addLecture.add()
  if (addLecture.state.value !== "failed") {
    onClose()
  }
}

function onClose(): void {
  sheet.close()
  void modalRef.value?.$el?.dismiss?.()
}

function onDidDismiss(): void {
  sheet.onDismiss()
}
</script>

<template>
  <IonModal
    ref="modalRef"
    :is-open="open"
    class="track-sheet web-track-sheet"
    @did-dismiss="onDidDismiss"
  >
    <TrackSheetHeader
      ref="headerComp"
      :title="title"
      :author="author"
      :meta-parts="metaParts"
      @close="onClose"
    />
    <IonContent ref="contentRef" :style="contentInsets">
      <div class="sheet-body">
        <p v-if="isAiGenerated" class="ai-badge">
          <IconStarsFilled :size="14" />
          <span>AI Overview</span>
        </p>
        <p v-if="summary" class="description">{{ summary }}</p>
      </div>
    </IonContent>

    <IonFooter class="ion-no-border">
      <div ref="footerComp" class="sheet-actions">
        <IonButton
          fill="clear"
          class="act icon-act share-btn"
          :aria-label="t('search.actions.share')"
          @click="onShare"
        >
          <IconShare slot="icon-only" :size="18" />
        </IonButton>
        <IonButton class="act add-btn" :disabled="addDisabled" @click="onPrimaryAction">
          <IconPlaylistAdd slot="start" :size="18" />
          {{ primaryActionLabel }}
        </IonButton>
      </div>
    </IonFooter>
  </IonModal>
</template>

<style scoped>
.ai-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ion-color-primary, #6366f1);
}

.description {
  margin: 0 0 16px;
  font-size: 15px;
  line-height: 1.55;
  color: var(--ion-text-color, #222);
}

.sheet-body {
  padding: 4px var(--ion-padding, 16px) 16px;
}

.sheet-actions {
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 28px 16px calc(10px + var(--ion-safe-area-bottom, 0px));
  background: linear-gradient(
    to top,
    rgba(var(--shruti-fade-bg-rgb), 1) 0%,
    rgba(var(--shruti-fade-bg-rgb), 0.98) 60%,
    rgba(var(--shruti-fade-bg-rgb), 0.6) 85%,
    rgba(var(--shruti-fade-bg-rgb), 0) 100%
  );
}

.act {
  position: relative;
  margin: 0;
  --padding-start: 0;
  --padding-end: 0;
  --box-shadow: none;
}

.icon-act {
  flex: 0 0 auto;
  width: 48px;
}

.add-btn {
  flex: 1;
  min-width: 0;
}

.act [slot="start"] {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  margin: 0;
}

.share-btn {
  position: relative;
  --background: var(--ion-color-step-100, rgba(0, 0, 0, 0.05));
  --background-hover: var(--ion-color-step-150, rgba(0, 0, 0, 0.08));
  --color: var(--ion-color-medium, #777);
}
</style>
