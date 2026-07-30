<template>
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
      <span v-if="isPending" class="status processing">
        <IonSpinner name="dots" class="status-spinner" />
        {{ $t("library.status.processing") }}
      </span>
      <button
        v-else-if="isFailed"
        type="button"
        class="status retry"
        @click.stop="emit('retry', item)"
      >
        <IconAlertTriangle :size="13" />
        {{ $t("library.status.retry") }}
      </button>
    </div>

    <div class="meta">
      <span class="title">{{ title }}</span>
      <span v-if="subtitle" class="subtitle">{{ subtitle }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { IonSpinner } from "@ionic/vue"
import { IconVinyl, IconAlertTriangle } from "@tabler/icons-vue"
import { CachedImage } from "@ui/primitives/index.js"
import { resolveAssetUrl } from "@shruti/services/regionsRegistry.js"
import type { LibraryItem } from "@lib/domain/libraryItem.js"

/**
 * A single personal-library item as a cover card: cover art (via
 * `resolveAssetUrl(cover_key)`, falling back to the shared placeholder when the
 * key is null — no generated cover), title and a subtitle (author · location ·
 * date). While ingesting, a status pill sits on the cover — a spinner for
 * queued/processing, a Retry button for failed (clipped to the cover, which is
 * position:relative + overflow:hidden). Ready items tap to `select`.
 */
const props = defineProps<{ item: LibraryItem }>()

const emit = defineEmits<{
  (e: "select", item: LibraryItem): void
  (e: "retry", item: LibraryItem): void
}>()

const { t } = useI18n()

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

.status {
  position: absolute;
  left: 6px;
  bottom: 6px;
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

.status.retry {
  appearance: none;
  background: var(--ion-color-danger);
  color: var(--ion-color-danger-contrast);
  cursor: pointer;
}

.status-spinner {
  width: 14px;
  height: 12px;
  color: inherit;
}
</style>
