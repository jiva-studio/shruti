<template>
  <IonChip
    :color="color"
    class="chip"
    @click="emit('click')"
  >
    <slot />
  </IonChip>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { IonChip } from '@ionic/vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const { applied = false } = defineProps<{
  applied?: boolean
}>()

const emit = defineEmits<{
  click: []
  remove: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const color = computed(() => applied ? 'primary' : 'medium')
</script>

<style scoped>
.chip {
  margin-right: 5px;
  margin-left: 5px;
}
</style>