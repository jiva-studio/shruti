<script setup lang="ts">
import { CollectionListItem } from "@ui/features/collections/index.js"
import RowDivider from "@ui/components/RowDivider.vue"

export interface CollectionRow {
  readonly id: string
  readonly name: string
  readonly coverUrl?: string
  readonly description?: string
}

defineProps<{ items: readonly CollectionRow[] }>()
const emit = defineEmits<{ select: [id: string] }>()
</script>

<template>
  <div class="flush-list">
    <template v-for="(c, index) in items" :key="c.id">
      <CollectionListItem
        :name="c.name"
        :cover-url="c.coverUrl"
        :description="c.description"
        @click="emit('select', c.id)"
      />
      <RowDivider v-if="index < items.length - 1" />
    </template>
  </div>
</template>

<style scoped>
.flush-list {
  margin-top: -8px; /* cancel the first collection row's 8px top padding */
}
</style>
