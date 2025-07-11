<template>
  <IonChip
    :color="color"
    class="chip"
    @click="emit('click')"
  >
    <slot />
    <IonIcon
      :icon="icon"
      @click.stop="applied ? emit('remove') : emit('click')"
    />
  </IonChip>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { IonChip, IonIcon } from '@ionic/vue'
import { close, chevronDownOutline } from 'ionicons/icons'

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

const icon  = computed(() => applied ? close : chevronDownOutline)
const color = computed(() => applied ? 'primary' : 'medium')
</script>

<style scoped>
.chip {
  margin-right: 5px;
  margin-left: 5px;
}
</style>