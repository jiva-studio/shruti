<template>
  <div class="language-selector">
    <span
      v-for="lang in languages"
      :key="lang.code"
      :class="{
        language: true,
        'language-inactive': !active.includes(lang.code),
        'language-active': active.includes(lang.code),
      }"
      @click="onLanguageClicked(lang.code)"
    >
      {{ lang.icon ?? "🏁" }} {{ lang.name }}
    </span>
  </div>
</template>

<script setup lang="ts">
import type { UiTranscriptLanguage } from "./types.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  languages: readonly UiTranscriptLanguage[]
  allowMultiple: boolean
}>()

const active = defineModel<string[]>("active", { default: [] as string[] })

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onLanguageClicked(language: string) {
  if (props.allowMultiple) {
    if (active.value.includes(language)) {
      if (active.value.length <= 1) {
        return
      }
      active.value = active.value.filter((x) => x !== language)
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
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 16px;
  gap: 1rem;
  font-size: 0.75rem;
}

.language {
  transition: all 0.25s ease;
  /* Fixed tones: the transcript reader is always dark, so theme step
     colours (which invert) can't be used here. */
  background-color: rgba(192, 184, 168, 0.12);
  color: var(--shruti-immersive-text, #c0b8a8);
  border-radius: 999px;
  padding: 5px 12px;
}

.language-inactive {
  opacity: 0.55;
}

.language-active {
  background-color: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  opacity: 1;
  scale: 1.05;
}
</style>
