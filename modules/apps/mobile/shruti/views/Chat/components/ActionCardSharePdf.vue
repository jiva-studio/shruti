<template>
  <section v-if="payload" class="action-card pdf">
    <header class="head">
      <span class="kind">{{ $t("chat.actionPdfKind") }}</span>
    </header>

    <ul class="rows">
      <li v-for="item in payload.items" :key="item.trackId" class="row">
        <div class="info">
          <span class="title">{{ item.title }}</span>
          <span v-if="metaFor(item)" class="meta">{{ metaFor(item) }}</span>
        </div>
        <footer class="row-footer">
          <button
            type="button"
            class="btn primary"
            :disabled="rowState(item.trackId) === 'sharing'"
            @click="onShare(item)"
          >
            <!-- Single fixed-width inner wrapper so the chip itself stays
                 the same size whether we show a spinner, "Share",
                 "Sent", or "Retry" — no jitter when state flips. -->
            <span class="btn-label">
              <IonSpinner v-if="rowState(item.trackId) === 'sharing'" name="dots" class="spinner" />
              <template v-else-if="rowState(item.trackId) === 'shared'">
                {{ $t("chat.actionPdfShared") }}
              </template>
              <template v-else-if="rowState(item.trackId) === 'error'">
                {{ $t("chat.actionRetry") }}
              </template>
              <template v-else>{{ $t("chat.actionPdfShare") }}</template>
            </span>
          </button>
        </footer>
      </li>
    </ul>
  </section>
  <section v-else class="action-card pdf broken">
    <span class="broken-icon">⚠</span>
    <span class="broken-text">{{ $t("chat.actionDegraded") }}</span>
  </section>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonSpinner } from "@ionic/vue"
import type { ActionPayload, SharePdfItemPayload } from "@shruti/services/chatClient.js"
import { useShruti } from "@shruti/shruti.js"
import { useToast } from "@shruti/services/useToast.js"
import { useShareJobStore } from "@shruti/stores/useShareJobStore.js"

type RowState = "idle" | "sharing" | "shared" | "error"

const props = defineProps<{
  actionId: string
  payload?: Extract<ActionPayload, { kind: "share_pdf" }>
}>()

const { t } = useI18n()
const { shareService, excerptCache } = useShruti()
const toast = useToast()
const shareJob = useShareJobStore()

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

// Filesystem-unsafe across Android / iOS / Windows shares. Control
// chars in user-facing track titles are nonsense in practice; we strip
// them belt-and-suspenders so a malformed catalog entry can't produce
// a filename Android refuses to share.
// eslint-disable-next-line no-control-regex
const BAD_FNAME = /[\\/:*?"<>|\x00-\x1f]/g

function localFilename(item: SharePdfItemPayload): string {
  // Two filenames in play: this one (what the user sees in Telegram /
  // WhatsApp / Files) and a stable cache key. We derive the cache key
  // from trackId+lang so a re-tap is an instant local-cache hit; the
  // user-visible filename comes from the lecture title with the date.
  const base = (item.title || item.trackId).replace(BAD_FNAME, "").trim().slice(0, 80)
  const dateSuffix = item.date ? ` (${item.date})` : ""
  return `${base || item.trackId}${dateSuffix}.pdf`
}

async function onShare(item: SharePdfItemPayload): Promise<void> {
  if (rowState(item.trackId) === "sharing") return
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
    const localUri = await excerptCache.download({
      url: item.pdfUrl,
      filename: localFilename(item),
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
.action-card.pdf {
  margin: 8px 0;
  padding: 0;
  border-radius: 12px;
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.28);
  background: rgba(var(--ion-color-primary-rgb), 0.06);
  overflow: hidden;
}

.action-card.broken {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--ion-color-medium);
  border: 1px dashed rgba(var(--ion-color-medium-rgb, 146, 148, 156), 0.5);
  background: transparent;
}

.broken-icon {
  flex: 0 0 auto;
  opacity: 0.8;
}

.broken-text {
  flex: 1 1 auto;
  min-width: 0;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 12px 6px;
}

.kind {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px 8px;
}

.row + .row {
  border-top: 1px solid rgba(var(--ion-color-step-200-rgb, 200, 200, 200), 0.14);
}

.info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  font-size: 12px;
  line-height: 1.25;
  color: var(--ion-color-medium);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Footer row mirrors the playlist card's bottom-aligned action: the
 * button parks at the right edge with consistent gutter, and the
 * fixed-width inner label keeps the chip itself the same size
 * whether it renders text or a spinner. */
.row-footer {
  display: flex;
  justify-content: flex-end;
}

.btn {
  appearance: none;
  border: 0;
  border-radius: 10px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
  min-height: 32px;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Fixed inner width — sized for the widest expected label
   * ("Поделиться") so RU and EN both fit without resizing the chip
   * across state transitions. */
  min-width: 110px;
}

.btn.primary {
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}

.btn.primary[disabled] {
  opacity: 0.7;
  cursor: default;
}

.spinner {
  width: 18px;
  height: 14px;
}
</style>
