<script setup lang="ts">
import { IonSpinner } from "@ionic/vue"
import type { UiTranscriptLanguage } from "./types.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  languages: readonly UiTranscriptLanguage[]
  allowMultiple: boolean
}>()

const active = defineModel<string[]>("active", { default: [] as string[] })
const emit = defineEmits<{ translate: [code: string] }>()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onLanguageClicked(lang: UiTranscriptLanguage) {
  // A "ghost" language (no transcript yet) requests an on-demand translation
  // instead of toggling — unless one is already running for it.
  if (lang.available === false) {
    if (!lang.busy) {
      emit("translate", lang.code)
    }
    return
  }
  const language = lang.code
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

<template>
  <div class="language-selector">
    <span
      v-for="lang in languages"
      :key="lang.code"
      :class="{
        language: true,
        'language-ghost': lang.available === false,
        'language-inactive': lang.available !== false && !active.includes(lang.code),
        'language-active': lang.available !== false && active.includes(lang.code),
      }"
      @click="onLanguageClicked(lang)"
    >
      <IonSpinner v-if="lang.busy" name="crescent" class="busy" />
      <span v-else-if="lang.icon" class="flag">{{ lang.icon }}</span>
      {{ lang.name }}
    </span>
  </div>
</template>

<style scoped>
.language-selector {
  display: flex;
  justify-content: center;
  align-items: center;
  margin: 16px 0;
  gap: 1rem;
  font-size: 0.75rem;
}

.flag {
  margin-right: 4px;
}

.language {
  transition: all 0.25s ease;
  /* Fixed tones: the transcript reader is always dark, so theme step
     colours (which invert) can't be used here. */
  background-color: rgba(192, 184, 168, 0.12);
  color: var(--lectorium-immersive-text, #c0b8a8);
  border-radius: 999px;
  padding: 5px 12px;
}

.language-inactive {
  opacity: 0.55;
}

/* A not-yet-translated language: dashed outline, tap to request translation. */
.language-ghost {
  opacity: 0.6;
  background-color: transparent;
  border: 1px dashed var(--lectorium-immersive-text, #c0b8a8);
}

.busy {
  width: 14px;
  height: 14px;
  margin-right: 4px;
  vertical-align: middle;
}

.language-active {
  background-color: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  opacity: 1;
  scale: 1.05;
}
</style>
