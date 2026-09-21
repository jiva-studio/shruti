<script setup lang="ts">
import { computed, useSlots } from "vue"
import { IonInput } from "@ionic/vue"

defineProps<{
  placeholder?: string
  /** Accessible label for the leading icon button (e.g. "Back"). */
  leadingLabel?: string
}>()

const searchQuery = defineModel<string>({ type: String, default: "" })

const emit = defineEmits<{
  "focus-change": [focused: boolean]
  "leading-click": []
}>()

const slots = useSlots()
const hasLeading = computed(() => !!slots.leading)
</script>

<template>
  <div class="search-input" :class="{ 'has-leading': hasLeading }">
    <button
      v-if="hasLeading"
      type="button"
      class="leading"
      :aria-label="leadingLabel"
      @click="emit('leading-click')"
    >
      <slot name="leading" />
    </button>

    <div class="search">
      <IonInput
        v-model="searchQuery"
        mode="md"
        fill="outline"
        :placeholder="placeholder"
        @ion-focus="emit('focus-change', true)"
        @ion-blur="emit('focus-change', false)"
      />
    </div>
  </div>
</template>

<style scoped>
.search-input {
  position: relative;
}

.search {
  /* Horizontal inset is tokenised so a page can align the field with its list
     gutter (note cards / track ion-item rows sit at 16px). Default 10px keeps
     the untoolbarised usages (chat history, filters sheet) unchanged; the
     toolbar pages (Notes, Tracks) set --search-gutter: 16px AND zero the
     toolbar's own --padding-start/-end so the field's left edge lands at
     exactly 16px in both md (toolbar pad 0) and ios (toolbar pad 4) — matching
     the cards. Do NOT collapse this back to a bare `margin: 10px`: that is the
     regression that keeps making the search sit ~6px tighter than the cards. */
  margin: 10px var(--search-gutter, 10px);
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
