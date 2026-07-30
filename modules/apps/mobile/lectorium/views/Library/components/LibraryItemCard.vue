<template>
  <!-- role=button, NOT a native <button>: the card holds nested interactive
       bits (the failed-status Retry). A <button> parent makes that invalid HTML
       the parser hoists OUT of the card, so the status leaks over other
       sections. A div can never reparent its children out. -->
  <div
    class="lib-card"
    :class="{ pending: !isReady }"
    role="button"
    :tabindex="isReady ? 0 : -1"
    :aria-disabled="!isReady || undefined"
    @click="onTap"
    @keydown.enter.prevent="onTap"
    @keydown.space.prevent="onTap"
  >
    <div class="cover">
      <CachedImage v-if="coverUrl" :url="coverUrl" :alt="title" />
      <div v-else class="cover-placeholder" aria-hidden="true">
        <IconVinyl :size="28" />
      </div>
    </div>

    <div class="meta">
      <span class="title">{{ title }}</span>
      <!-- Status sits in the meta row (not overlaid on the cover corner, where
           it read as clipped) and only when it's meaningful — a "ready" item is
           the normal case and needs no label. -->
      <LibraryItemStatusBadge
        v-if="item.status !== 'ready'"
        :status="item.status"
        @retry="emit('retry', item)"
      />
      <span v-else-if="subtitle" class="subtitle">{{ subtitle }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { IconVinyl } from "@tabler/icons-vue"
import { CachedImage } from "@ui/primitives/index.js"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"
import type { LibraryItem } from "@lib/domain/libraryItem.js"
import LibraryItemStatusBadge from "./LibraryItemStatusBadge.vue"

/**
 * A single personal-library item as a cover card: cover art (via
 * `resolveAssetUrl(cover_key)`, falling back to the shared placeholder when the
 * key is null — no generated cover), title, a subtitle (author · date) and the
 * ingest status badge. Ready items are tappable (`select`); pending ones are
 * disabled; a failed item's badge emits `retry`.
 */
const props = defineProps<{ item: LibraryItem }>()

const emit = defineEmits<{
  (e: "select", item: LibraryItem): void
  (e: "retry", item: LibraryItem): void
}>()

const { t } = useI18n()

const isReady = computed(() => props.item.status === "ready")
const coverUrl = computed(() => resolveAssetUrl(props.item.coverKey ?? undefined))
const title = computed(() => props.item.titleRaw?.trim() || t("library.untitled"))
const subtitle = computed(() => {
  const parts = [props.item.authorRaw, props.item.locationRaw, props.item.dateRaw].filter(
    (p): p is string => !!p && p.trim().length > 0
  )
  return parts.join(" · ")
})

function onTap(): void {
  if (isReady.value) emit("select", props.item)
}
</script>

<style scoped>
.lib-card {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 0;
  margin: 0;
  text-align: start;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
}

.lib-card.pending {
  cursor: default;
}

.lib-card.pending .cover {
  opacity: 0.85;
}

.cover {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 12px;
  overflow: hidden;
  background: var(--ion-color-light, #f4f5f8);
}

.cover-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ion-color-medium, #92949c);
}

.meta {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--ion-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.subtitle {
  font-size: 11px;
  color: var(--ion-color-medium, #92949c);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
