<template>
  <IonButton
    expand="block"
    :disabled="confirmed"
    color="danger"
    @mousedown="startHold"
    @touchstart="startHold"
    @mouseup="cancelHold"
    @mouseleave="cancelHold"
    @touchend="cancelHold"
  >
    <div
      v-if="!confirmed"
      class="circle-progress"
    >
      <svg viewBox="0 0 36 36">
        <circle
          class="bg"
          cx="18"
          cy="18"
          r="14"
        />
        <circle
          class="progress"
          cx="18"
          cy="18"
          r="14"
          :stroke-dasharray="circumference"
          :stroke-dashoffset="dashOffset"
        />
      </svg>
    </div>
    <span v-if="!confirmed">{{ text }}</span>
    <span v-else>{{ confirmedText }}</span>
  </IonButton>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { IonButton } from '@ionic/vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  text: string
  confirmedText: string
}>()

const emit = defineEmits<{
  confirm: []
  confirmStart: []
  confirming: [elapsed: number, holdTime: number]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const holdTime = 3500
const radius = 16
const circumference = 2 * Math.PI * radius

const progress = ref(0)
const confirmed = ref(false)
const isHolding = ref(false)
let interval: ReturnType<typeof setInterval> | null = null
let startTime = 0

const dashOffset = computed(() => {
  return circumference - (progress.value / 100) * circumference
})

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function startHold() {
  if (confirmed.value) return
  isHolding.value = true
  progress.value = 0
  startTime = Date.now()
  emit('confirmStart')

  interval = setInterval(() => {
    const elapsed = Date.now() - startTime
    progress.value = Math.min((elapsed / holdTime) * 100, 100)
    emit('confirming', elapsed, holdTime)

    if (elapsed >= holdTime) {
      if (interval) clearInterval(interval)
      isHolding.value = false
      confirmed.value = true
      emit('confirm')
    }
  }, 16)
}

function cancelHold() {
  if (!isHolding.value) return
  if (interval) clearInterval(interval)
  isHolding.value = false
  progress.value = 0
}
</script>

<style scoped>
.button-content {
  display: flex;
  align-items: center;
  gap: 12px;
}

.circle-progress {
  width: 24px;
  height: 24px;
  position: absolute;
  right: 0px;
  top: 50%;
  transform: translateY(-50%);
  opacity: 0.8;
}

svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

circle.bg {
  fill: none;
  stroke: #eee;
  stroke-width: 5;
}

circle.progress {
  fill: none;
  stroke: var(--ion-color-dark);
  stroke-width: 5;
  transition: stroke-dashoffset 0.1s linear;
}
</style>
