<template>
  <div
    :color="color"
    class="chip"
    :class="{
      'on': applied,
      'off': !applied,
    }"
    size="small"
    @click="emit('click')"
  >
    <div
      v-if="showIcon"
      class="icon"
    >
      <slot name="icon" />
    </div>

    <slot />
    <IonIcon
      v-if="showActionButton"
      class="action"
      :icon="icon"
      @click.stop="applied ? emit('remove') : emit('click')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { IonIcon } from '@ionic/vue'
import { closeCircle, addCircle } from 'ionicons/icons'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const {
  applied = false,
  showActionButton = true,
  showIcon = true,
} = defineProps<{
  applied?: boolean
  showActionButton?: boolean
  showIcon?: boolean
}>()

const emit = defineEmits<{
  click: []
  remove: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const icon  = computed(() => applied ? closeCircle : addCircle)
const color = computed(() => applied ? 'primary' : 'medium')
</script>

<style scoped>
.chip {
  padding: 6px 10px;
  display: flex;
  align-items: center;
  font-size: .95rem;
  vertical-align: middle;
  box-sizing: border-box;
}

.ios .chip {
  border-radius: 10px;
}

.md .chip {
  border-radius: 4px;
}

.chip.on {
  background-color: #f1e9fa;
  color: var(--ion-color-primary);
  border: 1px solid transparent;
}

.md .chip.on {
  border: 1px solid rgba(var(--ion-color-primary-rgb), .1);
}

.chip.off {
  background-color: #fafafa;
  border: 1px dashed rgba(0, 0, 0, 0.12);
  filter: grayscale(1);
  color: rgba(0,0,0,.5);
}

.ios .chip.off {
  border: 1px dashed rgba(0, 0, 0, 0.06);
}

.chip .action {
  margin-left: 8px;
  opacity: .5;
}

.icon {
  width: 20px;
  height: 20px;
  margin-right: 4px;
}
</style>
