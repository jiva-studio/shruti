<template>
  <!--
    Dumb whole-lecture row for a chat `[card:<track_id>]` result. The HOST
    resolves attribution (title / reference / meta) and owns the behaviour
    (open the lecture, add-to-playlist…) via the `activate` event. Same
    minimal-row look on web and mobile; the host fills the `#icon` slot to
    keep this component free of any icon-library dependency.
  -->
  <article
    class="lecture-card"
    role="button"
    tabindex="0"
    @click="emit('activate')"
    @keydown.enter.space.prevent="emit('activate')"
  >
    <div v-if="error" class="placeholder error">{{ missingLabel }}</div>
    <template v-else>
      <span class="lecture-icon" aria-hidden="true">
        <slot name="icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
            <path d="M18 19a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-1v6h1z" />
            <path d="M6 19a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h1v6H6z" />
          </svg>
        </slot>
      </span>
      <div class="lecture-info">
        <span class="title">{{ title }}</span>
        <div v-if="primaryRef || metaLine" class="details-line">
          <span v-if="primaryRef" class="ref">{{ primaryRef }}</span>
          <span v-if="extraRefCount > 0" class="ref extra">+{{ extraRefCount }}</span>
          <span v-if="metaLine" class="details">{{ metaLine }}</span>
        </div>
      </div>
    </template>
  </article>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string
    primaryRef?: string
    extraRefCount?: number
    metaLine?: string
    error?: boolean
    missingLabel?: string
  }>(),
  { primaryRef: '', extraRefCount: 0, metaLine: '', error: false, missingLabel: '' },
)

const emit = defineEmits<{ activate: [] }>()
</script>

<style scoped>
/* Minimal row — flat, no card-background or border: a document-style icon on
   the left, title + ref+meta on the right. Mirrors the mobile LectureCard.
   Framework-neutral: NO Ionic. Colours derive from the inherited text colour
   (`currentColor` + color-mix) so the row adapts to light/dark on any host;
   the host themes the icon accent via `--lc-accent`. */
.lecture-card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0.25rem 0;
  padding: 8px 4px;
  background: transparent;
  border: none;
  border-radius: 6px;
  text-align: left;
  width: 100%;
  color: inherit;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 120ms ease;
}

.lecture-card:hover,
.lecture-card:active {
  background: color-mix(in srgb, currentColor 7%, transparent);
}

.lecture-icon {
  flex: 0 0 28px;
  display: flex;
  color: var(--lc-accent, currentColor);
}

.lecture-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title {
  font-weight: 600;
  font-size: 15px;
  line-height: 1.3;
  color: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.details-line {
  display: flex;
  align-items: baseline;
  flex-wrap: nowrap;
  gap: 6px;
  min-width: 0;
}

.ref {
  flex: 0 0 auto;
  background: color-mix(in srgb, currentColor 12%, transparent);
  color: inherit;
  opacity: 0.85;
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
  color: inherit;
  opacity: 0.65;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.placeholder.error {
  min-height: 40px;
  display: flex;
  align-items: center;
  font-size: 13px;
  color: inherit;
  opacity: 0.55;
}
</style>
