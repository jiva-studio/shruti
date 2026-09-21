<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { IconChevronRight } from "@tabler/icons-vue"
import { CachedImage } from "@ui/primitives/index.js"
import type { PartOfCollection } from "@shruti/composables/useTrackSheetCollections.js"

defineProps<{ collection: PartOfCollection }>()
defineEmits<{ open: [id: string] }>()

const { t } = useI18n()
</script>

<template>
  <button type="button" class="part-of" @click="$emit('open', collection.id)">
    <!-- CachedImage fills its parent absolutely, so it needs a sized,
         relatively-positioned box of its own. -->
    <span v-if="collection.coverUrl" class="part-of-cover">
      <CachedImage :url="collection.coverUrl" :alt="collection.name" />
    </span>
    <span class="part-of-text">
      <span class="part-of-name">{{ collection.name }}</span>
      <span class="part-of-place">
        {{
          t("search.collections.partOf", { position: collection.position, total: collection.total })
        }}
      </span>
    </span>
    <IconChevronRight class="part-of-chevron" :size="18" />
  </button>
</template>

<style scoped>
/* The seminar this lecture belongs to. Sits above the description because it
   frames everything below it: the same talk reads differently as the third
   evening of a retreat than as a standalone. */
.part-of {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin: 0 0 16px;
  padding: 8px;
  border: none;
  border-radius: 10px;
  background: var(--ion-color-light);
  text-align: left;
  cursor: pointer;
}

.part-of-cover {
  position: relative;
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--ion-color-light-shade);
}

.part-of-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.part-of-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--ion-text-color, #222);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.part-of-place {
  font-size: 13px;
  color: var(--ion-color-medium);
}

.part-of-chevron {
  flex: 0 0 auto;
  color: var(--ion-color-medium);
}
</style>
