<template>
  <div class="language-selector">
    <span
      v-for="lang in languages"
      :key="lang.code"
      :class="{
        'language': true,
        'language-inactive': !active.includes(lang.code),
        'language-active': active.includes(lang.code)
      }"
      @click="onLanguageClicked(lang.code)"
    >
      {{ lang.icon ?? "🏁" }} {{ lang.name }}
    </span>  
  </div>
</template>

<script setup lang="ts">
/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type TranscriptLanguage = {
  code: string
  name: string
  icon: string
}

const props = defineProps<{
  languages: TranscriptLanguage[]
  allowMultiple: boolean
}>()

const active = defineModel<string[]>('active', { default: [] })

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onLanguageClicked(language: string) {
  if (props.allowMultiple) {
    if (active.value.includes(language)) {
      if (active.value.length <= 1) { return }
      active.value = active.value.filter(x => x !== language)
    } else {
      active.value = [...active.value, language]
    }
  } else {
    active.value = [language]
  }
}
</script>


<style scoped>
.language-selector {
  padding-top: 2rem;
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 16px;
  gap: 1rem;
  font-size: .75rem;
}

.language {
  transition: all 1s;
  background-color: #A0E060;
  border-radius: 5px;
  padding: 5px;
}

.language-inactive {
  opacity: 0.5;
  /* scale: .75; */
}

.language-active {
  opacity: 1;
  scale: 1.05;
}
</style>