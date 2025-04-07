<template>
  <span
    v-tooltip.top="getAnnotationsText(annotations)"
    :class="[getAnnotationsSeverity(annotations), 'whitespace-nowrap']"
  >
    <slot />
  </span>
</template>

<script setup lang="ts" generic="T">
/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type Annotation = {
  text: string
  severity: 'warn' | 'error'
}

defineProps<{
  annotations?: Annotation[] | undefined
}>()

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function getAnnotationsText(annotations: Annotation[] | undefined) {
  if (!annotations) return undefined
  return annotations.map((annotation) => annotation.text).join(', ')
}

function getAnnotationsSeverity(annotations: Annotation[] | undefined) {
  if (!annotations) return ''
  if (annotations.some((annotation) => annotation.severity === 'warn')) {
    return 'text-yellow-700'
  } else if (
    annotations.some((annotation) => annotation.severity === 'error')
  ) {
    return 'text-red-700'
  }
}
</script>
