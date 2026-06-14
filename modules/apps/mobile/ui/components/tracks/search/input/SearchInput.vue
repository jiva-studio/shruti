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

    <SearchInputIOS
      v-if="isIOS"
      v-model="searchQuery"
      :placeholder="placeholder"
      @focus-change="(v) => emit('focusChange', v)"
    />
    <SearchInputAndroid
      v-else
      v-model="searchQuery"
      :placeholder="placeholder"
      @focus-change="(v) => emit('focusChange', v)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, useSlots } from "vue"
import { isPlatform } from "@ionic/vue"
import SearchInputAndroid from "./SearchInputAndroid.vue"
import SearchInputIOS from "./SearchInputIOS.vue"

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
const isIOS = isPlatform("ios")
</script>

<style scoped>
.search-input {
  position: relative;
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

/* iOS IonSearchbar: drop the built-in magnifier and indent the field so the
   leading icon takes its place. */
.has-leading :deep(.searchbar-search-icon) {
  display: none;
}

.has-leading :deep(.searchbar-input) {
  padding-inline-start: 44px;
}
</style>
