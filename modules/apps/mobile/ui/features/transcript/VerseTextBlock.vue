<template>
  <div class="VerseTextBlock">
    <!-- Reference -->
    <span v-if="reference" class="reference center">
      {{ reference }}
    </span>

    <!-- Original script (Devanagari / Bengali) -->
    <div v-if="original && original.length">
      <div v-for="line in original" :key="line" class="original center">
        {{ line }}
      </div>
    </div>

    <!-- Transliteration -->
    <div>
      <div v-for="line in lines" :key="line" class="lines center">
        {{ line }}
      </div>
    </div>

    <!-- Translation -->
    <p v-if="translation" class="translation">
      {{ translation }}
    </p>
  </div>
</template>

<script lang="ts" setup>
/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  reference?: string
  lines: readonly string[]
  original?: readonly string[]
  translation?: string
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

.original {
  font-family: "Sanskrit2003", "Noto Sans Devanagari", serif;
  line-height: 1.5;
}

.lines {
  font-style: italic;
  opacity: 0.85;
}

.translation {
  margin: 0.25rem 0 0;
  align-self: stretch;
  text-align: left;
  opacity: 0.9;
}

.reference {
  opacity: 0.5;
  font-size: 0.75rem;
  padding: 0.25rem;
  white-space: nowrap;
}
</style>
