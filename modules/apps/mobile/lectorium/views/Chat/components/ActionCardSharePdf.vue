<template>
  <ul v-if="payload" class="pdf-list">
    <li
      v-for="item in payload.items"
      :key="item.trackId"
      class="pdf-row"
      role="button"
      tabindex="0"
      :aria-disabled="rowState(item.trackId) === 'sharing'"
      :data-state="rowState(item.trackId)"
      @click="onShare(item)"
      @keydown.enter.space.prevent="onShare(item)"
    >
      <span class="pdf-icon" aria-hidden="true">
        <IonSpinner v-if="rowState(item.trackId) === 'sharing'" name="dots" />
        <IconFileTypePdf v-else :size="32" :stroke-width="1.6" />
      </span>
      <div class="pdf-info">
        <span class="pdf-title">{{ item.title }}</span>
        <span v-if="item.references.length" class="pdf-refs">
          <ScriptureChip v-for="(r, i) in item.references" :key="i" :caption="refCaption(r)" />
        </span>
        <span v-if="metaFor(item)" class="pdf-meta">{{ metaFor(item) }}</span>
      </div>
    </li>
  </ul>
  <section v-else class="pdf-broken">
    <span class="pdf-broken-icon">⚠</span>
    <span class="pdf-broken-text">{{ $t("chat.actionDegraded") }}</span>
  </section>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonSpinner } from "@ionic/vue"
import { IconFileTypePdf } from "@tabler/icons-vue"
import type { ActionPayload } from "@lectorium/stores/useChatStore.js"
import type {
  ChatSharePdfItemPayload as SharePdfItemPayload,
  ChatSharePdfRefPayload as SharePdfRefPayload,
} from "@lib/domain/chatMessage.js"
import ScriptureChip from "@lib/ui/chat/ScriptureChip.vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useToast } from "@kit/composables"
import { useShareJobStore } from "@lectorium/stores/useShareJobStore.js"
import { useShareBackgroundOnLeave } from "@lectorium/composables/useShareBackgroundOnLeave.js"
import { useShareTranscript } from "@lectorium/composables/useShareTranscript.js"

type RowState = "idle" | "sharing" | "shared" | "error"

const props = defineProps<{
  actionId: string
  payload?: Extract<ActionPayload, { kind: "share_pdf" }>
}>()

const { t } = useI18n()
const { shareService } = useLectorium()
const toast = useToast()
const shareJob = useShareJobStore()
const shareTranscript = useShareTranscript()

// The row spinner is the only trace this share leaves, and it is gone the
// moment the user leaves the chat — while the slot stays held. Hand the
// indicator to the tab bar on the way out (#1886).
useShareBackgroundOnLeave()

// Local per-row state. Doesn't need to persist across navigation —
// re-tapping a "shared" row just redoes the share-sheet handoff, which
// is identical work (excerptCache.download is a cache-hit second time).
const rowStates = ref<Record<string, RowState>>({})

function rowState(trackId: string): RowState {
  return rowStates.value[trackId] ?? "idle"
}

function metaFor(item: SharePdfItemPayload): string {
  const parts: string[] = []
  if (item.author) parts.push(item.author)
  if (item.date) parts.push(item.date)
  return parts.join(" · ")
}

// Caption for one scripture reference — the server already resolved the
// source label, so this is just "<short_name> <tokens>" e.g. "БГ 4.8".
function refCaption(r: SharePdfRefPayload): string {
  const label = r.shortName ?? r.fullName ?? r.sourceId ?? ""
  return r.tokens ? `${label} ${r.tokens}`.trim() : label
}

async function onShare(item: SharePdfItemPayload): Promise<void> {
  if (rowState(item.trackId) === "sharing") return
  // Legacy card persisted before the share-transcript migration carried a
  // pre-rendered `pdfUrl`, not a `transcriptKey` — it can't be re-rendered.
  // Surface a clear error instead of POSTing an undefined key (→ 422).
  if (!item.transcriptKey) {
    rowStates.value = { ...rowStates.value, [item.trackId]: "error" }
    await toast.error(t("chat.actionPdfError"))
    return
  }
  // Cross-tab share is a single-slot operation in this app — the same
  // tap-block as Notes audio applies. If another share is already in
  // flight, drop a toast and bail; the user can retap once the slot
  // frees.
  if (!shareJob.tryStart("pdf", `${item.trackId}:${item.lang || "ru"}`)) {
    await toast.info(t("notes.shareAlreadyInProgress"))
    return
  }
  rowStates.value = { ...rowStates.value, [item.trackId]: "sharing" }
  try {
    // Render on demand via share-transcript (resolveShareArtifact reuses a
    // warm CDN copy when present), then hand the local file to the sheet.
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

<style scoped>
.pdf-list {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.pdf-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 4px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 120ms ease;
}

/* Soft gradient divider between rows — mirrors the VerseCard top /
   bottom rules so action lists read consistently with verse cards. */
.pdf-row + .pdf-row {
  background-image: linear-gradient(
    to right,
    transparent,
    rgba(var(--ion-color-tertiary-rgb), 0.18),
    transparent
  );
  background-position: top;
  background-repeat: no-repeat;
  background-size: 100% 1px;
}

.pdf-row:active:not([aria-disabled="true"]) {
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}

.pdf-row[aria-disabled="true"] {
  cursor: default;
}

/* "shared" state: subtle dimming + check-mark cue via the icon area. */
.pdf-row[data-state="shared"] .pdf-icon {
  opacity: 0.45;
}

.pdf-icon {
  flex: 0 0 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ion-color-primary);
  height: 40px;
}

.pdf-icon ion-spinner {
  --color: var(--ion-color-primary);
  height: 28px;
  width: 28px;
}

.pdf-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.pdf-title {
  /* Match bubble prose size (15px / 1.45) so the row reads as
     part of the conversation, not as an embedded widget. */
  font-size: 15px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ion-text-color);
}

.pdf-refs {
  /* Scripture-address chips (ScriptureChip) — the key identifier of the
     lecture. The chip carries its own pill styling; this just lays them
     out, wrapping for a multi-verse lecture. Negative margin offsets the
     chip's own 2px side margin so it aligns with the title. */
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 2px 0 0 -2px;
}

.pdf-meta {
  font-size: 13px;
  line-height: 1.25;
  color: var(--ion-color-medium);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
