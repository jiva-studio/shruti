<template>
  <div class="search-input" :class="{ 'has-leading': hasLeading }">
    <button
      v-if="hasLeading"
      type="button"
      class="leading"
      :aria-label="leadingLabel"
      @click="emit('leadingClick')"
    >
      <slot name="leading" />
    </button>

    <div class="search">
      <IonInput
        v-model="searchQuery"
        mode="md"
        fill="outline"
        :placeholder="placeholder"
        @ion-focus="emit('focusChange', true)"
        @ion-blur="emit('focusChange', false)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, useSlots } from "vue"
import { IonInput } from "@ionic/vue"

const searchQuery = defineModel<string>({ type: String, default: "" })

defineProps<{
  placeholder?: string
  /** Accessible label for the leading icon button (e.g. "Back"). */
  leadingLabel?: string
}>()

const emit = defineEmits<{
  focusChange: [focused: boolean]
  leadingClick: []
}>()

const slots = useSlots()
const hasLeading = computed(() => !!slots.leading)
</script>

<style scoped>
.search-input {
  position: relative;
}

.search {
  margin: var(--search-margin, 10px);
}

/* Leading icon sits over the field's left edge; the field gets extra start
   padding (.has-leading rules) so the text clears it. */
.leading {
  position: absolute;
  left: 22px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ion-text-color);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.has-leading :deep(ion-input) {
  --padding-start: 44px;
}
</style>
