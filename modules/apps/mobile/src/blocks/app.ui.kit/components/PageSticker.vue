<template>
  <div
    class="PageSticker center"
    :class="{ visible: visible }"
    @click="goTonavigationPath"
  >
    <img
      :src="image"
      @load="onLoad"
    >
    <b class="header">{{ header }}</b>
    {{ message }}
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const router = useRouter()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  navigationPath: string
  image: string
  header: string
  message: string
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const visible = ref(false)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function goTonavigationPath() {
  router.replace({ name: props.navigationPath })
}

function onLoad() {
  visible.value = true
}
</script>


<style scoped>
.PageSticker {
  max-width: 80%;
  display: flex;
  gap: .75rem;
  flex-direction: column;
  align-items: center;
  text-align: center;
  transition: all 0.15s ease-in-out;
  opacity: 0;
}

.visible {
  opacity: 1;
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
</style>