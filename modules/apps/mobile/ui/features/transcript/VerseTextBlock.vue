<template>
  <div class="VerseTextBlock">
    <!-- Reference -->
    <span v-if="reference" class="reference center">
      {{ reference }}
    </span>

    <!-- Verse Lines -->
    <div>
      <div v-for="line in lines" :key="line" class="lines center">
        {{ line }}
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  reference?: string
  lines: readonly string[]
}>()
</script>

<style scoped>
.VerseTextBlock {
  margin: 20px 0px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}

.center {
  text-align: center;
}

.lines {
  font-style: italic;
}

.reference {
  opacity: 0.5;
  background-color: white;
  color: black;
  border-radius: 3px;
  font-size: 0.75rem;
  padding: 0.25rem;
  white-space: nowrap;
}
</style>
