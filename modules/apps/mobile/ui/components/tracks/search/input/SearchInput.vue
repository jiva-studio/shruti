<template>
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
</template>

<script setup lang="ts">
import { isPlatform } from "@ionic/vue"
import SearchInputAndroid from "./SearchInputAndroid.vue"
import SearchInputIOS from "./SearchInputIOS.vue"

const searchQuery = defineModel<string>({ type: String, default: "" })

defineProps<{
  placeholder?: string
}>()

const emit = defineEmits<{
  focusChange: [focused: boolean]
}>()

const isIOS = isPlatform("ios")
</script>
