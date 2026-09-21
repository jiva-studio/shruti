<script setup lang="ts">
import IconAppSadhu from "@lectorium/views/Chat/components/IconAppSadhu.vue"

defineProps<{ unread: boolean }>()
</script>

<template>
  <div class="chat-icon-wrap">
    <IconAppSadhu :size="48" />
    <span v-if="unread" class="proactive-dot" />
  </div>
</template>

<style scoped>
.chat-icon-wrap {
  position: relative;
  display: inline-block;
}

/* A dot, not a count: it reads cleaner against the round chat-tab disc and
   has no tail behaviour past two digits. */
.proactive-dot {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ion-color-warning, #ffc409);
  border: 2px solid var(--ion-background-color, #fff);
  pointer-events: none;
}
</style>
