<template>
  <!-- Only a tile that can be opened claims to be a button. One that is
       waiting, broken or not ours yet is a picture with a control on it, and
       saying otherwise reports that control as disabled too. -->
  <div
    class="track-tile"
    :class="{ pending: status === 'pending', 'is-loaded': loaded }"
    :role="tappable ? 'button' : undefined"
    :tabindex="tappable ? 0 : undefined"
    @click="onTap"
    @keydown.enter.prevent="onTap"
    @keydown.space.prevent="onTap"
  >
    <CachedImage v-if="cover" :url="cover" :alt="title" @loaded="loaded = true" />
    <div v-else class="cover-placeholder" aria-hidden="true">
      <IconVinyl :size="28" />
    </div>

    <!-- One corner, whatever the tile currently is: fetching, broken, not ours
         yet, or simply ours. -->
    <IngestProgressBadge
      v-if="status === 'pending'"
      class="corner"
      :percent="progress?.percent"
      :label="progress?.label ?? ''"
    />
    <button
      v-else-if="status === 'failed' && canRetry"
      type="button"
      class="corner status failed as-button"
      @click.stop="emit('retry')"
    >
      <IconReload :size="13" />
      {{ $t("library.status.retry") }}
    </button>
    <span v-else-if="status === 'failed'" class="corner status failed">
      <IconAlertTriangle :size="13" />
      {{ $t("library.status.failed") }}
    </span>
    <button
      v-else-if="status === 'addable'"
      type="button"
      class="corner add"
      :aria-label="addLabel"
      @click.stop="emit('add')"
    >
      <IconPlus :size="18" />
    </button>

    <span class="scrim" aria-hidden="true" />
    <div class="meta">
      <span class="title">{{ title }}</span>
      <span v-if="status === 'failed' && errorMessage" class="subtitle error">
        {{ errorMessage }}
      </span>
      <span v-else-if="subtitle" class="subtitle">{{ subtitle }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { IconVinyl, IconAlertTriangle, IconReload, IconPlus } from "@tabler/icons-vue"
import { CachedImage } from "@ui/primitives/index.js"
import IngestProgressBadge from "./IngestProgressBadge.vue"

/**
 * A track as a square cover tile: the art, the title and a line of detail over
 * a readability scrim, and one control in the corner.
 *
 * There is one of these because there was nearly one of these three times — the
 * personal library grew it first, and a track found by searching is the same
 * object in the same states, just one nobody has added yet. So `addable` sits
 * beside the pipeline states rather than in a tile of its own: the corner shows
 * a plus, and the moment it is tapped that very tile starts reporting which
 * stage the fetch has reached.
 *
 * Presentational. It is told what it is and emits what was done to it.
 */
export type TileStatus = "addable" | "pending" | "ready" | "failed"

const props = withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    /** Cover art, or nothing — then the placeholder disc. */
    cover?: string | null
    status: TileStatus
    /** Stage and completion while fetching. */
    progress?: { label: string; percent?: number }
    /** A failed tile offers a retry only when there is something to retry. */
    canRetry?: boolean
    /** Why it failed, shown in place of the subtitle. */
    errorMessage?: string
    addLabel?: string
  }>(),
  {
    subtitle: "",
    cover: null,
    progress: undefined,
    canRetry: false,
    errorMessage: "",
    addLabel: "",
  }
)

const emit = defineEmits<{ select: []; add: []; retry: [] }>()

const loaded = ref(false)
// Only a track that is ours and ready has something to open.
const tappable = computed(() => props.status === "ready")

function onTap(): void {
  if (tappable.value) emit("select")
}
</script>

<style scoped>
.track-tile {
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

.track-tile.pending {
  cursor: default;
}

.track-tile.pending :deep(.cached-image),
.track-tile.pending .cover-placeholder {
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

.corner {
  position: absolute;
  top: 6px;
  left: 6px;
  max-width: calc(100% - 12px);
  z-index: 1;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}

.status.failed {
  background: var(--ion-color-danger, #eb445a);
}

.as-button {
  border: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

/* The one control a track that is not ours yet offers. Same disc as the chat
   card's, so adding looks the same wherever it is offered. */
.add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
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

.track-tile.is-loaded .scrim {
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
  line-height: 1.25;
  color: var(--ion-color-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subtitle.error {
  color: var(--ion-color-danger, #eb445a);
}

.track-tile.is-loaded .title {
  color: #fdf6ec;
}

.track-tile.is-loaded .subtitle {
  color: rgba(253, 246, 236, 0.82);
}
</style>
