<template>
  <div class="language-selector">
    <span
      v-for="lang in languages"
      :key="lang.code"
      :class="{
        'language-inactive': lang.code !== activeLanguage,
        'language-active': lang.code === activeLanguage
      }"
      @click="emit('changeLanguage', lang.code)"
    >
      {{ lang.icon ?? "🏁" }} 
    </span>  
  </div>
</template>

<script setup lang="ts">
export type TranscriptLanguage = {
  code: string
  icon: string
}

defineProps<{
  languages: TranscriptLanguage[]
  activeLanguage: string
}>()

const emit = defineEmits<{
  changeLanguage: [lang: string]
}>()
</script>


<style scoped>
.language-selector {
  padding-top: 2rem;
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 16px;
  gap: 1rem;
  font-size: 1.5rem;
}

.language-inactive {
  opacity: 0.5;
}

.language-active {
  opacity: 1;
}
</style>