<template>
  <div class="PageSticker center" @click="onClick">
    <LazyImage :src="image" class="sticker-image" />
    <b class="header">{{ header }}</b>
    {{ message }}
  </div>
</template>

<script setup lang="ts">
import { useRouter } from "vue-router"
import LazyImage from "./LazyImage.vue"

const router = useRouter()

const props = defineProps<{
  /** Vue Router target route name. When set, click navigates via `router.replace`. */
  to?: string
  image: string
  header: string
  message: string
}>()

function onClick() {
  if (props.to) {
    router.replace({ name: props.to })
  }
}
</script>

<style scoped>
.PageSticker {
  max-width: 80%;
  width: 80%;
  display: flex;
  gap: 0.75rem;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.header {
  font-size: 1.5rem;
  font-weight: bold;
}

.center {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.sticker-image {
  max-width: 75%;
}

@media (prefers-color-scheme: dark) {
  .sticker-image {
    filter: grayscale(1) brightness(0.7) opacity(0.8);
  }
}
</style>
