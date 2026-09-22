<template>
  <div class="page-sticker" @click="onClick">
    <LazyImage v-if="image" :src="image" class="sticker-image" />
    <b v-if="header" class="sticker-header">{{ header }}</b>
    <span v-if="message" class="sticker-message">{{ message }}</span>
    <div v-if="$slots.footer" class="sticker-footer" @click.stop>
      <slot name="footer" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * A centered empty-state "sticker": optional illustration, header, message and a
 * footer slot (e.g. a call-to-action chip). i18n-agnostic (text via props) and
 * router-agnostic: clicking the body emits `navigate` with the optional `to`
 * payload so the host decides whether/where to route.
 */
import LazyImage from "./LazyImage.vue"

const props = defineProps<{
  /** Opaque navigation target echoed back in the `navigate` event payload. */
  to?: string
  image?: string
  header?: string
  message?: string
}>()

const emit = defineEmits<{
  /** Fired on body click. Carries `to` so the host can route. */
  navigate: [to: string | undefined]
}>()

function onClick() {
  emit("navigate", props.to)
}
</script>

<style scoped>
/* Flex-fill column so the sticker centers inside an IonContent / AppPage
 * `.page-content` (both expose a column flex with `min-height:100%`).
 * The column itself is capped so the icon / text / footer chip row stay
 * cozy on landscape phones and tablets instead of stretching to the
 * full page width. */
.page-sticker {
  flex: 1 1 auto;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 24px 16px;
  text-align: center;
  max-width: 420px;
  width: 100%;
  margin-inline: auto;
}

.sticker-image {
  width: 100%;
  /* Absolute cap kills the prior 60% / 75% / 60vw growth on wide viewports. */
  max-width: 220px;
  height: auto;
}

.sticker-header {
  font-size: 1.5rem;
  font-weight: bold;
}

.sticker-message {
  color: var(--ion-color-medium);
}

.sticker-footer {
  margin-top: 1rem;
  width: 100%;
}
</style>
