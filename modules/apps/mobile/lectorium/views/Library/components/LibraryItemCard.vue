<template>
  <div
    class="lib-card"
    :class="{ pending: !isReady, 'is-loaded': loaded }"
    role="button"
    :tabindex="isReady ? 0 : -1"
    :aria-disabled="!isReady || undefined"
    @click="onTap"
    @keydown.enter.prevent="onTap"
    @keydown.space.prevent="onTap"
  >
    <CachedImage v-if="coverUrl" :url="coverUrl" :alt="title" @loaded="loaded = true" />
    <div v-else class="cover-placeholder" aria-hidden="true">
      <IconVinyl :size="28" />
    </div>

    <span v-if="isPending" class="status processing">
      <IonSpinner name="dots" class="status-spinner" />
      {{ $t("library.status.processing") }}
    </span>
    <span v-else-if="isFailed" class="status failed">
      <IconAlertTriangle :size="13" />
      {{ $t("library.status.failed") }}
    </span>

    <span class="scrim" aria-hidden="true" />
    <div class="meta">
      <span class="title">{{ title }}</span>
      <span v-if="isFailed" class="subtitle error">{{ errorMessage }}</span>
      <span v-else-if="subtitle" class="subtitle">{{ subtitle }}</span>
      <button v-if="canRetry" type="button" class="retry" @click.stop="onRetry">
        <IconReload :size="13" />
        {{ $t("library.status.retry") }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonSpinner } from "@ionic/vue"
import { IconVinyl, IconAlertTriangle, IconReload } from "@tabler/icons-vue"
import { CachedImage } from "@ui/primitives/index.js"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"
import type { LibraryItem } from "@lib/domain/libraryItem.js"

/**
 * A single personal-library item as a square cover tile: cover art (via
 * `resolveAssetUrl(cover_key)`, falling back to the shared placeholder when the
 * key is null), with the title and subtitle (author · location · date) overlaid
 * at the bottom over a readability scrim — the same treatment as the collection
 * tiles it sits beside. While ingesting, a status pill sits at the top — a
 * spinner for queued/processing, a Failed label otherwise. Ready items tap to
 * `select`; a failed item shows the localized reason and a Retry button that
 * re-runs the ingest (`retry`).
 */
const props = defineProps<{ item: LibraryItem }>()

const emit = defineEmits<{
  (e: "select", item: LibraryItem): void
  (e: "retry", item: LibraryItem): void
}>()

const { t, te } = useI18n()

const isReady = computed(() => props.item.status === "ready")
const isPending = computed(
  () => props.item.status === "queued" || props.item.status === "processing"
)
const isFailed = computed(() => props.item.status === "failed")
const coverUrl = computed(() => resolveAssetUrl(props.item.coverKey ?? undefined))
const title = computed(() => props.item.titleRaw?.trim() || t("library.untitled"))
const subtitle = computed(() => {
  const parts = [props.item.authorRaw, props.item.locationRaw, props.item.dateRaw].filter(
    (p): p is string => !!p && p.trim().length > 0
  )
  return parts.join(" · ")
})
// The server ships a STABLE failure code (e.g. "unavailable"); map it to a
// localized reason, falling back to the generic message for an unknown code.
const errorMessage = computed(() => {
  const key = `library.status.errors.${props.item.error ?? "internal"}`
  return te(key) ? t(key) : t("library.status.errors.internal")
})
// A failed item can be retried only when we still know the source URL to re-add
// (older rows predate source_url).
const canRetry = computed(() => isFailed.value && !!props.item.sourceUrl)

const loaded = ref(false)

function onTap(): void {
  if (isReady.value) emit("select", props.item)
}

function onRetry(): void {
  emit("retry", props.item)
}
</script>

<style scoped>
.lib-card {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  /* Match the sibling cover tiles (CollectionCard / media card) — one radius
     for every square cover in the app. */
  border-radius: 4px;
  overflow: hidden;
  appearance: none;
  border: 0;
  margin: 0;
  padding: 0;
  text-align: start;
  background: var(--ion-color-light, #f4f5f8);
  cursor: pointer;
}

.lib-card.pending {
  cursor: default;
}

.lib-card.pending :deep(.cached-image),
.lib-card.pending .cover-placeholder {
  opacity: 0.85;
}

.cover-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ion-color-medium, #92949c);
}

/* Readability scrim behind the overlaid text — revealed with the cover once it
   decodes, absent over the bare placeholder. Fixed espresso tones (not theme
   vars, which invert) so the overlay stays legible over any cover. */
.scrim {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 62%;
  background: linear-gradient(to top, rgba(61, 43, 31, 0.78), rgba(61, 43, 31, 0));
  opacity: 0;
  pointer-events: none;
}

.lib-card.is-loaded .scrim {
  opacity: 1;
}

.meta {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 18px 10px 9px;
}

.title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  /* Dark over the bare placeholder, switching to cream once the cover + scrim
     appear (fixed tone, doesn't invert) so it stays legible over the image. */
  color: var(--ion-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.subtitle {
  font-size: 11px;
  line-height: 1.3;
  color: var(--ion-color-medium, #92949c);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lib-card.is-loaded .title {
  color: var(--lectorium-scrim-cream);
}

.lib-card.is-loaded .subtitle {
  color: var(--lectorium-scrim-cream);
  opacity: 0.85;
}

.subtitle.error {
  color: var(--ion-color-danger);
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.lib-card.is-loaded .subtitle.error {
  color: var(--lectorium-scrim-cream);
  opacity: 1;
}

.retry {
  align-self: flex-start;
  margin-top: 6px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  border-radius: 999px;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}

.status {
  position: absolute;
  left: 6px;
  top: 6px;
  max-width: calc(100% - 12px);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  border: 0;
  border-radius: 999px;
  padding: 4px 9px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.status.processing {
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}

.status.failed {
  background: var(--ion-color-danger);
  color: var(--ion-color-danger-contrast);
}

.status-spinner {
  width: 14px;
  height: 12px;
  color: inherit;
}
</style>
