<template>
  <div
    class="web-row"
    role="button"
    tabindex="0"
    @click="onTap"
    @keydown.enter.space.prevent="onTap"
  >
    <IconHeadphones class="icon" :size="26" :stroke-width="1.6" aria-hidden="true" />

    <div class="info">
      <span class="title">{{ title }}</span>
      <div class="details-line">
        <span v-if="primaryRef" class="ref">{{ primaryRef }}</span>
        <span v-if="extraRefCount > 0" class="ref extra">+{{ extraRefCount }}</span>
        <span v-if="meta" class="details">{{ meta }}</span>
      </div>
    </div>

    <IngestProgressBadge
      v-if="add.state.value === 'pending'"
      class="trailing"
      :percent="add.percent.value"
      :label="add.stageLabel.value"
    />
    <button
      v-else-if="add.state.value === 'failed'"
      type="button"
      class="trailing control control--error"
      :aria-label="$t('library.status.retry')"
      @click.stop="onAdd"
    >
      <IconRefresh :size="16" />
    </button>
    <span
      v-else-if="add.state.value === 'ready'"
      class="trailing control control--done"
      :aria-label="$t('search.actions.alreadyInLibrary')"
    >
      <IconCheck :size="18" />
    </span>
    <button
      v-else
      type="button"
      class="trailing control"
      :aria-label="$t('search.web.add')"
      @click.stop="onAdd"
    >
      <IconPlus :size="18" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { IconHeadphones, IconPlus, IconCheck, IconRefresh } from "@tabler/icons-vue"
import IngestProgressBadge from "@shruti/components/IngestProgressBadge.vue"
import type { DiscoveryHit } from "@lib/contracts"
import { useWebLectureAdd } from "../composables/useWebLectureAdd.js"

/**
 * A lecture found on an archive that publishes files rather than videos — no
 * poster to show, so it reads as a row: an icon, what it is about, and the add
 * control on the trailing edge.
 *
 * Same three states as the poster card, same badge, same single call behind the
 * button. The two differ in shape only because the source material does.
 */
const props = defineProps<{ hit: DiscoveryHit }>()

const add = useWebLectureAdd(() => props.hit)

const title = computed(() => props.hit.title || props.hit.media_url)

const primaryRef = computed(() => props.hit.references?.[0] ?? "")
const extraRefCount = computed(() => Math.max(0, (props.hit.references?.length ?? 0) - 1))

const meta = computed(() => {
  const parts = [props.hit.author, props.hit.location, props.hit.recorded_on?.slice(0, 10)].filter(
    Boolean
  )
  return parts.join(" · ")
})

function onAdd(): void {
  void add.add()
}

function onTap(): void {
  if (add.state.value === "addable" || add.state.value === "failed") void add.add()
}
</script>

<style scoped>
.web-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 120ms ease;
}

.web-row:active {
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}

.icon {
  flex: 0 0 26px;
  color: var(--ion-color-primary);
}

.info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title {
  font-weight: 500;
  font-size: 15px;
  line-height: 1.3;
  color: var(--ion-text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* One physical line: the reference chip, then `author · place · date` —
   the same line LectureCard and TrackMiniRow use. */
.details-line {
  display: flex;
  align-items: baseline;
  flex-wrap: nowrap;
  gap: 6px;
  min-width: 0;
}

.ref {
  flex: 0 0 auto;
  background: var(--ion-color-light-shade);
  color: var(--ion-color-medium);
  font-size: 11px;
  font-weight: 700;
  font-stretch: condensed;
  line-height: 1.4;
  padding: 0 5px;
  border-radius: 5px;
  white-space: nowrap;
}

.ref.extra {
  opacity: 0.55;
}

.details {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.25;
  color: var(--ion-color-medium);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trailing {
  flex: 0 0 auto;
}

.control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--ion-color-light);
  color: var(--ion-color-primary);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.control--done {
  background: var(--ion-color-success, #2dd36f);
  color: #fff;
  cursor: default;
}

.control--error {
  background: var(--ion-color-danger, #eb445a);
  color: #fff;
}
</style>
