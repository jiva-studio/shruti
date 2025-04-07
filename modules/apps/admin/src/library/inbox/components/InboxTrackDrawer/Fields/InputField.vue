<template>
  <div class="flex flex-col gap-2">
    <label :for="id" class="font-bold">
      {{ label }}
    </label>
    <slot :has-errors="hasErrors" />
    <TransitionGroup name="list">
      <Message
        v-for="(error, index) in errors"
        :key="error.text"
        :severity="error.severity"
        :data-index="index"
      >
        {{ error.text }}
      </Message>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { computed, defineProps } from 'vue'
import Message from 'primevue/message'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type Error = { text: string; severity: 'error' | 'warn' }

const props = defineProps<{
  label: string
  id: string
  errors?: Error[] | undefined
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const hasErrors = computed(() => fieldHasErrors(props.errors))

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function fieldHasErrors(obj: Error[] | undefined) {
  if (!obj) return false
  return obj.filter((error) => error.severity === 'error').length > 0
}
</script>

<style scoped>
.list-move,
.list-enter-active,
.list-leave-active {
  transition: all 0.5s ease;
}

.list-enter-from,
.list-leave-to {
  opacity: 0;
  transform: translateX(10px);
}

.list-leave-active {
  position: relative;
}
</style>
