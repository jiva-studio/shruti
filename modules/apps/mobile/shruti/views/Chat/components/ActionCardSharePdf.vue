<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import type { ActionPayload } from "@shruti/stores/useChatStore.js"
import type { ChatSharePdfItemPayload as SharePdfItemPayload } from "@lib/domain/chatMessage.js"
import SharePdfRow from "./SharePdfRow.vue"
import type { SharePdfRowState } from "./sharePdf.js"
import { useShruti } from "@shruti/shruti.js"
import { useToast } from "@kit/composables"
import { useShareJobStore } from "@shruti/stores/useShareJobStore.js"
import { useShareBackgroundOnLeave } from "@shruti/composables/useShareBackgroundOnLeave.js"
import { useShareTranscript } from "@shruti/composables/useShareTranscript.js"

const props = defineProps<{
  actionId: string
  payload?: Extract<ActionPayload, { kind: "share_pdf" }>
}>()

const { t } = useI18n()
const { shareService } = useShruti()
const toast = useToast()
const shareJob = useShareJobStore()
const shareTranscript = useShareTranscript()

// The row spinner is the only trace this share leaves, and it goes the moment
// the user leaves the chat while the slot stays held — so the indicator is
// handed to the tab bar on the way out.
useShareBackgroundOnLeave()

// Per-row and not persisted: re-tapping a shared row redoes the share-sheet
// handoff, which is a cache hit.
const rowStates = ref<Record<string, SharePdfRowState>>({})

function rowState(trackId: string): SharePdfRowState {
  return rowStates.value[trackId] ?? "idle"
}

async function onShare(item: SharePdfItemPayload): Promise<void> {
  if (rowState(item.trackId) === "sharing") return
  // A card persisted before the share-transcript migration carries a rendered
  // `pdfUrl` and no `transcriptKey`, so it cannot be re-rendered.
  if (!item.transcriptKey) {
    rowStates.value = { ...rowStates.value, [item.trackId]: "error" }
    await toast.error(t("chat.actionPdfError"))
    return
  }
  // Sharing is a single-slot operation app-wide, the same tap-block as Notes
  // audio.
  if (!shareJob.tryStart("pdf", `${item.trackId}:${item.lang || "ru"}`)) {
    await toast.info(t("notes.shareAlreadyInProgress"))
    return
  }
  rowStates.value = { ...rowStates.value, [item.trackId]: "sharing" }
  try {
    // Rendered on demand; a warm CDN copy is reused when there is one.
    const localUri = await shareTranscript.prepareLocalPdf({
      trackId: item.trackId,
      lang: item.lang || "ru",
      transcriptKey: item.transcriptKey,
      title: item.title,
      author: item.author,
      date: item.date,
      location: item.location,
      references: item.references,
      tags: item.tags,
    })
    await shareService.share({
      url: localUri,
      title: item.title,
      dialogTitle: t("chat.actionPdfDialog"),
    })
    rowStates.value = { ...rowStates.value, [item.trackId]: "shared" }
  } catch (err) {
    console.warn("[share-pdf] failed", err)
    rowStates.value = { ...rowStates.value, [item.trackId]: "error" }
    await toast.error(t("chat.actionPdfError"))
  } finally {
    shareJob.finish()
  }
}

// `actionId` is used by the parent to scope this card; not read here.
void props.actionId
</script>

<template>
  <ul v-if="payload" class="pdf-list">
    <SharePdfRow
      v-for="item in payload.items"
      :key="item.trackId"
      :item="item"
      :state="rowState(item.trackId)"
      @share="onShare(item)"
    />
  </ul>
  <section v-else class="pdf-broken">
    <span class="pdf-broken-icon">⚠</span>
    <span class="pdf-broken-text">{{ $t("chat.actionDegraded") }}</span>
  </section>
</template>

<style scoped>
.pdf-list {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.pdf-broken {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--ion-color-medium);
  border: 1px dashed rgba(var(--ion-color-medium-rgb, 146, 148, 156), 0.5);
  background: transparent;
  border-radius: 12px;
}

.pdf-broken-icon {
  flex: 0 0 auto;
  opacity: 0.8;
}

.pdf-broken-text {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
