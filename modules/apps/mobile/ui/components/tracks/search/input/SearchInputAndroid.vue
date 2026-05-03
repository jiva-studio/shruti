<template>
  <div class="search">
    <IonInput
      v-model="searchQuery"
      fill="outline"
      :placeholder="placeholder"
      :clear-input="true"
      @ion-focus="emit('focusChange', true)"
      @ion-blur="emit('focusChange', false)"
    />
  </div>
</template>

<script setup lang="ts">
import { IonInput } from "@ionic/vue"

const searchQuery = defineModel<string>({ type: String, default: "" })

defineProps<{
  placeholder?: string
}>()

const emit = defineEmits<{
  focusChange: [focused: boolean]
}>()
</script>

<style scoped>
.search {
  margin: 10px;
}
</style>
