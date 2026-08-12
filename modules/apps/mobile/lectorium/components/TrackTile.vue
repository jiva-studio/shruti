<template>
  <!-- Only a tile that can be opened claims to be a button; one that is waiting,
       broken, not ours yet or unresolved is a picture with a control on it. -->
  <div
    class="track-tile"
    :class="{ loading, tappable }"
    :role="tappable ? 'button' : undefined"
    :tabindex="tappable ? 0 : undefined"
    :aria-hidden="loading ? 'true' : undefined"
    @click="onTap"
    @keydown.enter.prevent="onTap"
    @keydown.space.prevent="onTap"
  >
    <TileCover
      :cover="cover"
      :title="title"
      :loading="loading"
      :dimmed="status === 'pending'"
      @loaded="loaded = true"
    />

    <template v-if="!loading">
      <TileCorner
        :status="status"
        :progress="progress"
        :can-retry="canRetry"
        :add-label="addLabel"
        @add="emit('add')"
        @retry="emit('retry')"
      />
      <TileCaption
        :title="title"
        :subtitle="subtitle"
        :error-message="status === 'failed' ? errorMessage : ''"
        :over-art="overArt"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import TileCover from "./tile/TileCover.vue"
import TileCorner from "./tile/TileCorner.vue"
import TileCaption from "./tile/TileCaption.vue"
import type { TileStatus } from "./tile/status.js"

/**
 * A track as a square cover tile: the art, the words along the bottom, one
 * control in the corner.
 *
 * One tile for every place a track is offered — the personal library, a search
 * hit, a chat suggestion — so `addable` sits beside the pipeline states rather
 * than in a tile of its own: tap the plus and that same tile starts reporting
 * which stage the fetch has reached.
 *
 * Presentational. It is told what it is and emits what was done to it.
 */
export type { TileStatus }

const props = withDefaults(
  defineProps<{
    title?: string
    subtitle?: string
    cover?: string | null
    status: TileStatus
    /** Stage and completion while fetching. */
    progress?: { label: string; percent?: number }
    canRetry?: boolean
    /** Why it failed, shown in place of the subtitle. */
    errorMessage?: string
    addLabel?: string
    /** Whether a ready tile has somewhere to go — false makes it a picture. */
    selectable?: boolean
  }>(),
  {
    title: "",
    subtitle: "",
    cover: null,
    progress: undefined,
    canRetry: false,
    errorMessage: "",
    addLabel: "",
    selectable: true,
  }
)

const emit = defineEmits<{ select: []; add: []; retry: [] }>()

const loaded = ref(false)
const tappable = computed(() => props.status === "ready" && props.selectable)
const loading = computed(() => props.status === "loading")
// A decoded cover or the tint the tile paints for itself — either way there is
// something behind the words.
const overArt = computed(() => loaded.value || !props.cover)

function onTap(): void {
  if (tappable.value) emit("select")
}
</script>

<style scoped>
.track-tile {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  /* One radius for every square cover in the app (CollectionCard, media card). */
  border-radius: 4px;
  overflow: hidden;
  appearance: none;
  border: 0;
  margin: 0;
  padding: 0;
  text-align: start;
  background: var(--ion-color-light, #f4f5f8);
  cursor: default;
}

.track-tile.tappable {
  cursor: pointer;
}
</style>
