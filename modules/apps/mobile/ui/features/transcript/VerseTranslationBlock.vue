<template>
  <span class="VerseTranslationBlock">
    {{ text + ' ' }}
  </span>
</template>


<script lang="ts" setup>
/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  text: string
}>()
</script>


<style scoped>
.VerseTranslationBlock {
  font-weight: bold;
}
</style>
