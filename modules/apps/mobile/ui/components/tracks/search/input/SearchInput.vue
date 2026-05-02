<template>
  <div v-if="!isIOS" class="search">
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
    show-cancel-button="focus"
    :placeholder="placeholder"
    :cancel-button-text="$t('app.cancel')"
    @input="onInput"
  />
</template>

<script setup lang="ts">
import { IonInput, IonSearchbar, isPlatform } from "@ionic/vue"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const searchQuery = defineModel<string>({ type: String, default: "" })

defineProps<{
  placeholder?: string
}>()

const emit = defineEmits<{
  focus: [value: boolean]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const isIOS = isPlatform("ios")

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onFocus() {
  emit("focus", true)
}

function onBlur() {
  emit("focus", false)
}

function onInput(e: Event) {
  const target = e.target as HTMLInputElement | null
  if (target) searchQuery.value = target.value
}
</script>

<style scoped>
.search {
  margin: 10px;
}
</style>
