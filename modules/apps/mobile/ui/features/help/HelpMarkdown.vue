<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { blockMarkdownToHtml } from "@lib/ui/markdown/markdown.js"

const props = defineProps<{
  locales: Record<string, string>
}>()

const { locale, t } = useI18n()

const html = computed(() => {
  // Prefer the active UI locale; fall back to English when an article
  // has not been translated into it yet.
  const raw = props.locales[locale.value] ?? props.locales.en ?? ""
  const appName = t("app.name") || "Shruti"
  const baseUrl = typeof __WEB_APP_BASE_URL__ !== "undefined" ? __WEB_APP_BASE_URL__ : "https://shruti.app"
  const processed = raw
    .replaceAll("{{APP_NAME}}", appName)
    .replaceAll("https://shruti.app", baseUrl)
  return blockMarkdownToHtml(processed)
})
</script>

<template>
  <article class="help-md" v-html="html" />
</template>

<style scoped>
.help-md {
  padding: 0 16px 24px;
  color: var(--ion-text-color);
  font-size: 1rem;
  line-height: 1.55;
}

.help-md :deep(h1),
.help-md :deep(h2),
.help-md :deep(h3) {
  font-weight: 600;
  margin: 1.5em 0 0.5em;
  line-height: 1.25;
}

.help-md :deep(h1) {
  font-size: 1.4rem;
}
.help-md :deep(h2) {
  font-size: 1.2rem;
}
.help-md :deep(h3) {
  font-size: 1.05rem;
}

.help-md :deep(p) {
  margin: 0.5em 0 1em;
}

.help-md :deep(ul),
.help-md :deep(ol) {
  padding-left: 1.4em;
  margin: 0.5em 0 1em;
}

.help-md :deep(li) {
  margin: 0.25em 0;
}

.help-md :deep(strong) {
  font-weight: 600;
}

.help-md :deep(code) {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 0.92em;
  background: var(--ion-color-light, rgba(0, 0, 0, 0.06));
  padding: 0.05em 0.35em;
  border-radius: 4px;
}

.help-md :deep(blockquote) {
  margin: 1em 0;
  padding: 0.25em 0 0.25em 12px;
  border-left: 3px solid var(--ion-color-primary);
  color: var(--ion-color-medium);
}

.help-md :deep(a) {
  color: var(--ion-color-primary);
  text-decoration: none;
}

.help-md :deep(hr) {
  border: none;
  border-top: 1px solid var(--ion-color-light, rgba(0, 0, 0, 0.08));
  margin: 1.5em 0;
}
</style>
