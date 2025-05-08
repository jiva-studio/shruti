<template>
  <div
    v-if="isAndroid"
    class="search"
  >
    <IonInput
      v-model="searchQuery"
      fill="outline"
      :placeholder="placeholder"
      :clear-input="true"
      @ion-focus="onFocus"
      @ion-blur="onBlur"
    />
  </div>
  <IonSearchbar
    v-else
    v-model="searchQuery"
    :placeholder="placeholder"
    @input="(e) => searchQuery = e.target.value"
  />
</template>


<script setup lang="ts">
import { IonInput, IonSearchbar, isPlatform } from '@ionic/vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const searchQuery = defineModel<string>({ type: String, default: '' })

defineProps<{
  placeholder?: string
}>()

const emit = defineEmits<{
  focus: [value: boolean]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const isAndroid = isPlatform('android')

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onFocus() {
  emit('focus', true)
}

function onBlur() {
  emit('focus', false)
}
</script>


<style scoped>
.search {
  margin: 10px;
}
</style>